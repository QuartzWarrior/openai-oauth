import {
	buildCodexUserAgent,
	DEFAULT_CODEX_BASE_URL,
	DEFAULT_CODEX_CLIENT_VERSION,
	DEFAULT_CODEX_ORIGINATOR,
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

const hasHeaderCaseInsensitive = (
	headers: Record<string, string>,
	name: string,
): boolean => {
	const lowered = name.toLowerCase()
	return Object.keys(headers).some((key) => key.toLowerCase() === lowered)
}

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
	/** Test hook: bypass the lazy undici import. */
	webSocketFactory?: WebSocketFactory
}

export type WebsocketConnectionIdentity = {
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
}

export type WebsocketTransport = {
	/** Whether the last failure should fall back to HTTP (always true). */
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
	return { ...headers, ...extraHeaders }
}

const toWebsocketUrl = (baseURL: string | undefined): string => {
	const base = new URL(baseURL ?? DEFAULT_CODEX_BASE_URL)
	base.protocol = base.protocol === "http:" ? "ws:" : "wss:"
	// Codex authenticates the upgrade with headers (add_auth_headers), never a
	// query token — tokens in URLs leak into logs/proxies and mark the client.
	return new URL(
		`${base.pathname.replace(/\/$/, "")}/responses`,
		`${base.protocol}//${base.host}`,
	).toString()
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
	return metadata
}

export class WebsocketConnection {
	private socket: UndiciWebSocket | undefined
	/** Socket currently in handshake (open not yet fired); close() aborts it. */
	private pendingSocket: UndiciWebSocket | undefined
	private connectPromise: Promise<UndiciWebSocket> | undefined
	private readonly identity: WebsocketIdentity
	private readonly options: WebsocketConnectionOptions
	private readonly timers: Timers
	private codexVersion: string | undefined
	private codexVersionPromise: Promise<string> | undefined
	private idleTimer: ReturnType<typeof setTimeout> | undefined
	private lastActivityAt: number
	private closed = false
	/** Monotonic count of completed responses, for single-flight prewarm. */
	private inflightRequests = 0
	private lastResponseInput: unknown[] | undefined
	private lastResponseId: string | undefined

	constructor(
		identity: WebsocketIdentity,
		options: WebsocketConnectionOptions = {},
	) {
		this.identity = identity
		this.options = options
		this.timers = options.timers ?? defaultTimers
		this.lastActivityAt = (options.now ?? Date.now)()
	}

	private now(): number {
		return (this.options.now ?? Date.now)()
	}

	private async resolveCodexVersion(): Promise<string> {
		if (this.codexVersion) {
			return this.codexVersion
		}
		this.codexVersionPromise ??= resolveCodexClientVersion({
			codexVersion: this.options.codexVersion,
			fetchImpl: this.options.fetchImpl ?? globalThis.fetch?.bind(globalThis),
		})
			.then((version: string) => {
				this.codexVersion = version
				return version
			})
			// On registry-fetch failure fall back to the pinned core build version so the
			// handshake UA never disagrees with this account's HTTP data-path version.
			.catch((): string => DEFAULT_CODEX_CLIENT_VERSION)
		return this.codexVersionPromise
	}

	private async connect(accessToken: string): Promise<UndiciWebSocket> {
		if (this.closed) {
			throw new Error("Websocket connection is closed.")
		}
		if (this.socket && this.socket.readyState === 1) {
			return this.socket
		}
		// Assigned synchronously, before any await: concurrent prewarm/stream
		// callers must share the one in-flight handshake. Resolving the codex
		// version (or the undici import) first would leave a window where
		// connectPromise is still undefined and a second caller opens a second
		// socket for the same connection identity.
		this.connectPromise ??= this.open(accessToken).finally(() => {
			this.connectPromise = undefined
		})
		return this.connectPromise
	}

	private async open(accessToken: string): Promise<UndiciWebSocket> {
		const url = toWebsocketUrl(this.options.baseURL)
		const codexVersion = await this.resolveCodexVersion()
		const headers = buildWebsocketUpgradeHeaders(
			this.identity,
			codexVersion,
			this.options.headers,
			this.options.terminalToken,
		)
		// Codex's add_auth_headers on the upgrade: bearer + account id as headers.
		// extraHeaders (per-account overrides) may legitimately replace these.
		if (!hasHeaderCaseInsensitive(headers, "authorization")) {
			headers.Authorization = `Bearer ${accessToken}`
		}
		const factory: WebSocketFactory =
			this.options.webSocketFactory ??
			(async (target, upgradeHeaders) => {
				const undici = await loadUndici()
				if (!undici) {
					throw new Error(
						'The websocket transport requires undici (Node.js >= 20). Omit `transport: "websocket"` or install undici for other runtimes.',
					)
				}
				return new undici.WebSocket(target, { headers: upgradeHeaders })
			})

		const socket = await Promise.resolve(factory(url, headers))
		this.pendingSocket = socket
		try {
			await this.waitForOpen(socket)
		} finally {
			this.pendingSocket = undefined
		}
		if (this.closed) {
			socket.close()
			throw new Error("Websocket connection closed during handshake.")
		}
		this.socket = socket
		this.attachSocketHandlers(socket)
		this.armIdleTimer()
		return socket
	}

	private waitForOpen(socket: UndiciWebSocket): Promise<void> {
		return new Promise((resolve, reject) => {
			const timeout = this.timers.setTimeout(() => {
				reject(new Error("Timed out opening the Codex websocket."))
			}, WS_CONNECT_TIMEOUT_MS)
			socket.addEventListener("open", () => {
				this.timers.clearTimeout(timeout)
				resolve()
			})
			socket.addEventListener("error", () => {
				this.timers.clearTimeout(timeout)
				reject(new Error("Codex websocket handshake failed."))
			})
			socket.addEventListener("close", () => {
				this.timers.clearTimeout(timeout)
				reject(new Error("Codex websocket closed during handshake."))
			})
		})
	}

	private attachSocketHandlers(socket: UndiciWebSocket): void {
		socket.binaryType = "arraybuffer"
		socket.addEventListener("message", (event) => {
			this.lastActivityAt = this.now()
			this.handleMessage(event as { data: unknown; type: string })
		})
		socket.addEventListener("close", () => {
			this.tearDown(socket)
		})
		socket.addEventListener("error", () => {
			this.tearDown(socket)
		})
	}

	private tearDown(socket: UndiciWebSocket | undefined): void {
		if (this.idleTimer) {
			this.timers.clearTimeout(this.idleTimer)
			this.idleTimer = undefined
		}
		if (socket === undefined || socket === this.socket) {
			this.socket = undefined
		}
		try {
			socket?.close()
		} catch {}
	}

	private armIdleTimer(): void {
		if (this.idleTimer) {
			this.timers.clearTimeout(this.idleTimer)
		}
		this.idleTimer = this.timers.setTimeout(() => {
			const idleFor = this.now() - this.lastActivityAt
			if (idleFor >= WS_IDLE_TIMEOUT_MS && this.inflightRequests === 0) {
				this.tearDown(this.socket)
			} else {
				this.armIdleTimer()
			}
		}, WS_IDLE_TIMEOUT_MS)
	}

	private readonly waiters: Array<{
		predicate: (frame: JsonRecord) => boolean
		resolve: (frame: JsonRecord) => void
		reject: (error: Error) => void
		timer: ReturnType<typeof setTimeout>
	}> = []

	private handleMessage(event: { data: unknown }): void {
		let text: string | undefined
		if (typeof event.data === "string") {
			text = event.data
		} else if (event.data instanceof ArrayBuffer) {
			text = new TextDecoder().decode(event.data)
		} else if (ArrayBuffer.isView(event.data)) {
			text = new TextDecoder().decode(event.data)
		}
		if (text === undefined) {
			return
		}
		let frame: JsonRecord
		try {
			const parsed: unknown = JSON.parse(text)
			if (!isRecord(parsed)) {
				return
			}
			frame = parsed
		} catch {
			return
		}
		for (const waiter of [...this.waiters]) {
			if (waiter.predicate(frame)) {
				this.timers.clearTimeout(waiter.timer)
				this.waiters.splice(this.waiters.indexOf(waiter), 1)
				waiter.resolve(frame)
			}
		}
	}

	private awaitFrame(
		predicate: (frame: JsonRecord) => boolean,
		timeoutMs: number,
		label: string,
	): Promise<JsonRecord> {
		return new Promise((resolve, reject) => {
			const timer = this.timers.setTimeout(() => {
				const index = this.waiters.findIndex((waiter) => waiter.timer === timer)
				if (index >= 0) {
					this.waiters.splice(index, 1)
				}
				reject(new Error(`Timed out waiting for ${label} over websocket.`))
			}, timeoutMs)
			this.waiters.push({ predicate, resolve, reject, timer })
		})
	}

	/**
	 * Single-flight prewarm: opens the socket and sends one `response.create`
	 * with `generate: false` so the per-connection model context warms without
	 * spending a turn. Concurrent prewarms share the same handshake; the warm
	 * frame is sent exactly once for the whole connection lifetime.
	 */
	private warmSent = false

	prewarm(accessToken: string): void {
		if (this.closed) {
			return
		}
		// Claim the warm frame synchronously: concurrent prewarm calls (or a
		// prewarm racing a request's own warm-up) must not each send a
		// `generate: false` frame.
		const shouldWarm = !this.warmSent
		this.warmSent = true
		void this.connect(accessToken)
			.then((socket) => {
				if (!shouldWarm || this.closed || socket.readyState !== 1) {
					return
				}
				const lastInput = this.lastResponseInput
				const baseBody = lastInput
					? { input: lastInput, stream: true }
					: { stream: true }
				socket.send(
					JSON.stringify({
						...baseBody,
						type: RESPONSE_CREATE_TYPE,
						client_metadata: pickClientMetadata(this.identity),
						generate: false,
					}),
				)
			})
			.catch(() => this.tearDown(this.socket))
	}

	/**
	 * Runs one streamed response over the shared socket. Reuses the previous
	 * turn's input via incremental `input_text.delta` frames when the new input
	 * extends it (same conversation on the same account); otherwise a full
	 * `response.create` is sent. Resolves with the mapped SSE byte stream.
	 */
	async streamResponse(
		requestBody: JsonRecord,
		accessToken: string,
	): Promise<ReadableStream<Uint8Array>> {
		if (this.closed) {
			throw new Error("Websocket connection is closed.")
		}
		const socket = await this.connect(accessToken)
		if (socket.readyState !== 1) {
			throw new Error("Codex websocket is not open.")
		}

		this.inflightRequests += 1
		const encoder = new TextEncoder()
		const responseIdPromise = this.awaitFrame(
			(frame) =>
				frame.type === "response.created" ||
				frame.type === "response.completed",
			WS_RESPONSE_TIMEOUT_MS,
			"a response id",
		)

		const input = Array.isArray(requestBody.input)
			? (requestBody.input as unknown[])
			: undefined
		const reuseDelta =
			input !== undefined &&
			this.lastResponseInput !== undefined &&
			input.length >= this.lastResponseInput.length &&
			this.lastResponseInput.every(
				(item, index) => JSON.stringify(item) === JSON.stringify(input[index]),
			)

		// Codex sends one ResponsesWsRequest::ResponseCreate frame per turn and
		// nothing else (no incremental delta frames): the full request fields plus
		// `prompt_cache_key`, `previous_response_id` chained to the last response,
		// and when the new input is a strict extension of the previous, only the
		// incremental input items. Extras a real codex client_metadata carries
		// (trace/turn ids) are absent here just as codex omits them when unset.
		const frame: JsonRecord = {
			...requestBody,
			type: RESPONSE_CREATE_TYPE,
			client_metadata: pickClientMetadata(this.identity),
			stream: true,
		}
		if (this.lastResponseId !== undefined) {
			frame.previous_response_id = this.lastResponseId
		}
		if (
			reuseDelta &&
			input !== undefined &&
			this.lastResponseInput !== undefined
		) {
			frame.input = input.slice(this.lastResponseInput.length)
		}
		// `generate` is only ever set on the single prewarm frame (false); turn
		// frames leave it unset, matching codex (Some(false) iff warmup).
		socket.send(JSON.stringify(frame))
		if (input !== undefined) {
			this.lastResponseInput = input
		}

		const sseQueue: Uint8Array[] = []
		let streamError: Error | undefined
		let streamDone = false
		let wakeConsumer: (() => void) | undefined
		const notify = (): void => {
			wakeConsumer?.()
			wakeConsumer = undefined
		}

		const streamWaiter = {
			predicate: (frame: JsonRecord): boolean => {
				const frameType = typeof frame.type === "string" ? frame.type : ""
				if (!frameType.startsWith("response.")) {
					return false
				}
				const payload: JsonRecord = isRecord(frame.response)
					? frame.response
					: frame
				sseQueue.push(
					encoder.encode(
						`event: ${frameType}\ndata: ${JSON.stringify(payload)}\n\n`,
					),
				)
				if (
					frameType === "response.completed" ||
					frameType === "response.failed" ||
					frameType === "response.incomplete"
				) {
					const id =
						typeof payload.id === "string"
							? payload.id
							: typeof payload.response_id === "string"
								? payload.response_id
								: undefined
					if (id !== undefined) {
						this.lastResponseId = id
					}
					sseQueue.push(encoder.encode("data: [DONE]\n\n"))
					streamDone = true
				}
				notify()
				return false
			},
			resolve: () => {},
			reject: () => {},
			timer: this.timers.setTimeout(() => {
				streamError = new Error("Timed out streaming the websocket response.")
				streamDone = true
				notify()
			}, WS_RESPONSE_TIMEOUT_MS),
		}
		this.waiters.push(streamWaiter)

		const cleanup = (): void => {
			this.timers.clearTimeout(streamWaiter.timer)
			const index = this.waiters.indexOf(streamWaiter)
			if (index >= 0) {
				this.waiters.splice(index, 1)
			}
			this.inflightRequests = Math.max(0, this.inflightRequests - 1)
			this.lastActivityAt = this.now()
		}

		const stream = new ReadableStream<Uint8Array>({
			pull: async (controller) => {
				for (;;) {
					const chunk = sseQueue.shift()
					if (chunk !== undefined) {
						controller.enqueue(chunk)
						return
					}
					if (streamError !== undefined) {
						cleanup()
						controller.error(streamError)
						return
					}
					if (streamDone) {
						cleanup()
						controller.close()
						return
					}
					await new Promise<void>((resolve) => {
						wakeConsumer = resolve
					})
				}
			},
			cancel: () => {
				cleanup()
				notify()
			},
		})

		try {
			const created = await responseIdPromise
			void created
		} catch (error) {
			cleanup()
			throw error instanceof Error
				? error
				: new Error("Codex websocket response failed to start.")
		}

		return stream
	}

	async close(): Promise<void> {
		this.closed = true
		// Abort an in-flight handshake: the "close" listener registered by
		// waitForOpen rejects its promise, so streamResponse surfaces the close
		// instead of hanging until the handshake timeout.
		this.pendingSocket?.close()
		this.tearDown(this.socket)
	}
}

export type WebsocketConnectionManagerOptions = WebsocketTransportOptions & {
	headers?: Record<string, string>
}

/**
 * Owns one websocket per (account, access token) so every account in the pool
 * keeps an isolated connection, handshake identity, and idle lifecycle.
 */
export class WebsocketConnectionManager {
	private readonly connections = new Map<string, WebsocketConnection>()
	private readonly options: WebsocketConnectionManagerOptions
	/** Set on close(): a closed manager never opens a new connection again. */
	private managerClosed = false
	constructor(options: WebsocketConnectionManagerOptions = {}) {
		this.options = options
	}

	private keyFor(identity: WebsocketConnectionIdentity, accessToken: string) {
		// Per-conversation socket: Codex's session-id is the thread id, and one
		// connection serves one conversation lifecycle — a single socket claiming
		// the same session-id across disjoint conversations is a pool-only
		// pattern. The token slice rebinds a conversation's socket on refresh.
		return `${identity.accountId}:${identity.sessionId ?? identity.installationId}:${accessToken.slice(-24)}`
	}

	connectionFor(
		identity: WebsocketIdentity,
		accessToken: string,
	): WebsocketConnection {
		const key = this.keyFor(identity, accessToken)
		if (!this.managerClosed) {
			let connection = this.connections.get(key)
			if (connection === undefined) {
				connection = new WebsocketConnection(identity, this.options)
				// Keep at most one live socket per account besides the new one:
				// e.g. a prior conversation's socket past its turn, or a prewarm
				// keyed to an older access token.
				let kept = false
				for (const [existingKey, existing] of this.connections) {
					if (!existingKey.startsWith(`${identity.accountId}:`)) {
						continue
					}
					if (!kept) {
						kept = true
						continue
					}
					this.connections.delete(existingKey)
					void existing.close()
				}
				this.connections.set(key, connection)
			}
			return connection
		}
		// After close() there is no connection to hand out; a session-level
		// already-closed marker preserves the "connection is closed" contract
		// for late streamResponse callers instead of silently reconnecting.
		return this.closedConnection(identity)
	}

	closedConnection(identity: WebsocketConnectionIdentity): WebsocketConnection {
		const connection = new WebsocketConnection(
			{
				accountId: identity.accountId,
				installationId: identity.installationId,
				sessionId: identity.sessionId,
			},
			this.options,
		)
		void connection.close()
		return connection
	}

	prewarm(identity: WebsocketConnectionIdentity, accessToken: string): void {
		if (this.managerClosed) {
			return
		}
		this.connectionFor(identity, accessToken).prewarm(accessToken)
	}

	async close(): Promise<void> {
		this.managerClosed = true
		const closing = [...this.connections.values()].map((connection) =>
			connection.close(),
		)
		this.connections.clear()
		await Promise.all(closing)
	}
}

/**
 * Creates the per-account websocket transport. Any failure (handshake,
 * timeout, mid-stream error) is surfaced as `fallbackToHttp` so callers replay
 * the request on the HTTP path.
 */
export const createWebsocketTransport = (
	options: WebsocketTransportOptions = {},
): WebsocketTransport => {
	const manager = new WebsocketConnectionManager(options)
	return {
		fallbackToHttp: true,
		streamResponse: async (requestBody, identity, accessToken) => {
			const connection = manager.connectionFor(
				{
					accountId: identity.accountId,
					installationId: identity.installationId,
					sessionId: identity.sessionId,
					threadId: identity.threadId,
				},
				accessToken,
			)
			return connection.streamResponse(requestBody, accessToken)
		},
		prewarm: (identity, accessToken) => {
			manager.prewarm(identity, accessToken)
		},
		close: () => manager.close(),
	}
}
