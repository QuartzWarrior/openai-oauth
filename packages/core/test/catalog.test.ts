import { afterEach, expect, test, vi } from "vitest"
import { createModelCatalogCache } from "../src/catalog.js"
import {
	createOpenAIOAuthTransport,
	type OpenAIOAuthSession,
} from "../src/runtime.js"

const deferred = <T>() => {
	let resolve!: (value: T) => void
	return {
		promise: new Promise<T>((r) => {
			resolve = r
		}),
		resolve: (value: T) => resolve(value),
	}
}
const jwt = (user: string, plan: string) =>
	`e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_user_id: user, chatgpt_plan_type: plan } })).toString("base64url")}.sig`
const session = (user = "u", plan = "plus"): OpenAIOAuthSession => ({
	accountId: "a",
	accessToken: "private-token",
	idToken: jwt(user, plan),
})
const catalog = (slug = "m", etag = '"v1"') =>
	Response.json(
		{ models: [{ slug, raw_flag: "retained" }] },
		{ headers: { etag } },
	)
const completed = (headers?: HeadersInit, events: object[] = []) =>
	new Response(
		[
			...events,
			{ type: "response.completed", response: { id: "r", output: [] } },
		]
			.map((event) => `data: ${JSON.stringify(event)}\n\n`)
			.join(""),
		{ headers: { "content-type": "text/event-stream", ...headers } },
	)
const init = {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ model: "m", input: "hello", stream: false }),
}
afterEach(() => vi.restoreAllMocks())

test("catalog inspection is network-free until requested and returns defensive snapshots", async () => {
	const auth = vi.fn(async () => session())
	const fetch = vi.fn(async () => catalog())
	const transport = createOpenAIOAuthTransport({
		auth,
		fetch,
		codexVersion: "1.2.3",
	})
	expect(await transport.getModelCatalog({ cacheOnly: true })).toEqual({
		models: [],
		freshness: "missing",
	})
	expect(auth).not.toHaveBeenCalled()
	expect(fetch).not.toHaveBeenCalled()
	const first = await transport.getModelCatalog()
	expect(first).toMatchObject({
		clientVersion: "1.2.3",
		etag: '"v1"',
		freshness: "fresh",
		owner: { accountId: "a", isFedRamp: false },
	})
	const firstModel = first.models[0]
	if (!firstModel) throw new Error("Missing fixture model")
	firstModel.raw.raw_flag = "modified"
	expect(
		(await transport.getModelCatalog({ cacheOnly: true })).models[0]?.raw
			.raw_flag,
	).toBe("retained")
	expect(auth).toHaveBeenCalledOnce()
	expect(JSON.stringify(first)).not.toContain("private-token")
	await expect(
		transport.getModelCatalog({ cacheOnly: true, refresh: true }),
	).rejects.toThrow(/cannot both/)
})

test("same-owner token churn reuses cache while known user, plan and realm changes do not", async () => {
	let auth = session()
	const fetch = vi.fn(async () => catalog())
	const transport = createOpenAIOAuthTransport({
		auth: async () => auth,
		fetch,
		codexVersion: "1.2.3",
	})
	await transport.getModelCatalog()
	auth = { ...auth, accessToken: "rotated" }
	await transport.getModelCatalog()
	expect(fetch).toHaveBeenCalledOnce()
	for (const replacement of [
		session("u2"),
		session("u2", "pro"),
		{ ...session("u2", "pro"), isFedRamp: true },
	]) {
		auth = replacement
		await transport.getModelCatalog()
	}
	expect(fetch).toHaveBeenCalledTimes(4)
})

test("late old-owner loads cannot repopulate a reselected owner", async () => {
	const pending = deferred<Response>()
	let auth = session()
	let calls = 0
	const transport = createOpenAIOAuthTransport({
		auth: async () => auth,
		codexVersion: "1.2.3",
		fetch: async () => (++calls === 1 ? pending.promise : catalog(`m${calls}`)),
	})
	const old = transport.getModelCatalog()
	await vi.waitFor(() => expect(calls).toBe(1))
	auth = { ...session(), accountId: "b" }
	await transport.getModelCatalog()
	auth = session()
	expect((await transport.getModelCatalog()).models[0]?.slug).toBe("m3")
	pending.resolve(catalog("obsolete"))
	expect((await old).models[0]?.slug).toBe("obsolete")
	expect(
		(await transport.getModelCatalog({ cacheOnly: true })).models[0]?.slug,
	).toBe("m3")
})

test.each([
	"success",
	"failure",
])("an older owner's pending catalog %s never dispatches without its mode", async (outcome) => {
	const pending = deferred<Response>()
	let auth = session()
	let aCatalogStarted = false
	const dispatched: Array<{ owner: string | null; lite: string | null }> = []
	const transport = createOpenAIOAuthTransport({
		auth: async () => auth,
		codexVersion: "1.2.3",
		fetch: async (url, request) => {
			const headers = new Headers(request?.headers)
			const owner = headers.get("chatgpt-account-id")
			if (String(url).includes("/models?")) {
				if (owner === "a") {
					aCatalogStarted = true
					return pending.promise
				}
				return catalog("m", '"b"')
			}
			dispatched.push({
				owner,
				lite: headers.get("x-openai-internal-codex-responses-lite"),
			})
			return completed()
		},
	})
	const older = transport.request("responses", init)
	const olderResult = older.then(
		(value) => ({ value }),
		(error) => ({ error }),
	)
	await vi.waitFor(() => expect(aCatalogStarted).toBe(true))
	auth = { ...session(), accountId: "b" }
	await transport.request("responses", init)
	pending.resolve(
		outcome === "success"
			? Response.json({ models: [{ slug: "m", use_responses_lite: true }] })
			: new Response("failed catalog", { status: 503 }),
	)
	const result = await olderResult
	if (outcome === "success") {
		expect("value" in result).toBe(true)
		expect(dispatched).toEqual([
			{ owner: "b", lite: null },
			{ owner: "a", lite: "true" },
		])
	} else {
		expect("error" in result).toBe(true)
		expect(dispatched).toEqual([{ owner: "b", lite: null }])
	}
	expect(
		(await transport.getModelCatalog({ cacheOnly: true })).owner?.accountId,
	).toBe("b")
})

test.each([
	"http",
	"ws",
])("%s ETag signals immediately deduplicate revalidation and renew equal versions", async (kind) => {
	let clock = 1000
	vi.spyOn(Date, "now").mockImplementation(() => clock)
	let calls = 0
	const pending = deferred<Response>()
	let etag = '"v2"'
	const transport = createOpenAIOAuthTransport({
		auth: session(),
		codexVersion: "1.2.3",
		fetch: async (url) => {
			if (String(url).includes("/models?"))
				return ++calls === 1 ? catalog() : pending.promise
			return kind === "http"
				? completed({ "x-models-etag": etag })
				: completed(undefined, [
						{
							type: "codex.response.metadata",
							headers: { "x-models-etag": etag },
						},
					])
		},
	})
	await transport.getModelCatalog()
	await Promise.all(
		Array.from({ length: 4 }, () => transport.request("responses", init)),
	)
	expect(calls).toBe(2)
	pending.resolve(catalog("updated", '"v2"'))
	await vi.waitFor(async () =>
		expect((await transport.getModelCatalog({ cacheOnly: true })).etag).toBe(
			'"v2"',
		),
	)
	clock += 1000
	await transport.request("responses", init)
	const equal = await transport.getModelCatalog({ cacheOnly: true })
	expect(equal.validatedAt).toBe(clock)
	expect(equal.fetchedAt).toBe(1000)
	etag = '"v3"'
	await transport.request("responses", init)
	expect(calls).toBe(2)
})

test("catalog lifetime abort stops ignored authentication and invalid options never fetch", async () => {
	const auth = vi.fn(() => new Promise<OpenAIOAuthSession>(() => {}))
	const lifetime = new AbortController()
	const transport = createOpenAIOAuthTransport({
		auth,
		signal: lifetime.signal,
		codexVersion: "1.2.3",
	})
	await expect(
		transport.getModelCatalog({ mode: "invalid" as never }),
	).rejects.toThrow()
	expect(auth).not.toHaveBeenCalled()
	const pending = transport.getModelCatalog()
	lifetime.abort()
	await expect(pending).rejects.toMatchObject({ name: "AbortError" })
})

test("cache is bounded, client-version scoped and rejects old epoch observations", async () => {
	let calls = 0
	const cache = createModelCatalogCache({
		identity: (a) => a.accountId,
		maxStaleMs: 1000,
		fetch: async (_auth, version) => ({
			models: [{ slug: `m${++calls}`, raw: {} }],
			freshness: "fresh",
			clientVersion: version,
			fetchedAt: Date.now(),
			validatedAt: Date.now(),
			etag: "v1",
		}),
	})
	const old = cache.select(session(), "1")
	await cache.resolve(old)
	await cache.resolve(cache.select(session(), "2"))
	expect(calls).toBe(2)
	cache.observe(old, "different")
	expect(calls).toBe(2)
	for (let i = 0; i < 33; i++)
		await cache.resolve(
			cache.select({ ...session(), accountId: `owner${i}` }, "1"),
		)
	await cache.resolve(cache.select(session(), "1"))
	expect(calls).toBe(36)
})
