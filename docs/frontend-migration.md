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
