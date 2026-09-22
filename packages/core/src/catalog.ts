import {
	type CodexModelCatalogSnapshot,
	type GetModelCatalogOptions,
	parseModelCatalogEtag,
	selectCodexModels,
} from "./models.js"
import type { OpenAIOAuthSession } from "./runtime.js"

const TTL_MS = 5 * 60 * 1000
const REVALIDATION_INTERVAL_MS = 60 * 1000

type Capture = {
	key: string
	epoch: number
	auth: OpenAIOAuthSession
	clientVersion: string
}
type Entry = {
	snapshot?: CodexModelCatalogSnapshot
	expiresAt: number
	nextRevalidationAt: number
	loading?: Promise<CodexModelCatalogSnapshot>
	error?: Error
}

/** One transport owns this cache; private identity keys never leave it. */
export const createModelCatalogCache = (options: {
	identity: (auth: OpenAIOAuthSession) => string
	fetch: (
		auth: OpenAIOAuthSession,
		version: string,
	) => Promise<CodexModelCatalogSnapshot>
	maxStaleMs: number
	signal?: AbortSignal
}) => {
	const entries = new Map<string, Entry>()
	let active: Capture | undefined
	let epoch = 0
	const current = (capture: Capture) =>
		!options.signal?.aborted &&
		active?.key === capture.key &&
		active.epoch === capture.epoch
	const missing = (capture?: Capture): CodexModelCatalogSnapshot => ({
		models: [],
		freshness: "missing",
		...(capture
			? {
					clientVersion: capture.clientVersion,
					owner: {
						accountId: capture.auth.accountId,
						isFedRamp: capture.auth.isFedRamp === true,
					},
				}
			: {}),
	})
	const view = (capture?: Capture): CodexModelCatalogSnapshot => {
		if (!capture || !current(capture)) return missing(capture)
		const entry = entries.get(capture.key)
		const snapshot = entry?.snapshot
		if (!snapshot) return missing(capture)
		if (!entry.error && Date.now() < entry.expiresAt)
			return { ...snapshot, freshness: "fresh" }
		if (Date.now() - (snapshot.validatedAt ?? 0) > options.maxStaleMs)
			return missing(capture)
		return { ...snapshot, freshness: "stale" }
	}
	const select = (auth: OpenAIOAuthSession, clientVersion: string): Capture => {
		const key = JSON.stringify([options.identity(auth), clientVersion])
		if (active?.key !== key) {
			if (active) {
				const previous = entries.get(active.key)
				if (previous?.loading) entries.delete(active.key)
			}
			epoch++
		}
		active = { key, epoch, auth, clientVersion }
		return active
	}
	const resolve = async (
		capture: Capture,
		refresh = false,
	): Promise<CodexModelCatalogSnapshot> => {
		options.signal?.throwIfAborted()
		if (!current(capture))
			throw new Error("Catalog request identity is obsolete.")
		let entry = entries.get(capture.key)
		if (!entry) {
			if (entries.size >= 32) {
				const oldest = entries.keys().next().value
				if (oldest !== undefined) entries.delete(oldest)
			}
			entry = { expiresAt: 0, nextRevalidationAt: 0 }
			entries.set(capture.key, entry)
		}
		if (entry.loading) return entry.loading
		if (!refresh && Date.now() < entry.expiresAt) return view(capture)
		const target = entry
		let operation: Promise<CodexModelCatalogSnapshot>
		operation = Promise.resolve().then(async () => {
			try {
				const snapshot = await options.fetch(
					capture.auth,
					capture.clientVersion,
				)
				options.signal?.throwIfAborted()
				const result = {
					...snapshot,
					owner: {
						accountId: capture.auth.accountId,
						isFedRamp: capture.auth.isFedRamp === true,
					},
				}
				// The original request still needs its owner's normalization metadata;
				// only publication into the currently selected cache is fenced.
				if (!current(capture) || entries.get(capture.key) !== target)
					return result
				target.snapshot = result
				target.error = undefined
				target.expiresAt = Date.now() + TTL_MS
				return view(capture)
			} catch (error) {
				options.signal?.throwIfAborted()
				if (!current(capture) || entries.get(capture.key) !== target) {
					const fallback = target.snapshot
					if (
						fallback &&
						Date.now() - (fallback.validatedAt ?? 0) <= options.maxStaleMs
					)
						return { ...fallback, freshness: "stale" }
					throw error
				}
				target.error =
					error instanceof Error
						? error
						: new Error("Failed to load models from Codex.")
				// Failures delay retries, never extend the last verified catalog's age.
				target.expiresAt =
					error instanceof DOMException && error.name === "TimeoutError"
						? 0
						: Date.now() + REVALIDATION_INTERVAL_MS
				return view(capture)
			} finally {
				if (target.loading === operation) target.loading = undefined
			}
		})
		target.loading = operation
		return operation
	}
	const observe = (capture: Capture, value: unknown) => {
		const etag = parseModelCatalogEtag(value)
		if (!etag || !current(capture)) return
		const entry = entries.get(capture.key)
		if (entry?.snapshot?.etag === etag) {
			entry.snapshot.validatedAt = Date.now()
			entry.expiresAt = Date.now() + TTL_MS
			entry.error = undefined
			return
		}
		if (entry && (entry.loading || Date.now() < entry.nextRevalidationAt))
			return
		if (entry) entry.nextRevalidationAt = Date.now() + REVALIDATION_INTERVAL_MS
		// Use the latest same-identity credential, not a token retained by an old stream.
		if (active) void resolve(active, true).catch(() => undefined)
	}
	return {
		select,
		resolve,
		observe,
		peek: () => view(active),
		error: (capture: Capture) => entries.get(capture.key)?.error,
		copy: (
			snapshot: CodexModelCatalogSnapshot,
			request: GetModelCatalogOptions = {},
		) =>
			structuredClone({
				...snapshot,
				models: selectCodexModels(snapshot.models, request.mode),
			}),
	}
}
