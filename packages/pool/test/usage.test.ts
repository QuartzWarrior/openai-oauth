import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { InferenceError } from "@openai-oauth/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createOpenAIPool } from "../src/index.js"
import { evaluateUsageBlock, parseCodexUsagePayload } from "../src/quota.js"
import { codexUsageUrl, UsageProbeScheduler } from "../src/usage-probe.js"
import {
	errorJsonResponse,
	makeAuthFile,
	makeJwt,
	makeRequestInit,
	makeSseResponse,
} from "./helpers.js"

const RESPONSES = "https://chatgpt.com/backend-api/codex/responses"
const ORIGINAL_FETCH = globalThis.fetch
const roots: string[] = []

afterEach(async () => {
	globalThis.fetch = ORIGINAL_FETCH
	vi.useRealTimers()
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	)
})

const urlOf = (input: RequestInfo | URL): string =>
	String(input instanceof Request ? input.url : input)
const isUsage = (input: RequestInfo | URL) => urlOf(input).endsWith("/usage")
const isModels = (input: RequestInfo | URL) => urlOf(input).includes("/models")

const stubCatalog = () => {
	globalThis.fetch = (async () => Response.json({ models: [] })) as typeof fetch
}

const uniqueInit = (() => {
	let counter = 0
	return (overrides: Record<string, unknown> = {}) =>
		makeRequestInit({
			input: [{ role: "user", content: `usage-${++counter}` }],
			...overrides,
		})
})()

const usagePayload = (
	options: {
		allowed?: boolean
		limitReached?: boolean
		primary?: number
		secondary?: number
		secondaryResetAt?: number
		hasCredits?: boolean
	} = {},
) => ({
	plan_type: "plus",
	rate_limit: {
		allowed: options.allowed ?? true,
		limit_reached: options.limitReached ?? false,
		primary_window: {
			used_percent: options.primary ?? 10,
			limit_window_seconds: 18_000,
			reset_after_seconds: 3_600,
			reset_at: Math.floor(Date.now() / 1000) + 3_600,
		},
		secondary_window: {
			used_percent: options.secondary ?? 20,
			limit_window_seconds: 604_800,
			reset_after_seconds: 86_400,
			reset_at:
				options.secondaryResetAt ?? Math.floor(Date.now() / 1000) + 86_400,
		},
	},
	credits: {
		has_credits: options.hasCredits ?? false,
		unlimited: false,
		balance: "0",
	},
})

const waitFor = async (condition: () => boolean, label: string) => {
	for (let i = 0; i < 400 && !condition(); i += 1)
		await new Promise((resolve) => setTimeout(resolve, 5))
	if (!condition()) throw new Error(`waitFor timed out: ${label}`)
}

describe("parseCodexUsagePayload", () => {
	it("maps windows, credits, reached type and additional families", () => {
		const snapshot = parseCodexUsagePayload(
			{
				...usagePayload({ secondary: 100, secondaryResetAt: 2_000 }),
				rate_limit_reached_type: { type: "rate_limit_reached" },
				spend_control: { reached: false },
				additional_rate_limits: [
					{
						metered_feature: "codex_other",
						limit_name: "Other",
						rate_limit: {
							allowed: true,
							limit_reached: false,
							primary_window: { used_percent: 5, reset_at: 3_000 },
						},
					},
				],
			},
			1_000_000,
		)
		expect(snapshot).toMatchObject({
			allowed: true,
			limitReached: false,
			secondary: {
				usedPercent: 100,
				windowMinutes: 10_080,
				resetAt: 2_000_000,
			},
			credits: { hasCredits: false, unlimited: false, balance: "0" },
			reachedType: "rate_limit_reached",
			spendControlReached: false,
			planType: "plus",
		})
		expect(snapshot?.updates.map((update) => update.limitId)).toEqual([
			"codex",
			"codex_other",
		])
	})

	it("falls back to reset_after_seconds and rejects malformed input", () => {
		const snapshot = parseCodexUsagePayload(
			{
				rate_limit: {
					primary_window: { used_percent: 50, reset_after_seconds: 60 },
				},
			},
			5_000,
		)
		expect(snapshot?.primary).toEqual({ usedPercent: 50, resetAt: 65_000 })
		expect(parseCodexUsagePayload("nope")).toBeUndefined()
		expect(
			parseCodexUsagePayload({
				rate_limit: { primary_window: { used_percent: -1 } },
			})?.primary,
		).toBeUndefined()
	})
})

describe("evaluateUsageBlock", () => {
	const now = 1_000
	it("blocks a saturated weekly window until its reset", () => {
		expect(
			evaluateUsageBlock(
				{ secondary: { usedPercent: 100, resetAt: 9_000 } },
				now,
			),
		).toEqual({ until: 9_000, reason: "usage limit reached (weekly)" })
	})
	it("lets credits carry a saturated window but not allowed:false", () => {
		const secondary = { usedPercent: 100, resetAt: 9_000 }
		expect(
			evaluateUsageBlock({ secondary, credits: { hasCredits: true } }, now),
		).toBeUndefined()
		expect(
			evaluateUsageBlock(
				{ allowed: false, secondary, credits: { hasCredits: true } },
				now,
			),
		).toMatchObject({ until: 9_000 })
	})
	it("blocks limit_reached with an unknown reset and passes healthy usage", () => {
		expect(evaluateUsageBlock({ limitReached: true }, now)).toEqual({
			until: undefined,
			reason: "usage limit reached",
		})
		expect(
			evaluateUsageBlock({ allowed: true, primary: { usedPercent: 99 } }, now),
		).toBeUndefined()
		// A reset already in the past no longer saturates the window.
		expect(
			evaluateUsageBlock({ primary: { usedPercent: 100, resetAt: 500 } }, now),
		).toBeUndefined()
	})
})

describe("codexUsageUrl", () => {
	it("mirrors codex PathStyle", () => {
		expect(codexUsageUrl()).toBe("https://chatgpt.com/backend-api/wham/usage")
		expect(codexUsageUrl("https://example.test/backend-api/codex/")).toBe(
			"https://example.test/backend-api/wham/usage",
		)
		expect(codexUsageUrl("http://localhost:8787/api/codex")).toBe(
			"http://localhost:8787/api/api/codex/usage",
		)
		expect(codexUsageUrl("http://localhost:8787")).toBe(
			"http://localhost:8787/api/codex/usage",
		)
	})
})

describe("UsageProbeScheduler", () => {
	const sequence = (values: number[]) => {
		let index = 0
		return () => values[index++ % values.length] ?? 0
	}

	it("probes every key once at random startup offsets with spaced starts", async () => {
		vi.useFakeTimers({ now: 0 })
		const started: Array<{ key: string; at: number }> = []
		const scheduler = new UsageProbeScheduler<string>(
			{
				startupWindowMs: 120_000,
				blockedProbeMs: 3_600_000,
				// Offsets reverse config order; gap jitter draws follow.
				random: sequence([0.9, 0.5, 0.1, 0, 0, 0]),
				now: Date.now,
			},
			async (key) => {
				started.push({ key, at: Date.now() })
			},
		)
		scheduler.start(["a", "b", "c"])
		for (const key of ["a", "b", "c"]) {
			const at = scheduler.nextProbeAt(key) ?? -1
			expect(at).toBeGreaterThanOrEqual(1_000)
			expect(at).toBeLessThan(120_000)
		}
		await vi.advanceTimersByTimeAsync(200_000)
		expect(started.map((entry) => entry.key)).toEqual(["c", "b", "a"])
		for (let index = 1; index < started.length; index += 1)
			expect(
				(started[index]?.at ?? 0) - (started[index - 1]?.at ?? 0),
			).toBeGreaterThanOrEqual(3_000)
		await vi.advanceTimersByTimeAsync(10 * 3_600_000)
		expect(started).toHaveLength(3)
		scheduler.stop()
	})

	it("spaces simultaneous blocked probes and keeps the ±20% hourly cadence", async () => {
		vi.useFakeTimers({ now: 0 })
		const started: Array<{ key: string; at: number }> = []
		const scheduler = new UsageProbeScheduler<string>(
			{
				startupWindowMs: false,
				blockedProbeMs: 3_600_000,
				random: () => 0.5,
				now: Date.now,
			},
			async (key) => {
				started.push({ key, at: Date.now() })
			},
		)
		scheduler.scheduleBlocked("a")
		scheduler.scheduleBlocked("b")
		expect(scheduler.nextProbeAt("a")).toBe(3_600_000)
		await vi.advanceTimersByTimeAsync(3_700_000)
		expect(started.map((entry) => entry.key)).toEqual(["a", "b"])
		expect(
			(started[1]?.at ?? 0) - (started[0]?.at ?? 0),
		).toBeGreaterThanOrEqual(3_000)
		scheduler.scheduleBlocked("a")
		scheduler.cancel("a")
		await vi.advanceTimersByTimeAsync(5 * 3_600_000)
		expect(started).toHaveLength(2)
		scheduler.stop()
	})

	it("draws blocked delays within 0.8–1.2 of the cadence", () => {
		for (const [draw, expected] of [
			[0, 2_880_000],
			[1, 4_320_000],
		] as const) {
			const scheduler = new UsageProbeScheduler<string>(
				{
					startupWindowMs: false,
					blockedProbeMs: 3_600_000,
					random: () => draw,
					now: () => 0,
				},
				async () => undefined,
			)
			scheduler.scheduleBlocked("a")
			expect(scheduler.nextProbeAt("a")).toBe(expected)
			scheduler.stop()
		}
	})
})

describe("usage-aware pool routing", () => {
	it("blocks an exhausted account from its startup probe and routes to another", async () => {
		stubCatalog()
		const resetAt = Math.floor(Date.now() / 1000) + 3 * 86_400
		const probes: Headers[] = []
		const calls: string[] = []
		const pool = await createOpenAIPool({
			codexVersion: "0.160.0",
			startupProbeWindowMs: 1,
			random: () => 0,
			accounts: ["a", "b"].map((name) => ({
				name,
				authFilePath: makeAuthFile({ accountId: `acct-${name}` }),
				fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
					if (isModels(input)) return Response.json({ models: [] })
					if (isUsage(input)) {
						expect(urlOf(input)).toBe(
							"https://chatgpt.com/backend-api/wham/usage",
						)
						probes.push(new Headers(init?.headers))
						return Response.json(
							name === "a"
								? usagePayload({
										allowed: false,
										limitReached: true,
										secondary: 100,
										secondaryResetAt: resetAt,
									})
								: usagePayload(),
						)
					}
					calls.push(name)
					return makeSseResponse(`resp-${name}-${calls.length}`)
				}) as typeof fetch,
			})),
		})
		try {
			await waitFor(() => probes.length >= 1, "startup probe of a")
			await waitFor(
				() =>
					pool.stats().find((stat) => stat.name === "a")?.usage.blocked ===
					true,
				"a blocked",
			)
			const probe = probes[0]
			expect(probe?.get("authorization")).toMatch(/^Bearer /)
			expect(probe?.get("chatgpt-account-id")).toBe("acct-a")
			expect(probe?.get("originator")).toBe("codex_cli_rs")
			expect(probe?.get("user-agent")).toMatch(/^codex_cli_rs\/0\.160\.0 /)
			expect(probe?.has("installation_id")).toBe(false)
			const statA = pool.stats().find((stat) => stat.name === "a")
			expect(statA?.healthy).toBe(false)
			expect(statA?.usage).toMatchObject({
				blocked: true,
				blockedUntil: resetAt * 1000,
				source: "probe",
			})
			expect(statA?.usage.nextProbeAt).toBeGreaterThan(Date.now() + 2_800_000)
			for (let index = 0; index < 3; index += 1)
				await (await pool.fetch(RESPONSES, uniqueInit())).text()
			expect(calls).toEqual(["b", "b", "b"])
		} finally {
			await pool.destroy()
		}
	})

	it("fails fast with the earliest reset when every account is blocked", async () => {
		stubCatalog()
		const soon = Math.floor(Date.now() / 1000) + 86_400
		const later = soon + 86_400
		let dispatched = 0
		const pool = await createOpenAIPool({
			codexVersion: "0.160.0",
			queueTimeoutMs: 60_000,
			startupProbeWindowMs: false,
			accounts: [soon, later].map((reset, index) => ({
				name: `n${index}`,
				authFilePath: makeAuthFile({ accountId: `acct-${index}` }),
				fetch: (async (input: RequestInfo | URL) => {
					if (isModels(input)) return Response.json({ models: [] })
					dispatched += 1
					return makeSseResponse(`resp-${index}`, {
						"x-codex-secondary-used-percent": "100",
						"x-codex-secondary-reset-at": String(reset),
					})
				}) as typeof fetch,
			})),
		})
		try {
			for (let index = 0; index < 2; index += 1)
				await (await pool.fetch(RESPONSES, uniqueInit())).text()
			expect(pool.stats().map((stat) => stat.usage.blocked)).toEqual([
				true,
				true,
			])
			const rejection = await pool
				.fetch(RESPONSES, uniqueInit())
				.catch((error: unknown) => error)
			expect(rejection).toBeInstanceOf(InferenceError)
			expect(rejection).toMatchObject({ category: "throttled" })
			const retryAt = (rejection as InferenceError).retryAt ?? 0
			expect(Math.abs(retryAt - soon * 1000)).toBeLessThan(2_000)
			expect(dispatched).toBe(2)
		} finally {
			await pool.destroy()
		}
	})

	it("re-admits at a known reset without probing, then re-blocks on 429", async () => {
		stubCatalog()
		let now = 1_000_000
		const calls: string[] = []
		let usageCalls = 0
		let aFails = false
		const pool = await createOpenAIPool({
			codexVersion: "0.160.0",
			now: () => now,
			startupProbeWindowMs: false,
			accounts: ["a", "b"].map((name) => ({
				name,
				authFilePath: makeAuthFile({ accountId: `acct-${name}` }),
				fetch: (async (input: RequestInfo | URL) => {
					if (isModels(input)) return Response.json({ models: [] })
					if (isUsage(input)) {
						usageCalls += 1
						return Response.json(usagePayload())
					}
					calls.push(name)
					if (name === "a" && aFails)
						return errorJsonResponse(429, {
							error: {
								code: "usage_limit_reached",
								resets_at: Math.floor(now / 1000) + 7_200,
							},
						})
					return makeSseResponse(
						`resp-${name}-${calls.length}`,
						name === "a" && calls.length === 1
							? {
									"x-codex-primary-used-percent": "100",
									"x-codex-primary-reset-at": String(
										Math.floor(now / 1000) + 600,
									),
								}
							: {},
					)
				}) as typeof fetch,
			})),
		})
		try {
			await (await pool.fetch(RESPONSES, uniqueInit())).text()
			expect(calls).toEqual(["a"])
			expect(pool.stats()[0]?.usage).toMatchObject({
				blocked: true,
				source: "headers",
			})
			await (await pool.fetch(RESPONSES, uniqueInit())).text()
			expect(calls).toEqual(["a", "b"])
			now += 601_000
			aFails = true
			// A is eligible again; its stale reset 429s and the request fails over.
			const response = await pool.fetch(RESPONSES, uniqueInit())
			await response.text()
			expect(response.status).toBe(200)
			expect(calls).toEqual(["a", "b", "a", "b"])
			expect(pool.stats()[0]?.usage).toMatchObject({
				blocked: true,
				blockedUntil: (Math.floor(now / 1000) + 7_200) * 1000,
				source: "response",
			})
			expect(usageCalls).toBe(0)
		} finally {
			await pool.destroy()
		}
	})

	it("ignores probe server errors and a probe answered after an owner change", async () => {
		stubCatalog()
		const root = await mkdtemp(path.join(os.tmpdir(), "oauth-usage-owner-"))
		roots.push(root)
		const file = path.join(root, "auth.json")
		const saveOwner = (owner: string) =>
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
		await saveOwner("first")
		let releaseProbe: (response: Response) => void = () => undefined
		let probeStarted = false
		const pool = await createOpenAIPool({
			codexVersion: "0.160.0",
			startupProbeWindowMs: 1,
			accounts: [
				{
					name: "only",
					authFilePath: file,
					fetch: (async (input: RequestInfo | URL) => {
						if (isModels(input)) return Response.json({ models: [] })
						if (isUsage(input)) {
							probeStarted = true
							return new Promise<Response>((resolve) => {
								releaseProbe = resolve
							})
						}
						return makeSseResponse("resp-owner")
					}) as typeof fetch,
				},
			],
		})
		try {
			await waitFor(() => probeStarted, "probe started")
			await new Promise((resolve) => setTimeout(resolve, 20))
			await saveOwner("second")
			await (await pool.fetch(RESPONSES, uniqueInit())).text()
			expect(pool.stats()[0]?.accountId).toBe("second")
			releaseProbe(
				Response.json(usagePayload({ allowed: false, secondary: 100 })),
			)
			await new Promise((resolve) => setTimeout(resolve, 20))
			expect(pool.stats()[0]?.usage.blocked).toBe(false)
			expect(pool.stats()[0]?.healthy).toBe(true)
		} finally {
			await pool.destroy()
		}

		stubCatalog()
		const failing = await createOpenAIPool({
			codexVersion: "0.160.0",
			startupProbeWindowMs: 1,
			accounts: [
				{
					authFilePath: makeAuthFile({ accountId: "acct-5xx" }),
					fetch: (async (input: RequestInfo | URL) => {
						if (isModels(input)) return Response.json({ models: [] })
						if (isUsage(input)) {
							probeStarted = false
							return errorJsonResponse(503, { error: "down" })
						}
						return makeSseResponse("resp-5xx")
					}) as typeof fetch,
				},
			],
		})
		try {
			await waitFor(() => probeStarted === false, "5xx probe")
			await new Promise((resolve) => setTimeout(resolve, 20))
			expect(failing.stats()[0]).toMatchObject({
				healthy: true,
				consecutiveFailures: 0,
				usage: { blocked: false },
			})
		} finally {
			await failing.destroy()
		}
	})
})

describe("usage reserve", () => {
	it("prefers below-reserve accounts over load, and drops data at reset", async () => {
		stubCatalog()
		let now = 1_000_000
		const calls: string[] = []
		const pool = await createOpenAIPool({
			codexVersion: "0.160.0",
			now: () => now,
			startupProbeWindowMs: false,
			accounts: ["a", "b"].map((name) => ({
				name,
				authFilePath: makeAuthFile({ accountId: `acct-${name}` }),
				fetch: (async (input: RequestInfo | URL) => {
					if (isModels(input)) return Response.json({ models: [] })
					calls.push(name)
					return makeSseResponse(`resp-${name}-${calls.length}`, {
						"x-codex-secondary-used-percent": name === "a" ? "97" : "40",
						"x-codex-secondary-reset-at": String(
							Math.floor(now / 1000) + (name === "a" ? 3_600 : 86_400),
						),
					})
				}) as typeof fetch,
			})),
		})
		try {
			await (await pool.fetch(RESPONSES, uniqueInit())).text()
			await (await pool.fetch(RESPONSES, uniqueInit())).text()
			expect(calls).toEqual(["a", "b"])
			expect(pool.stats().map((stat) => stat.usage.reserve)).toEqual([
				true,
				false,
			])
			// B carries an open stream; reserve still outranks its higher load.
			const held = await pool.fetch(RESPONSES, uniqueInit())
			expect(calls.at(-1)).toBe("b")
			await (await pool.fetch(RESPONSES, uniqueInit())).text()
			expect(calls.at(-1)).toBe("b")
			await held.text()
			// Identical-request affinity into the reserve account is ignored.
			const repeat = uniqueInit()
			await (await pool.fetch(RESPONSES, repeat)).text()
			expect(calls.at(-1)).toBe("b")
			// After A's window resets its 97% no longer counts.
			now += 3_601_000
			expect(pool.stats()[0]?.usage.reserve).toBe(false)
			await (await pool.fetch(RESPONSES, uniqueInit())).text()
			expect(calls.at(-1)).toBe("a")
		} finally {
			await pool.destroy()
		}
	})

	it("picks the less utilized account when every account is in reserve", async () => {
		stubCatalog()
		const calls: string[] = []
		const used: Record<string, string> = { a: "99", b: "96" }
		const pool = await createOpenAIPool({
			codexVersion: "0.160.0",
			startupProbeWindowMs: false,
			accounts: ["a", "b"].map((name) => ({
				name,
				authFilePath: makeAuthFile({ accountId: `acct-${name}` }),
				fetch: (async (input: RequestInfo | URL) => {
					if (isModels(input)) return Response.json({ models: [] })
					calls.push(name)
					return makeSseResponse(`resp-${name}-${calls.length}`, {
						"x-codex-secondary-used-percent": used[name] ?? "0",
					})
				}) as typeof fetch,
			})),
		})
		try {
			await (await pool.fetch(RESPONSES, uniqueInit())).text()
			await (await pool.fetch(RESPONSES, uniqueInit())).text()
			await (await pool.fetch(RESPONSES, uniqueInit())).text()
			expect(calls).toEqual(["a", "b", "b"])
		} finally {
			await pool.destroy()
		}
	})
})

describe("usage failover", () => {
	const quotaError = (resetsAt: number) =>
		errorJsonResponse(429, {
			error: { code: "usage_limit_reached", resets_at: resetsAt },
		})

	it("replays a fresh request on another account and benches the exhausted one", async () => {
		stubCatalog()
		const resetsAt = Math.floor(Date.now() / 1000) + 2 * 86_400
		const calls: string[] = []
		const pool = await createOpenAIPool({
			codexVersion: "0.160.0",
			startupProbeWindowMs: false,
			accounts: ["a", "b"].map((name) => ({
				name,
				authFilePath: makeAuthFile({ accountId: `acct-${name}` }),
				fetch: (async (input: RequestInfo | URL) => {
					if (isModels(input)) return Response.json({ models: [] })
					calls.push(name)
					return name === "a"
						? quotaError(resetsAt)
						: makeSseResponse(`resp-b-${calls.length}`)
				}) as typeof fetch,
			})),
		})
		try {
			const response = await pool.fetch(RESPONSES, uniqueInit())
			expect(response.status).toBe(200)
			await response.text()
			expect(calls).toEqual(["a", "b"])
			const statA = pool.stats()[0]
			expect(statA?.usage).toMatchObject({
				blocked: true,
				blockedUntil: resetsAt * 1000,
				source: "response",
			})
			expect(statA?.cooldownRemainingMs).toBeGreaterThan(86_400_000)
			await (await pool.fetch(RESPONSES, uniqueInit())).text()
			expect(calls).toEqual(["a", "b", "b"])
			expect(pool.stats().map((stat) => stat.inflight)).toEqual([0, 0])
		} finally {
			await pool.destroy()
		}
	})

	it("never replays a bound continuation", async () => {
		stubCatalog()
		const calls: string[] = []
		let aCalls = 0
		const pool = await createOpenAIPool({
			codexVersion: "0.160.0",
			startupProbeWindowMs: false,
			accounts: ["a", "b"].map((name) => ({
				name,
				authFilePath: makeAuthFile({ accountId: `acct-${name}` }),
				fetch: (async (input: RequestInfo | URL) => {
					if (isModels(input)) return Response.json({ models: [] })
					calls.push(name)
					if (name === "a" && ++aCalls === 2)
						return quotaError(Math.floor(Date.now() / 1000) + 3_600)
					return makeSseResponse(`resp-${name}`)
				}) as typeof fetch,
			})),
		})
		try {
			await (await pool.fetch(RESPONSES, makeRequestInit())).text()
			const next = await pool.fetch(
				RESPONSES,
				makeRequestInit({
					previous_response_id: "resp-a",
					input: [{ role: "user", content: "next" }],
				}),
			)
			expect(next.status).toBe(429)
			await next.text()
			expect(calls).toEqual(["a", "a"])
		} finally {
			await pool.destroy()
		}
	})

	it("returns the last error when every account is exhausted, or when disabled", async () => {
		for (const failoverOnUsageLimit of [true, false]) {
			stubCatalog()
			const calls: string[] = []
			const pool = await createOpenAIPool({
				codexVersion: "0.160.0",
				startupProbeWindowMs: false,
				failoverOnUsageLimit,
				accounts: ["a", "b"].map((name) => ({
					name,
					authFilePath: makeAuthFile({ accountId: `acct-${name}` }),
					fetch: (async (input: RequestInfo | URL) => {
						if (isModels(input)) return Response.json({ models: [] })
						calls.push(name)
						return quotaError(Math.floor(Date.now() / 1000) + 3_600)
					}) as typeof fetch,
				})),
			})
			try {
				const response = await pool.fetch(RESPONSES, uniqueInit())
				expect(response.status).toBe(429)
				expect(await response.json()).toMatchObject({
					error: { code: "usage_limit_reached" },
				})
				expect(calls).toEqual(failoverOnUsageLimit ? ["a", "b"] : ["a"])
				expect(pool.stats().map((stat) => stat.inflight)).toEqual([0, 0])
			} finally {
				await pool.destroy()
			}
		}
	})

	it("fails over on a pre-start transport quota error", async () => {
		stubCatalog()
		const calls: string[] = []
		const pool = await createOpenAIPool({
			codexVersion: "0.160.0",
			startupProbeWindowMs: false,
			accounts: ["a", "b"].map((name) => ({
				name,
				authFilePath: makeAuthFile({ accountId: `acct-${name}` }),
				fetch: (async (input: RequestInfo | URL) => {
					if (isModels(input)) return Response.json({ models: [] })
					calls.push(name)
					if (name === "a")
						throw new InferenceError({
							category: "quota",
							code: "usage_limit_reached",
							responseStarted: false,
						})
					return makeSseResponse("resp-b")
				}) as typeof fetch,
			})),
		})
		try {
			const response = await pool.fetch(RESPONSES, uniqueInit())
			expect(response.status).toBe(200)
			await response.text()
			expect(calls).toEqual(["a", "b"])
			expect(pool.stats()[0]?.usage.blocked).toBe(true)
		} finally {
			await pool.destroy()
		}
	})
})
