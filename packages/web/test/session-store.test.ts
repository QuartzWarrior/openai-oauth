import "fake-indexeddb/auto"
import { afterEach, describe, expect, test, vi } from "vitest"
import { createSessionStore } from "../src/index.js"

const transactionDone = (transaction: IDBTransaction) =>
	new Promise<void>((resolve, reject) => {
		transaction.oncomplete = () => resolve()
		transaction.onerror = () => reject(transaction.error)
	})

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

describe("browser session store", () => {
	test("concurrent initializers share one persisted encryption key", async () => {
		vi.stubGlobal("window", globalThis)
		const generateKey = crypto.subtle.generateKey.bind(crypto.subtle)
		let release!: () => void
		const bothGenerated = new Promise<void>((resolve) => {
			release = resolve
		})
		let generated = 0
		vi.spyOn(crypto.subtle, "generateKey").mockImplementation(
			async (...args) => {
				const key = await generateKey(...args)
				generated += 1
				if (generated === 2) release()
				await bothGenerated
				return key
			},
		)
		// Different session slots share the same key, as independent tabs can.
		const a = createSessionStore({ dbName: "concurrent-key", sessionKey: "a" })
		const b = createSessionStore({ dbName: "concurrent-key", sessionKey: "b" })
		const sessionA = { accessToken: "token-a", accountId: "a" }
		const sessionB = { accessToken: "token-b", accountId: "b" }
		await Promise.all([a.set(sessionA), b.set(sessionB)])
		expect(generated).toBe(2)
		await expect(a.get()).resolves.toEqual(sessionA)
		await expect(b.get()).resolves.toEqual(sessionB)
	})

	test("persists, reads, and clears an encrypted session", async () => {
		vi.stubGlobal("window", globalThis)
		const store = createSessionStore({ dbName: "session-store-roundtrip" })
		const session = { accessToken: "token", accountId: "account" }

		await store.set(session)
		await expect(store.get()).resolves.toEqual(session)
		await store.clear()
		await expect(store.get()).resolves.toBeNull()
	})

	test("surfaces malformed stored sessions", async () => {
		vi.stubGlobal("window", globalThis)
		const dbName = "session-store-malformed"
		const store = createSessionStore({ dbName })
		await store.set({ accessToken: "token", accountId: "account" })

		const request = indexedDB.open(dbName)
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			request.onsuccess = () => resolve(request.result)
			request.onerror = () => reject(request.error)
		})
		const transaction = db.transaction("sessions", "readwrite")
		transaction.objectStore("sessions").put({
			id: "openai-oauth:session",
			value: { iv: 1, ciphertext: null },
		})
		await transactionDone(transaction)
		db.close()

		await expect(store.get()).rejects.toThrow(
			"stored OpenAI OAuth session is malformed",
		)
	})
})
