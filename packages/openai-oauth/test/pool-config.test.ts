import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import {
	PoolConfigChangedError,
	preparePoolProxyUpdate,
} from "../src/pool-config.js"

const roots: string[] = []
const proxy = "http://test-user:test-password@proxy.example:8080"
const fixture = async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pool-config-test-"))
	roots.push(root)
	return {
		root,
		config: path.join(root, "pool.json"),
		auth: path.join(root, "account.json"),
	}
}
const save = async (filePath: string, value: unknown) =>
	fs.writeFile(filePath, JSON.stringify(value), { mode: 0o600 })
const read = async (filePath: string) =>
	JSON.parse(await fs.readFile(filePath, "utf8"))

afterEach(async () => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	await Promise.all(
		roots
			.splice(0)
			.map((root) => fs.rm(root, { recursive: true, force: true })),
	)
})

describe("pool proxy config update", () => {
	test("preflight is read-only and commit changes only the matching proxy fields", async () => {
		const { root, config, auth } = await fixture()
		const other = {
			name: "other",
			authFilePath: path.join(root, "other.json"),
			proxyEnv: "OTHER_PROXY",
			weight: 3,
		}
		const original = {
			host: "127.0.0.1",
			port: 7777,
			custom: { keep: true },
			accounts: [
				{
					name: "target",
					authFilePath: auth,
					proxyEnv: "OLD_PROXY",
					transport: "http",
					custom: [1, 2],
				},
				other,
			],
		}
		await save(config, original)
		const before = await fs.readFile(config, "utf8")
		const update = await preparePoolProxyUpdate({
			authFilePath: auth,
			proxy,
			poolConfigPath: config,
		})
		expect(update.path).toBe(config)
		expect(await fs.readFile(config, "utf8")).toBe(before)
		await update.commit()
		expect(await read(config)).toEqual({
			...original,
			accounts: [
				{
					name: "target",
					authFilePath: auth,
					proxy,
					transport: "http",
					custom: [1, 2],
				},
				other,
			],
		})
		expect((await fs.stat(config)).mode & 0o777).toBe(0o600)
		expect(await fs.readdir(root)).toEqual(["pool.json"])
	})

	test("creates a missing private config only at commit", async () => {
		const { root, auth } = await fixture()
		const config = path.join(root, "private", "openai-oauth", "pool.json")
		const update = await preparePoolProxyUpdate({
			authFilePath: auth,
			proxy,
			poolConfigPath: config,
		})
		await expect(fs.stat(path.dirname(config))).rejects.toMatchObject({
			code: "ENOENT",
		})
		await update.commit()
		expect(await read(config)).toEqual({
			host: "127.0.0.1",
			port: 10531,
			accounts: [{ name: "account", authFilePath: auth, proxy }],
		})
		expect((await fs.stat(config)).mode & 0o777).toBe(0o600)
		expect((await fs.stat(path.dirname(config))).mode & 0o777).toBe(0o700)
	})

	test("appends an account with a unique stable name and preserves other properties", async () => {
		const { root, config, auth } = await fixture()
		const original = {
			accessTokenEnv: "API_TOKEN",
			accounts: [
				{ name: "account", authFilePath: path.join(root, "first.json") },
				{ name: "account-2", authFilePath: path.join(root, "second.json") },
			],
		}
		await save(config, original)
		await (
			await preparePoolProxyUpdate({
				authFilePath: auth,
				proxy,
				poolConfigPath: config,
			})
		).commit()
		expect(await read(config)).toEqual({
			...original,
			accounts: [
				...original.accounts,
				{ name: "account-3", authFilePath: auth, proxy },
			],
		})
	})

	test("matches a normalized or realpath credential alias without reading credentials", async () => {
		const { root, config, auth } = await fixture()
		await fs.writeFile(auth, "not-json-credential-contents-never-read", {
			mode: 0o600,
		})
		const alias = path.join(root, "alias.json")
		await fs.symlink(auth, alias)
		await save(config, {
			accounts: [
				{ name: "match", authFilePath: alias, proxy: "https://old.example" },
			],
		})
		await (
			await preparePoolProxyUpdate({
				authFilePath: `${root}/./account.json`,
				proxy,
				poolConfigPath: config,
			})
		).commit()
		expect((await read(config)).accounts).toEqual([
			{ name: "match", authFilePath: alias, proxy },
		])
		expect(await fs.readFile(auth, "utf8")).toBe(
			"not-json-credential-contents-never-read",
		)
	})

	test("uses absolute XDG_CONFIG_HOME and expands tilde credential paths", async () => {
		const { root } = await fixture()
		vi.spyOn(os, "homedir").mockReturnValue(root)
		vi.stubEnv("XDG_CONFIG_HOME", path.join(root, "xdg"))
		const update = await preparePoolProxyUpdate({
			authFilePath: "~/auth.json",
			proxy,
		})
		expect(update.path).toBe(
			path.join(root, "xdg", "openai-oauth", "pool.json"),
		)
		await update.commit()
		expect((await read(update.path)).accounts[0].authFilePath).toBe(
			path.join(root, "auth.json"),
		)
	})

	test.each([
		"",
		"relative/config",
	])("ignores nonabsolute XDG_CONFIG_HOME %s", async (xdg) => {
		const { root, auth } = await fixture()
		vi.spyOn(os, "homedir").mockReturnValue(root)
		vi.stubEnv("XDG_CONFIG_HOME", xdg)
		const update = await preparePoolProxyUpdate({ authFilePath: auth, proxy })
		expect(update.path).toBe(
			path.join(root, ".config", "openai-oauth", "pool.json"),
		)
		await expect(fs.stat(update.path)).rejects.toMatchObject({ code: "ENOENT" })
	})

	test("expands an explicit tilde config path", async () => {
		const { root, auth } = await fixture()
		vi.spyOn(os, "homedir").mockReturnValue(root)
		const update = await preparePoolProxyUpdate({
			authFilePath: auth,
			proxy,
			poolConfigPath: "~/pool.json",
		})
		expect(update.path).toBe(path.join(root, "pool.json"))
	})

	test("rejects duplicate matching auth paths", async () => {
		const { root, config, auth } = await fixture()
		await save(config, {
			accounts: [
				{ name: "a", authFilePath: auth },
				{ name: "b", authFilePath: `${root}/./account.json` },
			],
		})
		await expect(
			preparePoolProxyUpdate({
				authFilePath: auth,
				proxy,
				poolConfigPath: config,
			}),
		).rejects.toThrow(/Multiple pool accounts match/)
	})

	test.each([
		null,
		[],
		{},
		{ accounts: {} },
		{ accounts: [null] },
		{ accounts: [{ name: "a" }] },
		{
			accounts: [
				{ name: "a", authFilePath: "a" },
				{ name: "a", authFilePath: "b" },
			],
		},
	])("rejects malformed config structure %#", async (data) => {
		const { config, auth } = await fixture()
		await save(config, data)
		const before = await fs.readFile(config, "utf8")
		await expect(
			preparePoolProxyUpdate({
				authFilePath: auth,
				proxy,
				poolConfigPath: config,
			}),
		).rejects.toThrow()
		expect(await fs.readFile(config, "utf8")).toBe(before)
	})

	test("does not disclose malformed config or proxy secrets through errors", async () => {
		const { config, auth } = await fixture()
		await fs.writeFile(config, "private-config-secret-invalid-json", {
			mode: 0o600,
		})
		const error = await preparePoolProxyUpdate({
			authFilePath: auth,
			proxy,
			poolConfigPath: config,
		}).catch((value: unknown) => value)
		expect(error).toBeInstanceOf(Error)
		expect(String(error)).not.toMatch(/private-config-secret|test-password/)
		expect(error).not.toHaveProperty("cause")
		await expect(
			preparePoolProxyUpdate({
				authFilePath: auth,
				proxy: "http://secret-password@",
				poolConfigPath: config,
			}),
		).rejects.toThrow("A valid HTTP(S) proxy URL is required.")
	})

	test("rejects symlink and nonprivate configs without modifying their targets", async () => {
		const { root, config, auth } = await fixture()
		const target = path.join(root, "target.json")
		await save(target, { accounts: [] })
		await fs.symlink(target, config)
		await expect(
			preparePoolProxyUpdate({
				authFilePath: auth,
				proxy,
				poolConfigPath: config,
			}),
		).rejects.toThrow(/regular file/)
		await fs.unlink(config)
		await save(config, { accounts: [] })
		await fs.chmod(config, 0o644)
		await expect(
			preparePoolProxyUpdate({
				authFilePath: auth,
				proxy,
				poolConfigPath: config,
			}),
		).rejects.toThrow(/private/)
		expect(await read(target)).toEqual({ accounts: [] })
	})

	test("rejects config and credential paths identifying the same file or hardlink", async () => {
		const { config, auth } = await fixture()
		await save(config, { accounts: [] })
		await expect(
			preparePoolProxyUpdate({
				authFilePath: config,
				proxy,
				poolConfigPath: config,
			}),
		).rejects.toThrow(/different files/)
		await fs.link(config, auth)
		await expect(
			preparePoolProxyUpdate({
				authFilePath: auth,
				proxy,
				poolConfigPath: config,
			}),
		).rejects.toThrow(/different files/)
	})

	test("bounds existing and updated config bytes", async () => {
		const { config, auth } = await fixture()
		await fs.writeFile(config, " ".repeat(1024 * 1024 + 1), { mode: 0o600 })
		await expect(
			preparePoolProxyUpdate({
				authFilePath: auth,
				proxy,
				poolConfigPath: config,
			}),
		).rejects.toThrow(/size limit/)
		await save(config, { accounts: [] })
		await expect(
			preparePoolProxyUpdate({
				authFilePath: auth,
				proxy: `http://proxy.example/${"x".repeat(1024 * 1024)}`,
				poolConfigPath: config,
			}),
		).rejects.toThrow(/size limit/)
	})

	test.each([
		"edit",
		"delete",
		"replace",
		"symlink",
	])("rejects config %s since preflight without overwriting it", async (change) => {
		const { root, config, auth } = await fixture()
		await save(config, { accounts: [] })
		const update = await preparePoolProxyUpdate({
			authFilePath: auth,
			proxy,
			poolConfigPath: config,
		})
		if (change === "edit") await save(config, { accounts: [], newer: true })
		if (change === "delete") await fs.unlink(config)
		if (change === "replace") {
			await fs.unlink(config)
			await save(config, { accounts: [] })
		}
		if (change === "symlink") {
			const target = path.join(root, "new.json")
			await save(target, { accounts: [] })
			await fs.unlink(config)
			await fs.symlink(target, config)
		}
		const before = await fs.readFile(config, "utf8").catch(() => undefined)
		await expect(update.commit()).rejects.toBeInstanceOf(PoolConfigChangedError)
		expect(await fs.readFile(config, "utf8").catch(() => undefined)).toBe(
			before,
		)
		expect(
			(await fs.readdir(root)).some((entry) => entry.endsWith(".tmp")),
		).toBe(false)
	})

	test("rejects a new config appearing after a missing-file preflight", async () => {
		const { config, auth } = await fixture()
		const update = await preparePoolProxyUpdate({
			authFilePath: auth,
			proxy,
			poolConfigPath: config,
		})
		await save(config, { accounts: [], newer: true })
		await expect(update.commit()).rejects.toBeInstanceOf(PoolConfigChangedError)
		expect((await read(config)).newer).toBe(true)
	})

	test("serializes racing commits and refuses stale snapshots and repeat commits", async () => {
		const { config, auth } = await fixture()
		await save(config, { accounts: [] })
		const updates = await Promise.all(
			[1, 2].map((index) =>
				preparePoolProxyUpdate({
					authFilePath: auth,
					proxy: `http://proxy-${index}.example`,
					poolConfigPath: config,
				}),
			),
		)
		const results = await Promise.all(
			updates.map((update) =>
				update.commit().then(
					() => "saved",
					(error: unknown) => error,
				),
			),
		)
		expect(results.filter((result) => result === "saved")).toHaveLength(1)
		expect(
			results.filter((result) => result instanceof PoolConfigChangedError),
		).toHaveLength(1)
		await expect(updates[0]?.commit()).rejects.toThrow(/already been attempted/)
	})

	test("rejects changed credential alias after preflight", async () => {
		const { root, config, auth } = await fixture()
		const original = path.join(root, "original.json")
		const replacement = path.join(root, "replacement.json")
		await fs.writeFile(original, "credentials", { mode: 0o600 })
		await fs.writeFile(replacement, "different", { mode: 0o600 })
		await fs.symlink(original, auth)
		await save(config, { accounts: [] })
		const update = await preparePoolProxyUpdate({
			authFilePath: auth,
			proxy,
			poolConfigPath: config,
		})
		await fs.unlink(auth)
		await fs.symlink(replacement, auth)
		await expect(update.commit()).rejects.toBeInstanceOf(PoolConfigChangedError)
		expect(await read(config)).toEqual({ accounts: [] })
	})

	test("dispose closes a read-only preflight without updating config", async () => {
		const { config, auth } = await fixture()
		await save(config, { accounts: [] })
		const update = await preparePoolProxyUpdate({
			authFilePath: auth,
			proxy,
			poolConfigPath: config,
		})
		await update.dispose()
		await update.dispose()
		await expect(update.commit()).rejects.toThrow(/disposed/)
		expect(await read(config)).toEqual({ accounts: [] })
	})

	test("pre-aborted commit leaves the existing config unchanged", async () => {
		const { config, auth } = await fixture()
		await save(config, { accounts: [] })
		const update = await preparePoolProxyUpdate({
			authFilePath: auth,
			proxy,
			poolConfigPath: config,
		})
		await expect(update.commit(AbortSignal.abort())).rejects.toMatchObject({
			name: "AbortError",
		})
		expect(await read(config)).toEqual({ accounts: [] })
	})

	test("abort during temporary write cancels before rename and cleans up", async () => {
		const { root, config, auth } = await fixture()
		await save(config, { accounts: [] })
		const before = await fs.readFile(config, "utf8")
		const update = await preparePoolProxyUpdate({
			authFilePath: auth,
			proxy,
			poolConfigPath: config,
		})
		const controller = new AbortController()
		const originalOpen = fs.open.bind(fs)
		vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			const handle = await originalOpen(...args)
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
		await expect(update.commit(controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		})
		expect(rename).not.toHaveBeenCalled()
		expect(await fs.readFile(config, "utf8")).toBe(before)
		expect(await fs.readdir(root)).toEqual(["pool.json"])
	})

	test("cleans up temporary output on rename failure and preserves the config", async () => {
		const { root, config, auth } = await fixture()
		await save(config, { accounts: [] })
		const update = await preparePoolProxyUpdate({
			authFilePath: auth,
			proxy,
			poolConfigPath: config,
		})
		vi.spyOn(fs, "rename").mockRejectedValue(
			new Error("secret filesystem error"),
		)
		await expect(update.commit()).rejects.toThrow(
			"Could not save the account proxy to the pool configuration.",
		)
		expect(await read(config)).toEqual({ accounts: [] })
		expect(await fs.readdir(root)).toEqual(["pool.json"])
	})
})
