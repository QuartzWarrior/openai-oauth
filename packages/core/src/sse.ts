import { parseInferenceError } from "./inference-error.js"
import { readWithSignal } from "./stream-utils.js"
import { isRecord } from "./utils.js"

export type ServerSentEvent = {
	event?: string
	data?: string
}

export type SseLimits = {
	maxEventBytes?: number
	maxResponseBytes?: number
	maxOutputItems?: number
	/** Active upstream read timeout; paused consumers do not consume this budget. */
	idleTimeoutMs?: number
}

const DEFAULT_EVENT_BYTES = 1024 * 1024
const DEFAULT_RESPONSE_BYTES = 8 * 1024 * 1024
const DEFAULT_OUTPUT_ITEMS = 2_000
const encoder = new TextEncoder()

const parseEventBlock = (block: string): ServerSentEvent => {
	const event: ServerSentEvent = {}
	const dataLines: string[] = []
	for (const line of block.split("\n")) {
		if (line.startsWith("event:")) event.event = line.slice(6).trim()
		if (line.startsWith("data:"))
			dataLines.push(line.slice(5).replace(/^ /, ""))
	}
	if (dataLines.length > 0) event.data = dataLines.join("\n")
	return event
}

const checkedLimit = (value: number): number => {
	if (!Number.isSafeInteger(value) || value <= 0)
		throw new Error("SSE limits must be positive integers.")
	return value
}

/** Incremental parser; the budget applies before an unterminated event grows. */
export class SseParser {
	private readonly decoder = new TextDecoder()
	private line = ""
	private lines: string[] = []
	private bufferedBytes = 0
	private skipLf = false
	private readonly maxEventBytes: number

	constructor(limits: SseLimits = {}) {
		this.maxEventBytes = checkedLimit(
			limits.maxEventBytes ?? DEFAULT_EVENT_BYTES,
		)
	}

	*push(chunk: Uint8Array): Generator<ServerSentEvent> {
		// Split at ASCII CR/LF before decoding; delimiters cannot appear inside a
		// UTF-8 multibyte character. A CRLF split across chunks remains one line.
		let start = 0
		for (let index = 0; index < chunk.length; index += 1) {
			const byte = chunk[index]
			if (this.skipLf) {
				this.skipLf = false
				if (byte === 10) {
					start = index + 1
					continue
				}
			}
			if (byte !== 10 && byte !== 13) continue
			this.append(chunk.subarray(start, index))
			this.bufferedBytes += 1
			if (this.bufferedBytes > this.maxEventBytes)
				throw new Error("SSE event exceeded the configured size limit.")
			this.line += this.decoder.decode()
			start = index + 1
			this.skipLf = byte === 13
			if (this.line === "") {
				const block = this.lines.join("\n")
				this.lines = []
				this.bufferedBytes = 0
				if (block.trim()) yield parseEventBlock(block)
			} else {
				this.lines.push(this.line)
				this.line = ""
			}
		}
		if (start < chunk.length) this.append(chunk.subarray(start))
	}

	*finish(): Generator<ServerSentEvent> {
		this.line += this.decoder.decode()
		if (this.line) this.lines.push(this.line)
		const block = this.lines.join("\n")
		if (block.trim()) yield parseEventBlock(block)
		this.line = ""
		this.lines = []
		this.bufferedBytes = 0
	}

	private append(bytes: Uint8Array): void {
		this.bufferedBytes += bytes.byteLength
		if (this.bufferedBytes > this.maxEventBytes) {
			throw new Error("SSE event exceeded the configured size limit.")
		}
		this.line += this.decoder.decode(bytes, { stream: true })
	}
}

export async function* iterateServerSentEvents(
	stream: ReadableStream<Uint8Array>,
	limits: SseLimits = {},
): AsyncGenerator<ServerSentEvent> {
	const reader = stream.getReader()
	const parser = new SseParser(limits)
	let reachedEnd = false
	try {
		while (true) {
			const { value, done } = await readWithSignal(
				reader,
				undefined,
				limits.idleTimeoutMs,
			)
			if (done) {
				reachedEnd = true
				break
			}
			yield* parser.push(value)
		}
		yield* parser.finish()
	} finally {
		if (!reachedEnd) void reader.cancel().catch(() => undefined)
		reader.releaseLock()
	}
}

const terminalResponseStatuses = new Set([
	"completed",
	"failed",
	"cancelled",
	"canceled",
	"incomplete",
])

/** Only a terminal response can satisfy collection; [DONE] alone is not one. */
export class ResponseSseCollector {
	private readonly outputItems = new Map<string, Record<string, unknown>>()
	private readonly itemSizes = new Map<string, number>()
	private outputBytes = 0
	private readonly maxResponseBytes: number
	private readonly maxOutputItems: number
	response: Record<string, unknown> | undefined
	terminal = false

	constructor(limits: SseLimits = {}) {
		this.maxResponseBytes = checkedLimit(
			limits.maxResponseBytes ?? DEFAULT_RESPONSE_BYTES,
		)
		this.maxOutputItems = checkedLimit(
			limits.maxOutputItems ?? DEFAULT_OUTPUT_ITEMS,
		)
	}

	accept(event: ServerSentEvent): void {
		if (this.terminal || !event.data) return
		if (event.data === "[DONE]") {
			throw new Error("SSE stream ended without a terminal response.")
		}
		let parsed: unknown
		try {
			parsed = JSON.parse(event.data)
		} catch {
			throw new Error("SSE event contained invalid JSON.")
		}
		if (!isRecord(parsed)) return
		const type = typeof parsed.type === "string" ? parsed.type : event.event
		if (type === "error" || isRecord(parsed.error)) {
			throw parseInferenceError(parsed, { responseStarted: true })
		}
		const item = parsed.item
		if (
			type === "response.output_item.done" &&
			isRecord(item) &&
			typeof item.id === "string"
		) {
			const size = encoder.encode(JSON.stringify(item)).byteLength
			const total = this.outputBytes - (this.itemSizes.get(item.id) ?? 0) + size
			if (
				total > this.maxResponseBytes ||
				(!this.outputItems.has(item.id) &&
					this.outputItems.size >= this.maxOutputItems)
			) {
				throw new Error("SSE response exceeded the configured capture limit.")
			}
			this.outputBytes = total
			this.itemSizes.set(item.id, size)
			this.outputItems.set(item.id, item)
		}
		const response = parsed.response
		const statusFromEvent = type?.startsWith("response.")
			? type.slice("response.".length)
			: undefined
		const status =
			isRecord(response) && typeof response.status === "string"
				? response.status
				: statusFromEvent
		if (!status || !terminalResponseStatuses.has(status)) return
		if (!isRecord(response))
			throw new Error("Terminal SSE event did not include a response.")
		const output = Array.isArray(response.output) ? response.output : []
		if (output.length > this.maxOutputItems)
			throw new Error("SSE response exceeded the configured capture limit.")
		const completed = {
			...response,
			status,
			output: output.length > 0 ? output : [...this.outputItems.values()],
		}
		if (
			encoder.encode(JSON.stringify(completed)).byteLength >
			this.maxResponseBytes
		) {
			throw new Error("SSE response exceeded the configured capture limit.")
		}
		this.response = completed
		this.terminal = true
	}

	finish(): Record<string, unknown> {
		if (!this.terminal || !this.response) {
			throw new Error("SSE stream ended without a terminal response.")
		}
		return this.response
	}
}

export const collectCompletedResponseFromSse = async (
	stream: ReadableStream<Uint8Array>,
	limits: SseLimits = {},
): Promise<Record<string, unknown>> => {
	const collector = new ResponseSseCollector(limits)
	for await (const event of iterateServerSentEvents(stream, limits)) {
		collector.accept(event)
		if (collector.terminal) return collector.finish()
	}
	return collector.finish()
}
