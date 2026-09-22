import type { OpenAIOAuthProvider } from "@openai-oauth/ai-sdk"
import { afterEach, describe, expect, test, vi } from "vitest"

vi.mock("ai", async (importOriginal) => ({
	...(await importOriginal<typeof import("ai")>()),
	generateText: vi.fn(),
	streamText: vi.fn(),
}))

import { generateText, streamText } from "ai"
import { handleChatCompletionsRequest } from "../src/chat-completions.js"
import { streamChatCompletions } from "../src/chat-stream.js"

const provider = (() => ({})) as unknown as OpenAIOAuthProvider
const tools = [
	{
		type: "function",
		function: {
			name: "answer",
			strict: true,
			parameters: {
				type: "object",
				properties: { value: { type: "string" } },
				required: ["value"],
				additionalProperties: false,
			},
		},
	},
]
afterEach(() => vi.clearAllMocks())

describe("chat translation fidelity", () => {
	test("forwards nonstream request signal and strict tool schemas", async () => {
		vi.mocked(generateText).mockResolvedValue({
			text: "ok",
			finishReason: "stop",
			toolCalls: [],
			usage: {},
		} as unknown as Awaited<ReturnType<typeof generateText>>)
		const controller = new AbortController()
		const request = new Request("http://localhost/v1/chat/completions", {
			method: "POST",
			signal: controller.signal,
			body: JSON.stringify({ messages: [], tools }),
		})
		expect(
			(await handleChatCompletionsRequest(request, provider, undefined)).status,
		).toBe(200)
		const options = vi.mocked(generateText).mock.calls[0]?.[0]
		expect(options?.abortSignal).toBe(request.signal)
		expect(options?.tools?.answer?.strict).toBe(true)
		expect(options?.tools?.answer?.inputSchema).toMatchObject({
			jsonSchema: tools[0]?.function.parameters,
		})
		controller.abort()
		expect(options?.abortSignal?.aborted).toBe(true)
	})

	test("stream consumption is pull-driven and cancellation aborts the SDK", async () => {
		let yielded = 0
		vi.mocked(streamText).mockReturnValue({
			fullStream: (async function* () {
				for (let i = 0; i < 100; i++) {
					yielded++
					yield { type: "text-delta", text: "a" }
				}
			})(),
		} as unknown as ReturnType<typeof streamText>)
		const response = await streamChatCompletions(
			{ messages: [], tools },
			provider,
			{ requestId: "r", startedAt: 0 },
		)
		const options = vi.mocked(streamText).mock.calls[0]?.[0]
		expect(options?.tools?.answer?.strict).toBe(true)
		expect(yielded).toBe(0)
		if (!response.body) throw new Error("Expected streaming body")
		const reader = response.body.getReader()
		await reader.read() // role chunk does not consume upstream
		expect(yielded).toBe(0)
		await reader.read()
		expect(yielded).toBe(1)
		await reader.cancel("disconnect")
		expect(options?.abortSignal?.aborted).toBe(true)
		expect(yielded).toBe(1)
	})

	test.each([
		"max_tokens",
		"max_completion_tokens",
	])("enforces supported %s through the Responses output cap", async (field) => {
		vi.mocked(generateText).mockResolvedValue({
			text: "ok",
			finishReason: "stop",
			toolCalls: [],
			usage: {},
		} as unknown as Awaited<ReturnType<typeof generateText>>)
		vi.mocked(streamText).mockReturnValue({
			fullStream: (async function* () {})(),
		} as unknown as ReturnType<typeof streamText>)
		for (const stream of [false, true]) {
			const response = await handleChatCompletionsRequest(
				new Request("http://localhost/v1/chat/completions", {
					method: "POST",
					body: JSON.stringify({ messages: [], stream, [field]: 12 }),
				}),
				provider,
				undefined,
			)
			expect(response.status).toBe(200)
		}
		expect(vi.mocked(generateText).mock.calls[0]?.[0].maxOutputTokens).toBe(12)
		expect(vi.mocked(streamText).mock.calls[0]?.[0].maxOutputTokens).toBe(12)
	})

	test("direct streaming helper enforces max_completion_tokens", async () => {
		vi.mocked(streamText).mockReturnValue({
			fullStream: (async function* () {})(),
		} as unknown as ReturnType<typeof streamText>)
		const response = await streamChatCompletions(
			{ messages: [], max_completion_tokens: 10 },
			provider,
			{ requestId: "r", startedAt: 0 },
		)
		expect(response.status).toBe(200)
		expect(vi.mocked(streamText).mock.calls[0]?.[0].maxOutputTokens).toBe(10)
	})

	test("caller abort settles a pending stream read", async () => {
		vi.mocked(streamText).mockImplementation(
			(options) =>
				({
					fullStream: (async function* () {
						await new Promise<void>((_resolve, reject) =>
							options.abortSignal?.addEventListener(
								"abort",
								() => reject(options.abortSignal?.reason),
								{ once: true },
							),
						)
						yield { type: "text-delta", text: "unreachable" }
					})(),
				}) as unknown as ReturnType<typeof streamText>,
		)
		const controller = new AbortController()
		const response = await streamChatCompletions(
			{ messages: [] },
			provider,
			{ requestId: "r", startedAt: 0 },
			controller.signal,
		)
		if (!response.body) throw new Error("Expected streaming body")
		const reader = response.body.getReader()
		await reader.read()
		const pending = reader.read()
		const rejected = expect(pending).rejects.toThrow("stop")
		controller.abort(new Error("stop"))
		await rejected
	})
})
