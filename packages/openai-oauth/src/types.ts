import type { Server as HttpServer } from "node:http"
import type { OpenAIOAuth } from "@openai-oauth/core"
import type { LocalOpenAIOAuthOptions } from "@openai-oauth/local"
import type { PoolDiagnosticsSource } from "./pool-diagnostics.js"

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| JsonObject
export type JsonObject = { [key: string]: JsonValue }

export type ToolOutputValue =
	| {
			type: "json"
			value: JsonValue
	  }
	| {
			type: "text"
			value: string
	  }

export type ChatToolDefinition = {
	type?: string
	function?: {
		name?: string
		description?: string
		parameters?: JsonObject
		strict?: boolean
	}
}

export type ChatToolChoice =
	| "auto"
	| "none"
	| "required"
	| {
			type?: string
			function?: {
				name?: string
			}
	  }

export type ChatMessage = {
	role?: string
	content?: unknown
	tool_calls?: Array<{
		id?: string
		type?: string
		function?: {
			name?: string
			arguments?: string
		}
	}>
	tool_call_id?: string
}

export type ChatRequest = {
	model?: string
	messages?: ChatMessage[]
	stream?: boolean
	/** Only text format is currently supported by this Chat translation. */
	response_format?: { type?: string }
	tools?: ChatToolDefinition[]
	tool_choice?: ChatToolChoice
	temperature?: number
	top_p?: number
	stop?: string | string[]
	/** Legacy alias for max_completion_tokens. */
	max_tokens?: number
	/** Enforced by the upstream Responses output cap; maximum 128,000. */
	max_completion_tokens?: number
	parallel_tool_calls?: boolean
	reasoning_effort?:
		| "none"
		| "minimal"
		| "low"
		| "medium"
		| "high"
		| "xhigh"
		| "max"
		| "ultra"
}

export type ChatRequestSummary = {
	bodyKeys: string[]
	messageCount: number
	messageRoles: string[]
	model?: string
	reasoningEffort?: ChatRequest["reasoning_effort"]
	stream: boolean
	toolCount: number
}

type UsageLike = {
	inputTokens?: number
	outputTokens?: number
	totalTokens?: number
	reasoningTokens?: number
	cachedInputTokens?: number
}

export type OpenAIOAuthServerLogEvent =
	| ({
			type: "chat_request"
			requestId: string
			path: "/v1/chat/completions"
	  } & ChatRequestSummary)
	| {
			type: "chat_response"
			durationMs: number
			finishReason?: string
			path: "/v1/chat/completions"
			requestId: string
			status: number
			stream: boolean
			usage: UsageLike
	  }
	| {
			type: "chat_error"
			durationMs: number
			message: string
			path: "/v1/chat/completions"
			requestId: string
	  }

export type OpenAIOAuthServerOptions = LocalOpenAIOAuthOptions & {
	/**
	 * Optional credential source. When omitted, the server reads one local auth
	 * file using the regular LocalOpenAIOAuthOptions. Supplying a credential
	 * source makes it possible to serve a pooled or otherwise custom account
	 * source while retaining the same OpenAI-compatible HTTP API.
	 */
	credentials?: OpenAIOAuth
	/** Opt-in /pool inspection routes; the existing authorizer grants access to all accounts. */
	poolDiagnostics?: PoolDiagnosticsSource
	/**
	 * Start listening before fetching the account's model catalog. The catalog is
	 * still resolved on the first GET /v1/models request. Defaults to false.
	 */
	deferModelDiscovery?: boolean
	/** Optional downstream Bearer token, checked before reading any request body. */
	accessToken?: string
	/** Additional header-only authorization check. Applied to every route. */
	authorizeRequest?: (request: Request) => boolean | Promise<boolean>
	/** Maximum request body size in bytes. Defaults to 16 MiB; positive integer. */
	maxRequestBodyBytes?: number
	host?: string
	port?: number
	models?: string[]
	codexVersion?: string
	requestLogger?: (event: OpenAIOAuthServerLogEvent) => void
}

export type RunningOpenAIOAuthServer = {
	server: HttpServer
	host: string
	port: number
	url: string
	models: string[]
	close: () => Promise<void>
}

export type ChatCompletionResultShape = {
	text: string
	finishReason: string
	toolCalls: Array<{
		toolCallId: string
		toolName: string
		input: unknown
	}>
	usage: UsageLike
}

export type { UsageLike }
