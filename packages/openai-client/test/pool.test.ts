import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createOpenAIPool } from "@openai-oauth/pool"
import OpenAI, { toFile } from "openai"
import { afterEach, describe, expect, test, vi } from "vitest"

const { createOpenAIOptions } =
	process.env.OAUTH_TEST_BUILT_ADAPTERS === "1"
		? await import("../dist/index.js")
		: await import("../src/index.js")

const roots: string[] = []
const model = "test-model"
const endpoint = "https://chatgpt.com/backend-api/codex/responses"
const jwt = (claims: Record<string, unknown>) =>
	[{}, { exp: Math.floor(Date.now() / 1000) + 3600, ...claims }, "test"]
		.map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
		.join(".")
const authFile = async (owner: string) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "oauth-adapter-pool-"))
	roots.push(root)
	const file = path.join(root, "auth.json")
	await writeFile(
		file,
		JSON.stringify({
			auth_mode: "chatgpt",
			tokens: {
				access_token: jwt({
					"https://api.openai.com/auth": { chatgpt_account_id: owner },
				}),
				id_token: jwt({ sub: owner }),
				account_id: owner,
			},
		}),
		{ mode: 0o600 },
	)
	return file
}
const completed = (id: string) =>
	new Response(
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				id,
				object: "response",
				status: "completed",
				model,
				output: [],
			},
		})}\n\n`,
		{ headers: { "content-type": "text/event-stream" } },
	)
const body = (text: string, stream = false) => ({
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({
		model,
		input: [{ role: "user", content: [{ type: "input_text", text }] }],
		stream,
	}),
})
afterEach(async () => {
	vi.restoreAllMocks()
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	)
})

describe("public OpenAI SDK pool composition", () => {
	test("uses an advertised ready transport without a second credential selection", async () => {
		const getSession = vi.fn(async () => {
			throw new Error("must not select credentials outside dispatch")
		})
		const fetch = vi.fn(async () => Response.json({ id: "ready", output: [] }))
		const transport = {
			kind: "openai-compatible" as const,
			baseURL: "https://ready.test/v1",
			fetch,
			request: async () => Response.json({}),
		}
		const input = { kind: "openai-oauth" as const, getSession, transport }
		const client = new OpenAI({ ...createOpenAIOptions(input), maxRetries: 0 })
		const response = await client.responses.create({ model, input: "hello" })
		expect(response.id).toBe("ready")
		expect(getSession).not.toHaveBeenCalled()
		expect(fetch).toHaveBeenCalledOnce()
		expect(createOpenAIOptions(input).fetch).toBe(fetch)
	})

	test("keeps a continuation on its busy owner while independent work uses another account", async () => {
		const calls: Array<{ owner: string; body: Record<string, unknown> }> = []
		const cancel = vi.fn()
		let next = 0
		const accountFetch = (owner: string) =>
			vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
				const target = String(url)
				if (target.includes("registry.npmjs.org"))
					return Response.json({ version: "0.154.0" })
				if (target.includes("/models?"))
					return Response.json({
						models: [{ slug: model, visibility: "list" }],
					})
				const request = JSON.parse(String(init?.body))
				calls.push({ owner, body: request })
				if (JSON.stringify(request.input).includes("hold-open"))
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"))
							},
							cancel,
						}),
						{ headers: { "content-type": "text/event-stream" } },
					)
				return completed(`response-${++next}`)
			})
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			accounts: [
				{
					name: "a",
					authFilePath: await authFile("a"),
					fetch: accountFetch("a"),
				},
				{
					name: "b",
					authFilePath: await authFile("b"),
					fetch: accountFetch("b"),
				},
			],
		})
		let held: ReadableStreamDefaultReader<Uint8Array> | undefined
		try {
			const getSession = vi.spyOn(pool, "getSession")
			const client = new OpenAI({ ...createOpenAIOptions(pool), maxRetries: 0 })
			const first = await client.responses.create({
				model,
				input: "private-a-first",
			})
			if (!pool.fetch) throw new Error("expected pool fetch")
			const busy = await pool.fetch(endpoint, body("hold-open", true))
			if (!busy.body) throw new Error("expected streaming body")
			held = busy.body.getReader()
			await held.read()
			expect(pool.stats().find((entry) => entry.name === "a")?.inflight).toBe(1)
			await client.responses.create({
				model,
				previous_response_id: first.id,
				input: "a-continuation",
			})
			await client.responses.create({ model, input: "independent-b" })
			expect(calls.map((entry) => entry.owner)).toEqual(["a", "a", "a", "b"])
			expect(JSON.stringify(calls[2]?.body.input)).toContain("private-a-first")
			expect(JSON.stringify(calls[2]?.body.input)).toContain("a-continuation")
			expect(JSON.stringify(calls[3]?.body.input)).not.toContain(
				"private-a-first",
			)
			expect(getSession).not.toHaveBeenCalled()
		} finally {
			await held?.cancel()
			await pool.destroy()
		}
	})

	test("normalizes JSON image generation through the public SDK and pool", async () => {
		const requests: Record<string, unknown>[] = []
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			accounts: [
				{
					authFilePath: await authFile("image-owner"),
					fetch: async (url, init) => {
						expect(String(url)).toMatch(/\/images\/generations$/)
						requests.push(JSON.parse(String(init?.body)))
						return Response.json({ created: 1, data: [{ b64_json: "AQID" }] })
					},
				},
			],
		})
		try {
			const client = new OpenAI({ ...createOpenAIOptions(pool), maxRetries: 0 })
			const result = await client.images.generate({
				model: "gpt-image-2",
				prompt: "draw a tree",
				quality: "low",
				n: 1,
			})
			expect(result.data?.[0]?.b64_json).toBe("AQID")
			expect(requests).toEqual([
				{ model: "gpt-image-2", prompt: "draw a tree", quality: "low", n: 1 },
			])
		} finally {
			await pool.destroy()
		}
	})

	test("preserves multipart binary image edits through the public SDK and pool", async () => {
		const images: Record<string, unknown>[] = []
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			accounts: [
				{
					authFilePath: await authFile("image-owner"),
					fetch: async (url, init) => {
						if (!String(url).endsWith("/images/edits"))
							throw new Error("unexpected upstream request")
						images.push(JSON.parse(String(init?.body)))
						return Response.json({ created: 1, data: [{ b64_json: "AQID" }] })
					},
				},
			],
		})
		try {
			const bytes = new Uint8Array([137, 80, 78, 71, 0, 255, 128, 13, 10])
			const client = new OpenAI({ ...createOpenAIOptions(pool), maxRetries: 0 })
			const result = await client.images.edit({
				model: "gpt-image-2",
				prompt: "edit",
				image: await toFile(bytes, "test.png", { type: "image/png" }),
			})
			expect(result.data?.[0]?.b64_json).toBe("AQID")
			expect(images).toEqual([
				{
					model: "gpt-image-2",
					prompt: "edit",
					images: [
						{
							image_url: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
						},
					],
				},
			])
		} finally {
			await pool.destroy()
		}
	})
})
