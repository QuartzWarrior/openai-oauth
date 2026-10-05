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
} from "./account-state.js"
import { ChatGptCookieJar, withChatGptCookies } from "./cookie-jar.js"
import { weightedLoad } from "./inflight-tracker.js"
import {
	type CodexUsageSnapshot,
	evaluateUsageBlock,
	type PoolQuotaStats,
	parseCodexQuotaEvent,
	parseCodexQuotaHeaders,
	QuotaStore,
	type UsageBlock,
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
	codexUsageUrl,
	fetchCodexUsage,
	UsageProbeScheduler,
} from "./usage-probe.js"
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
	/**
	 * Spread one `/wham/usage` probe per account over this startup window
	 * (default 120 seconds); false skips startup probes.
	 */
	startupProbeWindowMs?: number | false
	/** Re-probe cadence (±20%) for usage-blocked accounts (default 1 hour). */
	blockedProbeMs?: number | false
	/**
	 * Accounts at or above this used percent on either window are only picked
	 * when no account below it is available (default 95; 100 disables).
	 */
	usageReservePercent?: number
	/** Replay fresh requests on another account after a quota/429 (default true). */
	failoverOnUsageLimit?: boolean
	/** Test hook for probe jitter. */
	random?: () => number
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
	usage: PoolUsageStats
}

export type PoolUsageStats = {
	blocked: boolean
	blockedReason?: string
	/** Unix epoch ms of the saturated window's reset, when known. */
	blockedUntil?: number
	/** At or above `usageReservePercent`; only picked when nothing else is free. */
	reserve: boolean
	nextProbeAt?: number
	observedAt?: number
	source?: UsageSource
}

type UsageSource = "probe" | "headers" | "event" | "response"

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
	cookies: ChatGptCookieJar
	usage: {
		blocked: boolean
		blockedUntil?: number
		blockedReason?: string
		observedAt?: number
		source?: UsageSource
	}
	probe: {
		url: string
		fetch: FetchFunction
		versionFetch: FetchFunction
		headers?: Record<string, string>
		terminalToken?: string
	}
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

/** Pool-wide admission failure; not attributable to any one account. */
class PoolCapacityError extends InferenceError {
	constructor(message: string) {
		super({ category: "capacity" })
		this.message = message
	}
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
	const startupProbeWindowMs = config.startupProbeWindowMs ?? 120_000
	const blockedProbeMs = config.blockedProbeMs ?? 3_600_000
	for (const [name, value] of Object.entries({
		startupProbeWindowMs,
		blockedProbeMs,
	}))
		if (value !== false && (!Number.isSafeInteger(value) || value <= 0))
			throw new Error(`Invalid pool ${name}.`)
	const reservePercent = config.usageReservePercent ?? 95
	if (
		typeof reservePercent !== "number" ||
		!Number.isFinite(reservePercent) ||
		reservePercent <= 0 ||
		reservePercent > 100
	)
		throw new Error("Invalid pool usageReservePercent.")
	const failoverOnUsageLimit = config.failoverOnUsageLimit ?? true
	let usageScheduler: UsageProbeScheduler<PoolAccount> | undefined
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
			// Per-account ChatGPT infrastructure cookies, shared by HTTP and WS.
			const cookies = new ChatGptCookieJar(now)
			const cookieFetch = withChatGptCookies(runtime.fetch, cookies)
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
						cookies,
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
					cookies,
					usage: { blocked: false },
					probe: {
						url: codexUsageUrl(accountConfig.baseURL ?? config.baseURL),
						fetch: cookieFetch,
						versionFetch: accountConfig.refreshFetch ?? runtime.fetch,
						headers: accountConfig.headers,
						terminalToken,
					},
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
							account.usage = { blocked: false }
							usageScheduler?.cancel(account)
							account.lastRate = undefined
							account.quota.clear()
							account.conversationIds.clear()
							account.turnStates.clear()
							account.cookies.clear()
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
					fetch: cookieFetch,
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
							const response = await cookieFetch(url, requestInit)
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
								routingHint: headers.get("x-codex-routing-hint") ?? undefined,
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
		if (error.category === "quota")
			blockUsage(
				account,
				{
					until:
						error.retryAt !== undefined && error.retryAt > now()
							? error.retryAt
							: undefined,
					reason: `usage limit reached${error.code ? ` (${error.code})` : ""}`,
				},
				"response",
			)
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
		observeUsage(account, "event")
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
			if (!account.usage.blocked)
				account.health = { unavailableUntil: 0, consecutiveFailures: 0 }
			if (rate) observeUsage(account, "headers")
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
	const blockUsage = (
		account: PoolAccount,
		block: UsageBlock,
		source: UsageSource,
	): void => {
		const until = block.until ?? now() + (blockedProbeMs || 3_600_000)
		account.usage = {
			blocked: true,
			blockedUntil: block.until,
			blockedReason: block.reason,
			observedAt: now(),
			source,
		}
		account.health.unavailableUntil =
			source === "probe"
				? until
				: Math.max(account.health.unavailableUntil, until)
		account.health.unavailableReason = block.reason
		// Keep an armed timer: repeated observations must not postpone it.
		if (usageScheduler?.nextProbeAt(account) === undefined)
			usageScheduler?.scheduleBlocked(account)
	}
	const unblockUsage = (account: PoolAccount, source: UsageSource): void => {
		if (
			account.usage.blocked &&
			account.health.unavailableReason === account.usage.blockedReason
		) {
			account.health.unavailableUntil = 0
			account.health.consecutiveFailures = 0
			account.health.unavailableReason = undefined
		}
		account.usage = { blocked: false, observedAt: now(), source }
		usageScheduler?.cancel(account)
		notify()
	}
	/** A known reset re-admits the account without a probe. */
	const refreshUsageBlocks = (): void => {
		for (const account of accounts)
			if (
				account.usage.blocked &&
				account.usage.blockedUntil !== undefined &&
				account.usage.blockedUntil <= now()
			) {
				account.usage = { ...account.usage, blocked: false }
				usageScheduler?.cancel(account)
			}
	}
	/** Header/event windows at 100% block immediately, without a probe. */
	const observeUsage = (account: PoolAccount, source: UsageSource): void => {
		const rate = account.lastRate
		const credits = account.quota.snapshot(now())?.credits
		const block = evaluateUsageBlock(
			{
				primary:
					rate?.primaryUsedPercent === undefined
						? undefined
						: {
								usedPercent: rate.primaryUsedPercent,
								resetAt: rate.primaryResetAt,
							},
				secondary:
					rate?.secondaryUsedPercent === undefined
						? undefined
						: {
								usedPercent: rate.secondaryUsedPercent,
								resetAt: rate.secondaryResetAt,
							},
				credits,
			},
			now(),
		)
		if (block) blockUsage(account, block, source)
		else if (rate)
			account.usage = { ...account.usage, observedAt: now(), source }
	}
	const rateFromUsage = (snapshot: CodexUsageSnapshot): CodexRateSnapshot => ({
		observedAt: snapshot.observedAt,
		primaryUsedPercent: snapshot.primary?.usedPercent,
		secondaryUsedPercent: snapshot.secondary?.usedPercent,
		primaryWindowMinutes: snapshot.primary?.windowMinutes,
		secondaryWindowMinutes: snapshot.secondary?.windowMinutes,
		primaryResetAt: snapshot.primary?.resetAt,
		secondaryResetAt: snapshot.secondary?.resetAt,
		planType: snapshot.planType,
	})
	const probeUsage = async (account: PoolAccount): Promise<void> => {
		const signal = healthRefreshLifecycle.signal
		try {
			if (closed || signal.aborted) return
			await refreshQuarantines()
			if (account.quarantineVersion !== undefined) return
			let session: OpenAIOAuthSession | null
			try {
				session = await abortable(account.lockedGetSession(), signal)
			} catch (error) {
				if (!signal.aborted) markError(account, error)
				return
			}
			if (!session || closed || signal.aborted) return
			const codexVersion = await resolveCodexClientVersion({
				codexVersion: config.codexVersion,
				fetchImpl: account.probe.versionFetch,
				signal,
			}).catch(() => DEFAULT_CODEX_CLIENT_VERSION)
			const result = await fetchCodexUsage({
				fetch: account.probe.fetch,
				url: account.probe.url,
				session,
				headers: account.probe.headers,
				codexVersion,
				terminalToken: account.probe.terminalToken,
				signal,
				now,
			}).catch(() => undefined)
			// The credential owner may have changed while the probe was in flight.
			if (!result || !owns(account, session) || closed || signal.aborted) return
			if (result.kind === "ok") {
				for (const update of result.snapshot.updates)
					account.quota.update(update)
				account.lastRate = rateFromUsage(result.snapshot)
				const block = evaluateUsageBlock(result.snapshot, now())
				if (block) blockUsage(account, block, "probe")
				else unblockUsage(account, "probe")
				return
			}
			// Only an authentication rejection says anything about the account;
			// probe throttling, server errors and bad payloads never bench it.
			if (result.kind === "http" && result.status === 401) {
				const failure = computeUnavailability({
					status: result.status,
					headers: result.headers,
					bodyText: result.bodyText,
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
		} finally {
			if (
				account.usage.blocked &&
				usageScheduler?.nextProbeAt(account) === undefined
			)
				usageScheduler?.scheduleBlocked(account)
		}
	}
	/** Utilization only falls when its window resets; no time-based staleness. */
	const utilization = (account: PoolAccount) => {
		const rate = account.lastRate
		const at = now()
		const value = (used?: number, resetAt?: number) =>
			used === undefined || (resetAt !== undefined && resetAt <= at) ? 0 : used
		const primary = value(rate?.primaryUsedPercent, rate?.primaryResetAt)
		const secondary = value(rate?.secondaryUsedPercent, rate?.secondaryResetAt)
		return { primary, secondary, max: Math.max(primary, secondary) }
	}
	const inReserve = (account: PoolAccount): boolean =>
		reservePercent < 100 && utilization(account).max >= reservePercent
	const available = (account: PoolAccount): boolean =>
		account.quarantineVersion === undefined &&
		isAccountAvailable(account.health, now()) &&
		account.inflight < maxInflight
	const pick = (
		exclude?: ReadonlySet<PoolAccount>,
	): PoolAccount | undefined => {
		let best: PoolAccount | undefined
		let bestKey: number[] = []
		for (const account of accounts) {
			if (!available(account) || exclude?.has(account)) continue
			const usage = utilization(account)
			// Reserve tier first, then weighted load, then weekly then 5h headroom.
			const key = [
				inReserve(account) ? 1 : 0,
				weightedLoad(account.inflight, account.weight),
				usage.secondary,
				usage.primary,
			]
			const index = key.findIndex((value, at) => value !== bestKey[at])
			if (!best || (index >= 0 && (key[index] ?? 0) < (bestKey[index] ?? 0))) {
				best = account
				bestKey = key
			}
		}
		return best
	}
	const acquire = async (
		prefer?: PoolAccount,
		signal?: AbortSignal,
		exclude?: ReadonlySet<PoolAccount>,
	): Promise<PoolAccount> => {
		const started = Date.now()
		for (;;) {
			if (closed) throw new Error("Pool is closed.")
			await refreshQuarantines()
			refreshUsageBlocks()
			if (signal?.aborted) throw abortReason(signal)
			const account = prefer
				? available(prefer)
					? prefer
					: undefined
				: pick(exclude)
			if (account) {
				account.inflight += 1
				return account
			}
			const candidates = prefer
				? [prefer]
				: accounts.filter((item) => !exclude?.has(item))
			if (candidates.length === 0)
				throw new PoolCapacityError("No untried pool account remains.")
			if (waiters.size >= maxQueued)
				throw new PoolCapacityError("Pool admission queue is full.")
			const remaining = queueTimeout - (Date.now() - started)
			if (remaining <= 0)
				throw new PoolCapacityError("Timed out waiting for pool capacity.")
			// Every candidate is cooling down past the admission budget, so waiting
			// cannot succeed; fail now and let the caller route elsewhere.
			const earliest = Math.min(
				...candidates.map((item) =>
					item.quarantineVersion === undefined
						? item.health.unavailableUntil - now()
						: 0,
				),
			)
			if (earliest > remaining)
				throw new InferenceError({
					category: "throttled",
					retryAt: now() + earliest,
				})
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
		type Attempt =
			| { kind: "done"; response: Response }
			| { kind: "retry"; response?: Response; error?: unknown }
		// One dispatch on one account. With `canRetry`, an account-scoped quota or
		// throttling failure before any output releases the lease and asks the
		// caller to try another account instead of surfacing the error.
		const attempt = async (
			account: PoolAccount,
			headers: Headers,
			canRetry: boolean,
		): Promise<Attempt> => {
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
						...(outgoingBody instanceof ReadableStream
							? { duplex: "half" }
							: {}),
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
					if (rate) {
						account.lastRate = rate
						observeUsage(account, "headers")
					}
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
						const rate = parseCodexRateHeaders(response.headers, now())
						if (rate) account.lastRate = rate
						let parsedError: unknown
						try {
							parsedError = errorText ? JSON.parse(errorText) : undefined
						} catch {}
						const classified = parseInferenceError(parsedError, {
							status: response.status,
							headers: response.headers,
							now: now(),
						})
						if (classified.category === "quota")
							blockUsage(
								account,
								{
									until:
										classified.retryAt !== undefined &&
										classified.retryAt > now()
											? classified.retryAt
											: undefined,
									reason: `usage limit reached${classified.code ? ` (${classified.code})` : ""}`,
								},
								"response",
							)
						else observeUsage(account, "headers")
					}
					if (failure?.retriableOnOtherAccount && canRetry && !signal.aborted)
						return { kind: "retry", response }
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
				return { kind: "done", response: result }
			} catch (error) {
				if (!signal.aborted) markError(account, error, selectedSession)
				if (
					canRetry &&
					!signal.aborted &&
					error instanceof InferenceError &&
					!error.responseStarted &&
					(error.category === "quota" || error.category === "throttled")
				)
					return { kind: "retry", error }
				throw error
			} finally {
				if (!handedOff) {
					requestContexts.delete(contextId)
					release(account)
				}
			}
		}
		// A binding owner never fails over; only complete, buffered fresh
		// Responses requests can be replayed on another account.
		const fresh = responses && !owner && failoverOnUsageLimit
		const tried = new Set<PoolAccount>()
		let pending: Extract<Attempt, { kind: "retry" }> | undefined
		const surface = (failed: Extract<Attempt, { kind: "retry" }>): Response => {
			if (failed.response) return failed.response
			throw failed.error
		}
		for (;;) {
			let account: PoolAccount
			try {
				// Identical-request affinity is only a hint. A response-id owner is binding.
				account = await acquire(
					owner
						? owner.account
						: tried.size === 0 &&
								preferred &&
								preferred.inflight === 0 &&
								available(preferred) &&
								!inReserve(preferred)
							? preferred
							: undefined,
					signal,
					tried,
				)
			} catch (error) {
				// No other account can take it now; return the original failure.
				if (pending && !signal.aborted) return surface(pending)
				throw error
			}
			if (pending?.response)
				void pending.response.body?.cancel().catch(() => undefined)
			pending = undefined
			tried.add(account)
			const outcome = await attempt(
				account,
				new Headers(headers),
				fresh && tried.size < accounts.length,
			)
			if (outcome.kind === "done") return outcome.response
			pending = outcome
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
	usageScheduler = new UsageProbeScheduler<PoolAccount>(
		{
			startupWindowMs: startupProbeWindowMs,
			blockedProbeMs,
			random: config.random,
			now,
		},
		probeUsage,
	)
	usageScheduler.start(accounts)
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
				usage: {
					blocked:
						account.usage.blocked &&
						(account.usage.blockedUntil === undefined ||
							account.usage.blockedUntil > now()),
					blockedReason: account.usage.blockedReason,
					blockedUntil: account.usage.blockedUntil,
					reserve: inReserve(account),
					nextProbeAt: usageScheduler?.nextProbeAt(account),
					observedAt: account.usage.observedAt,
					source: account.usage.source,
				},
			})),
		close: async () => {
			closed = true
			stopHealthRefresh()
			usageScheduler?.stop()
			notify()
		},
		destroy: () => {
			closed = true
			stopHealthRefresh()
			usageScheduler?.stop()
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
