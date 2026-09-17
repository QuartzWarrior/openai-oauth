import type {
	LanguageModelV3StreamPart,
	LanguageModelV3StreamResult,
	LanguageModelV3Usage,
} from "@ai-sdk/provider"
import { getEncoding } from "js-tiktoken"

const tokenizer = getEncoding("o200k_base")

const emptyInputUsage = (): LanguageModelV3Usage["inputTokens"] => ({
	total: undefined,
	noCache: undefined,
	cacheRead: undefined,
	cacheWrite: undefined,
})

const truncateToTokens = (
	text: string,
	remaining: number,
): { text: string; tokens: number; truncated: boolean } => {
	const encoded = tokenizer.encode(text)
	if (encoded.length <= remaining) {
		return { text, tokens: encoded.length, truncated: false }
	}
	let prefix = encoded.slice(0, remaining)
	let decoded = tokenizer.decode(prefix)
	// Some Unicode code points span multiple BPE tokens. Avoid exposing a
	// replacement character when the cap lands between those tokens.
	while (prefix.length > 0 && decoded.endsWith("\uFFFD")) {
		prefix = prefix.slice(0, -1)
		decoded = tokenizer.decode(prefix)
	}
	return { text: decoded, tokens: prefix.length, truncated: true }
}

const syntheticLengthFinish = (
	textTokens: number,
	reasoningTokens: number,
): LanguageModelV3StreamPart => ({
	type: "finish",
	finishReason: { unified: "length", raw: "length" },
	usage: {
		inputTokens: emptyInputUsage(),
		outputTokens: {
			total: textTokens + reasoningTokens,
			text: textTokens,
			reasoning: reasoningTokens,
		},
	},
})

export const enforceOutputTokenLimit = (
	result: LanguageModelV3StreamResult,
	maxOutputTokens: number,
	onLimit: () => void,
): LanguageModelV3StreamResult => {
	const reader = result.stream.getReader()
	let remaining = maxOutputTokens
	let textTokens = 0
	let reasoningTokens = 0
	let lengthFinishPending = false
	let terminal = false
	const toolInputsWithDeltas = new Set<string>()

	const stopAtLimit = async () => {
		if (lengthFinishPending || terminal) return
		lengthFinishPending = true
		onLimit()
		await reader.cancel("max_completion_tokens reached").catch(() => undefined)
	}

	const stream = new ReadableStream<LanguageModelV3StreamPart>({
		async pull(controller) {
			if (lengthFinishPending) {
				lengthFinishPending = false
				terminal = true
				controller.enqueue(syntheticLengthFinish(textTokens, reasoningTokens))
				controller.close()
				return
			}

			while (!terminal) {
				const { value: part, done } = await reader.read()
				if (done) {
					terminal = true
					controller.close()
					return
				}

				let content: string | undefined
				let category: "text" | "reasoning" = "text"
				if (part.type === "text-delta") {
					content = part.delta
				} else if (part.type === "reasoning-delta") {
					content = part.delta
					category = "reasoning"
				} else if (part.type === "tool-input-delta") {
					toolInputsWithDeltas.add(part.id)
					content = part.delta
				} else if (
					part.type === "tool-call" &&
					!toolInputsWithDeltas.has(part.toolCallId)
				) {
					content = JSON.stringify(part.input)
				}

				if (content === undefined) {
					controller.enqueue(part)
					return
				}

				const limited = truncateToTokens(content, remaining)
				remaining -= limited.tokens
				if (category === "reasoning") reasoningTokens += limited.tokens
				else textTokens += limited.tokens

				if (limited.truncated || remaining === 0) {
					await stopAtLimit()
				}

				if (limited.text.length === 0) {
					if (lengthFinishPending) {
						lengthFinishPending = false
						terminal = true
						controller.enqueue(
							syntheticLengthFinish(textTokens, reasoningTokens),
						)
						controller.close()
						return
					}
					continue
				}
				if (limited.truncated) {
					if (part.type === "tool-call") {
						// A partial JSON tool call is not valid output. End before it.
						lengthFinishPending = false
						terminal = true
						controller.enqueue(
							syntheticLengthFinish(textTokens, reasoningTokens),
						)
						controller.close()
						return
					}
					if (
						part.type === "text-delta" ||
						part.type === "reasoning-delta" ||
						part.type === "tool-input-delta"
					) {
						controller.enqueue({ ...part, delta: limited.text })
					}
				} else {
					controller.enqueue(part)
				}
				return
			}
		},
		async cancel(reason) {
			terminal = true
			onLimit()
			await reader.cancel(reason).catch(() => undefined)
		},
	})

	return { ...result, stream }
}
