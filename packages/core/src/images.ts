import { isRecord } from "./utils.js"

export const CODEX_IMAGE_MODEL = "gpt-image-2"

const MAX_REFERENCE_IMAGES = 5
const MAX_REFERENCE_IMAGE_BYTES = 50 * 1024 * 1024

/** Local memory budgets, not upstream entitlement or context limits. */
export type CodexImageLimits = {
	maxReferenceImageBytes?: number
	maxTotalImageBytes?: number
	maxEncodedBodyBytes?: number
}
const resolveLimits = (limits: CodexImageLimits) => {
	const resolved = {
		maxReferenceImageBytes:
			limits.maxReferenceImageBytes ?? MAX_REFERENCE_IMAGE_BYTES,
		maxTotalImageBytes: limits.maxTotalImageBytes ?? MAX_REFERENCE_IMAGE_BYTES,
		maxEncodedBodyBytes: limits.maxEncodedBodyBytes ?? 70 * 1024 * 1024,
	}
	for (const value of Object.values(resolved)) {
		if (!Number.isSafeInteger(value) || value <= 0)
			throw new Error("Image byte limits must be positive safe integers.")
	}
	return resolved
}
const optionError = (body: Record<string, unknown>): string | undefined => {
	if (
		body.n !== undefined &&
		(typeof body.n !== "number" || !Number.isSafeInteger(body.n) || body.n < 1)
	)
		return "`n` must be a positive safe integer."
	if (
		body.background !== undefined &&
		!["auto", "opaque", "transparent"].includes(String(body.background))
	)
		return "`background` must be auto, opaque, or transparent."
	if (
		body.quality !== undefined &&
		!["auto", "low", "medium", "high"].includes(String(body.quality))
	)
		return "`quality` must be auto, low, medium, or high."
	for (const key of ["model", "background", "quality", "size"]) {
		if (
			body[key] !== undefined &&
			(typeof body[key] !== "string" || !(body[key] as string).trim())
		)
			return `\`${key}\` must be a non-empty string.`
	}
	if (body.stream !== undefined && typeof body.stream !== "boolean")
		return "`stream` must be a boolean."
	return undefined
}
const unsupportedOptions = [
	"input_fidelity",
	"moderation",
	"output_compression",
	"output_format",
	"partial_images",
] as const

export type PreparedCodexImageRequest = {
	body: BodyInit | null | undefined
	response?: Response
}

const errorResponse = (message: string): Response =>
	Response.json(
		{
			error: {
				message,
				type: "invalid_request_error",
			},
		},
		{ status: 400 },
	)

const bytesToBase64 = (bytes: Uint8Array): string => {
	let binary = ""
	const chunkSize = 0x8000
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
	}
	return btoa(binary)
}

const fileToDataUrl = async (file: Blob): Promise<string> => {
	const bytes = new Uint8Array(await file.arrayBuffer())
	return `data:${file.type || "image/png"};base64,${bytesToBase64(bytes)}`
}

const decodeBody = async (
	body: BodyInit | null | undefined,
): Promise<string | undefined> => {
	if (typeof body === "string") return body
	if (body instanceof Blob) return body.text()
	if (body instanceof ArrayBuffer) return new TextDecoder().decode(body)
	if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body)
	return undefined
}

const normalizeGeneration = (
	body: Record<string, unknown>,
): PreparedCodexImageRequest => {
	if (body.stream === true) {
		return {
			body: undefined,
			response: errorResponse(
				"Streaming image generation is not supported by ChatGPT OAuth.",
			),
		}
	}
	if (typeof body.prompt !== "string" || body.prompt.length === 0) {
		return {
			body: undefined,
			response: errorResponse("`prompt` must be a non-empty string."),
		}
	}
	const unsupported = unsupportedOptions.find((key) => body[key] !== undefined)
	if (unsupported) {
		return {
			body: undefined,
			response: errorResponse(
				`\`${unsupported}\` is not supported by ChatGPT OAuth image generation.`,
			),
		}
	}
	if (
		body.response_format !== undefined &&
		body.response_format !== "b64_json"
	) {
		return {
			body: undefined,
			response: errorResponse(
				"ChatGPT OAuth image generation only returns `b64_json`.",
			),
		}
	}

	const validationError = optionError(body)
	if (validationError)
		return { body: undefined, response: errorResponse(validationError) }
	const normalized: Record<string, unknown> = {
		model:
			typeof body.model === "string" && body.model.length > 0
				? body.model
				: CODEX_IMAGE_MODEL,
		prompt: body.prompt,
	}
	for (const key of ["background", "n", "quality", "size"] as const) {
		if (body[key] !== undefined) normalized[key] = body[key]
	}

	return { body: JSON.stringify(normalized) }
}

const normalizeEdit = async (
	body: FormData,
	limits: ReturnType<typeof resolveLimits>,
): Promise<PreparedCodexImageRequest> => {
	if (body.get("stream") === "true") {
		return {
			body: undefined,
			response: errorResponse(
				"Streaming image editing is not supported by ChatGPT OAuth.",
			),
		}
	}
	if (body.has("mask")) {
		return {
			body: undefined,
			response: errorResponse(
				"Image masks are not supported by ChatGPT OAuth.",
			),
		}
	}

	const prompt = body.get("prompt")
	if (typeof prompt !== "string" || prompt.length === 0) {
		return {
			body: undefined,
			response: errorResponse("`prompt` must be a non-empty string."),
		}
	}

	const files = [...body.getAll("image"), ...body.getAll("image[]")].filter(
		(value): value is File => typeof value !== "string",
	)
	if (files.length === 0 || files.length > MAX_REFERENCE_IMAGES) {
		return {
			body: undefined,
			response: errorResponse(
				files.length === 0
					? "At least one `image` is required."
					: "ChatGPT OAuth supports at most 5 reference images.",
			),
		}
	}
	const oversized = files.find(
		(file) => file.size > limits.maxReferenceImageBytes,
	)
	if (oversized) {
		return {
			body: undefined,
			response: errorResponse(
				"A reference image exceeds the configured per-file byte limit.",
			),
		}
	}
	if (
		files.reduce((sum, file) => sum + file.size, 0) > limits.maxTotalImageBytes
	) {
		return {
			body: undefined,
			response: errorResponse(
				"Reference images exceed the configured total byte limit.",
			),
		}
	}
	const unsupported = unsupportedOptions.find((key) => body.has(key))
	if (unsupported) {
		return {
			body: undefined,
			response: errorResponse(
				`\`${unsupported}\` is not supported by ChatGPT OAuth image editing.`,
			),
		}
	}
	const responseFormat = body.get("response_format")
	if (responseFormat !== null && responseFormat !== "b64_json") {
		return {
			body: undefined,
			response: errorResponse(
				"ChatGPT OAuth image editing only returns `b64_json`.",
			),
		}
	}

	const fields: Record<string, unknown> = {}
	for (const key of ["model", "n", "background", "quality", "size", "stream"]) {
		const entries = body.getAll(key)
		if (entries.length > 1)
			return {
				body: undefined,
				response: errorResponse(
					`Duplicate \`${key}\` fields are not supported.`,
				),
			}
		if (entries.length === 0) continue
		const value = entries[0]
		if (typeof value !== "string")
			return {
				body: undefined,
				response: errorResponse(`\`${key}\` must be a text field.`),
			}
		fields[key] =
			key === "n"
				? value.trim()
					? Number(value)
					: Number.NaN
				: key === "stream"
					? value === "false"
						? false
						: value === "true"
							? true
							: value
					: value
	}
	const validationError = optionError(fields)
	if (validationError)
		return { body: undefined, response: errorResponse(validationError) }
	const normalized: Record<string, unknown> = {
		images: files.map((file) => ({
			image_url: `data:${file.type || "image/png"};base64,`,
		})),
		model: fields.model ?? CODEX_IMAGE_MODEL,
		prompt,
	}
	for (const key of ["n", "background", "quality", "size"]) {
		if (fields[key] !== undefined) normalized[key] = fields[key]
	}
	const encodedBytes =
		new TextEncoder().encode(JSON.stringify(normalized)).byteLength +
		files.reduce((sum, file) => sum + 4 * Math.ceil(file.size / 3), 0)
	if (encodedBytes > limits.maxEncodedBodyBytes)
		return {
			body: undefined,
			response: errorResponse(
				"Encoded image request exceeds the configured byte limit.",
			),
		}
	const images: Array<{ image_url: string }> = []
	// Do not materialize every file's binary buffer concurrently.
	for (const file of files)
		images.push({ image_url: await fileToDataUrl(file) })
	normalized.images = images
	return { body: JSON.stringify(normalized) }
}

export const prepareCodexImageRequest = async (
	pathname: string,
	headers: Headers,
	body: BodyInit | null | undefined,
	options: CodexImageLimits = {},
): Promise<PreparedCodexImageRequest> => {
	const limits = resolveLimits(options)
	if (pathname.endsWith("/images/generations")) {
		const knownBytes =
			body instanceof Blob
				? body.size
				: body instanceof ArrayBuffer || ArrayBuffer.isView(body)
					? body.byteLength
					: undefined
		if (knownBytes !== undefined && knownBytes > limits.maxEncodedBodyBytes) {
			return {
				body: undefined,
				response: errorResponse(
					"Image generation request exceeds the configured byte limit.",
				),
			}
		}
		const bodyText = await decodeBody(body)
		if (bodyText === undefined) {
			return {
				body: undefined,
				response: errorResponse(
					"Image generation requires a JSON request body.",
				),
			}
		}
		if (
			new TextEncoder().encode(bodyText).byteLength > limits.maxEncodedBodyBytes
		) {
			return {
				body: undefined,
				response: errorResponse(
					"Image generation request exceeds the configured byte limit.",
				),
			}
		}
		try {
			const parsed = JSON.parse(bodyText)
			if (!isRecord(parsed)) {
				return {
					body: undefined,
					response: errorResponse(
						"Image generation request body must be a JSON object.",
					),
				}
			}
			headers.set("content-type", "application/json")
			const prepared = normalizeGeneration(parsed)
			if (
				typeof prepared.body === "string" &&
				new TextEncoder().encode(prepared.body).byteLength >
					limits.maxEncodedBodyBytes
			) {
				return {
					body: undefined,
					response: errorResponse(
						"Normalized image generation request exceeds the configured byte limit.",
					),
				}
			}
			return prepared
		} catch {
			return {
				body: undefined,
				response: errorResponse("Image generation request is invalid JSON."),
			}
		}
	}

	if (pathname.endsWith("/images/edits")) {
		if (!(body instanceof FormData)) {
			return {
				body: undefined,
				response: errorResponse(
					"Image editing requires a multipart/form-data request body.",
				),
			}
		}
		headers.set("content-type", "application/json")
		return normalizeEdit(body, limits)
	}

	return { body }
}
