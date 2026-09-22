import type { LanguageModelV3, SharedV3Warning } from "@ai-sdk/provider"
import { generateImage, generateText } from "ai"
import { describe, expect, test, vi } from "vitest"
import { createOpenAIOAuth } from "../src/index.js"

type CallOptions = Parameters<LanguageModelV3["doStream"]>[0]

const reasoningRequest = async (
	method: "doGenerate" | "doStream",
	providerOptions?: CallOptions["providerOptions"],
	name?: string,
) => {
	let body: Record<string, unknown> = {}
	const provider = createOpenAIOAuth(
		{
			kind: "openai-compatible",
			baseURL: "https://ready.test/v1",
			request: async () => {
				throw new Error("unexpected request dispatch")
			},
			fetch: async (_url, init) => {
				body = JSON.parse(String(init?.body))
				return new Response(
					`data: ${JSON.stringify({
						type: "response.completed",
						response: {
							id: "resp_reasoning",
							model: "gpt-6-astra",
							status: "completed",
							output: [],
							usage: { input_tokens: 1, output_tokens: 1 },
						},
					})}\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				)
			},
		},
		{ name },
	)
	const options: CallOptions = {
		prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
		providerOptions,
	}
	const model = provider("gpt-6-astra")
	if (method === "doGenerate") {
		const result = await model.doGenerate(options)
		return { body, warnings: result.warnings }
	}
	const result = await model.doStream(options)
	const warnings: SharedV3Warning[] = []
	const reader = result.stream.getReader()
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			if (value.type === "stream-start") warnings.push(...value.warnings)
			if (value.type === "error") throw value.error
		}
	} finally {
		reader.releaseLock()
	}
	return { body, warnings }
}

describe.each([
	"doGenerate",
	"doStream",
] as const)("reasoning options via %s", (method) => {
	test.each([
		"high",
		"none",
		"xhigh",
	])("forwards explicit effort %s for an unrecognized model", async (effort) => {
		const openai = Object.freeze({
			reasoningEffort: effort,
			reasoningSummary: "detailed",
			parallelToolCalls: false,
			store: false,
		})
		const providerOptions = Object.freeze({
			openai,
			other: Object.freeze({ key: "kept" }),
		})
		const { body, warnings } = await reasoningRequest(method, providerOptions)
		expect(body).toMatchObject({
			model: "gpt-6-astra",
			reasoning: { effort, summary: "detailed" },
			parallel_tool_calls: false,
			store: false,
		})
		expect(warnings).toEqual([])
		expect(providerOptions).toEqual({ openai, other: { key: "kept" } })
		expect(openai).not.toHaveProperty("forceReasoning")
	})

	test("forwards summary without requiring an effort", async () => {
		const { body, warnings } = await reasoningRequest(method, {
			openai: { reasoningSummary: "auto" },
		})
		expect(body.reasoning).toEqual({ summary: "auto" })
		expect(warnings).toEqual([])
	})

	test("preserves an explicit opt-out and its warning", async () => {
		const { body, warnings } = await reasoningRequest(method, {
			openai: { reasoningEffort: "high", forceReasoning: false },
		})
		expect(body.reasoning).toBeUndefined()
		expect(warnings).toContainEqual(
			expect.objectContaining({
				type: "unsupported",
				feature: "reasoningEffort",
			}),
		)
	})

	test("preserves an explicit opt-in", async () => {
		const { body, warnings } = await reasoningRequest(method, {
			openai: { reasoningEffort: "high", forceReasoning: true },
		})
		expect(body.reasoning).toEqual({ effort: "high" })
		expect(warnings).toEqual([])
	})

	test.each([
		undefined,
		{ other: { key: "kept" } },
		{ openai: { reasoningEffort: null, store: false } },
	])("does not force reasoning without explicit reasoning options (%j)", async (providerOptions) => {
		const { body, warnings } = await reasoningRequest(method, providerOptions)
		expect(body.reasoning).toBeUndefined()
		expect(body.include ?? []).not.toContain("reasoning.encrypted_content")
		expect(warnings).toEqual([])
	})

	test.each([
		{ azure: { reasoningEffort: "high" } },
		{ openai: { reasoningEffort: "high" } },
		{ azure: { reasoningEffort: "high" }, openai: { forceReasoning: false } },
	])("uses the SDK option namespace for custom provider names (%j)", async (providerOptions) => {
		const { body, warnings } = await reasoningRequest(
			method,
			providerOptions,
			"azure-custom",
		)
		expect(body.reasoning).toEqual({ effort: "high" })
		expect(warnings).toEqual([])
	})
})

describe("createOpenAIOAuth", () => {
	test("uses request-bound OAuth credentials for generateText calls", async () => {
		const fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input)
			if (url === "https://registry.npmjs.org/@openai/codex/latest") {
				return Response.json({ version: "0.144.1" })
			}
			if (url.includes("/backend-api/codex/models?")) {
				return Response.json({
					models: [
						{
							slug: "gpt-5.6-sol",
							visibility: "list",
							use_responses_lite: true,
							support_verbosity: true,
							default_verbosity: "low",
							default_reasoning_level: "low",
						},
					],
				})
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				return new Response(
					[
						"event: response.created",
						'data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.6-sol","created_at":1735689600}}',
						"",
						"event: response.output_item.added",
						'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","phase":"final_answer"}}',
						"",
						"event: response.output_text.delta",
						'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"hello"}',
						"",
						"event: response.output_item.done",
						'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_1","phase":"final_answer"}}',
						"",
						"event: response.completed",
						'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.6-sol","created_at":1735689600,"status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}',
						"",
						"",
					].join("\n"),
					{
						headers: { "Content-Type": "text/event-stream" },
					},
				)
			}

			throw new Error(`Unexpected request: ${url}`)
		})
		const openai = createOpenAIOAuth({
			kind: "openai-oauth",
			fetch,
			getSession: async () => ({
				accessToken: "access-token",
				accountId: "acct-1",
			}),
		})

		const result = await generateText({
			model: openai("gpt-5.6-sol"),
			prompt: "hi",
		})

		expect(result.text).toBe("hello")
		expect(result.finishReason).toBe("stop")
		expect(result.usage.inputTokens).toBe(1)
		expect(result.usage.outputTokens).toBe(1)
		expect(result.usage.totalTokens).toBe(2)
		const responseCall = fetch.mock.calls.find(
			([input]) =>
				String(input) === "https://chatgpt.com/backend-api/codex/responses",
		)
		const [url, init] = responseCall ?? []
		const headers = new Headers(init?.headers)
		const body = JSON.parse(String(init?.body))

		expect(url).toBe("https://chatgpt.com/backend-api/codex/responses")
		expect(headers.get("authorization")).toBe("Bearer access-token")
		expect(headers.get("chatgpt-account-id")).toBe("acct-1")
		expect(headers.get("x-openai-internal-codex-responses-lite")).toBe("true")
		expect(body.stream).toBe(true)
		expect(body.store).toBe(false)
		expect(body.reasoning).toMatchObject({
			effort: "low",
			context: "all_turns",
		})
		expect(body.text).toMatchObject({ verbosity: "low" })
	})

	test("uses ChatGPT OAuth for image generation and editing", async () => {
		const requests: Array<{ path: string; body: Record<string, unknown> }> = []
		const fetch = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input))
				if (
					url.pathname.endsWith("/images/generations") ||
					url.pathname.endsWith("/images/edits")
				) {
					requests.push({
						path: url.pathname,
						body: JSON.parse(String(init?.body)),
					})
					return Response.json({
						created: 1,
						data: [{ b64_json: "AQID" }],
						usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
					})
				}
				throw new Error(`Unexpected request: ${url}`)
			},
		)
		const openai = createOpenAIOAuth({
			kind: "openai-oauth",
			fetch,
			getSession: async () => ({
				accessToken: "access-token",
				accountId: "acct-1",
			}),
		})

		const generated = await generateImage({
			model: openai.image("gpt-image-2"),
			prompt: "draw a square",
			size: "1024x1024",
		})
		const edited = await generateImage({
			model: openai.image("gpt-image-2"),
			prompt: {
				text: "add a red hat",
				images: [new Uint8Array([1, 2, 3])],
			},
		})

		expect(generated.image.base64).toBe("AQID")
		expect(edited.image.base64).toBe("AQID")
		expect(generated.usage).toEqual({
			inputTokens: 2,
			outputTokens: 3,
			totalTokens: 5,
		})
		expect(requests).toEqual([
			{
				path: "/backend-api/codex/images/generations",
				body: {
					model: "gpt-image-2",
					prompt: "draw a square",
					n: 1,
					size: "1024x1024",
				},
			},
			{
				path: "/backend-api/codex/images/edits",
				body: {
					images: [{ image_url: "data:image/png;base64,AQID" }],
					model: "gpt-image-2",
					prompt: "add a red hat",
					n: 1,
				},
			},
		])
	})
})
