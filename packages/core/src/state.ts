type JsonRecord = Record<string, unknown>

type CachedResponseEntry = {
	input: unknown[]
	output: JsonRecord[]
}

export type CodexResponsesStateSnapshot = {
	items: Array<{ id: string; item: JsonRecord }>
	responses: Array<{ id: string; input: unknown[]; output: JsonRecord[] }>
}

export type CodexResponsesStateOptions = {
	snapshot?: CodexResponsesStateSnapshot
	onChange?: (snapshot: CodexResponsesStateSnapshot) => void
	/** Total serialized bytes retained by the cache (default 16 MiB). */
	maxBytes?: number
}

const MAX_ITEM_CACHE_SIZE = 2_000
const MAX_RESPONSE_CACHE_SIZE = 256
const isRecord = (value: unknown): value is JsonRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value)
const cloneValue = <T>(value: T): T => structuredClone(value)

export class CodexResponsesState {
	private readonly items = new Map<string, JsonRecord>()
	private readonly responses = new Map<string, CachedResponseEntry>()
	private readonly pendingCaptures = new Set<Promise<void>>()
	private readonly onChange?: (snapshot: CodexResponsesStateSnapshot) => void
	private readonly maxBytes: number
	private readonly sizes = new Map<string, number>()
	private retainedBytes = 0
	private owner: string | undefined

	/** Bind externally supplied caches too; two transports cannot share owners. */
	claimOwner(owner: string): void {
		if (this.owner !== undefined && this.owner !== owner) {
			throw new Error(
				"Responses state is already bound to a different authenticated account.",
			)
		}
		this.owner = owner
	}

	constructor(options: CodexResponsesStateOptions = {}) {
		this.onChange = options.onChange
		this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024
		if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) {
			throw new Error("Responses cache maxBytes must be a positive integer.")
		}
		for (const entry of options.snapshot?.items ?? []) {
			if (typeof entry.id === "string") this.store("item", entry.id, entry.item)
		}
		for (const entry of options.snapshot?.responses ?? []) {
			if (typeof entry.id === "string") {
				this.store("response", entry.id, {
					input: entry.input,
					output: entry.output,
				})
			}
		}
	}

	async waitForPendingCaptures(): Promise<void> {
		await Promise.allSettled([...this.pendingCaptures])
	}

	trackPendingCapture(promise: Promise<void>): void {
		this.pendingCaptures.add(promise)
		void promise.then(
			() => this.pendingCaptures.delete(promise),
			() => this.pendingCaptures.delete(promise),
		)
	}

	hasResponse(id: string): boolean {
		return this.responses.has(id)
	}

	hasItem(id: string): boolean {
		return this.items.has(id)
	}

	requiresCachedState(body: JsonRecord): boolean {
		if (typeof body.previous_response_id === "string") return true
		return (
			Array.isArray(body.input) &&
			body.input.some(
				(item) =>
					isRecord(item) &&
					item.type === "item_reference" &&
					typeof item.id === "string",
			)
		)
	}

	expandRequestBody(body: JsonRecord): JsonRecord {
		const nextBody = { ...body }
		const previousId =
			typeof body.previous_response_id === "string"
				? body.previous_response_id
				: undefined
		const history =
			previousId === undefined ? undefined : this.responses.get(previousId)
		const input = Array.isArray(body.input)
			? this.expandInput(body.input)
			: body.input
		if (history) {
			nextBody.input = [
				...cloneValue(history.input),
				...cloneValue(history.output),
				...(Array.isArray(input) ? input : []),
			]
			delete nextBody.previous_response_id
		} else if (Array.isArray(input)) {
			// A cache miss is not history recovery. Preserve the server reference;
			// only the owning account may resolve it, or report that it is missing.
			nextBody.input = input
		}
		return nextBody
	}

	rememberResponse(response: unknown, requestBody?: JsonRecord): void {
		if (!isRecord(response)) return
		if (response.status !== undefined && response.status !== "completed") return
		// A server-resolved predecessor leaves only the delta in requestBody. Do
		// not later mistake that partial history for a complete local replay.
		if (requestBody && this.requiresCachedState(requestBody)) return
		const output = Array.isArray(response.output)
			? response.output.filter(isRecord)
			: []
		let changed = false
		for (const item of output) {
			if (typeof item.id === "string")
				changed = this.store("item", item.id, item) || changed
		}
		if (typeof response.id === "string" && requestBody) {
			changed =
				this.store("response", response.id, {
					input: Array.isArray(requestBody.input) ? requestBody.input : [],
					output,
				}) || changed
		}
		if (changed) this.onChange?.(this.snapshot())
	}

	snapshot(): CodexResponsesStateSnapshot {
		return {
			items: [...this.items].map(([id, item]) => ({
				id,
				item: cloneValue(item),
			})),
			responses: [...this.responses].map(([id, entry]) => ({
				id,
				...cloneValue(entry),
			})),
		}
	}

	private store(
		kind: "item" | "response",
		id: string,
		value: JsonRecord | CachedResponseEntry,
	): boolean {
		const key = `${kind}:${id}`
		const size =
			new TextEncoder().encode(JSON.stringify(value)).byteLength +
			new TextEncoder().encode(key).byteLength
		this.remove(key)
		if (size > this.maxBytes) return false
		while (this.retainedBytes + size > this.maxBytes) {
			const oldest = this.sizes.keys().next().value
			if (oldest === undefined) break
			this.remove(oldest)
		}
		const map = kind === "item" ? this.items : this.responses
		const limit =
			kind === "item" ? MAX_ITEM_CACHE_SIZE : MAX_RESPONSE_CACHE_SIZE
		if (map.size >= limit) {
			const oldest = map.keys().next().value
			if (oldest !== undefined) this.remove(`${kind}:${oldest}`)
		}
		if (kind === "item") this.items.set(id, cloneValue(value as JsonRecord))
		else this.responses.set(id, cloneValue(value as CachedResponseEntry))
		this.sizes.set(key, size)
		this.retainedBytes += size
		return true
	}

	private remove(key: string): void {
		this.retainedBytes -= this.sizes.get(key) ?? 0
		this.sizes.delete(key)
		if (key.startsWith("item:")) this.items.delete(key.slice(5))
		else this.responses.delete(key.slice(9))
	}

	private expandInput(input: unknown[]): unknown[] {
		return input.map((item) => {
			if (
				isRecord(item) &&
				item.type === "item_reference" &&
				typeof item.id === "string"
			) {
				const cached = this.items.get(item.id)
				if (cached) return cloneValue(cached)
			}
			return cloneValue(item)
		})
	}
}
