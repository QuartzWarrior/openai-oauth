import { readFileSync, writeFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { createOpenAIPool } from "../src/pool.js"
import {
	parseCodexQuotaEvent,
	parseCodexQuotaHeaders,
	QuotaStore,
} from "../src/quota.js"
import {
	makeAuthFile,
	makeJwt,
	makeRequestInit,
	makeSseResponse,
} from "./helpers.js"

const event = (data: Record<string, unknown>) => ({
	type: "codex.rate_limits",
	...data,
})
const record = (
	store: QuotaStore,
	data: Record<string, unknown>,
	at = 1000,
) => {
	const update = parseCodexQuotaEvent(event(data), at)
	if (update) store.update(update)
}
const responseUrl = "https://chatgpt.com/backend-api/codex/responses"
const quotaResponse = (id: string, data: Record<string, unknown>) =>
	new Response(
		`data: ${JSON.stringify(event(data))}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { id, status: "completed", output: [] } })}\n\n`,
		{ headers: { "content-type": "text/event-stream" } },
	)

describe("bounded quota diagnostics", () => {
	it("parses multiple header families and account credits without inventing per-meter balances", () => {
		const updates = parseCodexQuotaHeaders(
			new Headers({
				"X-Codex-Primary-Used-Percent": "42.5",
				"x-codex-primary-window-minutes": "300",
				"x-codex-primary-reset-at": "1234",
				"x-codex-other-secondary-used-percent": "110",
				"x-codex-other-limit-name": "Other limit",
				"x-codex-plan-type": "plus",
				"x-codex-credits-has-credits": "1",
				"x-codex-credits-unlimited": "FALSE",
				"x-codex-credits-balance": "1.234567890123456789",
			}),
			1000,
		)
		expect(updates).toHaveLength(2)
		expect(updates[0]).toMatchObject({
			limitId: "codex",
			planType: "plus",
			primary: { usedPercent: 42.5, windowMinutes: 300, resetAt: 1_234_000 },
			credits: {
				hasCredits: true,
				unlimited: false,
				balance: "1.234567890123456789",
			},
		})
		expect(updates[1]).toMatchObject({
			limitId: "codex_other",
			limitName: "Other limit",
			secondary: { usedPercent: 110 },
		})
		expect(updates[1]?.credits).toBeUndefined()
	})
	it("normalizes event meter identity without treating its fallback name as a model", () => {
		expect(
			parseCodexQuotaEvent(
				event({
					metered_limit_name: " CODEX-Other ",
					limit_name: "ignored",
					rate_limits: { primary: { used_percent: 8 } },
				}),
				1000,
			),
		).toMatchObject({ limitId: "codex_other" })
		expect(
			parseCodexQuotaEvent(
				event({
					limit_name: "Other-Meter",
					rate_limits: { secondary: { used_percent: 0 } },
				}),
				1000,
			),
		).toMatchObject({ limitId: "other_meter", secondary: { usedPercent: 0 } })
		expect(
			parseCodexQuotaEvent({ type: "response.completed" }, 1000),
		).toBeUndefined()
	})
	it("rejects invalid numbers, identifiers, text and observation timestamps", () => {
		const update = parseCodexQuotaEvent(
			event({
				rate_limits: {
					primary: {
						used_percent: 3,
						window_minutes: -1,
						reset_at: Number.MAX_SAFE_INTEGER,
					},
				},
				credits: {
					has_credits: "bad",
					unlimited: true,
					balance: "x".repeat(129),
				},
				plan_type: "a\nb",
			}),
			1000,
		)
		expect(update?.primary).toEqual({ usedPercent: 3 })
		expect(update?.credits).toEqual({ unlimited: true })
		expect(update?.planType).toBeUndefined()
		for (const bad of [NaN, Infinity, -1, "", " ", {}, "0x10"]) {
			expect(
				parseCodexQuotaEvent(
					event({ rate_limits: { primary: { used_percent: bad } } }),
					1000,
				),
			).toBeUndefined()
		}
		expect(
			parseCodexQuotaEvent(
				event({
					metered_limit_name: "../bad",
					rate_limits: { primary: { used_percent: 4 } },
				}),
				1000,
			),
		).toBeUndefined()
		expect(
			parseCodexQuotaHeaders(
				new Headers({ "x-codex-primary-used-percent": "3" }),
				Infinity,
			),
		).toEqual([])
	})
	it("merges partial windows, preserves independent freshness and ignores older observations", () => {
		const store = new QuotaStore()
		record(store, {
			rate_limits: {
				primary: { used_percent: 80, window_minutes: 300, reset_at: 1000 },
				secondary: { used_percent: 20 },
			},
		})
		record(
			store,
			{
				rate_limits: { secondary: { used_percent: 30 } },
				credits: { has_credits: true, unlimited: false, balance: "5" },
			},
			302_000,
		)
		record(
			store,
			{
				rate_limits: { secondary: { used_percent: 99 } },
				credits: { has_credits: false, unlimited: true },
			},
			2000,
		)
		const stats = store.snapshot(302_000)
		expect(stats?.families[0]?.primary).toMatchObject({
			usedPercent: 80,
			windowMinutes: 300,
			resetAt: 1_000_000,
			observedAt: 1000,
			stale: true,
		})
		expect(stats?.families[0]?.secondary).toMatchObject({
			usedPercent: 30,
			observedAt: 302_000,
			stale: false,
		})
		expect(stats?.credits).toMatchObject({
			hasCredits: true,
			unlimited: false,
			balance: "5",
			stale: false,
		})
		record(store, { rate_limits: { primary: { used_percent: 50 } } }, 303_000)
		expect(store.snapshot(303_000)?.families[0]?.primary).toMatchObject({
			usedPercent: 50,
			windowMinutes: 300,
			resetAt: 1_000_000,
		})
	})
	it("retains credit-only observations and never rejuvenates window freshness", () => {
		const store = new QuotaStore()
		for (const update of parseCodexQuotaHeaders(
			new Headers({
				"x-codex-credits-has-credits": "true",
				"x-codex-credits-unlimited": "false",
				"x-codex-credits-balance": "0",
			}),
			1000,
		))
			store.update(update)
		expect(store.snapshot(1000)).toMatchObject({
			families: [],
			credits: { balance: "0" },
		})
		record(store, { rate_limits: { primary: { used_percent: 90 } } }, 1000)
		record(
			store,
			{ credits: { has_credits: true, unlimited: false, balance: "2" } },
			302_000,
		)
		expect(store.snapshot(302_000)?.families[0]?.primary?.stale).toBe(true)
		expect(store.snapshot(302_000)?.credits?.stale).toBe(false)
	})
	it("merges reset-only and credit components without refreshing older values", () => {
		const store = new QuotaStore()
		record(
			store,
			{
				rate_limits: { primary: { used_percent: 70 } },
				credits: { has_credits: true },
			},
			1000,
		)
		record(
			store,
			{
				rate_limits: { primary: { reset_at: 999 } },
				credits: { unlimited: false },
			},
			302_000,
		)
		record(store, { credits: { balance: "2" } }, 303_000)
		expect(store.snapshot(303_000)).toMatchObject({
			families: [
				{
					primary: {
						usedPercent: 70,
						resetAt: 999_000,
						observedAt: 1000,
						stale: true,
					},
				},
			],
			credits: {
				hasCredits: true,
				unlimited: false,
				balance: "2",
				observedAt: 1000,
				stale: true,
			},
		})
		record(
			store,
			{
				rate_limits: { primary: { reset_at: 3 } },
				credits: { balance: "old" },
			},
			2000,
		)
		expect(store.snapshot(303_000)?.families[0]?.primary?.resetAt).toBe(999_000)
		expect(store.snapshot(303_000)?.credits?.balance).toBe("2")
	})
	it("bounds families, protects the default meter and returns independent copies", () => {
		const store = new QuotaStore()
		record(store, {
			rate_limits: { primary: { used_percent: 10 } },
			credits: { has_credits: true, unlimited: false, balance: "5" },
		})
		for (let i = 0; i < 40; i++)
			record(
				store,
				{
					metered_limit_name: `meter_${i}`,
					rate_limits: { primary: { used_percent: i } },
				},
				2000 + i,
			)
		const stats = store.snapshot(3000)
		expect(stats?.families).toHaveLength(32)
		expect(stats?.families.some((f) => f.limitId === "codex")).toBe(true)
		expect(stats?.families.some((f) => f.limitId === "meter_0")).toBe(false)
		const first = stats?.families[0]?.primary
		if (first) first.usedPercent = 999
		if (stats?.credits) stats.credits.balance = "mutated"
		expect(store.snapshot(3000)?.families[0]?.primary?.usedPercent).toBe(10)
		expect(store.snapshot(3000)?.credits?.balance).toBe("5")
		store.clear()
		expect(store.snapshot()).toBeUndefined()
	})
})

describe("pool quota integration", () => {
	it("records named SSE events without affecting the default family or scheduling", async () => {
		const calls: string[] = []
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			now: () => 1000,
			accounts: ["a", "b"].map((owner) => ({
				authFilePath: makeAuthFile({ accountId: owner }),
				fetch: async (url: RequestInfo | URL) => {
					if (String(url).includes("/models"))
						return Response.json({ models: [] })
					calls.push(owner)
					return quotaResponse(`r-${calls.length}`, {
						metered_limit_name: "codex_other",
						rate_limits: { primary: { used_percent: 100, reset_at: 99999 } },
						credits: { has_credits: true, unlimited: false },
					})
				},
			})),
		})
		try {
			const first = await pool.fetch(
				responseUrl,
				makeRequestInit({ input: "first", stream: false }),
			)
			const body = await first.json()
			expect(body.output).toEqual([])
			expect(JSON.stringify(body)).not.toContain("codex.rate_limits")
			expect(pool.stats()[0]).toMatchObject({
				healthy: true,
				cooldownRemainingMs: 0,
				quota: {
					families: [{ limitId: "codex_other", primary: { usedPercent: 100 } }],
				},
			})
			expect(pool.stats()[0]?.codex).toBeUndefined()
			await (
				await pool.fetch(responseUrl, makeRequestInit({ input: "second" }))
			).text()
			expect(calls).toEqual(["a", "a"])
		} finally {
			await pool.destroy()
		}
	})
	it("keeps SSE observations newer than their nonstream HTTP headers", async () => {
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			now: () => 1000,
			accounts: [
				{
					authFilePath: makeAuthFile({ accountId: "a" }),
					fetch: async (url) => {
						if (String(url).includes("/models"))
							return Response.json({ models: [] })
						const response = quotaResponse("r", {
							rate_limits: { primary: { used_percent: 75 } },
						})
						response.headers.set("x-codex-primary-used-percent", "25")
						return response
					},
				},
			],
		})
		try {
			await (
				await pool.fetch(responseUrl, makeRequestInit({ stream: false }))
			).text()
			expect(pool.stats()[0]?.quota?.families[0]?.primary?.usedPercent).toBe(75)
		} finally {
			await pool.destroy()
		}
	})
	it("keeps legacy default utilization while observing failed HTTP headers", async () => {
		let count = 0
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			now: () => 1000,
			accounts: [
				{
					authFilePath: makeAuthFile({ accountId: "a" }),
					fetch: async (url) => {
						if (String(url).includes("/models"))
							return Response.json({ models: [] })
						if (++count === 1)
							return quotaResponse("r", {
								rate_limits: { primary: { used_percent: 7 } },
							})
						return Response.json(
							{ error: { code: "invalid_request" } },
							{
								status: 400,
								headers: { "x-codex-other-secondary-used-percent": "45" },
							},
						)
					},
				},
			],
		})
		try {
			await (await pool.fetch(responseUrl, makeRequestInit())).text()
			await (
				await pool.fetch(responseUrl, makeRequestInit({ input: "other" }))
			).text()
			expect(pool.stats()[0]?.codex?.primaryUsedPercent).toBe(7)
			expect(pool.stats()[0]?.quota?.families.map((f) => f.limitId)).toEqual([
				"codex",
				"codex_other",
			])
			expect(pool.stats()[0]?.healthy).toBe(true)
		} finally {
			await pool.destroy()
		}
	})
	it("clears observations on owner replacement and fences old streamed events", async () => {
		const file = makeAuthFile({ accountId: "a" })
		let emit!: (text: string) => void
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			now: () => 1000,
			accounts: [
				{
					authFilePath: file,
					fetch: async (url, init) => {
						if (String(url).includes("/models"))
							return Response.json({ models: [] })
						if (new Headers(init?.headers).get("chatgpt-account-id") === "b")
							return makeSseResponse("b", {
								"x-codex-primary-used-percent": "7",
							})
						return new Response(
							new ReadableStream<Uint8Array>({
								start(c) {
									emit = (text) => c.enqueue(new TextEncoder().encode(text))
								},
							}),
							{
								headers: {
									"content-type": "text/event-stream",
									"x-codex-old-primary-used-percent": "12",
								},
							},
						)
					},
				},
			],
		})
		try {
			const old = await pool.fetch(
				responseUrl,
				makeRequestInit({ stream: true }),
			)
			expect(pool.stats()[0]?.quota?.families[0]?.limitId).toBe("codex_old")
			const saved = JSON.parse(readFileSync(file, "utf8"))
			saved.tokens.account_id = "b"
			saved.tokens.access_token = makeJwt({
				"https://api.openai.com/auth": { chatgpt_account_id: "b" },
			})
			writeFileSync(file, JSON.stringify(saved))
			await (
				await pool.fetch(responseUrl, makeRequestInit({ input: "new" }))
			).text()
			emit(
				`data: ${JSON.stringify(event({ metered_limit_name: "codex_old", rate_limits: { primary: { used_percent: 99 } } }))}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "a", status: "completed", output: [] } })}\n\n`,
			)
			await old.text()
			expect(pool.stats()[0]?.quota?.families.map((f) => f.limitId)).toEqual([
				"codex",
			])
			expect(pool.stats()[0]?.quota?.families[0]?.primary?.usedPercent).toBe(7)
		} finally {
			await pool.destroy()
		}
	})
})
