import { afterEach, describe, expect, test, vi } from "vitest"
import type { PoolDiagnosticsSource } from "../src/pool-diagnostics.js"
import {
	createOpenAIOAuthFetchHandler,
	startOpenAIOAuthServer,
} from "../src/server.js"

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
	vi.restoreAllMocks()
})
const source = () => ({
	stats: vi.fn(() => [
		{
			name: "a",
			transport: "http",
			healthy: true,
			inflight: 0,
			cooldownRemainingMs: 0,
			consecutiveFailures: 0,
			accountId: "private-id",
			installationId: "private-install",
		},
	]),
	getModelCatalog: vi.fn(async () => ({
		models: [
			{ slug: "m", raw: { secret: "private-raw" }, contextWindow: 10000 },
		],
		freshness: "fresh" as const,
		owner: { accountId: "private-id", isFedRamp: false },
	})),
})
const post = (
	body: string | ReadableStream<Uint8Array>,
	headers: HeadersInit = {},
	signal?: AbortSignal,
) =>
	new Request("http://localhost/pool/context", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body,
		signal,
		duplex: "half",
	} as RequestInit)

describe("pool diagnostics gateway", () => {
	test("is disabled by default and rejects unauthorized requests before reading bodies", async () => {
		const disabled = createOpenAIOAuthFetchHandler()
		const notFound = await disabled(new Request("http://localhost/pool/stats"))
		expect(notFound.status).toBe(404)
		expect(notFound.headers.get("cache-control")).toBe("no-store")
		const diagnostics = source()
		const getSession = vi.fn()
		const pull = vi.fn(),
			cancel = vi.fn()
		const handler = createOpenAIOAuthFetchHandler({
			poolDiagnostics: diagnostics,
			accessToken: "secret",
			credentials: { kind: "openai-oauth", getSession },
		})
		const response = await handler(
			post(new ReadableStream({ pull, cancel }, { highWaterMark: 0 })),
		)
		expect(response.status).toBe(401)
		expect(response.headers.get("cache-control")).toBe("no-store")
		expect(pull).not.toHaveBeenCalled()
		expect(cancel).toHaveBeenCalled()
		expect(diagnostics.stats).not.toHaveBeenCalled()
		expect(diagnostics.getModelCatalog).not.toHaveBeenCalled()
		expect(getSession).not.toHaveBeenCalled()
	})
	test("requires both bearer and additional authorizer for diagnostics", async () => {
		const diagnostics = source()
		const handler = createOpenAIOAuthFetchHandler({
			poolDiagnostics: diagnostics,
			accessToken: "secret",
			authorizeRequest: (request) => request.headers.get("x-admin") === "yes",
		})
		for (const headers of [
			{ authorization: "Bearer secret" },
			{ "x-admin": "yes" },
		])
			expect(
				(await handler(new Request("http://localhost/pool/stats", { headers })))
					.status,
			).toBe(401)
		expect(diagnostics.stats).not.toHaveBeenCalled()
		const response = await handler(
			new Request("http://localhost/pool/stats", {
				headers: { authorization: "Bearer secret", "x-admin": "yes" },
			}),
		)
		expect(response.status).toBe(200)
		expect(await response.text()).not.toContain("private")
	})
	test("enforces body bounds and aborts ignored catalog work without disclosing errors", async () => {
		const diagnostics = source()
		const handler = createOpenAIOAuthFetchHandler({
			poolDiagnostics: diagnostics,
			maxRequestBodyBytes: 32,
		})
		const oversized = await handler(post("x".repeat(33)))
		expect(oversized.status).toBe(413)
		expect(oversized.headers.get("cache-control")).toBe("no-store")
		expect(diagnostics.getModelCatalog).not.toHaveBeenCalled()
		const pending: PoolDiagnosticsSource = {
			stats: diagnostics.stats,
			getModelCatalog: vi.fn(() => new Promise(() => {})),
		}
		const aborting = createOpenAIOAuthFetchHandler({ poolDiagnostics: pending })
		const controller = new AbortController()
		const result = aborting(
			new Request("http://localhost/pool/models?account=a", {
				signal: controller.signal,
			}),
		)
		await vi.waitFor(() => expect(pending.getModelCatalog).toHaveBeenCalled())
		controller.abort()
		expect((await result).status).toBe(499)
	})
	test("serves sanitized diagnostics over the Node loopback bridge", async () => {
		const diagnostics = source()
		const running = await startOpenAIOAuthServer({
			host: "127.0.0.1",
			port: 0,
			deferModelDiscovery: true,
			accessToken: "secret",
			poolDiagnostics: diagnostics,
		})
		closers.push(running.close)
		const origin = new URL(running.url).origin
		const headers = { authorization: "Bearer secret" }
		const stats = await fetch(`${origin}/pool/stats`, { headers })
		expect(stats.status).toBe(200)
		expect(await stats.text()).not.toContain("private")
		const models = await fetch(`${origin}/pool/models?account=a`, { headers })
		expect(models.status).toBe(200)
		expect(await models.text()).not.toContain("private")
		const context = await fetch(`${origin}/pool/context`, {
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify({
				account: "a",
				request: { model: "m", input: "private prompt" },
				estimate: "characters",
			}),
		})
		expect(context.status).toBe(200)
		const text = await context.text()
		expect(text).not.toContain("private prompt")
		expect(text).toContain("characters-div-4")
		expect(diagnostics.getModelCatalog).toHaveBeenLastCalledWith(
			"a",
			expect.objectContaining({ cacheOnly: true }),
		)
	})
})

describe("gateway ready transport composition", () => {
	test("uses ready dispatch without outer auth and keeps stateless rejection", async () => {
		const getSession = vi.fn(async () => {
			throw new Error("outer auth must not run")
		})
		const request = vi.fn(async () => Response.json({ id: "r", output: [] }))
		const credentials = {
			kind: "openai-oauth" as const,
			getSession,
			transport: {
				kind: "openai-compatible" as const,
				baseURL: "https://ready.invalid/v1",
				request,
				fetch: vi.fn(async () => Response.json({})),
			},
		}
		const handler = createOpenAIOAuthFetchHandler({ credentials })
		const body = (value: object) =>
			new Request("http://localhost/v1/responses", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(value),
			})
		expect((await handler(body({ model: "m", input: "hello" }))).status).toBe(
			200,
		)
		expect(request).toHaveBeenCalledOnce()
		expect(getSession).not.toHaveBeenCalled()
		expect(
			(
				await handler(
					body({ model: "m", input: "next", previous_response_id: "r" }),
				)
			).status,
		).toBe(400)
		expect(request).toHaveBeenCalledOnce()
		expect(() =>
			createOpenAIOAuthFetchHandler({
				credentials,
				baseURL: "https://override.invalid",
			}),
		).toThrow(/overrides/)
	})
})
