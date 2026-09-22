import { afterEach, describe, expect, it, vi } from "vitest"
import { makeAuthFile, makeRequestInit, makeSseResponse } from "./helpers.js"

const ws = vi.hoisted(() => ({
	streamResponse: vi.fn(),
	close: vi.fn(async () => {}),
	prewarm: vi.fn(),
}))
vi.mock("../src/websocket-transport.js", () => ({
	createWebsocketTransport: () => ws,
}))

import { createOpenAIPool } from "../src/pool.js"

const url = "https://chatgpt.com/backend-api/codex/responses"
afterEach(() => {
	vi.unstubAllGlobals()
	vi.clearAllMocks()
})

describe("pool WebSocket normalized execution", () => {
	it("passes trusted account IDs and finalizes stream:false using core", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ models: [] }), {
						headers: { "content-type": "application/json" },
					}),
			),
		)
		ws.streamResponse.mockImplementation(
			async () => makeSseResponse("response-ws").body,
		)
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			accounts: [
				{
					authFilePath: makeAuthFile({ accountId: "actual-account" }),
					installationId: "not-account-id",
					transport: "websocket",
				},
			],
		})
		const response = await pool.fetch(
			url,
			makeRequestInit({ stream: false, store: true }),
		)
		expect(response.headers.get("content-type")).toContain("application/json")
		expect((await response.json()).id).toBe("response-ws")
		const [body, identity, token] = ws.streamResponse.mock.calls[0] ?? []
		expect(body).toMatchObject({
			stream: true,
			store: false,
			tool_choice: "auto",
		})
		expect(identity).toMatchObject({
			accountId: "actual-account",
			installationId: "not-account-id",
			isFedRamp: false,
		})
		expect(token).toBeTruthy()
		expect(pool.stats()[0]?.inflight).toBe(0)
		await pool.destroy()
	})

	it("does not replay a failed WebSocket exchange on HTTP", async () => {
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ models: [] }), {
					headers: { "content-type": "application/json" },
				}),
		)
		vi.stubGlobal("fetch", fetch)
		ws.streamResponse.mockRejectedValue(
			new Error("Websocket response cancelled."),
		)
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			accounts: [
				{
					authFilePath: makeAuthFile({ accountId: "a" }),
					transport: "websocket",
				},
			],
		})
		await expect(pool.fetch(url, makeRequestInit())).rejects.toThrow(
			/cancelled/,
		)
		expect(
			fetch.mock.calls.every(
				([input]) => !String(input).endsWith("/responses"),
			),
		).toBe(true)
		expect(pool.stats()[0]?.inflight).toBe(0)
		await pool.destroy()
	})
})
