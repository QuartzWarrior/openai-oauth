type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value)

type TimedEntry<TValue> = {
	value: TValue
	expiresAt: number
}

export type ReplayMapOptions = {
	ttlMs?: number
	maxEntries?: number
	now?: () => number
}

const DEFAULT_TTL_MS = 30 * 60 * 1000
const DEFAULT_MAX_ENTRIES = 10_000

const itemIdentity = (item: unknown): unknown => {
	if (!isRecord(item)) {
		return item
	}
	// Drop server-assigned ids so retries of the same logical request hash the
	// same even if a caller reuses ids across attempts.
	const { id: _id, ...rest } = item
	return rest
}

/**
 * Describes identical-request affinity. This changes as input changes and must
 * never be used as a continuation ownership index. The pool stores a digest of
 * this value and routes continuation IDs separately.
 */
export const computeSessionHash = (
	parsedBody: JsonRecord,
): string | undefined => {
	if (!isRecord(parsedBody)) {
		return undefined
	}
	const model = parsedBody.model
	const instructions = parsedBody.instructions
	const input = parsedBody.input
	if (typeof model !== "string" || model.length === 0) {
		return undefined
	}
	if (!Array.isArray(input) || input.length === 0) {
		return undefined
	}
	try {
		return JSON.stringify({
			model,
			instructions: typeof instructions === "string" ? instructions : "",
			input: input.map(itemIdentity),
		})
	} catch {
		return undefined
	}
}

/**
 * TTL + LRU map. Used both to remember which account produced the response
 * for a given session hash (so an identical later request is routed back to
 * the account whose `previous_response_id` chain is valid) and to record any
 * per-conversation device ids that must expire with the conversation.
 */
export class ReplayMap<TValue> {
	private readonly entries = new Map<string, TimedEntry<TValue>>()
	private readonly ttlMs: number
	private readonly maxEntries: number
	private readonly now: () => number

	constructor(options: ReplayMapOptions = {}) {
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
		this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
		this.now = options.now ?? (() => Date.now())
		if (
			!Number.isFinite(this.ttlMs) ||
			this.ttlMs <= 0 ||
			!Number.isSafeInteger(this.maxEntries) ||
			this.maxEntries <= 0
		) {
			throw new Error("Replay maps require a positive TTL and entry limit.")
		}
	}

	get(hash: string): TValue | undefined {
		const entry = this.entries.get(hash)
		if (!entry) {
			return undefined
		}
		if (entry.expiresAt <= this.now()) {
			this.entries.delete(hash)
			return undefined
		}
		// Refresh LRU position on hit.
		this.entries.delete(hash)
		this.entries.set(hash, entry)
		return entry.value
	}

	set(hash: string, value: TValue): void {
		this.sweep()
		this.entries.delete(hash)
		this.entries.set(hash, { value, expiresAt: this.now() + this.ttlMs })
		this.trim()
	}

	delete(hash: string): void {
		this.entries.delete(hash)
	}

	clear(): void {
		this.entries.clear()
	}

	get size(): number {
		return this.entries.size
	}

	private sweep(): void {
		const now = this.now()
		for (const [key, entry] of this.entries) {
			if (entry.expiresAt <= now) {
				this.entries.delete(key)
			}
		}
	}

	private trim(): void {
		while (this.entries.size > this.maxEntries) {
			const oldestKey = this.entries.keys().next().value
			if (oldestKey == null) {
				break
			}
			this.entries.delete(oldestKey)
		}
	}
}
