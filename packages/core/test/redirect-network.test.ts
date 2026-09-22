import { createServer, type Server } from "node:http"
import { afterEach, describe, expect, test } from "vitest"
import {
	exchangeOpenAIOAuthCode,
	refreshOpenAIOAuthTokens,
} from "../src/runtime.js"

const servers: Server[] = []
const listen = async (server: Server): Promise<string> => {
	servers.push(server)
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(0, "127.0.0.1", resolve)
	})
	const address = server.address()
	if (!address || typeof address === "string")
		throw new Error("Missing test listener")
	return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(async (server) => {
			server.closeAllConnections()
			await new Promise<void>((resolve) => server.close(() => resolve()))
		}),
	)
})

describe("OAuth token redirect policy on a loopback network", () => {
	test.each([
		302, 303, 307, 308,
	])("rejects same/cross-origin HTTP %s without replaying token bodies", async (status) => {
		let destinationRequests = 0
		const target = await listen(
			createServer((_request, response) => {
				destinationRequests++
				response.end('{"access_token":"unexpected"}')
			}),
		)
		let location = ""
		const origin = await listen(
			createServer((request, response) => {
				if (request.url === "/destination") {
					destinationRequests++
					response.end('{"access_token":"unexpected"}')
					return
				}
				response.writeHead(status, { location })
				response.end()
			}),
		)
		for (const destination of [
			`${origin}/destination`,
			`${target}/destination`,
		]) {
			location = destination
			await expect(
				refreshOpenAIOAuthTokens({
					tokenUrl: `${origin}/token`,
					refreshToken: "synthetic-private-refresh",
				}),
			).rejects.toThrow()
			await expect(
				exchangeOpenAIOAuthCode({
					tokenUrl: `${origin}/token`,
					code: "synthetic-code",
					codeVerifier: "synthetic-verifier",
					redirectUri: "http://localhost/callback",
				}),
			).rejects.toThrow()
		}
		expect(destinationRequests).toBe(0)
	})
})
