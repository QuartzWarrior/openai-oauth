import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
	getSession,
	type OpenAIOAuthSession,
	refreshStoredSession,
} from "../src/index.js"

const deferred = <T>() => {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((yes) => {
		resolve = yes
	})
	return { promise, resolve }
}

const original: OpenAIOAuthSession = {
	accountId: "a",
	accessToken: "old",
	refreshToken: "refresh-a",
	expiresAt: "2020-01-01T00:00:00.000Z",
}

const tokenResponse = (refreshToken = "rotated") =>
	new Response(
		JSON.stringify({
			access_token: `e30.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "a" } }))}.sig`,
			refresh_token: refreshToken,
			expires_in: 3600,
		}),
		{ headers: { "content-type": "application/json" } },
	)

const memoryStore = () => {
	let current: OpenAIOAuthSession | null = { ...original }
	return {
		get: vi.fn(async () => current),
		set: vi.fn(async (session: OpenAIOAuthSession) => {
			current = session
		}),
		clear: vi.fn(async () => {
			current = null
		}),
	}
}

const observe = <T>(promise: Promise<T>) => {
	let result:
		| { status: "pending" }
		| { status: "fulfilled"; value: T }
		| { status: "rejected"; reason: unknown } = { status: "pending" }
	void promise.then(
		(value) => {
			result = { status: "fulfilled", value }
		},
		(reason) => {
			result = { status: "rejected", reason }
		},
	)
	return () => result
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
})

describe("shared browser refresh deadline", () => {
	test.each([
		"fetch",
		"body",
	])("bounds a stalled %s for joined subscribers and permits a fresh retry", async (phase) => {
		const sessionStore = memoryStore()
		const started = deferred<void>()
		const response = deferred<Response>()
		const cancel = vi.fn()
		let operationSignal: AbortSignal | null | undefined
		const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
			operationSignal = init?.signal
			started.resolve()
			return phase === "fetch"
				? response.promise
				: new Response(new ReadableStream({ cancel }))
		})
		const options = { sessionStore, fetch, refreshTimeoutMs: 50 }
		const first = observe(getSession(options))
		await started.promise
		const second = observe(refreshStoredSession(options))
		await vi.advanceTimersByTimeAsync(49)
		expect(first().status).toBe("pending")
		expect(second().status).toBe("pending")
		await vi.advanceTimersByTimeAsync(1)
		for (const result of [first(), second()]) {
			expect(result).toMatchObject({ status: "rejected" })
			if (result.status === "rejected")
				expect(result.reason).toEqual(
					expect.objectContaining({
						message: "OpenAI OAuth session refresh timed out.",
					}),
				)
		}
		expect(operationSignal?.aborted).toBe(true)
		expect(fetch).toHaveBeenCalledOnce()
		expect(sessionStore.set).not.toHaveBeenCalled()
		if (phase === "body") expect(cancel).toHaveBeenCalledOnce()

		await expect(
			getSession({
				sessionStore,
				fetch: async () => tokenResponse("fresh-retry"),
				refreshTimeoutMs: 50,
			}),
		).resolves.toMatchObject({ refreshToken: "fresh-retry" })
		// A fetch ignoring abort may still complete after the replacement operation.
		response.resolve(tokenResponse("obsolete"))
		await vi.advanceTimersByTimeAsync(0)
		await expect(sessionStore.get()).resolves.toMatchObject({
			refreshToken: "fresh-retry",
		})
		expect(sessionStore.set).toHaveBeenCalledOnce()
	})

	test("defaults the shared operation deadline to thirty seconds", async () => {
		const sessionStore = memoryStore()
		const started = deferred<void>()
		const result = observe(
			getSession({
				sessionStore,
				fetch: async () => {
					started.resolve()
					return new Promise<Response>(() => {})
				},
			}),
		)
		await started.promise
		await vi.advanceTimersByTimeAsync(29_999)
		expect(result().status).toBe("pending")
		await vi.advanceTimersByTimeAsync(1)
		expect(result()).toMatchObject({
			status: "rejected",
			reason: { message: "OpenAI OAuth session refresh timed out." },
		})
	})

	test("one cancelled subscriber does not stop another subscriber's useful refresh", async () => {
		const sessionStore = memoryStore()
		const started = deferred<void>()
		const response = deferred<Response>()
		let operationSignal: AbortSignal | null | undefined
		const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
			operationSignal = init?.signal
			started.resolve()
			return response.promise
		})
		const controller = new AbortController()
		const options = { sessionStore, fetch, refreshTimeoutMs: 50 }
		const first = getSession({ ...options, signal: controller.signal })
		const cancelled = expect(first).rejects.toMatchObject({
			name: "AbortError",
		})
		await started.promise
		const second = refreshStoredSession(options)
		controller.abort()
		await cancelled
		expect(operationSignal?.aborted).toBe(false)
		response.resolve(tokenResponse())
		await expect(second).resolves.toMatchObject({ refreshToken: "rotated" })
		await vi.advanceTimersByTimeAsync(50)
		expect(operationSignal?.aborted).toBe(false)
		expect(fetch).toHaveBeenCalledOnce()
		expect(sessionStore.set).toHaveBeenCalledOnce()
	})

	test("bounds a stalled precommit storage read and fences its late continuation", async () => {
		const sessionStore = memoryStore()
		const enteredCommit = deferred<void>()
		const read = deferred<OpenAIOAuthSession | null>()
		sessionStore.get
			.mockResolvedValueOnce(original)
			.mockImplementationOnce(async () => {
				enteredCommit.resolve()
				return read.promise
			})
		const result = observe(
			getSession({
				sessionStore,
				fetch: async () => tokenResponse("obsolete"),
				refreshTimeoutMs: 50,
			}),
		)
		await enteredCommit.promise
		await vi.advanceTimersByTimeAsync(50)
		expect(result()).toMatchObject({
			status: "rejected",
			reason: { message: "OpenAI OAuth session refresh timed out." },
		})
		read.resolve(original)
		await vi.advanceTimersByTimeAsync(0)
		expect(sessionStore.set).not.toHaveBeenCalled()
		await expect(
			getSession({ sessionStore, fetch: async () => tokenResponse() }),
		).resolves.toMatchObject({ refreshToken: "rotated" })
	})

	test.each([
		0,
		-1,
		0.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		2_147_483_648,
	])("rejects invalid shared refresh deadline %s before fetching", async (refreshTimeoutMs) => {
		const fetch = vi.fn(async () => tokenResponse())
		await expect(
			getSession({ sessionStore: memoryStore(), fetch, refreshTimeoutMs }),
		).rejects.toThrow("refreshTimeoutMs")
		expect(fetch).not.toHaveBeenCalled()
	})
})
