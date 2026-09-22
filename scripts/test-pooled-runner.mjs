import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const runner = fileURLToPath(new URL("./run-pooled-proxy.mjs", import.meta.url))

const withFixture = (run) => {
	const directory = mkdtempSync(path.join(tmpdir(), "pool-runner-test-"))
	try {
		const authFilePath = path.join(directory, "auth.json")
		writeFileSync(authFilePath, "{}", { mode: 0o600 })
		const loader = path.join(directory, "loader.mjs")
		// Intercept package imports: this exercises the real runner without any
		// authentication, transport connection, or provider request.
		writeFileSync(
			loader,
			`
export async function resolve(specifier, context, next) {
  if (specifier === '@openai-oauth/pool' || specifier === 'openai-oauth') {
    return { url: 'mock:' + specifier, shortCircuit: true }
  }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (url === 'mock:@openai-oauth/pool') return {
    format: 'module', shortCircuit: true,
    source: \`export async function createOpenAIPool(options) {
      if (String(options.healthRefreshMs) !== process.env.EXPECTED_HEALTH_REFRESH) throw new Error('Health refresh was not forwarded')
      return {
        calls: { stats: 0, catalog: 0 },
        stats() {
          this.calls.stats++
          return [{ name: 'test', healthy: true, quota: { families: [] } }]
        },
        async getModelCatalog(name, options) {
          this.calls.catalog++
          return { accountName: name, models: [], freshness: 'missing', options }
        },
        getSession() { throw new Error('Unexpected credential loading') },
        destroy: async () => {},
      }
    }\`
  }
  if (url === 'mock:openai-oauth') return {
    format: 'module', shortCircuit: true,
    source: \`export async function startOpenAIOAuthServer(options) {
      if (options.deferModelDiscovery !== true) throw new Error('Discovery was not deferred')
      if (options.accessToken !== process.env.EXPECTED_RUNNER_TOKEN) throw new Error('Token was not forwarded')
      const enabled = process.env.EXPECTED_RUNNER_DIAGNOSTICS === 'true'
      if (Boolean(options.poolDiagnostics) !== enabled) throw new Error('Diagnostics opt-in was not preserved')
      if (options.credentials.calls.stats !== 0 || options.credentials.calls.catalog !== 0) throw new Error('Runner eagerly inspected accounts')
      if (enabled) {
        const stats = options.poolDiagnostics.stats()
        if (stats[0]?.name !== 'test' || options.credentials.calls.stats !== 1) throw new Error('Stats callback was not delegated')
        const controller = new AbortController()
        const requestOptions = { mode: 'oauth-visible', cacheOnly: true, signal: controller.signal }
        const result = await options.poolDiagnostics.getModelCatalog('test', requestOptions)
        if (result.accountName !== 'test' || result.options !== requestOptions || options.credentials.calls.catalog !== 1) throw new Error('Catalog callback was not delegated')
      }
      console.log('runner-options-verified')
      setImmediate(() => process.emit('SIGTERM'))
      return { url: 'http://127.0.0.1:10531', close: async () => {} }
    }\`
  }
  return next(url, context)
}
`,
		)
	const runConfig = (overrides = {}, environment = {}, args = []) => {
			const configPath = path.join(directory, "config.json")
			writeFileSync(
				configPath,
				typeof overrides === "string"
					? overrides
					: JSON.stringify({
							accounts: [{ name: "test", authFilePath }],
							...overrides,
						}),
				{ mode: 0o600 },
			)
			const env = { ...process.env, ...environment }
			delete env.EXPECTED_RUNNER_TOKEN
			delete env.EXPECTED_RUNNER_DIAGNOSTICS
			delete env.EXPECTED_HEALTH_REFRESH
			env.EXPECTED_HEALTH_REFRESH = "undefined"
			if (environment.EXPECTED_RUNNER_DIAGNOSTICS)
				env.EXPECTED_RUNNER_DIAGNOSTICS =
					environment.EXPECTED_RUNNER_DIAGNOSTICS
			if (environment.EXPECTED_RUNNER_TOKEN)
				env.EXPECTED_RUNNER_TOKEN = environment.EXPECTED_RUNNER_TOKEN
			if (environment.EXPECTED_HEALTH_REFRESH !== undefined)
				env.EXPECTED_HEALTH_REFRESH = environment.EXPECTED_HEALTH_REFRESH
			return spawnSync(
				process.execPath,
				[
					"--no-warnings",
					"--loader",
					loader,
					...(environment.RUNNER_TEST_NODE_VERSION
						? [
								"--import",
								`data:text/javascript,${encodeURIComponent(`Object.defineProperty(process.versions, "node", {value: ${JSON.stringify(environment.RUNNER_TEST_NODE_VERSION)}})`)}`,
							]
						: []),
					runner,
					"--config",
					configPath,
					...args,
				],
				{
					encoding: "utf8",
					timeout: 10_000,
					env,
				},
			)
		}
		run(runConfig)
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

test("runner defers discovery and cleanly shuts down with mocked accounts", () =>
	withFixture((run) => {
		const result = run()
		assert.equal(result.status, 0, result.stderr)
		assert.match(result.stdout, /runner-options-verified/)
	}))

test("runner diagnostics remain disabled when explicitly false", () =>
	withFixture((run) => {
		const result = run({ diagnostics: false })
		assert.equal(result.status, 0, result.stderr)
		assert.match(result.stdout, /runner-options-verified/)
	}))

for (const [label, healthRefreshMs, expected] of [
	["default", undefined, undefined],
	["default interval", true, true],
	["custom interval", 15_000, 15_000],
]) {
	test(`runner forwards health refresh ${label}`, () =>
		withFixture((run) => {
			const result = run(
				healthRefreshMs === undefined ? {} : { healthRefreshMs },
				{ EXPECTED_HEALTH_REFRESH: String(expected) },
			)
			assert.equal(result.status, 0, result.stderr)
		}))
}

for (const healthRefreshMs of [false, 0, -1, 1.5, "60000", null]) {
	test(`runner rejects invalid health refresh ${JSON.stringify(healthRefreshMs)}`, () =>
		withFixture((run) => {
			const result = run({ healthRefreshMs })
			assert.equal(result.status, 1)
			assert.match(result.stderr, /healthRefreshMs must be true or a positive integer/)
		}))
}

for (const [label, config, args] of [
	["configuration", { diagnostics: true }, []],
	["flag", {}, ["--diagnostics"]],
	["flag overriding false", { diagnostics: false }, ["--diagnostics"]],
]) {
	test(`runner enables lazy diagnostics callbacks through ${label}`, () =>
		withFixture((run) => {
			const result = run(config, { EXPECTED_RUNNER_DIAGNOSTICS: "true" }, args)
			assert.equal(result.status, 0, result.stderr)
			assert.match(result.stdout, /runner-options-verified/)
		}))
}

for (const diagnostics of ["true", 1, null, {}, []]) {
	test(`runner rejects nonboolean diagnostics ${JSON.stringify(diagnostics)}`, () =>
		withFixture((run) => {
			const result = run({ diagnostics }, {}, ["--diagnostics"])
			assert.equal(result.status, 1)
			assert.match(result.stderr, /diagnostics must be true or false/)
			assert.doesNotMatch(result.stdout, /runner-options-verified/)
		}))
}

test("runner diagnostics reuse the explicitly configured bearer token", () =>
	withFixture((run) => {
		const result = run(
			{ diagnostics: true, accessTokenEnv: "RUNNER_TEST_TOKEN" },
			{
				RUNNER_TEST_TOKEN: "diagnostics-test-token",
				EXPECTED_RUNNER_TOKEN: "diagnostics-test-token",
				EXPECTED_RUNNER_DIAGNOSTICS: "true",
			},
		)
		assert.equal(result.status, 0, result.stderr)
		assert.match(result.stdout, /runner-options-verified/)
		assert.doesNotMatch(result.stdout + result.stderr, /diagnostics-test-token/)
	}))

test("runner diagnostics do not bypass the explicit network-bind flag", () =>
	withFixture((run) => {
		const result = run({ host: "0.0.0.0", diagnostics: true })
		assert.equal(result.status, 1)
		assert.match(result.stderr, /Refusing to bind/)
		assert.doesNotMatch(result.stdout, /runner-options-verified/)
	}))

test("runner forwards an explicitly configured access-token environment value", () =>
	withFixture((run) => {
		const result = run(
			{ accessTokenEnv: "RUNNER_TEST_TOKEN" },
			{
				RUNNER_TEST_TOKEN: "test-only-token",
				EXPECTED_RUNNER_TOKEN: "test-only-token",
			},
		)
		assert.equal(result.status, 0, result.stderr)
		assert.match(result.stdout, /runner-options-verified/)
		assert.doesNotMatch(result.stdout + result.stderr, /test-only-token/)
	}))

test("runner refuses a missing configured access token", () =>
	withFixture((run) => {
		const result = run(
			{ accessTokenEnv: "RUNNER_TEST_TOKEN" },
			{ RUNNER_TEST_TOKEN: "" },
		)
		assert.equal(result.status, 1)
		assert.match(
			result.stderr,
			/accessTokenEnv value must be a non-empty string/,
		)
		assert.doesNotMatch(result.stdout, /runner-options-verified/)
	}))

test("runner redacts private contents from malformed JSON diagnostics", () =>
	withFixture((run) => {
		const result = run("private-config-token-NOT-JSON")
		assert.equal(result.status, 1)
		assert.match(
			result.stderr,
			/Could not read a valid JSON configuration file/,
		)
		assert.doesNotMatch(result.stdout + result.stderr, /private-config-token/)
	}))

for (const [version, accepted] of [
	["20.0.0", false],
	["20.18.0", false],
	["20.18.1", true],
	["22.0.0", true],
]) {
	test(`runner Node version guard: ${version}`, () =>
		withFixture((run) => {
			const result = run({}, { RUNNER_TEST_NODE_VERSION: version })
			assert.equal(result.status, accepted ? 0 : 1, result.stderr)
			if (!accepted) assert.match(result.stderr, /20\.18\.1 or newer/)
		}))
}

test("runner still refuses network binding without the explicit flag", () =>
	withFixture((run) => {
		const result = run({ host: "0.0.0.0" })
		assert.equal(result.status, 1)
		assert.match(result.stderr, /Refusing to bind/)
		assert.doesNotMatch(result.stdout, /runner-options-verified/)
	}))
