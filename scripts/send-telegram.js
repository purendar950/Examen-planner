/*
 * PrepPath — Daily Telegram study-plan sender
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs in GitHub Actions (see .github/workflows/daily-telegram.yml).
 *
 * For every user who has:
 *   - appState.telegram.enabled  = true
 *   - appState.telegram.chatId   = a numeric Telegram chat ID
 * it reads their precomputed digest for today and sends it via Telegram Bot API.
 *
 * Required GitHub secrets:
 *   TELEGRAM_BOT_TOKEN        – from @BotFather
 *   FIREBASE_SERVICE_ACCOUNT  – full service-account JSON (one line or pretty-printed)
 *
 * The digest is built in the browser (buildTelegramDigest in app.html) and
 * stored at Firestore: users/{uid}.appState.telegram.digest = { 'YYYY-MM-DD': text }
 * ─────────────────────────────────────────────────────────────────────────────
 */

const admin = require('firebase-admin');
const fetch = require('node-fetch');

/* ── 1. Validate secrets ────────────────────────────────────────────────── */
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
  console.error('   Make sure you pasted the ENTIRE JSON from Firebase Console → Service accounts → Generate new private key.');
  process.exit(1);
}
console.log(`✅ Firebase project: ${svc.project_id}`);

/* ── 2. Init Firebase Admin ─────────────────────────────────────────────── */
admin.initializeApp({ credential: admin.credential.cert(svc) });
const db = admin.firestore();

/* ── 3. Helpers ─────────────────────────────────────────────────────────── */

/** Today's date string in IST (YYYY-MM-DD). The cron fires at 00:30 UTC = 06:00 IST. */
function todayIST() {
  const now = new Date();
  const ist = new Date(now.getTime() + (5 * 60 + 30) * 60000);
  return ist.toISOString().slice(0, 10);
}

/** Current IST time as minutes-since-midnight (0–1439). */
function istMinutesNow() {
  const ist = new Date(Date.now() + (5 * 60 + 30) * 60000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

/** Current IST wall-clock as "HH:MM" (for logs). */
function istClockNow() {
  const ist = new Date(Date.now() + (5 * 60 + 30) * 60000);
  const p = n => String(n).padStart(2, '0');
  return p(ist.getUTCHours()) + ':' + p(ist.getUTCMinutes());
}

/** Send a message via Telegram Bot API. Throws on API error. */
async function sendTelegramMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:                  chatId,
      text,
      parse_mode:               'HTML',
      disable_web_page_preview: true,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    const desc = data.description || 'Unknown Telegram error';
    /* 403 = user blocked the bot; 400 chat not found → skip, not an error in the code */
    if (data.error_code === 403 || (data.error_code === 400 && desc.includes('chat not found'))) {
      throw Object.assign(new Error(desc), { skip: true });
    }
    throw new Error(`Telegram API error ${data.error_code}: ${desc}`);
  }
}

/* ── Pro check — mirrors ezIsPro() in app.html. Auto Telegram delivery is a
   Pro feature, so the cron must not send to free users even if their
   appState.telegram.enabled is somehow true (stale data, expired plan, etc.) */
function isProUser(data, today) {
  const profile  = data.profile  || {};
  const appState = data.appState || {};
  if (profile.plan && profile.plan !== 'free') {
    if (!profile.planExpiry || profile.planExpiry >= today) return true;
  }

  // Admin-granted trial (profile.trialExpiry). This field is admin-only-writable
  // in the Firestore rules, so it's trusted (no tamper guard needed). Mirrors
  // the web app's ezIsTrialActive(): active unless suspended and not yet expired.
  if (profile.trialExpiry && !profile.trialSuspended && profile.trialExpiry >= today) return true;

  const trial = appState.proTrial;
  if (trial && trial.expiry && trial.expiry >= today) {
    // Mirror the web app's ezIsProTrialActive() guards. proTrial lives in
    // user-writable appState, so don't trust it blindly:
    //   1. An admin can suspend a trial (profile.trialSuspended).
    //   2. A self-serve trial lasts at most ~4 days (3 + 1 grace) from
    //      startedAt — this rejects a tampered far-future expiry written
    //      straight to Firestore on first activation.
    if (profile.trialSuspended) return false;
    if (trial.startedAt) {
      const startedAt = new Date(trial.startedAt);
      const maxExpiry = new Date(startedAt.getTime() + 4 * 86400000);
      const claimedExpiry = new Date(trial.expiry + 'T23:59:59');
      if (!isNaN(startedAt.getTime()) && claimedExpiry > maxExpiry) return false;
    }
    return true;
  }
  return false;
}

/* ── 4. Main ────────────────────────────────────────────────────────────── */
async function main() {
  const today = todayIST();
  const eventName = process.env.GITHUB_EVENT_NAME || '';
  /* "Force" = a MANUAL "Run workflow" (gated input false) → send immediately.
     Scheduled runs AND external-cron dispatches (gated=true) respect the
     admin-set time gate below, so the external cron can safely ping every few
     minutes without sending more than once per day. */
  const gated = process.env.GATED === 'true';
  const forced = (eventName === 'workflow_dispatch') && !gated;

  /* ── Schedule gate ───────────────────────────────────────────────────────
     The workflow runs every 30 min. The admin sets the daily send time in
     config/telegram.sendTime ("HH:MM", IST, default 06:00). We send on the
     FIRST run at/after that time each day and record config/telegram.lastSentDate
     so we never send twice. A manual workflow_dispatch run bypasses the gate. */
  let cfg = {};
  try {
    const cfgSnap = await db.collection('config').doc('telegram').get();
    cfg = cfgSnap.exists ? (cfgSnap.data() || {}) : {};
  } catch (e) { console.warn('⚠️  Could not read config/telegram:', e.message); }

  const sendTime = /^\d{1,2}:\d{2}$/.test(cfg.sendTime) ? cfg.sendTime : '06:00';
  const [sh, sm] = sendTime.split(':').map(n => parseInt(n, 10));
  const targetMin = (sh * 60) + sm;

  if (forced) {
    console.log('🚀 Manual run (workflow_dispatch) — bypassing schedule gate.');
  } else {
    if (cfg.lastSentDate === today) {
      console.log(`⏭  Already auto-sent today (${today}). Nothing to do.`);
      return;
    }
    if (istMinutesNow() < targetMin) {
      console.log(`⏰ Not send time yet. Now ${istClockNow()} IST, scheduled ${sendTime} IST. Skipping this run.`);
      return;
    }
    console.log(`✅ Send window reached (now ${istClockNow()} IST ≥ ${sendTime} IST).`);
  }

  /* Claim today's slot BEFORE sending so an overlapping/next 30-min run can't
     double-send. A manual re-run (workflow_dispatch) ignores lastSentDate, so
     the admin can always force a resend. */
  try {
    await db.collection('config').doc('telegram').set(
      { lastSentDate: today, lastRunAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
  } catch (e) { console.warn('⚠️  Could not record lastSentDate:', e.message); }

  console.log(`📅 Sending plans for ${today}`);

  const snap = await db.collection('users').get();
  console.log(`👥 Total users in Firestore: ${snap.size}`);

  const adminSnap = await db.collection('admins').get();
  const adminUids = new Set(adminSnap.docs.map(d => d.id));
  console.log(`🛡️  Admins (always treated as Pro): ${adminUids.size}`);

  let sent = 0, skipped = 0, skippedFree = 0, failed = 0, noDigest = 0;

  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const tg   = (data.appState && data.appState.telegram) || {};

    /* Skip users who haven't connected Telegram */
    if (!tg.enabled || !tg.chatId) {
      skipped++;
      continue;
    }

    /* Pro-only feature — skip free users even if enabled/chatId are set */
    if (!adminUids.has(doc.id) && !isProUser(data, today)) {
      skippedFree++;
      console.log(`  💎 Skipped (not Pro) → ${doc.id} chat:${tg.chatId}`);
      continue;
    }

    /* Read today's digest entry */
    const digest = tg.digest || {};
    const plan   = digest[today];
    const name   = (data.profile && data.profile.name)
                    ? data.profile.name.split(' ')[0]
                    : 'there';

    /* Build message */
    const header = `☀️ <b>Good morning, ${name}!</b>\n📅 Aaj ka study plan (${today})\n\n`;
    let   body;
    if (plan && plan.trim()) {
      body = plan;
    } else {
      body = '📋 Aaj koi topic scheduled nahi.\n💡 App kholo → Planner mein topics add karo → Save karo.';
      noDigest++;
    }
    const footer = '\n\n— <a href="https://examzen.in">StudyPlanner</a>';

    try {
      await sendTelegramMessage(tg.chatId, header + body + footer);
      sent++;
      console.log(`  ✅ Sent → ${doc.id} (${name}) chat:${tg.chatId}`);
    } catch (e) {
      if (e.skip) {
        console.log(`  ⚠️  Skipped (blocked/not found) → ${doc.id} chat:${tg.chatId}: ${e.message}`);
        skipped++;
      } else {
        failed++;
        console.error(`  ❌ Failed → ${doc.id}: ${e.message}`);
      }
    }
  }

  console.log('\n─────────────────────────────');
  console.log(`Done. Sent=${sent}  Skipped=${skipped}  SkippedFree=${skippedFree}  Failed=${failed}  NoDigest=${noDigest}`);

  if (noDigest > 0) {
    console.log(`ℹ️  ${noDigest} user(s) got fallback message — they haven't set up a study plan yet.`);
  }
  if (failed > 0) {
    console.log('⚠️  Some sends failed — check the error lines above.');
    process.exit(1); // Make the Actions step red so you notice
  }
}

main().catch(e => {
  console.error('❌ Fatal error:', e.message);
  process.exit(1);
});
