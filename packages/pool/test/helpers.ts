import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

type ClaimSet = Record<string, unknown>

const base64Url = (value: string): string =>
	Buffer.from(value, "utf-8")
		.toString("base64")
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "")

export const makeJwt = (claims?: ClaimSet): string => {
	const nowSeconds = Math.floor(Date.now() / 1000)
	return [
		base64Url(JSON.stringify({ alg: "none", typ: "JWT" })),
		base64Url(
			JSON.stringify({
				exp: nowSeconds + 60 * 60,
				...claims,
			}),
		),
		base64Url("sig"),
	].join(".")
}

export type FakeAuthFileOptions = {
	accountId: string
	accessToken?: string
}

/**
 * Writes a Codex-shaped auth.json into a fresh temp directory and returns its
 * path. Tokens are long-lived + have no last_refresh, so loadAuthTokens never
 * attempts a network refresh.
 */
export const makeAuthFile = (options: FakeAuthFileOptions): string => {
	const dir = mkdtempSync(path.join(tmpdir(), "openai-oauth-pool-test-"))
	const filePath = path.join(dir, "auth.json")
	const accessToken =
		options.accessToken ??
		makeJwt({
			"https://api.openai.com/auth": {
				chatgpt_account_id: options.accountId,
			},
		})
	writeFileSync(
		filePath,
		JSON.stringify({
			auth_mode: "chatgpt",
			tokens: {
				id_token: makeJwt({ sub: options.accountId }),
				access_token: accessToken,
				account_id: options.accountId,
			},
		}),
		"utf-8",
	)
	return filePath
}

export const makeResponsesBody = (
	overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
	model: "gpt-5-codex",
	instructions: "You are helpful.",
	input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
	...overrides,
})

/**
 * Full Codex-style request init for the pool's /responses path, including the
 * `stream: true` the transport forces and a stable input the session hasher
 * can pin. Pass `undefined`/a custom text to produce distinct bodies.
 */
export const makeRequestInit = (
	overrides: Record<string, unknown> = {},
): RequestInit => ({
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify(makeResponsesBody(overrides)),
})

export const makeResponseInit = (
	status = 200,
	headers: Record<string, string> = {},
): ResponseInit => ({
	status,
	headers: {
		"content-type": "application/json",
		...headers,
	},
})

export const okJsonResponse = (
	body: Record<string, unknown>,
	headers: Record<string, string> = {},
): Response =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json", ...headers },
	})

export const makeSseResponse = (
	responseId: string,
	headers: Record<string, string> = {},
): Response => {
	const responseObject = {
		id: responseId,
		object: "response",
		status: "completed",
		output: [],
	}
	const body = [
		`event: response.created\ndata: ${JSON.stringify({ response: { ...responseObject, status: "in_progress" } })}\n`,
		`event: response.completed\ndata: ${JSON.stringify({ response: responseObject })}\n`,
		"data: [DONE]\n",
	].join("\n")
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream", ...headers },
	})
}

export const errorJsonResponse = (
	status: number,
	body: Record<string, unknown>,
	headers: Record<string, string> = {},
): Response =>
	new Response(JSON.stringify(body), makeResponseInit(status, headers))

export const makeModelsListResponse = (): Response =>
	okJsonResponse({ models: [] })
