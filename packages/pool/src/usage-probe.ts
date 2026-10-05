import {
	applyCodexAuthHeaders,
	DEFAULT_CODEX_BASE_URL,
	type FetchFunction,
	type OpenAIOAuthSession,
} from "@openai-oauth/core"
import { type CodexUsageSnapshot, parseCodexUsagePayload } from "./quota.js"

const MAX_USAGE_BODY_BYTES = 64 * 1024
const USAGE_TIMEOUT_MS = 15_000
const STARTUP_FLOOR_MS = 1_000

/**
 * Mirrors codex backend-client PathStyle: ChatGPT bases (`/backend-api`) use
 * `/wham/usage`; Codex API bases use `/api/codex/usage`.
 */
export const codexUsageUrl = (baseURL = DEFAULT_CODEX_BASE_URL): string => {
	const url = new URL(baseURL)
	const path = url.pathname.replace(/\/+$/, "")
	const backend = path.indexOf("/backend-api")
	url.pathname =
		backend >= 0
			? `${path.slice(0, backend)}/backend-api/wham/usage`
			: `${path.replace(/\/codex$/, "")}/api/codex/usage`
	url.search = ""
	url.hash = ""
	return url.toString()
}

export type UsageProbeResult =
	| { kind: "ok"; snapshot: CodexUsageSnapshot }
	| { kind: "http"; status: number; headers: Headers; bodyText?: string }
	| { kind: "invalid" }

const readText = async (
	response: Response,
	limit: number,
): Promise<string | undefined> => {
	if (!response.body) return ""
	const reader = response.body.getReader()
	const decoder = new TextDecoder()
	let text = ""
	let size = 0
	try {
		for (;;) {
			const { value, done } = await reader.read()
			if (done) return text + decoder.decode()
			size += value.byteLength
			if (size > limit) {
				void reader.cancel().catch(() => undefined)
				return undefined
			}
			text += decoder.decode(value, { stream: true })
		}
	} finally {
		reader.releaseLock()
	}
}

/** One authenticated read of the account's plan usage; never inference. */
export const fetchCodexUsage = async (options: {
	fetch: FetchFunction
	url: string
	session: OpenAIOAuthSession
	headers?: Record<string, string>
	codexVersion?: string
	terminalToken?: string
	signal?: AbortSignal
	now: () => number
	timeoutMs?: number
}): Promise<UsageProbeResult> => {
	const headers = new Headers(options.headers)
	headers.delete("installation_id")
	applyCodexAuthHeaders(
		headers,
		options.session,
		options.codexVersion,
		options.terminalToken,
	)
	const signal = AbortSignal.any([
		AbortSignal.timeout(options.timeoutMs ?? USAGE_TIMEOUT_MS),
		...(options.signal ? [options.signal] : []),
	])
	const response = await options.fetch(options.url, {
		method: "GET",
		headers,
		redirect: "error",
		signal,
	})
	const text = await readText(response, MAX_USAGE_BODY_BYTES)
	if (!response.ok)
		return {
			kind: "http",
			status: response.status,
			headers: response.headers,
			bodyText: text?.slice(0, 4096),
		}
	if (text === undefined) return { kind: "invalid" }
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		return { kind: "invalid" }
	}
	const snapshot = parseCodexUsagePayload(parsed, options.now())
	return snapshot ? { kind: "ok", snapshot } : { kind: "invalid" }
}

type Timers = {
	setTimeout(callback: () => void, ms: number): unknown
	clearTimeout(handle: unknown): void
}

export type UsageProbeSchedulerOptions = {
	/** Spread startup probes over this window; false skips them. */
	startupWindowMs: number | false
	/** Re-probe cadence for blocked accounts; false disables. */
	blockedProbeMs: number | false
	/** Minimum spacing between any two probes (default 3 s). */
	minGapMs?: number
	/** Extra random spacing added to the minimum (default 7 s). */
	gapJitterMs?: number
	random?: () => number
	now: () => number
	timers?: Timers
}

const defaultTimers: Timers = {
	setTimeout: (callback, ms) => {
		const handle = setTimeout(callback, ms)
		;(handle as { unref?: () => void }).unref?.()
		return handle
	},
	clearTimeout: (handle) =>
		clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * Per-account probe timers with no shared tick: random startup offsets,
 * jittered blocked re-probes, and one pool-wide slot enforcing randomized
 * spacing so accounts never probe side by side.
 */
export class UsageProbeScheduler<K> {
	private readonly timers: Timers
	private readonly random: () => number
	private readonly due = new Map<K, { handle: unknown; at: number }>()
	private readonly queue: K[] = []
	private readonly running = new Set<K>()
	private slotBusy = false
	private nextSlotAt = 0
	private slotTimer: unknown
	private stopped = false

	constructor(
		private readonly options: UsageProbeSchedulerOptions,
		private readonly probe: (key: K) => Promise<void>,
	) {
		this.timers = options.timers ?? defaultTimers
		this.random = options.random ?? Math.random
	}

	/** Schedule one startup probe per key at independent random offsets. */
	start(keys: readonly K[]): void {
		const window = this.options.startupWindowMs
		if (window === false) return
		// Never at construction: offsets fall in [min(1 s, window), window).
		const floor = Math.min(STARTUP_FLOOR_MS, window)
		for (const key of keys)
			this.schedule(key, floor + Math.floor(this.random() * (window - floor)))
	}

	/** (Re)arm a blocked key's next probe at the cadence ±20%. */
	scheduleBlocked(key: K): void {
		const interval = this.options.blockedProbeMs
		if (interval === false) return
		this.schedule(key, Math.round(interval * (0.8 + 0.4 * this.random())))
	}

	cancel(key: K): void {
		const entry = this.due.get(key)
		if (entry) this.timers.clearTimeout(entry.handle)
		this.due.delete(key)
		const index = this.queue.indexOf(key)
		if (index >= 0) this.queue.splice(index, 1)
	}

	nextProbeAt(key: K): number | undefined {
		return this.due.get(key)?.at
	}

	stop(): void {
		this.stopped = true
		for (const key of [...this.due.keys()]) this.cancel(key)
		this.queue.length = 0
		if (this.slotTimer !== undefined) this.timers.clearTimeout(this.slotTimer)
		this.slotTimer = undefined
	}

	private schedule(key: K, delay: number): void {
		if (this.stopped) return
		this.cancel(key)
		const at = this.options.now() + delay
		const handle = this.timers.setTimeout(() => {
			this.due.delete(key)
			this.enqueue(key)
		}, delay)
		this.due.set(key, { handle, at })
	}

	private enqueue(key: K): void {
		if (this.stopped || this.running.has(key) || this.queue.includes(key))
			return
		this.queue.push(key)
		this.pump()
	}

	private pump(): void {
		if (this.stopped || this.slotBusy || this.slotTimer !== undefined) return
		const key = this.queue[0]
		if (key === undefined) return
		const wait = this.nextSlotAt - this.options.now()
		if (wait > 0) {
			this.slotTimer = this.timers.setTimeout(() => {
				this.slotTimer = undefined
				this.pump()
			}, wait)
			return
		}
		this.queue.shift()
		this.slotBusy = true
		this.running.add(key)
		const release = () => {
			this.running.delete(key)
			this.slotBusy = false
			this.nextSlotAt =
				this.options.now() +
				(this.options.minGapMs ?? 3_000) +
				Math.floor(this.random() * (this.options.gapJitterMs ?? 7_000))
			this.pump()
		}
		void this.probe(key).then(release, release)
	}
}
