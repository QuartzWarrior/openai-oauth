# @openai-oauth/pool

[Docs](https://github.com/EvanZhouDev/openai-oauth#typescript-sdk) | [GitHub](https://github.com/EvanZhouDev/openai-oauth) | [npm](https://www.npmjs.com/package/@openai-oauth/pool)

Run many ChatGPT accounts as one: per-account proxies, per-account installation ids, least-busy + health-aware load balancing, and full request parallelism.

```bash
npm i @openai-oauth/pool
```

## Quickstart

Log each account in to its own auth file (one per account):

```bash
npx openai-oauth login --auth-file ~/.codex/accounts/alice.json
npx openai-oauth login --auth-file ~/.codex/accounts/bob.json
```

Then pool them. The pool is a drop-in `OpenAIOAuth` credential source, so it works with every client adapter unchanged:

```ts
import { createOpenAIPool } from "@openai-oauth/pool";
import { createOpenAIOptions } from "@openai-oauth/openai-client";
import OpenAI from "openai";

const pool = createOpenAIPool({
	accounts: [
		{
			authFilePath: "~/.codex/accounts/alice.json",
			proxy: "http://user:pass@proxy-a.example:8080",
			installationId: "device-id-for-alice",
		},
		{
			authFilePath: "~/.codex/accounts/bob.json",
			proxy: "socks5h://user:pass@proxy-b.example:1080",
			installationId: "device-id-for-bob",
		},
	],
});

const client = new OpenAI(createOpenAIOptions(pool));

const result = await client.responses.create({
	model: "gpt-5.4-mini",
	input: "Hello!",
});
```

Or with Vercel AI SDK:

```ts
import { createOpenAIOAuth } from "@openai-oauth/ai-sdk";
import { generateText } from "ai";

const openai = createOpenAIOAuth(pool);

const result = await generateText({
	model: openai("gpt-5.4-mini"),
	prompt: "Hello!",
});
```

## Full isolation per account

Every account in the pool is kept fully separate:

| Concern | Isolation |
| --- | --- |
| Credentials | Its own `authFilePath`; tokens are loaded, refreshed and saved per account, with a per-account refresh lock so concurrent requests trigger exactly one refresh. |
| Network | Its own `proxy` — each account gets a dedicated undici `ProxyAgent`, so connections, TLS sessions and proxy credentials never mix. |
| Device identity | Its own `installationId`, persisted into the account's auth file on first run so the same "device" survives restarts. Sent only where codex sends it — the body's `client_metadata` — never as a literal header, never embedded in other ids. |
| Wire identity | Mirrors Codex CLI exactly: bare v4-UUID `session-id` rotated per conversation (thread-id shape — never a composite exposing the installation id), `thread-id` + `x-client-request-id` mirroring, `prompt_cache_key`, body `client_metadata`, `originator: codex_cli_rs`, `Accept: text/event-stream`, and `User-Agent: codex_cli_rs/<latest-release> (Linux <kernel>; x86_64) unknown`. The `unknown` terminal token matches a headless codex TUI: codex_terminal_detection's interactive probes (`TERM_PROGRAM`, `WEZTERM_VERSION`, …) are never set server-side, and the `TERM`-echo only fires for the interactive `codex`/`codex exec` front-ends (verified against a live codex 0.154 capture). |
| Replay chains | Its own transport state — `previous_response_id` chains are pinned to the account that started them, so server-side replay state never crosses accounts. |

With `rotateIdentity` (default) each account derives a fresh, stable device id per conversation from its `installationId` — matching Codex CLI's one-session-id-per-conversation lifecycle. A static header value sent on every request is a fingerprint; rotation removes it.

Each account's **User-Agent** is *also* a stable per-account signal. By default every account sends the uniform headless-TUI token `codex_cli_rs/<ver> (Linux <kernel>; x86_64) unknown` — the dominant, safest shape for a server-side pool. To spread accounts over distinct-but-plausible clients, set `varyUserAgent: true` (pins a stable token per account, derived from its `installationId`) or `terminalToken: "…"` (explicit). Every candidate is a terminal token codex_terminal_detection can *genuinely* emit on a headless **Linux** host — `unknown`, the tmux/screen/xterm `TERM`-echoes, `kitty`, `WezTerm/<build>`, `vscode/<ver>` (a `code tunnel` server) — and nothing mac/Windows-only, so no account ever claims a terminal a Linux box can't have. The choice is pinned per account and identical across HTTP and websocket, because a real install stamps one UA everywhere.

Two codex headers are deliberately handled with nuance rather than blanket-emitted:

- **`x-codex-window-id`** — codex's window identity is non-optional: `CodexResponsesMetadata::client_metadata()` always emits it and `compatibility_headers()` always sends the header, in the form `<thread_id>:<window_number>` (the TUI/memories mint it as `format!("{thread_id}:{n}")`, first window `:0`). A pool account serves each conversation as codex's single long-lived window, so we derive `x-codex-window-id` as `<rotated-thread-id>:0` per conversation and emit it on the websocket upgrade header and in body/frame `client_metadata` exactly as codex does. It is never invented per-request — the per-conversation thread id anchors it, matching codex's `<thread_id>:<n>` shape.
- **`x-codex-turn-metadata`** — codex emits a bounded form only when a turn has full request identity plus turn metadata; the unbounded tool-inventory form stays in `client_metadata` only. We leave it off unless the caller configures it, since a pool has no genuine turn metadata to echo.

## Websocket transport

Set `transport: "websocket"` on an account to carry its `/responses` traffic over Codex's realtime websocket wire instead of HTTP:

```ts
{
	accounts: [
		{
			authFilePath: "~/.codex/accounts/alice.json",
			proxy: "socks5h://proxy-a.example:1080",
			transport: "websocket",
		},
	],
}
```

Each websocket account keeps one persistent connection per conversation (per account + session id + access token, rebound on token refresh), warms it with a `generate: false` `response.create`, keeps it alive with protocol-level ping/pong exactly like codex (an RFC 6455 control ping via undici — never an app-level `{"type":"ping"}` frame, which no genuine codex client emits), tears it down after 60s idle, and reuses prior turns as `input_text.delta` frames when a request extends the previous input. The upgrade authenticates with `Authorization`/`chatgpt-account-id` headers like codex's HTTP requests (never a query token) and every `response.create` carries codex's wire identity (`session-id`/`thread-id`/`x-client-request-id` handshake ids + `client_metadata` with installation/session/thread ids, `originator`, a dynamic User-Agent whose trailing terminal token is detected from the environment like `codex_terminal_detection`, `OpenAI-Beta: responses_websockets=2026-02-06`, permessage-deflate). Any websocket failure — handshake, timeout, mid-stream error — falls back to plain HTTP for that request and demotes the account to HTTP permanently, so a broken websocket never breaks a request HTTP could serve. Requires `undici` (Node.js ≥ 20); lazily imported like the proxy agent.

The installation id each account reports (in `client_metadata` and the `x-codex-installation-id` body field) defaults to the per-account id persisted in that account's `auth.json` (generated on first run so the "device" survives restarts), keeping accounts fully isolated. You can pin an exact id per account via `installationId` in config. Because codex's genuine CLI on a machine has exactly one install, its standalone `~/.codex/installation_id` identifies *that one device* — so it's never claimed by default. If you want one account to impersonate the real CLI sharing the machine, opt that single account in with `preferNativeInstallationId: true`; enabling it on more than one account would spread one machine-id across many "devices", which real codex never does.

## Load balancing

Picks combine least-busy balancing with health tracking:

1. **Least busy** — the account with the lowest in-flight request count wins (reservations are made synchronously at pick time, so bursts of parallel requests spread across all accounts instead of piling onto the first idle one). `weight` biases the share: an account with `weight: 2` takes roughly twice the load of `weight: 1`.
2. **Health tracking** — `429`/`401`/`403` responses put the account into cooldown (honoring `Retry-After`, otherwise exponential backoff). Cooling accounts are skipped; if every account is cooling, the request waits for the earliest recovery instead of failing.
3. **Utilization** — Codex rate-window usage headers (`x-codex-primary-used-percent` / `x-codex-secondary-used-percent`) are tracked per account and used to break least-busy ties (the less-utilized account wins). The latest snapshot is exposed per account as `codex` in `pool.stats()`.

Sequential turns of the same conversation (same model + instructions + input, or a `previous_response_id` chain) are pinned back to the account that served them. Parallel duplicates are spread across accounts.

## Account stats

```ts
const stats = pool.stats();
// [
//   {
//     name: "alice",              // config name, or "account-<index>"
//     accountId: "acct_...",      // set after the first session load
//     installationId: "device-id-for-alice",
//     transport: "websocket",    // "http" | "websocket" (demoted ws shows "http")
//     healthy: true,
//     inflight: 1,
//     cooldownRemainingMs: 0,
//     consecutiveFailures: 0,
//     codex: {                    // latest x-codex-* rate-window headers
//       primaryUsedPercent: 12,
//       secondaryUsedPercent: 4,
//       primaryWindowMinutes: 300,
//       planType: "plus",
//     },
//   },
//   ...
// ]
```

## Options

```ts
type PoolAccountConfig = {
	name?: string; // defaults to "account-<index>"
	authFilePath: string; // required: this account's auth.json
	proxy?: string; // http://, https://, socks5://, socks5h://
	installationId?: string; // device id; generated, persisted into the auth file
	preferNativeInstallationId?: boolean; // opt-in: claim the real CLI's
	// ~/.codex/installation_id for THIS account (at most one account)
	varyUserAgent?: boolean; // default false (uniform headless `unknown` UA).
	// true: pin a stable, Linux-plausible UA terminal token per account
	// (derived from its installationId — same value forever)
	terminalToken?: string; // explicit token instead (overrides varyUserAgent);
	// must be legitimately possible on headless Linux: unknown, xterm-256color,
	// tmux-256color, screen(-256color), kitty, WezTerm/<build>, vscode/<ver>
	transport?: "http" | "websocket"; // default "http"; ws falls back to HTTP
	weight?: number; // default 1
	fetch?: typeof fetch; // full escape hatch; overrides `proxy`
	refreshFetch?: typeof fetch; // defaults to the data-path fetch (same proxy)
	headers?: Record<string, string>;
	instructions?: string;
	baseURL?: string;
	clientId?: string;
	issuer?: string;
	tokenUrl?: string;
};

type PoolConfig = {
	accounts: PoolAccountConfig[];
	codexVersion?: string; // pins the codex_cli_rs version in User-Agent
	instructions?: string;
	baseURL?: string;
	openAIBaseURL?: string;
	retryOnOtherAccount?: boolean; // default true: replay a rate-limited
	// request on the next account after a human-scale (1–3s) pause;
	// cross-account failover of a bare request is a trade-off the pool
	// cannot make timing-invisible (a genuine CLI would back off on the
	// SAME identity instead). Disable if plausibility beats availability.
	rotateIdentity?: boolean; // default true: fresh derived device id per
	// conversation (Codex's per-thread session-id lifecycle)
	replay?: { ttlMs?: number; maxEntries?: number }; // pin TTL (30 min) and LRU size (10k)
};
```

## Lifecycle

```ts
await pool.close(); // stop picking new work, release queued waiters
await pool.destroy(); // close() + shut down proxy agents/connections
```

## Package notes

Proxy support uses [`undici`](https://github.com/nodejs/undici) `ProxyAgent` under the hood, lazily imported — accounts without a `proxy` don't pay for it. Every account should have its own proxy: sharing one proxy across accounts defeats the network isolation.

## More

[Learn more in the openai-oauth README.](https://github.com/EvanZhouDev/openai-oauth#typescript-sdk)
