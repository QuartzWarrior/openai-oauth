import type {
	LanguageModelV3StreamPart,
	LanguageModelV3StreamResult,
} from "@ai-sdk/provider"
import { describe, expect, test, vi } from "vitest"
import { enforceOutputTokenLimit } from "../src/output-limit.js"

const collect = async (parts: LanguageModelV3StreamPart[], limit: number) => {
	let cancelled = false
	let index = 0
	const upstream = new ReadableStream<LanguageModelV3StreamPart>({
		pull(controller) {
			const part = parts[index++]
			if (part === undefined) controller.close()
			else controller.enqueue(part)
		},
		cancel() {
			cancelled = true
		},
	})
	const onLimit = vi.fn()
	const result = enforceOutputTokenLimit(
		{ stream: upstream } satisfies LanguageModelV3StreamResult,
		limit,
		onLimit,
	)
	const output: LanguageModelV3StreamPart[] = []
	for await (const part of result.stream) output.push(part)
	return { cancelled, onLimit, output }
}

describe("local OAuth output limit", () => {
	test("truncates text and emits a length finish", async () => {
		const result = await collect(
			[
				{ type: "text-start", id: "text" },
				{ type: "text-delta", id: "text", delta: "one two three" },
				{ type: "text-end", id: "text" },
			],
			1,
		)

		expect(result.onLimit).toHaveBeenCalledOnce()
		expect(result.cancelled).toBe(true)
		expect(result.output).toEqual([
			{ type: "text-start", id: "text" },
			{ type: "text-delta", id: "text", delta: "one" },
			expect.objectContaining({
				type: "finish",
				finishReason: { unified: "length", raw: "length" },
				usage: expect.objectContaining({
					outputTokens: { total: 1, text: 1, reasoning: 0 },
				}),
			}),
		])
	})

	test("counts reasoning against the shared completion budget", async () => {
		const result = await collect(
			[
				{ type: "reasoning-start", id: "reasoning" },
				{ type: "reasoning-delta", id: "reasoning", delta: "think" },
				{ type: "text-start", id: "text" },
				{ type: "text-delta", id: "text", delta: "answer" },
			],
			1,
		)

		expect(result.output).toEqual([
			{ type: "reasoning-start", id: "reasoning" },
			{ type: "reasoning-delta", id: "reasoning", delta: "think" },
			expect.objectContaining({
				type: "finish",
				usage: expect.objectContaining({
					outputTokens: { total: 1, text: 0, reasoning: 1 },
				}),
			}),
		])
	})

	test("preserves an upstream finish below the cap", async () => {
		const finish: LanguageModelV3StreamPart = {
			type: "finish",
			finishReason: { unified: "stop", raw: "stop" },
			usage: {
				inputTokens: {
					total: 1,
					noCache: 1,
					cacheRead: 0,
					cacheWrite: 0,
				},
				outputTokens: { total: 1, text: 1, reasoning: 0 },
			},
		}
		const result = await collect(
			[{ type: "text-delta", id: "text", delta: "ok" }, finish],
			8,
		)

		expect(result.onLimit).not.toHaveBeenCalled()
		expect(result.output.at(-1)).toBe(finish)
	})
})
