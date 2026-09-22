import type { FetchFunction } from "@openai-oauth/core"

type UndiciProxyAgent = {
	destroy?(): Promise<void>
	close?(): Promise<void>
	dispatch?: (...args: unknown[]) => unknown
}

type UndiciModule = {
	fetch: (
		url: string | URL,
		init?: Record<string, unknown>,
	) => Promise<Response>
	ProxyAgent: new (options: string | { uri: string }) => UndiciProxyAgent
}

const SUPPORTED_PROXY_PROTOCOLS = new Set(["http:", "https:"])

export type AccountRuntime = {
	fetch: FetchFunction
	fetchDispatcherUsed: boolean
	close(): Promise<void>
	destroy(): Promise<void>
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
		throw new Error("Invalid proxy URL. Expected an HTTP(S) proxy URL.")
	}
	if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol)) {
		throw new Error(
			`Unsupported proxy protocol "${parsed.protocol}". Supported: http, https.`,
		)
	}
}

/**
 * Builds a fetch implementation that routes through the given static proxy via
 * undici (Node.js >= 20.18.1). Each proxy URL gets its own ProxyAgent, which keeps
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
			"Proxy support requires Node.js >= 20.18.1. Account proxies are not available in browser/edge runtimes; omit `proxy` (or pass an explicit `fetch`) for those environments.",
		)
	}

	// Some runtimes provide an undici stub without dispatcher support.
	const agent = new undici.ProxyAgent({ uri: proxy })
	if (typeof agent.dispatch !== "function") {
		await agent.close?.()
		throw new Error(
			"This runtime cannot honor the configured proxy dispatcher. Use Node.js with undici or an explicit proxy-aware fetch.",
		)
	}
	const proxiedFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
		undici.fetch(input instanceof Request ? input.url : String(input), {
			...(input instanceof Request
				? {
						method: input.method,
						headers: input.headers,
						body: input.body,
						signal: input.signal,
						duplex: "half",
					}
				: {}),
			...(init ?? {}),
			dispatcher: agent,
		})) as FetchFunction

	return {
		fetch: proxiedFetch,
		fetchDispatcherUsed: true,
		destroy: async () => {
			if (agent.destroy) await agent.destroy()
			else await agent.close?.()
		},
		close: async () => {
			// undefined under Bun's stub; calling it throws "agent.close is not a
			// function". Only real undici exposes it.
			await agent.close?.()
		},
	}
}

export const createPlainRuntime = (fetch?: FetchFunction): AccountRuntime => ({
	fetch:
		fetch ??
		(((input: RequestInfo | URL, init?: RequestInit) =>
			globalThis.fetch(input, init)) as FetchFunction),
	fetchDispatcherUsed: false,
	close: () => Promise.resolve(),
	// Custom/global fetch resources are not owned by this adapter.
	destroy: () => Promise.resolve(),
})
