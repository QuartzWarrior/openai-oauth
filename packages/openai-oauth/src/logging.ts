import type {
	OpenAIOAuthServerLogEvent,
	OpenAIOAuthServerOptions,
} from "./types.js"
import { describeUpstreamError } from "./upstream-error.js"

export const createRequestLogger = (
	settings: OpenAIOAuthServerOptions,
): ((event: OpenAIOAuthServerLogEvent) => void) | undefined => {
	if (typeof settings.requestLogger === "function") {
		return settings.requestLogger
	}

	// "1" logs every request; "errors" logs only failures, never request summaries.
	const mode = process.env.CODEX_OPENAI_SERVER_LOG_REQUESTS
	if (mode !== "1" && mode !== "errors") {
		return undefined
	}

	return (event) => {
		if (mode === "errors" && !event.type.endsWith("_error")) return
		console.log(
			JSON.stringify({
				source: "openai-oauth",
				timestamp: new Date().toISOString(),
				...event,
			}),
		)
	}
}

export const emitRequestLog = (
	logger: ((event: OpenAIOAuthServerLogEvent) => void) | undefined,
	event: OpenAIOAuthServerLogEvent,
) => {
	try {
		logger?.(event)
	} catch {}
}

/** The error fields of a chat_error event, classified when the failure was upstream. */
export const describeChatError = (
	error: unknown,
): { message: string; status?: number; code?: string } => {
	const upstream = describeUpstreamError(error)
	const message =
		error instanceof Error && error.message.length > 0
			? error.message
			: (upstream?.message ?? "Unexpected server error.")
	return upstream
		? { message, status: upstream.status, code: upstream.code }
		: { message }
}
