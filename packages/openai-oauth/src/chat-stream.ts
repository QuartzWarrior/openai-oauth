import type { OpenAIOAuthProvider } from "@openai-oauth/ai-sdk"
import { streamText, type TextStreamPart, type ToolSet } from "ai"
import {
	createToolSet,
	toModelMessages,
	toToolChoice,
} from "./chat-messages.js"
import { resolveChatOutputLimit } from "./chat-output-limit.js"
import { describeChatError, emitRequestLog } from "./logging.js"
import {
	mapFinishReason,
	sseHeaders,
	toErrorResponse,
	toUsage,
} from "./shared.js"
import type {
	ChatRequest,
	OpenAIOAuthServerLogEvent,
	UsageLike,
} from "./types.js"
import {
	describeUpstreamError,
	toUpstreamErrorBody,
	toUpstreamErrorResponse,
} from "./upstream-error.js"

const encodeSse = (data: unknown): Uint8Array =>
	new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`)

const encodeDone = (): Uint8Array =>
	new TextEncoder().encode("data: [DONE]\n\n")

const logChatStreamResult = (
	logger: ((event: OpenAIOAuthServerLogEvent) => void) | undefined,
	requestId: string,
	startedAt: number,
	finishReason: string,
	usage: UsageLike,
) => {
	emitRequestLog(logger, {
		type: "chat_response",
		requestId,
		path: "/v1/chat/completions",
		status: 200,
		stream: true,
		durationMs: Date.now() - startedAt,
		finishReason,
		usage,
	})
}

export const streamChatCompletions = async (
	request: ChatRequest,
	provider: OpenAIOAuthProvider,
	logContext: {
		logger?: (event: OpenAIOAuthServerLogEvent) => void
		requestId: string
		startedAt: number
	},
	signal?: AbortSignal,
): Promise<Response> => {
	const outputLimit = resolveChatOutputLimit(request)
	if (outputLimit.error !== undefined) {
		return toErrorResponse(outputLimit.error)
	}
	const abortController = new AbortController()
	const abort = () => abortController.abort(signal?.reason)
	if (signal?.aborted) abort()
	const toolIndexes = new Map<string, number>()
	const toolsWithDeltas = new Set<string>()
	const created = Math.floor(Date.now() / 1000)
	const id = `chatcmpl_${crypto.randomUUID()}`
	const result = streamText({
		abortSignal: abortController.signal,
		model: provider(request.model ?? "gpt-5.2"),
		messages: toModelMessages(request.messages ?? []),
		tools: createToolSet(request.tools),
		toolChoice: toToolChoice(request.tool_choice),
		temperature: request.temperature,
		topP: request.top_p,
		stopSequences:
			typeof request.stop === "string"
				? [request.stop]
				: Array.isArray(request.stop)
					? request.stop
					: undefined,
		maxOutputTokens: outputLimit.maxOutputTokens,
		providerOptions: {
			openai: {
				parallelToolCalls: request.parallel_tool_calls,
				reasoningEffort: request.reasoning_effort,
			},
		},
	})
	signal?.addEventListener("abort", abort, { once: true })
	if (signal?.aborted) abort()

	const logError = (error: unknown) =>
		emitRequestLog(logContext.logger, {
			type: "chat_error",
			requestId: logContext.requestId,
			path: "/v1/chat/completions",
			durationMs: Date.now() - logContext.startedAt,
			...describeChatError(error),
		})

	// Hold the 200 until the first real part, so failures before any output
	// (upstream 4xx, `response.failed`) reach the caller as an HTTP status.
	const parts = result.fullStream[Symbol.asyncIterator]()
	const buffered: Array<TextStreamPart<ToolSet>> = []
	for (;;) {
		const next = await parts.next()
		if (next.done) break
		buffered.push(next.value)
		if (next.value.type !== "start" && next.value.type !== "start-step") break
	}
	const early = buffered.at(-1)
	if (early?.type === "abort") {
		signal?.removeEventListener("abort", abort)
		abortController.signal.throwIfAborted()
		throw new Error("Streaming chat completion was aborted.")
	}
	if (early?.type === "error") {
		signal?.removeEventListener("abort", abort)
		logError(early.error)
		const response = toUpstreamErrorResponse(early.error)
		if (response) return response
		throw early.error
	}
	const allParts = async function* () {
		yield* buffered
		yield* { [Symbol.asyncIterator]: () => parts }
	}

	const chunks = async function* () {
		yield encodeSse({
			id,
			object: "chat.completion.chunk",
			created,
			model: request.model,
			choices: [
				{ index: 0, delta: { role: "assistant" }, finish_reason: null },
			],
		})

		for await (const part of allParts()) {
			switch (part.type) {
				case "text-delta":
					yield encodeSse({
						id,
						object: "chat.completion.chunk",
						created,
						model: request.model,
						choices: [
							{
								index: 0,
								delta: { content: part.text },
								finish_reason: null,
							},
						],
					})
					break
				case "tool-input-start": {
					const nextIndex = toolIndexes.size
					toolIndexes.set(part.id, nextIndex)
					yield encodeSse({
						id,
						object: "chat.completion.chunk",
						created,
						model: request.model,
						choices: [
							{
								index: 0,
								delta: {
									tool_calls: [
										{
											index: nextIndex,
											id: part.id,
											type: "function",
											function: { name: part.toolName, arguments: "" },
										},
									],
								},
								finish_reason: null,
							},
						],
					})
					break
				}
				case "tool-input-delta": {
					const index = toolIndexes.get(part.id)
					if (index == null) {
						break
					}
					toolsWithDeltas.add(part.id)

					yield encodeSse({
						id,
						object: "chat.completion.chunk",
						created,
						model: request.model,
						choices: [
							{
								index: 0,
								delta: {
									tool_calls: [{ index, function: { arguments: part.delta } }],
								},
								finish_reason: null,
							},
						],
					})
					break
				}
				case "tool-call": {
					// Some models (e.g. gpt-5.3-codex-spark) return tool call
					// arguments in one shot without streaming deltas. When no
					// tool-input-delta events were emitted, emit the complete
					// arguments from the final tool-call event.
					const index = toolIndexes.get(part.toolCallId)
					if (index == null || toolsWithDeltas.has(part.toolCallId)) {
						break
					}

					yield encodeSse({
						id,
						object: "chat.completion.chunk",
						created,
						model: request.model,
						choices: [
							{
								index: 0,
								delta: {
									tool_calls: [
										{
											index,
											function: {
												arguments: JSON.stringify(part.input),
											},
										},
									],
								},
								finish_reason: null,
							},
						],
					})
					break
				}
				case "finish":
					logChatStreamResult(
						logContext.logger,
						logContext.requestId,
						logContext.startedAt,
						part.finishReason,
						part.totalUsage,
					)
					yield encodeSse({
						id,
						object: "chat.completion.chunk",
						created,
						model: request.model,
						choices: [
							{
								index: 0,
								delta: {},
								finish_reason: mapFinishReason(part.finishReason),
							},
						],
					})
					yield encodeSse({
						id,
						object: "chat.completion.chunk",
						created,
						model: request.model,
						choices: [],
						usage: toUsage(part.totalUsage),
					})
					break
				case "error": {
					logError(part.error)
					// Headers are already sent: report upstream failures in-band the
					// way OpenAI does, and end the stream without [DONE].
					const upstream = describeUpstreamError(part.error)
					if (upstream) {
						yield encodeSse(toUpstreamErrorBody(upstream))
						return
					}
					throw part.error instanceof Error
						? part.error
						: new Error("Streaming chat completion failed.")
				}
			}
		}

		yield encodeDone()
	}
	const iterator = chunks()
	const cleanup = () => signal?.removeEventListener("abort", abort)
	const stream = new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				try {
					abortController.signal.throwIfAborted()
					const { value, done } = await iterator.next()
					abortController.signal.throwIfAborted()
					if (done) {
						cleanup()
						controller.close()
					} else controller.enqueue(value)
				} catch (error) {
					cleanup()
					abortController.abort(error)
					controller.error(error)
				}
			},
			cancel(reason) {
				cleanup()
				abortController.abort(reason)
				void iterator.return().catch(() => undefined)
			},
		},
		{ highWaterMark: 0 },
	)

	return new Response(stream, {
		status: 200,
		headers: sseHeaders,
	})
}
