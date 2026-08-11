/*
 * PrepPath — shared helpers for the Telegram senders
 * ─────────────────────────────────────────────────────────────────────────────
 * Used by BOTH scripts/send-telegram.js (morning digest) and
 * scripts/send-telegram-evening.js (evening incomplete-tasks check-in), so the
 * two messages stay behaviourally consistent (same date math, same task/video
 * extraction, same Telegram error handling).
 *
 * v4 — Animated cascade style with sequential multi-message sends,
 * <tg-spoiler> interactive reveals, gradient emoji progress bars,
 * status indicators, and premium card-style formatting.
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

/** Current IST time as minutes-since-midnight (0-1439). */
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
    if (data.error_code === 403 || (data.error_code === 400 && desc.includes('chat not found'))) {
      throw Object.assign(new Error(desc), { skip: true });
    }
    throw new Error(`Telegram API error ${data.error_code}: ${desc}`);
  }
}

const _MONS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const _DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const _DAYS_SHORT = ['SUN','MON','TUE','WED','THU','FRI','SAT'];

/** "YYYY-MM-DD" -> "25 Jun" */
function fmtDM(ds) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ds || '')) return ds || '';
  const [y, m, d] = ds.split('-').map(Number);
  return `${d} ${_MONS[(m - 1) % 12]}`;
}

/** "YYYY-MM-DD" -> "Tuesday, 25 Jun" */
function fmtDMDay(ds) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ds || '')) return ds || '';
  const dt = new Date(ds + 'T12:00:00Z');
  const day = _DAYS[dt.getUTCDay()];
  return `${day}, ${fmtDM(ds)}`;
}

/** "YYYY-MM-DD" -> "WED 12" (short day code + date) for compact cards. */
function fmtShort(ds) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ds || '')) return ds || '';
  const dt = new Date(ds + 'T12:00:00Z');
  return `${_DAYS_SHORT[dt.getUTCDay()]} ${dt.getUTCDate()}`;
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

/* ================================================================
   VISUAL FORMATTING HELPERS (v4 — Animated Cascade Style)
   ================================================================ */

/** Fancy double-line box divider. */
function boxTop()    { return '\u2554' + '\u2550'.repeat(28) + '\u2557'; }
function boxBottom() { return '\u255A' + '\u2550'.repeat(28) + '\u255D'; }
function boxMid()    { return '\u2560' + '\u2500'.repeat(28) + '\u2563'; }
function hr()        { return '\u2500'.repeat(30); }

/** Thin elegant dot divider. */
function dotHr() { return '\u00B7 '.repeat(15).trim(); }

/** Star-sparkle divider for premium feel. */
function sparkleHr() { return '\u2728 \u00B7 \u00B7 \u00B7 \u00B7 \u00B7 \u00B7 \u00B7 \u00B7 \u00B7 \u00B7 \u00B7 \u00B7 \u00B7 \u2728'; }

/** Compact stat pill: returns HTML like <code> 5 tasks \u2502 2 done </code> */
function statPill(pending, done) {
  return `<code> ${pending + done} tasks \u2502 ${done} done </code>`;
}

/** Build a Unicode progress bar: [\u2588\u2588\u2588\u2591\u2591\u2591\u2591\u2591\u2591\u2591] 33% */
function progressBar(done, total, width) {
  if (width === undefined) width = 10;
  if (total === 0) return '<code>[\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500] 0%</code>';
  const pct = Math.round((done / total) * 100);
  const filled = Math.round((done / total) * width);
  const empty = width - filled;
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
  return `<code>[${bar}] ${pct}%</code>`;
}

/** Gradient emoji progress bar using colored squares.
 *  Returns something like: \uD83D\uDFE9\uD83D\uDFE9\uD83D\uDFE9\u2B1C\u2B1C\u2B1C\u2B1C\u2B1C 60%
 *  Green (done) -> White (remaining) — clean and universally supported. */
function gradientBar(done, total, width) {
  if (width === undefined) width = 8;
  if (total === 0) return `${'\u2B1C'.repeat(width)} 0%`;
  const pct = Math.round((done / total) * 100);
  const filled = Math.round((done / total) * width);
  const empty = width - filled;
  const green  = '\uD83D\uDFE9';
  const white  = '\u2B1C';
  /* Add a single yellow square at the boundary for a gradient transition feel */
  let bar = '';
  if (filled > 0) {
    if (pct >= 100) {
      bar += green.repeat(filled);
    } else if (filled === 1) {
      bar += green;
    } else {
      bar += green.repeat(filled - 1);
      bar += '\uD83D\uDFE8'; // yellow at edge
    }
  }
  bar += white.repeat(empty);
  return `${bar} <b>${pct}%</b>`;
}

/** Status dot emoji based on completion percentage. */
function statusDot(pct) {
  if (pct >= 100) return '\uD83D\uDFE2';  // green circle
  if (pct >= 50)  return '\uD83D\uDFE1';  // yellow circle
  if (pct >= 1)   return '\uD83D\uDD34';  // red circle
  return '\u26AB';                         // white circle
}

/** Emoji completion badge based on percentage. */
function completionBadge(pct) {
  if (pct >= 100) return '\u2B50';
  if (pct >= 75)  return '\u2728';
  if (pct >= 50)  return '\u26A1';
  if (pct >= 25)  return '\uD83D\uDD25';
  return '\uD83D\uDCA1';
}

/** Wrap text in Telegram spoiler tags — creates a blur-reveal effect.
 *  User must tap/click to reveal the hidden content. */
function spoiler(text) {
  return `<tg-spoiler>${text}</tg-spoiler>`;
}

/** Animated-style task bullet with status ring.
 *  Pending: \u25CB (white circle), Done: \u2705 (green check).
 *  Overdue gets a pulsing \u26A0\uFE0F badge. */
function taskBullet(isDone, isOverdue) {
  if (isDone) return '\u2705';
  if (isOverdue) return '\u26A0\uFE0F';
  return '\u25CB';
}

/** Subject emoji auto-detection from task/topic text. */
function subjectEmoji(text) {
  if (!text) return '';
  const t = text.toLowerCase();
  if (/polity|constitution|article|fundamental|dp|amendment|parliament|supreme court|high court| judiciary|pi|laxmikanth|magna carta|preamble/i.test(t)) return '\u2696\uFE0F';
  if (/geography|climate|map|river|mountain|ocean|soil|monsoon|latitud|longitude|earthquake|volcano/i.test(t)) return '\u1F30D';
  if (/math|calcul|number|algebra|geometry|trigon|profit|loss|percent|speed|time.*work|interest|simplif|averag|ratio|proportion|lcm|hcf|mensur/i.test(t)) return '\u1F9EE';
  if (/reason|syllog|coding|decod|seri|analog|blood relat|direc|dice|calendar|rank|puzzle|mirror|water/i.test(t)) return '\u1F9E0';
  if (/english|gram|vocab|comprehen|cloze|error|spot|fill|phras|idiom|synonym|antonym|passage|sentence/i.test(t)) return '\u1F4D6';
  if (/econom|budget|plan|gdp|inflat|tax|market|bank|rbi|sebi|supply|demand|niti|five year/i.test(t)) return '\u1F4B0';
  if (/histor|mughal|british|ancient|medieval|modern|freedom|independ|guerilla|dynasty|empire|sultanate|vijay/i.test(t)) return '\u1F3DB\uFE0F';
  if (/science|physics|chemistry|biolog|botan|zoolog|cell|atom|gravit|element|reaction|geneti|evolut|digest/i.test(t)) return '\u1F52C';
  if (/current affair|news|event|award|appointment|sport|summit|index|report|committee|mission|scheme|yojana/i.test(t)) return '\u1F4F0';
  if (/gk|general know|static|national|capital|currenc|symbol|festival|dance|river/i.test(t)) return '\u2753';
  if (/essay|writ|letter|pr\u00e9cis|comprehension|draft/i.test(t)) return '\u270D\uFE0F';
  if (/mock|test|practice|solve|attempt|question|quiz|mcq|previous year|pyq/i.test(t)) return '\u1F4DD';
  if (/revision|revise|review|re-read|doobara/i.test(t)) return '\u1F504';
  if (/video|lecture|watch|see|youtube|class/i.test(t)) return '\u1F3AC';
  if (/di|data interpret|chart|graph|table/i.test(t)) return '\u1F4CA';
  if (/current af|ca/i.test(t)) return '\u1F4F0';
  return '\u27A4'; // default arrow bullet
}

/** Build a styled section header with left bar effect.
 *  e.g. "\u2502 \uD83D\uDCDA  STUDY PLAN" */
function sectionHeader(emoji, title) {
  return `<b>${emoji}  ${title.toUpperCase()}</b>`;
}

/** Small decorative label pill: \u2502 \uD83D\uDCCB LABEL \u2502 */
function labelPill(emoji, text) {
  return `<code>\u2502 ${emoji} ${text} \u2502</code>`;
}

/** Random motivational study quote (Hinglish, rotated daily by date hash). */
function dailyQuote(dateStr) {
  const quotes = [
    'Koshish karne walon ki haar nahi hoti \u2014 Shah Rukh Khan',
    'Padhai ka koi shortcut nahi, consistency hi sabse bada weapon hai.',
    'Aaj ka 1 hour = kal ka confidence.',
    'Agar aaj nahi karoge toh kab? Start now, perfect later.',
    'Small daily improvements lead to staggering long-term results.',
    'Discipline > Motivation. Motivation aati jaati hai, discipline rehti hai.',
    'Exam sirf ek din ka hai, preparation har din ka hai.',
    'Jo padhai aaj lagti hai boring, wo kal ban jaati hai interesting.',
    'Success is the sum of small efforts, repeated day in and day out.',
    'Apne pace pe chalo, par ruko mat.',
    'Every expert was once a beginner. Keep going!',
    'Thoda thoda karo, par roz karo. Steady wins the race.',
    'Mushkil questions se daro mat \u2014 wo tumhe strong banate hain.',
    'Revision is the mother of memory. Doobara padho, doobara strong ho.',
    'Consistency beats intensity. Roz thoda > ek din bahut.',
    'Your only competition is yesterday\u2019s you.',
    'Padhai mein focus > hours. 2 hours of deep study > 6 hours of scrolling.',
  'The expert in anything was once a beginner. Keep showing up!',
  'Mehnat invisible hoti hai jab result aata hai \u2014 tab sab dekhte hain.',
    'Abhi padho, result khud aayega. Trust the process.',
  ];
  let hash = 0;
  for (let i = 0; i < (dateStr || '').length; i++) {
    hash = ((hash << 5) - hash + dateStr.charCodeAt(i)) | 0;
  }
  return quotes[Math.abs(hash) % quotes.length];
}

/** Evening-specific encouragement based on completion percentage. */
function eveningEncouragement(done, total) {
  if (total === 0) return '';
  const pct = Math.round((done / total) * 100);
  if (pct === 100) return '\u2728 Sab ho gaya! Aaj ka target complete. Relax karo, kal naya energy ke saath aao!';
  if (pct >= 75)  return '\u1F4AA Almost there! Bas thoda aur, tum kar sakte ho!';
  if (pct >= 50)  return '\u26A1 Half done! Ab speed badhao, finish strong!';
  if (pct >= 25)  return '\u1F525 Good start! Ab aur push karo, target achieve karo!';
  return '\u1F4A1 Abhi start karo! Ek task complete karo, momentum aa jayega.';
}

/** Count total today tasks (done + pending, excluding videos) for progress calc. */
function todayTotalTasks(appState, today) {
  const tasks = (appState && appState.tasks) || {};
  const todayList = Array.isArray(tasks[today]) ? tasks[today] : [];
  return todayList.filter(t => t && !isTaskDeleted(appState, t) && t.type !== 'video').length;
}

/** Build a mini stat card line like: "\u2705 2 done  \u25CB 3 left  \u26A0\uFE0F 1 overdue"
 *  Returns empty string if nothing to show. */
function miniStats(doneCount, todayPending, overdueCount) {
  const parts = [];
  if (doneCount > 0)     parts.push(`\u2705 ${doneCount} done`);
  if (todayPending > 0)   parts.push(`\u25CB ${todayPending} left`);
  if (overdueCount > 0)   parts.push(`\u26A0\uFE0F ${overdueCount} overdue`);
  return parts.length ? '<code>' + parts.join('  \u2502  ') + '</code>' : '';
}

/* ================================================================
   ORIGINAL LOGIC HELPERS (unchanged)
   ================================================================ */

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

function isTaskDeleted(appState, task) {
  const led = (appState && Array.isArray(appState.deletedTaskKeys)) ? appState.deletedTaskKeys : [];
  if (!led.length) return false;
  const key = taskDedupKey(task);
  if (!!key && led.includes(key)) return true;
  if (task && task.chId) return led.includes('ch:' + String(task.chId));
  return false;
}

function rolloverLabel(fromDate, today) {
  if (fromDate === shiftDate(today, -1)) return 'from yesterday';
  return 'from earlier \u00b7 ' + fmtDM(fromDate);
}

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
   - Hides completed tasks (shows a count instead).
   - Folds in incomplete tasks from the past 14 days (rollover preview).
   - Video tasks go to the Videos section as clickable links.
   - v3: Returns { line, overdue, rawText } for subject-emoji support.
   - rawText is the unescaped original text for subjectEmoji() detection. */
function buildTaskSections(appState, today) {
  const tasks = (appState && appState.tasks) || {};
  const todayList = Array.isArray(tasks[today]) ? tasks[today] : [];
  const isDone = t => t && (t.done === true || t.status === 'done');
  const norm = s => String(s || '').trim().toLowerCase();
  const lookbackStart = shiftDate(today, -14);

  const todoLines = [];          // { line, overdue?, rawText }
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
    if (isTaskDeleted(appState, t)) return;
    if (t.type === 'video' && t.videoId) { pushVideo(t.videoId, t.text, t.url); return; }
    const txt = norm(t.text);
    if (txt) seenText.add(txt);
    const from = (t.rolledFrom && t.rolledFrom < today) ? t.rolledFrom
               : (t.originalDate && t.originalDate < today) ? t.originalDate : null;
    const raw = t.text || 'Task';
    if (from) {
      todoLines.push({ line: `${subjectEmoji(raw)} ${escHtml(raw)}  <i>\u26A0\uFE0F ${rolloverLabel(from, today)}</i>`, overdue: true, rawText: raw });
    } else {
      const tgBadge = t.fromTelegram ? ' \uD83D\uDCE8' : '';
      todoLines.push({ line: `\u25CB ${escHtml(raw)}${tgBadge}`, overdue: false, rawText: raw });
    }
  });

  /* 2. Past incomplete tasks not yet physically rolled (preview) */
  Object.keys(tasks).forEach(ds => {
    if (ds >= today || ds < lookbackStart) return;
    (Array.isArray(tasks[ds]) ? tasks[ds] : []).forEach(t => {
      if (!t || isDone(t)) return;
      if (isTaskDeleted(appState, t)) return;
      if (t.type === 'video' && t.videoId) { pushVideo(t.videoId, t.text, t.url); return; }
      const txt = norm(t.text);
      if (!txt || seenText.has(txt)) return;
      seenText.add(txt);
      const fromDate = (t.originalDate && t.originalDate < today) ? t.originalDate : ds;
      const raw = t.text || 'Task';
      todoLines.push({ line: `${subjectEmoji(raw)} ${escHtml(raw)}  <i>\u26A0\uFE0F ${rolloverLabel(fromDate, today)}</i>`, overdue: true, rawText: raw });
    });
  });

  /* 3. Course auto-scheduled videos */
  scheduledCourseVideos(appState, today).forEach(v => {
    if (isTaskDeleted(appState, { videoId: v.id })) return;
    pushVideo(v.id, v.title);
  });

  return { todoLines, videoItems, doneCount };
}

/** Join a section list with a "+N more" cap.
 *  Handles both plain strings and { line, ... } objects (backward compat). */
function capLines(lines, max) {
  if (!lines || !lines.length) return '';
  const strs = typeof lines[0] === 'object' && lines[0] !== null && lines[0].line !== undefined
    ? lines.map(o => o.line) : lines;
  if (strs.length <= max) return strs.join('\n');
  return strs.slice(0, max).join('\n') + `\n\u2026+${strs.length - max} more`;
}

/** Join lines from { line, overdue } objects, with cap. */
function capTaskLines(taskObjs, max) {
  const lines = taskObjs.map(o => o.line);
  if (lines.length <= max) return lines.join('\n');
  return lines.slice(0, max).join('\n') + `\n\u2026+${lines.length - max} more`;
}

/* ================================================================
   SEQUENTIAL MESSAGE SENDER (v4 — Animated Cascade)
   ================================================================ */

/** Send multiple Telegram messages sequentially with a delay between each.
 *  Creates a "cascade" animation effect as messages pop in one by one.
 *  Each message in the array is a plain text string (HTML parse mode).
 *  Delay defaults to 1200ms between messages.
 *  Throws with .skip = true for blocked/bad chat (same as sendTelegramMessage). */
async function sendSequentialMessages(botToken, chatId, messages, delayMs) {
  if (delayMs === undefined) delayMs = 1200;
  for (let i = 0; i < messages.length; i++) {
    if (i > 0) await sleep(delayMs);
    await sendTelegramMessage(botToken, chatId, messages[i]);
  }
}

/** Promise-based sleep helper. */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  todayIST, istMinutesNow, istClockNow,
  sendTelegramMessage, sendSequentialMessages,
  fmtDM, fmtDMDay, fmtShort, shiftDate, escHtml, rolloverLabel, capLines, capTaskLines,
  scheduledCourseVideos, buildTaskSections,
  taskDedupKey, isTaskDeleted,
  progressBar, gradientBar, hr, dotHr, sparkleHr, dailyQuote, eveningEncouragement, todayTotalTasks,
  boxTop, boxBottom, boxMid,
  subjectEmoji, sectionHeader, completionBadge, miniStats, statPill,
  statusDot, spoiler, taskBullet, labelPill, sleep,
};
