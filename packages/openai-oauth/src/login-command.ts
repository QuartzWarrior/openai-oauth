import os from "node:os"
import path from "node:path"
import { resolveCodexAuthFilePath } from "@openai-oauth/local/auth-file"
import { type OpenAIOAuthLoginOptions, runOpenAIOAuthLogin } from "./login.js"
import { createLoginProxy } from "./login-proxy.js"
import { preparePoolProxyUpdate } from "./pool-config.js"

export type LoginCommandOptions = OpenAIOAuthLoginOptions & {
	proxy?: string
	poolConfigPath?: string
}

const absolutePath = (value: string): string =>
	path.resolve(
		value === "~"
			? os.homedir()
			: value.startsWith("~/")
				? path.join(os.homedir(), value.slice(2))
				: value,
	)

export const resolveLoginAuthFilePath = (authFilePath?: string): string =>
	absolutePath(resolveCodexAuthFilePath(authFilePath))

/** CLI-only orchestration: programmatic login does not implicitly edit a pool. */
export const runLoginCommand = async (options: LoginCommandOptions) => {
	const { proxy, poolConfigPath, ...login } = options
	if (poolConfigPath !== undefined && proxy === undefined) {
		throw new Error("--pool-config requires login --proxy.")
	}
	if (proxy === undefined) return runOpenAIOAuthLogin(login)
	if (options.signal?.aborted) throw new Error("OpenAI OAuth login cancelled.")
	if (options.fetch !== undefined) {
		throw new Error("A login proxy cannot be combined with a custom fetch.")
	}

	const authFilePath = resolveLoginAuthFilePath(login.authFilePath)
	const runtime = await createLoginProxy(proxy)
	let result: Awaited<ReturnType<typeof runOpenAIOAuthLogin>> | undefined
	let update: Awaited<ReturnType<typeof preparePoolProxyUpdate>> | undefined
	let cleanupFailed = false
	try {
		// Validate the destination before asking the user to authenticate. Commit
		// only after credentials are saved; cancelled/failed logins change nothing.
		update = await preparePoolProxyUpdate({
			authFilePath,
			proxy,
			poolConfigPath,
		})
		const onMessage = login.onMessage ?? console.log
		onMessage(
			"Login token exchange will use the configured proxy. Browser sign-in uses the browser's own proxy settings; the callback stays on localhost.",
		)
		onMessage(`Pool configuration after successful login: ${update.path}`)
		const saved = await runOpenAIOAuthLogin({
			...login,
			authFilePath,
			fetch: runtime.fetch,
		})
		if (options.signal?.aborted) {
			throw new Error(
				"Credentials were saved, but login was cancelled before the pool configuration was updated.",
			)
		}
		try {
			await update.commit(options.signal)
		} catch {
			// Do not roll back saved credentials or print a potentially secret-bearing
			// filesystem/parser exception. A concurrent config edit must be preserved.
			throw new Error(
				"Credentials were saved, but the pool configuration was not updated. Check its permissions and any concurrent edits before retrying.",
			)
		}
		onMessage(
			`Account proxy saved to ${update.path}. Restart the pooled server to load the change.`,
		)
		result = saved
	} finally {
		const cleanup = await Promise.allSettled([
			Promise.resolve().then(() => update?.dispose()),
			Promise.resolve().then(() => runtime.close()),
		])
		cleanupFailed = cleanup.some((result) => result.status === "rejected")
	}
	if (cleanupFailed) {
		throw new Error(
			"Login completed, but its resources could not be closed cleanly.",
		)
	}
	return result
}
