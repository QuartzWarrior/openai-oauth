import type { FetchFunction } from "@openai-oauth/core"

// Mirrors codex http-client chatgpt_cloudflare_cookies.rs: only Cloudflare
// service cookies plus the `__oailb` routing cookie are ever retained, and only
// for HTTPS/WSS ChatGPT hosts. Account, session and auth cookies are refused.
// Unlike codex's process-global store, each pool account owns its own jar so
// infrastructure cookies can never link accounts together.
const ALLOWED_COOKIE_NAMES = new Set([
	"__cf_bm",
	"__cflb",
	"__cfruid",
	"__cfseq",
	"__cfwaitingroom",
	"__oailb",
	"_cfuvid",
	"cf_clearance",
	"cf_ob_info",
	"cf_use_ob",
])
const MAX_COOKIES = 64
const MAX_COOKIE_BYTES = 4096

export const isAllowedChatGptCookieName = (name: string): boolean =>
	ALLOWED_COOKIE_NAMES.has(name) || name.startsWith("cf_chl_")

// codex http-client chatgpt_hosts.rs is_allowed_chatgpt_host.
const isChatGptHost = (host: string): boolean =>
	["chatgpt.com", "chat.openai.com", "chatgpt-staging.com"].includes(host) ||
	host.endsWith(".chatgpt.com") ||
	host.endsWith(".chatgpt-staging.com")

/** A secure WebSocket handshake has the same cookie scope as HTTPS. */
const cookieUrl = (input: string | URL): URL | undefined => {
	let url: URL
	try {
		url = new URL(input)
	} catch {
		return undefined
	}
	if (url.protocol === "wss:") url = new URL(`https:${url.href.slice(4)}`)
	return url.protocol === "https:" && isChatGptHost(url.hostname)
		? url
		: undefined
}

type StoredCookie = {
	name: string
	value: string
	domain: string
	hostOnly: boolean
	path: string
	expiresAt?: number
}

// RFC 6265 5.1.4 default-path.
const defaultPath = (pathname: string): string => {
	const slash = pathname.lastIndexOf("/")
	return slash <= 0 ? "/" : pathname.slice(0, slash)
}

const pathMatches = (requestPath: string, cookiePath: string): boolean =>
	requestPath === cookiePath ||
	(requestPath.startsWith(cookiePath) &&
		(cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/"))

const domainMatches = (host: string, cookie: StoredCookie): boolean =>
	cookie.hostOnly
		? host === cookie.domain
		: host === cookie.domain || host.endsWith(`.${cookie.domain}`)

export class ChatGptCookieJar {
	private readonly cookies = new Map<string, StoredCookie>()

	constructor(private readonly now: () => number = Date.now) {}

	/** Cookie header for an HTTPS/WSS ChatGPT request, or undefined. */
	header(input: string | URL): string | undefined {
		const url = cookieUrl(input)
		if (!url) return undefined
		const now = this.now()
		const matches: StoredCookie[] = []
		for (const [key, cookie] of this.cookies) {
			if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) {
				this.cookies.delete(key)
				continue
			}
			if (
				domainMatches(url.hostname, cookie) &&
				pathMatches(url.pathname, cookie.path)
			)
				matches.push(cookie)
		}
		if (matches.length === 0) return undefined
		// RFC 6265 5.4: longer paths first.
		matches.sort((a, b) => b.path.length - a.path.length)
		return matches.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")
	}

	/** Retain allowlisted infrastructure cookies from a ChatGPT response. */
	store(input: string | URL, setCookies: Iterable<string>): void {
		const url = cookieUrl(input)
		if (!url) return
		for (const line of setCookies) this.storeOne(url, line)
	}

	clear(): void {
		this.cookies.clear()
	}

	private storeOne(url: URL, line: string): void {
		if (line.length > MAX_COOKIE_BYTES) return
		const [pair = "", ...attributes] = line.split(";")
		const equals = pair.indexOf("=")
		if (equals <= 0) return
		const name = pair.slice(0, equals).trim()
		const value = pair.slice(equals + 1).trim()
		if (!isAllowedChatGptCookieName(name) || /[\s;,]/.test(value)) return
		const now = this.now()
		let domain = url.hostname
		let hostOnly = true
		let path = defaultPath(url.pathname)
		let expiresAt: number | undefined
		let maxAgeSeen = false
		for (const attribute of attributes) {
			const index = attribute.indexOf("=")
			const key = (index < 0 ? attribute : attribute.slice(0, index))
				.trim()
				.toLowerCase()
			const raw = index < 0 ? "" : attribute.slice(index + 1).trim()
			if (key === "max-age" && /^-?\d+$/.test(raw)) {
				maxAgeSeen = true
				const seconds = Number(raw)
				expiresAt = seconds <= 0 ? 0 : now + seconds * 1000
			} else if (key === "expires" && !maxAgeSeen) {
				const date = Date.parse(raw)
				if (!Number.isNaN(date)) expiresAt = date
			} else if (key === "domain" && raw) {
				const candidate = raw.replace(/^\./, "").toLowerCase()
				// Reject cookies scoped outside the responding ChatGPT host.
				if (
					!isChatGptHost(candidate) ||
					(url.hostname !== candidate &&
						!url.hostname.endsWith(`.${candidate}`))
				)
					return
				domain = candidate
				hostOnly = false
			} else if (key === "path" && raw.startsWith("/")) {
				path = raw
			}
		}
		const key = JSON.stringify([name, domain, path])
		this.cookies.delete(key)
		if (expiresAt !== undefined && expiresAt <= now) return
		if (this.cookies.size >= MAX_COOKIES) {
			const oldest = this.cookies.keys().next().value
			if (oldest !== undefined) this.cookies.delete(oldest)
		}
		this.cookies.set(key, { name, value, domain, hostOnly, path, expiresAt })
	}
}

const setCookiesOf = (headers: Headers): string[] =>
	typeof headers.getSetCookie === "function"
		? headers.getSetCookie()
		: (headers.get("set-cookie")?.split(/,(?=\s*[^;=\s]+=)/) ?? [])

/**
 * Sends and retains ChatGPT infrastructure cookies like codex's reqwest cookie
 * store. An explicit caller `Cookie` header takes precedence.
 */
export const withChatGptCookies = (
	fetch: FetchFunction,
	jar: ChatGptCookieJar,
): FetchFunction =>
	(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input)
		const cookie = jar.header(url)
		let nextInit = init
		if (cookie !== undefined) {
			const headers = new Headers(
				init?.headers ?? (input instanceof Request ? input.headers : undefined),
			)
			if (!headers.has("cookie")) {
				headers.set("cookie", cookie)
				nextInit = { ...init, headers }
			}
		}
		const response = await fetch(input, nextInit)
		jar.store(response.url || url, setCookiesOf(response.headers))
		return response
	}) as FetchFunction
