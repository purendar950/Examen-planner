# Kiro API Key Test

A minimal, standalone service to verify that a `KIRO_API_KEY` works, without ever
exposing the key to the browser. This is a **personal testing tool**, not part of
the AI Study feature — see the note at the bottom.

```
Browser (HTML/JS) → this server → kiro-cli (holds the key) → response back to browser
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
cp .env.example .env      # paste your real key into .env
npm start
```

Open `http://localhost:3000`, or test directly:

```bash
curl -X POST http://localhost:3000/api/test-kiro \
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
| **Env Var** | `KIRO_API_KEY` = your real key (Render dashboard only — never in code) |

Render sets `PORT` automatically; `server.js` already reads `process.env.PORT`.

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

- This endpoint is **unauthenticated**. Fine for `localhost` or private testing.
  If deployed publicly, anyone with the URL can spend your Kiro credits. Add a
  shared-secret header check before making it public.
- Never commit `.env`. The repo's root `.gitignore` already excludes `.env`
  and `.env.*` (except `.env.example`).

## Not for AI Study

Kiro's headless mode (`kiro-cli` + `KIRO_API_KEY`) is designed for running the
Kiro agent against your own repo (code review, docs, audits) — not as a hosted
inference API for serving end users. This tool exists only to verify a key
works; it is intentionally kept separate from the `AI Study` feature's
`STUDY_PROVIDERS` (Bynara, Gemini, Groq, etc.), which are real hosted
chat-completions APIs meant for that purpose.
