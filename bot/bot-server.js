/**
 * StudyPlanner Telegram Bot Server
 * ─────────────────────────────────────────────────────────────────────────────
 * Three jobs:
 *   1. Reply with the user's Chat ID on /start  (existing connect flow)
 *   2. AI auto-schedule: when a connected user sends a task or a YouTube link,
 *      parse it with Groq, auto-detect the subject, and drop it into their
 *      planner To-Do list (via the user doc's `telegramInbox` field).
 *   3. /calc: hand a saved Calculation Practice preset back on demand — the pull
 *      counterpart to the scheduled reminder in scripts/send-calculation-reminders.js.
 *
 * Routes:
 *   GET  /            → health check
 *   POST /send        → proxy: sends a Telegram message server-side (CORS-safe)
 *   POST /send-photo  → proxy: relays a Turbo screenshot (base64 JPEG) via sendPhoto;
 *                       routed to the user's group "📸 Images" topic if they ran
 *                       /setup, else to their private DM.
 *
 * Deploy on Render (Web Service):
 *   Root directory: bot
 *   Build:          npm install
 *   Start:          node bot-server.js
 *   Env vars:
 *     TELEGRAM_BOT_TOKEN        (required) — from @BotFather
 *     FIREBASE_SERVICE_ACCOUNT  (required for AI scheduling) — full service-account JSON
 *
 * The Groq API key + model + on/off toggle are NOT env vars — they are managed
 * by the admin in the panel and stored in Firestore at  config/ai.
 *
 * Requires Node >= 18 (uses the built-in global `fetch`).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const TelegramBot = require('node-telegram-bot-api');
const crypto      = require('crypto');
const http        = require('http');
const https       = require('https');
/* `isLifetimePlan` is only used to word /status; the gate itself is isProUser. */
const { isProUser, isLifetimePlan } = require('../shared/proGating');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN env var missing. Set it in Render dashboard.');
  process.exit(1);
}

/* ── Firebase Admin ─────────────────────────────────────────────────────────
   Everything past the Chat-ID reply needs Firestore: /calc, /setup, the AI
   auto-schedule, the Mini App routes and both send proxies all go through `db`.
   When `db` is null each of them fails in its own way, so one mis-pasted env
   var shows up as several unrelated bugs — which is exactly how it was reported.

   The value arrives through a hosting dashboard, and that is where it gets
   damaged: some UIs wrap a pasted value in quotes, some strip the real newlines
   out of `private_key`, shells prepend a BOM, and round-tripping through an
   editor can double-escape the `\n` sequences. Every one of those ends as a null
   `db`. So accept the value in each shape it realistically arrives in, repair
   `private_key`, and when it still cannot be used say which of those was wrong
   rather than one generic line. */

/* A raw control character inside a JSON string is invalid JSON — which is what
   a `private_key` pasted with real newlines produces. Escape them only where
   they matter, inside string literals: escaping the newlines that pretty-print
   the document would corrupt it instead of repairing it. */
function escapeControlCharsInJsonStrings(text) {
  const replacements = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === '\\') { out += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; out += ch; continue; }
    out += inString && replacements[ch] ? replacements[ch] : ch;
  }
  return out;
}

/* → { serviceAccount } on success, else { code, detail }.
   `code` is a fixed token safe to expose on /health; `detail` can quote the
   parser error, which may echo part of the value, so it stays in the logs. */
function parseServiceAccount(rawValue) {
  let raw = String(rawValue == null ? '' : rawValue).replace(/^\uFEFF/, '').trim();
  if (!raw) return { code: 'not-set', detail: 'FIREBASE_SERVICE_ACCOUNT is empty or not set' };

  /* A dashboard or shell that wraps the value in double quotes also escapes the
     quotes inside it, so stripping the outer pair alone leaves `{\"type\":…` —
     still not parseable. Decoding the whole thing as the JSON string literal it
     has become recovers the document properly; the plain strip is the fallback
     for a wrap that is not a valid literal. */
  if (raw.length > 1 && raw.startsWith('"') && raw.endsWith('"')) {
    let unwrapped = null;
    try {
      const decoded = JSON.parse(raw);
      if (typeof decoded === 'string') unwrapped = decoded;
    } catch (error) { /* not a valid literal — fall back below */ }
    raw = (unwrapped === null ? raw.slice(1, -1) : unwrapped).trim();
  } else if (raw.length > 1 && raw.startsWith("'") && raw.endsWith("'")) {
    raw = raw.slice(1, -1).trim();
  }

  /* Base64 carries no braces or newlines for a dashboard to mangle, so it is
     the shape to fall back on when the raw JSON keeps arriving broken. */
  if (!raw.startsWith('{')) {
    const decoded = Buffer.from(raw, 'base64').toString('utf8').trim();
    if (decoded.startsWith('{')) raw = decoded;
  }
  if (!raw.startsWith('{')) return { code: 'not-json', detail: 'value is neither JSON nor base64-encoded JSON' };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (firstError) {
    try {
      parsed = JSON.parse(escapeControlCharsInJsonStrings(raw));
      console.warn('⚠️  FIREBASE_SERVICE_ACCOUNT contained unescaped newlines — repaired in memory. Prefer the base64 form.');
    } catch (secondError) {
      return { code: 'not-json', detail: `JSON.parse failed: ${firstError.message}` };
    }
  }
  if (!parsed || typeof parsed !== 'object') return { code: 'not-json', detail: 'value did not decode to an object' };

  /* A key that survived an extra round of escaping arrives as two-character
     "\n" sequences with no real newlines, and the PEM parser rejects it. */
  if (typeof parsed.private_key === 'string'
    && !parsed.private_key.includes('\n') && parsed.private_key.includes('\\n')) {
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    console.warn('⚠️  FIREBASE_SERVICE_ACCOUNT private_key was double-escaped — repaired in memory.');
  }

  if (!parsed.project_id) return { code: 'incomplete', detail: 'no project_id field' };
  if (!parsed.private_key) return { code: 'incomplete', detail: 'no private_key field' };
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(parsed.private_key)) {
    return { code: 'bad-private-key', detail: 'private_key is not a PEM block' };
  }
  return { serviceAccount: parsed };
}

let db = null;
let storageBucket = null;
/* Surfaced by GET /health so a deployment can be checked without log access. */
const FIRESTORE_STATUS = { code: 'init' };

/* The old single console.warn scrolled past unnoticed for however long this has
   been broken, so state the blast radius and the fix at the point of failure. */
function reportFirestoreDown(code, detail) {
  FIRESTORE_STATUS.code = code;
  console.error('══════════════════════════════════════════════════════════════════');
  console.error(`❌ FIRESTORE UNAVAILABLE (${code}) — ${detail}`);
  console.error('   Disabled: /calc, /setup, AI auto-schedule, Mini App practice,');
  console.error('             "Send to Telegram", screenshot relay.');
  console.error('   Working:  /start, /id, /help (Chat-ID replies only).');
  console.error('   Fix:      set FIREBASE_SERVICE_ACCOUNT on the bot host to the');
  console.error('             full service-account JSON (or its base64), redeploy.');
  console.error('   Verify:   GET /health → {"firestore":"ready"}');
  console.error('══════════════════════════════════════════════════════════════════');
}

function initFirestore() {
  const loaded = parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (loaded.code) {
    reportFirestoreDown(loaded.code, loaded.detail);
    return;
  }
  try {
    const admin = require('firebase-admin');
    admin.initializeApp({ credential: admin.credential.cert(loaded.serviceAccount) });
    db = admin.firestore();
    storageBucket = admin.storage().bucket(`${loaded.serviceAccount.project_id}.firebasestorage.app`);
    global._fbAdmin = admin; // for FieldValue / Timestamp
    FIRESTORE_STATUS.code = 'ready';
    console.log(`✅ Firebase Admin ready (project: ${loaded.serviceAccount.project_id}) — Firestore features enabled`);
  } catch (error) {
    db = null;
    reportFirestoreDown('rejected', `Firebase Admin rejected the credentials: ${error.message}`);
  }
}
initFirestore();

/* Identifies this process in the logs and on /health. Several deployments of
   this bot answering the same chat is otherwise almost impossible to diagnose:
   the replies look like one bot behaving erratically, when in fact each came
   from a different build. Render supplies these; a local run falls back to a
   random id. */
const INSTANCE = {
  id: String(process.env.RENDER_INSTANCE_ID || crypto.randomBytes(6).toString('hex')).slice(-12),
  service: process.env.RENDER_SERVICE_NAME || 'local',
  commit: String(process.env.RENDER_GIT_COMMIT || '').slice(0, 7),
  branch: String(process.env.RENDER_GIT_BRANCH || ''),
  startedAt: new Date().toISOString()
};
function describeInstance() {
  return `${INSTANCE.service}@${INSTANCE.commit || 'unknown'} (instance ${INSTANCE.id})`;
}

/* Telegram only delivers the update types explicitly asked for here, and the
   default omits the ones this bot depends on: `channel_post` (/setup typed in a
   channel) and `my_chat_member` (the bot being promoted). Kept as a named
   constant because /health reports it — a hardcoded second copy had already
   drifted out of sync with this list once. */
const ALLOWED_UPDATES = ['message', 'callback_query', 'channel_post', 'edited_channel_post', 'my_chat_member'];

const bot = new TelegramBot(TOKEN, {
  polling: {
    params: {
      allowed_updates: ALLOWED_UPDATES
    }
  }
});
console.log(`🤖 StudyPlanner Bot running (long-polling) — ${describeInstance()}`);

/* ════════════════════════════════════════════════════════════════════════════
   HELPERS
   ════════════════════════════════════════════════════════════════════════════ */

/** Today's date string in IST (YYYY-MM-DD). */
function todayIST() {
  const ist = new Date(Date.now() + (5 * 60 + 30) * 60000);
  return ist.toISOString().slice(0, 10);
}

/** Add N days to an IST date string → YYYY-MM-DD. */
function addDaysIST(days) {
  const ist = new Date(Date.now() + (5 * 60 + 30) * 60000);
  ist.setUTCDate(ist.getUTCDate() + days);
  return ist.toISOString().slice(0, 10);
}

/** Resolve a relative/explicit date token from the AI into a YYYY-MM-DD (IST). */
function resolveDate(token) {
  if (!token) return todayIST();
  const t = String(token).trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;          // already explicit
  if (t === 'today' || t === 'aaj') return todayIST();
  if (t === 'tomorrow' || t === 'kal') return addDaysIST(1);
  if (t === 'day after tomorrow' || t === 'parso') return addDaysIST(2);
  const weekdays = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const idx = weekdays.indexOf(t);
  if (idx >= 0) {
    const ist = new Date(Date.now() + (5 * 60 + 30) * 60000);
    const cur = ist.getUTCDay();
    let diff = (idx - cur + 7) % 7;
    if (diff === 0) diff = 7; // next occurrence, not today
    return addDaysIST(diff);
  }
  return todayIST();
}

/** Extract all YouTube video IDs from free text. */
function extractYouTubeIds(text) {
  if (!text) return [];
  const ids = [];
  const re = /(?:youtube\.com\/(?:watch\?(?:[^ ]*&)?v=|embed\/|shorts\/|live\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/g;
  let m;
  while ((m = re.exec(text)) !== null) { if (!ids.includes(m[1])) ids.push(m[1]); }
  return ids;
}

/** Strip URLs out of a message so the leftover text can be parsed as a task. */
function stripUrls(text) {
  return (text || '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
}

/** Fetch a YouTube video title via oEmbed (no API key needed). */
async function fetchYouTubeTitle(videoId) {
  try {
    const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.title ? j.title : null;
  } catch (e) { return null; }
}

/** Read the AI config (Groq key + model + enabled) from Firestore config/ai. */
async function getAiConfig() {
  if (!db) return { enabled: false };
  try {
    const snap = await db.collection('config').doc('ai').get();
    return snap.exists ? (snap.data() || {}) : {};
  } catch (e) { return { enabled: false }; }
}

/** Find the connected user (uid + data) for a Telegram chat ID. */
async function findUserByChatId(chatId) {
  if (!db) return null;
  const cid = String(chatId);
  /* Primary: users who pasted their chat ID in the app (source of truth). */
  try {
    const q = await db.collection('users').where('appState.telegram.chatId', '==', cid).limit(1).get();
    if (!q.empty) { const d = q.docs[0]; return { uid: d.id, data: d.data() || {} }; }
  } catch (e) { console.warn('⚠️  chatId query failed:', e.message); }
  /* Fallback: the /start auto-link map. */
  try {
    const link = await db.collection('telegram_links').doc(cid).get();
    if (link.exists && link.data().uid) {
      const u = await db.collection('users').doc(link.data().uid).get();
      if (u.exists) return { uid: u.id, data: u.data() || {} };
    }
  } catch (e) {}
  return null;
}

/**
 * Ask Groq to turn a free-text study message into structured tasks.
 * Returns { tasks: [{ text, subject, date, priority }] } or null on failure.
 */
async function parseWithGroq(text, cfg) {
  const key = cfg && cfg.groqApiKey;
  if (!key) return null;
  const model = (cfg && cfg.model) || 'llama-3.1-8b-instant';
  const today = todayIST();

  const system =
    'You are a study-planner assistant for Indian competitive-exam aspirants (SSC, UPSC, banking, etc.). ' +
    'Convert the user message into a JSON object that schedules study tasks. ' +
    'Output ONLY valid minified JSON, no markdown, no commentary. ' +
    'Schema: {"tasks":[{"text":string,"subject":string,"date":string,"priority":string}]}. ' +
    'Rules: ' +
    '"text" = the concise topic/task to study (e.g. "Article 14 - Right to Equality"). ' +
    '"subject" = the best-guess subject name like Polity, History, Geography, Economics, ' +
    'Maths, Reasoning, English, General Science, Current Affairs, Computer (or "" if unknown). ' +
    '"date" = "YYYY-MM-DD" if a specific day is implied, else "today" or "tomorrow" or a weekday name. ' +
    `Today is ${today} (IST). ` +
    '"priority" = "high" | "normal" | "low" (default "normal"). ' +
    'Split multiple tasks into separate array items. If the message is small talk or unclear, ' +
    'return {"tasks":[]}.';

  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: text }
    ],
    temperature: 0.2,
    max_completion_tokens: 1024,
    top_p: 1,
    stream: false
  };

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    if (!r.ok) {
      console.error('❌ Groq error:', (j.error && j.error.message) || r.status);
      return null;
    }
    const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!content) return null;
    /* Be lenient: strip code fences and grab the first {...} block. */
    let raw = content.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = raw.indexOf('{'); const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) raw = raw.slice(start, end + 1);
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.tasks)) return parsed;
    return null;
  } catch (e) {
    console.error('❌ Groq parse failed:', e.message);
    return null;
  }
}

/** Append items to a user's telegramInbox (drained by the web app). */
async function pushToInbox(uid, items) {
  if (!db || !items.length) return;
  const admin = global._fbAdmin;
  await db.collection('users').doc(uid).set(
    { telegramInbox: admin.firestore.FieldValue.arrayUnion(...items) },
    { merge: true }
  );
}

/* ── Pro check ──────────────────────────────────────────────────────────────
   Delegated to shared/proGating.js — the single source of truth for
   server-side Pro/trial gating, also used by scripts/send-telegram.js.
   It must stay behaviourally in sync with the web app's ezIsPro()
   (js/features/preppath-phase4-gating.js) — see the comment in that file. */

/** Admins are always treated as Pro (mirrors the daily sender). */
async function isAdminUid(uid) {
  if (!db || !uid) return false;
  try {
    const snap = await db.collection('admins').doc(uid).get();
    return snap.exists;
  } catch (e) { return false; }
}

/* ── Simple in-memory rate limit: max 15 scheduling msgs / chat / minute ──── */
const _rate = new Map();
function rateLimited(chatId) {
  const now = Date.now();
  const arr = (_rate.get(chatId) || []).filter(t => now - t < 60000);
  arr.push(now);
  _rate.set(chatId, arr);
  return arr.length > 15;
}

/* ── Photo rate limit: max 6 screenshots / authenticated user / minute ───── */
const _photoRate = new Map();
function photoRateLimited(chatId) {
  const now = Date.now();
  const arr = (_photoRate.get(chatId) || []).filter(t => now - t < 60000);
  arr.push(now);
  _photoRate.set(chatId, arr);
  return arr.length > 6;
}

/* ════════════════════════════════════════════════════════════════════════════
   COMMAND HANDLERS
   ════════════════════════════════════════════════════════════════════════════ */

/* ── /start handler — also auto-links the chat ID to the uid if provided ──── */
bot.onText(/^\/start(?:\s+(.+))?$/, (msg, match) => {
  const chatId = msg.chat.id;
  const name   = msg.from.first_name || 'Student';
  const uid    = match && match[1] ? match[1].trim() : '';

  /* Best-effort reverse-link so the bot can find this user later. */
  if (uid && db) {
    db.collection('telegram_links').doc(String(chatId))
      .set({ uid, username: msg.from.username || '', linkedAt: global._fbAdmin.firestore.FieldValue.serverTimestamp() }, { merge: true })
      .catch(e => console.warn('telegram_links write failed:', e.message));
  }

  const aiLine = db
    ? '\n\n🧠 <b>Naya!</b> Ab tum mujhe apna aaj ka task ya YouTube link bhej sakte ho — ' +
      'main use tumhare planner ki To-Do list mein add kar dunga (subject auto-detect karke).'
    : '';

  const text =
    `👋 Namaste <b>${name}</b>!\n\n` +
    `✅ Bot se successfully connect ho gaye!\n\n` +
    `📋 <b>Tumhara Telegram Chat ID:</b>\n` +
    `<code>${chatId}</code>\n\n` +
    `👆 Upar wala number <b>copy karo</b> aur StudyPlanner app mein:\n` +
    `<b>Profile → Daily Plan on Telegram → Chat ID field</b> mein paste karo, toggle ON karo, Save karo.\n\n` +
    `📚 Phir roz <b>6:00 AM IST</b> pe aaj ka study plan yahan milega!` +
    aiLine;
  bot.sendMessage(chatId, text, { parse_mode: 'HTML' })
    .then(() => console.log(`✅ Sent chat ID to ${chatId} (${name})`))
    .catch(err => console.error(`❌ sendMessage error for ${chatId}:`, err.message));
});

/* ── /id  or  /chatid ───────────────────────────────────────────────────── */
bot.onText(/^\/(id|chatid)$/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
    `🆔 Tumhara Chat ID: <code>${chatId}</code>\n\nIse StudyPlanner app mein paste karo.`,
    { parse_mode: 'HTML' }
  ).catch(err => console.error('sendMessage error:', err.message));
});

/* ── /help ──────────────────────────────────────────────────────────────── */
/* Keep this list, BOT_COMMANDS below, and the handlers themselves in sync — the
   help text is hand-written, so a new command is invisible without all three. */
bot.onText(/^\/help$/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `📖 <b>StudyPlanner Bot Commands:</b>\n\n` +
    `/start — Apna Chat ID pao\n` +
    `/calc — Aaj ki Calculation Practice turant shuru karo (<code>/calc &lt;name&gt;</code> se koi bhi preset)\n` +
    `/plan — Aaj ka study plan\n` +
    `/pending — Kya baaki hai\n` +
    `/exam — Exam countdown\n` +
    `/stats — Practice streak aur accuracy (<code>/streak</code> bhi)\n` +
    `/mock — Mock test scores aur trend\n` +
    `/addmock — Section-wise mock marks seedha add karo\n` +
    `/ask — Koi doubt poocho (AI tutor)\n` +
    `/status — Account aur bot ka health check\n` +
    `/id — Chat ID dobara dekho\n` +
    `/setup — Screenshot destination choose karo (DM mein button se channel select karo)\n` +
    `/help — Yeh help message\n\n` +
    `🧠 <b>AI auto-schedule:</b> Bas apna task likho (e.g. "Polity Article 14 kal") ` +
    `ya YouTube link bhejo — main planner mein add kar dunga.\n\n` +
    `📸 <b>Screenshots alag rakhne ke liye:</b> DM mein /setup bhejo aur Choose my channel dabao. ` +
    `Group ke liye group mein /setup bhej sakte ho.\n\n` +
    `🌐 App: <a href="https://examzen.in">examzen.in</a>`,
    { parse_mode: 'HTML', disable_web_page_preview: true }
  ).catch(err => console.error('sendMessage error:', err.message));
});

/* ── Command menu ──────────────────────────────────────────────────────────
   Without setMyCommands Telegram shows no autocomplete list, so every command
   above is discoverable only by reading /help — which itself has to be found
   first. Registering the menu is per-bot state on Telegram's side, not per
   process, so sending it on each boot simply overwrites the previous list.
   `/chatid` is deliberately omitted: it is an alias of `/id` and would only
   pad the menu. A failure here costs autocomplete, not any command, so it is
   logged rather than fatal. */
const BOT_COMMANDS = [
  { command: 'start',   description: 'Connect the bot and get your Chat ID' },
  { command: 'calc',    description: "Start today's Calculation Practice" },
  { command: 'plan',    description: "Today's study plan" },
  { command: 'pending', description: "What's still left today" },
  { command: 'exam',    description: 'Days left until your exam' },
  { command: 'stats',   description: 'Practice streak and accuracy' },
  { command: 'mock',    description: 'Mock test scores and trend' },
  { command: 'addmock', description: 'Add section-wise mock test marks' },
  { command: 'ask',     description: 'Ask a study doubt' },
  { command: 'status',  description: 'Check your account and the bot' },
  { command: 'id',      description: 'Show your Chat ID again' },
  { command: 'setup',   description: 'Choose a screenshot channel or group' },
  { command: 'help',    description: 'What this bot can do' }
];
bot.setMyCommands(BOT_COMMANDS)
  .then(() => console.log(`⌨️  Command menu registered (${BOT_COMMANDS.map(entry => '/' + entry.command).join(' ')})`))
  .catch(err => console.warn('⚠️  setMyCommands failed:', err.message, '— commands still work, autocomplete may be stale.'));

/* ── /setup ───────────────────────────────────────────────────────────────
   Supports ALL group/channel types:
   • Supergroup with Topics (forum) → creates "📸 Images" topic, routes there
   • Channel / regular group / supergroup without Topics → routes directly
   • Private chat → rejected (screenshots need a separate destination)

   A bot CANNOT create a group/channel itself (Bot API limitation), so the
   group creation is the one manual step; everything after is automatic. */
const SETUP_CHANNEL_REQUEST_TTL_MS = 10 * 60 * 1000;
const _setupChannelRequests = new Map();

function setupChannelPickerMarkup(requestId) {
  return {
    keyboard: [[{
      text: '📣 Choose my channel',
      request_chat: {
        request_id: requestId,
        chat_is_channel: true,
        chat_is_created: true,
        bot_is_member: true,
        request_title: true,
        request_username: true
      }
    }]],
    resize_keyboard: true,
    one_time_keyboard: true,
    input_field_placeholder: 'Choose the channel for screenshots'
  };
}

bot.onText(/^\/setup(?:@\w+)?(?:\s+(.+))?$/, async (msg, match) => {
  const chat   = msg.chat;
  const fromId = msg.from && msg.from.id;

  /* Private bot DM — either link a channel/group by ID, or show instructions. */
  if (chat.type === 'private') {
    /* Check if user provided a chat ID argument: /setup -100123456 */
    const targetId = match && match[1] ? match[1].trim() : '';

    if (/^-?\d+$/.test(targetId) && db && fromId) {
      /* User is linking a specific channel/group from their DM. */
      try {
        /* Verify the bot is a member of that chat. */
        const chatInfo = await bot.getChat(targetId);
        if (!chatInfo) throw new Error('Chat not found');

        const chatType = chatInfo.type; // 'channel', 'group', 'supergroup'
        if (chatType === 'private') {
          bot.sendMessage(chat.id, '⚠️ Private chat nahi — channel ya group ka ID do.', { parse_mode: 'HTML' }).catch(() => {});
          return;
        }

        await db.collection('telegram_groups').doc(String(fromId)).set({
          groupId:       Number(targetId),
          imagesTopicId: null,
          groupTitle:    chatInfo.title || '',
          username:      (msg.from && msg.from.username) || '',
          chatType:      chatType,
          updatedAt:     new Date().toISOString()
        }, { merge: true });

        const label = chatType === 'channel' ? 'channel' : 'group';
        bot.sendMessage(chat.id,
          `✅ <b>Setup complete!</b>\n` +
          `Tumhare screenshots ab "<b>${escapeTelegramHtml((chatInfo.title || targetId).slice(0, 60))}</b>" ${label} mein jayenge.\n\n` +
          `(Daily plan pehle jaisa DM mein hi milega.)`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
        console.log(`✅ /setup DM link → user:${fromId} target:${targetId} type:${chatType}`);
      } catch (e) {
        const errMsg = (e && e.response && e.response.body && e.response.body.description) || e.message;
        bot.sendMessage(chat.id,
          `❌ Link nahi ho paya: ${errMsg}\n\n` +
          `Check karo:\n• Kya bot us channel/group mein <b>admin</b> hai?\n• Kya ID sahi hai?`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
        console.error('❌ /setup DM link error:', errMsg);
      }
      return;
    }

    /* Native Bot API channel picker: Telegram returns a chat_shared service
       message in this DM, so private channel ids never need to be discovered,
       copied or inferred from anonymous channel posts. */
    const requestId = crypto.randomInt(1, 0x7fffffff);
    const requestOwner = String(fromId);
    _setupChannelRequests.set(requestOwner, {
      requestId,
      expiresAt: Date.now() + SETUP_CHANNEL_REQUEST_TTL_MS
    });
    bot.sendMessage(chat.id,
      `📸 <b>Screenshot destination setup</b>\n\n` +
      `Neeche <b>Choose my channel</b> dabao aur apna channel select karo.\n\n` +
      `Channel list mein aane ke liye:\n` +
      `• channel tumhara created/owned hona chahiye\n` +
      `• Studyplannerbot us channel mein pehle se member/admin hona chahiye\n\n` +
      `Select karte hi main permission check karke channel mein test message bhejunga.`,
      { parse_mode: 'HTML', reply_markup: setupChannelPickerMarkup(requestId) }
    ).catch(err => {
      _setupChannelRequests.delete(requestOwner);
      console.error('❌ /setup picker send failed:', err.message);
    });
    return;
  }

  if (!db) {
    bot.sendMessage(chat.id, '⚠️ Server config missing — setup abhi save nahi ho sakta.').catch(() => {});
    return;
  }

  /* Supergroup with Topics (forum) — create a dedicated "📸 Images" topic. */
  if (chat.type === 'supergroup' && chat.is_forum) {
    try {
      const topic = await bot.createForumTopic(chat.id, '📸 Images', { icon_color: 0x6FB9F0 });
      const threadId = topic && topic.message_thread_id;
      if (!threadId) throw new Error('no message_thread_id returned');

      await db.collection('telegram_groups').doc(String(fromId)).set({
        groupId:       chat.id,
        imagesTopicId: threadId,
        groupTitle:    chat.title || '',
        username:      (msg.from && msg.from.username) || '',
        updatedAt:     new Date().toISOString()
      }, { merge: true });

      bot.sendMessage(chat.id,
        `✅ <b>Setup complete!</b>\nTumhare Turbo screenshots ab is group ke <b>📸 Images</b> topic mein aayenge.\n` +
        `(Daily study plan pehle jaisa tumhare private chat mein hi milega.)`,
        { parse_mode: 'HTML', message_thread_id: threadId }
      ).catch(() => {});
      console.log(`✅ /setup → user:${fromId} group:${chat.id} topic:${threadId} (forum)`);
    } catch (e) {
      const errMsg = (e && e.response && e.response.body && e.response.body.description) || e.message;
      bot.sendMessage(chat.id,
        `❌ Topic nahi bana paya: ${errMsg}\n\n` +
        `Check karo: kya main is group ka <b>admin</b> hoon <b>"Manage Topics"</b> permission ke saath?`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
      console.error('❌ /setup error (forum):', errMsg);
    }
    return;
  }

  /* Channel, regular group, or supergroup without Topics — save as direct
     screenshot destination (no topic creation needed). */
  try {
    await db.collection('telegram_groups').doc(String(fromId)).set({
      groupId:       chat.id,
      imagesTopicId: null,
      groupTitle:    chat.title || '',
      username:      (msg.from && msg.from.username) || '',
      chatType:      chat.type,
      updatedAt:     new Date().toISOString()
    }, { merge: true });

    const label = chat.type === 'channel' ? 'channel' : 'group';
    bot.sendMessage(chat.id,
      `✅ <b>Setup complete!</b>\nTumhare Turbo screenshots ab is ${label} mein seedhe aayenge.\n` +
      `(Daily study plan pehle jaisa tumhare private chat mein hi milega.)`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
    console.log(`✅ /setup → user:${fromId} chat:${chat.id} type:${chat.type} (direct, no topic)`);
  } catch (e) {
    const errMsg = (e && e.response && e.response.body && e.response.body.description) || e.message;
    bot.sendMessage(chat.id,
      `❌ Setup fail: ${errMsg}\n\n` +
      `Check karo: kya main is ${chat.type === 'channel' ? 'channel' : 'group'} ka <b>admin</b> hoon?`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
    console.error('❌ /setup error (direct):', errMsg);
  }
});

/* ── Native channel selection from /setup DM ─────────────────────────────
   KeyboardButtonRequestChat returns Message.chat_shared in the private chat.
   This is the authoritative setup path for private channels: Telegram supplies
   the id, the picker restricts selection to channels owned by the user where
   this bot is already a member, and we prove write access with a test post
   before persisting the destination. */
bot.on('message', async (msg) => {
  const shared = msg && msg.chat_shared;
  if (!shared) return;
  if (!msg.chat || msg.chat.type !== 'private' || !msg.from) return;

  const dmChatId = msg.chat.id;
  const userId = String(msg.from.id);
  const pending = _setupChannelRequests.get(userId);
  const requestId = Number(shared.request_id);
  if (!pending || pending.requestId !== requestId || pending.expiresAt < Date.now()) {
    _setupChannelRequests.delete(userId);
    bot.sendMessage(dmChatId,
      '⚠️ Yeh channel selection expire ho chuka hai. Naya button pane ke liye /setup dobara bhejo.',
      { reply_markup: { remove_keyboard: true } }
    ).catch(() => {});
    return;
  }
  /* Consume before network work so duplicate service messages cannot post or save twice. */
  _setupChannelRequests.delete(userId);

  const targetId = String(shared.chat_id || '');
  if (!/^-?\d+$/.test(targetId)) {
    bot.sendMessage(dmChatId, '❌ Telegram ne valid channel ID nahi diya. /setup dobara bhejo.', {
      reply_markup: { remove_keyboard: true }
    }).catch(() => {});
    return;
  }
  if (!db) {
    bot.sendMessage(dmChatId, '⚠️ Server database unavailable hai. Thodi der baad /setup dobara bhejo.', {
      reply_markup: { remove_keyboard: true }
    }).catch(() => {});
    return;
  }

  try {
    await enforceFirestoreRateLimit('command:setupChannel', userId, 4, 60000,
      'Bahut zyada setup attempts. Ek minute wait karke dobara try karo.');

    const [chatInfo, me] = await Promise.all([bot.getChat(targetId), bot.getMe()]);
    if (!chatInfo || chatInfo.type !== 'channel') {
      const userMessage = 'Selected chat channel nahi hai.';
      throw Object.assign(new Error(userMessage), { userMessage });
    }

    const [botMembership, ownerMembership] = await Promise.all([
      bot.getChatMember(targetId, me.id),
      bot.getChatMember(targetId, msg.from.id)
    ]);
    if (!ownerMembership || ownerMembership.status !== 'creator') {
      const userMessage = 'Sirf channel owner apna channel connect kar sakta hai.';
      throw Object.assign(new Error(userMessage), { userMessage });
    }

    const isAdmin = botMembership && ['administrator', 'creator'].includes(botMembership.status);
    const canPost = botMembership && botMembership.status === 'creator'
      ? true
      : botMembership && botMembership.can_post_messages === true;
    if (!isAdmin || !canPost) {
      const userMessage =
        'Studyplannerbot ko channel ka admin banao aur “Post Messages” permission ON karo, phir /setup se channel dobara choose karo.';
      throw Object.assign(new Error(userMessage), { userMessage });
    }

    let testMessage;
    testMessage = await bot.sendMessage(targetId,
      '🔄 <b>StudyPlanner connection test</b>\nPermission verified. Setup save ho raha hai…',
      { parse_mode: 'HTML' });

    try {
      await db.collection('telegram_groups').doc(userId).set({
        groupId: Number(targetId),
        imagesTopicId: null,
        groupTitle: String(shared.title || chatInfo.title || '').slice(0, 120),
        username: (msg.from && msg.from.username) || '',
        chatType: 'channel',
        linkedVia: 'chat_shared',
        setupTestMessageId: testMessage && testMessage.message_id ? String(testMessage.message_id) : '',
        updatedAt: new Date().toISOString()
      }, { merge: true });
    } catch (persistenceError) {
      if (testMessage && testMessage.message_id) {
        await bot.deleteMessage(targetId, testMessage.message_id).catch(deleteError => {
          console.error('❌ /setup provisional message cleanup failed:', deleteError.message);
        });
      }
      throw persistenceError;
    }

    if (testMessage && testMessage.message_id) {
      await bot.editMessageText(
        '✅ <b>StudyPlanner connected</b>\nTurbo screenshots ab is channel mein aa sakte hain.',
        { chat_id: targetId, message_id: testMessage.message_id, parse_mode: 'HTML' }
      ).catch(editError => console.error('❌ /setup saved but channel confirmation edit failed:', editError.message));
    }

    console.log(`✅ /setup chat_shared → user:${userId} channel:${targetId} test:${testMessage && testMessage.message_id}`);
    try {
      await bot.sendMessage(dmChatId,
        `✅ <b>Setup complete!</b>\n\n` +
        `Channel: <b>${escapeTelegramHtml(String(shared.title || chatInfo.title || targetId).slice(0, 80))}</b>\n` +
        `Test message successfully bhej diya. Turbo screenshots ab isi channel mein jayenge.`,
        { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
    } catch (confirmationError) {
      console.error('❌ setup saved but confirmation DM failed:', confirmationError.message);
    }
    return;
  } catch (error) {
    const telegramDetail = error && error.response && error.response.body && error.response.body.description;
    const detail = String(telegramDetail || error.message || 'unknown error');
    console.error(`❌ /setup chat_shared failed → user:${userId} channel:${targetId}: ${detail}`);
    const userText = error && error.userMessage
      ? error.userMessage
      : error && error.status === 429
        ? error.message
        : /not enough rights|administrator|chat not found|forbidden|have no rights/i.test(detail)
          ? 'Bot channel mein post nahi kar sakta. Studyplannerbot ko admin banao, “Post Messages” ON karo, phir /setup dobara bhejo.'
          : 'Channel setup abhi complete nahi hua. Thodi der baad /setup dobara try karo.';
    await bot.sendMessage(dmChatId,
      `❌ <b>Setup complete nahi hua.</b>\n\n${escapeTelegramHtml(userText)}`,
      { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } }
    ).catch(sendError => console.error('❌ /setup failure DM also failed:', sendError.message));
  }
});

/* ── /setup via message with sender_chat (channels with "Sign Messages" ON) ─
   When a channel has "Sign Messages" or "Show Authors' Profiles" enabled,
   Telegram may deliver channel posts as regular `message` updates with a
   `sender_chat` field identifying the channel. Handle /setup here too. */
bot.on('message', async (msg) => {
  if (!msg.text || !msg.text.match(/^\/setup(?:@\w+)?$/)) return;
  if (!msg.sender_chat || msg.sender_chat.type !== 'channel') return;
  if (msg.chat.type === 'private') return; // not a forwarded channel post
  
  const chat = msg.chat;
  if (!db) {
    bot.sendMessage(chat.id, '⚠️ Server config missing — setup abhi save nahi ho sakta.').catch(() => {});
    return;
  }

  try {
    await db.collection('telegram_channels').doc(String(chat.id)).set({
      channelId:    chat.id,
      channelTitle: chat.title || '',
      setupAt:      new Date().toISOString()
    }, { merge: true });

    bot.sendMessage(chat.id,
      `✅ <b>Channel registered!</b>\n\n` +
      `Ab apne bot DM mein yeh bhejo:\n` +
      `<code>/setup ${chat.id}</code>\n\n` +
      `Isse tumhara account is channel se link ho jayega aur screenshots yahan aayenge.`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
    console.log(`✅ /setup sender_chat → channel:${chat.id} title:${chat.title || ''}`);
  } catch (e) {
    const errMsg = (e && e.response && e.response.body && e.response.body.description) || e.message;
    bot.sendMessage(chat.id,
      `❌ Setup fail: ${errMsg}\n\nCheck karo: kya main is channel ka <b>admin</b> hoon?`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
    console.error('❌ /setup sender_chat error:', errMsg);
  }
});

/* ── /setup in channels (channel_post) ────────────────────────────────────
   Telegram sends messages posted in channels as `channel_post` updates, not
   regular `message` updates — so `bot.onText()` never sees them. This listener
   catches /setup typed in a channel and links it as the screenshot destination.

   Channel posts have NO `from` field (the sender is anonymous). To identify the
   user, we look up who has this bot linked via telegram_links where uid matches
   a user whose appState.telegram.chatId resolves to a known account. Since only
   channel admins can post, and the user must also be bot-connected, we use the
   sender_chat or fall back to requiring /setup <channel_id> from the DM. */
bot.on('channel_post', async (msg) => {
  if (!msg.text || !msg.text.match(/^\/setup(?:@\w+)?$/)) return;
  const chat = msg.chat;

  if (!db) {
    bot.sendMessage(chat.id, '⚠️ Server config missing — setup abhi save nahi ho sakta.').catch(() => {});
    return;
  }

  /* In a channel, msg.from is undefined. We use sender_chat (the channel itself)
     to confirm this is a channel, then save it. The owner will link it via
     /setup <channel_id> from DM, OR if we can identify them from telegram_links
     we save directly. For now, save keyed by the channel's own chat ID and let
     /setup <id> from DM create the user-keyed record. */
  try {
    /* Save a channel-level record so we know this channel has been set up.
       The user-keyed record (needed for routing) is created by /setup <id> from DM. */
    await db.collection('telegram_channels').doc(String(chat.id)).set({
      channelId:    chat.id,
      channelTitle: chat.title || '',
      setupAt:      new Date().toISOString()
    }, { merge: true });

    bot.sendMessage(chat.id,
      `✅ <b>Channel registered!</b>\n\n` +
      `Ab apne bot DM mein yeh bhejo:\n` +
      `<code>/setup ${chat.id}</code>\n\n` +
      `Isse tumhara account is channel se link ho jayega aur screenshots yahan aayenge.`,
      { parse_mode: 'HTML' }
    ).catch(err => {
      /* A silent .catch() here is what made this look like "nothing happens":
         the update arrived and the write succeeded, but the reply was refused
         (usually because the bot has no "Post Messages" right) and the reason
         was thrown away. Say it loudly instead. */
      const why = (err && err.response && err.response.body && err.response.body.description) || err.message;
      console.error(`❌ /setup channel_post: received in channel ${chat.id} but REPLY FAILED — ${why}`);
      console.error('   → Grant the bot "Post Messages" in the channel, or link it from your DM with /setup ' + chat.id);
    });
    console.log(`✅ /setup channel_post → channel:${chat.id} title:${chat.title || ''}`);
  } catch (e) {
    const errMsg = (e && e.response && e.response.body && e.response.body.description) || e.message;
    bot.sendMessage(chat.id,
      `❌ Setup fail: ${errMsg}\n\nCheck karo: kya main is channel ka <b>admin</b> hoon?`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
    console.error('❌ /setup channel_post error:', errMsg);
  }
});

/* ── Auto-link on promotion (my_chat_member) ──────────────────────────────
   The reliable way to connect a channel. `channel_post` has two failure modes
   that both look like "nothing happens": the update may not be delivered, and
   a channel post carries no `from`, so even when it arrives the bot cannot tell
   whose account to link — it has to ask the user to relay the id by hand.

   `my_chat_member` has neither problem. Telegram sends it the moment the bot's
   own membership changes, and it carries BOTH halves at once: `chat` is the
   channel, and `from` is the user who promoted the bot — which for a private
   chat is also their DM chat id. So the link is established with no command at
   all, and the confirmation goes to the DM, which always works because the user
   has already pressed Start. It also reports `can_post_messages`, so a missing
   post right is stated up front instead of silently eating every later reply. */
bot.on('my_chat_member', async (update) => {
  const chat = update && update.chat;
  const actor = update && update.from;
  const status = update && update.new_chat_member && update.new_chat_member.status;
  if (!chat || !actor || !status) return;
  if (chat.type === 'private') return;                       // DM membership is not a destination
  if (!['administrator', 'member', 'creator'].includes(status)) return;  // demoted/kicked/left
  if (!db) return;

  const actorId = String(actor.id);
  const label = chat.type === 'channel' ? 'channel' : 'group';

  try {
    /* A forum supergroup still gets its own "📸 Images" topic, so preserve that
       path; everything else is a direct destination. */
    let topicId = null;
    if (chat.type === 'supergroup' && chat.is_forum) {
      try {
        const topic = await bot.createForumTopic(chat.id, '📸 Images', { icon_color: 0x6FB9F0 });
        topicId = (topic && topic.message_thread_id) || null;
      } catch (topicError) {
        /* No "Manage Topics" right — fall back to posting in the group itself
           rather than refusing the whole link. */
        topicId = null;
      }
    }

    await db.collection('telegram_groups').doc(actorId).set({
      groupId:       chat.id,
      imagesTopicId: topicId,
      groupTitle:    chat.title || '',
      username:      actor.username || '',
      chatType:      chat.type,
      linkedVia:     'my_chat_member',
      updatedAt:     new Date().toISOString()
    }, { merge: true });

    /* Only channels expose can_post_messages; for groups an admin can post. */
    const canPost = chat.type !== 'channel'
      || update.new_chat_member.can_post_messages !== false;

    const where = topicId
      ? `is group ke <b>📸 Images</b> topic mein`
      : `"<b>${escapeTelegramHtml(String(chat.title || chat.id).slice(0, 60))}</b>" ${label} mein`;

    const lines = [
      `✅ <b>Setup complete!</b>`,
      `Tumhare Turbo screenshots ab ${where} aayenge.`,
      ``,
      `(Daily study plan pehle jaisa yahan DM mein hi milega.)`
    ];
    if (!canPost) {
      lines.push('',
        `⚠️ <b>Ek cheez baaki hai:</b> mujhe is ${label} mein <b>"Post Messages"</b> permission nahi hai, ` +
        `is liye main wahan kuch bhej nahi paunga. Channel Settings → Administrators → Studyplannerbot → ` +
        `<b>Post Messages</b> ON kar do.`);
    }

    /* The DM is the dependable surface here: the actor has started the bot, so
       this delivers even when the bot cannot post in the channel itself. */
    await bot.sendMessage(actorId, lines.join('\n'), { parse_mode: 'HTML' });
    console.log(`✅ my_chat_member link → user:${actorId} chat:${chat.id} type:${chat.type} topic:${topicId || 'none'} canPost:${canPost}`);
  } catch (error) {
    const why = (error && error.response && error.response.body && error.response.body.description) || error.message;
    console.error(`❌ my_chat_member link failed for user:${actorId} chat:${chat.id} — ${why}`);
  }
});

/* ── Calculation Practice reminder snooze buttons ───────────────────────── */
bot.on('callback_query', async (query) => {
  const data = query && query.data ? String(query.data) : '';
  const match = data.match(/^calc_snooze:([a-f0-9]{32})$/);
  if (!match) return;
  const chatId = query.message && query.message.chat ? String(query.message.chat.id) : '';
  const chatType = query.message && query.message.chat ? query.message.chat.type : '';
  const fromId = query.from && query.from.id ? String(query.from.id) : '';
  if (!db || !chatId || chatType !== 'private' || !fromId) {
    bot.answerCallbackQuery(query.id, { text: 'Snooze is available only in your private bot chat.', show_alert: true }).catch(() => {});
    return;
  }

  try {
    const ref = db.collection('calculationReminderDeliveries').doc(match[1]);
    const result = await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return { ok: false, message: 'This reminder has expired.' };
      const delivery = snapshot.data() || {};
      if (String(delivery.chatId || '') !== chatId || String(delivery.authorizedTelegramUserId || '') !== fromId) {
        return { ok: false, message: 'This reminder belongs to another account.' };
      }
      if (delivery.status !== 'sent') return { ok: false, message: 'This reminder is already pending or unavailable.' };
      const sentAtMs = delivery.sentAt && typeof delivery.sentAt.toMillis === 'function' ? delivery.sentAt.toMillis() : 0;
      if (!sentAtMs || Date.now() - sentAtMs > 24 * 60 * 60 * 1000) return { ok: false, message: 'This reminder has expired.' };
      const maxSnoozes = Math.max(0, Math.min(5, Number(delivery.maxSnoozes) || 0));
      const snoozeCount = Math.max(0, Number(delivery.snoozeCount) || 0);
      if (!maxSnoozes || snoozeCount >= maxSnoozes) return { ok: false, message: 'No snoozes remaining.' };
      const minutes = Math.max(5, Math.min(60, Number(delivery.snoozeMinutes) || 10));
      transaction.update(ref, {
        status: 'snoozed',
        snoozeCount: snoozeCount + 1,
        nextSendAt: global._fbAdmin.firestore.Timestamp.fromMillis(Date.now() + minutes * 60000),
        snoozedAt: global._fbAdmin.firestore.FieldValue.serverTimestamp()
      });
      return { ok: true, minutes, remaining: maxSnoozes - snoozeCount - 1 };
    });
    const message = result.ok
      ? `Snoozed for ${result.minutes} minutes${result.remaining ? ` · ${result.remaining} left` : ''}.`
      : result.message;
    await bot.answerCallbackQuery(query.id, { text: message, show_alert: !result.ok });
  } catch (error) {
    console.error('Calculation reminder snooze failed:', error.message);
    bot.answerCallbackQuery(query.id, { text: 'Could not snooze. Please try again.', show_alert: true }).catch(() => {});
  }
});

/* ── Dashboard navigation & action callbacks (v5) ───────────────────────
   Handles:
     pm:prev|today|next:DATE  — morning dashboard date navigation
     pe:prev|today|next:DATE  — evening dashboard date navigation
     pe:finish:DATE           — evening "finish now" action
     pe:move:DATE             — evening "move to tomorrow" action
   Callback data format:  pm:ACTION:DATE  or  pe:ACTION:DATE
   where ACTION = prev | today | next | finish | move
   and DATE = YYYY-MM-DD (the currently-viewed date). */
bot.on('callback_query', async (query) => {
  const data = query && query.data ? String(query.data) : '';
  /* Only handle dashboard callbacks */
  const pmMatch = data.match(/^pm:(prev|today|next):(\d{4}-\d{2}-\d{2})$/);
  const peMatch = data.match(/^pe:(prev|today|next|finish|move):(\d{4}-\d{2}-\d{2})$/);
  const match = pmMatch || peMatch;
  if (!match) return;

  const prefix = pmMatch ? 'pm' : 'pe';
  const action = match[1];
  const viewDate = match[2];

  const chatId = query.message && query.message.chat ? String(query.message.chat.id) : '';
  const chatType = query.message && query.message.chat ? query.message.chat.type : '';
  const messageId = query.message && query.message.message_id ? query.message.message_id : null;
  const fromId = query.from && query.from.id ? String(query.from.id) : '';

  if (!db || !chatId || chatType !== 'private' || !fromId || !messageId) {
    bot.answerCallbackQuery(query.id, { text: 'Dashboard is only available in your private bot chat.', show_alert: true }).catch(() => {});
    return;
  }

  try {
    /* 1. Identify the user — verify the chat belongs to the callback sender */
    const user = await findUserByChatId(chatId);
    if (!user) {
      bot.answerCallbackQuery(query.id, { text: 'Account not linked. Use /start first.', show_alert: true }).catch(() => {});
      return;
    }
    /* Security: ensure the callback is from the same Telegram account */
    const expectedTgUid = String(user.data.appState && user.data.appState.telegram && user.data.appState.telegram.telegramUserId || '');
    if (expectedTgUid && expectedTgUid !== fromId) {
      bot.answerCallbackQuery(query.id, { text: 'This dashboard belongs to another account.', show_alert: true }).catch(() => {});
      return;
    }

    /* 2. Calculate target date */
    let targetDate = viewDate;
    if (action === 'prev') {
      targetDate = shiftDateForBot(viewDate, -1);
    } else if (action === 'next') {
      targetDate = shiftDateForBot(viewDate, 1);
    } else if (action === 'today') {
      targetDate = todayIST();
    }
    /* finish and move keep the same date */

    /* 3. Handle action buttons (finish, move) */
    if (prefix === 'pe' && action === 'finish') {
      /* FINISH NOW — send a link to the planner */
      const appUrl = appBaseUrlForRequest({ headers: { origin: '' } }) + '/pages/planner.html';
      await bot.sendMessage(chatId,
        `\uD83D\uDD25 <b>Finish your tasks!</b>\n\nOpen your planner to complete pending tasks:\n<a href="${appUrl}">\uD83D\uDCD6 Open Planner</a>`,
        { parse_mode: 'HTML', disable_web_page_preview: true }
      );
      await bot.answerCallbackQuery(query.id, { text: 'Opening planner...' });
      return;
    }

    if (prefix === 'pe' && action === 'move') {
      /* MOVE TO TOMORROW — move the first pending non-overdue task to tomorrow */
      const appState = user.data.appState || {};
      const tasks = appState.tasks || {};
      const dayTasks = Array.isArray(tasks[viewDate]) ? tasks[viewDate] : [];
      const isDone = t => t && (t.done === true || t.status === 'done');
      const pendingTask = dayTasks.find(t => t && !isDone(t) && !t.overdue && t.type !== 'video');

      if (!pendingTask) {
        await bot.answerCallbackQuery(query.id, { text: 'No pending tasks to move.', show_alert: true });
        return;
      }

      /* Move the task: remove from current date, add to tomorrow */
      const tomorrow = shiftDateForBot(viewDate, 1);
      const taskRef = { ...pendingTask, originalDate: pendingTask.originalDate || viewDate };

      /* Build updated task arrays */
      const updatedDayTasks = dayTasks.filter(t => t !== pendingTask);
      const tomorrowTasks = Array.isArray(tasks[tomorrow]) ? [...tasks[tomorrow]] : [];
      tomorrowTasks.push(taskRef);

      /* Update Firestore */
      await db.collection('users').doc(user.uid).set({
        'appState.tasks': {
          [viewDate]: updatedDayTasks,
          [tomorrow]: tomorrowTasks,
        },
      }, { merge: true });

      /* Rebuild the dashboard for the current date */
      const freshState = { ...appState, tasks: { ...tasks, [viewDate]: updatedDayTasks, [tomorrow]: tomorrowTasks } };
      const name = (user.data.profile && user.data.profile.name)
        ? user.data.profile.name.split(' ')[0] : 'there';
      const dashboardResult = buildEveningDashboardForBot(name, freshState, viewDate);
      const keyboard = eveningKeyboardForBot(viewDate);

      if (dashboardResult.hasContent) {
        try {
          await bot.editMessageText(dashboardResult.text, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            reply_markup: keyboard,
          });
        } catch (editErr) {
          /* If edit fails (message too old), send a fresh message */
          console.warn(`Dashboard edit failed, sending fresh: ${editErr.message}`);
          await bot.sendMessage(chatId, dashboardResult.text, {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            reply_markup: keyboard,
          });
        }
      }

      const remaining = updatedDayTasks.filter(t => t && !isDone(t) && t.type !== 'video').length;
      await bot.answerCallbackQuery(query.id, { text: `Moved! ${remaining} task${remaining !== 1 ? 's' : ''} remaining.` });
      console.log(`Moved task for uid:${user.uid} from ${viewDate} to ${tomorrow}`);
      return;
    }

    /* 4. Navigation (prev/today/next) — rebuild and edit the message */
    const appState = user.data.appState || {};
    const name = (user.data.profile && user.data.profile.name)
      ? user.data.profile.name.split(' ')[0] : 'there';

    let dashboardResult;
    let keyboard;

    if (prefix === 'pm') {
      const digest = (appState.telegram && appState.telegram.digest) || {};
      const plan = digest[targetDate];
      dashboardResult = buildMorningDashboardForBot(name, appState, plan, targetDate);
      keyboard = morningKeyboardForBot(targetDate);
    } else {
      dashboardResult = buildEveningDashboardForBot(name, appState, targetDate);
      keyboard = eveningKeyboardForBot(targetDate);
    }

    /* Handle empty date gracefully */
    if (!dashboardResult.text) {
      const label = prefix === 'pm' ? 'No tasks' : 'No tasks';
      dashboardResult = { text: `\u2139\uFE0F ${label} for ${targetDate}`, hasContent: false };
    }

    try {
      await bot.editMessageText(dashboardResult.text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: keyboard,
      });
    } catch (editErr) {
      /* If the message is too old to edit, send a fresh one */
      const desc = (editErr.response && editErr.response.body && editErr.response.body.description) || editErr.message || '';
      console.warn(`Dashboard edit failed (uid:${user.uid}): ${desc}`);
      if (desc.includes("can't be edited") || desc.includes('not found')) {
        await bot.sendMessage(chatId, dashboardResult.text, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: keyboard,
        });
        await bot.answerCallbackQuery(query.id, { text: 'Opened fresh dashboard.' });
      } else {
        await bot.answerCallbackQuery(query.id, { text: 'Could not update dashboard. Try again.', show_alert: true });
      }
      return;
    }

    /* Answer the callback to stop the loading spinner */
    await bot.answerCallbackQuery(query.id, { text: `Viewing ${targetDate}` });

  } catch (error) {
    console.error('Dashboard callback failed:', error.message);
    bot.answerCallbackQuery(query.id, { text: 'Something went wrong. Please try again.', show_alert: true }).catch(() => {});
  }
});

/* ── Dashboard helper functions for bot-server ───────────────────────── */

/** Shift an ISO date string by N days (bot-local copy for the callback handler). */
function shiftDateForBot(ds, n) {
  const dt = new Date(ds + 'T12:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** Import dashboard builders. Loaded lazily to avoid circular deps. */
let _dashboardLib = null;
function getDashboardLib() {
  if (_dashboardLib) return _dashboardLib;
  _dashboardLib = require('../scripts/telegram-dashboard');
  return _dashboardLib;
}

function buildMorningDashboardForBot(name, appState, topicDigest, dateStr) {
  return getDashboardLib().buildMorningDashboard(name, appState, topicDigest, dateStr);
}
function buildEveningDashboardForBot(name, appState, dateStr) {
  return getDashboardLib().buildEveningDashboard(name, appState, dateStr);
}
function morningKeyboardForBot(dateStr) {
  return getDashboardLib().morningKeyboard(dateStr);
}
function eveningKeyboardForBot(dateStr) {
  return getDashboardLib().eveningKeyboard(dateStr);
}

/* ════════════════════════════════════════════════════════════════════════════
   AI AUTO-SCHEDULE — handle any non-command text message
   ════════════════════════════════════════════════════════════════════════════ */
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const text   = msg.text.trim();

  /* No Firebase → keep the old behaviour (point user to /start). */
  if (!db) {
    bot.sendMessage(chatId, `👋 Hi! Apna Chat ID pane ke liye <b>/start</b> dabao.`, { parse_mode: 'HTML' }).catch(() => {});
    return;
  }

  if (rateLimited(chatId)) {
    bot.sendMessage(chatId, '⏳ Thoda dheere! Ek minute mein bahut messages aa gaye. Thodi der baad try karo.').catch(() => {});
    return;
  }

  try {
    /* 1. Identify the user. */
    const user = await findUserByChatId(chatId);
    if (!user) {
      bot.sendMessage(chatId,
        `🔗 Pehle account connect karo:\n\n1️⃣ <b>/start</b> dabao\n2️⃣ Apna Chat ID <code>${chatId}</code> app mein paste karo (Profile → Daily Plan on Telegram)\n3️⃣ Save karo.\n\nPhir mujhe apne tasks bhejo!`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
      return;
    }

    /* 1b. Pro gate — AI auto-scheduling is a Pro-only feature. Free users can
       still connect / get /start, but cannot schedule via the bot. */
    const today = todayIST();
    const isPro = isProUser(user.data, today) || (await isAdminUid(user.uid));
    if (!isPro) {
      bot.sendMessage(chatId,
        `🔒 <b>AI auto-schedule Pro feature hai.</b>\n\n` +
        `Telegram se task/video bhejke planner mein auto-add karna Pro members ke liye hai.\n\n` +
        `💎 Upgrade karo: <a href="https://examzen.in">examzen.in</a>\n` +
        `(Tumhara daily study plan free mein milta rahega.)`,
        { parse_mode: 'HTML', disable_web_page_preview: true }
      ).catch(() => {});
      console.log(`💎 Blocked (not Pro) → uid:${user.uid} chat:${chatId}`);
      return;
    }

    /* 2. AI config gate. */
    const cfg = await getAiConfig();
    const aiEnabled = cfg && cfg.enabled && cfg.groqApiKey;

    const inboxItems = [];
    const replyLines = [];

    /* 3. YouTube links → video to-do tasks. */
    const videoIds = extractYouTubeIds(text);
    for (const vid of videoIds) {
      const title = (await fetchYouTubeTitle(vid)) || 'YouTube video';
      inboxItems.push({
        id: `${Date.now()}_${vid}`,
        kind: 'video',
        videoId: vid,
        url: `https://www.youtube.com/watch?v=${vid}`,
        title,
        text: title,
        date: todayIST(),
        priority: 'normal',
        createdAt: new Date().toISOString()
      });
      replyLines.push(`🎥 <b>${title}</b> → To-Do (aaj) · click karke YouTube tab mein chalegi`);
    }

    /* 4. Remaining text → AI-parsed study tasks. */
    const leftover = stripUrls(text);
    if (leftover && leftover.length > 1) {
      let tasks = [];
      if (aiEnabled) {
        const parsed = await parseWithGroq(leftover, cfg);
        if (parsed && parsed.tasks) tasks = parsed.tasks;
      }
      /* Fallback when AI is off / failed: schedule the raw text for today. */
      if (!tasks.length && !videoIds.length) {
        tasks = [{ text: leftover, subject: '', date: 'today', priority: 'normal' }];
      }
      for (const t of tasks) {
        if (!t || !t.text) continue;
        const date = resolveDate(t.date);
        const pr = ['high', 'normal', 'low'].includes((t.priority || '').toLowerCase()) ? t.priority.toLowerCase() : 'normal';
        inboxItems.push({
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          kind: 'task',
          text: String(t.text).slice(0, 200),
          subjectName: (t.subject || '').slice(0, 40),
          date,
          priority: pr,
          createdAt: new Date().toISOString()
        });
        const subjTag = t.subject ? ` <i>(${t.subject})</i>` : '';
        const dateTag = date === todayIST() ? 'aaj' : date;
        replyLines.push(`✅ <b>${String(t.text).slice(0, 120)}</b>${subjTag} → To-Do (${dateTag})`);
      }
    }

    /* 5. Nothing actionable? */
    if (!inboxItems.length) {
      bot.sendMessage(chatId,
        `🤔 Samajh nahi aaya. Aise bhejo:\n• "Polity Article 14 kal"\n• "Revise Modern History today"\n• ya koi YouTube link 📎`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
      return;
    }

    /* 6. Write to the inbox (app drains it into the planner). */
    await pushToInbox(user.uid, inboxItems);

    const head = aiEnabled ? '🧠 <b>Add ho gaya!</b>\n\n' : '📝 <b>Add ho gaya!</b>\n\n';
    bot.sendMessage(chatId,
      head + replyLines.join('\n') + '\n\n📲 App kholo (ya already open hai to apne aap dikh jayega).',
      { parse_mode: 'HTML', disable_web_page_preview: true }
    ).catch(() => {});
    console.log(`📥 Scheduled ${inboxItems.length} item(s) for uid:${user.uid} chat:${chatId}`);

  } catch (e) {
    console.error('❌ AI schedule error:', e.message);
    bot.sendMessage(chatId, '⚠️ Kuch gadbad ho gayi. Thodi der baad try karo.').catch(() => {});
  }
});

/* ── Incoming PHOTOS → app gallery ───────────────────────────────────────
   Any image a connected user sends the bot is queued (as a file_id reference,
   no bytes) in their telegramInbox. The app drains it into the Screenshots tab
   under "📥 Telegram Uploads" and displays it via the proxy's /tg-photo. */
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  if (!db) return;
  if (rateLimited(chatId)) return;
  try {
    const user = await findUserByChatId(chatId);
    if (!user) {
      bot.sendMessage(chatId,
        `🔗 Pehle account connect karo: <b>/start</b> dabao aur Chat ID <code>${chatId}</code> app mein paste karo.`,
        { parse_mode: 'HTML' }).catch(() => {});
      return;
    }
    const photos = msg.photo || [];
    const largest = photos[photos.length - 1];   // biggest PhotoSize
    if (!largest || !largest.file_id) return;

    const admin = global._fbAdmin;
    if (!await rememberTelegramMediaOwner(user.uid, largest.file_id, 'bot-upload')) {
      console.error(`Could not record Telegram media owner for uid:${user.uid}`);
      bot.sendMessage(chatId, '⚠️ Image receive ho gayi, lekin gallery mein safely save nahi ho saki. Dobara bhejo.').catch(() => {});
      return;
    }
    await db.collection('users').doc(user.uid).set({
      telegramInbox: admin.firestore.FieldValue.arrayUnion({
        id: 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        kind: 'image',
        tgFileId: largest.file_id,
        caption: (msg.caption || '').slice(0, 200),
        createdAt: new Date().toISOString()
      })
    }, { merge: true });

    bot.sendMessage(chatId,
      '🖼️ Image add ho gaya! App mein <b>Analysis → 📥 Uploads</b> mein dikhega — wahan folder bana ke organise kar sakte ho.',
      { parse_mode: 'HTML' }).catch(() => {});
    console.log(`🖼️ image inbox → uid:${user.uid} chat:${chatId}`);
  } catch (e) {
    console.error('❌ photo handler error:', e.message);
  }
});

/* ── Polling error handler ────────────────────────────────────────────────
   Telegram hands each update to exactly one getUpdates consumer, so a second
   process polling the same token does not merely duplicate work — it competes
   for updates and answers them with whatever build and configuration it happens
   to be running. That is how a single /calc produced three different replies,
   one of them "Server-side dikkat hai" from an instance with no Firestore
   credential while a healthy instance answered the same command correctly.

   Telegram reports the collision as HTTP 409, which used to scroll past as a
   one-line warning among ordinary network noise. It is the only authoritative
   signal that a duplicate exists, so it gets said properly. */
function isPollingConflict(error) {
  const body = error && error.response && error.response.body;
  if (body && Number(body.error_code) === 409) return true;
  return /\b409\b|terminated by other getupdates|only one bot instance/i
    .test(String((error && error.message) || ''));
}

let lastConflictWarnAt = 0;
bot.on('polling_error', (err) => {
  if (!isPollingConflict(err)) {
    console.error('⚠️  Polling error:', err.code, err.message);
    return;
  }
  /* A conflict repeats on every poll, so the banner is rate-limited rather than
     printed dozens of times a minute. */
  if (Date.now() - lastConflictWarnAt < 60000) return;
  lastConflictWarnAt = Date.now();
  console.error('══════════════════════════════════════════════════════════════════');
  console.error('❌ ANOTHER BOT INSTANCE IS POLLING THIS TOKEN (Telegram 409)');
  console.error(`   This instance: ${describeInstance()}`);
  console.error('   Only one process may long-poll a bot token. While two run,');
  console.error('   updates are split between them, so a reply comes from whichever');
  console.error('   wins the race — including stale builds, and instances with no');
  console.error('   Firestore credential that answer "Server-side dikkat hai".');
  console.error('   Fix: stop every other deployment of this bot — an older Render');
  console.error('        service, a second instance of this one, or a local run —');
  console.error('        then check GET /health on each URL and keep one build.');
  console.error('══════════════════════════════════════════════════════════════════');
});

/* ════════════════════════════════════════════════════════════════════════════
   HTTP Server (health check + /send proxy)
   ════════════════════════════════════════════════════════════════════════════ */
const PORT = process.env.PORT || 3000;
/* The built-in production origins are ALWAYS allowed. ALLOWED_ORIGINS
   (comma-separated) only ADDS further origins — it never replaces the defaults,
   so a stale/misconfigured env value can no longer silently drop the live
   site's own origin. That is exactly what broke "Send to Telegram" from the
   GitHub Pages deployment: the preflight was answered 403 without CORS
   headers, which the browser surfaces only as "Failed to fetch".
   Mirrors youtube-turbo-proxy/app.py. Never a wildcard. */
const DEFAULT_ALLOWED_ORIGINS = [
  'https://examzen.in',
  'https://www.examzen.in',
  'https://purendar950.github.io',   // GitHub Pages deployment
  'https://appassets.androidengine', // Android WebView
  'http://localhost:5173'
];
const ALLOWED_ORIGINS = new Set(DEFAULT_ALLOWED_ORIGINS
  .concat(String(process.env.ALLOWED_ORIGINS || '').split(','))
  .map(origin => origin.trim().replace(/\/$/, ''))
  .filter(Boolean));

/* Where the app is reachable in a browser, per origin. GitHub Pages serves the
   app from a repository sub-path, so the deep link needs the full base — not
   just the origin. APP_BASE_URLS (comma-separated absolute URLs) adds or
   overrides bases; APP_BASE_URL sets the fallback used when the caller's origin
   is unknown (for example the Android WebView or the scheduled worker). */
const DEFAULT_APP_BASE_URLS = [
  'https://purendar950.github.io/Examen-planner',
  'https://examzen.in',
  'https://www.examzen.in',
  'http://localhost:5173/Examen-planner' // vite.config.mjs serves under this base
];

/* A deep link is only useful if it is an absolute http(s) URL, so reject
   anything else instead of emitting a button Telegram will refuse or that
   opens nothing. Returns '' when the value cannot be used. */
function normalizeAppBaseUrl(value) {
  const candidate = String(value == null ? '' : value).trim().replace(/\/+$/, '');
  if (!candidate) return '';
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    return candidate;
  } catch (error) {
    return '';
  }
}

const APP_BASE_URLS = new Map();
DEFAULT_APP_BASE_URLS
  .concat(String(process.env.APP_BASE_URLS || '').split(','))
  .filter(entry => String(entry || '').trim())
  .forEach(entry => {
    const base = normalizeAppBaseUrl(entry);
    if (!base) {
      console.warn(`⚠️  Ignoring malformed APP_BASE_URLS entry: ${String(entry).trim()}`);
      return;
    }
    APP_BASE_URLS.set(new URL(base).origin, base);
  });

const FALLBACK_APP_BASE_URL = normalizeAppBaseUrl(process.env.APP_BASE_URL)
  || normalizeAppBaseUrl(DEFAULT_APP_BASE_URLS[0]);
if (process.env.APP_BASE_URL && !normalizeAppBaseUrl(process.env.APP_BASE_URL)) {
  console.warn(`⚠️  APP_BASE_URL is not an absolute http(s) URL — using ${FALLBACK_APP_BASE_URL} for deep links.`);
}

/* Only an already allow-listed origin can select its base, so the delivered
   deep link can never be pointed at an attacker-supplied host. */
function appBaseUrlForRequest(req) {
  const origin = String((req && req.headers && req.headers.origin) || '').replace(/\/$/, '');
  if (origin && ALLOWED_ORIGINS.has(origin) && APP_BASE_URLS.has(origin)) return APP_BASE_URLS.get(origin);
  return FALLBACK_APP_BASE_URL;
}

/* Surface the resolved routing once at boot: an allow-listed origin with no
   base of its own silently receives the fallback link, which is easy to miss
   when a new deployment origin is added to only one of the two lists. */
/* A deep-link base whose origin is not allow-listed produces a Mini App that
   loads and authorizes, then fails every request on CORS — worth saying loudly
   at boot rather than debugging from the client. */
const _basesNotAllowed = Array.from(APP_BASE_URLS.keys()).filter(origin => !ALLOWED_ORIGINS.has(origin));
if (_basesNotAllowed.length) {
  console.warn(`⚠️  App base origin(s) not in ALLOWED_ORIGINS — the Mini App will fail CORS from: ${_basesNotAllowed.join(', ')}`);
}
const _originsWithoutBase = Array.from(ALLOWED_ORIGINS).filter(origin => !APP_BASE_URLS.has(origin));
console.log(`🔗 Deep-link bases: ${Array.from(APP_BASE_URLS.values()).join(', ')} · fallback ${FALLBACK_APP_BASE_URL}`
  + (_originsWithoutBase.length ? ` · using fallback for ${_originsWithoutBase.join(', ')}` : ''));

const MAX_RELAY_BODY_BYTES = 12 * 1024 * 1024;

function setCors(req, res) {
  const origin = String(req.headers.origin || '').replace(/\/$/, '');
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  }
  return !origin || ALLOWED_ORIGINS.has(origin);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function requireFirebaseUser(req) {
  if (!db || !global._fbAdmin) throw Object.assign(new Error('authentication unavailable'), { status: 503 });
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) throw Object.assign(new Error('Firebase ID token required'), { status: 401 });
  try {
    const decoded = await global._fbAdmin.auth().verifyIdToken(header.slice(7).trim());
    if (!decoded || !decoded.uid) throw new Error('missing uid');
    return decoded;
  } catch (err) {
    throw Object.assign(new Error('invalid or expired Firebase ID token'), { status: 401 });
  }
}

function telegramChatForUserData(userData) {
  const telegram = ((userData || {}).appState || {}).telegram;
  const chatId = telegram && String(telegram.chatId || '').trim();
  return /^-?\d+$/.test(chatId || '') ? chatId : '';
}

async function proRelayUser(uid) {
  const snap = await db.collection('users').doc(uid).get();
  const data = snap.exists ? (snap.data() || {}) : {};
  if (!await isAdminUid(uid) && !isProUser(data, todayIST())) {
    throw Object.assign(new Error('This screenshot feature requires an active Pro plan or trial'), { status: 403 });
  }
  return data;
}

async function joinStudyCircle(actor, body) {
  const uid = actor.uid;
  const code = String(body && body.code || '').trim().toUpperCase();
  const requestedCircleId = String(body && body.circleId || '').trim();
  if (!!code === !!requestedCircleId) {
    throw Object.assign(new Error('provide either an invite code or a public circle ID'), { status: 400 });
  }
  if (code && !/^[A-HJ-NP-Z2-9]{6}$/.test(code)) {
    throw Object.assign(new Error('valid 6-character invite code required'), { status: 400 });
  }
  if (requestedCircleId && !/^[A-Za-z0-9_-]{6,128}$/.test(requestedCircleId)) {
    throw Object.assign(new Error('valid circle ID required'), { status: 400 });
  }

  let circleRef;
  if (code) {
    const codeSnap = await db.collection('studyCircles').where('joinCode', '==', code).limit(2).get();
    if (codeSnap.empty) throw Object.assign(new Error('circle invite code was not found'), { status: 404 });
    if (codeSnap.size !== 1) {
      throw Object.assign(new Error('circle invite code is ambiguous; ask the owner for a new code'), { status: 409 });
    }
    circleRef = codeSnap.docs[0].ref;
  } else {
    circleRef = db.collection('studyCircles').doc(requestedCircleId);
  }

  return db.runTransaction(async transaction => {
    const circleSnap = await transaction.get(circleRef);
    if (!circleSnap.exists) throw Object.assign(new Error('circle was not found'), { status: 404 });
    const circle = circleSnap.data() || {};
    if (code) {
      if (circle.visibility !== 'private' || String(circle.joinCode || '').toUpperCase() !== code) {
        throw Object.assign(new Error('invite code is no longer valid'), { status: 409 });
      }
    } else if (circle.visibility !== 'public' || circle.approvalRequired === true) {
      throw Object.assign(new Error('this circle requires an invite or owner approval'), { status: 403 });
    }

    const memberRef = circleRef.collection('members').doc(uid);
    const memberSnap = await transaction.get(memberRef);
    if (memberSnap.exists) return { circleId: circleRef.id, alreadyMember: true };
    const memberCount = Math.max(0, Number(circle.memberCount) || 0);
    const maxMembers = circle.maxMembers == null ? null : Math.max(0, Number(circle.maxMembers) || 0);
    if (maxMembers !== null && memberCount >= maxMembers) {
      throw Object.assign(new Error('circle is full'), { status: 409 });
    }

    const now = global._fbAdmin.firestore.FieldValue.serverTimestamp();
    transaction.create(memberRef, {
      uid,
      name: String(actor.name || actor.email || 'Learner').slice(0, 100),
      avatar: String(actor.picture || '').slice(0, 2048),
      role: 'member',
      joinedAt: now,
      isPremium: false,
      isFocusing: false,
      weeklyFocusMinutes: 0,
      weekKey: ''
    });
    transaction.set(circleRef.collection('joinRequests').doc(uid), {
      uid,
      status: 'approved',
      respondedAt: now
    }, { merge: true });
    transaction.update(circleRef, {
      memberCount: global._fbAdmin.firestore.FieldValue.increment(1)
    });
    return { circleId: circleRef.id, alreadyMember: false };
  });
}

async function updateStudyCircleVisibility(actor, body) {
  const circleId = String(body && body.circleId || '').trim();
  const visibility = String(body && body.visibility || '').trim();
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(circleId) || !['public', 'private'].includes(visibility)) {
    throw Object.assign(new Error('valid circle and visibility are required'), { status: 400 });
  }

  let freshCode = '';
  if (visibility === 'private') {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let candidate = '';
      for (let index = 0; index < 6; index += 1) {
        candidate += alphabet[crypto.randomInt(0, alphabet.length)];
      }
      const collision = await db.collection('studyCircles').where('joinCode', '==', candidate).limit(1).get();
      if (collision.empty) { freshCode = candidate; break; }
    }
    if (!freshCode) throw Object.assign(new Error('could not allocate a private invite code'), { status: 503 });
  }

  const circleRef = db.collection('studyCircles').doc(circleId);
  await db.runTransaction(async transaction => {
    const snap = await transaction.get(circleRef);
    if (!snap.exists) throw Object.assign(new Error('circle was not found'), { status: 404 });
    const circle = snap.data() || {};
    if (circle.ownerId !== actor.uid) throw Object.assign(new Error('only the circle owner can change visibility'), { status: 403 });
    transaction.update(circleRef, {
      visibility,
      joinCode: visibility === 'private' ? freshCode : '',
      approvalRequired: visibility === 'public' ? !!circle.approvalRequired : false
    });
  });
  return { circleId, visibility, joinCode: freshCode };
}

function referralBonusDays(friendCount) {
  return friendCount > 0 ? 3 : 0;
}

function referralExpiryFrom(profile, bonusDays) {
  const today = new Date(`${todayIST()}T00:00:00.000Z`);
  const existing = profile && /^\d{4}-\d{2}-\d{2}$/.test(String(profile.planExpiry || ''))
    ? new Date(`${profile.planExpiry}T00:00:00.000Z`)
    : today;
  const base = existing > today ? existing : today;
  base.setUTCDate(base.getUTCDate() + bonusDays);
  return base.toISOString().slice(0, 10);
}

/* Referral rewards are privileged entitlement writes. The verified Firebase
   account determines the referee. Eligibility uses one claim per verified,
   newly-created account and a fixed lifetime referrer cap; browser/device
   identifiers are intentionally not trusted as an anti-abuse boundary. */
async function claimReferralReward(refereeUid, rawReferrerUid) {
  const referrerUid = String(rawReferrerUid || '').trim();
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(referrerUid)) {
    throw Object.assign(new Error('valid referral identifier is required'), { status: 400 });
  }
  if (referrerUid === refereeUid) {
    return { rejected: true, reason: 'Self-referrals are not eligible.' };
  }

  const authUser = await global._fbAdmin.auth().getUser(refereeUid);
  const createdMs = Date.parse(authUser.metadata && authUser.metadata.creationTime || '');
  if (!authUser.emailVerified) {
    return { rejected: true, reason: 'Verify your email before claiming a referral reward.' };
  }
  if (!Number.isFinite(createdMs) || Date.now() - createdMs > 24 * 60 * 60 * 1000) {
    return { rejected: true, reason: 'Referral rewards are available only during the first 24 hours of a new account.' };
  }

  const accountRef = db.collection('referral_accounts').doc(refereeUid);
  const referrerRef = db.collection('users').doc(referrerUid);
  const refereeRef = db.collection('users').doc(refereeUid);
  const logRef = db.collection('referral_log').doc(refereeUid);
  const nowIso = new Date().toISOString();
  const maxLifetimeRewards = 10;

  return db.runTransaction(async transaction => {
    const [accountSnap, referrerSnap, refereeSnap] = await Promise.all([
      transaction.get(accountRef), transaction.get(referrerRef), transaction.get(refereeRef)
    ]);
    if (accountSnap.exists) return { duplicate: true };
    if (!referrerSnap.exists || !refereeSnap.exists) {
      return { rejected: true, reason: 'Referral account could not be verified.' };
    }

    const referrerProfile = (referrerSnap.data() || {}).profile || {};
    const refereeProfile = (refereeSnap.data() || {}).profile || {};
    const previousRefCount = Math.max(0, Number(referrerProfile.refCount) || 0);
    if (previousRefCount >= maxLifetimeRewards) {
      return { rejected: true, reason: 'This referrer has reached the lifetime reward limit.' };
    }
    const newRefCount = previousRefCount + 1;
    const bonusDays = referralBonusDays(newRefCount);
    const referralExpiry = referralExpiryFrom(referrerProfile, bonusDays);
    const lifetime = isLifetimePlan(referrerProfile.plan);

    const referrerUpdate = {
      'profile.refCount': newRefCount,
      'profile.referralDaysEarned': Math.max(0, Number(referrerProfile.referralDaysEarned) || 0) + bonusDays,
      'profile.lastReferralBonus': bonusDays,
      'profile.lastReferralDate': nowIso
    };
    if (!lifetime) {
      referrerUpdate['profile.plan'] = 'referral';
      referrerUpdate['profile.planExpiry'] = referralExpiry;
    }
    transaction.update(referrerRef, referrerUpdate);

    const refereeIsPaid = refereeProfile.plan && refereeProfile.plan !== 'free'
      && (isLifetimePlan(refereeProfile.plan) || String(refereeProfile.planExpiry || '') >= todayIST());
    const refereeUpdate = { 'profile.referredBy': referrerUid };
    if (!refereeIsPaid) {
      refereeUpdate['profile.plan'] = 'referral_welcome';
      refereeUpdate['profile.planExpiry'] = addDaysIST(1);
    }
    transaction.update(refereeRef, refereeUpdate);
    transaction.create(accountRef, {
      refereeUid,
      referrerUid,
      eligibility: 'verified-new-account',
      createdAt: global._fbAdmin.firestore.FieldValue.serverTimestamp()
    });
    transaction.set(logRef, {
      referrer: referrerUid,
      referee: refereeUid,
      bonusDays,
      totalRefCount: newRefCount,
      date: nowIso
    });
    return { bonusDays, duplicate: false };
  });
}

function couponExpiryMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

/* Payment amount, coupon eligibility, usage counts and immutable pending
   record creation are computed under Admin credentials. Browser totals are
   display-only and cannot mint discounts or mutate commerce counters. */
async function submitPaymentForUser(actor, body) {
  const uid = actor.uid;
  const planId = String(body.planId || '').trim();
  const rawTxnId = String(body.txnId || '').trim();
  const txnId = rawTxnId.toUpperCase();
  const couponCode = String(body.couponCode || '').trim().toUpperCase();
  const proofBase64 = String(body.proofBase64 || '');
  const proofContentType = String(body.proofContentType || '').toLowerCase();
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(planId) || txnId.length < 6 || txnId.length > 100) {
    throw Object.assign(new Error('valid plan and transaction ID are required'), { status: 400 });
  }
  if (couponCode && !/^[A-Z0-9_-]{2,40}$/.test(couponCode)) {
    throw Object.assign(new Error('invalid coupon code'), { status: 400 });
  }
  if (proofBase64 && !['image/jpeg', 'image/png', 'image/webp'].includes(proofContentType)) {
    throw Object.assign(new Error('payment proof must be a JPEG, PNG, or WebP image'), { status: 400 });
  }

  /* Historical browser-created payments preserved transaction-ID casing.
     Firestore has no case-insensitive equality operator, so querying only raw
     and uppercase variants misses values such as "AbC123". Scan the complete
     legacy field before creating the canonical uniqueness claim. New-vs-new
     races are still serialized by payment_txn_claims inside the transaction. */
  const historicalPayments = await db.collection('payments').select('txnId').get();
  const historicalMatch = historicalPayments.docs.some(doc => {
    const value = String((doc.data() || {}).txnId || '').trim().toUpperCase();
    return value && value === txnId;
  });
  if (historicalMatch) {
    throw Object.assign(new Error('this transaction ID was already submitted'), { status: 409 });
  }

  const planRef = db.collection('plans').doc(planId);
  const userRef = db.collection('users').doc(uid);
  const paymentRef = db.collection('payments').doc();
  let screenshotPath = null;
  let uploadedProof = null;
  if (proofBase64) {
    if (!storageBucket) throw Object.assign(new Error('payment proof storage is unavailable'), { status: 503 });
    let proof;
    try { proof = Buffer.from(proofBase64, 'base64'); }
    catch (error) { throw Object.assign(new Error('invalid payment proof encoding'), { status: 400 }); }
    if (!proof.length || proof.length > 3 * 1024 * 1024) {
      throw Object.assign(new Error('payment proof must be 3 MB or smaller'), { status: 413 });
    }
    const isJpeg = proof[0] === 0xff && proof[1] === 0xd8 && proof[2] === 0xff;
    const isPng = proof.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isWebp = proof.subarray(0, 4).toString() === 'RIFF' && proof.subarray(8, 12).toString() === 'WEBP';
    const detectedType = isJpeg ? 'image/jpeg' : isPng ? 'image/png' : isWebp ? 'image/webp' : '';
    if (!detectedType || detectedType !== proofContentType) {
      throw Object.assign(new Error('payment proof content does not match its image type'), { status: 400 });
    }
    const extension = detectedType === 'image/jpeg' ? 'jpg' : detectedType === 'image/png' ? 'png' : 'webp';
    screenshotPath = `payment_screenshots/${uid}/${paymentRef.id}.${extension}`;
    uploadedProof = storageBucket.file(screenshotPath);
    await uploadedProof.save(proof, {
      resumable: false,
      validation: 'md5',
      metadata: {
        contentType: detectedType,
        cacheControl: 'private,no-store,max-age=0',
        metadata: { ownerUid: uid, paymentId: paymentRef.id }
      }
    });
  }
  const txnHash = crypto.createHash('sha256').update(txnId).digest('hex');
  const claimRef = db.collection('payment_txn_claims').doc(txnHash);
  const couponRef = couponCode ? db.collection('coupons').doc(couponCode) : null;

  try {
    return await db.runTransaction(async transaction => {
    const [planSnap, userSnap, claimSnap] = await Promise.all([
      transaction.get(planRef), transaction.get(userRef), transaction.get(claimRef)
    ]);
    if (!planSnap.exists) throw Object.assign(new Error('selected plan is unavailable'), { status: 400 });
    if (!userSnap.exists) throw Object.assign(new Error('user profile is unavailable'), { status: 404 });
    if (claimSnap.exists) throw Object.assign(new Error('this transaction ID was already submitted'), { status: 409 });

    const plan = planSnap.data() || {};
    const profile = (userSnap.data() || {}).profile || {};
    const originalAmount = Math.max(0, Math.round(Number(plan.price) || 0));
    if (!originalAmount) throw Object.assign(new Error('selected plan has an invalid price'), { status: 400 });

    let coupon = null;
    let percentOff = 0;
    let discountAmount = 0;
    if (couponRef) {
      const couponSnap = await transaction.get(couponRef);
      if (!couponSnap.exists) throw Object.assign(new Error('invalid coupon code'), { status: 400 });
      coupon = couponSnap.data() || {};
      if (coupon.enabled === false) throw Object.assign(new Error('this coupon is disabled'), { status: 400 });
      const expiry = couponExpiryMillis(coupon.expiresAt);
      if (expiry && expiry < Date.now()) throw Object.assign(new Error('this coupon has expired'), { status: 400 });
      if (coupon.maxUses && (Number(coupon.usedCount) || 0) >= Number(coupon.maxUses)) {
        throw Object.assign(new Error('this coupon is fully used'), { status: 409 });
      }
      if (coupon.minAmount && originalAmount < Number(coupon.minAmount)) {
        throw Object.assign(new Error(`minimum plan amount ₹${coupon.minAmount} required`), { status: 400 });
      }
      if (coupon.firstTimeOnly && profile.plan && profile.plan !== 'free') {
        throw Object.assign(new Error('this coupon is only for first-time upgrades'), { status: 400 });
      }
      if (Array.isArray(profile.couponsUsed) && profile.couponsUsed.includes(couponCode)) {
        throw Object.assign(new Error('this coupon was already used by your account'), { status: 409 });
      }
      percentOff = Math.max(1, Math.min(100, Math.round(Number(coupon.percentOff) || 0)));
      discountAmount = Math.round(originalAmount * percentOff / 100);
    }
    const amount = Math.max(1, originalAmount - discountAmount);
    const createdAt = global._fbAdmin.firestore.FieldValue.serverTimestamp();

    transaction.create(claimRef, { uid, paymentId: paymentRef.id, createdAt });
    transaction.create(paymentRef, {
      uid,
      email: String(actor.email || ''),
      planId,
      planName: String(plan.name || planId).slice(0, 120),
      amount,
      originalAmount,
      txnId,
      screenshotPath: screenshotPath || null,
      couponCode: couponCode || null,
      couponPercent: couponCode ? percentOff : null,
      discountAmount,
      status: 'pending',
      createdAt
    });
    if (couponRef) {
      transaction.update(couponRef, {
        usedCount: global._fbAdmin.firestore.FieldValue.increment(1)
      });
      transaction.create(db.collection('coupon_redemptions').doc(paymentRef.id), {
        couponCode, uid, email: String(actor.email || ''), planId,
        planName: String(plan.name || planId).slice(0, 120),
        originalAmount, discountAmount, finalAmount: amount,
        paymentId: paymentRef.id, createdAt
      });
      transaction.update(userRef, {
        'profile.couponsUsed': global._fbAdmin.firestore.FieldValue.arrayUnion(couponCode)
      });
    }
    return { paymentId: paymentRef.id, amount, originalAmount, percentOff, discountAmount };
    });
  } catch (error) {
    if (uploadedProof) {
      try { await uploadedProof.delete({ ignoreNotFound: true }); }
      catch (cleanupError) { console.error('Could not remove orphaned payment proof:', cleanupError.message); }
    }
    throw error;
  }
}

async function paymentProofUrlForAdmin(adminUid, rawPaymentId) {
  if (!await isAdminUid(adminUid)) throw Object.assign(new Error('admin access required'), { status: 403 });
  const paymentId = String(rawPaymentId || '').trim();
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(paymentId)) {
    throw Object.assign(new Error('valid paymentId is required'), { status: 400 });
  }
  const snap = await db.collection('payments').doc(paymentId).get();
  if (!snap.exists) throw Object.assign(new Error('payment not found'), { status: 404 });
  const payment = snap.data() || {};
  if (payment.screenshotPath) {
    if (!storageBucket || !String(payment.screenshotPath).startsWith('payment_screenshots/')) {
      throw Object.assign(new Error('payment proof storage is unavailable'), { status: 503 });
    }
    const [url] = await storageBucket.file(payment.screenshotPath).getSignedUrl({
      action: 'read',
      expires: Date.now() + 5 * 60 * 1000
    });
    return { url, expiresInSeconds: 300 };
  }
  if (payment.screenshotUrl) return { url: payment.screenshotUrl, legacy: true };
  throw Object.assign(new Error('this payment has no screenshot'), { status: 404 });
}

async function startSelfServeTrial(uid) {
  const userRef = db.collection('users').doc(uid);
  return db.runTransaction(async transaction => {
    const snap = await transaction.get(userRef);
    if (!snap.exists) throw Object.assign(new Error('user profile is unavailable'), { status: 404 });
    const data = snap.data() || {};
    const profile = data.profile || {};
    const appState = data.appState || {};
    if (profile.proTrialUsed) {
      throw Object.assign(new Error('the free trial was already used by this account'), { status: 409 });
    }
    if (isProUser(data, todayIST())) {
      throw Object.assign(new Error('this account already has active Pro access'), { status: 409 });
    }

    /* One-time cutover for trials created by the pre-authoritative client.
       Adopt only a bounded, parseable trial, stamp its immutable profile
       marker, and never extend its original expiry. Expired/partial legacy
       markers are recorded as used so they cannot be reset into a fresh trial. */
    const legacy = appState.proTrial && typeof appState.proTrial === 'object' ? appState.proTrial : null;
    if (legacy || appState.proTrialUsed) {
      const started = legacy && new Date(legacy.startedAt);
      const expiry = legacy && /^\d{4}-\d{2}-\d{2}$/.test(String(legacy.expiry || ''))
        ? new Date(`${legacy.expiry}T23:59:59.000Z`)
        : null;
      const validLegacy = started && !Number.isNaN(started.getTime()) && expiry
        && started.getTime() <= Date.now() + 86400000
        && expiry.getTime() <= started.getTime() + 8 * 86400000;
      const marker = validLegacy ? legacy.startedAt : `legacy-used:${new Date().toISOString()}`;
      transaction.update(userRef, {
        'profile.proTrialUsed': true,
        'profile.proTrialStartedAt': marker,
        updatedAt: global._fbAdmin.firestore.FieldValue.serverTimestamp()
      });
      if (validLegacy && expiry.getTime() >= Date.now()) {
        return { trial: legacy, adoptedLegacy: true };
      }
      return { used: true, adoptedLegacy: false };
    }

    const startedAt = new Date().toISOString();
    const expiry = addDaysIST(7);
    const trial = { startedAt, expiry, days: 7 };
    transaction.update(userRef, {
      'profile.proTrialUsed': true,
      'profile.proTrialStartedAt': startedAt,
      'appState.proTrial': trial,
      'appState.proTrialUsed': true,
      updatedAt: global._fbAdmin.firestore.FieldValue.serverTimestamp()
    });
    return { trial };
  });
}

function telegramMediaDocId(uid, fileId) {
  return require('crypto').createHash('sha256').update(uid + '\n' + fileId).digest('hex');
}

function telegramMediaSigningSecret() {
  const explicit = String(process.env.TELEGRAM_MEDIA_SIGNING_SECRET || '').trim();
  if (explicit) return explicit;
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    if (serviceAccount.private_key) return String(serviceAccount.private_key);
  } catch (error) { /* use the bot token fallback */ }
  return String(TOKEN || '');
}

function telegramMediaSignature(uid, fileId) {
  const secret = telegramMediaSigningSecret();
  return require('crypto').createHmac('sha256', secret).update(uid + '\n' + fileId).digest('hex');
}

async function rememberTelegramMediaOwner(uid, fileId, source) {
  if (!db || !uid || !fileId) return false;
  const ref = db.collection('telegram_media_owners').doc(telegramMediaDocId(uid, fileId));
  const signature = telegramMediaSignature(uid, fileId);
  try {
    await ref.create({
      ownerUid: uid,
      fileId,
      source,
      signature,
      createdAt: global._fbAdmin.firestore.FieldValue.serverTimestamp()
    });
    return true;
  } catch (error) {
    try {
      const existing = await ref.get();
      const data = existing.exists ? (existing.data() || {}) : {};
      return data.ownerUid === uid && data.fileId === fileId && data.signature === signature;
    } catch (readError) {
      console.error('telegram media ownership write failed:', error.message);
      return false;
    }
  }
}

/* ── Instant Calculation Practice delivery ─────────────────────────────── */
/* Shared per-identity fixed-window limiter. Firestore-backed so the quota holds
   across restarts and across every instance of this service. */
async function enforceFirestoreRateLimit(collectionName, identity, limit, windowMs, message) {
  const id = crypto.createHash('sha256').update(String(identity)).digest('hex');
  const ref = db.collection(collectionName).doc(id);
  const nowMs = Date.now();
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    const data = snapshot.exists ? (snapshot.data() || {}) : {};
    const startedMs = data.windowStartedAt && typeof data.windowStartedAt.toMillis === 'function'
      ? data.windowStartedAt.toMillis()
      : 0;
    const sameWindow = startedMs > 0 && nowMs - startedMs < windowMs;
    const count = sameWindow ? boundedInteger(data.count, 0, 100000, 0) : 0;
    if (count >= limit) throw Object.assign(new Error(message), { status: 429 });
    transaction.set(ref, {
      identity: String(identity),
      count: count + 1,
      windowStartedAt: global._fbAdmin.firestore.Timestamp.fromMillis(sameWindow ? startedMs : nowMs),
      updatedAt: global._fbAdmin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });
}

async function enforceCalculationPresetRateLimit(uid) {
  await enforceFirestoreRateLimit('calculationPresetSendRates', uid, 5, 60000,
    'Too many sends. Wait one minute and try again.');
}

function positivePrivateChatId(value) {
  const chatId = String(value == null ? '' : value).trim();
  return /^\d+$/.test(chatId) && Number(chatId) > 0 ? chatId : '';
}

function escapeTelegramHtml(value) {
  return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function boundedInteger(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

function sanitizeCalculationPreset(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const settings = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  let multFrom = boundedInteger(settings.multFrom, 1, 100, 2);
  let multTo = boundedInteger(settings.multTo, 1, 100, 9);
  let multiplierFrom = boundedInteger(settings.multiplierFrom, 1, 100, 1);
  let multiplierTo = boundedInteger(settings.multiplierTo, 1, 100, 10);
  if (multTo < multFrom) [multFrom, multTo] = [multTo, multFrom];
  if (multiplierTo < multiplierFrom) [multiplierFrom, multiplierTo] = [multiplierTo, multiplierFrom];
  const quizIds = Array.isArray(raw.quizIds)
    ? raw.quizIds.map(id => String(id || '').slice(0, 32)).filter(id => ['mult1', 'mult2', 'mult3', 'tablewrite'].includes(id))
    : [];
  return {
    id: String(raw.id || '').slice(0, 80),
    name: String(raw.name || 'Calculation Practice').trim().slice(0, 40) || 'Calculation Practice',
    icon: String(raw.icon || '🧮').slice(0, 4),
    questionCount: boundedInteger(raw.questionCount, 3, 50, 10),
    difficulty: ['easy', 'standard', 'exam', 'custom'].includes(raw.difficulty) ? raw.difficulty : 'standard',
    hasTables: quizIds.length > 0,
    multFrom,
    multTo,
    multiplierFrom,
    multiplierTo
  };
}

function canonicalPresetJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalPresetJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalPresetJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function calculationPresetFingerprint(preset) {
  return crypto.createHash('sha256').update(canonicalPresetJson(preset)).digest('hex');
}

function calculationPresetText(preset) {
  const difficulty = preset.difficulty === 'exam'
    ? 'Exam'
    : preset.difficulty.charAt(0).toUpperCase() + preset.difficulty.slice(1);
  let detail = `${preset.questionCount} questions · ${escapeTelegramHtml(difficulty)}`;
  if (preset.hasTables) {
    const tables = preset.multFrom === preset.multTo ? `Table ${preset.multFrom}` : `Tables ${preset.multFrom}–${preset.multTo}`;
    detail += `\n${tables} · ×${preset.multiplierFrom} to ×${preset.multiplierTo}`;
  }
  return `🧮 <b>Calculation Practice</b>\n${escapeTelegramHtml(preset.icon)} <b>${escapeTelegramHtml(preset.name)}</b>\n${detail}\n\nYour practice preset is ready.`;
}

/* Launch buttons for a practice preset.
   `web_app` opens the Mini App inside Telegram and is only valid over HTTPS in
   private chats, so it is added conditionally; the plain URL button stays as a
   fallback for clients that cannot open Mini Apps. */
function calculationPracticeButtons(appBase, presetId, options) {
  const base = String(appBase || FALLBACK_APP_BASE_URL).replace(/\/+$/, '');
  const encodedPreset = encodeURIComponent(presetId);
  const rows = [];
  if (/^https:\/\//i.test(base) && !(options && options.browserOnly)) {
    rows.push([{
      text: '▶ Practice here',
      web_app: { url: `${base}/calc/index.html?tgpreset=${encodedPreset}` }
    }]);
  }
  rows.push([{ text: '🌐 Open in browser', url: `${base}/app.html?open=calc&preset=${encodedPreset}` }]);
  return rows;
}

/* A Mini App button Telegram refuses would otherwise fail the whole message and
   lose the reminder, so fall back to the plain URL keyboard once. */
function isTelegramButtonRejection(description) {
  return /BUTTON|WEB_?APP|url invalid/i.test(String(description || ''));
}

function calculationPresetRequestRef(uid, requestId) {
  const id = crypto.createHash('sha256').update(`${uid}\n${requestId}`).digest('hex');
  return db.collection('calculationPresetSendRequests').doc(id);
}

async function claimCalculationPresetRequest(uid, presetId, requestId, presetFingerprint) {
  const ref = calculationPresetRequestRef(uid, requestId);
  try {
    await ref.create({
      uid,
      presetId,
      requestId,
      presetFingerprint,
      status: 'sending',
      createdAt: global._fbAdmin.firestore.FieldValue.serverTimestamp(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
    });
    return { ref, duplicate: false };
  } catch (error) {
    const existing = await ref.get();
    const data = existing.exists ? (existing.data() || {}) : {};
    const sameRequest = data.uid === uid && data.requestId === requestId && data.presetId === presetId && data.presetFingerprint === presetFingerprint;
    if (sameRequest && data.status === 'sent') {
      return { ref, duplicate: true };
    }
    if (existing.exists) {
      const failed = sameRequest && data.status === 'failed';
      const changed = !sameRequest;
      throw Object.assign(new Error(changed
        ? 'This preset changed after the send started. Press Send to Telegram again for the new version.'
        : failed
          ? 'That send attempt failed. Press Send to Telegram again to retry.'
          : 'This preset send is already being processed. Check Telegram before trying a new send.'), {
        status: 409,
        retryWithNewRequest: changed || failed
      });
    }
    throw error;
  }
}

async function sendCalculationPresetForUser(uid, presetId, requestId, presetFingerprint, appBaseUrl) {
  const userSnapshot = await db.collection('users').doc(uid).get();
  if (!userSnapshot.exists) throw Object.assign(new Error('User profile not found.'), { status: 404 });
  const userData = userSnapshot.data() || {};
  if (!await isAdminUid(uid) && !isProUser(userData, todayIST())) {
    throw Object.assign(new Error('Instant Telegram practice delivery requires an active Pro plan or trial.'), { status: 403 });
  }
  const appState = userData.appState && typeof userData.appState === 'object' ? userData.appState : {};
  const telegram = appState.telegram && typeof appState.telegram === 'object' ? appState.telegram : {};
  const chatId = positivePrivateChatId(telegram.chatId);
  if (telegram.enabled !== true || !chatId) {
    throw Object.assign(new Error('Enable Telegram and save your positive private Chat ID in Study Profile first.'), { status: 400 });
  }
  const linkSnapshot = await db.collection('telegram_links').doc(chatId).get();
  const link = linkSnapshot.exists ? (linkSnapshot.data() || {}) : {};
  if (!linkSnapshot.exists || link.uid !== uid) {
    throw Object.assign(new Error('Reconnect Telegram: open the bot from Study Profile, press Start, then save your private Chat ID.'), { status: 409 });
  }
  const calculation = appState.calculationPractice && typeof appState.calculationPractice === 'object'
    ? appState.calculationPractice
    : {};
  const presets = Array.isArray(calculation.presets) ? calculation.presets : [];
  const rawPreset = presets.find(preset => preset && preset.id === presetId);
  if (!rawPreset) throw Object.assign(new Error('Saved preset not found. Sync it and try again.'), { status: 404 });

  if (calculationPresetFingerprint(rawPreset) !== presetFingerprint) {
    throw Object.assign(new Error('This preset is still syncing. Wait a moment and press Send to Telegram again.'), {
      status: 409,
      retryWithNewRequest: false
    });
  }
  const claim = await claimCalculationPresetRequest(uid, presetId, requestId, presetFingerprint);
  if (claim.duplicate) return { duplicate: true };

  const preset = sanitizeCalculationPreset(rawPreset);
  const practiceBase = String(appBaseUrl || FALLBACK_APP_BASE_URL).replace(/\/+$/, '');
  let sent;
  try {
    const send = rows => bot.sendMessage(chatId, calculationPresetText(preset), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: rows }
    });
    try {
      sent = await send(calculationPracticeButtons(practiceBase, preset.id));
    } catch (buttonError) {
      const description = (buttonError && buttonError.response && buttonError.response.body
        && buttonError.response.body.description) || buttonError.message;
      if (!isTelegramButtonRejection(description)) throw buttonError;
      console.warn(`⚠️  Telegram refused the Mini App button (${description}) — sending the browser link instead.`);
      sent = await send(calculationPracticeButtons(practiceBase, preset.id, { browserOnly: true }));
    }
  } catch (error) {
    const responseBody = error && error.response && error.response.body ? error.response.body : null;
    const explicitRejection = !!(responseBody && (responseBody.ok === false || responseBody.error_code));
    const telegramError = (responseBody && responseBody.description) || error.message || 'Telegram send failed';
    await claim.ref.update({
      status: explicitRejection ? 'failed' : 'uncertain',
      finishedAt: global._fbAdmin.firestore.FieldValue.serverTimestamp(),
      error: String(telegramError).slice(0, 200)
    }).catch(() => {});
    if (!explicitRejection) {
      throw Object.assign(new Error('Telegram delivery status is uncertain. Check Telegram before trying again.'), { status: 502, retryWithNewRequest: false });
    }
    if (/chat not found|bot was blocked|user is deactivated/i.test(telegramError)) {
      throw Object.assign(new Error('Telegram could not reach this private chat. Reconnect the bot and try again.'), { status: 409, retryWithNewRequest: true });
    }
    throw Object.assign(new Error('Telegram rejected the delivery. Try again shortly.'), { status: 502, retryWithNewRequest: true });
  }

  try {
    await claim.ref.update({
      status: 'sent',
      sentAt: global._fbAdmin.firestore.FieldValue.serverTimestamp(),
      telegramMessageId: sent && sent.message_id ? String(sent.message_id) : '',
      error: null
    });
  } catch (error) {
    // Telegram already accepted the message. Keep the claim in "sending" so
    // the same request ID cannot send a duplicate if acknowledgement storage
    // is temporarily unavailable, but still report delivery success to the UI.
    console.error(`⚠️ Instant preset sent but idempotency acknowledgement failed for uid:${uid}: ${error.message}`);
  }
  console.log(`✅ Instant calculation preset → uid:${uid} preset:${preset.id}`);
  return { duplicate: false };
}

/* ── /calc — start Calculation Practice from the chat ─────────────────────────
   Every other practice delivery is push-only: the scheduled reminder
   (scripts/send-calculation-reminders.js) and the app's "Send to Telegram"
   button both decide *when* a session arrives. A user who missed the reminder,
   or who wants a second round, had no way to open one from Telegram. This is
   the pull equivalent, and it deliberately reuses the reminder's presentation
   (`calculationPresetText` + `calculationPracticeButtons`) so a preset looks
   the same however it arrives.

   Question generation stays in the Mini App: the QUIZZES engines live in an
   inline <script> in calc/index.html and cannot be required here, so this hands
   over a preset id and nothing more — exactly like the other delivery paths.

   Authorization goes through `miniAppAccountForTelegramUser` (both halves of
   the link must agree) rather than `findUserByChatId`, whose link-map fallback
   would let anyone holding a shareable `?start=<uid>` link read another
   account's preset names and settings.

   No idempotency claim: `claimCalculationPresetRequest` exists to stop the
   browser button double-submitting, whereas a typed command *is* the user
   asking again on purpose. The rate limit is the right control here. */
const CALC_PRESET_LIST_LIMIT = 10;

/* Button labels are plain text, not HTML — escaping them here would surface a
   literal "&amp;" on the button, so `escapeTelegramHtml` is deliberately absent. */
function calculationPresetButtonLabel(preset) {
  const icon = String((preset && preset.icon) || '🧮').slice(0, 4);
  const name = String((preset && preset.name) || 'Practice').trim().slice(0, 40) || 'Practice';
  return `▶ ${icon} ${name}`;
}

/* A plain text list made the user retype a name to start anything, which is
   painful on a phone and worse for a name like "Mixed Practice (8 presets)".
   One button per preset starts that quiz inside Telegram in a single tap.

   `web_app` is the right button type here: the Bot API caps `callback_data` at
   64 bytes, and a preset id may be up to 80 characters, so a callback round trip
   would need an extra id→index mapping to stay inside the limit. A `web_app`
   button carries the id in its URL and needs none. It is private-chat only,
   which every caller of this already is. */
function calculationPresetListButtons(presets, appBase, options) {
  const base = String(appBase || FALLBACK_APP_BASE_URL).replace(/\/+$/, '');
  const miniAppAllowed = /^https:\/\//i.test(base) && !(options && options.browserOnly);
  const rows = presets.slice(0, CALC_PRESET_LIST_LIMIT).map(preset => {
    const label = calculationPresetButtonLabel(preset);
    const encodedPreset = encodeURIComponent(preset.id);
    return [miniAppAllowed
      ? { text: label, web_app: { url: `${base}/calc/index.html?tgpreset=${encodedPreset}` } }
      : { text: label, url: `${base}/app.html?open=calc&preset=${encodedPreset}` }];
  });
  /* One shared browser row, not a second button beside every preset: ten presets
     would otherwise be twenty buttons. Skipped in browserOnly mode, where every
     row is already a plain link. */
  if (rows.length && miniAppAllowed) {
    rows.push([{ text: '🌐 Open in browser', url: `${base}/app.html?open=calc` }]);
  }
  return rows;
}

/* Shown only when the list is truncated, so the remaining presets are still
   reachable by name rather than silently missing. */
function calculationPresetOverflowNote(presets) {
  return presets.length > CALC_PRESET_LIST_LIMIT
    ? `\n\n(Pehle ${CALC_PRESET_LIST_LIMIT} dikhaye hain — baaki ke liye <code>/calc &lt;name&gt;</code> bhejo.)`
    : '';
}

/* Matching stays forgiving because the name is retyped from memory on a phone
   keyboard: an exact id wins, then an exact name, then a unique prefix, then a
   unique substring. A term that stays ambiguous asks rather than guessing,
   since silently practising the wrong preset wastes the session. */
function findCalculationPreset(presets, query) {
  const term = String(query || '').trim().toLowerCase();
  if (!term) return { preset: null, matches: [] };
  const byId = presets.find(preset => String(preset.id || '').toLowerCase() === term);
  if (byId) return { preset: byId, matches: [byId] };
  const nameOf = preset => String(preset.name || '').trim().toLowerCase();
  const tiers = [
    presets.filter(preset => nameOf(preset) === term),
    presets.filter(preset => nameOf(preset).startsWith(term)),
    presets.filter(preset => nameOf(preset).includes(term))
  ];
  for (const candidates of tiers) {
    if (candidates.length === 1) return { preset: candidates[0], matches: candidates };
    if (candidates.length > 1) return { preset: null, matches: candidates };
  }
  return { preset: null, matches: [] };
}

/* Same Mini App fallback as sendCalculationPresetForUser: a web_app button
   Telegram refuses must not cost the user the whole message, so build the rows
   through a callback and resend once with plain links if it is rejected. */
async function sendWithMiniAppFallback(chatId, body, rowsFor) {
  const send = rows => {
    const options = { parse_mode: 'HTML', disable_web_page_preview: true };
    if (rows && rows.length) options.reply_markup = { inline_keyboard: rows };
    return bot.sendMessage(chatId, body, options);
  };
  try {
    return await send(rowsFor(undefined));
  } catch (buttonError) {
    const description = (buttonError && buttonError.response && buttonError.response.body
      && buttonError.response.body.description) || buttonError.message;
    if (!isTelegramButtonRejection(description)) throw buttonError;
    console.warn(`⚠️  Telegram refused the Mini App button (${description}) — sending browser links instead.`);
    return send(rowsFor({ browserOnly: true }));
  }
}

function sendCalculationPracticeMessage(chatId, preset, note) {
  const body = calculationPresetText(preset) + (note ? `\n\n${note}` : '');
  return sendWithMiniAppFallback(chatId, body, options =>
    calculationPracticeButtons(FALLBACK_APP_BASE_URL, preset.id, options));
}

function sendCalculationPresetList(chatId, body, presets) {
  return sendWithMiniAppFallback(chatId, body + calculationPresetOverflowNote(presets), options =>
    calculationPresetListButtons(presets, FALLBACK_APP_BASE_URL, options));
}

bot.onText(/^\/calc(?:@\w+)?(?:\s+([\s\S]+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const query = match && match[1] ? String(match[1]).slice(0, 60) : '';

  /* Mini App buttons are only valid in private chats, and a preset list is the
     user's own data — neither belongs in a group. */
  if (msg.chat.type !== 'private') {
    bot.sendMessage(chatId, '⚠️ <b>/calc</b> sirf private chat mein chalta hai — mujhe DM karo.',
      { parse_mode: 'HTML' }).catch(() => {});
    return;
  }
  /* Not the user's fault and nothing they can do, so say so rather than leaving
     them retrying — and leave a trace, since this path used to log nothing at
     all and the failure was invisible server-side. */
  if (!db) {
    console.error(`❌ /calc unavailable — Firestore is not configured (${FIRESTORE_STATUS.code}). See /health.`);
    bot.sendMessage(chatId,
      '⚠️ <b>Server-side dikkat hai</b> — bot ka database connection missing hai, is liye main tumhare ' +
      'saved presets padh nahi sakta. Yeh tumhari galti nahi hai, admin ko bata do.\n\n' +
      'Tab tak app ke <b>Calculation</b> tab se practice kar sakte ho.',
      { parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => {});
    return;
  }

  try {
    await enforceFirestoreRateLimit('calculationCommandRates', String(msg.from.id), 6, 60000,
      'Bahut zyada requests. Ek minute wait karke dobara try karo.');
    const account = await miniAppAccountForTelegramUser(msg.from.id);
    const appState = account.data.appState && typeof account.data.appState === 'object' ? account.data.appState : {};
    const calculation = appState.calculationPractice && typeof appState.calculationPractice === 'object'
      ? appState.calculationPractice
      : {};
    const presets = (Array.isArray(calculation.presets) ? calculation.presets : []).filter(preset => preset && preset.id);

    if (!presets.length) {
      await bot.sendMessage(chatId,
        '🧮 <b>Koi practice preset nahi mila.</b>\n\nApp mein <b>Calculation</b> tab kholo, ek preset banao ' +
        '(ya template use karo), phir yahan <code>/calc</code> bhejo.',
        { parse_mode: 'HTML', disable_web_page_preview: true });
      return;
    }

    let preset;
    if (query) {
      const found = findCalculationPreset(presets, query);
      if (!found.preset) {
        const ambiguous = found.matches.length > 0;
        const heading = ambiguous
          ? `🤔 "<b>${escapeTelegramHtml(query)}</b>" se ek se zyada preset match hue — kaunsa chahiye?`
          : `🤔 "<b>${escapeTelegramHtml(query)}</b>" naam ka koi preset nahi mila.\nTap karke koi bhi shuru karo:`;
        await sendCalculationPresetList(chatId, heading, ambiguous ? found.matches : presets);
        return;
      }
      preset = found.preset;
    } else {
      /* One preset needs no disambiguation, so treat it as the default even
         when the user never marked a daily one. */
      preset = presets.find(item => item.id === calculation.dailyPresetId)
        || (presets.length === 1 ? presets[0] : null);
      if (!preset) {
        /* The old footer said "send /calc for your daily preset" to someone who
           had just sent /calc and had no daily preset. Point at the setting that
           actually makes this one tap instead. */
        await sendCalculationPresetList(chatId,
          '🧮 <b>Kaunsi practice karni hai?</b>\nTap karke Telegram mein hi shuru ho jao.\n\n'
          + '⭐ App ke <b>Calculation</b> tab mein kisi preset ko <b>Daily</b> mark kar do — '
          + 'phir sirf <code>/calc</code> bhejna kaafi hoga.',
          presets);
        return;
      }
    }

    /* `history` is written by the browser against its own local day, which for
       these users is IST — the same key todayIST() produces. Mini App attempts
       land in `calculationAttemptInbox` first, so a session finished inside
       Telegram only counts here once the app drains it; the note is a nudge,
       never a gate, so a stale read costs nothing. */
    const history = Array.isArray(calculation.history) ? calculation.history : [];
    const doneToday = history.some(entry => entry && entry.presetId === preset.id
      && entry.date === todayIST() && entry.reason === 'completed');
    const note = doneToday ? '✅ Aaj yeh preset already complete ho chuka hai — yeh bonus round hai.' : '';

    await sendCalculationPracticeMessage(chatId, sanitizeCalculationPreset(preset), note);
    console.log(`✅ /calc → uid:${account.uid} preset:${preset.id}`);
  } catch (error) {
    /* The thrown statuses carry copy written for the user (reconnect hints, Pro
       upsell, rate limit); anything else is ours and must not leak. */
    const actionable = [400, 403, 409, 429].includes(error && error.status);
    if (!actionable) console.error('❌ /calc error:', (error && error.message) || error);
    const message = actionable ? error.message : 'Practice bhejne mein dikkat hui. Thodi der baad try karo.';
    bot.sendMessage(chatId, `⚠️ ${escapeTelegramHtml(message)}`, { parse_mode: 'HTML' }).catch(() => {});
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   READ-ONLY ACCOUNT COMMANDS
   ─────────────────────────────────────────────────────────────────────────────
   /status /plan /pending /exam /stats /streak /mock — everything the app already
   stores, answered in the chat. None of them write user state: appState belongs
   to the browser, and a direct write from here can be clobbered by any open tab
   (the reason telegramInbox and calculationAttemptInbox exist).

   They share one preamble — private chat, Firestore up, rate limit, the strict
   both-halves account link — so it lives in registerAccountCommand() rather than
   being restated seven times, and each handler is only about its own message.
   ════════════════════════════════════════════════════════════════════════════ */

/* Task and video extraction is the same logic the scheduled digests use. It is
   imported rather than reimplemented so a chat reply can never disagree with the
   6 AM message about what is still pending. */
const tgLib = require('../scripts/telegram-lib');

function accountAppState(account) {
  return account && account.data && typeof account.data.appState === 'object' && account.data.appState
    ? account.data.appState
    : {};
}

function accountCalculation(account) {
  const calculation = accountAppState(account).calculationPractice;
  return calculation && typeof calculation === 'object' ? calculation : {};
}

/* Firestore stores dates as plain "YYYY-MM-DD", so day arithmetic is done at
   noon UTC to stay clear of DST and timezone edges. */
function daysBetweenDates(fromDate, toDate) {
  const from = Date.parse(`${fromDate}T12:00:00Z`);
  const to = Date.parse(`${toDate}T12:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / 86400000);
}

function isDateString(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function registerAccountCommand(options) {
  const { name, regex, limit, build } = options;
  bot.onText(regex, async (msg, match) => {
    const chatId = msg.chat.id;
    if (msg.chat.type !== 'private') {
      bot.sendMessage(chatId, `⚠️ <b>/${name}</b> sirf private chat mein chalta hai — mujhe DM karo.`,
        { parse_mode: 'HTML' }).catch(() => {});
      return;
    }
    if (!db) {
      console.error(`❌ /${name} unavailable — Firestore is not configured (${FIRESTORE_STATUS.code}). See /health.`);
      bot.sendMessage(chatId,
        '⚠️ <b>Server-side dikkat hai</b> — bot ka database connection missing hai. '
        + 'Yeh tumhari galti nahi hai, admin ko bata do.',
        { parse_mode: 'HTML' }).catch(() => {});
      return;
    }
    try {
      await enforceFirestoreRateLimit(`command:${name}`, String(msg.from.id), limit || 6, 60000,
        'Bahut zyada requests. Ek minute wait karke dobara try karo.');
      const account = await miniAppAccountForTelegramUser(msg.from.id);
      const argument = match && match[1] ? String(match[1]).slice(0, 200).trim() : '';
      const reply = await build(account, argument, msg);
      if (!reply) return;
      const body = typeof reply === 'string' ? reply : reply.text;
      const sendOptions = { parse_mode: 'HTML', disable_web_page_preview: true };
      if (reply && reply.rows && reply.rows.length) sendOptions.reply_markup = { inline_keyboard: reply.rows };
      try {
        await bot.sendMessage(chatId, body, sendOptions);
      } catch (sendError) {
        /* Older Telegram clients can reject a web_app keyboard. Keep the
           command useful by retrying once with the ordinary browser URL. */
        if (!reply || !Array.isArray(reply.fallbackRows)
            || !isTelegramButtonRejection(sendError && sendError.message)) throw sendError;
        const fallbackOptions = {
          parse_mode: 'HTML',
          disable_web_page_preview: true
        };
        if (reply.fallbackRows.length) {
          fallbackOptions.reply_markup = { inline_keyboard: reply.fallbackRows };
        }
        await bot.sendMessage(chatId, body, fallbackOptions);
      }
      console.log(`✅ /${name} → uid:${account.uid}`);
    } catch (error) {
      const actionable = [400, 403, 409, 429].includes(error && error.status);
      if (!actionable) console.error(`❌ /${name} error:`, (error && error.message) || error);
      const message = actionable ? error.message : 'Kuch galat ho gaya. Thodi der baad try karo.';
      bot.sendMessage(chatId, `⚠️ ${escapeTelegramHtml(message)}`, { parse_mode: 'HTML' }).catch(() => {});
    }
  });
}

/* ── /status ──────────────────────────────────────────────────────────────
   Written for self-diagnosis. Every confusing report so far — Firestore down,
   duplicate bot instances, no daily preset, a digest the browser never
   refreshed — is visible in these six lines, so the user can see the cause
   without anyone reading a server log. */
function buildStatusMessage(account) {
  const today = todayIST();
  const appState = accountAppState(account);
  const profile = account.data.profile && typeof account.data.profile === 'object' ? account.data.profile : {};
  const telegram = appState.telegram && typeof appState.telegram === 'object' ? appState.telegram : {};
  const calculation = accountCalculation(account);
  const lines = ['🩺 <b>Status</b>', ''];

  lines.push(`📡 Telegram: <b>connected</b> ✓  <code>${escapeTelegramHtml(String(telegram.chatId || ''))}</code>`);

  /* Mirrors shared/proGating.js, which is the gate itself — this only explains
     the outcome, it never decides it. */
  const trial = appState.proTrial && typeof appState.proTrial === 'object' ? appState.proTrial : {};
  let plan;
  if (profile.plan && profile.plan !== 'free' && isLifetimePlan(profile.plan)) {
    plan = `<b>${escapeTelegramHtml(profile.plan)}</b> · lifetime`;
  } else if (profile.plan && profile.plan !== 'free' && profile.planExpiry) {
    const left = daysBetweenDates(today, profile.planExpiry);
    plan = `<b>${escapeTelegramHtml(profile.plan)}</b> · ${left != null && left >= 0 ? `${left} din baaki` : 'expired'}`;
  } else if (profile.trialExpiry && !profile.trialSuspended) {
    const left = daysBetweenDates(today, profile.trialExpiry);
    plan = `trial · ${left != null && left >= 0 ? `${left} din baaki` : 'expired'}`;
  } else if (trial.expiry) {
    const left = daysBetweenDates(today, trial.expiry);
    plan = `free trial · ${left != null && left >= 0 ? `${left} din baaki` : 'expired'}`;
  } else {
    plan = 'free';
  }
  lines.push(`💳 Plan: ${plan}`);

  const presets = Array.isArray(calculation.presets) ? calculation.presets : [];
  const daily = presets.find(preset => preset && preset.id === calculation.dailyPresetId);
  lines.push(`🧮 Daily preset: ${daily
    ? `<b>${escapeTelegramHtml(String(daily.name || 'Practice'))}</b>`
    : `<i>set nahi hai</i> — <code>/calc</code> se choose karo`}`);

  /* The digest is precomputed in the browser, so a stale one means the app has
     not been opened — not that nothing is scheduled. Saying which it is here is
     the whole point. */
  const digest = telegram.digest && typeof telegram.digest === 'object' ? telegram.digest : {};
  const digestDates = Object.keys(digest).filter(isDateString).sort();
  const newestDigest = digestDates.length ? digestDates[digestDates.length - 1] : '';
  if (digest[today]) {
    lines.push('📋 Aaj ka plan: <b>ready</b> ✓');
  } else if (newestDigest) {
    lines.push(`📋 Aaj ka plan: <i>missing</i> — app ne last ${escapeTelegramHtml(tgLib.fmtDM(newestDigest))} tak banaya tha. App kholo.`);
  } else {
    lines.push('📋 Aaj ka plan: <i>kabhi banaya nahi</i> — ek baar app kholo.');
  }

  const history = Array.isArray(calculation.history) ? calculation.history : [];
  const lastSession = history.find(entry => entry && isDateString(entry.date));
  lines.push(`🎯 Last practice: ${lastSession
    ? `${escapeTelegramHtml(tgLib.fmtDM(lastSession.date))} · ${calculationAccuracy(lastSession)}%`
    : '<i>abhi tak koi nahi</i>'}`);

  const examDate = isDateString(appState.examDate) ? appState.examDate : '';
  if (examDate) {
    const left = daysBetweenDates(today, examDate);
    lines.push(`📅 Exam: ${escapeTelegramHtml(tgLib.fmtDM(examDate))}${left != null && left >= 0 ? ` · ${left} din baaki` : ''}`);
  }

  lines.push('', `🤖 Bot: Firestore <b>${FIRESTORE_STATUS.code}</b> · ${escapeTelegramHtml(describeInstance())}`);
  return lines.join('\n');
}

/* ── /plan and /pending ───────────────────────────────────────────────────
   The same sections the 6 AM and evening jobs send, on demand — built with the
   senders' own helpers so the three can never disagree. */
function buildPlanMessage(account) {
  const today = todayIST();
  const appState = accountAppState(account);
  const telegram = appState.telegram && typeof appState.telegram === 'object' ? appState.telegram : {};
  const digest = telegram.digest && typeof telegram.digest === 'object' ? telegram.digest : {};
  const sections = [`📅 <b>Aaj ka plan</b> — ${escapeTelegramHtml(tgLib.fmtDM(today))}`];

  if (digest[today]) {
    sections.push(`📚 <b>Study topics</b>\n${escapeTelegramHtml(String(digest[today]).slice(0, 2000))}`);
  }

  const { todoLines, videoItems, doneCount } = tgLib.buildTaskSections(appState, today);
  if (todoLines.length) sections.push(`📝 <b>To-Do</b>\n${tgLib.capLines(todoLines, 12)}`);
  if (videoItems.length) {
    sections.push(`🎥 <b>Videos</b>\n${tgLib.capLines(videoItems.map(video => `▶ <a href="${video.url}">${tgLib.escHtml(video.title)}</a>`), 10)}`);
  }
  if (doneCount) sections.push(`✅ ${doneCount} already done`);

  if (sections.length === 1) {
    /* Distinguish "nothing scheduled" from "the app never built a digest",
       because the fix is different and only the user can do it. */
    sections.push(Object.keys(digest).filter(isDateString).length
      ? '📭 Aaj ke liye kuch scheduled nahi hai.\nPlanner mein topics add karke Save karo.'
      : '📭 Abhi tak koi plan nahi bana.\nEk baar app kholo — plan yahan aa jayega.');
  }
  return sections.join('\n\n');
}

function buildPendingMessage(account) {
  const today = todayIST();
  const appState = accountAppState(account);
  const { todoLines, videoItems, doneCount } = tgLib.buildTaskSections(appState, today);
  if (!todoLines.length && !videoItems.length) {
    return doneCount
      ? `🎉 <b>Sab complete!</b>\nAaj ke ${doneCount} kaam ho gaye. Shabaash!`
      : '📭 Aaj kuch track nahi hua hai. Planner mein tasks add karo.';
  }
  const sections = [`⏳ <b>Kya baaki hai</b> — ${escapeTelegramHtml(tgLib.fmtDM(today))}`];
  if (todoLines.length) sections.push(`📝 <b>Pending</b>\n${tgLib.capLines(todoLines, 12)}`);
  if (videoItems.length) {
    sections.push(`🎥 <b>Videos pending</b>\n${tgLib.capLines(videoItems.map(video => `▶ <a href="${video.url}">${tgLib.escHtml(video.title)}</a>`), 10)}`);
  }
  if (doneCount) sections.push(`✅ ${doneCount} done`);
  return sections.join('\n\n');
}

/* ── /exam ───────────────────────────────────────────────────────────────
   `currentExam` is a browser global and never reaches Firestore, so
   appState.examDate is the only reliable "my exam" here; examDates holds the
   per-exam map the app maintains alongside it. */
function buildExamMessage(account) {
  const today = todayIST();
  const appState = accountAppState(account);
  const primary = isDateString(appState.examDate) ? appState.examDate : '';
  const examDates = appState.examDates && typeof appState.examDates === 'object' ? appState.examDates : {};
  const others = Object.keys(examDates)
    .filter(exam => isDateString(examDates[exam]) && examDates[exam] !== primary && examDates[exam] >= today)
    .sort((left, right) => (examDates[left] < examDates[right] ? -1 : 1))
    .slice(0, 5);

  if (!primary && !others.length) {
    return '📅 <b>Koi exam date set nahi hai.</b>\n\nApp ke <b>Profile</b> mein exam date daal do — phir countdown yahan milega.';
  }

  const lines = ['📅 <b>Exam countdown</b>', ''];
  if (primary) {
    const left = daysBetweenDates(today, primary);
    if (left === null) {
      lines.push(`Date: ${escapeTelegramHtml(primary)}`);
    } else if (left > 0) {
      lines.push(`⏳ <b>${left}</b> din baaki — ${escapeTelegramHtml(tgLib.fmtDM(primary))}`);
      const weeks = Math.floor(left / 7);
      if (weeks >= 1) lines.push(`(${weeks} hafte${weeks > 1 ? '' : ''}${left % 7 ? ` ${left % 7} din` : ''})`);
    } else if (left === 0) {
      lines.push('🔥 <b>Aaj exam hai!</b> All the best!');
    } else {
      lines.push(`✅ Exam ho gaya (${escapeTelegramHtml(tgLib.fmtDM(primary))}).`);
    }
  }
  if (others.length) {
    lines.push('', '<b>Aage aane wale</b>');
    others.forEach(exam => {
      const left = daysBetweenDates(today, examDates[exam]);
      lines.push(`• ${escapeTelegramHtml(exam.toUpperCase())} — ${escapeTelegramHtml(tgLib.fmtDM(examDates[exam]))}${left != null ? ` · ${left} din` : ''}`);
    });
  }
  return lines.join('\n');
}

/* ── /stats and /streak ──────────────────────────────────────────────────
   Mirrors accuracy() and calculateStreak() in calc/presets.js. Attempts made
   inside the Mini App land in calculationAttemptInbox and only join `history`
   once the app drains them, so those are reported as pending instead of being
   silently missing from the totals. */
function calculationAccuracy(entry) {
  const total = Math.max(1, Number(entry && entry.total) || 1);
  const correct = Math.max(0, Number(entry && entry.firstTryCorrect) || 0);
  return Math.round((correct / total) * 100);
}

function calculationStreak(history, today) {
  const completed = new Set(history
    .filter(entry => entry && entry.reason === 'completed' && isDateString(entry.date))
    .map(entry => entry.date));
  let streak = 0;
  let cursor = today;
  while (completed.has(cursor)) {
    streak++;
    cursor = tgLib.shiftDate(cursor, -1);
  }
  return streak;
}

function buildStatsMessage(account) {
  const today = todayIST();
  const calculation = accountCalculation(account);
  const history = (Array.isArray(calculation.history) ? calculation.history : [])
    .filter(entry => entry && isDateString(entry.date));
  const pending = Array.isArray(account.data.calculationAttemptInbox) ? account.data.calculationAttemptInbox.length : 0;

  if (!history.length) {
    return '📊 <b>Abhi tak koi practice session nahi.</b>\n\n<code>/calc</code> bhejo aur pehla session shuru karo.'
      + (pending ? `\n\n(${pending} attempt sync hone baaki hain — app kholo.)` : '');
  }

  const streak = calculationStreak(history, today);
  const sessions = history.length;
  const average = Math.round(history.reduce((sum, entry) => sum + calculationAccuracy(entry), 0) / sessions);
  const best = history.reduce((top, entry) => Math.max(top, calculationAccuracy(entry)), 0);
  const totalQuestions = history.reduce((sum, entry) => sum + (Number(entry.total) || 0), 0);
  const minutes = Math.round(history.reduce((sum, entry) => sum + (Number(entry.durationSec) || 0), 0) / 60);
  const doneToday = history.some(entry => entry.date === today && entry.reason === 'completed');

  const lines = [
    '📊 <b>Calculation practice</b>',
    '',
    `🔥 Streak: <b>${streak}</b> din${streak ? '' : ' — aaj shuru karo'}`,
    `🎯 Average accuracy: <b>${average}%</b> (best ${best}%)`,
    `🧮 Sessions: <b>${sessions}</b> · ${totalQuestions} questions · ${minutes} min`,
    '',
    `<b>Recent</b>`
  ];
  history.slice(0, 5).forEach(entry => {
    lines.push(`• ${escapeTelegramHtml(tgLib.fmtDM(entry.date))} — ${escapeTelegramHtml(String(entry.presetName || 'Practice').slice(0, 30))} · ${calculationAccuracy(entry)}%`);
  });
  if (pending) lines.push('', `⏳ ${pending} attempt sync hone baaki hain — app kholo.`);
  if (!doneToday) lines.push('', 'Aaj ka session pending hai — <code>/calc</code> bhejo.');
  return lines.join('\n');
}

/* ── /addmock ────────────────────────────────────────────────────────────
   Mirror of MOCK_EXAMS in js/tabs/mock-tests-data.js. The command accepts one
   mark per section in this order, then queues the attempt outside appState so
   an open browser tab cannot overwrite it with a whole-state save. */
const TELEGRAM_MOCK_EXAMS = {
  cgl: { label: 'SSC CGL', tiers: {
    t1: { label: 'Tier I', sections: [['gi', 'Reasoning', 50, -12.5], ['ga', 'Awareness', 50, -12.5], ['qa', 'Quant', 50, -12.5], ['en', 'English', 50, -12.5]] },
    t2: { label: 'Tier II', sections: [['ma', 'Maths', 90, -30], ['re', 'Reasoning', 90, -30], ['en', 'English', 135, -45], ['ga', 'Awareness', 75, -25], ['ck', 'Computer', 60, -20]] }
  } },
  ntpc: { label: 'RRB NTPC', tiers: {
    cbt1: { label: 'CBT 1', sections: [['ma', 'Maths', 30, -10], ['gi', 'Reasoning', 30, -10], ['ga', 'Awareness', 40, -40 / 3]] },
    cbt2: { label: 'CBT 2', sections: [['ma', 'Maths', 35, -35 / 3], ['gi', 'Reasoning', 35, -35 / 3], ['ga', 'Awareness', 50, -50 / 3]] }
  } },
  gd: { label: 'SSC GD', tiers: {
    cbt: { label: 'CBT', sections: [['gi', 'Reasoning', 40, -10], ['gk', 'GK', 40, -10], ['em', 'Maths', 40, -10], ['eh', 'English/Hindi', 40, -10]] }
  } },
  ibps: { label: 'IBPS', tiers: {
    pre: { label: 'Prelims', sections: [['en', 'English', 30, -7.5], ['qa', 'Quant', 35, -8.75], ['re', 'Reasoning', 35, -8.75]] },
    mains: { label: 'Mains', sections: [['rc', 'Reasoning/Computer', 60, -11.25], ['ga', 'Awareness', 40, -10], ['en', 'English', 40, -8.75], ['di', 'Data Analysis', 60, -8.75]] }
  } },
  upsc: { label: 'UPSC', tiers: {
    pre: { label: 'Prelims', sections: [['gs', 'GS', 200, -66], ['csat', 'CSAT', 200, -66.4]] }
  } },
  uppcs: { label: 'UPPCS', tiers: {
    pre: { label: 'Prelims', sections: [['gs', 'GS', 200, -66], ['csat', 'CSAT', 200, -66]] }
  } },
  bpsc: { label: 'BPSC', tiers: {
    pre: { label: 'Prelims', sections: [['gs', 'GS', 150, -50]] }
  } }
};

function addMockUsageText() {
  return 'Use: /addmock cgl t1 38 32.5 41 36 | Test name | YYYY-MM-DD\n'
    + 'Valid: cgl(t1,t2), ntpc(cbt1,cbt2), gd(cbt), ibps(pre,mains), upsc(pre), uppcs(pre), bpsc(pre).';
}

function validMockCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const parts = String(value).split('-').map(Number);
  const parsed = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  return parsed.getUTCFullYear() === parts[0]
    && parsed.getUTCMonth() === parts[1] - 1
    && parsed.getUTCDate() === parts[2];
}

function normalizeMockTier(exam, value) {
  const raw = String(value || '').toLowerCase().replace(/[-_\s]/g, '');
  const aliases = {
    cgl: { tier1: 't1', i: 't1', tier2: 't2', ii: 't2' },
    ntpc: { '1': 'cbt1', '2': 'cbt2' },
    ibps: { prelim: 'pre', prelims: 'pre' },
    upsc: { prelim: 'pre', prelims: 'pre' },
    uppcs: { prelim: 'pre', prelims: 'pre' },
    bpsc: { prelim: 'pre', prelims: 'pre' }
  };
  return (aliases[exam] && aliases[exam][raw]) || raw;
}

function parseAddMockArgument(argument) {
  const pieces = String(argument || '').split('|');
  if (!String(argument || '').trim()) {
    throw Object.assign(new Error(addMockUsageText()), { status: 400 });
  }
  if (pieces.length > 3) {
    throw Object.assign(new Error('Name ya date mein | use mat karo. ' + addMockUsageText()), { status: 400 });
  }

  const tokens = pieces[0].trim().split(/\s+/).filter(Boolean);
  const exam = String(tokens.shift() || '').toLowerCase();
  const examCfg = TELEGRAM_MOCK_EXAMS[exam];
  if (!examCfg) {
    throw Object.assign(new Error('Exam valid nahi hai. ' + addMockUsageText()), { status: 400 });
  }
  const tier = normalizeMockTier(exam, tokens.shift());
  const tierCfg = examCfg.tiers[tier];
  if (!tierCfg) {
    throw Object.assign(new Error(`${examCfg.label} tier valid nahi hai. Options: ${Object.keys(examCfg.tiers).join(', ')}.`), { status: 400 });
  }
  if (tokens.length !== tierCfg.sections.length) {
    const order = tierCfg.sections.map(section => `${section[0]}(max ${section[2]})`).join(' ');
    throw Object.assign(new Error(`${tierCfg.sections.length} section marks chahiye, is order mein: ${order}.`), { status: 400 });
  }

  const sectionMarks = {};
  let total = 0;
  tierCfg.sections.forEach((section, index) => {
    const raw = tokens[index];
    if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw)) {
      throw Object.assign(new Error(`${section[1]} marks valid number hona chahiye.`), { status: 400 });
    }
    const mark = Number(raw);
    if (!Number.isFinite(mark) || mark < section[3] || mark > section[2]) {
      throw Object.assign(new Error(`${section[1]} marks ${Math.round(section[3] * 100) / 100} se ${section[2]} ke beech hona chahiye.`), { status: 400 });
    }
    const rounded = Math.round(mark * 100) / 100;
    sectionMarks[section[0]] = { m: rounded };
    total += rounded;
  });

  let name = String(pieces[1] || '').trim();
  let date = String(pieces[2] || '').trim();
  /* Allow a date without a custom name: `/addmock … | 2026-08-08`. */
  if (pieces.length === 2 && validMockCalendarDate(name)) {
    date = name;
    name = '';
  }
  date = date || todayIST();
  if (!validMockCalendarDate(date)) {
    throw Object.assign(new Error('Date YYYY-MM-DD format mein valid calendar date honi chahiye.'), { status: 400 });
  }
  if (name.length > 60) {
    throw Object.assign(new Error('Mock name 60 characters se chhota rakho.'), { status: 400 });
  }

  return {
    exam,
    tier,
    examCfg,
    tierCfg,
    name,
    date,
    sections: sectionMarks,
    total: Math.round(total * 100) / 100
  };
}

async function queueMockAttempt(uid, item) {
  const ref = db.collection('users').doc(uid);
  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    const data = snapshot.exists ? (snapshot.data() || {}) : {};
    const inbox = Array.isArray(data.mockAttemptInbox) ? data.mockAttemptInbox : [];
    const existing = inbox.find(entry => entry && entry.id === item.id);
    if (existing) {
      const comparable = value => JSON.stringify({
        id: value && value.id,
        exam: value && value.exam,
        tier: value && value.tier,
        attempt: value && value.attempt
      });
      if (comparable(existing) !== comparable(item)) {
        throw Object.assign(new Error('This form changed after an earlier save attempt. Reopen it and save again.'), { status: 409 });
      }
      return { duplicate: true, item: existing };
    }
    if (inbox.length >= 20) {
      throw Object.assign(new Error('20 mock results sync hone baaki hain. StudyPlanner app ek baar kholo, phir try karo.'), { status: 409 });
    }
    transaction.set(ref, { mockAttemptInbox: [item].concat(inbox) }, { merge: true });
    return { duplicate: false, item };
  });
}

function countSavedMocks(appState) {
  const mocks = appState && appState.mocks && typeof appState.mocks === 'object' ? appState.mocks : {};
  return Object.values(mocks).reduce((examTotal, tiers) => examTotal
    + Object.values(tiers && typeof tiers === 'object' ? tiers : {})
      .reduce((tierTotal, attempts) => tierTotal + (Array.isArray(attempts) ? attempts.length : 0), 0), 0);
}

async function buildAddMockMessage(account, argument) {
  if (!argument) {
    const base = String(FALLBACK_APP_BASE_URL || '').replace(/\/+$/, '');
    const formUrl = `${base}/addmock/index.html`;
    const formRows = /^https:\/\//i.test(base)
      ? [[{ text: '📝 Open Mock Marks Form', web_app: { url: formUrl } }]]
      : [];
    return {
      text: '➕ <b>Add Mock Marks</b>\n\nTap the button to choose your exam and enter section-wise marks in a simple form.\n\n'
        + 'Manual entry also works:\n<code>/addmock cgl t1 38 32.5 41 36 | Test name | 2026-08-08</code>',
      rows: formRows,
      /* A plain URL does not receive Telegram initData and therefore cannot
         authenticate this form. If Telegram rejects web_app, retry the same
         manual-entry instructions without an unusable browser button. */
      fallbackRows: []
    };
  }
  const parsed = parseAddMockArgument(argument);
  const existing = countSavedMocks(accountAppState(account));
  const pending = Array.isArray(account.data.mockAttemptInbox) ? account.data.mockAttemptInbox.length : 0;
  const name = parsed.name || `Telegram Mock ${existing + pending + 1}`;
  const id = 'tgmock-' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  const attempt = {
    id,
    name,
    date: parsed.date,
    s: parsed.sections,
    total: parsed.total,
    weakTopics: []
  };
  await queueMockAttempt(account.uid, {
    id,
    exam: parsed.exam,
    tier: parsed.tier,
    attempt,
    queuedAt: new Date().toISOString()
  });

  const sectionLine = parsed.tierCfg.sections
    .map(section => `${section[0].toUpperCase()} ${attempt.s[section[0]].m}`)
    .join(' · ');
  return `✅ <b>Mock marks add ho gaye!</b>\n\n`
    + `<b>${escapeTelegramHtml(name)}</b> · ${escapeTelegramHtml(parsed.examCfg.label)} ${escapeTelegramHtml(parsed.tierCfg.label)}\n`
    + `${escapeTelegramHtml(parsed.date)} · ${escapeTelegramHtml(sectionLine)}\n`
    + `Total: <b>${attempt.total}</b>\n\n`
    + 'StudyPlanner app khulte hi result Mock Tests mein sync ho jayega.';
}

/* ── /mock ───────────────────────────────────────────────────────────────
   appState.mocks is keyed exam → tier → attempts[], and neither key reaches the
   bot (both come from browser globals), so every bucket is flattened and sorted
   by date instead of guessing which exam is current. */
function collectMockAttempts(appState) {
  const mocks = appState.mocks && typeof appState.mocks === 'object' ? appState.mocks : {};
  const attempts = [];
  Object.keys(mocks).forEach(exam => {
    const tiers = mocks[exam] && typeof mocks[exam] === 'object' ? mocks[exam] : {};
    Object.keys(tiers).forEach(tier => {
      (Array.isArray(tiers[tier]) ? tiers[tier] : []).forEach(attempt => {
        if (!attempt || !isDateString(attempt.date)) return;
        attempts.push({
          exam,
          tier,
          name: String(attempt.name || 'Mock'),
          date: attempt.date,
          total: Number(attempt.total) || 0,
          weakTopics: Array.isArray(attempt.weakTopics) ? attempt.weakTopics : []
        });
      });
    });
  });
  /* Newest first; a same-day pair keeps a stable order by name. */
  attempts.sort((left, right) => (left.date === right.date
    ? String(left.name).localeCompare(String(right.name))
    : (left.date < right.date ? 1 : -1)));
  return attempts;
}

function buildMockMessage(account) {
  const attempts = collectMockAttempts(accountAppState(account));
  if (!attempts.length) {
    return '📝 <b>Koi mock test save nahi hua.</b>\n\nApp ke <b>Mock Tests</b> tab mein score daalo — trend yahan dikhega.';
  }
  const latest = attempts[0];
  const lines = [
    '📝 <b>Mock tests</b>',
    '',
    `<b>${escapeTelegramHtml(latest.name.slice(0, 40))}</b> — ${escapeTelegramHtml(tgLib.fmtDM(latest.date))}`,
    `Score: <b>${latest.total}</b>`
  ];
  /* Compare with the previous attempt of the same exam and tier, so a different
     paper cannot masquerade as improvement. */
  const previous = attempts.slice(1).find(attempt => attempt.exam === latest.exam && attempt.tier === latest.tier);
  if (previous) {
    const change = Math.round((latest.total - previous.total) * 100) / 100;
    const arrow = change > 0 ? `📈 +${change}` : change < 0 ? `📉 ${change}` : '➖ same';
    lines.push(`vs pichhla (${escapeTelegramHtml(tgLib.fmtDM(previous.date))}): ${arrow}`);
  }
  if (latest.weakTopics.length) {
    lines.push('', `⚠️ Weak: ${escapeTelegramHtml(latest.weakTopics.slice(0, 5).map(String).join(', ').slice(0, 200))}`);
  }
  if (attempts.length > 1) {
    lines.push('', '<b>Recent</b>');
    attempts.slice(0, 5).forEach(attempt => {
      lines.push(`• ${escapeTelegramHtml(tgLib.fmtDM(attempt.date))} — ${escapeTelegramHtml(attempt.name.slice(0, 30))} · ${attempt.total}`);
    });
    const scored = attempts.filter(attempt => attempt.total > 0);
    if (scored.length > 1) {
      const average = Math.round((scored.reduce((sum, attempt) => sum + attempt.total, 0) / scored.length) * 10) / 10;
      lines.push('', `Average: <b>${average}</b> over ${scored.length} mocks`);
    }
  }
  return lines.join('\n');
}

registerAccountCommand({ name: 'status', regex: /^\/status(?:@\w+)?$/, limit: 6, build: buildStatusMessage });
registerAccountCommand({ name: 'plan', regex: /^\/plan(?:@\w+)?$/, limit: 6, build: buildPlanMessage });
registerAccountCommand({ name: 'pending', regex: /^\/pending(?:@\w+)?$/, limit: 6, build: buildPendingMessage });
registerAccountCommand({ name: 'exam', regex: /^\/exam(?:@\w+)?$/, limit: 6, build: buildExamMessage });
registerAccountCommand({ name: 'stats', regex: /^\/(?:stats|streak)(?:@\w+)?$/, limit: 6, build: buildStatsMessage });
registerAccountCommand({ name: 'mock', regex: /^\/mock(?:s)?(?:@\w+)?$/, limit: 6, build: buildMockMessage });
registerAccountCommand({ name: 'addmock', regex: /^\/addmock(?:@\w+)?(?:\s+([\s\S]+))?$/, limit: 6, build: buildAddMockMessage });

/* ── /ask — study doubts answered in the chat ─────────────────────────────
   Routed through whichever provider the admin selected in the panel, rather
   than one hard-coded here. Saving the Study AI card writes a flattened mirror
   into config/ai — studyProvider, studyBaseUrl, studyApiKeys, studyModel,
   studyTransport — described in js/admin/admin-actions.js as "the only fields
   youtube-turbo-proxy reads". Reading the same mirror keeps the panel the single
   source of truth and puts this bot on the same contract as the other
   server-side consumers, so switching provider needs no code change here.

   It matters most for the current selection, OmniRoute: it is reached over an
   ngrok dev domain, so its URL changes. Taking the URL from studyBaseUrl means
   the admin re-saves the card and the bot follows, with no redeploy.

   `groqApiKey` remains a fallback so /ask still works on an installation that
   only ever configured the auto-scheduler.

   Deliberately stateless: the tutor's memory lives in Supabase, which the bot
   has no credentials for, so this answers one question at a time rather than
   pretending to hold a conversation. The rate limit is tighter than the other
   commands because every call spends someone else's quota. */
const ASK_TIMEOUT_MS = 30000;
const ASK_MAX_ANSWER_CHARS = 3500;
const STUDY_TUTOR_SYSTEM_PROMPT = 'You are a patient tutor for Indian competitive-exam aspirants '
  + '(SSC, UPSC, banking, railways). Answer the question directly and briefly: at most 150 words. '
  + 'Show the working for any calculation, step by step. Prefer the shortcut an exam candidate would use '
  + 'under time pressure. Reply in the language of the question (Hindi, Hinglish or English). '
  + 'Use plain text only — no markdown, no headings, no asterisks. '
  /* This used to end with "If the question is not about studying or an exam
     subject, say so in one line instead of answering." That refusal misfired on
     the single most-asked category: General Awareness / current affairs IS a
     scored subject in every one of these exams, so "who is the current RBI
     governor" was being turned away as off-topic. Answer everything instead; the
     only thing to be careful about is not sounding certain on facts that may
     have moved since training. */
  + 'Every question is in scope, including general awareness, current affairs and general knowledge '
  + '— these are scored subjects in these exams. Never refuse a question for being off-topic. '
  + 'If the answer depends on a fact that may have changed recently, give what you know and add one '
  + 'short line saying it should be verified.';

/* The bot has no web search (that lives in the app backend), so date awareness
   is the one thing keeping it from confidently answering current-affairs
   questions relative to whenever its training data stopped. IST, because that is
   where the students are. */
function tutorDateContext(now) {
  const ist = new Date((now instanceof Date ? now : new Date()).getTime() + (5.5 * 3600 * 1000));
  const stamp = ist.toISOString().slice(0, 10);
  return 'Today is ' + stamp + ' (IST). Your training data is older than that, so treat anything '
    + 'you recall as "current" or "latest" as possibly out of date.';
}

function buildTutorMessages(question) {
  return [
    { role: 'system', content: STUDY_TUTOR_SYSTEM_PROMPT + ' ' + tutorDateContext() },
    { role: 'user', content: String(question || '') }
  ];
}

/* Keys are stored as an array by the panel, but tolerate the newline/comma text
   form too — that is how they are typed in, and splitStudyKeys() accepts both. */
function studyApiKeyList(raw) {
  const list = Array.isArray(raw) ? raw : String(raw == null ? '' : raw).split(/[\n,]+/);
  return list.map(key => String(key == null ? '' : key).trim()).filter(Boolean);
}

/* OmniRoute runs on an account-owned ngrok Dev Domain. Keep one strict
   canonicalizer shared by the selected route and failover route so an Admin
   endpoint update takes effect on the next /ask request without a bot redeploy. */
const OMNIROUTE_DEFAULT_BASE_URL = 'https://precut-uniformly-handsfree.ngrok-free.dev/v1';
const OMNIROUTE_RETIRED_BASE_URL = 'https://squeak-earthly-obliged.ngrok-free.dev/v1';

function normalizeOmnirouteBaseUrl(value) {
  const original = String(value == null ? '' : value);
  if (/[\u0000-\u001f\u007f]/.test(original)) return '';
  const raw = original.trim();
  if (!raw || raw.includes('\\')) return '';
  try {
    const authorityMatch = raw.match(/^https:\/\/([^\/?#]+)(?=\/|$)/i);
    if (!authorityMatch || authorityMatch[1].includes('@') || authorityMatch[1].includes(':')) return '';
    const hostname = authorityMatch[1].toLowerCase();
    const rawPath = raw.slice(authorityMatch[0].length);
    const allowedPath = rawPath === '/v1' || rawPath === '/v1/'
      || rawPath === '/v1/chat/completions' || rawPath === '/v1/chat/completions/';
    const parsed = new URL(raw);
    if (!allowedPath || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port
        || parsed.search || parsed.hash
        || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ngrok-free\.dev$/.test(hostname)) return '';
    const base = `https://${hostname}/v1`;
    return base === OMNIROUTE_RETIRED_BASE_URL ? '' : base;
  } catch (error) { return ''; }
}

function normalizeOmnirouteLocalBaseUrl(value) {
  const original = String(value == null ? '' : value);
  if (/[\u0000-\u001f\u007f]/.test(original)) return '';
  const raw = original.trim();
  if (!raw || raw.includes('\\')) return '';
  try {
    const authorityMatch = raw.match(/^https?:\/\/([^\/?#]+)(?=\/|$)/i);
    if (!authorityMatch || authorityMatch[1].includes('@')) return '';
    const authorityParts = authorityMatch[1].match(/^([^:]+)(?::([0-9]+))?$/);
    if (!authorityParts || authorityMatch[1].endsWith(':')) return '';
    const hostname = authorityParts[1].toLowerCase();
    const port = authorityParts[2] ? String(Number(authorityParts[2])) : '';
    const hostParts = hostname.split('.');
    const octets = hostParts.map(Number);
    const privateIpv4 = octets.length === 4
      && octets.every((part, index) => /^(?:0|[1-9][0-9]{0,2})$/.test(hostParts[index])
        && Number.isInteger(part) && part >= 0 && part <= 255)
      && (octets[0] === 10
        || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
        || (octets[0] === 192 && octets[1] === 168)
        || octets[0] === 127);
    const localTarget = hostname === 'localhost' || privateIpv4;
    const parsed = new URL(raw);
    const rawPath = raw.slice(authorityMatch[0].length);
    const allowedPath = rawPath === '/v1' || rawPath === '/v1/'
      || rawPath === '/v1/chat/completions' || rawPath === '/v1/chat/completions/';
    if (!localTarget || !allowedPath
        || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        || parsed.username || parsed.password || parsed.search || parsed.hash) return '';
    return `${parsed.protocol}//${hostname}${port ? `:${port}` : ''}/v1`;
  } catch (error) { return ''; }
}

function resolveOmniroutePublicBaseUrl(cfg) {
  cfg = cfg && typeof cfg === 'object' ? cfg : {};
  const candidates = [cfg.omnirouteBaseUrl];
  const active = String(cfg.studyProvider || '').trim().toLowerCase();
  const transport = String(cfg.studyTransport || 'openai_chat').trim().toLowerCase();
  if (active === 'omniroute' && transport === 'openai_chat') candidates.push(cfg.studyBaseUrl);
  candidates.push(process.env.OMNIROUTE_URL, OMNIROUTE_DEFAULT_BASE_URL);
  for (const candidate of candidates) {
    const normalized = normalizeOmnirouteBaseUrl(candidate);
    if (normalized) return normalized;
  }
  return OMNIROUTE_DEFAULT_BASE_URL;
}

function omnirouteAdminLocalEnabled() {
  return ['1', 'true', 'yes', 'on'].includes(
    String(process.env.OMNIROUTE_ALLOW_ADMIN_LOCAL_URL || '').trim().toLowerCase());
}

function resolveOmnirouteBaseUrl(cfg) {
  /* A pinned process value always wins. The separate Admin local field is
     trusted only when this individual deployment explicitly opts in; public
     bots therefore cannot be redirected into their own LAN or localhost. */
  const pinned = normalizeOmnirouteLocalBaseUrl(process.env.OMNIROUTE_LOCAL_URL);
  if (pinned) return pinned;
  if (omnirouteAdminLocalEnabled()) {
    const adminLocal = normalizeOmnirouteLocalBaseUrl(
      cfg && typeof cfg === 'object' ? cfg.omnirouteLocalBaseUrl : '');
    if (adminLocal) return adminLocal;
  }
  return resolveOmniroutePublicBaseUrl(cfg);
}

/* → { provider, url, keys, model } or null when the panel has not configured a
   usable provider. OmniRoute resolves its dedicated live endpoint; other
   providers continue to use the selected provider mirror. */
function studyProviderFromConfig(cfg) {
  cfg = cfg && typeof cfg === 'object' ? cfg : {};
  /* `google_interactions` speaks a different protocol; only the OpenAI-compatible
     transport is understood here, so anything else falls through to the
     fallback rather than being sent a body it cannot read. */
  if (String(cfg.studyTransport || 'openai_chat') !== 'openai_chat') return null;
  const provider = String(cfg.studyProvider || 'study').slice(0, 40);
  const base = provider.toLowerCase() === 'omniroute'
    ? resolveOmnirouteBaseUrl(cfg)
    : normalizeAppBaseUrl(cfg.studyBaseUrl);
  const keys = studyApiKeyList(cfg.studyApiKeys);
  if (!base || !keys.length) return null;
  return {
    provider,
    url: `${base}/chat/completions`,
    keys,
    model: String(cfg.studyModel || '').trim() || 'auto'
  };
}

function groqFallbackProvider(cfg) {
  const key = cfg && cfg.groqApiKey ? String(cfg.groqApiKey).trim() : '';
  if (!key) return null;
  return {
    provider: 'groq',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    keys: [key],
    model: (cfg && cfg.model) || 'llama-3.1-8b-instant'
  };
}

/* ── Cross-provider failover registry ─────────────────────────────────────
   Server-side mirror of the subset of STUDY_PROVIDERS (from admin-actions.js)
   that speaks the OpenAI-compatible chat/completions protocol. Used to build a
   fallback chain when the active provider is unreachable.
   google_interactions is intentionally excluded (transport !== 'openai_chat'). */
const FAILOVER_PROVIDERS = [
  { id: 'bynara',      keyField: 'bynaraApiKeys',      modelField: 'bynaraModel',      baseUrl: 'https://router.bynara.id/v1',                            defaultModel: 'mistral-large' },
  { id: 'mistral',     keyField: 'mistralApiKeys',     modelField: 'mistralModel',     baseUrl: 'https://api.mistral.ai/v1',                           defaultModel: 'mistral-large-latest' },
  { id: 'cerebras',    keyField: 'cerebrasApiKeys',    modelField: 'cerebrasModel',    baseUrl: 'https://api.cerebras.ai/v1',                          defaultModel: 'gpt-oss-120b' },
  { id: 'openrouter',  keyField: 'openrouterApiKeys',  modelField: 'openrouterModel',  baseUrl: 'https://openrouter.ai/api/v1',                        defaultModel: 'nvidia/nemotron-3-ultra-550b-a55b:free' },
  { id: 'nvidia',      keyField: 'nvidiaApiKeys',      modelField: 'nvidiaModel',      baseUrl: 'https://integrate.api.nvidia.com/v1',                  defaultModel: 'deepseek-ai/deepseek-v4-pro' },
  { id: 'google',      keyField: 'googleApiKeys',      modelField: 'googleModel',      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-flash-latest' },
  { id: 'hcnsec',      keyField: 'hcnsecApiKeys',      modelField: 'hcnsecModel',      baseUrl: 'https://api.hcnsec.cn/v1',                            defaultModel: 'DeepSeek-V4-Pro' },
  { id: 'bluesminds',  keyField: 'bluesmindsApiKeys',  modelField: 'bluesmindsModel',  baseUrl: 'https://api.bluesminds.com/v1',                       defaultModel: 'gpt-5.2-chat' },
  { id: 'aicampus',    keyField: 'aicampusApiKeys',    modelField: 'aicampusModel',    baseUrl: 'https://ai-hub.aicampus.my/v1',                       defaultModel: 'minimax-m3' },
  { id: 'omniroute',   keyField: 'omnirouteApiKeys',   modelField: 'omnirouteModel',   baseUrl: '',                                                   defaultModel: 'auto' },
  { id: 'kiro',        keyField: 'kiroApiKeys',        modelField: 'kiroModel',        baseUrl: 'https://kiro-key-test-s6io.onrender.com/v1',           defaultModel: 'auto' },
];

/* Build a list of fallback providers from the config, excluding the provider that
   was already tried (matched by its completions URL). Returns an array of
   provider objects in registry order, ready for callStudyProvider(). */
function buildFallbackProviderList(cfg, excludeProvider) {
  const result = [];
  const excludeUrl = excludeProvider ? excludeProvider.url : null;

  for (const entry of FAILOVER_PROVIDERS) {
    const keys = studyApiKeyList(cfg[entry.keyField]);
    if (!keys.length) continue;
    const baseUrl = entry.id === 'omniroute' ? resolveOmnirouteBaseUrl(cfg) : entry.baseUrl;
    const url = `${baseUrl}/chat/completions`;
    if (url === excludeUrl) continue;
    const model = (cfg[entry.modelField] || entry.defaultModel || 'auto').trim();
    result.push({ provider: entry.id, url, keys, model });
  }

  // Include Groq fallback if not already excluded
  if (!excludeProvider || excludeProvider.provider !== 'groq') {
    const groq = groqFallbackProvider(cfg);
    if (groq) result.push(groq);
  }

  return result;
}

/* Try each provider in sequence. Re-throw HTTP 400 immediately (bad question —
   retrying won't help). Swallow 502/network errors and move to the next. If all
   providers fail, throw the last error. */
async function callWithFailover(providers, messages) {
  let lastError = null;
  for (const provider of providers) {
    try {
      const answer = await callStudyProvider(provider, messages);
      if (answer) return { answer, provider };
    } catch (error) {
      if (error && error.status === 400) throw error; // bad question — don't retry
      lastError = error;
      continue;
    }
  }
  if (lastError) throw lastError;
  throw Object.assign(new Error('no providers available'), { status: 502 });
}

/* The key list is a rotation, not a preference order: a revoked or exhausted key
   must not take /ask down while another still works. A 400 is not retried,
   because the request itself is what was refused and every key would say the
   same. */
async function callStudyProvider(provider, messages) {
  let lastDetail = 'no key succeeded';
  for (const key of provider.keys) {
    let response;
    try {
      response = await fetch(provider.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          /* OmniRoute sits behind an ngrok dev domain, which answers some
             requests with an HTML interstitial instead of JSON unless asked not
             to. Harmless for every other provider. */
          'ngrok-skip-browser-warning': 'true'
        },
        body: JSON.stringify({
          model: provider.model,
          temperature: 0.3,
          max_completion_tokens: 700,
          messages
        }),
        signal: AbortSignal.timeout(ASK_TIMEOUT_MS)
      });
    } catch (error) {
      /* Network failure, or the ngrok tunnel being down — try the next key, then
         report it as unavailable rather than as a bad question. */
      lastDetail = `request failed: ${(error && error.message) || error}`;
      continue;
    }
    if (response.status === 400) {
      throw Object.assign(new Error('AI ne yeh sawaal accept nahi kiya. Thoda chhota karke poocho.'), { status: 400 });
    }
    if (!response.ok) {
      lastDetail = `${provider.provider} responded ${response.status}`;
      continue;
    }
    const data = await response.json().catch(() => null);
    const answer = data && data.choices && data.choices[0] && data.choices[0].message
      ? String(data.choices[0].message.content || '').trim()
      : '';
    if (answer) return answer;
    lastDetail = `${provider.provider} returned an empty completion`;
  }
  /* The detail names the provider and status for the log; the handler replaces it
     with user-facing copy, so no upstream wording reaches the chat. */
  throw Object.assign(new Error(lastDetail), { status: 502 });
}

bot.onText(/^\/ask(?:@\w+)?(?:\s+([\s\S]+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const question = match && match[1] ? String(match[1]).trim().slice(0, 600) : '';
  if (msg.chat.type !== 'private') {
    bot.sendMessage(chatId, '⚠️ <b>/ask</b> sirf private chat mein chalta hai — mujhe DM karo.',
      { parse_mode: 'HTML' }).catch(() => {});
    return;
  }
  if (!db) {
    bot.sendMessage(chatId, '⚠️ <b>Server-side dikkat hai</b> — bot ka database connection missing hai.',
      { parse_mode: 'HTML' }).catch(() => {});
    return;
  }
  if (!question) {
    bot.sendMessage(chatId,
      '🧠 <b>Kuch poocho!</b>\n\nJaise:\n'
      + '• <code>/ask 15% of 840 kaise nikaalein</code>\n'
      + '• <code>/ask Article 14 kya kehta hai</code>\n'
      + '• <code>/ask difference between DNA and RNA</code>',
      { parse_mode: 'HTML' }).catch(() => {});
    return;
  }
  try {
    /* Tighter than the read-only commands: each answer costs Groq quota. */
    await enforceFirestoreRateLimit('command:ask', String(msg.from.id), 4, 60000,
      'Ek minute mein 4 sawaal — thoda ruk ke poocho.');
    const account = await miniAppAccountForTelegramUser(msg.from.id);
    const cfg = await getAiConfig();
    if (!cfg || cfg.enabled === false) {
      await bot.sendMessage(chatId, '⚠️ AI abhi off hai. Admin ise panel se on kar sakta hai.',
        { parse_mode: 'HTML' });
      return;
    }
    /* Whatever the admin selected in the Study AI card, with the auto-scheduler's
       Groq key as the fallback for an installation that configured only that.
       If the primary provider fails, walk through all other configured providers
       (cross-provider failover) before giving up. */
    const primaryProvider = studyProviderFromConfig(cfg) || groqFallbackProvider(cfg);
    const fallbacks = buildFallbackProviderList(cfg, primaryProvider);
    if (!primaryProvider && fallbacks.length === 0) {
      await bot.sendMessage(chatId,
        '⚠️ AI provider set nahi hai. Admin panel ke <b>Study AI</b> card mein provider aur key save karo.',
        { parse_mode: 'HTML' });
      return;
    }
    const allProviders = primaryProvider ? [primaryProvider, ...fallbacks] : fallbacks;
    const messages = buildTutorMessages(question);
    bot.sendChatAction(chatId, 'typing').catch(() => {});
    const { answer, provider } = await callWithFailover(allProviders, messages);
    if (!answer) {
      await bot.sendMessage(chatId, '⚠️ Jawab nahi mila. Dobara try karo.', { parse_mode: 'HTML' });
      return;
    }
    /* The model is told to send plain text, but it is still untrusted input for a
       parse_mode:'HTML' message, so escape before sending. */
    await bot.sendMessage(chatId,
      `🧠 <b>${escapeTelegramHtml(question.slice(0, 80))}</b>\n\n${escapeTelegramHtml(answer).slice(0, ASK_MAX_ANSWER_CHARS)}`,
      { parse_mode: 'HTML', disable_web_page_preview: true });
    console.log(`✅ /ask → uid:${account.uid} via ${provider.provider}/${provider.model}`);
  } catch (error) {
    const actionable = [400, 403, 409, 429].includes(error && error.status);
    if (!actionable) console.error('❌ /ask error:', (error && error.message) || error);
    const message = actionable ? error.message : 'AI se jawab nahi aaya. Thodi der baad try karo.';
    bot.sendMessage(chatId, `⚠️ ${escapeTelegramHtml(message)}`, { parse_mode: 'HTML' }).catch(() => {});
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   TELEGRAM MINI APP — run Calculation Practice inside Telegram
   ─────────────────────────────────────────────────────────────────────────────
   A Mini App cannot use the web app's Google sign-in (Google blocks OAuth in
   embedded webviews). Telegram instead hands the page a signed `initData`
   string; verifying its HMAC with the bot token proves which Telegram user is
   running the app. That verified Telegram id is mapped to the StudyPlanner
   account through the same link the reminders already rely on, so the browser
   never states who it is.
   ════════════════════════════════════════════════════════════════════════════ */
const MINI_APP_MAX_INIT_DATA = 4096;
/* initData is a bearer credential that Telegram exposes in the webview URL, so
   the acceptance window is kept short. The client re-reads `tg.initData` for
   every request and the launch screen offers a retry, so a long window buys
   nothing while widening the replay opportunity. */
const MINI_APP_INIT_DATA_MAX_AGE_SEC = 3 * 60 * 60;
/* `initData` is fixed at launch and never refreshed, so a session left open on a
   phone would lose its finished attempt under the same bound. Submitting a
   result gets a longer window; replaying it is harmless because the attempt id
   makes the write idempotent. */
const MINI_APP_RESULT_MAX_AGE_SEC = 24 * 60 * 60;
const CALC_QUIZ_IDS = new Set([
  'addition', 'subtraction', 'mult1', 'mult2', 'mult3', 'tablewrite', 'mult2d', 'mult3d',
  'squares', 'sqroots', 'cubes', 'cuberoots',
  'higherpow', 'pctfrac', 'pctnum', 'trig', 'pyth', 'ci_si', 'ci_ci', 'primeinrange', 'isprime',
  'astr1', 'astr2', 'arev1', 'arev2'
]);

/* Verify Telegram's WebApp initData exactly as documented: build the
   data_check_string from every field except `hash`, sorted by key, then compare
   an HMAC keyed by SHA256("WebAppData", bot token). Constant-time compare, and
   stale payloads are refused so a leaked initData cannot be replayed forever. */
function verifyTelegramInitData(initData, maxAgeSec) {
  const raw = String(initData == null ? '' : initData);
  if (!raw || raw.length > MINI_APP_MAX_INIT_DATA) {
    throw Object.assign(new Error('Telegram initData is required'), { status: 400 });
  }
  let params;
  try { params = new URLSearchParams(raw); } catch (error) {
    throw Object.assign(new Error('Telegram initData is malformed'), { status: 400 });
  }
  const hash = String(params.get('hash') || '');
  if (!/^[a-f0-9]{64}$/i.test(hash)) {
    throw Object.assign(new Error('Telegram initData signature is missing'), { status: 401 });
  }
  params.delete('hash');
  const dataCheckString = Array.from(params.entries())
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(String(TOKEN)).digest();
  const expected = crypto.createHmac('sha256', secret).update(dataCheckString).digest();
  const provided = Buffer.from(hash.toLowerCase(), 'hex');
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    throw Object.assign(new Error('Telegram initData signature is invalid'), { status: 401 });
  }
  const authDate = Number(params.get('auth_date') || 0);
  const maxAge = Number.isFinite(Number(maxAgeSec)) ? Number(maxAgeSec) : MINI_APP_INIT_DATA_MAX_AGE_SEC;
  if (!Number.isFinite(authDate) || authDate <= 0
      || Math.floor(Date.now() / 1000) - authDate > maxAge) {
    throw Object.assign(new Error('This Telegram session expired. Reopen the practice from Telegram.'), { status: 401 });
  }
  let user;
  try { user = JSON.parse(params.get('user') || '{}'); } catch (error) { user = {}; }
  const telegramUserId = positivePrivateChatId(user && user.id);
  if (!telegramUserId) {
    throw Object.assign(new Error('Open this practice from your private Telegram chat with the bot.'), { status: 401 });
  }
  return { telegramUserId, authDate };
}

/* Resolve the StudyPlanner account for a verified Telegram user.
   BOTH halves of the link must agree, because neither is sufficient alone:
     • account side — `appState.telegram.chatId` is free-typed by whoever is
       signed in, so on its own it lets someone claim another person's Telegram
       id and capture their Mini App sessions;
     • chat side — `telegram_links/<chatId>` is written by `/start <uid>` from
       the chat itself, so on its own it lets anyone who knows a uid claim that
       account (the app hands out shareable `?start=<uid>` links).
   Requiring both closes each hole with the other: an attacker can write neither
   the victim's `appState` nor a link doc keyed by the victim's chat id.
   `findUserByChatId` is deliberately not used here — it falls back to the link
   map alone. */
async function miniAppAccountForTelegramUser(telegramUserId) {
  const chatId = String(telegramUserId);
  const reconnectHint = 'Reconnect Telegram: in StudyPlanner open Profile → Daily Plan on Telegram, tap the button that opens this bot, press Start, then save this Chat ID.';

  const [query, linkSnapshot] = await Promise.all([
    db.collection('users').where('appState.telegram.chatId', '==', chatId).limit(5).get(),
    db.collection('telegram_links').doc(chatId).get()
  ]);
  if (query.empty) throw Object.assign(new Error(reconnectHint), { status: 403 });

  const linkedUid = linkSnapshot.exists ? String((linkSnapshot.data() || {}).uid || '') : '';
  if (!linkedUid) throw Object.assign(new Error(reconnectHint), { status: 403 });

  /* The link map holds a single uid per chat, so this filter also removes the
     ambiguity a duplicate claim would otherwise create. */
  const candidates = query.docs.filter(doc => doc.id === linkedUid);
  if (!candidates.length) throw Object.assign(new Error(reconnectHint), { status: 403 });
  if (candidates.length > 1) {
    console.error(`⚠️  Telegram chat ${chatId} resolves to multiple accounts — refusing Mini App access.`);
    throw Object.assign(new Error('This Telegram Chat ID is linked to more than one StudyPlanner account.'), { status: 409 });
  }

  const doc = candidates[0];
  const account = { uid: doc.id, data: doc.data() || {} };
  const telegram = ((account.data.appState || {}).telegram) || {};
  /* Matches /send-calculation-preset: turning Telegram off disables this too,
     so an old message in the chat cannot keep access alive. */
  if (telegram.enabled !== true) {
    throw Object.assign(new Error('Telegram is switched off for this account. Turn it back on in Profile → Daily Plan on Telegram.'), { status: 403 });
  }
  if (!await isAdminUid(account.uid) && !isProUser(account.data, todayIST())) {
    throw Object.assign(new Error('Practice inside Telegram requires an active Pro plan or trial.'), { status: 403 });
  }
  return account;
}

/* Difficulty presets mirrored from calc/presets.js difficultySettings(), so a
   stored preset missing `settings` practises at the same level in Telegram as it
   does in the browser. */
function calculationDifficultyDefaults(level) {
  if (level === 'easy') {
    return {
      digits: 1, sqMin: 2, sqMax: 12, cubeMin: 2, cubeMax: 8, multFrom: 2, multTo: 9, multiplierFrom: 1, multiplierTo: 10,
      mult2Min: 10, mult2Max: 30, mult3Min: 100, mult3Max: 400, mult3ByMin: 2, mult3ByMax: 9, primeMax: 50, ciYears: 2
    };
  }
  if (level === 'exam') {
    return {
      digits: 3, sqMin: 10, sqMax: 50, cubeMin: 5, cubeMax: 25, multFrom: 11, multTo: 25, multiplierFrom: 1, multiplierTo: 20,
      mult2Min: 10, mult2Max: 99, mult3Min: 100, mult3Max: 999, mult3ByMin: 11, mult3ByMax: 99, primeMax: 300, ciYears: 3
    };
  }
  return {
    digits: 2, sqMin: 2, sqMax: 25, cubeMin: 2, cubeMax: 15, multFrom: 2, multTo: 9, multiplierFrom: 1, multiplierTo: 10,
    mult2Min: 10, mult2Max: 99, mult3Min: 100, mult3Max: 999, mult3ByMin: 2, mult3ByMax: 12, primeMax: 100, ciYears: 2
  };
}

/* The full practice configuration the engine needs, clamped to the same bounds
   the web app enforces so a tampered stored document cannot widen ranges. */
/* Shared by the preset and by each of its parts, which carry their own ranges. */
function sanitizeCalculationSettings(raw, difficulty) {
  const settings = raw && typeof raw === 'object' ? raw : {};
  const fallback = calculationDifficultyDefaults(difficulty === 'custom' ? 'standard' : difficulty);
  /* Presets saved before squares and cubes were given separate base ranges
     carry a single rangeMin/rangeMax, which seeds both. */
  const legacyBaseLow = settings.sqMin == null && settings.cubeMin == null ? settings.rangeMin : null;
  const legacyBaseHigh = settings.sqMax == null && settings.cubeMax == null ? settings.rangeMax : null;
  let multFrom = boundedInteger(settings.multFrom, 1, 100, fallback.multFrom);
  let multTo = boundedInteger(settings.multTo, 1, 100, fallback.multTo);
  let multiplierFrom = boundedInteger(settings.multiplierFrom, 1, 100, fallback.multiplierFrom);
  let multiplierTo = boundedInteger(settings.multiplierTo, 1, 100, fallback.multiplierTo);
  if (multTo < multFrom) [multFrom, multTo] = [multTo, multFrom];
  if (multiplierTo < multiplierFrom) [multiplierFrom, multiplierTo] = [multiplierTo, multiplierFrom];

  const orderedPair = (low, high, min, max, fallbackLow, fallbackHigh) => {
    const a = boundedInteger(low, min, max, fallbackLow);
    const b = boundedInteger(high, min, max, fallbackHigh);
    return b < a ? [b, a] : [a, b];
  };
  const [mult2Min, mult2Max] = orderedPair(settings.mult2Min, settings.mult2Max, 10, 99, fallback.mult2Min, fallback.mult2Max);
  const [mult3Min, mult3Max] = orderedPair(settings.mult3Min, settings.mult3Max, 100, 999, fallback.mult3Min, fallback.mult3Max);
  const [mult3ByMin, mult3ByMax] = orderedPair(settings.mult3ByMin, settings.mult3ByMax, 2, 999, fallback.mult3ByMin, fallback.mult3ByMax);
  const [sqMin, sqMax] = orderedPair(
    settings.sqMin != null ? settings.sqMin : legacyBaseLow, settings.sqMax != null ? settings.sqMax : legacyBaseHigh,
    1, 100, fallback.sqMin, fallback.sqMax);
  const [cubeMin, cubeMax] = orderedPair(
    settings.cubeMin != null ? settings.cubeMin : legacyBaseLow, settings.cubeMax != null ? settings.cubeMax : legacyBaseHigh,
    1, 100, fallback.cubeMin, fallback.cubeMax);

  return {
    digits: boundedInteger(settings.digits, 1, 4, fallback.digits),
    sqMin,
    sqMax,
    cubeMin,
    cubeMax,
    multFrom,
    multTo,
    multiplierFrom,
    multiplierTo,
    mult2Min,
    mult2Max,
    mult3Min,
    mult3Max,
    mult3ByMin,
    mult3ByMax,
    primeMax: boundedInteger(settings.primeMax, 10, 300, fallback.primeMax),
    ciYears: boundedInteger(settings.ciYears, 2, 5, fallback.ciYears)
  };
}

/* Parts of a combined preset, each practised as its own block. Dropped unless
   they still cover exactly the preset's question types, matching the browser. */
function sanitizeCalculationSegments(raw, difficulty, quizIds) {
  if (!Array.isArray(raw)) return [];
  const segments = raw.slice(0, 8).map(segment => {
    segment = segment && typeof segment === 'object' ? segment : {};
    const ids = Array.isArray(segment.quizIds)
      ? Array.from(new Set(segment.quizIds.map(id => String(id || '').slice(0, 32)).filter(id => CALC_QUIZ_IDS.has(id))))
      : [];
    if (!ids.length) return null;
    const weights = {};
    const rawWeights = segment.weights && typeof segment.weights === 'object' ? segment.weights : {};
    ids.forEach(id => { weights[id] = boundedInteger(rawWeights[id], 1, 10, 1); });
    return {
      name: String(segment.name || 'Part').trim().slice(0, 40) || 'Part',
      quizIds: ids,
      weights,
      share: boundedInteger(segment.share, 1, 50, 10),
      settings: sanitizeCalculationSettings(segment.settings, difficulty)
    };
  }).filter(Boolean);
  const covered = [];
  segments.forEach(segment => segment.quizIds.forEach(id => { if (!covered.includes(id)) covered.push(id); }));
  if (segments.length < 2 || covered.length !== quizIds.length || covered.some(id => !quizIds.includes(id))) return [];
  return segments;
}

function sanitizeCalculationPracticeConfig(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const rawWeights = raw.weights && typeof raw.weights === 'object' ? raw.weights : {};
  const difficulty = ['easy', 'standard', 'exam', 'custom'].includes(raw.difficulty) ? raw.difficulty : 'standard';
  let quizIds = Array.isArray(raw.quizIds)
    ? Array.from(new Set(raw.quizIds.map(id => String(id || '').slice(0, 32)).filter(id => CALC_QUIZ_IDS.has(id))))
    : [];
  if (!quizIds.length) quizIds = ['addition', 'subtraction', 'mult1'];
  const weights = {};
  quizIds.forEach(id => { weights[id] = boundedInteger(rawWeights[id], 1, 10, 1); });
  const segments = sanitizeCalculationSegments(raw.segments, difficulty, quizIds);

  return {
    id: String(raw.id || '').slice(0, 80),
    name: String(raw.name || 'Calculation Practice').trim().slice(0, 40) || 'Calculation Practice',
    icon: String(raw.icon || '🧮').slice(0, 4),
    color: /^#[0-9a-f]{6}$/i.test(raw.color || '') ? raw.color : '#00C896',
    description: String(raw.description || '').trim().slice(0, 100),
    questionCount: boundedInteger(raw.questionCount, 3, 50, 10),
    difficulty,
    timerMinutes: [0, 3, 5, 10, 15].includes(Number(raw.timerMinutes)) ? Number(raw.timerMinutes) : 0,
    quizIds,
    weights,
    allowHints: raw.allowHints !== false,
    allowSkip: raw.allowSkip !== false,
    shuffle: raw.shuffle !== false,
    retryWrong: ['immediate', 'end', 'none'].includes(raw.retryWrong) ? raw.retryWrong : 'immediate',
    segments,
    sequential: segments.length >= 2 && raw.sequential !== false,
    settings: sanitizeCalculationSettings(raw.settings, difficulty)
  };
}

/* An attempt record the web app's own history sanitizer will accept. Scores are
   re-clamped and the completion time is server-owned. The attempt id comes from
   the client so that a retried submission is idempotent; `date` is deliberately
   omitted because streaks are computed against the user's LOCAL day, which only
   the browser knows — it is filled in when the app drains the attempt. */
function sanitizeMiniAppResult(raw, preset) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const total = boundedInteger(raw.total, 1, 50, preset.questionCount);
  const answered = Math.min(total, boundedInteger(raw.answered, 0, 50, 0));
  const firstTryCorrect = Math.min(total, boundedInteger(raw.firstTryCorrect, 0, 50, 0));
  const mistakeQuizIds = Array.isArray(raw.mistakeQuizIds)
    ? Array.from(new Set(raw.mistakeQuizIds.map(id => String(id || '').slice(0, 32))))
      .filter(id => CALC_QUIZ_IDS.has(id)).slice(0, 20)
    : [];
  const clientId = String(raw.id || '');
  return {
    id: /^[A-Za-z0-9_-]{6,60}$/.test(clientId)
      ? clientId
      : 'tgmini-' + crypto.randomUUID().replace(/-/g, '').slice(0, 20),
    presetId: preset.id,
    presetName: preset.name,
    completedAt: new Date().toISOString(),
    total,
    answered,
    firstTryCorrect,
    wrongAttempts: boundedInteger(raw.wrongAttempts, 0, 500, 0),
    hintsUsed: Math.min(total, boundedInteger(raw.hintsUsed, 0, 50, 0)),
    skipped: Math.min(total, boundedInteger(raw.skipped, 0, 50, 0)),
    durationSec: boundedInteger(raw.durationSec, 0, 86400, 0),
    reason: raw.reason === 'time' ? 'time' : 'completed',
    mistakeQuizIds,
    source: 'telegram-mini-app'
  };
}

/* Queue the attempt in a TOP-LEVEL inbox, deliberately NOT inside `appState`.
   The browser saves the whole `appState` map with merge:true (auto-save timer,
   page-exit flush, offline replay), and Firestore replaces arrays on merge — so
   an attempt written into appState.calculationPractice.history could be silently
   dropped by any tab with pending edits. This mirrors `telegramInbox`, which the
   app already drains for bot-created tasks. */
async function queueMiniAppAttempt(uid, attempt) {
  const ref = db.collection('users').doc(uid);
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    const data = snapshot.exists ? (snapshot.data() || {}) : {};
    const inbox = Array.isArray(data.calculationAttemptInbox) ? data.calculationAttemptInbox : [];
    if (inbox.some(entry => entry && entry.id === attempt.id)) return;
    const next = [attempt].concat(inbox).slice(0, 20);
    transaction.set(ref, { calculationAttemptInbox: next }, { merge: true });
  });
}

function requireMiniAppBackend() {
  if (!db || !global._fbAdmin) {
    throw Object.assign(new Error('Practice sync is temporarily unavailable. Try again shortly.'), { status: 503 });
  }
}

async function miniAppPresetForRequest(body) {
  const { telegramUserId } = verifyTelegramInitData(body && body.initData);
  requireMiniAppBackend();
  await enforceFirestoreRateLimit('calculationMiniAppRates', telegramUserId, 30, 60000,
    'Too many requests. Wait a minute and reopen the practice.');
  const account = await miniAppAccountForTelegramUser(telegramUserId);
  const presetId = String((body && body.presetId) || '').slice(0, 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(presetId)) {
    throw Object.assign(new Error('A valid presetId is required'), { status: 400 });
  }
  const calculation = ((account.data.appState || {}).calculationPractice) || {};
  const presets = Array.isArray(calculation.presets) ? calculation.presets : [];
  const rawPreset = presets.find(preset => preset && preset.id === presetId);
  if (!rawPreset) {
    throw Object.assign(new Error('This preset is no longer saved in your account.'), { status: 404 });
  }
  return { uid: account.uid, preset: sanitizeCalculationPracticeConfig(rawPreset) };
}

async function miniAppSaveResult(body) {
  const { telegramUserId } = verifyTelegramInitData(body && body.initData, MINI_APP_RESULT_MAX_AGE_SEC);
  requireMiniAppBackend();
  await enforceFirestoreRateLimit('calculationMiniAppResultRates', telegramUserId, 20, 60000,
    'Too many results. Wait a minute and try again.');
  const account = await miniAppAccountForTelegramUser(telegramUserId);
  const presetId = String((body && body.presetId) || '').slice(0, 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(presetId)) {
    throw Object.assign(new Error('A valid presetId is required'), { status: 400 });
  }
  const calculation = ((account.data.appState || {}).calculationPractice) || {};
  const presets = Array.isArray(calculation.presets) ? calculation.presets : [];
  const rawPreset = presets.find(preset => preset && preset.id === presetId);
  /* A preset deleted from another device mid-session must not cost the user
     their finished attempt: the preset is only needed for the display name. */
  const preset = rawPreset
    ? sanitizeCalculationPracticeConfig(rawPreset)
    : sanitizeCalculationPracticeConfig({
      id: presetId,
      name: String((body && body.result && body.result.presetName) || 'Calculation Practice'),
      quizIds: ['mult1']
    });
  const result = sanitizeMiniAppResult(body && body.result, preset);
  await queueMiniAppAttempt(account.uid, result);
  console.log(`🧮 Mini App attempt saved → uid:${account.uid} preset:${preset.id} ${result.firstTryCorrect}/${result.total}`);
  return { saved: true, attemptId: result.id };
}

/* Public, presentation-only view of the server's mock schema. Bounds are still
   enforced again on submit; returning them here only lets the form render the
   correct section labels and input limits without maintaining a third copy. */
function mockMiniAppExamConfig() {
  return Object.entries(TELEGRAM_MOCK_EXAMS).map(([examId, exam]) => ({
    id: examId,
    label: exam.label,
    tiers: Object.entries(exam.tiers).map(([tierId, tier]) => ({
      id: tierId,
      label: tier.label,
      sections: tier.sections.map(section => ({
        key: section[0],
        name: section[1],
        max: Math.round(Number(section[2]) * 100) / 100,
        min: Math.round(Number(section[3]) * 100) / 100
      }))
    }))
  }));
}

async function miniAppMockConfig(body) {
  const { telegramUserId } = verifyTelegramInitData(body && body.initData);
  requireMiniAppBackend();
  await enforceFirestoreRateLimit('mockMiniAppRates', telegramUserId, 30, 60000,
    'Too many requests. Wait a minute and reopen the mock form.');
  const account = await miniAppAccountForTelegramUser(telegramUserId);
  const selected = String(accountAppState(account).selectedExam || '');
  return {
    exams: mockMiniAppExamConfig(),
    defaultExam: TELEGRAM_MOCK_EXAMS[selected] ? selected : 'cgl',
    today: todayIST()
  };
}

function sanitizeMiniAppMock(body, account) {
  body = body && typeof body === 'object' ? body : {};
  const requestId = String(body.requestId || '');
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(requestId)) {
    throw Object.assign(new Error('A valid request id is required. Reopen the mock form.'), { status: 400 });
  }

  const exam = String(body.exam || '').toLowerCase();
  const examCfg = TELEGRAM_MOCK_EXAMS[exam];
  if (!examCfg) throw Object.assign(new Error('Choose a valid exam.'), { status: 400 });
  const tier = normalizeMockTier(exam, body.tier);
  const tierCfg = examCfg.tiers[tier];
  if (!tierCfg) throw Object.assign(new Error('Choose a valid tier or stage.'), { status: 400 });

  const rawMarks = body.marks && typeof body.marks === 'object' && !Array.isArray(body.marks)
    ? body.marks
    : null;
  if (!rawMarks) throw Object.assign(new Error('Section marks are required.'), { status: 400 });
  const expectedKeys = new Set(tierCfg.sections.map(section => section[0]));
  const receivedKeys = Object.keys(rawMarks);
  if (receivedKeys.length !== expectedKeys.size || receivedKeys.some(key => !expectedKeys.has(key))) {
    throw Object.assign(new Error('Enter marks for every section shown in the form.'), { status: 400 });
  }

  const sections = {};
  let total = 0;
  tierCfg.sections.forEach(section => {
    const raw = rawMarks[section[0]];
    if (raw === '' || raw == null || (typeof raw !== 'number' && typeof raw !== 'string')) {
      throw Object.assign(new Error(`${section[1]} marks are required.`), { status: 400 });
    }
    const mark = Number(raw);
    const minimum = Math.round(Number(section[3]) * 100) / 100;
    const maximum = Math.round(Number(section[2]) * 100) / 100;
    if (!Number.isFinite(mark) || mark < minimum || mark > maximum) {
      throw Object.assign(new Error(`${section[1]} marks must be between ${minimum} and ${maximum}.`), { status: 400 });
    }
    const rounded = Math.round(mark * 100) / 100;
    sections[section[0]] = { m: rounded };
    total += rounded;
  });

  const date = String(body.date || '');
  if (!validMockCalendarDate(date)) {
    throw Object.assign(new Error('Choose a valid mock date.'), { status: 400 });
  }
  const suppliedName = String(body.name || '').trim();
  if (suppliedName.length > 60) {
    throw Object.assign(new Error('Mock name must be 60 characters or fewer.'), { status: 400 });
  }
  /* Mini App retries must not change identity merely because the first write is
     now counted as pending. Use a stable descriptive default; the request id
     still lets separate unnamed submissions remain separate attempts. */
  const name = suppliedName || `${examCfg.label} ${tierCfg.label} Mock`;
  const roundedTotal = Math.round(total * 100) / 100;
  /* Bind the deterministic retry id to the normalized payload. An unchanged
     retry reuses the id, while edited marks/name/date produce a genuinely new
     attempt instead of acknowledging different data under an old id. */
  const payloadFingerprint = JSON.stringify({ exam, tier, name, date, sections, total: roundedTotal });
  const id = 'tgmock-' + crypto.createHash('sha256')
    .update(`${account.uid}\n${requestId}\n${payloadFingerprint}`)
    .digest('hex')
    .slice(0, 24);
  return {
    id,
    exam,
    tier,
    examCfg,
    tierCfg,
    attempt: {
      id,
      name,
      date,
      s: sections,
      total: roundedTotal,
      weakTopics: []
    }
  };
}

async function miniAppSaveMock(body) {
  const { telegramUserId } = verifyTelegramInitData(body && body.initData, MINI_APP_RESULT_MAX_AGE_SEC);
  requireMiniAppBackend();
  await enforceFirestoreRateLimit('mockMiniAppResultRates', telegramUserId, 20, 60000,
    'Too many mock results. Wait a minute and try again.');
  const account = await miniAppAccountForTelegramUser(telegramUserId);
  const result = sanitizeMiniAppMock(body, account);
  const queued = await queueMockAttempt(account.uid, {
    id: result.id,
    exam: result.exam,
    tier: result.tier,
    attempt: result.attempt,
    queuedAt: new Date().toISOString()
  });
  const storedAttempt = queued && queued.item && queued.item.attempt
    ? queued.item.attempt
    : result.attempt;
  console.log(`📝 Mock Mini App saved → uid:${account.uid} ${result.exam}/${result.tier} total:${storedAttempt.total}`);
  return {
    attemptId: storedAttempt.id,
    name: storedAttempt.name,
    total: storedAttempt.total,
    duplicate: !!(queued && queued.duplicate)
  };
}

/* Collect a bounded JSON body. Mini App payloads are small; anything larger is
   rejected before it is parsed. */
function readJsonBody(req, res, maxBytes) {
  return new Promise((resolve, reject) => {
    let body = '';
    let aborted = false;
    /* Decode as UTF-8 across chunk boundaries: concatenating raw Buffers would
       corrupt a multi-byte character split between chunks, which would break
       initData verification for non-Latin Telegram names. */
    req.setEncoding('utf8');
    req.on('data', chunk => {
      /* A later chunk can still arrive after the 413 was written; writing a
         second response would throw out of this listener and kill the process
         (the HTTP server shares it with the long-polling bot). */
      if (aborted) return;
      body += chunk;
      if (body.length > maxBytes) {
        aborted = true;
        /* Answer before dropping the connection, so the caller sees a real 413
           instead of an opaque network failure. `responded` tells the route not
           to write a second response. */
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'request too large' }), () => {
          try { req.destroy(); } catch (error) { /* already closed */ }
        });
        reject(Object.assign(new Error('request too large'), { status: 413, responded: true }));
      }
    });
    req.on('error', error => { if (!aborted) reject(error); });
    req.on('end', () => {
      if (aborted) return;
      try { resolve(JSON.parse(body || '{}')); }
      catch (error) { reject(Object.assign(new Error('valid JSON body required'), { status: 400 })); }
    });
  });
}

const server = http.createServer((req, res) => {

  const corsAllowed = setCors(req, res);
  if (req.headers.origin && !corsAllowed) {
    sendJson(res, 403, { ok: false, error: 'origin not allowed' });
    return;
  }

  /* Preflight */
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  /* Health check. "Alive" alone was misleading: the process answers this even
     when every Firestore-backed feature is dead, which is how a missing
     FIREBASE_SERVICE_ACCOUNT went unnoticed. */
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`StudyPlanner Bot is alive 🤖 — ${describeInstance()}`
      + `${db ? '' : ' — but Firestore is UNAVAILABLE, see /health'}`);
    return;
  }

  /* Deployment check. Deliberately always 200: an uptime monitor or a platform
     health check pointed here must not roll a deploy back over this, and `/`
     stays plain text for the keep-alive ping. `reason` is the fixed token from
     FIRESTORE_STATUS — the parser detail is never exposed, because it can quote
     the credential. `commands` confirms which build is actually live. */
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz')) {
    const ready = !!db;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      ok: ready,
      bot: 'alive',
      firestore: ready ? 'ready' : 'unavailable',
      reason: ready ? undefined : FIRESTORE_STATUS.code,
      allowedUpdates: ALLOWED_UPDATES,
      /* Identifies the build answering here. Comparing this across every bot URL
         is how a duplicate deployment gets found: two services reporting
         different commits are both competing for the same updates. */
      instance: INSTANCE,
      commands: BOT_COMMANDS.map(entry => '/' + entry.command)
    }));
    return;
  }

  /* ── Mini App: load mock exam/tier/section metadata ── */
  if (req.method === 'POST' && req.url === '/mini/mock-config') {
    (async () => {
      try {
        const body = await readJsonBody(req, res, 8192);
        const result = await miniAppMockConfig(body);
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        console.error('❌ /mini/mock-config error:', error.message);
        if (!error.responded) sendJson(res, error.status || 500, { ok: false, error: error.message || 'request failed' });
      }
    })();
    return;
  }

  /* ── Mini App: validate and queue a graphical mock-marks submission ── */
  if (req.method === 'POST' && req.url === '/mini/mock-result') {
    (async () => {
      try {
        const body = await readJsonBody(req, res, 8192);
        const result = await miniAppSaveMock(body);
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        console.error('❌ /mini/mock-result error:', error.message);
        if (!error.responded) sendJson(res, error.status || 500, { ok: false, error: error.message || 'request failed' });
      }
    })();
    return;
  }

  /* ── Mini App: fetch the preset to practise, authorized by Telegram initData ── */
  if (req.method === 'POST' && req.url === '/mini/calculation-preset') {
    (async () => {
      try {
        const body = await readJsonBody(req, res, 8192);
        const result = await miniAppPresetForRequest(body);
        sendJson(res, 200, { ok: true, preset: result.preset });
      } catch (error) {
        console.error('❌ /mini/calculation-preset error:', error.message);
        if (!error.responded) sendJson(res, error.status || 500, { ok: false, error: error.message || 'request failed' });
      }
    })();
    return;
  }

  /* ── Mini App: store a finished attempt in the linked account ── */
  if (req.method === 'POST' && req.url === '/mini/calculation-result') {
    (async () => {
      try {
        const body = await readJsonBody(req, res, 8192);
        const result = await miniAppSaveResult(body);
        sendJson(res, 200, { ok: true, attemptId: result.attemptId });
      } catch (error) {
        console.error('❌ /mini/calculation-result error:', error.message);
        if (!error.responded) sendJson(res, error.status || 500, { ok: false, error: error.message || 'request failed' });
      }
    })();
    return;
  }

  /* ── POST /study-circles/join — authenticated private/public membership ── */
  if (req.method === 'POST' && req.url === '/study-circles/join') {
    (async () => {
      try {
        const actor = await requireFirebaseUser(req);
        const body = await readJsonBody(req, res, 2048);
        await enforceFirestoreRateLimit('studyCircleJoinRates', actor.uid, 10, 60 * 60 * 1000,
          'Too many circle join attempts. Try again later.');
        const result = await joinStudyCircle(actor, body);
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        console.error('❌ /study-circles/join error:', error.message);
        if (!error.responded) sendJson(res, error.status || 500, { ok: false, error: error.message || 'request failed' });
      }
    })();
    return;
  }

  /* ── POST /study-circles/visibility — rotate/clear private invite code ── */
  if (req.method === 'POST' && req.url === '/study-circles/visibility') {
    (async () => {
      try {
        const actor = await requireFirebaseUser(req);
        const body = await readJsonBody(req, res, 2048);
        await enforceFirestoreRateLimit('studyCircleVisibilityRates', actor.uid, 20, 60 * 60 * 1000,
          'Too many circle visibility changes. Try again later.');
        const result = await updateStudyCircleVisibility(actor, body);
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        console.error('❌ /study-circles/visibility error:', error.message);
        if (!error.responded) sendJson(res, error.status || 500, { ok: false, error: error.message || 'request failed' });
      }
    })();
    return;
  }

  /* ── POST /referrals/claim — authenticated, transactional reward grant ── */
  if (req.method === 'POST' && req.url === '/referrals/claim') {
    (async () => {
      try {
        const actor = await requireFirebaseUser(req);
        const body = await readJsonBody(req, res, 4096);
        await enforceFirestoreRateLimit('referralClaimRates', actor.uid, 5, 60 * 60 * 1000,
          'Too many referral attempts. Try again later.');
        const result = await claimReferralReward(actor.uid, body.referrerUid);
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        console.error('❌ /referrals/claim error:', error.message);
        if (!error.responded) sendJson(res, error.status || 500, { ok: false, error: error.message || 'request failed' });
      }
    })();
    return;
  }

  /* ── POST /payments/submit — authenticated commerce transaction ── */
  if (req.method === 'POST' && req.url === '/payments/submit') {
    (async () => {
      try {
        const actor = await requireFirebaseUser(req);
        const body = await readJsonBody(req, res, 5 * 1024 * 1024);
        await enforceFirestoreRateLimit('paymentSubmitRates', actor.uid, 10, 60 * 60 * 1000,
          'Too many payment submissions. Try again later.');
        const result = await submitPaymentForUser(actor, body);
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        console.error('❌ /payments/submit error:', error.message);
        if (!error.responded) sendJson(res, error.status || 500, { ok: false, error: error.message || 'request failed' });
      }
    })();
    return;
  }

  /* ── POST /payments/proof-url — short-lived admin-only proof access ── */
  if (req.method === 'POST' && req.url === '/payments/proof-url') {
    (async () => {
      try {
        const actor = await requireFirebaseUser(req);
        const body = await readJsonBody(req, res, 2048);
        const result = await paymentProofUrlForAdmin(actor.uid, body.paymentId);
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        console.error('❌ /payments/proof-url error:', error.message);
        if (!error.responded) sendJson(res, error.status || 500, { ok: false, error: error.message || 'request failed' });
      }
    })();
    return;
  }

  /* ── POST /trials/start — one-time server-authoritative Pro trial ── */
  if (req.method === 'POST' && req.url === '/trials/start') {
    (async () => {
      try {
        const actor = await requireFirebaseUser(req);
        await enforceFirestoreRateLimit('trialStartRates', actor.uid, 3, 60 * 60 * 1000,
          'Too many trial attempts. Try again later.');
        const result = await startSelfServeTrial(actor.uid);
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        console.error('❌ /trials/start error:', error.message);
        sendJson(res, error.status || 500, { ok: false, error: error.message || 'request failed' });
      }
    })();
    return;
  }

  /* ── POST /send-calculation-preset — authenticated, server-derived send ── */
  if (req.method === 'POST' && req.url === '/send-calculation-preset') {
    let body = '';
    let aborted = false;
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 4096) {
        aborted = true;
        sendJson(res, 413, { ok: false, error: 'request too large' });
        req.destroy();
      }
    });
    req.on('end', async () => {
      if (aborted) return;
      try {
        const actor = await requireFirebaseUser(req);
        let parsed;
        try { parsed = JSON.parse(body || '{}'); }
        catch (parseError) { throw Object.assign(new Error('valid JSON body required'), { status: 400 }); }
        const presetId = typeof parsed.presetId === 'string' ? parsed.presetId : '';
        const requestId = typeof parsed.requestId === 'string' ? parsed.requestId : '';
        const presetFingerprint = typeof parsed.presetFingerprint === 'string' ? parsed.presetFingerprint : '';
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(presetId) ||
            !/^[A-Za-z0-9][A-Za-z0-9_-]{7,99}$/.test(requestId) ||
            !/^[a-f0-9]{64}$/.test(presetFingerprint)) {
          throw Object.assign(new Error('valid presetId, requestId, and presetFingerprint are required'), { status: 400 });
        }
        await enforceCalculationPresetRateLimit(actor.uid);
        const result = await sendCalculationPresetForUser(
          actor.uid, presetId, requestId, presetFingerprint, appBaseUrlForRequest(req));
        sendJson(res, 200, { ok: true, duplicate: result.duplicate === true });
      } catch (error) {
        console.error('❌ /send-calculation-preset error:', error.message);
        sendJson(res, error.status || 500, {
          ok: false,
          error: error.message || 'send failed',
          retryWithNewRequest: error.retryWithNewRequest === true
        });
      }
    });
    return;
  }

  /* ── POST /send — proxy Telegram sendMessage ── */
  if (req.method === 'POST' && req.url === '/send') {
    let body = '';
    let bodyBytes = 0;
    let aborted = false;
    req.on('data', chunk => {
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_RELAY_BODY_BYTES) {
        aborted = true;
        sendJson(res, 413, { ok: false, error: 'request too large' });
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', async () => {
      if (aborted) return;
      try {
        const actor = await requireFirebaseUser(req);
        if (!await isAdminUid(actor.uid)) throw Object.assign(new Error('admin access required'), { status: 403 });
        const { chatId, text } = JSON.parse(body);
        if (!/^-?\d+$/.test(String(chatId || '')) || typeof text !== 'string' || !text.trim()) {
          throw Object.assign(new Error('numeric chatId and text are required'), { status: 400 });
        }
        if (text.length > 4096) throw Object.assign(new Error('message too long'), { status: 400 });

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
          const errMsg = tgRes.description || String(tgRes.error_code);
          console.error(`❌ /send failed for ${chatId}: ${errMsg}`);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: errMsg }));
        } else {
          console.log(`✅ /send → chatId:${chatId}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        }
      } catch (e) {
        console.error('❌ /send error:', e.message);
        sendJson(res, e.status || 500, { ok: false, error: e.message });
      }
    });
    return;
  }

  /* ── POST /send-photo — relay a Turbo screenshot for a Pro account ──
     Body: JSON { imageBase64, caption }. The destination is derived from the
     verified Firebase account; no browser-supplied chat ID is accepted. */
  if (req.method === 'POST' && req.url === '/send-photo') {
    let body = '';
    let aborted = false;
    req.on('data', chunk => {
      body += chunk;
      // Guard against oversized uploads (JPEG frames are ~0.1–0.4 MB; base64
      // inflates ~33%). Cap the raw body at 12 MB and reject anything larger.
      if (body.length > 12 * 1024 * 1024) {
        aborted = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'image too large' }));
        req.destroy();
      }
    });
    req.on('end', async () => {
      if (aborted) return;
      try {
        const actor = await requireFirebaseUser(req);
        const relayUser = await proRelayUser(actor.uid);
        const { imageBase64, caption } = JSON.parse(body);
        const chatId = telegramChatForUserData(relayUser);
        if (!chatId) throw Object.assign(new Error('Connect a Telegram chat in your profile first'), { status: 400 });
        if (typeof imageBase64 !== 'string' || !imageBase64) {
          throw Object.assign(new Error('imageBase64 is required'), { status: 400 });
        }

        if (photoRateLimited(actor.uid)) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Too many screenshots — ek minute baad try karo.' }));
          return;
        }

        const buffer = Buffer.from(imageBase64, 'base64');
        if (!buffer.length) throw Object.assign(new Error('empty image'), { status: 400 });
        if (buffer.length > 8 * 1024 * 1024) throw Object.assign(new Error('image too large'), { status: 413 });
        const isImage = (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) ||
          buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
          (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP');
        if (!isImage) throw Object.assign(new Error('unsupported image format'), { status: 400 });

        /* Destination: if this user ran /setup in a group, route the screenshot
           to that group's "📸 Images" topic; otherwise fall back to their DM. */
        let target = chatId;
        const opts = { caption: (caption || '').slice(0, 1024), parse_mode: 'HTML' };
        if (db) {
          try {
            const g = await db.collection('telegram_groups').doc(String(chatId)).get();
            const gd = g.exists ? g.data() : null;
            if (gd && gd.groupId) {
              target = gd.groupId;
              if (gd.imagesTopicId) opts.message_thread_id = gd.imagesTopicId;
            }
          } catch (e) { /* fall back to DM on any lookup error */ }
        }

        const sent = await bot.sendPhoto(
          target,
          buffer,
          opts,
          { filename: 'turbo-frame.jpg', contentType: 'image/jpeg' }
        );
        const photos = (sent && sent.photo) || [];
        let fileId = photos.length ? String(photos[photos.length - 1].file_id || '') : '';
        if (fileId && !await rememberTelegramMediaOwner(actor.uid, fileId, 'bot-relay')) {
          console.error(`Photo delivered but could not record media owner for uid:${actor.uid}`);
          fileId = '';
        }

        console.log(`✅ /send-photo → ${target === chatId ? 'DM' : 'group ' + target + ' topic ' + opts.message_thread_id} (from chatId:${chatId}, ${buffer.length} bytes)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, fileId }));
      } catch (e) {
        const errMsg = (e && e.response && e.response.body && e.response.body.description) || e.message;
        console.error('❌ /send-photo error:', errMsg);
        sendJson(res, e.status || 400, { ok: false, error: errMsg });
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
