import type { OpenAIOAuthProvider } from "@openai-oauth/ai-sdk"
import { afterEach, describe, expect, test, vi } from "vitest"

vi.mock("ai", async (importOriginal) => ({
	...(await importOriginal<typeof import("ai")>()),
	generateText: vi.fn(),
	streamText: vi.fn(),
}))

import { generateText, streamText } from "ai"
import { handleChatCompletionsRequest } from "../src/chat-completions.js"
import { LOCAL_CHAT_MAX_COMPLETION_TOKENS } from "../src/chat-output-limit.js"
import { streamChatCompletions } from "../src/chat-stream.js"

const provider = (() => ({})) as unknown as OpenAIOAuthProvider

afterEach(() => vi.clearAllMocks())

describe("Chat completion output limits", () => {
	test("maps max_completion_tokens to the enforced Responses output cap", async () => {
		vi.mocked(generateText).mockResolvedValue({
			text: "ok",
			finishReason: "stop",
			toolCalls: [],
			usage: {},
		} as unknown as Awaited<ReturnType<typeof generateText>>)

		const response = await handleChatCompletionsRequest(
			new Request("http://localhost/v1/chat/completions", {
				method: "POST",
				body: JSON.stringify({
					model: "gpt-6-astra",
					messages: [],
					max_completion_tokens: 4096,
				}),
			}),
			provider,
			undefined,
		)

		expect(response.status).toBe(200)
		expect(vi.mocked(generateText).mock.calls[0]?.[0].maxOutputTokens).toBe(
			4096,
		)
	})

	test("retains max_tokens as a legacy alias", async () => {
		vi.mocked(streamText).mockReturnValue({
			fullStream: (async function* () {})(),
		} as unknown as ReturnType<typeof streamText>)

		const response = await streamChatCompletions(
			{ messages: [], max_tokens: 2048 },
			provider,
			{ requestId: "r", startedAt: 0 },
		)

		expect(response.status).toBe(200)
		expect(vi.mocked(streamText).mock.calls[0]?.[0].maxOutputTokens).toBe(2048)
	})

	test.each([
		0,
		-1,
		1.5,
		"10",
		LOCAL_CHAT_MAX_COMPLETION_TOKENS + 1,
	])("rejects invalid max_completion_tokens value %s", async (maxCompletionTokens) => {
		const response = await handleChatCompletionsRequest(
			new Request("http://localhost/v1/chat/completions", {
				method: "POST",
				body: JSON.stringify({
					messages: [],
					max_completion_tokens: maxCompletionTokens,
				}),
			}),
			provider,
			undefined,
		)

		expect(response.status).toBe(400)
		expect(generateText).not.toHaveBeenCalled()
		expect(streamText).not.toHaveBeenCalled()
	})

	test("accepts the configured ceiling and rejects ambiguous aliases", async () => {
		vi.mocked(streamText).mockReturnValue({
			fullStream: (async function* () {})(),
		} as unknown as ReturnType<typeof streamText>)

		const accepted = await streamChatCompletions(
			{
				messages: [],
				max_completion_tokens: LOCAL_CHAT_MAX_COMPLETION_TOKENS,
			},
			provider,
			{ requestId: "r", startedAt: 0 },
		)
		expect(accepted.status).toBe(200)

		const rejected = await streamChatCompletions(
			{ messages: [], max_tokens: 1, max_completion_tokens: 1 },
			provider,
			{ requestId: "r", startedAt: 0 },
		)
		expect(rejected.status).toBe(400)
	})
})
