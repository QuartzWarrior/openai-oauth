import { describe, expect, test } from "vitest"
import { pickCodexTerminalToken, randomUUIDv7 } from "../src/index.js"

/**
 * The terminal token is the only free segment of the Codex User-Agent. Every
 * value the pool may emit must be a token codex_terminal_detection can
 * genuinely produce on a headless Linux host — never a mac/Windows-only
 * program, and crates-recognized tokens in their exact wire form.
 */
const LEGIT_TOKENS = new Set([
	"unknown",
	"xterm-256color",
	"screen",
	"screen-256color",
	"tmux-256color",
	"kitty",
	"WezTerm/20240203-110809-5046fc22",
	"vscode/1.104.0",
])

const ILLEGAL = [
	"iTerm.app",
	"Apple_Terminal",
	"WarpTerminal",
	"WindowsTerminal",
	"Ghostty",
	"Alacritty",
]

describe("pickCodexTerminalToken", () => {
	test("only ever returns a legitimately-possible Linux token", () => {
		for (let i = 0; i < 400; i += 1) {
			const token = pickCodexTerminalToken(`installation-${i}`)
			expect(LEGIT_TOKENS.has(token)).toBe(true)
			for (const bad of ILLEGAL) {
				expect(token).not.toContain(bad)
			}
		}
	})

	test("is deterministic per seed (one account keeps one UA)", () => {
		expect(pickCodexTerminalToken("device-a")).toBe(
			pickCodexTerminalToken("device-a"),
		)
		expect(pickCodexTerminalToken("device-b")).toBe(
			pickCodexTerminalToken("device-b"),
		)
	})

	test("weighs toward the headless unknown/multiplexer majority", () => {
		const counts = new Map<string, number>()
		for (let i = 0; i < 2000; i += 1) {
			const token = pickCodexTerminalToken(`seed-${i}`)
			counts.set(token, (counts.get(token) ?? 0) + 1)
		}
		const unknown = counts.get("unknown") ?? 0
		// unknown holds ~60% weight; assert a clear plurality well above any other
		expect(unknown / 2000).toBeGreaterThan(0.4)
		// interactive-looking terminals stay a small minority
		const interactive =
			(counts.get("kitty") ?? 0) +
			(counts.get("WezTerm/20240203-110809-5046fc22") ?? 0) +
			(counts.get("vscode/1.104.0") ?? 0)
		expect(interactive / 2000).toBeLessThan(0.3)
	})

	test("produces a spread across distinct accounts", () => {
		const tokens = new Set(
			Array.from({ length: 50 }, (_, i) => pickCodexTerminalToken(`acct-${i}`)),
		)
		// with many accounts, more than one distinct (still legit) token appears
		expect(tokens.size).toBeGreaterThan(1)
	})
})

/**
 * Codex's ID universe is RFC 9562 UUIDv7 (time-ordered): protocol/src/items.rs
 * `Uuid::now_v7()`, session_id.rs, turn_metadata.rs, ... Every id the pool
 * mints must be v7 — a v4 is regex-valid but generationally inconsistent.
 */
describe("randomUUIDv7", () => {
	const V7 =
		/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

	test("emits well-formed v7 UUIDs", () => {
		for (let i = 0; i < 200; i += 1) {
			expect(randomUUIDv7()).toMatch(V7)
		}
	})

	test("leading hex encodes a recent Unix-ms timestamp (time-ordered)", () => {
		const before = Date.now()
		const id = randomUUIDv7()
		const after = Date.now()
		const ms = Number.parseInt(id.replace(/-/g, "").slice(0, 12), 16)
		expect(ms).toBeGreaterThanOrEqual(before)
		expect(ms).toBeLessThanOrEqual(after)
	})

	test("ids generated later never sort earlier in their ms prefix", () => {
		const first = randomUUIDv7()
		const second = randomUUIDv7()
		expect(
			second.replace(/-/g, "").slice(0, 12) >=
				first.replace(/-/g, "").slice(0, 12),
		).toBe(true)
	})
})
