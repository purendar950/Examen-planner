/*
 * PrepPath — Evening Telegram “incomplete tasks” check-in
 * ──────────────────────────────────────────────────────────────────────────────────────
 * Runs in GitHub Actions (see .github/workflows/evening-telegram.yml).
 * Companion to scripts/send-telegram.js (the morning digest) — this one fires
 * later in the day and tells each user what's STILL not done today: incomplete
 * To-Do tasks and pending videos. Shares its date math, Telegram send helper,
 * and task/video extraction with the morning script via ./telegram-lib.js so
 * the two stay behaviourally consistent.
 *
 * Required GitHub secrets (same two as the morning script):
 *   TELEGRAM_BOT_TOKEN        – from @BotFather
 *   FIREBASE_SERVICE_ACCOUNT  – full service-account JSON (one line or pretty-printed)
 *
 * v4 — Animated cascade: 2-3 sequential messages with delays,
 * <tg-spoiler> tomorrow preview & encouragement reveal, gradient progress,
 * status dots, and premium card formatting.
 * ──────────────────────────────────────────────────────────────────────────────────────
 */

const admin = require('firebase-admin');
const { isProUser } = require('../shared/proGating');
const {
  todayIST, istMinutesNow, istClockNow,
  sendTelegramMessage: _sendTelegramMessage,
  sendSequentialMessages,
  fmtDM, fmtDMDay, escHtml, capLines, capTaskLines,
  buildTaskSections,
  progressBar, gradientBar, hr, dotHr, sparkleHr, eveningEncouragement, todayTotalTasks, shiftDate,
  boxTop, boxBottom, boxMid,
  subjectEmoji, sectionHeader, completionBadge, miniStats,
  statusDot, spoiler, taskBullet, labelPill,
} = require('./telegram-lib');

/* ── 1. Validate secrets ────────────────────── */
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

/* ── 2. Init Firebase Admin ────────────── */
admin.initializeApp({ credential: admin.credential.cert(svc) });
const db = admin.firestore();

function sendTelegramMessage(chatId, text) {
  return _sendTelegramMessage(BOT_TOKEN, chatId, text);
}

function sendCascade(chatId, messages) {
  return sendSequentialMessages(BOT_TOKEN, chatId, messages, 1200);
}

/* ── Pro check ─────────────────────────────
   Same gate as the morning digest (shared/proGating.js). */

/* Build 2-3 sequential messages for animated cascade effect:
 *   Message 1: Evening header + progress card
 *   Message 2: Pending tasks + overdue + videos + tomorrow preview
 *   Message 3: Encouragement in spoiler (tap to reveal!)
 *
 * Returns { messages: string[], hasContent: bool }. */
function buildEveningMessage(name, appState, today) {
  const { todoLines, videoItems, doneCount } = buildTaskSections(appState, today);
  const totalTaskCount = todayTotalTasks(appState, today);
  const totalCount = totalTaskCount + doneCount;
  const pending = todoLines.length > 0 || videoItems.length > 0;
  const todayPending = todoLines.filter(t => !t.overdue).length;
  const overdueCount = todoLines.filter(t => t.overdue).length;
  const pct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  if (!pending && doneCount === 0) {
    return { messages: [], hasContent: false };
  }

  /* ── MESSAGE 1: HEADER + PROGRESS (the status card) ── */
  const msg1 = [];
  msg1.push(boxTop());
  msg1.push(`<b>🌙  Evening Check-in, ${escHtml(name)}!</b>`);
  msg1.push(boxMid());
  msg1.push(`📅  <b>${fmtDMDay(today)}</b>`);
  msg1.push('');
  if (totalCount > 0) {
    msg1.push(labelPill(completionBadge(pct), `${doneCount}/${totalCount} tasks done  ·  ${todayPending} pending  ·  ${overdueCount} overdue`));
    msg1.push('');
    msg1.push(gradientBar(doneCount, totalCount));
    msg1.push(progressBar(doneCount, totalCount));
    msg1.push('');
    msg1.push(miniStats(doneCount, todayPending, overdueCount));
  } else {
    msg1.push(labelPill('📊', 'No tracked tasks today'));
  }
  msg1.push(boxBottom());

  /* ── MESSAGE 2: CONTENT (pending + overdue + videos + tomorrow) ── */
  const msg2 = [];
  let hasMsg2Content = false;
  const todayTasks = todoLines.filter(t => !t.overdue);
  const overdueTasks = todoLines.filter(t => t.overdue);

  /* Today's Pending */
  if (todayTasks.length) {
    hasMsg2Content = true;
    msg2.push(boxTop());
    msg2.push(sectionHeader('📋', 'Still Pending'));
    msg2.push(hr());
    todayTasks.forEach(t => { msg2.push(`  ${t.line}`); });
  }

  /* Overdue */
  if (overdueTasks.length) {
    if (hasMsg2Content) msg2.push('');
    hasMsg2Content = true;
    if (!todayTasks.length) msg2.push(boxTop());
    msg2.push(`<b>⚠️  OVERDUE (${overdueTasks.length})</b>`);
    msg2.push(dotHr());
    overdueTasks.forEach(t => { msg2.push(`  ${t.line}`); });
  }

  /* All Done Celebration */
  if (!pending && doneCount > 0) {
    hasMsg2Content = true;
    msg2.push(boxTop());
    msg2.push(`<b>✨  ALL TASKS DONE!</b>`);
    msg2.push(`<i>Sab ${doneCount} tasks done for today — shabash! 🎉</i>`);
  }

  /* Videos Pending */
  if (videoItems.length) {
    if (hasMsg2Content) msg2.push('');
    hasMsg2Content = true;
    if (!todayTasks.length && !overdueTasks.length && (pending || doneCount === 0)) msg2.push(boxTop());
    msg2.push(sectionHeader('🎬', 'Videos Pending'));
    msg2.push(hr());
    videoItems.forEach((v, i) => {
      const emoji = subjectEmoji(v.title);
      msg2.push(`  <code>${String(i + 1).padStart(2, '0')}</code>  ${emoji}  <a href="${v.url}">${escHtml(v.title)}</a>`);
    });
  }

  /* Tomorrow Preview — wrapped in spoiler for interactive reveal */
  const tomorrow = shiftDate(today, 1);
  const tomorrowTasks = appState && appState.tasks && Array.isArray(appState.tasks[tomorrow])
    ? appState.tasks[tomorrow].filter(t => t && !t.done && t.status !== 'done')
    : [];
  if (tomorrowTasks.length > 0) {
    if (hasMsg2Content) msg2.push('');
    hasMsg2Content = true;
    if (!todayTasks.length && !overdueTasks.length && videoItems.length === 0 && (pending || doneCount === 0)) msg2.push(boxTop());
    msg2.push(sectionHeader('🔮', "Tomorrow's Preview"));
    msg2.push(hr());
    const previewLines = [];
    tomorrowTasks.slice(0, 3).forEach(t => {
      const raw = t.text || 'Task';
      previewLines.push(`  ${subjectEmoji(raw)}  ${escHtml(raw)}`);
    });
    if (tomorrowTasks.length > 3) {
      previewLines.push(`  <i>…+${tomorrowTasks.length - 3} more</i>`);
    }
    /* Wrap tomorrow preview in spoiler — user taps to reveal! */
    msg2.push(spoiler(previewLines.join('\n')));
  }

  if (hasMsg2Content) {
    msg2.push(boxBottom());
  }

  /* ── MESSAGE 3: ENCOURAGEMENT SPOILER (tap to reveal!) ── */
  const encouragement = eveningEncouragement(doneCount, totalCount);
  const msg3 = [];
  if (encouragement) {
    msg3.push(sparkleHr());
    msg3.push(spoiler(`<i>${encouragement}</i>`));
    msg3.push(sparkleHr());
  }
  msg3.push(`<a href="https://examzen.in">🏠  StudyPlanner</a>`);

  /* Build cascade array */
  const messages = [];
  messages.push(msg1.join('\n'));
  if (hasMsg2Content) messages.push(msg2.join('\n'));
  messages.push(msg3.join('\n'));

  return { messages, hasContent: true };
}

async function main() {
  const today = todayIST();
  const eventName = process.env.GITHUB_EVENT_NAME || '';
  const gated = process.env.GATED === 'true';
  const forced = (eventName === 'workflow_dispatch') && !gated;

  /* ── Schedule gate ── */
  let cfg = {};
  try {
    const cfgSnap = await db.collection('config').doc('telegram').get();
    cfg = cfgSnap.exists ? (cfgSnap.data() || {}) : {};
  } catch (e) { console.warn('\u26A0\uFE0F  Could not read config/telegram:', e.message); }

  const sendTime = /^\d{1,2}:\d{2}$/.test(cfg.eveningSendTime) ? cfg.eveningSendTime : '20:00';
  const [sh, sm] = sendTime.split(':').map(n => parseInt(n, 10));
  const targetMin = (sh * 60) + sm;

  if (forced) {
    console.log('\uD83D\uDE80 Manual run (workflow_dispatch) \u2014 bypassing schedule gate.');
  } else {
    if (cfg.lastEveningSentDate === today) {
      console.log(`\u23ED  Already auto-sent this evening (${today}). Nothing to do.`);
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
      { lastEveningSentDate: today, lastEveningRunAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
  } catch (e) { console.warn('\u26A0\uFE0F  Could not record lastEveningSentDate:', e.message); }

  console.log(`\uD83D\uDCC5 Sending evening check-ins for ${today}`);

  const snap = await db.collection('users').get();
  console.log(`\uD83D\uDC65 Total users in Firestore: ${snap.size}`);

  const adminSnap = await db.collection('admins').get();
  const adminUids = new Set(adminSnap.docs.map(d => d.id));

  let sent = 0, skipped = 0, skippedFree = 0, failed = 0, noContent = 0;

  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const tg   = (data.appState && data.appState.telegram) || {};

    if (!tg.enabled || !tg.chatId) { skipped++; continue; }

    if (!adminUids.has(doc.id) && !isProUser(data, today)) {
      skippedFree++;
      continue;
    }

    const aState = data.appState || {};
    const name   = (data.profile && data.profile.name)
                    ? data.profile.name.split(' ')[0]
                    : 'there';

    const built = buildEveningMessage(name, aState, today);
    if (!built.hasContent) { noContent++; continue; }

    try {
      /* v4: Send as animated cascade */
      await sendCascade(tg.chatId, built.messages);
      sent++;
      console.log(`  ✅ Sent (${built.messages.length} msgs) → ${doc.id} (${name}) chat:${tg.chatId}`);
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

  console.log('\n' + hr());
  console.log(`Done. Sent=${sent}  Skipped=${skipped}  SkippedFree=${skippedFree}  Failed=${failed}  NoContent=${noContent}`);

  if (failed > 0) {
    console.log('\u26A0\uFE0F  Some sends failed \u2014 check the error lines above.');
    process.exit(1);
  }
}

main().catch(e => {
  console.error('❌ Fatal error:', e.message);
  process.exit(1);
});
