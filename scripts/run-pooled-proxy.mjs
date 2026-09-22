#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { createOpenAIPool } from "@openai-oauth/pool"
import { startOpenAIOAuthServer } from "openai-oauth"

const usage = `Usage: bun run pool:serve -- --config <path> [--allow-network] [--diagnostics]

Starts one OpenAI-compatible HTTP API backed by a pool of isolated ChatGPT
accounts. Each account has its own auth file and optional outbound proxy.

Options:
  --config <path>    Private JSON configuration file (required).
  --allow-network    Permit a non-loopback host from the configuration.
  --diagnostics      Enable pool diagnostics using the existing API authorization.
  --help             Show this message.
`

const isObject = (value) =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const isLoopbackHost = (host) =>
	host === "127.0.0.1" || host === "::1" || host === "localhost"

const readString = (value, field, optional = false) => {
	if (value === undefined && optional) return undefined
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${field} must be a non-empty string.`)
	}
	return value
}

const readBoolean = (value, field) => {
	if (value === undefined) return undefined
	if (typeof value !== "boolean") {
		throw new Error(`${field} must be true or false.`)
	}
	return value
}

const readHealthRefreshMs = (value) => {
	if (value === undefined) return undefined
	if (value === true) return true
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value <= 0
	) {
		throw new Error("healthRefreshMs must be true or a positive integer.")
	}
	return value
}

const readPort = (value) => {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 1 ||
		value > 65_535
	) {
		throw new Error("port must be an integer between 1 and 65535.")
	}
	return value
}

const readModels = (value) => {
	if (value === undefined) return undefined
	if (
		!Array.isArray(value) ||
		value.some((model) => typeof model !== "string" || !model.trim())
	) {
		throw new Error("models must be an array of non-empty model ids.")
	}
	return [...new Set(value)]
}

const parseArguments = (argv) => {
	const parsed = {
		allowNetwork: false,
		configPath: undefined,
		diagnostics: false,
		help: false,
	}
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index]
		if (argument === "--help" || argument === "-h") {
			parsed.help = true
			continue
		}
		if (argument === "--allow-network") {
			parsed.allowNetwork = true
			continue
		}
		if (argument === "--diagnostics") {
			parsed.diagnostics = true
			continue
		}
		if (argument === "--config") {
			const configPath = argv[index + 1]
			if (!configPath || configPath.startsWith("-")) {
				throw new Error("--config requires a file path.")
			}
			parsed.configPath = path.resolve(configPath)
			index += 1
			continue
		}
		throw new Error(`Unknown option: ${argument}`)
	}
	return parsed
}

const requirePrivateFile = async (filePath, label) => {
	let details
	try {
		details = await stat(filePath)
	} catch {
		throw new Error(`${label} was not found: ${filePath}`)
	}
	if (!details.isFile()) {
		throw new Error(`${label} must be a regular file: ${filePath}`)
	}
	if ((details.mode & 0o077) !== 0) {
		throw new Error(
			`Refusing to read ${label}: run chmod 600 ${filePath} first.`,
		)
	}
}

const resolveProxy = (account, accountName) => {
	const direct = readString(
		account.proxy,
		`accounts[${accountName}].proxy`,
		true,
	)
	const environmentName = readString(
		account.proxyEnv,
		`accounts[${accountName}].proxyEnv`,
		true,
	)
	if (direct && environmentName) {
		throw new Error(
			`accounts[${accountName}] may set proxy or proxyEnv, but not both.`,
		)
	}
	if (!environmentName) return direct
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(environmentName)) {
		throw new Error(
			`accounts[${accountName}].proxyEnv is not a valid environment variable name.`,
		)
	}
	const proxy = process.env[environmentName]
	if (!proxy) {
		throw new Error(
			`accounts[${accountName}] requires the ${environmentName} environment variable.`,
		)
	}
	return proxy
}

const readAccount = async (value, index) => {
	if (!isObject(value)) {
		throw new Error(`accounts[${index}] must be an object.`)
	}
	const name = readString(value.name, `accounts[${index}].name`)
	const authFilePath = readString(
		value.authFilePath,
		`accounts[${name}].authFilePath`,
	)
	if (!path.isAbsolute(authFilePath)) {
		throw new Error(`accounts[${name}].authFilePath must be an absolute path.`)
	}
	await requirePrivateFile(authFilePath, `accounts[${name}] auth file`)

	const transport = readString(
		value.transport,
		`accounts[${name}].transport`,
		true,
	)
	if (
		transport !== undefined &&
		transport !== "http" &&
		transport !== "websocket"
	) {
		throw new Error(
			`accounts[${name}].transport must be "http" or "websocket".`,
		)
	}
	if (
		value.weight !== undefined &&
		(typeof value.weight !== "number" ||
			!Number.isFinite(value.weight) ||
			value.weight <= 0)
	) {
		throw new Error(`accounts[${name}].weight must be a positive number.`)
	}

	return {
		name,
		authFilePath,
		proxy: resolveProxy(value, name),
		transport,
		weight: value.weight,
	}
}

const parseConfig = async (configPath) => {
	await requirePrivateFile(configPath, "configuration file")
	let parsed
	try {
		parsed = JSON.parse(await readFile(configPath, "utf8"))
	} catch {
		// JSON parser diagnostics may quote private configuration contents.
		throw new Error("Could not read a valid JSON configuration file.")
	}
	if (!isObject(parsed)) {
		throw new Error("The configuration root must be an object.")
	}
	if (!Array.isArray(parsed.accounts) || parsed.accounts.length === 0) {
		throw new Error("accounts must be a non-empty array.")
	}
	const accounts = await Promise.all(parsed.accounts.map(readAccount))
	const names = new Set()
	for (const account of accounts) {
		if (names.has(account.name)) {
			throw new Error(
				`Account names must be unique; ${account.name} appears more than once.`,
			)
		}
		names.add(account.name)
	}
	const accessTokenEnv = readString(
		parsed.accessTokenEnv,
		"accessTokenEnv",
		true,
	)
	let accessToken
	if (accessTokenEnv !== undefined) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(accessTokenEnv)) {
			throw new Error(
				"accessTokenEnv is not a valid environment variable name.",
			)
		}
		accessToken = readString(
			process.env[accessTokenEnv],
			"accessTokenEnv value",
		)
	}
	return {
		accounts,
		accessToken,
		diagnostics: readBoolean(parsed.diagnostics, "diagnostics") ?? false,
		healthRefreshMs: readHealthRefreshMs(parsed.healthRefreshMs),
		host: readString(parsed.host, "host", true) ?? "127.0.0.1",
		models: readModels(parsed.models),
		port: parsed.port === undefined ? 10531 : readPort(parsed.port),
		retryOnOtherAccount: readBoolean(
			parsed.retryOnOtherAccount,
			"retryOnOtherAccount",
		),
		rotateIdentity: readBoolean(parsed.rotateIdentity, "rotateIdentity"),
	}
}

const checkNodeVersion = () => {
	const [major, minor, patch] = process.versions.node.split(".").map(Number)
	if (
		![major, minor, patch].every(Number.isInteger) ||
		major < 20 ||
		(major === 20 && (minor < 18 || (minor === 18 && patch < 1)))
	) {
		throw new Error("Pooled account proxies require Node.js 20.18.1 or newer.")
	}
}

const main = async () => {
	const args = parseArguments(process.argv.slice(2))
	if (args.help) {
		console.log(usage)
		return
	}
	if (!args.configPath) {
		throw new Error(`--config is required.\n\n${usage}`)
	}
	checkNodeVersion()
	const config = await parseConfig(args.configPath)
	if (!isLoopbackHost(config.host) && !args.allowNetwork) {
		throw new Error(
			`Refusing to bind ${config.host}. Keep this proxy on loopback, or pass --allow-network with accessTokenEnv or your own access control.`,
		)
	}

	const pool = await createOpenAIPool({
		accounts: config.accounts,
		healthRefreshMs: config.healthRefreshMs,
		retryOnOtherAccount: config.retryOnOtherAccount,
		rotateIdentity: config.rotateIdentity,
	})
	let server
	try {
		server = await startOpenAIOAuthServer({
			credentials: pool,
			accessToken: config.accessToken,
			host: config.host,
			models: config.models,
			port: config.port,
			deferModelDiscovery: true,
			...(args.diagnostics || config.diagnostics
				? {
						poolDiagnostics: {
							stats: () => pool.stats(),
							getModelCatalog: (name, options) =>
								pool.getModelCatalog(name, options),
						},
					}
				: {}),
		})
	} catch (error) {
		await pool.destroy()
		throw error
	}

	console.log(`Pooled OpenAI-compatible API ready at ${server.url}`)
	console.log(
		`Accounts: ${config.accounts.map((account) => account.name).join(", ")}`,
	)
	console.log("Press Ctrl+C to stop.")

	await new Promise((resolve) => {
		let stopping = false
		const stop = () => {
			if (stopping) return
			stopping = true
			void Promise.allSettled([server.close(), pool.destroy()]).then(resolve)
		}
		process.once("SIGINT", stop)
		process.once("SIGTERM", stop)
	})
}

try {
	await main()
} catch (error) {
	console.error(
		error instanceof Error ? error.message : "Failed to start pool.",
	)
	process.exitCode = 1
}
