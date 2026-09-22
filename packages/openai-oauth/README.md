# openai-oauth

[Docs](https://github.com/EvanZhouDev/openai-oauth#dev-proxy) | [GitHub](https://github.com/EvanZhouDev/openai-oauth) | [npm](https://www.npmjs.com/package/openai-oauth)

Turn your ChatGPT account into an OpenAI-compatible local API.

```bash
> npx openai-oauth

OpenAI-compatible endpoint ready at http://127.0.0.1:10531/v1
Use this as your OpenAI base URL. No API key is required.
Available Models: gpt-5.6-sol, gpt-5.6-terra, gpt-image-2, ...

[d] Run in background  [q] Quit
```

Press `d` to keep it running in the background or `q` to quit. You can also manage it directly:

```bash
npx openai-oauth --detach
npx openai-oauth status
npx openai-oauth logs --follow
npx openai-oauth stop
```

## Package Notes

`openai-oauth` exposes an OpenAI-compatible local endpoint backed by your ChatGPT account.

Supported endpoints:

- `/v1/responses`
- `/v1/chat/completions`
- `/v1/images/generations`
- `/v1/images/edits`
- `/v1/models`

Image generation uses JSON requests. Image editing uses the standard OpenAI multipart request with one or more `image` fields. Both return base64 image data and usage metadata.

```bash
curl http://127.0.0.1:10531/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-2","prompt":"A tiny house in a forest","quality":"low"}'
```

Common flags:

| Config | Flag | Default |
| --- | --- | --- |
| Host binding | `--host` | `127.0.0.1` |
| Port | `--port` | `10531` |
| Model allowlist | `--models` | Account-specific Codex models discovered from ChatGPT |
| Auth file path | `--oauth-file` | `$CODEX_HOME/auth.json` or `~/.codex/auth.json` |
| Open browser | `--open` / `--no-open` | `--open` |
| Login timeout | `--login-timeout-ms` | `300000` |

Binding `--host` beyond loopback exposes the proxy to your network. Anyone who can reach that port can make requests with your ChatGPT account.

Login listens on loopback and uses `http://localhost:1455/auth/callback`, the local callback URL accepted by OpenAI OAuth.

The CLI resolves the latest published Codex client version automatically. Advanced flags also exist for overriding it, the upstream Codex base URL, OAuth client id, and OAuth token URL.

## Login through an HTTP(S) proxy

From this repository, build once and run the local CLI with Node.js 20.18.1 or newer:

```bash
bun run build
bun run cli:local login \
  --no-open \
  --login-timeout-ms 900000 \
  --auth-file /absolute/path/account.json \
  --proxy 'http://user:password@proxy.example:8080' \
  --pool-config /absolute/path/pool.json
```

You can also use `node packages/openai-oauth/dist/cli.js login ...` from the repository root. Rebuild after source changes. `npx openai-oauth@2.0.0` still runs the published package, not these local changes.

`--proxy` routes the CLI's OAuth token exchange through a dedicated proxy connection. It does **not** configure the browser: open the printed URL using the browser/network configuration you intend. The callback remains `http://localhost:1455/auth/callback`. Proxy failures do not fall back to a direct connection. SOCKS URLs are not supported by this flag.

After credentials are saved, the CLI updates the pool account matched by its normalized auth-file path, sets `proxy`, and removes that account's old `proxyEnv` if present. Other accounts/settings are preserved. If no account matches, it appends one named after the auth filename; if no config exists, it creates a private loopback-default config. Restart an already-running pooled server to load the change.

Without `--pool-config`, the default is `$XDG_CONFIG_HOME/openai-oauth/pool.json` when `XDG_CONFIG_HOME` is absolute, otherwise `~/.config/openai-oauth/pool.json`. Paths use the **CLI process user's** home, not the owner of the auth-file path. For example, running as root with an auth file under `/home/claude_user` still requires `--pool-config /home/claude_user/.config/openai-oauth/pool.json` to update that user's config.

Existing configs must be private regular files (mode `600`, not symlinks). Updates use atomic replacement and reject observed concurrent changes; they are not distributed transactions with the credential save. If configuration persistence fails after login succeeds, the CLI reports that credentials were saved but the pool was not updated. Cancelling before the config rename leaves it unchanged; rename is the commit boundary.

The config stores the supplied proxy URL, including any proxy credentials, so keep it private. The application redacts proxy diagnostics, but literal command-line secrets can still be recorded in shell history or visible to process inspection. A login without `--proxy` never edits the pool config.

## Opt-in pool inspection routes

The repository's `pool:serve` runner supports `--diagnostics` or `"diagnostics": true` in its private JSON configuration. The normal `openai-oauth` CLI does not gain this flag. Routes are disabled unless a `poolDiagnostics` source is explicitly supplied:

- `GET /pool/stats` — sanitized quota/health/load observations.
- `GET /pool/models?account=a&mode=public-api` — typed catalog for one unique configured account. Optional `cacheOnly` and `refresh` accept only `true`/`false` and cannot both be true.
- `POST /pool/context` — `{ "account": "a", "request": { "model": "m", "input": "Hello" }, "estimate": "none" }`. Uses cached metadata only. Optional `characters` estimation is a fixed, approximate text-length heuristic, not executable code or an exact tokenizer.

Programmatic servers may pass `poolDiagnostics: { stats: () => pool.stats(), getModelCatalog: (name, options) => pool.getModelCatalog(name, options) }`. `PoolDiagnosticsSource` is exported as a structural type; no additional pool runtime dependency is required.

The existing bearer token/custom authorizer applies before body or diagnostic work. The same authorization grants inspection across all configured accounts, not tenant isolation. DTOs omit internal owner/installation IDs, paths and raw model metadata; prompts are not echoed. Responses use `Cache-Control: no-store`. Body limits, cancellation, standard `/v1/models` behavior and stateless continuation rejection remain intact.

A supplied credential source's ready transport is used directly, avoiding a second authentication/normalization layer. Configure base URL, fetch, headers, instructions, compatible base URL and client-version overrides on that transport/pool; conflicting server-level transport overrides are rejected rather than silently ignored.

See the root README's [HTTP pool diagnostics](../../README.md#http-pool-diagnostics) for runnable requests and authorization guidance.

## More

[Learn more in the openai-oauth README.](https://github.com/EvanZhouDev/openai-oauth#readme)
