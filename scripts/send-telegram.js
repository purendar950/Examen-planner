/*
 * PrepPath — Daily Telegram study-plan sender
 * ────────────────────────────────────────────────────────────────────────────────────────
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
 *
 * v4 — Animated cascade: 3 sequential messages with delays,
 * <tg-spoiler> quote reveal, gradient emoji progress, status dots.
 * ────────────────────────────────────────────────────────────────────────────────────────
 */

const admin = require('firebase-admin');
const { isProUser } = require('../shared/proGating');
const {
  todayIST, istMinutesNow, istClockNow,
  sendTelegramMessage: _sendTelegramMessage,
  sendSequentialMessages,
  fmtDM, fmtDMDay, escHtml, capLines, capTaskLines,
  scheduledCourseVideos, buildTaskSections,
  progressBar, gradientBar, hr, dotHr, sparkleHr, dailyQuote, todayTotalTasks,
  boxTop, boxBottom, boxMid,
  subjectEmoji, sectionHeader, completionBadge, miniStats, statPill,
  statusDot, spoiler, taskBullet, labelPill,
} = require('./telegram-lib');

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
  console.error('   Make sure you pasted the ENTIRE JSON from Firebase Console → Service accounts → Generate new private key.');
  process.exit(1);
}
console.log(`✅ Firebase project: ${svc.project_id}`);

/* ── 2. Init Firebase Admin ─────────────────────────────── */
admin.initializeApp({ credential: admin.credential.cert(svc) });
const db = admin.firestore();

/* ── 3. Helpers ──────────────────────────────────────── */
function sendTelegramMessage(chatId, text) {
  return _sendTelegramMessage(BOT_TOKEN, chatId, text);
}

function sendCascade(chatId, messages) {
  return sendSequentialMessages(BOT_TOKEN, chatId, messages, 1200);
}

/* ── Pro check ─────────────────────────────────────────────────
   Delegated to shared/proGating.js. */

/* ── 4. Main ──────────────────────────────────────── */

/* Build 3 sequential messages for the animated cascade effect:
 *   Message 1: Header card + progress (the "teaser")
 *   Message 2: Study topics + Tasks + Videos (the "meat")
 *   Message 3: Motivational quote in spoiler (the "reward")
 *
 * Returns an array of message strings (1-3 items).
 * Falls back to single-message mode for empty state. */
function buildMessage(name, appState, topicDigest, today) {
  const { todoLines, videoItems, doneCount } = buildTaskSections(appState, today);
  const totalCount = todayTotalTasks(appState, today);
  const total = totalCount + doneCount;
  const todayPending = todoLines.filter(t => !t.overdue).length;
  const overdueCount = todoLines.filter(t => t.overdue).length;
  const hasContent = (topicDigest && topicDigest.trim()) || todoLines.length || videoItems.length;
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  if (!hasContent) {
    /* Empty state — single message, no cascade */
    const parts = [];
    parts.push(boxTop());
    parts.push(`<b>☀️  Good Morning, ${escHtml(name)}!</b>`);
    parts.push(boxMid());
    parts.push(`📅  <b>${fmtDMDay(today)}</b>`);
    parts.push('');
    parts.push('<b>📋  No plan scheduled today</b>');
    parts.push(dotHr());
    parts.push('<i>💡 App kholo → Planner mein add karo → Save karo</i>');
    parts.push(boxMid());
    parts.push(sparkleHr());
    parts.push(spoiler(`<i>💬  “${dailyQuote(today)}”</i>`));
    parts.push(sparkleHr());
    parts.push(boxBottom());
    parts.push(`<a href="https://examzen.in">🏠  StudyPlanner</a>`);
    return { messages: [parts.join('\n')], hasContent: false };
  }

  /* ── MESSAGE 1: HEADER + PROGRESS (the teaser) ── */
  const msg1 = [];
  msg1.push(boxTop());
  msg1.push(`<b>☀️  Good Morning, ${escHtml(name)}!</b>`);
  msg1.push(boxMid());
  msg1.push(`📅  <b>${fmtDMDay(today)}</b>`);
  msg1.push('');
  if (total > 0) {
    msg1.push(labelPill('📊', `${statusDot(pct)}  ${doneCount}/${total} done  ·  ${todayPending} pending  ·  ${overdueCount} overdue`));
    msg1.push('');
    msg1.push(gradientBar(doneCount, total));
    msg1.push(progressBar(doneCount, total));
  }
  msg1.push(boxBottom());

  /* ── MESSAGE 2: CONTENT (study plan + tasks + videos) ── */
  const msg2 = [];
  let hasMsg2Content = false;

  /* Study Topics */
  if (topicDigest && topicDigest.trim()) {
    hasMsg2Content = true;
    msg2.push(boxTop());
    msg2.push(sectionHeader('📚', 'Study Plan'));
    msg2.push(hr());
    const topicLines = topicDigest.trim().split('\n').filter(l => l.trim());
    topicLines.forEach((line, i) => {
      const emoji = subjectEmoji(line);
      msg2.push(`  <code>${String(i + 1).padStart(2, '0')}</code>  ${emoji}  ${line}`);
    });
  }

  /* Today's Tasks */
  if (todoLines.length) {
    const todayTasks = todoLines.filter(t => !t.overdue);
    const overdueTasks = todoLines.filter(t => t.overdue);

    if (todayTasks.length) {
      if (hasMsg2Content) msg2.push('');
      hasMsg2Content = true;
      if (!topicDigest || !topicDigest.trim()) msg2.push(boxTop());
      msg2.push(sectionHeader('✅', "Today's Tasks"));
      msg2.push(hr());
      todayTasks.forEach(t => { msg2.push(`  ${t.line}`); });
    }

    if (overdueTasks.length) {
      if (hasMsg2Content) msg2.push('');
      hasMsg2Content = true;
      if (!topicDigest || !topicDigest.trim()) msg2.push(boxTop());
      msg2.push(`<b>⚠️  OVERDUE (${overdueTasks.length})</b>`);
      msg2.push(dotHr());
      overdueTasks.forEach(t => { msg2.push(`  ${t.line}`); });
    }

    if (doneCount > 0) {
      msg2.push('');
      msg2.push(`<i>✅  ${doneCount} task${doneCount > 1 ? 's' : ''} already completed</i>`);
    }
  } else if (doneCount > 0) {
    if (!topicDigest || !topicDigest.trim()) msg2.push(boxTop());
    hasMsg2Content = true;
    msg2.push('');
    msg2.push(`<b>✨  ALL TASKS DONE!</b>`);
    msg2.push(`<i>Sab ${doneCount} tasks done — shabash! 🎉</i>`);
  }

  /* Videos */
  if (videoItems.length) {
    if (hasMsg2Content) msg2.push('');
    hasMsg2Content = true;
    if (!topicDigest || !topicDigest.trim()) msg2.push(boxTop());
    msg2.push(sectionHeader('🎬', 'Videos'));
    msg2.push(hr());
    videoItems.forEach((v, i) => {
      const emoji = subjectEmoji(v.title);
      msg2.push(`  <code>${String(i + 1).padStart(2, '0')}</code>  ${emoji}  <a href="${v.url}">${escHtml(v.title)}</a>`);
    });
  }

  if (hasMsg2Content) {
    msg2.push(boxBottom());
  }

  /* ── MESSAGE 3: SPOILER QUOTE (the reward — tap to reveal!) ── */
  const msg3 = [];
  msg3.push(sparkleHr());
  msg3.push(spoiler(`<i>💬  “${dailyQuote(today)}”</i>`));
  msg3.push(sparkleHr());
  msg3.push(`<a href="https://examzen.in">🏠  StudyPlanner</a>`);

  /* Combine into cascade messages array */
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

  /* ── Schedule gate ──────────────────────────────────────────────── */
  let cfg = {};
  try {
    const cfgSnap = await db.collection('config').doc('telegram').get();
    cfg = cfgSnap.exists ? (cfgSnap.data() || {}) : {};
  } catch (e) { console.warn('\u26A0\uFE0F  Could not read config/telegram:', e.message); }

  const sendTime = /^\d{1,2}:\d{2}$/.test(cfg.sendTime) ? cfg.sendTime : '06:00';
  const [sh, sm] = sendTime.split(':').map(n => parseInt(n, 10));
  const targetMin = (sh * 60) + sm;

  if (forced) {
    console.log('\uD83D\uDE80 Manual run (workflow_dispatch) — bypassing schedule gate.');
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

  console.log(`\uD83D\uDCC5 Sending plans for ${today}`);

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
      console.log(`  \uD83D\uDC8E Skipped (not Pro) → ${doc.id} chat:${tg.chatId}`);
      continue;
    }

    const digest = tg.digest || {};
    const plan   = digest[today];
    const aState = data.appState || {};
    const name   = (data.profile && data.profile.name)
                    ? data.profile.name.split(' ')[0]
                    : 'there';

    const built = buildMessage(name, aState, plan, today);
    if (!built.hasContent) noDigest++;

    try {
      /* v4: Send as animated cascade (multiple sequential messages) */
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
  console.log(`Done. Sent=${sent}  Skipped=${skipped}  SkippedFree=${skippedFree}  Failed=${failed}  NoDigest=${noDigest}`);

  if (noDigest > 0) {
    console.log(`ℹ️  ${noDigest} user(s) got fallback message — they haven't set up a study plan yet.`);
  }
  if (failed > 0) {
    console.log('\u26A0\uFE0F  Some sends failed — check the error lines above.');
    process.exit(1);
  }
}

main().catch(e => {
  console.error('❌ Fatal error:', e.message);
  process.exit(1);
});
