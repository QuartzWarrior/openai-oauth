import { createHash, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import {
	createOpenAIOAuth,
	type OpenAIOAuthProvider,
} from "@openai-oauth/ai-sdk"
import {
	createOpenAIOAuthTransport,
	type OpenAIOAuthTransport,
} from "@openai-oauth/core"
import { openaiCredentials } from "@openai-oauth/local"
import { handleChatCompletionsRequest } from "./chat-completions.js"
import {
	handleImageEditRequest,
	handleImageGenerationRequest,
} from "./images.js"
import { createRequestLogger } from "./logging.js"
import { createModelResolver } from "./models.js"
import {
	handlePoolDiagnosticsRequest,
	type PoolDiagnosticsSource,
} from "./pool-diagnostics.js"
import { handleResponsesRequest } from "./responses.js"
import {
	DEFAULT_HOST,
	DEFAULT_MAX_REQUEST_BODY_BYTES,
	DEFAULT_PORT,
	limitRequestBody,
	RequestBodyTooLargeError,
	resolveAddress,
	toErrorResponse,
	toJsonResponse,
	toWebRequest,
	writeWebResponse,
} from "./shared.js"
import type {
	OpenAIOAuthServerOptions,
	RunningOpenAIOAuthServer,
} from "./types.js"

const handleRoutes = async (
	request: Request,
	provider: OpenAIOAuthProvider,
	client: OpenAIOAuthTransport,
	resolveModels: () => Promise<string[]>,
	requestLogger: ReturnType<typeof createRequestLogger>,
	poolDiagnostics?: PoolDiagnosticsSource,
): Promise<Response> => {
	const url = new URL(request.url)
	if (poolDiagnostics && url.pathname.startsWith("/pool/")) {
		const response = await handlePoolDiagnosticsRequest(
			request,
			poolDiagnostics,
		)
		if (response) return response
	}
	if (request.method === "GET" && url.pathname === "/health") {
		return toJsonResponse({
			ok: true,
			replay_state: "stateless",
		})
	}

	if (request.method === "GET" && url.pathname === "/v1/models") {
		try {
			const models = await resolveModels()
			return toJsonResponse({
				object: "list",
				data: models.map((id) => ({
					id,
					object: "model",
					created: 0,
					owned_by: "codex-oauth",
				})),
			})
		} catch {
			return toErrorResponse("Failed to load models.", 502, "upstream_error")
		}
	}

	if (request.method === "POST" && url.pathname === "/v1/responses") {
		return handleResponsesRequest(request, client)
	}

	if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
		return handleChatCompletionsRequest(request, provider, requestLogger)
	}

	if (request.method === "POST" && url.pathname === "/v1/images/generations") {
		return handleImageGenerationRequest(request, client)
	}

	if (request.method === "POST" && url.pathname === "/v1/images/edits") {
		return handleImageEditRequest(request, client)
	}

	return toErrorResponse("Route not found.", 404, "not_found_error")
}

const createOpenAIOAuthRuntime = (settings: OpenAIOAuthServerOptions = {}) => {
	const {
		credentials,
		poolDiagnostics,
		deferModelDiscovery,
		accessToken,
		authorizeRequest,
		maxRequestBodyBytes = DEFAULT_MAX_REQUEST_BODY_BYTES,
		...localSettings
	} = settings
	if (!Number.isSafeInteger(maxRequestBodyBytes) || maxRequestBodyBytes <= 0) {
		throw new Error("maxRequestBodyBytes must be a positive integer.")
	}
	if (
		accessToken !== undefined &&
		(!accessToken.trim() || /\s/.test(accessToken))
	) {
		throw new Error(
			"accessToken must be a nonempty Bearer token without whitespace.",
		)
	}
	const tokenDigest =
		accessToken === undefined
			? undefined
			: createHash("sha256").update(accessToken).digest()
	const auth = credentials ?? openaiCredentials(localSettings)
	const sharedSettings = {
		...localSettings,
		auth: () => auth.getSession(),
		baseURL: localSettings.baseURL ?? auth.baseURL,
		fetch: localSettings.fetch ?? auth.fetch,
		headers: localSettings.headers ?? auth.headers,
		instructions: localSettings.instructions ?? auth.instructions,
		openAIBaseURL: localSettings.openAIBaseURL ?? auth.openAIBaseURL,
		responsesState: false as const,
	}
	if (
		auth.transport &&
		[
			"baseURL",
			"fetch",
			"headers",
			"instructions",
			"openAIBaseURL",
			"codexVersion",
		].some(
			(key) => localSettings[key as keyof typeof localSettings] !== undefined,
		)
	)
		throw new Error(
			"Configure transport overrides on the supplied ready credential transport, not on the server.",
		)
	const client = auth.transport ?? createOpenAIOAuthTransport(sharedSettings)
	const provider = createOpenAIOAuth(client)
	const resolveModels = createModelResolver(client, localSettings.models)
	const requestLogger = createRequestLogger(localSettings)

	const handler = async (request: Request): Promise<Response> => {
		const responseFor = (response: Response) => {
			if (new URL(request.url).pathname.startsWith("/pool/"))
				response.headers.set("cache-control", "no-store")
			return response
		}
		let boundedRequest: Request | undefined
		try {
			request.signal.throwIfAborted()
			const bearer = /^Bearer ([^\s]+)$/i.exec(
				request.headers.get("authorization") ?? "",
			)?.[1]
			const allowedToken =
				tokenDigest === undefined ||
				(bearer !== undefined &&
					timingSafeEqual(
						tokenDigest,
						createHash("sha256").update(bearer).digest(),
					))
			const authorizationRequest = new Request(request.url, {
				method: request.method,
				headers: request.headers,
				signal: request.signal,
			})
			if (
				!allowedToken ||
				(authorizeRequest && !(await authorizeRequest(authorizationRequest)))
			) {
				void request.body?.cancel().catch(() => undefined)
				const response = toErrorResponse(
					"Unauthorized.",
					401,
					"authentication_error",
				)
				response.headers.set("www-authenticate", "Bearer")
				return responseFor(response)
			}
			request.signal.throwIfAborted()
			boundedRequest = limitRequestBody(request, maxRequestBodyBytes)
			return responseFor(
				await handleRoutes(
					boundedRequest,
					provider,
					client,
					resolveModels,
					requestLogger,
					poolDiagnostics,
				),
			)
		} catch (error) {
			if (request.signal.aborted)
				return responseFor(
					toErrorResponse("Request aborted.", 499, "request_aborted"),
				)
			if (error instanceof RequestBodyTooLargeError)
				return responseFor(toErrorResponse(error.message, 413))
			if (error instanceof SyntaxError)
				return responseFor(toErrorResponse("Request body must be valid JSON."))
			return responseFor(
				toErrorResponse("Unexpected server error.", 500, "server_error"),
			)
		} finally {
			const body = (boundedRequest ?? request).body
			if (body && !body.locked) void body.cancel().catch(() => undefined)
		}
	}

	return { deferModelDiscovery, handler, resolveModels }
}

export const createOpenAIOAuthFetchHandler = (
	settings: OpenAIOAuthServerOptions = {},
): ((request: Request) => Promise<Response>) =>
	createOpenAIOAuthRuntime(settings).handler

export const startOpenAIOAuthServer = async (
	settings: OpenAIOAuthServerOptions = {},
): Promise<RunningOpenAIOAuthServer> => {
	const host = settings.host ?? DEFAULT_HOST
	const port = settings.port ?? DEFAULT_PORT
	const runtime = createOpenAIOAuthRuntime(settings)
	const models = runtime.deferModelDiscovery
		? (settings.models ?? [])
		: await runtime.resolveModels()
	const handler = runtime.handler
	const server = createServer(async (req, res) => {
		const controller = new AbortController()
		const abort = () =>
			controller.abort(new DOMException("Client disconnected.", "AbortError"))
		const onClose = () => {
			if (!res.writableEnded) abort()
		}
		req.once("aborted", abort)
		res.once("close", onClose)
		try {
			const request = await toWebRequest(req, {
				host,
				port,
				signal: controller.signal,
			})
			const response = await handler(request)
			// Do not retain unread upload bytes after an early rejection.
			if (!req.complete) {
				response.headers.set("connection", "close")
				res.shouldKeepAlive = false
			}
			await writeWebResponse(res, response)
		} catch (error) {
			if (res.headersSent || res.writableEnded || res.destroyed) {
				res.destroy(error instanceof Error ? error : undefined)
				return
			}
			try {
				await writeWebResponse(
					res,
					toErrorResponse("Unexpected server error.", 500, "server_error"),
				)
			} catch {
				res.destroy()
			}
		} finally {
			req.off("aborted", abort)
			res.off("close", onClose)
		}
	})

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(port, host, () => {
			server.off("error", reject)
			resolve()
		})
	})

	const address = resolveAddress(server.address() as AddressInfo, host)
	return {
		server,
		host: address.host,
		port: address.port,
		url: `http://${address.host.includes(":") ? `[${address.host}]` : address.host}:${address.port}/v1`,
		models,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error)
						return
					}

					resolve()
				})
			}),
	}
}
