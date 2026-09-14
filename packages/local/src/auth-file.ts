import { promises as fs } from "node:fs"
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
const UUID_V4_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Codex persists its installation id in a standalone `installation_id` file in
 * the codex home dir (default `~/.codex`). When real codex shares the machine,
 * reusing that exact id keeps the pool indistinguishable from the genuine CLI.
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
	/**
	 * Full User-Agent for the token-refresh request. One codex process uses a
	 * single process-wide UA everywhere (refresh + /responses + /models), so a
	 * pool passes its account's data-path UA here to keep them identical;
	 * omitted = the pinned default codex UA (pinned version, `unknown` token).
	 * A function is awaited lazily at each refresh so the version segment always
	 * reflects the UA the data path would stamp that moment.
	 */
	userAgent?: string | (() => string | Promise<string>)
}

export type SaveAuthTokensOptions = {
	token: OpenAIOAuthTokenResponse
	authFilePath?: string
	now?: () => Date
}

export type SavedAuthTokens = {
	path: string
	auth: EffectiveAuth
}

type AuthReadResult = {
	path?: string
	data?: AuthFile
}

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
			const content = await fs.readFile(candidate, "utf-8")
			const parsed = JSON.parse(content)
			if (isRecord(parsed)) {
				return { path: candidate, data: toAuthFile(parsed) }
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
				throw new Error(`Auth file at ${candidate} is not valid JSON.`, {
					cause: error,
				})
			}
			throw error
		}
	}

	return {}
}

const ensureDirectory = async (filePath: string): Promise<void> => {
	await fs.mkdir(path.dirname(filePath), { recursive: true })
}

const writeAuthFile = async (
	filePath: string,
	data: AuthFile,
): Promise<void> => {
	await ensureDirectory(filePath)
	await fs.writeFile(filePath, JSON.stringify(data, null, 2), {
		encoding: "utf-8",
		mode: 0o600,
	})
	// writeFile's mode applies only at creation; codex enforces 0o600 on
	// existing files too, so lock the file down regardless of prior state.
	await fs.chmod(filePath, 0o600).catch(() => {})
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
	const filePath = resolveCodexAuthFilePath(options.authFilePath)
	const existing = (await readAuthFile([filePath])).data ?? {}
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

	await writeAuthFile(filePath, {
		...existing,
		auth_mode: "chatgpt",
		tokens: {
			id_token: options.token.idToken,
			access_token: options.token.accessToken,
			refresh_token: options.token.refreshToken,
			account_id: accountId,
		},
		last_refresh: savedAt,
	})

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
	const existing = (await readAuthFile([authFilePath])).data ?? {}
	await writeAuthFile(authFilePath, {
		...existing,
		installation_id: installationId,
	})
}

const refreshChatGptTokens = async (
	refreshToken: string,
	clientId: string | undefined,
	issuer: string | undefined,
	tokenUrl: string | undefined,
	fetchFn: FetchFunction,
	userAgent?: string | (() => string | Promise<string>),
): Promise<RefreshOutcome> => {
	const resolvedUserAgent =
		typeof userAgent === "function" ? await userAgent() : userAgent
	const refreshed = await refreshOpenAIOAuthTokens({
		refreshToken,
		clientId,
		issuer,
		tokenUrl,
		fetch: fetchFn,
		userAgent: resolvedUserAgent,
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

export const loadAuthTokens = async (
	options: AuthLoaderOptions,
): Promise<EffectiveAuth> => {
	const {
		clientId,
		issuer,
		tokenUrl,
		authFilePath,
		fetch,
		ensureFresh = true,
		now = () => new Date(),
		userAgent,
	} = options

	if (typeof fetch !== "function") {
		throw new Error(
			"A fetch implementation is required to refresh ChatGPT tokens.",
		)
	}

	const readResult = await readAuthFile(resolveAuthFileCandidates(authFilePath))
	const authData = readResult.data ?? {}
	const tokens = normalizeTokens(authData.tokens)

	let accessToken = tokens.access_token
	let idToken = tokens.id_token
	let refreshToken = tokens.refresh_token
	let accountId = tokens.account_id ?? deriveAccountId(idToken)
	let isFedRamp =
		deriveChatGptAccountIsFedRamp(idToken) ||
		deriveChatGptAccountIsFedRamp(accessToken)
	let lastRefresh = authData.last_refresh

	const needsRefresh =
		ensureFresh &&
		typeof refreshToken === "string" &&
		shouldRefreshAccessToken(accessToken, lastRefresh, now())

	if (needsRefresh && typeof refreshToken === "string") {
		const refreshed = await refreshChatGptTokens(
			refreshToken,
			clientId,
			issuer,
			tokenUrl,
			fetch,
			userAgent,
		)

		accessToken = refreshed.accessToken
		idToken = refreshed.idToken ?? idToken
		refreshToken = refreshed.refreshToken ?? refreshToken
		accountId = refreshed.accountId ?? accountId
		isFedRamp =
			isFedRamp ||
			refreshed.isFedRamp === true ||
			deriveChatGptAccountIsFedRamp(idToken) ||
			deriveChatGptAccountIsFedRamp(accessToken)
		lastRefresh = now().toISOString()

		const writePath = resolveWritePath(readResult.path ?? authFilePath)
		await writeAuthFile(writePath, {
			...authData,
			auth_mode: "chatgpt",
			tokens: {
				id_token: idToken,
				access_token: accessToken,
				refresh_token: refreshToken,
				account_id: accountId,
			},
			last_refresh: lastRefresh,
		})
	}

	if (typeof accessToken !== "string" || accessToken.length === 0) {
		throw new Error(
			"ChatGPT access token not found. Run `npx openai-oauth login` to sign in.",
		)
	}

	if (typeof accountId !== "string" || accountId.length === 0) {
		throw new Error(
			"ChatGPT account id not found in auth.json. Run `npx openai-oauth login` to sign in again.",
		)
	}

	return {
		accessToken,
		accountId,
		isFedRamp,
		idToken,
		refreshToken,
		sourcePath: readResult.path ?? resolveWritePath(authFilePath),
		lastRefresh,
	}
}
