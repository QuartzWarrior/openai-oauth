import {
	buildCodexUserAgent,
	CodexResponsesState,
	createOpenAIOAuthTransport,
	DEFAULT_CODEX_CLIENT_VERSION,
	type FetchFunction,
	type OpenAIOAuth,
	type OpenAIOAuthSession,
	pickCodexTerminalToken,
	randomUUIDv7,
	resolveCodexClientVersion,
} from "@openai-oauth/core"
import { openaiCredentials } from "@openai-oauth/local"
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
import { forkForResponseIdCapture } from "./response-id.js"
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
	type WebsocketIdentity,
	type WebsocketTransport,
} from "./websocket-transport.js"

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms))

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const randomUUID = (): string => randomUUIDv7()

export type PoolAccountConfig = {
	/** Display name; defaults to `account-<index>`. */
	name?: string
	/**
	 * Codex auth file for this account (typically created with
	 * `openai-oauth login --auth-file <path>`). Every account in the pool must
	 * use a distinct path so tokens never leak between accounts.
	 */
	authFilePath: string
	/**
	 * Device identity for this account. Codex CLI sends one `session-id` header
	 * value per conversation (the thread id it keeps stable for prompt-cache
	 * affinity), so with the default `rotateIdentity` the pool uses this as a
	 * base and derives a fresh, stable device id per conversation hash. Pass an
	 * explicit id to pin the exact device this account presents as; with
	 * `rotateIdentity: false` the same value is sent on every request.
	 */
	installationId?: string
	/**
	 * Claim the genuine codex CLI's installation id on this machine
	 * (`~/.codex/installation_id`) for this account instead of the per-account
	 * id in its auth.json. That file identifies the real CLI's single install, so
	 * for undetectability it should be enabled for at most one account — enabling
	 * it on several would spread one machine-id across many "devices", which the
	 * real CLI never does. Ignored when `installationId` is set explicitly.
	 */
	preferNativeInstallationId?: boolean
	/**
	 * Give this account a stable, distinct Codex User-Agent terminal token,
	 * pinned by its installation id (same value forever). Every candidate is a
	 * token codex could legitimately emit on a headless Linux host — never a
	 * mac/Windows-only program. Defaults to false (uniform `unknown` like a
	 * plain headless TUI). Enable to diversify accounts' UAs without any
	 * impossible value; per-account `headers["User-Agent"]` still overrides.
	 */
	varyUserAgent?: boolean
	/**
	 * Explicit terminal token to append to this account's Codex User-Agent
	 * instead of picking one. Must be locally plausible (e.g. `unknown`,
	 * `xterm-256color`, `tmux-256color`, `kitty`, `WezTerm/<build>`,
	 * `vscode/<ver>`). Takes precedence over `varyUserAgent`.
	 */
	terminalToken?: string
	/**
	 * Static proxy dedicated to this account, e.g.
	 * `http://user:pass@host:8000` or `socks5h://host:1080`. Applied through a
	 * dedicated undici ProxyAgent (Node.js >= 20) so connection pools and
	 * credentials stay fully isolated per account.
	 */
	proxy?: string
	/** Reserved for weighted balancing (e.g. plan tiers). Defaults to 1. */
	weight?: number
	/** Full escape hatch; overrides `proxy` when provided. */
	fetch?: FetchFunction
	/** Defaults to the data-path fetch (so refresh rides the same proxy). */
	refreshFetch?: FetchFunction
	clientId?: string
	issuer?: string
	tokenUrl?: string
	headers?: Record<string, string>
	instructions?: string
	baseURL?: string
	/**
	 * Transport for this account's /responses requests. `"http"` (default) uses
	 * the OAuth transport fetch; `"websocket"` streams responses over a
	 * persistent per-account websocket (Codex's realtime wire), falling back to
	 * HTTP for any request the websocket cannot serve.
	 */
	transport?: "http" | "websocket"
}

export type PoolConfig = {
	accounts: PoolAccountConfig[]
	codexVersion?: string
	instructions?: string
	baseURL?: string
	openAIBaseURL?: string
	/**
	 * Replay one retryable failure (429 / usage-limit class codes) on a
	 * different healthy account. Defaults to true.
	 */
	retryOnOtherAccount?: boolean
	/**
	 * Rotate each account's `session-id` per conversation (default true), the
	 * same lifecycle Codex CLI uses (one thread id per conversation). Disable to
	 * send one literal `installationId` on every request.
	 */
	rotateIdentity?: boolean
	replay?: ReplayMapOptions
	now?: () => number
}

export type PoolAccountStats = {
	name: string
	accountId?: string
	installationId: string
	/** Transport currently carrying this account's /responses traffic. A
	 * websocket account that hard-failed is demoted back to `"http"`. */
	transport: "http" | "websocket"
	healthy: boolean
	inflight: number
	cooldownRemainingMs: number
	consecutiveFailures: number
	codex?: CodexRateSnapshot
}

export type OpenAIPool = OpenAIOAuth & {
	stats(): PoolAccountStats[]
	/** Stop listening for pool events; in-flight fetches still finish. */
	close(): Promise<void>
	/** Close proxy agents actively (call when the app is shutting down). */
	destroy(): Promise<void>
}

type PoolAccount = {
	name: string
	index: number
	installationId: string
	weight: number
	inflight: number
	/** Acquired slots whose attempt hasn't started yet. Counted by the balancer. */
	pendingAssignments: number
	health: AccountHealth
	lastRate: CodexRateSnapshot | undefined
	transportFetch: FetchFunction
	lockedGetSession: () => Promise<OpenAIOAuthSession | null>
	lastSession: OpenAIOAuthSession | null
	/** Stable device id per conversation hash (Codex's per-thread session-id). */
	deviceByConversation: { get(hash: string): string }
	/** Stable thread id per conversation hash (framing ids only). */
	threadByConversation: { get(hash: string): string }
	/** Stable window number per conversation hash (codex numbers windows 0,1,…). */
	windowByConversation: { get(hash: string): string }
	/**
	 * Latest `x-codex-turn-state` captured from a response header, per
	 * conversation. Codex keeps this in a per-turn OnceLock and resends it for
	 * sticky routing; absent on the very first request of a conversation.
	 */
	turnStateByConversation: {
		get(hash: string): string | undefined
		set(hash: string, value: string): void
	}
	/** This account's Responses-state cache (only chains it actually served). */
	responsesState: CodexResponsesState
	/** Swap in a fresh Responses-state + transport so a migrated conversation re-arrives chain-less. */
	beginMigrationFrom(senderState: CodexResponsesState): void
	/** Present only for `transport: "websocket"` accounts; falls back to HTTP on failure. */
	wsTransport?: WebsocketTransport
	/** Access token the websocket connection is currently pinned to. */
	wsAccessToken?: string
	/** True once a websocket attempt hard-failed; demotes the account to HTTP. */
	wsBroken?: boolean
	runtime: AccountRuntime
}

type AttemptOutcome = {
	response: Response
	/** Whether this request may be replayed on a different healthy account. */
	retriable: boolean
	/** Why the attempt failed, when it did (feeds retry-mode classification). */
	reason?: string
}

const MAX_ERROR_BODY_BYTES = 4 * 1024

const decodeBodyText = async (
	body: BodyInit | null | undefined,
): Promise<string | undefined> => {
	if (body == null) {
		return undefined
	}
	if (typeof body === "string") {
		return body
	}
	if (body instanceof URLSearchParams) {
		return body.toString()
	}
	if (body instanceof Blob) {
		return await body.text()
	}
	if (body instanceof ArrayBuffer) {
		return new TextDecoder().decode(body)
	}
	if (ArrayBuffer.isView(body)) {
		return new TextDecoder().decode(body)
	}
	return undefined
}

const readRequestUrl = (input: RequestInfo | URL): string =>
	typeof input === "string"
		? input
		: input instanceof URL
			? input.toString()
			: input.url

const readRequestBody = async (
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<BodyInit | null | undefined> => {
	if (init?.body !== undefined) {
		return init.body
	}
	if (input instanceof Request && input.body != null) {
		const contentType = input.headers.get("content-type") ?? ""
		if (contentType.includes("multipart/form-data")) {
			return undefined
		}
		return await input.clone().text()
	}
	return undefined
}

const requestPathname = (input: RequestInfo | URL): string | undefined => {
	try {
		return new URL(readRequestUrl(input), "https://pool.invalid").pathname
	} catch {
		return undefined
	}
}

const isResponsesRequestTarget = (input: RequestInfo | URL): boolean =>
	requestPathname(input)?.endsWith("/responses") ?? false

const readRequestBodyJson = async (
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Record<string, unknown>> => {
	const text = await decodeBodyText(await readRequestBody(input, init))
	if (typeof text !== "string") {
		return {}
	}
	try {
		const parsed: unknown = JSON.parse(text)
		return isRecord(parsed) ? parsed : {}
	} catch {
		return {}
	}
}

type ParsedResponsesRequest = {
	hash?: string
	previousResponseId?: string
}

const parseResponsesRequest = async (
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<ParsedResponsesRequest> => {
	const method = (
		init?.method ?? (input instanceof Request ? input.method : "GET")
	).toUpperCase()
	if (method === "GET") {
		return {}
	}
	const pathname = requestPathname(input)
	if (!pathname?.endsWith("/responses")) {
		return {}
	}

	const text = await decodeBodyText(await readRequestBody(input, init))
	if (typeof text !== "string") {
		return {}
	}
	try {
		const parsed: unknown = JSON.parse(text)
		if (!isRecord(parsed)) {
			return {}
		}
		return {
			hash: computeSessionHash(parsed),
			previousResponseId:
				typeof parsed.previous_response_id === "string"
					? parsed.previous_response_id
					: undefined,
		}
	} catch {
		return {}
	}
}

const createLockedGetSession = (
	accountName: string,
	getSession: () => Promise<OpenAIOAuthSession | null>,
	onSession: (session: OpenAIOAuthSession | null) => void,
): (() => Promise<OpenAIOAuthSession | null>) => {
	let chain: Promise<OpenAIOAuthSession | null> = Promise.resolve(null)
	return () => {
		// Serialize token loading/refresh so parallel requests on the same
		// account never trigger two refreshes at once.
		const next = chain.then(async () => {
			const session = await getSession()
			onSession(session)
			return session
		})
		chain = next.catch((error) => {
			throw new Error(
				`Pool account "${accountName}" failed to load a session: ${String(error)}`,
			)
		})
		return next
	}
}

export const createOpenAIPool = async (
	config: PoolConfig,
): Promise<OpenAIPool> => {
	const now = config.now ?? (() => Date.now())
	if (!Array.isArray(config.accounts) || config.accounts.length === 0) {
		throw new Error("createOpenAIPool requires at least one account.")
	}

	const replay = new ReplayMap<{
		account: PoolAccount
		previousResponseId?: string
	}>({ ...config.replay, now })
	const retryOnOtherAccount = config.retryOnOtherAccount ?? true
	const rotateIdentity = config.rotateIdentity ?? true
	const waiters = new Set<() => void>()
	const notifyAvailable = (): void => {
		for (const waiter of [...waiters]) {
			waiters.delete(waiter)
			waiter()
		}
	}

	const accounts: PoolAccount[] = await Promise.all(
		config.accounts.map(async (accountConfig, index) => {
			if (typeof accountConfig.authFilePath !== "string") {
				throw new Error(
					`Pool account #${index} is missing its required authFilePath.`,
				)
			}

			// Resolve the installation id early: the UA terminal token (and its
			// deterministic derivation) is pinned by it, and the refresh UA must
			// be decided before the credential loader exists. Persist the base id in
			// the account's auth.json so the same "device" identity survives restarts;
			// an explicit config value always wins and is also persisted so it sticks.
			const persistedId = await readAuthInstallationId(
				accountConfig.authFilePath,
				{ preferNative: accountConfig.preferNativeInstallationId === true },
			)
			const installationId =
				accountConfig.installationId ?? persistedId ?? randomUUID()
			// Each account can present a stable, legitimately-possible Codex UA
			// terminal token. Explicit terminalToken wins; varyUserAgent derives
			// one deterministically from the installation id so the same account
			// always keeps the same UA; default is the headless `unknown`.
			const terminalToken =
				accountConfig.terminalToken ??
				(accountConfig.varyUserAgent === true
					? pickCodexTerminalToken(installationId)
					: undefined)

			const runtime: AccountRuntime = accountConfig.fetch
				? createPlainRuntime(accountConfig.fetch)
				: accountConfig.proxy
					? await createProxyRuntime(accountConfig.proxy)
					: createPlainRuntime()

			// One process-wide Codex UA per account: codex stamps the same UA
			// (its build version + one terminal token) on refresh, /responses,
			// /models and the ws handshake (default_client.rs create_default_auth_client).
			// The refresh UA therefore shares this account's version resolution and
			// terminal token so it can never drift from the data path.
			let accountVersionPromise: Promise<string> | undefined
			const userAgentOf = async (dataPath: boolean): Promise<string> => {
				if (dataPath) {
					// Share this account's version resolution across data-path callers
					// (resolved against npm once, TTL-cached inside core).
					accountVersionPromise ??= resolveCodexClientVersion({
						codexVersion: config.codexVersion,
						fetchImpl: runtime.fetch,
					}).catch(() => DEFAULT_CODEX_CLIENT_VERSION)
					return buildCodexUserAgent(await accountVersionPromise, terminalToken)
				}
				const version = await resolveCodexClientVersion({
					codexVersion: config.codexVersion,
					fetchImpl: accountConfig.refreshFetch ?? runtime.fetch,
				}).catch(() => DEFAULT_CODEX_CLIENT_VERSION)
				return buildCodexUserAgent(version, terminalToken)
			}

			const credential = openaiCredentials({
				authFilePath: accountConfig.authFilePath,
				fetch: accountConfig.refreshFetch ?? runtime.fetch,
				clientId: accountConfig.clientId,
				issuer: accountConfig.issuer,
				tokenUrl: accountConfig.tokenUrl,
				userAgent: () => userAgentOf(false),
			})

			if (persistedId !== installationId) {
				await saveAuthInstallationId(accountConfig.authFilePath, installationId)
			}
			const usesWebsocket = accountConfig.transport === "websocket"

			// The websocket transport mirrors Codex's realtime wire: one persistent
			// connection per account, response.create frames carrying rotated
			// per-conversation session ids, prewarm, ping/pong, and HTTP fallback
			// on any failure.
			const wsTransport = usesWebsocket
				? createWebsocketTransport({
						baseURL: accountConfig.baseURL ?? config.baseURL,
						codexVersion: config.codexVersion,
						headers: accountConfig.headers,
						terminalToken,
						now,
					})
				: undefined

			// One stable device id per (account, conversation). Codex CLI sends a
			// new `session-id` per conversation (thread id, kept for prompt-cache
			// affinity); this map reproduces that lifecycle per account, so the
			// literal installationId never repeats verbatim across unrelated
			// conversations on the same account.
			const deviceByConversation = new ReplayMap<string>({
				ttlMs: config.replay?.ttlMs,
				maxEntries: config.replay?.maxEntries,
				now,
			})
			// One stable thread id per (account, conversation), distinct from the
			// session id — codex threads get their own UUID (its ThreadId), used
			// for `thread-id`/x-client-request-id framing only.
			const threadByConversation = new ReplayMap<string>({
				ttlMs: config.replay?.ttlMs,
				maxEntries: config.replay?.maxEntries,
				now,
			})
			// One window number per (account, conversation): codex numbers a
			// thread's windows 0,1,2,… as the user opens panes, and a pool account
			// is a single long-lived window per conversation, so it stays "0".
			const windowByConversation = new ReplayMap<string>({
				ttlMs: config.replay?.ttlMs,
				maxEntries: config.replay?.maxEntries,
				now,
			})
			// Latest x-codex-turn-state echoed back for sticky routing, per
			// conversation (codex's per-turn OnceLock; refreshed on each response).
			const turnStateByConversation = new ReplayMap<string>({
				ttlMs: config.replay?.ttlMs,
				maxEntries: config.replay?.maxEntries,
				now,
			})

			// This account's Responses-state cache: it mirrors only the chains
			// this account served, so a request replayed here never resolves a
			// foreign account's `previous_response_id`. Migrating a conversation
			// onto this account swaps in a fresh cache (see `beginMigrationFrom`
			// below), so the re-arriving full-input turn doesn't inherit a stale
			// chain reference and re-splits on every turn.
			const account = {} as PoolAccount
			let responsesState = new CodexResponsesState()
			const buildTransport = (): FetchFunction =>
				createOpenAIOAuthTransport({
					auth: () => credential.getSession(),
					baseURL: accountConfig.baseURL ?? config.baseURL,
					openAIBaseURL: config.openAIBaseURL,
					codexVersion: config.codexVersion,
					instructions: accountConfig.instructions ?? config.instructions,
					responsesState,
					headers: {
						...accountConfig.headers,
						// Fallback device identity when no per-conversation value was
						// assigned (or rotation is off).
						session_id: installationId,
						// Carried into the body's client_metadata
						// (x-codex-installation-id) by the core transport — the wire slot
						// Codex uses for the device id — never a standalone header.
						installation_id: installationId,
					},
					fetch: runtime.fetch,
					terminalToken,
				}).fetch
			account.transportFetch = buildTransport()
			/**
			 * Discard this account's Responses-state and rebuild its transport over
			 * a fresh cache, so an incoming migrated conversation re-arrives with
			 * full input and no chain — codex's own compaction re-send shape (its
			 * new chain heads to a fresh `previous_response_id`, never a dead one).
			 * `senderState` is the source account's cache; kept for symmetry with a
			 * real "carry history" hand-off, currently unused.
			 */
			account.beginMigrationFrom = (senderState: CodexResponsesState): void => {
				void senderState
				responsesState = new CodexResponsesState()
				account.responsesState = responsesState
				account.transportFetch = buildTransport()
			}

			Object.assign(account, {
				name: accountConfig.name ?? `account-${index}`,
				index,
				installationId,
				weight: Math.max(1, accountConfig.weight ?? 1),
				inflight: 0,
				pendingAssignments: 0,
				health: { unavailableUntil: 0, consecutiveFailures: 0 },
				lastRate: undefined,
				responsesState,
				lockedGetSession: () => Promise.resolve(null),
				lastSession: null,
				transportFetch: account.transportFetch,
				wsTransport,
				wsAccessToken: undefined,
				wsBroken: false,
				deviceByConversation: {
					get: (hash: string): string => {
						const existing = deviceByConversation.get(hash)
						if (existing !== undefined) {
							return existing
						}
						// Codex's session-id/thread-id/x-client-request-id are bare v4
						// thread UUIDs — nothing else on the wire looks like a thread
						// id. A composite id (installationId+hash+uuid) matches no UUID
						// regex, and it embeds the account's stable installation id in
						// every rotated request — re-linking "rotated" conversations to
						// the device rotation exists to hide. Mint a plain UUID; this map
						// already gives per-conversation stability.
						const derived = randomUUID()
						deviceByConversation.set(hash, derived)
						return derived
					},
				},
				threadByConversation: {
					get: (hash: string): string => {
						const existing = threadByConversation.get(hash)
						if (existing !== undefined) {
							return existing
						}
						const derived = randomUUID()
						threadByConversation.set(hash, derived)
						return derived
					},
				},
				windowByConversation: {
					get: (hash: string): string => {
						const existing = windowByConversation.get(hash)
						if (existing !== undefined) {
							return existing
						}
						// A pool account holds one window per conversation; codex's
						// first window is "0".
						windowByConversation.set(hash, "0")
						return "0"
					},
				},
				turnStateByConversation: {
					get: (hash: string): string | undefined =>
						turnStateByConversation.get(hash),
					set: (hash: string, value: string): void => {
						turnStateByConversation.set(hash, value)
					},
				},
				runtime,
			})
			account.lockedGetSession = createLockedGetSession(
				account.name,
				() => credential.getSession(),
				(session) => {
					account.lastSession = session
				},
			)
			return account
		}),
	)

	const refreshExpiredCooldown = (account: PoolAccount): void => {
		if (
			account.health.unavailableUntil > 0 &&
			account.health.unavailableUntil <= now()
		) {
			account.health.unavailableUntil = 0
			account.health.unavailableReason = undefined
		}
	}

	const healthyAccounts = (exclude?: PoolAccount): PoolAccount[] =>
		accounts.filter((account) => {
			if (account === exclude) {
				return false
			}
			refreshExpiredCooldown(account)
			return isAccountAvailable(account.health, now())
		})

	/**
	 * Rate-limited failover keeps conversation/server-state put for chained
	 * requests UNLESS the pinned account is unavailable — then the conversation
	 * must move or it would stall on a dead account. Codex itself falls back to
	 * full-input + no `previous_response_id` whenever incremental reuse doesn't
	 * match (client.rs: get_incremental_items → None → sends full request.input
	 * with no chain), and its previous_response_not_found recovery resends the
	 * full request — so re-arriving with full input and no chain under a fresh
	 * identity is a genuine codex shape, never a pool tell. Auth failures
	 * (401/403) always migrate.
	 */
	const resolveRetryMode = (
		parsedPreviousResponseId: string | undefined,
		pinned: { previousResponseId?: string } | undefined,
		reason: string | undefined,
		lockedToAccount: boolean,
		pinnedAccountAvailable: boolean,
	): boolean => {
		const isRate = /rate limit|usage limit|quota|throttl/i.test(reason ?? "")
		if (!isRate) {
			// 401/403 etc. are worth moving to another account regardless
			return true
		}
		// Rate/quota limit on the pinned account: migrate when that account is
		// down (the conversation's state holder is gone), otherwise keep the
		// chain on the locked account and take the local Retry-After back-off.
		if (lockedToAccount || parsedPreviousResponseId !== undefined) {
			return !pinnedAccountAvailable
		}
		return pinned === undefined
	}

	const pickAccount = (exclude?: PoolAccount): PoolAccount | undefined => {
		// Least-busy first across actual inflight plus pick reservations (close
		// races between concurrent picks); ties break by observed rate-window
		// saturation. A tiny load jitter keeps several near-equal accounts from
		// falling into a deterministic round-robin — a perfectly phase-locked
		// pick cycle is a schedulers' fingerprint no human traffic produces.
		const candidates = healthyAccounts(exclude)
		let best: PoolAccount | undefined
		let bestScore = Number.POSITIVE_INFINITY
		let bestUtilization = Number.POSITIVE_INFINITY
		for (const account of candidates) {
			const load = weightedLoad(
				account.inflight + account.pendingAssignments,
				account.weight,
			)
			const score = load + Math.random() * 0.01
			const utilization = rateSnapshotUtilization(account.lastRate)
			if (
				best === undefined || Math.abs(score - bestScore) <= 0.01
					? utilization < bestUtilization
					: score < bestScore
			) {
				best = account
				bestScore = score
				bestUtilization = utilization
			}
		}
		return best
	}

	const waitForAvailableAccount = (): Promise<void> =>
		new Promise((resolve) => {
			const recheck = (): void => {
				if (healthyAccounts().length > 0) {
					resolve()
					return
				}
				const delay = Math.max(
					1,
					Math.min(...accounts.map((a) => a.health.unavailableUntil)) - now(),
				)
				setTimeout(() => {
					waiters.delete(recheck)
					recheck()
				}, delay)
				waiters.add(recheck)
			}
			recheck()
		})

	const acquireAccount = async (prefer?: PoolAccount): Promise<PoolAccount> => {
		for (;;) {
			if (prefer) {
				refreshExpiredCooldown(prefer)
				if (isAccountAvailable(prefer.health, now())) {
					// Reserve synchronously, same as the picked path below — the
					// caller always folds the reservation into inflight.
					prefer.pendingAssignments += 1
					return prefer
				}
			}
			const picked = pickAccount()
			if (picked) {
				// Reserve the slot synchronously, before any async work has a
				// chance to interleave a concurrent pick onto the same account.
				picked.pendingAssignments += 1
				return picked
			}
			await waitForAvailableAccount()
		}
	}

	const markSuccess = (account: PoolAccount, headers: Headers): void => {
		account.health.consecutiveFailures = 0
		const snapshot = parseCodexRateHeaders(headers)
		if (snapshot) {
			account.lastRate = snapshot
		}
	}

	const markFailure = async (
		account: PoolAccount,
		response: Response,
	): Promise<{ retriable: boolean; reason?: string }> => {
		let bodyText: string | undefined
		try {
			bodyText = (await response.clone().text()).slice(0, MAX_ERROR_BODY_BYTES)
		} catch {}
		const unavailability = computeUnavailability({
			status: response.status,
			headers: response.headers,
			bodyText,
			consecutiveFailures: account.health.consecutiveFailures,
			now: now(),
		})
		if (!unavailability) {
			return { retriable: false }
		}
		account.health.consecutiveFailures += 1
		account.health.unavailableUntil = now() + unavailability.unavailableMs
		account.health.unavailableReason = unavailability.reason
		return {
			retriable: unavailability.retriableOnOtherAccount,
			reason: unavailability.reason,
		}
	}

	const executeAttempt = async (
		account: PoolAccount,
		input: RequestInfo | URL,
		init: RequestInit | undefined,
		sessionHash: string | undefined,
		recordedPin: boolean,
		migrateChain = false,
	): Promise<AttemptOutcome> => {
		// Codex CLI rotates session-id per conversation. With rotation on, swap in
		// this account's stable per-conversation device id; with it off, the
		// literal installationId set at construction is sent untouched.
		let attemptInit = init
		if (migrateChain) {
			// Migrating to a fresh account: drop the previous account's
			// `previous_response_id` so the conversation re-arrives with full input
			// and no chain — codex's own incremental-mismatch / expired-id recovery
			// shape (sends full request.input, no chain) under this account's
			// distinct identity. The full input already carries the whole history.
			const bodyJson = await readRequestBodyJson(input, attemptInit)
			if (bodyJson.previous_response_id !== undefined) {
				const headers = new Headers(attemptInit?.headers)
				if (!headers.has("content-type")) {
					headers.set("content-type", "application/json")
				}
				const rest = { ...bodyJson }
				delete rest.previous_response_id
				attemptInit = {
					...attemptInit,
					method:
						attemptInit?.method ??
						(input instanceof Request ? input.method : "POST"),
					headers,
					body: JSON.stringify(rest),
				}
			}
		}
		if (rotateIdentity && sessionHash !== undefined) {
			// codex's root session id IS its thread id (session.rs:892 —
			// "session_id is equal to the root thread's ID", SessionId::from(thread_id)
			// in protocol/src/session_id.rs reuses the same UUID). So every header
			// carries the one conversation UUID: session-id, thread-id,
			// x-client-request-id, x-codex-window-id, and the body client_metadata.
			// Minting distinct session/thread ids would read as a non-root (subagent)
			// source the pool never is.
			const conversationId = account.threadByConversation.get(sessionHash)
			const rotatedSession = conversationId
			const rotatedThread = conversationId
			// Codex's sticky-routing token: resent on every request within a turn
			// after it was captured; absent on the conversation's first request.
			const turnState = account.turnStateByConversation.get(sessionHash)
			const stampIdentity = (headers: Headers): Headers => {
				headers.set("session-id", rotatedSession)
				// build_session_headers sends session-id and thread-id side by side
				// (requests/headers.rs:8-11), equal here, and x-client-request-id =
				// the thread id (endpoint/responses.rs:120).
				headers.set("thread-id", rotatedThread)
				headers.set("x-client-request-id", rotatedThread)
				// codex compatibility_headers() inserts x-codex-window-id on every
				// /responses request (responses_metadata.rs:357); value is
				// "<thread_id>:<window_number>" and a pool conversation is codex's
				// first window ":0".
				headers.set("x-codex-window-id", `${rotatedThread}:0`)
				if (turnState !== undefined && !headers.has("x-codex-turn-state")) {
					headers.set("x-codex-turn-state", turnState)
				}
				headers.delete("session_id")
				return headers
			}
			if (init !== undefined) {
				attemptInit = {
					...init,
					headers: stampIdentity(new Headers(init.headers)),
				}
			} else if (typeof input === "string" || input instanceof URL) {
				attemptInit = {
					headers: stampIdentity(new Headers()),
				}
			}
			// input as a Request carries its original init; the literal
			// installationId goes out — rotateIdentity applies to the (init,
			// string, URL) call shapes that dominate SDK usage.
		}

		// Websocket accounts prefer streaming over the persistent connection; any
		// websocket failure demotes to the existing HTTP path for this request and
		// future attempts (a broken ws should never break a request HTTP can serve).
		// Root-session parity (session.rs:892): the conversation id is one UUID;
		// the ws session-id and thread-id carry the same value.
		const threadId =
			sessionHash !== undefined && rotateIdentity
				? account.threadByConversation.get(sessionHash)
				: account.installationId
		const sessionId = threadId
		// Codex's window id is "<thread_id>:<window_number>" (tui/memories mint it
		// as `format!("{thread_id}:{n}")`). A pool account is one interactive
		// window per conversation, so counter starts at 0 like codex's first window.
		const windowId = `${threadId}:0`
		if (
			account.wsTransport !== undefined &&
			!account.wsBroken &&
			isResponsesRequestTarget(input)
		) {
			try {
				const session = await account.lockedGetSession()
				const accessToken = session?.accessToken
				if (accessToken === undefined || accessToken.length === 0) {
					throw new Error("websocket transport requires an access token")
				}
				// Re-prewarm when the account's token changed (refresh) so the ws
				// connection binds to the live credential, not a stale one.
				if (account.wsAccessToken !== accessToken) {
					account.wsAccessToken = accessToken
					account.wsTransport.prewarm(
						{
							accountId: account.installationId,
							installationId: account.installationId,
							sessionId,
							threadId,
							windowId,
						},
						accessToken,
					)
				}
				const requestBody = await readRequestBodyJson(input, attemptInit)
				const identity: WebsocketIdentity = {
					accountId: account.installationId,
					installationId: account.installationId,
					sessionId,
					threadId,
					windowId,
					// codex mints a fresh v7 turn_id per turn
					// (turn_metadata.rs:136) and ships it in client_metadata on
					// turn-shaped requests; set only on the /responses path, never
					// on prewarm.
					turnId: randomUUID(),
					turnState:
						sessionHash !== undefined
							? account.turnStateByConversation.get(sessionHash)
							: undefined,
				}
				const sseBody = await account.wsTransport.streamResponse(
					requestBody,
					identity,
					accessToken,
				)
				const wsResponse = new Response(sseBody, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				})
				return finalizeResponse(account, wsResponse, sessionHash, recordedPin)
			} catch {
				// Mark the ws path as unusable for the rest of this account's life and
				// fall through to plain HTTP for this request.
				account.wsBroken = true
			}
		}

		const response = await account.transportFetch(input, attemptInit ?? init)
		return finalizeResponse(account, response, sessionHash, recordedPin)
	}

	const finalizeResponse = async (
		account: PoolAccount,
		response: Response,
		sessionHash: string | undefined,
		recordedPin: boolean,
	): Promise<AttemptOutcome> => {
		if (!response.ok) {
			const { retriable, reason } = await markFailure(account, response)
			return {
				response,
				// A hash-pinned request deliberately targets the account owning
				// its replay chain; a failure (e.g. 400 because the recorded id
				// is stale) is returned as-is rather than replayed elsewhere.
				retriable: retriable && !recordedPin,
				reason,
			}
		}

		markSuccess(account, response.headers)

		// Capture codex's sticky-routing token so the next request in this
		// conversation echoes it (x-codex-turn-state). Only real HTTP responses
		// carry the header; a websocket turn surfaces it via client_metadata and
		// is deliberately not re-derived here.
		if (sessionHash !== undefined) {
			const turnState = response.headers.get("x-codex-turn-state")
			if (turnState !== null) {
				account.turnStateByConversation.set(sessionHash, turnState)
			}
		}

		if (sessionHash !== undefined) {
			// Pin the conversation to the account that just served it — including
			// after a migration — so its next turn routes back to the account that
			// can resolve its `previous_response_id` chain. The response id itself is
			// always re-supplied by the caller on the next turn, so the pin needs no
			// captured id: pinning by conversation is enough to keep the chain put.
			const { response: returned, id } = forkForResponseIdCapture(response)
			void id
			replay.set(sessionHash, { account })
			return { response: returned, retriable: false }
		}

		return { response, retriable: false }
	}

	const poolFetch: FetchFunction = (async (
		input: RequestInfo | URL,
		init?: RequestInit,
	) => {
		const parsed = await parseResponsesRequest(input, init)
		const sessionHash = parsed.hash

		let pinned = sessionHash !== undefined ? replay.get(sessionHash) : undefined
		if (
			pinned &&
			parsed.previousResponseId !== undefined &&
			pinned.previousResponseId !== undefined &&
			pinned.previousResponseId !== parsed.previousResponseId
		) {
			// The pinned account can't resolve this `previous_response_id` (the
			// conversation continued elsewhere — e.g. after a migration). Drop the
			// stale pin; the foreign chain must not be forwarded to it. The request
			// then dispatches fresh below and migrateChain strips the dead chain.
			replay.delete(sessionHash!)
			pinned = undefined
		}

		let prefer = pinned?.account
		let retried = false
		// Set when the conversation must move off an account that can't serve its
		// `previous_response_id` (dead/overloaded owner, or a stale/foreign chain):
		// the attempt strips the chain so it re-arrives with full input, no
		// `previous_response_id`, under the new account's distinct identity —
		// exactly codex's own incremental-mismatch / expired-id recovery shape.
		let migrateChain = false
		// The account the conversation is leaving; its Responses-state forks onto
		// the migration target so the moved turn re-arrives chain-less.
		let migrateFrom: PoolAccount | undefined
		if (prefer === undefined && parsed.previousResponseId !== undefined) {
			migrateChain = true
			migrateFrom = pinned?.account
		} else if (prefer !== undefined) {
			// The chain stays on its owner while the owner can serve it; migrate
			// only when the owner is down (or busy on a parallel in-flight request
			// on the same conversation) and a fresh account exists.
			refreshExpiredCooldown(prefer)
			const ownerDown =
				!isAccountAvailable(prefer.health, now()) || prefer.inflight > 0
			if (ownerDown && healthyAccounts(prefer).length > 0) {
				replay.delete(sessionHash!)
				migrateFrom = prefer
				prefer = undefined
				migrateChain = true
			}
		}
		for (;;) {
			const account = await acquireAccount(prefer)
			const recordedPin = !migrateChain && prefer !== undefined

			// Hold the inflight slot for the whole attempt. The reservation made
			// by acquireAccount is folded into inflight here; finally below
			// releases both the reservation and the inflight slot.
			account.pendingAssignments = Math.max(0, account.pendingAssignments - 1)
			account.inflight += 1
			try {
				if (
					migrateChain &&
					migrateFrom !== undefined &&
					account !== migrateFrom
				) {
					// Move this conversation's Responses-state off the sender onto the
					// new account's fresh cache, so the migrated turn re-arrives with
					// full input and no chain — codex's own compaction re-send shape,
					// never a foreign `previous_response_id` crossing accounts.
					account.beginMigrationFrom(migrateFrom.responsesState)
					migrateFrom = undefined
				}
				const outcome = await executeAttempt(
					account,
					input,
					init,
					sessionHash,
					recordedPin,
					migrateChain,
				)

				// Cross-account failover in-loop is only for fresh conversations (a
				// new chain an account 429'd on): moving them is invisible. A chained
				// conversation stays on its owner for the local back-off (codex's own
				// behavior on a transient 429) and migrates via the pre-dispatch
				// check on the NEXT request once the owner's cool-down is active and
				// a fresh account exists — never mid-stream, never arbitrating a
				// foreign response id.
				if (
					outcome.retriable &&
					!retried &&
					retryOnOtherAccount &&
					parsed.previousResponseId === undefined &&
					resolveRetryMode(
						parsed.previousResponseId,
						pinned,
						outcome.reason,
						false,
						true,
					) &&
					healthyAccounts(account).length > 0
				) {
					retried = true
					prefer = undefined
					if (outcome.reason !== undefined) {
						// A genuine client that just got a 429 waits Retry-After
						// (seconds) before the SAME identity reappears — so an instant
						// cross-account retry within ~150ms is a traffic pair no real
						// deployment produces. Human-scale jitter instead: long enough
						// to read as a new request, short enough to keep failover
						// useful. (Residual risk: an identical conversation arriving
						// under two identities close in time is inherently pool-shaped;
						// one retry max.)
						await sleep(1000 + Math.floor(Math.random() * 2000))
					}
					continue
				}
				return outcome.response
			} finally {
				account.inflight = Math.max(0, account.inflight - 1)
			}
		}
	}) as FetchFunction

	return {
		kind: "openai-oauth",
		baseURL: config.baseURL,
		openAIBaseURL: config.openAIBaseURL,
		instructions: config.instructions,
		fetch: poolFetch,
		getSession: async () => {
			// Accounting only for the session fetch itself: least-busy reads see
			// no model catalog/session stall in any concurrent request's way.
			const account = await acquireAccount()
			account.pendingAssignments -= 1
			account.inflight += 1
			try {
				return await account.lockedGetSession()
			} finally {
				account.inflight = Math.max(0, account.inflight - 1)
			}
		},
		stats: () =>
			accounts.map((account) => {
				refreshExpiredCooldown(account)
				return {
					name: account.name,
					accountId: account.lastSession?.accountId,
					installationId: account.installationId,
					transport:
						account.wsTransport !== undefined && !account.wsBroken
							? "websocket"
							: "http",
					healthy: isAccountAvailable(account.health, now()),
					inflight: account.inflight,
					cooldownRemainingMs: Math.max(
						0,
						account.health.unavailableUntil - now(),
					),
					consecutiveFailures: account.health.consecutiveFailures,
					codex: account.lastRate,
				}
			}),
		close: () => {
			// Wake any waiters a final time; in-flight fetches still finish.
			notifyAvailable()
			waiters.clear()
			return Promise.resolve()
		},
		destroy: async () => {
			notifyAvailable()
			waiters.clear()
			await Promise.all(
				accounts.flatMap((account) => [
					account.runtime.close(),
					account.wsTransport?.close() ?? Promise.resolve(),
				]),
			)
		},
	}
}
