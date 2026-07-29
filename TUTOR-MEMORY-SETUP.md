# AI Tutor Memory v2 — Setup

Enhanced persistent memory for the AI Tutor with **5 intelligence layers**:

| Layer | What it tracks | Table |
|-------|---------------|-------|
| Topics | Weak/strong topics + past summaries (last 5) | `student_memory` |
| Confidence | Per-topic 0–1 mastery score | `student_topic_mastery` |
| Mistakes | Specific mistakes + corrections | `student_sessions.mistakes` |
| Sessions | Per-video session summaries + topics covered | `student_sessions` |
| Learning Style | Detected style (examples/step-by-step/...), depth, pace | `student_preferences` |

```
Student asks tutor a question → answered as normal (unchanged)
Trigger: every 4 messages OR topic change OR confusion signal
  → chat sent to /api/tutor/memory-update (enhanced)
    → AI extracts: topics, confidence, mistakes, learning style, summary
    → saved to 4 Supabase tables independently
Every tutor question
  → all 4 tables fetched in parallel, merged into rich context
  → injected into system prompt (weak/strong topics, confidence %, past mistakes,
    session summaries, learning style, pace)
```

## 1. Run the SQL migration

Open the SQL editor of the **dedicated** project
(project ref `aqxglvtndssjkqluvzpl`).

Paste and run `supabase/student_memory.sql`. This is **additive** — if you
already ran the v1 SQL, the existing `student_memory` table and data are
preserved (the `last_summary` column is automatically migrated into
`past_summaries`). The 3 new tables (`student_topic_mastery`,
`student_sessions`, `student_preferences`) are created fresh.

## 2. Deploy the backend change

`youtube-turbo-proxy/app.py` — the `/api/tutor/memory-update` endpoint now
returns 4 separate objects (`memory`, `session`, `mastery`, `preferences`)
instead of 1, so the client can save each to its own table. No new env vars
needed — reuses the existing AI config.

Push to `main` and let Render redeploy.

## 3. Deploy the frontend change

- `js/features/tutor-memory.js` — rewritten: loads 4 tables in parallel,
  builds rich context (confidence %, mistakes, multi-session summaries,
  learning style), saves each response object to its table.
- `js/features/ai-tutor.js` — smarter refresh triggers: every 4 messages,
  on topic change (keyword comparison), and on confusion signals
  ("I don't understand", "confused", "wrong", "again").
- `app.html` — cache-bust versions bumped.

## 4. GitHub secrets for keep-alive

Already set up from v1 (`SUPABASE_URL`, `SUPABASE_ANON_KEY`). The
`.github/workflows/supabase-keepalive.yml` workflow now touches
`student_memory` which keeps the project awake — no changes needed.

## 5. Test it

1. Open a video, ask the tutor questions across 2–3 exchanges.
2. Check Supabase table editor:
   - `student_memory` — row with weak/strong topics + past_summaries array
   - `student_topic_mastery` — rows with confidence scores per topic
   - `student_sessions` — row with summary, topics_covered, mistakes
   - `student_preferences` — row with learning_style, explanation_depth, pace
3. Start a **new** chat — the tutor should reference past sessions, adapt
   to your learning style, and warn about past mistakes.
4. Switch provider/model — memory persists (it's in your database, not the model).
5. Say something wrong then get corrected — next session the tutor should
   remember your specific mistake.