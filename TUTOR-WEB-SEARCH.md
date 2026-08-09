# AI Tutor: internet access + general awareness

The tutor used to be told *"Answer ONLY using the transcript below"*. That stopped
hallucinated lecture content, but it also meant the tutor refused everything the
lecture happened not to cover — including **General Awareness / current affairs**,
which is a scored subject in SSC, UPSC, banking and railway exams. It also had no
idea what today's date was, so it answered "who is the current …" relative to its
training cutoff and sounded confident doing it.

Two changes fix that:

1. **General awareness.** The transcript is now the *primary* source, not the
   *only* one. Anything off-transcript is still answered, but under an explicit
   `**Beyond this video:**` heading, so a revising student can always separate
   what their lecture actually taught from what the model added. Nothing is
   refused for being "off-topic".
2. **Internet access.** Time-sensitive questions get real web results injected
   into the prompt, and every tutor prompt now carries today's real date (IST).

Works out of the box with **no configuration**. Adding a search key makes it
substantially better — see below.

## How the tutor decides to search

The client sends `web` = `auto` (default) | `on` | `off`, set by the 🌐 button in
the tutor's top row. The server re-decides and treats the field as untrusted.

| Mode | Behaviour |
|---|---|
| `auto` | Searches only questions whose answer changes over time — "latest", "current", "aaj", "who is the", exam dates, notifications, cut-offs, results, repo rate, any year ≥ 2025, and so on (`_WEB_TRIGGER_RE`). "Explain photosynthesis" never triggers a search. |
| `on` | Searches every question. |
| `off` | Never searches. |

Questions under 8 characters are skipped ("ok", "haan"). Results are cached for
15 minutes and shared across users — a query string is not user data, and the
answer to a current-affairs question is the same for everyone.

Tool/function calling is deliberately **not** used: the tutor routes across ~12
gateways, many of them free tiers proxying small models with partial or missing
tool-call support, and the reply streams. Deciding server-side and injecting
results as context behaves identically on every provider.

## Search providers

Tried in order; the first to return enough results wins. Failures are logged and
skipped — a failed search costs the answer its freshness, never the answer.

**Keyed (recommended — add any one).** Configure in Firestore `config/ai`, or by
env var on the proxy:

| Provider | `config/ai` field | Env var | Free tier |
|---|---|---|---|
| [Tavily](https://tavily.com) | `tavilyApiKey` | `TAVILY_API_KEY` | yes |
| [Serper](https://serper.dev) (Google) | `serperApiKey` | `SERPER_API_KEY` | yes |
| [Brave Search](https://brave.com/search/api/) | `braveApiKey` | `BRAVE_API_KEY` | yes |
| self-hosted [SearXNG](https://docs.searxng.org) | `searxngUrl` | `SEARXNG_URL` | self-hosted |

Keys never reach the browser, exactly like the AI provider keys.

**Keyless (the default).** No setup, but weaker:

- **DuckDuckGo** (HTML endpoint) — returns real ranked web results, but from a
  datacenter IP it starts answering HTTP 202 with a bot-check page after roughly
  two requests. Measured on the sandbox: worked, then walled. Treated as
  best-effort.
- **DuckDuckGo Instant Answer API** — official and never walled, but only holds
  entity abstracts, so it is usually empty.
- **Wikinews** — dated news events.
- **Wikipedia** — the dependable floor, and genuinely strong for static GK
  (office holders, organisations, constitution, geography). The only provider
  that answered every probe without rate-limiting.

**So: without a key, expect Wikipedia-grade answers.** Static GK works well;
"SSC CGL 2026 exam date" will not. One free-tier key fixes that.

## Turning it off

- Globally, without redeploying: set `config/ai.tutorWebSearch = false` in
  Firestore (cached for 5 minutes).
- By env var: `TUTOR_WEB_SEARCH=0`.
- Per student: the 🌐 button → Off.

Date awareness stays on regardless — it needs no network.

## Tuning

| Env var | Default | Meaning |
|---|---|---|
| `WEB_SEARCH_TIMEOUT` | `6` | Per-provider timeout (seconds). |
| `WEB_SEARCH_BUDGET` | `12` | Ceiling for the whole provider chain. Search latency is answer latency — the student is watching a spinner. |
| `WEB_SEARCH_RESULTS` | `5` | Results injected into the prompt. |
| `WEB_SNIPPET_CHARS` | `420` | Per-result snippet cap. |
| `WEB_SEARCH_TTL` | `900` | Result cache TTL (seconds). |
| `WEB_SEARCH_PER_HOUR` | `60` | Searches per user per hour. Exceeding it silently skips the search rather than failing the answer. |

## Debugging

`GET /api/search?q=…` (any signed-in user, metered on the same bucket) reports
exactly what the tutor would see:

```json
{
  "enabled": true,
  "keyed": false,
  "providers": ["duckduckgo", "ddg-instant", "wikinews", "wikipedia"],
  "auto_would_search": true,
  "count": 5,
  "took_ms": 294,
  "results": [{ "title": "…", "url": "…", "site": "…", "via": "wikipedia" }]
}
```

`auto_would_search` answers "would `auto` mode have searched this at all?", which
is the usual cause of a stale-looking answer. `/api/status` also returns
`tutorWebSearch` so the UI can tell whether the feature is on.

## What the student sees

Cited sources are rendered under the answer as `[Web 1] site.com` links, matching
the `[Web n]` citations the model writes inline. They are persisted with the chat
history, so they survive a reload and are included in the chat PDF export.

## The Telegram `/ask` tutor

`bot/bot-server.js` had the only *explicit* off-topic refusal in the codebase
("If the question is not about studying or an exam subject, say so in one line
instead of answering"). That has been removed and replaced with the same
general-awareness permission, plus today's IST date. The bot has no web search —
it has no credentials for one — so it is instructed to flag facts that may have
moved since training.
