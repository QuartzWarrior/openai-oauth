import { createServer } from "node:http"
import { connect } from "node:net"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	fetch: vi.fn(),
	construct: vi.fn(),
	dispatchers: [] as Array<{
		dispatch?: ReturnType<typeof vi.fn>
		destroy?: ReturnType<typeof vi.fn>
		close?: ReturnType<typeof vi.fn>
	}>,
}))
vi.mock("undici", () => ({
	fetch: mocks.fetch,
	ProxyAgent: function ProxyAgent(options: { uri: string }) {
		mocks.construct(options)
		return (
			mocks.dispatchers.shift() ?? {
				dispatch: vi.fn(),
				destroy: vi.fn(async () => undefined),
			}
		)
	},
}))

import { createLoginProxy } from "../src/login-proxy.js"

beforeEach(() => {
	mocks.fetch.mockReset().mockResolvedValue(new Response("ok"))
	mocks.construct.mockReset()
	mocks.dispatchers.length = 0
})
afterEach(() => vi.restoreAllMocks())

const dispatcher = () => ({
	dispatch: vi.fn(),
	destroy: vi.fn(async () => undefined),
	close: vi.fn(async () => undefined),
})
const target = "https://issuer.example/oauth/token"

describe("login proxy transport", () => {
	test("allocates a dedicated dispatcher per login without changing global fetch", async () => {
		const firstAgent = dispatcher()
		const secondAgent = dispatcher()
		mocks.dispatchers.push(firstAgent, secondAgent)
		const originalFetch = globalThis.fetch
		const first = await createLoginProxy(
			"http://user:secret@proxy.example:8080",
		)
		const second = await createLoginProxy("https://second.example:8443")
		const controller = new AbortController()
		const body = new URLSearchParams({
			grant_type: "authorization_code",
			code: "fake",
		})
		const headers = { "content-type": "application/x-www-form-urlencoded" }
		const init = { method: "POST", body, headers, signal: controller.signal }
		await first.fetch(target, init)
		await second.fetch(target)
		expect(mocks.fetch.mock.calls[0]).toEqual([
			target,
			{ ...init, dispatcher: firstAgent },
		])
		expect(mocks.fetch.mock.calls[1]).toEqual([
			target,
			{ dispatcher: secondAgent },
		])
		expect(globalThis.fetch).toBe(originalFetch)
		expect(init).not.toHaveProperty("dispatcher")
		await Promise.all([first.close(), second.close()])
	})

	test("converts native Requests with method, headers, body and signal intact", async () => {
		const agent = dispatcher()
		mocks.dispatchers.push(agent)
		const proxy = await createLoginProxy("http://proxy.example")
		const controller = new AbortController()
		const request = new Request(target, {
			method: "POST",
			headers: { "x-original": "yes" },
			body: "grant_type=authorization_code",
			signal: controller.signal,
		})
		await proxy.fetch(request)
		const [url, options] = mocks.fetch.mock.calls[0] ?? []
		expect(url).toBe(target)
		expect(options).toMatchObject({
			method: "POST",
			dispatcher: agent,
			duplex: "half",
		})
		expect(new Headers(options.headers).get("x-original")).toBe("yes")
		expect(await new Response(options.body).text()).toBe(
			"grant_type=authorization_code",
		)
		controller.abort()
		expect(options.signal.aborted).toBe(true)
		await proxy.close()
	})

	test("honors RequestInit overrides on a native Request", async () => {
		const proxy = await createLoginProxy("http://proxy.example")
		const request = new Request(target, {
			method: "POST",
			body: "old",
			headers: { "x-old": "old" },
		})
		const controller = new AbortController()
		await proxy.fetch(request, {
			method: "PUT",
			body: "new",
			headers: { "x-new": "new" },
			signal: controller.signal,
		})
		const options = mocks.fetch.mock.calls[0]?.[1]
		expect(options.method).toBe("PUT")
		expect(new Headers(options.headers).get("x-old")).toBeNull()
		expect(new Headers(options.headers).get("x-new")).toBe("new")
		expect(await new Response(options.body).text()).toBe("new")
		controller.abort()
		expect(options.signal.aborted).toBe(true)
		await proxy.close()
	})

	test("sets duplex for streamed bodies and does not override the dispatcher", async () => {
		const agent = dispatcher()
		mocks.dispatchers.push(agent)
		const proxy = await createLoginProxy("http://proxy.example")
		const stream = new ReadableStream({
			start(c) {
				c.close()
			},
		})
		await proxy.fetch(target, {
			method: "POST",
			body: stream,
			dispatcher: "wrong",
		} as RequestInit)
		expect(mocks.fetch.mock.calls[0]?.[1]).toMatchObject({
			body: stream,
			duplex: "half",
			dispatcher: agent,
		})
		await proxy.close()
	})

	test.each([
		"",
		"not-a-proxy-secret",
		"socks5://user:secret@proxy.example:1080",
		"file:///private-secret",
		"http://",
		"http://user:secret@proxy.example/private-secret",
		"http://user:secret@proxy.example?password=secret",
		"http://user:secret@proxy.example#secret",
	])("rejects invalid or unsupported proxy configuration without leaking details", async (value) => {
		const error = await createLoginProxy(value).catch((error: unknown) => error)
		expect(error).toBeInstanceOf(Error)
		expect(String(error)).toMatch(/Invalid login proxy URL/)
		expect(String(error)).not.toMatch(/secret|user:|password=/)
		expect(error).not.toHaveProperty("cause")
		expect(mocks.construct).not.toHaveBeenCalled()
		expect(mocks.fetch).not.toHaveBeenCalled()
	})

	test("redacts constructor failures", async () => {
		mocks.construct.mockImplementation(() => {
			throw new Error("bad http://user:secret@proxy.example")
		})
		await expect(
			createLoginProxy("http://user:secret@proxy.example"),
		).rejects.toThrow("Could not initialize the login proxy.")
	})

	test("fails closed for runtimes without a usable dispatcher and cleans up", async () => {
		const close = vi.fn(async () => undefined)
		mocks.dispatchers.push({ close })
		await expect(createLoginProxy("http://proxy.example")).rejects.toThrow(
			/cannot honor a login proxy dispatcher/,
		)
		expect(close).toHaveBeenCalledOnce()
		expect(mocks.fetch).not.toHaveBeenCalled()
		mocks.dispatchers.push({})
		await expect(createLoginProxy("http://proxy.example")).rejects.toThrow(
			/cannot honor a login proxy dispatcher/,
		)
	})

	test("redacts proxy request errors and never falls back to direct fetch", async () => {
		const direct = vi.spyOn(globalThis, "fetch")
		mocks.fetch.mockRejectedValue(
			new Error("proxy http://user:secret@proxy.example refused credentials"),
		)
		const proxy = await createLoginProxy("http://proxy.example")
		const error = await proxy.fetch(target).catch((error: unknown) => error)
		expect(String(error)).toBe("Error: Login proxy request failed.")
		expect(error).not.toHaveProperty("cause")
		expect(direct).not.toHaveBeenCalled()
		await proxy.close()
	})

	test("preserves pre-abort reason without dispatching", async () => {
		const proxy = await createLoginProxy("http://proxy.example")
		const controller = new AbortController()
		const reason = new DOMException("Cancelled", "AbortError")
		controller.abort(reason)
		await expect(
			proxy.fetch(target, { signal: controller.signal }),
		).rejects.toBe(reason)
		expect(mocks.fetch).not.toHaveBeenCalled()
		await proxy.close()
	})

	test("an explicit null signal overrides an aborted Request signal", async () => {
		const proxy = await createLoginProxy("http://proxy.example")
		const controller = new AbortController()
		const request = new Request(target, { signal: controller.signal })
		controller.abort()
		await proxy.fetch(request, { signal: null })
		expect(mocks.fetch.mock.calls[0]?.[1].signal.aborted).toBe(false)
		await proxy.close()
	})

	test("propagates request abortion rather than a proxy diagnostic", async () => {
		const proxy = await createLoginProxy("http://proxy.example")
		const controller = new AbortController()
		mocks.fetch.mockImplementation(
			async (_url, init) =>
				new Promise((_resolve, reject) => {
					init.signal.addEventListener(
						"abort",
						() => reject(new Error("secret proxy diagnostic")),
						{ once: true },
					)
				}),
		)
		const pending = proxy.fetch(target, { signal: controller.signal })
		controller.abort()
		await expect(pending).rejects.toMatchObject({ name: "AbortError" })
		await proxy.close()
	})

	test("destroy is preferred and cleanup is idempotent", async () => {
		const agent = dispatcher()
		mocks.dispatchers.push(agent)
		const proxy = await createLoginProxy("http://proxy.example")
		const one = proxy.close()
		const two = proxy.close()
		expect(one).toBe(two)
		await Promise.all([one, two])
		expect(agent.destroy).toHaveBeenCalledOnce()
		expect(agent.close).not.toHaveBeenCalled()
		await expect(proxy.fetch(target)).rejects.toThrow(
			"The login proxy is closed.",
		)
		expect(mocks.fetch).not.toHaveBeenCalled()
	})

	test("routes a token POST through a real loopback CONNECT proxy", async () => {
		const undici = await vi.importActual<typeof import("undici")>("undici")
		const upstream = createServer(async (req, res) => {
			let body = ""
			for await (const chunk of req) body += String(chunk)
			expect(req.method).toBe("POST")
			expect(body).toBe("grant_type=authorization_code&code=test-code")
			res.writeHead(200, { "content-type": "application/json" })
			res.end('{"access_token":"mock-token"}')
		})
		const forward = createServer((_req, res) => {
			res.writeHead(405).end()
		})
		const listen = (server: ReturnType<typeof createServer>) =>
			new Promise<number>((resolve, reject) => {
				server.once("error", reject)
				server.listen(0, "127.0.0.1", () => {
					server.off("error", reject)
					const address = server.address()
					if (!address || typeof address === "string")
						return reject(new Error("Missing loopback listener"))
					resolve(address.port)
				})
			})
		const stop = (server: ReturnType<typeof createServer>) =>
			new Promise<void>((resolve, reject) => {
				if (!server.listening) return resolve()
				server.close((error) => (error ? reject(error) : resolve()))
			})
		let closeProxy: (() => Promise<void>) | undefined
		const connected: string[] = []
		try {
			const upstreamPort = await listen(upstream)
			forward.on("connect", (req, socket, head) => {
				connected.push(req.url ?? "")
				const remote = connect(upstreamPort, "127.0.0.1", () => {
					socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
					if (head.length) remote.write(head)
					socket.pipe(remote).pipe(socket)
				})
				remote.on("error", () => socket.destroy())
				socket.on("error", () => remote.destroy())
				socket.on("close", () => remote.destroy())
				remote.on("close", () => socket.destroy())
			})
			const proxyPort = await listen(forward)
			const uri = `http://127.0.0.1:${proxyPort}`
			const realAgent = new undici.ProxyAgent({ uri })
			mocks.dispatchers.push(
				realAgent as unknown as ReturnType<typeof dispatcher>,
			)
			mocks.fetch.mockImplementation(undici.fetch)
			const proxy = await createLoginProxy(uri)
			closeProxy = proxy.close
			const response = await proxy.fetch(
				`http://127.0.0.1:${upstreamPort}/oauth/token`,
				{
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({
						grant_type: "authorization_code",
						code: "test-code",
					}),
				},
			)
			expect(await response.json()).toEqual({ access_token: "mock-token" })
			expect(connected).toEqual([`127.0.0.1:${upstreamPort}`])
		} finally {
			await closeProxy?.()
			await Promise.all([stop(forward), stop(upstream)])
		}
	}, 5000)

	test("falls back to close when destroy is unavailable and sanitizes cleanup failures", async () => {
		const close = vi.fn(async () => {
			throw new Error("proxy user:secret")
		})
		mocks.dispatchers.push({ dispatch: vi.fn(), close })
		const proxy = await createLoginProxy("http://proxy.example")
		const error = await proxy.close().catch((error: unknown) => error)
		expect(String(error)).toBe("Error: Could not close the login proxy.")
		expect(error).not.toHaveProperty("cause")
		await expect(proxy.close()).rejects.toThrow(
			"Could not close the login proxy.",
		)
		expect(close).toHaveBeenCalledOnce()
	})
})
