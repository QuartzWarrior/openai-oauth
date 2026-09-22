import { createHash, randomUUID } from "node:crypto"
import { type BigIntStats, constants, promises as fs } from "node:fs"
import type { FileHandle } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const MAX_CONFIG_BYTES = 1024 * 1024
const commitTails = new Map<string, Promise<void>>()
type JsonRecord = Record<string, unknown>
type Snapshot = { data: JsonRecord; version: string } | undefined

export class PoolConfigChangedError extends Error {
	constructor() {
		super(
			"Pool configuration changed during login; no proxy update was written.",
		)
		this.name = "PoolConfigChangedError"
	}
}

const isRecord = (value: unknown): value is JsonRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value)
const hasCode = (error: unknown, code: string): boolean =>
	isRecord(error) && error.code === code
const nonempty = (value: unknown): value is string =>
	typeof value === "string" && value.trim().length > 0
const absolutePath = (value: string): string => {
	if (!nonempty(value) || value.includes("\0"))
		throw new Error("A non-empty local file path is required.")
	return path.resolve(
		value === "~"
			? os.homedir()
			: value.startsWith("~/")
				? path.join(os.homedir(), value.slice(2))
				: value,
	)
}

// Resolve existing parent aliases even when login has not created the auth file.
const canonicalPath = async (filePath: string): Promise<string> => {
	try {
		return await fs.realpath(filePath)
	} catch (error) {
		if (!hasCode(error, "ENOENT"))
			throw new Error("Could not resolve a local file path.")
		const parent = path.dirname(filePath)
		if (parent === filePath)
			throw new Error("Could not resolve a local file path.")
		return path.join(await canonicalPath(parent), path.basename(filePath))
	}
}
const fingerprint = (stat: BigIntStats): string =>
	`${stat.dev}:${stat.ino}:${stat.ctimeNs}:${stat.mtimeNs}:${stat.size}:${stat.mode}`
const metadata = async (filePath: string): Promise<BigIntStats | undefined> => {
	try {
		return await fs.stat(filePath, { bigint: true })
	} catch (error) {
		if (hasCode(error, "ENOENT")) return undefined
		throw new Error("Could not inspect the account credential path.")
	}
}

const readSnapshot = async (
	filePath: string,
	authPath: string,
): Promise<Snapshot> => {
	let stat: BigIntStats
	try {
		stat = await fs.lstat(filePath, { bigint: true })
	} catch (error) {
		if (hasCode(error, "ENOENT")) return undefined
		throw new Error("Could not inspect the pool configuration file.")
	}
	if (!stat.isFile() || stat.isSymbolicLink())
		throw new Error(
			"Pool configuration must be a regular file, not a symbolic link.",
		)
	if (process.platform !== "win32" && (stat.mode & 0o177n) !== 0n)
		throw new Error(
			"Pool configuration must be private; set its permissions to 600.",
		)
	const authStat = await metadata(authPath)
	if (authStat?.dev === stat.dev && authStat.ino === stat.ino)
		throw new Error(
			"Pool configuration and account credentials must be different files.",
		)
	if (stat.size > BigInt(MAX_CONFIG_BYTES))
		throw new Error("Pool configuration exceeds the 1 MiB size limit.")
	let content: string
	let version: string
	try {
		const handle = await fs.open(
			filePath,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
		)
		try {
			const before = await handle.stat({ bigint: true })
			if (fingerprint(stat) !== fingerprint(before))
				throw new PoolConfigChangedError()
			const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1)
			let length = 0
			while (length < buffer.length) {
				const { bytesRead } = await handle.read(
					buffer,
					length,
					buffer.length - length,
					null,
				)
				if (bytesRead === 0) break
				length += bytesRead
			}
			if (length > MAX_CONFIG_BYTES)
				throw new Error("Pool configuration exceeds the 1 MiB size limit.")
			const after = await handle.stat({ bigint: true })
			if (fingerprint(before) !== fingerprint(after))
				throw new PoolConfigChangedError()
			content = buffer.subarray(0, length).toString("utf8")
			version = `${fingerprint(after)}:${createHash("sha256").update(buffer.subarray(0, length)).digest("hex")}`
		} finally {
			await handle.close()
		}
	} catch (error) {
		if (error instanceof PoolConfigChangedError) throw error
		throw new Error("Could not safely read the pool configuration file.")
	}
	let data: unknown
	try {
		data = JSON.parse(content)
	} catch {
		throw new Error("Pool configuration must contain valid JSON.")
	}
	if (!isRecord(data) || !Array.isArray(data.accounts))
		throw new Error("Pool configuration must contain an accounts array.")
	return { data, version }
}

const throwIfAborted = (signal?: AbortSignal): void => {
	if (signal?.aborted)
		throw new DOMException("Pool configuration update cancelled.", "AbortError")
}

const withCommitLock = async (
	key: string,
	operation: () => Promise<void>,
): Promise<void> => {
	const previous = commitTails.get(key) ?? Promise.resolve()
	const next = previous.then(operation)
	const tail = next.then(
		() => undefined,
		() => undefined,
	)
	commitTails.set(key, tail)
	try {
		await next
	} finally {
		if (commitTails.get(key) === tail) commitTails.delete(key)
	}
}

export type PreparePoolProxyUpdateOptions = {
	authFilePath: string
	proxy: string
	poolConfigPath?: string
}

/** Preflight is read-only; commit after login succeeds and always dispose in finally. */
export const preparePoolProxyUpdate = async (
	options: PreparePoolProxyUpdateOptions,
): Promise<{
	path: string
	commit: (signal?: AbortSignal) => Promise<void>
	dispose: () => Promise<void>
}> => {
	const authPath = absolutePath(options.authFilePath)
	const xdg = process.env.XDG_CONFIG_HOME
	const configHome =
		nonempty(xdg) && path.isAbsolute(xdg)
			? xdg
			: path.join(os.homedir(), ".config")
	const configPath = absolutePath(
		options.poolConfigPath ??
			path.join(configHome, "openai-oauth", "pool.json"),
	)
	const [authIdentity, configIdentity] = await Promise.all([
		canonicalPath(authPath),
		canonicalPath(configPath),
	])
	if (authIdentity === configIdentity)
		throw new Error(
			"Pool configuration and account credentials must be different files.",
		)
	try {
		const proxy = new URL(options.proxy)
		if (!["http:", "https:"].includes(proxy.protocol) || !proxy.hostname)
			throw new Error()
	} catch {
		throw new Error("A valid HTTP(S) proxy URL is required.")
	}
	const snapshot = await readSnapshot(configPath, authPath)
	const data = snapshot?.data ?? {
		host: "127.0.0.1",
		port: 10531,
		accounts: [],
	}
	const accounts = data.accounts as unknown[]
	const names = new Set<string>()
	let matched: JsonRecord | undefined
	for (const account of accounts) {
		if (
			!isRecord(account) ||
			!nonempty(account.name) ||
			!nonempty(account.authFilePath)
		)
			throw new Error(
				"Each pool account must have a name and credential file path.",
			)
		if (names.has(account.name))
			throw new Error("Pool account names must be unique.")
		names.add(account.name)
		for (const key of ["proxy", "proxyEnv"]) {
			if (account[key] !== undefined && !nonempty(account[key]))
				throw new Error(
					"Pool account proxy settings must be non-empty strings.",
				)
		}
		if (
			(await canonicalPath(absolutePath(account.authFilePath))) === authIdentity
		) {
			if (matched)
				throw new Error(
					"Multiple pool accounts match the credential file path.",
				)
			matched = account
		}
	}
	if (matched) {
		matched.proxy = options.proxy
		delete matched.proxyEnv
	} else {
		const baseName =
			path.basename(authPath).replace(/\.json$/i, "") || "account"
		let name = baseName
		for (let suffix = 2; names.has(name); suffix++)
			name = `${baseName}-${suffix}`
		accounts.push({ name, authFilePath: authPath, proxy: options.proxy })
	}
	const serialized = `${JSON.stringify(data, null, 2)}\n`
	if (Buffer.byteLength(serialized) > MAX_CONFIG_BYTES)
		throw new Error("Updated pool configuration exceeds the 1 MiB size limit.")
	let lease: FileHandle | undefined
	if (snapshot) {
		try {
			lease = await fs.open(
				configPath,
				constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
			)
			const leaseStat = await lease.stat({ bigint: true })
			if (
				leaseStat.nlink === 0n ||
				!snapshot.version.startsWith(`${fingerprint(leaseStat)}:`)
			)
				throw new PoolConfigChangedError()
		} catch {
			await lease?.close().catch(() => undefined)
			throw new PoolConfigChangedError()
		}
	}
	let attempted = false
	let disposed = false
	const dispose = async () => {
		if (disposed) return
		disposed = true
		await lease?.close()
	}
	return {
		path: configPath,
		dispose,
		commit: async (signal) => {
			if (attempted || disposed)
				throw new Error(
					"This pool configuration update has already been attempted or disposed.",
				)
			attempted = true
			try {
				throwIfAborted(signal)
				await withCommitLock(configIdentity, async () => {
					throwIfAborted(signal)
					const assertUnchanged = async () => {
						try {
							if (lease) {
								const leaseStat = await lease.stat({ bigint: true })
								if (
									leaseStat.nlink === 0n ||
									!snapshot?.version.startsWith(`${fingerprint(leaseStat)}:`)
								)
									throw new PoolConfigChangedError()
							}
							if (
								(await canonicalPath(authPath)) !== authIdentity ||
								(await canonicalPath(configPath)) !== configIdentity
							)
								throw new PoolConfigChangedError()
							if (
								(await readSnapshot(configPath, authPath))?.version !==
								snapshot?.version
							)
								throw new PoolConfigChangedError()
						} catch {
							throw new PoolConfigChangedError()
						}
					}
					await assertUnchanged()
					throwIfAborted(signal)
					const temporaryPath = path.join(
						path.dirname(configPath),
						`.${path.basename(configPath)}.${randomUUID()}.tmp`,
					)
					try {
						await fs.mkdir(path.dirname(configPath), {
							recursive: true,
							mode: 0o700,
						})
						throwIfAborted(signal)
						const handle = await fs.open(temporaryPath, "wx", 0o600)
						try {
							throwIfAborted(signal)
							await handle.writeFile(serialized, "utf8")
							throwIfAborted(signal)
							await handle.sync()
							throwIfAborted(signal)
						} finally {
							await handle.close()
						}
						throwIfAborted(signal)
						await assertUnchanged()
						throwIfAborted(signal)
						// Rename is the irreversible commit boundary: cancellation after the
						// syscall starts cannot imply rollback. Process-local serialization
						// and stale checks are not distributed compare-and-swap.
						await fs.rename(temporaryPath, configPath)
					} catch (error) {
						throwIfAborted(signal)
						if (error instanceof PoolConfigChangedError) throw error
						throw new Error(
							"Could not save the account proxy to the pool configuration.",
						)
					} finally {
						await fs.unlink(temporaryPath).catch(() => undefined)
					}
				})
			} finally {
				await dispose()
			}
		},
	}
}
