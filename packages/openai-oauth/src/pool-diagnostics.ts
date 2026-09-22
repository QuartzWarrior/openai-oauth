import {
	type CodexModelCatalogSnapshot,
	type ContextBudgetRequest,
	type GetModelCatalogOptions,
	inspectContextBudget,
} from "@openai-oauth/core"
import {
	isRecord,
	RequestBodyTooLargeError,
	toErrorResponse,
	toJsonResponse,
} from "./shared.js"

export type PoolDiagnosticsSource = {
	stats(): readonly {
		name: string
		transport: string
		healthy: boolean
		inflight: number
		cooldownRemainingMs: number
		consecutiveFailures: number
		quota?: unknown
	}[]
	getModelCatalog(
		accountName: string,
		options?: GetModelCatalogOptions,
	): Promise<CodexModelCatalogSnapshot & { accountName?: string }>
}

const noStore = (response: Response): Response => {
	response.headers.set("cache-control", "no-store")
	return response
}
const invalid = (message: string): Response => noStore(toErrorResponse(message))
const json = (value: unknown): Response => noStore(toJsonResponse(value))

const waitForSignal = <T>(
	operation: Promise<T>,
	signal: AbortSignal,
): Promise<T> =>
	new Promise((resolve, reject) => {
		const abort = () => {
			signal.removeEventListener("abort", abort)
			reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
		}
		if (signal.aborted) abort()
		else signal.addEventListener("abort", abort, { once: true })
		void operation.then(
			(value) => {
				signal.removeEventListener("abort", abort)
				resolve(value)
			},
			(error) => {
				signal.removeEventListener("abort", abort)
				reject(error)
			},
		)
	})

const knownQuery = (params: URLSearchParams, allowed: readonly string[]) => {
	const seen = new Set<string>()
	for (const key of params.keys()) {
		if (!allowed.includes(key) || seen.has(key)) return false
		seen.add(key)
	}
	return true
}
const exactKeys = (
	value: Record<string, unknown>,
	allowed: readonly string[],
) => Object.keys(value).every((key) => allowed.includes(key))
const validName = (value: unknown): value is string =>
	typeof value === "string" && value.trim().length > 0 && value.length <= 256
const uniqueAccount = (source: PoolDiagnosticsSource, account: string) =>
	source.stats().filter((entry) => entry.name === account).length === 1

// Copy known scalar fields only; never pass provider/raw objects through the facade.
const scalarFields = (
	value: Record<string, unknown>,
	strings: readonly string[],
	numbers: readonly string[],
	booleans: readonly string[],
): Record<string, string | number | boolean> => {
	const result: Record<string, string | number | boolean> = {}
	for (const key of strings)
		if (typeof value[key] === "string") result[key] = value[key]
	for (const key of numbers)
		if (typeof value[key] === "number" && Number.isFinite(value[key]))
			result[key] = value[key]
	for (const key of booleans)
		if (typeof value[key] === "boolean") result[key] = value[key]
	return result
}
const quotaWindow = (value: unknown) =>
	isRecord(value)
		? scalarFields(
				value,
				[],
				["usedPercent", "windowMinutes", "resetAt", "observedAt"],
				["stale"],
			)
		: undefined
const quotaSummary = (value: unknown) => {
	if (!isRecord(value)) return undefined
	return {
		families: Array.isArray(value.families)
			? value.families
					.slice(0, 32)
					.filter(isRecord)
					.map((family) => ({
						...scalarFields(
							family,
							["limitId", "limitName", "planType"],
							[],
							[],
						),
						primary: quotaWindow(family.primary),
						secondary: quotaWindow(family.secondary),
					}))
			: [],
		credits: isRecord(value.credits)
			? scalarFields(
					value.credits,
					["balance"],
					["observedAt"],
					["hasCredits", "unlimited", "stale"],
				)
			: undefined,
	}
}
const modelSummary = (value: Record<string, unknown>) => {
	const strings = [
		"slug",
		"displayName",
		"description",
		"defaultServiceTier",
		"compactionCompatibilityHash",
		"visibility",
		"minimalClientVersion",
		"defaultVerbosity",
		"defaultReasoningLevel",
		"defaultReasoningSummary",
	]
	const result: Record<string, unknown> = scalarFields(
		value,
		strings,
		[
			"contextWindow",
			"maxContextWindow",
			"autoCompactTokenLimit",
			"effectiveContextWindowPercent",
		],
		[
			"supportsReasoningSummaryParameter",
			"supportsImageDetailOriginal",
			"supportedInApi",
			"useResponsesLite",
			"preferWebsockets",
			"supportVerbosity",
			"supportsParallelToolCalls",
		],
	)
	for (const key of ["inputModalities", "availableInPlans"])
		if (Array.isArray(value[key]))
			result[key] = value[key].filter(
				(item): item is string => typeof item === "string",
			)
	if (Array.isArray(value.supportedReasoningLevels))
		result.supportedReasoningLevels = value.supportedReasoningLevels
			.filter(isRecord)
			.map((level) => scalarFields(level, ["effort", "description"], [], []))
	if (Array.isArray(value.serviceTiers))
		result.serviceTiers = value.serviceTiers
			.filter(isRecord)
			.map((tier) => scalarFields(tier, ["id", "name", "description"], [], []))
	return result
}

/** Called only after the gateway's authorization and request-body limit checks. */
export const handlePoolDiagnosticsRequest = async (
	request: Request,
	source: PoolDiagnosticsSource,
): Promise<Response | undefined> => {
	const url = new URL(request.url)
	const method = url.pathname === "/pool/context" ? "POST" : "GET"
	if (!["/pool/stats", "/pool/models", "/pool/context"].includes(url.pathname))
		return undefined
	request.signal.throwIfAborted()
	if (request.method !== method) {
		const response = noStore(
			toErrorResponse("Method not allowed.", 405, "method_not_allowed"),
		)
		response.headers.set("allow", method)
		return response
	}
	try {
		if (url.pathname === "/pool/stats") {
			if (!knownQuery(url.searchParams, []))
				return invalid("Unsupported query parameters.")
			return json({
				accounts: source.stats().map((entry) => ({
					...scalarFields(
						entry,
						["name", "transport"],
						["inflight", "cooldownRemainingMs", "consecutiveFailures"],
						["healthy"],
					),
					quota: quotaSummary(entry.quota),
				})),
			})
		}
		if (url.pathname === "/pool/models") {
			if (
				!knownQuery(url.searchParams, [
					"account",
					"mode",
					"cacheOnly",
					"refresh",
				])
			)
				return invalid("Unsupported or duplicate query parameters.")
			const account = url.searchParams.get("account")
			const mode = url.searchParams.get("mode") ?? "public-api"
			const cacheOnly = url.searchParams.get("cacheOnly") ?? "false"
			const refresh = url.searchParams.get("refresh") ?? "false"
			if (!validName(account)) return invalid("An account name is required.")
			if (!["public-api", "oauth-visible", "all"].includes(mode))
				return invalid("Unsupported model listing mode.")
			if (
				!["true", "false"].includes(cacheOnly) ||
				!["true", "false"].includes(refresh)
			)
				return invalid("cacheOnly and refresh must be true or false.")
			if (cacheOnly === "true" && refresh === "true")
				return invalid("cacheOnly and refresh cannot both be enabled.")
			if (!uniqueAccount(source, account))
				return invalid("Account name must identify one configured account.")
			const snapshot = await waitForSignal(
				source.getModelCatalog(account, {
					mode: mode as NonNullable<GetModelCatalogOptions["mode"]>,
					cacheOnly: cacheOnly === "true",
					refresh: refresh === "true",
					signal: request.signal,
				}),
				request.signal,
			)
			return json({
				accountName: account,
				...scalarFields(
					snapshot,
					["freshness", "etag", "clientVersion"],
					["fetchedAt", "validatedAt"],
					[],
				),
				models: snapshot.models.map(modelSummary),
			})
		}
		if (!knownQuery(url.searchParams, []))
			return invalid("Unsupported query parameters.")
		if (
			request.headers
				.get("content-type")
				?.split(";", 1)[0]
				?.trim()
				.toLowerCase() !== "application/json"
		)
			return invalid("Context inspection requires application/json.")
		let body: unknown
		try {
			body = await waitForSignal(request.json(), request.signal)
		} catch (error) {
			if (error instanceof SyntaxError && !request.signal.aborted)
				return invalid("Request body must be valid JSON.")
			throw error
		}
		if (!isRecord(body) || !exactKeys(body, ["account", "request", "estimate"]))
			return invalid(
				"Context inspection requires an account and request object.",
			)
		if (!validName(body.account)) return invalid("An account name is required.")
		if (
			!isRecord(body.request) ||
			!exactKeys(body.request, [
				"model",
				"instructions",
				"input",
				"tools",
				"previous_response_id",
			]) ||
			!validName(body.request.model)
		)
			return invalid(
				"Context request must contain a model and supported input fields.",
			)
		const estimate = body.estimate === undefined ? "none" : body.estimate
		if (estimate !== "none" && estimate !== "characters")
			return invalid("estimate must be none or characters.")
		if (!uniqueAccount(source, body.account))
			return invalid("Account name must identify one configured account.")
		const catalog = await waitForSignal(
			source.getModelCatalog(body.account, {
				mode: "all",
				cacheOnly: true,
				signal: request.signal,
			}),
			request.signal,
		)
		const inspection = inspectContextBudget(
			body.request as ContextBudgetRequest,
			{
				catalog,
				estimateTokens:
					estimate === "characters"
						? (text) => Math.ceil(text.length / 4)
						: undefined,
			},
		)
		request.signal.throwIfAborted()
		return json({
			accountName: body.account,
			...inspection,
			estimateMethod: estimate === "characters" ? "characters-div-4" : "none",
		})
	} catch (error) {
		if (request.signal.aborted || error instanceof RequestBodyTooLargeError)
			throw error
		return noStore(
			toErrorResponse(
				"Pool diagnostics are unavailable.",
				502,
				"upstream_error",
			),
		)
	}
}
