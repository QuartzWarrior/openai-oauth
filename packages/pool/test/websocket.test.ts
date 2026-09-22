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
		expect(text).toContain(
			'data: {"type":"response.created","response":{"id":"resp_1"}}',
		)
		expect(text).toContain("event: response.output_text.delta\n")
		expect(text).toContain("event: response.completed\n")
		expect(text).toContain(
			'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}',
		)
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
		completeResponse(socket)
		await clock.tick(0)
		// An acknowledged warmup releases the exchange before the idle timeout.
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

describe("websocket correctness regressions", () => {
	it("uses trusted routing metadata rather than caller headers", () => {
		const headers = buildWebsocketUpgradeHeaders(
			{ ...identity, isFedRamp: true },
			TEST_CODEX_VERSION,
			{
				"ChatGPT-Account-ID": "wrong",
				"X-OpenAI-FedRAMP": "false",
			},
		)
		expect(new Headers(headers).get("chatgpt-account-id")).toBe(
			identity.accountId,
		)
		expect(new Headers(headers).get("x-openai-fedramp")).toBe("true")
		expect(
			new Headers(
				buildWebsocketUpgradeHeaders(identity, TEST_CODEX_VERSION, {
					"X-OpenAI-FedRAMP": "true",
				}),
			).has("x-openai-fedramp"),
		).toBe(false)
	})

	it("preserves current turn/window options on a reused connection", async () => {
		FakeWebSocket.instances = []
		const clock = createVirtualClock()
		const transport = makeTestTransport(clock)
		const first = await roundTrip(
			clock,
			transport,
			{ model: "gpt-5" },
			{ ...identity, turnId: "turn-1", windowId: "window-1" },
		)
		await roundTrip(
			clock,
			transport,
			{ model: "gpt-5" },
			{
				...identity,
				turnId: "turn-2",
				windowId: "window-2",
				turnState: "sticky",
			},
		)
		expect(
			first.socket.framesOfType("response.create")[1]?.client_metadata,
		).toMatchObject({
			turn_id: "turn-2",
			"x-codex-window-id": "window-2",
			"x-codex-turn-state": "sticky",
		})
		await transport.close()
	})

	it("serializes whole exchanges and does not broadcast events across callers", async () => {
		FakeWebSocket.instances = []
		const clock = createVirtualClock()
		const transport = makeTestTransport(clock)
		const first = transport.streamResponse(
			{ model: "gpt-5", input: [] },
			identity,
			ACCESS_TOKEN,
		)
		const second = transport.streamResponse(
			{ model: "gpt-5", input: [] },
			identity,
			ACCESS_TOKEN,
		)
		await clock.tick(0)
		const socket = FakeWebSocket.instances[0] as FakeWebSocket
		socket.open()
		await clock.tick(0)
		expect(socket.framesOfType("response.create")).toHaveLength(1)
		completeResponse(socket, "first")
		await clock.tick(0)
		expect(socket.framesOfType("response.create")).toHaveLength(2)
		completeResponse(socket, "second")
		expect(await readStreamText(await first)).toContain('"id":"first"')
		const secondText = await readStreamText(await second)
		expect(secondText).toContain('"id":"second"')
		expect(secondText).not.toContain('"id":"first"')
		await transport.close()
	})

	it("waits for prewarm completion before sending a turn", async () => {
		FakeWebSocket.instances = []
		const clock = createVirtualClock()
		const transport = makeTestTransport(clock)
		transport.prewarm(identity, ACCESS_TOKEN)
		const pending = transport.streamResponse(
			{ model: "gpt-5" },
			identity,
			ACCESS_TOKEN,
		)
		await clock.tick(0)
		const socket = FakeWebSocket.instances[0] as FakeWebSocket
		socket.open()
		await clock.tick(0)
		expect(socket.framesOfType("response.create")).toHaveLength(1)
		completeResponse(socket, "warm")
		await clock.tick(0)
		expect(socket.framesOfType("response.create")).toHaveLength(2)
		completeResponse(socket, "real")
		const text = await readStreamText(await pending)
		expect(text).not.toContain('"id":"warm"')
		await transport.close()
	})

	it("rejects top-level errors before response.created immediately", async () => {
		FakeWebSocket.instances = []
		const clock = createVirtualClock()
		const transport = makeTestTransport(clock)
		const pending = transport.streamResponse(
			{ model: "gpt-5" },
			identity,
			ACCESS_TOKEN,
		)
		const assertion = expect(pending).rejects.toThrow(
			/reported an error \(overloaded\)/,
		)
		await clock.tick(0)
		const socket = FakeWebSocket.instances[0] as FakeWebSocket
		socket.open()
		await clock.tick(0)
		socket.serverSend({ type: "error", error: { code: "overloaded" } })
		await assertion
		await transport.close()
	})

	it("settles an active stream and queued request on close", async () => {
		FakeWebSocket.instances = []
		const clock = createVirtualClock()
		const transport = makeTestTransport(clock)
		const pending = transport.streamResponse(
			{ model: "gpt-5" },
			identity,
			ACCESS_TOKEN,
		)
		await clock.tick(0)
		const socket = FakeWebSocket.instances[0] as FakeWebSocket
		socket.open()
		await clock.tick(0)
		socket.serverSend({ type: "response.created", response: { id: "active" } })
		const stream = await pending
		const reading = readStreamText(stream)
		const readAssert = expect(reading).rejects.toThrow(/closed/)
		const queued = transport.streamResponse(
			{ model: "gpt-5" },
			identity,
			ACCESS_TOKEN,
		)
		const queuedAssert = expect(queued).rejects.toThrow(/closed/)
		await transport.close()
		await Promise.all([readAssert, queuedAssert])
	})

	it("supports abort before handshake and while waiting for socket ownership", async () => {
		FakeWebSocket.instances = []
		const clock = createVirtualClock()
		const transport = makeTestTransport(clock)
		const abort = new AbortController()
		const first = transport.streamResponse(
			{ model: "gpt-5" },
			{ ...identity, signal: abort.signal },
			ACCESS_TOKEN,
		)
		const assertion = expect(first).rejects.toThrow()
		await clock.tick(0)
		abort.abort()
		await assertion
		await transport.close()
	})

	it("rejects a slow consumer when the bounded websocket queue fills", async () => {
		FakeWebSocket.instances = []
		const clock = createVirtualClock()
		const transport = makeTestTransport(clock, { maxBufferedBytes: 250 })
		const pending = transport.streamResponse(
			{ model: "gpt-5" },
			identity,
			ACCESS_TOKEN,
		)
		await clock.tick(0)
		const socket = FakeWebSocket.instances[0] as FakeWebSocket
		socket.open()
		await clock.tick(0)
		socket.serverSend({ type: "response.created", response: { id: "active" } })
		const stream = await pending
		for (let i = 0; i < 4; i++)
			socket.serverSend({
				type: "response.output_text.delta",
				delta: "x".repeat(100),
			})
		await expect(readStreamText(stream)).rejects.toThrow(/buffer budget/)
		await transport.close()
	})

	it("never reuses a predecessor when request semantics change", async () => {
		FakeWebSocket.instances = []
		const clock = createVirtualClock()
		const transport = makeTestTransport(clock)
		const { socket } = await roundTrip(clock, transport, {
			model: "gpt-5",
			instructions: "one",
			input: [],
		})
		await roundTrip(clock, transport, {
			model: "gpt-5",
			instructions: "two",
			input: [],
		})
		expect(socket.framesOfType("response.create")[1]).not.toHaveProperty(
			"previous_response_id",
		)
		await transport.close()
	})
})

describe("websocket connection setup cancellation", () => {
	it.each([
		"abort",
		"close",
	])("settles %s while an async factory is pending and closes its late socket", async (action) => {
		const clock = createVirtualClock()
		let resolveFactory: (socket: FakeWebSocket) => void = () => {}
		let entered = false
		const transport = createWebsocketTransport({
			codexVersion: TEST_CODEX_VERSION,
			now: clock.now,
			timers: clock.timers,
			webSocketFactory: async () => {
				entered = true
				return new Promise<FakeWebSocket>((resolve) => {
					resolveFactory = resolve
				})
			},
		})
		const controller = new AbortController()
		const pending = transport.streamResponse(
			{ model: "gpt-5" },
			{ ...identity, signal: controller.signal },
			ACCESS_TOKEN,
		)
		const assertion = expect(pending).rejects.toThrow()
		await clock.tick(0)
		expect(entered).toBe(true)
		if (action === "abort") controller.abort()
		else await transport.close()
		await assertion
		const late = new FakeWebSocket("wss://late.example", {})
		resolveFactory(late)
		await clock.tick(0)
		expect(late.closeCalls.length).toBeGreaterThan(0)
		await transport.close()
	})
})

describe("websocket prepared URLs", () => {
	it("preserves encoded provider and request query parameters", async () => {
		FakeWebSocket.instances = []
		const clock = createVirtualClock()
		const transport = makeTestTransport(clock)
		const { socket } = await roundTrip(
			clock,
			transport,
			{ model: "gpt-5" },
			{
				...identity,
				url: "https://upstream.example/prefix/responses?api-version=v1&label=a%26b",
			},
		)
		expect(socket.url).toBe(
			"wss://upstream.example/prefix/responses?api-version=v1&label=a%26b",
		)
		await transport.close()
	})
	it("preserves configured query parameters without an explicit request URL", async () => {
		FakeWebSocket.instances = []
		const clock = createVirtualClock()
		const transport = makeTestTransport(clock, {
			baseURL: "https://upstream.example/prefix?api-version=v1",
		})
		const { socket } = await roundTrip(clock, transport, { model: "gpt-5" })
		expect(socket.url).toBe(
			"wss://upstream.example/prefix/responses?api-version=v1",
		)
		await transport.close()
	})
})

describe("websocket composition metadata", () => {
	it("preserves per-request Lite mode without leaking it to the next ordinary turn", async () => {
		FakeWebSocket.instances = []
		const clock = createVirtualClock(),
			transport = makeTestTransport(clock)
		const first = await roundTrip(
			clock,
			transport,
			{ model: "gpt-5", input: [] },
			{ ...identity, responsesLite: true },
		)
		expect(
			first.socket.framesOfType("response.create")[0]?.client_metadata,
		).toMatchObject({
			ws_request_header_x_openai_internal_codex_responses_lite: "true",
		})
		const next = transport.streamResponse(
			{ model: "gpt-5", input: [] },
			identity,
			ACCESS_TOKEN,
		)
		await clock.tick(0)
		const frames = first.socket.framesOfType("response.create")
		expect(frames[1]?.client_metadata).not.toHaveProperty(
			"ws_request_header_x_openai_internal_codex_responses_lite",
		)
		completeResponse(first.socket, "next")
		await clock.tick(0)
		await readStreamText(await next)
		await transport.close()
	})
	it("includes completed output items in incremental history when terminal output is empty", async () => {
		FakeWebSocket.instances = []
		const clock = createVirtualClock(),
			transport = makeTestTransport(clock)
		const input = [{ role: "user", content: "hello" }],
			output = {
				id: "o",
				type: "message",
				role: "assistant",
				content: "answer",
			}
		const first = transport.streamResponse(
			{ model: "m", input },
			identity,
			ACCESS_TOKEN,
		)
		await clock.tick(0)
		const socket = FakeWebSocket.instances[0]
		socket.open()
		await clock.tick(0)
		socket.serverSend({ type: "response.output_item.done", item: output })
		socket.serverSend({
			type: "response.completed",
			response: { id: "r", output: [] },
		})
		await clock.tick(0)
		await readStreamText(await first)
		const next = transport.streamResponse(
			{
				model: "m",
				input: [...input, output, { role: "user", content: "next" }],
			},
			identity,
			ACCESS_TOKEN,
		)
		await clock.tick(0)
		expect(socket.framesOfType("response.create")[1]).toMatchObject({
			previous_response_id: "r",
			input: [{ role: "user", content: "next" }],
		})
		completeResponse(socket, "next")
		await clock.tick(0)
		await readStreamText(await next)
		await transport.close()
	})
	it("forwards quota events as protocol events and preserves typed quota errors", async () => {
		FakeWebSocket.instances = []
		const clock = createVirtualClock(),
			transport = makeTestTransport(clock)
		const pending = transport.streamResponse(
			{ model: "m" },
			identity,
			ACCESS_TOKEN,
		)
		await clock.tick(0)
		const socket = FakeWebSocket.instances[0]
		socket.open()
		await clock.tick(0)
		socket.serverSend({
			type: "codex.rate_limits",
			rate_limits: { primary: { used_percent: 100, reset_at: 200 } },
		})
		await clock.tick(0)
		const stream = await pending
		const reader = stream.getReader()
		expect(new TextDecoder().decode((await reader.read()).value)).toContain(
			"codex.rate_limits",
		)
		socket.serverSend({
			type: "error",
			status: 429,
			error: { code: "rate_limit_exceeded", resets_at: 200 },
		})
		await clock.tick(0)
		await expect(reader.read()).rejects.toMatchObject({
			category: "throttled",
			status: 429,
		})
		await transport.close()
	})
	it.each([
		{
			name: "string Retry-After and mixed-case identifiers",
			headers: {
				"Retry-After": "3600",
				"X-Codex-Active-Limit": "family",
				"X-Request-Id": "request-1",
				authorization: "Bearer must-not-be-retained",
			},
			retryAt: 3_600_000,
			limitId: "family",
			requestId: "request-1",
		},
		{
			name: "numeric Retry-After",
			headers: { "retry-after": 3600 },
			retryAt: 3_600_000,
		},
		{
			name: "HTTP-date Retry-After",
			headers: { "retry-after": "Thu, 01 Jan 1970 01:00:00 GMT" },
			retryAt: 3_600_000,
		},
		{
			name: "longer body reset",
			headers: { "retry-after": "3600" },
			resetsAt: 7200,
			retryAt: 7_200_000,
		},
		{
			name: "longer header reset",
			headers: { "retry-after": "7200" },
			resetsAt: 3600,
			retryAt: 7_200_000,
		},
		{
			name: "malformed values are ignored independently",
			headers: {
				"retry-after": ["3600"],
				"x-codex-active-limit": { value: "family" },
				"x-request-id": "request-2",
			},
			retryAt: undefined,
			requestId: "request-2",
		},
		{
			name: "oversized and control-character values are ignored",
			headers: {
				"retry-after": "1".repeat(257),
				"x-codex-active-limit": "family\r\ninjected: value",
				"x-request-id": null,
			},
			retryAt: undefined,
		},
		{
			name: "a non-object header collection is ignored",
			headers: ["retry-after", "3600"],
			retryAt: undefined,
		},
	])("preserves wrapped error policy: $name", async (testCase) => {
		FakeWebSocket.instances = []
		const clock = createVirtualClock()
		const transport = makeTestTransport(clock)
		try {
			const pending = transport.streamResponse(
				{ model: "m" },
				identity,
				ACCESS_TOKEN,
			)
			const rejection = expect(pending).rejects.toMatchObject({
				category: "throttled",
				status: 429,
				retryAt: testCase.retryAt,
				limitId: testCase.limitId,
				requestId: testCase.requestId,
			})
			await clock.tick(0)
			const socket = FakeWebSocket.instances[0]
			socket.open()
			await clock.tick(0)
			socket.serverSend({
				type: "error",
				status: 429,
				error: {
					type: "rate_limit_exceeded",
					resets_at: testCase.resetsAt,
				},
				headers: testCase.headers,
			})
			await clock.tick(0)
			await rejection
		} finally {
			await transport.close()
		}
	})
	it("progress resets idle timeout and downstream queued data is not upstream idleness", async () => {
		FakeWebSocket.instances = []
		const clock = createVirtualClock(),
			transport = makeTestTransport(clock, { streamIdleTimeoutMs: 100 })
		const pending = transport.streamResponse(
			{ model: "m" },
			identity,
			ACCESS_TOKEN,
		)
		await clock.tick(0)
		const socket = FakeWebSocket.instances[0]
		socket.open()
		await clock.tick(0)
		socket.serverSend({ type: "response.created", response: { id: "r" } })
		await clock.tick(0)
		const reader = (await pending).getReader()
		await reader.read()
		await clock.tick(80)
		socket.serverSend({ type: "response.output_text.delta", delta: "x" })
		await clock.tick(0)
		await clock.tick(150)
		expect(socket.closeCalls).toHaveLength(0)
		await reader.read()
		await clock.tick(101)
		await expect(reader.read()).rejects.toThrow(/idle timeout/)
		await transport.close()
	})
})
