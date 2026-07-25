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
const { isProUser } = require('../shared/proGating');
const {
  todayIST, istMinutesNow, istClockNow,
  sendTelegramMessage: _sendTelegramMessage,
  fmtDM, shiftDate, escHtml, rolloverLabel, capLines,
  scheduledCourseVideos, buildTaskSections,
} = require('./telegram-lib');

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
/* Date/IST-time helpers, buildTaskSections, and the Telegram send helper now
   live in ./telegram-lib.js (shared with send-telegram-evening.js) — see that
   file's header comment. Nothing below was changed, just moved. */

/** Send a message via Telegram Bot API. Throws on API error. Thin wrapper so
 *  the rest of this file can keep calling sendTelegramMessage(chatId, text). */
function sendTelegramMessage(chatId, text) {
  return _sendTelegramMessage(BOT_TOKEN, chatId, text);
}

/** Accept a destination only when the Telegram account completed the one-time
 *  linking challenge for this exact Firebase UID. */
async function verifiedTelegramChat(uid, claimedChatId) {
  const chatId = String(claimedChatId || '').trim();
  if (!/^-?\d+$/.test(chatId)) return '';
  const link = await db.collection('telegram_links').doc(chatId).get();
  const data = link.exists ? (link.data() || {}) : {};
  return data.verified === true
    && data.method === 'challenge-v1'
    && String(data.uid || '') === String(uid) ? chatId : '';
}

/* ── Pro check ──────────────────────────────────────────────────────────────
   Delegated to shared/proGating.js — the single source of truth for
   server-side Pro/trial gating, also used by bot/bot-server.js. Auto
   Telegram delivery is a Pro feature, so the cron must not send to free
   users even if their appState.telegram.enabled is somehow true (stale
   data, expired plan, etc.). Must stay behaviourally in sync with the web
   app's ezIsPro() (js/features/preppath-phase4-gating.js) — see the
   comment in that file. */

/* ── 4. Main ────────────────────────────────────────────────────────────── */

/* Assemble the full per-user message: Study Topics + To-Do + Videos. */
function buildMessage(name, appState, topicDigest, today) {
  const header = `☀️ <b>Good morning, ${escHtml(name)}!</b>\n📅 Aaj ka plan (${fmtDM(today)})\n`;
  const sections = [];

  if (topicDigest && topicDigest.trim()) {
    sections.push('▪ <b>Study Topics</b>\n' + topicDigest.trim());
  }

  const { todoLines, videoItems, doneCount } = buildTaskSections(appState, today);

  if (todoLines.length) {
    let block = '✓ <b>To-Do</b>\n' + capLines(todoLines, 12);
    if (doneCount) block += `\n✅ ${doneCount} done`;
    sections.push(block);
  } else if (doneCount) {
    sections.push(`✓ <b>To-Do</b>\n✅ Sab ${doneCount} tasks done — shabash! 🎉`);
  }

  if (videoItems.length) {
    const vlines = videoItems.map(v => `▶ <a href="${v.url}">${escHtml(v.title)}</a>`);
    sections.push('🎥 <b>Videos</b>\n' + capLines(vlines, 10));
  }

  const footer = '\n\n— <a href="https://examzen.in">StudyPlanner</a>';
  const hasContent = sections.length > 0;
  const body = hasContent
    ? sections.join('\n\n')
    : '📋 Aaj koi topic/task scheduled nahi.\n💡 App kholo → Planner mein add karo → Save karo.';
  return { text: header + '\n' + body + footer, hasContent };
}

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

    const verifiedChatId = await verifiedTelegramChat(doc.id, tg.chatId);
    if (!verifiedChatId) {
      skipped++;
      console.log(`  🔒 Skipped (Telegram ownership not verified) → ${doc.id}`);
      continue;
    }

    /* Read today's digest entry (study topics + revisions, browser-built) and
       assemble the full message (topics + to-do + videos) at send time so the
       to-do list, videos, and rolled-over items are always accurate. */
    const digest = tg.digest || {};
    const plan   = digest[today];
    const aState = data.appState || {};
    const name   = (data.profile && data.profile.name)
                    ? data.profile.name.split(' ')[0]
                    : 'there';

    const built = buildMessage(name, aState, plan, today);
    if (!built.hasContent) noDigest++;

    try {
      await sendTelegramMessage(verifiedChatId, built.text);
      sent++;
      console.log(`  ✅ Sent → ${doc.id} (${name}) chat:${verifiedChatId}`);
    } catch (e) {
      if (e.skip) {
        console.log(`  ⚠️  Skipped (blocked/not found) → ${doc.id} chat:${verifiedChatId}: ${e.message}`);
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
