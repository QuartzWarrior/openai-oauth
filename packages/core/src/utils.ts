export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Mint an RFC 9562 UUIDv7: 48-bit Unix-ms timestamp in the high bits, `0111`
 * version, RFC variant, random tail. Codex's entire ID universe is v7
 * (protocol/src/items.rs, session_id.rs, response_item_id.rs, turn_metadata.rs,
 * ...), so every id this client sends upstream — thread, session, turn — must
 * be time-ordered v7 too; a v4 is regex-valid but generationally inconsistent
 * with every other id the wire ever sees from a real client.
 */
export const randomUUIDv7 = (): string => {
	const nowMs = BigInt(Date.now()) & 0xffffffffffffn
	const bytes = new Uint8Array(16)
	globalThis.crypto.getRandomValues(bytes)
	// High 48 bits: unix epoch milliseconds
	bytes[0] = Number(nowMs >> 40n)
	bytes[1] = Number((nowMs >> 32n) & 0xffn)
	bytes[2] = Number((nowMs >> 24n) & 0xffn)
	bytes[3] = Number((nowMs >> 16n) & 0xffn)
	bytes[4] = Number((nowMs >> 8n) & 0xffn)
	bytes[5] = Number(nowMs & 0xffn)
	// version 7 (0111) in the high nibble of byte 6; keep low nibble random
	bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f)
	// RFC variant (10xx) in the high two bits of byte 8
	bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f)
	const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"))
	return (
		hex.slice(0, 4).join("") +
		"-" +
		hex.slice(4, 6).join("") +
		"-" +
		hex.slice(6, 8).join("") +
		"-" +
		hex.slice(8, 10).join("") +
		"-" +
		hex.slice(10, 16).join("")
	)
}
