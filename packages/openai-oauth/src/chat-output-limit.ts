import type { ChatRequest } from "./types.js"

// Keep this local ceiling explicit until model-specific output limits are
// available from the upstream service.
export const LOCAL_CHAT_MAX_COMPLETION_TOKENS = 128_000

export type ChatOutputLimit =
	| { maxOutputTokens: number | undefined; error?: never }
	| { maxOutputTokens?: never; error: string }

export const resolveChatOutputLimit = (
	request: ChatRequest,
): ChatOutputLimit => {
	if (
		request.max_tokens !== undefined &&
		request.max_completion_tokens !== undefined
	) {
		return {
			error: "Specify only one of `max_tokens` or `max_completion_tokens`.",
		}
	}

	const field =
		request.max_completion_tokens !== undefined
			? "max_completion_tokens"
			: request.max_tokens !== undefined
				? "max_tokens"
				: undefined
	const value =
		request.max_completion_tokens !== undefined
			? request.max_completion_tokens
			: request.max_tokens

	if (field === undefined || value === undefined) {
		return { maxOutputTokens: undefined }
	}
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		return { error: `\`${field}\` must be a positive integer.` }
	}
	if (value > LOCAL_CHAT_MAX_COMPLETION_TOKENS) {
		return {
			error: `\`${field}\` must be at most ${LOCAL_CHAT_MAX_COMPLETION_TOKENS}.`,
		}
	}

	return { maxOutputTokens: value }
}
