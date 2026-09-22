import { readFileSync, writeFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createOpenAIPool } from "../src/pool.js"
import {
	makeAuthFile,
	makeJwt,
	makeRequestInit,
	makeSseResponse,
} from "./helpers.js"

const url = "https://chatgpt.com/backend-api/codex/responses"
const models = () => Response.json({ models: [] })
const isModels = (input: RequestInfo | URL) => String(input).includes("/models")
const until = async (condition: () => boolean) => {
	await vi.waitFor(() => expect(condition()).toBe(true))
}
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

describe("pool composition boundaries", () => {
	it("exposes a ready transport without selecting credentials twice", async () => {
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			accounts: [
				{
					authFilePath: makeAuthFile({ accountId: "a" }),
					fetch: async (input) =>
						isModels(input) ? models() : makeSseResponse("r"),
				},
			],
		})
		expect(pool.transport?.kind).toBe("openai-compatible")
		expect(pool.transport?.fetch).toBe(pool.fetch)
		expect(
			(await pool.transport?.request("responses", makeRequestInit()))?.status,
		).toBe(200)
		await pool.destroy()
	})
	it("preserves multipart bytes for one image normalization", async () => {
		let calls = 0
		const fetch = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (isModels(input)) return models()
				calls++
				expect(new Headers(init?.headers).get("content-type")).toBe(
					"application/json",
				)
				return Response.json({ data: [] })
			},
		)
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			accounts: [{ authFilePath: makeAuthFile({ accountId: "a" }), fetch }],
		})
		const body = new FormData()
		body.set("model", "gpt-image-2")
		body.set("prompt", "edit")
		body.set(
			"image",
			new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 255, 0])], {
				type: "image/png",
			}),
			"image.png",
		)
		const response = await pool.fetch(
			"https://openai-oauth.local/v1/images/edits",
			{ method: "POST", body },
		)
		expect(response.status).toBe(200)
		expect(calls).toBe(1)
		await response.text()
		await pool.destroy()
	})
	it("normalizes a streamed Request body for JSON image generation", async () => {
		const fetch = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				expect(JSON.parse(String(init?.body))).toEqual({
					model: "gpt-image-2",
					prompt: "draw a tree",
				})
				return Response.json({ data: [{ b64_json: "AQID" }] })
			},
		)
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			accounts: [{ authFilePath: makeAuthFile({ accountId: "a" }), fetch }],
		})
		try {
			const request = new Request(
				"https://openai-oauth.local/v1/images/generations",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ prompt: "draw a tree" }),
				},
			)
			const response = await pool.fetch(request)
			expect(response.status).toBe(200)
			expect(await response.json()).toEqual({ data: [{ b64_json: "AQID" }] })
			expect(fetch).toHaveBeenCalledOnce()
		} finally {
			await pool.destroy()
		}
	})
	it.each([
		"oversize",
		"abort",
	])("bounds JSON image body reads on %s and releases capacity", async (scenario) => {
		const fetch = vi.fn(async () => Response.json({ data: [] }))
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			maxRequestBodyBytes: 32,
			accounts: [{ authFilePath: makeAuthFile({ accountId: "a" }), fetch }],
		})
		const cancel = vi.fn()
		const started = vi.fn()
		const controller = new AbortController()
		const stream = new ReadableStream<Uint8Array>(
			{
				pull(c) {
					started()
					if (scenario === "oversize") c.enqueue(new Uint8Array(33))
				},
				cancel,
			},
			{ highWaterMark: 0 },
		)
		try {
			const result = pool.fetch(
				"https://openai-oauth.local/v1/images/generations",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: stream,
					signal: controller.signal,
					duplex: "half",
				} as RequestInit,
			)
			const failure = expect(result).rejects.toThrow(
				scenario === "oversize" ? /size limit/ : /aborted/i,
			)
			if (scenario === "abort") {
				await until(() => started.mock.calls.length > 0)
				controller.abort()
			}
			await failure
			expect(cancel).toHaveBeenCalledOnce()
			expect(fetch).not.toHaveBeenCalled()
			expect(pool.stats()[0]?.inflight).toBe(0)
			expect(pool.stats()[0]?.healthy).toBe(true)
		} finally {
			await pool.destroy()
		}
	})
	it("indexes accepted aggregate output exceeding one MiB", async () => {
		let calls = 0
		const output = Array.from({ length: 3 }, (_, i) => ({
			id: `item${i}`,
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text: "x".repeat(400_000) }],
		}))
		const sse =
			output
				.map(
					(item) =>
						`data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`,
				)
				.join("") +
			`data: ${JSON.stringify({ type: "response.completed", response: { id: "big", status: "completed", output: [] } })}\n\n`
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			accounts: [
				{
					authFilePath: makeAuthFile({ accountId: "a" }),
					fetch: async (input) => {
						if (isModels(input)) return models()
						calls++
						return calls === 1
							? new Response(sse, {
									headers: { "content-type": "text/event-stream" },
								})
							: makeSseResponse("next")
					},
				},
			],
		})
		const first = await pool.fetch(url, makeRequestInit({ stream: false }))
		expect((await first.json()).id).toBe("big")
		const next = await pool.fetch(
			url,
			makeRequestInit({
				previous_response_id: "big",
				input: [{ role: "user", content: "next" }],
			}),
		)
		expect(next.status).toBe(200)
		await next.text()
		await pool.destroy()
	})
	it("keeps the longer concurrent restriction and recovers only after expiry", async () => {
		let clock = 100_000
		const releases: Array<(r: Response) => void> = []
		const pool = await createOpenAIPool({
			now: () => clock,
			codexVersion: "0.154.0",
			accounts: [
				{
					authFilePath: makeAuthFile({ accountId: "a" }),
					fetch: async (input) =>
						isModels(input)
							? models()
							: new Promise<Response>((r) => releases.push(r)),
				},
			],
		})
		const a = pool.fetch(url, makeRequestInit({ input: "a" })),
			b = pool.fetch(url, makeRequestInit({ input: "b" }))
		await until(() => releases.length === 2)
		releases[0]?.(
			Response.json(
				{ error: { code: "rate_limit_exceeded" } },
				{ status: 429, headers: { "retry-after": "3600" } },
			),
		)
		await (await a).text()
		releases[1]?.(
			Response.json(
				{ error: { code: "rate_limit_exceeded" } },
				{ status: 429, headers: { "retry-after": "1" } },
			),
		)
		await (await b).text()
		expect(pool.stats()[0]?.cooldownRemainingMs).toBe(3_600_000)
		clock += 3_600_000
		expect(pool.stats()[0]?.healthy).toBe(true)
		await pool.destroy()
	})
	it("quarantines permanent auth failure for future requests until credentials change", async () => {
		const path = makeAuthFile({ accountId: "a" })
		const data = JSON.parse(readFileSync(path, "utf8"))
		data.tokens.access_token = makeJwt({ exp: 1 })
		data.tokens.refresh_token = "bad-refresh"
		writeFileSync(path, JSON.stringify(data))
		let refreshes = 0
		const calls: string[] = []
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			accounts: [
				{
					authFilePath: path,
					fetch: async (input) => {
						if (String(input).includes("oauth/token")) {
							refreshes++
							return Response.json({ error: "invalid_grant" }, { status: 400 })
						}
						if (isModels(input)) return models()
						calls.push("a")
						return makeSseResponse("a")
					},
				},
				{
					authFilePath: makeAuthFile({ accountId: "b" }),
					fetch: async (input) => {
						if (isModels(input)) return models()
						calls.push("b")
						return makeSseResponse("b")
					},
				},
			],
		})
		await expect(pool.fetch(url, makeRequestInit())).rejects.toThrow()
		expect(pool.stats()[0]?.healthy).toBe(false)
		await (
			await pool.fetch(url, makeRequestInit({ input: "independent" }))
		).text()
		expect(calls).toEqual(["b"])
		expect(refreshes).toBe(1)
		data.tokens.access_token = makeJwt({
			"https://api.openai.com/auth": { chatgpt_account_id: "a" },
		})
		delete data.tokens.refresh_token
		writeFileSync(path, JSON.stringify(data))
		await (
			await pool.fetch(url, makeRequestInit({ input: "reauthorized" }))
		).text()
		expect(calls).toEqual(["b", "a"])
		await pool.destroy()
	})
	it("destroy aborts pending headers and active streams without closing external fetch resources", async () => {
		let seen: AbortSignal | null | undefined
		let cancelled = false
		const fetch = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (isModels(input)) return models()
				seen = init?.signal
				return new Response(
					new ReadableStream<Uint8Array>({
						cancel() {
							cancelled = true
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				)
			},
		)
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			accounts: [{ authFilePath: makeAuthFile({ accountId: "a" }), fetch }],
		})
		const response = await pool.fetch(url, makeRequestInit({ stream: true }))
		await pool.destroy()
		expect(seen?.aborted).toBe(true)
		await expect(response.text()).rejects.toThrow()
		await until(() => cancelled)
		expect(pool.stats()[0]?.inflight).toBe(0)
		await pool.destroy()
	})
})
