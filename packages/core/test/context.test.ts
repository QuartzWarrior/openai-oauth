import { describe, expect, test } from "vitest"
import { inspectContextBudget } from "../src/context.js"
import type { CodexModelCatalogSnapshot } from "../src/models.js"

const catalog: CodexModelCatalogSnapshot = {
	models: [
		{
			slug: "m",
			contextWindow: 1000,
			maxContextWindow: 2000,
			effectiveContextWindowPercent: 80,
			autoCompactTokenLimit: 700,
			raw: {},
		},
	],
	freshness: "fresh",
	fetchedAt: 1,
	validatedAt: 2,
}

describe("read-only context budget inspection", () => {
	test("reports metadata without network, guessed tokens or input mutation", () => {
		const request = Object.freeze({ model: "m", input: "hello" })
		expect(inspectContextBudget(request, { catalog })).toMatchObject({
			modelContextLimit: 1000,
			maxContextWindow: 2000,
			usableInputTokens: 800,
			suggestedThreshold: 700,
			catalogFreshness: "fresh",
			catalogFetchedAt: 1,
			estimatedTextTokens: undefined,
			estimateMethod: "none",
			approximate: false,
			inputComplete: true,
			unknownComponents: ["protocol-overhead"],
		})
		expect(request.input).toBe("hello")
	})
	test("keeps absent limits, headroom, threshold and unknown models unknown", () => {
		const snapshot: CodexModelCatalogSnapshot = {
			models: [{ slug: "m", maxContextWindow: 2000, raw: {} }],
			freshness: "stale",
		}
		expect(
			inspectContextBudget({ model: "m" }, { catalog: snapshot }),
		).toMatchObject({
			modelContextLimit: undefined,
			usableInputTokens: undefined,
			suggestedThreshold: undefined,
			catalogFreshness: "stale",
			maxContextWindow: 2000,
		})
		expect(inspectContextBudget({ model: "unknown" })).toMatchObject({
			modelContextLimit: undefined,
			catalogFreshness: "missing",
		})
	})
	test("explicit estimator sees instructions, messages, tool definitions and tool I/O", () => {
		let extracted = ""
		const result = inspectContextBudget(
			{
				model: "m",
				instructions: "system directions",
				input: [
					{ role: "user", content: [{ type: "input_text", text: "question" }] },
					{
						type: "function_call",
						name: "weather",
						arguments: '{"city":"LA"}',
					},
					{
						type: "function_call_output",
						output: [{ type: "input_text", text: "sunny" }],
					},
				],
				tools: [
					{
						type: "function",
						name: "weather",
						parameters: {
							type: "object",
							properties: { city: { type: "string" } },
						},
					},
				],
			},
			{
				estimateTokens: (text) => {
					extracted = text
					return Math.ceil(text.length / 4)
				},
			},
		)
		for (const value of [
			"system directions",
			"question",
			'"LA"',
			"sunny",
			"parameters",
			"city",
		])
			expect(extracted).toContain(value)
		expect(result.estimatedTextTokens).toBe(Math.ceil(extracted.length / 4))
		expect(result).toMatchObject({
			estimateMethod: "custom-text",
			approximate: true,
			inputComplete: true,
		})
		expect(result.unknownComponents).toEqual(["protocol-overhead"])
	})
	test("inspects reasoning content alongside summary and marks unfamiliar blocks unknown", () => {
		let text = ""
		const result = inspectContextBudget(
			{
				model: "m",
				input: [
					{
						type: "reasoning",
						summary: [{ type: "summary_text", text: "summary" }],
						content: [{ type: "reasoning_text", text: "visible reasoning" }],
					},
				],
			},
			{
				estimateTokens: (value) => {
					text = value
					return value.length
				},
			},
		)
		expect(text).toBe("summary\nvisible reasoning")
		expect(result.estimatedTextTokens).toBe(text.length)
		expect(result.inputComplete).toBe(true)
		const unknown = inspectContextBudget({
			model: "m",
			input: [
				{
					type: "reasoning",
					content: [{ type: "future_reasoning", payload: "unknown" }],
				},
			],
		})
		expect(unknown.inputComplete).toBe(false)
		expect(unknown.unknownComponents).toContain("unsupported-content")
	})
	test("media and opaque values are unknown instead of counting URLs/base64 as text", () => {
		let text = ""
		const result = inspectContextBudget(
			{
				model: "m",
				previous_response_id: "previous",
				input: [
					{
						role: "user",
						content: [
							{ type: "input_image", image_url: "secret-image-base64" },
							{ type: "input_audio", input_audio: { data: "secret-audio" } },
							{ type: "input_file", file_data: "secret-file" },
						],
					},
					{
						type: "function_call_output",
						output: [{ type: "input_image", image_url: "nested-secret" }],
					},
					{
						type: "reasoning",
						encrypted_content: "secret-encrypted",
						summary: [{ type: "summary_text", text: "public summary" }],
					},
					{ type: "item_reference", id: "missing" },
				],
			},
			{
				estimateTokens: (value) => {
					text = value
					return 3
				},
			},
		)
		expect(text).toBe("public summary")
		expect(result.inputComplete).toBe(false)
		expect(result.unknownComponents).toEqual(
			expect.arrayContaining([
				"image",
				"audio",
				"file",
				"opaque-content",
				"missing-history",
				"protocol-overhead",
			]),
		)
	})
	test("bounds text and schema traversal without altering long input", () => {
		let text = ""
		const request = { model: "m", input: "a".repeat(100) }
		const result = inspectContextBudget(request, {
			maxCharacters: 12,
			estimateTokens: (value) => {
				text = value
				return 3
			},
		})
		expect(text).toHaveLength(12)
		expect(request.input).toHaveLength(100)
		expect(result.unknownComponents).toContain("inspection-limit")
		const many = inspectContextBudget(
			{ model: "m", input: Array.from({ length: 100 }, () => "a") },
			{ maxNodes: 10 },
		)
		expect(many.inputComplete).toBe(false)
		expect(many.unknownComponents).toContain("inspection-limit")
	})
	test("does not recurse forever on cycles or deep nested tool schemas", () => {
		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic
		expect(
			inspectContextBudget({ model: "m", tools: cyclic }).unknownComponents,
		).toContain("unsupported-content")
		let deep: unknown = "end"
		for (let i = 0; i < 40; i++) deep = { nested: deep }
		expect(
			inspectContextBudget({ model: "m", tools: deep }).unknownComponents,
		).toContain("inspection-limit")
	})
	test.each([
		NaN,
		Infinity,
		-1,
		1.5,
		Number.MAX_SAFE_INTEGER + 1,
	])("rejects invalid estimator result %s", (value) => {
		expect(() =>
			inspectContextBudget(
				{ model: "m", input: "x" },
				{ estimateTokens: () => value },
			),
		).toThrow(/nonnegative safe integer/)
	})
	test("rejects invalid inspection budgets and unsupported object types", () => {
		expect(() => inspectContextBudget({ model: "m" }, { maxNodes: 0 })).toThrow(
			/maxNodes/,
		)
		expect(() =>
			inspectContextBudget({ model: "m" }, { maxCharacters: Infinity }),
		).toThrow(/maxCharacters/)
		expect(
			inspectContextBudget({ model: "m", input: new Blob(["x"]) })
				.unknownComponents,
		).toContain("unsupported-content")
	})
})
