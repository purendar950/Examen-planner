/*
 * PrepPath — shared helpers for the Telegram senders
 * ─────────────────────────────────────────────────────────────────────────────
 * Used by BOTH scripts/send-telegram.js (morning digest) and
 * scripts/send-telegram-evening.js (evening incomplete-tasks check-in), so the
 * two messages stay behaviourally consistent (same date math, same task/video
 * extraction, same Telegram error handling). Pulled out of send-telegram.js
 * unchanged — no logic was altered in the move.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/* `fetch` is deliberately the Node built-in (18+) rather than node-fetch. The
   pure helpers below — date math, escaping, task and video extraction — are the
   only server-side copy of that logic, and bot/bot-server.js needs them too. A
   top-level `require('node-fetch')` made this file unloadable there, because
   bot/package.json does not carry that dependency; the bot would have had to
   duplicate the logic instead. Both GitHub Actions senders run Node 20, so the
   built-in is available everywhere this module is used. */

/** Today's date string in IST (YYYY-MM-DD). */
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

/** Send a message via Telegram Bot API. Throws on API error (throws with
 *  `.skip = true` for a blocked bot / bad chat id, so callers can tell that
 *  apart from a real failure). */
async function sendTelegramMessage(botToken, chatId, text) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
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

const _MONS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** "YYYY-MM-DD" → "25 Jun" */
function fmtDM(ds) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ds || '')) return ds || '';
  const [y, m, d] = ds.split('-').map(Number);
  return `${d} ${_MONS[(m - 1) % 12]}`;
}

/** Shift an ISO date string by N days. */
function shiftDate(ds, n) {
  const dt = new Date(ds + 'T12:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* Server-side port of the app's taskDedupKey() (js/tabs/plan-wizard.js): builds
   the same {chId|videoId|text} signature so the sender can honour the deleted-
   task tombstone ledger (appState.deletedTaskKeys) and NOT re-surface a task the
   user deleted. Must stay byte-for-byte in sync with the browser version. */
function taskDedupKey(t) {
  if (!t) return '';
  if (t.chId) {
    const partIndex = Number(t.planPartIndex) || 0;
    const totalParts = Math.max(1, Number(t.planTotalParts) || 1);
    if (partIndex >= 1 && totalParts > 1 && partIndex <= totalParts) {
      const planPrefix = t.planId ? `plan:${String(t.planId)}:` : '';
      return `${planPrefix}ch:${String(t.chId)}:part:${partIndex}/${totalParts}`;
    }
    return 'ch:' + String(t.chId);
  }
  if (t.videoId) return 'vid:' + String(t.videoId);
  const txt = (t.text || '').trim().toLowerCase();
  return txt ? 'txt:' + txt : '';
}

/* True when a task's signature was tombstoned (deleted by the user). Reads the
   persisted appState.deletedTaskKeys ledger that the browser writes to Firestore. */
function isTaskDeleted(appState, task) {
  const led = (appState && Array.isArray(appState.deletedTaskKeys)) ? appState.deletedTaskKeys : [];
  if (!led.length) return false;
  const key = taskDedupKey(task);
  if (!!key && led.includes(key)) return true;
  /* Honor broad chapter tombstones written by older app versions. */
  if (task && task.chId) return led.includes('ch:' + String(task.chId));
  return false;
}

/** Label a rolled-forward / overdue task: "from yesterday" or "from earlier · 22 Jun". */
function rolloverLabel(fromDate, today) {
  if (fromDate === shiftDate(today, -1)) return 'from yesterday';
  return 'from earlier · ' + fmtDM(fromDate);
}

/* Port of the app's getScheduledVideosForDate() — the auto-scheduled course
   videos for "today" from any YouTube Organiser course that has a study plan. */
function scheduledCourseVideos(appState, today) {
  const lib = (appState && appState.ytoLibrary) || {};
  const out = [];
  Object.keys(lib).forEach(plId => {
    const pl = lib[plId];
    if (!pl || !pl.plan || !Array.isArray(pl.videos)) return;
    if (pl.plan.targetDate && today > pl.plan.targetDate) return;
    const watched = pl.watched || {};
    const pending = pl.videos.filter(v => v && !watched[v.id]).slice().sort((a, b) => {
      const ta = a.pub ? new Date(a.pub).getTime() : null;
      const tb = b.pub ? new Date(b.pub).getTime() : null;
      if (ta === null || tb === null) return 0;
      return ta - tb;
    });
    if (!pending.length) return;
    const budget = (pl.plan.hoursPerDay || 1) * 3600;
    let used = 0;
    for (const v of pending) {
      const dur = v.dur || 600;
      if (used > 0 && used + dur > budget) break;
      out.push({ id: v.id, title: v.title || 'Video' });
      used += dur;
      if (used >= budget) break;
    }
  });
  return out;
}

/* Build the To-Do + Videos sections for today's message from appState.tasks.
   - Hides completed tasks (shows a "✅ N done" count instead).
   - Folds in incomplete tasks from the past 14 days (rollover preview) with a
     "from yesterday/earlier" label — accurate even if the browser rollover
     hasn't run yet.
   - Video tasks + Telegram YouTube links + course auto-scheduled videos go to
     the Videos section as clickable links (de-duplicated by videoId). */
function buildTaskSections(appState, today) {
  const tasks = (appState && appState.tasks) || {};
  const todayList = Array.isArray(tasks[today]) ? tasks[today] : [];
  const isDone = t => t && (t.done === true || t.status === 'done');
  const norm = s => String(s || '').trim().toLowerCase();
  const lookbackStart = shiftDate(today, -14);

  const todoLines = [];          // { line }
  const videoItems = [];         // { title, url }
  const seenVideo = new Set();
  const seenText = new Set();
  let doneCount = 0;

  const pushVideo = (videoId, title, url) => {
    if (!videoId || seenVideo.has(videoId)) return;
    seenVideo.add(videoId);
    videoItems.push({ title: title || 'Video', url: url || ('https://www.youtube.com/watch?v=' + videoId) });
  };

  /* 1. Today's tasks */
  todayList.forEach(t => {
    if (!t) return;
    if (isDone(t)) { doneCount++; return; }
    if (isTaskDeleted(appState, t)) return;   // user deleted it — don't re-surface
    if (t.type === 'video' && t.videoId) { pushVideo(t.videoId, t.text, t.url); return; }
    const txt = norm(t.text);
    if (txt) seenText.add(txt);
    const from = (t.rolledFrom && t.rolledFrom < today) ? t.rolledFrom
               : (t.originalDate && t.originalDate < today) ? t.originalDate : null;
    if (from) {
      todoLines.push('• ⏳ ' + escHtml(t.text || 'Task') + ' (' + rolloverLabel(from, today) + ')');
    } else {
      todoLines.push('• ' + escHtml(t.text || 'Task') + (t.fromTelegram ? ' 📩' : ''));
    }
  });

  /* 2. Past incomplete tasks not yet physically rolled (preview) */
  Object.keys(tasks).forEach(ds => {
    if (ds >= today || ds < lookbackStart) return;
    (Array.isArray(tasks[ds]) ? tasks[ds] : []).forEach(t => {
      if (!t || isDone(t)) return;
      if (isTaskDeleted(appState, t)) return;   // user deleted it — don't re-surface
      if (t.type === 'video' && t.videoId) { pushVideo(t.videoId, t.text, t.url); return; }
      const txt = norm(t.text);
      if (!txt || seenText.has(txt)) return;
      seenText.add(txt);
      const fromDate = (t.originalDate && t.originalDate < today) ? t.originalDate : ds;
      todoLines.push('• ⏳ ' + escHtml(t.text || 'Task') + ' (' + rolloverLabel(fromDate, today) + ')');
    });
  });

  /* 3. Course auto-scheduled videos */
  scheduledCourseVideos(appState, today).forEach(v => {
    if (isTaskDeleted(appState, { videoId: v.id })) return;   // user deleted this video task
    pushVideo(v.id, v.title);
  });

  return { todoLines, videoItems, doneCount };
}

module.exports = {
  todayIST, istMinutesNow, istClockNow,
  sendTelegramMessage,
  fmtDM, shiftDate, escHtml, rolloverLabel, capLines,
  scheduledCourseVideos, buildTaskSections,
  taskDedupKey, isTaskDeleted,
};

/** Join a section list with a "+N more" cap to respect Telegram's size limit. */
function capLines(lines, max) {
  if (lines.length <= max) return lines.join('\n');
  return lines.slice(0, max).join('\n') + `\n…+${lines.length - max} more`;
}
