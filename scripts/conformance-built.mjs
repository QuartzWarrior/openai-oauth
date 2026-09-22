import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"
import { createOpenAIOAuth } from "../packages/ai-sdk/dist/index.js"
import {
	createOpenAIOAuthTransport,
	inspectContextBudget,
} from "../packages/core/dist/index.js"
import { createOpenAIOptions } from "../packages/openai-client/dist/index.js"
import { createOpenAIPool } from "../packages/pool/dist/index.js"

// Test production artifacts with Node alone: no Vite runtime on the minimum
// supported Node version. All provider I/O is replaced with in-memory responses.
const requireClient = createRequire(
	new URL("../packages/openai-client/package.json", import.meta.url),
)
const { default: OpenAI } = await import(
	pathToFileURL(requireClient.resolve("openai")).href
)
const requireAi = createRequire(
	new URL("../packages/ai-sdk/package.json", import.meta.url),
)
const { generateText } = await import(
	pathToFileURL(requireAi.resolve("ai")).href
)
const model = "gpt-5-codex"
const jwt = (accountId) =>
	[
		Buffer.from('{"alg":"none"}').toString("base64url"),
		Buffer.from(
			JSON.stringify({
				exp: Math.floor(Date.now() / 1000) + 3600,
				"https://api.openai.com/auth": { chatgpt_account_id: accountId },
			}),
		).toString("base64url"),
		"fixture",
	].join(".")
const output = [
	{
		type: "message",
		id: "msg-1",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text: "hello", annotations: [] }],
	},
]
const completed = (id, minimal = false) => {
	const response = minimal
		? { id }
		: {
				id,
				object: "response",
				model,
				status: "completed",
				output,
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					total_tokens: 2,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens_details: { reasoning_tokens: 0 },
				},
			}
	const events = minimal
		? []
		: [
				{
					type: "response.created",
					response: { ...response, status: "in_progress", output: [] },
				},
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { ...output[0], status: "in_progress", content: [] },
				},
				{
					type: "response.output_text.delta",
					item_id: "msg-1",
					output_index: 0,
					content_index: 0,
					delta: "hello",
				},
				{ type: "response.output_item.done", output_index: 0, item: output[0] },
			]
	events.push({ type: "response.completed", response })
	return new Response(
		events
			.map(
				(event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
			)
			.join(""),
		{ headers: { "content-type": "text/event-stream" } },
	)
}
const catalog = () =>
	Response.json({
		models: [
			{
				slug: model,
				visibility: "list",
				supported_in_api: true,
				context_window: 10000,
				input_modalities: ["text", "image"],
			},
		],
	})
const fixture = async (run) => {
	const directory = await mkdtemp(
		path.join(tmpdir(), "oauth-built-conformance-"),
	)
	const authFilePath = path.join(directory, "auth.json")
	const accountId = "fixture-account"
	await writeFile(
		authFilePath,
		JSON.stringify({
			tokens: { account_id: accountId, access_token: jwt(accountId) },
		}),
		{ mode: 0o600 },
	)
	let pool
	try {
		pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			accounts: [
				{
					authFilePath,
					fetch: async (url, init) => {
						if (String(url).includes("/models?")) return catalog()
						assert.equal(
							new Headers(init?.headers).get("chatgpt-account-id"),
							accountId,
						)
						if (String(url).endsWith("/images/generations")) {
							assert.deepEqual(JSON.parse(String(init.body)), {
								model: "gpt-image-2",
								prompt: "draw a tree",
								n: 1,
							})
							return Response.json({ created: 1, data: [{ b64_json: "AQID" }] })
						}
						if (String(url).endsWith("/images/edits")) {
							const body = JSON.parse(String(init.body))
							assert.equal(
								body.images[0].image_url,
								"data:image/png;base64,AP+AKg==",
							)
							return Response.json({
								created: 1,
								data: [{ b64_json: "AP+AKg==" }],
							})
						}
						return completed("response-built")
					},
				},
			],
		})
		await run(pool)
	} finally {
		await pool?.destroy()
		await rm(directory, { recursive: true, force: true })
	}
}

test("built core accepts minimal completion envelopes", async () => {
	const transport = createOpenAIOAuthTransport({
		auth: { accountId: "fixture", accessToken: "fixture" },
		codexVersion: "0.154.0",
		fetch: async (url) =>
			String(url).includes("/models?") ? catalog() : completed("minimal", true),
	})
	const response = await transport.request("responses", {
		method: "POST",
		body: JSON.stringify({ model, input: "hello", stream: false }),
	})
	assert.equal((await response.json()).id, "minimal")
})

test("built OpenAI adapter uses pool ready transport without separate ownership selection", async () =>
	fixture(async (pool) => {
		pool.getSession = async () => {
			throw new Error("Adapter must not select pool ownership independently")
		}
		const client = new OpenAI(createOpenAIOptions(pool))
		const response = await client.responses.create({ model, input: "hello" })
		assert.equal(response.id, "response-built")
	}))

test("built OpenAI adapter normalizes pooled JSON image generation", async () =>
	fixture(async (pool) => {
		const client = new OpenAI(createOpenAIOptions(pool))
		const response = await client.images.generate({
			model: "gpt-image-2",
			prompt: "draw a tree",
			n: 1,
		})
		assert.equal(response.data[0].b64_json, "AQID")
	}))

test("built OpenAI adapter preserves multipart image bytes through the pool", async () =>
	fixture(async (pool) => {
		const client = new OpenAI(createOpenAIOptions(pool))
		const response = await client.images.edit({
			model: "gpt-image-2",
			prompt: "edit",
			image: new File([new Uint8Array([0, 255, 128, 42])], "image.png", {
				type: "image/png",
			}),
		})
		assert.equal(response.data[0].b64_json, "AP+AKg==")
	}))

test("built catalog and context APIs remain owner-scoped and read-only", async () =>
	fixture(async (pool) => {
		const snapshot = await pool.getModelCatalog("account-0")
		assert.equal(snapshot.owner.accountId, "fixture-account")
		assert.equal(snapshot.models[0].contextWindow, 10000)
		assert.deepEqual(snapshot.models[0].inputModalities, ["text", "image"])
		const cached = await pool.getModelCatalog("account-0", { cacheOnly: true })
		assert.equal(cached.fetchedAt, snapshot.fetchedAt)
		const budget = inspectContextBudget(
			{ model, input: "hello" },
			{
				catalog: cached,
				estimateTokens: (text) => text.length,
			},
		)
		assert.equal(budget.modelContextLimit, 10000)
		assert.equal(budget.estimatedTextTokens, 5)
		assert.equal(budget.approximate, true)
		assert.deepEqual(budget.unknownComponents, ["protocol-overhead"])
		assert.equal(pool.stats()[0].inflight, 0)
	}))

test("built AI SDK adapter uses pool ready transport", async () =>
	fixture(async (pool) => {
		pool.getSession = async () => {
			throw new Error("Adapter must not select pool ownership independently")
		}
		const result = await generateText({
			model: createOpenAIOAuth(pool)(model),
			prompt: "hello",
		})
		assert.equal(result.text, "hello")
	}))
