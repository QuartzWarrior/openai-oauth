import { describe, expect, test, vi } from "vitest"
import {
	type CodexImageLimits,
	prepareCodexImageRequest,
} from "../src/images.js"

const generation = (
	fields: Record<string, unknown>,
	limits: CodexImageLimits = {},
) =>
	prepareCodexImageRequest(
		"/images/generations",
		new Headers(),
		JSON.stringify({ prompt: "test", ...fields }),
		limits,
	)
const edit = (
	fields: Record<string, unknown>,
	limits: CodexImageLimits = {},
	count = 1,
) => {
	const body = new FormData()
	body.set("prompt", "test")
	for (let i = 0; i < count; i++)
		body.append(
			"image",
			new Blob([new Uint8Array([0, 255, 128, 42])], { type: "image/png" }),
			`image-${i}.png`,
		)
	for (const [key, value] of Object.entries(fields))
		body.set(key, value instanceof Blob ? value : String(value))
	return prepareCodexImageRequest("/images/edits", new Headers(), body, limits)
}

describe("image request contracts", () => {
	test.each([
		0,
		-1,
		1.5,
		"invalid",
		"",
		null,
		{},
		true,
	])("rejects invalid image count %j for both body representations", async (n) => {
		expect((await generation({ n })).response?.status).toBe(400)
		expect((await edit({ n })).response?.status).toBe(400)
	})
	test.each([
		{ background: "unknown" },
		{ background: {} },
		{ quality: "ultra" },
		{ quality: null },
		{ size: {} },
		{ size: "" },
		{ stream: "false" },
	])("rejects invalid JSON image options %j", async (fields) => {
		expect((await generation(fields)).response?.status).toBe(400)
	})
	test("multipart scalar files and empty fields reject rather than disappear", async () => {
		for (const fields of [
			{ quality: new Blob(["high"]) },
			{ size: "" },
			{ n: "" },
			{ stream: "invalid" },
		]) {
			expect((await edit(fields)).response?.status).toBe(400)
		}
	})
	test("valid options normalize consistently and binary bytes survive", async () => {
		const fields = {
			n: 2,
			background: "transparent",
			quality: "high",
			size: "1024x1536",
		}
		const generated = await generation(fields)
		const edited = await edit(fields)
		expect(generated.response).toBeUndefined()
		expect(edited.response).toBeUndefined()
		expect(JSON.parse(String(generated.body))).toMatchObject(fields)
		expect(JSON.parse(String(edited.body))).toMatchObject({
			...fields,
			images: [{ image_url: "data:image/png;base64,AP+AKg==" }],
		})
	})
	test("allows five references but rejects six", async () => {
		expect((await edit({}, {}, 5)).response).toBeUndefined()
		expect((await edit({}, {}, 6)).response?.status).toBe(400)
	})
	test("per-file and aggregate budgets are independent", async () => {
		expect(
			(await edit({}, { maxReferenceImageBytes: 3 })).response?.status,
		).toBe(400)
		expect(
			(await edit({}, { maxReferenceImageBytes: 4, maxTotalImageBytes: 7 }, 2))
				.response?.status,
		).toBe(400)
		expect(
			(await edit({}, { maxReferenceImageBytes: 4, maxTotalImageBytes: 8 }, 2))
				.response,
		).toBeUndefined()
	})
	test("checks exact encoded JSON size including base64 overhead", async () => {
		const reference = await edit({})
		const size = new TextEncoder().encode(String(reference.body)).byteLength
		expect(
			(await edit({}, { maxEncodedBodyBytes: size })).response,
		).toBeUndefined()
		expect(
			(await edit({}, { maxEncodedBodyBytes: size - 1 })).response?.status,
		).toBe(400)
	})
	test("generation requests obey the encoded byte budget", async () => {
		expect(
			(
				await generation(
					{ prompt: "x".repeat(100) },
					{ maxEncodedBodyBytes: 32 },
				)
			).response?.status,
		).toBe(400)
	})
	test("normalized generation overhead is included in the budget", async () => {
		const request = await generation(
			{ prompt: "x" },
			{ maxEncodedBodyBytes: 15 },
		)
		expect(request.response?.status).toBe(400)
	})
	test("rejects oversized Blobs before materializing their contents", async () => {
		const blob = new Blob([JSON.stringify({ prompt: "x".repeat(100) })])
		const text = vi.spyOn(blob, "text")
		const result = await prepareCodexImageRequest(
			"/images/generations",
			new Headers(),
			blob,
			{ maxEncodedBodyBytes: 16 },
		)
		expect(result.response?.status).toBe(400)
		expect(text).not.toHaveBeenCalled()
	})

	test("rejects invalid local budget options", async () => {
		for (const maxTotalImageBytes of [
			0,
			-1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
		]) {
			await expect(edit({}, { maxTotalImageBytes })).rejects.toThrow(
				"positive safe integers",
			)
		}
	})
})
