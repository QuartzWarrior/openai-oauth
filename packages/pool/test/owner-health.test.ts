import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createOpenAIPool } from "../src/pool.js"
import { makeJwt, makeRequestInit, makeSseResponse } from "./helpers.js"

const url = "https://chatgpt.com/backend-api/codex/responses"
const roots: string[] = []
const deferred = <T>() => {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}
const saveOwner = (file: string, owner: string) =>
	writeFile(
		file,
		JSON.stringify({
			auth_mode: "chatgpt",
			tokens: {
				id_token: makeJwt({ sub: owner }),
				access_token: makeJwt({
					"https://api.openai.com/auth": { chatgpt_account_id: owner },
				}),
				account_id: owner,
			},
		}),
		{ mode: 0o600 },
	)
const authFile = async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "oauth-owner-health-"))
	roots.push(root)
	const file = path.join(root, "auth.json")
	await saveOwner(file, "a")
	return file
}
const rateError = () =>
	Response.json(
		{ error: { code: "rate_limit_exceeded" } },
		{ status: 429, headers: { "retry-after": "600" } },
	)

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	)
})

describe("authenticated owner HTTP health fencing", () => {
	it.each([
		"headers",
		"error body",
	])("ignores an old owner's 429 after replacement while awaiting %s", async (waitingFor) => {
		const file = await authFile()
		const dispatched = deferred<void>()
		const headers = deferred<Response>()
		const reading = deferred<void>()
		const body = deferred<void>()
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			now: () => 100_000,
			accounts: [
				{
					authFilePath: file,
					fetch: async (input, init) => {
						if (String(input).includes("/models"))
							return Response.json({ models: [] })
						if (new Headers(init?.headers).get("chatgpt-account-id") === "a") {
							dispatched.resolve()
							return headers.promise
						}
						return makeSseResponse("b", {
							"x-codex-primary-used-percent": "7",
						})
					},
				},
			],
		})
		try {
			const old = pool.fetch(url, makeRequestInit({ input: "old-owner" }))
			await dispatched.promise
			if (waitingFor === "error body") {
				headers.resolve(
					new Response(
						new ReadableStream<Uint8Array>(
							{
								async pull(controller) {
									reading.resolve()
									await body.promise
									controller.enqueue(
										new TextEncoder().encode(
											'{"error":{"code":"rate_limit_exceeded"}}',
										),
									)
									controller.close()
								},
							},
							{ highWaterMark: 0 },
						),
						{ status: 429, headers: { "retry-after": "3600" } },
					),
				)
				await reading.promise
			}
			await saveOwner(file, "b")
			await (
				await pool.fetch(url, makeRequestInit({ input: "new-owner" }))
			).text()
			expect(pool.stats()[0]).toMatchObject({ accountId: "b", healthy: true })
			if (waitingFor === "headers") headers.resolve(rateError())
			else body.resolve()
			const result = await old
			expect(result.status).toBe(429)
			await result.text()
			expect(pool.stats()[0]).toMatchObject({
				accountId: "b",
				healthy: true,
				inflight: 0,
				cooldownRemainingMs: 0,
				consecutiveFailures: 0,
				codex: { primaryUsedPercent: 7 },
			})
		} finally {
			body.resolve()
			headers.resolve(rateError())
			await pool.destroy()
		}
	})

	it("does not replace the new owner's utilization or clear its failures on old-owner success", async () => {
		const file = await authFile()
		const dispatched = deferred<void>()
		const oldResponse = deferred<Response>()
		let bCalls = 0
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			now: () => 100_000,
			accounts: [
				{
					authFilePath: file,
					fetch: async (input, init) => {
						if (String(input).includes("/models"))
							return Response.json({ models: [] })
						if (new Headers(init?.headers).get("chatgpt-account-id") === "a") {
							dispatched.resolve()
							return oldResponse.promise
						}
						return ++bCalls === 1
							? makeSseResponse("b", { "x-codex-primary-used-percent": "20" })
							: rateError()
					},
				},
			],
		})
		try {
			const old = pool.fetch(url, makeRequestInit({ input: "old-owner" }))
			await dispatched.promise
			await saveOwner(file, "b")
			await (
				await pool.fetch(url, makeRequestInit({ input: "b-success" }))
			).text()
			await (
				await pool.fetch(url, makeRequestInit({ input: "b-throttled" }))
			).text()
			expect(pool.stats()[0]).toMatchObject({
				accountId: "b",
				healthy: false,
				consecutiveFailures: 1,
				cooldownRemainingMs: 600_000,
				codex: { primaryUsedPercent: 20 },
			})
			oldResponse.resolve(
				makeSseResponse("a", { "x-codex-primary-used-percent": "95" }),
			)
			await (await old).text()
			expect(pool.stats()[0]).toMatchObject({
				accountId: "b",
				healthy: false,
				inflight: 0,
				consecutiveFailures: 1,
				cooldownRemainingMs: 600_000,
				codex: { primaryUsedPercent: 20 },
			})
		} finally {
			oldResponse.resolve(makeSseResponse("a"))
			await pool.destroy()
		}
	})
})
