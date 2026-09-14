type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value)

export type ResponseIdFork = {
	response: Response
	id: Promise<string | undefined>
}

const MAX_SCAN_BYTES = 64 * 1024
const MAX_SCAN_LINES = 200

const responseIdFromJson = async (
	response: Response,
): Promise<string | undefined> => {
	try {
		const parsed: unknown = await response.clone().json()
		if (isRecord(parsed) && typeof parsed.id === "string") {
			return parsed.id
		}
	} catch {}
	return undefined
}

const scanStreamForResponseId = async (
	stream: ReadableStream<Uint8Array>,
): Promise<string | undefined> => {
	const reader = stream.getReader()
	const decoder = new TextDecoder()
	let buffered = ""
	let scannedBytes = 0
	let scannedLines = 0

	const finish = async (
		id: string | undefined,
	): Promise<string | undefined> => {
		// Stop draining: the caller's branch keeps flowing without buffering.
		await reader.cancel().catch(() => undefined)
		return id
	}

	try {
		while (true) {
			const { value, done } = await reader.read()
			if (done) {
				return undefined
			}
			if (value) {
				scannedBytes += value.byteLength
				buffered += decoder.decode(value, { stream: true })
			}

			let newlineIndex = buffered.indexOf("\n")
			while (newlineIndex !== -1) {
				const line = buffered.slice(0, newlineIndex).trim()
				buffered = buffered.slice(newlineIndex + 1)
				scannedLines += 1

				if (line.startsWith("data:")) {
					const payload = line.slice("data:".length).trim()
					if (payload !== "[DONE]") {
						try {
							const parsed: unknown = JSON.parse(payload)
							if (isRecord(parsed) && typeof parsed.id === "string") {
								return await finish(parsed.id)
							}
						} catch {}
					}
				}

				if (scannedLines >= MAX_SCAN_LINES || scannedBytes >= MAX_SCAN_BYTES) {
					return await finish(undefined)
				}
				newlineIndex = buffered.indexOf("\n")
			}
		}
	} catch {
		return undefined
	}
}

/**
 * Splits a `/responses` payload so the pool can learn the upstream response id
 * (needed to validate pinned `previous_response_id` chains) without delaying
 * or consuming the body the caller receives. Non-streaming JSON is cloned;
 * SSE streams are teed and only scanned until the first `response.created`
 * event yields an id, then the scan branch is cancelled.
 */
export const forkForResponseIdCapture = (
	response: Response,
): ResponseIdFork => {
	const contentType = response.headers.get("content-type") ?? ""

	if (contentType.includes("application/json")) {
		return { response, id: responseIdFromJson(response) }
	}

	if (!response.body || !contentType.includes("text/event-stream")) {
		return { response, id: Promise.resolve(undefined) }
	}

	const [returnedBody, scanBody] = response.body.tee()
	return {
		response: new Response(returnedBody, {
			status: response.status,
			statusText: response.statusText,
			headers: new Headers(response.headers),
		}),
		id: scanStreamForResponseId(scanBody),
	}
}
