---
inclusion: always
---

# Cache-busting: bump `?v=` whenever a versioned asset changes

This project deploys to GitHub Pages via Vite (`npm run build`). The Vite
config copies the `js/`, `css/`, `pages/` and `demo/` directories **verbatim**
(no content hashing) — see `vite.config.mjs` (`copyLegacyStaticAssets`,
`legacyDirectories`). Cache invalidation for these files is therefore **manual**,
done with a `?v=YYYYMMDD<letter>` query string on the reference in the HTML.

## The rule

Whenever you modify a file that is referenced with a `?v=` query string, you
**must** bump that `?v=` value in the HTML that references it. If you don't, the
deployed URL is unchanged and browsers (and the Pages CDN) keep serving the
**old cached file** — your code change ships but users never receive it.

Common references live in `app.html`:

- `<script defer src="js/tabs/saved-questions.js?v=...">`
- `<script defer src="js/playlist-quizzes.js?v=...">`
- `<script defer src="js/quiz-attempts.js?v=...">`
- `<div data-include="pages/saved.html?v=...">` (partials loaded by
  `js/core/include-loader.js`)

## How to bump

Use today's date plus an incrementing letter, e.g. `20260717j` → `20260717k`.
Keep the letter moving forward so the value is always strictly newer.

## Checklist before opening a PR that touches `js/**` or `pages/**`

1. For every changed file, grep the HTML for its `?v=` reference
   (`grep -rn "<filename>?v=" *.html`).
2. Bump each matching `?v=` value.
3. If a file is referenced from more than one HTML entry (e.g. `app.html`,
   `admin.html`, `test-engine.html`), bump it in all of them.
