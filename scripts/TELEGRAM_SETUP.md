# ExamZen — Daily Telegram Study Plan Setup

## Architecture

```
Firebase Firestore         GitHub Actions (triggered by external cron, gated by admin time)
  users/{uid}                        send-telegram.js
    appState.telegram ──────────────► reads digest ──► Telegram Bot API ──► User's phone
      chatId: "123456"          config/telegram.sendTime ─┘ (admin-set time gate)
      enabled: true
      digest: { "2026-06-18": "📖 History\n🔁 Revise: Polity" }
```

---

## Step 1 — Create the bot (BotFather)

1. Telegram → message **@BotFather** → `/newbot`
2. Give it a name (e.g. `ExamZen Daily`) and username (e.g. `SSCplannerbot`)
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

## Step 7 — Set the daily send time (Admin panel)

The send time is now configurable — no need to edit the cron.

1. Open **admin.html → Telegram tab → Send Controls**
2. Set **"Daily auto-send time (IST)"** → click **Save Time**
3. This saves to Firestore `config/telegram.sendTime`. The sender reads it and
   sends **once per day**, on the first run at/after that time, and records
   `lastSentDate` so it never double-sends.

---

## Step 8 — Reliable auto-send (external cron) ⭐ IMPORTANT

**Why this is needed:** GitHub's built-in `schedule:` trigger is unreliable —
scheduled runs are frequently delayed or **dropped entirely** (you may see them
almost never fire). A **manual** `workflow_dispatch` run, however, always works.
So we use a free external cron to call that reliable trigger on a schedule. The
in-app send time (Step 7) still decides exactly when the message goes out.

### 8a. Create a GitHub token
GitHub → **Settings → Developer settings → Fine-grained tokens → Generate new token**
- **Repository access:** Only select repositories → `Examen-planner`
- **Permissions → Repository permissions → Actions: Read and write**
- Generate and **copy the token** (you won't see it again).

### 8b. Create a free cron job at [cron-job.org](https://console.cron-job.org)
Create a job with:

| Field | Value |
|---|---|
| **URL** | `https://api.github.com/repos/purendar950/Examen-planner/actions/workflows/daily-telegram.yml/dispatches` |
| **Method** | `POST` |
| **Schedule** | Every **15 minutes** (or every 5 for tighter timing) |

**Request headers:**
```
Accept: application/vnd.github+json
Authorization: Bearer YOUR_TOKEN_HERE
X-GitHub-Api-Version: 2022-11-28
Content-Type: application/json
```

**Request body:**
```json
{"ref":"main","inputs":{"gated":"true"}}
```

That's it. cron-job.org pings every 15 min → the workflow runs with `gated=true`
→ it checks your admin-set time and sends once that time is reached each day.
You change the time only in the **admin panel** — never touch cron-job.org again.

> `gated=true` = respect the admin time. A normal **Run workflow** from the
> Actions tab (gated unchecked) **force-sends immediately** — use that to test.

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
| **Auto-send only works when you click "Run workflow" manually; scheduled runs never fire** | GitHub's `schedule:` trigger is unreliable. Set up the **external cron (Step 8)** — that's the real fix. |
| Scheduled run is green but no message arrived | A green run can mean it **skipped** (not send time yet, or already sent today). Check the log: `Not send time yet` / `Already auto-sent today`. |

---

## Notes

- The Firebase **web config** in `app.html` is public by design — safe.
- The **bot token and service account JSON must never be committed** — only in GitHub Secrets.
- **Change send time:** use the **Admin panel → Telegram → Daily auto-send time** (Step 7). No need to edit the cron anymore. The workflow cron (`8,23,38,53 * * * *`, off-peak) is only a best-effort backup; the reliable trigger is the external cron in Step 8.
