import { afterEach, describe, expect, test, vi } from "vitest"
import { startOpenAIOAuthServer } from "../src/index.js"

describe("node server runtime", () => {
	let close: (() => Promise<void>) | undefined

	afterEach(async () => {
		await close?.()
		close = undefined
	})

	test("starts an http server and serves health", async () => {
		const running = await startOpenAIOAuthServer({
			host: "127.0.0.1",
			port: 0,
			models: ["gpt-5.4-mini"],
		})
		close = running.close

		const response = await fetch(
			`http://${running.host}:${running.port}/health`,
		)
		expect(response.ok).toBe(true)
		await expect(response.json()).resolves.toEqual({
			ok: true,
			replay_state: "stateless",
		})
	})

	test("advertises a bracketed IPv6 URL while retaining the listen host", async ({
		skip,
	}) => {
		let running: Awaited<ReturnType<typeof startOpenAIOAuthServer>>
		try {
			running = await startOpenAIOAuthServer({
				host: "::1",
				port: 0,
				models: ["test-model"],
			})
		} catch (error) {
			if (
				error &&
				typeof error === "object" &&
				"code" in error &&
				["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(String(error.code))
			) {
				skip()
				return
			}
			throw error
		}
		close = running.close
		expect(running.host).toBe("::1")
		expect(new URL(running.url).hostname).toBe("[::1]")
		expect((await fetch(new URL("/health", running.url))).status).toBe(200)
	})

	test("can start before resolving the model catalog", async () => {
		const fetch = vi.fn()
		const running = await startOpenAIOAuthServer({
			credentials: {
				kind: "openai-oauth",
				fetch,
				getSession: async () => ({
					accessToken: "access-token",
					accountId: "acct-deferred",
				}),
			},
			deferModelDiscovery: true,
			host: "127.0.0.1",
			port: 0,
		})
		close = running.close

		expect(fetch).not.toHaveBeenCalled()
		expect(running.models).toEqual([])
	})
})
