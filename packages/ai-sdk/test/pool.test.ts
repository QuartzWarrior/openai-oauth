import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createOpenAIPool } from "@openai-oauth/pool"
import { generateImage, generateText } from "ai"
import { afterEach, describe, expect, test, vi } from "vitest"

const { createOpenAIOAuth } =
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
	const root = await mkdtemp(path.join(os.tmpdir(), "oauth-ai-pool-"))
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
const responseStream = (id: string) => {
	const item = {
		type: "message",
		id: `msg-${id}`,
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text: "hello", annotations: [] }],
	}
	const response = {
		id,
		object: "response",
		model,
		created_at: 1735689600,
		status: "completed",
		output: [item],
		usage: { input_tokens: 1, output_tokens: 1 },
	}
	const events = [
		{
			type: "response.created",
			response: { ...response, status: "in_progress", output: [] },
		},
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { ...item, status: "in_progress", content: [] },
		},
		{
			type: "response.output_text.delta",
			item_id: item.id,
			output_index: 0,
			content_index: 0,
			delta: "hello",
		},
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response },
	]
	return new Response(
		events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
		{ headers: { "content-type": "text/event-stream" } },
	)
}

afterEach(async () => {
	vi.restoreAllMocks()
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	)
})

describe("public AI SDK pool composition", () => {
	test("uses ready transport for generateText without outer authentication", async () => {
		const getSession = vi.fn(async () => {
			throw new Error("must not load outer auth")
		})
		const fetch = vi.fn(async () => responseStream("ready"))
		const provider = createOpenAIOAuth({
			kind: "openai-oauth",
			getSession,
			transport: {
				kind: "openai-compatible",
				baseURL: "https://ready.test/v1",
				fetch,
				request: async () => responseStream("ready"),
			},
		})
		const result = await generateText({
			model: provider(model),
			prompt: "hello",
			maxRetries: 0,
		})
		expect(result.text).toBe("hello")
		expect(getSession).not.toHaveBeenCalled()
		expect(fetch).toHaveBeenCalledOnce()
	})

	test("keeps predecessor ownership across a busy pool through generateText", async () => {
		const calls: Array<{ owner: string; body: Record<string, unknown> }> = []
		let next = 0
		const makeFetch =
			(owner: string): typeof fetch =>
			async (url, init) => {
				if (String(url).includes("registry.npmjs.org"))
					return Response.json({ version: "0.154.0" })
				if (String(url).includes("/models?"))
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
						}),
						{ headers: { "content-type": "text/event-stream" } },
					)
				return responseStream(`response-${++next}`)
			}
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			accounts: [
				{ name: "a", authFilePath: await authFile("a"), fetch: makeFetch("a") },
				{ name: "b", authFilePath: await authFile("b"), fetch: makeFetch("b") },
			],
		})
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
		try {
			const outerGetSession = vi.spyOn(pool, "getSession")
			const provider = createOpenAIOAuth(pool)
			const first = await generateText({
				model: provider(model),
				prompt: "private-a",
				maxRetries: 0,
			})
			expect(first.text).toBe("hello")
			if (!pool.fetch) throw new Error("expected pool fetch")
			const held = await pool.fetch(endpoint, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model,
					input: [{ role: "user", content: "hold-open" }],
					stream: true,
				}),
			})
			if (!held.body) throw new Error("expected stream")
			reader = held.body.getReader()
			await reader.read()
			expect(pool.stats().find((entry) => entry.name === "a")?.inflight).toBe(1)
			await generateText({
				model: provider(model),
				prompt: "a-continuation",
				maxRetries: 0,
				providerOptions: { openai: { previousResponseId: "response-1" } },
			})
			await generateText({
				model: provider(model),
				prompt: "independent-b",
				maxRetries: 0,
			})
			expect(calls.map((entry) => entry.owner)).toEqual(["a", "a", "a", "b"])
			expect(JSON.stringify(calls[2]?.body.input)).toContain("private-a")
			expect(JSON.stringify(calls[3]?.body.input)).not.toContain("private-a")
			expect(outerGetSession).not.toHaveBeenCalled()
		} finally {
			await reader?.cancel()
			await pool.destroy()
		}
	})

	test("normalizes pooled AI SDK image generation", async () => {
		const seen: Record<string, unknown>[] = []
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			accounts: [
				{
					authFilePath: await authFile("image"),
					fetch: async (url, init) => {
						expect(String(url)).toMatch(/\/images\/generations$/)
						seen.push(JSON.parse(String(init?.body)))
						return Response.json({ created: 1, data: [{ b64_json: "AQID" }] })
					},
				},
			],
		})
		try {
			const provider = createOpenAIOAuth(pool)
			const result = await generateImage({
				model: provider.image("gpt-image-2"),
				prompt: "draw a tree",
				maxRetries: 0,
			})
			expect(result.image.base64).toBe("AQID")
			expect(seen).toEqual([
				{ model: "gpt-image-2", prompt: "draw a tree", n: 1 },
			])
		} finally {
			await pool.destroy()
		}
	})

	test("normalizes pooled AI SDK image edits only once", async () => {
		const seen: Record<string, unknown>[] = []
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			accounts: [
				{
					authFilePath: await authFile("image"),
					fetch: async (url, init) => {
						if (!String(url).endsWith("/images/edits"))
							throw new Error("unexpected upstream")
						seen.push(JSON.parse(String(init?.body)))
						return Response.json({ created: 1, data: [{ b64_json: "AQID" }] })
					},
				},
			],
		})
		try {
			const provider = createOpenAIOAuth(pool)
			const bytes = new Uint8Array([137, 80, 78, 71, 0, 255, 128, 13, 10])
			const result = await generateImage({
				model: provider.image("gpt-image-2"),
				prompt: { text: "edit", images: [bytes] },
				maxRetries: 0,
			})
			expect(result.image.base64).toBe("AQID")
			expect(seen).toHaveLength(1)
			expect(seen[0]).toMatchObject({
				model: "gpt-image-2",
				prompt: "edit",
				n: 1,
			})
			expect(JSON.stringify(seen[0]?.images)).toContain(
				Buffer.from(bytes).toString("base64"),
			)
		} finally {
			await pool.destroy()
		}
	})
})
