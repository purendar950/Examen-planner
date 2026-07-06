# PrepPath — Daily Telegram Study Plan Setup

There are **two** daily Telegram sends, each its own workflow + script, sharing
one Firestore config doc (`config/telegram`) and one set of secrets:

| | Morning digest | Evening check-in |
|---|---|---|
| Workflow | `.github/workflows/daily-telegram.yml` | `.github/workflows/evening-telegram.yml` |
| Script | `scripts/send-telegram.js` | `scripts/send-telegram-evening.js` |
| Says | Today's study topics + full To-Do + videos | What's **still not done** today: incomplete tasks + pending videos |
| Admin time field | `config/telegram.sendTime` (default `06:00`) | `config/telegram.eveningSendTime` (default `20:00`) |
| Once-per-day guard | `config/telegram.lastSentDate` | `config/telegram.lastEveningSentDate` |

Both scripts share their date math, task/video extraction, and Telegram send
helper via `scripts/telegram-lib.js` — if you change how a task or video is
displayed, change it there once and both messages stay in sync.

## Architecture

```
Firebase Firestore              GitHub Actions (best-effort, ~every 15 min)
  users/{uid}                        send-telegram.js  (morning)
    appState.telegram ──────────────► reads digest+tasks ──► Telegram Bot API ──► User's phone
      chatId: "123456"                send-telegram-evening.js  (evening)
      enabled: true              ────► reads today's tasks  ──► Telegram Bot API ──► User's phone
      digest: { "2026-06-18": "📖 History\n🔁 Revise: Polity" }

  config/telegram
    sendTime / eveningSendTime  (admin-set, HH:MM IST — the source of truth for WHEN)
    lastSentDate / lastEveningSentDate  (once-per-day guard)
```

> ⚠️ **GitHub's built-in `schedule:` trigger is unreliable** — scheduled runs
> are frequently delayed or dropped under load. Both workflows' cron entries
> are a best-effort backup only. The **reliable** path is an external cron
> (e.g. [cron-job.org](https://cron-job.org), free) hitting each workflow's
> `workflow_dispatch` endpoint every ~15 min with `gated: true` — see
> **Step 6b** below. Without that external cron configured, sends depend
> entirely on GitHub's own scheduler and may arrive late or not at all.

---

## Step 1 — Create the bot (BotFather)

1. Telegram → message **@BotFather** → `/newbot`
2. Give it a name (e.g. `PrepPath Daily`) and username (e.g. `SSCplannerbot`)
3. Copy the **bot token** — looks like `123456789:ABC-xyz...`

---

## Step 2 — Deploy the bot server on Render (so bot replies with Chat ID)

The bot must run 24/7 to reply to users who press Start.

1. Go to **render.com** → New → Web Service
2. Connect this GitHub repo
3. Set:
   - **Root directory:** `bot`
   - **Build command:** `npm install`
   - **Start command:** `node bot-server.js`
   - **Plan:** Free
4. Add env var: `TELEGRAM_BOT_TOKEN` = your token from BotFather
5. Deploy. When live, press **Start** in your bot → it should reply with your Chat ID.

> **Alternative (no Render):** Users can message **@userinfobot** on Telegram — it replies instantly with their numeric Chat ID. No bot server needed.

---

## Step 3 — Set the bot username in app.html

In `app.html`, find and update:

```js
const TELEGRAM_BOT_USERNAME = 'SSCplannerbot'; // ← your bot's username (without @)
```

---

## Step 4 — Add GitHub Secrets

In your GitHub repo: **Settings → Secrets and variables → Actions → New repository secret**

| Secret name | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | The token from BotFather |
| `FIREBASE_SERVICE_ACCOUNT` | Full JSON from Firebase Console → Project settings → Service accounts → Generate new private key |

> Paste the **entire JSON** including `{` and `}`. Newlines in the JSON are fine — GitHub handles them.

---

## Step 5 — User connects Telegram in the app

1. Open app → Profile → **Daily Plan on Telegram**
2. Click **"Step 1: Bot kholo"** → Telegram opens → press **Start**
3. Bot replies: "Your Chat ID: `987654321`"  *(or get it from @userinfobot)*
4. Paste the ID, toggle **ON**, click **Save**

---

## Step 6 — Enable GitHub Actions + test

1. Push repo to GitHub (including `scripts/package-lock.json`)
2. **Actions** tab → if asked, click **"Enable Actions"**
3. Click **Daily Telegram Study Plan** → **Run workflow** → leave `gated` unchecked → **Run workflow** (unchecked = send immediately, for testing)
4. Watch the **send** step — success output looks like:

```
✅ Firebase project: syncstudy-3d734
👥 Total users in Firestore: 5
  ✅ Sent → uid123 (Purendar) chat:987654321
─────────────────────────────
Done. Sent=1  Skipped=4  Failed=0  NoDigest=0
```

`Sent=0` is normal until at least one user has saved their Chat ID with enabled=true.

5. Repeat for **Evening Telegram Check-in** → **Run workflow** → `gated` unchecked → **Run workflow**. Output looks the same, ending in `NoContent=` instead of `NoDigest=` (users with nothing tracked today are skipped, not counted as sent/failed).

---

## Step 6b — Make it reliable (external cron)

GitHub's own `schedule:` trigger is a best-effort backup only (see the warning
above) — for sends that actually arrive on time every day, add an external
cron for **each** workflow:

1. Create a free account at [cron-job.org](https://cron-job.org).
2. For the **morning** workflow, add a job that does an HTTP **POST** every
   ~15 min to:
   `https://api.github.com/repos/<you>/<repo>/actions/workflows/daily-telegram.yml/dispatches`
   - Headers: `Authorization: Bearer <a GitHub PAT with 'repo' scope>`, `Accept: application/vnd.github+json`
   - Body: `{"ref":"main","inputs":{"gated":"true"}}`
3. Repeat for the **evening** workflow, same URL but
   `evening-telegram.yml` instead of `daily-telegram.yml`.
4. The `gated:"true"` input makes each run respect the admin-set time +
   once-per-day guard in Firestore, so pinging every ~15 min is safe — it
   will only actually send once it reaches (or passes) the configured time,
   and only once per day.

You only need to do this once per workflow; after that, changing the send
time is just the Admin panel (see below), not the cron job.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT is not valid JSON` | Repaste the full JSON — check no characters were cut off |
| `Telegram API error 403: Forbidden` | User blocked the bot — they need to press Start first |
| `Telegram API error 400: chat not found` | Wrong Chat ID pasted — user should re-check with @userinfobot |
| `Sent=0` every day | No user has enabled=true + valid chatId in Firestore |
| Bot doesn't reply | Bot server not running on Render — check Render logs |
| Message says "Aaj koi topic scheduled nahi" | User hasn't built a study plan in the app yet |
| Evening check-in never arrives / arrives late | The external cron-job.org job for `evening-telegram.yml` isn't set up (or isn't firing) — GitHub's own scheduled cron alone is not reliable enough. See Step 6b. |
| `NoContent` is high on the evening run | Expected for users who don't track manual to-dos/videos in the planner — they're skipped, not failed. |

---

## Notes

- The Firebase **web config** in `app.html` is public by design — safe.
- The **bot token and service account JSON must never be committed** — only in GitHub Secrets.
- **To change the send time, use the Admin panel** (Admin → Telegram tab → "Daily auto-send time" / "Evening check-in time"). This writes `config/telegram.sendTime` / `eveningSendTime`, which the scripts read as the source of truth.
- The `cron:` line inside each workflow file is **not** the send time — it's just how often the best-effort backup trigger polls (off-peak minutes, several times an hour). Editing it changes polling frequency, not when messages go out. Don't confuse the two.
