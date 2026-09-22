import {
	type CompleteLoginOptions,
	logout as clearLogin,
	completeLogin,
	createSessionStore,
	refreshStoredSession,
	type StartLoginOptions,
	startLogin,
} from "@openai-oauth/web"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type {
	OpenAIOAuthSession,
	SessionStore,
	SignInWithChatGPTError,
	SignInWithChatGPTState,
} from "./types.js"

export type SignInWithChatGPTOpenMode = "redirect" | "popup"

export type UseSignInWithChatGPTOptions = Omit<StartLoginOptions, "returnTo"> &
	Pick<CompleteLoginOptions, "fetch" | "now" | "tokenUrl"> & {
		sessionStore?: SessionStore
		onStateChange?: (state: SignInWithChatGPTState) => void
		onSuccess?: (session: OpenAIOAuthSession) => void
		onError?: (error: SignInWithChatGPTError) => void
	}

export type UseSignInWithChatGPTReturn = SignInWithChatGPTState & {
	isSignedIn: boolean
	login: () => Promise<void>
	logout: () => Promise<void>
	refresh: () => Promise<OpenAIOAuthSession | null>
	reset: () => Promise<void>
}

const popupMessageType = "openai-oauth:signed-in"

const checkingState: SignInWithChatGPTState = {
	status: "checking",
	session: null,
	error: null,
}

const signedOutState: SignInWithChatGPTState = {
	status: "signed-out",
	session: null,
	error: null,
}

const needsExtensionState = (installUrl: string): SignInWithChatGPTState => ({
	status: "needs-extension",
	installUrl,
	session: null,
	error: null,
})

const isBrowser = (): boolean => typeof window !== "undefined"

const toLoginError = (
	error: unknown,
	code: SignInWithChatGPTError["code"] = "request-failed",
): SignInWithChatGPTError => ({
	code,
	message:
		error instanceof Error ? error.message : "Sign in with ChatGPT failed.",
	cause: error,
})

const notifyOpener = (): void => {
	if (window.opener && window.opener !== window) {
		window.opener.postMessage(
			{ type: popupMessageType },
			window.location.origin,
		)
		window.setTimeout(() => window.close(), 50)
	}
}

const useLatest = <T>(value: T) => {
	const ref = useRef(value)
	ref.current = value
	return ref
}

export const useSignInWithChatGPT = (
	options: UseSignInWithChatGPTOptions = {},
): UseSignInWithChatGPTReturn => {
	const {
		callbackPath,
		clientId,
		codeVerifier,
		sessionStore: providedSessionStore,
		extraParams,
		fetch: fetchImpl,
		idTokenAddOrganizations,
		issuer,
		now,
		onSuccess,
		onError,
		onStateChange,
		openMode = "redirect",
		redirectUri,
		scope,
		simplifiedFlow,
		state: configuredState,
		tokenUrl,
	} = options
	const onSuccessRef = useLatest(onSuccess)
	const onErrorRef = useLatest(onError)
	const onStateChangeRef = useLatest(onStateChange)
	const defaultStore = useMemo(() => createSessionStore(), [])
	const sessionStore = providedSessionStore ?? defaultStore
	const [state, setState] = useState<SignInWithChatGPTState>(checkingState)
	const lifecycle = useRef({ generation: 0, mounted: false })
	const activeRequests = useRef(new Set<AbortController>())
	const refreshRequest = useRef<{
		generation: number
		promise: Promise<OpenAIOAuthSession | null>
	} | null>(null)
	const invalidate = useCallback(() => {
		lifecycle.current.generation += 1
		for (const controller of activeRequests.current) controller.abort()
		activeRequests.current.clear()
		refreshRequest.current = null
		return lifecycle.current.generation
	}, [])
	const isCurrent = useCallback(
		(generation: number) =>
			lifecycle.current.mounted && lifecycle.current.generation === generation,
		[],
	)
	// biome-ignore lint/correctness/useExhaustiveDependencies: a replacement store invalidates operations from the old owner.
	useEffect(() => {
		lifecycle.current.mounted = true
		invalidate()
		return () => {
			lifecycle.current.mounted = false
			invalidate()
		}
	}, [sessionStore, invalidate])

	const signedInState = useCallback(
		(session: OpenAIOAuthSession): SignInWithChatGPTState => ({
			status: "signed-in",
			session,
			error: null,
		}),
		[],
	)

	const setLoginState = useCallback(
		(next: SignInWithChatGPTState) => {
			setState(next)
			onStateChangeRef.current?.(next)
		},
		[onStateChangeRef],
	)

	const fail = useCallback(
		(error: unknown, code?: SignInWithChatGPTError["code"]) => {
			const loginError = toLoginError(error, code)
			setLoginState({
				status: "error",
				session: null,
				error: loginError,
			})
			onErrorRef.current?.(loginError)
		},
		[onErrorRef, setLoginState],
	)

	const loadStoredSession = useCallback(async () => {
		const generation = invalidate()
		try {
			const session = await sessionStore.get()
			if (!isCurrent(generation)) return
			if (!session) {
				setLoginState(signedOutState)
				return
			}
			const next = signedInState(session)
			setLoginState(next)
			onSuccessRef.current?.(session)
		} catch (error) {
			if (isCurrent(generation)) fail(error)
		}
	}, [
		sessionStore,
		onSuccessRef,
		setLoginState,
		signedInState,
		invalidate,
		isCurrent,
		fail,
	])

	const completeCallback = useCallback(async (): Promise<boolean> => {
		if (!isBrowser()) {
			return false
		}

		const generation = lifecycle.current.generation
		const controller = new AbortController()
		activeRequests.current.add(controller)
		let session: OpenAIOAuthSession | null
		try {
			session = await completeLogin({
				clientId,
				fetch: fetchImpl,
				issuer,
				now,
				sessionStore,
				tokenUrl,
				signal: controller.signal,
			})
		} catch (error) {
			if (!isCurrent(generation)) return true
			throw error
		} finally {
			activeRequests.current.delete(controller)
		}
		if (!isCurrent(generation)) return true
		if (!session) {
			return false
		}

		const next = signedInState(session)
		setLoginState(next)
		onSuccessRef.current?.(session)
		notifyOpener()
		return true
	}, [
		clientId,
		fetchImpl,
		issuer,
		now,
		sessionStore,
		tokenUrl,
		onSuccessRef,
		setLoginState,
		signedInState,
		isCurrent,
	])

	useEffect(() => {
		if (!isBrowser()) {
			setLoginState(signedOutState)
			return
		}

		let current = true
		void (async () => {
			let completed = false
			try {
				completed = await completeCallback()
			} catch (error) {
				if (current) {
					fail(error, "invalid-callback")
				}
				return
			}
			if (!current || completed) {
				return
			}
			try {
				await loadStoredSession()
			} catch (error) {
				if (current) {
					fail(error)
				}
			}
		})()

		return () => {
			current = false
		}
	}, [completeCallback, fail, loadStoredSession, setLoginState])

	useEffect(() => {
		if (!isBrowser()) {
			return
		}

		const onMessage = (event: MessageEvent) => {
			if (
				event.origin === window.location.origin &&
				typeof event.data === "object" &&
				event.data !== null &&
				"type" in event.data &&
				event.data.type === popupMessageType
			) {
				void loadStoredSession()
			}
		}

		window.addEventListener("message", onMessage)
		return () => window.removeEventListener("message", onMessage)
	}, [loadStoredSession])

	const login = useCallback(async () => {
		if (!isBrowser()) {
			fail(new Error("Sign in with ChatGPT can only start in a browser."))
			return
		}

		const generation = invalidate()
		try {
			if (state.status !== "needs-extension") {
				setLoginState({
					status: "starting",
					session: null,
					error: null,
				})
			}

			const result = await startLogin({
				sessionStore,
				callbackPath,
				clientId,
				codeVerifier,
				extraParams,
				idTokenAddOrganizations,
				issuer,
				openMode,
				redirectUri,
				scope,
				simplifiedFlow,
				state: configuredState,
			})
			if (!isCurrent(generation)) return
			if (result.status === "needs-extension") {
				setLoginState(needsExtensionState(result.installUrl))
				return
			}

			setLoginState({
				status: "redirecting",
				session: null,
				error: null,
			})
		} catch (error) {
			if (!isCurrent(generation)) return
			fail(
				error,
				error instanceof Error &&
					error.message === "The ChatGPT login popup was blocked."
					? "popup-blocked"
					: undefined,
			)
		}
	}, [
		callbackPath,
		clientId,
		codeVerifier,
		configuredState,
		extraParams,
		fail,
		idTokenAddOrganizations,
		issuer,
		openMode,
		redirectUri,
		scope,
		sessionStore,
		setLoginState,
		simplifiedFlow,
		state.status,
		invalidate,
		isCurrent,
	])

	const logout = useCallback(async () => {
		const generation = invalidate()
		await clearLogin({ sessionStore })
		if (isCurrent(generation)) setLoginState(signedOutState)
	}, [sessionStore, setLoginState, invalidate, isCurrent])

	const refresh = useCallback((): Promise<OpenAIOAuthSession | null> => {
		const generation = lifecycle.current.generation
		if (refreshRequest.current?.generation === generation) {
			return refreshRequest.current.promise
		}
		const controller = new AbortController()
		activeRequests.current.add(controller)
		const promise = (async () => {
			try {
				// Read the authoritative store, not a possibly stale rendered session.
				const nextSession = await refreshStoredSession({
					sessionStore,
					clientId,
					fetch: fetchImpl,
					issuer,
					now,
					tokenUrl,
					signal: controller.signal,
				})
				if (!isCurrent(generation)) return null
				if (!nextSession) {
					setLoginState(signedOutState)
					return null
				}
				setLoginState(signedInState(nextSession))
				onSuccessRef.current?.(nextSession)
				return nextSession
			} catch (error) {
				if (isCurrent(generation)) fail(error)
				return null
			} finally {
				activeRequests.current.delete(controller)
				if (refreshRequest.current?.generation === generation)
					refreshRequest.current = null
			}
		})()
		refreshRequest.current = { generation, promise }
		return promise
	}, [
		clientId,
		fail,
		fetchImpl,
		issuer,
		now,
		onSuccessRef,
		sessionStore,
		setLoginState,
		signedInState,
		tokenUrl,
		isCurrent,
	])

	const reset = logout

	return {
		...state,
		isSignedIn: state.status === "signed-in",
		login,
		logout,
		refresh,
		reset,
	}
}
