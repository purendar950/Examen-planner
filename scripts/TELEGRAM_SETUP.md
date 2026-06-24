# PrepPath — Daily Telegram Study Plan Setup

## Architecture

```
Firebase Firestore              GitHub Actions (6 AM IST daily)
  users/{uid}                        send-telegram.js
    appState.telegram ──────────────► reads digest ──► Telegram Bot API ──► User's phone
      chatId: "123456"
      enabled: true
      digest: { "2026-06-18": "📖 History\n🔁 Revise: Polity" }

  ┌─────────────────────────────────────────────────────────────────────────┐
  │  NEW: inbound task scheduling (bot/bot-server.js on Render, 24/7)         │
  │                                                                           │
  │  User sends "kal: Revise Polity Ch 3"  ──►  bot-server.js                 │
  │     1. finds the user by appState.telegram.chatId                         │
  │     2. parses the date ("kal" → tomorrow) + task text                     │
  │     3. writes it to users/{uid}.appState.tasks["YYYY-MM-DD"]              │
  │  The web planner reads the same store, so the task is already scheduled.  │
  └─────────────────────────────────────────────────────────────────────────┘
```

---

## Step 1 — Create the bot (BotFather)

1. Telegram → message **@BotFather** → `/newbot`
2. Give it a name (e.g. `PrepPath Daily`) and username (e.g. `SSCplannerbot`)
3. Copy the **bot token** — looks like `123456789:ABC-xyz...`

---

## Step 2 — Deploy the bot server on Render (replies with Chat ID **and** schedules tasks)

The bot must run 24/7 to reply to users who press Start and to receive tasks they send.

1. Go to **render.com** → New → Web Service
2. Connect this GitHub repo
3. Set:
   - **Root directory:** `bot`
   - **Build command:** `npm install`
   - **Start command:** `node bot-server.js`
   - **Plan:** Free
4. Add env vars:
   - `TELEGRAM_BOT_TOKEN` = your token from BotFather
   - `FIREBASE_SERVICE_ACCOUNT` = full service-account JSON (same value as the
     GitHub secret in Step 4). **Required for task auto-scheduling.** Without it
     the bot still replies with Chat IDs, but cannot add tasks to the planner.
5. Deploy. When live, press **Start** in your bot → it should reply with your Chat ID.

> The startup logs will show `✅ Firebase Admin connected — task auto-scheduling ENABLED`
> when the service account is set correctly.

> **Alternative (no Render):** Users can message **@userinfobot** on Telegram — it replies instantly with their numeric Chat ID. But task auto-scheduling needs the bot server running, so Render (or any always-on host) is required for that feature.

---

## How task auto-scheduling works (for users)

Once a user has connected (Chat ID saved + toggle ON in the app), they can just
message the bot and the task lands in their planner automatically:

| User sends | Result |
|---|---|
| `Revise Polity Ch 3` | Added to **today** |
| `kal: Solve 50 maths Qs` | Added to **tomorrow** (`kal`) |
| `monday Mock test attempt` | Added to next **Monday** |
| `Attempt Mock Test 25 Jun` | Added to **25 Jun** |
| `2026-06-25 Revise Economics` | Added to that exact date |

- **Multiple tasks:** send each on its own line.
- **High priority:** end the line with `!` or add `#high` / `#urgent` / `#important`.
- **Commands:** `/task <text>` to add explicitly, `/list` (or `/today`) to see today's tasks.

Tasks are saved to `users/{uid}.appState.tasks["YYYY-MM-DD"]` (the exact store
the web planner reads) and also merged into the daily digest for that date.

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
3. Click **Daily Telegram Study Plan** → **Run workflow** → **Run workflow**
4. Watch the **send** step — success output looks like:

```
✅ Firebase project: syncstudy-3d734
👥 Total users in Firestore: 5
  ✅ Sent → uid123 (Purendar) chat:987654321
─────────────────────────────
Done. Sent=1  Skipped=4  Failed=0  NoDigest=0
```

`Sent=0` is normal until at least one user has saved their Chat ID with enabled=true.

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
| Bot replies "Pehle apna account connect karo" when sending a task | User's Chat ID isn't saved in the app yet — connect via Profile → Daily Plan on Telegram |
| Bot says "Task scheduling abhi available nahi hai" | `FIREBASE_SERVICE_ACCOUNT` env var is missing on the Render bot service — add it (see Step 2) |
| Tasks not appearing in planner | Confirm the same Chat ID is saved in the app and the bot logs show `task auto-scheduling ENABLED` |

---

## Notes

- The Firebase **web config** in `app.html` is public by design — safe.
- The **bot token and service account JSON must never be committed** — only in GitHub Secrets.
- Change send time: edit `cron: '30 0 * * *'` (UTC) in `.github/workflows/daily-telegram.yml`.
  - `30 0` = 06:00 IST · `0 1` = 06:30 IST · `30 2` = 08:00 IST
