# Supabase Setup — Mock Test Engine

This guide wires the **test engine** (`test-engine.html`), the **admin upload panel**
(`admin.html`), and the **in-app Mock section** (`app.html`) to a Supabase backend.

Questions are stored as **JSON** (bilingual English/Hindi + image URLs supported),
the engine **fetches & displays** them by id, and **results/attempts are saved** back
to Supabase.

---

## 1. Create a Supabase project

1. Go to <https://supabase.com> → **New project**.
2. Pick a name (e.g. `examzen`), a strong DB password, and a region close to your users
   (e.g. `South Asia (Mumbai)`).
3. Wait for the project to finish provisioning.

## 2. Run the schema

1. Open **SQL Editor → New query**.
2. Paste the entire contents of [`schema.sql`](./schema.sql) and click **Run**.
3. This creates the tables (`mock_tests`, `mock_questions`, `mock_attempts`),
   the `mock-images` storage bucket, and all Row-Level-Security policies.

## 3. Get your API keys

**Settings → API**. Copy:

- **Project URL** — e.g. `https://abcdxyz.supabase.co`
- **anon public** key — the long `eyJ...` JWT (safe to use in the browser; RLS protects writes)

## 4. Paste keys into the app

Open **`js/core/supabase-config.js`** and fill in the two values:

```js
window.SUPABASE_CONFIG = Object.freeze({
  url:     "https://YOUR-PROJECT.supabase.co",
  anonKey: "YOUR-ANON-PUBLIC-KEY"
});
```

That single file is loaded by the engine, the app, and the admin panel.

## 5. Create the admin upload account

Creating / editing tests requires a signed-in Supabase user (reads are public).

1. **Authentication → Users → Add user** → create an email + password
   (e.g. your admin email).
2. In `admin.html`, open the **🧪 Mock Tests** tab → **Connect Supabase** box →
   sign in once with that email/password. Uploads will then work.

> Reads (taking a test, listing published tests, saving an attempt) need **no login** —
> they use the public anon key with RLS.

---

## 6. Question JSON format

Upload one JSON file per test in the admin panel. Plain strings or `{en, hi}` objects
both work for any text field. See [`sample-mock.json`](./sample-mock.json) for a full example.

```jsonc
{
  "test": {
    "id": "ssc-cgl-mock-01",          // slug used in test-engine.html?id=ssc-cgl-mock-01
    "title": "SSC CGL Tier 1 — Mock 01",
    "exam": "cgl",                     // optional
    "tier": "t1",                      // optional
    "correct_score": 2,
    "negative_score": 0.5,
    "section_time_min": 15,
    "is_published": true
  },
  "sections": [
    {
      "name": "General Awareness",
      "time_min": 15,                  // optional per-section override
      "questions": [
        {
          "id": "Q1",                            // optional, auto-generated if missing
          "question": { "en": "Capital of India?", "hi": "भारत की राजधानी?" },
          "option_1": { "en": "Mumbai",  "hi": "मुंबई" },
          "option_2": { "en": "Delhi",   "hi": "दिल्ली" },
          "option_3": { "en": "Kolkata", "hi": "कोलकाता" },
          "option_4": { "en": "Chennai", "hi": "चेन्नई" },
          "answer": "2",                          // correct option number as string
          "explanation": { "en": "New Delhi is the capital.", "hi": "नई दिल्ली राजधानी है।" },
          "question_image": "",                   // optional image URL
          "option_image_1": "",                   // optional
          "solution_image": ""                    // optional
        }
      ]
    }
  ]
}
```

### Field notes
- **Text fields** (`question`, `option_*`, `explanation`) accept a plain string **or**
  a `{ "en": "...", "hi": "..." }` object. The engine shows a language switcher when
  Hindi is present.
- **`answer`** is the correct option **number** as a string (`"1"`–`"5"`).
- **Images**: put any public URL in `question_image`, `option_image_1..5`, or
  `solution_image`. To host them on Supabase, upload via the admin panel image
  uploader (stored in the `mock-images` bucket) and paste the returned URL.
- Up to **5 options** per question (`option_1` … `option_5`).
