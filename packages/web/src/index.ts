import {
	createOpenAIOAuthRequest,
	deriveAccountId,
	exchangeOpenAIOAuthCode,
	type FetchFunction,
	type OpenAIOAuthRequestOptions,
	type OpenAIOAuthSession,
	type OpenAIOAuthTokenResponse,
	parseJwtClaims,
	refreshOpenAIOAuthTokens,
	type SessionStore,
} from "@openai-oauth/core"

export type { OpenAIOAuthSession, SessionStore }

export type BrowserSessionStoreOptions = {
	dbName?: string
	storeName?: string
	sessionKey?: string
	cryptoKey?: string
}

export type OpenAIOAuthTokenOptions = {
	clientId?: string
	issuer?: string
	tokenUrl?: string
	fetch?: FetchFunction
	now?: () => Date
}

export type ExchangeCodeOptions = OpenAIOAuthTokenOptions

export type ExchangeCodeInput = {
	code: string
	codeVerifier: string
	redirectUri: string
	signal?: AbortSignal
}

export type RefreshSessionOptions = OpenAIOAuthTokenOptions

export type RefreshSessionInput = {
	refreshToken: string
	signal?: AbortSignal
}

export type BrowserSessionOptions = {
	sessionStore?: SessionStore
	clientId?: string
	issuer?: string
	tokenUrl?: string
	fetch?: FetchFunction
	refresh?: boolean
	signal?: AbortSignal
	/** Shared refresh deadline; subscriber cancellation stays independent. Default 30 seconds. */
	refreshTimeoutMs?: number
	now?: () => Date
}

export type OpenAIAuthHeadersOptions = BrowserSessionOptions & {
	headers?: HeadersInit
	optional?: boolean
}

export type OpenAIAuthHeaders = Record<string, string>

export type StartLoginOptions = Omit<
	OpenAIOAuthRequestOptions,
	"redirectUri"
> & {
	callbackPath?: string
	redirectUri?: string
	returnTo?: string
	openMode?: "redirect" | "popup"
	/** Store whose pending maintenance must yield to this explicit login intent. */
	sessionStore?: SessionStore
}

export type CompleteLoginOptions = {
	sessionStore?: SessionStore
	clientId?: string
	issuer?: string
	tokenUrl?: string
	fetch?: FetchFunction
	now?: () => Date
	url?: string
	signal?: AbortSignal
	/** Shared callback exchange deadline; subscriber cancellation stays independent. Default 5 minutes. */
	callbackTimeoutMs?: number
}

export type LogoutOptions = {
	sessionStore?: SessionStore
}

type StoreSettings = Required<BrowserSessionStoreOptions>

type StoredRecord<T> = {
	id: string
	value: T
}

type EncryptedSession = {
	iv: string
	ciphertext: string
}

type PendingLogin = {
	state: string
	codeVerifier: string
	redirectUri: string
	returnTo: string
}

const defaultStoreSettings: StoreSettings = {
	dbName: "openai-oauth",
	storeName: "sessions",
	sessionKey: "openai-oauth:session",
	cryptoKey: "openai-oauth:crypto-key",
}

const pendingLoginKey = "openai-oauth:pending-login"
const browserExtensionStatePrefix = "oo2_"
const browserExtensionRedirectUri = "http://localhost:1455/auth/callback"
const browserExtensionId = "odbgboachaefbbbdiffcefhpkekhfcna"
const browserExtensionInstalledPath = "src/installed.json"
const chromeExtensionInstallUrl =
	"https://chromewebstore.google.com/detail/sign-in-with-chatgpt/odbgboachaefbbbdiffcefhpkekhfcna"
const firefoxExtensionInstallUrl =
	"https://addons.mozilla.org/firefox/addon/sign-in-with-chatgpt/"
const firefoxExtensionDetectionUrl =
	"http://localhost:1455/openai-oauth/installed"
const browserExtensionMarkerType = "openai-oauth:browser-extension-installed"
const browserExtensionDetectionTimeoutMs = 750
const refreshExpiryMarginMs = 5 * 60 * 1000
const refreshIntervalMs = 55 * 60 * 1000

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

const assertBrowserStorage = (): void => {
	if (
		typeof indexedDB === "undefined" ||
		typeof globalThis.crypto?.subtle === "undefined"
	) {
		throw new Error("Browser session storage requires IndexedDB and WebCrypto.")
	}
}

const assertBrowserWindow = (): Window => {
	if (typeof window === "undefined") {
		throw new Error("OpenAI OAuth browser login requires window.")
	}
	return window
}

const isFirefox = (): boolean =>
	typeof navigator !== "undefined" &&
	navigator.userAgent.toLowerCase().includes("firefox/")

const isChromeExtensionInstalled = async (): Promise<boolean> => {
	const fetchImpl = globalThis.fetch
	if (!fetchImpl) {
		return false
	}

	const controller =
		typeof AbortController === "undefined" ? null : new AbortController()
	const timeout = controller
		? globalThis.setTimeout(
				() => controller.abort(),
				browserExtensionDetectionTimeoutMs,
			)
		: null

	try {
		const response = await fetchImpl(
			`chrome-extension://${browserExtensionId}/${browserExtensionInstalledPath}`,
			{
				cache: "no-store",
				signal: controller?.signal,
			},
		)
		if (!response.ok) {
			return false
		}

		const marker = (await response.json().catch(() => null)) as {
			installed?: unknown
		} | null
		return marker?.installed === true
	} catch {
		return false
	} finally {
		if (timeout !== null) {
			globalThis.clearTimeout(timeout)
		}
	}
}

const isFirefoxExtensionInstalled = (browserWindow: Window): Promise<boolean> =>
	new Promise((resolve) => {
		const document = browserWindow.document
		const parent = document?.body ?? document?.documentElement
		if (!document?.createElement || !parent) {
			resolve(false)
			return
		}

		const iframe = document.createElement("iframe")
		iframe.hidden = true
		iframe.setAttribute("aria-hidden", "true")
		iframe.src = firefoxExtensionDetectionUrl

		let settled = false
		const finish = (installed: boolean) => {
			if (settled) {
				return
			}
			settled = true
			globalThis.clearTimeout(timeout)
			browserWindow.removeEventListener("message", onMessage)
			iframe.remove()
			resolve(installed)
		}
		const onMessage = (event: MessageEvent) => {
			const data = event.data as {
				name?: unknown
				protocol?: unknown
				protocolVersion?: unknown
				type?: unknown
			} | null
			if (
				event.source === iframe.contentWindow &&
				event.origin.startsWith("moz-extension://") &&
				data?.type === browserExtensionMarkerType &&
				data.name === "sign-in-with-chatgpt" &&
				data.protocol === "openai-oauth-browser-extension" &&
				data.protocolVersion === 1
			) {
				finish(true)
			}
		}
		const timeout = globalThis.setTimeout(
			() => finish(false),
			browserExtensionDetectionTimeoutMs,
		)

		browserWindow.addEventListener("message", onMessage)
		parent.appendChild(iframe)
	})

const getBrowserExtension = (browserWindow: Window) =>
	isFirefox()
		? {
				installUrl: firefoxExtensionInstallUrl,
				isInstalled: () => isFirefoxExtensionInstalled(browserWindow),
			}
		: {
				installUrl: chromeExtensionInstallUrl,
				isInstalled: isChromeExtensionInstalled,
			}

const requestToPromise = <T>(request: IDBRequest<T>): Promise<T> =>
	new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result)
		request.onerror = () =>
			reject(request.error ?? new Error("IndexedDB request failed."))
	})

const transactionToPromise = (transaction: IDBTransaction): Promise<void> =>
	new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve()
		transaction.onerror = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction failed."))
		transaction.onabort = () =>
			reject(
				transaction.error ?? new Error("IndexedDB transaction was aborted."),
			)
	})

const openDatabaseRequest = (
	settings: StoreSettings,
	version?: number,
): Promise<IDBDatabase> => {
	assertBrowserStorage()

	const browserWindow = assertBrowserWindow()
	return new Promise((resolve, reject) => {
		let settled = false
		const timeout = browserWindow.setTimeout(() => {
			settled = true
			reject(new Error("Timed out opening browser session storage."))
		}, 2000)
		const request =
			typeof version === "number"
				? indexedDB.open(settings.dbName, version)
				: indexedDB.open(settings.dbName)
		request.onupgradeneeded = () => {
			const db = request.result
			if (!db.objectStoreNames.contains(settings.storeName)) {
				db.createObjectStore(settings.storeName, { keyPath: "id" })
			}
		}
		request.onsuccess = () => {
			browserWindow.clearTimeout(timeout)
			if (settled) {
				request.result.close()
				return
			}
			settled = true
			resolve(request.result)
		}
		request.onerror = () => {
			browserWindow.clearTimeout(timeout)
			if (settled) return
			settled = true
			reject(request.error ?? new Error("Could not open IndexedDB."))
		}
		request.onblocked = () => {
			browserWindow.clearTimeout(timeout)
			if (settled) return
			settled = true
			reject(new Error("Browser session storage is blocked."))
		}
	})
}

const openDatabase = async (settings: StoreSettings): Promise<IDBDatabase> => {
	const db = await openDatabaseRequest(settings)
	if (db.objectStoreNames.contains(settings.storeName)) {
		return db
	}

	const nextVersion = db.version + 1
	db.close()
	const upgraded = await openDatabaseRequest(settings, nextVersion)
	if (upgraded.objectStoreNames.contains(settings.storeName)) {
		return upgraded
	}

	upgraded.close()
	throw new Error("Browser session storage could not create its object store.")
}

const withStore = async <T>(
	settings: StoreSettings,
	mode: IDBTransactionMode,
	fn: (store: IDBObjectStore) => Promise<T>,
): Promise<T> => {
	const db = await openDatabase(settings)
	try {
		const tx = db.transaction(settings.storeName, mode)
		const completed = transactionToPromise(tx)
		const store = tx.objectStore(settings.storeName)
		try {
			const result = await fn(store)
			await completed
			return result
		} catch (error) {
			try {
				tx.abort()
			} catch {}
			await completed.catch(() => undefined)
			throw error
		}
	} finally {
		db.close()
	}
}

const getRecord = async <T>(
	settings: StoreSettings,
	id: string,
): Promise<T | undefined> =>
	withStore(settings, "readonly", async (store) => {
		const record = await requestToPromise<StoredRecord<T> | undefined>(
			store.get(id),
		)
		return record?.value
	})

const setRecord = async <T>(
	settings: StoreSettings,
	id: string,
	value: T,
): Promise<void> =>
	withStore(settings, "readwrite", async (store) => {
		await requestToPromise(store.put({ id, value }))
	})

const deleteRecord = async (
	settings: StoreSettings,
	id: string,
): Promise<void> =>
	withStore(settings, "readwrite", async (store) => {
		await requestToPromise(store.delete(id))
	})

const bytesToBase64 = (bytes: Uint8Array): string => {
	let binary = ""
	for (const byte of bytes) {
		binary += String.fromCharCode(byte)
	}
	return btoa(binary)
}

const base64ToBytes = (value: string): Uint8Array<ArrayBuffer> => {
	const decoded = atob(value)
	const bytes = new Uint8Array(decoded.length)
	for (let index = 0; index < decoded.length; index += 1) {
		bytes[index] = decoded.charCodeAt(index)
	}
	return bytes
}

const generateCryptoKey = async (): Promise<CryptoKey> => {
	const key = await globalThis.crypto.subtle.generateKey(
		{
			name: "AES-GCM",
			length: 256,
		},
		false,
		["encrypt", "decrypt"],
	)
	return key as CryptoKey
}

const getCryptoKey = async (settings: StoreSettings): Promise<CryptoKey> => {
	const existing = await getRecord<CryptoKey>(settings, settings.cryptoKey)
	if (existing) {
		return existing
	}

	// Generate outside the transaction, then recheck under its exclusive write
	// lock. Another tab may have installed a key while WebCrypto was running.
	const candidate = await generateCryptoKey()
	return withStore(settings, "readwrite", async (store) => {
		const record = await requestToPromise<StoredRecord<CryptoKey> | undefined>(
			store.get(settings.cryptoKey),
		)
		if (record) return record.value
		await requestToPromise(
			store.put({ id: settings.cryptoKey, value: candidate }),
		)
		return candidate
	})
}

const encryptSession = async (
	key: CryptoKey,
	session: OpenAIOAuthSession,
): Promise<EncryptedSession> => {
	const iv = new Uint8Array(12)
	globalThis.crypto.getRandomValues(iv)
	const ciphertext = await globalThis.crypto.subtle.encrypt(
		{
			name: "AES-GCM",
			iv,
		},
		key,
		textEncoder.encode(JSON.stringify(session)),
	)

	return {
		iv: bytesToBase64(iv),
		ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
	}
}

const decryptSession = async (
	key: CryptoKey,
	encrypted: EncryptedSession,
): Promise<OpenAIOAuthSession> => {
	const plaintext = await globalThis.crypto.subtle.decrypt(
		{
			name: "AES-GCM",
			iv: base64ToBytes(encrypted.iv),
		},
		key,
		base64ToBytes(encrypted.ciphertext),
	)
	const session: unknown = JSON.parse(textDecoder.decode(plaintext))
	if (
		typeof session !== "object" ||
		session === null ||
		!("accessToken" in session) ||
		typeof session.accessToken !== "string" ||
		!("accountId" in session) ||
		typeof session.accountId !== "string"
	) {
		throw new Error("The stored OpenAI OAuth session is malformed.")
	}
	return session as OpenAIOAuthSession
}

type SessionSnapshot = {
	session: OpenAIOAuthSession | null
	encrypted?: EncryptedSession
}

type SharedSessionOperation = {
	promise: Promise<OpenAIOAuthSession | null>
	controller: AbortController
	waiters: number
}

type PendingSessionRefresh = SharedSessionOperation & {
	generation: number
}

type PendingLoginOperation = SharedSessionOperation & {
	key: string
	generation: number
	snapshot?: SessionSnapshot
	retentionTimer?: ReturnType<typeof setTimeout>
}

type SessionCoordination = {
	/** Changes for explicit login/logout/replacement, not maintenance refresh. */
	generation: number
	tail: Promise<void>
	refresh?: PendingSessionRefresh
	login?: PendingLoginOperation
}

type BrowserStoreOperations = {
	read(): Promise<SessionSnapshot>
	compareAndSet(
		snapshot: SessionSnapshot,
		session: OpenAIOAuthSession,
		signal?: AbortSignal,
	): Promise<SessionSnapshot | undefined>
}

const coordinators = new WeakMap<SessionStore, SessionCoordination>()
const browserCoordinators = new Map<string, SessionCoordination>()
const browserStoreOperations = new WeakMap<
	SessionStore,
	BrowserStoreOperations
>()

const newCoordination = (): SessionCoordination => ({
	generation: 0,
	tail: Promise.resolve(),
})

const coordinationFor = (store: SessionStore): SessionCoordination => {
	let coordination = coordinators.get(store)
	if (!coordination) {
		coordination = newCoordination()
		coordinators.set(store, coordination)
	}
	return coordination
}

const invalidatePendingLogin = (coordination: SessionCoordination): void => {
	coordination.login?.controller.abort()
	clearTimeout(coordination.login?.retentionTimer)
	coordination.login = undefined
}

const invalidateSessionOwner = (coordination: SessionCoordination): void => {
	coordination.generation += 1
	invalidatePendingLogin(coordination)
}

const serializeSessionOperation = <T>(
	coordination: SessionCoordination,
	operation: () => Promise<T>,
): Promise<T> => {
	const result = coordination.tail.then(operation)
	coordination.tail = result.then(
		() => undefined,
		() => undefined,
	)
	return result
}

const sameSession = (
	left: OpenAIOAuthSession | null,
	right: OpenAIOAuthSession | null,
): boolean =>
	left === right ||
	(left !== null &&
		right !== null &&
		left.accountId === right.accountId &&
		left.accessToken === right.accessToken &&
		left.refreshToken === right.refreshToken &&
		left.idToken === right.idToken &&
		left.isFedRamp === right.isFedRamp &&
		left.expiresAt === right.expiresAt &&
		left.lastRefresh === right.lastRefresh)

const readSessionSnapshot = (store: SessionStore): Promise<SessionSnapshot> => {
	const browser = browserStoreOperations.get(store)
	return browser
		? browser.read()
		: store
				.get()
				.then((session) => ({ session: session ? { ...session } : null }))
}

const waitForSessionOperation = <T>(
	promise: Promise<T>,
	signal?: AbortSignal,
): Promise<T> => {
	if (!signal) return promise
	return new Promise((resolve, reject) => {
		const abort = () =>
			reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
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
		if (signal.aborted) abort()
	})
}

const readCurrentSession = (
	store: SessionStore,
	signal?: AbortSignal,
): Promise<OpenAIOAuthSession | null> =>
	waitForSessionOperation(
		serializeSessionOperation(coordinationFor(store), () => store.get()),
		signal,
	)

const commitSession = (
	store: SessionStore,
	snapshotOrRead: SessionSnapshot | (() => SessionSnapshot),
	generation: number,
	session: OpenAIOAuthSession,
	signal?: AbortSignal,
	ownerChange = false,
): Promise<boolean> => {
	const coordination = coordinationFor(store)
	return serializeSessionOperation(coordination, async () => {
		signal?.throwIfAborted()
		if (coordination.generation !== generation) return false
		const snapshot =
			typeof snapshotOrRead === "function" ? snapshotOrRead() : snapshotOrRead
		const browser = browserStoreOperations.get(store)
		let committed: SessionSnapshot
		if (browser) {
			const next = await browser.compareAndSet(snapshot, session, signal)
			if (!next) return false
			committed = next
		} else {
			// Custom stores need their own CAS for writers outside this realm.
			if (
				!sameSession(await store.get(), snapshot.session) ||
				coordination.generation !== generation
			)
				return false
			signal?.throwIfAborted()
			await store.set(session)
			committed = { session: { ...session } }
		}
		if (coordination.generation !== generation) return false
		if (ownerChange) {
			coordination.generation += 1
			if (coordination.login?.generation === generation) {
				coordination.login.generation = coordination.generation
			}
		} else {
			// Maintenance may rotate the old credential while an explicit login is
			// pending. Advance only that login's verified predecessor snapshot, not
			// its owner-intent generation, so the intentional login can still commit.
			const login = coordination.login
			if (
				login?.generation === generation &&
				login.snapshot &&
				sameSession(login.snapshot.session, snapshot.session)
			) {
				login.snapshot = committed
			}
		}
		return true
	})
}

export const createSessionStore = (
	options: BrowserSessionStoreOptions = {},
): SessionStore => {
	const settings: StoreSettings = {
		...defaultStoreSettings,
		...options,
	}

	const coordinationKey = JSON.stringify([
		settings.dbName,
		settings.storeName,
		settings.sessionKey,
	])
	let coordination = browserCoordinators.get(coordinationKey)
	if (!coordination) {
		coordination = newCoordination()
		browserCoordinators.set(coordinationKey, coordination)
	}
	const current = coordination
	const read = async (): Promise<SessionSnapshot> => {
		const encrypted = await getRecord<EncryptedSession>(
			settings,
			settings.sessionKey,
		)
		if (!encrypted) return { session: null }
		if (
			typeof encrypted.iv !== "string" ||
			typeof encrypted.ciphertext !== "string"
		) {
			throw new Error("The stored OpenAI OAuth session is malformed.")
		}
		return {
			encrypted,
			session: await decryptSession(await getCryptoKey(settings), encrypted),
		}
	}
	const store: SessionStore = {
		get: async () => (await read()).session,
		set: (session) => {
			invalidateSessionOwner(current)
			return serializeSessionOperation(current, async () => {
				const key = await getCryptoKey(settings)
				await setRecord(
					settings,
					settings.sessionKey,
					await encryptSession(key, session),
				)
			})
		},
		clear: () => {
			invalidateSessionOwner(current)
			return serializeSessionOperation(current, () =>
				deleteRecord(settings, settings.sessionKey),
			)
		},
	}
	coordinators.set(store, current)
	browserStoreOperations.set(store, {
		read,
		compareAndSet: async (snapshot, session, signal) => {
			const encrypted = await encryptSession(
				await getCryptoKey(settings),
				session,
			)
			signal?.throwIfAborted()
			return withStore(settings, "readwrite", async (records) => {
				const record = await requestToPromise<
					StoredRecord<EncryptedSession> | undefined
				>(records.get(settings.sessionKey))
				if (
					record?.value.iv !== snapshot.encrypted?.iv ||
					record?.value.ciphertext !== snapshot.encrypted?.ciphertext
				)
					return undefined
				signal?.throwIfAborted()
				await requestToPromise(
					records.put({ id: settings.sessionKey, value: encrypted }),
				)
				return { session: { ...session }, encrypted }
			})
		},
	})
	return store
}

let defaultSessionStore: SessionStore | undefined

const getDefaultSessionStore = (): SessionStore => {
	defaultSessionStore ??= createSessionStore()
	return defaultSessionStore
}

const parseIsoDate = (value: string | undefined): Date | undefined => {
	if (typeof value !== "string" || value.length === 0) {
		return undefined
	}
	const date = new Date(value)
	return Number.isNaN(date.getTime()) ? undefined : date
}

const shouldRefreshSession = (
	session: OpenAIOAuthSession,
	now: Date,
): boolean => {
	const expiresAt = parseIsoDate(session.expiresAt)
	if (
		expiresAt &&
		expiresAt.getTime() <= now.getTime() + refreshExpiryMarginMs
	) {
		return true
	}

	const claims = parseJwtClaims(session.accessToken)
	const exp = claims && typeof claims.exp === "number" ? claims.exp : undefined
	if (
		typeof exp === "number" &&
		exp * 1000 <= now.getTime() + refreshExpiryMarginMs
	) {
		return true
	}

	const lastRefresh = parseIsoDate(session.lastRefresh)
	return lastRefresh
		? lastRefresh.getTime() <= now.getTime() - refreshIntervalMs
		: false
}

const toSession = (
	token: OpenAIOAuthTokenResponse,
	options: {
		previousRefreshToken?: string
		now: Date
	},
): OpenAIOAuthSession => {
	const accountId =
		token.accountId ??
		deriveAccountId(token.idToken) ??
		deriveAccountId(token.accessToken)

	if (!accountId) {
		throw new Error(
			"ChatGPT account id not found in OpenAI OAuth token response.",
		)
	}

	return {
		accessToken: token.accessToken,
		accountId,
		isFedRamp: token.isFedRamp,
		idToken: token.idToken,
		refreshToken: token.refreshToken ?? options.previousRefreshToken,
		expiresAt:
			typeof token.expiresIn === "number"
				? new Date(options.now.getTime() + token.expiresIn * 1000).toISOString()
				: undefined,
		lastRefresh: options.now.toISOString(),
	}
}

export const exchangeCode = async (
	input: ExchangeCodeInput,
	options: ExchangeCodeOptions = {},
): Promise<OpenAIOAuthSession> => {
	const token = await exchangeOpenAIOAuthCode({
		code: input.code,
		codeVerifier: input.codeVerifier,
		redirectUri: input.redirectUri,
		clientId: options.clientId,
		issuer: options.issuer,
		tokenUrl: options.tokenUrl,
		fetch: options.fetch,
		signal: input.signal,
	})
	return toSession(token, {
		now: (options.now ?? (() => new Date()))(),
	})
}

export const refreshSession = async (
	input: RefreshSessionInput,
	options: RefreshSessionOptions = {},
): Promise<OpenAIOAuthSession> => {
	const token = await refreshOpenAIOAuthTokens({
		refreshToken: input.refreshToken,
		clientId: options.clientId,
		issuer: options.issuer,
		tokenUrl: options.tokenUrl,
		fetch: options.fetch,
		signal: input.signal,
	})
	return toSession(token, {
		previousRefreshToken: input.refreshToken,
		now: (options.now ?? (() => new Date()))(),
	})
}

const joinSessionOperation = (
	pending: SharedSessionOperation,
	signal?: AbortSignal,
): Promise<OpenAIOAuthSession | null> => {
	pending.waiters += 1
	return new Promise((resolve, reject) => {
		let settled = false
		const finish = (operation: () => void) => {
			if (settled) return
			settled = true
			signal?.removeEventListener("abort", abort)
			pending.waiters -= 1
			operation()
		}
		const abort = () =>
			finish(() => {
				if (pending.waiters === 0) pending.controller.abort()
				reject(signal?.reason ?? new DOMException("Aborted", "AbortError"))
			})
		signal?.addEventListener("abort", abort, { once: true })
		void pending.promise.then(
			(session) => finish(() => resolve(session)),
			(error) => finish(() => reject(error)),
		)
		if (signal?.aborted) abort()
	})
}

const loadSession = async (
	options: BrowserSessionOptions,
	force: boolean,
): Promise<OpenAIOAuthSession | null> => {
	options.signal?.throwIfAborted()
	const timeoutMs = options.refreshTimeoutMs ?? 30_000
	if (
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs <= 0 ||
		timeoutMs > 2_147_483_647
	)
		throw new Error("refreshTimeoutMs must be a positive supported duration.")
	const store = options.sessionStore ?? getDefaultSessionStore()
	const coordination = coordinationFor(store)
	const generation = coordination.generation
	if (
		options.refresh !== false &&
		coordination.refresh?.generation === generation &&
		!coordination.refresh.controller.signal.aborted
	) {
		return joinSessionOperation(coordination.refresh, options.signal)
	}
	const snapshot = await waitForSessionOperation(
		serializeSessionOperation(coordination, () => readSessionSnapshot(store)),
		options.signal,
	)
	options.signal?.throwIfAborted()
	if (coordination.generation !== generation)
		return readCurrentSession(store, options.signal)
	const session = snapshot.session
	if (
		!session ||
		options.refresh === false ||
		!session.refreshToken ||
		(!force &&
			!shouldRefreshSession(session, (options.now ?? (() => new Date()))()))
	) {
		return session
	}
	if (
		coordination.refresh?.generation === generation &&
		!coordination.refresh.controller.signal.aborted
	) {
		return joinSessionOperation(coordination.refresh, options.signal)
	}
	const refreshToken = session.refreshToken
	const controller = new AbortController()
	const signal = controller.signal
	const timeout = setTimeout(
		() =>
			controller.abort(new Error("OpenAI OAuth session refresh timed out.")),
		timeoutMs,
	)
	const work = (async () => {
		try {
			const refreshed = await refreshSession(
				{
					refreshToken,
					signal,
				},
				options,
			)
			signal.throwIfAborted()
			if (refreshed.accountId !== session.accountId) {
				throw new Error("Refreshed OpenAI OAuth session changed account.")
			}
			const next =
				session.isFedRamp && !refreshed.isFedRamp
					? { ...refreshed, isFedRamp: true }
					: refreshed
			if (await commitSession(store, snapshot, generation, next, signal))
				return next
			return readCurrentSession(store, signal)
		} catch (error) {
			signal.throwIfAborted()
			const current = await readCurrentSession(store, signal)
			if (
				coordination.generation !== generation ||
				!sameSession(current, session)
			)
				return current
			throw error
		}
	})()
	// Bound the complete shared operation, including serialized storage work.
	// Its signal also fences continuations that outlive an ignored abort.
	const promise = waitForSessionOperation(work, signal)
	const pending = { generation, promise, controller, waiters: 0 }
	coordination.refresh = pending
	const clear = () => {
		clearTimeout(timeout)
		if (coordination.refresh === pending) coordination.refresh = undefined
	}
	void promise.then(clear, clear)
	return joinSessionOperation(pending, options.signal)
}

export const getSession = (
	options: BrowserSessionOptions = {},
): Promise<OpenAIOAuthSession | null> => loadSession(options, false)

/** Refresh the current stored credential without overwriting a newer login. */
export const refreshStoredSession = (
	options: BrowserSessionOptions = {},
): Promise<OpenAIOAuthSession | null> =>
	loadSession({ ...options, refresh: true }, true)

export const openaiAuthHeaders = async (
	options: OpenAIAuthHeadersOptions = {},
): Promise<OpenAIAuthHeaders> => {
	const session = await getSession(options)
	if (!session) {
		if (options.optional) {
			return toPlainHeaders(new Headers(options.headers))
		}
		throw new Error("OpenAI OAuth session not found.")
	}

	const headers = new Headers(options.headers)
	headers.set("Authorization", `Bearer ${session.accessToken}`)
	headers.set("chatgpt-account-id", session.accountId)
	if (session.isFedRamp) {
		headers.set("X-OpenAI-Fedramp", "true")
	}
	return toPlainHeaders(headers)
}

const toPlainHeaders = (headers: Headers): OpenAIAuthHeaders => {
	const output: OpenAIAuthHeaders = {}
	headers.forEach((value, key) => {
		output[key] = value
	})
	return output
}

const readPendingLogin = (): PendingLogin | undefined => {
	const browserWindow = assertBrowserWindow()
	try {
		const value = browserWindow.sessionStorage.getItem(pendingLoginKey)
		return value ? (JSON.parse(value) as PendingLogin) : undefined
	} catch {
		return undefined
	}
}

const writePendingLogin = (pending: PendingLogin): void => {
	assertBrowserWindow().sessionStorage.setItem(
		pendingLoginKey,
		JSON.stringify(pending),
	)
}

const clearPendingLogin = (): void => {
	assertBrowserWindow().sessionStorage.removeItem(pendingLoginKey)
}

const getCurrentRelativeUrl = (): string => {
	const browserWindow = assertBrowserWindow()
	return `${browserWindow.location.pathname}${browserWindow.location.search}${browserWindow.location.hash}`
}

const getDefaultRedirectUri = (callbackPath: string): string =>
	new URL(callbackPath, assertBrowserWindow().location.origin).toString()

const getCurrentUrl = (): string =>
	new URL(
		getCurrentRelativeUrl(),
		assertBrowserWindow().location.origin,
	).toString()

const bytesToBase64Url = (bytes: Uint8Array): string =>
	bytesToBase64(bytes)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "")

const randomURLSafeString = (byteLength: number): string => {
	const bytes = new Uint8Array(byteLength)
	globalThis.crypto.getRandomValues(bytes)
	return bytesToBase64Url(bytes)
}

const encodeBase64Url = (value: string): string =>
	bytesToBase64Url(textEncoder.encode(value))

const createBrowserExtensionState = (
	callbackUrl: string,
	appState?: string,
): string => {
	const payload: Record<string, string | number> = {
		type: "openai-oauth-callback",
		version: 1,
		nonce: randomURLSafeString(24),
		callbackUrl,
	}
	if (appState) {
		payload.appState = appState
	}

	return `${browserExtensionStatePrefix}${encodeBase64Url(JSON.stringify(payload))}`
}

export const startLogin = async (
	options: StartLoginOptions = {},
): Promise<
	{ status: "needs-extension"; installUrl: string } | { status: "started" }
> => {
	const browserWindow = assertBrowserWindow()
	const usesBrowserExtension = options.redirectUri === undefined
	const browserExtension = getBrowserExtension(browserWindow)
	if (usesBrowserExtension && !(await browserExtension.isInstalled())) {
		return {
			status: "needs-extension",
			installUrl: browserExtension.installUrl,
		}
	}

	const coordination = coordinationFor(
		options.sessionStore ?? getDefaultSessionStore(),
	)
	invalidateSessionOwner(coordination)
	const generation = coordination.generation
	const returnTo = options.returnTo ?? getCurrentRelativeUrl()
	const callbackUrl = options.callbackPath
		? getDefaultRedirectUri(options.callbackPath)
		: usesBrowserExtension
			? getCurrentUrl()
			: getDefaultRedirectUri("/auth/callback")
	const redirectUri = options.redirectUri ?? browserExtensionRedirectUri
	const request = await createOpenAIOAuthRequest({
		clientId: options.clientId,
		issuer: options.issuer,
		scope: options.scope,
		state: usesBrowserExtension
			? createBrowserExtensionState(callbackUrl, options.state)
			: options.state,
		codeVerifier: options.codeVerifier,
		simplifiedFlow: options.simplifiedFlow,
		idTokenAddOrganizations: options.idTokenAddOrganizations,
		extraParams: options.extraParams,
		redirectUri,
	})

	if (coordination.generation !== generation) {
		throw new Error("OpenAI OAuth login was superseded.")
	}
	writePendingLogin({
		state: request.state,
		codeVerifier: request.codeVerifier,
		redirectUri: request.redirectUri,
		returnTo,
	})

	if (options.openMode === "popup") {
		const popup = browserWindow.open(
			request.authorizationUrl,
			"_blank",
			"popup,width=520,height=720",
		)
		if (!popup) {
			throw new Error("The ChatGPT login popup was blocked.")
		}
		return { status: "started" }
	}

	browserWindow.location.assign(request.authorizationUrl)
	return { status: "started" }
}

const callbackOperationKey = (
	pending: PendingLogin,
	code: string,
	options: CompleteLoginOptions,
): string =>
	JSON.stringify([
		pending.state,
		pending.codeVerifier,
		pending.redirectUri,
		code,
		options.clientId ?? null,
		options.issuer ?? null,
		options.tokenUrl ?? null,
	])

export const completeLogin = async (
	options: CompleteLoginOptions = {},
): Promise<OpenAIOAuthSession | null> => {
	options.signal?.throwIfAborted()
	const browserWindow = assertBrowserWindow()
	const url = new URL(options.url ?? browserWindow.location.href)
	const oauthError = url.searchParams.get("error")
	const code = url.searchParams.get("code")
	const callbackState = url.searchParams.get("state")
	const sessionStore = options.sessionStore ?? getDefaultSessionStore()
	if (!oauthError && !code) return null

	const pending = readPendingLogin()
	if (!pending) {
		const existingSession = await readCurrentSession(
			sessionStore,
			options.signal,
		)
		options.signal?.throwIfAborted()
		if (existingSession) {
			browserWindow.history.replaceState(null, "", "/")
			return existingSession
		}
	}
	if (oauthError) {
		if (
			oauthError === "access_denied" &&
			pending &&
			callbackState === pending.state
		) {
			invalidateSessionOwner(coordinationFor(sessionStore))
			clearPendingLogin()
			browserWindow.history.replaceState(null, "", pending.returnTo || "/")
			return null
		}
		throw new Error(
			url.searchParams.get("error_description") ??
				`OpenAI OAuth returned ${oauthError}.`,
		)
	}
	if (!pending || !callbackState || pending.state !== callbackState)
		throw new Error("OpenAI OAuth callback state did not match.")
	if (!code) throw new Error("OpenAI OAuth callback did not include a code.")

	const coordination = coordinationFor(sessionStore)
	const key = callbackOperationKey(pending, code, options)
	if (
		coordination.login?.key === key &&
		coordination.login.generation === coordination.generation
	) {
		return joinSessionOperation(coordination.login, options.signal)
	}
	const timeoutMs = options.callbackTimeoutMs ?? 5 * 60 * 1000
	if (
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs <= 0 ||
		timeoutMs > 2_147_483_647
	)
		throw new Error("Callback timeout must be a positive supported duration.")
	invalidateSessionOwner(coordination)
	const generation = coordination.generation
	const controller = new AbortController()
	const operation: PendingLoginOperation = {
		key,
		generation,
		controller,
		waiters: 0,
		promise: Promise.resolve(null),
	}
	coordination.login = operation
	const timeout = setTimeout(
		() =>
			controller.abort(new Error("OpenAI OAuth callback exchange timed out.")),
		timeoutMs,
	)
	const signal = controller.signal
	const work = Promise.resolve().then(async () => {
		// Read under the same serialization tail as maintenance writes. A refresh
		// can later advance this snapshot only after a verified same-owner commit.
		await waitForSessionOperation(
			serializeSessionOperation(coordination, async () => {
				signal.throwIfAborted()
				operation.snapshot = await readSessionSnapshot(sessionStore)
			}),
			signal,
		)
		signal.throwIfAborted()
		const session = await waitForSessionOperation(
			exchangeCode(
				{
					code,
					codeVerifier: pending.codeVerifier,
					redirectUri: pending.redirectUri,
					signal,
				},
				options,
			),
			signal,
		)
		signal.throwIfAborted()
		if (readPendingLogin()?.state !== pending.state) return null
		if (
			!(await waitForSessionOperation(
				commitSession(
					sessionStore,
					() => {
						if (!operation.snapshot)
							throw new Error("Login snapshot is unavailable.")
						return operation.snapshot
					},
					generation,
					session,
					signal,
					true,
				),
				signal,
			))
		)
			return null
		if (readPendingLogin()?.state === pending.state) {
			clearPendingLogin()
			browserWindow.history.replaceState(null, "", pending.returnTo || "/")
		}
		return session
	})
	operation.promise = waitForSessionOperation(work, signal)
	const settled = () => {
		clearTimeout(timeout)
		if (coordination.login !== operation) return
		// Retain at most one settled callback for this store for a short window:
		// a duplicate consumer must not exchange the same one-use code again.
		operation.retentionTimer = setTimeout(() => {
			if (coordination.login === operation) coordination.login = undefined
		}, 60_000)
		;(operation.retentionTimer as unknown as { unref?: () => void }).unref?.()
	}
	void operation.promise.then(settled, settled)
	return joinSessionOperation(operation, options.signal)
}

export const logout = async (options: LogoutOptions = {}): Promise<void> => {
	try {
		clearPendingLogin()
	} catch {}
	const store = options.sessionStore ?? getDefaultSessionStore()
	const coordination = coordinationFor(store)
	invalidateSessionOwner(coordination)
	if (browserStoreOperations.has(store)) {
		await store.clear()
	} else {
		await serializeSessionOperation(coordination, () => store.clear())
	}
}
