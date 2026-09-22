import { Buffer } from "node:buffer"
import type {
	IncomingHttpHeaders,
	IncomingMessage,
	ServerResponse,
} from "node:http"
import type { AddressInfo } from "node:net"
import type { ChatRequest, JsonValue, UsageLike } from "./types.js"

export const DEFAULT_HOST = "127.0.0.1"
export const DEFAULT_PORT = 10531

const jsonHeaders = {
	"content-type": "application/json; charset=utf-8",
}

export const sseHeaders = {
	"content-type": "text/event-stream; charset=utf-8",
	"cache-control": "no-cache, no-transform",
	connection: "keep-alive",
	"x-accel-buffering": "no",
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

export const isJsonValue = (value: unknown): value is JsonValue => {
	if (
		value == null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return true
	}

	if (Array.isArray(value)) {
		return value.every((item) => isJsonValue(item))
	}

	if (isRecord(value)) {
		return Object.values(value).every((item) => isJsonValue(item))
	}

	return false
}

export const toJsonResponse = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: {
			...jsonHeaders,
		},
	})

export const toErrorResponse = (
	message: string,
	status = 400,
	type = "invalid_request_error",
): Response =>
	toJsonResponse(
		{
			error: {
				message,
				type,
			},
		},
		status,
	)

export const mapFinishReason = (
	finishReason: string | undefined,
): "stop" | "length" | "tool_calls" | "content_filter" | null => {
	switch (finishReason) {
		case "stop":
			return "stop"
		case "length":
			return "length"
		case "tool-calls":
			return "tool_calls"
		case "content-filter":
			return "content_filter"
		default:
			return null
	}
}

export const toUsage = (usage: UsageLike) => ({
	prompt_tokens: usage.inputTokens ?? 0,
	completion_tokens: usage.outputTokens ?? 0,
	total_tokens: usage.totalTokens ?? 0,
	prompt_tokens_details:
		usage.cachedInputTokens == null
			? undefined
			: {
					cached_tokens: usage.cachedInputTokens,
				},
	completion_tokens_details:
		usage.reasoningTokens == null
			? undefined
			: {
					reasoning_tokens: usage.reasoningTokens,
				},
})

export const summarizeChatRequest = (request: {
	model?: string
	messages?: Array<{ role?: string }>
	reasoning_effort?: ChatRequest["reasoning_effort"]
	stream?: boolean
	tools?: unknown[]
}) => ({
	bodyKeys: Object.keys(request).sort(),
	messageCount: request.messages?.length ?? 0,
	messageRoles: (request.messages ?? [])
		.map((message) => message.role)
		.filter((role): role is string => typeof role === "string"),
	model: request.model,
	reasoningEffort: request.reasoning_effort,
	stream: request.stream === true,
	toolCount: request.tools?.length ?? 0,
})

export const copyUpstreamResponse = (response: Response): Response => {
	const headers = new Headers(response.headers)
	headers.delete("content-encoding")
	headers.delete("content-length")
	if (!headers.has("content-type")) {
		headers.set("content-type", "application/json; charset=utf-8")
	}

	return new Response(response.body, {
		status: response.status,
		headers,
	})
}

export const DEFAULT_MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024

export class RequestBodyTooLargeError extends Error {
	constructor() {
		super("Request body exceeds the configured size limit.")
		this.name = "RequestBodyTooLargeError"
	}
}

export const limitRequestBody = (request: Request, limit: number): Request => {
	const length = request.headers.get("content-length")
	if (length !== null && Number(length) > limit) {
		void request.body?.cancel().catch(() => undefined)
		throw new RequestBodyTooLargeError()
	}
	if (request.body === null) return request

	const reader = request.body.getReader()
	let size = 0
	let settled = false
	let controller: ReadableStreamDefaultController<Uint8Array>
	const cancelSource = (reason?: unknown) => {
		void reader
			.cancel(reason)
			.catch(() => undefined)
			.finally(() => reader.releaseLock())
	}
	const cleanup = () => request.signal.removeEventListener("abort", abort)
	const abort = () => {
		if (settled) return
		settled = true
		cleanup()
		controller.error(request.signal.reason)
		cancelSource(request.signal.reason)
	}
	const body = new ReadableStream<Uint8Array>(
		{
			start(value) {
				controller = value
				request.signal.addEventListener("abort", abort, { once: true })
				if (request.signal.aborted) abort()
			},
			async pull() {
				try {
					const { done, value } = await reader.read()
					if (settled) return
					if (done) {
						settled = true
						cleanup()
						controller.close()
						reader.releaseLock()
						return
					}
					size += value.byteLength
					if (size > limit) throw new RequestBodyTooLargeError()
					controller.enqueue(value)
				} catch (error) {
					if (settled) return
					settled = true
					cleanup()
					controller.error(error)
					cancelSource(error)
				}
			},
			cancel(reason) {
				if (settled) return
				settled = true
				cleanup()
				cancelSource(reason)
			},
		},
		{ highWaterMark: 0 },
	)
	return new Request(request, { body, duplex: "half" } as RequestInit)
}

const toHeaders = (headers: IncomingHttpHeaders): Headers => {
	const nextHeaders = new Headers()

	for (const [key, value] of Object.entries(headers)) {
		if (Array.isArray(value)) {
			for (const item of value) {
				nextHeaders.append(key, item)
			}
			continue
		}

		if (typeof value === "string") {
			nextHeaders.set(key, value)
		}
	}

	return nextHeaders
}

export const toWebRequest = async (
	request: IncomingMessage,
	options: { host: string; port: number; signal?: AbortSignal },
): Promise<Request> => {
	const host = options.host.includes(":") ? `[${options.host}]` : options.host
	const url = `http://${host}:${options.port}${request.url ?? "/"}`
	const iterator = request.iterator({ destroyOnReturn: false })
	const body =
		request.method === "GET" || request.method === "HEAD"
			? undefined
			: new ReadableStream<Uint8Array>(
					{
						async pull(controller) {
							try {
								const { done, value } = await iterator.next()
								if (done) controller.close()
								else
									controller.enqueue(
										Buffer.isBuffer(value) ? value : Buffer.from(value),
									)
							} catch (error) {
								controller.error(error)
							}
						},
						async cancel() {
							await iterator.return?.()
						},
					},
					{ highWaterMark: 0 },
				)

	return new Request(url, {
		method: request.method,
		headers: toHeaders(request.headers),
		body,
		signal: options.signal,
		duplex: "half",
	} as RequestInit)
}

export const writeWebResponse = async (
	response: ServerResponse,
	webResponse: Response,
): Promise<void> => {
	response.statusCode = webResponse.status
	webResponse.headers.forEach((value, key) => {
		response.setHeader(key, value)
	})

	if (webResponse.body == null) {
		response.end()
		return
	}

	const reader = webResponse.body.getReader()
	let disconnected = response.destroyed
	const onClose = () => {
		disconnected = true
		void reader
			.cancel(new DOMException("Client disconnected.", "AbortError"))
			.catch(() => undefined)
	}
	response.once("close", onClose)
	if (disconnected) onClose()
	const waitForDrain = () =>
		new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				response.off("drain", drain)
				response.off("close", close)
				response.off("error", error)
			}
			const drain = () => {
				cleanup()
				resolve()
			}
			const close = () => {
				cleanup()
				reject(new DOMException("Client disconnected.", "AbortError"))
			}
			const error = (reason: Error) => {
				cleanup()
				reject(reason)
			}
			response.once("drain", drain)
			response.once("close", close)
			response.once("error", error)
			if (response.destroyed) close()
		})
	try {
		while (!disconnected) {
			const { done, value } = await reader.read()
			if (done || disconnected) break
			if (!response.write(Buffer.from(value))) await waitForDrain()
		}
		if (!disconnected) response.end()
	} catch (error) {
		await reader.cancel(error).catch(() => undefined)
		throw error
	} finally {
		response.off("close", onClose)
		reader.releaseLock()
	}
}

export const resolveAddress = (
	address: AddressInfo,
	host: string,
): { host: string; port: number } => ({
	host:
		address.address === "::" || address.address === "0.0.0.0"
			? host
			: address.address,
	port: address.port,
})
