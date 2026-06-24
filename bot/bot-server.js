/**
 * StudyPlanner Telegram Bot Server
 * ─────────────────────────────────────────────────────────────────────────────
 * What it does (long-polling):
 *   /start  /id  /help        → reply with the user's Telegram Chat ID + help
 *   /task  /add  /plan <text> → add task(s) to the user's planner
 *   /list  /today             → show today's planner tasks
 *   <any plain text>          → treated as a task and auto-scheduled in the planner
 *
 * Inbound tasks are written straight into Firestore at
 *   users/{uid}.appState.tasks['YYYY-MM-DD']
 * which is the exact same store the web planner reads — so the moment the user
 * opens the app, the task is already scheduled. We also merge the task into the
 * Telegram daily digest for that date so the morning message reflects it.
 *
 * Natural-language dates are supported (prefix OR suffix of the message):
 *   today / aaj, tomorrow / kal / tmrw, day after tomorrow / parso,
 *   weekday names (mon..sun), ISO dates (2026-06-25), "25 Jun".
 * Multiple tasks: send each on its own line.
 * Priority: end a line with "!" or include #high / #urgent / #important.
 *
 * HTTP routes (unchanged):
 *   GET  /     → health check
 *   POST /send → proxy: sends a Telegram message server-side (CORS-safe)
 *
 * Deploy on Render (Web Service):
 *   Root directory: bot
 *   Build:          npm install
 *   Start:          node bot-server.js
 *   Env vars:       TELEGRAM_BOT_TOKEN          (required)
 *                   FIREBASE_SERVICE_ACCOUNT    (required for task auto-scheduling)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const TelegramBot = require('node-telegram-bot-api');
const http        = require('http');
const https       = require('https');
const { aiParse, SUPPORTED_MODELS, DEFAULT_MODEL } = require('./ai');
const { subjectPromptList, resolveSubjectId }       = require('./exam-subjects');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN env var missing. Set it in Render dashboard.');
  process.exit(1);
}

/* ── Firebase Admin (optional) ────────────────────────────────────────────
   Needed so the bot can map a Telegram chat → app user and write tasks into
   their planner. If the service account is not provided, the bot still works
   for chat-ID replies; task scheduling is simply disabled with a clear notice. */
let admin = null;
let db    = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    admin = require('firebase-admin');
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!svc.project_id || !svc.private_key) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT JSON is incomplete (missing project_id / private_key).');
    }
    admin.initializeApp({ credential: admin.credential.cert(svc) });
    db = admin.firestore();
    console.log(`✅ Firebase Admin connected (${svc.project_id}) — task auto-scheduling ENABLED`);
  } else {
    console.warn('⚠️  FIREBASE_SERVICE_ACCOUNT not set — task auto-scheduling DISABLED (chat-ID replies still work).');
  }
} catch (e) {
  console.error('❌ Firebase Admin init failed:', e.message, '— task auto-scheduling disabled.');
  admin = null;
  db    = null;
}

const bot = new TelegramBot(TOKEN, { polling: true });
console.log('🤖 StudyPlanner Bot running (long-polling)...');

/* ── AI (Groq) config, read from Firestore config/ai (admin-managed) ──────
   Cached for 2 min so we don't hit Firestore on every message. The admin
   panel writes { groqApiKey, model, enabled } to this doc. */
let _aiCache = { value: null, ts: 0 };
async function getAiConfig() {
  if (!db) return { enabled: false };
  const now = Date.now();
  if (_aiCache.value && (now - _aiCache.ts) < 120000) return _aiCache.value;
  try {
    const snap = await db.collection('config').doc('ai').get();
    const d = snap.exists ? (snap.data() || {}) : {};
    const cfg = {
      enabled: d.enabled !== false && !!d.groqApiKey, // enabled unless explicitly off
      apiKey:  d.groqApiKey || '',
      model:   d.model || DEFAULT_MODEL,
    };
    _aiCache = { value: cfg, ts: now };
    return cfg;
  } catch (e) {
    console.warn('⚠️  getAiConfig failed:', e.message);
    return { enabled: false };
  }
}

/* ════════════════════════════════════════════════════════════════════════
   DATE + TASK PARSING HELPERS
   ════════════════════════════════════════════════════════════════════════ */

/** "now" shifted into IST so getUTC* methods read as IST wall-clock. */
function istNow() {
  return new Date(Date.now() + (5 * 60 + 30) * 60000);
}
function fmtDateUTC(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}
/** Today's IST date (+offset days) as 'YYYY-MM-DD'. */
function istDateStr(offsetDays) {
  const d = istNow();
  d.setUTCDate(d.getUTCDate() + (offsetDays || 0));
  return fmtDateUTC(d);
}

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
const WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** Next future occurrence of a weekday (same weekday → next week). */
function nextWeekdayStr(targetDow) {
  const d = istNow();
  const cur = d.getUTCDay();
  let diff = (targetDow - cur + 7) % 7;
  if (diff === 0) diff = 7;
  d.setUTCDate(d.getUTCDate() + diff);
  return fmtDateUTC(d);
}

/** "25 jun" / "5 january" → next such date (this year, or next year if past). */
function dayMonthStr(day, monthIdx) {
  const now = istNow();
  let year = now.getUTCFullYear();
  let candidate = fmtDateUTC(new Date(Date.UTC(year, monthIdx, day)));
  if (candidate < istDateStr(0)) {
    candidate = fmtDateUTC(new Date(Date.UTC(year + 1, monthIdx, day)));
  }
  return candidate;
}

/** Human label for a confirmation message. */
function dateLabel(dateStr) {
  if (dateStr === istDateStr(0)) return 'today';
  if (dateStr === istDateStr(1)) return 'tomorrow';
  if (dateStr === istDateStr(2)) return 'day after tomorrow';
  const d = new Date(dateStr + 'T12:00:00Z');
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[d.getUTCDay()]}, ${mons[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** Full weekday name for today's IST date (for the AI prompt context). */
function weekdayNameToday() {
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return names[istNow().getUTCDay()];
}

/** Extract the first YouTube URL from a string, or '' if none. */
function extractYouTubeUrl(text) {
  const m = String(text || '').match(/https?:\/\/(?:www\.)?(?:youtube\.com\/\S+|youtu\.be\/\S+)/i);
  return m ? m[0] : '';
}

/* The "core" regex fragments for date expressions and how to resolve them. */
const DATE_MATCHERS = [
  { core: 'day\\s*after\\s*tomorrow|parso', resolve: () => istDateStr(2) },
  { core: 'tomorrow|tmrw|tom|kal',          resolve: () => istDateStr(1) },
  { core: 'today|aaj',                      resolve: () => istDateStr(0) },
  { core: '\\d{4}-\\d{2}-\\d{2}',           resolve: (m) => m[0] },
  {
    core: '\\d{1,2}\\s*(?:st|nd|rd|th)?\\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*',
    resolve: (m) => {
      const dm = m[0].match(/(\d{1,2})\s*(?:st|nd|rd|th)?\s*([a-z]{3})/i);
      if (!dm) return null;
      const mon = MONTHS[dm[2].toLowerCase()];
      if (mon === undefined) return null;
      return dayMonthStr(parseInt(dm[1], 10), mon);
    },
  },
  {
    core: '(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*',
    resolve: (m) => {
      const key = m[0].slice(0, 3).toLowerCase();
      const dow = WEEKDAYS[key];
      return dow === undefined ? null : nextWeekdayStr(dow);
    },
  },
];

/**
 * Pull a date expression off the front OR back of the text.
 * Returns { dateStr, label, rest }. Defaults to today when none is found.
 */
function resolveDate(raw) {
  let text = (raw || '').trim();
  for (const matcher of DATE_MATCHERS) {
    const prefix = new RegExp('^(?:' + matcher.core + ')\\b[\\s:,\\-]*', 'i');
    const suffix = new RegExp('[\\s:,\\-]+(?:' + matcher.core + ')\\s*$', 'i');

    let m = text.match(prefix);
    if (m) {
      const ds = matcher.resolve(text.match(new RegExp('^(?:' + matcher.core + ')', 'i')));
      if (ds) return { dateStr: ds, label: dateLabel(ds), rest: text.slice(m[0].length).trim() };
    }
    m = text.match(suffix);
    if (m) {
      const ds = matcher.resolve(text.match(new RegExp('(?:' + matcher.core + ')\\s*$', 'i')));
      if (ds) return { dateStr: ds, label: dateLabel(ds), rest: text.slice(0, m.index).trim() };
    }
  }
  return { dateStr: istDateStr(0), label: 'today', rest: text };
}

/** Detect priority markers in a single task line and strip them out. */
function parsePriority(line) {
  let text = (line || '').trim();
  let priority = 'normal';
  if (/!{1,}\s*$/.test(text) || /#(?:high|urgent|important)\b/i.test(text)
      || /\b(?:urgent|important|high\s*priority)\b/i.test(text)) {
    priority = 'high';
  }
  text = text.replace(/#(?:high|urgent|important)\b/ig, '')
             .replace(/!+\s*$/, '')
             .replace(/^[•\-\*\d\.\)\s]+/, '') // strip bullet/number prefixes
             .trim();
  return { text, priority };
}

/* ════════════════════════════════════════════════════════════════════════
   FIRESTORE: find user by chat ID + write tasks
   ════════════════════════════════════════════════════════════════════════ */

/** Find the app user who saved this Telegram chat ID. */
async function findUserByChatId(chatId) {
  if (!db) return null;
  const cid = String(chatId);
  const snap = await db.collection('users')
    .where('appState.telegram.chatId', '==', cid)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { uid: doc.id, ref: doc.ref, data: doc.data() || {} };
}

/**
 * Add task lines to a user's planner for dateStr.
 * Returns the array of task texts that were actually added (deduped).
 */
async function addTasksToPlanner(user, dateStr, lines) {
  const appState = user.data.appState || {};
  const tasks    = appState.tasks || {};
  const dayList  = Array.isArray(tasks[dateStr]) ? tasks[dateStr].slice() : [];
  const existing = new Set(dayList.map(t => (t.text || '').toLowerCase()));

  const addedTexts = [];
  lines.forEach((line) => {
    const { text, priority } = parsePriority(line);
    if (!text || existing.has(text.toLowerCase())) return;
    dayList.push({
      id:       Date.now().toString() + Math.floor(Math.random() * 100000),
      text,
      done:     false,
      priority,
      subject:  '',
      source:   'telegram',
    });
    existing.add(text.toLowerCase());
    addedTexts.push(text);
  });

  if (!addedTexts.length) return [];

  /* Merge the new tasks into the daily digest for that date so the morning
     message reflects them too. The browser may rebuild the digest later, but
     buildTelegramDigest now also includes manual tasks, so they survive. */
  const tg        = appState.telegram || {};
  const digestMap = tg.digest || {};
  const prev      = digestMap[dateStr] ? digestMap[dateStr] + '\n' : '';
  const digestText = prev + addedTexts.map(t => '📝 ' + t).join('\n');

  const tasksPath  = new admin.firestore.FieldPath('appState', 'tasks', dateStr);
  const digestPath = new admin.firestore.FieldPath('appState', 'telegram', 'digest', dateStr);

  try {
    await user.ref.update(tasksPath, dayList, digestPath, digestText);
  } catch (e) {
    /* If the combined update fails (e.g. telegram map missing), at least save
       the tasks — that's the part that matters for scheduling. */
    console.warn(`⚠️  digest merge failed for ${user.uid}: ${e.message} — saving tasks only.`);
    await user.ref.update(tasksPath, dayList);
  }
  return addedTexts;
}

/** Read today's planner tasks for a user (for /list). */
function getTodaysTasks(user) {
  const appState = user.data.appState || {};
  const tasks    = appState.tasks || {};
  return tasks[istDateStr(0)] || [];
}

/**
 * Write a list of AI-produced intents into the user's planner. Intents may span
 * multiple dates. Each becomes a task { text, done, priority, subject, type, url }.
 * Returns [{ date, label, text, type }] for the ones actually added (deduped).
 */
async function addIntentsToPlanner(user, intents, examId) {
  const appState = user.data.appState || {};
  const tasksMap = appState.tasks || {};

  // Group intents by date and build the updated day lists.
  const touched = {};   // dateStr -> updated array
  const added   = [];   // summary rows

  intents.forEach((it) => {
    const dateStr = it.date;
    if (!touched[dateStr]) {
      touched[dateStr] = Array.isArray(tasksMap[dateStr]) ? tasksMap[dateStr].slice() : [];
    }
    const dayList  = touched[dateStr];
    const existing = new Set(dayList.map(t => (t.text || '').toLowerCase()));

    const text = (it.text || '').trim();
    if (!text || existing.has(text.toLowerCase())) return;

    const isVideo = it.action === 'add_video';
    const task = {
      id:       Date.now().toString() + Math.floor(Math.random() * 100000),
      text,
      done:     false,
      priority: it.priority === 'high' ? 'high' : 'normal',
      subject:  resolveSubjectId(examId, it.subject),
      type:     isVideo ? 'video' : 'study',
      source:   'telegram',
    };
    if (isVideo && it.url) task.url = it.url;

    dayList.push(task);
    added.push({ date: dateStr, label: dateLabel(dateStr), text, type: task.type });
  });

  if (!added.length) return [];

  // Build one update per touched date (tasks + merged digest).
  const tg        = appState.telegram || {};
  const digestMap = tg.digest || {};

  for (const dateStr of Object.keys(touched)) {
    const newRows = added.filter(a => a.date === dateStr)
      .map(a => (a.type === 'video' ? '🎥 ' : '📝 ') + a.text);
    const prev = digestMap[dateStr] ? digestMap[dateStr] + '\n' : '';
    const digestText = prev + newRows.join('\n');

    const tasksPath  = new admin.firestore.FieldPath('appState', 'tasks', dateStr);
    const digestPath = new admin.firestore.FieldPath('appState', 'telegram', 'digest', dateStr);
    try {
      await user.ref.update(tasksPath, touched[dateStr], digestPath, digestText);
    } catch (e) {
      console.warn(`⚠️  digest merge failed for ${user.uid} (${dateStr}): ${e.message} — saving tasks only.`);
      await user.ref.update(tasksPath, touched[dateStr]);
    }
  }
  return added;
}

/* ════════════════════════════════════════════════════════════════════════
   MESSAGE HANDLERS
   ════════════════════════════════════════════════════════════════════════ */

function send(chatId, text, extra) {
  return bot.sendMessage(chatId, text, Object.assign({ parse_mode: 'HTML', disable_web_page_preview: true }, extra || {}))
            .catch(err => console.error(`❌ sendMessage error for ${chatId}:`, err.message));
}

const NOT_CONNECTED_MSG =
  '🔗 <b>Pehle apna account connect karo.</b>\n\n' +
  'Bot ko tumhari ID nahi pata. App kholo → <b>Profile → Daily Plan on Telegram</b> ' +
  'mein apna Chat ID daalo, toggle ON karo, Save karo. Phir yahan task bhejo aur woh ' +
  'apne aap planner mein add ho jayega! 📅';

/** Shared logic: take a chunk of text, parse date + tasks, write to planner. */
async function handleTaskMessage(msg, rawText) {
  const chatId = msg.chat.id;

  if (!db) {
    return send(chatId,
      '⚠️ Task scheduling abhi available nahi hai (server config pending). ' +
      'Filhaal app kholke Planner mein task add karo.');
  }

  let user;
  try {
    user = await findUserByChatId(chatId);
  } catch (e) {
    console.error('findUserByChatId error:', e.message);
    return send(chatId, '⚠️ Thodi dikkat aa gayi. Thodi der baad try karo.');
  }
  if (!user) return send(chatId, NOT_CONNECTED_MSG);

  const examId = (user.data.appState && user.data.appState.selectedExam) || 'cgl';

  /* ── 1) Try the AI path (Groq) — understands subject, dates, videos ── */
  const aiCfg = await getAiConfig();
  if (aiCfg.enabled && aiCfg.apiKey) {
    try {
      const parsed = await aiParse(rawText, aiCfg, {
        todayIST:     istDateStr(0),
        weekdayIST:   weekdayNameToday(),
        examName:     examId.toUpperCase(),
        subjectList:  subjectPromptList(examId),
        fallbackDate: istDateStr(0),
      });
      if (parsed.intents && parsed.intents.length) {
        const added = await addIntentsToPlanner(user, parsed.intents, examId);
        if (!added.length) {
          return send(chatId, 'ℹ️ Yeh task(s) planner mein pehle se hain.');
        }
        return send(chatId, formatAddedSummary(added, parsed.reply));
      }
      // AI understood nothing actionable — fall through to regex.
    } catch (e) {
      console.warn(`⚠️  AI parse failed (${e.message}) — falling back to regex parser.`);
    }
  }

  /* ── 2) Fallback: regex date/priority parser (also detects YouTube links) ── */
  const { dateStr, label, rest } = resolveDate(rawText);
  const ytUrl = extractYouTubeUrl(rest);
  if (ytUrl) {
    const title = rest.replace(ytUrl, '').replace(/[:\-–]\s*$/, '').trim() || 'Watch video';
    const added = await addIntentsToPlanner(user,
      [{ action: 'add_video', date: dateStr, text: 'Watch: ' + title, priority: 'normal', subject: '', url: ytUrl }],
      examId);
    if (!added.length) return send(chatId, `ℹ️ Yeh video <b>${label}</b> ke liye pehle se hai.`);
    return send(chatId, formatAddedSummary(added));
  }

  const lines = rest.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) {
    return send(chatId,
      '✍️ Mujhe task bhejo, main planner mein daal dunga.\n\n' +
      'Example:\n<code>Revise Polity Ch 3</code>\n' +
      '<code>kal: Solve 50 maths Qs</code>\n' +
      '<code>monday Mock test attempt</code>');
  }

  let added;
  try {
    added = await addTasksToPlanner(user, dateStr, lines);
  } catch (e) {
    console.error(`addTasksToPlanner error for ${user.uid}:`, e.message);
    return send(chatId, '⚠️ Task save nahi ho paya. Thodi der baad try karo.');
  }

  if (!added.length) {
    return send(chatId, `ℹ️ Yeh task(s) <b>${label}</b> ke liye pehle se planner mein hain.`);
  }

  const list = added.map(t => '• ' + escapeHtml(t)).join('\n');
  console.log(`📝 Added ${added.length} task(s) for ${user.uid} on ${dateStr}`);
  return send(chatId,
    `✅ <b>${added.length} task${added.length > 1 ? 's' : ''}</b> planner mein add ho gaye — <b>${label}</b> (${dateStr}):\n\n` +
    `${list}\n\n📲 App kholo to dekho — Planner → ${label === 'today' ? 'Aaj' : label}.`);
}

/** Build a confirmation message from structured added-rows. */
function formatAddedSummary(added, aiReply) {
  // Group rows by date for a tidy summary.
  const byDate = {};
  added.forEach(a => { (byDate[a.date] = byDate[a.date] || []).push(a); });
  const blocks = Object.keys(byDate).sort().map(date => {
    const label = byDate[date][0].label;
    const rows = byDate[date].map(a =>
      (a.type === 'video' ? '🎥 ' : '• ') + escapeHtml(a.text)).join('\n');
    return `📅 <b>${label}</b> (${date}):\n${rows}`;
  });
  const head = (aiReply && aiReply.trim())
    ? '✅ ' + escapeHtml(aiReply.trim()) + '\n\n'
    : `✅ <b>${added.length} item${added.length > 1 ? 's' : ''}</b> planner mein add ho gaye:\n\n`;
  return head + blocks.join('\n\n') + '\n\n📲 App kholo → Planner mein dekho.';
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ── /start ─────────────────────────────────────────────────────────────── */
bot.onText(/^\/start(.*)$/, (msg) => {
  const chatId = msg.chat.id;
  const name   = msg.from.first_name || 'Student';
  const text =
    `👋 Namaste <b>${name}</b>!\n\n` +
    `✅ Bot se successfully connect ho gaye!\n\n` +
    `📋 <b>Tumhara Telegram Chat ID:</b>\n` +
    `<code>${chatId}</code>\n\n` +
    `👆 Upar wala number <b>copy karo</b> aur StudyPlanner app mein:\n` +
    `<b>Profile → Daily Plan on Telegram → Chat ID field</b> mein paste karo, toggle ON karo, Save karo.\n\n` +
    `📚 Phir roz <b>6:00 AM IST</b> pe aaj ka study plan yahan milega!\n\n` +
    `🆕 <b>Naya:</b> Connect hone ke baad, mujhe seedha apna task bhej do — main use planner mein add kar dunga!\n` +
    `Example: <code>kal: Revise Polity Ch 3</code>\n` +
    `Commands dekhne ke liye /help dabao.`;
  send(chatId, text)
    .then(() => console.log(`✅ Sent chat ID to ${chatId} (${name})`));
});

/* ── /id  or  /chatid ───────────────────────────────────────────────────── */
bot.onText(/^\/(id|chatid)$/, (msg) => {
  send(msg.chat.id,
    `🆔 Tumhara Chat ID: <code>${msg.chat.id}</code>\n\nIse StudyPlanner app mein paste karo.`);
});

/* ── /help ──────────────────────────────────────────────────────────────── */
bot.onText(/^\/help$/, (msg) => {
  send(msg.chat.id,
    `📖 <b>StudyPlanner Bot — Commands</b>\n\n` +
    `/start — Apna Chat ID pao\n` +
    `/id — Chat ID dobara dekho\n` +
    `/task &lt;text&gt; — Planner mein task add karo\n` +
    `/list — Aaj ke planner tasks dekho\n` +
    `/help — Yeh help message\n\n` +
    `📝 <b>Task add karne ka tareeka</b> (connect hone ke baad):\n` +
    `Seedha apna task type karke bhej do — ya /task use karo. AI khud subject samajh ke planner mein daal dega.\n\n` +
    `🎥 <b>YouTube video bhejo</b> → woh planner mein "click to play" task ban jayega:\n` +
    `<code>kal ye lecture dekhna https://youtu.be/xxxx</code>\n\n` +
    `📅 <b>Date bhi bata sakte ho</b> (aage ya peeche):\n` +
    `• <code>today / aaj</code>, <code>tomorrow / kal</code>, <code>parso</code>\n` +
    `• weekday: <code>monday</code> ... <code>sunday</code>\n` +
    `• date: <code>2026-06-25</code> ya <code>25 Jun</code>\n\n` +
    `Examples:\n` +
    `<code>Revise Polity Ch 3</code>\n` +
    `<code>kal: Solve 50 maths Qs</code>\n` +
    `<code>Attempt Mock Test 25 Jun</code>\n\n` +
    `📌 Ek se zyada task? Har task nayi line pe bhejo.\n` +
    `❗ High priority? Line ke end mein <code>!</code> lagao ya <code>#high</code>.\n\n` +
    `🌐 App: <a href="https://examzen.in">examzen.in</a>`);
});

/* ── /task  /add  /plan <text> ──────────────────────────────────────────── */
bot.onText(/^\/(task|add|plan)\b([\s\S]*)$/i, (msg, match) => {
  const body = (match[2] || '').trim();
  if (!body) {
    return send(msg.chat.id,
      '✍️ Task likho command ke saath. Example:\n' +
      '<code>/task kal Revise Polity Ch 3</code>');
  }
  handleTaskMessage(msg, body);
});

/* ── /list  /today — show today's planner tasks ─────────────────────────── */
bot.onText(/^\/(list|today)$/i, async (msg) => {
  const chatId = msg.chat.id;
  if (!db) return send(chatId, '⚠️ Yeh feature abhi available nahi hai.');
  let user;
  try { user = await findUserByChatId(chatId); }
  catch (e) { return send(chatId, '⚠️ Thodi dikkat aa gayi. Baad mein try karo.'); }
  if (!user) return send(chatId, NOT_CONNECTED_MSG);

  const tasks = getTodaysTasks(user);
  if (!tasks.length) {
    return send(chatId, '📋 Aaj ke liye koi task nahi. Bhejo to add kar dun! ✍️');
  }
  const rows = tasks.map(t =>
    `${t.done ? '✅' : '⬜'} ${escapeHtml(t.text)}${t.priority === 'high' ? ' ❗' : ''}`).join('\n');
  send(chatId, `📋 <b>Aaj ke tasks (${istDateStr(0)}):</b>\n\n${rows}`);
});

/* ── Any other plain text → treat as task ───────────────────────────────── */
bot.on('message', (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return; // commands handled above
  handleTaskMessage(msg, msg.text);
});

/* ── Polling error handler ──────────────────────────────────────────────── */
bot.on('polling_error', (err) => {
  console.error('⚠️  Polling error:', err.code, err.message);
});

/* ════════════════════════════════════════════════════════════════════════
   HTTP Server (health check + /send proxy) — unchanged
   ════════════════════════════════════════════════════════════════════════ */
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {

  /* CORS headers — allow admin.html on GitHub Pages to call this */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  /* Preflight */
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  /* Health check */
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('PrepPath Bot is alive 🤖');
    return;
  }

  /* ── POST /ai-test — admin panel "Test AI" button ──
     Reads config/ai from Firestore and runs a sample parse so the admin can
     verify the Groq key + model work. Returns the parsed intents. */
  if (req.method === 'POST' && req.url === '/ai-test') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { message } = JSON.parse(body || '{}');
        const cfg = await getAiConfig();
        // Bypass the cache for an immediate test if Firestore has fresher data.
        _aiCache = { value: null, ts: 0 };
        const fresh = await getAiConfig();
        if (!fresh.apiKey) throw new Error('No Groq API key saved in config/ai');
        const sample = message || 'kal Revise Polity Ch 3 and solve 30 quant Qs, important';
        const parsed = await aiParse(sample, fresh, {
          todayIST:     istDateStr(0),
          weekdayIST:   weekdayNameToday(),
          examName:     'CGL',
          subjectList:  subjectPromptList('cgl'),
          fallbackDate: istDateStr(0),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, model: fresh.model, sample, parsed }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  /* ── POST /send — proxy Telegram sendMessage ── */
  if (req.method === 'POST' && req.url === '/send') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { chatId, text } = JSON.parse(body);
        if (!chatId || !text) throw new Error('chatId and text are required');

        const tgUrl = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
        const payload = JSON.stringify({
          chat_id:                  chatId,
          text,
          parse_mode:               'HTML',
          disable_web_page_preview: true,
        });

        /* Call Telegram API from server side — no CORS issues */
        const tgRes = await new Promise((resolve, reject) => {
          const r = https.request(tgUrl, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
          }, (resp) => {
            let d = '';
            resp.on('data', c => d += c);
            resp.on('end', () => resolve(JSON.parse(d)));
          });
          r.on('error', reject);
          r.write(payload);
          r.end();
        });

        if (!tgRes.ok) {
          const msg = tgRes.description || String(tgRes.error_code);
          console.error(`❌ /send failed for ${chatId}: ${msg}`);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: msg }));
        } else {
          console.log(`✅ /send → chatId:${chatId}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        }
      } catch (e) {
        console.error('❌ /send error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  /* 404 for anything else */
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => console.log(`🌐 Health server on :${PORT}`));

/* ── Keep-alive ping every 14 min (prevents free tier sleep) ───────────── */
const renderUrl = process.env.RENDER_EXTERNAL_URL;
if (renderUrl) {
  setInterval(() => {
    try {
      const mod = renderUrl.startsWith('https') ? https : http;
      mod.get(renderUrl, (r) => console.log(`💓 Keep-alive ping → ${r.statusCode}`))
         .on('error', (e) => console.log('Keep-alive ping error:', e.message));
    } catch(e) {}
  }, 14 * 60 * 1000);
}
