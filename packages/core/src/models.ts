import {
	createOperationScope,
	fetchWithSignal,
	readBoundedText,
	waitWithSignal,
} from "./stream-utils.js"
import { isRecord } from "./utils.js"

export const DEFAULT_CODEX_CLIENT_VERSION = "0.154.0"

const CODEX_VERSION_CACHE_TTL_MS = 60 * 60 * 1000
const CODEX_REGISTRY_URL = "https://registry.npmjs.org/@openai/codex/latest"

type FetchLike = typeof fetch

export type CodexModelListingMode = "public-api" | "oauth-visible" | "all"

export type CodexReasoningLevel = { effort: string; description?: string }
export type CodexServiceTier = {
	id: string
	name?: string
	description?: string
}

export type CodexModelInfo = {
	slug: string
	displayName?: string
	description?: string
	supportedReasoningLevels?: CodexReasoningLevel[]
	supportsReasoningSummaryParameter?: boolean
	supportsImageDetailOriginal?: boolean
	inputModalities?: string[]
	serviceTiers?: CodexServiceTier[]
	defaultServiceTier?: string
	contextWindow?: number
	maxContextWindow?: number
	autoCompactTokenLimit?: number
	effectiveContextWindowPercent?: number
	compactionCompatibilityHash?: string
	visibility?: string
	supportedInApi?: boolean
	minimalClientVersion?: string
	useResponsesLite?: boolean
	preferWebsockets?: boolean
	supportVerbosity?: boolean
	defaultVerbosity?: string
	defaultReasoningLevel?: string
	defaultReasoningSummary?: string
	supportsParallelToolCalls?: boolean
	availableInPlans?: string[]
	raw: Record<string, unknown>
}

export type ResolveCodexClientVersionOptions = {
	codexVersion?: string
	fetchImpl?: FetchLike
	onWarning?: (message: string) => void
	/** Subscriber cancellation does not cancel another caller's shared lookup. */
	signal?: AbortSignal
	/** Shared lookup deadline, including its response body (default 30s). */
	timeoutMs?: number
}

export type GetModelCatalogOptions = {
	mode?: CodexModelListingMode
	/** Read the last observed owner without resolving credentials or making requests. */
	cacheOnly?: boolean
	refresh?: boolean
	signal?: AbortSignal
}

export type CodexModelCatalogSnapshot = {
	models: CodexModelInfo[]
	freshness: "missing" | "fresh" | "stale"
	etag?: string
	clientVersion?: string
	fetchedAt?: number
	validatedAt?: number
	/** Last observed owner; cache-only inspection does not verify current credentials. */
	owner?: { accountId: string; isFedRamp: boolean }
}

export type FetchCodexModelCatalogOptions = ResolveCodexClientVersionOptions

export const parseModelCatalogEtag = (value: unknown): string | undefined =>
	typeof value === "string" &&
	value.length > 0 &&
	value.length <= 256 &&
	/^[\x20-\x7e]+$/.test(value)
		? value
		: undefined

export type CodexModelCatalogClient = {
	request(path: string, init?: RequestInit): Promise<Response>
}

type RegistryPackageResponse = {
	version?: unknown
}

const normalizeVersion = (value: unknown): string | undefined => {
	if (typeof value !== "string") {
		return undefined
	}

	return value.trim().match(/\b\d+\.\d+\.\d+\b/)?.[0]
}

const optionalString = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined

const optionalBoolean = (value: unknown): boolean | undefined =>
	typeof value === "boolean" ? value : undefined

const optionalArray = <T>(
	value: unknown,
	parse: (item: unknown) => T | undefined,
): T[] | undefined => {
	if (!Array.isArray(value)) return undefined
	const parsed = value.flatMap((item) => {
		const result = parse(item)
		return result === undefined ? [] : [result]
	})
	return value.length === 0 || parsed.length > 0 ? parsed : undefined
}

const optionalStrings = (value: unknown): string[] | undefined =>
	optionalArray(value, optionalString)

const optionalPositiveInteger = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: undefined

const optionalPercent = (value: unknown): number | undefined =>
	typeof value === "number" &&
	Number.isFinite(value) &&
	value > 0 &&
	value <= 100
		? value
		: undefined

const optionalReasoningLevels = (
	value: unknown,
): CodexReasoningLevel[] | undefined =>
	optionalArray(value, (item) => {
		if (!isRecord(item)) return undefined
		const effort = optionalString(item.effort)
		return effort
			? { effort, description: optionalString(item.description) }
			: undefined
	})

const optionalServiceTiers = (value: unknown): CodexServiceTier[] | undefined =>
	optionalArray(value, (item) => {
		if (!isRecord(item)) return undefined
		const id = optionalString(item.id)
		return id
			? {
					id,
					name: optionalString(item.name),
					description: optionalString(item.description),
				}
			: undefined
	})

const toCodexModelInfo = (value: unknown): CodexModelInfo | undefined => {
	if (!isRecord(value)) {
		return undefined
	}

	const slug = optionalString(value.slug)
	if (!slug) {
		return undefined
	}

	return {
		slug,
		displayName: optionalString(value.display_name),
		description: optionalString(value.description),
		supportedReasoningLevels: optionalReasoningLevels(
			value.supported_reasoning_levels,
		),
		supportsReasoningSummaryParameter: optionalBoolean(
			value.supports_reasoning_summary_parameter,
		),
		supportsImageDetailOriginal: optionalBoolean(
			value.supports_image_detail_original,
		),
		inputModalities: optionalStrings(value.input_modalities),
		serviceTiers: optionalServiceTiers(value.service_tiers),
		defaultServiceTier: optionalString(value.default_service_tier),
		contextWindow: optionalPositiveInteger(value.context_window),
		maxContextWindow: optionalPositiveInteger(value.max_context_window),
		autoCompactTokenLimit: optionalPositiveInteger(
			value.auto_compact_token_limit,
		),
		effectiveContextWindowPercent: optionalPercent(
			value.effective_context_window_percent,
		),
		compactionCompatibilityHash: optionalString(value.comp_hash),
		visibility: optionalString(value.visibility),
		supportedInApi: optionalBoolean(value.supported_in_api),
		minimalClientVersion: optionalString(value.minimal_client_version),
		useResponsesLite: optionalBoolean(value.use_responses_lite),
		preferWebsockets: optionalBoolean(value.prefer_websockets),
		supportVerbosity: optionalBoolean(value.support_verbosity),
		defaultVerbosity: optionalString(value.default_verbosity),
		defaultReasoningLevel: optionalString(value.default_reasoning_level),
		defaultReasoningSummary: optionalString(value.default_reasoning_summary),
		supportsParallelToolCalls: optionalBoolean(
			value.supports_parallel_tool_calls,
		),
		availableInPlans: optionalStrings(value.available_in_plans),
		raw: value,
	}
}

const toUpstreamErrorMessage = (bodyText: string): string => {
	if (!bodyText) {
		return "Failed to load models from Codex."
	}

	try {
		const parsed = JSON.parse(bodyText)
		if (isRecord(parsed)) {
			if (typeof parsed.detail === "string" && parsed.detail.length > 0) {
				return parsed.detail
			}
			if (isRecord(parsed.error) && typeof parsed.error.message === "string") {
				return parsed.error.message
			}
		}
	} catch {}

	return bodyText
}

let versionGeneration = 0
let cachedCodexClientVersion: string | undefined
let codexClientVersionCacheExpiresAt = 0
// A caller can itself route through another OAuth transport (for example, a
// pooled transport). Sharing one in-flight promise across different fetch
// implementations would make that nested request await itself forever.
const inflightCodexClientVersions = new Map<
	FetchLike | undefined,
	Promise<string>
>()

export const resolveCodexClientVersion = async (
	options: ResolveCodexClientVersionOptions = {},
): Promise<string> => {
	if (options.signal?.aborted)
		throw options.signal.reason ?? new DOMException("Aborted", "AbortError")
	const explicitVersion = normalizeVersion(options.codexVersion)
	if (explicitVersion) {
		return explicitVersion
	}

	const now = Date.now()
	if (cachedCodexClientVersion && now < codexClientVersionCacheExpiresAt) {
		return cachedCodexClientVersion
	}

	const fetchImpl = options.fetchImpl ?? globalThis.fetch
	const existing = inflightCodexClientVersions.get(fetchImpl)
	if (existing) {
		return waitWithSignal(existing, options.signal)
	}

	const generation = versionGeneration
	const scope = createOperationScope(
		options.timeoutMs ?? 30_000,
		[],
		"Codex version discovery",
	)
	const inflight = (async () => {
		try {
			const response = await fetchWithSignal(
				fetchImpl,
				CODEX_REGISTRY_URL,
				{
					headers: { accept: "application/json" },
				},
				scope.signal,
			)
			const text = await readBoundedText(response.body, 64 * 1024, scope.signal)
			scope.signal.throwIfAborted()
			if (response.ok) {
				const parsed = JSON.parse(text) as RegistryPackageResponse
				const version = normalizeVersion(parsed.version)
				if (version) {
					if (generation === versionGeneration) {
						cachedCodexClientVersion = version
						codexClientVersionCacheExpiresAt =
							Date.now() + CODEX_VERSION_CACHE_TTL_MS
					}
					return version
				}
			}
		} catch {}
		options.onWarning?.(
			`Could not determine the latest Codex version. Falling back to ${DEFAULT_CODEX_CLIENT_VERSION}. Pass a version explicitly if you need to override it.`,
		)
		// Do not pin a failed/expired operation for an hour; a later request can recover.
		return DEFAULT_CODEX_CLIENT_VERSION
	})().finally(() => {
		scope.dispose()
		if (inflightCodexClientVersions.get(fetchImpl) === inflight)
			inflightCodexClientVersions.delete(fetchImpl)
	})
	inflightCodexClientVersions.set(fetchImpl, inflight)

	return waitWithSignal(inflight, options.signal)
}

export const resetCodexClientVersionCache = (): void => {
	versionGeneration += 1
	cachedCodexClientVersion = undefined
	codexClientVersionCacheExpiresAt = 0
	inflightCodexClientVersions.clear()
}

export const fetchCodexModelCatalogSnapshot = async (
	client: CodexModelCatalogClient,
	options: FetchCodexModelCatalogOptions = {},
): Promise<CodexModelCatalogSnapshot> => {
	const scope = createOperationScope(
		options.timeoutMs ?? 30_000,
		[options.signal],
		"Codex model discovery",
	)
	let response: Response
	let bodyText: string
	let clientVersion: string
	try {
		clientVersion = await resolveCodexClientVersion({
			...options,
			signal: scope.signal,
		})
		const pending = client.request(
			`/models?client_version=${encodeURIComponent(clientVersion)}`,
			{ signal: scope.signal },
		)
		void pending.then(
			(late) => {
				if (scope.signal.aborted)
					void late.body?.cancel(scope.signal.reason).catch(() => undefined)
			},
			() => undefined,
		)
		response = await waitWithSignal(pending, scope.signal)
		bodyText = await readBoundedText(
			response.body,
			4 * 1024 * 1024,
			scope.signal,
		)
		scope.signal.throwIfAborted()
	} finally {
		scope.dispose()
	}

	if (!response.ok) {
		throw new Error(toUpstreamErrorMessage(bodyText))
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(bodyText)
	} catch {
		throw new Error("Codex returned an invalid models response.")
	}

	if (!isRecord(parsed) || !Array.isArray(parsed.models)) {
		throw new Error("Codex returned a malformed models response.")
	}

	const models = parsed.models
		.map(toCodexModelInfo)
		.filter((model): model is CodexModelInfo => model !== undefined)
	if (models.length === 0) {
		throw new Error("Codex returned an empty models list.")
	}

	const fetchedAt = Date.now()
	return {
		models,
		freshness: "fresh",
		etag: parseModelCatalogEtag(response.headers.get("etag")),
		clientVersion,
		fetchedAt,
		validatedAt: fetchedAt,
	}
}

export const fetchCodexModelCatalog = async (
	client: CodexModelCatalogClient,
	options: FetchCodexModelCatalogOptions = {},
): Promise<CodexModelInfo[]> =>
	(await fetchCodexModelCatalogSnapshot(client, options)).models

export const isPublicCodexModel = (model: CodexModelInfo): boolean =>
	model.supportedInApi !== false &&
	(model.visibility === undefined || model.visibility === "list")

/** Listing visibility is metadata, not a guarantee of account entitlement. */
export const selectCodexModels = (
	models: readonly CodexModelInfo[],
	mode: CodexModelListingMode = "public-api",
): CodexModelInfo[] => {
	switch (mode) {
		case "public-api":
			return models.filter(isPublicCodexModel)
		case "oauth-visible":
			return models.filter(
				(model) =>
					model.visibility === undefined || model.visibility === "list",
			)
		case "all":
			return [...models]
		default:
			throw new Error("Unknown model listing mode.")
	}
}
