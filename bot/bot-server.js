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
const { isProUser } = require('../shared/proGating');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN env var missing. Set it in Render dashboard.');
  process.exit(1);
}

/* ── Firebase Admin (optional but required for AI auto-scheduling) ─────────── */
let db = null;
try {
  const admin = require('firebase-admin');
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT || '';
  if (raw.trim()) {
    const svc = JSON.parse(raw);
    if (svc.project_id && svc.private_key) {
      admin.initializeApp({ credential: admin.credential.cert(svc) });
      db = admin.firestore();
      global._fbAdmin = admin; // for FieldValue
      console.log(`✅ Firebase Admin ready (project: ${svc.project_id}) — AI auto-schedule enabled`);
    } else {
      console.warn('⚠️  FIREBASE_SERVICE_ACCOUNT incomplete — AI auto-schedule disabled.');
    }
  } else {
    console.warn('⚠️  FIREBASE_SERVICE_ACCOUNT not set — AI auto-schedule disabled (Chat-ID replies still work).');
  }
} catch (e) {
  console.warn('⚠️  Could not init Firebase Admin:', e.message, '— AI auto-schedule disabled.');
}

const bot = new TelegramBot(TOKEN, { polling: true });
console.log('🤖 StudyPlanner Bot running (long-polling)...');

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
    `/id — Chat ID dobara dekho\n` +
    `/setup — (Ek group mein) apne screenshots ke liye ek 📸 Images topic banao\n` +
    `/help — Yeh help message\n\n` +
    `🧠 <b>AI auto-schedule:</b> Bas apna task likho (e.g. "Polity Article 14 kal") ` +
    `ya YouTube link bhejo — main planner mein add kar dunga.\n\n` +
    `📸 <b>Screenshots alag rakhne ke liye:</b> ek group banao → Settings → <b>Topics</b> ON ` +
    `→ mujhe admin (Manage Topics) banao → group mein <b>/setup</b> bhejo. Uske baad tumhare ` +
    `Turbo screenshots seedhe us group ke <b>📸 Images</b> topic mein jayenge (daily plan DM mein hi rahega).\n\n` +
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
  { command: 'start', description: 'Connect the bot and get your Chat ID' },
  { command: 'calc',  description: "Start today's Calculation Practice" },
  { command: 'id',    description: 'Show your Chat ID again' },
  { command: 'setup', description: 'Send your screenshots to a group topic' },
  { command: 'help',  description: 'What this bot can do' }
];
bot.setMyCommands(BOT_COMMANDS)
  .then(() => console.log(`⌨️  Command menu registered (${BOT_COMMANDS.map(entry => '/' + entry.command).join(' ')})`))
  .catch(err => console.warn('⚠️  setMyCommands failed:', err.message, '— commands still work, autocomplete may be stale.'));

/* ── /setup ───────────────────────────────────────────────────────────────
   Option B: the user creates their OWN forum supergroup, adds this bot as an
   admin (with "Manage Topics"), and runs /setup inside it. The bot creates a
   "📸 Images" topic and remembers { groupId, imagesTopicId } keyed by the
   user's Telegram id (which equals their private-chat / app chatId). After
   that, their Turbo screenshots are routed to that topic (see /send-photo).

   A bot CANNOT create a group/channel itself (Bot API limitation), so the
   group creation is the one manual step; everything after is automatic. */
bot.onText(/^\/setup(?:@\w+)?$/, async (msg) => {
  const chat   = msg.chat;
  const fromId = msg.from && msg.from.id;

  if (chat.type !== 'supergroup') {
    bot.sendMessage(chat.id,
      `⚠️ Yeh command ek <b>group</b> mein chalao (private chat mein nahi).\n\n` +
      `1️⃣ Ek naya group banao\n2️⃣ Group Settings → <b>Topics</b> ON karo\n` +
      `3️⃣ Mujhe us group mein <b>admin</b> banao (Manage Topics permission ke saath)\n` +
      `4️⃣ Phir group mein <b>/setup</b> bhejo.`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
    return;
  }
  if (!chat.is_forum) {
    bot.sendMessage(chat.id,
      `⚠️ Is group mein <b>Topics</b> OFF hai. Group Settings → <b>Topics</b> ON karo, phir dobara <b>/setup</b> bhejo.`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
    return;
  }
  if (!db) {
    bot.sendMessage(chat.id, '⚠️ Server config missing — setup abhi save nahi ho sakta.').catch(() => {});
    return;
  }

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
    console.log(`✅ /setup → user:${fromId} group:${chat.id} topic:${threadId}`);
  } catch (e) {
    const errMsg = (e && e.response && e.response.body && e.response.body.description) || e.message;
    bot.sendMessage(chat.id,
      `❌ Topic nahi bana paya: ${errMsg}\n\n` +
      `Check karo: kya main is group ka <b>admin</b> hoon <b>"Manage Topics"</b> permission ke saath?`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
    console.error('❌ /setup error:', errMsg);
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

/* ── Polling error handler ──────────────────────────────────────────────── */
bot.on('polling_error', (err) => {
  console.error('⚠️  Polling error:', err.code, err.message);
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
  res.writeHead(status, { 'Content-Type': 'application/json' });
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
const CALC_COMMAND_USAGE = 'Daily preset ke liye <code>/calc</code> bhejo, ya kisi bhi preset ke liye <code>/calc &lt;name&gt;</code>.';
const CALC_PRESET_LIST_LIMIT = 10;

function calculationPresetLabel(preset) {
  const icon = escapeTelegramHtml(String((preset && preset.icon) || '🧮').slice(0, 4));
  const name = escapeTelegramHtml(String((preset && preset.name) || 'Practice').trim().slice(0, 40) || 'Practice');
  return `${icon} <b>${name}</b>`;
}

function calculationPresetChoices(presets) {
  const lines = presets.slice(0, CALC_PRESET_LIST_LIMIT).map(preset => `• ${calculationPresetLabel(preset)}`);
  if (presets.length > CALC_PRESET_LIST_LIMIT) {
    lines.push(`…aur ${presets.length - CALC_PRESET_LIST_LIMIT} more`);
  }
  return lines.join('\n');
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

/* Same Mini App button fallback as sendCalculationPresetForUser: a rejected
   web_app button must not cost the user the whole message. */
async function sendCalculationPracticeMessage(chatId, preset, note) {
  const body = calculationPresetText(preset) + (note ? `\n\n${note}` : '');
  const send = rows => bot.sendMessage(chatId, body, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: rows }
  });
  try {
    return await send(calculationPracticeButtons(FALLBACK_APP_BASE_URL, preset.id));
  } catch (buttonError) {
    const description = (buttonError && buttonError.response && buttonError.response.body
      && buttonError.response.body.description) || buttonError.message;
    if (!isTelegramButtonRejection(description)) throw buttonError;
    console.warn(`⚠️  Telegram refused the Mini App button (${description}) — sending the browser link instead.`);
    return send(calculationPracticeButtons(FALLBACK_APP_BASE_URL, preset.id, { browserOnly: true }));
  }
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
  if (!db) {
    bot.sendMessage(chatId, '⚠️ Server config missing — practice abhi nahi bhej sakta.').catch(() => {});
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
          ? `🤔 "<b>${escapeTelegramHtml(query)}</b>" se ek se zyada preset match hue:`
          : `🤔 "<b>${escapeTelegramHtml(query)}</b>" naam ka koi preset nahi mila. Tumhare presets:`;
        await bot.sendMessage(chatId,
          `${heading}\n${calculationPresetChoices(ambiguous ? found.matches : presets)}\n\n${CALC_COMMAND_USAGE}`,
          { parse_mode: 'HTML', disable_web_page_preview: true });
        return;
      }
      preset = found.preset;
    } else {
      /* One preset needs no disambiguation, so treat it as the default even
         when the user never marked a daily one. */
      preset = presets.find(item => item.id === calculation.dailyPresetId)
        || (presets.length === 1 ? presets[0] : null);
      if (!preset) {
        await bot.sendMessage(chatId,
          `🧮 <b>Koi daily preset set nahi hai.</b> Tumhare presets:\n${calculationPresetChoices(presets)}\n\n${CALC_COMMAND_USAGE}`,
          { parse_mode: 'HTML', disable_web_page_preview: true });
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

  /* Health check */
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('StudyPlanner Bot is alive 🤖');
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
            if (gd && gd.groupId && gd.imagesTopicId) {
              target = gd.groupId;
              opts.message_thread_id = gd.imagesTopicId;
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
