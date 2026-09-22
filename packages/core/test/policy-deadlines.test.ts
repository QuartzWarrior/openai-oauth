import { afterEach, describe, expect, test, vi } from "vitest"
import { InferenceError, parseInferenceError } from "../src/inference-error.js"
import {
	resetCodexClientVersionCache,
	resolveCodexClientVersion,
} from "../src/models.js"
import {
	createOpenAIOAuthTransport,
	exchangeOpenAIOAuthCode,
	refreshOpenAIOAuthTokens,
} from "../src/runtime.js"

const auth = { accountId: "a", accessToken: "token" }
const settings = { auth, codexVersion: "0.154.0" }
const done = (id = "r") =>
	`data: ${JSON.stringify({ type: "response.completed", response: { id, output: [] } })}\n\n`
const sse = (value = done()) =>
	new Response(value, { headers: { "content-type": "text/event-stream" } })
const init = (stream = true): RequestInit => ({
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ model: "m", input: "hello", stream }),
})
const catalogFetch =
	(fetch: typeof globalThis.fetch): typeof globalThis.fetch =>
	async (url, options) =>
		String(url).includes("/models?")
			? Response.json({ models: [{ slug: "m" }] })
			: fetch(url, options)
const deferred = <T>() => {
	let resolve!: (value: T) => void
	return {
		promise: new Promise<T>((r) => {
			resolve = r
		}),
		resolve: (value: T) => resolve(value),
	}
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
afterEach(() => {
	vi.restoreAllMocks()
	resetCodexClientVersionCache()
})

describe("redirect policy", () => {
	test.each([
		"error",
		"manual",
	] as const)("preserves %s for init and Request forms", async (redirect) => {
		const seen: RequestInit[] = []
		const transport = createOpenAIOAuthTransport({
			...settings,
			fetch: async (_url, request) => {
				seen.push(request ?? {})
				return new Response(null)
			},
		})
		await transport.request("health", { redirect })
		await transport.fetch(
			new Request("https://placeholder.test/v1/health", { redirect }),
		)
		expect(seen.map((request) => request.redirect)).toEqual([
			redirect,
			redirect,
		])
	})
	test("init redirect overrides a Request policy, including downgraded targets", async () => {
		const fetch = vi.fn(async () => new Response(null))
		const transport = createOpenAIOAuthTransport({
			...settings,
			baseURL: "http://local.test",
			fetch,
		})
		await transport.fetch(
			new Request("https://placeholder.test/v1/health", { redirect: "follow" }),
			{ redirect: "error" },
		)
		expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" })
	})
	test.each([
		"init",
		"request",
	])("keeps authenticated catalog discovery redirect-safe for %s calls", async (form) => {
		const seen: RequestInit[] = []
		const pending = deferred<Response>()
		const transport = createOpenAIOAuthTransport({
			...settings,
			fetch: async (_url, request) => {
				seen.push(request ?? {})
				return pending.promise
			},
		})
		const first = transport.request("models", { redirect: "follow" })
		await vi.waitFor(() => expect(seen).toHaveLength(1))
		const restricted =
			form === "init"
				? transport.request("models", { redirect: "error" })
				: transport.fetch(
						new Request("https://placeholder.test/v1/models", {
							redirect: "error",
						}),
					)
		pending.resolve(Response.json({ models: [{ slug: "m" }] }))
		expect((await first).status).toBe(200)
		expect((await restricted).status).toBe(200)
		expect(seen).toHaveLength(1)
		expect(seen[0]?.redirect).toBe("error")
	})
	test.each([
		302, 303, 307, 308,
	])("OAuth rejects HTTP %s redirects rather than replaying bodies", async (status) => {
		const fetch = vi.fn(async (_url, request?: RequestInit) => {
			expect(request?.redirect).toBe("error")
			return new Response(null, {
				status,
				headers: { location: "https://elsewhere.invalid/token" },
			})
		})
		await expect(
			refreshOpenAIOAuthTokens({ refreshToken: "private", fetch }),
		).rejects.toMatchObject({ status })
		await expect(
			exchangeOpenAIOAuthCode({
				code: "code",
				codeVerifier: "verifier",
				redirectUri: "http://localhost/cb",
				fetch,
			}),
		).rejects.toMatchObject({ status })
		expect(fetch).toHaveBeenCalledTimes(2)
	})
})

describe("operation-owned discovery deadlines", () => {
	test("a stalled shared version lookup expires and cannot publish its late result", async () => {
		const pending = deferred<Response>()
		let calls = 0
		const fetch = vi.fn(async () =>
			++calls === 1 ? pending.promise : Response.json({ version: "1.2.3" }),
		)
		await expect(
			resolveCodexClientVersion({ fetchImpl: fetch, timeoutMs: 20 }),
		).resolves.toBe("0.154.0")
		await expect(
			resolveCodexClientVersion({ fetchImpl: fetch, timeoutMs: 100 }),
		).resolves.toBe("1.2.3")
		pending.resolve(Response.json({ version: "9.9.9" }))
		await delay(5)
		await expect(resolveCodexClientVersion({ fetchImpl: fetch })).resolves.toBe(
			"1.2.3",
		)
	})
	test("subscriber abort leaves another version subscriber useful", async () => {
		const pending = deferred<Response>()
		const fetch = vi.fn(() => pending.promise)
		const controller = new AbortController()
		const first = resolveCodexClientVersion({
			fetchImpl: fetch,
			timeoutMs: 100,
			signal: controller.signal,
		})
		const second = resolveCodexClientVersion({
			fetchImpl: fetch,
			timeoutMs: 100,
		})
		controller.abort()
		await expect(first).rejects.toMatchObject({ name: "AbortError" })
		pending.resolve(Response.json({ version: "2.3.4" }))
		await expect(second).resolves.toBe("2.3.4")
		expect(fetch).toHaveBeenCalledOnce()
	})
	test("catalog deadline cancels a trickling body and later discovery recovers", async () => {
		const cancel = vi.fn()
		let calls = 0
		const transport = createOpenAIOAuthTransport({
			...settings,
			modelCatalogTimeoutMs: 20,
			fetch: async () =>
				++calls === 1
					? new Response(
							new ReadableStream({
								start(c) {
									c.enqueue(new TextEncoder().encode('{"models":'))
								},
								cancel,
							}),
						)
					: Response.json({ models: [{ slug: "m" }] }),
		})
		expect((await transport.request("models")).status).toBe(502)
		expect(cancel).toHaveBeenCalledOnce()
		expect((await transport.request("models")).status).toBe(200)
	})
	test("transport shutdown cancels its catalog while one subscriber abort does not", async () => {
		const pending = deferred<Response>()
		const lifetime = new AbortController()
		const caller = new AbortController()
		const fetch = vi.fn(() => pending.promise)
		const transport = createOpenAIOAuthTransport({
			...settings,
			fetch,
			signal: lifetime.signal,
		})
		const first = transport.request("models", { signal: caller.signal })
		const second = transport.request("models")
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
		caller.abort()
		await expect(first).rejects.toMatchObject({ name: "AbortError" })
		lifetime.abort()
		await expect(second).rejects.toMatchObject({ name: "AbortError" })
		const cancel = vi.fn()
		pending.resolve(new Response(new ReadableStream({ cancel })))
		await vi.waitFor(() => expect(cancel).toHaveBeenCalled())
	})
})

describe("stream deadlines and completion seams", () => {
	test("idle wait excludes time paused by the consumer", async () => {
		let count = 0
		const stream = new ReadableStream<Uint8Array>(
			{
				pull(c) {
					c.enqueue(
						new TextEncoder().encode(++count === 1 ? ": progress\n\n" : done()),
					)
				},
			},
			{ highWaterMark: 0 },
		)
		const transport = createOpenAIOAuthTransport({
			...settings,
			streamIdleTimeoutMs: 20,
			fetch: catalogFetch(async () => new Response(stream)),
		})
		const response = await transport.request("responses", init())
		await delay(30)
		const reader = response.body?.getReader()
		if (!reader) throw new Error("Missing fixture body")
		await reader.read()
		await delay(30)
		await expect(reader.read()).resolves.toMatchObject({ done: false })
		await expect(reader.read()).resolves.toMatchObject({ done: true })
	})
	test("silent upstream expires its idle read and cancels the source", async () => {
		const cancel = vi.fn()
		const transport = createOpenAIOAuthTransport({
			...settings,
			streamIdleTimeoutMs: 20,
			fetch: catalogFetch(
				async () => new Response(new ReadableStream({ cancel })),
			),
		})
		const response = await transport.request("responses", init())
		await expect(response.text()).rejects.toMatchObject({
			name: "TimeoutError",
		})
		expect(cancel).toHaveBeenCalled()
	})
	test("total timeout also applies while downstream is paused", async () => {
		const cancel = vi.fn()
		const transport = createOpenAIOAuthTransport({
			...settings,
			requestTimeoutMs: 20,
			fetch: catalogFetch(
				async () => new Response(new ReadableStream({ cancel })),
			),
		})
		const response = await transport.request("responses", init())
		await delay(30)
		await expect(response.text()).rejects.toMatchObject({
			name: "TimeoutError",
		})
		expect(cancel).toHaveBeenCalled()
	})
	test.each([
		true,
		false,
	])("logical completion is registered once for stream=%s", async (stream) => {
		const completed = vi.fn()
		const events = vi.fn()
		const transport = createOpenAIOAuthTransport({
			...settings,
			onResponseCompleted: completed,
			onResponseEvent: events,
			fetch: catalogFetch(async () =>
				sse(
					'data: {"type":"codex.rate_limits","rate_limits":{"remaining":1}}\n\n' +
						done(),
				),
			),
		})
		await (await transport.request("responses", init(stream))).text()
		expect(completed).toHaveBeenCalledOnce()
		expect(completed.mock.calls[0]?.[0]).toMatchObject({
			id: "r",
			status: "completed",
		})
		expect(completed.mock.calls[0]?.[1]).toMatchObject({ session: auth })
		expect(events).toHaveBeenCalledOnce()
	})
	test("top-level stream error is typed, redacted and reported without a completion", async () => {
		const error = vi.fn()
		const completed = vi.fn()
		const transport = createOpenAIOAuthTransport({
			...settings,
			onResponseError: error,
			onResponseCompleted: completed,
			fetch: catalogFetch(async () =>
				sse(
					'data: {"type":"error","error":{"code":"rate_limit_exceeded","message":"secret"}}\n\n',
				),
			),
		})
		await expect(
			(await transport.request("responses", init())).text(),
		).rejects.toBeInstanceOf(InferenceError)
		expect(error).toHaveBeenCalledOnce()
		expect(error.mock.calls[0]?.[0]).toMatchObject({
			category: "throttled",
			code: "rate_limit_exceeded",
		})
		expect(String(error.mock.calls[0]?.[0])).not.toContain("secret")
		expect(completed).not.toHaveBeenCalled()
	})
	test("unknown errors remain unknown and invalid prompts are request local", () => {
		expect(
			parseInferenceError({
				error: { code: "secret-unknown", message: "secret" },
			}).category,
		).toBe("unknown")
		expect(
			parseInferenceError({ error: { code: "context_length_exceeded" } })
				.category,
		).toBe("request")
		expect(
			parseInferenceError(
				{ error: { code: "usage_limit_reached", resets_at: 20 } },
				{ now: 1000 },
			).retryAt,
		).toBe(20_000)
	})
})
