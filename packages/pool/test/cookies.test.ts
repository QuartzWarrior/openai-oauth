import { createHash } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import {
	ChatGptCookieJar,
	isAllowedChatGptCookieName,
	withChatGptCookies,
} from "../src/cookie-jar.js"
import { createOpenAIPool } from "../src/index.js"
import {
	createWebsocketTransport,
	observeHandshakeCookies,
} from "../src/websocket-transport.js"
import { makeAuthFile, makeRequestInit, makeSseResponse } from "./helpers.js"

const RESPONSES = "https://chatgpt.com/backend-api/codex/responses"
const ORIGINAL_FETCH = globalThis.fetch

afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH
})

describe("ChatGptCookieJar", () => {
	it("retains only allowlisted infrastructure cookies", () => {
		const jar = new ChatGptCookieJar()
		jar.store(RESPONSES, [
			"__cflb=west; Path=/; Secure; HttpOnly",
			"_cfuvid=visitor; Path=/; Secure; HttpOnly",
			"__Secure-next-auth.session-token=secret; Path=/; Secure",
			"chatgpt_session=secret; Path=/",
			"oai-auth-token=secret; Path=/",
		])
		expect(jar.header(RESPONSES)?.split("; ").sort()).toEqual([
			"__cflb=west",
			"_cfuvid=visitor",
		])
		for (const name of ["cf_clearance", "cf_chl_rc_i", "__oailb", "__cf_bm"])
			expect(isAllowedChatGptCookieName(name)).toBe(true)
		expect(isAllowedChatGptCookieName("not_cf_clearance")).toBe(false)
	})

	it("scopes cookies to HTTPS/WSS ChatGPT hosts and paths", () => {
		const jar = new ChatGptCookieJar()
		jar.store(RESPONSES, ["__oailb=route; Path=/backend-api; Max-Age=3600"])
		expect(jar.header("https://chatgpt.com/backend-api/ps/mcp")).toBe(
			"__oailb=route",
		)
		expect(jar.header("wss://chatgpt.com/backend-api/codex/responses")).toBe(
			"__oailb=route",
		)
		for (const outside of [
			"https://chatgpt.com/",
			"https://chatgpt.com/backend-apix",
			"https://other.chatgpt.com/backend-api/ps/mcp",
			"https://api.openai.com/backend-api/ps/mcp",
			"http://chatgpt.com/backend-api/ps/mcp",
			"ws://chatgpt.com/backend-api/codex/responses",
		])
			expect(jar.header(outside)).toBeUndefined()
	})

	it("ignores cookies from non-ChatGPT or insecure origins", () => {
		const jar = new ChatGptCookieJar()
		jar.store("https://api.openai.com/v1/responses", ["_cfuvid=v; Path=/"])
		jar.store("http://chatgpt.com/backend-api/codex", ["_cfuvid=v; Path=/"])
		jar.store(RESPONSES, ["_cfuvid=v; Path=/; Domain=evil.example"])
		expect(jar.header(RESPONSES)).toBeUndefined()
		expect(jar.header("https://api.openai.com/v1/responses")).toBeUndefined()
	})

	it("uses the default path and honors Domain for subdomains", () => {
		const jar = new ChatGptCookieJar()
		jar.store(RESPONSES, [
			"__cf_bm=a",
			"_cfuvid=b; Domain=.chatgpt.com; Path=/",
		])
		// Default path of /backend-api/codex/responses is /backend-api/codex.
		expect(jar.header("https://chatgpt.com/backend-api/codex/models")).toBe(
			"__cf_bm=a; _cfuvid=b",
		)
		expect(jar.header("https://chatgpt.com/backend-api/other")).toBe(
			"_cfuvid=b",
		)
		expect(jar.header("https://ab.chatgpt.com/x")).toBe("_cfuvid=b")
	})

	it("expires and deletes cookies", () => {
		let now = 1_000_000
		const jar = new ChatGptCookieJar(() => now)
		jar.store(RESPONSES, ["__cflb=a; Path=/; Max-Age=10", "__oailb=b; Path=/"])
		now += 11_000
		expect(jar.header(RESPONSES)).toBe("__oailb=b")
		jar.store(RESPONSES, ["__oailb=; Path=/; Max-Age=0"])
		expect(jar.header(RESPONSES)).toBeUndefined()
		jar.store(RESPONSES, [
			"__oailb=c; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
		])
		expect(jar.header(RESPONSES)).toBeUndefined()
	})
})

describe("withChatGptCookies", () => {
	it("replays retained cookies and lets explicit Cookie headers win", async () => {
		const jar = new ChatGptCookieJar()
		const sent: Array<string | null> = []
		const fetch = withChatGptCookies(
			(async (_input, init) => {
				sent.push(new Headers(init?.headers).get("cookie"))
				return new Response("{}", {
					headers: [
						["set-cookie", "__oailb=route; Path=/"],
						["set-cookie", "session=secret; Path=/"],
					],
				})
			}) as typeof globalThis.fetch,
			jar,
		)
		await fetch(RESPONSES, { headers: { a: "b" } })
		await fetch(RESPONSES)
		await fetch(RESPONSES, { headers: { Cookie: "explicit=1" } })
		await fetch("https://api.openai.com/v1/responses")
		expect(sent).toEqual([null, "__oailb=route", "explicit=1", null])
	})
})

describe("websocket handshake cookies", () => {
	const connectOnce = async (
		jar: ChatGptCookieJar,
		headers?: Record<string, string>,
		setCookies: string[] = [],
	) => {
		const seen: Record<string, string>[] = []
		const transport = createWebsocketTransport({
			baseURL: "https://chatgpt.com/backend-api/codex",
			codexVersion: "0.157.0",
			headers,
			cookies: jar,
			connectTimeoutMs: 50,
			webSocketFactory: (_url, values, onSetCookies) => {
				seen.push(values)
				onSetCookies?.(setCookies)
				// Fail the handshake immediately; only its request/response matter.
				const listeners: Record<string, Array<() => void>> = {}
				queueMicrotask(() => {
					for (const listener of listeners.error ?? []) listener()
				})
				return {
					binaryType: "",
					readyState: 0,
					send: () => {},
					close: () => {},
					addEventListener: (type: string, listener: () => void) => {
						listeners[type] = [...(listeners[type] ?? []), listener]
					},
				}
			},
		})
		await transport
			.streamResponse(
				{ model: "m" },
				{ accountId: "a", installationId: "i" },
				"t",
			)
			.catch(() => undefined)
		await transport.close()
		return seen[0]
	}

	it("sends HTTP-retained cookies and stores rejected-upgrade cookies", async () => {
		const jar = new ChatGptCookieJar()
		jar.store(RESPONSES, ["__oailb=from-http; Path=/"])
		const headers = await connectOnce(jar, undefined, [
			"__oailb=from-wss; Path=/",
			"session=secret; Path=/",
		])
		expect(headers?.Cookie).toBe("__oailb=from-http")
		expect(jar.header(RESPONSES)).toBe("__oailb=from-wss")
	})

	it("keeps an explicit per-account Cookie header", async () => {
		const jar = new ChatGptCookieJar()
		jar.store(RESPONSES, ["__oailb=from-http; Path=/"])
		const headers = await connectOnce(jar, { cookie: "explicit=1" })
		expect(headers?.cookie).toBe("explicit=1")
		expect(headers?.Cookie).toBeUndefined()
	})

	it("observes Set-Cookie on successful and rejected undici upgrades", async () => {
		const undici = await import("undici")
		const server = createServer()
		const received: Array<string | undefined> = []
		server.on("upgrade", (request, socket) => {
			received.push(request.headers.cookie)
			if (request.url === "/reject") {
				socket.end(
					"HTTP/1.1 403 Forbidden\r\nSet-Cookie: __cf_bm=rejected; Path=/\r\nContent-Length: 0\r\n\r\n",
				)
				return
			}
			const accept = createHash("sha1")
				.update(
					`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
				)
				.digest("base64")
			socket.write(
				`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSet-Cookie: __oailb=ok; Path=/\r\n\r\n`,
			)
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		const { port } = server.address() as AddressInfo
		const observed: string[][] = []
		const dispatcher = undici
			.getGlobalDispatcher()
			.compose(
				observeHandshakeCookies((cookies) =>
					observed.push(cookies),
				) as unknown as Parameters<
					ReturnType<typeof undici.getGlobalDispatcher>["compose"]
				>[0],
			)
		try {
			for (const path of ["/ok", "/reject"])
				await new Promise<void>((resolve) => {
					const socket = new undici.WebSocket(`ws://127.0.0.1:${port}${path}`, {
						headers: { Cookie: "__oailb=sent" },
						dispatcher,
					})
					socket.addEventListener("open", () => {
						socket.close()
						resolve()
					})
					socket.addEventListener("error", () => resolve())
				})
		} finally {
			server.closeAllConnections()
			server.close()
		}
		expect(received).toEqual(["__oailb=sent", "__oailb=sent"])
		expect(observed).toEqual([
			["__oailb=ok; Path=/"],
			["__cf_bm=rejected; Path=/"],
		])
	})
})

describe("pool cookie isolation", () => {
	it("keeps each account's infrastructure cookies to that account", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ models: [] }), {
				headers: { "content-type": "application/json" },
			})) as typeof fetch
		const cookies: Record<"a" | "b", Array<string | null>> = { a: [], b: [] }
		const releases: Array<() => void> = []
		const makeFetch = (which: "a" | "b") =>
			(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input instanceof Request ? input.url : input)
				if (!url.endsWith("/responses"))
					return new Response(JSON.stringify({ models: [] }), {
						headers: { "content-type": "application/json" },
					})
				cookies[which].push(new Headers(init?.headers).get("cookie"))
				await new Promise<void>((resolve) => releases.push(resolve))
				const response = makeSseResponse(`resp_${which}_${Math.random()}`)
				response.headers.append("set-cookie", `__oailb=${which}; Path=/`)
				return response
			}) as typeof fetch
		const pool = await createOpenAIPool({
			codexVersion: "0.157.0",
			accounts: [
				{
					authFilePath: makeAuthFile({ accountId: "acct-a" }),
					fetch: makeFetch("a"),
				},
				{
					authFilePath: makeAuthFile({ accountId: "acct-b" }),
					fetch: makeFetch("b"),
				},
			],
		})
		let counter = 0
		const pair = async () => {
			const requests = [0, 1].map(() =>
				pool.fetch(
					RESPONSES,
					makeRequestInit({
						input: [
							{
								role: "user",
								content: [{ type: "input_text", text: `cookie-${++counter}` }],
							},
						],
					}),
				),
			)
			for (let i = 0; i < 400 && releases.length < 2; i++)
				await new Promise((resolve) => setTimeout(resolve, 5))
			for (const release of releases.splice(0)) release()
			for (const response of await Promise.all(requests)) await response.text()
		}
		await pair()
		await pair()
		expect(cookies).toEqual({
			a: [null, "__oailb=a"],
			b: [null, "__oailb=b"],
		})
		await pool.destroy()
	})
})
