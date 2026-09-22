import { describe, expect, test } from "vitest"
import {
	type CodexModelInfo,
	type CodexModelListingMode,
	fetchCodexModelCatalog,
	selectCodexModels,
} from "../src/models.js"

const parse = async (value: Record<string, unknown>) =>
	(
		await fetchCodexModelCatalog(
			{
				request: async () =>
					Response.json({ models: [{ slug: "m", ...value }] }),
			},
			{ codexVersion: "0.154.0" },
		)
	)[0]

describe("typed catalog capabilities", () => {
	test("retains raw metadata and exposes validated known capabilities", async () => {
		const raw = {
			display_name: "Model",
			description: "Description",
			supported_reasoning_levels: [
				{ effort: "custom-effort", description: "Custom" },
			],
			supports_reasoning_summary_parameter: false,
			supports_image_detail_original: true,
			input_modalities: ["text", "image", "future"],
			service_tiers: [{ id: "fast", name: "Fast", description: "Faster" }],
			default_service_tier: "fast",
			context_window: 1000,
			max_context_window: 2000,
			auto_compact_token_limit: 700,
			effective_context_window_percent: 85,
			comp_hash: "opaque-hash",
			unknown_field: { retained: true },
		}
		expect(await parse(raw)).toMatchObject({
			displayName: "Model",
			description: "Description",
			supportedReasoningLevels: [
				{ effort: "custom-effort", description: "Custom" },
			],
			supportsReasoningSummaryParameter: false,
			supportsImageDetailOriginal: true,
			inputModalities: ["text", "image", "future"],
			serviceTiers: [{ id: "fast", name: "Fast", description: "Faster" }],
			defaultServiceTier: "fast",
			contextWindow: 1000,
			maxContextWindow: 2000,
			autoCompactTokenLimit: 700,
			effectiveContextWindowPercent: 85,
			compactionCompatibilityHash: "opaque-hash",
			raw: { slug: "m", ...raw },
		})
	})
	test("missing capabilities remain unknown and explicit false/empty are preserved", async () => {
		expect(await parse({})).toMatchObject({
			supportsReasoningSummaryParameter: undefined,
			inputModalities: undefined,
			contextWindow: undefined,
		})
		expect(
			await parse({
				input_modalities: [],
				service_tiers: [],
				supports_image_detail_original: false,
			}),
		).toMatchObject({
			inputModalities: [],
			serviceTiers: [],
			supportsImageDetailOriginal: false,
		})
	})
	test("all-invalid arrays stay unknown rather than advertising no supported capabilities", async () => {
		const raw = {
			input_modalities: [null, 1, {}],
			available_in_plans: [false],
			supported_reasoning_levels: [{ effort: 2 }, null],
			service_tiers: [{ id: false }, "invalid"],
		}
		expect(await parse(raw)).toMatchObject({
			inputModalities: undefined,
			availableInPlans: undefined,
			supportedReasoningLevels: undefined,
			serviceTiers: undefined,
			raw,
		})
	})
	test("empty arrays remain explicit and mixed arrays retain valid members", async () => {
		expect(
			await parse({
				input_modalities: [],
				supported_reasoning_levels: [],
				service_tiers: [],
			}),
		).toMatchObject({
			inputModalities: [],
			supportedReasoningLevels: [],
			serviceTiers: [],
		})
		expect(
			await parse({
				input_modalities: [null, "image", 3],
				supported_reasoning_levels: [false, { effort: "custom" }],
				service_tiers: [{ id: 1 }, { id: "fast" }],
			}),
		).toMatchObject({
			inputModalities: ["image"],
			supportedReasoningLevels: [{ effort: "custom" }],
			serviceTiers: [{ id: "fast" }],
		})
	})
	test("malformed capability values do not become false promises", async () => {
		expect(
			await parse({
				context_window: "1000",
				max_context_window: -2,
				auto_compact_token_limit: 1.5,
				effective_context_window_percent: 101,
				supports_image_detail_original: "yes",
				supported_reasoning_levels: [
					null,
					{},
					{ effort: 5 },
					{ effort: "high", description: 3 },
				],
				service_tiers: [
					null,
					"fast",
					{ id: 5 },
					{ id: "fast", description: false },
				],
			}),
		).toMatchObject({
			contextWindow: undefined,
			maxContextWindow: undefined,
			autoCompactTokenLimit: undefined,
			effectiveContextWindowPercent: undefined,
			supportsImageDetailOriginal: undefined,
			supportedReasoningLevels: [{ effort: "high", description: undefined }],
			serviceTiers: [{ id: "fast", description: undefined }],
		})
	})
	test.each([
		0,
		-1,
		1.5,
		Number.MAX_SAFE_INTEGER + 1,
	])("ignores invalid context limit %s", async (value) => {
		expect(
			(await parse({ context_window: value }))?.contextWindow,
		).toBeUndefined()
	})
	test("listing defaults remain narrow while explicit modes expose account catalog visibility", () => {
		const models: CodexModelInfo[] = [
			{ slug: "default", raw: {} },
			{ slug: "public", visibility: "list", supportedInApi: true, raw: {} },
			{ slug: "oauth", visibility: "list", supportedInApi: false, raw: {} },
			{ slug: "hidden", visibility: "hide", supportedInApi: true, raw: {} },
		]
		expect(selectCodexModels(models).map((m) => m.slug)).toEqual([
			"default",
			"public",
		])
		expect(
			selectCodexModels(models, "oauth-visible").map((m) => m.slug),
		).toEqual(["default", "public", "oauth"])
		expect(selectCodexModels(models, "all")).toEqual(models)
		expect(selectCodexModels(models, "all")).not.toBe(models)
		expect(models).toHaveLength(4)
		expect(() =>
			selectCodexModels(models, "invalid" as CodexModelListingMode),
		).toThrow(/listing mode/)
	})
})
