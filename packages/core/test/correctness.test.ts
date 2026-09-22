import { afterEach, describe, expect, test, vi } from "vitest"
import {
	createOpenAIOAuthTransport,
	OAuthTokenError,
	refreshOpenAIOAuthTokens,
} from "../src/runtime.js"
import {
	collectCompletedResponseFromSse,
	iterateServerSentEvents,
} from "../src/sse.js"
import { CodexResponsesState } from "../src/state.js"

const encoder = new TextEncoder()
const session = { accountId: "owner-a", accessToken: "token-a" }
const event = (type: string, response: Record<string, unknown>) =>
	`event: ${type}\ndata: ${JSON.stringify({ type, response })}\n\n`
const completed = (id: string, output: unknown[] = []) =>
	event("response.completed", { id, status: "completed", output })
const sse = (text: string) =>
	new Response(text, { headers: { "content-type": "text/event-stream" } })
const responseBody = (response: Response): ReadableStream<Uint8Array> => {
	if (!response.body)
		throw new Error("Expected a response body in the fixture.")
	return response.body
}
const init = (body: Record<string, unknown> = {}): RequestInit => ({
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ model: "m", input: [], ...body }),
})
const deferred = <T>() => {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}
const fetchWithCatalog =
	(handler: typeof fetch): typeof fetch =>
	async (url, options) => {
		if (String(url).includes("/models?"))
			return Response.json({ models: [{ slug: "m", visibility: "list" }] })
		return handler(url, options)
	}
const settings = { auth: session, codexVersion: "0.154.0" }

afterEach(() => vi.restoreAllMocks())

describe("safe state ownership", () => {
	test("preserves unknown predecessors and never caches delta-only history", () => {
		const state = new CodexResponsesState()
		const delta = {
			previous_response_id: "outside-cache",
			input: [{ role: "user", content: "delta" }],
		}
		expect(state.expandRequestBody(delta)).toEqual(delta)
		state.rememberResponse(
			{ id: "next", status: "completed", output: [] },
			delta,
		)
		expect(
			state.expandRequestBody({ previous_response_id: "next", input: [] })
				.previous_response_id,
		).toBe("next")
	})

	test("does not cache unsuccessful responses and limits retained bytes", () => {
		const state = new CodexResponsesState({ maxBytes: 256 })
		state.rememberResponse(
			{ id: "failed", status: "failed", output: [] },
			{ input: [] },
		)
		state.rememberResponse(
			{ id: "large", status: "completed", output: [] },
			{ input: ["x".repeat(1024)] },
		)
		expect(state.snapshot().responses).toEqual([])
		for (let index = 0; index < 20; index += 1)
			state.rememberResponse(
				{ id: String(index), status: "completed", output: [] },
				{ input: ["x".repeat(100)] },
			)
		expect(state.snapshot().responses.length).toBeLessThan(3)
	})

	test("cache owner switches fence in-flight captures, token refresh keeps owner history", async () => {
		let auth = session
		const old = deferred<Response>()
		const bodies: Array<{
			owner: string | null
			body: Record<string, unknown>
		}> = []
		let requests = 0
		const transport = createOpenAIOAuthTransport({
			...settings,
			auth: async () => auth,
			fetch: fetchWithCatalog(async (_url, request) => {
				bodies.push({
					owner: new Headers(request?.headers).get("chatgpt-account-id"),
					body: JSON.parse(String(request?.body)),
				})
				requests += 1
				return requests === 1 ? old.promise : sse(completed(`resp-${requests}`))
			}),
		})
		const first = transport.request(
			"responses",
			init({ input: ["private-a"], stream: true }),
		)
		await vi.waitFor(() => expect(bodies).toHaveLength(1))
		auth = { accountId: "owner-b", accessToken: "token-b" }
		await (await transport.request("responses", init({ stream: true }))).text()
		old.resolve(sse(completed("resp-a")))
		await (await first).text()
		await expect(
			transport.request(
				"responses",
				init({
					previous_response_id: "resp-a",
					input: ["b-delta"],
					stream: true,
				}),
			),
		).rejects.toThrow(/different authenticated account/)
		expect(bodies).toHaveLength(2)
		auth = { ...session, accessToken: "refreshed-a" }
		await (
			await transport.request(
				"responses",
				init({
					previous_response_id: "resp-a",
					input: ["a-delta"],
					stream: true,
				}),
			)
		).text()
		expect(bodies[2]?.body.input).toEqual(["private-a", "a-delta"])
		expect(bodies[2]?.body.previous_response_id).toBeUndefined()
	})
})

describe("bounded SSE and terminal semantics", () => {
	test.each([
		event("response.created", { id: "r", status: "in_progress" }),
		event("response.created", { id: "r", status: "in_progress" }) +
			"data: [DONE]\n\n",
		event("response.created", { id: "r", status: "in_progress" }) +
			'data: {"type":"error","error":{"message":"secret"}}\n\n',
	])("rejects missing or error terminal outcomes", async (text) => {
		await expect(
			collectCompletedResponseFromSse(responseBody(sse(text))),
		).rejects.toThrow(/terminal response|reported an error/)
	})

	test("failed terminal response is explicit and not the earlier progress object", async () => {
		const text =
			event("response.created", { id: "r", status: "in_progress" }) +
			event("response.failed", {
				id: "r",
				status: "failed",
				error: { code: "x" },
			})
		await expect(
			collectCompletedResponseFromSse(responseBody(sse(text))),
		).resolves.toMatchObject({ status: "failed" })
	})

	test("enforces event and collected-output limits while reading and cancels", async () => {
		const cancel = vi.fn()
		const huge = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(encoder.encode(`data: ${"x".repeat(64)}`))
			},
			cancel,
		})
		await expect(
			collectCompletedResponseFromSse(huge, { maxEventBytes: 32 }),
		).rejects.toThrow(/event exceeded/)
		expect(cancel).toHaveBeenCalled()
		const item = (id: string) =>
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { id, text: "x".repeat(40) } })}\n\n`
		await expect(
			collectCompletedResponseFromSse(
				responseBody(sse(item("a") + item("b"))),
				{
					maxResponseBytes: 80,
				},
			),
		).rejects.toThrow(/capture limit/)
	})

	test("parses CRLF and UTF-8 across byte boundaries", async () => {
		const bytes = encoder.encode('event: note\r\ndata: {"value":"🌱"}\r\n\r\n')
		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				for (const byte of bytes) c.enqueue(new Uint8Array([byte]))
				c.close()
			},
		})
		const events = []
		for await (const value of iterateServerSentEvents(stream))
			events.push(value)
		expect(events).toEqual([{ event: "note", data: '{"value":"🌱"}' }])
	})

	test("streaming observation does not drain ahead and propagates cancel", async () => {
		let pulls = 0
		const cancel = vi.fn()
		const upstream = new ReadableStream<Uint8Array>(
			{
				pull(c) {
					pulls++
					c.enqueue(encoder.encode(": heartbeat\n\n"))
				},
				cancel,
			},
			{ highWaterMark: 0 },
		)
		const transport = createOpenAIOAuthTransport({
			...settings,
			fetch: fetchWithCatalog(async () => new Response(upstream)),
		})
		const response = await transport.request(
			"responses",
			init({ stream: true }),
		)
		expect(pulls).toBe(0)
		const reader = responseBody(response).getReader()
		await reader.read()
		expect(pulls).toBe(1)
		await reader.cancel()
		expect(cancel).toHaveBeenCalledOnce()
	})

	test("streaming truncation errors instead of silently returning progress", async () => {
		const transport = createOpenAIOAuthTransport({
			...settings,
			fetch: fetchWithCatalog(async () =>
				sse(event("response.created", { status: "in_progress" })),
			),
		})
		const response = await transport.request(
			"responses",
			init({ stream: true }),
		)
		await expect(response.text()).rejects.toThrow(/terminal response/)
	})
})

describe("routing and transport seams", () => {
	test("rebuilds routing headers from ordinary and FedRAMP sessions", async () => {
		for (const flag of [true, false]) {
			const seen: Headers[] = []
			const transport = createOpenAIOAuthTransport({
				...settings,
				auth: { ...session, isFedRamp: flag },
				fetch: fetchWithCatalog(async (_url, options) => {
					seen.push(new Headers(options?.headers))
					return sse(completed("r"))
				}),
			})
			const request = init()
			request.headers = {
				"content-type": "application/json",
				"X-OpenAI-FedRAMP": flag ? "false" : "true",
				"chatgpt-account-id": "attacker",
			}
			await transport.request("responses", request)
			expect(seen[0]?.get("chatgpt-account-id")).toBe(session.accountId)
			expect(seen[0]?.get("x-openai-fedramp")).toBe(flag ? "true" : null)
		}
	})

	test("executeResponses receives normalized input and common stream:false finalization", async () => {
		const executor = vi.fn(async (_url: string, request: RequestInit) => {
			expect(JSON.parse(String(request.body))).toMatchObject({
				stream: true,
				store: false,
				input: [
					{ role: "user", content: [{ type: "input_text", text: "hello" }] },
				],
			})
			return sse(completed("custom"))
		})
		const transport = createOpenAIOAuthTransport({
			...settings,
			fetch: fetchWithCatalog(async () => {
				throw new Error("HTTP should not run")
			}),
			executeResponses: executor,
		})
		const response = await transport.request(
			"responses",
			init({ input: "hello", stream: false }),
		)
		expect(response.headers.get("content-type")).toBe("application/json")
		await expect(response.json()).resolves.toMatchObject({
			id: "custom",
			status: "completed",
		})
		expect(executor.mock.calls[0]?.[2]).toEqual(session)
	})

	test("merges base query defaults with encoded request precedence", async () => {
		const urls: string[] = []
		const transport = createOpenAIOAuthTransport({
			...settings,
			baseURL: "https://upstream.test/root?api-version=old&key=a%2Bb",
			fetch: async (url) => {
				urls.push(String(url))
				return new Response(null)
			},
		})
		await transport.request("health?api-version=new%20value&tag=one&tag=two")
		if (urls[0] === undefined) throw new Error("Expected an upstream request.")
		const target = new URL(urls[0])
		expect(target.pathname).toBe("/root/health")
		expect(target.searchParams.get("key")).toBe("a+b")
		expect(target.searchParams.get("api-version")).toBe("new value")
		expect(target.searchParams.getAll("tag")).toEqual(["one", "two"])
	})

	test("aborts pending auth without sending inference", async () => {
		const pending = deferred<typeof session>()
		const fetch = vi.fn(async () => new Response(null))
		const transport = createOpenAIOAuthTransport({
			...settings,
			auth: () => pending.promise,
			fetch,
		})
		const abort = new AbortController()
		const request = transport.request("responses", {
			...init(),
			signal: abort.signal,
		})
		abort.abort()
		await expect(request).rejects.toMatchObject({ name: "AbortError" })
		pending.resolve(session)
		expect(fetch).not.toHaveBeenCalled()
	})

	test("keeps last-known-good catalog only for its owner within the age budget", async () => {
		let now = 0
		vi.spyOn(Date, "now").mockImplementation(() => now)
		let fail = false
		let auth = session
		const transport = createOpenAIOAuthTransport({
			...settings,
			auth: async () => auth,
			modelCatalogMaxStaleMs: 600_000,
			fetch: async () =>
				fail
					? new Response("unavailable", { status: 503 })
					: Response.json({ models: [{ slug: "m", visibility: "list" }] }),
		})
		expect((await transport.request("models")).status).toBe(200)
		fail = true
		now = 301_000
		expect((await transport.request("models")).status).toBe(200)
		auth = { ...session, accountId: "other" }
		expect((await transport.request("models")).status).toBe(502)
		auth = session
		now = 601_000
		expect((await transport.request("models")).status).toBe(502)
	})
})

describe("review regression boundaries", () => {
	test("binds an external state object across separate transports", async () => {
		const shared = new CodexResponsesState()
		const fetch = fetchWithCatalog(async () => sse(completed("private-id")))
		const a = createOpenAIOAuthTransport({
			...settings,
			fetch,
			responsesState: shared,
		})
		const b = createOpenAIOAuthTransport({
			...settings,
			auth: { ...session, accountId: "owner-b" },
			fetch,
			responsesState: shared,
		})
		await a.request("responses", init({ input: ["private-a"] }))
		await expect(
			b.request(
				"responses",
				init({ previous_response_id: "private-id", input: ["delta"] }),
			),
		).rejects.toThrow(/already bound/)
	})

	test("counts long response IDs against retained cache budget", () => {
		const state = new CodexResponsesState({ maxBytes: 128 })
		state.rememberResponse(
			{ id: "x".repeat(4096), status: "completed", output: [] },
			{ input: [] },
		)
		expect(state.snapshot().responses).toHaveLength(0)
	})

	test("limits terminal output count and rejects nonfinite budgets", async () => {
		const stream = sse(completed("r", [{ id: "1" }, { id: "2" }])).body
		if (!stream) throw new Error("Missing test body")
		await expect(
			collectCompletedResponseFromSse(stream, { maxOutputItems: 1 }),
		).rejects.toThrow(/capture limit/)
		const invalid = sse(completed("r")).body
		if (!invalid) throw new Error("Missing test body")
		await expect(
			collectCompletedResponseFromSse(invalid, { maxEventBytes: Number.NaN }),
		).rejects.toThrow(/positive integers/)
	})

	test.each([
		"\r",
		"\n",
		"\r\n",
	])("parses %j line endings split at every byte", async (separator) => {
		const text = [
			"event: response.completed",
			`data: ${JSON.stringify({ response: { id: "r", status: "completed", output: [] } })}`,
			"",
			"",
		].join(separator)
		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				for (const byte of encoder.encode(text))
					c.enqueue(new Uint8Array([byte]))
				c.close()
			},
		})
		await expect(
			collectCompletedResponseFromSse(stream),
		).resolves.toMatchObject({ id: "r", status: "completed" })
	})
})

describe("typed OAuth failures", () => {
	test.each([
		[400, false],
		[401, false],
		[429, true],
		[503, true],
	])("redacts provider text at HTTP %s", async (status, retryable) => {
		const error = await refreshOpenAIOAuthTokens({
			refreshToken: "secret-refresh",
			fetch: async () =>
				Response.json(
					{
						error: "invalid_grant",
						error_description: "secret-refresh password=https://u:p@host",
					},
					{ status: Number(status) },
				),
		}).catch((error: unknown) => error)
		expect(error).toBeInstanceOf(OAuthTokenError)
		expect(error).toMatchObject({ status, code: "invalid_grant", retryable })
		expect(JSON.stringify(error)).not.toContain("secret-refresh")
		expect(String(error)).not.toContain("password")
	})
})
