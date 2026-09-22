# @openai-oauth/pool

[Docs](https://github.com/EvanZhouDev/openai-oauth#typescript-sdk) | [GitHub](https://github.com/EvanZhouDev/openai-oauth)

An unofficial, account-scoped OAuth adapter with bounded request admission and health-aware scheduling. Use only accounts and requests you are authorized to operate. Compatibility tests do not establish exact CLI equivalence, anonymity, or live-provider capacity.

```bash
npm i @openai-oauth/pool
```

## Quickstart

Create a separate credential file for each authorized account. Treat these files and any proxy credentials as secrets.

```bash
npx openai-oauth login --auth-file /absolute/path/account-a.json
npx openai-oauth login --auth-file /absolute/path/account-b.json
```

```ts
import { createOpenAIPool } from "@openai-oauth/pool";
import { createOpenAIOptions } from "@openai-oauth/openai-client";
import OpenAI from "openai";

const pool = await createOpenAIPool({
    accounts: [
        { name: "a", authFilePath: "/absolute/path/account-a.json" },
        { name: "b", authFilePath: "/absolute/path/account-b.json" },
    ],
    maxInflightPerAccount: 128,
    maxQueuedRequests: 1024,
    queueTimeoutMs: 300_000,
});

const client = new OpenAI(createOpenAIOptions(pool));
const result = await client.responses.create({
    model: "gpt-5.4-mini",
    input: "Hello!",
});

await pool.destroy();
```

`createOpenAIPool` is asynchronous. Consume or cancel response bodies so their in-flight leases can be released.

## Ownership and continuation

- Each configured account has separate credential loading, response state and HTTP transport resources. HTTP, WebSocket and public session loading share the account's credential-loading primitive.
- A predecessor response ID binds a continuation to its recorded owner, even when the new input differs. Identical-request affinity is a scheduling optimization, not proof of conversation ownership.
- Unknown/expired ownership fails explicitly. Removing an unknown `previous_response_id` does **not** reconstruct history.
- Quota/authentication failures are returned rather than retried under another account. `retryOnOtherAccount` is retained as a deprecated compatibility option; it does not enable quota failover.
- No migration clears another account's response cache. To begin an independent request, supply complete authorized input without a predecessor ID.
- Pool ownership indexes and core response caches are bounded and in-memory. Restart or eviction can make an old continuation unavailable.

For direct `pool.fetch` callers, optional `x-pool-conversation-id` and `x-pool-turn-id` headers express application-defined conversation and turn boundaries. These control headers are removed before forwarding upstream. Keep them scoped to the caller's authorized context; they are not authentication. Without an explicit turn ID, the pool does not treat a conversation-wide TTL as a turn boundary or invent turn telemetry.

A pool instance is **not** a multi-tenant authorization boundary. The caller must authenticate users and decide which accounts and histories they may access. SDK adapters may normalize and cache requests before the pool; this is distinct from direct pool calls. The stateless HTTP facade intentionally rejects continuation IDs and item references.

## Network routing

An account may configure an HTTP(S) proxy:

```ts
{
    authFilePath: "/absolute/path/account-a.json",
    proxy: "http://user:password@proxy.example:8080",
}
```

The package uses a dedicated undici `ProxyAgent` on Node.js 20.18.1 or newer. Unsupported protocols or runtimes without a working dispatcher fail closed. In particular, a Bun undici stub lacking `dispatch` is not accepted merely because its missing `close` method can be guarded. SOCKS is not implemented by this adapter; use a separately supplied, tested proxy-aware `fetch` if needed.

`fetch` explicitly supplies the account's network implementation. `refreshFetch` optionally supplies a separate refresh route; otherwise refresh uses the account's data-path route. No global organization/project environment variables are implicitly imported into every account.

A WebSocket configuration with a proxy or custom fetch deliberately uses HTTP when the WebSocket implementation cannot honor that route. It must not silently connect directly. Account-routing headers, including the FedRAMP flag, are rebuilt from the selected trusted session rather than arbitrary caller overrides.

## Streaming and WebSocket behavior

Set `transport: "websocket"` only where the available connector supports the intended route. The protocol bridge shares HTTP request normalization and response finalization, including `stream: false` aggregation.

- Complete response event envelopes are preserved in SSE output.
- A connection serializes full exchanges, including warmup. Reuse requires a successful eligible predecessor and compatible request properties/history.
- Close, error and abort settle pending operations. Buffer and connection budgets limit accumulation.
- A failure after output has started is an error, not permission to replay the request and duplicate output.
- No client ping loop or fabricated turn metadata is required by this API.

These behaviors are verified with offline mocks. They are not a claim that every upstream WebSocket implementation, compression mode or long-running session has been integration-tested.

## Scheduling and limits

The scheduler uses weighted in-flight load and health observations. In-flight includes the lifetime of a streamed body, not just the time until its headers arrive. Cooling accounts do not receive new assignments; admission waits are cancellable and bounded.

| Pool option | Default | Purpose |
| --- | ---: | --- |
| `maxInflightPerAccount` | 128 | Active response leases per account |
| `maxQueuedRequests` | 1024 | Waiting requests |
| `queueTimeoutMs` | 300000 | Maximum admission wait |
| `maxRequestBodyBytes` | 8388608 | Maximum body inspected by the pool |
| `healthRefreshMs` | disabled | `true` probes every 60 seconds; a positive integer sets the interval |

These local limits do not grant upstream quota. `Retry-After` is honored; a rate window's length is not treated as its remaining reset time. Utilization observations have their own freshness and are not reset deadlines. A synthetic concurrent test is not a production-throughput benchmark.

`pool.stats()` exposes account name/ID, installation ID, selected transport, health, in-flight count, cooldown and observed rate metadata. Do not expose those details to unauthorized callers.

## Quota diagnostics

`pool.stats()[i].quota` contains observed named quota `families` and optional account-level `credits`. Each primary/secondary window has its own `observedAt` and `stale` flag; timestamps and reset deadlines use epoch milliseconds. Credits retain the provider's bounded balance string rather than converting it into floating-point currency.

```ts
const account = pool.stats().find((entry) => entry.name === "a");
for (const family of account?.quota?.families ?? []) {
    console.log(family.limitId, family.primary?.usedPercent, family.primary?.stale);
}
```

Observations come from response headers and consumed HTTP/WebSocket quota events. Opting into `healthRefreshMs` also polls each account's authenticated `/models` endpoint, refreshing any quota/rate headers it returns without reserving inference capacity. They are bounded to 32 families per account, marked stale after five minutes, and cleared when the observed credential owner changes. Partial updates do not refresh unrelated windows. Returned diagnostics are copies. Existing `codex` stats remain available.

Additional meter families are diagnostics only: their names are not model aliases, entitlements or routing instructions, and they do not change scheduling or shorten restrictions.

## Account-specific model catalogs

```ts
const catalog = await pool.getModelCatalog("a", { mode: "oauth-visible" });
const cached = await pool.getModelCatalog("a", { cacheOnly: true });
const refreshed = await pool.getModelCatalog("a", { refresh: true });
```

The name must identify exactly one configured account. Inspection does not select an inference owner, reserve an inference slot or imply that a later independently scheduled request will use this account. It never unions capabilities across accounts. See the core package for catalog fields, listing modes and context inspection.

`cacheOnly` reads the **last observed** owner's cached metadata without loading credentials or making network requests. It does not verify external credential-file changes. Before any catalog is selected it returns `freshness: "missing"`; a normal call resolves current credentials. `refresh` and `cacheOnly` cannot be combined. Both account names and catalog ownership data must remain behind application authorization.

## Serving diagnostics over HTTP

After rebuilding, `bun run pool:serve -- --config /absolute/path/pool.json --diagnostics` exposes `/pool/stats`, `/pool/models` and `/pool/context` through the existing authenticated gateway. Alternatively enable `"diagnostics": true` in the private config (false by default). Model discovery and health polling remain disabled at startup unless `healthRefreshMs` is configured.

HTTP DTOs omit internal account/installation IDs, paths and raw metadata. They still expose configured account names and operational information, and the server token grants access to all configured accounts. Context inspection uses cached metadata only; first request the targeted catalog when freshness is needed. See the [root examples](../../README.md#http-pool-diagnostics). These nonstandard inspection routes do not change `/v1` defaults or enable compaction.

## Identity and persistence

Existing installation identities are preserved. New installation IDs use UUIDv4; conversation identifiers have their own lifecycle. Do not rotate stored identities solely to satisfy a blanket UUID-version recommendation. Explicit identity/header options are compatibility settings, not detection-evasion guarantees.

Auth-file replacement uses temporary files and rename with stale-snapshot checks. Coordination is process-local; it is not a cross-process or distributed compare-and-swap guarantee. Do not run multiple independent credential writers without external coordination.

## Lifecycle

```ts
await pool.close();   // reject new/queued work; current HTTP streams may finish
await pool.destroy(); // shut down transports as well
```

Serve the pool on loopback or behind explicit authentication and TLS. The repository runner accepts `accessTokenEnv` for bearer authentication and requires `--allow-network` for a nonloopback bind. It defers model discovery until requested. See the root README for configuration.

## Verification boundary

Tests cover mocked HTTP/WebSocket exchanges, cancellation, credential races and admission behavior. No live authentication/inference result, universal browser-runtime guarantee, automatic cross-account history transfer or undetectability guarantee is implied. PAT validation, remote compaction and richer model-template policy are separate features, not silently emulated here.
