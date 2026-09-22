import {
	buildCodexUserAgent,
	DEFAULT_CODEX_BASE_URL,
	DEFAULT_CODEX_CLIENT_VERSION,
	DEFAULT_CODEX_ORIGINATOR,
	parseInferenceError,
	ResponseSseCollector,
	resolveCodexClientVersion,
} from "@openai-oauth/core"

const RESPONSES_WEBSOCKETS_BETA = "responses_websockets=2026-02-06"
const WS_CONNECT_TIMEOUT_MS = 10_000
const WS_RESPONSE_TIMEOUT_MS = 300_000
// codex never initiates a ping of any kind: tungstenite answers server pings
// with pongs automatically and sends nothing itself. Liveness here is the idle
// timeout only — no client ping/pong loop at all.
const WS_IDLE_TIMEOUT_MS = 60_000

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value)

export type WebsocketTransportOptions = {
	/** Codex backend base URL (http(s)://...); converted to ws(s)://. */
	baseURL?: string
	codexVersion?: string
	/** Extra headers merged into the upgrade request (per-account overrides). */
	headers?: Record<string, string>
	/**
	 * Terminal token for the upgrade User-Agent; must match the account's HTTP
	 * UA so one account presents a single consistent client across transports.
	 * Defaults to `unknown` (headless TUI).
	 */
	terminalToken?: string
	fetchImpl?: typeof fetch
	now?: () => number
	maxBufferedBytes?: number
	maxConnections?: number
	connectTimeoutMs?: number
	streamIdleTimeoutMs?: number
	requestTimeoutMs?: number
	/** Test hook: bypass the lazy undici import. */
	webSocketFactory?: WebSocketFactory
}

export type WebsocketConnectionIdentity = {
	isFedRamp?: boolean
	accountId: string
	installationId: string
	/** Per-conversation id (thread id when distinct). */
	sessionId?: string
	/** Conversation thread id; falls back to sessionId. */
	threadId?: string
	/** codex "<thread_id>:<window_number>" window id, sent on the upgrade. */
	windowId?: string
}

export type WebsocketIdentity = {
	/** Fully prepared Responses URL, including provider query parameters. */
	url?: string
	isFedRamp?: boolean
	signal?: AbortSignal
	accountId: string
	installationId: string
	/** Per-conversation id; falls back to installationId. */
	sessionId?: string
	/** Conversation thread id; falls back to sessionId. */
	threadId?: string
	/** Stable per-account window id, like codex's one-window-per-process TUI. */
	windowId?: string
	/**
	 * Sticky-routing token captured from a prior response this turn; resent in
	 * client_metadata (codex inserts x-codex-turn-state when its OnceLock is set).
	 */
	turnState?: string
	/**
	 * Fresh v7 id for this logical turn (codex mints `turn_id: Uuid::now_v7()`
	 * per turn and inserts it into client_metadata when turn metadata is present,
	 * responses_metadata.rs:325). Present on turn frames, absent on prewarm/
	 * models-shaped requests.
	 */
	turnId?: string
	responsesLite?: boolean
}

export type WebsocketTransport = {
	/** Legacy capability marker; callers must not replay an exchange after output. */
	readonly fallbackToHttp: true
	streamResponse(
		requestBody: JsonRecord,
		identity: WebsocketIdentity,
		accessToken: string,
	): Promise<ReadableStream<Uint8Array>>
	prewarm(identity: WebsocketConnectionIdentity, accessToken: string): void
	close(): Promise<void>
}

type UndiciWebSocket = {
	binaryType: string
	readyState: number
	send(data: string | ArrayBufferLike): void
	close(code?: number, reason?: string): void
	addEventListener(
		type: "open" | "message" | "error" | "close",
		listener: (event: never) => void,
	): void
}

type UndiciModule = {
	WebSocket: new (
		url: string,
		options?: { headers?: Record<string | symbol, string> },
	) => UndiciWebSocket
}

type WebSocketFactory = (
	url: string,
	headers: Record<string, string>,
) => Promise<UndiciWebSocket> | UndiciWebSocket

let undiciModulePromise: Promise<UndiciModule | undefined> | undefined

const loadUndici = (): Promise<UndiciModule | undefined> => {
	undiciModulePromise ??= import("undici")
		.then((module) => module as unknown as UndiciModule)
		.catch(() => undefined)
	return undiciModulePromise
}

export const buildWebsocketUpgradeHeaders = (
	identity: WebsocketConnectionIdentity,
	codexVersion: string,
	extraHeaders?: Record<string, string>,
	terminalToken?: string,
): Record<string, string> => {
	const headers: Record<string, string> = {
		// Mirrors codex-rs build_websocket_headers (client.rs:1162-1195): originator,
		// codex UA (from the default client), thread-scoped ids, websocket beta. The
		// genuine handshake also carries Authorization + chatgpt-account-id (via
		// add_auth_headers) — those are added by the caller, which owns the token.
		// Codex's tungstenite handshake sends NO Origin header, and none of undici's
		// browser-stack upgrade extras; keep handshake to exactly codex's set.
		originator: DEFAULT_CODEX_ORIGINATOR,
		"User-Agent": buildCodexUserAgent(codexVersion, terminalToken),
		// The built-in provider's static `version` header is merged into the ws
		// handshake too (responses_websocket.rs:495) — same value as the UA segment.
		version: codexVersion,
		"OpenAI-Beta": RESPONSES_WEBSOCKETS_BETA,
		"chatgpt-account-id": identity.accountId,
		"session-id": identity.sessionId ?? identity.installationId,
		"thread-id":
			identity.threadId ?? identity.sessionId ?? identity.installationId,
		"x-client-request-id":
			identity.threadId ?? identity.sessionId ?? identity.installationId,
	}
	// Codex's handshake compat headers always include x-codex-window-id when a
	// window exists (build_websocket_headers extends compatibility_headers,
	// which inserts it unconditionally). A pool account is one window.
	if (identity.windowId !== undefined) {
		headers["x-codex-window-id"] = identity.windowId
	}
	// Preserve familiar casing for exported header objects, but never allow
	// account-routing overrides from additional headers.
	const result = { ...headers, ...extraHeaders }
	for (const name of Object.keys(result)) {
		if (["chatgpt-account-id", "x-openai-fedramp"].includes(name.toLowerCase()))
			delete result[name]
	}
	result["chatgpt-account-id"] = identity.accountId
	if (identity.isFedRamp) result["x-openai-fedramp"] = "true"
	return result
}

const toWebsocketUrl = (baseURL: string | undefined): string => {
	const base = new URL(baseURL ?? DEFAULT_CODEX_BASE_URL)
	base.protocol = base.protocol === "http:" ? "ws:" : "wss:"
	// Codex authenticates the upgrade with headers (add_auth_headers), never a
	// query token — tokens in URLs leak into logs/proxies and mark the client.
	base.pathname = `${base.pathname.replace(/\/$/, "")}/responses`
	return base.toString()
}

type Timers = {
	setTimeout: typeof setTimeout
	clearTimeout: typeof clearTimeout
	setInterval: typeof setInterval
	clearInterval: typeof clearInterval
}

const defaultTimers: Timers = {
	setTimeout,
	clearTimeout,
	setInterval,
	clearInterval,
}

export type WebsocketConnectionOptions = WebsocketTransportOptions & {
	timers?: Timers
}

const RESPONSE_CREATE_TYPE = "response.create"

const pickClientMetadata = (
	identity: WebsocketIdentity,
): Record<string, string> => {
	// Codex's CodexResponsesMetadata::client_metadata() always emits these keys
	// on both the ws frame and the HTTP body: installation id, session id,
	// thread id, and x-codex-window-id (window_id is non-optional there). A bare
	// `installation_id` key is never among them.
	const effective = identity.sessionId ?? identity.installationId
	const threadId = identity.threadId ?? effective
	const metadata: Record<string, string> = {
		"x-codex-installation-id": identity.installationId,
		session_id: effective,
		thread_id: threadId,
		// codex window_id is "<thread_id>:<window_number>"; default to the first
		// window (":0") when the caller didn't pin one, matching its non-optional
		// presence in client_metadata.
		"x-codex-window-id": identity.windowId ?? `${threadId}:0`,
	}
	// Codex inserts x-codex-turn-state into client_metadata when its per-turn
	// OnceLock is set (client.rs:1775) — i.e. once captured, for sticky routing.
	if (identity.turnState !== undefined) {
		metadata["x-codex-turn-state"] = identity.turnState
	}
	// A turn-shaped frame carries the fresh v7 turn_id codex mints per turn
	// (turn_metadata.rs:136 → client_metadata responses_metadata.rs:325-327).
	if (identity.turnId !== undefined) {
		metadata.turn_id = identity.turnId
	}
	if (identity.responsesLite)
		metadata.ws_request_header_x_openai_internal_codex_responses_lite = "true"
	return metadata
}

type PendingExchange = {
	onFrame(frame: JsonRecord): void
	fail(error: Error): void
}

const errorOf = (value: unknown): Error =>
	value instanceof Error ? value : new Error("Websocket operation failed.")

/** Wrapped errors carry HTTP policy metadata, not arbitrary response headers. */
const wrappedErrorHeaders = (value: unknown): Headers => {
	const headers = new Headers()
	if (!isRecord(value)) return headers
	for (const [name, raw] of Object.entries(value)) {
		const key = name.toLowerCase()
		if (!["retry-after", "x-codex-active-limit", "x-request-id"].includes(key))
			continue
		const text =
			typeof raw === "string"
				? raw
				: typeof raw === "number" && Number.isFinite(raw)
					? String(raw)
					: undefined
		if (text === undefined || text.length > 256 || /[^\x20-\x7e]/.test(text))
			continue
		headers.set(key, text)
	}
	return headers
}

const semanticKey = (body: JsonRecord): string =>
	JSON.stringify(
		Object.fromEntries(
			Object.entries(body)
				.filter(
					([key]) =>
						!["input", "previous_response_id", "client_metadata"].includes(key),
				)
				.sort(([a], [b]) => a.localeCompare(b)),
		),
	)

export class WebsocketConnection {
	private socket?: UndiciWebSocket
	private pendingSocket?: UndiciWebSocket
	private handshakeReject?: (error: Error) => void
	private closed = false
	private readonly lifecycle = new AbortController()
	private idleTimer?: ReturnType<typeof setTimeout>
	private readonly timers: Timers
	private active?: PendingExchange
	private busy = false
	private readonly slots: Array<{
		resolve(): void
		reject(error: Error): void
		signal?: AbortSignal
		abort(): void
	}> = []
	private warmSent = false
	private last?: { id: string; history: unknown[]; key: string }

	constructor(
		private readonly identity: WebsocketIdentity,
		private readonly options: WebsocketConnectionOptions = {},
	) {
		this.timers = options.timers ?? defaultTimers
	}

	get isIdle(): boolean {
		return !this.busy && this.slots.length === 0
	}

	private async acquire(signal?: AbortSignal): Promise<void> {
		if (this.closed) throw new Error("Websocket connection is closed.")
		if (signal?.aborted) throw errorOf(signal.reason)
		if (!this.busy) {
			this.busy = true
			return
		}
		if (this.slots.length >= 128)
			throw new Error("Websocket request queue is full.")
		await new Promise<void>((resolve, reject) => {
			const slot = {
				resolve,
				reject,
				signal,
				abort: () => {
					const index = this.slots.indexOf(slot)
					if (index >= 0) this.slots.splice(index, 1)
					reject(errorOf(signal?.reason))
				},
			}
			this.slots.push(slot)
			signal?.addEventListener("abort", slot.abort, { once: true })
		})
	}

	private release(): void {
		const slot = this.slots.shift()
		if (slot) {
			slot.signal?.removeEventListener("abort", slot.abort)
			slot.resolve()
		} else {
			this.busy = false
			this.armIdle()
		}
	}

	private armIdle(): void {
		if (this.idleTimer) this.timers.clearTimeout(this.idleTimer)
		if (this.closed || !this.socket || this.busy) return
		this.idleTimer = this.timers.setTimeout(() => {
			if (!this.busy) this.disconnect(new Error("Websocket idle timeout."))
		}, WS_IDLE_TIMEOUT_MS)
	}

	private disconnect(error: Error): void {
		this.last = undefined
		if (this.idleTimer) this.timers.clearTimeout(this.idleTimer)
		this.handshakeReject?.(error)
		const socket = this.socket ?? this.pendingSocket
		this.socket = undefined
		this.pendingSocket = undefined
		this.active?.fail(error)
		try {
			socket?.close()
		} catch {}
	}

	private async connect(
		accessToken: string,
		signal?: AbortSignal,
	): Promise<UndiciWebSocket> {
		const attempt = new AbortController()
		let rejectAbort: (error: Error) => void = () => {}
		const aborted = new Promise<never>((_, reject) => {
			rejectAbort = reject
		})
		const abort = () => {
			const error = errorOf(
				signal?.aborted ? signal.reason : this.lifecycle.signal.reason,
			)
			attempt.abort(error)
			rejectAbort(error)
		}
		signal?.addEventListener("abort", abort, { once: true })
		this.lifecycle.signal.addEventListener("abort", abort, { once: true })
		const timer = this.timers.setTimeout(() => {
			const error = new Error("Timed out opening the Codex websocket.")
			attempt.abort(error)
			rejectAbort(error)
		}, this.options.connectTimeoutMs ?? WS_CONNECT_TIMEOUT_MS)
		if (signal?.aborted || this.lifecycle.signal.aborted) abort()
		try {
			return await Promise.race([
				this.open(accessToken, attempt.signal),
				aborted,
			])
		} finally {
			this.timers.clearTimeout(timer)
			signal?.removeEventListener("abort", abort)
			this.lifecycle.signal.removeEventListener("abort", abort)
		}
	}

	private async open(
		accessToken: string,
		signal?: AbortSignal,
	): Promise<UndiciWebSocket> {
		if (this.closed) throw new Error("Websocket connection is closed.")
		if (signal?.aborted) throw errorOf(signal.reason)
		if (this.socket?.readyState === 1) return this.socket
		const codexVersion = await resolveCodexClientVersion({
			codexVersion: this.options.codexVersion,
			fetchImpl: this.options.fetchImpl ?? globalThis.fetch?.bind(globalThis),
		}).catch(() => DEFAULT_CODEX_CLIENT_VERSION)
		if (this.closed || signal?.aborted) throw errorOf(signal?.reason)
		const headers = buildWebsocketUpgradeHeaders(
			this.identity,
			codexVersion,
			this.options.headers,
			this.options.terminalToken,
		)
		for (const name of Object.keys(headers))
			if (name.toLowerCase() === "authorization") delete headers[name]
		headers.Authorization = `Bearer ${accessToken}`
		const factory =
			this.options.webSocketFactory ??
			(async (url: string, values: Record<string, string>) => {
				const undici = await loadUndici()
				if (!undici) throw new Error("Websocket transport requires undici.")
				return new undici.WebSocket(url, { headers: values })
			})
		const target = this.identity.url
			? new URL(this.identity.url)
			: new URL(toWebsocketUrl(this.options.baseURL))
		target.protocol =
			target.protocol === "http:" || target.protocol === "ws:" ? "ws:" : "wss:"
		const socket = await factory(target.toString(), headers)
		if (this.closed || signal?.aborted) {
			socket.close()
			throw new Error("Websocket connection is closed or aborted.")
		}
		this.pendingSocket = socket
		await new Promise<void>((resolve, reject) => {
			let done = false
			const finish = (error?: Error) => {
				if (done) return
				done = true
				this.timers.clearTimeout(timer)
				signal?.removeEventListener("abort", abort)
				this.handshakeReject = undefined
				if (error) {
					socket.close()
					reject(error)
				} else resolve()
			}
			const abort = () => finish(errorOf(signal?.reason))
			const timer = this.timers.setTimeout(
				() => finish(new Error("Timed out opening the Codex websocket.")),
				this.options.connectTimeoutMs ?? WS_CONNECT_TIMEOUT_MS,
			)
			this.handshakeReject = (error) => finish(error)
			socket.addEventListener("open", () => finish())
			socket.addEventListener("error", () =>
				finish(new Error("Codex websocket handshake failed.")),
			)
			socket.addEventListener("close", () =>
				finish(new Error("Codex websocket closed during handshake.")),
			)
			signal?.addEventListener("abort", abort, { once: true })
			if (socket.readyState === 1) finish()
			if (signal?.aborted) abort()
		})
		this.pendingSocket = undefined
		this.socket = socket
		socket.binaryType = "arraybuffer"
		socket.addEventListener("message", (event) => {
			if (socket !== this.socket) return
			const data = (event as { data: unknown }).data
			const text =
				typeof data === "string"
					? data
					: data instanceof ArrayBuffer || ArrayBuffer.isView(data)
						? new TextDecoder().decode(data)
						: undefined
			if (text === undefined) {
				this.disconnect(new Error("Unsupported websocket message."))
				return
			}
			if (
				new TextEncoder().encode(text).byteLength >
				(this.options.maxBufferedBytes ?? 1024 * 1024)
			) {
				this.disconnect(new Error("Websocket frame exceeds buffer budget."))
				return
			}
			try {
				const frame: unknown = JSON.parse(text)
				if (!isRecord(frame)) throw new Error("Invalid websocket frame.")
				this.active?.onFrame(frame)
			} catch (error) {
				this.disconnect(errorOf(error))
			}
		})
		socket.addEventListener("close", () => {
			if (socket === this.socket)
				this.disconnect(new Error("Websocket closed before completion."))
		})
		socket.addEventListener("error", () => {
			if (socket === this.socket)
				this.disconnect(new Error("Websocket transport error."))
		})
		return socket
	}

	prewarm(accessToken: string): void {
		if (this.warmSent || this.closed) return
		this.warmSent = true
		// Warmup is an exchange, not a fire-and-forget frame: consume its terminal
		// event before another request can own this socket.
		void this.exchange(
			{ stream: true, generate: false },
			accessToken,
			this.identity,
			true,
		)
			.then(async (stream) => {
				const reader = stream.getReader()
				try {
					while (!(await reader.read()).done) {}
				} finally {
					reader.releaseLock()
				}
			})
			.catch(() => undefined)
	}

	streamResponse(
		requestBody: JsonRecord,
		accessToken: string,
		identity = this.identity,
	): Promise<ReadableStream<Uint8Array>> {
		return this.exchange(requestBody, accessToken, identity, false)
	}

	private async exchange(
		requestBody: JsonRecord,
		accessToken: string,
		identity: WebsocketIdentity,
		warm: boolean,
	): Promise<ReadableStream<Uint8Array>> {
		await this.acquire(identity.signal)
		let socket: UndiciWebSocket
		try {
			socket = await this.connect(accessToken, identity.signal)
		} catch (error) {
			this.release()
			throw error
		}
		const encoder = new TextEncoder()
		const input = Array.isArray(requestBody.input)
			? requestBody.input
			: undefined
		const key = `${semanticKey(requestBody)}:${identity.responsesLite === true}`
		const last = this.last
		const reuse =
			!warm &&
			requestBody.previous_response_id === undefined &&
			last &&
			input &&
			key === last.key &&
			input.length >= last.history.length &&
			last.history.every(
				(item, index) => JSON.stringify(item) === JSON.stringify(input[index]),
			)
		const metadata = {
			...(isRecord(requestBody.client_metadata)
				? requestBody.client_metadata
				: {}),
			...pickClientMetadata(identity),
		}
		const frame: JsonRecord = {
			...requestBody,
			type: RESPONSE_CREATE_TYPE,
			stream: true,
			client_metadata: metadata,
		}
		if (reuse) {
			frame.previous_response_id = last.id
			frame.input = input.slice(last.history.length)
		}
		if (!warm) delete frame.generate
		const collector = new ResponseSseCollector()
		let settled = false
		let started = false
		let done = false
		let failure: Error | undefined
		let bytes = 0
		const queue: Uint8Array[] = []
		let wake: (() => void) | undefined
		let resolveStarted: () => void = () => {}
		let rejectStarted: (error: Error) => void = () => {}
		const startPromise = new Promise<void>((resolve, reject) => {
			resolveStarted = resolve
			rejectStarted = reject
		})
		const notify = () => {
			wake?.()
			wake = undefined
		}
		const finish = () => {
			if (settled) return
			settled = true
			if (timer) this.timers.clearTimeout(timer)
			if (idleTimer) this.timers.clearTimeout(idleTimer)
			identity.signal?.removeEventListener("abort", abort)
			this.active = undefined
			this.release()
			notify()
		}
		const fail = (error: Error) => {
			if (settled) return
			failure = error
			done = true
			this.last = undefined
			queue.length = 0
			bytes = 0
			if (!started) rejectStarted(error)
			finish()
		}
		const abort = () =>
			this.disconnect(
				errorOf(
					identity.signal?.reason ?? new DOMException("Aborted", "AbortError"),
				),
			)
		let idleTimer: ReturnType<typeof setTimeout> | undefined
		const resetIdle = () => {
			if (idleTimer) this.timers.clearTimeout(idleTimer)
			// A full downstream queue is backpressure, not upstream silence.
			if (!settled && bytes === 0)
				idleTimer = this.timers.setTimeout(
					() => this.disconnect(new Error("Websocket response idle timeout.")),
					this.options.streamIdleTimeoutMs ?? WS_RESPONSE_TIMEOUT_MS,
				)
		}
		const timer =
			this.options.requestTimeoutMs === undefined
				? undefined
				: this.timers.setTimeout(
						() =>
							this.disconnect(new Error("Websocket total request timeout.")),
						this.options.requestTimeoutMs,
					)
		resetIdle()
		this.active = {
			fail,
			onFrame: (event) => {
				const type = typeof event.type === "string" ? event.type : ""
				resetIdle()
				if (type === "error") {
					this.disconnect(
						parseInferenceError(event, {
							headers: wrappedErrorHeaders(event.headers),
							responseStarted: started,
							now: this.options.now?.(),
						}),
					)
					return
				}
				if (
					!type.startsWith("response.") &&
					type !== "codex.rate_limits" &&
					type !== "codex.response.metadata"
				)
					return
				if (type === "codex.response.metadata") {
					const headers: Record<string, string> = {}
					if (isRecord(event.headers)) {
						for (const [name, value] of Object.entries(event.headers)) {
							if (
								name.toLowerCase() === "x-models-etag" &&
								typeof value === "string" &&
								value.length <= 256 &&
								/^[\x20-\x7e]+$/.test(value)
							)
								headers["x-models-etag"] = value
						}
					}
					if (!headers["x-models-etag"]) return
					event = { type, headers }
				}
				if (type.startsWith("response."))
					collector.accept({ event: type, data: JSON.stringify(event) })
				const chunk = encoder.encode(
					`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`,
				)
				if (
					bytes + chunk.byteLength >
					(this.options.maxBufferedBytes ?? 1024 * 1024)
				) {
					this.disconnect(
						new Error("Websocket response exceeds buffer budget."),
					)
					return
				}
				queue.push(chunk)
				bytes += chunk.byteLength
				resetIdle()
				if (!started) {
					started = true
					resolveStarted()
				}
				if (
					[
						"response.completed",
						"response.failed",
						"response.incomplete",
					].includes(type)
				) {
					const response = collector.finish()
					if (
						!warm &&
						requestBody.previous_response_id === undefined &&
						type === "response.completed" &&
						response.status === "completed" &&
						typeof response.id === "string" &&
						input
					) {
						const history = [
							...input,
							...(Array.isArray(response.output) ? response.output : []),
						]
						this.last =
							encoder.encode(JSON.stringify(history)).byteLength <=
							(this.options.maxBufferedBytes ?? 1024 * 1024)
								? { id: response.id, history: structuredClone(history), key }
								: undefined
					} else this.last = undefined
					queue.push(encoder.encode("data: [DONE]\n\n"))
					done = true
					finish()
				}
				notify()
			},
		}
		identity.signal?.addEventListener("abort", abort, { once: true })
		if (identity.signal?.aborted) abort()
		else
			try {
				socket.send(JSON.stringify(frame))
			} catch (error) {
				this.disconnect(errorOf(error))
			}
		await startPromise
		return new ReadableStream<Uint8Array>(
			{
				async pull(controller) {
					for (;;) {
						const chunk = queue.shift()
						if (chunk) {
							bytes -= chunk.byteLength
							resetIdle()
							controller.enqueue(chunk)
							return
						}
						if (failure) {
							controller.error(failure)
							return
						}
						if (done) {
							controller.close()
							return
						}
						await new Promise<void>((resolve) => {
							wake = resolve
						})
					}
				},
				cancel: () => {
					if (!done) this.disconnect(new Error("Websocket response cancelled."))
					queue.length = 0
					bytes = 0
					done = true
					notify()
				},
			},
			{ highWaterMark: 0 },
		)
	}

	async close(): Promise<void> {
		this.closed = true
		this.lifecycle.abort(new Error("Websocket connection is closed."))
		for (const slot of this.slots.splice(0)) {
			slot.signal?.removeEventListener("abort", slot.abort)
			slot.reject(new Error("Websocket connection is closed."))
		}
		this.disconnect(new Error("Websocket connection is closed."))
	}
}

export type WebsocketConnectionManagerOptions = WebsocketTransportOptions

export class WebsocketConnectionManager {
	private readonly connections = new Map<string, WebsocketConnection>()
	private closed = false
	constructor(
		private readonly options: WebsocketConnectionManagerOptions = {},
	) {}

	connectionFor(
		identity: WebsocketIdentity,
		accessToken: string,
	): WebsocketConnection {
		if (this.closed) throw new Error("Websocket manager is closed.")
		const key = JSON.stringify([
			identity.accountId,
			identity.url,
			identity.isFedRamp === true,
			identity.sessionId ?? identity.installationId,
			accessToken,
		])
		let connection = this.connections.get(key)
		if (!connection) {
			const limit = this.options.maxConnections ?? 64
			if (this.connections.size >= limit) {
				const idle = [...this.connections].find(([, value]) => value.isIdle)
				if (!idle) throw new Error("Websocket connection limit reached.")
				this.connections.delete(idle[0])
				void idle[1].close()
			}
			connection = new WebsocketConnection(identity, this.options)
			this.connections.set(key, connection)
		}
		return connection
	}

	prewarm(identity: WebsocketConnectionIdentity, accessToken: string): void {
		if (!this.closed)
			this.connectionFor(identity, accessToken).prewarm(accessToken)
	}

	async close(): Promise<void> {
		this.closed = true
		await Promise.all(
			[...this.connections.values()].map((connection) => connection.close()),
		)
		this.connections.clear()
	}
}

export const createWebsocketTransport = (
	options: WebsocketTransportOptions = {},
): WebsocketTransport => {
	const manager = new WebsocketConnectionManager(options)
	return {
		fallbackToHttp: true,
		streamResponse: async (body, identity, token) =>
			manager
				.connectionFor(identity, token)
				.streamResponse(body, token, identity),
		prewarm: (identity, token) => manager.prewarm(identity, token),
		close: () => manager.close(),
	}
}
