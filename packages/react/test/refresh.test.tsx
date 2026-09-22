// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
	type OpenAIOAuthSession,
	type UseSignInWithChatGPTReturn,
	useSignInWithChatGPT,
} from "../src/index.js"

const deferred = <T,>() => {
	let resolve!: (value: T) => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}
const initial: OpenAIOAuthSession = {
	accountId: "a",
	accessToken: "old",
	refreshToken: "refresh-a",
}
const replacement: OpenAIOAuthSession = { accountId: "b", accessToken: "new-b" }
const tokenResponse = () => {
	const token = `e30.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "a" } }))}.sig`
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
const roots = new Set<Root>()
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
})
afterEach(async () => {
	await act(async () => {
		for (const root of roots) root.unmount()
	})
	roots.clear()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})
const mount = async () => {
	let session: OpenAIOAuthSession | null = { ...initial }
	const sessionStore = {
		get: vi.fn(async () => session),
		set: vi.fn(async (next: OpenAIOAuthSession) => {
			session = next
		}),
		clear: vi.fn(async () => {
			session = null
		}),
	}
	const gate = deferred<Response>()
	const started = deferred<void>()
	const fetch = vi.fn(async () => {
		started.resolve()
		return gate.promise
	})
	const onError = vi.fn()
	const onSuccess = vi.fn()
	const onStateChange = vi.fn()
	let api!: UseSignInWithChatGPTReturn
	function Probe() {
		api = useSignInWithChatGPT({
			sessionStore,
			fetch,
			onError,
			onSuccess,
			onStateChange,
		})
		return <span>{api.status}</span>
	}
	const root = createRoot(document.createElement("div"))
	roots.add(root)
	await act(async () => {
		root.render(<Probe />)
	})
	onSuccess.mockClear()
	onStateChange.mockClear()
	return {
		api: () => api,
		root,
		gate,
		started,
		fetch,
		sessionStore,
		onError,
		onSuccess,
		onStateChange,
	}
}

describe("React refresh lifecycle", () => {
	test("two callback hook consumers share one one-use code exchange", async () => {
		window.history.replaceState(
			null,
			"",
			"/auth/callback?code=one-use-code&state=shared-state",
		)
		window.sessionStorage.setItem(
			"openai-oauth:pending-login",
			JSON.stringify({
				state: "shared-state",
				codeVerifier: "verifier",
				redirectUri: `${window.location.origin}/auth/callback`,
				returnTo: "/",
			}),
		)
		let current: OpenAIOAuthSession | null = null
		const store = {
			get: vi.fn(async () => current),
			set: vi.fn(async (session: OpenAIOAuthSession) => {
				current = session
			}),
			clear: vi.fn(async () => {
				current = null
			}),
		}
		const gate = deferred<Response>()
		const fetch = vi.fn(async () => gate.promise)
		const apis: UseSignInWithChatGPTReturn[] = []
		function Probe({ index }: { index: number }) {
			apis[index] = useSignInWithChatGPT({ sessionStore: store, fetch })
			return null
		}
		const root = createRoot(document.createElement("div"))
		roots.add(root)
		try {
			await act(async () => {
				root.render(
					<>
						<Probe index={0} />
						<Probe index={1} />
					</>,
				)
			})
			expect(fetch).toHaveBeenCalledOnce()
			await act(async () => {
				gate.resolve(tokenResponse())
			})
			expect(apis[0]?.status).toBe("signed-in")
			expect(apis[1]?.status).toBe("signed-in")
			expect(store.set).toHaveBeenCalledOnce()
		} finally {
			window.sessionStorage.removeItem("openai-oauth:pending-login")
			window.history.replaceState(null, "", "/")
		}
	})

	test("a stale popup storage failure cannot overwrite logout", async () => {
		const h = await mount()
		const stored = deferred<OpenAIOAuthSession | null>()
		h.sessionStore.get.mockImplementationOnce(() => stored.promise)
		await act(async () => {
			window.dispatchEvent(
				new MessageEvent("message", {
					origin: window.location.origin,
					data: { type: "openai-oauth:signed-in" },
				}),
			)
		})
		await act(async () => {
			await h.api().logout()
		})
		await act(async () => {
			stored.reject(new Error("stale storage error"))
		})
		expect(h.api().status).toBe("signed-out")
		expect(h.onError).not.toHaveBeenCalled()
	})

	test("coalesces concurrent refreshes into one operation and notification", async () => {
		const h = await mount()
		let first!: Promise<OpenAIOAuthSession | null>
		let second!: Promise<OpenAIOAuthSession | null>
		await act(async () => {
			first = h.api().refresh()
			second = h.api().refresh()
			await h.started.promise
			h.gate.resolve(tokenResponse())
			await Promise.all([first, second])
		})
		expect(first).toBe(second)
		expect(h.fetch).toHaveBeenCalledOnce()
		expect(h.sessionStore.set).toHaveBeenCalledOnce()
		expect(h.onSuccess).toHaveBeenCalledOnce()
		expect(h.api().session?.refreshToken).toBe("rotated")
	})

	test.each([
		false,
		true,
	])("logout wins over a pending refresh (rejects: %s)", async (reject) => {
		const h = await mount()
		let request!: Promise<OpenAIOAuthSession | null>
		await act(async () => {
			request = h.api().refresh()
			await h.started.promise
		})
		await act(async () => {
			await h.api().logout()
		})
		await act(async () => {
			if (reject) h.gate.reject(new Error("old failure"))
			else h.gate.resolve(tokenResponse())
			await request
		})
		expect(h.api().status).toBe("signed-out")
		expect(h.onError).not.toHaveBeenCalled()
		expect(h.onSuccess).not.toHaveBeenCalled()
		expect(h.sessionStore.set).not.toHaveBeenCalled()
		await expect(h.sessionStore.get()).resolves.toBeNull()
	})

	test.each([
		false,
		true,
	])("a newer stored account wins over refresh (rejects: %s)", async (reject) => {
		const h = await mount()
		let request!: Promise<OpenAIOAuthSession | null>
		await act(async () => {
			request = h.api().refresh()
			await h.started.promise
		})
		await h.sessionStore.set(replacement)
		await act(async () => {
			if (reject) h.gate.reject(new Error("old failure"))
			else h.gate.resolve(tokenResponse())
			await request
		})
		expect(h.api().session).toEqual(replacement)
		expect(h.onError).not.toHaveBeenCalled()
		expect(h.sessionStore.set).toHaveBeenCalledOnce()
	})

	test("unmount prevents refresh persistence and callbacks even if fetch ignores abort", async () => {
		const h = await mount()
		let request!: Promise<OpenAIOAuthSession | null>
		await act(async () => {
			request = h.api().refresh()
			await h.started.promise
		})
		await act(async () => {
			h.root.unmount()
		})
		roots.delete(h.root)
		h.gate.resolve(tokenResponse())
		await request
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(h.sessionStore.set).not.toHaveBeenCalled()
		expect(h.onError).not.toHaveBeenCalled()
		expect(h.onSuccess).not.toHaveBeenCalled()
		expect(h.onStateChange).not.toHaveBeenCalled()
	})

	test("popup account replacement invalidates pending refresh notifications", async () => {
		const h = await mount()
		let request!: Promise<OpenAIOAuthSession | null>
		await act(async () => {
			request = h.api().refresh()
			await h.started.promise
		})
		await h.sessionStore.set(replacement)
		await act(async () => {
			window.dispatchEvent(
				new MessageEvent("message", {
					origin: window.location.origin,
					data: { type: "openai-oauth:signed-in" },
				}),
			)
		})
		await act(async () => {
			h.gate.reject(new Error("obsolete"))
			await request
		})
		expect(h.api().session).toEqual(replacement)
		expect(h.onError).not.toHaveBeenCalled()
		expect(h.onSuccess).toHaveBeenCalledOnce()
	})
})
