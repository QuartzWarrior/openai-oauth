import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { OAuthTokenError } from "@openai-oauth/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	AuthFileChangedError,
	AuthRefreshTimeoutError,
	loadAuthTokens,
	saveAuthInstallationId,
	saveAuthTokens,
} from "../src/auth-file.js"
import { openaiCredentials } from "../src/index.js"

const roots: string[] = []
const now = () => new Date("2025-01-01T00:00:00Z")
const jwt = (claims: Record<string, unknown>) =>
	[
		"e30",
		Buffer.from(JSON.stringify(claims)).toString("base64url"),
		"signature",
	].join(".")
const deferred = <T>() => {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}
const expired = () => ({
	auth_mode: "chatgpt",
	installation_id: "keep-installation",
	custom: { keep: true },
	tokens: {
		access_token: jwt({ exp: 1 }),
		refresh_token: "refresh-a",
		account_id: "acct-a",
		extra: "preserved",
	},
	last_refresh: "2020-01-01T00:00:00Z",
})
const freshResponse = () =>
	new Response(
		JSON.stringify({
			access_token: "fresh-access",
			refresh_token: "fresh-refresh",
		}),
		{ headers: { "content-type": "application/json" } },
	)
const fixture = async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "auth-persistence-"))
	roots.push(root)
	const filePath = path.join(root, "auth.json")
	await fs.writeFile(filePath, JSON.stringify(expired()), { mode: 0o644 })
	return { root, filePath }
}
const token = (accountId: string, accessToken = "signed-in-access") => ({
	accountId,
	accessToken,
	refreshToken: "signed-in-refresh",
	raw: {},
})

afterEach(async () => {
	vi.restoreAllMocks()
	await Promise.all(
		roots
			.splice(0)
			.map((root) => fs.rm(root, { recursive: true, force: true })),
	)
})

describe("auth persistence", () => {
	it.each([
		"ua",
		"fetch",
		"body",
	])("bounds shared refresh stuck in %s, fences late work, and allows retry", async (stage) => {
		const { filePath } = await fixture()
		const before = await fs.readFile(filePath, "utf8")
		const entered = deferred<void>()
		const releaseUA = deferred<string>()
		const releaseFetch = deferred<Response>()
		const cancelled = vi.fn()
		let operationSignal: AbortSignal | undefined
		const userAgent = async (signal?: AbortSignal) => {
			operationSignal = signal
			if (stage === "ua") {
				entered.resolve()
				return releaseUA.promise
			}
			return "test-agent"
		}
		const fetch = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				operationSignal = init?.signal ?? undefined
				entered.resolve()
				if (stage === "fetch") return releaseFetch.promise
				if (stage === "body")
					return new Response(
						new ReadableStream<Uint8Array>({ cancel: cancelled }),
					)
				return freshResponse()
			},
		)
		const first = loadAuthTokens({
			authFilePath: filePath,
			fetch,
			now,
			userAgent,
			refreshTimeoutMs: 80,
		})
		const rejected = expect(first).rejects.toBeInstanceOf(
			AuthRefreshTimeoutError,
		)
		await entered.promise
		await rejected
		expect(operationSignal?.aborted).toBe(true)
		if (stage === "body")
			await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce())
		expect(await fs.readFile(filePath, "utf8")).toBe(before)
		const recovered = await loadAuthTokens({
			authFilePath: filePath,
			fetch: async () => freshResponse(),
			now,
		})
		expect(recovered.accessToken).toBe("fresh-access")
		releaseUA.resolve("late-agent")
		releaseFetch.resolve(
			new Response(
				JSON.stringify({
					access_token: "obsolete-access",
					refresh_token: "obsolete-refresh",
				}),
			),
		)
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(
			JSON.parse(await fs.readFile(filePath, "utf8")).tokens.access_token,
		).toBe("fresh-access")
		if (stage === "ua") expect(fetch).not.toHaveBeenCalled()
	})

	it("shared operation abort differs from one subscriber cancelling", async () => {
		const { filePath } = await fixture()
		const started = deferred<void>()
		const release = deferred<Response>()
		const operation = new AbortController()
		const fetch = vi.fn(async () => {
			started.resolve()
			return release.promise
		})
		const first = loadAuthTokens({
			authFilePath: filePath,
			fetch,
			now,
			refreshSignal: operation.signal,
		})
		const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" })
		await started.promise
		operation.abort()
		await rejected
		await expect(
			loadAuthTokens({
				authFilePath: filePath,
				fetch: async () => freshResponse(),
				now,
			}),
		).resolves.toMatchObject({ accessToken: "fresh-access" })
		release.resolve(new Response(JSON.stringify({ access_token: "late" })))
	})

	it.each([
		0,
		-1,
		Infinity,
		NaN,
		1.5,
		2147483648,
	])("rejects invalid shared refresh deadline %s", async (refreshTimeoutMs) => {
		const { filePath } = await fixture()
		const fetch = vi.fn(async () => freshResponse())
		await expect(
			loadAuthTokens({ authFilePath: filePath, fetch, now, refreshTimeoutMs }),
		).rejects.toThrow("refreshTimeoutMs")
		expect(fetch).not.toHaveBeenCalled()
	})

	it("cancels a token save waiting behind the file lock without poisoning later saves", async () => {
		const { filePath } = await fixture()
		const entered = deferred<void>()
		const release = deferred<void>()
		const rename = fs.rename.bind(fs)
		vi.spyOn(fs, "rename").mockImplementationOnce(async (...args) => {
			entered.resolve()
			await release.promise
			return rename(...args)
		})
		const held = saveAuthInstallationId(filePath, "metadata")
		await entered.promise
		const controller = new AbortController()
		const save = saveAuthTokens({
			authFilePath: filePath,
			token: token("acct-b"),
			signal: controller.signal,
			now,
		})
		const rejected = expect(save).rejects.toMatchObject({ name: "AbortError" })
		controller.abort()
		await rejected
		release.resolve()
		await held
		await saveAuthTokens({
			authFilePath: filePath,
			token: token("acct-a", "later-save"),
			now,
		})
		expect(
			JSON.parse(await fs.readFile(filePath, "utf8")).tokens.access_token,
		).toBe("later-save")
	})

	it("cancels token save during temporary write before rename", async () => {
		const { filePath, root } = await fixture()
		const before = await fs.readFile(filePath, "utf8")
		const controller = new AbortController()
		const open = fs.open.bind(fs)
		vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			const handle = await open(...args)
			if (args[1] === "wx") {
				const write = handle.writeFile.bind(handle)
				vi.spyOn(handle, "writeFile").mockImplementation(
					async (...writeArgs) => {
						await write(...writeArgs)
						controller.abort()
					},
				)
			}
			return handle
		})
		const rename = vi.spyOn(fs, "rename")
		await expect(
			saveAuthTokens({
				authFilePath: filePath,
				token: token("acct-a"),
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ name: "AbortError" })
		expect(rename).not.toHaveBeenCalled()
		expect(await fs.readFile(filePath, "utf8")).toBe(before)
		expect(await fs.readdir(root)).toEqual(["auth.json"])
	})

	it("reports committed save when abort arrives after rename starts", async () => {
		const { filePath } = await fixture()
		const controller = new AbortController()
		const rename = fs.rename.bind(fs)
		vi.spyOn(fs, "rename").mockImplementationOnce(async (...args) => {
			await rename(...args)
			controller.abort()
		})
		const saved = await saveAuthTokens({
			authFilePath: filePath,
			token: token("acct-a", "committed"),
			signal: controller.signal,
		})
		expect(saved.auth.accessToken).toBe("committed")
		expect(
			JSON.parse(await fs.readFile(filePath, "utf8")).tokens.access_token,
		).toBe("committed")
	})

	it("coalesces an expired file across independent credential handles and path aliases", async () => {
		const { filePath } = await fixture()
		const entered = deferred<void>()
		const release = deferred<Response>()
		const fetch = vi.fn(async () => {
			entered.resolve()
			return release.promise
		})
		const first = openaiCredentials({
			authFilePath: filePath,
			fetch,
			now,
		}).getSession()
		await entered.promise
		const second = openaiCredentials({
			authFilePath: path.join(path.dirname(filePath), ".", "auth.json"),
			fetch,
			now,
		}).getSession()
		const others = Array.from({ length: 12 }, () =>
			loadAuthTokens({ authFilePath: filePath, fetch, now }),
		)
		release.resolve(freshResponse())
		const sessions = await Promise.all([first, second, ...others])
		expect(fetch).toHaveBeenCalledTimes(1)
		expect(
			sessions.every((session) => session?.accessToken === "fresh-access"),
		).toBe(true)
		const stored = JSON.parse(await fs.readFile(filePath, "utf8"))
		expect(stored).toMatchObject({
			installation_id: "keep-installation",
			custom: { keep: true },
			tokens: { extra: "preserved", access_token: "fresh-access" },
		})
		expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600)
	})

	it("forwards a lazy User-Agent only when a refresh is needed", async () => {
		const { filePath } = await fixture()
		const userAgent = vi.fn(async () => "application/test-agent")
		const fetch = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				expect(new Headers(init?.headers).get("user-agent")).toBe(
					"application/test-agent",
				)
				return freshResponse()
			},
		)
		const credentials = openaiCredentials({
			authFilePath: filePath,
			fetch,
			userAgent,
			now,
		})
		await credentials.getSession()
		await credentials.getSession()
		expect(fetch).toHaveBeenCalledTimes(1)
		expect(userAgent).toHaveBeenCalledTimes(1)
	})

	it.each([
		"delete",
		"replace",
		"same-owner-login",
	])("does not restore an outdated refresh after %s", async (change) => {
		const { filePath } = await fixture()
		const entered = deferred<void>()
		const release = deferred<Response>()
		const fetch = vi.fn(async () => {
			entered.resolve()
			return release.promise
		})
		const loading = loadAuthTokens({ authFilePath: filePath, fetch, now })
		const rejected =
			expect(loading).rejects.toBeInstanceOf(AuthFileChangedError)
		await entered.promise
		if (change === "delete") await fs.unlink(filePath)
		else
			await saveAuthTokens({
				authFilePath: filePath,
				now,
				token: token(change === "replace" ? "acct-b" : "acct-a"),
			})
		const before = await fs.readFile(filePath, "utf8").catch(() => undefined)
		release.resolve(freshResponse())
		await rejected
		expect(await fs.readFile(filePath, "utf8").catch(() => undefined)).toBe(
			before,
		)
	})

	it("keeps one rotating refresh through a metadata-only save", async () => {
		const { filePath } = await fixture()
		const entered = deferred<void>()
		const release = deferred<Response>()
		const fetch = vi.fn(async () => {
			entered.resolve()
			return release.promise
		})
		const first = loadAuthTokens({ authFilePath: filePath, fetch, now })
		await entered.promise
		await saveAuthInstallationId(filePath, "updated-installation")
		const second = loadAuthTokens({ authFilePath: filePath, fetch, now })
		release.resolve(freshResponse())
		expect((await first).refreshToken).toBe("fresh-refresh")
		expect((await second).refreshToken).toBe("fresh-refresh")
		expect(fetch).toHaveBeenCalledTimes(1)
		expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toMatchObject({
			installation_id: "updated-installation",
			tokens: { refresh_token: "fresh-refresh" },
		})
	})

	it("does not attach malformed credential text to parse errors", async () => {
		const { filePath } = await fixture()
		await fs.writeFile(filePath, '{"access_token":"secret-sentinel", broken')
		const error = await loadAuthTokens({
			authFilePath: filePath,
			fetch: async () => freshResponse(),
		}).catch((error: unknown) => error)
		expect(error).toBeInstanceOf(Error)
		expect(String(error)).not.toContain("secret-sentinel")
		expect((error as Error).cause).toBeUndefined()
	})

	it("rejects owner changes returned by the refresh endpoint without writing", async () => {
		const { filePath } = await fixture()
		const before = await fs.readFile(filePath, "utf8")
		const fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						access_token: "foreign-access",
						id_token: jwt({
							"https://api.openai.com/auth": { chatgpt_account_id: "acct-b" },
						}),
					}),
				),
		)
		await expect(
			loadAuthTokens({ authFilePath: filePath, fetch, now }),
		).rejects.toBeInstanceOf(AuthFileChangedError)
		expect(await fs.readFile(filePath, "utf8")).toBe(before)
	})

	it("serializes token and metadata writes without losing unrelated fields", async () => {
		const { filePath } = await fixture()
		await Promise.all([
			saveAuthTokens({ authFilePath: filePath, token: token("acct-a"), now }),
			saveAuthInstallationId(filePath, "updated-installation"),
		])
		const stored = JSON.parse(await fs.readFile(filePath, "utf8"))
		expect(stored).toMatchObject({
			installation_id: "updated-installation",
			custom: { keep: true },
			tokens: {
				account_id: "acct-a",
				access_token: "signed-in-access",
				extra: "preserved",
			},
		})
	})

	it("atomic replacement leaves the old file intact until rename and cleans failed writes", async () => {
		const { filePath, root } = await fixture()
		const before = await fs.readFile(filePath, "utf8")
		const rename = vi
			.spyOn(fs, "rename")
			.mockImplementationOnce(async (from, to) => {
				expect(String(to)).toBe(filePath)
				expect(path.dirname(String(from))).toBe(root)
				expect((await fs.stat(from)).mode & 0o777).toBe(0o600)
				expect(await fs.readFile(filePath, "utf8")).toBe(before)
				JSON.parse(await fs.readFile(from, "utf8"))
				throw Object.assign(new Error("rename failed"), { code: "EIO" })
			})
		await expect(
			saveAuthInstallationId(filePath, "new-installation"),
		).rejects.toThrow("rename failed")
		expect(await fs.readFile(filePath, "utf8")).toBe(before)
		expect(await fs.readdir(root)).toEqual(["auth.json"])
		rename.mockRestore()
		await saveAuthInstallationId(filePath, "retry-installation")
		expect(
			JSON.parse(await fs.readFile(filePath, "utf8")).installation_id,
		).toBe("retry-installation")
	})

	it.each([
		{ status: 400, retryable: false },
		{ status: 503, retryable: true },
	])("surfaces typed OAuth errors ($status) without deleting credentials and permits retry", async ({
		status,
		retryable,
	}) => {
		const { filePath } = await fixture()
		const before = await fs.readFile(filePath, "utf8")
		const fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						error: "invalid_grant",
						error_description: "private token secret",
					}),
					{ status },
				),
		)
		const result = await loadAuthTokens({
			authFilePath: filePath,
			fetch,
			now,
		}).catch((error: unknown) => error)
		expect(result).toBeInstanceOf(OAuthTokenError)
		expect(result).toMatchObject({ status, retryable })
		expect(String(result)).not.toContain("private token secret")
		expect(await fs.readFile(filePath, "utf8")).toBe(before)
		const recovered = await loadAuthTokens({
			authFilePath: filePath,
			fetch: async () => freshResponse(),
			now,
		})
		expect(recovered.accessToken).toBe("fresh-access")
	})

	it("coalesces symbolic aliases and keeps the alias intact during replacement", async () => {
		const { filePath, root } = await fixture()
		const alias = path.join(root, "alias.json")
		await fs.symlink(filePath, alias)
		const entered = deferred<void>()
		const release = deferred<Response>()
		const fetch = vi.fn(async () => {
			entered.resolve()
			return release.promise
		})
		const first = loadAuthTokens({ authFilePath: filePath, fetch, now })
		await entered.promise
		const second = loadAuthTokens({ authFilePath: alias, fetch, now })
		release.resolve(freshResponse())
		expect((await first).accessToken).toBe("fresh-access")
		expect((await second).sourcePath).toBe(alias)
		expect(fetch).toHaveBeenCalledTimes(1)
		expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true)
	})

	it("rejects a removed and recreated identical snapshot", async () => {
		const { filePath } = await fixture()
		const entered = deferred<void>()
		const release = deferred<Response>()
		const first = loadAuthTokens({
			authFilePath: filePath,
			now,
			fetch: async () => {
				entered.resolve()
				return release.promise
			},
		})
		const rejected = expect(first).rejects.toBeInstanceOf(AuthFileChangedError)
		await entered.promise
		const contents = await fs.readFile(filePath, "utf8")
		await fs.unlink(filePath)
		await fs.writeFile(filePath, contents)
		release.resolve(freshResponse())
		await rejected
		expect(await fs.readFile(filePath, "utf8")).toBe(contents)
	})

	it("uses CODEX_HOME without touching ambient credentials", async () => {
		const { filePath, root } = await fixture()
		vi.stubEnv("CODEX_HOME", root)
		try {
			const result = await loadAuthTokens({
				fetch: async () => freshResponse(),
				now,
			})
			expect(result.sourcePath).toBe(filePath)
			expect(result.accountId).toBe("acct-a")
		} finally {
			vi.unstubAllEnvs()
		}
	})

	it("one caller abort does not cancel another caller's coalesced refresh", async () => {
		const { filePath } = await fixture()
		const entered = deferred<void>()
		const release = deferred<Response>()
		const fetch = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				expect(init?.signal).toBeInstanceOf(AbortSignal)
				expect(init?.signal?.aborted).toBe(false)
				entered.resolve()
				return release.promise
			},
		)
		const controller = new AbortController()
		const first = loadAuthTokens({
			authFilePath: filePath,
			fetch,
			now,
			signal: controller.signal,
		})
		const aborted = expect(first).rejects.toMatchObject({ name: "AbortError" })
		await entered.promise
		const second = loadAuthTokens({ authFilePath: filePath, fetch, now })
		controller.abort()
		await aborted
		release.resolve(freshResponse())
		expect((await second).accessToken).toBe("fresh-access")
		expect(fetch).toHaveBeenCalledTimes(1)
	})
})
