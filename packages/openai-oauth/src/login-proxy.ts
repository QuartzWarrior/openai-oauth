type ProxyDispatcher = {
	dispatch?: (...args: unknown[]) => unknown
	close?: () => Promise<void>
	destroy?: () => Promise<void>
}

type ProxyModule = {
	ProxyAgent: new (options: { uri: string }) => ProxyDispatcher
	fetch: (url: string | URL, init: Record<string, unknown>) => Promise<Response>
}

export type LoginProxy = {
	fetch: typeof fetch
	close: () => Promise<void>
}

const validateProxy = (value: string): string => {
	let url: URL
	try {
		url = new URL(value)
	} catch {
		throw new Error("Invalid login proxy URL. Expected an HTTP(S) proxy URL.")
	}
	if (
		!["http:", "https:"].includes(url.protocol) ||
		!url.hostname ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	) {
		throw new Error(
			"Invalid login proxy URL. Use HTTP(S) with a host and no path, query, or fragment.",
		)
	}
	return url.toString()
}

const abortReason = (signal: AbortSignal): unknown =>
	signal.reason ?? new DOMException("Aborted", "AbortError")

/** Dedicated Node dispatcher for the CLI's token exchange, not browser traffic. */
export const createLoginProxy = async (proxy: string): Promise<LoginProxy> => {
	const uri = validateProxy(proxy)
	let undici: ProxyModule
	let agent: ProxyDispatcher
	try {
		undici = (await import("undici")) as unknown as ProxyModule
		agent = new undici.ProxyAgent({ uri })
	} catch {
		throw new Error(
			"Could not initialize the login proxy. Use Node.js 20.18.1 or newer with undici.",
		)
	}

	let closing: Promise<void> | undefined
	const close = (): Promise<void> => {
		closing ??= Promise.resolve()
			.then(async () => {
				// Destroy active connections too, so cancellation cannot wait on a
				// hung token request. Some runtimes omit both lifecycle methods.
				if (typeof agent.destroy === "function") await agent.destroy()
				else if (typeof agent.close === "function") await agent.close()
			})
			.catch(() => {
				throw new Error("Could not close the login proxy.")
			})
		return closing
	}

	if (
		typeof agent.dispatch !== "function" ||
		typeof undici.fetch !== "function"
	) {
		await close().catch(() => undefined)
		throw new Error(
			"This runtime cannot honor a login proxy dispatcher. Use Node.js with undici.",
		)
	}

	const proxiedFetch = (async (
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> => {
		const signal =
			init?.signal !== undefined
				? init.signal
				: input instanceof Request
					? input.signal
					: undefined
		if (signal?.aborted) throw abortReason(signal)
		if (closing) throw new Error("The login proxy is closed.")
		try {
			// Native and undici Request objects need not be interchangeable.
			// Normalize Request overrides before passing their standard fields.
			const request =
				input instanceof Request ? new Request(input, init) : undefined
			const options: Record<string, unknown> = request
				? {
						...init,
						method: request.method,
						headers: request.headers,
						body: request.body,
						signal: request.signal,
						redirect: request.redirect,
						credentials: request.credentials,
						cache: request.cache,
						mode: request.mode,
						referrer: request.referrer,
						referrerPolicy: request.referrerPolicy,
						integrity: request.integrity,
						keepalive: request.keepalive,
					}
				: { ...init }
			if (options.body instanceof ReadableStream) options.duplex = "half"
			return await undici.fetch(request?.url ?? String(input), {
				...options,
				dispatcher: agent,
			})
		} catch {
			if (signal?.aborted) throw abortReason(signal)
			// Undici errors may include proxy userinfo or rejected credentials.
			throw new Error("Login proxy request failed.")
		}
	}) as typeof fetch

	return { fetch: proxiedFetch, close }
}
