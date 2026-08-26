# Authenticated Kiro CLI Bridge

A small OpenAI-compatible bridge for server-side Kiro CLI requests. The metered
`KIRO_API_KEY` remains inside the service, and every diagnostic/completion route
requires a separate high-entropy `KIRO_PROXY_TOKEN` in production.

```
Authorized server → Bearer KIRO_PROXY_TOKEN → this service → kiro-cli → response
```

## Prerequisites

- Node.js >= 18
- [`kiro-cli`](https://cli.kiro.dev/install) installed and on `PATH`
- A Kiro Pro / Pro+ / Power plan with API key generation enabled
  ([docs](https://kiro.dev/docs/enterprise/governance/api-keys/))

## Run locally

```bash
cd kiro-test
npm install
cp .env.example .env      # set KIRO_API_KEY and KIRO_PROXY_TOKEN
npm start
```

The local UI is available only outside production. Test directly with the proxy
token (development allows no token only when `KIRO_PROXY_TOKEN` is unset):

```bash
curl -X POST http://localhost:3000/api/test-kiro \
  -H "Authorization: Bearer $KIRO_PROXY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"hello"}'
```

## Deploy on Render

The repo already defines this service in the root `render.yaml`, so the easiest
path is to deploy via a **Blueprint** (it fills in the settings below for you).
If you set it up manually instead, use these exact values:

| Setting | Value |
|---|---|
| **Root Directory** | `kiro-test` |
| **Build Command** | `rm -rf vendor && mkdir -p vendor/kiro && env HOME="$PWD/vendor/kiro" bash -c 'curl -fsSL https://cli.kiro.dev/install \| bash' && npm install` |
| **Start Command** | `node server.js` |
| **Env Var** | `KIRO_API_KEY` = metered upstream key (dashboard only) |
| **Env Var** | `KIRO_PROXY_TOKEN` = separate random bearer token (dashboard only) |
| **Env Var** | `NODE_ENV` = `production` |

Set `KIRO_PROXY_TOKEN` **before** deploying this code. Then store that same proxy
token—not the metered Kiro key—as the Kiro provider key in the Admin provider
configuration. Deploy, confirm `/health` returns HTTP 200 with both configuration
flags true, and perform one authenticated completion smoke test. Missing proxy
auth intentionally makes `/health` and protected routes return 503.

Free tier spins down after 15 min idle (cold start ~30-50s on next request).
For always-on, use a paid instance type.

### Why the Build Command overrides `HOME`

**Render's build and runtime run on SEPARATE filesystems.** The `kiro-cli`
installer defaults to `$HOME/.local/bin` (i.e. `/opt/render/.local/bin`), which
is **discarded before runtime** — confirmed via `/api/diag`, which showed
`binaryExists:false` with `HOME=/opt/render`. Only files written INSIDE the
deployed project directory survive to runtime.

So the build overrides `HOME` to `$PWD/vendor/kiro`, which makes the installer
write the binary to `kiro-test/vendor/kiro/.local/bin/kiro-cli` — inside the
project dir. `server.js` resolves that exact absolute path (see `VENDOR_BIN`).
`HOME` is scoped to just the install step (via `env HOME=...`) so it doesn't
disturb `npm install`. The `rm -rf vendor` prefix guarantees a clean install
each build and sidesteps the installer's interactive replace prompt (which has
no TTY on Render and would otherwise fail the build).

Because the binary lives at an absolute path that `server.js` resolves directly
(and `childEnv()` also adds the vendor dir to `PATH`), the start command no
longer needs a `PATH` export.

## Known kiro-cli quirks (found via testing)

- `kiro-cli` exits with code `0` even when the API key is invalid/expired —
  the real error goes to stderr with empty stdout. `server.js` explicitly
  checks for this and returns `HTTP 401` instead of a false "success".
- Responses include ANSI color codes (e.g. a colored `> ` prompt prefix) even
  with `--no-interactive`. `server.js` strips these before sending to the browser.
- `--trust-tools=` (empty) is used to keep this endpoint tool-free and safe
  for unattended/public use — no file reads/writes/shell commands are allowed.

## Security notes

- `/health` is public and reveals only boolean readiness. All `/api/*` and
  chat-completion routes—including trailing-slash variants—require a
  constant-time bearer-token match in production.
- Keep `KIRO_PROXY_TOKEN` distinct from `KIRO_API_KEY`; rotate the proxy token in
  Render and the Admin provider configuration together.
- Production does not serve the browser test UI and does not self-ping to avoid
  platform sleep.
- Never commit `.env`. The root `.gitignore` excludes `.env` and `.env.*` except
  `.env.example`.

## Scope

This bridge is intentionally tool-free (`--trust-tools=`) and should be called
only by trusted server-side provider code. It is not a public browser API.
