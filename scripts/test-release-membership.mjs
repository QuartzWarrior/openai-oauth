import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const expected = readdirSync(join(root, "packages"))
	.filter((directory) => {
		const metadata = JSON.parse(
			readFileSync(join(root, "packages", directory, "package.json"), "utf8"),
		)
		return !metadata.private
	})
	.map((directory) => `packages/${directory}`)
	.sort()

for (const script of ["check-release.mjs", "publish-packages.mjs"]) {
	test(`${script} includes every public package exactly once`, () => {
		const source = readFileSync(join(root, "scripts", script), "utf8")
		const list = source.match(/const packageDirs = \[([\s\S]*?)\]/)?.[1]
		assert.ok(list, "explicit release package list exists")
		const actual = [...list.matchAll(/"(packages\/[^"\n]+)"/g)].map(
			(match) => match[1],
		)
		assert.deepEqual([...actual].sort(), expected)
		assert.ok(actual.indexOf("packages/core") < actual.indexOf("packages/pool"))
		assert.ok(
			actual.indexOf("packages/local") < actual.indexOf("packages/pool"),
		)
	})
}
