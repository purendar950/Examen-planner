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

Render's Build Command and Start Command run in **separate shells**, so a
`PATH` export in the build step does not carry over. Export it again in the
start command:

| Setting | Value |
|---|---|
| **Root Directory** | `kiro-test` |
| **Build Command** | `rm -f ~/.local/bin/kiro-cli ~/.local/bin/kiro-cli-chat ~/.local/bin/kiro-cli-term; curl -fsSL https://cli.kiro.dev/install \| bash && npm install` |
| **Start Command** | `export PATH="$HOME/.local/bin:$PATH" && node server.js` |
| **Env Var** | `KIRO_API_KEY` = your real key (Render dashboard only — never in code) |

Render sets `PORT` automatically; `server.js` already reads `process.env.PORT`.

Free tier spins down after 15 min idle (cold start ~30-50s on next request).
For always-on, use a paid instance type.

### Why the Build Command has a `rm -f` prefix

**Verified bug in Kiro's own install script:** if `kiro-cli` is already
present at `~/.local/bin/` (e.g. from a previous/retried build on the same
Render instance), the installer tries to interactively prompt
`Do you want to replace it? (y/N):` via `/dev/tty`. Render's build shell has
no TTY, so the script crashes with `main: line 478: /dev/tty: No such device
or address` and exits with status 1 -- the deploy fails at the build step
with no `kiro-cli` binary present. The `--force` flag does **not** fix this
(tested) -- the check in `install_linux()` ignores it. Removing any existing
binary before running the installer avoids the prompt entirely and was
confirmed to install cleanly (exit code 0) in this exact scenario.

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
