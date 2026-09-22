# @openai-oauth/core

[Docs](https://github.com/EvanZhouDev/openai-oauth#sdk-overview) | [GitHub](https://github.com/EvanZhouDev/openai-oauth) | [npm](https://www.npmjs.com/package/@openai-oauth/core)

Lowest-level OpenAI OAuth and OpenAI-compatible transport primitives.

```bash
npm i @openai-oauth/core
```

Most apps should use `openai-oauth`, `@openai-oauth/local`, `@openai-oauth/react`, `@openai-oauth/ai-sdk`, or `@openai-oauth/openai-client` instead.

## Package Notes

`@openai-oauth/core` is for advanced integrations and adapter authors.

Create an OpenAI-compatible transport from an explicit auth source:

```ts
import { createOpenAIOAuthTransport } from "@openai-oauth/core";

const transport = createOpenAIOAuthTransport({
	auth: async () => session,
});

const baseURL = transport.baseURL;
const fetch = transport.fetch;
```

The transport supports Responses, model discovery, image generation, and multipart image editing. Client adapters build higher-level interfaces such as Chat Completions on top.

Create an OAuth request:

```ts
import { createOpenAIOAuthRequest } from "@openai-oauth/core";

const request = await createOpenAIOAuthRequest({
	redirectUri: "https://app.example.com/auth/callback",
});
```

Core exports include:

- `createOpenAIOAuthTransport`
- `createOpenAIOAuthRequest`
- `exchangeOpenAIOAuthCode`
- `refreshOpenAIOAuthTokens`
- `OpenAIOAuth`
- `OpenAIOAuthSession`
- `SessionStore`

## Model catalogs and capabilities

Transports created by `createOpenAIOAuthTransport` expose `getModelCatalog`. It is optional on the structural `OpenAIOAuthTransport` type so custom ready transports remain compatible.

```ts
const catalog = await transport.getModelCatalog({ mode: "public-api" });
const cached = await transport.getModelCatalog({ cacheOnly: true });
const refreshed = await transport.getModelCatalog({ refresh: true });
```

Listing modes:

- `public-api` (default): retains the existing visibility and `supported_in_api` filter.
- `oauth-visible`: visible account-returned models, including those marked API-unsupported.
- `all`: all valid entries returned by that account's catalog, including hidden entries.

These modes describe metadata, not entitlement. The typed catalog does not synthesize image-model entries. Existing compatible `/models` behavior remains unchanged.

Snapshots include `models`, `freshness` (`fresh`, `stale`, `missing`), available `etag`, `clientVersion`, `fetchedAt`, `validatedAt`, and the observed `owner`. Models expose validated optional reasoning, image-detail, modality, service-tier and context-budget fields alongside untouched `raw` metadata. Missing values remain unknown; explicit false and empty arrays retain their meaning. Inspection does not strip or rewrite caller request options.

Catalog caches partition by available stable owner/user/plan, routing and client-version identity rather than ordinary token churn. Valid model-version signals from HTTP or WebSocket responses renew matching metadata or request a deduplicated, rate-limited refresh. Revalidation attempts are limited to one per identity per minute; a further change observed during that interval waits for a later signal or normal TTL refresh, not a scheduled polling job. Existing bounded stale fallback and operation deadlines remain; no conditional-GET support is assumed. Authenticated discovery rejects redirects.

`cacheOnly` performs no credential loading or network access. Its owner is the **last observed** owner, not verification of current external credentials. A cache miss is explicit. Normal/forced calls resolve current credentials; caller cancellation does not cancel another subscriber's useful shared discovery. Combining `cacheOnly` and `refresh` is invalid.

## Read-only context inspection

```ts
import { inspectContextBudget } from "@openai-oauth/core";

const request = {
    model: "your-model",
    instructions: "Answer concisely.",
    input: [{ role: "user", content: "Explain the change." }],
};
const budget = inspectContextBudget(request, {
    catalog,
    // Optional application-supplied tokenizer or explicitly approximate estimator.
    estimateTokens: (text) => Math.ceil(text.length / 4),
});
console.log(budget.estimatedTextTokens, budget.unknownComponents);
```

Without an estimator, inspection returns known metadata and unknown-cost information, not a guessed token count. The example estimator is only a rough heuristic, not a model tokenizer. Estimates are labeled approximate and cover extracted text: instructions, messages, tool definitions and textual tool inputs/outputs. Protocol overhead remains unknown; images, audio, files, encrypted content and unresolved continuation references are not counted as their URL/base64 text.

Context/max-window/headroom/threshold metadata remain distinct. No automatic 90% threshold or exact remaining-token guarantee is invented. Traversal is bounded and cycle-safe. This pure helper does not fetch metadata, expand cached history, authenticate, execute inference, mutate state, truncate input or compact conversations.

## More

[Learn more in the openai-oauth README.](https://github.com/EvanZhouDev/openai-oauth#sdk-overview)
