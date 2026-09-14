import type { FetchFunction } from "@openai-oauth/core"

type UndiciProxyAgent = {
	close(): Promise<void>
}

type UndiciModule = {
	fetch: (
		url: string | URL,
		init?: Record<string, unknown>,
	) => Promise<Response>
	ProxyAgent: new (options: string | { uri: string }) => UndiciProxyAgent
}

const SUPPORTED_PROXY_PROTOCOLS = new Set([
	"http:",
	"https:",
	"socks5:",
	"socks5h:",
])

export type AccountRuntime = {
	fetch: FetchFunction
	fetchDispatcherUsed: boolean
	close(): Promise<void>
}

let undiciModulePromise: Promise<UndiciModule | undefined> | undefined

const loadUndici = (): Promise<UndiciModule | undefined> => {
	undiciModulePromise ??= import("undici")
		.then((module) => module as UndiciModule)
		.catch(() => undefined)
	return undiciModulePromise
}

export const validateProxyUrl = (proxy: string): void => {
	let parsed: URL
	try {
		parsed = new URL(proxy)
	} catch {
		throw new Error(
			`Invalid proxy URL "${proxy}". Expected something like "http://user:pass@host:8000" or "socks5h://host:1080".`,
		)
	}
	if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol)) {
		throw new Error(
			`Unsupported proxy protocol "${parsed.protocol}". Supported: http, https, socks5, socks5h.`,
		)
	}
}

/**
 * Builds a fetch implementation that routes through the given static proxy via
 * undici (Node.js >= 20). Each proxy URL gets its own ProxyAgent, which keeps
 * connection pools, DNS, and credentials fully isolated per account.
 *
 * Throws in non-Node runtimes: when no undici-compatible environment is
 * present there is no way to honor per-request proxies through the standard
 * fetch API.
 */
export const createProxyRuntime = async (
	proxy: string,
): Promise<AccountRuntime> => {
	validateProxyUrl(proxy)

	const undici = await loadUndici()
	if (!undici) {
		throw new Error(
			"Proxy support requires Node.js >= 20. Account proxies are not available in browser/edge runtimes; omit `proxy` (or pass an explicit `fetch`) for those environments.",
		)
	}

	const agent = new undici.ProxyAgent({ uri: proxy })
	const proxiedFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
		undici.fetch(String(input instanceof Request ? input.url : input), {
			...(init ?? {}),
			dispatcher: agent,
		})) as FetchFunction

	return {
		fetch: proxiedFetch,
		fetchDispatcherUsed: true,
		close: () => agent.close(),
	}
}

export const createPlainRuntime = (fetch?: FetchFunction): AccountRuntime => ({
	fetch:
		fetch ??
		(((input: RequestInfo | URL, init?: RequestInit) =>
			globalThis.fetch(input, init)) as FetchFunction),
	fetchDispatcherUsed: false,
	close: () => Promise.resolve(),
})
