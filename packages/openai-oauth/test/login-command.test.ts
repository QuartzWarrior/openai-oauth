import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	login: vi.fn(),
	proxy: vi.fn(),
	prepare: vi.fn(),
	close: vi.fn(),
	commit: vi.fn(),
	dispose: vi.fn(),
	fetch: vi.fn(),
}))
vi.mock("../src/login.js", () => ({ runOpenAIOAuthLogin: mocks.login }))
vi.mock("../src/login-proxy.js", () => ({ createLoginProxy: mocks.proxy }))
vi.mock("../src/pool-config.js", () => ({
	preparePoolProxyUpdate: mocks.prepare,
}))

import { runLoginCommand } from "../src/login-command.js"

const proxy = "http://test-user:private-password@proxy.test:8080"
const options = {
	proxy,
	authFilePath: "/tmp/account.json",
	poolConfigPath: "/tmp/pool.json",
	onMessage: vi.fn(),
	openBrowser: false,
}

beforeEach(() => {
	vi.resetAllMocks()
	mocks.close.mockResolvedValue(undefined)
	mocks.dispose.mockResolvedValue(undefined)
	mocks.commit.mockResolvedValue(undefined)
	mocks.proxy.mockResolvedValue({ fetch: mocks.fetch, close: mocks.close })
	mocks.prepare.mockResolvedValue({
		path: "/tmp/pool.json",
		commit: mocks.commit,
		dispose: mocks.dispose,
	})
	mocks.login.mockResolvedValue({ path: "/tmp/account.json", auth: {} })
})

describe("proxied login orchestration", () => {
	test("updates pool only after successful login and closes all resources", async () => {
		mocks.login.mockImplementation(async () => {
			expect(mocks.prepare).toHaveBeenCalledOnce()
			expect(mocks.commit).not.toHaveBeenCalled()
			return { path: "/tmp/account.json", auth: {} }
		})
		await runLoginCommand(options)
		expect(mocks.proxy).toHaveBeenCalledWith(proxy)
		expect(mocks.login).toHaveBeenCalledWith(
			expect.objectContaining({
				fetch: mocks.fetch,
				authFilePath: "/tmp/account.json",
				openBrowser: false,
			}),
		)
		expect(mocks.prepare).toHaveBeenCalledWith({
			authFilePath: "/tmp/account.json",
			proxy,
			poolConfigPath: "/tmp/pool.json",
		})
		expect(mocks.commit).toHaveBeenCalledOnce()
		expect(mocks.dispose).toHaveBeenCalledOnce()
		expect(mocks.close).toHaveBeenCalledOnce()
		expect(JSON.stringify(options.onMessage.mock.calls)).not.toContain(
			"private-password",
		)
	})

	test.each([
		"OpenAI OAuth login cancelled.",
		"OpenAI OAuth login timed out.",
		"Token exchange failed",
	])("does not write pool config after %s", async (message) => {
		mocks.login.mockRejectedValue(new Error(message))
		await expect(runLoginCommand(options)).rejects.toThrow(message)
		expect(mocks.commit).not.toHaveBeenCalled()
		expect(mocks.dispose).toHaveBeenCalledOnce()
		expect(mocks.close).toHaveBeenCalledOnce()
	})

	test("invalid pool preflight closes proxy without starting login", async () => {
		mocks.prepare.mockRejectedValue(new Error("Invalid pool configuration"))
		await expect(runLoginCommand(options)).rejects.toThrow(
			"Invalid pool configuration",
		)
		expect(mocks.login).not.toHaveBeenCalled()
		expect(mocks.commit).not.toHaveBeenCalled()
		expect(mocks.close).toHaveBeenCalledOnce()
	})

	test("config write failure reports partial success without leaking details", async () => {
		mocks.commit.mockRejectedValue(new Error(proxy))
		await expect(runLoginCommand(options)).rejects.toThrow(
			"Credentials were saved, but the pool configuration was not updated",
		)
		expect(mocks.close).toHaveBeenCalledOnce()
		expect(mocks.dispose).toHaveBeenCalledOnce()
		expect(JSON.stringify(options.onMessage.mock.calls)).not.toContain(
			"private-password",
		)
	})

	test("passes cancellation into the config commit boundary", async () => {
		const controller = new AbortController()
		mocks.commit.mockImplementation(async (signal: AbortSignal) => {
			expect(signal).toBe(controller.signal)
			controller.abort()
			signal.throwIfAborted()
		})
		await expect(
			runLoginCommand({ ...options, signal: controller.signal }),
		).rejects.toThrow("pool configuration was not updated")
		expect(mocks.dispose).toHaveBeenCalledOnce()
		expect(mocks.close).toHaveBeenCalledOnce()
	})

	test("preserves login error when cleanup also fails", async () => {
		mocks.login.mockRejectedValue(new Error("Login rejected"))
		mocks.close.mockRejectedValue(new Error(proxy))
		await expect(runLoginCommand(options)).rejects.toThrow("Login rejected")
		expect(mocks.dispose).toHaveBeenCalledOnce()
	})

	test("ordinary login does not construct proxy or touch pool config", async () => {
		await runLoginCommand({
			authFilePath: options.authFilePath,
			openBrowser: false,
		})
		expect(mocks.login).toHaveBeenCalledWith({
			authFilePath: options.authFilePath,
			openBrowser: false,
		})
		expect(mocks.proxy).not.toHaveBeenCalled()
		expect(mocks.prepare).not.toHaveBeenCalled()
	})

	test("rejects pre-aborted login before proxy creation", async () => {
		await expect(
			runLoginCommand({ ...options, signal: AbortSignal.abort() }),
		).rejects.toThrow("cancelled")
		expect(mocks.proxy).not.toHaveBeenCalled()
	})

	test("does not commit if cancellation arrives after credential save", async () => {
		const controller = new AbortController()
		mocks.login.mockImplementation(async () => {
			controller.abort()
			return { path: options.authFilePath, auth: {} }
		})
		await expect(
			runLoginCommand({ ...options, signal: controller.signal }),
		).rejects.toThrow("Credentials were saved")
		expect(mocks.commit).not.toHaveBeenCalled()
		expect(mocks.close).toHaveBeenCalledOnce()
	})

	test("rejects pool-config without proxy and conflicting custom fetch", async () => {
		await expect(
			runLoginCommand({ poolConfigPath: "/tmp/pool.json" }),
		).rejects.toThrow("requires login --proxy")
		await expect(
			runLoginCommand({ ...options, fetch: mocks.fetch }),
		).rejects.toThrow("custom fetch")
		expect(mocks.login).not.toHaveBeenCalled()
	})
})
