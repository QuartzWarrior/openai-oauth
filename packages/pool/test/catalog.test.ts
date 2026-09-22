import { readFileSync, writeFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createOpenAIPool } from "../src/pool.js"
import { makeAuthFile, makeJwt } from "./helpers.js"

const catalog = (name: string) =>
	Response.json(
		{
			models: [
				{
					slug: `${name}-public`,
					visibility: "list",
					supported_in_api: true,
					context_window: 10000,
				},
				{ slug: `${name}-oauth`, visibility: "list", supported_in_api: false },
				{ slug: `${name}-hidden`, visibility: "hide", supported_in_api: true },
			],
		},
		{ headers: { etag: `"${name}"` } },
	)

afterEach(() => vi.restoreAllMocks())

describe("explicit pool catalog inspection", () => {
	it("inspects only the named account and keeps default listing behavior", async () => {
		const a = vi.fn(async () => catalog("a"))
		const b = vi.fn(async () => catalog("b"))
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			accounts: [
				{
					name: "a",
					authFilePath: makeAuthFile({ accountId: "owner-a" }),
					fetch: a,
				},
				{
					name: "b",
					authFilePath: makeAuthFile({ accountId: "owner-b" }),
					fetch: b,
				},
			],
		})
		try {
			const select = vi.spyOn(pool, "getSession")
			const before = await pool.getModelCatalog("b", { cacheOnly: true })
			expect(before.freshness).toBe("missing")
			expect(a).not.toHaveBeenCalled()
			expect(b).not.toHaveBeenCalled()
			const snapshot = await pool.getModelCatalog("b")
			expect(snapshot.accountName).toBe("b")
			expect(snapshot.owner?.accountId).toBe("owner-b")
			expect(snapshot.models.map((model) => model.slug)).toEqual(["b-public"])
			expect(
				(await pool.getModelCatalog("b", { mode: "oauth-visible" })).models.map(
					(model) => model.slug,
				),
			).toEqual(["b-public", "b-oauth"])
			expect(
				(await pool.getModelCatalog("b", { mode: "all" })).models,
			).toHaveLength(3)
			expect(a).not.toHaveBeenCalled()
			expect(b).toHaveBeenCalledOnce()
			expect(select).not.toHaveBeenCalled()
			expect(pool.stats().every((account) => account.inflight === 0)).toBe(true)
		} finally {
			await pool.destroy()
		}
	})

	it("cached inspection does not refresh credentials or pretend to verify external replacement", async () => {
		const path = makeAuthFile({ accountId: "a" })
		const fetch = vi.fn(async () => catalog("a"))
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			accounts: [{ name: "a", authFilePath: path, fetch }],
		})
		try {
			await pool.getModelCatalog("a")
			const auth = JSON.parse(readFileSync(path, "utf8"))
			auth.tokens.access_token = makeJwt({ exp: 1 })
			auth.tokens.refresh_token = "synthetic-needs-refresh"
			writeFileSync(path, JSON.stringify(auth))
			const cached = await pool.getModelCatalog("a", { cacheOnly: true })
			expect(cached.owner?.accountId).toBe("a")
			expect(cached.models).toHaveLength(1)
			expect(fetch).toHaveBeenCalledOnce()
		} finally {
			await pool.destroy()
		}
	})

	it("rejects unknown, ambiguous and closed targets without network work", async () => {
		const fetch = vi.fn(async () => catalog("a"))
		const pool = await createOpenAIPool({
			codexVersion: "0.154.0",
			accounts: [
				{
					name: "duplicate",
					authFilePath: makeAuthFile({ accountId: "a" }),
					fetch,
				},
				{
					name: "duplicate",
					authFilePath: makeAuthFile({ accountId: "b" }),
					fetch,
				},
			],
		})
		try {
			await expect(pool.getModelCatalog("missing")).rejects.toThrow(/unique/)
			await expect(pool.getModelCatalog("duplicate")).rejects.toThrow(/unique/)
			await pool.close()
			await expect(pool.getModelCatalog("duplicate")).rejects.toThrow(/closed/)
			expect(fetch).not.toHaveBeenCalled()
		} finally {
			await pool.destroy()
		}
	})
})
