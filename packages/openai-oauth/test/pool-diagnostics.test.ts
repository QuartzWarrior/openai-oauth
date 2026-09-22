import { describe, expect, test, vi } from "vitest"
import {
	handlePoolDiagnosticsRequest,
	type PoolDiagnosticsSource,
} from "../src/pool-diagnostics.js"
import { limitRequestBody, RequestBodyTooLargeError } from "../src/shared.js"

const source = () => ({
	stats: vi.fn(() => [
		{
			name: "a",
			transport: "http",
			healthy: true,
			inflight: 0,
			cooldownRemainingMs: 0,
			consecutiveFailures: 0,
			accountId: "PRIVATE_ACCOUNT",
			installationId: "PRIVATE_INSTALLATION",
			quota: {
				families: [
					{
						limitId: "codex",
						accountId: "PRIVATE_FAMILY",
						primary: {
							usedPercent: 20,
							observedAt: 100,
							stale: false,
							token: "PRIVATE_WINDOW",
						},
					},
				],
				credits: {
					hasCredits: true,
					unlimited: false,
					balance: "2.3",
					observedAt: 100,
					stale: false,
					token: "PRIVATE_CREDITS",
				},
			},
		},
	]),
	getModelCatalog: vi.fn(async () => ({
		freshness: "fresh" as const,
		fetchedAt: 100,
		validatedAt: 100,
		owner: { accountId: "PRIVATE_OWNER", isFedRamp: false },
		etag: '"v1"',
		clientVersion: "1.2.3",
		accountName: "PRIVATE_WRONG_NAME",
		models: [
			{
				slug: "m",
				contextWindow: 1000,
				inputModalities: ["text"],
				supportedReasoningLevels: [
					{ effort: "high", token: "PRIVATE_REASONING" },
				],
				serviceTiers: [{ id: "fast", token: "PRIVATE_TIER" }],
				raw: { apiKey: "PRIVATE_RAW" },
				secret: "PRIVATE_EXTRA",
			},
		],
	})),
})
const get = (path: string, signal?: AbortSignal) =>
	new Request(`http://localhost${path}`, { signal })
const post = (
	body: unknown,
	headers = { "content-type": "application/json" },
) =>
	new Request("http://localhost/pool/context", {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	})

const handle = async (request: Request, diagnostics: PoolDiagnosticsSource) => {
	const response = await handlePoolDiagnosticsRequest(request, diagnostics)
	if (!response) throw new Error("Expected diagnostic response")
	expect(response.headers.get("cache-control")).toBe("no-store")
	return response
}

describe("pool HTTP diagnostic facade", () => {
	test("unknown routes pass through and known routes reject wrong methods", async () => {
		const diagnostics = source()
		expect(
			await handlePoolDiagnosticsRequest(get("/v1/models"), diagnostics),
		).toBeUndefined()
		const response = await handle(get("/pool/context"), diagnostics)
		expect(response.status).toBe(405)
		expect(response.headers.get("allow")).toBe("POST")
		expect(diagnostics.stats).not.toHaveBeenCalled()
	})

	test("stats whitelist nested diagnostic fields without identifiers or raw secrets", async () => {
		const diagnostics = source()
		const response = await handle(get("/pool/stats"), diagnostics)
		const text = await response.text()
		expect(text).not.toContain("PRIVATE")
		expect(JSON.parse(text)).toMatchObject({
			accounts: [
				{
					name: "a",
					transport: "http",
					healthy: true,
					quota: {
						families: [
							{ limitId: "codex", primary: { usedPercent: 20, stale: false } },
						],
						credits: { balance: "2.3" },
					},
				},
			],
		})
		expect(diagnostics.getModelCatalog).not.toHaveBeenCalled()
	})

	test("catalog defaults are explicit and nested output is sanitized", async () => {
		const diagnostics = source()
		const response = await handle(get("/pool/models?account=a"), diagnostics)
		expect(diagnostics.getModelCatalog).toHaveBeenCalledWith("a", {
			mode: "public-api",
			cacheOnly: false,
			refresh: false,
			signal: expect.any(AbortSignal),
		})
		const text = await response.text()
		expect(text).not.toContain("PRIVATE")
		expect(JSON.parse(text)).toMatchObject({
			accountName: "a",
			freshness: "fresh",
			etag: '"v1"',
			models: [
				{
					slug: "m",
					contextWindow: 1000,
					supportedReasoningLevels: [{ effort: "high" }],
				},
			],
		})
	})

	test("explicit catalog modes and booleans are forwarded", async () => {
		const diagnostics = source()
		await handle(
			get(
				"/pool/models?account=a&mode=oauth-visible&cacheOnly=true&refresh=false",
			),
			diagnostics,
		)
		expect(diagnostics.getModelCatalog).toHaveBeenCalledWith(
			"a",
			expect.objectContaining({
				mode: "oauth-visible",
				cacheOnly: true,
				refresh: false,
			}),
		)
	})

	test.each([
		"/pool/stats?extra=true",
		"/pool/models",
		"/pool/models?account=a&account=a",
		"/pool/models?account=a&mode=unknown",
		"/pool/models?account=a&refresh=1",
		"/pool/models?account=a&cacheOnly=TRUE",
		"/pool/models?account=a&cacheOnly=true&refresh=true",
		"/pool/models?account=a&secret=x",
	])("invalid query %s is rejected before diagnostics access", async (path) => {
		const diagnostics = source()
		expect((await handle(get(path), diagnostics)).status).toBe(400)
		expect(diagnostics.stats).not.toHaveBeenCalled()
		expect(diagnostics.getModelCatalog).not.toHaveBeenCalled()
	})

	test("unknown and ambiguous account names never invoke catalogs", async () => {
		const diagnostics = source()
		expect(
			(await handle(get("/pool/models?account=missing"), diagnostics)).status,
		).toBe(400)
		diagnostics.stats.mockReturnValue([
			...diagnostics.stats(),
			...diagnostics.stats(),
		])
		expect(
			(await handle(get("/pool/models?account=a"), diagnostics)).status,
		).toBe(400)
		expect(diagnostics.getModelCatalog).not.toHaveBeenCalled()
	})

	test("context defaults to metadata only, uses cache, and never echoes input", async () => {
		const diagnostics = source()
		const response = await handle(
			post({ account: "a", request: { model: "m", input: "PRIVATE_PROMPT" } }),
			diagnostics,
		)
		expect(diagnostics.getModelCatalog).toHaveBeenCalledWith(
			"a",
			expect.objectContaining({
				cacheOnly: true,
				mode: "all",
			}),
		)
		const text = await response.text()
		expect(text).not.toContain("PRIVATE")
		expect(JSON.parse(text)).toMatchObject({
			accountName: "a",
			model: "m",
			modelContextLimit: 1000,
			estimateMethod: "none",
			approximate: false,
			unknownComponents: ["protocol-overhead"],
		})
		expect(JSON.parse(text)).not.toHaveProperty("estimatedTextTokens")
	})

	test("fixed character heuristic is identified and does not count media bytes", async () => {
		const diagnostics = source()
		const response = await handle(
			post({
				account: "a",
				estimate: "characters",
				request: {
					model: "m",
					input: [
						{
							role: "user",
							content: [
								{ type: "input_text", text: "12345678" },
								{ type: "input_image", image_url: "PRIVATE_MEDIA" },
							],
						},
					],
				},
			}),
			diagnostics,
		)
		expect(await response.json()).toMatchObject({
			estimateMethod: "characters-div-4",
			approximate: true,
			estimatedTextTokens: 2,
			inputComplete: false,
			unknownComponents: ["protocol-overhead", "image"],
		})
	})

	test.each([
		null,
		[],
		{},
		{ account: "a", request: { model: " " } },
		{ account: "a", request: { model: "m", unsupported: true } },
		{ account: "a", request: { model: "m" }, catalog: { models: [] } },
		{ account: "a", request: { model: "m" }, estimate: "() => 0" },
		{ account: "a", request: { model: "m" }, estimate: null },
	])("invalid context shape %j fails before any diagnostic access", async (body) => {
		const diagnostics = source()
		expect((await handle(post(body), diagnostics)).status).toBe(400)
		expect(diagnostics.stats).not.toHaveBeenCalled()
		expect(diagnostics.getModelCatalog).not.toHaveBeenCalled()
	})

	test("rejects non-JSON media types and malformed JSON", async () => {
		const diagnostics = source()
		expect(
			(await handle(post({}, { "content-type": "text/plain" }), diagnostics))
				.status,
		).toBe(400)
		expect(
			(
				await handle(
					new Request("http://localhost/pool/context", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: "{",
					}),
					diagnostics,
				)
			).status,
		).toBe(400)
		expect(diagnostics.stats).not.toHaveBeenCalled()
	})

	test("body limit errors propagate for gateway 413 handling", async () => {
		const diagnostics = source()
		await expect(
			handlePoolDiagnosticsRequest(
				limitRequestBody(
					post({
						account: "a",
						request: { model: "m", input: "too large" },
					}),
					8,
				),
				diagnostics,
			),
		).rejects.toBeInstanceOf(RequestBodyTooLargeError)
		expect(diagnostics.getModelCatalog).not.toHaveBeenCalled()
	})

	test("provider failures are redacted, including SyntaxError", async () => {
		for (const error of [
			new Error("PRIVATE_TOKEN"),
			new SyntaxError("PRIVATE_TOKEN"),
		]) {
			const diagnostics = source()
			diagnostics.getModelCatalog.mockRejectedValue(error)
			const response = await handle(get("/pool/models?account=a"), diagnostics)
			expect(response.status).toBe(502)
			expect(await response.text()).not.toContain("PRIVATE")
		}
	})

	test("abort settles an ignored catalog operation and removes its listener", async () => {
		const diagnostics = source()
		diagnostics.getModelCatalog.mockImplementation(() => new Promise(() => {}))
		const controller = new AbortController()
		const request = get("/pool/models?account=a", controller.signal)
		const remove = vi.spyOn(request.signal, "removeEventListener")
		const pending = handlePoolDiagnosticsRequest(request, diagnostics)
		controller.abort()
		await expect(pending).rejects.toMatchObject({ name: "AbortError" })
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function))
	})

	test("pre-aborted requests cannot access diagnostics", async () => {
		const diagnostics = source()
		const controller = new AbortController()
		controller.abort()
		await expect(
			handlePoolDiagnosticsRequest(
				get("/pool/stats", controller.signal),
				diagnostics,
			),
		).rejects.toMatchObject({ name: "AbortError" })
		expect(diagnostics.stats).not.toHaveBeenCalled()
	})
})
