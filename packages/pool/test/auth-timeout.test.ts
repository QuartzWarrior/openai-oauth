import { readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { AuthRefreshTimeoutError } from "@openai-oauth/local"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createOpenAIPool } from "../src/pool.js"
import {
	makeAuthFile,
	makeJwt,
	makeRequestInit,
	makeSseResponse,
} from "./helpers.js"

const roots: string[] = []
const url = "https://openai-oauth.local/v1/responses"
const authFile = (accountId: string, expired = false): string => {
	const filePath = makeAuthFile({ accountId })
	roots.push(path.dirname(filePath))
	if (expired) {
		const data = JSON.parse(readFileSync(filePath, "utf8"))
		data.tokens.access_token = makeJwt({ exp: 1 })
		data.tokens.refresh_token = `synthetic-refresh-${accountId}`
		writeFileSync(filePath, JSON.stringify(data))
	}
	return filePath
}
const deferred = <T>() => {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true })
})

describe("pool shared refresh timeouts", () => {
	it("cools down the timed-out account so independent requests can use another account", async () => {
		const entered = deferred<void>()
		const stalled = deferred<Response>()
		const refresh = vi.fn(async () => {
			entered.resolve()
			return stalled.promise
		})
		const inference: string[] = []
		const fetchFor =
			(accountId: string) => async (input: RequestInfo | URL) => {
				if (String(input).includes("/models"))
					return Response.json({ models: [] })
				inference.push(accountId)
				return makeSseResponse(`response-${accountId}`)
			}
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			now: () => Date.now(),
			accounts: [
				{
					authFilePath: authFile("a", true),
					refreshFetch: refresh,
					fetch: fetchFor("a"),
				},
				{ authFilePath: authFile("b"), fetch: fetchFor("b") },
			],
		})
		vi.useFakeTimers()
		try {
			const failed = expect(
				pool.fetch(url, makeRequestInit({ stream: false })),
			).rejects.toBeInstanceOf(AuthRefreshTimeoutError)
			await entered.promise
			await vi.advanceTimersByTimeAsync(30_000)
			await failed
			expect(pool.stats()[0]).toMatchObject({
				healthy: false,
				inflight: 0,
				consecutiveFailures: 1,
				cooldownRemainingMs: 5_000,
			})

			const response = await pool.fetch(
				url,
				makeRequestInit({ stream: false, input: "independent request" }),
			)
			expect((await response.json()).id).toBe("response-b")
			expect(inference).toEqual(["b"])
			expect(refresh).toHaveBeenCalledOnce()

			await vi.advanceTimersByTimeAsync(5_000)
			expect(pool.stats()[0]).toMatchObject({
				healthy: true,
				cooldownRemainingMs: 0,
			})
		} finally {
			await pool.destroy()
		}
	})

	it("does not penalize an account when only the caller cancels its refresh wait", async () => {
		const entered = deferred<void>()
		const stalled = deferred<Response>()
		let refreshSignal: AbortSignal | null | undefined
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			now: () => Date.now(),
			accounts: [
				{
					authFilePath: authFile("a", true),
					refreshFetch: async (_input, init) => {
						refreshSignal = init?.signal
						entered.resolve()
						return stalled.promise
					},
					fetch: async () => {
						throw new Error("Inference must not run after caller cancellation.")
					},
				},
			],
		})
		try {
			const controller = new AbortController()
			const failed = expect(
				pool.fetch(url, {
					...makeRequestInit(),
					signal: controller.signal,
				}),
			).rejects.toMatchObject({ name: "AbortError" })
			await entered.promise
			controller.abort()
			await failed
			expect(refreshSignal?.aborted).toBe(false)
			expect(pool.stats()[0]).toMatchObject({
				healthy: true,
				inflight: 0,
				consecutiveFailures: 0,
				cooldownRemainingMs: 0,
			})
		} finally {
			await pool.destroy()
		}
	})
})
