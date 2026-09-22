import { createModelCatalogCache } from "./catalog.js"
import {
	CODEX_IMAGE_MODEL,
	type CodexImageLimits,
	prepareCodexImageRequest,
} from "./images.js"
import {
	type CodexModelCatalogSnapshot,
	type CodexModelInfo,
	DEFAULT_CODEX_CLIENT_VERSION,
	fetchCodexModelCatalogSnapshot,
	type GetModelCatalogOptions,
	isPublicCodexModel,
	resolveCodexClientVersion,
} from "./models.js"
import {
	collectCompletedResponseFromSse,
	ResponseSseCollector,
	type SseLimits,
	SseParser,
} from "./sse.js"
import { CodexResponsesState } from "./state.js"
import {
	createOperationScope,
	fetchWithSignal,
	readBoundedText,
	readWithSignal,
	validateTimeout,
	waitWithSignal,
} from "./stream-utils.js"
import { isRecord, randomUUIDv7 } from "./utils.js"

export const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"
export const DEFAULT_CODEX_ORIGINATOR = "codex_cli_rs"

const CODEX_UA_KERNEL = "6.8.0-79-generic"
const CODEX_UA_ARCH = "x86_64"

/**
 * Terminal tokens codex_terminal_detection can genuinely produce for a process
 * running on a headless Linux host — and only those. Anything mac/Windows-only
 * (iTerm.app, Apple_Terminal, WarpTerminal, WindowsTerminal) or GUI-detached
 * (Ghostty, Alacritty, Konsole, gnome-terminal, VTE) is excluded because a
 * Linux server-side codex could never emit them. Each entry is one a real
 * codex TUI/exec could legitimately stamp on this box:
 *  - unknown             — TUI with no TTY, piped, or TERM unset (dominant)
 *  - xterm-256color/tmux/screen — TUI inside tmux/screen/tmux-in-xterm
 *  - kitty               — `kitty +kitten ssh` (no version in the token)
 *  - WezTerm/<build>     — wezterm SSH-domain client
 *  - vscode/<ver>        — `code tunnel` / vscode-server (TERM_PROGRAM=vscode)
 * Weighted toward the headless majority: unknown + multiplexer dominate.
 */
const LEGIT_TERMINAL_TOKENS: ReadonlyArray<{ token: string; weight: number }> =
	[
		{ token: "unknown", weight: 44 },
		{ token: "unknown", weight: 16 }, // ~60% unknown overall
		{ token: "xterm-256color", weight: 8 },
		{ token: "screen", weight: 4 },
		{ token: "screen-256color", weight: 6 },
		{ token: "tmux-256color", weight: 4 },
		{ token: "kitty", weight: 6 },
		{ token: "WezTerm/20240203-110809-5046fc22", weight: 4 },
		{ token: "vscode/1.104.0", weight: 8 },
	]

const TOTAL_TOKEN_WEIGHT = LEGIT_TERMINAL_TOKENS.reduce(
	(sum, entry) => sum + entry.weight,
	0,
)

/** Deterministic 32-bit hash for pinning a terminal token per account. */
const hashTerminalSeed = (seed: string): number => {
	let h = 0x811c9dc5
	for (let i = 0; i < seed.length; i += 1) {
		h ^= seed.charCodeAt(i)
		h = Math.imul(h, 0x01000193)
	}
	return h >>> 0
}

/**
 * Picks a stable, legit terminal token for the given seed (typically an
 * installation id). Same seed always yields the same token, so one account
 * keeps one UA forever. Crate-recognized tokens are emitted exactly as codex
 * would (`kitty` bare, WezTerm with its build number, vscode with a version).
 */
export const pickCodexTerminalToken = (seed: string): string => {
	const roll = hashTerminalSeed(seed) % TOTAL_TOKEN_WEIGHT
	let acc = 0
	for (const entry of LEGIT_TERMINAL_TOKENS) {
		acc += entry.weight
		if (roll < acc) {
			return entry.token
		}
	}
	return "unknown"
}

/**
 * Builds the User-Agent Codex CLI stamps on every backend request
 * (codex-rs login/src/auth/default_client.rs `get_codex_user_agent`):
 * `<originator>/<version> (<os> <os-version>; <arch>) <terminal-ua>`.
 *
 * The terminal token defaults to `unknown` — verified against a live codex
 * 0.154 capture as the token a TUI emits with no real terminal, which is what
 * a headless pool genuinely is. Pass `terminalToken` (e.g. from
 * `pickCodexTerminalToken`) to give one account a stable, legitimately-
 * possible token instead. The os-version segment is a Linux kernel release
 * string (`uname -r`), what `os_info::version()` returns on the Linux hosts
 * Codex runs on. `settings.headers["User-Agent"]` always overrides.
 */
export const buildCodexUserAgent = (
	codexVersion: string,
	terminalToken = "unknown",
): string =>
	`${DEFAULT_CODEX_ORIGINATOR}/${codexVersion} (Linux ${CODEX_UA_KERNEL}; ${CODEX_UA_ARCH}) ${terminalToken}`
/**
 * Fallback User-Agent built from the pinned default client version; mirrors
 * the exact shape `buildCodexUserAgent` produces once the version resolves.
 */
export const DEFAULT_CODEX_USER_AGENT = buildCodexUserAgent(
	DEFAULT_CODEX_CLIENT_VERSION,
)
export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL =
	"https://openai-oauth.local/v1"
export const DEFAULT_OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
export const DEFAULT_OPENAI_OAUTH_ISSUER = "https://auth.openai.com"
// Codex's authorize scope is broader than the plain OIDC triple — it also
// requests the connectors scopes (login/server.rs build_authorize_url).
export const DEFAULT_OPENAI_OAUTH_SCOPE =
	"openid profile email offline_access api.connectors.read api.connectors.invoke"
const DEFAULT_CODEX_INSTRUCTIONS = ""
const RESPONSES_LITE_HEADER = "x-openai-internal-codex-responses-lite"

export type FetchFunction = typeof fetch

export type OpenAIOAuthSession = {
	accessToken: string
	accountId: string
	isFedRamp?: boolean
	idToken?: string
	refreshToken?: string
	expiresAt?: string
	lastRefresh?: string
}

export type OpenAIOAuthSessionInput =
	| OpenAIOAuthSession
	| (() => Promise<OpenAIOAuthSession | null | undefined>)

export type OpenAIOAuth = {
	kind: "openai-oauth"
	/** Already-authenticating transport; adapters must not wrap it again. */
	transport?: OpenAIOAuthTransport
	getSession(): Promise<OpenAIOAuthSession | null>
	baseURL?: string
	fetch?: FetchFunction
	headers?: Record<string, string>
	instructions?: string
	openAIBaseURL?: string
}

export type SessionStore = {
	get(): Promise<OpenAIOAuthSession | null>
	set(session: OpenAIOAuthSession): Promise<void>
	clear(): Promise<void>
}

export type OpenAIOAuthRequestOptions = {
	clientId?: string
	issuer?: string
	redirectUri: string
	scope?: string
	state?: string
	codeVerifier?: string
	simplifiedFlow?: boolean
	idTokenAddOrganizations?: boolean
	/** `originator` query param on the authorize URL (defaults to codex's). */
	originator?: string
	extraParams?: Record<string, string | number | boolean | undefined>
}

export type OpenAIOAuthRequest = {
	authorizationUrl: string
	state: string
	codeVerifier: string
	codeChallenge: string
	redirectUri: string
}

export type OpenAIOAuthTokenResponse = {
	accessToken: string
	refreshToken?: string
	idToken?: string
	expiresIn?: number
	accountId?: string
	isFedRamp?: boolean
	raw: unknown
}

export type ExchangeOpenAIOAuthCodeOptions = {
	code: string
	codeVerifier: string
	redirectUri: string
	clientId?: string
	issuer?: string
	tokenUrl?: string
	fetch?: FetchFunction
	signal?: AbortSignal
}

export type RefreshOpenAIOAuthTokensOptions = {
	refreshToken: string
	clientId?: string
	issuer?: string
	tokenUrl?: string
	fetch?: FetchFunction
	signal?: AbortSignal
	/**
	 * Full User-Agent for the refresh request, e.g. the account's data-path UA
	 * (`buildCodexUserAgent(resolvedVersion, terminalToken)`). Codex uses one
	 * process-wide UA (`create_default_auth_client`), so a pool refresh must
	 * match that account's /responses+models UA exactly. Defaults to the pinned
	 * `DEFAULT_CODEX_USER_AGENT` (pinned version, `unknown` token).
	 */
	userAgent?: string
}

export type ExecuteResponses = (
	url: string,
	init: RequestInit,
	session: OpenAIOAuthSession,
) => Promise<Response>

export type ResponsesContext = {
	session: OpenAIOAuthSession
	request: Record<string, unknown>
	headers: Headers
}

export type ModelCatalogResponseContext = {
	session: OpenAIOAuthSession
}

type CodexOAuthRuntimeSettings = {
	/** Transport-owned lifetime; unlike caller signals, also cancels shared catalog work. */
	signal?: AbortSignal
	requestTimeoutMs?: number
	streamIdleTimeoutMs?: number
	modelCatalogTimeoutMs?: number
	imageLimits?: CodexImageLimits
	onResponseCompleted?: (
		response: Record<string, unknown>,
		context: ResponsesContext,
	) => void
	onResponseEvent?: (
		event: Record<string, unknown>,
		context: ResponsesContext,
	) => void
	onResponseError?: (error: unknown, context: ResponsesContext) => void
	/** Observes authenticated /models responses without exposing catalog internals. */
	onModelCatalogResponse?: (
		response: Response,
		context: ModelCatalogResponseContext,
	) => void
	/** Internal transport seam: return upstream SSE; core owns normalization and finalization. */
	executeResponses?: ExecuteResponses
	/** SSE event and collected response budgets. */
	responseLimits?: SseLimits
	/** Maximum age of last-known-good model metadata used after a refresh failure. */
	modelCatalogMaxStaleMs?: number
	auth: OpenAIOAuthSessionInput
	baseURL?: string
	codexVersion?: string
	fetch?: FetchFunction
	headers?: Record<string, string>
	instructions?: string
	responsesState?: CodexResponsesState | false
	/**
	 * Override the default `unknown` terminal token in the Codex User-Agent.
	 * Must be a legitimately-possible value for a headless Linux codex (see
	 * `pickCodexTerminalToken`); never a mac/Windows-only program. Pools pin one
	 * per account; `settings.headers["User-Agent"]` still overrides everything.
	 */
	terminalToken?: string
}

export type OpenAIOAuthTransportOptions = Omit<
	CodexOAuthRuntimeSettings,
	"responsesState"
> & {
	openAIBaseURL?: string
	/**
	 * `false` disables the Responses-state cache entirely. Passing a
	 * `CodexResponsesState` instance pins the cache the transport mirrors
	 * `previous_response_id` chains into — a pool uses this to give each account
	 * its own device-local cache so a chain never resolves across accounts.
	 * Omitted: the transport owns a private cache.
	 */
	responsesState?: CodexResponsesState | false
}

export type OpenAIOAuthTransport = {
	kind: "openai-compatible"
	baseURL: string
	fetch: FetchFunction
	request: (path: string, init?: RequestInit) => Promise<Response>
	getModelCatalog?: (
		options?: GetModelCatalogOptions,
	) => Promise<CodexModelCatalogSnapshot>
}

type RequestParts = {
	redirect?: RequestRedirect
	url: string
	method?: string
	headers: Headers
	body?: BodyInit | null
	signal?: AbortSignal | null
}

export type NormalizeCodexResponsesBodyOptions = {
	instructions?: string
	forceStream?: boolean
}

type InternalNormalizeCodexResponsesBodyOptions =
	NormalizeCodexResponsesBodyOptions & {
		modelInfo?: CodexModelInfo
	}

const textEncoder = new TextEncoder()

const bytesToBase64Url = (bytes: Uint8Array): string => {
	let binary = ""
	for (const byte of bytes) {
		binary += String.fromCharCode(byte)
	}
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "")
}

const randomURLSafeString = (byteLength: number): string => {
	const bytes = new Uint8Array(byteLength)
	globalThis.crypto.getRandomValues(bytes)
	return bytesToBase64Url(bytes)
}

const createCodeChallenge = async (codeVerifier: string): Promise<string> => {
	const digest = await globalThis.crypto.subtle.digest(
		"SHA-256",
		textEncoder.encode(codeVerifier),
	)
	return bytesToBase64Url(new Uint8Array(digest))
}

const trimTrailingSlash = (value: string): string => value.replace(/\/$/, "")

const withoutTrailingSlash = (value: string | undefined): string | undefined =>
	value?.replace(/\/$/, "")

export const usesServerReplayState = (
	value: Record<string, unknown>,
): boolean => {
	if (typeof value.previous_response_id === "string") {
		return true
	}

	if (!Array.isArray(value.input)) {
		return false
	}

	return value.input.some(
		(item) =>
			isRecord(item) &&
			item.type === "item_reference" &&
			typeof item.id === "string",
	)
}

const decodeBase64Url = (value: string): string | undefined => {
	try {
		const padded = value + "=".repeat(((-value.length % 4) + 4) % 4)
		const binary = atob(padded.replaceAll("-", "+").replaceAll("_", "/"))
		const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
		return new TextDecoder().decode(bytes)
	} catch {
		return undefined
	}
}

export const parseJwtClaims = (
	token: string | undefined,
): Record<string, unknown> | undefined => {
	if (typeof token !== "string" || !token.includes(".")) {
		return undefined
	}
	const parts = token.split(".")
	if (parts.length !== 3 || parts[1] === undefined) {
		return undefined
	}
	const payload = decodeBase64Url(parts[1])
	if (typeof payload !== "string") {
		return undefined
	}
	try {
		const parsed = JSON.parse(payload)
		return isRecord(parsed) ? parsed : undefined
	} catch {
		return undefined
	}
}

export const deriveAccountId = (
	idToken: string | undefined,
): string | undefined => {
	const claims = parseJwtClaims(idToken)
	if (!claims) {
		return undefined
	}
	const authClaim = claims["https://api.openai.com/auth"]
	if (isRecord(authClaim)) {
		const accountId = authClaim.chatgpt_account_id
		if (typeof accountId === "string" && accountId.length > 0) {
			return accountId
		}
	}

	const topLevelAccountId = claims.chatgpt_account_id
	if (typeof topLevelAccountId === "string" && topLevelAccountId.length > 0) {
		return topLevelAccountId
	}

	const organizations = claims.organizations
	if (Array.isArray(organizations)) {
		const first = organizations[0]
		if (
			isRecord(first) &&
			typeof first.id === "string" &&
			first.id.length > 0
		) {
			return first.id
		}
	}

	return undefined
}

export const deriveChatGptAccountIsFedRamp = (
	token: string | undefined,
): boolean => {
	const claims = parseJwtClaims(token)
	if (!claims) {
		return false
	}

	const authClaim = claims["https://api.openai.com/auth"]
	return isRecord(authClaim) && authClaim.chatgpt_account_is_fedramp === true
}

const resolveTokenUrl = (
	issuer: string,
	tokenUrl: string | undefined,
): string => tokenUrl ?? `${trimTrailingSlash(issuer)}/oauth/token`

const toTokenResponse = (payload: unknown): OpenAIOAuthTokenResponse => {
	if (!isRecord(payload)) {
		throw new Error("OpenAI OAuth token response must be a JSON object.")
	}

	const accessToken =
		typeof payload.access_token === "string" ? payload.access_token : undefined
	if (!accessToken) {
		throw new Error("OpenAI OAuth token response did not include access_token.")
	}

	const refreshToken =
		typeof payload.refresh_token === "string"
			? payload.refresh_token
			: undefined
	const idToken =
		typeof payload.id_token === "string" ? payload.id_token : undefined
	const expiresIn =
		typeof payload.expires_in === "number" ? payload.expires_in : undefined

	return {
		accessToken,
		refreshToken,
		idToken,
		expiresIn,
		accountId: deriveAccountId(idToken) ?? deriveAccountId(accessToken),
		isFedRamp:
			deriveChatGptAccountIsFedRamp(idToken) ||
			deriveChatGptAccountIsFedRamp(accessToken),
		raw: payload,
	}
}

const OAUTH_ERROR_CODES = new Set([
	"invalid_request",
	"invalid_client",
	"invalid_grant",
	"unauthorized_client",
	"unsupported_grant_type",
	"invalid_scope",
	"access_denied",
	"server_error",
	"temporarily_unavailable",
	"refresh_token_expired",
	"refresh_token_reused",
	"refresh_token_invalidated",
])

export class OAuthTokenError extends Error {
	readonly status: number
	readonly code?: string
	readonly retryable: boolean

	constructor(status: number, code?: string) {
		super(`OpenAI OAuth token request failed with HTTP ${status}.`)
		this.name = "OAuthTokenError"
		this.status = status
		this.code = code && OAUTH_ERROR_CODES.has(code) ? code : undefined
		this.retryable =
			status === 408 || status === 425 || status === 429 || status >= 500
	}
}

const requestOpenAIOAuthTokens = async (options: {
	clientId?: string
	issuer?: string
	tokenUrl?: string
	fetch?: FetchFunction
	signal?: AbortSignal
	/** Sent verbatim as the User-Agent header. Pass `null` to omit the header. */
	userAgent?: string | null
	/** Sent as codex's `originator` header when provided. */
	originator?: string
	body: Record<string, string>
	encoding: "form" | "json"
}): Promise<OpenAIOAuthTokenResponse> => {
	const issuer = options.issuer ?? DEFAULT_OPENAI_OAUTH_ISSUER
	const isForm = options.encoding === "form"
	// Codex splits its OAuth surface by client: the authorization-code exchange
	// and the API-key exchange use `create_raw_auth_client`, a bare reqwest
	// builder with no codex default headers (no User-Agent, no originator),
	// while the refresh flow uses `create_default_auth_client`, which stamps the
	// codex User-Agent + originator (login/default_client.rs default_headers).
	// Callers pass exactly the surface the genuine CLI emits for that request.
	const headers: Record<string, string> = {
		"Content-Type": isForm
			? "application/x-www-form-urlencoded"
			: "application/json",
	}
	if (options.userAgent != null) {
		headers["User-Agent"] = options.userAgent
	}
	if (options.originator !== undefined) {
		headers.originator = options.originator
	}
	const response = await fetchWithSignal(
		pickFetch(options.fetch),
		resolveTokenUrl(issuer, options.tokenUrl),
		{
			method: "POST",
			headers,
			body: isForm
				? new URLSearchParams(options.body).toString()
				: JSON.stringify(options.body),
			signal: options.signal,
			redirect: "error",
		},
		options.signal,
	)
	let bodyText: string
	try {
		bodyText = await readBoundedText(response.body, 64 * 1024, options.signal)
	} catch (error) {
		if (!response.ok) throw new OAuthTokenError(response.status)
		throw error
	}

	if (!response.ok) {
		let code: string | undefined
		try {
			const parsed = JSON.parse(bodyText)
			if (isRecord(parsed)) {
				const candidate =
					typeof parsed.error === "string"
						? parsed.error
						: isRecord(parsed.error)
							? parsed.error.code
							: undefined
				if (typeof candidate === "string") code = candidate
			}
		} catch {}
		// Provider error descriptions may echo tokens, authorization codes or URL
		// userinfo. Keep only a whitelisted machine code and HTTP status.
		throw new OAuthTokenError(response.status, code)
	}

	try {
		return toTokenResponse(JSON.parse(bodyText))
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error("OpenAI OAuth token response was not valid JSON.")
		}
		throw error
	}
}

export const createOpenAIOAuthRequest = async (
	options: OpenAIOAuthRequestOptions,
): Promise<OpenAIOAuthRequest> => {
	const state = options.state ?? randomURLSafeString(24)
	const codeVerifier = options.codeVerifier ?? randomURLSafeString(48)
	const codeChallenge = await createCodeChallenge(codeVerifier)
	const issuer = trimTrailingSlash(
		options.issuer ?? DEFAULT_OPENAI_OAUTH_ISSUER,
	)
	const authorizationUrl = new URL(`${issuer}/oauth/authorize`)

	authorizationUrl.searchParams.set("response_type", "code")
	authorizationUrl.searchParams.set(
		"client_id",
		options.clientId ?? DEFAULT_OPENAI_OAUTH_CLIENT_ID,
	)
	authorizationUrl.searchParams.set("redirect_uri", options.redirectUri)
	authorizationUrl.searchParams.set(
		"scope",
		options.scope ?? DEFAULT_OPENAI_OAUTH_SCOPE,
	)
	authorizationUrl.searchParams.set("state", state)
	authorizationUrl.searchParams.set("code_challenge", codeChallenge)
	authorizationUrl.searchParams.set("code_challenge_method", "S256")

	if (options.idTokenAddOrganizations ?? true) {
		authorizationUrl.searchParams.set("id_token_add_organizations", "true")
	}

	if (options.simplifiedFlow ?? true) {
		authorizationUrl.searchParams.set("codex_cli_simplified_flow", "true")
	}

	// The genuine CLI's authorize URL always carries an `originator` query param
	// (login/server.rs build_authorize_url) defaulting to `codex_cli_rs` —
	// omitting it marks the login flow as non-codex.
	authorizationUrl.searchParams.set(
		"originator",
		options.originator ?? DEFAULT_CODEX_ORIGINATOR,
	)

	for (const [key, value] of Object.entries(options.extraParams ?? {})) {
		// `originator` is owned by the dedicated option above (codex always
		// stamps its own); extraParams must not clobber it.
		if (value !== undefined && key !== "originator") {
			authorizationUrl.searchParams.set(key, String(value))
		}
	}

	return {
		authorizationUrl: authorizationUrl.toString(),
		state,
		codeVerifier,
		codeChallenge,
		redirectUri: options.redirectUri,
	}
}

export const exchangeOpenAIOAuthCode = (
	options: ExchangeOpenAIOAuthCodeOptions,
): Promise<OpenAIOAuthTokenResponse> =>
	requestOpenAIOAuthTokens({
		issuer: options.issuer,
		tokenUrl: options.tokenUrl,
		fetch: options.fetch,
		signal: options.signal,
		// Codex exchanges the authorization code with `create_raw_auth_client`:
		// a bare client with NO codex User-Agent and NO originator header.
		userAgent: null,
		encoding: "form",
		body: {
			grant_type: "authorization_code",
			code: options.code,
			redirect_uri: options.redirectUri,
			client_id: options.clientId ?? DEFAULT_OPENAI_OAUTH_CLIENT_ID,
			code_verifier: options.codeVerifier,
		},
	})

export const refreshOpenAIOAuthTokens = (
	options: RefreshOpenAIOAuthTokensOptions,
): Promise<OpenAIOAuthTokenResponse> =>
	requestOpenAIOAuthTokens({
		issuer: options.issuer,
		tokenUrl: options.tokenUrl,
		fetch: options.fetch,
		signal: options.signal,
		// Codex refreshes with `create_default_auth_client`, which stamps the
		// codex User-Agent + originator on the token request — the same process-wide
		// UA as the data path. A pool passes its account's UA; a bare client keeps
		// the pinned default.
		userAgent: options.userAgent ?? DEFAULT_CODEX_USER_AGENT,
		originator: DEFAULT_CODEX_ORIGINATOR,
		encoding: "json",
		body: {
			grant_type: "refresh_token",
			refresh_token: options.refreshToken,
			client_id: options.clientId ?? DEFAULT_OPENAI_OAUTH_CLIENT_ID,
		},
	})

const pickFetch = (customFetch?: FetchFunction): FetchFunction => {
	if (typeof customFetch === "function") {
		return customFetch
	}

	if (typeof globalThis.fetch === "function") {
		return globalThis.fetch.bind(globalThis)
	}

	throw new Error("A fetch implementation is required for OpenAI OAuth.")
}

const resolveBaseURL = (baseURL?: string): string =>
	withoutTrailingSlash(baseURL) ?? DEFAULT_CODEX_BASE_URL

const resolveOpenAIBaseURL = (baseURL?: string): string =>
	withoutTrailingSlash(baseURL) ?? DEFAULT_OPENAI_COMPATIBLE_BASE_URL

const resolveTargetUrl = (input: string, baseURL: string): string => {
	const base = new URL(baseURL)
	const parsed = /^https?:\/\//.test(input)
		? new URL(input)
		: new URL(input, "https://codex.invalid")
	let pathname = parsed.pathname
	const basePath = withoutTrailingSlash(base.pathname) ?? ""

	if (pathname === basePath) {
		pathname = "/"
	} else if (basePath.length > 0 && pathname.startsWith(`${basePath}/`)) {
		pathname = pathname.slice(basePath.length)
	}

	if (pathname === "/v1") {
		pathname = "/"
	} else if (pathname.startsWith("/v1/")) {
		pathname = pathname.slice(3)
	}

	const target = new URL(`${base.origin}${basePath}${pathname}`)
	target.search = base.search
	// Request query values replace the base defaults for the same key; repeated
	// request keys remain repeated and encoding is handled by URLSearchParams.
	for (const key of new Set(parsed.searchParams.keys()))
		target.searchParams.delete(key)
	for (const [key, value] of parsed.searchParams)
		target.searchParams.append(key, value)
	return target.toString()
}

const readRequestParts = async (
	input: Parameters<FetchFunction>[0],
	init: Parameters<FetchFunction>[1],
): Promise<RequestParts> => {
	if (input instanceof Request) {
		const headers = new Headers(input.headers)
		if (init?.headers) {
			new Headers(init.headers).forEach((value, key) => {
				headers.set(key, value)
			})
		}

		return {
			url: input.url,
			method: init?.method ?? input.method,
			headers,
			body:
				init?.body ??
				(input.body == null
					? undefined
					: input.headers
								.get("content-type")
								?.split(";", 1)[0]
								?.trim()
								.toLowerCase() === "multipart/form-data"
						? await input.clone().formData()
						: await input.clone().text()),
			signal: init?.signal ?? input.signal,
			redirect: init?.redirect ?? input.redirect,
		}
	}

	return {
		url: String(input),
		method: init?.method,
		headers: new Headers(init?.headers),
		body: init?.body,
		signal: init?.signal,
		redirect: init?.redirect,
	}
}

const decodeBody = async (
	body: BodyInit | null | undefined,
): Promise<string | undefined> => {
	if (body == null) {
		return undefined
	}
	if (typeof body === "string") {
		return body
	}
	if (body instanceof URLSearchParams || body instanceof FormData) {
		return undefined
	}
	if (body instanceof ReadableStream) {
		return undefined
	}
	if (body instanceof Blob) {
		return body.text()
	}
	if (body instanceof ArrayBuffer) {
		return new TextDecoder().decode(body)
	}
	if (ArrayBuffer.isView(body)) {
		return new TextDecoder().decode(body)
	}
	return undefined
}

export const getDefaultCodexInstructions = (): string =>
	DEFAULT_CODEX_INSTRUCTIONS

const normalizeResponsesInput = (input: unknown): unknown =>
	typeof input === "string"
		? [
				{
					role: "user",
					content: [{ type: "input_text", text: input }],
				},
			]
		: input

const addEncryptedReasoningContent = (include: unknown): string[] => {
	const values = Array.isArray(include)
		? include.filter((value): value is string => typeof value === "string")
		: []
	if (!values.includes("reasoning.encrypted_content")) {
		values.push("reasoning.encrypted_content")
	}
	return values
}

const applyModelDefaults = (
	normalized: Record<string, unknown>,
	modelInfo: CodexModelInfo | undefined,
): void => {
	// Codex's ResponsesApiRequest always serializes tool_choice:"auto" and a
	// boolean parallel_tool_calls (client.rs:886-887), regardless of model.
	// Their absence lets the server default them, but a genuine codex body
	// always carries both, so stamp them when the caller left them unset.
	if (normalized.tool_choice === undefined) {
		normalized.tool_choice = "auto"
	}

	if (!modelInfo) {
		return
	}

	const reasoning = isRecord(normalized.reasoning)
		? { ...normalized.reasoning }
		: {}
	if (
		reasoning.effort === undefined &&
		modelInfo.defaultReasoningLevel !== undefined
	) {
		reasoning.effort = modelInfo.defaultReasoningLevel
	}
	if (modelInfo.useResponsesLite) {
		reasoning.context = "all_turns"
	}
	if (Object.keys(reasoning).length > 0) {
		normalized.reasoning = reasoning
	}

	if (modelInfo.supportVerbosity && modelInfo.defaultVerbosity !== undefined) {
		const text = isRecord(normalized.text) ? { ...normalized.text } : {}
		if (text.verbosity === undefined) {
			text.verbosity = modelInfo.defaultVerbosity
		}
		normalized.text = text
	}

	if (!modelInfo.useResponsesLite) {
		// Non-Lite: codex sends parallel_tool_calls = prompt.parallel_tool_calls &&
		// !lite, so a caller's explicit value is honored; only stamp the codex
		// default (false) when the caller left it unset. The Lite branch below
		// forces it false, so it must not be touched here.
		if (normalized.parallel_tool_calls === undefined) {
			normalized.parallel_tool_calls = false
		}
		return
	}

	const input = Array.isArray(normalized.input) ? [...normalized.input] : []
	const prefix: unknown[] = []
	const tools = Array.isArray(normalized.tools) ? normalized.tools : []
	if (
		tools.length > 0 &&
		!input.some((item) => isRecord(item) && item.type === "additional_tools")
	) {
		prefix.push({
			type: "additional_tools",
			role: "developer",
			tools,
		})
	}

	if (typeof normalized.instructions === "string" && normalized.instructions) {
		prefix.push({
			role: "developer",
			content: [{ type: "input_text", text: normalized.instructions }],
		})
	}

	normalized.input = [...prefix, ...input]
	normalized.instructions = ""
	// Lite: codex computes parallel_tool_calls = prompt.parallel_tool_calls &&
	// !use_responses_lite, which is always false on this path — force it.
	normalized.parallel_tool_calls = false
	delete normalized.tools
}

const normalizeCodexResponsesBodyInternal = (
	body: Record<string, unknown>,
	options: InternalNormalizeCodexResponsesBodyOptions = {},
): Record<string, unknown> => {
	const normalized = { ...body }
	const instructions =
		typeof normalized.instructions === "string"
			? normalized.instructions
			: (options.instructions ?? getDefaultCodexInstructions())

	normalized.instructions = instructions
	normalized.input = normalizeResponsesInput(normalized.input)
	normalized.store = false
	normalized.include = addEncryptedReasoningContent(normalized.include)
	applyModelDefaults(normalized, options.modelInfo)

	if (options.forceStream) {
		normalized.stream = true
	}
	delete normalized.max_output_tokens
	return normalized
}

export const normalizeCodexResponsesBody = (
	body: Record<string, unknown>,
	options: NormalizeCodexResponsesBodyOptions = {},
): Record<string, unknown> => normalizeCodexResponsesBodyInternal(body, options)

type PreparedResponsesRequestBody = {
	body: BodyInit | null | undefined
	requestBody?: Record<string, unknown>
	wantsStream?: boolean
}

type ResolveModelInfo = (
	auth: OpenAIOAuthSession,
	model: string,
) => Promise<CodexModelInfo | undefined>

const prepareResponsesRequestBody = async (
	pathname: string,
	headers: Headers,
	body: BodyInit | null | undefined,
	settings: CodexOAuthRuntimeSettings,
	state: CodexResponsesState | undefined,
	auth: OpenAIOAuthSession,
	resolveModelInfo: ResolveModelInfo,
	validateStateReferences: (body: Record<string, unknown>) => void,
): Promise<PreparedResponsesRequestBody> => {
	if (!pathname.endsWith("/responses")) {
		return { body }
	}
	const contentType = headers
		.get("content-type")
		?.split(";", 1)[0]
		?.trim()
		.toLowerCase()
	if (contentType && contentType !== "application/json") {
		return { body }
	}
	const bodyText = await decodeBody(body)
	if (typeof bodyText !== "string") {
		return { body }
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(bodyText)
	} catch {
		return { body }
	}
	if (!isRecord(parsed)) return { body }
	{
		const wantsStream = parsed.stream === true
		const modelInfo =
			typeof parsed.model === "string"
				? await resolveModelInfo(auth, parsed.model)
				: undefined

		const normalized = normalizeCodexResponsesBodyInternal(parsed, {
			forceStream: true,
			instructions: settings.instructions,
			modelInfo,
		})
		if (modelInfo?.useResponsesLite) {
			headers.set(RESPONSES_LITE_HEADER, "true")
		}

		// Codex ties prompt-cache affinity to the session id twice: the
		// `session-id` header and an identical `prompt_cache_key` in the body
		// (codex.rs prompt_cache_key() = responses_session_id). With no session
		// id at all it still always sends one (its thread id), so stamp a fresh
		// UUID as the single missing conversation identity.
		const sessionId = headers.get("session-id")
		if (sessionId !== null && normalized.prompt_cache_key === undefined) {
			normalized.prompt_cache_key = sessionId
		}
		// Root-session parity (core/src/session/session.rs:892 — "session_id is
		// equal to the root thread's ID"): a caller-provided session id without a
		// thread id means thread-id == session-id, and codex still stamps
		// thread-id/x-client-request-id/x-codex-window-id on the request.
		if (headers.get("thread-id") === null && sessionId !== null) {
			headers.set("thread-id", sessionId)
			headers.set("x-client-request-id", sessionId)
			headers.set("x-codex-window-id", `${sessionId}:0`)
		}
		if (sessionId === null) {
			// Time-ordered v7 like every other codex-issued thread/session id
			// (protocol/src/items.rs) — a v4 here reads generationally wrong.
			const minted = randomUUIDv7()
			headers.set("session-id", minted)
			headers.set("thread-id", minted)
			headers.set("x-client-request-id", minted)
			// compatibility_headers() stamps x-codex-window-id on every /responses
			// request; a SDK passthrough has one window, codex's ":0".
			headers.set("x-codex-window-id", `${minted}:0`)
			if (normalized.prompt_cache_key === undefined) {
				normalized.prompt_cache_key = minted
			}
		}

		// Codex sends the conversation identity block on every /responses body
		// (CodexResponsesMetadata::client_metadata): installation id + session,
		// thread and window ids. Send only ids we know are real — never
		// fabricate an installation id here (a minted "device" inconsistent with
		// the account's registry state is worse than the older-client absence).
		if (normalized.client_metadata === undefined) {
			const installationId =
				settings.headers?.["x-codex-installation-id"] ??
				settings.headers?.installation_id
			const metadata: Record<string, string> = {}
			if (sessionId !== null) {
				metadata.session_id = sessionId
			}
			const threadId = headers.get("thread-id")
			if (threadId !== null) {
				metadata.thread_id = threadId
			}
			if (installationId !== undefined) {
				metadata["x-codex-installation-id"] = installationId
			}
			// window_id is non-optional in codex's client_metadata and takes the
			// form "<thread_id>:<window_number>". An explicit caller/config value
			// wins; otherwise derive it from the thread id as codex's first (only)
			// window ":0" so the block matches codex's always-present shape.
			const configuredWindowId =
				settings.headers?.["x-codex-window-id"] ?? settings.headers?.window_id
			const derivedWindowId =
				configuredWindowId ?? (threadId !== null ? `${threadId}:0` : undefined)
			if (derivedWindowId !== undefined) {
				metadata["x-codex-window-id"] = derivedWindowId
			}
			// codex mints a fresh v7 turn_id per turn and ships it here when the
			// request is turn-shaped (turn_metadata.rs:136 → client_metadata
			// responses_metadata.rs:325-327). Emit it only under caller pin: bare
			// consumers sending a fresh turn_id per HTTP request read as many
			// distinct turns, where one device should keep a coherent turn id
			// for the conversation.
			const pinnedTurnId = settings.headers?.turn_id
			if (pinnedTurnId !== undefined) {
				metadata.turn_id = pinnedTurnId
			}
			if (Object.keys(metadata).length > 0) {
				normalized.client_metadata = metadata
			}
		}

		// Captures advance synchronously with consumer reads. Never wait for all
		// other active streams on this owner merely to resolve one predecessor.
		validateStateReferences(normalized)
		const expanded = state?.expandRequestBody(normalized) ?? normalized

		return {
			body: JSON.stringify(expanded),
			requestBody: expanded,
			wantsStream,
		}
	}
}

const captureResponsesState = (
	response: Response,
	requestBody: Record<string, unknown> | undefined,
	state: CodexResponsesState | undefined,
	limits?: SseLimits,
	signal?: AbortSignal | null,
	hooks?: {
		context: ResponsesContext
		completed?: CodexOAuthRuntimeSettings["onResponseCompleted"]
		event?: CodexOAuthRuntimeSettings["onResponseEvent"]
		error?: CodexOAuthRuntimeSettings["onResponseError"]
	},
): Response => {
	if (!requestBody || !response.ok || !response.body) return response
	const reader = response.body.getReader()
	const parser = new SseParser(limits)
	const collector = new ResponseSseCollector(limits)
	let settled = false
	let captured = false
	let settleCapture: () => void = () => undefined
	const capture = new Promise<void>((resolve) => {
		settleCapture = resolve
	})
	state?.trackPendingCapture(capture)
	const finish = () => {
		if (settled) return
		settled = true
		signal?.removeEventListener("abort", abort)
		settleCapture()
	}
	const collect = (events: Iterable<import("./sse.js").ServerSentEvent>) => {
		for (const event of events) {
			if (hooks?.event && event.data) {
				let parsed: unknown
				try {
					parsed = JSON.parse(event.data)
				} catch {}
				if (
					isRecord(parsed) &&
					(parsed.type === "codex.rate_limits" ||
						event.event === "codex.rate_limits" ||
						parsed.type === "codex.response.metadata" ||
						event.event === "codex.response.metadata")
				)
					hooks.event(parsed, hooks.context)
			}
			collector.accept(event)
		}
		if (collector.terminal && !captured) {
			captured = true
			state?.rememberResponse(collector.finish(), requestBody)
			hooks?.completed?.(collector.finish(), hooks.context)
			settleCapture()
		}
	}
	let controller: ReadableStreamDefaultController<Uint8Array>
	const abort = () => {
		if (settled) return
		const reason = signal?.reason ?? new DOMException("Aborted", "AbortError")
		finish()
		void reader.cancel(reason).catch(() => undefined)
		controller.error(reason)
	}
	const body = new ReadableStream<Uint8Array>(
		{
			start(value) {
				controller = value
				signal?.addEventListener("abort", abort, { once: true })
				if (signal?.aborted) abort()
			},
			async pull(value) {
				try {
					const chunk = await readWithSignal(
						reader,
						signal,
						limits?.idleTimeoutMs,
					)
					if (settled) return
					if (chunk.done) {
						collect(parser.finish())
						collector.finish()
						finish()
						reader.releaseLock()
						value.close()
						return
					}
					collect(parser.push(chunk.value))
					value.enqueue(chunk.value)
					if (collector.terminal) {
						finish()
						void reader.cancel().catch(() => undefined)
						value.close()
					}
				} catch (error) {
					if (settled) return
					finish()
					if (!signal?.aborted) hooks?.error?.(error, hooks.context)
					void reader.cancel(error).catch(() => undefined)
					value.error(error)
				}
			},
			cancel(reason) {
				finish()
				return reader.cancel(reason)
			},
		},
		{ highWaterMark: 0 },
	)
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: new Headers(response.headers),
	})
}

const finalizeResponsesResponse = async (
	response: Response,
	prepared: PreparedResponsesRequestBody,
	state: CodexResponsesState | undefined,
	limits?: SseLimits,
	signal?: AbortSignal | null,
	hooks?: Parameters<typeof captureResponsesState>[5],
): Promise<Response> => {
	if (
		prepared.requestBody == null ||
		prepared.wantsStream == null ||
		!response.ok ||
		response.body == null
	) {
		return response
	}

	const observed = captureResponsesState(
		response,
		prepared.requestBody,
		state,
		limits,
		signal,
		hooks,
	)
	if (prepared.wantsStream) return observed

	if (!observed.body) return observed
	const completed = await collectCompletedResponseFromSse(observed.body, limits)
	const headers = new Headers(response.headers)
	headers.delete("content-encoding")
	headers.delete("content-length")
	headers.set("content-type", "application/json")
	return new Response(JSON.stringify(completed), {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}

const applyAuthHeaders = (
	headers: Headers,
	auth: OpenAIOAuthSession,
	codexVersion?: string,
	terminalToken?: string,
): void => {
	headers.delete("authorization")
	headers.delete("chatgpt-account-id")
	headers.delete("openai-beta")
	headers.delete(RESPONSES_LITE_HEADER)
	headers.delete("x-openai-fedramp")
	headers.set("Authorization", `Bearer ${auth.accessToken}`)
	headers.set("chatgpt-account-id", auth.accountId)
	if (auth.isFedRamp === true) headers.set("x-openai-fedramp", "true")

	// Account-routing metadata comes only from the selected trusted session.
	// Caller headers must not be able to select another account or compliance route.
	// Non-routing header overrides remain configurable.
	if (!headers.has("originator")) {
		headers.set("originator", DEFAULT_CODEX_ORIGINATOR)
	}
	if (!headers.has("user-agent")) {
		headers.set(
			"User-Agent",
			codexVersion
				? buildCodexUserAgent(codexVersion, terminalToken)
				: DEFAULT_CODEX_USER_AGENT,
		)
	}
	// Codex negotiates SSE only on /responses (endpoint/responses.rs sets
	// ACCEPT: text/event-stream per-request, inside the responses stream path).
	// It is deliberately NOT set here: this helper also serves /models and other
	// non-streaming calls, where codex sends no explicit Accept. The /responses
	// path stamps it explicitly before dispatch.
	const sessionId = headers.get("session-id")
	if (sessionId) {
		// Codex derives prompt-cache affinity from session-id and mirrors the
		// thread id in both thread-id and x-client-request-id.
		if (!headers.has("thread-id")) {
			headers.set("thread-id", sessionId)
		}
		if (!headers.has("x-client-request-id")) {
			headers.set("x-client-request-id", sessionId)
		}
	}
}

const createModelCatalogResolver = (
	fetch: FetchFunction,
	baseURL: string,
	settings: CodexOAuthRuntimeSettings,
) => {
	const maxStaleMs = settings.modelCatalogMaxStaleMs ?? 30 * 60 * 1000
	if (!Number.isFinite(maxStaleMs) || maxStaleMs < 0)
		throw new Error(
			"modelCatalogMaxStaleMs must be a nonnegative finite number.",
		)
	const field = (value: unknown): string | null =>
		typeof value === "string" && value.length > 0 && value.length <= 256
			? value
			: null
	return createModelCatalogCache({
		maxStaleMs,
		signal: settings.signal,
		identity: (auth) => {
			const claims = [auth.idToken, auth.accessToken].map((token) => {
				const parsed = parseJwtClaims(token)?.["https://api.openai.com/auth"]
				return isRecord(parsed) ? parsed : {}
			})
			const user =
				claims
					.map((claim) => field(claim.chatgpt_user_id) ?? field(claim.user_id))
					.find(Boolean) ?? null
			const plan =
				claims.map((claim) => field(claim.chatgpt_plan_type)).find(Boolean) ??
				null
			return JSON.stringify([
				baseURL,
				auth.accountId,
				auth.isFedRamp === true,
				user,
				plan,
			])
		},
		fetch: (auth, version) =>
			fetchCodexModelCatalogSnapshot(
				{
					request: async (path, init) => {
						const headers = new Headers(settings.headers)
						new Headers(init?.headers).forEach((value, key) => {
							headers.set(key, value)
						})
						applyAuthHeaders(headers, auth, version, settings.terminalToken)
						const response = await fetch(resolveTargetUrl(path, baseURL), {
							...init,
							method: init?.method ?? "GET",
							headers,
							// Shared discovery never weakens another caller's redirect restriction.
							redirect: "error",
						})
						settings.onModelCatalogResponse?.(response, { session: auth })
						return response
					},
				},
				{
					codexVersion: version,
					timeoutMs: settings.modelCatalogTimeoutMs,
					signal: settings.signal,
				},
			),
	})
}

const resolveAuth = async (
	source: OpenAIOAuthSessionInput,
): Promise<OpenAIOAuthSession> => {
	const auth = typeof source === "function" ? await source() : source
	if (!auth) {
		throw new Error("OpenAI OAuth session not found.")
	}
	return auth
}

const createCodexOAuthFetch = (
	settings: CodexOAuthRuntimeSettings,
): {
	fetch: FetchFunction
	getModelCatalog: NonNullable<OpenAIOAuthTransport["getModelCatalog"]>
} => {
	validateTimeout(settings.modelCatalogTimeoutMs, "modelCatalogTimeoutMs")
	validateTimeout(settings.requestTimeoutMs, "requestTimeoutMs")
	validateTimeout(settings.streamIdleTimeoutMs, "streamIdleTimeoutMs")
	const fetch = pickFetch(settings.fetch)
	const baseURL = resolveBaseURL(settings.baseURL)
	// Cache keys exclude access tokens: a refresh is not an ownership change.
	// In-flight responses retain their own state reference, so an older owner's
	// completion cannot populate a different owner's cache after auth switches.
	const states = new Map<string, CodexResponsesState>()
	let suppliedStateOwner: string | undefined
	const stateFor = (
		auth: OpenAIOAuthSession,
	): CodexResponsesState | undefined => {
		if (settings.responsesState === false) return undefined
		const key = JSON.stringify([auth.accountId, auth.isFedRamp === true])
		let state = states.get(key)
		if (!state) {
			state =
				settings.responsesState && suppliedStateOwner === undefined
					? settings.responsesState
					: new CodexResponsesState()
			state.claimOwner(key)
			if (suppliedStateOwner === undefined) suppliedStateOwner = key
			if (states.size >= 8) {
				const oldest = states.keys().next().value
				if (oldest !== undefined) states.delete(oldest)
			}
			states.set(key, state)
		}
		return state
	}
	const modelCatalog = createModelCatalogResolver(fetch, baseURL, settings)
	// Resolved once (mirrors the npm-registry lookup the model catalog already
	// performs) and stamped onto the default Codex User-Agent from then on.
	// Pre-resolution requests keep the pinned fallback UA; a literal
	// settings.headers["User-Agent"] always wins over both.
	let resolvedCodexVersion: string | undefined
	let codexVersionPromise: Promise<string> | undefined
	const resolveUserAgentVersion = (): Promise<string> => {
		codexVersionPromise ??= resolveCodexClientVersion({
			codexVersion: settings.codexVersion,
			fetchImpl: settings.fetch ?? globalThis.fetch?.bind(globalThis),
			timeoutMs: settings.modelCatalogTimeoutMs,
			signal: settings.signal,
		})
			.then((version) => {
				resolvedCodexVersion = version
				return version
			})
			.catch(() => {
				resolvedCodexVersion = DEFAULT_CODEX_CLIENT_VERSION
				return resolvedCodexVersion
			})
			.finally(() => {
				codexVersionPromise = undefined
			})
		return codexVersionPromise
	}

	const getModelCatalog: NonNullable<
		OpenAIOAuthTransport["getModelCatalog"]
	> = async (options = {}) => {
		options.signal?.throwIfAborted()
		settings.signal?.throwIfAborted()
		if (options.cacheOnly && options.refresh)
			throw new Error("cacheOnly and refresh cannot both be enabled.")
		const cached = modelCatalog.copy(modelCatalog.peek(), options)
		if (options.cacheOnly) return cached
		const scope = createOperationScope(
			settings.requestTimeoutMs,
			[settings.signal, options.signal],
			"Catalog inspection",
		)
		try {
			const auth = await waitWithSignal(
				resolveAuth(settings.auth),
				scope.signal,
			)
			const version = await waitWithSignal(
				resolveUserAgentVersion(),
				scope.signal,
			)
			const capture = modelCatalog.select(auth, version)
			const snapshot = await waitWithSignal(
				modelCatalog.resolve(capture, options.refresh),
				scope.signal,
			)
			return modelCatalog.copy(snapshot, options)
		} finally {
			scope.dispose()
		}
	}
	const authenticatedFetch: FetchFunction = async (input, init) => {
		const scope = createOperationScope(
			settings.requestTimeoutMs,
			[
				settings.signal,
				init?.signal ?? (input instanceof Request ? input.signal : undefined),
			],
			"Request",
		)
		const signal = scope.signal
		let bodyOwnsScope = false
		try {
			if (signal?.aborted)
				throw signal.reason ?? new DOMException("Aborted", "AbortError")
			const request = await waitWithSignal(
				readRequestParts(input, init),
				signal,
			)
			request.signal = signal
			const targetUrl = resolveTargetUrl(request.url, baseURL)
			const target = new URL(targetUrl)
			const auth = await waitWithSignal(resolveAuth(settings.auth), signal)
			const responsesState = stateFor(auth)
			const userAgentResolution = resolveUserAgentVersion()
			const catalogCapture = modelCatalog.select(
				auth,
				await waitWithSignal(userAgentResolution, signal),
			)
			const resolveModelInfo: ResolveModelInfo = async (_auth, model) =>
				(await modelCatalog.resolve(catalogCapture)).models.find(
					(entry) => entry.slug === model,
				)
			if (
				(request.method ?? "GET").toUpperCase() === "GET" &&
				target.pathname.endsWith("/models") &&
				!target.searchParams.has("client_version")
			) {
				const catalog = await waitWithSignal(
					modelCatalog.resolve(catalogCapture),
					signal,
				)
				const models = catalog.models.filter(isPublicCodexModel)
				if (models.length === 0) {
					return Response.json(
						{
							error: {
								message:
									modelCatalog.error(catalogCapture)?.message ??
									"Failed to load models from Codex.",
							},
						},
						{ status: 502 },
					)
				}
				return Response.json({
					object: "list",
					data: [
						...models.map((model) => ({
							id: model.slug,
							object: "model",
							created: 0,
							owned_by: "codex-oauth",
						})),
						...(models.some((model) => model.slug === CODEX_IMAGE_MODEL)
							? []
							: [
									{
										id: CODEX_IMAGE_MODEL,
										object: "model",
										created: 0,
										owned_by: "codex-oauth",
									},
								]),
					],
				})
			}

			const headers = new Headers(settings.headers)
			request.headers.forEach((value, key) => {
				headers.set(key, value)
			})
			// Codex CLI sends one `session-id` per conversation (the thread id used
			// for prompt-cache affinity). The settings-level session id is only a
			// fallback device identity for pools that don't already stamp a
			// conversation-scoped `session-id` per request; any per-request value
			// merged above always wins. Underscore `session_id` is a settings-side
			// configuration key, never sent verbatim.
			const configuredSessionId =
				settings.headers?.session_id ?? settings.headers?.["session-id"]
			if (configuredSessionId !== undefined) {
				headers.delete("session_id")
				if (!headers.has("session-id")) {
					headers.set("session-id", configuredSessionId)
				}
			}
			// Underscore installation_id is a settings-side key too: it belongs only
			// in the body's client_metadata (added in prepareResponsesRequestBody),
			// never as a literal request header.
			headers.delete("installation_id")
			// Await the one-time version resolution so the first request already
			// stamps the fully-resolved UA (originator + version + per-account
			// terminalToken) instead of the build-frozen DEFAULT_CODEX_USER_AGENT —
			// which would otherwise drop terminalToken on the fallback path.
			await waitWithSignal(Promise.resolve(userAgentResolution), signal)
			applyAuthHeaders(
				headers,
				auth,
				resolvedCodexVersion,
				settings.terminalToken,
			)
			// Codex's built-in OpenAI provider carries a static `version` header set to
			// its build version on every request (model-provider-info/src/lib.rs:474
			// http_headers → applied to /responses, /models, ws, everything). Matches
			// the UA's version segment — never let it float off resolvedCodexVersion.
			if (!headers.has("version")) {
				headers.set(
					"version",
					resolvedCodexVersion ?? DEFAULT_CODEX_CLIENT_VERSION,
				)
			}
			// Codex sets Accept: text/event-stream only on the /responses streaming
			// endpoint; /models and image calls get no explicit Accept header.
			if (target.pathname.endsWith("/responses") && !headers.has("accept")) {
				headers.set("Accept", "text/event-stream")
			}
			const preparedImage = await waitWithSignal(
				prepareCodexImageRequest(
					target.pathname,
					headers,
					request.body,
					settings.imageLimits,
				),
				signal,
			)
			if (preparedImage.response) {
				return preparedImage.response
			}

			const preparedBody = await waitWithSignal(
				prepareResponsesRequestBody(
					target.pathname,
					headers,
					preparedImage.body,
					settings,
					responsesState,
					auth,
					resolveModelInfo,
					(body) => {
						const predecessor =
							typeof body.previous_response_id === "string"
								? body.previous_response_id
								: undefined
						const items = Array.isArray(body.input)
							? body.input
									.filter(isRecord)
									.filter(
										(item) =>
											item.type === "item_reference" &&
											typeof item.id === "string",
									)
							: []
						for (const other of states.values()) {
							if (other === responsesState) continue
							if (
								(predecessor &&
									!responsesState?.hasResponse(predecessor) &&
									other.hasResponse(predecessor)) ||
								items.some(
									(item) =>
										!responsesState?.hasItem(item.id as string) &&
										other.hasItem(item.id as string),
								)
							) {
								throw new Error(
									"Continuation state belongs to a different authenticated account.",
								)
							}
						}
					},
				),
				signal,
			)

			const dispatchInit: RequestInit = {
				method: request.method ?? init?.method,
				redirect: request.redirect,
				headers,
				body: preparedBody.body,
				signal: request.signal ?? undefined,
			}
			if (signal?.aborted)
				throw signal.reason ?? new DOMException("Aborted", "AbortError")
			const dispatch =
				preparedBody.requestBody && settings.executeResponses
					? settings.executeResponses(target.toString(), dispatchInit, auth)
					: fetch(target.toString(), dispatchInit)
			void dispatch.then(
				(late) => {
					if (signal.aborted)
						void late.body?.cancel(signal.reason).catch(() => undefined)
				},
				() => undefined,
			)
			const response = await waitWithSignal(dispatch, signal)
			modelCatalog.observe(
				catalogCapture,
				response.headers.get("x-models-etag"),
			)

			const finalized = await finalizeResponsesResponse(
				response,
				preparedBody,
				responsesState,
				{
					...settings.responseLimits,
					idleTimeoutMs:
						settings.streamIdleTimeoutMs ??
						settings.responseLimits?.idleTimeoutMs,
				},
				signal,
				preparedBody.requestBody
					? {
							context: {
								session: auth,
								request: preparedBody.requestBody,
								headers: new Headers(dispatchInit.headers),
							},
							completed: settings.onResponseCompleted,
							event: (event, context) => {
								if (
									event.type === "codex.response.metadata" &&
									isRecord(event.headers)
								) {
									for (const [name, value] of Object.entries(event.headers)) {
										if (name.toLowerCase() === "x-models-etag")
											modelCatalog.observe(catalogCapture, value)
									}
								}
								settings.onResponseEvent?.(event, context)
							},
							error: settings.onResponseError,
						}
					: undefined,
			)
			if (!finalized.body) return finalized
			bodyOwnsScope = true
			return retainResponseScope(finalized, scope)
		} finally {
			if (!bodyOwnsScope) scope.dispose()
		}
	}
	return { fetch: authenticatedFetch, getModelCatalog }
}

/** Keep a total request deadline alive until the consumer finishes or cancels. */
const retainResponseScope = (
	response: Response,
	scope: ReturnType<typeof createOperationScope>,
): Response => {
	if (!response.body) {
		scope.dispose()
		return response
	}
	const reader = response.body.getReader()
	let done = false
	let controller: ReadableStreamDefaultController<Uint8Array>
	const finish = () => {
		if (done) return
		done = true
		scope.signal.removeEventListener("abort", abort)
		scope.dispose()
	}
	const abort = () => {
		if (done) return
		finish()
		void reader.cancel(scope.signal.reason).catch(() => undefined)
		controller.error(scope.signal.reason)
	}
	const stream = new ReadableStream<Uint8Array>(
		{
			start(value) {
				controller = value
				scope.signal.addEventListener("abort", abort, { once: true })
				if (scope.signal.aborted) abort()
			},
			async pull(value) {
				try {
					const chunk = await readWithSignal(reader, scope.signal)
					if (done) return
					if (chunk.done) {
						finish()
						reader.releaseLock()
						value.close()
					} else value.enqueue(chunk.value)
				} catch (error) {
					if (done) return
					finish()
					void reader.cancel(error).catch(() => undefined)
					value.error(error)
				}
			},
			cancel(reason) {
				finish()
				return reader.cancel(reason)
			},
		},
		{ highWaterMark: 0 },
	)
	return new Response(stream, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	})
}

const resolveOpenAICompatibleUrl = (path: string, baseURL: string): string => {
	if (/^https?:\/\//.test(path)) {
		return path
	}

	const normalizedPath = path.startsWith("/v1/")
		? path.slice("/v1/".length)
		: path.replace(/^\//, "")

	return new URL(normalizedPath, `${baseURL}/`).toString()
}

export const createOpenAIOAuthTransport = (
	settings: OpenAIOAuthTransportOptions,
): OpenAIOAuthTransport & {
	getModelCatalog: NonNullable<OpenAIOAuthTransport["getModelCatalog"]>
} => {
	const baseURL = resolveOpenAIBaseURL(settings.openAIBaseURL)
	const { fetch, getModelCatalog } = createCodexOAuthFetch(settings)

	return {
		kind: "openai-compatible",
		baseURL,
		fetch,
		getModelCatalog,
		request: (path, init) =>
			fetch(resolveOpenAICompatibleUrl(path, baseURL), init),
	}
}
