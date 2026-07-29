# AI Tutor Memory — Setup

Gives the AI Tutor (YouTube tab) a small persistent memory of each student —
weak/strong topics, preferred language, a one-line summary of the last
session — that survives across devices AND across AI provider/model
switches, because it lives in Supabase, not inside any model.

```
Student asks tutor a question → answered as normal (unchanged)
Every ~2 exchanges           → chat sent to /api/tutor/memory-update
                                → AI folds it into a compact JSON profile
                                → saved to Supabase `student_memory`
Every tutor question         → profile fetched from Supabase
                                → sent as `memory` on the request
                                → folded into the tutor's system prompt
```

## 1. Run the SQL migration

Open the SQL editor of the **dedicated** project created for this feature
(project ref `aqxglvtndssjkqluvzpl`) — kept separate on purpose from the
project already used by `js/supabase-config.js` / `js/saved-questions.js` /
`js/quiz-attempts.js` (`deefmrmmjlknotzpceqp`).

Paste and run `supabase/student_memory.sql`.

> **Note on privacy:** this table uses the same permissive-RLS pattern as
> `mock_attempts` / `quiz_attempts` in the other project (there's no
> Supabase Auth session to check — StudyPlanner logs in with Firebase), so
> it's protected by this project's anon key + needing a specific student's
> uid, not by real per-row isolation. Being a separate project means a leak
> here can't touch your mock-tests/quiz data, but it doesn't add isolation
> on its own. The SQL file has a longer comment on tightening this later
> via the `/api/tutor/memory-update` endpoint (it already verifies the
> Firebase ID token — it could write with a service_role key instead of
> letting the client upsert directly).

## 2. Deploy the backend change

`youtube-turbo-proxy/app.py` has two changes:

- `_tutor_prepare()` now accepts an optional `memory` field and folds it
  into the tutor's system prompt.
- A new `POST /api/tutor/memory-update` endpoint summarizes a chat into
  the JSON profile, reusing whatever Study AI / Groq key is already
  configured in the admin panel — no new key to add.

No new environment variables needed. Push to `main` and let your existing
Render deploy (`youtube-turbo-proxy/render.yaml`) redeploy it as usual.

## 3. Deploy the frontend change

New file `js/features/tutor-memory.js`, loaded in `app.html` right after
`vendor/supabase.js` and before `ai-tutor.js`. `ai-tutor.js` itself has two
small edits: it now sends `memory` on every tutor request, and refreshes
memory every couple of exchanges. Push to `main` as usual (`static.yml`
handles the GitHub Pages build; Android/`turbo-proxy-image` workflows are
untouched by this change).

## 4. Keep the Supabase project awake

Supabase pauses free-tier projects after 7 days with no real database
activity. `.github/workflows/supabase-keepalive.yml` pings `student_memory`
twice a week to prevent that. Add these two repo secrets (**Settings →
Secrets and variables → Actions**):

- `SUPABASE_URL` = `https://aqxglvtndssjkqluvzpl.supabase.co`
- `SUPABASE_ANON_KEY` = the same anon key now hardcoded in
  `js/features/tutor-memory.js` (it's meant to be public — safe to reuse
  here)

No GitHub personal access token is needed anywhere in this setup — the
workflow only needs the two secrets above. This is a **second** keep-alive
target from the one you might already be running for the other project —
if you ever add memory storage to `deefmrmmjlknotzpceqp` too, that one
needs its own separate ping, since Supabase tracks inactivity per project.

## 5. Test it

1. Open a video, ask the tutor a few questions across 2–3 exchanges.
2. Check the Supabase table editor → `student_memory` — a row should
   appear for your uid after the 4th message in a chat.
3. Start a **new** chat (different video, or clear + reopen) — the tutor's
   very first reply should already reflect what it "knows" about you,
   without you repeating anything.
4. Switch the provider/model in the admin panel and repeat step 3 — memory
   should still show up, since it's injected fresh on every call rather
   than living inside any one model.
