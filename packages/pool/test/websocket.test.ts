import { describe, expect, it } from "vitest"
import {
	buildWebsocketUpgradeHeaders,
	createWebsocketTransport,
	type WebsocketConnectionOptions,
	type WebsocketIdentity,
	type WebsocketTransport,
} from "../src/websocket-transport.js"

const TEST_CODEX_VERSION = "0.154.0"
const ACCESS_TOKEN = "test-access-token"

type Listener = (event: unknown) => void

/**
 * Deterministic in-test clock: real microtasks, controllable timer ticks.
 * The transport accepts `now`/`timers` injection, so tests never touch global
 * fake timers (which break internal promise/timer interleaving).
 */
const createVirtualClock = () => {
	type TimerEntry = { at: number; fire: () => void }
	type IntervalEntry = { every: number; fire: () => void; next: number }
	const timeouts = new Set<TimerEntry>()
	const intervals = new Set<IntervalEntry>()
	let nowValue = 0

	const setTimeoutMock = ((fn: () => void, ms = 0) => {
		const entry: TimerEntry = { at: nowValue + ms, fire: fn }
		timeouts.add(entry)
		return entry
	}) as unknown as typeof setTimeout
	const clearTimeoutMock = ((entry: TimerEntry) => {
		timeouts.delete(entry)
	}) as unknown as typeof clearTimeout
	const setIntervalMock = ((fn: () => void, ms = 0) => {
		const entry: IntervalEntry = { every: ms, fire: fn, next: nowValue + ms }
		intervals.add(entry)
		return entry
	}) as unknown as typeof setInterval
	const clearIntervalMock = ((entry: IntervalEntry) => {
		intervals.delete(entry)
	}) as unknown as typeof clearInterval

	const flushMicrotasks = async (): Promise<void> => {
		for (let i = 0; i < 32; i++) {
			await Promise.resolve()
		}
	}

	const tick = async (ms: number): Promise<void> => {
		const target = nowValue + ms
		for (;;) {
			await flushMicrotasks()
			const dueTimeout = [...timeouts]
				.filter((entry) => entry.at <= target)
				.sort((a, b) => a.at - b.at)[0]
			const dueInterval = [...intervals]
				.filter((entry) => entry.next <= target)
				.sort((a, b) => a.next - b.next)[0]
			const timeoutAt = dueTimeout?.at ?? Number.POSITIVE_INFINITY
			const intervalAt = dueInterval?.next ?? Number.POSITIVE_INFINITY
			if (
				timeoutAt === Number.POSITIVE_INFINITY &&
				intervalAt === Number.POSITIVE_INFINITY
			) {
				break
			}
			if (timeoutAt <= intervalAt && dueTimeout) {
				nowValue = dueTimeout.at
				timeouts.delete(dueTimeout)
				dueTimeout.fire()
			} else if (dueInterval) {
				nowValue = dueInterval.next
				dueInterval.next += dueInterval.every
				dueInterval.fire()
			}
		}
		nowValue = target
	}

	return {
		now: () => nowValue,
		timers: {
			setTimeout: setTimeoutMock,
			clearTimeout: clearTimeoutMock,
			setInterval: setIntervalMock,
			clearInterval: clearIntervalMock,
		},
		tick,
	}
}

type Clock = ReturnType<typeof createVirtualClock>

/**
 * Scriptable stand-in for undici's WebSocket. Records every sent frame and lets
 * each test drive open/message/error/close events manually.
 */
class FakeWebSocket {
	static instances: FakeWebSocket[] = []

	binaryType = "blob"
	readyState = 0
	readonly url: string
	readonly headers: Record<string, string>
	readonly sent: string[] = []
	closeCalls: Array<{ code?: number; reason?: string }> = []
	private readonly listeners = new Map<string, Listener[]>()

	constructor(url: string, headers: Record<string, string>) {
		this.url = url
		this.headers = headers
		FakeWebSocket.instances.push(this)
	}

	send(data: string | ArrayBufferLike): void {
		this.sent.push(
			typeof data === "string" ? data : new TextDecoder().decode(data),
		)
	}

	close(code?: number, reason?: string): void {
		this.closeCalls.push({ code, reason })
		this.readyState = 3
	}

	addEventListener(type: string, listener: Listener): void {
		const list = this.listeners.get(type) ?? []
		list.push(listener)
		this.listeners.set(type, list)
	}

	emit(type: string, event: unknown = {}): void {
		for (const listener of [...(this.listeners.get(type) ?? [])]) {
			listener(event)
		}
	}

	open(): void {
		this.readyState = 1
		this.emit("open")
	}

	serverSend(frame: Record<string, unknown>): void {
		this.emit("message", { data: JSON.stringify(frame), type: "message" })
	}

	sentFrames(): Array<Record<string, unknown>> {
		return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>)
	}

	framesOfType(type: string): Array<Record<string, unknown>> {
		return this.sentFrames().filter((frame) => frame.type === type)
	}
}

const makeFactory =
	() =>
	(url: string, headers: Record<string, string>): FakeWebSocket =>
		new FakeWebSocket(url, headers)

const makeTestTransport = (
	clock: Clock,
	options: Omit<
		WebsocketConnectionOptions,
		"now" | "timers" | "webSocketFactory" | "codexVersion"
	> = {},
): WebsocketTransport =>
	createWebsocketTransport({
		codexVersion: TEST_CODEX_VERSION,
		webSocketFactory: makeFactory(),
		now: clock.now,
		timers: clock.timers,
		...options,
	})

const identity: WebsocketIdentity = {
	accountId: "acct-installation",
	installationId: "install-1234",
	sessionId: "thread-5678",
}

const readStreamText = async (
	stream: ReadableStream<Uint8Array>,
): Promise<string> => {
	const reader = stream.getReader()
	const decoder = new TextDecoder()
	let text = ""
	for (;;) {
		const { value, done } = await reader.read()
		if (done) {
			return text
		}
		text += decoder.decode(value, { stream: true })
	}
}

const completeResponse = (socket: FakeWebSocket, id = "resp_1"): void => {
	socket.serverSend({ type: "response.created", response: { id } })
	socket.serverSend({ type: "response.output_text.delta", delta: "hello" })
	socket.serverSend({
		type: "response.completed",
		response: { id, status: "completed" },
	})
}

/**
 * Every await that depends on transport-internal async work is preceded by a
 * full virtual-clock advance (`tick(0)` after each event emission). Under
 * vitest an emit-then-immediately-await sequence does not reliably flush the
 * transport's promise chain; ticking the clock drains pending jobs first.
 */
const roundTrip = async (
	clock: Clock,
	transport: WebsocketTransport,
	requestBody: Record<string, unknown>,
	who: WebsocketIdentity = identity,
	token: string = ACCESS_TOKEN,
): Promise<{ socket: FakeWebSocket; text: string }> => {
	const streamPromise = transport.streamResponse(requestBody, who, token)
	streamPromise.catch(() => {})
	await clock.tick(0)
	const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
	socket.open()
	await clock.tick(0)
	completeResponse(socket)
	await clock.tick(0)
	const stream = await streamPromise
	const text = await readStreamText(stream)
	return { socket, text }
}

describe("websocket transport", () => {
	it("buildWebsocketUpgradeHeaders matches the codex handshake header set", () => {
		const headers = buildWebsocketUpgradeHeaders(identity, TEST_CODEX_VERSION)
		expect(headers).toEqual({
			originator: "codex_cli_rs",
			"User-Agent": `codex_cli_rs/${TEST_CODEX_VERSION} (Linux 6.8.0-79-generic; x86_64) unknown`,
			// The built-in provider's static version header is merged into the ws
			// handshake (responses_websocket.rs:495) — same value as the UA segment.
			version: TEST_CODEX_VERSION,
			"OpenAI-Beta": "responses_websockets=2026-02-06",
			"chatgpt-account-id": "acct-installation",
			"session-id": "thread-5678",
			"thread-id": "thread-5678",
			"x-client-request-id": "thread-5678",
		})
		expect(headers).not.toHaveProperty("Origin")
	})

	it("falls back to the installation id when no session id is set", () => {
		const headers = buildWebsocketUpgradeHeaders(
			{ accountId: "a", installationId: "install-only" },
			TEST_CODEX_VERSION,
		)
		expect(headers["session-id"]).toBe("install-only")
	})

	it("lets per-account header overrides win", () => {
		const headers = buildWebsocketUpgradeHeaders(identity, TEST_CODEX_VERSION, {
			Origin: "https://example.test",
			"x-extra": "1",
		})
		// Default never sends Origin; an explicit per-account override may add it.
		expect(headers.Origin).toBe("https://example.test")
		expect(headers["x-extra"]).toBe("1")
		expect(headers["OpenAI-Beta"]).toBe("responses_websockets=2026-02-06")
	})

	it("connects to the ws responses endpoint with header auth (no query token)", async () => {
		FakeWebSocket.instances = []
		const clock = createVirtualClock()
		const transport = makeTestTransport(clock, {
			baseURL: "https://chatgpt.com/backend-api/codex",
		})
		const { socket } = await roundTrip(clock, transport, {
			model: "gpt-5",
			input: [],
		})
		expect(socket.url).toBe("wss://chatgpt.com/backend-api/codex/responses")
		expect(socket.url).not.toContain("access_token")
		expect(socket.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`)
		expect(socket.headers["OpenAI-Beta"]).toBe(
			"responses_websockets=2026-02-06",
		)
		expect(socket.headers.originator).toBe("codex_cli_rs")
		expect(socket.headers["thread-id"]).toBe("thread-5678")
		await transport.close()
	})

	it("derives a ws (not wss) URL from an http base URL", async () => {
		FakeWebSocket.instances = []
		const clock = createVirtualClock()
		const transport = makeTestTransport(clock, {
			baseURL: "http://localhost:8787/api",
		})
		const { socket } = await roundTrip(clock, transport, { model: "gpt-5" })
		expect(socket.url).toBe("ws://localhost:8787/api/responses")
		expect(socket.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`)
		await transport.close()
	})

	it("rejects when the handshake fails so the caller falls back to HTTP", async () => {
		FakeWebSocket.instances = []
		const clock = createVirtualClock()
		const transport = makeTestTransport(clock)
		const streamPromise = transport.streamResponse(
			{ model: "gpt-5" },
			identity,
			ACCESS_TOKEN,
		)
		const assertion = expect(streamPromise).rejects.toThrow(/handshake failed/)
		await clock.tick(0)
		FakeWebSocket.instances[0].emit("error")
		await assertion
		await transport.close()
	})

	it("sends a full response.create with codex client metadata and stream: true", async () => {
		FakeWebSocket.instances = []
		const clock = createVirtualClock()
		const transport = makeTestTransport(clock)
		const streamPromise = transport.streamResponse(
			{ model: "gpt-5", input: [{ type: "message", content: "hi" }] },
			identity,
			ACCESS_TOKEN,
		)
		await clock.tick(0)
		const socket = FakeWebSocket.instances[0]
		socket.open()
		await clock.tick(0)
		const created = socket.framesOfType("response.create")
		expect(created).toHaveLength(1)
		expect(created[0]).toMatchObject({
			model: "gpt-5",
			stream: true,
			client_metadata: {
				"x-codex-installation-id": "install-1234",
				session_id: "thread-5678",
				thread_id: "thread-5678",
			},
		})
		completeResponse(socket)
		const stream = await streamPromise
		await readStreamText(stream)
		await transport.close()
	})

	it("maps response frames to SSE lines with a [DONE] terminator", async () => {
		FakeWebSocket.instances = []
		const clock = createVirtualClock()
		const transport = makeTestTransport(clock)
		const { text } = await roundTrip(clock, transport, { model: "gpt-5" })
		expect(text).toContain("event: response.created\n")
		expect(text).toContain('data: {"id":"resp_1"}')
		expect(text).toContain("event: response.output_text.delta\n")
		expect(text).toContain("event: response.completed\n")
		expect(text).toContain('data: {"id":"resp_1","status":"completed"}')
		expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true)
		await transport.close()
	})

	it("sends ONE response.create with only the new input + previous_response_id when input extends the previous turn", async () => {
		FakeWebSocket.instances = []
		const clock = createVirtualClock()
		const transport = makeTestTransport(clock)
		const first = [{ role: "user", content: "one" }]
		const { socket } = await roundTrip(clock, transport, {
			model: "gpt-5",
			input: first,
		})
		expect(socket.framesOfType("response.create")).toHaveLength(1)

		await roundTrip(clock, transport, {
			model: "gpt-5",
			input: [...first, { role: "assistant", content: "two" }],
		})

		// codex has no input_text.delta or incremental:true frame — one
		// response.create per turn carrying the sliced incremental input and the
		// previous response id to chain the turn.
		expect(socket.framesOfType("input_text.delta")).toHaveLength(0)
		const creates = socket.framesOfType("response.create")
		expect(creates).toHaveLength(2)
		expect(creates[1]).not.toHaveProperty("incremental")
		expect(creates[1]).toMatchObject({
			input: [{ role: "assistant", content: "two" }],
			stream: true,
			previous_response_id: expect.any(String),
		})
		await transport.close()
	})

	it("sends a full response.create again when the new input diverges", async () => {
		FakeWebSocket.instances = []
		const clock = createVirtualClock()
		const transport = makeTestTransport(clock)
		const { socket } = await roundTrip(clock, transport, {
			model: "gpt-5",
			input: [{ role: "user", content: "one" }],
		})
		await roundTrip(clock, transport, {
			model: "gpt-5",
			input: [{ role: "user", content: "other" }],
		})

		const creates = socket.framesOfType("response.create")
		expect(creates).toHaveLength(2)
		expect(creates[1]).toMatchObject({
			input: [{ role: "user", content: "other" }],
			stream: true,
			previous_response_id: expect.any(String),
		})
		expect(socket.framesOfType("input_text.delta")).toHaveLength(0)
		await transport.close()
	})

	it("sends a single generate:false response.create per prewarmed connection", async () => {
		FakeWebSocket.instances = []
		const clock = createVirtualClock()
		const transport = makeTestTransport(clock)
		transport.prewarm(identity, ACCESS_TOKEN)
		transport.prewarm(identity, ACCESS_TOKEN)
		await clock.tick(0)
		expect(FakeWebSocket.instances).toHaveLength(1)
		const socket = FakeWebSocket.instances[0]
		socket.open()
		await clock.tick(0)
		const warms = socket
			.framesOfType("response.create")
			.filter((frame) => frame.generate === false)
		expect(warms).toHaveLength(1)
		// client_metadata always carries codex's window id (non-optional there),
		// defaulting to "<thread_id>:0" when no explicit window is pinned.
		expect(warms[0].client_metadata).toEqual({
			"x-codex-installation-id": "install-1234",
			session_id: "thread-5678",
			thread_id: "thread-5678",
			"x-codex-window-id": "thread-5678:0",
		})
		await transport.close()
	})

	it("never initiates any ping (codex: tungstenite auto-answers server pings, sends none)", async () => {
		FakeWebSocket.instances = []
		const clock = createVirtualClock()
		const transport = makeTestTransport(clock)
		transport.prewarm(identity, ACCESS_TOKEN)
		await clock.tick(0)
		const socket = FakeWebSocket.instances[0]
		// Spy on the undici protocol-ping surface: codex never calls it.
		const pings: unknown[] = []
		;(socket as unknown as { ping: () => void }).ping = () => {
			pings.push(null)
		}
		socket.open()
		await clock.tick(0)

		// Run past the idle timeout: no app-level ping frame and no protocol ping —
		// codex sends neither, relying on the server to drop dead connections.
		await clock.tick(61_000)
		expect(socket.framesOfType("ping")).toHaveLength(0)
		expect(pings).toHaveLength(0)
		await transport.close()
	})

	it("closes an idle connection after the idle timeout", async () => {
		FakeWebSocket.instances = []
		const clock = createVirtualClock()
		const transport = makeTestTransport(clock)
		transport.prewarm(identity, ACCESS_TOKEN)
		await clock.tick(0)
		const socket = FakeWebSocket.instances[0]
		socket.open()
		await clock.tick(0)
		// Past the idle window with a completed (non-inflight) stream: teardown.
		await clock.tick(61_000)
		expect(socket.closeCalls.length).toBeGreaterThanOrEqual(1)
		await transport.close()
	})

	it("keeps one connection per (account, token) pair", async () => {
		FakeWebSocket.instances = []
		const clock = createVirtualClock()
		const transport = makeTestTransport(clock)
		const otherIdentity: WebsocketIdentity = {
			accountId: "acct-two",
			installationId: "install-two",
		}
		transport.prewarm(identity, ACCESS_TOKEN)
		transport.prewarm(otherIdentity, "another-token")
		await clock.tick(0)
		expect(FakeWebSocket.instances).toHaveLength(2)
		expect(FakeWebSocket.instances[0].headers["chatgpt-account-id"]).toBe(
			"acct-installation",
		)
		expect(FakeWebSocket.instances[1].headers["chatgpt-account-id"]).toBe(
			"acct-two",
		)
		expect(FakeWebSocket.instances[0].headers.Authorization).toBe(
			`Bearer ${ACCESS_TOKEN}`,
		)
		expect(FakeWebSocket.instances[1].headers.Authorization).toBe(
			"Bearer another-token",
		)
		expect(FakeWebSocket.instances[0].url).not.toContain("access_token")
		await transport.close()
	})

	/**
	 * Resolves when `promise` settles, advancing the virtual clock until it does.
	 * Post-event promise chains under vitest occasionally fail to flush; driving
	 * the clock guarantees progress (and fires internal timeouts on a real stall).
	 */
	const settle = async <T>(clock: Clock, promise: Promise<T>): Promise<T> => {
		for (;;) {
			let settled = false
			void promise.then(
				() => {
					settled = true
				},
				() => {
					settled = true
				},
			)
			await clock.tick(0)
			if (settled) {
				return promise
			}
			await clock.tick(1000)
			if (settled) {
				return promise
			}
			await clock.tick(399_000)
			// After the full 300s stream/handshake window, return the promise as-is:
			// if it still has not settled it is now guaranteed to have rejected via
			// an internal timeout.
			return promise
		}
	}

	it("close() shuts every connection and blocks further streams", async () => {
		FakeWebSocket.instances = []
		const clock = createVirtualClock()
		const transport = makeTestTransport(clock)
		// Open the connection for real first: a completed prewarm means "socket
		// open". (A prewarm left mid-handshake is served by the abort test below.)
		transport.prewarm(identity, ACCESS_TOKEN)
		await clock.tick(0)
		FakeWebSocket.instances[0].open()
		await clock.tick(0)
		await transport.close()
		expect(FakeWebSocket.instances[0].closeCalls.length).toBeGreaterThanOrEqual(
			1,
		)
		await expect(
			settle(
				clock,
				transport.streamResponse({ model: "gpt-5" }, identity, ACCESS_TOKEN),
			),
		).rejects.toThrow(/closed/)
	})

	it("close() aborts an in-flight handshake instead of hanging", async () => {
		FakeWebSocket.instances = []
		const clock = createVirtualClock()
		const transport = makeTestTransport(clock)
		transport.prewarm(identity, ACCESS_TOKEN)
		await clock.tick(0)
		// Socket never fires "open": close() must abort the pending handshake
		// rather than leave streamResponse waiting on the connect timeout.
		await transport.close()
		expect(FakeWebSocket.instances[0].closeCalls.length).toBeGreaterThanOrEqual(
			1,
		)
		await expect(
			settle(
				clock,
				transport.streamResponse({ model: "gpt-5" }, identity, ACCESS_TOKEN),
			),
		).rejects.toThrow(/closed/)
	})
})
