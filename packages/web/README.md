# @openai-oauth/web

[Docs](https://github.com/EvanZhouDev/openai-oauth#react-component) | [GitHub](https://github.com/EvanZhouDev/openai-oauth) | [npm](https://www.npmjs.com/package/@openai-oauth/web)

Framework-neutral browser sign-in primitives for OpenAI OAuth.

```bash
npm i @openai-oauth/web
```

Most React apps should use `@openai-oauth/react`, which depends on this package and re-exports the common browser helpers.

```ts
import { openaiAuthHeaders } from "@openai-oauth/web";

await fetch("/api/chat", {
	method: "POST",
	headers: await openaiAuthHeaders(),
	body: "Hello!",
});
```

## Package Notes

`@openai-oauth/web` is the lower-level web package. Use it when you need browser primitives without React.


Model requests cannot be made directly from a browser due to CORS. This also applies for Desktop apps inside a WebView or browser renderer such as Electron or Tauri. You can use this package for sign-in and session storage, but run model requests through native desktop networking.

### Hosted Sign-in

Hosted browser sign-in uses the open-source Sign in with ChatGPT extension for [Chrome](https://chromewebstore.google.com/detail/sign-in-with-chatgpt/odbgboachaefbbbdiffcefhpkekhfcna) or [Firefox](https://addons.mozilla.org/firefox/addon/sign-in-with-chatgpt/) to complete OpenAI's local OAuth callback. The extension shows the destination app for confirmation and then returns the callback directly to it.

`startLogin()` uses this extension flow by default. When installation is needed, it returns the correct Chrome Web Store or Firefox Add-ons URL for your interface to display:

```ts
import { startLogin } from "@openai-oauth/web";

const result = await startLogin();

if (result.status === "needs-extension") {
	installLink.href = result.installUrl;
	installScreen.hidden = false;
}
```

After installation, call `startLogin()` again when the user returns to your app or presses Sign in again. It will start OAuth once the extension is available.

The extension redirects only `http://localhost:1455/auth/callback`. After the user confirms the destination, call `completeLogin()` on the returned app URL to exchange the code and save the browser session.

`startLogin()` returns `{ status: "started" }` when OAuth begins or `{ status: "needs-extension", installUrl }` when your interface should show installation UI. Provide an explicit `redirectUri` only when your environment handles its own registered callback without the extension.

### Browser Session

```ts
import { createSessionStore, getSession, openaiAuthHeaders } from "@openai-oauth/web";

const sessionStore = createSessionStore();
const session = await getSession({ sessionStore });
const headers = await openaiAuthHeaders({ sessionStore });
```

`getSession()` reads the browser session store and refreshes with the stored refresh token when needed. `refreshStoredSession()` explicitly refreshes the current stored credential with the same safeguards; `refreshSession()` is the lower-level token exchange and does not persist a session.

Stored refreshes are coalesced within one JavaScript realm and store namespace. Local generation checks fence logout/account replacement, and the built-in IndexedDB store uses an atomic encrypted-snapshot comparison before committing a refreshed credential. Its encryption-key initialization is also atomic. These checks do not provide cross-tab network singleflight or broadcast UI synchronization. Custom three-method `SessionStore` implementations must coordinate their own external writers; a read/check/write is not cross-tab compare-and-set. Pass `signal` to cancel a session load or callback; cancelling one refresh waiter does not cancel other subscribers.

`openaiAuthHeaders()` returns a plain object of request headers for your own app route:

```ts
const headers = await openaiAuthHeaders({
	headers: { "content-type": "application/json" },
});
```

Because it returns a plain object, the result can be passed directly to `fetch`, AI SDK hooks, and other code that spreads header objects.

It includes:

- `Authorization: Bearer <access token>`
- `chatgpt-account-id: <account id>`

### Server Credentials

Use `@openai-oauth/web/server` in the app route that receives those headers:

```ts
import { createOpenAIOAuth } from "@openai-oauth/ai-sdk";
import { openaiCredentials } from "@openai-oauth/web/server";
import { generateText } from "ai";

export async function POST(request: Request) {
	const openai = createOpenAIOAuth(openaiCredentials(request));

	const result = await generateText({
		model: openai("gpt-5.4-mini"),
		prompt: await request.text(),
	});

	return new Response(result.text);
}
```

`openaiCredentials(request)` reads the request headers and returns an `OpenAIOAuth` credential source for client adapters.

### Session Store

The default store persists the session in IndexedDB and encrypts each payload with a non-extractable WebCrypto AES-GCM key.

Apps can provide their own store:

```ts
type SessionStore = {
	get(): Promise<OpenAIOAuthSession | null>;
	set(session: OpenAIOAuthSession): Promise<void>;
	clear(): Promise<void>;
};
```

### Direct Token Exchange

```ts
import { exchangeCode, refreshSession } from "@openai-oauth/web";

const session = await exchangeCode({
	code,
	codeVerifier,
	redirectUri,
});

const refreshed = await refreshSession({
	refreshToken: session.refreshToken,
});
```

### Login Helpers

```ts
import { completeLogin, logout, startLogin } from "@openai-oauth/web";

await startLogin();
await completeLogin();
await logout();
```

`completeLogin()` returns the signed-in session when the current URL contains an OAuth callback, and `null` when there is no callback to complete.

Callback consumers sharing a store/pending-login identity in one JavaScript realm share one code exchange. Cancelling one subscriber does not cancel the others; cancelling the last subscriber prevents late persistence. `callbackTimeoutMs` bounds the shared callback operation (default five minutes). At most one settled callback is retained per store for one minute to avoid immediate one-use-code retries. Pending storage reads are caller-cancellable without abandoning the store's internal serialization order.

Maintenance refreshes do not invalidate a pending explicit login. They may advance that login's verified credential snapshot; logout, a newer login, or an explicit store replacement still wins. When using a custom store, pass the same `sessionStore` to `startLogin`, `completeLogin`, and session helpers. This is in-realm arbitration, not cross-tab network single-flight; custom external writers still require their own atomic coordination.

Maintenance refreshes have an operation-owned `refreshTimeoutMs` deadline (default 30 seconds), covering token exchange, body reads and pre-commit waits. A timeout clears the shared pending operation so a later call can retry, and late results cannot replace the session. Cancelling one subscriber does not cancel another subscriber's refresh.

Useful browser options:

```ts
type BrowserSessionOptions = {
	sessionStore?: SessionStore;
	clientId?: string;
	issuer?: string;
	tokenUrl?: string;
	fetch?: typeof fetch;
	refresh?: boolean;
	refreshTimeoutMs?: number;
	now?: () => Date;
};
```

Useful server options:

```ts
type WebServerOpenAIOAuthOptions = {
	baseURL?: string;
	fetch?: typeof fetch;
	headers?: Record<string, string>;
	instructions?: string;
	openAIBaseURL?: string;
};
```

## More

[Learn more in the openai-oauth README.](https://github.com/EvanZhouDev/openai-oauth#react-component)
