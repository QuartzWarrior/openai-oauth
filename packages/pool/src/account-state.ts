type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value)

export type CodexRateSnapshot = {
	primaryUsedPercent?: number
	secondaryUsedPercent?: number
	primaryWindowMinutes?: number
	secondaryWindowMinutes?: number
	planType?: string
}

export type Unavailability = {
	unavailableMs: number
	reason: string
	retriableOnOtherAccount: boolean
}

const MAX_BACKOFF_MS = 60_000
const BASE_BACKOFF_MS = 5_000

const RETRYABLE_UNAVAILABILITY_CODES = new Set([
	"rate_limit_exceeded",
	"usage_limit_reached",
	"usage_not_included",
	"incorrect_api_key",
	"insufficient_quota",
])

const RETRYABLE_UNAVAILABILITY_TYPES = new Set([
	"usage_limit_reached",
	"tokens",
	"requests",
])

const parsePositiveNumber = (value: string | null): number | undefined => {
	if (value == null) {
		return undefined
	}
	const parsed = Number.parseFloat(value)
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

/**
 * Reads Codex per-plan rate-window headers (e.g.
 * `x-codex-primary-used-percent: 37`) so the balancer can tie-break between
 * equally busy accounts by whichever has more headroom left in its window.
 */
export const parseCodexRateHeaders = (
	headers: Headers,
): CodexRateSnapshot | undefined => {
	const snapshot: CodexRateSnapshot = {
		primaryUsedPercent: parsePositiveNumber(
			headers.get("x-codex-primary-used-percent"),
		),
		secondaryUsedPercent: parsePositiveNumber(
			headers.get("x-codex-secondary-used-percent"),
		),
		primaryWindowMinutes: parsePositiveNumber(
			headers.get("x-codex-primary-window-minutes"),
		),
		secondaryWindowMinutes: parsePositiveNumber(
			headers.get("x-codex-secondary-window-minutes"),
		),
		planType: headers.get("x-codex-plan-type") ?? undefined,
	}

	if (
		snapshot.primaryUsedPercent === undefined &&
		snapshot.secondaryUsedPercent === undefined
	) {
		return undefined
	}
	return snapshot
}

/** Higher = more saturated. Used only as a tie-breaker after inflight. */
export const rateSnapshotUtilization = (
	snapshot: CodexRateSnapshot | undefined,
): number => {
	if (!snapshot) {
		return 0
	}
	return Math.max(
		snapshot.primaryUsedPercent ?? 0,
		snapshot.secondaryUsedPercent ?? 0,
	)
}

const parseRetryAfterMs = (
	headers: Headers | undefined,
	now: number,
): number | undefined => {
	if (!headers) {
		return undefined
	}
	const value = headers.get("retry-after")
	if (!value) {
		return undefined
	}
	const seconds = Number.parseFloat(value)
	if (Number.isFinite(seconds)) {
		return Math.max(0, Math.ceil(seconds * 1000))
	}
	const date = Date.parse(value)
	if (!Number.isNaN(date)) {
		return Math.max(0, date - now)
	}
	return undefined
}

const extractErrorFields = (
	body: string | undefined,
): { code?: string; type?: string } => {
	if (!body) {
		return {}
	}
	try {
		const parsed = JSON.parse(body)
		if (!isRecord(parsed)) {
			return {}
		}
		const error = isRecord(parsed.error) ? parsed.error : parsed
		const code = typeof error.code === "string" ? error.code : undefined
		const type = typeof error.type === "string" ? error.type : undefined
		return { code, type }
	} catch {
		return {}
	}
}

/**
 * Decides how long an account should sit out of rotation after a failed
 * response, and whether the same request is safe to replay on another
 * account. Honors `Retry-After` when present; otherwise backs off
 * exponentially (5s doubling per consecutive failure, capped at 60s).
 */
export const computeUnavailability = (input: {
	status: number
	retryAfter?: string | null
	headers?: Headers
	bodyText?: string
	consecutiveFailures: number
	now?: number
}): Unavailability | undefined => {
	const { status, consecutiveFailures } = input
	const now = input.now ?? Date.now()

	const isAuthFailure = status === 401 || status === 403
	const isRateLimit = status === 429
	if (!isAuthFailure && !isRateLimit) {
		return undefined
	}

	const retryAfterMs = parseRetryAfterMs(input.headers, now)
	const backoffMs = Math.min(
		MAX_BACKOFF_MS,
		BASE_BACKOFF_MS * 2 ** Math.min(consecutiveFailures, 4),
	)
	const unavailableMs = retryAfterMs ?? backoffMs

	const { code, type } = extractErrorFields(input.bodyText)
	const explicitCode =
		(code && RETRYABLE_UNAVAILABILITY_CODES.has(code)) ||
		(type && RETRYABLE_UNAVAILABILITY_TYPES.has(type))

	return {
		unavailableMs,
		reason: isRateLimit
			? `rate limited (HTTP 429${code ? `, ${code}` : ""})`
			: `auth/account rejected (HTTP ${status}${code ? `, ${code}` : ""})`,
		retriableOnOtherAccount: isRateLimit || explicitCode === true,
	}
}

export type AccountHealth = {
	unavailableUntil: number
	unavailableReason?: string
	consecutiveFailures: number
}

export const isAccountAvailable = (
	health: AccountHealth,
	now: number,
): boolean => health.unavailableUntil <= now
