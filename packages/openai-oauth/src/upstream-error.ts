import { InferenceError } from "@openai-oauth/core"
import { APICallError, RetryError } from "ai"
import { isRecord, toJsonResponse } from "./shared.js"

export type UpstreamErrorDescription = {
	status: number
	type: string
	message: string
	code?: string
	/** Seconds until the upstream limit is expected to lift, when known. */
	retryAfter?: number
}

const MAX_MESSAGE_LENGTH = 1000

// Statuses that describe the caller's request rather than the account or the
// upstream service, so they are safe and useful to pass through verbatim.
const REQUEST_STATUSES = new Set([400, 404, 409, 413, 422])

const identifier = (value: unknown): string | undefined =>
	typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
		? value
		: undefined

const parseBody = (body: string | undefined): Record<string, unknown> => {
	if (!body) return {}
	try {
		const parsed: unknown = JSON.parse(body)
		if (!isRecord(parsed)) return {}
		return isRecord(parsed.error) ? parsed.error : parsed
	} catch {
		return {}
	}
}

const rateLimited = (): UpstreamErrorDescription => ({
	status: 429,
	type: "rate_limit_error",
	message: "Upstream rate or usage limit reached.",
})

const unavailable = (): UpstreamErrorDescription => ({
	status: 503,
	type: "service_unavailable",
	message: "Upstream capacity is temporarily unavailable.",
})

// Account problems are ours, not the caller's: a 401/403 here must not look
// like the downstream key was rejected, and must not leak account details.
const upstreamFailure = (): UpstreamErrorDescription => ({
	status: 502,
	type: "upstream_error",
	message: "Upstream request failed.",
})

const fromApiCallError = (error: APICallError): UpstreamErrorDescription => {
	const status = error.statusCode
	if (status === 429) return rateLimited()
	if (status === undefined || !REQUEST_STATUSES.has(status))
		return upstreamFailure()
	const body = parseBody(error.responseBody)
	const message =
		error.message ||
		(typeof body.message === "string" ? body.message : "") ||
		(typeof body.detail === "string" ? body.detail : "") ||
		"Upstream rejected the request."
	return {
		status,
		type: identifier(body.type) ?? "invalid_request_error",
		message: message.slice(0, MAX_MESSAGE_LENGTH),
		code: identifier(body.code),
	}
}

const fromInferenceError = (
	error: InferenceError,
): UpstreamErrorDescription => {
	switch (error.category) {
		case "request":
			return {
				status:
					error.status !== undefined && REQUEST_STATUSES.has(error.status)
						? error.status
						: 400,
				type: "invalid_request_error",
				message: error.code
					? `Upstream rejected the request (${error.code}).`
					: "Upstream rejected the request.",
				code: error.code,
			}
		case "throttled":
		case "quota":
			return error.retryAt === undefined
				? rateLimited()
				: {
						...rateLimited(),
						retryAfter: Math.max(
							1,
							Math.ceil((error.retryAt - Date.now()) / 1000),
						),
					}
		case "capacity":
		case "overloaded":
			return unavailable()
		default:
			return upstreamFailure()
	}
}

/** Classifies failures that came from the upstream model API; undefined otherwise. */
export const describeUpstreamError = (
	error: unknown,
): UpstreamErrorDescription | undefined => {
	if (RetryError.isInstance(error))
		return describeUpstreamError(error.lastError) ?? upstreamFailure()
	if (APICallError.isInstance(error)) return fromApiCallError(error)
	if (error instanceof InferenceError) return fromInferenceError(error)
	return undefined
}

export const toUpstreamErrorBody = ({
	message,
	type,
	code,
}: UpstreamErrorDescription) => ({
	error: code === undefined ? { message, type } : { message, type, code },
})

export const toUpstreamErrorResponse = (
	error: unknown,
): Response | undefined => {
	const description = describeUpstreamError(error)
	if (!description) return undefined
	const response = toJsonResponse(
		toUpstreamErrorBody(description),
		description.status,
	)
	if (description.retryAfter !== undefined)
		response.headers.set("retry-after", String(description.retryAfter))
	return response
}
