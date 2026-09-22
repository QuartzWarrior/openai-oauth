type JsonRecord = Record<string, unknown>
const isRecord = (value: unknown): value is JsonRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const MAX_FAMILIES = 32
const STALE_AFTER_MS = 5 * 60_000

export type QuotaWindow = {
	usedPercent: number
	windowMinutes?: number
	/** Unix epoch milliseconds. */
	resetAt?: number
	/** Usage observation time; reset-only updates do not rejuvenate utilization. */
	observedAt: number
	stale: boolean
}
export type QuotaFamily = {
	limitId: string
	limitName?: string
	planType?: string
	primary?: QuotaWindow
	secondary?: QuotaWindow
}
export type QuotaCredits = {
	hasCredits: boolean
	unlimited: boolean
	/** Provider value retained as text, not floating-point currency. */
	balance?: string
	/** Oldest retained credit component; partial updates do not rejuvenate others. */
	observedAt: number
	stale: boolean
}
export type PoolQuotaStats = {
	families: QuotaFamily[]
	/** The protocol reports account credits, not independent per-family balances. */
	credits?: QuotaCredits
}
export type CodexQuotaUpdate = {
	limitId: string
	limitName?: string
	planType?: string
	observedAt: number
	primary?: Partial<Omit<QuotaWindow, "observedAt" | "stale">>
	secondary?: Partial<Omit<QuotaWindow, "observedAt" | "stale">>
	credits?: Partial<Omit<QuotaCredits, "observedAt" | "stale">>
}

const boundedText = (value: unknown): string | undefined => {
	if (typeof value !== "string") return undefined
	const text = value.trim()
	return text.length > 0 &&
		text.length <= 128 &&
		[...text].every(
			(char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
		)
		? text
		: undefined
}
const limitId = (value: unknown): string | undefined => {
	if (typeof value !== "string" || !/^[a-z0-9_-]{1,64}$/i.test(value.trim()))
		return undefined
	return value.trim().toLowerCase().replace(/-/g, "_")
}
const number = (value: unknown): number | undefined => {
	if (typeof value !== "number" && typeof value !== "string") return undefined
	if (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value.trim()))
		return undefined
	const parsed = Number(value)
	return Number.isFinite(parsed) &&
		parsed >= 0 &&
		parsed <= Number.MAX_SAFE_INTEGER
		? parsed
		: undefined
}
const boolean = (value: unknown): boolean | undefined => {
	if (typeof value === "boolean") return value
	if (typeof value !== "string") return undefined
	if (/^(true|1)$/i.test(value.trim())) return true
	if (/^(false|0)$/i.test(value.trim())) return false
	return undefined
}
const windowUpdate = (value: unknown): CodexQuotaUpdate["primary"] => {
	if (!isRecord(value)) return undefined
	const update: NonNullable<CodexQuotaUpdate["primary"]> = {}
	const used = number(value.used_percent)
	const minutes = number(value.window_minutes)
	const seconds = number(value.reset_at)
	if (used !== undefined) update.usedPercent = used
	if (minutes !== undefined && Number.isSafeInteger(minutes))
		update.windowMinutes = minutes
	if (seconds !== undefined && Number.isSafeInteger(seconds * 1000))
		update.resetAt = seconds * 1000
	return Object.keys(update).length > 0 ? update : undefined
}
const creditsUpdate = (value: unknown): CodexQuotaUpdate["credits"] => {
	if (!isRecord(value)) return undefined
	const update: NonNullable<CodexQuotaUpdate["credits"]> = {}
	const hasCredits = boolean(value.has_credits)
	const unlimited = boolean(value.unlimited)
	const balance = boundedText(value.balance)
	if (hasCredits !== undefined) update.hasCredits = hasCredits
	if (unlimited !== undefined) update.unlimited = unlimited
	if (balance !== undefined) update.balance = balance
	return Object.keys(update).length > 0 ? update : undefined
}
const validTime = (value: number) => Number.isSafeInteger(value) && value >= 0

export const parseCodexQuotaHeaders = (
	headers: Headers,
	observedAt = Date.now(),
): CodexQuotaUpdate[] => {
	if (!validTime(observedAt)) return []
	const families = new Set(["codex"])
	for (const name of headers.keys()) {
		const match =
			/^x-(.+)-(?:primary|secondary)-(?:used-percent|window-minutes|reset-at)$/.exec(
				name,
			)
		const id = limitId(match?.[1])
		if (id && families.size < MAX_FAMILIES) families.add(id)
	}
	const credits = creditsUpdate({
		has_credits: headers.get("x-codex-credits-has-credits"),
		unlimited: headers.get("x-codex-credits-unlimited"),
		balance: headers.get("x-codex-credits-balance"),
	})
	const updates: CodexQuotaUpdate[] = []
	for (const id of families) {
		const prefix = `x-${id.replace(/_/g, "-")}`
		const readWindow = (name: string) =>
			windowUpdate({
				used_percent: headers.get(`${prefix}-${name}-used-percent`),
				window_minutes: headers.get(`${prefix}-${name}-window-minutes`),
				reset_at: headers.get(`${prefix}-${name}-reset-at`),
			})
		const primary = readWindow("primary")
		const secondary = readWindow("secondary")
		if (!primary && !secondary && !(id === "codex" && credits)) continue
		updates.push({
			limitId: id,
			observedAt,
			limitName: boundedText(headers.get(`${prefix}-limit-name`)),
			planType: boundedText(headers.get("x-codex-plan-type")),
			primary,
			secondary,
			credits: id === "codex" ? credits : undefined,
		})
	}
	return updates
}

export const parseCodexQuotaEvent = (
	event: unknown,
	observedAt = Date.now(),
): CodexQuotaUpdate | undefined => {
	if (
		!isRecord(event) ||
		event.type !== "codex.rate_limits" ||
		!validTime(observedAt)
	)
		return undefined
	const rawId = event.metered_limit_name ?? event.limit_name ?? "codex"
	const id = limitId(rawId)
	if (!id) return undefined
	const rate = isRecord(event.rate_limits) ? event.rate_limits : {}
	const primary = windowUpdate(rate.primary)
	const secondary = windowUpdate(rate.secondary)
	const credits = creditsUpdate(event.credits)
	if (!primary && !secondary && !credits) return undefined
	return {
		limitId: id,
		observedAt,
		primary,
		secondary,
		credits,
		planType: boundedText(event.plan_type),
	}
}

type StoredWindow = Partial<Omit<QuotaWindow, "observedAt" | "stale">> & {
	times: Partial<Record<"usedPercent" | "windowMinutes" | "resetAt", number>>
}
type StoredCredits = Partial<Omit<QuotaCredits, "observedAt" | "stale">> & {
	times: Partial<Record<"hasCredits" | "unlimited" | "balance", number>>
}
type StoredFamily = Omit<QuotaFamily, "primary" | "secondary"> & {
	primary?: StoredWindow
	secondary?: StoredWindow
	updatedAt: number
	metadataAt: number
}

/** Diagnostics only: this store never changes admission or routing policy. */
export class QuotaStore {
	private readonly families = new Map<string, StoredFamily>()
	private credits?: StoredCredits

	clear(): void {
		this.families.clear()
		this.credits = undefined
	}

	update(update: CodexQuotaUpdate): void {
		const at = update.observedAt
		if (update.credits) {
			const credits = this.credits ?? { times: {} }
			for (const name of ["hasCredits", "unlimited", "balance"] as const) {
				const value = update.credits[name]
				if (value === undefined || at < (credits.times[name] ?? 0)) continue
				if (name === "balance") credits.balance = value as string
				else credits[name] = value as boolean
				credits.times[name] = at
			}
			this.credits = credits
		}
		let family = this.families.get(update.limitId)
		if (!family) {
			if (!update.primary && !update.secondary) return
			if (this.families.size >= MAX_FAMILIES) {
				const oldest = [...this.families.values()]
					.filter((entry) => entry.limitId !== "codex")
					.sort(
						(a, b) =>
							a.updatedAt - b.updatedAt || a.limitId.localeCompare(b.limitId),
					)[0]
				if (oldest) this.families.delete(oldest.limitId)
			}
			family = { limitId: update.limitId, updatedAt: at, metadataAt: at }
			this.families.set(update.limitId, family)
		}
		for (const name of ["primary", "secondary"] as const) {
			const incoming = update[name]
			if (!incoming) continue
			const current = family[name] ?? { times: {} }
			for (const field of [
				"usedPercent",
				"windowMinutes",
				"resetAt",
			] as const) {
				const value = incoming[field]
				if (value === undefined || at < (current.times[field] ?? 0)) continue
				current[field] = value
				current.times[field] = at
			}
			family[name] = current
		}
		if (at >= family.metadataAt) {
			if (update.limitName !== undefined) family.limitName = update.limitName
			if (update.planType !== undefined) family.planType = update.planType
			family.metadataAt = at
		}
		family.updatedAt = Math.max(family.updatedAt, at)
	}

	snapshot(now = Date.now()): PoolQuotaStats | undefined {
		if (this.families.size === 0 && !this.credits) return undefined
		const window = (
			value: StoredWindow | undefined,
		): QuotaWindow | undefined => {
			if (
				value?.usedPercent === undefined ||
				value.times.usedPercent === undefined
			)
				return undefined
			return {
				usedPercent: value.usedPercent,
				windowMinutes: value.windowMinutes,
				resetAt: value.resetAt,
				observedAt: value.times.usedPercent,
				stale: now - value.times.usedPercent > STALE_AFTER_MS,
			}
		}
		const creditTimes = Object.values(this.credits?.times ?? {})
		const creditsAt = creditTimes.length ? Math.min(...creditTimes) : 0
		return {
			families: [...this.families.values()]
				.sort((a, b) => a.limitId.localeCompare(b.limitId))
				.map((family) => ({
					limitId: family.limitId,
					limitName: family.limitName,
					planType: family.planType,
					primary: window(family.primary),
					secondary: window(family.secondary),
				})),
			credits:
				this.credits?.hasCredits !== undefined &&
				this.credits.unlimited !== undefined
					? {
							hasCredits: this.credits.hasCredits,
							unlimited: this.credits.unlimited,
							balance: this.credits.balance,
							observedAt: creditsAt,
							stale: now - creditsAt > STALE_AFTER_MS,
						}
					: undefined,
		}
	}
}
