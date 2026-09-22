import "fake-indexeddb/auto"
import { afterEach, describe, expect, test, vi } from "vitest"
import {
	completeLogin,
	createSessionStore,
	getSession,
	logout,
	type OpenAIOAuthSession,
	refreshStoredSession,
} from "../src/index.js"

const deferred = <T>() => {
	let resolve!: (value: T) => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}
const original: OpenAIOAuthSession = {
	accountId: "a",
	accessToken: "old",
	refreshToken: "refresh-a",
	expiresAt: "2020-01-01T00:00:00.000Z",
}
const replacement: OpenAIOAuthSession = { accountId: "b", accessToken: "new-b" }
const tokenResponse = (accountId = "a") => {
	const token = `e30.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }))}.sig`
	return new Response(
		JSON.stringify({
			access_token: token,
			refresh_token: "rotated",
			expires_in: 3600,
		}),
		{
			headers: { "content-type": "application/json" },
		},
	)
}
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
const pendingRefresh = () => {
	const started = deferred<void>()
	const response = deferred<Response>()
	const fetch = vi.fn(async () => {
		started.resolve()
		return response.promise
	})
	return { started, response, fetch }
}

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

describe("stored browser refresh", () => {
	test("login abort during encryption cannot persist an obsolete session", async () => {
		const pending = JSON.stringify({
			state: "test-state",
			codeVerifier: "test-verifier",
			redirectUri: "https://app.test/callback",
			returnTo: "/",
		})
		vi.stubGlobal("window", {
			setTimeout,
			clearTimeout,
			location: {
				href: "https://app.test/callback?code=code&state=test-state",
			},
			sessionStorage: { getItem: () => pending, removeItem: vi.fn() },
			history: { replaceState: vi.fn() },
		})
		const sessionStore = createSessionStore({
			dbName: "abort-login-encryption",
		})
		await sessionStore.set(original)
		const encrypt = crypto.subtle.encrypt.bind(crypto.subtle)
		const started = deferred<void>()
		const release = deferred<void>()
		vi.spyOn(crypto.subtle, "encrypt").mockImplementation(async (...args) => {
			started.resolve()
			await release.promise
			return encrypt(...args)
		})
		const controller = new AbortController()
		const request = completeLogin({
			sessionStore,
			fetch: async () => tokenResponse(),
			signal: controller.signal,
		})
		const assertion = expect(request).rejects.toMatchObject({
			name: "AbortError",
		})
		await started.promise
		controller.abort()
		release.resolve()
		await assertion
		await expect(sessionStore.get()).resolves.toEqual(original)
	})

	test("coalesces simultaneous automatic and explicit refreshes", async () => {
		const sessionStore = memoryStore()
		const gate = pendingRefresh()
		const first = getSession({ sessionStore, fetch: gate.fetch })
		const second = refreshStoredSession({ sessionStore, fetch: gate.fetch })
		await gate.started.promise
		gate.response.resolve(tokenResponse())
		const [a, b] = await Promise.all([first, second])
		expect(a).toEqual(b)
		expect(a?.accessToken).not.toBe("old")
		expect(gate.fetch).toHaveBeenCalledOnce()
		expect(sessionStore.set).toHaveBeenCalledOnce()
	})

	test("does not resurrect a logged-out session", async () => {
		const sessionStore = memoryStore()
		const gate = pendingRefresh()
		const request = getSession({ sessionStore, fetch: gate.fetch })
		await gate.started.promise
		await logout({ sessionStore })
		gate.response.resolve(tokenResponse())
		await expect(request).resolves.toBeNull()
		await expect(sessionStore.get()).resolves.toBeNull()
		expect(sessionStore.set).not.toHaveBeenCalled()
	})

	test.each([
		false,
		true,
	])("does not replace a newer account (old refresh rejects: %s)", async (reject) => {
		const sessionStore = memoryStore()
		const gate = pendingRefresh()
		const request = getSession({ sessionStore, fetch: gate.fetch })
		await gate.started.promise
		await sessionStore.set(replacement)
		if (reject) gate.response.reject(new Error("old refresh failed"))
		else gate.response.resolve(tokenResponse())
		await expect(request).resolves.toEqual(replacement)
		await expect(sessionStore.get()).resolves.toEqual(replacement)
		expect(sessionStore.clear).not.toHaveBeenCalled()
		expect(sessionStore.set).toHaveBeenCalledOnce()
	})

	test("does not discard a same-account credential replacement", async () => {
		const sessionStore = memoryStore()
		const gate = pendingRefresh()
		const request = getSession({ sessionStore, fetch: gate.fetch })
		await gate.started.promise
		const newer = {
			...original,
			accessToken: "manual-relogin",
			refreshToken: "new-refresh",
		}
		await sessionStore.set(newer)
		gate.response.resolve(tokenResponse())
		await expect(request).resolves.toEqual(newer)
	})

	test("a current refresh failure propagates without poisoning the next refresh", async () => {
		const sessionStore = memoryStore()
		const gate = pendingRefresh()
		const request = getSession({ sessionStore, fetch: gate.fetch })
		const assertion = expect(request).rejects.toThrow("temporary")
		await gate.started.promise
		gate.response.reject(new Error("temporary"))
		await assertion
		await expect(
			getSession({ sessionStore, fetch: async () => tokenResponse() }),
		).resolves.toMatchObject({ refreshToken: "rotated" })
	})

	test("rejects an unexpected account change in a refresh response", async () => {
		const sessionStore = memoryStore()
		await expect(
			getSession({ sessionStore, fetch: async () => tokenResponse("b") }),
		).rejects.toThrow("changed account")
		expect(sessionStore.set).not.toHaveBeenCalled()
	})

	test("an aborted waiter does not abort another refresh subscriber", async () => {
		const sessionStore = memoryStore()
		const gate = pendingRefresh()
		const controller = new AbortController()
		const first = getSession({
			sessionStore,
			fetch: gate.fetch,
			signal: controller.signal,
		})
		const rejection = expect(first).rejects.toMatchObject({
			name: "AbortError",
		})
		await gate.started.promise
		const second = getSession({ sessionStore, fetch: gate.fetch })
		controller.abort()
		await rejection
		gate.response.resolve(tokenResponse())
		await expect(second).resolves.toMatchObject({ refreshToken: "rotated" })
		expect(gate.fetch).toHaveBeenCalledOnce()
	})

	test("last-waiter cancellation prevents a noncompliant fetch from committing", async () => {
		const sessionStore = memoryStore()
		const gate = pendingRefresh()
		const controller = new AbortController()
		const request = getSession({
			sessionStore,
			fetch: gate.fetch,
			signal: controller.signal,
		})
		const rejection = expect(request).rejects.toMatchObject({
			name: "AbortError",
		})
		await gate.started.promise
		controller.abort()
		await rejection
		gate.response.resolve(tokenResponse())
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(sessionStore.set).not.toHaveBeenCalled()
	})

	test.each([
		"clear",
		"replace",
	])("built-in stores fence %s from a second instance", async (action) => {
		vi.stubGlobal("window", globalThis)
		const dbName = `browser-refresh-${action}`
		const sessionStore = createSessionStore({ dbName })
		const other = createSessionStore({ dbName })
		await sessionStore.set(original)
		const gate = pendingRefresh()
		const request = getSession({ sessionStore, fetch: gate.fetch })
		await gate.started.promise
		if (action === "clear") await other.clear()
		else await other.set(replacement)
		gate.response.resolve(tokenResponse())
		await expect(request).resolves.toEqual(
			action === "clear" ? null : replacement,
		)
		await expect(other.get()).resolves.toEqual(
			action === "clear" ? null : replacement,
		)
	})
})
