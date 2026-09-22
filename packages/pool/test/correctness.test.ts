import { readFileSync, writeFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	computeUnavailability,
	parseCodexRateHeaders,
	rateSnapshotUtilization,
} from "../src/account-state.js"
import { createOpenAIPool } from "../src/pool.js"
import { validateProxyUrl } from "../src/runtime.js"
import {
	errorJsonResponse,
	makeAuthFile,
	makeJwt,
	makeRequestInit,
	makeSseResponse,
} from "./helpers.js"

const url = "https://chatgpt.com/backend-api/codex/responses"
const models = () =>
	new Response(JSON.stringify({ models: [] }), {
		headers: { "content-type": "application/json" },
	})
const isModels = (input: RequestInfo | URL) => String(input).includes("/models")
afterEach(() => vi.restoreAllMocks())
const until = async (condition: () => boolean) => {
	for (let i = 0; i < 400 && !condition(); i++)
		await new Promise((resolve) => setTimeout(resolve, 5))
	expect(condition()).toBe(true)
}

const mockNetwork = () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => models()),
	)
}

afterEach(() => vi.unstubAllGlobals())

describe("pool correctness", () => {
	it("rejects unknown continuation IDs without contacting any account", async () => {
		mockNetwork()
		const fetch = vi.fn(async () => makeSseResponse("x"))
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			accounts: [{ authFilePath: makeAuthFile({ accountId: "a" }), fetch }],
		})
		await expect(
			pool.fetch(
				url,
				makeRequestInit({
					previous_response_id: "unknown",
					input: [{ role: "user", content: "delta" }],
				}),
			),
		).rejects.toThrow(/owner is unknown/)
		expect(fetch).not.toHaveBeenCalled()
		await pool.destroy()
	})

	it("mints only new installation IDs as v4 and preserves persisted identities", async () => {
		mockNetwork()
		const path = makeAuthFile({ accountId: "a" })
		const pool = await createOpenAIPool({ accounts: [{ authFilePath: path }] })
		const id = pool.stats()[0]?.installationId
		expect(id).toMatch(/^[a-f0-9-]{14}4[a-f0-9-]{21}$/)
		await pool.destroy()
		const data = JSON.parse(readFileSync(path, "utf8"))
		data.installation_id = "existing-installation"
		writeFileSync(path, JSON.stringify(data))
		const next = await createOpenAIPool({ accounts: [{ authFilePath: path }] })
		expect(next.stats()[0]?.installationId).toBe("existing-installation")
		await next.destroy()
	})

	it("does not poison later credential loads after one rejection", async () => {
		mockNetwork()
		const path = makeAuthFile({ accountId: "a" })
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			accounts: [{ authFilePath: path }],
		})
		const valid = readFileSync(path, "utf8")
		writeFileSync(path, "not json")
		await expect(pool.getSession()).rejects.toThrow()
		writeFileSync(path, valid)
		expect((await pool.getSession())?.accountId).toBe("a")
		await pool.destroy()
	})

	it("serializes expired-credential refresh through HTTP and public loading", async () => {
		mockNetwork()
		const path = makeAuthFile({ accountId: "a" })
		const data = JSON.parse(readFileSync(path, "utf8"))
		data.tokens.access_token = makeJwt({
			exp: 1,
			"https://api.openai.com/auth": { chatgpt_account_id: "a" },
		})
		data.tokens.refresh_token = "refresh"
		writeFileSync(path, JSON.stringify(data))
		let release: () => void = () => {}
		let refreshes = 0
		const fetch = vi.fn(async (input: RequestInfo | URL) => {
			if (String(input).includes("oauth/token")) {
				refreshes++
				await new Promise<void>((resolve) => {
					release = resolve
				})
				return new Response(
					JSON.stringify({
						access_token: makeJwt({
							"https://api.openai.com/auth": { chatgpt_account_id: "a" },
						}),
						refresh_token: "next",
					}),
					{ headers: { "content-type": "application/json" } },
				)
			}
			if (isModels(input)) return models()
			return makeSseResponse("a")
		})
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			accounts: [{ authFilePath: path, fetch }],
		})
		const first = pool.fetch(url, makeRequestInit())
		const second = pool.fetch(url, makeRequestInit())
		const session = pool.getSession()
		await until(() => refreshes > 0)
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(refreshes).toBe(1)
		release()
		await Promise.all(
			(await Promise.all([first, second])).map((response) => response.text()),
		)
		await session
		expect(refreshes).toBe(1)
		await pool.destroy()
	})

	it("holds inflight leases through consumer cancellation and unblocks queues", async () => {
		mockNetwork()
		let calls = 0
		let cancelled = false
		const fetch = async (input: RequestInfo | URL) => {
			if (isModels(input)) return models()
			calls++
			return new Response(
				new ReadableStream<Uint8Array>({
					cancel() {
						cancelled = true
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			)
		}
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			maxInflightPerAccount: 1,
			accounts: [{ authFilePath: makeAuthFile({ accountId: "a" }), fetch }],
		})
		const first = await pool.fetch(url, makeRequestInit({ stream: true }))
		expect(pool.stats()[0]?.inflight).toBe(1)
		const second = pool.fetch(url, makeRequestInit({ stream: true }))
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(calls).toBe(1)
		await first.body?.cancel()
		expect(cancelled).toBe(true)
		await (await second).body?.cancel()
		expect(pool.stats()[0]?.inflight).toBe(0)
		await pool.destroy()
	})

	it("aborts queued work and rejects pending/new work on close", async () => {
		mockNetwork()
		const fetch = async (input: RequestInfo | URL) =>
			isModels(input)
				? models()
				: errorJsonResponse(429, {}, { "retry-after": "60" })
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			accounts: [{ authFilePath: makeAuthFile({ accountId: "a" }), fetch }],
		})
		await (await pool.fetch(url, makeRequestInit())).text()
		const controller = new AbortController()
		const queued = pool.fetch(url, {
			...makeRequestInit(),
			signal: controller.signal,
		})
		const assertion = expect(queued).rejects.toThrow()
		controller.abort()
		await assertion
		const another = pool.fetch(url, makeRequestInit())
		const closeAssertion = expect(another).rejects.toThrow(/closed/)
		await pool.close()
		await closeAssertion
		await expect(pool.fetch(url, makeRequestInit())).rejects.toThrow(/closed/)
		await pool.destroy()
	})

	it("preserves Request-object headers, body and signal", async () => {
		mockNetwork()
		const fetch = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (isModels(input)) return models()
				expect(new Headers(init?.headers).get("x-custom")).toBe("preserved")
				expect(JSON.parse(String(init?.body)).input).toEqual([
					{ role: "user", content: "request-object" },
				])
				return makeSseResponse("request")
			},
		)
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			accounts: [{ authFilePath: makeAuthFile({ accountId: "a" }), fetch }],
		})
		const request = new Request(url, {
			...makeRequestInit({
				input: [{ role: "user", content: "request-object" }],
			}),
			headers: { "content-type": "application/json", "x-custom": "preserved" },
		})
		await (await pool.fetch(request)).text()
		await pool.destroy()
	})

	it("uses HTTP for a configured custom route even when websocket was requested", async () => {
		mockNetwork()
		const fetch = vi.fn(async (input: RequestInfo | URL) =>
			isModels(input) ? models() : makeSseResponse("routed"),
		)
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			accounts: [
				{
					authFilePath: makeAuthFile({ accountId: "a" }),
					fetch,
					transport: "websocket",
				},
			],
		})
		expect(pool.stats()[0]?.transport).toBe("http")
		await (await pool.fetch(url, makeRequestInit())).text()
		expect(fetch).toHaveBeenCalled()
		await pool.destroy()
	})

	it("redacts malformed proxy userinfo and rejects unsupported SOCKS routing", () => {
		expect(() => validateProxyUrl("http://secret:password@[broken")).toThrow(
			"Invalid proxy URL",
		)
		try {
			validateProxyUrl("http://secret:password@[broken")
		} catch (error) {
			expect(String(error)).not.toContain("secret")
			expect(String(error)).not.toContain("password")
		}
		expect(() => validateProxyUrl("socks5h://localhost:1234")).toThrow(
			/Unsupported/,
		)
	})
})

describe("pool quota observations", () => {
	it("uses saturated reset-at epoch seconds and not window duration", () => {
		const headers = new Headers({
			"x-codex-primary-used-percent": "100",
			"x-codex-primary-window-minutes": "300",
			"x-codex-primary-reset-at": "150",
			"retry-after": "2",
		})
		const snapshot = parseCodexRateHeaders(headers, 100_000)
		expect(snapshot).toMatchObject({
			observedAt: 100_000,
			primaryResetAt: 150_000,
			primaryWindowMinutes: 300,
		})
		expect(
			computeUnavailability({
				status: 429,
				headers,
				now: 100_000,
				consecutiveFailures: 0,
			})?.unavailableMs,
		).toBe(50_000)
		headers.delete("x-codex-primary-reset-at")
		expect(
			computeUnavailability({
				status: 429,
				headers,
				now: 100_000,
				consecutiveFailures: 0,
			})?.unavailableMs,
		).toBe(2_000)
		expect(rateSnapshotUtilization(snapshot, 500_001)).toBe(0)
	})
	it("honors Retry-After HTTP dates without parsing the day as seconds", () => {
		const headers = new Headers({
			"retry-after": new Date(200_000).toUTCString(),
		})
		expect(
			computeUnavailability({
				status: 429,
				headers,
				now: 100_000,
				consecutiveFailures: 0,
			})?.unavailableMs,
		).toBe(100_000)
	})
})

describe("pool body-read cancellation", () => {
	it("cancels a pending input source when the caller aborts", async () => {
		mockNetwork()
		let cancelled = false
		const source = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true
			},
		})
		const pool = await createOpenAIPool({
			accounts: [{ authFilePath: makeAuthFile({ accountId: "a" }) }],
		})
		const controller = new AbortController()
		const init = {
			method: "POST",
			body: source,
			signal: controller.signal,
			duplex: "half",
		} as RequestInit
		const pending = pool.fetch(url, init)
		const assertion = expect(pending).rejects.toThrow()
		await new Promise((resolve) => setTimeout(resolve, 5))
		controller.abort()
		await assertion
		await until(() => cancelled)
		await pool.destroy()
	})
})

describe("pool auth owner routing", () => {
	it("does not carry turn state across a FedRAMP realm change on the same account", async () => {
		mockNetwork()
		const path = makeAuthFile({ accountId: "a" })
		const seen: Array<{ state: string | null; fedramp: string | null }> = []
		const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
			if (isModels(input)) return models()
			const headers = new Headers(init?.headers)
			seen.push({
				state: headers.get("x-codex-turn-state"),
				fedramp: headers.get("x-openai-fedramp"),
			})
			return makeSseResponse("r", { "x-codex-turn-state": "sticky" })
		}
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			accounts: [{ authFilePath: path, fetch }],
		})
		const init = {
			...makeRequestInit(),
			headers: {
				"content-type": "application/json",
				"x-pool-conversation-id": "conv",
				"x-pool-turn-id": "turn",
			},
		}
		await (await pool.fetch(url, init)).text()
		const auth = JSON.parse(readFileSync(path, "utf8"))
		auth.tokens.access_token = makeJwt({
			"https://api.openai.com/auth": {
				chatgpt_account_id: "a",
				chatgpt_account_is_fedramp: true,
			},
		})
		writeFileSync(path, JSON.stringify(auth))
		// A new explicit conversation remains the same text but does not claim an
		// old owner. A prior bound conversation must reject the realm change.
		await expect(pool.fetch(url, init)).rejects.toThrow(/owner changed/)
		await (
			await pool.fetch(url, {
				...init,
				headers: { ...init.headers, "x-pool-conversation-id": "new" },
			})
		).text()
		expect(seen).toEqual([
			{ state: null, fedramp: null },
			{ state: null, fedramp: "true" },
		])
		await pool.destroy()
	})
})

describe("pool Responses input and SSE boundaries", () => {
	it("normalizes case-insensitive JSON MIME and never forwards the internal owner header", async () => {
		mockNetwork()
		const fetch = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (isModels(input)) return models()
				const headers = new Headers(init?.headers)
				expect(headers.get("content-type")).toBe("application/json")
				expect(headers.has("x-pool-expected-account-id")).toBe(false)
				expect(JSON.parse(String(init?.body)).stream).toBe(true)
				return makeSseResponse("uppercase-mime")
			},
		)
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			accounts: [{ authFilePath: makeAuthFile({ accountId: "a" }), fetch }],
		})
		const response = await pool.fetch(url, {
			...makeRequestInit({ stream: false }),
			headers: { "content-type": "Application/JSON; charset=utf-8" },
		})
		expect((await response.json()).id).toBe("uppercase-mime")
		await pool.destroy()
	})
	it.each([
		{ body: "broken", type: "application/json" },
		{ body: "null", type: "application/json" },
		{ body: "{}", type: "text/plain" },
	])("rejects unsupported body $body / $type without dispatch", async ({
		body,
		type,
	}) => {
		mockNetwork()
		const fetch = vi.fn(async () => makeSseResponse("unexpected"))
		const pool = await createOpenAIPool({
			accounts: [{ authFilePath: makeAuthFile({ accountId: "a" }), fetch }],
		})
		await expect(
			pool.fetch(url, {
				method: "POST",
				body,
				headers: { "content-type": type },
			}),
		).rejects.toThrow(/Pool Responses/)
		expect(fetch).not.toHaveBeenCalled()
		await pool.destroy()
	})
	it("indexes completed CR-only SSE so a delta stays on its owner", async () => {
		mockNetwork()
		const calls: string[] = []
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			accounts: ["a", "b"].map((account) => ({
				authFilePath: makeAuthFile({ accountId: account }),
				fetch: async (input: RequestInfo | URL) => {
					if (isModels(input)) return models()
					calls.push(account)
					return new Response(
						`event: response.completed\rdata: ${JSON.stringify({ type: "response.completed", response: { id: "r-cr", status: "completed", output: [] } })}\r\r`,
						{ headers: { "content-type": "text/event-stream" } },
					)
				},
			})),
		})
		await (await pool.fetch(url, makeRequestInit({ stream: true }))).text()
		await (
			await pool.fetch(
				url,
				makeRequestInit({
					stream: true,
					previous_response_id: "r-cr",
					input: [{ role: "user", content: "next" }],
				}),
			)
		).text()
		expect(calls).toEqual(["a", "a"])
		await pool.destroy()
	})
})
