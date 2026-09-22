import { describe, expect, test, vi } from "vitest"
import { createOpenAIOAuthTransport } from "../src/runtime.js"

const session = { accountId: "owner", accessToken: "token" }

describe("Responses MIME parsing", () => {
	test.each([
		"application/json",
		"Application/JSON",
		"APPLICATION/JSON; Charset=UTF-8",
	])("normalizes %s requests before the custom executor", async (contentType) => {
		const executor = vi.fn(async (_url: string, init: RequestInit) => {
			expect(JSON.parse(String(init.body))).toMatchObject({
				stream: true,
				store: false,
				input: [
					{ role: "user", content: [{ type: "input_text", text: "hello" }] },
				],
			})
			return new Response(
				'data: {"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}\n\n',
				{
					headers: { "content-type": "text/event-stream" },
				},
			)
		})
		const transport = createOpenAIOAuthTransport({
			auth: session,
			codexVersion: "0.154.0",
			fetch: async (url) => {
				if (String(url).includes("/models?"))
					return Response.json({ models: [{ slug: "m" }] })
				throw new Error("Responses must use the prepared executor")
			},
			executeResponses: executor,
		})
		const response = await transport.request("responses", {
			method: "POST",
			headers: { "content-type": contentType },
			body: JSON.stringify({ model: "m", input: "hello", stream: false }),
		})
		expect(executor).toHaveBeenCalledOnce()
		expect(response.headers.get("content-type")).toBe("application/json")
		await expect(response.json()).resolves.toMatchObject({
			id: "r",
			status: "completed",
		})
	})
})
