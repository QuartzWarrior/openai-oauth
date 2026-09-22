import { EventEmitter } from "node:events"
import { request as httpRequest, type ServerResponse } from "node:http"
import { afterEach, describe, expect, test, vi } from "vitest"
import {
	createOpenAIOAuthFetchHandler,
	startOpenAIOAuthServer,
} from "../src/index.js"
import { writeWebResponse } from "../src/shared.js"

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

const makeRequest = (body: string | ReadableStream<Uint8Array>, headers = {}) =>
	new Request("http://localhost/v1/chat/completions", {
		method: "POST",
		body,
		headers,
		duplex: "half",
	} as RequestInit)

describe("gateway safety", () => {
	test("authorization rejects before consuming a streamed body or loading credentials", async () => {
		const pull = vi.fn()
		const cancel = vi.fn()
		const getSession = vi.fn()
		const handler = createOpenAIOAuthFetchHandler({
			accessToken: "expected-secret",
			credentials: { kind: "openai-oauth", getSession },
		})
		const body = new ReadableStream<Uint8Array>(
			{ pull, cancel },
			{ highWaterMark: 0 },
		)
		const response = await handler(
			makeRequest(body, { authorization: "Bearer wrong-secret" }),
		)
		expect(response.status).toBe(401)
		expect(response.headers.get("www-authenticate")).toBe("Bearer")
		expect(pull).not.toHaveBeenCalled()
		expect(cancel).toHaveBeenCalled()
		expect(getSession).not.toHaveBeenCalled()
	})

	test("accepts configured bearer and requires the additional header-only authorizer", async () => {
		const authorizeRequest = vi.fn(async (request: Request) => {
			expect(request.body).toBeNull()
			return request.headers.get("x-allowed") === "yes"
		})
		const handler = createOpenAIOAuthFetchHandler({
			accessToken: "secret",
			authorizeRequest,
		})
		expect(
			(
				await handler(
					new Request("http://localhost/health", {
						headers: { authorization: "Bearer secret" },
					}),
				)
			).status,
		).toBe(401)
		expect(
			(
				await handler(
					new Request("http://localhost/health", {
						headers: { authorization: "Bearer secret", "x-allowed": "yes" },
					}),
				)
			).status,
		).toBe(200)
	})

	test("redacts arbitrary authorizer errors", async () => {
		const handler = createOpenAIOAuthFetchHandler({
			authorizeRequest: () => {
				throw new Error("secret=private")
			},
		})
		const response = await handler(new Request("http://localhost/health"))
		expect(response.status).toBe(500)
		expect(await response.text()).not.toContain("private")
	})

	test("rejects invalid limits, oversized declared bodies and oversized chunked bodies", async () => {
		for (const limit of [0, -1, NaN, Infinity, 1.5]) {
			expect(() =>
				createOpenAIOAuthFetchHandler({ maxRequestBodyBytes: limit }),
			).toThrow(/positive integer/)
		}
		const handler = createOpenAIOAuthFetchHandler({ maxRequestBodyBytes: 8 })
		expect(
			(await handler(makeRequest("{}", { "content-length": "20" }))).status,
		).toBe(413)
		let count = 0
		const cancel = vi.fn()
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					count++
					controller.enqueue(new TextEncoder().encode("12345"))
				},
				cancel,
			},
			{ highWaterMark: 0 },
		)
		expect((await handler(makeRequest(body))).status).toBe(413)
		expect(count).toBe(2)
		expect(cancel).toHaveBeenCalled()
	})

	test("abort cancels a pending upload read", async () => {
		const controller = new AbortController()
		const cancel = vi.fn()
		const handler = createOpenAIOAuthFetchHandler()
		const request = new Request("http://localhost/v1/chat/completions", {
			method: "POST",
			signal: controller.signal,
			body: new ReadableStream<Uint8Array>({ cancel }),
			duplex: "half",
		} as RequestInit)
		const response = handler(request)
		await Promise.resolve()
		controller.abort()
		expect((await response).status).toBe(499)
		expect(cancel).toHaveBeenCalled()
	})

	test("empty and malformed JSON bodies return 400, not 500", async () => {
		const handler = createOpenAIOAuthFetchHandler()
		for (const body of ["", "{"])
			expect((await handler(makeRequest(body))).status).toBe(400)
	})

	test.each([
		false,
		true,
	])("explicitly rejects unsupported schema output for stream=%s", async (stream) => {
		const getSession = vi.fn()
		const handler = createOpenAIOAuthFetchHandler({
			credentials: { kind: "openai-oauth", getSession },
		})
		const response = await handler(
			makeRequest(
				JSON.stringify({
					messages: [],
					stream,
					response_format: {
						type: "json_schema",
						json_schema: { name: "answer", schema: { type: "object" } },
					},
				}),
			),
		)
		expect(response.status).toBe(400)
		expect(await response.text()).toContain("structured output")
		expect(getSession).not.toHaveBeenCalled()
	})

	test("Node sends an unauthorized response without waiting for upload completion", async () => {
		const running = await startOpenAIOAuthServer({
			port: 0,
			deferModelDiscovery: true,
			accessToken: "secret",
		})
		closers.push(running.close)
		const status = await new Promise<number | undefined>((resolve, reject) => {
			const req = httpRequest(
				`${running.url}/responses`,
				{ method: "POST", headers: { "content-length": "100000" } },
				(res) => {
					res.resume()
					resolve(res.statusCode)
					req.destroy()
				},
			)
			req.on("error", reject)
			req.flushHeaders()
		})
		expect(status).toBe(401)
	})

	test("Node enforces chunked body limit with a 413 response", async () => {
		const running = await startOpenAIOAuthServer({
			port: 0,
			deferModelDiscovery: true,
			maxRequestBodyBytes: 8,
		})
		closers.push(running.close)
		const status = await new Promise<number | undefined>((resolve, reject) => {
			const req = httpRequest(
				`${running.url}/chat/completions`,
				{ method: "POST", headers: { "transfer-encoding": "chunked" } },
				(res) => {
					res.resume()
					resolve(res.statusCode)
				},
			)
			req.on("error", reject)
			req.write("12345")
			req.end("12345")
		})
		expect(status).toBe(413)
	})
})

class MockResponse extends EventEmitter {
	statusCode = 0
	destroyed = false
	setHeader = vi.fn()
	write = vi.fn(() => false)
	end = vi.fn()
}

describe("Node response bridge", () => {
	test("waits for drain before reading another upstream chunk", async () => {
		const response = new MockResponse()
		let reads = 0
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					reads++
					if (reads === 3) controller.close()
					else controller.enqueue(new Uint8Array([reads]))
				},
			},
			{ highWaterMark: 0 },
		)
		const writing = writeWebResponse(
			response as unknown as ServerResponse,
			new Response(body),
		)
		await vi.waitFor(() => expect(response.write).toHaveBeenCalledTimes(1))
		expect(reads).toBe(1)
		response.emit("drain")
		await vi.waitFor(() => expect(response.write).toHaveBeenCalledTimes(2))
		expect(reads).toBe(2)
		response.emit("drain")
		await writing
		expect(response.end).toHaveBeenCalledTimes(1)
		expect(response.listenerCount("close")).toBe(0)
	})

	test("disconnect cancels a pending upstream read", async () => {
		const response = new MockResponse()
		const cancel = vi.fn()
		const writing = writeWebResponse(
			response as unknown as ServerResponse,
			new Response(new ReadableStream({ cancel })),
		)
		response.destroyed = true
		response.emit("close")
		await writing
		expect(cancel).toHaveBeenCalled()
		expect(response.end).not.toHaveBeenCalled()
	})
})
