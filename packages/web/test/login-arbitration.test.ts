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
	accessToken: "expired-a",
	refreshToken: "refresh-a",
	expiresAt: "2020-01-01T00:00:00.000Z",
}
const tokenResponse = (accountId: string) =>
	Response.json({
		access_token: `e30.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }))}.sig`,
		refresh_token: `rotated-${accountId}`,
		expires_in: 3600,
	})
const fixture = () => {
	let pending: string | null = JSON.stringify({
		state: "login-state",
		codeVerifier: "verifier",
		redirectUri: "https://app.test/callback",
		returnTo: "/home",
	})
	vi.stubGlobal("window", {
		setTimeout,
		clearTimeout,
		location: {
			href: "https://app.test/callback?code=one-use-code&state=login-state",
		},
		sessionStorage: {
			getItem: () => pending,
			removeItem: () => {
				pending = null
			},
			setItem: (_key: string, value: string) => {
				pending = value
			},
		},
		history: { replaceState: vi.fn() },
	})
	let current: OpenAIOAuthSession | null = { ...original }
	const sessionStore = {
		get: vi.fn(async () => current),
		set: vi.fn(async (session: OpenAIOAuthSession) => {
			current = session
		}),
		clear: vi.fn(async () => {
			current = null
		}),
	}
	return { sessionStore, current: () => current }
}
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

describe("callback and maintenance arbitration", () => {
	test("duplicate callback consumers exchange the one-use code only once", async () => {
		const { sessionStore } = fixture()
		const response = deferred<Response>()
		let exchanges = 0
		const fetch = vi.fn(async () => {
			exchanges += 1
			return exchanges === 1
				? response.promise
				: Response.json({ error: "invalid_grant" }, { status: 400 })
		})
		const first = completeLogin({ sessionStore, fetch })
		const second = completeLogin({ sessionStore, fetch })
		await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
		response.resolve(tokenResponse("b"))
		const sessions = await Promise.all([first, second])
		expect(fetch).toHaveBeenCalledOnce()
		expect(sessions[0]?.accountId).toBe("b")
		expect(sessions[1]).toEqual(sessions[0])
		expect(sessionStore.set).toHaveBeenCalledOnce()
	})

	test.each([
		"before",
		"during",
	])("maintenance refresh started %s login cannot invalidate the explicit owner choice", async (when) => {
		const { sessionStore, current } = fixture()
		const refreshResponse = deferred<Response>()
		const loginResponse = deferred<Response>()
		const refreshFetch = vi.fn(async () => refreshResponse.promise)
		const loginFetch = vi.fn(async () => loginResponse.promise)
		let refreshing: Promise<OpenAIOAuthSession | null> | undefined
		if (when === "before") {
			refreshing = getSession({ sessionStore, fetch: refreshFetch })
			await vi.waitFor(() => expect(refreshFetch).toHaveBeenCalledOnce())
		}
		const login = completeLogin({ sessionStore, fetch: loginFetch })
		await vi.waitFor(() => expect(loginFetch).toHaveBeenCalledOnce())
		if (when === "during")
			refreshing = getSession({ sessionStore, fetch: refreshFetch })
		refreshResponse.resolve(tokenResponse("a"))
		await refreshing
		loginResponse.resolve(tokenResponse("b"))
		await expect(login).resolves.toMatchObject({ accountId: "b" })
		expect(current()?.accountId).toBe("b")
	})

	test("built-in store maintenance advances the pending login's encrypted snapshot", async () => {
		fixture()
		const sessionStore = createSessionStore({
			dbName: "callback-maintenance-arbitration",
		})
		await sessionStore.set(original)
		const loginResponse = deferred<Response>()
		const loginFetch = vi.fn(async () => loginResponse.promise)
		const login = completeLogin({ sessionStore, fetch: loginFetch })
		await vi.waitFor(() => expect(loginFetch).toHaveBeenCalledOnce())
		await getSession({ sessionStore, fetch: async () => tokenResponse("a") })
		loginResponse.resolve(tokenResponse("b"))
		await expect(login).resolves.toMatchObject({ accountId: "b" })
		await expect(sessionStore.get()).resolves.toMatchObject({ accountId: "b" })
	})

	test("explicit store replacement wins over pending login", async () => {
		const { sessionStore, current } = fixture()
		const response = deferred<Response>()
		const fetch = vi.fn(async () => response.promise)
		const login = completeLogin({ sessionStore, fetch })
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
		await sessionStore.set({ accountId: "c", accessToken: "manual-c" })
		response.resolve(tokenResponse("b"))
		await expect(login).resolves.toBeNull()
		expect(current()?.accountId).toBe("c")
	})

	test("a new pending login supersedes the prior callback without clearing its state", async () => {
		const { sessionStore, current } = fixture()
		const oldResponse = deferred<Response>()
		const oldFetch = vi.fn(async () => oldResponse.promise)
		const oldLogin = completeLogin({ sessionStore, fetch: oldFetch })
		const oldRejection = expect(oldLogin).rejects.toMatchObject({
			name: "AbortError",
		})
		await vi.waitFor(() => expect(oldFetch).toHaveBeenCalledOnce())
		window.sessionStorage.setItem(
			"openai-oauth:pending-login",
			JSON.stringify({
				state: "next-state",
				codeVerifier: "next-verifier",
				redirectUri: "https://app.test/callback",
				returnTo: "/next",
			}),
		)
		await expect(
			completeLogin({
				sessionStore,
				url: "https://app.test/callback?code=next-code&state=next-state",
				fetch: async () => tokenResponse("c"),
			}),
		).resolves.toMatchObject({ accountId: "c" })
		oldResponse.resolve(tokenResponse("b"))
		await oldRejection
		expect(current()?.accountId).toBe("c")
	})

	test("callback deadline releases an ignored-abort exchange and fences its late result", async () => {
		const { sessionStore, current } = fixture()
		const response = deferred<Response>()
		const fetch = vi.fn(async () => response.promise)
		await expect(
			completeLogin({ sessionStore, fetch, callbackTimeoutMs: 25 }),
		).rejects.toThrow("timed out")
		response.resolve(tokenResponse("b"))
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(current()).toEqual(original)
	})

	test("a maintenance response arriving after successful login cannot restore the old account", async () => {
		const { sessionStore, current } = fixture()
		const loginResponse = deferred<Response>()
		const loginFetch = vi.fn(async () => loginResponse.promise)
		const login = completeLogin({ sessionStore, fetch: loginFetch })
		await vi.waitFor(() => expect(loginFetch).toHaveBeenCalledOnce())
		const refreshResponse = deferred<Response>()
		const refreshFetch = vi.fn(async () => refreshResponse.promise)
		const refresh = getSession({ sessionStore, fetch: refreshFetch })
		await vi.waitFor(() => expect(refreshFetch).toHaveBeenCalledOnce())
		loginResponse.resolve(tokenResponse("b"))
		await expect(login).resolves.toMatchObject({ accountId: "b" })
		refreshResponse.resolve(tokenResponse("a"))
		await expect(refresh).resolves.toMatchObject({ accountId: "b" })
		expect(current()?.accountId).toBe("b")
	})

	test("failed explicit login permits a later fresh maintenance operation", async () => {
		const { sessionStore, current } = fixture()
		await expect(
			completeLogin({
				sessionStore,
				fetch: async () => {
					throw new Error("login failed")
				},
			}),
		).rejects.toThrow("login failed")
		await expect(
			refreshStoredSession({
				sessionStore,
				fetch: async () => tokenResponse("a"),
			}),
		).resolves.toMatchObject({ refreshToken: "rotated-a" })
		expect(current()?.accountId).toBe("a")
	})

	test("one cancelled callback subscriber leaves another subscriber's exchange usable", async () => {
		const { sessionStore } = fixture()
		const response = deferred<Response>()
		const fetch = vi.fn(async () => response.promise)
		const controller = new AbortController()
		const first = completeLogin({
			sessionStore,
			fetch,
			signal: controller.signal,
		})
		const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" })
		const second = completeLogin({ sessionStore, fetch })
		await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
		controller.abort()
		await rejected
		response.resolve(tokenResponse("b"))
		await expect(second).resolves.toMatchObject({ accountId: "b" })
		expect(fetch).toHaveBeenCalledOnce()
	})

	test("all callback subscribers cancelling fences an ignored-abort exchange", async () => {
		const { sessionStore, current } = fixture()
		const response = deferred<Response>()
		const fetch = vi.fn(async () => response.promise)
		const a = new AbortController()
		const b = new AbortController()
		const first = completeLogin({ sessionStore, fetch, signal: a.signal })
		const second = completeLogin({ sessionStore, fetch, signal: b.signal })
		const rejectedA = expect(first).rejects.toMatchObject({
			name: "AbortError",
		})
		const rejectedB = expect(second).rejects.toMatchObject({
			name: "AbortError",
		})
		await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
		a.abort()
		b.abort()
		await Promise.all([rejectedA, rejectedB])
		response.resolve(tokenResponse("b"))
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(current()).toEqual(original)
		expect(sessionStore.set).not.toHaveBeenCalled()
	})

	test("logout fences a shared callback and a late maintenance completion", async () => {
		const { sessionStore, current } = fixture()
		const refreshResponse = deferred<Response>()
		const refreshFetch = vi.fn(async () => refreshResponse.promise)
		const refresh = getSession({ sessionStore, fetch: refreshFetch })
		await vi.waitFor(() => expect(refreshFetch).toHaveBeenCalledOnce())
		const loginResponse = deferred<Response>()
		const loginFetch = vi.fn(async () => loginResponse.promise)
		const login = completeLogin({ sessionStore, fetch: loginFetch })
		await vi.waitFor(() => expect(loginFetch).toHaveBeenCalledOnce())
		await logout({ sessionStore })
		loginResponse.resolve(tokenResponse("b"))
		refreshResponse.resolve(tokenResponse("a"))
		await Promise.allSettled([login, refresh])
		expect(current()).toBeNull()
		expect(sessionStore.set).not.toHaveBeenCalled()
	})
})

describe("pending custom storage cancellation", () => {
	test.each([
		"get",
		"callback",
		"callback-without-pending",
	])("%s promptly rejects an aborted storage wait and its tail recovers", async (kind) => {
		const { sessionStore } = fixture()
		if (kind === "callback-without-pending")
			window.sessionStorage.removeItem("openai-oauth:pending-login")
		const pending = deferred<OpenAIOAuthSession | null>()
		sessionStore.get.mockImplementationOnce(() => pending.promise)
		const controller = new AbortController()
		const fetch = vi.fn(async () => tokenResponse("b"))
		const options = { sessionStore, signal: controller.signal, fetch }
		const request =
			kind === "get" ? getSession(options) : completeLogin(options)
		const rejected = expect(request).rejects.toMatchObject({
			name: "AbortError",
		})
		await vi.waitFor(() => expect(sessionStore.get).toHaveBeenCalledOnce())
		controller.abort()
		await rejected
		expect(fetch).not.toHaveBeenCalled()
		pending.resolve(original)
		await expect(getSession({ sessionStore, refresh: false })).resolves.toEqual(
			original,
		)
	})
})
