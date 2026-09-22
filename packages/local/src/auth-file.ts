import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import type { FileHandle } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
	deriveAccountId,
	deriveChatGptAccountIsFedRamp,
	type FetchFunction,
	type OpenAIOAuthTokenResponse,
	parseJwtClaims,
	refreshOpenAIOAuthTokens,
} from "@openai-oauth/core"

const AUTH_FILENAME = "auth.json"
const REFRESH_EXPIRY_MARGIN_MS = 5 * 60 * 1000
const REFRESH_INTERVAL_MS = 55 * 60 * 1000
const DEFAULT_REFRESH_TIMEOUT_MS = 30_000
const UUID_V4_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Codex persists its installation id in a standalone `installation_id` file in
 * the codex home dir (default `~/.codex`). This opt-in reader supports callers
 * that intentionally share a local installation identity.
 * Read-only here: we never create the file when it does not already exist.
 * Returns undefined unless the file holds a bare v4 UUID.
 */
const readCodexNativeInstallationId = async (): Promise<string | undefined> => {
	try {
		const codexHome =
			process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex")
		const raw = await fs.readFile(
			path.join(codexHome, "installation_id"),
			"utf8",
		)
		const value = raw.trim()
		return UUID_V4_RE.test(value) ? value : undefined
	} catch {
		return undefined
	}
}

type StoredTokens = {
	[key: string]: unknown
	id_token?: string
	access_token?: string
	refresh_token?: string
	account_id?: string
}

type AuthFile = {
	[key: string]: unknown
	OPENAI_API_KEY?: string
	tokens?: StoredTokens
	last_refresh?: string
	/**
	 * Stable device/installation identity Codex CLI reports in
	 * `x-codex-installation-id` and websocket `client_metadata`. Persisted here
	 * so a pool account keeps one installation id across restarts.
	 */
	installation_id?: string
}

export type EffectiveAuth = {
	accessToken: string
	accountId: string
	isFedRamp?: boolean
	idToken?: string
	refreshToken?: string
	sourcePath?: string
	lastRefresh?: string
}

export type AuthLoaderOptions = {
	clientId?: string
	issuer?: string
	tokenUrl?: string
	authFilePath?: string
	fetch: FetchFunction
	ensureFresh?: boolean
	now?: () => Date
	/** Cancel this caller's wait without cancelling a shared token refresh. */
	signal?: AbortSignal
	/** Shared refresh deadline, including UA resolution and token body read (default 30s). */
	refreshTimeoutMs?: number
	/** Abort an exclusively owned shared refresh; unlike signal, affects every subscriber. */
	refreshSignal?: AbortSignal
	/**
	 * Full User-Agent for the token-refresh request. One codex process uses a
	 * single process-wide UA everywhere (refresh + /responses + /models), so a
	 * pool passes its account's data-path UA here to keep them identical;
	 * omitted = the pinned default codex UA (pinned version, `unknown` token).
	 * A function is awaited lazily at each refresh so the version segment always
	 * reflects the UA the data path would stamp that moment.
	 */
	userAgent?: string | ((signal?: AbortSignal) => string | Promise<string>)
}

export type SaveAuthTokensOptions = {
	token: OpenAIOAuthTokenResponse
	authFilePath?: string
	now?: () => Date
	/** Cancels waiting and pre-commit work; once rename starts, a save may have committed. */
	signal?: AbortSignal
}

export type SavedAuthTokens = {
	path: string
	auth: EffectiveAuth
}

type AuthReadResult = {
	path?: string
	data?: AuthFile
	/** File identity and content fence; never included in errors or logs. */
	version?: string
}

export class AuthFileChangedError extends Error {
	readonly code = "AUTH_FILE_CHANGED"

	constructor() {
		super(
			"Credentials changed while refreshing. Load the current session again.",
		)
		this.name = "AuthFileChangedError"
	}
}

export class AuthRefreshTimeoutError extends Error {
	readonly code = "AUTH_REFRESH_TIMEOUT"
	readonly retryable = true

	constructor() {
		super("The shared credential refresh timed out.")
		this.name = "AuthRefreshTimeoutError"
	}
}

// These queues coordinate this module's callers in one process, not other
// processes. Atomic replacement prevents partial files; version checks refuse
// observed external changes, but are not a cross-process compare-and-swap.
const fileOperations = new Map<string, Promise<void>>()
type RefreshEntry = {
	version: string
	lease: FileHandle
	signal: AbortSignal
	promise: Promise<EffectiveAuth>
}
const pendingRefreshes = new Map<string, RefreshEntry>()

const withFileLock = <T>(
	key: string,
	operation: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> => {
	let started = false
	let rejectQueued: ((reason: unknown) => void) | undefined
	const abortQueued = () => {
		if (!started)
			rejectQueued?.(
				signal?.reason ?? new DOMException("Aborted", "AbortError"),
			)
	}
	const next = (fileOperations.get(key) ?? Promise.resolve()).then(() => {
		started = true
		signal?.removeEventListener("abort", abortQueued)
		signal?.throwIfAborted()
		return operation()
	})
	const tail = next.then(
		() => undefined,
		() => undefined,
	)
	fileOperations.set(key, tail)
	void tail.then(() => {
		if (fileOperations.get(key) === tail) fileOperations.delete(key)
	})
	if (!signal) return next
	return new Promise((resolve, reject) => {
		rejectQueued = reject
		if (signal.aborted) abortQueued()
		else signal.addEventListener("abort", abortQueued, { once: true })
		void next.then(resolve, reject)
	})
}

const canonicalPath = async (filePath: string): Promise<string> => {
	const absolute = path.resolve(filePath)
	try {
		return await fs.realpath(absolute)
	} catch (error) {
		if (!isMissingFile(error)) throw error
		try {
			return path.join(
				await fs.realpath(path.dirname(absolute)),
				path.basename(absolute),
			)
		} catch (parentError) {
			if (!isMissingFile(parentError)) throw parentError
			return absolute
		}
	}
}

const isMissingFile = (error: unknown): boolean =>
	typeof error === "object" &&
	error !== null &&
	"code" in error &&
	error.code === "ENOENT"

type RefreshOutcome = {
	accessToken: string
	idToken?: string
	refreshToken?: string
	accountId?: string
	isFedRamp?: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const parseIsoDate = (value: string | undefined): Date | undefined => {
	if (typeof value !== "string" || !value) {
		return undefined
	}
	const date = new Date(value)
	return Number.isNaN(date.getTime()) ? undefined : date
}

const shouldRefreshAccessToken = (
	accessToken: string | undefined,
	lastRefresh: string | undefined,
	now: Date,
): boolean => {
	if (typeof accessToken !== "string" || accessToken.length === 0) {
		return true
	}

	const claims = parseJwtClaims(accessToken)
	const exp = claims && typeof claims.exp === "number" ? claims.exp : undefined
	if (typeof exp === "number") {
		const expiryMs = exp * 1000
		if (expiryMs <= now.getTime() + REFRESH_EXPIRY_MARGIN_MS) {
			return true
		}
	}

	const refreshedAt = parseIsoDate(lastRefresh)
	if (refreshedAt) {
		return refreshedAt.getTime() <= now.getTime() - REFRESH_INTERVAL_MS
	}
	return false
}

const uniquePaths = (paths: string[]): string[] => {
	const seen = new Set<string>()
	const result: string[] = []

	for (const candidate of paths) {
		if (!seen.has(candidate)) {
			seen.add(candidate)
			result.push(candidate)
		}
	}

	return result
}

export const resolveAuthFileCandidates = (authFilePath?: string): string[] => {
	if (typeof authFilePath === "string" && authFilePath.length > 0) {
		return [authFilePath]
	}

	const codexHome = process.env.CODEX_HOME

	return uniquePaths(
		[
			authFilePath,
			codexHome ? path.join(codexHome, AUTH_FILENAME) : undefined,
			path.join(os.homedir(), ".codex", AUTH_FILENAME),
		].filter(
			(value): value is string => typeof value === "string" && value.length > 0,
		),
	)
}

const resolveWritePath = (preferred: string | undefined): string => {
	if (preferred) {
		return preferred
	}

	const envHome = process.env.CODEX_HOME
	if (envHome) {
		return path.join(envHome, AUTH_FILENAME)
	}

	return path.join(os.homedir(), ".codex", AUTH_FILENAME)
}

const toAuthFile = (input: Record<string, unknown>): AuthFile => {
	const auth: AuthFile = { ...input }
	const tokensValue = input.tokens

	if (typeof input.OPENAI_API_KEY === "string" && input.OPENAI_API_KEY) {
		auth.OPENAI_API_KEY = input.OPENAI_API_KEY
	} else {
		delete auth.OPENAI_API_KEY
	}

	if (isRecord(tokensValue) && Object.keys(tokensValue).length > 0) {
		auth.tokens = {
			...tokensValue,
			id_token:
				typeof tokensValue.id_token === "string"
					? tokensValue.id_token
					: undefined,
			access_token:
				typeof tokensValue.access_token === "string"
					? tokensValue.access_token
					: undefined,
			refresh_token:
				typeof tokensValue.refresh_token === "string"
					? tokensValue.refresh_token
					: undefined,
			account_id:
				typeof tokensValue.account_id === "string"
					? tokensValue.account_id
					: undefined,
		}
	} else {
		delete auth.tokens
	}

	if (typeof input.last_refresh === "string" && input.last_refresh) {
		auth.last_refresh = input.last_refresh
	} else {
		delete auth.last_refresh
	}

	return auth
}

const readAuthFile = async (candidates: string[]): Promise<AuthReadResult> => {
	for (const candidate of candidates) {
		try {
			const handle = await fs.open(candidate, "r")
			let content: string
			let version: string
			try {
				const before = await handle.stat({ bigint: true })
				content = await handle.readFile("utf-8")
				const after = await handle.stat({ bigint: true })
				if (
					before.mtimeNs !== after.mtimeNs ||
					before.ctimeNs !== after.ctimeNs ||
					before.size !== after.size
				) {
					throw new AuthFileChangedError()
				}
				version = `${after.dev}:${after.ino}:${after.ctimeNs}:${after.mtimeNs}:${createHash("sha256").update(content).digest("hex")}`
			} finally {
				await handle.close()
			}
			const parsed = JSON.parse(content)
			if (isRecord(parsed)) {
				return { path: candidate, data: toAuthFile(parsed), version }
			}
			throw new Error(`Auth file at ${candidate} must contain a JSON object.`)
		} catch (error) {
			if (
				typeof error === "object" &&
				error !== null &&
				"code" in error &&
				error.code === "ENOENT"
			) {
				continue
			}
			if (error instanceof SyntaxError) {
				// JSON.parse errors can include source excerpts containing tokens.
				throw new Error(`Auth file at ${candidate} is not valid JSON.`)
			}
			throw error
		}
	}

	return {}
}

const openSnapshotLease = async (
	filePath: string,
	version: string,
): Promise<FileHandle> => {
	const lease = await fs.open(filePath, "r")
	try {
		const stat = await lease.stat({ bigint: true })
		const content = await lease.readFile("utf8")
		const leaseVersion = `${stat.dev}:${stat.ino}:${stat.ctimeNs}:${stat.mtimeNs}:${createHash("sha256").update(content).digest("hex")}`
		if (leaseVersion !== version || stat.nlink === 0n)
			throw new AuthFileChangedError()
		return lease
	} catch (error) {
		await lease.close()
		throw error
	}
}

const ensureDirectory = async (filePath: string): Promise<void> => {
	await fs.mkdir(path.dirname(filePath), { recursive: true })
}

const writeAuthFile = async (
	filePath: string,
	data: AuthFile,
	expectedVersion: string | undefined,
	signal?: AbortSignal,
): Promise<void> => {
	signal?.throwIfAborted()
	await ensureDirectory(filePath)
	signal?.throwIfAborted()
	const temporaryPath = path.join(
		path.dirname(filePath),
		`.${path.basename(filePath)}.${randomUUID()}.tmp`,
	)
	const handle = await fs.open(temporaryPath, "wx", 0o600)
	let closed = false
	try {
		signal?.throwIfAborted()
		await handle.writeFile(JSON.stringify(data, null, 2), "utf-8")
		signal?.throwIfAborted()
		await handle.sync()
		signal?.throwIfAborted()
		await handle.close()
		closed = true
		// Callers hold the process-local path lock. Refuse external changes we
		// can observe, including deletion; another process can still race the
		// final check/rename and needs its own ownership-aware coordination.
		const current = await readAuthFile([filePath])
		signal?.throwIfAborted()
		if (current.version !== expectedVersion) throw new AuthFileChangedError()
		// Rename is the irrevocable commit boundary. Do not reject a completed
		// save merely because cancellation arrived while the syscall was pending.
		await fs.rename(temporaryPath, filePath)
	} finally {
		if (!closed) await handle.close().catch(() => undefined)
		await fs.rm(temporaryPath, { force: true })
	}
}

export const resolveCodexAuthFilePath = (authFilePath?: string): string => {
	if (authFilePath) {
		return authFilePath
	}

	const codexHome = process.env.CODEX_HOME
	return path.join(
		codexHome ?? path.join(os.homedir(), ".codex"),
		AUTH_FILENAME,
	)
}

export const saveAuthTokens = async (
	options: SaveAuthTokensOptions,
): Promise<SavedAuthTokens> => {
	options.signal?.throwIfAborted()
	const filePath = resolveCodexAuthFilePath(options.authFilePath)
	const writePath = await abortable(canonicalPath(filePath), options.signal)
	return withFileLock(
		writePath,
		async () => {
			options.signal?.throwIfAborted()
			const snapshot = await abortable(
				readAuthFile([writePath]),
				options.signal,
			)
			options.signal?.throwIfAborted()
			const existing = snapshot.data ?? {}
			const now = options.now ?? (() => new Date())
			const savedAt = now().toISOString()
			const accountId =
				options.token.accountId ??
				deriveAccountId(options.token.idToken) ??
				deriveAccountId(options.token.accessToken)

			if (!accountId) {
				throw new Error(
					"ChatGPT account id not found in OpenAI OAuth token response.",
				)
			}

			await writeAuthFile(
				writePath,
				{
					...existing,
					auth_mode: "chatgpt",
					tokens: {
						...((existing.tokens?.account_id ??
							deriveAccountId(existing.tokens?.id_token) ??
							deriveAccountId(existing.tokens?.access_token)) === accountId
							? existing.tokens
							: {}),
						id_token: options.token.idToken,
						access_token: options.token.accessToken,
						refresh_token: options.token.refreshToken,
						account_id: accountId,
					},
					last_refresh: savedAt,
				},
				snapshot.version,
				options.signal,
			)

			return {
				path: filePath,
				auth: {
					accessToken: options.token.accessToken,
					accountId,
					isFedRamp: options.token.isFedRamp,
					idToken: options.token.idToken,
					refreshToken: options.token.refreshToken,
					sourcePath: filePath,
					lastRefresh: savedAt,
				},
			}
		},
		options.signal,
	)
}

/**
 * Resolves the installation id Codex CLI reports in `x-codex-installation-id`
 * and websocket `client_metadata`. Preference order mirrors codex itself: the
 * standalone codex-native `installation_id` file wins when the caller opts to
 * share the genuine CLI's identity; otherwise the id persisted in auth.json.
 */
const resolveInstallationId = (
	authFileValue: unknown,
	nativeValue: string | undefined,
): string | undefined => {
	if (nativeValue) {
		return nativeValue
	}
	return typeof authFileValue === "string" && authFileValue.length > 0
		? authFileValue
		: undefined
}

/**
 * Reads the persisted installation id, if any. By default this is the id in
 * auth.json (per-account, so pool accounts stay isolated). Codex's native
 * `~/.codex/installation_id` is consulted only when `options.preferNative` is
 * set — that file identifies the genuine CLI on this machine, so it should be
 * claimed by at most one account. Returns undefined when no usable id exists.
 */
export const readAuthInstallationId = async (
	authFilePath: string,
	options?: { preferNative?: boolean },
): Promise<string | undefined> => {
	const { data } = await readAuthFile([authFilePath])
	return resolveInstallationId(
		data?.installation_id,
		options?.preferNative ? await readCodexNativeInstallationId() : undefined,
	)
}

/**
 * Persists an installation id into auth.json, preserving every existing field
 * (tokens, auth_mode, last_refresh, unknown keys) and the 0o600 file mode
 * `writeAuthFile` enforces.
 */
export const saveAuthInstallationId = async (
	authFilePath: string,
	installationId: string,
): Promise<void> => {
	const writePath = await canonicalPath(authFilePath)
	await withFileLock(writePath, async () => {
		const snapshot = await readAuthFile([writePath])
		const pending = pendingRefreshes.get(writePath)
		const next: AuthFile = { ...snapshot.data, installation_id: installationId }
		await writeAuthFile(writePath, next, snapshot.version)
		// This operation changed metadata, not ownership/credentials. Advance
		// this process's existing refresh fence without issuing a second refresh.
		if (
			pending &&
			!pending.signal.aborted &&
			pending.version === snapshot.version
		) {
			const updated = await readAuthFile([writePath])
			if (
				updated.version &&
				JSON.stringify(updated.data) === JSON.stringify(next)
			) {
				const lease = await openSnapshotLease(writePath, updated.version)
				if (pending.signal.aborted) {
					await lease.close()
				} else {
					const previousLease = pending.lease
					pending.lease = lease
					pending.version = updated.version
					await previousLease.close()
				}
			}
		}
	})
}

const refreshChatGptTokens = async (
	refreshToken: string,
	clientId: string | undefined,
	issuer: string | undefined,
	tokenUrl: string | undefined,
	fetchFn: FetchFunction,
	userAgent?: string | ((signal?: AbortSignal) => string | Promise<string>),
	signal?: AbortSignal,
): Promise<RefreshOutcome> => {
	signal?.throwIfAborted()
	const resolvedUserAgent =
		typeof userAgent === "function"
			? await abortable(Promise.resolve(userAgent(signal)), signal)
			: userAgent
	signal?.throwIfAborted()
	const refreshed = await refreshOpenAIOAuthTokens({
		refreshToken,
		clientId,
		issuer,
		tokenUrl,
		fetch: fetchFn,
		userAgent: resolvedUserAgent,
		signal,
	})

	return {
		accessToken: refreshed.accessToken,
		idToken: refreshed.idToken,
		refreshToken: refreshed.refreshToken ?? refreshToken,
		accountId: refreshed.accountId,
		isFedRamp: refreshed.isFedRamp,
	}
}

const normalizeTokens = (tokens: StoredTokens | undefined): StoredTokens => {
	const maybeString = (value: unknown): string | undefined =>
		typeof value === "string" && value.length > 0 ? value : undefined

	return {
		id_token: maybeString(tokens?.id_token),
		access_token: maybeString(tokens?.access_token),
		refresh_token: maybeString(tokens?.refresh_token),
		account_id: maybeString(tokens?.account_id),
	}
}

const storedAccountId = (tokens: StoredTokens): string | undefined =>
	tokens.account_id ??
	deriveAccountId(tokens.id_token) ??
	deriveAccountId(tokens.access_token)

const effectiveAuth = (
	authData: AuthFile,
	sourcePath: string,
): EffectiveAuth => {
	const tokens = normalizeTokens(authData.tokens)
	const accountId = storedAccountId(tokens)
	if (!tokens.access_token) {
		throw new Error(
			"ChatGPT access token not found. Run `npx openai-oauth login` to sign in.",
		)
	}
	if (!accountId) {
		throw new Error(
			"ChatGPT account id not found in auth.json. Run `npx openai-oauth login` to sign in again.",
		)
	}
	return {
		accessToken: tokens.access_token,
		accountId,
		isFedRamp:
			deriveChatGptAccountIsFedRamp(tokens.id_token) ||
			deriveChatGptAccountIsFedRamp(tokens.access_token),
		idToken: tokens.id_token,
		refreshToken: tokens.refresh_token,
		sourcePath,
		lastRefresh: authData.last_refresh,
	}
}

const abortable = <T>(
	operation: Promise<T>,
	signal?: AbortSignal,
): Promise<T> => {
	if (!signal) return operation
	return new Promise((resolve, reject) => {
		const abort = () =>
			reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
		if (signal.aborted) abort()
		else signal.addEventListener("abort", abort, { once: true })
		void operation.then(
			(value) => {
				signal.removeEventListener("abort", abort)
				resolve(value)
			},
			(error) => {
				signal.removeEventListener("abort", abort)
				reject(error)
			},
		)
	})
}

const loadAuthTokensInternal = async (
	options: AuthLoaderOptions,
): Promise<EffectiveAuth> => {
	const {
		authFilePath,
		fetch,
		ensureFresh = true,
		now = () => new Date(),
	} = options
	if (typeof fetch !== "function") {
		throw new Error(
			"A fetch implementation is required to refresh ChatGPT tokens.",
		)
	}
	const refreshTimeoutMs =
		options.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS
	if (
		!Number.isSafeInteger(refreshTimeoutMs) ||
		refreshTimeoutMs <= 0 ||
		refreshTimeoutMs > 2_147_483_647
	) {
		throw new Error(
			"refreshTimeoutMs must be a positive integer no greater than 2147483647.",
		)
	}
	options.refreshSignal?.throwIfAborted()
	const discovered = await readAuthFile(resolveAuthFileCandidates(authFilePath))
	const sourcePath = discovered.path ?? resolveWritePath(authFilePath)
	const writePath = await canonicalPath(sourcePath)
	const loading = await withFileLock(writePath, async () => {
		const snapshot = await readAuthFile([writePath])
		const authData = snapshot.data ?? {}
		const tokens = normalizeTokens(authData.tokens)
		if (
			!ensureFresh ||
			!tokens.refresh_token ||
			!shouldRefreshAccessToken(
				tokens.access_token,
				authData.last_refresh,
				now(),
			)
		) {
			return { result: Promise.resolve(effectiveAuth(authData, sourcePath)) }
		}
		const version = snapshot.version
		if (version === undefined) throw new AuthFileChangedError()
		const refreshToken = tokens.refresh_token
		const pending = pendingRefreshes.get(writePath)
		if (pending?.version === version && !pending.signal.aborted) {
			return { result: pending.promise }
		}

		options.refreshSignal?.throwIfAborted()
		const lease = await openSnapshotLease(writePath, version)
		const controller = new AbortController()
		const signal = controller.signal
		const ownerAbort = () =>
			controller.abort(
				options.refreshSignal?.reason ??
					new DOMException("Aborted", "AbortError"),
			)
		options.refreshSignal?.addEventListener("abort", ownerAbort, { once: true })
		if (options.refreshSignal?.aborted) ownerAbort()
		const timer = setTimeout(
			() => controller.abort(new AuthRefreshTimeoutError()),
			refreshTimeoutMs,
		)
		let entry: RefreshEntry
		const refresh = Promise.resolve().then(async (): Promise<EffectiveAuth> => {
			signal.throwIfAborted()
			const refreshed = await abortable(
				refreshChatGptTokens(
					refreshToken,
					options.clientId,
					options.issuer,
					options.tokenUrl,
					fetch,
					options.userAgent,
					signal,
				),
				signal,
			)
			signal.throwIfAborted()
			const oldOwner = storedAccountId(tokens)
			const newOwner =
				refreshed.accountId ??
				deriveAccountId(refreshed.idToken) ??
				deriveAccountId(refreshed.accessToken)
			if (oldOwner && newOwner && oldOwner !== newOwner)
				throw new AuthFileChangedError()
			return withFileLock(
				writePath,
				async () => {
					signal.throwIfAborted()
					const current = await readAuthFile([writePath])
					signal.throwIfAborted()
					// A refresh may outlive logout, explicit sign-in, or another writer.
					// The open lease also prevents inode reuse after unlink/recreate.
					if (
						!current.data ||
						current.version !== entry.version ||
						(await entry.lease.stat()).nlink === 0
					)
						throw new AuthFileChangedError()
					signal.throwIfAborted()
					const next: AuthFile = {
						...current.data,
						auth_mode: "chatgpt",
						tokens: {
							...current.data.tokens,
							id_token: refreshed.idToken ?? tokens.id_token,
							access_token: refreshed.accessToken,
							refresh_token: refreshed.refreshToken ?? tokens.refresh_token,
							account_id: newOwner ?? oldOwner,
						},
						last_refresh: now().toISOString(),
					}
					const result = effectiveAuth(next, sourcePath)
					await writeAuthFile(writePath, next, current.version, signal)
					return result
				},
				signal,
			)
		})
		entry = { version, lease, signal, promise: refresh }
		pendingRefreshes.set(writePath, entry)
		const cleanup = () => {
			clearTimeout(timer)
			options.refreshSignal?.removeEventListener("abort", ownerAbort)
			if (pendingRefreshes.get(writePath) === entry)
				pendingRefreshes.delete(writePath)
			// The operation is settled and its signal fences all later work. Close
			// its lease without waiting behind an unrelated filesystem write.
			return entry.lease.close()
		}
		void refresh.then(cleanup, cleanup).catch(() => undefined)
		return { result: refresh }
	})
	return { ...(await loading.result), sourcePath }
}

export const loadAuthTokens = (
	options: AuthLoaderOptions,
): Promise<EffectiveAuth> => {
	if (options.signal?.aborted) {
		return Promise.reject(
			options.signal.reason ?? new DOMException("Aborted", "AbortError"),
		)
	}
	return abortable(loadAuthTokensInternal(options), options.signal)
}
