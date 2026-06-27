# Supabase Setup — StudyPlanner Mock

This connects the **portal** (`index.html`), the **test engine** (`test-engine.html`)
and the **admin** (`admin.html`) to a Supabase backend.

Questions are stored as **JSON** (bilingual English/Hindi + image URLs supported),
the engine **fetches & displays** them by id, and **results/attempts are saved** back
to Supabase.

---

## 1. Create a Supabase project
1. Go to <https://supabase.com> → **New project**.
2. Pick a name, a strong DB password, and a nearby region (e.g. *South Asia (Mumbai)*).
3. Wait for it to finish provisioning.

## 2. Run the schema
1. Open **SQL Editor → New query**.
2. Paste the entire contents of [`schema.sql`](./schema.sql) and click **Run**.
3. This creates the tables (`mock_tests`, `mock_questions`, `mock_attempts`),
   the `mock-images` storage bucket, and all Row-Level-Security policies.

## 3. Get your API keys
**Settings → API**. Copy:
- **Project URL** — e.g. `https://abcdxyz.supabase.co`
- **anon public** key — the long `eyJ...` JWT (safe in the browser; RLS guards writes)

## 4. Paste keys into the app
Open **`js/supabase-config.js`** and fill in:

```js
window.SUPABASE_CONFIG = Object.freeze({
  url:     "https://YOUR-PROJECT.supabase.co",
  anonKey: "YOUR-ANON-PUBLIC-KEY"
});
```

That one file is used by the portal, the engine, and the admin page.

## 5. Create the admin account
Creating / editing tests requires a signed-in Supabase user (reads are public).
1. **Authentication → Users → Add user** → create an email + password.
2. Open `admin.html`, sign in with that account, and upload tests.

> Taking a test, listing published tests, and saving an attempt need **no login** —
> they use the public anon key with RLS.

---

## 6. Question JSON format
Upload one JSON file per test in the admin page. Plain strings or `{en, hi}` objects
both work for any text field. See [`sample-mock.json`](./sample-mock.json).

```jsonc
{
  "test": {
    "id": "ssc-cgl-mock-01",          // slug used in test-engine.html?id=ssc-cgl-mock-01
    "title": "SSC CGL Tier 1 — Mock 01",
    "exam": "cgl",                     // optional (drives the portal category chips)
    "tier": "t1",                      // optional
    "correct_score": 2,
    "negative_score": 0.5,
    "section_time_min": 15,
    "is_published": true
  },
  "sections": [
    {
      "name": "General Awareness",
      "time_min": 15,
      "questions": [
        {
          "id": "Q1",
          "question": { "en": "Capital of India?", "hi": "भारत की राजधानी?" },
          "option_1": { "en": "Mumbai",  "hi": "मुंबई" },
          "option_2": { "en": "Delhi",   "hi": "दिल्ली" },
          "option_3": { "en": "Kolkata", "hi": "कोलकाता" },
          "option_4": { "en": "Chennai", "hi": "चेन्नई" },
          "answer": "2",
          "explanation": { "en": "New Delhi is the capital.", "hi": "नई दिल्ली राजधानी है।" },
          "question_image": "",
          "option_image_1": "",
          "solution_image": ""
        }
      ]
    }
  ]
}
```

### Field notes
- Text fields accept a plain string **or** `{ "en": "...", "hi": "..." }`. The engine
  shows a language switcher when Hindi is present.
- **`answer`** is the correct option number as a string (`"1"`–`"5"`).
- **Images**: any public URL in `question_image`, `option_image_1..5`, or
  `solution_image`. Use the admin image uploader to host on Supabase and get a URL.
- Up to **5 options** per question.
