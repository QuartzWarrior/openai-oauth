import { generateText } from "ai"
import { MockLanguageModelV3 } from "ai/test"
import { describe, expect, test } from "vitest"
import { toModelMessages } from "../src/chat-messages.js"
import { InvalidRequestError } from "../src/shared.js"

const userImage = (image_url: Record<string, unknown>) =>
	toModelMessages([
		{
			role: "user",
			content: [
				{ type: "text", text: "What is this?" },
				{ type: "image_url", image_url },
			],
		},
	] as Parameters<typeof toModelMessages>[0])

describe("Chat message image conversion", () => {
	test("inlines base64 data URLs with their media type and Codex's default detail", () => {
		expect(
			userImage({ url: "data:image/png;base64,AQID" })[0]?.content,
		).toEqual([
			{ type: "text", text: "What is this?" },
			{
				type: "image",
				image: "AQID",
				mediaType: "image/png",
				providerOptions: { openai: { imageDetail: "high" } },
			},
		])
	})

	test("keeps http(s) URLs and forwards detail", () => {
		expect(
			userImage({ url: "https://example.com/cat.png", detail: "low" })[0]
				?.content,
		).toEqual([
			{ type: "text", text: "What is this?" },
			{
				type: "image",
				image: new URL("https://example.com/cat.png"),
				providerOptions: { openai: { imageDetail: "low" } },
			},
		])
	})

	test("data URL images reach the model without a download attempt", async () => {
		const model = new MockLanguageModelV3({
			supportedUrls: { "image/*": [/^https?:\/\/.*$/] },
			doGenerate: async () => ({
				content: [{ type: "text", text: "ok" }],
				finishReason: { unified: "stop", raw: "stop" },
				usage: {
					inputTokens: {
						total: 1,
						noCache: 1,
						cacheRead: undefined,
						cacheWrite: undefined,
					},
					outputTokens: { total: 1, text: 1, reasoning: undefined },
				},
				warnings: [],
			}),
		})

		await generateText({
			model,
			messages: userImage({ url: "data:image/png;base64,AQID" }),
		})

		const [prompt] = model.doGenerateCalls.map((call) => call.prompt)
		expect(prompt?.[0]?.content).toContainEqual(
			expect.objectContaining({ type: "file", mediaType: "image/png" }),
		)
	})

	test("rejects undecodable data URL payloads as invalid requests", () => {
		for (const url of [
			"data:image/png;base64,not-an-image!!",
			"data:image/png;base64,A",
			"data:image/png,%zz",
		]) {
			expect(() => userImage({ url })).toThrow(InvalidRequestError)
		}
		expect(() =>
			userImage({ url: "data:image/png;base64,AQ-_\nAA==" }),
		).not.toThrow()
	})
})
