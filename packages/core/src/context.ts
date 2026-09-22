import type { CodexModelCatalogSnapshot } from "./models.js"
import { isRecord } from "./utils.js"

export type ContextBudgetRequest = {
	model: string
	instructions?: unknown
	input?: unknown
	tools?: unknown
	previous_response_id?: unknown
}

export type ContextBudgetUnknownComponent =
	| "protocol-overhead"
	| "missing-history"
	| "image"
	| "audio"
	| "file"
	| "opaque-content"
	| "unsupported-content"
	| "inspection-limit"

export type ContextBudgetOptions = {
	catalog?: CodexModelCatalogSnapshot
	/** Estimate the extracted text only; framing, media and encrypted items remain unknown. */
	estimateTokens?: (text: string) => number
	/** UTF-16 code units inspected, not token or byte counts (default 200,000). */
	maxCharacters?: number
	/** Maximum visited values (default 10,000). */
	maxNodes?: number
}

export type ContextBudgetInspection = {
	model: string
	modelContextLimit?: number
	maxContextWindow?: number
	usableInputTokens?: number
	/** Advertised threshold only; inspection never derives an automatic policy. */
	suggestedThreshold?: number
	catalogFreshness: CodexModelCatalogSnapshot["freshness"]
	catalogFetchedAt?: number
	catalogValidatedAt?: number
	textCharacters: number
	estimatedTextTokens?: number
	estimateMethod: "none" | "custom-text"
	approximate: boolean
	/** Whether supplied content was inspected fully, not whether total tokens are known. */
	inputComplete: boolean
	unknownComponents: ContextBudgetUnknownComponent[]
}

const positiveInteger = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: undefined

const budget = (
	value: number | undefined,
	fallback: number,
	maximum: number,
	name: string,
): number => {
	const resolved = value ?? fallback
	if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum)
		throw new RangeError(
			`${name} must be a positive integer no greater than ${maximum}.`,
		)
	return resolved
}

/** Pure local inspection: never fetches, expands cached history, truncates or rewrites input. */
export const inspectContextBudget = (
	request: ContextBudgetRequest,
	options: ContextBudgetOptions = {},
): ContextBudgetInspection => {
	if (typeof request.model !== "string" || request.model.length === 0)
		throw new TypeError("Context inspection requires a non-empty model name.")
	const maxCharacters = budget(
		options.maxCharacters,
		200_000,
		10_000_000,
		"maxCharacters",
	)
	const maxNodes = budget(options.maxNodes, 10_000, 100_000, "maxNodes")
	const unknown = new Set<ContextBudgetUnknownComponent>(["protocol-overhead"])
	const fragments: string[] = []
	const ancestors = new WeakSet<object>()
	let nodes = 0
	let characters = 0
	const text = (value: string) => {
		const remaining = maxCharacters - characters
		const separator = fragments.length > 0 ? "\n" : ""
		if (separator.length + value.length > remaining) {
			unknown.add("inspection-limit")
			if (remaining > separator.length) {
				fragments.push(separator + value.slice(0, remaining - separator.length))
				characters = maxCharacters
			}
			return
		}
		fragments.push(separator + value)
		characters += separator.length + value.length
	}
	const visit = (value: unknown, depth = 0, schema = false): void => {
		if (++nodes > maxNodes || depth > 32 || characters >= maxCharacters) {
			unknown.add("inspection-limit")
			return
		}
		if (typeof value === "string") {
			text(value)
			return
		}
		if (value === undefined || value === null) return
		if (typeof value !== "object") {
			if (schema && (typeof value === "number" || typeof value === "boolean"))
				text(String(value))
			else unknown.add("unsupported-content")
			return
		}
		if (ancestors.has(value)) {
			unknown.add("unsupported-content")
			return
		}
		ancestors.add(value)
		try {
			if (Array.isArray(value)) {
				for (const item of value) {
					visit(item, depth + 1, schema)
					if (nodes >= maxNodes || characters >= maxCharacters) break
				}
				if (nodes >= maxNodes || characters >= maxCharacters)
					unknown.add("inspection-limit")
				return
			}
			if (
				!isRecord(value) ||
				(Object.getPrototypeOf(value) !== Object.prototype &&
					Object.getPrototypeOf(value) !== null)
			) {
				unknown.add("unsupported-content")
				return
			}
			if (schema) {
				for (const key in value) {
					if (!Object.hasOwn(value, key)) continue
					text(key)
					visit(value[key], depth + 1, true)
					if (nodes >= maxNodes || characters >= maxCharacters) {
						unknown.add("inspection-limit")
						break
					}
				}
				return
			}
			if (value.encrypted_content !== undefined) unknown.add("opaque-content")
			switch (value.type) {
				case "input_text":
				case "output_text":
				case "summary_text":
				case "reasoning_text":
				case "text":
					if (typeof value.text === "string") visit(value.text, depth + 1)
					else unknown.add("unsupported-content")
					break
				case "input_image":
				case "image_url":
				case "image":
					unknown.add("image")
					break
				case "input_audio":
				case "output_audio":
				case "audio":
					unknown.add("audio")
					break
				case "input_file":
				case "file":
					unknown.add("file")
					break
				case "item_reference":
					unknown.add("missing-history")
					break
				case "function_call":
					visit(value.name, depth + 1)
					visit(value.arguments, depth + 1)
					break
				case "function_call_output":
					visit(value.output, depth + 1)
					break
				case "reasoning":
					visit(value.summary, depth + 1)
					visit(value.content, depth + 1)
					break
				case "compaction":
					unknown.add("opaque-content")
					break
				case "message":
					visit(value.content, depth + 1)
					break
				default:
					if (value.type === undefined && typeof value.role === "string")
						visit(value.content, depth + 1)
					else unknown.add("unsupported-content")
			}
		} finally {
			ancestors.delete(value)
		}
	}
	if (request.previous_response_id !== undefined) unknown.add("missing-history")
	visit(request.instructions)
	visit(request.input)
	visit(request.tools, 0, true)
	let estimatedTextTokens: number | undefined
	if (options.estimateTokens) {
		estimatedTextTokens = options.estimateTokens(fragments.join(""))
		if (!Number.isSafeInteger(estimatedTextTokens) || estimatedTextTokens < 0)
			throw new RangeError(
				"The text token estimator must return a nonnegative safe integer.",
			)
	}
	const model = options.catalog?.models.find(
		(item) => item.slug === request.model,
	)
	const modelContextLimit = positiveInteger(model?.contextWindow)
	const percent = model?.effectiveContextWindowPercent
	const usableInputTokens =
		modelContextLimit !== undefined &&
		typeof percent === "number" &&
		Number.isFinite(percent) &&
		percent > 0 &&
		percent <= 100
			? Math.floor(modelContextLimit * (percent / 100))
			: undefined
	return {
		model: request.model,
		modelContextLimit,
		maxContextWindow: positiveInteger(model?.maxContextWindow),
		usableInputTokens,
		suggestedThreshold: positiveInteger(model?.autoCompactTokenLimit),
		catalogFreshness: options.catalog?.freshness ?? "missing",
		catalogFetchedAt: options.catalog?.fetchedAt,
		catalogValidatedAt: options.catalog?.validatedAt,
		textCharacters: characters,
		estimatedTextTokens,
		estimateMethod: options.estimateTokens ? "custom-text" : "none",
		approximate: options.estimateTokens !== undefined,
		inputComplete: unknown.size === 1,
		unknownComponents: [...unknown],
	}
}
