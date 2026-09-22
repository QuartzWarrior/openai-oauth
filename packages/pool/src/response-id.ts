/** Hold a lease for the consumer's body lifetime. Completion indexing is core-owned. */
export const observeResponse = (
	response: Response,
	onSettled: () => void,
	signal?: AbortSignal,
): Response => {
	if (!response.body) {
		onSettled()
		return response
	}
	const reader = response.body.getReader()
	let settled = false
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined
	const finish = () => {
		if (settled) return
		settled = true
		signal?.removeEventListener("abort", abort)
		onSettled()
	}
	const abort = () => {
		if (settled) return
		const reason = signal?.reason ?? new DOMException("Aborted", "AbortError")
		finish()
		controller?.error(reason)
		void reader.cancel(reason).catch(() => undefined)
	}
	const body = new ReadableStream<Uint8Array>(
		{
			start(value) {
				controller = value
				signal?.addEventListener("abort", abort, { once: true })
				if (signal?.aborted) abort()
			},
			async pull(value) {
				try {
					const next = await reader.read()
					if (settled) return
					if (next.done) {
						finish()
						value.close()
					} else value.enqueue(next.value)
				} catch (error) {
					if (!settled) {
						finish()
						value.error(error)
					}
				}
			},
			async cancel(reason) {
				finish()
				await reader.cancel(reason).catch(() => undefined)
			},
		},
		{ highWaterMark: 0 },
	)
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	})
}
