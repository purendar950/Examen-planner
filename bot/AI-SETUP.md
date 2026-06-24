# AI Auto-Schedule (Telegram → Planner) — Setup

When a connected user texts the bot a task or a YouTube link, the bot uses **Groq AI**
to detect the subject and adds it to that user's planner **To-Do list**. YouTube links
become video to-do tasks that play **inside the YouTube tab** when tapped.

## How it works

```
User → Telegram bot → Groq AI (parse + detect subject)
                    → writes to users/{uid}.telegramInbox  (Firestore)
Web app  → onSnapshot listener drains telegramInbox → appState.tasks → shows live in Planner
```

The bot writes to a **separate `telegramInbox` field** (not `appState`) so an open
browser tab can never overwrite the new tasks.

## 1. Get a Groq API key (free)

1. Go to https://console.groq.com/keys
2. Create an API key (starts with `gsk_`). Copy it.

## 2. Add the key in the Admin panel

1. Open `admin.html` → **Telegram** tab.
2. In the **🧠 AI Auto-Schedule (Groq)** card:
   - Paste the Groq API key.
   - Pick a model (default: `llama-3.1-8b-instant` — fast & cheap).
   - Tick **AI auto-schedule ON**.
   - Click **💾 Save AI Config**.
3. This saves to Firestore `config/ai`. No code/redeploy needed to change it later.

## 3. Give the Render bot Firebase access (one-time)

The bot needs to read `config/ai` and write `telegramInbox`. Add the service-account JSON
as an env var on Render (same JSON used by the GitHub Actions daily sender):

1. Firebase Console → Project settings → **Service accounts** → **Generate new private key**.
2. Render → your bot **Web Service** → **Environment** → add:
   - `TELEGRAM_BOT_TOKEN` = (existing) bot token from @BotFather
   - `FIREBASE_SERVICE_ACCOUNT` = paste the **entire** JSON (one variable)
3. The bot's **Build** command is `npm install` and **Start** is `node bot-server.js`
   (root directory `bot`). `firebase-admin` is now in `package.json`, so a redeploy installs it.
4. Click **Manual Deploy → Deploy latest commit**.

> If `FIREBASE_SERVICE_ACCOUNT` is missing, the bot still replies with Chat IDs,
> but AI auto-scheduling stays off (logged on startup).

## 4. Firestore security rules

The admin writes `config/ai`. Make sure your rules allow admin writes to it, the same
way `config/telegram` is allowed, e.g.:

```
match /config/{doc} {
  allow read: if true;
  allow write: if isAdmin();
}
```

The bot uses the Admin SDK, which bypasses rules — no extra rule needed for it.

## 5. Use it

A user who has connected Telegram (pasted their Chat ID in Profile → Daily Plan on Telegram)
can now text the bot:

- `Polity Article 14 kal` → task added to **tomorrow**, subject = Polity
- `Revise Modern History today` → task added to **today**, subject = History
- a YouTube link → a 🎥 video task on **today**; tap **▶** to play in the YouTube tab

Tasks appear **live** if the app is open, or on next open otherwise.

## Notes / limits

- Rate limit: 15 scheduling messages per chat per minute.
- If AI is OFF or the key is missing, a plain text message is still saved as a task for today.
- Models available: `llama-3.1-8b-instant`, `llama-3.3-70b-versatile`,
  `openai/gpt-oss-120b`, `openai/gpt-oss-20b`.
