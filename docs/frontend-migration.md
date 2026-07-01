# Frontend migration plan

This repo now has a Vite entry point and a small ES-module layer in `src/shared/`.
The current global scripts still load in their existing order so production behavior stays stable.

## Commands

```bash
npm install
npm run dev
npm run build
npm run preview
```

## Current shared modules

- `firebaseConfig.js` — Firebase config for future module-first code.
- `storageService.js` — Firestore/localStorage persistence helpers.
- `plannerEngine.js` — planner scheduling helpers that can be unit-tested separately.
- `youtubeService.js` — YouTube URL parsing and API helper factory.
- `dateUtils.js` — date formatting and date math.
- `domUtils.js` — DOM selectors, safe text insertion, and HTML escaping.

## Migration rule

Move one feature at a time from `js/**` to `src/**`, then replace inline/global handlers with `addEventListener` bindings from module entry files.

## Status

`src/shared/*` is no longer dead scaffolding — the following legacy globals
now delegate to it instead of duplicating logic:

- `js/core/ui-helpers.js` (`escapeHtml`) → `src/shared/domUtils.js`
- `js/core/persistence.js` (`saveProgress`, `saveProgressNow`) and
  `js/core/auth.js` (offline cache read on login) → `src/shared/storageService.js`

**Why the duplication isn't fully gone (and can't be, yet):** `<script type="module">`
tags are deferred and always execute *after* classic `<script>` tags, regardless
of where they appear in the document. Every legacy file above is a classic
script, so it cannot `import` from `src/shared/*` directly — it reads the
already-populated `window.PrepPathModules` object (set by `src/main.js`) at
**call time** (inside functions), never at parse time, and falls back to an
inline copy of the same logic if the module hasn't loaded yet for any reason.
This keeps a single implementation as the source of truth while staying safe
against load-order surprises.

`js/core/firebase-config.js` still duplicates the literal Firebase config
object from `src/shared/firebaseConfig.js`. This one is intentionally left
as-is: it must run synchronously, before any other classic script, so that
`window.PREPPATH_FIREBASE_CONFIG` exists the instant `js/core/firebase.js`
and `js/admin/admin-core.js` need it — which is before any deferred module
script (including `src/main.js`) has run. Removing it would require
reordering the Firebase-consuming classic scripts to run after modules,
which is a bigger, riskier change than this pass covers.

## Not yet migrated

`plannerEngine.js` and `youtubeService.js` are exported via
`window.PrepPathModules` but have no legacy call sites wired up yet — the
equivalent logic in `js/tabs/planner-*.js` (split from the former monolithic
`js/tabs/planner.js` — see its header comment) / `js/tabs/youtube.js` is
significantly more complex (DOM rendering intertwined with scheduling math)
and needs a dedicated migration pass rather than a drop-in swap.
