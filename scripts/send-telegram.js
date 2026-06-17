/*
 * Daily Telegram study-plan sender.
 *
 * Runs in GitHub Actions (see .github/workflows/daily-telegram.yml).
 * For every user who opted in (appState.telegram.enabled) and linked a
 * chatId, it reads the precomputed digest for today and sends it via the
 * Telegram Bot API.
 *
 * Required GitHub secrets:
 *   TELEGRAM_BOT_TOKEN        - from @BotFather
 *   FIREBASE_SERVICE_ACCOUNT  - the full service-account JSON (one line),
 *                               from Firebase Console > Project settings >
 *                               Service accounts > Generate new private key.
 *
 * The user's digest is built in the browser (buildTelegramDigest in app.html)
 * and stored at users/{uid}.appState.telegram.digest as { 'YYYY-MM-DD': text }.
 */

const admin = require('firebase-admin');
const fetch = require('node-fetch');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) { console.error('Missing TELEGRAM_BOT_TOKEN'); process.exit(1); }

let svc;
try {
  svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
} catch (e) {
  console.error('FIREBASE_SERVICE_ACCOUNT is not valid JSON'); process.exit(1);
}
if (!svc.project_id) { console.error('Missing/invalid FIREBASE_SERVICE_ACCOUNT'); process.exit(1); }

admin.initializeApp({ credential: admin.credential.cert(svc) });
const db = admin.firestore();

/* Today's date in IST (the send fires at ~6 AM IST). */
function todayISTDate() {
  const now = new Date();
  const ist = new Date(now.getTime() + (5 * 60 + 30) * 60000); // UTC+5:30
  return ist.toISOString().slice(0, 10);
}

async function sendMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true })
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error((data && data.description) || 'sendMessage failed');
}

async function main() {
  const today = todayISTDate();
  const snap = await db.collection('users').get();
  let sent = 0, skipped = 0, failed = 0;

  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const tg = (data.appState && data.appState.telegram) || {};
    if (!tg.enabled || !tg.chatId) { skipped++; continue; }

    const digest = tg.digest || {};
    const plan = digest[today];
    const name = (data.profile && data.profile.name) ? data.profile.name.split(' ')[0] : 'there';

    const header = `☀️ <b>Good morning, ${name}!</b>\n📅 Aaj ka study plan (${today})\n\n`;
    const body = plan && plan.trim()
      ? plan
      : 'Aaj koi topic scheduled nahi. Plan banao ya thoda revision kar lo 💪';
    const footer = '\n\n— ExamZen';

    try {
      await sendMessage(tg.chatId, header + body + footer);
      sent++;
    } catch (e) {
      failed++;
      console.error(`Failed for ${doc.id}: ${e.message}`);
    }
  }

  console.log(`Done. Sent=${sent} Skipped=${skipped} Failed=${failed}`);
}

main().catch(e => { console.error(e); process.exit(1); });
