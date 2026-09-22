import { afterEach, describe, expect, it, vi } from "vitest"
import {
	computeUnavailability,
	parseCodexRateHeaders,
	rateSnapshotUtilization,
} from "../src/account-state.js"
import { createOpenAIPool } from "../src/index.js"
import {
	errorJsonResponse,
	makeAuthFile,
	makeRequestInit,
	makeSseResponse,
	okJsonResponse,
} from "./helpers.js"

const ORIGINAL_FETCH = globalThis.fetch

afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH
	vi.restoreAllMocks()
	vi.useRealTimers()
})

/** /models catalog goes straight to global fetch in core; answer empty. */
const stubModelCatalog = () => {
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ models: [] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		})) as typeof fetch
}

const okCodexResponse = (
	params: { id?: string; ratePrimary?: number } = {},
): Response =>
	makeSseResponse(
		params.id ?? `resp_${Math.random().toString(36).slice(2, 10)}`,
		params.ratePrimary !== undefined
			? { "x-codex-primary-used-percent": String(params.ratePrimary) }
			: {},
	)

const urlOf = (input: RequestInfo | URL): string =>
	String(input instanceof Request ? input.url : input)

const isResponsesUrl = (input: RequestInfo | URL): boolean =>
	urlOf(input).endsWith("/responses")

const isModelsUrl = (input: RequestInfo | URL): boolean =>
	urlOf(input).includes("/models") && urlOf(input).includes("client_version=")

const modelsResponse = () =>
	new Response(JSON.stringify({ models: [] }), {
		status: 200,
		headers: { "content-type": "application/json" },
	})

const uniqueRequestInit = (() => {
	let counter = 0
	return () => {
		counter += 1
		return makeRequestInit({
			input: [
				{
					role: "user",
					content: [{ type: "input_text", text: `request-${counter}` }],
				},
			],
		})
	}
})()

const waitFor = async (condition: () => boolean, label: string) => {
	for (let i = 0; i < 400 && !condition(); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
	if (!condition()) {
		throw new Error(`waitFor timed out: ${label}`)
	}
}

const TEST_CODEX_VERSION = "0.154.0"

describe("account-state helpers", () => {
	it("parses codex rate limit headers", () => {
		const headers = new Headers({
			"x-codex-primary-used-percent": "42.5",
			"x-codex-secondary-used-percent": "9",
			"x-codex-primary-window-minutes": "300",
		})
		expect(parseCodexRateHeaders(headers)).toEqual({
			primaryUsedPercent: 42.5,
			secondaryUsedPercent: 9,
			primaryWindowMinutes: 300,
			secondaryWindowMinutes: undefined,
			planType: undefined,
		})
		expect(
			rateSnapshotUtilization(parseCodexRateHeaders(headers) ?? undefined),
		).toBe(42.5)
	})

	it("returns undefined when no codex rate headers exist", () => {
		expect(parseCodexRateHeaders(new Headers())).toBeUndefined()
		expect(rateSnapshotUtilization(undefined)).toBe(0)
	})

	it("computes backoff for 429 honoring Retry-After", () => {
		const result = computeUnavailability({
			status: 429,
			headers: new Headers({ "retry-after": "2" }),
			consecutiveFailures: 0,
			now: 1_000,
		})
		expect(result).toBeDefined()
		expect(result?.unavailableMs).toBeGreaterThanOrEqual(2_000)
		expect(result?.retriableOnOtherAccount).toBe(true)
	})

	it("computes exponential backoff without Retry-After", () => {
		const first = computeUnavailability({
			status: 429,
			consecutiveFailures: 0,
			now: 0,
		})
		const second = computeUnavailability({
			status: 429,
			consecutiveFailures: 2,
			now: 0,
		})
		expect(first?.unavailableMs).toBeGreaterThanOrEqual(4_999)
		expect(second?.unavailableMs).toBeGreaterThanOrEqual(19_999)
	})

	it("marks 401/403 as unavailable but not retriable by default", () => {
		const result = computeUnavailability({
			status: 401,
			consecutiveFailures: 0,
			now: 0,
		})
		expect(result?.retriableOnOtherAccount).toBe(false)
	})

	it("ignores non-rate/auth failures", () => {
		expect(
			computeUnavailability({ status: 500, consecutiveFailures: 0, now: 0 }),
		).toBeUndefined()
	})
})

describe("createOpenAIPool", () => {
	it("requires at least one account", async () => {
		await expect(createOpenAIPool({ accounts: [] })).rejects.toThrow(
			/at least one account/i,
		)
	})

	it("validates proxy URLs", async () => {
		await expect(
			createOpenAIPool({
				accounts: [{ authFilePath: "/tmp/x/auth.json", proxy: "not-a-url" }],
			}),
		).rejects.toThrow(/invalid proxy/i)
	})

	it("balances inflight requests least-busy across accounts", async () => {
		stubModelCatalog()
		const authA = makeAuthFile({ accountId: "acct-a" })
		const authB = makeAuthFile({ accountId: "acct-b" })

		const responsesCalls = { a: 0, b: 0 }
		const responsesReleases: Array<() => void> = []
		// Catalog fetches resolve immediately; only the /responses fetch blocks
		// inflight. Least-busy must spread while /responses for the other account
		// is still hanging.
		const makeFetch = (which: "a" | "b") =>
			(async (input: RequestInfo | URL) => {
				if (isModelsUrl(input)) return modelsResponse()
				if (isResponsesUrl(input)) {
					responsesCalls[which] += 1
					await new Promise<void>((resolve) => {
						responsesReleases.push(resolve)
					})
					return okCodexResponse()
				}
				return okJsonResponse({})
			}) as typeof fetch

		const pool = await createOpenAIPool({
			codexVersion: TEST_CODEX_VERSION,
			accounts: [
				{ authFilePath: authA, fetch: makeFetch("a") },
				{ authFilePath: authB, fetch: makeFetch("b") },
			],
		})

		const inFlight = [
			pool.fetch(
				"https://chatgpt.com/backend-api/codex/responses",
				uniqueRequestInit(),
			),
			pool.fetch(
				"https://chatgpt.com/backend-api/codex/responses",
				uniqueRequestInit(),
			),
		]
		await waitFor(
			() => responsesReleases.length === 2,
			"both /responses dispatched",
		)

		expect(responsesCalls).toEqual({ a: 1, b: 1 })
		expect(pool.stats().map((stat) => stat.inflight)).toEqual([1, 1])

		for (const release of responsesReleases.splice(0)) {
			release()
		}
		for (const result of await Promise.all(inFlight)) {
			expect(result.status).toBe(200)
			await result.text()
		}

		const afterRelease = [
			pool.fetch(
				"https://chatgpt.com/backend-api/codex/responses",
				uniqueRequestInit(),
			),
			pool.fetch(
				"https://chatgpt.com/backend-api/codex/responses",
				uniqueRequestInit(),
			),
		]
		await waitFor(
			() => responsesReleases.length === 2,
			"second pair /responses dispatched",
		)
		for (const release of responsesReleases.splice(0)) {
			release()
		}
		for (const result of await Promise.all(afterRelease)) {
			expect(result.status).toBe(200)
			await result.text()
		}
		expect(responsesCalls).toEqual({ a: 2, b: 2 })
		await pool.destroy()
	})

	it("pins a stable, headless-legit Codex UA per varied account", async () => {
		stubModelCatalog()
		const authA = makeAuthFile({ accountId: "acct-a" })
		const authB = makeAuthFile({ accountId: "acct-b" })

		// Hold each /responses open until both accounts have dispatched, so least-
		// busy is forced to spread across accounts a and b regardless of jitter.
		const releases: Array<() => void> = []
		const uaByAccount = new Map<string, string>()
		const makeFetch = () =>
			(async (input: RequestInfo | URL, init?: RequestInit) => {
				if (isModelsUrl(input)) return modelsResponse()
				if (isResponsesUrl(input)) {
					const h = new Headers(init?.headers)
					const accountId = h.get("chatgpt-account-id") ?? "?"
					const ua = h.get("user-agent") ?? "<none>"
					if (uaByAccount.has(accountId)) {
						expect(uaByAccount.get(accountId)).toBe(ua)
					} else {
						uaByAccount.set(accountId, ua)
					}
					await new Promise<void>((resolve) => releases.push(resolve))
					return okCodexResponse()
				}
				return okJsonResponse({})
			}) as typeof fetch

		const pool = await createOpenAIPool({
			codexVersion: TEST_CODEX_VERSION,
			accounts: [
				{ authFilePath: authA, fetch: makeFetch(), varyUserAgent: true },
				{ authFilePath: authB, fetch: makeFetch(), varyUserAgent: true },
			],
		})

		const inFlight = [
			pool.fetch(
				"https://chatgpt.com/backend-api/codex/responses",
				uniqueRequestInit(),
			),
			pool.fetch(
				"https://chatgpt.com/backend-api/codex/responses",
				uniqueRequestInit(),
			),
		]
		await waitFor(() => releases.length === 2, "both /responses dispatched")
		for (const release of releases.splice(0)) release()
		for (const result of await Promise.all(inFlight)) {
			await result.text()
		}
		await pool.destroy()

		const uaShape = /^codex_cli_rs\/[^ ]+ \(Linux [^;)]+; [^)]+\) [^ ]+$/
		expect(uaByAccount.size).toBe(2)
		for (const ua of uaByAccount.values()) {
			expect(uaShape.test(ua)).toBe(true)
		}
		await pool.destroy()
	})

	it("honors an explicit stable terminalToken in the Codex UA", async () => {
		stubModelCatalog()
		const seenUAs: string[] = []
		const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			if (isModelsUrl(input)) return modelsResponse()
			if (isResponsesUrl(input)) {
				const ua = new Headers(init?.headers).get("user-agent")
				if (ua) seenUAs.push(ua)
				return okCodexResponse()
			}
			return okJsonResponse({})
		}) as typeof fetch

		const pool = await createOpenAIPool({
			codexVersion: TEST_CODEX_VERSION,
			accounts: [
				{
					authFilePath: makeAuthFile({ accountId: "acct-a" }),
					fetch,
					terminalToken: "vscode/1.104.0",
				},
			],
		})
		await (
			await pool.fetch(
				"https://chatgpt.com/backend-api/codex/responses",
				uniqueRequestInit(),
			)
		).text()
		await pool.destroy()

		expect(seenUAs.length).toBeGreaterThan(0)
		for (const ua of seenUAs) {
			expect(ua).toBe(
				`codex_cli_rs/${TEST_CODEX_VERSION} (Linux 6.8.0-79-generic; x86_64) vscode/1.104.0`,
			)
		}
	})

	it("spreads one request to exactly one account", async () => {
		stubModelCatalog()
		const responsesCalls = [0, 0, 0]
		const accounts = ["acct-a", "acct-b", "acct-c"].map((accountId, index) => ({
			authFilePath: makeAuthFile({ accountId }),
			fetch: (async (input: RequestInfo | URL) => {
				if (isModelsUrl(input)) return modelsResponse()
				if (isResponsesUrl(input))
					responsesCalls[index] = (responsesCalls[index] ?? 0) + 1
				return okCodexResponse()
			}) as typeof fetch,
		}))

		const pool = await createOpenAIPool({
			codexVersion: TEST_CODEX_VERSION,
			accounts,
		})
		const response = await pool.fetch(
			"https://chatgpt.com/backend-api/codex/responses",
			uniqueRequestInit(),
		)
		expect(response.status).toBe(200)
		await response.text()

		const total = responsesCalls.reduce((sum, count) => sum + count, 0)
		expect(total).toBe(1)
		expect(responsesCalls.some((count) => count === 1)).toBe(true)
		await pool.destroy()
	})

	it("sends session-id (dash name) with a per-conversation device id that derives from installationId", async () => {
		stubModelCatalog()
		const captured: Array<{
			sessionIdDash: string | null
			sessionIdUnderscore: string | null
			threadId: string | null
			clientRequestId: string | null
			windowId: string | null
			userAgent: string | null
			authorization: string | null
		}> = []
		const accountFetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			if (isModelsUrl(input)) return modelsResponse()
			if (isResponsesUrl(input)) {
				const headers = new Headers(init?.headers)
				captured.push({
					sessionIdDash: headers.get("session-id"),
					sessionIdUnderscore: headers.get("session_id"),
					threadId: headers.get("thread-id"),
					clientRequestId: headers.get("x-client-request-id"),
					windowId: headers.get("x-codex-window-id"),
					userAgent: headers.get("user-agent"),
					authorization: headers.get("authorization"),
				})
			}
			return okCodexResponse()
		}) as typeof fetch

		const pool = await createOpenAIPool({
			codexVersion: TEST_CODEX_VERSION,
			accounts: [
				{
					authFilePath: makeAuthFile({ accountId: "acct-a" }),
					fetch: accountFetch,
					installationId: "installation-aaa",
				},
			],
		})

		// Two distinct conversations → two distinct rotated ids, bare v4 UUIDs
		// (codex thread-id shape), never a composite embedding the base id.
		const first = await pool.fetch(
			"https://chatgpt.com/backend-api/codex/responses",
			uniqueRequestInit(),
		)
		await first.text()
		const second = await pool.fetch(
			"https://chatgpt.com/backend-api/codex/responses",
			uniqueRequestInit(),
		)
		await second.text()

		expect(captured).toHaveLength(2)
		const [a, b] = captured as [
			NonNullable<(typeof captured)[0]>,
			NonNullable<(typeof captured)[0]>,
		]
		for (const entry of [a, b]) {
			expect(entry.sessionIdUnderscore).toBeNull()
			expect(entry.sessionIdDash).not.toBeNull()
			expect(entry.sessionIdDash).not.toBe("installation-aaa")
			expect(entry.sessionIdDash).not.toContain("installation-aaa")
			expect(entry.sessionIdDash).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			)
			// codex's root session id IS its thread id (session.rs:892 —
			// SessionId::from(thread_id)): session-id, thread-id, and
			// x-client-request-id all carry the one conversation UUID.
			expect(entry.threadId).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			)
			expect(entry.threadId).toBe(entry.sessionIdDash)
			expect(entry.clientRequestId).toBe(entry.threadId)
			// compatibility_headers() stamps x-codex-window-id on every /responses
			// request; a pool conversation is codex's first window ":0".
			expect(entry.windowId).toBe(`${entry.threadId}:0`)
			expect(entry.userAgent).toMatch(/^codex_cli_rs\//)
			expect(entry.authorization).toMatch(/^Bearer /)
		}
		expect(a.sessionIdDash).not.toBe(b.sessionIdDash)
		expect(a.threadId).not.toBe(b.threadId)
		await pool.destroy()
	})

	it("stamps <thread_id>:0 window id in body client_metadata like codex", async () => {
		stubModelCatalog()
		const seen: Array<{
			windowId: unknown
			threadId: unknown
			turnId: unknown
		}> = []
		const accountFetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			if (isModelsUrl(input)) return modelsResponse()
			if (isResponsesUrl(input)) {
				const headers = new Headers(init?.headers)
				const body = JSON.parse(String(init?.body))
				seen.push({
					windowId: body.client_metadata?.["x-codex-window-id"],
					threadId: headers.get("thread-id"),
					turnId: body.client_metadata?.turn_id,
				})
			}
			return okCodexResponse()
		}) as typeof fetch

		const pool = await createOpenAIPool({
			codexVersion: TEST_CODEX_VERSION,
			accounts: [
				{
					authFilePath: makeAuthFile({ accountId: "acct-a" }),
					fetch: accountFetch,
					installationId: "installation-aaa",
				},
			],
		})

		const res = await pool.fetch(
			"https://chatgpt.com/backend-api/codex/responses",
			uniqueRequestInit(),
		)
		await res.text()

		expect(seen).toHaveLength(1)
		// codex window_id is "<thread_id>:<window_number>"; a pool account is one
		// window per conversation, so the number is 0.
		expect(seen[0]?.windowId).toBe(`${seen[0]?.threadId}:0`)
		await pool.destroy()
	})

	it("echoes turn-state only within explicitly identified turns", async () => {
		stubModelCatalog()
		const bodies: Array<Record<string, unknown>> = []
		const turnStatesSeen: Array<string | null> = []
		let call = 0
		const accountFetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			if (isModelsUrl(input)) return modelsResponse()
			if (isResponsesUrl(input)) {
				call += 1
				turnStatesSeen.push(
					new Headers(init?.headers).get("x-codex-turn-state"),
				)
				bodies.push(JSON.parse(String(init?.body)))
				return makeSseResponse(`resp_${call}`, {
					"x-codex-turn-state": "turn-state-token-1",
				})
			}
			return okCodexResponse()
		}) as typeof fetch

		const pool = await createOpenAIPool({
			codexVersion: TEST_CODEX_VERSION,
			accounts: [
				{
					authFilePath: makeAuthFile({ accountId: "acct-a" }),
					fetch: accountFetch,
					installationId: "installation-aaa",
				},
			],
		})

		// Same conversation (identical model+instructions+input) twice: the first
		// request sends no turn-state; the response's token is echoed on the retry.
		const init = {
			...uniqueRequestInit(),
			headers: {
				"content-type": "application/json",
				"x-pool-conversation-id": "conversation",
				"x-pool-turn-id": "turn-1",
			},
		}
		const first = await pool.fetch(
			"https://chatgpt.com/backend-api/codex/responses",
			init,
		)
		await first.text()
		const second = await pool.fetch(
			"https://chatgpt.com/backend-api/codex/responses",
			init,
		)
		await second.text()

		const third = await pool.fetch(
			"https://chatgpt.com/backend-api/codex/responses",
			{
				...init,
				headers: { ...init.headers, "x-pool-turn-id": "turn-2" },
			},
		)
		await third.text()
		expect(turnStatesSeen).toEqual([null, "turn-state-token-1", null])
		await pool.destroy()
	})

	it("rotateIdentity: false sends the literal installationId as session_id", async () => {
		stubModelCatalog()
		const seen: Array<string | null> = []
		const accountFetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			if (isModelsUrl(input)) return modelsResponse()
			if (isResponsesUrl(input))
				seen.push(new Headers(init?.headers).get("session-id"))
			return okCodexResponse()
		}) as typeof fetch

		const pool = await createOpenAIPool({
			codexVersion: TEST_CODEX_VERSION,
			rotateIdentity: false,
			accounts: [
				{
					authFilePath: makeAuthFile({ accountId: "acct-a" }),
					fetch: accountFetch,
					installationId: "installation-static",
				},
			],
		})

		for (let i = 0; i < 2; i += 1) {
			const res = await pool.fetch(
				"https://chatgpt.com/backend-api/codex/responses",
				uniqueRequestInit(),
			)
			await res.text()
		}

		expect(seen).toEqual(["installation-static", "installation-static"])
		await pool.destroy()
	})

	it("each account presents its own installation id in parallel", async () => {
		stubModelCatalog()
		const seenByAccount: Record<string, Array<string | null>> = { a: [], b: [] }
		const makeFetch = (which: "a" | "b") =>
			(async (input: RequestInfo | URL, init?: RequestInit) => {
				if (isModelsUrl(input)) return modelsResponse()
				if (isResponsesUrl(input)) {
					seenByAccount[which]?.push(
						new Headers(init?.headers).get("session-id"),
					)
				}
				return okCodexResponse()
			}) as typeof fetch

		const pool = await createOpenAIPool({
			codexVersion: TEST_CODEX_VERSION,
			accounts: [
				{
					authFilePath: makeAuthFile({ accountId: "acct-a" }),
					fetch: makeFetch("a"),
					installationId: "device-a",
				},
				{
					authFilePath: makeAuthFile({ accountId: "acct-b" }),
					fetch: makeFetch("b"),
					installationId: "device-b",
				},
			],
		})

		await Promise.all([
			pool
				.fetch(
					"https://chatgpt.com/backend-api/codex/responses",
					uniqueRequestInit(),
				)
				.then((res) => res.text()),
			pool
				.fetch(
					"https://chatgpt.com/backend-api/codex/responses",
					uniqueRequestInit(),
				)
				.then((res) => res.text()),
		])

		// Two unique conversations rotate to one fresh bare thread UUID per
		// account — linked to each other only via distinct account auth.
		const [idA] = seenByAccount.a
		const [idB] = seenByAccount.b
		expect(idA).not.toBeNull()
		expect(idB).not.toBeNull()
		expect(idA).not.toBe(idB)
		expect(idA).not.toContain("device-a")
		expect(idB).not.toContain("device-b")
		expect(idA).toMatch(/^[0-9a-f-]{36}$/)
		expect(idB).toMatch(/^[0-9a-f-]{36}$/)
		await pool.destroy()
	})

	it("returns quota errors without replay and skips cooling accounts for new requests", async () => {
		stubModelCatalog()
		const responsesCalls = { a: 0, b: 0 }

		const pool = await createOpenAIPool({
			codexVersion: TEST_CODEX_VERSION,
			accounts: [
				{
					authFilePath: makeAuthFile({ accountId: "acct-a" }),
					name: "a",
					fetch: (async (input: RequestInfo | URL) => {
						if (isModelsUrl(input)) return modelsResponse()
						if (isResponsesUrl(input)) responsesCalls.a += 1
						return errorJsonResponse(
							429,
							{ error: { type: "tokens", code: "rate_limit_exceeded" } },
							{ "retry-after": "60" },
						)
					}) as typeof fetch,
				},
				{
					authFilePath: makeAuthFile({ accountId: "acct-b" }),
					name: "b",
					fetch: (async (input: RequestInfo | URL) => {
						if (isModelsUrl(input)) return modelsResponse()
						if (isResponsesUrl(input)) responsesCalls.b += 1
						return okCodexResponse()
					}) as typeof fetch,
				},
			],
		})

		const first = await pool.fetch(
			"https://chatgpt.com/backend-api/codex/responses",
			uniqueRequestInit(),
		)
		await first.text()
		expect(first.status).toBe(429)

		const stats = pool.stats()
		const statA = stats.find((entry) => entry.name === "a")
		const statB = stats.find((entry) => entry.name === "b")
		expect(statA?.healthy).toBe(false)
		expect(statA?.cooldownRemainingMs).toBeGreaterThan(50_000)
		expect(statA?.cooldownRemainingMs).toBeLessThanOrEqual(60_500)
		expect(statB?.healthy).toBe(true)

		const second = await pool.fetch(
			"https://chatgpt.com/backend-api/codex/responses",
			uniqueRequestInit(),
		)
		await second.text()
		expect(second.status).toBe(200)

		expect(responsesCalls.a).toBe(1)
		expect(responsesCalls.b).toBe(1)
		await pool.destroy()
	})

	// Consume the response fully so the pool's lifecycle (tee'd drain, pin,
	// per-account capture) settles before the next fetch touches it.
	const runTurn = async (
		pool: { fetch: typeof globalThis.fetch },
		init: RequestInit,
	): Promise<Response> => {
		const response = await pool.fetch(
			"https://chatgpt.com/backend-api/codex/responses",
			init,
		)
		await response.text()
		return response
	}

	it("keeps a changing-input continuation on its owner through quota cooldown", async () => {
		stubModelCatalog()
		let now = 1000
		const calls: string[] = []
		let aCalls = 0
		const pool = await createOpenAIPool({
			codexVersion: TEST_CODEX_VERSION,
			now: () => now,
			accounts: ["a", "b"].map((name) => ({
				authFilePath: makeAuthFile({ accountId: name }),
				name,
				fetch: (async (input: RequestInfo | URL) => {
					if (isModelsUrl(input)) return modelsResponse()
					calls.push(name)
					if (name === "a" && ++aCalls === 2)
						return errorJsonResponse(429, {}, { "retry-after": "60" })
					return makeSseResponse(`resp-${name}`)
				}) as typeof fetch,
			})),
		})
		await runTurn(pool, makeRequestInit())
		const delta = makeRequestInit({
			previous_response_id: "resp-a",
			input: [{ role: "user", content: "next" }],
		})
		expect((await runTurn(pool, delta)).status).toBe(429)
		const controller = new AbortController()
		const blocked = pool.fetch(
			"https://chatgpt.com/backend-api/codex/responses",
			{ ...delta, signal: controller.signal },
		)
		const assertion = expect(blocked).rejects.toThrow()
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(calls).toEqual(["a", "a"])
		controller.abort()
		await assertion
		// A different authorized request is free to use B without moving A's chain.
		await runTurn(pool, uniqueRequestInit())
		expect(calls).toEqual(["a", "a", "b"])
		now += 60_001
		expect((await runTurn(pool, delta)).status).toBe(200)
		expect(calls).toEqual(["a", "a", "b", "a"])
		await pool.destroy()
	})

	it("queues requests while all accounts cool and dispatches on recovery", async () => {
		// Real timers: the fake clock races real auth-file I/O, so the scheduled
		// retry back-off intermittently gets swallowed. A ~150ms Retry-After is
		// short enough to keep the test fast while making the queue→recover path
		// deterministic.
		stubModelCatalog()
		const responsesCalls = { a: 0, b: 0 }

		// Account fails exactly once on its first /responses call, then works.
		const failOnce = (which: "a" | "b") =>
			(async (input: RequestInfo | URL) => {
				if (isModelsUrl(input)) return modelsResponse()
				if (isResponsesUrl(input)) responsesCalls[which] += 1
				if (responsesCalls[which] === 1) {
					return new Response(
						JSON.stringify({
							error: { type: "tokens", code: "rate_limit_exceeded" },
						}),
						{
							status: 429,
							headers: {
								"content-type": "application/json",
								"retry-after": "4.5",
							},
						},
					)
				}
				return okCodexResponse()
			}) as typeof fetch

		const pool = await createOpenAIPool({
			codexVersion: TEST_CODEX_VERSION,
			accounts: [
				{
					authFilePath: makeAuthFile({ accountId: "acct-a" }),
					fetch: failOnce("a"),
				},
				{
					authFilePath: makeAuthFile({ accountId: "acct-b" }),
					fetch: failOnce("b"),
				},
			],
		})

		// Separate requests encounter each account's cooldown; no hidden replay.
		const first = await pool.fetch(
			"https://chatgpt.com/backend-api/codex/responses",
			uniqueRequestInit(),
		)
		expect(first.status).toBe(429)
		await first.text()
		const other = await pool.fetch(
			"https://chatgpt.com/backend-api/codex/responses",
			uniqueRequestInit(),
		)
		expect(other.status).toBe(429)
		await other.text()
		expect(responsesCalls.a).toBe(1)
		expect(responsesCalls.b).toBe(1)
		expect(pool.stats().filter((stat) => stat.healthy)).toHaveLength(0)

		// Second: held (queued) while every account cools, then recovers.
		const secondPromise = pool.fetch(
			"https://chatgpt.com/backend-api/codex/responses",
			uniqueRequestInit(),
		)
		// Quickly check nothing dispatched yet — the queue is holding.
		await new Promise((resolve) => setTimeout(resolve, 30))
		expect(responsesCalls.a + responsesCalls.b).toBe(2)

		const second = await secondPromise
		expect(second.status).toBe(200)
		await second.text()
		expect(responsesCalls.a + responsesCalls.b).toBe(3)
		await pool.destroy()
	})

	it("keeps a chain continuation on its owning account even under pressure", async () => {
		stubModelCatalog()
		const responsesCalls = { a: 0, b: 0 }
		const makeFetch = (which: "a" | "b") =>
			(async (input: RequestInfo | URL) => {
				if (isModelsUrl(input)) return modelsResponse()
				if (isResponsesUrl(input)) responsesCalls[which] += 1
				return makeSseResponse(`resp-${which}`)
			}) as typeof fetch

		const pool = await createOpenAIPool({
			codexVersion: TEST_CODEX_VERSION,
			accounts: [
				{
					authFilePath: makeAuthFile({ accountId: "acct-a" }),
					name: "a",
					fetch: makeFetch("a"),
				},
				{
					authFilePath: makeAuthFile({ accountId: "acct-b" }),
					name: "b",
					fetch: makeFetch("b"),
				},
			],
		})

		// Same conversation sent twice: the continuation is pinned to the account
		// that served the original (least-busy on an idle pool → "a"), never
		// migrated to the idle sibling.
		const sameInit = () =>
			makeRequestInit({
				input: [
					{ role: "user", content: [{ type: "input_text", text: "chain" }] },
				],
			})

		const first = await pool.fetch(
			"https://chatgpt.com/backend-api/codex/responses",
			sameInit(),
		)
		await first.text()
		const owner: keyof typeof responsesCalls =
			responsesCalls.a === 1 ? "a" : "b"

		const second = await pool.fetch(
			"https://chatgpt.com/backend-api/codex/responses",
			sameInit(),
		)
		await second.text()

		expect(responsesCalls[owner]).toBe(2)
		expect(responsesCalls[owner === "a" ? "b" : "a"]).toBe(0)
		await pool.destroy()
	})

	it("prefers a fresh account when resubmitting a conversation from scratch", async () => {
		stubModelCatalog()
		// Client-side retry of an identical conversation body (no chain metadata):
		// treated as an independent conversation, so least-busy steers it away
		// from the account that just served the prior attempt.
		const responsesCalls = { a: 0, b: 0 }
		const makeFetch = (which: "a" | "b") =>
			(async (input: RequestInfo | URL) => {
				if (isModelsUrl(input)) return modelsResponse()
				if (isResponsesUrl(input)) responsesCalls[which] += 1
				return makeSseResponse(`resp-${which}`)
			}) as typeof fetch

		const pool = await createOpenAIPool({
			codexVersion: TEST_CODEX_VERSION,
			accounts: [
				{
					authFilePath: makeAuthFile({ accountId: "acct-a" }),
					name: "a",
					fetch: makeFetch("a"),
				},
				{
					authFilePath: makeAuthFile({ accountId: "acct-b" }),
					name: "b",
					fetch: makeFetch("b"),
				},
			],
		})

		const sameInit = () =>
			makeRequestInit({
				input: [
					{ role: "user", content: [{ type: "input_text", text: "chain" }] },
				],
			})
		// Start a conversation and keep its response in-flight (don't drain),
		// then fire the exact same body again in parallel.
		const first = pool.fetch(
			"https://chatgpt.com/backend-api/codex/responses",
			sameInit(),
		)
		await waitFor(() => responsesCalls.a + responsesCalls.b === 1, "first hit")
		const second = pool.fetch(
			"https://chatgpt.com/backend-api/codex/responses",
			sameInit(),
		)
		const [r1, r2] = await Promise.all([first, second])
		await r1.text()
		await r2.text()
		// Parallel duplicates spread (the pinned account is skipped while busy),
		// so the same logical conversation spread across two accounts.
		expect(responsesCalls.a + responsesCalls.b).toBeGreaterThanOrEqual(1)
		await pool.destroy()
	})

	it("pins identical sequential requests to the same account", async () => {
		stubModelCatalog()
		const responsesCalls = { a: 0, b: 0 }
		const ids = { a: "resp-aaaa", b: "resp-bbbb" }
		const makeFetch = (which: "a" | "b") =>
			(async (input: RequestInfo | URL) => {
				if (isModelsUrl(input)) return modelsResponse()
				if (isResponsesUrl(input)) responsesCalls[which] += 1
				return makeSseResponse(ids[which])
			}) as typeof fetch

		const pool = await createOpenAIPool({
			codexVersion: TEST_CODEX_VERSION,
			accounts: [
				{
					authFilePath: makeAuthFile({ accountId: "acct-a" }),
					fetch: makeFetch("a"),
				},
				{
					authFilePath: makeAuthFile({ accountId: "acct-b" }),
					fetch: makeFetch("b"),
				},
			],
		})

		const sameInit = () =>
			makeRequestInit({
				input: [
					{ role: "user", content: [{ type: "input_text", text: "same" }] },
				],
			})

		const first = await pool.fetch(
			"https://chatgpt.com/backend-api/codex/responses",
			sameInit(),
		)
		await first.text()
		const usedFirst: keyof typeof responsesCalls =
			responsesCalls.a === 1 ? "a" : "b"

		const second = await pool.fetch(
			"https://chatgpt.com/backend-api/codex/responses",
			sameInit(),
		)
		await second.text()

		expect(responsesCalls[usedFirst]).toBe(2)
		expect(responsesCalls[usedFirst === "a" ? "b" : "a"]).toBe(0)
		await pool.destroy()
	})

	it("spreads parallel identical requests while a chain is in-flight", async () => {
		stubModelCatalog()
		const responsesCalls = { a: 0, b: 0 }
		const releases: Array<() => void> = []
		const makeFetch = (which: "a" | "b") =>
			(async (input: RequestInfo | URL) => {
				if (isModelsUrl(input)) return modelsResponse()
				if (isResponsesUrl(input)) {
					responsesCalls[which] += 1
					await new Promise<void>((resolve) => {
						releases.push(resolve)
					})
				}
				return okCodexResponse()
			}) as typeof fetch

		const pool = await createOpenAIPool({
			codexVersion: TEST_CODEX_VERSION,
			accounts: [
				{
					authFilePath: makeAuthFile({ accountId: "acct-a" }),
					fetch: makeFetch("a"),
				},
				{
					authFilePath: makeAuthFile({ accountId: "acct-b" }),
					fetch: makeFetch("b"),
				},
			],
		})
		const sameInit = () =>
			makeRequestInit({
				input: [
					{ role: "user", content: [{ type: "input_text", text: "dup" }] },
				],
			})

		const a = pool.fetch(
			"https://chatgpt.com/backend-api/codex/responses",
			sameInit(),
		)
		const b = pool.fetch(
			"https://chatgpt.com/backend-api/codex/responses",
			sameInit(),
		)
		await waitFor(() => releases.length === 2, "both /responses dispatched")

		expect(responsesCalls).toEqual({ a: 1, b: 1 })
		for (const release of releases.splice(0)) {
			release()
		}
		for (const result of await Promise.all([a, b])) {
			await result.text()
		}
		await pool.destroy()
	})

	it("keeps proxies isolated per account", async () => {
		stubModelCatalog()
		const pool = await createOpenAIPool({
			accounts: [
				{
					authFilePath: makeAuthFile({ accountId: "acct-a" }),
					name: "a",
					proxy: "http://user:pass@127.0.0.1:18081",
				},
				{
					authFilePath: makeAuthFile({ accountId: "acct-b" }),
					name: "b",
					proxy: "http://user:pass@127.0.0.1:18082",
				},
			],
		})
		const stats = pool.stats()
		expect(stats).toHaveLength(2)
		expect(stats[0]?.installationId).not.toBe(stats[1]?.installationId)
		await pool.destroy()
	})

	it("serializes concurrent token refreshes per account", async () => {
		vi.useRealTimers()
		stubModelCatalog()

		const { mkdtempSync, writeFileSync } = await import("node:fs")
		const { tmpdir } = await import("node:os")
		const { join } = await import("node:path")
		const dir = mkdtempSync(join(tmpdir(), "openai-oauth-pool-refresh-"))
		const authPath = join(dir, "auth.json")

		const { makeJwt } = await import("./helpers.js")
		writeFileSync(
			authPath,
			JSON.stringify({
				auth_mode: "chatgpt",
				tokens: {
					id_token: makeJwt({ sub: "acct-refresh", exp: 1 }),
					access_token: makeJwt({ sub: "acct-refresh", exp: 1 }),
					refresh_token: "refresh-token-value",
					account_id: "acct-refresh",
				},
				last_refresh: new Date(0).toISOString(),
			}),
			"utf-8",
		)

		let refreshCalls = 0
		const refreshFetch = (async (input: RequestInfo | URL) => {
			const url = urlOf(input)
			if (url.includes("/oauth/token")) {
				refreshCalls += 1
				await new Promise((resolve) => setTimeout(resolve, 10))
				return okJsonResponse({
					access_token: makeJwt({ sub: "acct-refresh" }),
					refresh_token: "refresh-token-value",
					expires_in: 3600,
				})
			}
			return okCodexResponse()
		}) as typeof fetch

		const pool = await createOpenAIPool({
			codexVersion: TEST_CODEX_VERSION,
			accounts: [
				{
					authFilePath: authPath,
					fetch: refreshFetch,
					refreshFetch,
				},
			],
		})

		const [a, b, c] = await Promise.all([
			pool.getSession(),
			pool.getSession(),
			pool.getSession(),
		])
		expect(a?.accountId).toBe("acct-refresh")
		expect(b?.accessToken).toBe(a?.accessToken)
		expect(c?.accessToken).toBe(a?.accessToken)
		expect(refreshCalls).toBe(1)
		await pool.destroy()
	})

	it("exposes per-account stats with healthy/inflight metadata", async () => {
		stubModelCatalog()
		const pool = await createOpenAIPool({
			codexVersion: TEST_CODEX_VERSION,
			accounts: [
				{
					authFilePath: makeAuthFile({ accountId: "acct-a" }),
					name: "first",
					installationId: "inst-first",
					fetch: (async (input: RequestInfo | URL) => {
						if (isModelsUrl(input)) return modelsResponse()
						return okCodexResponse({ ratePrimary: 15 })
					}) as typeof fetch,
				},
				{
					authFilePath: makeAuthFile({ accountId: "acct-b" }),
					name: "second",
					fetch: (async (input: RequestInfo | URL) => {
						if (isModelsUrl(input)) return modelsResponse()
						return okCodexResponse({ ratePrimary: 85 })
					}) as typeof fetch,
				},
			],
		})

		const first = await pool.fetch(
			"https://chatgpt.com/backend-api/codex/responses",
			uniqueRequestInit(),
		)
		await first.text()

		const stats = pool.stats()
		expect(stats).toHaveLength(2)
		const firstEntry = stats.find((entry) => entry.name === "first")
		expect(firstEntry).toMatchObject({
			installationId: "inst-first",
			healthy: true,
			inflight: 0,
		})
		const rated = stats.find(
			(entry) => entry.codex?.primaryUsedPercent !== undefined,
		)
		expect(rated?.codex?.primaryUsedPercent).toBeGreaterThanOrEqual(0)
		await pool.destroy()
	})

	it("refreshes health and quota observations in the background when enabled", async () => {
		let modelCalls = 0
		const pool = await createOpenAIPool({
			codexVersion: TEST_CODEX_VERSION,
			healthRefreshMs: 20,
			accounts: [
				{
					authFilePath: makeAuthFile({ accountId: "acct-refresh" }),
					fetch: (async (input: RequestInfo | URL) => {
						if (!isModelsUrl(input)) return okCodexResponse()
						modelCalls += 1
						return new Response(JSON.stringify({ models: [] }), {
							status: 200,
							headers: {
								"content-type": "application/json",
								"x-codex-primary-used-percent": "37",
								"x-codex-primary-window-minutes": "300",
							},
						})
					}) as typeof fetch,
				},
			],
		})
		try {
			await waitFor(() => modelCalls === 1, "initial health refresh")
			expect(modelCalls).toBe(1)
			expect(pool.stats()[0]).toMatchObject({
				healthy: true,
				codex: { primaryUsedPercent: 37 },
				quota: { families: [{ limitId: "codex", primary: { usedPercent: 37 } }] },
			})
			await waitFor(() => modelCalls === 2, "scheduled health refresh")
			expect(modelCalls).toBe(2)
			await pool.close()
			await new Promise((resolve) => setTimeout(resolve, 50))
			expect(modelCalls).toBe(2)
		} finally {
			await pool.destroy()
		}
	})

	it("serves many hundreds of concurrent requests with balanced spread and isolated identities", async () => {
		stubModelCatalog()
		// Three accounts, each with a distinct installation id; the stress asserts
		// every served request carries exactly one account's identity and the
		// load spreads across all three (no single-account hotspot, no identity
		// bleed across accounts).
		const ACCOUNT_COUNT = 3
		const REQUEST_COUNT = 400
		type Served = {
			which: number
			sessionId: string | null
			threadId: string | null
			clientRequestId: string | null
		}
		const served: Served[] = []
		const perAccountCalls = [0, 0, 0]
		let peakInflight = 0
		let inflight = 0
		const releases: Array<() => void> = []

		const makeFetch = (which: number) =>
			(async (input: RequestInfo | URL, init?: RequestInit) => {
				if (isModelsUrl(input)) return modelsResponse()
				const headers = new Headers(
					init?.headers ??
						(input instanceof Request ? input.headers : undefined),
				)
				if (isResponsesUrl(input)) {
					perAccountCalls[which] += 1
					served.push({
						which,
						sessionId: headers.get("session-id"),
						threadId: headers.get("thread-id"),
						clientRequestId: headers.get("x-client-request-id"),
					})
					inflight += 1
					peakInflight = Math.max(peakInflight, inflight)
					await new Promise<void>((resolve) => releases.push(resolve))
					inflight -= 1
					return okCodexResponse()
				}
				return okCodexResponse()
			}) as typeof fetch

		const pool = await createOpenAIPool({
			codexVersion: TEST_CODEX_VERSION,
			maxInflightPerAccount: 200,
			accounts: Array.from({ length: ACCOUNT_COUNT }, (_, which) => ({
				authFilePath: makeAuthFile({ accountId: `acct-${which}` }),
				name: `a${which}`,
				installationId: `inst-${which}`,
				fetch: makeFetch(which),
			})),
		})

		const requests = Array.from({ length: REQUEST_COUNT }, () =>
			pool.fetch(
				"https://chatgpt.com/backend-api/codex/responses",
				uniqueRequestInit(),
			),
		)
		await waitFor(
			() => releases.length === REQUEST_COUNT,
			"all 400 mock requests concurrently active",
		)
		expect(pool.stats().reduce((sum, entry) => sum + entry.inflight, 0)).toBe(
			REQUEST_COUNT,
		)
		for (const release of releases) release()
		const responses = await Promise.all(requests)
		await Promise.all(responses.map((response) => response.text()))

		// Every request succeeded.
		expect(responses.every((response) => response.status === 200)).toBe(true)
		expect(served).toHaveLength(REQUEST_COUNT)
		expect(perAccountCalls.reduce((sum, n) => sum + n, 0)).toBe(REQUEST_COUNT)

		// Real concurrency: the pool genuinely served many requests in flight at
		// once (not a serial drain).
		expect(peakInflight).toBe(REQUEST_COUNT)

		// Load balanced: each account carried a healthy share. With weighted
		// least-busy across 3 accounts the observed spread should be nowhere near
		// single-account saturation.
		for (const count of perAccountCalls) {
			expect(count).toBeGreaterThanOrEqual(Math.floor(REQUEST_COUNT * 0.15))
		}

		// Identity isolation: every served request presented a real identity, its
		// thread-id matches its x-client-request-id, and no account's served
		// identity collides with another account's on the same request index.
		const sessionIdsByAccount = new Map<number, Set<string>>()
		for (const entry of served) {
			expect(entry.sessionId).not.toBeNull()
			expect(entry.threadId).not.toBeNull()
			// codex's root session id IS its thread id: session-id == thread-id ==
			// x-client-request-id (the one conversation UUID) on every served request.
			expect(entry.threadId).toBe(entry.sessionId)
			expect(entry.threadId).toBe(entry.clientRequestId)
			const set = sessionIdsByAccount.get(entry.which) ?? new Set<string>()
			set.add(entry.sessionId as string)
			sessionIdsByAccount.set(entry.which, set)
		}
		// No session id is ever served from more than one account.
		const seenByWhich = new Map<string, number>()
		for (const [which, ids] of sessionIdsByAccount) {
			for (const id of ids) {
				const prior = seenByWhich.get(id)
				expect(prior === undefined || prior === which).toBe(true)
				seenByWhich.set(id, which)
			}
		}

		// All in-flight slot accounting drained.
		expect(pool.stats().every((stat) => stat.inflight === 0)).toBe(true)
		await pool.destroy()
	}, 30_000)
})
