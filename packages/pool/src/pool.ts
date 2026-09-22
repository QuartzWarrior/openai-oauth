import { promises as fs } from "node:fs"
import {
	buildCodexUserAgent,
	type CodexModelCatalogSnapshot,
	createOpenAIOAuthTransport,
	DEFAULT_CODEX_CLIENT_VERSION,
	DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
	type FetchFunction,
	type GetModelCatalogOptions,
	InferenceError,
	OAuthTokenError,
	type OpenAIOAuth,
	type OpenAIOAuthSession,
	type OpenAIOAuthTransport,
	parseInferenceError,
	pickCodexTerminalToken,
	randomUUIDv7,
	resolveCodexClientVersion,
} from "@openai-oauth/core"
import { AuthRefreshTimeoutError, openaiCredentials } from "@openai-oauth/local"
import {
	readAuthInstallationId,
	saveAuthInstallationId,
} from "@openai-oauth/local/auth-file"
import {
	type AccountHealth,
	type CodexRateSnapshot,
	computeUnavailability,
	isAccountAvailable,
	parseCodexRateHeaders,
	rateSnapshotUtilization,
} from "./account-state.js"
import { weightedLoad } from "./inflight-tracker.js"
import {
	type PoolQuotaStats,
	parseCodexQuotaEvent,
	parseCodexQuotaHeaders,
	QuotaStore,
} from "./quota.js"
import { observeResponse } from "./response-id.js"
import {
	type AccountRuntime,
	createPlainRuntime,
	createProxyRuntime,
} from "./runtime.js"
import {
	computeSessionHash,
	ReplayMap,
	type ReplayMapOptions,
} from "./session-hash.js"
import {
	createWebsocketTransport,
	type WebsocketTransport,
} from "./websocket-transport.js"

type JsonRecord = Record<string, unknown>
const isRecord = (value: unknown): value is JsonRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value)

export type PoolAccountConfig = {
	name?: string
	/** Use one credential file per authorized account. */
	authFilePath: string
	/** Persisted installation identity; existing values are preserved. */
	installationId?: string
	preferNativeInstallationId?: boolean
	varyUserAgent?: boolean
	terminalToken?: string
	/** Dedicated HTTP(S) proxy; unsupported dispatchers fail closed. */
	proxy?: string
	weight?: number
	/** A custom fetch owns the account's network route. */
	fetch?: FetchFunction
	refreshFetch?: FetchFunction
	clientId?: string
	issuer?: string
	tokenUrl?: string
	headers?: Record<string, string>
	instructions?: string
	baseURL?: string
	/** Configured proxy/custom fetch routes deliberately use HTTP. */
	transport?: "http" | "websocket"
}

export type PoolConfig = {
	accounts: PoolAccountConfig[]
	codexVersion?: string
	instructions?: string
	baseURL?: string
	openAIBaseURL?: string
	/** Deprecated: quota/auth failures are returned, never replayed across accounts. */
	retryOnOtherAccount?: boolean
	rotateIdentity?: boolean
	replay?: ReplayMapOptions
	now?: () => number
	/** Stream-lifetime concurrency limit, per account (default 128). */
	maxInflightPerAccount?: number
	/** Maximum requests waiting for a slot or cooldown (default 1024). */
	maxQueuedRequests?: number
	/** Maximum queued wait before rejecting (default 300 seconds). */
	queueTimeoutMs?: number
	/** Maximum request body inspected by the pool (default 8 MiB). */
	maxRequestBodyBytes?: number
	/** Opt-in authenticated account health refresh; true means every 60 seconds. */
	healthRefreshMs?: true | number
}

export type PoolAccountStats = {
	name: string
	accountId?: string
	installationId: string
	transport: "http" | "websocket"
	healthy: boolean
	inflight: number
	cooldownRemainingMs: number
	consecutiveFailures: number
	codex?: CodexRateSnapshot
	/** Bounded owner-scoped observations; named meters do not affect scheduling. */
	quota?: PoolQuotaStats
}

export type PoolModelCatalogSnapshot = CodexModelCatalogSnapshot & {
	accountName: string
}

export type OpenAIPool = OpenAIOAuth & {
	transport: OpenAIOAuthTransport
	/** Inspect one configured account, without selecting an inference owner. */
	getModelCatalog(
		accountName: string,
		options?: GetModelCatalogOptions,
	): Promise<PoolModelCatalogSnapshot>
	stats(): PoolAccountStats[]
	/** Reject new/queued work; allow current HTTP streams to finish. */
	close(): Promise<void>
	/** Close all transports and reject new/queued work. */
	destroy(): Promise<void>
}

type PoolAccount = {
	name: string
	installationId: string
	weight: number
	inflight: number
	health: AccountHealth
	lastRate?: CodexRateSnapshot
	quota: QuotaStore
	authFilePath: string
	credentialVersion?: string
	quarantineVersion?: string
	lastSession: OpenAIOAuthSession | null
	transportFetch: FetchFunction
	getModelCatalog?: OpenAIOAuthTransport["getModelCatalog"]
	lockedGetSession: () => Promise<OpenAIOAuthSession | null>
	conversationIds: ReplayMap<string>
	turnStates: ReplayMap<string>
	wsTransport?: WebsocketTransport
	runtime: AccountRuntime
}

type Owner = {
	account: PoolAccount
	accountId: string
	isFedRamp: boolean
	conversation: string
}
const REQUEST_CONTEXT_HEADER = "x-pool-request-context"
const EXPECTED_ACCOUNT_HEADER = "x-pool-expected-account-id"
const CONVERSATION_HEADER = "x-pool-conversation-id"
const TURN_HEADER = "x-pool-turn-id"
const MAX_ERROR_BODY_BYTES = 4096
const abortReason = (signal?: AbortSignal): unknown =>
	signal?.reason ?? new DOMException("Aborted", "AbortError")

const abortable = <T>(
	promise: Promise<T>,
	signal?: AbortSignal,
): Promise<T> => {
	if (!signal) return promise
	if (signal.aborted) return Promise.reject(abortReason(signal))
	return new Promise((resolve, reject) => {
		const abort = () => reject(abortReason(signal))
		signal.addEventListener("abort", abort, { once: true })
		void promise
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", abort))
	})
}

/** Keep the queue tail fulfilled even when one caller's operation fails. */
const createLockedGetSession = (
	getSession: () => Promise<OpenAIOAuthSession | null>,
	onSession: (session: OpenAIOAuthSession | null) => void,
): (() => Promise<OpenAIOAuthSession | null>) => {
	let tail: Promise<void> = Promise.resolve()
	return () => {
		const next = tail.then(async () => {
			const session = await getSession()
			onSession(session)
			return session
		})
		tail = next.then(
			() => undefined,
			() => undefined,
		)
		return next
	}
}

const readBounded = async (
	stream: ReadableStream<Uint8Array>,
	limit: number,
	truncate = false,
	signal?: AbortSignal,
): Promise<string> => {
	const reader = stream.getReader()
	const abort = () => {
		void reader.cancel(abortReason(signal)).catch(() => undefined)
	}
	signal?.addEventListener("abort", abort, { once: true })
	if (signal?.aborted) abort()
	const decoder = new TextDecoder()
	let size = 0
	let text = ""
	try {
		for (;;) {
			const { value, done } = await reader.read()
			if (signal?.aborted) throw abortReason(signal)
			if (done) return text + decoder.decode()
			const remaining = limit - size
			if (value.byteLength > remaining) {
				void reader.cancel().catch(() => undefined)
				if (truncate) return text + decoder.decode(value.subarray(0, remaining))
				throw new Error("Pool request body exceeds the configured size limit.")
			}
			size += value.byteLength
			text += decoder.decode(value, { stream: true })
		}
	} finally {
		signal?.removeEventListener("abort", abort)
		reader.releaseLock()
	}
}

const credentialVersion = async (filePath: string): Promise<string> => {
	try {
		const stat = await fs.stat(filePath, { bigint: true })
		return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
	} catch {
		return "unavailable"
	}
}
const owns = (account: PoolAccount, session: OpenAIOAuthSession): boolean =>
	account.lastSession?.accountId === session.accountId &&
	(account.lastSession?.isFedRamp === true) === (session.isFedRamp === true)

export const createOpenAIPool = async (
	config: PoolConfig,
): Promise<OpenAIPool> => {
	if (!Array.isArray(config.accounts) || config.accounts.length === 0) {
		throw new Error("createOpenAIPool requires at least one account.")
	}
	const now = config.now ?? Date.now
	const maxInflight = config.maxInflightPerAccount ?? 128
	const maxQueued = config.maxQueuedRequests ?? 1024
	const queueTimeout = config.queueTimeoutMs ?? 300_000
	const maxBodyBytes = config.maxRequestBodyBytes ?? 8 * 1024 * 1024
	const healthRefreshMs =
		config.healthRefreshMs === true ? 60_000 : config.healthRefreshMs
	for (const [name, value] of Object.entries({
		maxInflight,
		maxQueued,
		queueTimeout,
		maxBodyBytes,
	})) {
		if (!Number.isSafeInteger(value) || value <= 0)
			throw new Error(`Invalid pool ${name}.`)
	}
	if (
		healthRefreshMs !== undefined &&
		(!Number.isSafeInteger(healthRefreshMs) || healthRefreshMs <= 0)
	)
		throw new Error("Invalid pool healthRefreshMs.")
	const owners = new ReplayMap<Owner>({ ...config.replay, now })
	const affinity = new ReplayMap<PoolAccount>({ ...config.replay, now })
	const conversations = new ReplayMap<Owner>({ ...config.replay, now })
	const waiters = new Set<() => void>()
	const lifecycle = new AbortController()
	const healthRefreshLifecycle = new AbortController()
	const requestContexts = new Map<
		string,
		{ owner: Owner; explicitConversation?: string }
	>()
	let destroying: Promise<void> | undefined
	let closed = false
	const notify = () => {
		for (const wake of [...waiters]) wake()
	}

	const accounts: PoolAccount[] = []
	try {
		for (const [index, accountConfig] of config.accounts.entries()) {
			if (typeof accountConfig.authFilePath !== "string") {
				throw new Error(
					`Pool account #${index} is missing its required authFilePath.`,
				)
			}
			const runtime = accountConfig.fetch
				? createPlainRuntime(accountConfig.fetch)
				: accountConfig.proxy
					? await createProxyRuntime(accountConfig.proxy)
					: createPlainRuntime()
			let wsTransport: WebsocketTransport | undefined
			try {
				const persistedId = await readAuthInstallationId(
					accountConfig.authFilePath,
					{
						preferNative: accountConfig.preferNativeInstallationId === true,
					},
				)
				const installationId =
					accountConfig.installationId ??
					persistedId ??
					globalThis.crypto.randomUUID()
				if (persistedId !== installationId)
					await saveAuthInstallationId(
						accountConfig.authFilePath,
						installationId,
					)
				const terminalToken =
					accountConfig.terminalToken ??
					(accountConfig.varyUserAgent
						? pickCodexTerminalToken(installationId)
						: undefined)
				const credential = openaiCredentials({
					authFilePath: accountConfig.authFilePath,
					signal: lifecycle.signal,
					refreshSignal: lifecycle.signal,
					fetch: accountConfig.refreshFetch ?? runtime.fetch,
					clientId: accountConfig.clientId,
					issuer: accountConfig.issuer,
					tokenUrl: accountConfig.tokenUrl,
					userAgent: async () =>
						accountConfig.headers?.["User-Agent"] ??
						buildCodexUserAgent(
							await resolveCodexClientVersion({
								codexVersion: config.codexVersion,
								fetchImpl: accountConfig.refreshFetch ?? runtime.fetch,
							}).catch(() => DEFAULT_CODEX_CLIENT_VERSION),
							terminalToken,
						),
				})
				// A generic WebSocket constructor cannot honor a fetch-owned route.
				if (
					accountConfig.transport === "websocket" &&
					!accountConfig.proxy &&
					!accountConfig.fetch
				) {
					wsTransport = createWebsocketTransport({
						baseURL: accountConfig.baseURL ?? config.baseURL,
						codexVersion: config.codexVersion,
						headers: accountConfig.headers,
						terminalToken,
						now,
					})
				}
				const account: PoolAccount = {
					name: accountConfig.name ?? `account-${index}`,
					installationId,
					weight: Math.max(1, accountConfig.weight ?? 1),
					inflight: 0,
					health: { unavailableUntil: 0, consecutiveFailures: 0 },
					quota: new QuotaStore(),
					authFilePath: accountConfig.authFilePath,
					lastSession: null,
					conversationIds: new ReplayMap({ ...config.replay, now }),
					turnStates: new ReplayMap({ ...config.replay, now }),
					lockedGetSession: () => Promise.resolve(null),
					transportFetch: runtime.fetch,
					wsTransport,
					runtime,
				}
				account.lockedGetSession = createLockedGetSession(
					async () => {
						account.credentialVersion = await credentialVersion(
							account.authFilePath,
						)
						return credential.getSession()
					},
					(session) => {
						if (
							account.lastSession &&
							(session?.accountId !== account.lastSession.accountId ||
								(session?.isFedRamp === true) !==
									(account.lastSession.isFedRamp === true))
						) {
							account.health = { unavailableUntil: 0, consecutiveFailures: 0 }
							account.lastRate = undefined
							account.quota.clear()
							account.conversationIds.clear()
							account.turnStates.clear()
						}
						account.lastSession = session
					},
				)
				const accountTransport = createOpenAIOAuthTransport({
					auth: account.lockedGetSession,
					baseURL: accountConfig.baseURL ?? config.baseURL,
					openAIBaseURL: config.openAIBaseURL,
					codexVersion: config.codexVersion,
					instructions: accountConfig.instructions ?? config.instructions,
					headers: {
						...accountConfig.headers,
						installation_id: installationId,
					},
					fetch: runtime.fetch,
					terminalToken,
					signal: lifecycle.signal,
					onResponseCompleted: (response, context) => {
						const captured = requestContexts.get(
							context.headers.get(REQUEST_CONTEXT_HEADER) ?? "",
						)
						if (
							!captured ||
							!owns(account, context.session) ||
							lifecycle.signal.aborted
						)
							return
						if (
							response.status === "failed" ||
							response.status === "incomplete"
						) {
							markError(
								account,
								parseInferenceError(response, {
									responseStarted: true,
									now: now(),
								}),
								context.session,
							)
							return
						}
						if (typeof response.id === "string") {
							owners.set(response.id, captured.owner)
							if (captured.explicitConversation)
								conversations.set(captured.explicitConversation, captured.owner)
						}
					},
					onResponseEvent: (event, context) => {
						if (owns(account, context.session) && !lifecycle.signal.aborted)
							recordRateEvent(account, event)
					},
					onResponseError: (error, context) => {
						if (!lifecycle.signal.aborted)
							markError(account, error, context.session)
					},
					onModelCatalogResponse: (response, context) =>
						recordCatalogResponse(account, response, context.session),
					executeResponses: async (url, init, session) => {
						const headers = new Headers(init.headers)
						const expected = headers.get(EXPECTED_ACCOUNT_HEADER)
						headers.delete(EXPECTED_ACCOUNT_HEADER)
						headers.delete(REQUEST_CONTEXT_HEADER)
						headers.delete(REQUEST_CONTEXT_HEADER)
						if (
							expected &&
							expected !==
								JSON.stringify([session.accountId, session.isFedRamp === true])
						)
							throw new Error("Continuation credential owner changed.")
						const requestInit = { ...init, headers }
						if (!account.wsTransport) {
							const response = await runtime.fetch(url, requestInit)
							if (
								owns(account, session) &&
								!lifecycle.signal.aborted &&
								!init.signal?.aborted
							)
								for (const update of parseCodexQuotaHeaders(
									response.headers,
									now(),
								))
									account.quota.update(update)
							return response
						}
						const body: JsonRecord = JSON.parse(String(init.body))
						const metadata = isRecord(body.client_metadata)
							? body.client_metadata
							: {}
						const stream = await account.wsTransport.streamResponse(
							body,
							{
								accountId: session.accountId,
								url,
								isFedRamp: session.isFedRamp === true,
								installationId,
								sessionId: headers.get("session-id") ?? undefined,
								threadId: headers.get("thread-id") ?? undefined,
								windowId: headers.get("x-codex-window-id") ?? undefined,
								turnId:
									typeof metadata.turn_id === "string"
										? metadata.turn_id
										: undefined,
								turnState: headers.get("x-codex-turn-state") ?? undefined,
								signal: init.signal ?? undefined,
								responsesLite:
									headers.get("x-openai-internal-codex-responses-lite") ===
									"true",
							},
							session.accessToken,
						)
						return new Response(stream, {
							headers: { "content-type": "text/event-stream" },
						})
					},
				})
				account.transportFetch = accountTransport.fetch
				account.getModelCatalog = accountTransport.getModelCatalog
				accounts.push(account)
			} catch (error) {
				await wsTransport?.close()
				await runtime.close()
				throw error
			}
		}
	} catch (error) {
		await Promise.all(
			accounts.map(async (account) => {
				await account.wsTransport?.close()
				await account.runtime.close()
			}),
		)
		throw error
	}

	const refreshQuarantines = async () => {
		await Promise.all(
			accounts.map(async (account) => {
				if (account.quarantineVersion === undefined) return
				if (
					(await credentialVersion(account.authFilePath)) !==
					account.quarantineVersion
				) {
					account.quarantineVersion = undefined
					account.health = { unavailableUntil: 0, consecutiveFailures: 0 }
				}
			}),
		)
	}
	const markError = (
		account: PoolAccount,
		error: unknown,
		session?: OpenAIOAuthSession,
	): void => {
		if (session && !owns(account, session)) return
		if (
			error instanceof OAuthTokenError ||
			error instanceof AuthRefreshTimeoutError
		) {
			account.health.consecutiveFailures++
			if (!error.retryable) {
				account.quarantineVersion = account.credentialVersion ?? "unavailable"
				account.health.unavailableReason =
					"Credentials require reauthorization."
			} else {
				account.health.unavailableUntil = Math.max(
					account.health.unavailableUntil,
					now() +
						Math.min(
							60_000,
							5_000 * 2 ** Math.min(account.health.consecutiveFailures - 1, 4),
						),
				)
			}
			return
		}
		if (!(error instanceof InferenceError)) return
		if (
			![
				"authentication",
				"quota",
				"throttled",
				"overloaded",
				"transport",
			].includes(error.category)
		)
			return
		account.health.consecutiveFailures++
		const fallback = Math.min(
			60_000,
			5_000 * 2 ** Math.min(account.health.consecutiveFailures - 1, 4),
		)
		const until =
			error.retryAt !== undefined && Number.isSafeInteger(error.retryAt)
				? error.retryAt
				: now() + fallback
		account.health.unavailableUntil = Math.max(
			account.health.unavailableUntil,
			until,
		)
		account.health.unavailableReason = error.category
	}
	const recordRateEvent = (account: PoolAccount, event: JsonRecord) => {
		const update = parseCodexQuotaEvent(event, now())
		if (!update) return
		account.quota.update(update)
		// Extra meter families are diagnostics, never scheduler utilization.
		if (update.limitId !== "codex") return
		const rate = isRecord(event.rate_limits) ? event.rate_limits : event
		const primary = isRecord(rate.primary) ? rate.primary : undefined
		const secondary = isRecord(rate.secondary) ? rate.secondary : undefined
		const headers = new Headers()
		for (const [name, window] of [
			["primary", primary],
			["secondary", secondary],
		] as const) {
			if (!window) continue
			if (typeof window.used_percent === "number")
				headers.set(`x-codex-${name}-used-percent`, String(window.used_percent))
			if (typeof window.reset_at === "number")
				headers.set(`x-codex-${name}-reset-at`, String(window.reset_at))
		}
		const snapshot = parseCodexRateHeaders(headers, now())
		if (snapshot) account.lastRate = snapshot
	}
	const recordCatalogResponse = (
		account: PoolAccount,
		response: Response,
		session: OpenAIOAuthSession,
	): void => {
		if (!owns(account, session) || lifecycle.signal.aborted || closed) return
		for (const update of parseCodexQuotaHeaders(response.headers, now()))
			account.quota.update(update)
		const rate = parseCodexRateHeaders(response.headers, now())
		if (rate) account.lastRate = rate
		if (response.ok) {
			account.health = { unavailableUntil: 0, consecutiveFailures: 0 }
			return
		}
		const failure = computeUnavailability({
			status: response.status,
			headers: response.headers,
			consecutiveFailures: account.health.consecutiveFailures,
			now: now(),
		})
		if (!failure) return
		account.health.consecutiveFailures += 1
		account.health.unavailableUntil = Math.max(
			account.health.unavailableUntil,
			now() + failure.unavailableMs,
		)
		account.health.unavailableReason = failure.reason
	}
	const available = (account: PoolAccount): boolean =>
		account.quarantineVersion === undefined &&
		isAccountAvailable(account.health, now()) &&
		account.inflight < maxInflight
	const pick = (): PoolAccount | undefined => {
		let best: PoolAccount | undefined
		for (const account of accounts) {
			if (!available(account)) continue
			const load = weightedLoad(account.inflight, account.weight)
			const bestLoad = best
				? weightedLoad(best.inflight, best.weight)
				: Infinity
			if (
				!best ||
				load < bestLoad ||
				(load === bestLoad &&
					rateSnapshotUtilization(account.lastRate, now()) <
						rateSnapshotUtilization(best.lastRate, now()))
			)
				best = account
		}
		return best
	}
	const acquire = async (
		prefer?: PoolAccount,
		signal?: AbortSignal,
	): Promise<PoolAccount> => {
		const started = Date.now()
		for (;;) {
			if (closed) throw new Error("Pool is closed.")
			await refreshQuarantines()
			if (signal?.aborted) throw abortReason(signal)
			const account = prefer ? (available(prefer) ? prefer : undefined) : pick()
			if (account) {
				account.inflight += 1
				return account
			}
			if (waiters.size >= maxQueued)
				throw new Error("Pool admission queue is full.")
			const remaining = queueTimeout - (Date.now() - started)
			if (remaining <= 0)
				throw new Error("Timed out waiting for pool capacity.")
			await new Promise<void>((resolve, reject) => {
				let timer: ReturnType<typeof setTimeout>
				const cleanup = () => {
					clearTimeout(timer)
					waiters.delete(wake)
					signal?.removeEventListener("abort", abort)
				}
				const wake = () => {
					cleanup()
					resolve()
				}
				const abort = () => {
					cleanup()
					reject(abortReason(signal))
				}
				const candidates = prefer ? [prefer] : accounts
				const cooldowns = candidates
					.map((item) => item.health.unavailableUntil - now())
					.filter((delay) => delay > 0)
				const delay = Math.min(
					remaining,
					...cooldowns,
					candidates.some((item) => item.quarantineVersion !== undefined)
						? 1000
						: 2_147_483_647,
				)
				timer = setTimeout(wake, delay)
				waiters.add(wake)
				signal?.addEventListener("abort", abort, { once: true })
				if (signal?.aborted) abort()
			})
		}
	}
	const release = (account: PoolAccount) => {
		account.inflight = Math.max(0, account.inflight - 1)
		notify()
	}

	const poolFetch: FetchFunction = async (input, init) => {
		if (closed) throw new Error("Pool is closed.")
		const request = new Request(input, init)
		const signal = AbortSignal.any([request.signal, lifecycle.signal])
		if (signal.aborted) throw abortReason(signal)
		const headers = new Headers(request.headers)
		const explicitConversation = headers.get(CONVERSATION_HEADER)
		const explicitTurn = headers.get(TURN_HEADER)
		headers.delete(CONVERSATION_HEADER)
		headers.delete(TURN_HEADER)
		headers.delete(EXPECTED_ACCOUNT_HEADER)
		headers.delete(REQUEST_CONTEXT_HEADER)
		// Turn-state supplied by a caller cannot choose account-owned routing.
		headers.delete("x-codex-turn-state")
		const responses = new URL(request.url).pathname.endsWith("/responses")
		const text =
			responses && request.body
				? await abortable(
						readBounded(request.body, maxBodyBytes, false, signal),
						signal,
					)
				: undefined
		let body: JsonRecord = {}
		if (responses) {
			const contentType = headers
				.get("content-type")
				?.split(";")[0]
				?.trim()
				.toLowerCase()
			if (
				request.method !== "POST" ||
				contentType !== "application/json" ||
				!text
			) {
				throw new Error(
					"Pool Responses requests require POST with an application/json object body.",
				)
			}
			let parsed: unknown
			try {
				parsed = JSON.parse(text)
			} catch {
				throw new Error("Pool Responses request body is not valid JSON.")
			}
			if (!isRecord(parsed))
				throw new Error("Pool Responses request body must be a JSON object.")
			body = parsed
			// MIME names are case-insensitive; normalize after validation so every
			// accepted request reaches core preparation and the owner fence.
			headers.set("content-type", "application/json")
		}
		const previousId =
			typeof body.previous_response_id === "string"
				? body.previous_response_id
				: undefined
		const owner = previousId
			? owners.get(previousId)
			: explicitConversation
				? conversations.get(explicitConversation)
				: undefined
		if (previousId && !owner)
			throw new Error(
				"Continuation owner is unknown or expired; provide complete input without previous_response_id.",
			)
		if (
			Array.isArray(body.input) &&
			body.input.some(
				(item) => isRecord(item) && item.type === "item_reference",
			) &&
			!owner
		) {
			throw new Error("Item references require a known continuation owner.")
		}
		const requestHashInput = responses ? computeSessionHash(body) : undefined
		// Retain a fixed-size affinity key, not a copy of every prompt in every map.
		const hash =
			requestHashInput === undefined
				? undefined
				: Array.from(
						new Uint8Array(
							await globalThis.crypto.subtle.digest(
								"SHA-256",
								new TextEncoder().encode(requestHashInput),
							),
						),
						(byte) => byte.toString(16).padStart(2, "0"),
					).join("")
		const conversation =
			owner?.conversation ??
			explicitConversation ??
			hash ??
			globalThis.crypto.randomUUID()
		await refreshQuarantines()
		const preferred = owner?.account ?? (hash ? affinity.get(hash) : undefined)
		// Identical-request affinity is only a hint. A response-id owner is binding.
		const account = await acquire(
			owner
				? owner.account
				: preferred && preferred.inflight === 0 && available(preferred)
					? preferred
					: undefined,
			signal,
		)
		let handedOff = false
		const contextId = globalThis.crypto.randomUUID()
		let selectedSession: OpenAIOAuthSession | undefined
		try {
			const session = await abortable(account.lockedGetSession(), signal)
			if (!session) throw new Error("OpenAI OAuth session not found.")
			selectedSession = session
			if (
				owner &&
				(session.accountId !== owner.accountId ||
					(session.isFedRamp === true) !== owner.isFedRamp)
			)
				throw new Error("Continuation credential owner changed.")
			if (responses) {
				requestContexts.set(contextId, {
					owner: {
						account,
						accountId: session.accountId,
						isFedRamp: session.isFedRamp === true,
						conversation,
					},
					explicitConversation: explicitConversation ?? undefined,
				})
				headers.set(REQUEST_CONTEXT_HEADER, contextId)
				headers.set(
					EXPECTED_ACCOUNT_HEADER,
					JSON.stringify([session.accountId, session.isFedRamp === true]),
				)
				let id = account.conversationIds.get(conversation)
				if (!id) {
					id = randomUUIDv7()
					account.conversationIds.set(conversation, id)
				}
				if (config.rotateIdentity === false) id = account.installationId
				headers.set("session-id", id)
				headers.set("thread-id", id)
				headers.set("x-client-request-id", id)
				headers.set("x-codex-window-id", `${id}:0`)
				if (explicitTurn) {
					const state = account.turnStates.get(
						JSON.stringify([
							session.accountId,
							session.isFedRamp === true,
							conversation,
							explicitTurn,
						]),
					)
					if (state) headers.set("x-codex-turn-state", state)
				}
			}
			const multipart = headers
				.get("content-type")
				?.toLowerCase()
				.startsWith("multipart/form-data")
			let outgoingBody: BodyInit | null | undefined = text
			if (!responses) {
				if (init?.body instanceof FormData) outgoingBody = init.body
				else if (multipart)
					outgoingBody = await abortable(request.formData(), signal)
				else if (
					new URL(request.url).pathname.endsWith("/images/generations") &&
					request.body
				)
					outgoingBody = await readBounded(
						request.body,
						maxBodyBytes,
						false,
						signal,
					)
				else outgoingBody = request.body
			}
			const response = await abortable(
				account.transportFetch(request.url, {
					method: request.method,
					headers,
					body: outgoingBody,
					signal,
					redirect: request.redirect,
					...(outgoingBody instanceof ReadableStream ? { duplex: "half" } : {}),
				}),
				signal,
			)
			if (!responses && owns(account, session) && !signal.aborted) {
				for (const update of parseCodexQuotaHeaders(response.headers, now()))
					account.quota.update(update)
			}
			if (response.ok && owns(account, session)) {
				account.health.consecutiveFailures = 0
				const rate = parseCodexRateHeaders(response.headers, now())
				if (rate) account.lastRate = rate
				if (hash) affinity.set(hash, account)
				if (explicitTurn) {
					const state = response.headers.get("x-codex-turn-state")
					if (state)
						account.turnStates.set(
							JSON.stringify([
								session.accountId,
								session.isFedRamp === true,
								conversation,
								explicitTurn,
							]),
							state,
						)
				}
			} else if (!response.ok) {
				let errorText: string | undefined
				const clone = response.clone()
				if (clone.body)
					errorText = await abortable(
						readBounded(clone.body, MAX_ERROR_BODY_BYTES, true, signal),
						signal,
					).catch(() => undefined)
				const failure = computeUnavailability({
					status: response.status,
					headers: response.headers,
					bodyText: errorText,
					consecutiveFailures: account.health.consecutiveFailures,
					now: now(),
				})
				// Credentials may have changed while awaiting headers or the error body.
				if (failure && owns(account, session)) {
					account.health.consecutiveFailures += 1
					account.health.unavailableUntil = Math.max(
						account.health.unavailableUntil,
						now() + failure.unavailableMs,
					)
					account.health.unavailableReason = failure.reason
				}
			}
			const result = observeResponse(
				response,
				() => {
					requestContexts.delete(contextId)
					release(account)
				},
				signal,
			)
			handedOff = true
			return result
		} catch (error) {
			if (!signal.aborted) markError(account, error, selectedSession)
			throw error
		} finally {
			if (!handedOff) {
				requestContexts.delete(contextId)
				release(account)
			}
		}
	}

	const compatibleBase =
		config.openAIBaseURL ?? DEFAULT_OPENAI_COMPATIBLE_BASE_URL
	let healthRefreshTimer: ReturnType<typeof setTimeout> | undefined
	const stopHealthRefresh = () => {
		if (healthRefreshTimer !== undefined) clearTimeout(healthRefreshTimer)
		healthRefreshTimer = undefined
		if (!healthRefreshLifecycle.signal.aborted)
			healthRefreshLifecycle.abort(
				new DOMException("Pool health refresh stopped.", "AbortError"),
			)
	}
	const scheduleHealthRefresh = (delay = 0) => {
		if (
			healthRefreshMs === undefined ||
			closed ||
			healthRefreshLifecycle.signal.aborted
		)
			return
		healthRefreshTimer = setTimeout(() => {
			healthRefreshTimer = undefined
			void Promise.allSettled(
				accounts.map((account) =>
					account.getModelCatalog?.({
						refresh: true,
						signal: healthRefreshLifecycle.signal,
					}),
				),
			).finally(() => scheduleHealthRefresh(healthRefreshMs))
		}, delay)
		;(healthRefreshTimer as unknown as { unref?: () => void }).unref?.()
	}
	scheduleHealthRefresh()
	const transport: OpenAIOAuthTransport = {
		kind: "openai-compatible",
		baseURL: compatibleBase,
		fetch: poolFetch,
		request: (path, init) =>
			poolFetch(
				/^https?:\/\//.test(path)
					? path
					: new URL(
							path.replace(/^\/v1\//, "").replace(/^\//, ""),
							`${compatibleBase.replace(/\/$/, "")}/`,
						),
				init,
			),
	}
	return {
		transport,
		kind: "openai-oauth",
		baseURL: config.baseURL,
		openAIBaseURL: config.openAIBaseURL,
		instructions: config.instructions,
		fetch: poolFetch,
		getModelCatalog: async (accountName, options = {}) => {
			if (closed) throw new Error("Pool is closed.")
			const matches = accounts.filter((account) => account.name === accountName)
			if (matches.length !== 1)
				throw new Error(
					"Catalog inspection requires one unique configured account name.",
				)
			const account = matches[0]
			if (!account?.getModelCatalog)
				throw new Error("Model catalog inspection is unavailable.")
			const signal = AbortSignal.any([
				lifecycle.signal,
				...(options.signal ? [options.signal] : []),
			])
			signal.throwIfAborted()
			const snapshot = await account.getModelCatalog({ ...options, signal })
			return { ...snapshot, accountName: account.name }
		},
		getSession: async () => {
			await refreshQuarantines()
			const account = await acquire(undefined, lifecycle.signal)
			try {
				return await abortable(account.lockedGetSession(), lifecycle.signal)
			} catch (error) {
				if (!lifecycle.signal.aborted) markError(account, error)
				throw error
			} finally {
				release(account)
			}
		},
		stats: () =>
			accounts.map((account) => ({
				name: account.name,
				accountId: account.lastSession?.accountId,
				installationId: account.installationId,
				transport: account.wsTransport ? "websocket" : "http",
				healthy:
					account.quarantineVersion === undefined &&
					isAccountAvailable(account.health, now()),
				inflight: account.inflight,
				cooldownRemainingMs: Math.max(
					0,
					account.health.unavailableUntil - now(),
				),
				consecutiveFailures: account.health.consecutiveFailures,
				codex: account.lastRate,
				quota: account.quota.snapshot(now()),
			})),
		close: async () => {
			closed = true
			stopHealthRefresh()
			notify()
		},
		destroy: () => {
			closed = true
			stopHealthRefresh()
			lifecycle.abort(new DOMException("Pool destroyed.", "AbortError"))
			notify()
			destroying ??= Promise.all(
				accounts.map(async (account) => {
					await Promise.all([
						account.wsTransport?.close(),
						account.runtime.destroy(),
					])
				}),
			).then(() => undefined)
			return destroying
		},
	}
}
