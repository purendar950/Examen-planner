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

**This is the single most common cause of "the bot is up but nothing works".** Without it
the process still starts and still answers `/start`, so it looks healthy — but every
Firestore-backed feature is dead:

| Needs `FIREBASE_SERVICE_ACCOUNT` | Works without it |
| --- | --- |
| `/calc`, `/setup`, AI auto-schedule | `/start`, `/id`, `/help` |
| Mini App practice, "Send to Telegram", screenshot relay | (Chat-ID replies only) |

Note the GitHub Actions daily sender has its **own** copy of this secret, so the morning
digest and calculation reminders can keep arriving while the Render bot has no access
at all.

1. Firebase Console → Project settings → **Service accounts** → **Generate new private key**.
2. Render → your bot **Web Service** → **Environment** → add:
   - `TELEGRAM_BOT_TOKEN` = (existing) bot token from @BotFather
   - `FIREBASE_SERVICE_ACCOUNT` = the **entire** JSON, in one variable
3. The bot's **Build** command is `npm install` and **Start** is `node bot-server.js`
   (root directory `bot`). `firebase-admin` is in `package.json`, so a redeploy installs it.
4. Click **Manual Deploy → Deploy latest commit**.

### If the JSON keeps getting mangled, use base64

The loader repairs the usual paste damage by itself (surrounding quotes, a BOM, real
newlines inside `private_key`, double-escaped `\n`) and logs when it does. When a
dashboard still corrupts the value, sidestep it — base64 has no braces or newlines to
break, and the bot accepts it directly:

```bash
base64 -w0 service-account.json     # macOS: base64 -i service-account.json
```

Paste that single line as `FIREBASE_SERVICE_ACCOUNT` instead.

### Verify without reading logs

```
GET https://<your-bot-host>/health
```

```json
{ "ok": true, "bot": "alive", "firestore": "ready", "commands": ["/start", "/calc", "/id", "/setup", "/help"] }
```

`firestore: "ready"` is the only healthy answer. Otherwise `reason` names the problem:

| `reason` | Meaning |
| --- | --- |
| `not-set` | the env var is absent or empty on this service |
| `not-json` | the value is neither JSON nor base64 — usually truncated on paste |
| `incomplete` | parsed, but no `project_id` / `private_key` — wrong file? |
| `bad-private-key` | `private_key` is not a PEM block |
| `rejected` | Firebase refused the credentials — key revoked, or wrong project |

`/health` deliberately returns **200** even when unhealthy, so a platform health check
cannot roll a deploy back over it; read the body, not the status. The precise parser
error stays in the boot logs, which print a `FIRESTORE UNAVAILABLE` banner naming the
cause and the fix. Never exposed over HTTP — it can quote the credential.

## 4. Exactly one instance may run

The bot uses **long polling**, and Telegram hands each update to exactly one
`getUpdates` consumer. A second running copy does not just duplicate work — it competes
for updates and answers them with **its own build and its own configuration**.

Observed symptom: one `/calc` produced three different replies — a stale build's preset
list, the current build's buttons, and `⚠️ Server-side dikkat hai` from a third instance
that had no `FIREBASE_SERVICE_ACCOUNT`. Nothing looks broken in any single log; the bot
just appears to behave at random.

Telegram reports the collision as HTTP 409, which the bot now prints as an
`ANOTHER BOT INSTANCE IS POLLING THIS TOKEN` banner naming the build that logged it.

To find the duplicate, check `/health` on **every** URL that might be running this bot —
old Render services, a second instance of the current one, a local `node bot-server.js`:

```json
"instance": { "id": "…", "service": "examen-planner-2", "commit": "f9f37af", "branch": "main", "startedAt": "…" }
```

Two URLs reporting **different `commit` values are both live and competing**. Keep one
service, suspend or delete the rest. `GET /` shows the same identity in one line, so
`curl` is enough for a quick sweep.

> Scaling this service to more than one instance breaks it for the same reason — the bot
> must stay at a single instance.

## 5. Firestore security rules

The admin writes `config/ai`. Make sure your rules allow admin writes to it, the same
way `config/telegram` is allowed, e.g.:

```
match /config/{doc} {
  allow read: if true;
  allow write: if isAdmin();
}
```

The bot uses the Admin SDK, which bypasses rules — no extra rule needed for it.

## 6. Use it

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
