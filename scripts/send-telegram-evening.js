/*
 * PrepPath — Evening Telegram "incomplete tasks" check-in
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs in GitHub Actions (see .github/workflows/evening-telegram.yml).
 * Companion to scripts/send-telegram.js (the morning digest) — this one fires
 * later in the day and tells each user what's STILL not done today: incomplete
 * To-Do tasks and pending videos. Shares its date math, Telegram send helper,
 * and task/video extraction with the morning script via ./telegram-lib.js so
 * the two stay behaviourally consistent.
 *
 * For every user who has:
 *   - appState.telegram.enabled  = true
 *   - appState.telegram.chatId   = a numeric Telegram chat ID
 *   - (Pro or admin — same gate as the morning digest)
 * it looks at today's tasks and sends whatever is still incomplete.
 *
 * If a user has nothing tracked for today at all (no tasks, nothing done),
 * we skip them rather than send an empty "nothing to report" message every
 * evening — see the `noContent` branch in main().
 *
 * Required GitHub secrets (same two as the morning script):
 *   TELEGRAM_BOT_TOKEN        – from @BotFather
 *   FIREBASE_SERVICE_ACCOUNT  – full service-account JSON (one line or pretty-printed)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const admin = require('firebase-admin');
const { isProUser } = require('../shared/proGating');
const {
  todayIST, istMinutesNow, istClockNow,
  sendTelegramMessage: _sendTelegramMessage,
  fmtDM, escHtml, capLines,
  buildTaskSections,
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

/** Send a message via Telegram Bot API. Throws on API error. */
function sendTelegramMessage(chatId, text) {
  return _sendTelegramMessage(BOT_TOKEN, chatId, text);
}

/* ── Pro check ──────────────────────────────────────────────────────────────
   Same gate as the morning digest (shared/proGating.js) — the evening
   check-in is part of the same Pro Telegram feature, not a separate one. */

/* Assemble the evening message: what's still not done today.
   Returns { text, hasContent } — hasContent is false when there is truly
   nothing to say (no tasks tracked today, nothing done either), so main()
   can skip sending rather than nag an empty message every evening. */
function buildEveningMessage(name, appState, today) {
  const header = `🌙 <b>Evening check-in, ${escHtml(name)}!</b>\n📅 ${fmtDM(today)} — kya baaki hai?\n`;
  const { todoLines, videoItems, doneCount } = buildTaskSections(appState, today);
  const pending = todoLines.length > 0 || videoItems.length > 0;

  if (!pending && doneCount === 0) {
    /* Nothing tracked for today at all — nothing meaningful to report. */
    return { text: '', hasContent: false };
  }

  const sections = [];
  if (todoLines.length) {
    sections.push('⏳ <b>Still pending</b>\n' + capLines(todoLines, 12));
  }
  if (videoItems.length) {
    const vlines = videoItems.map(v => `▶ <a href="${v.url}">${escHtml(v.title)}</a>`);
    sections.push('🎥 <b>Videos still pending</b>\n' + capLines(vlines, 10));
  }
  if (!pending) {
    /* Everything that was tracked today is done. */
    sections.push(`✅ Sab ${doneCount} tasks done for today — shabash! 🎉`);
  } else if (doneCount) {
    sections.push(`✅ ${doneCount} already done today`);
  }

  const footer = '\n\n— <a href="https://examzen.in">StudyPlanner</a>';
  return { text: header + '\n' + sections.join('\n\n') + footer, hasContent: true };
}

async function main() {
  const today = todayIST();
  const eventName = process.env.GITHUB_EVENT_NAME || '';
  /* Same "gated" pattern as the morning script: a plain manual run sends
     immediately; scheduled runs and gated=true external-cron dispatches
     respect the admin-set evening time + once-per-day guard below. */
  const gated = process.env.GATED === 'true';
  const forced = (eventName === 'workflow_dispatch') && !gated;

  /* ── Schedule gate ───────────────────────────────────────────────────────
     Separate from the morning gate: config/telegram.eveningSendTime ("HH:MM",
     IST, default 20:00) and config/telegram.lastEveningSentDate, so the
     morning and evening sends never interfere with each other's guard. */
  let cfg = {};
  try {
    const cfgSnap = await db.collection('config').doc('telegram').get();
    cfg = cfgSnap.exists ? (cfgSnap.data() || {}) : {};
  } catch (e) { console.warn('⚠️  Could not read config/telegram:', e.message); }

  const sendTime = /^\d{1,2}:\d{2}$/.test(cfg.eveningSendTime) ? cfg.eveningSendTime : '20:00';
  const [sh, sm] = sendTime.split(':').map(n => parseInt(n, 10));
  const targetMin = (sh * 60) + sm;

  if (forced) {
    console.log('🚀 Manual run (workflow_dispatch) — bypassing schedule gate.');
  } else {
    if (cfg.lastEveningSentDate === today) {
      console.log(`⏭  Already auto-sent this evening (${today}). Nothing to do.`);
      return;
    }
    if (istMinutesNow() < targetMin) {
      console.log(`⏰ Not send time yet. Now ${istClockNow()} IST, scheduled ${sendTime} IST. Skipping this run.`);
      return;
    }
    console.log(`✅ Send window reached (now ${istClockNow()} IST ≥ ${sendTime} IST).`);
  }

  /* Claim today's evening slot BEFORE sending so an overlapping/next run
     can't double-send. A manual re-run (workflow_dispatch) ignores the
     guard, so the admin can always force a resend. */
  try {
    await db.collection('config').doc('telegram').set(
      { lastEveningSentDate: today, lastEveningRunAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
  } catch (e) { console.warn('⚠️  Could not record lastEveningSentDate:', e.message); }

  console.log(`📅 Sending evening check-ins for ${today}`);

  const snap = await db.collection('users').get();
  console.log(`👥 Total users in Firestore: ${snap.size}`);

  const adminSnap = await db.collection('admins').get();
  const adminUids = new Set(adminSnap.docs.map(d => d.id));

  let sent = 0, skipped = 0, skippedFree = 0, failed = 0, noContent = 0;

  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const tg   = (data.appState && data.appState.telegram) || {};

    if (!tg.enabled || !tg.chatId) {
      skipped++;
      continue;
    }

    if (!adminUids.has(doc.id) && !isProUser(data, today)) {
      skippedFree++;
      continue;
    }

    const aState = data.appState || {};
    const name   = (data.profile && data.profile.name)
                    ? data.profile.name.split(' ')[0]
                    : 'there';

    const built = buildEveningMessage(name, aState, today);
    if (!built.hasContent) { noContent++; continue; } /* nothing tracked today — don't nag */

    try {
      await sendTelegramMessage(tg.chatId, built.text);
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
  console.log(`Done. Sent=${sent}  Skipped=${skipped}  SkippedFree=${skippedFree}  Failed=${failed}  NoContent=${noContent}`);

  if (failed > 0) {
    console.log('⚠️  Some sends failed — check the error lines above.');
    process.exit(1); // Make the Actions step red so you notice
  }
}

main().catch(e => {
  console.error('❌ Fatal error:', e.message);
  process.exit(1);
});
