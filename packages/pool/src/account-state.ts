type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value)

export type CodexRateSnapshot = {
	observedAt?: number
	primaryUsedPercent?: number
	secondaryUsedPercent?: number
	primaryWindowMinutes?: number
	secondaryWindowMinutes?: number
	/** Unix epoch milliseconds, not window duration. */
	primaryResetAt?: number
	secondaryResetAt?: number
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
	const parsed = value.trim() === "" ? Number.NaN : Number(value)
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

/**
 * Reads Codex per-plan rate-window headers (e.g.
 * `x-codex-primary-used-percent: 37`) so the balancer can tie-break between
 * equally busy accounts by whichever has more headroom left in its window.
 */
export const parseCodexRateHeaders = (
	headers: Headers,
	observedAt?: number,
): CodexRateSnapshot | undefined => {
	const resetAt = (name: string): number | undefined => {
		const value = headers.get(name)
		if (value == null || !/^\d+$/.test(value)) return undefined
		const seconds = Number(value)
		return Number.isSafeInteger(seconds) && Number.isSafeInteger(seconds * 1000)
			? seconds * 1000
			: undefined
	}
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
	const primaryResetAt = resetAt("x-codex-primary-reset-at")
	const secondaryResetAt = resetAt("x-codex-secondary-reset-at")
	if (primaryResetAt !== undefined) snapshot.primaryResetAt = primaryResetAt
	if (secondaryResetAt !== undefined)
		snapshot.secondaryResetAt = secondaryResetAt
	if (observedAt !== undefined) snapshot.observedAt = observedAt
	return snapshot
}

/** Higher = more saturated. Used only as a tie-breaker after inflight. */
export const rateSnapshotUtilization = (
	snapshot: CodexRateSnapshot | undefined,
	now?: number,
): number => {
	if (
		!snapshot ||
		(now !== undefined &&
			snapshot.observedAt !== undefined &&
			now - snapshot.observedAt > 5 * 60_000)
	) {
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
	const seconds = Number(value)
	if (/^\d+(?:\.\d+)?$/.test(value.trim()) && Number.isFinite(seconds)) {
		return Number.isSafeInteger(Math.ceil(seconds * 1000))
			? Math.max(0, Math.ceil(seconds * 1000))
			: undefined
	}
	const date = Date.parse(value)
	if (!Number.isNaN(date)) {
		return Math.max(0, date - now)
	}
	return undefined
}

const extractErrorFields = (
	body: string | undefined,
): { code?: string; type?: string; resetAt?: number } => {
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
		const seconds = error.resets_at
		const resetAt =
			typeof seconds === "number" &&
			Number.isSafeInteger(seconds) &&
			seconds >= 0 &&
			Number.isSafeInteger(seconds * 1000)
				? seconds * 1000
				: undefined
		return { code, type, resetAt }
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

	const { code, type, resetAt } = extractErrorFields(input.bodyText)
	const retryAfterMs = parseRetryAfterMs(input.headers, now)
	const backoffMs = Math.min(
		MAX_BACKOFF_MS,
		BASE_BACKOFF_MS * 2 ** Math.min(consecutiveFailures, 4),
	)
	// reset-at is explicitly Unix seconds in the upstream rate-limit protocol.
	// Only a saturated window with a future reset can lengthen its cooldown.
	const active = input.headers?.get("x-codex-active-limit")
	const activeHeaders = input.headers ? new Headers(input.headers) : undefined
	if (active && /^[a-z0-9_-]{1,64}$/i.test(active) && activeHeaders) {
		for (const window of ["primary", "secondary"])
			for (const field of ["used-percent", "reset-at", "window-minutes"]) {
				const value = activeHeaders.get(`x-codex-${active}-${window}-${field}`)
				if (value !== null)
					activeHeaders.set(`x-codex-${window}-${field}`, value)
			}
	}
	const snapshot = activeHeaders
		? parseCodexRateHeaders(activeHeaders, now)
		: undefined
	const resets = [
		(snapshot?.primaryUsedPercent ?? 0) >= 100
			? snapshot?.primaryResetAt
			: undefined,
		(snapshot?.secondaryUsedPercent ?? 0) >= 100
			? snapshot?.secondaryResetAt
			: undefined,
	].filter((value): value is number => value !== undefined && value > now)
	const resetDelay = resets.length > 0 ? Math.max(...resets) - now : undefined
	const unavailableMs = Math.max(
		retryAfterMs ?? backoffMs,
		isRateLimit
			? Math.max(
					resetDelay ?? 0,
					resetAt !== undefined ? Math.max(0, resetAt - now) : 0,
				)
			: 0,
	)

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
