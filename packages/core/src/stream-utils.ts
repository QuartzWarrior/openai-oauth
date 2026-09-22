const abortReason = (signal: AbortSignal): unknown =>
	signal.reason ?? new DOMException("Aborted", "AbortError")

export const validateTimeout = (
	value: number | undefined,
	name: string,
): void => {
	if (
		value !== undefined &&
		(!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)
	) {
		throw new Error(
			`${name} must be a positive integer no greater than 2147483647.`,
		)
	}
}

/** One operation owns its deadline; subscribers only race their own wait. */
export const createOperationScope = (
	timeoutMs: number | undefined,
	parents: Array<AbortSignal | null | undefined>,
	label = "Operation",
): { signal: AbortSignal; dispose(): void } => {
	validateTimeout(timeoutMs, "timeoutMs")
	const controller = new AbortController()
	const cleanups: Array<() => void> = []
	for (const parent of parents) {
		if (!parent) continue
		const abort = () => controller.abort(abortReason(parent))
		if (parent.aborted) abort()
		else {
			parent.addEventListener("abort", abort, { once: true })
			cleanups.push(() => parent.removeEventListener("abort", abort))
		}
	}
	const timer =
		timeoutMs === undefined
			? undefined
			: setTimeout(() => {
					controller.abort(
						new DOMException(`${label} timed out.`, "TimeoutError"),
					)
				}, timeoutMs)
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timer)
			for (const cleanup of cleanups) cleanup()
		},
	}
}

/** Aborting one waiter must not cancel shared authentication/catalog work. */
export const waitWithSignal = <T>(
	promise: Promise<T>,
	signal?: AbortSignal | null,
): Promise<T> => {
	if (!signal) return promise
	if (signal.aborted) {
		void promise.catch(() => undefined)
		return Promise.reject(abortReason(signal))
	}
	return new Promise((resolve, reject) => {
		const abort = () => reject(abortReason(signal))
		signal.addEventListener("abort", abort, { once: true })
		void promise.then(
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
}

/** Cancellation belongs to this read; unlike a subscriber, it cancels its source. */
export const readWithSignal = async <T>(
	reader: ReadableStreamDefaultReader<T>,
	signal?: AbortSignal | null,
	idleTimeoutMs?: number,
): Promise<ReadableStreamReadResult<T>> => {
	const scope = createOperationScope(
		idleTimeoutMs,
		[signal],
		"Upstream stream idle wait",
	)
	const cancel = () => {
		void reader.cancel(abortReason(scope.signal)).catch(() => undefined)
	}
	scope.signal.addEventListener("abort", cancel, { once: true })
	try {
		if (scope.signal.aborted) {
			cancel()
			throw abortReason(scope.signal)
		}
		return await waitWithSignal(reader.read(), scope.signal)
	} finally {
		scope.signal.removeEventListener("abort", cancel)
		scope.dispose()
	}
}

/** Bound response reads before allocating a complete string. */
export const readBoundedText = async (
	body: ReadableStream<Uint8Array> | null,
	maxBytes: number,
	signal?: AbortSignal | null,
): Promise<string> => {
	if (!body) return ""
	const reader = body.getReader()
	const decoder = new TextDecoder()
	let size = 0
	let text = ""
	try {
		for (;;) {
			const { value, done } = await readWithSignal(reader, signal)
			if (done) return text + decoder.decode()
			size += value.byteLength
			if (size > maxBytes)
				throw new Error("Response body exceeded the configured size limit.")
			text += decoder.decode(value, { stream: true })
		}
	} catch (error) {
		void reader.cancel(error).catch(() => undefined)
		throw error
	} finally {
		reader.releaseLock()
	}
}

/** Cancel a late response when a custom fetch ignores AbortSignal. */
export const fetchWithSignal = async (
	fetch: typeof globalThis.fetch,
	input: RequestInfo | URL,
	init: RequestInit,
	signal?: AbortSignal | null,
): Promise<Response> => {
	if (signal?.aborted) throw abortReason(signal)
	const pending = fetch(input, { ...init, signal })
	void pending.then(
		(response) => {
			if (signal?.aborted)
				void response.body?.cancel(abortReason(signal)).catch(() => undefined)
		},
		() => undefined,
	)
	return waitWithSignal(pending, signal)
}
