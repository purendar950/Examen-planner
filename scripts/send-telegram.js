/*
 * PrepPath — Daily Telegram Morning Dashboard Sender (v5)
 * ────────────────────────────────────────────────────────────────────────────────────────
 * Runs in GitHub Actions (see .github/workflows/daily-telegram.yml).
 *
 * For every Pro user with appState.telegram.enabled=true and a chatId,
 * sends a SINGLE interactive morning dashboard with inline navigation buttons.
 *
 * Required GitHub secrets:
 *   TELEGRAM_BOT_TOKEN        – from @BotFather
 *   FIREBASE_SERVICE_ACCOUNT  – full service-account JSON
 *
 * v5 — Single-message interactive dashboard with date navigation.
 * Replaces the old 3-message animated cascade.
 * ────────────────────────────────────────────────────────────────────────────────────────
 */

const admin = require('firebase-admin');
const { isProUser } = require('../shared/proGating');
const { todayIST, istMinutesNow, istClockNow, hr } = require('./telegram-lib');
const {
  sendTelegramMessageWithKeyboard,
  buildMorningDashboard,
  morningKeyboard,
} = require('./telegram-dashboard-v6');

/* ── 1. Validate secrets ──────────────────────────────────────── */
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN is not set. Add it as a GitHub secret.');
  process.exit(1);
}

let svc;
try {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT || '{}';
  svc = JSON.parse(raw);
} catch (e) {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT is not valid JSON:', e.message);
  process.exit(1);
}
if (!svc.project_id || !svc.private_key) {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT JSON is incomplete (missing project_id or private_key).');
  console.error('   Make sure you pasted the ENTIRE JSON from Firebase Console.');
  process.exit(1);
}
console.log(`✅ Firebase project: ${svc.project_id}`);

/* ── 2. Init Firebase Admin ─────────────────────────────── */
admin.initializeApp({ credential: admin.credential.cert(svc) });
const db = admin.firestore();

/* ── 3. Main ──────────────────────────────────────── */

async function main() {
  const today = todayIST();
  const eventName = process.env.GITHUB_EVENT_NAME || '';
  const gated = process.env.GATED === 'true';
  const forced = (eventName === 'workflow_dispatch') && !gated;

  /* ── Schedule gate ──────────────────────────────────────────────── */
  let cfg = {};
  try {
    const cfgSnap = await db.collection('config').doc('telegram').get();
    cfg = cfgSnap.exists ? (cfgSnap.data() || {}) : {};
  } catch (e) { console.warn('⚠\uFE0F  Could not read config/telegram:', e.message); }

  const sendTime = /^\d{1,2}:\d{2}$/.test(cfg.sendTime) ? cfg.sendTime : '06:00';
  const [sh, sm] = sendTime.split(':').map(n => parseInt(n, 10));
  const targetMin = (sh * 60) + sm;

  if (forced) {
    console.log('\uD83D\uDE80 Manual run (workflow_dispatch) \u2014 bypassing schedule gate.');
  } else {
    if (cfg.lastSentDate === today) {
      console.log(`\u23ED  Already auto-sent today (${today}). Nothing to do.`);
      return;
    }
    if (istMinutesNow() < targetMin) {
      console.log(`\u23F0 Not send time yet. Now ${istClockNow()} IST, scheduled ${sendTime} IST. Skipping this run.`);
      return;
    }
    console.log(`\u2705 Send window reached (now ${istClockNow()} IST \u2265 ${sendTime} IST).`);
  }

  try {
    await db.collection('config').doc('telegram').set(
      { lastSentDate: today, lastRunAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
  } catch (e) { console.warn('\u26A0\uFE0F  Could not record lastSentDate:', e.message); }

  console.log(`\uD83D\uDCC5 Sending morning dashboards for ${today}`);

  const snap = await db.collection('users').get();
  console.log(`\uD83D\uDC65 Total users in Firestore: ${snap.size}`);

  const adminSnap = await db.collection('admins').get();
  const adminUids = new Set(adminSnap.docs.map(d => d.id));
  console.log(`\uD83D\uDEE1\uFE0F  Admins (always treated as Pro): ${adminUids.size}`);

  let sent = 0, skipped = 0, skippedFree = 0, failed = 0, noDigest = 0;

  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const tg   = (data.appState && data.appState.telegram) || {};

    if (!tg.enabled || !tg.chatId) { skipped++; continue; }

    if (!adminUids.has(doc.id) && !isProUser(data, today)) {
      skippedFree++;
      console.log(`  \uD83D\uDC8E Skipped (not Pro) \u2192 ${doc.id} chat:${tg.chatId}`);
      continue;
    }

    const digest = tg.digest || {};
    const plan   = digest[today];
    const aState = data.appState || {};
    const name   = (data.profile && data.profile.name)
                    ? data.profile.name.split(' ')[0]
                    : 'there';

    const built = buildMorningDashboard(name, aState, plan, today);
    const keyboard = morningKeyboard(today);

    if (!built.hasContent) noDigest++;

    try {
      /* v5: Send single interactive dashboard with inline keyboard */
      await sendTelegramMessageWithKeyboard(BOT_TOKEN, tg.chatId, built.text, keyboard);
      sent++;
      console.log(`  \u2705 Sent (1 dashboard) \u2192 ${doc.id} (${name}) chat:${tg.chatId}`);
    } catch (e) {
      if (e.skip) {
        console.log(`  \u26A0\uFE0F  Skipped (blocked/not found) \u2192 ${doc.id} chat:${tg.chatId}: ${e.message}`);
        skipped++;
      } else {
        failed++;
        console.error(`  \u274C Failed \u2192 ${doc.id}: ${e.message}`);
      }
    }
  }

  console.log('\n' + hr());
  console.log(`Done. Sent=${sent}  Skipped=${skipped}  SkippedFree=${skippedFree}  Failed=${failed}  NoDigest=${noDigest}`);

  if (noDigest > 0) {
    console.log(`\u2139\uFE0F  ${noDigest} user(s) got empty dashboard \u2014 they haven't set up a study plan yet.`);
  }
  if (failed > 0) {
    console.log('\u26A0\uFE0F  Some sends failed \u2014 check the error lines above.');
    process.exit(1);
  }
}

main().catch(e => {
  console.error('\u274C Fatal error:', e.message);
  process.exit(1);
});
