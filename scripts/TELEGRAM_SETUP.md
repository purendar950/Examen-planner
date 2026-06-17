# Daily Telegram Study Plan — Setup

The app precomputes each user's daily plan; a GitHub Actions cron job sends it.

## 1. Create the bot
1. Open Telegram, message **@BotFather**, send `/newbot`, follow prompts.
2. Copy the **bot token** (looks like `123456:ABC-...`). Keep it secret.
3. Note the **bot username** (e.g. `ExamZenBot`).

## 2. Wire the bot username into the app
In `app.html`, set:
```js
const TELEGRAM_BOT_USERNAME = 'YOUR_BOT_USERNAME'; // without the @
```

## 3. How a user links their account
In the app: **Planner > ⚙️ Profile > Daily Plan on Telegram**
1. Tap **Connect Telegram** → opens the bot → press **Start**.
2. The bot replies with their **chat ID** (you set up the bot's `/start` reply
   to echo `chat.id`, or use @userinfobot to find it).
3. Paste the chat ID, turn the toggle ON, Save.

> Telegram bots cannot message a user who has never pressed **Start** — that
> one-time step is required.

## 4. GitHub secrets
In your GitHub repo: **Settings > Secrets and variables > Actions > New secret**
- `TELEGRAM_BOT_TOKEN` = the bot token from BotFather.
- `FIREBASE_SERVICE_ACCOUNT` = full JSON from Firebase Console >
  Project settings > Service accounts > **Generate new private key**
  (paste the whole JSON as the secret value).

## 5. Enable + test
- Push this repo to GitHub. The workflow `.github/workflows/daily-telegram.yml`
  runs daily at **00:30 UTC (06:00 IST)**.
- Test immediately: GitHub > **Actions** > *Daily Telegram Study Plan* >
  **Run workflow**.

## Notes
- The Firebase web config in `app.html` is public by design — safe.
- The **bot token and service account must never be committed** — only stored
  as GitHub secrets.
- To change send time, edit the `cron:` line (UTC) in the workflow.
