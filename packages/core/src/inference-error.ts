import { isRecord } from "./utils.js"

export type InferenceErrorCategory =
	| "authentication"
	| "throttled"
	| "quota"
	| "overloaded"
	| "request"
	| "transport"
	| "unknown"
export type InferenceErrorOptions = {
	category: InferenceErrorCategory
	status?: number
	code?: string
	retryAt?: number
	limitId?: string
	requestId?: string
	responseStarted?: boolean
}
const codes = new Set([
	"invalid_api_key",
	"invalid_token",
	"authentication_error",
	"unauthorized",
	"token_expired",
	"rate_limit_exceeded",
	"rate_limit_error",
	"too_many_requests",
	"usage_limit_reached",
	"usage_limit_exceeded",
	"insufficient_quota",
	"quota_exceeded",
	"billing_hard_limit_reached",
	"server_is_overloaded",
	"server_overloaded",
	"overloaded",
	"invalid_request_error",
	"invalid_request",
	"context_length_exceeded",
	"previous_response_not_found",
	"permission_denied",
	"insufficient_permissions",
])
const identifier = (value: unknown): string | undefined =>
	typeof value === "string" &&
	value.length > 0 &&
	value.length <= 128 &&
	/^[A-Za-z0-9_.:-]+$/.test(value)
		? value
		: undefined

/** Machine-readable failure with no provider message, tokens or raw error cause. */
export class InferenceError extends Error {
	readonly category: InferenceErrorCategory
	readonly status?: number
	readonly code?: string
	readonly retryAt?: number
	readonly limitId?: string
	readonly requestId?: string
	readonly responseStarted: boolean
	constructor(options: InferenceErrorOptions) {
		super(
			`The upstream Responses stream reported an error (${options.category}).`,
		)
		this.name = "InferenceError"
		this.category = options.category
		this.status = options.status
		this.code =
			options.code && codes.has(options.code) ? options.code : undefined
		this.retryAt = options.retryAt
		this.limitId = identifier(options.limitId)
		this.requestId = identifier(options.requestId)
		this.responseStarted = options.responseStarted ?? false
	}
}

export const parseInferenceError = (
	value: unknown,
	options: {
		status?: number
		headers?: Headers
		responseStarted?: boolean
		now?: number
	} = {},
): InferenceError => {
	if (value instanceof InferenceError) return value
	const root = isRecord(value) ? value : {}
	const response = isRecord(root.response) ? root.response : root
	const error = isRecord(response.error)
		? response.error
		: isRecord(root.error)
			? root.error
			: response
	const candidate =
		typeof error.code === "string"
			? error.code
			: typeof error.type === "string"
				? error.type
				: typeof root.error === "string"
					? root.error
					: undefined
	const code = candidate && codes.has(candidate) ? candidate : undefined
	const rawStatus =
		options.status ?? error.status ?? root.status ?? root.status_code
	const status =
		typeof rawStatus === "number" &&
		Number.isInteger(rawStatus) &&
		rawStatus >= 100 &&
		rawStatus <= 599
			? rawStatus
			: undefined
	let category: InferenceErrorCategory = "unknown"
	if (
		[
			"invalid_api_key",
			"invalid_token",
			"authentication_error",
			"unauthorized",
			"token_expired",
		].includes(code ?? "") ||
		status === 401
	)
		category = "authentication"
	else if (
		[
			"usage_limit_reached",
			"usage_limit_exceeded",
			"insufficient_quota",
			"quota_exceeded",
			"billing_hard_limit_reached",
		].includes(code ?? "")
	)
		category = "quota"
	else if (
		["rate_limit_exceeded", "rate_limit_error", "too_many_requests"].includes(
			code ?? "",
		) ||
		status === 429
	)
		category = "throttled"
	else if (
		["server_is_overloaded", "server_overloaded", "overloaded"].includes(
			code ?? "",
		)
	)
		category = "overloaded"
	else if (
		[
			"invalid_request_error",
			"invalid_request",
			"context_length_exceeded",
			"previous_response_not_found",
			"permission_denied",
			"insufficient_permissions",
		].includes(code ?? "") ||
		status === 400 ||
		status === 403 ||
		status === 404 ||
		status === 422
	)
		category = "request"
	else if (status !== undefined && status >= 500) category = "transport"
	const now = options.now ?? Date.now()
	let retryAt: number | undefined
	const reset = error.resets_at
	if (
		typeof reset === "number" &&
		Number.isFinite(reset) &&
		reset > 0 &&
		Number.isSafeInteger(reset * 1000)
	)
		retryAt = reset * 1000
	const retry = options.headers?.get("retry-after")
	if (retry) {
		const numeric = Number(retry)
		const candidateAt =
			Number.isFinite(numeric) && numeric >= 0
				? now + numeric * 1000
				: Date.parse(retry)
		if (Number.isSafeInteger(candidateAt) && candidateAt >= now)
			retryAt = Math.max(retryAt ?? 0, candidateAt)
	}
	return new InferenceError({
		category,
		status,
		code,
		retryAt,
		limitId: identifier(
			error.limit_id ??
				root.limit_id ??
				options.headers?.get("x-codex-active-limit"),
		),
		requestId: identifier(
			root.request_id ?? options.headers?.get("x-request-id"),
		),
		responseStarted: options.responseStarted,
	})
}
