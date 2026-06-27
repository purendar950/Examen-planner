# StudyPlanner Mock

A standalone **mock test platform for competitive exams** (SSC, Railway, Banking, UPSC, …).
Questions are uploaded as JSON to **Supabase**, the test engine fetches and displays them in a
real exam interface, and attempts/results are saved back to Supabase.

This is a **static site** — no build step, no server. Just host the files.

## Features
- 📝 **Test engine** — sectional timers, question palette, mark-for-review, bilingual
  (English/Hindi) questions, images, MathJax, instant solutions, score & analysis.
- 🗂 **Portal** (`index.html`) — lists published tests with exam-category filters and search.
- 🔐 **Admin** (`admin.html`) — Supabase sign-in, upload & validate question JSON with a live
  preview, publish/unpublish/delete tests, and upload images.
- ☁️ **Supabase backend** — questions stored as JSONB, attempts saved per user.

## Project structure
```
.
├── index.html            # Public portal (list of tests)
├── test-engine.html      # The test-taking engine (?id=<test id>)
├── admin.html            # Admin upload/manage page
├── css/style.css         # Shared theme
├── js/
│   ├── supabase-config.js # ← put your Supabase URL + anon key here
│   └── admin.js          # Admin logic
└── supabase/
    ├── schema.sql        # Run this in the Supabase SQL editor
    ├── SETUP.md          # Full setup walkthrough
    └── sample-mock.json  # Example question file
```

## Quick start
1. **Create a Supabase project** and run [`supabase/schema.sql`](supabase/schema.sql) in the SQL editor.
2. Put your **Project URL** + **anon key** in [`js/supabase-config.js`](js/supabase-config.js).
3. Create a Supabase auth user (Authentication → Users), open `admin.html`, sign in, and upload
   a test (try `supabase/sample-mock.json`).
4. Open `index.html` to see it listed, and click **Start Test**.

Full details in [`supabase/SETUP.md`](supabase/SETUP.md).

## Run locally
Because it's static, any static server works:
```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

## Deploy
Works on any static host — **GitHub Pages**, Netlify, Vercel, Cloudflare Pages, etc.
For GitHub Pages: push to a repo → Settings → Pages → deploy from the `main` branch root.

> The Supabase anon key is meant to be public; Row-Level-Security (set up by `schema.sql`)
> restricts writes to signed-in admins while keeping published tests publicly readable.
