/**
 * StudyPlanner Telegram Bot Server
 * ─────────────────────────────────────────────────────────────────────────────
 * Two jobs:
 *   1. Reply with the user's Chat ID on /start  (existing connect flow)
 *   2. AI auto-schedule: when a connected user sends a task or a YouTube link,
 *      parse it with Groq, auto-detect the subject, and drop it into their
 *      planner To-Do list (via the user doc's `telegramInbox` field).
 *
 * Routes:
 *   GET  /                       → health check
 *   POST /telegram-link/start    → create Firebase-authenticated one-time link
 *   POST /telegram-link/status   → verify chat ownership for signed-in user
 *   POST /trial/start            → issue one trusted self-serve Pro trial
 *   POST /send                   → admin-only Telegram message relay
 *   POST /send-photo             → authenticated Pro screenshot relay;
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
const http        = require('http');
const https       = require('https');
const crypto      = require('crypto');
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

/** Find the connected user from the server-owned verified link. */
async function findUserByChatId(chatId) {
  if (!db) return null;
  const cid = String(chatId);
  try {
    const link = await db.collection('telegram_links').doc(cid).get();
    const linkData = link.exists ? (link.data() || {}) : {};
    const uid = linkData.verified === true && linkData.method === 'challenge-v1'
      ? String(linkData.uid || '') : '';
    if (!uid) return null;
    const user = await db.collection('users').doc(uid).get();
    if (user.exists) return { uid: user.id, data: user.data() || {} };
  } catch (e) { console.warn('⚠️  verified Telegram link lookup failed:', e.message); }
  return null;
}

const TELEGRAM_LINK_TTL_MS = 10 * 60 * 1000;
function telegramLinkChallengeId(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

async function createTelegramLinkChallenge(uid) {
  if (!db || !global._fbAdmin || !uid) throw Object.assign(new Error('linking unavailable'), { status: 503 });
  const token = crypto.randomBytes(24).toString('base64url');
  await db.collection('telegram_link_challenges').doc(telegramLinkChallengeId(token)).set({
    uid,
    createdAt: global._fbAdmin.firestore.FieldValue.serverTimestamp(),
    expiresAt: global._fbAdmin.firestore.Timestamp.fromMillis(Date.now() + TELEGRAM_LINK_TTL_MS)
  });
  return token;
}

async function consumeTelegramLinkChallenge(token, msg) {
  const isPrivateOwnerChat = msg && msg.chat && msg.chat.type === 'private'
    && msg.from && String(msg.from.id) === String(msg.chat.id);
  if (!db || !global._fbAdmin || !isPrivateOwnerChat
      || !/^[A-Za-z0-9_-]{32}$/.test(String(token || ''))) return null;
  const challengeRef = db.collection('telegram_link_challenges').doc(telegramLinkChallengeId(token));
  const chatId = String(msg.chat.id);
  return db.runTransaction(async (tx) => {
    const challenge = await tx.get(challengeRef);
    if (!challenge.exists) return null;
    const challengeData = challenge.data() || {};
    const expiresAt = challengeData.expiresAt && challengeData.expiresAt.toMillis
      ? challengeData.expiresAt.toMillis() : 0;
    const uid = String(challengeData.uid || '');
    if (!uid || expiresAt < Date.now()) {
      tx.delete(challengeRef);
      return null;
    }
    tx.set(db.collection('telegram_links').doc(chatId), {
      uid,
      username: (msg.from && msg.from.username) || '',
      verified: true,
      method: 'challenge-v1',
      linkedAt: global._fbAdmin.firestore.FieldValue.serverTimestamp()
    });
    tx.delete(challengeRef);
    return uid;
  });
}

async function verifiedTelegramChatForUid(uid, claimedChatId) {
  const chatId = String(claimedChatId || '').trim();
  if (!db || !uid || !/^-?\d+$/.test(chatId)) return '';
  const link = await db.collection('telegram_links').doc(chatId).get();
  const data = link.exists ? (link.data() || {}) : {};
  return data.verified === true
    && data.method === 'challenge-v1'
    && String(data.uid || '') === String(uid) ? chatId : '';
}

async function issueSelfServeTrial(uid) {
  if (!db || !global._fbAdmin || !uid) throw Object.assign(new Error('trial service unavailable'), { status: 503 });
  const userRef = db.collection('users').doc(uid);
  const now = new Date();
  const expiresAtMs = now.getTime() + 7 * 86400000;
  const expiry = new Date(expiresAtMs).toISOString().slice(0, 10);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) throw Object.assign(new Error('user profile not found'), { status: 404 });
    const data = snap.data() || {};
    const profile = data.profile || {};
    const appState = data.appState || {};
    if ((profile.plan && profile.plan !== 'free') || profile.trialExpiry || profile.trialExpiresAt) {
      throw Object.assign(new Error('This account already has Pro access or used its trial.'), { status: 409 });
    }
    if (profile.proTrialUsed || (appState.proTrial && appState.proTrial.startedAt) || appState.proTrialUsed) {
      throw Object.assign(new Error('The free trial has already been used on this account.'), { status: 409 });
    }
    tx.set(userRef, {
      profile: {
        proTrialUsed: true,
        proTrialStartedAt: global._fbAdmin.firestore.FieldValue.serverTimestamp(),
        trialExpiresAt: global._fbAdmin.firestore.Timestamp.fromMillis(expiresAtMs),
        trialExpiry: expiry,
        trialSource: 'self-serve-v1'
      }
    }, { merge: true });
  });
  return { startedAt: now.toISOString(), expiresAt: new Date(expiresAtMs).toISOString(), expiry, days: 7 };
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

/* ── /start handler — consumes a one-time app-issued linking challenge ──── */
bot.onText(/^\/start(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const name   = msg.from.first_name || 'Student';
  const token  = match && match[1] ? match[1].trim() : '';
  let linkedUid = null;

  if (token) {
    try { linkedUid = await consumeTelegramLinkChallenge(token, msg); }
    catch (error) { console.warn('Telegram link challenge failed:', error.message); }
  }

  const linkLine = linkedUid
    ? '✅ <b>Telegram securely linked to your StudyPlanner account.</b>\n\n'
    : token
      ? '⚠️ <b>This secure link is invalid or expired.</b> App mein Connect Telegram dobara dabao.\n\n'
      : '🔒 Securely connect karne ke liye StudyPlanner app mein <b>Connect Telegram</b> dabao.\n\n';
  const aiLine = linkedUid
    ? '\n\n🧠 <b>Naya!</b> Ab tum mujhe apna aaj ka task ya YouTube link bhej sakte ho — ' +
      'main use tumhare planner ki To-Do list mein add kar dunga (subject auto-detect karke).'
    : '';

  const text =
    `👋 Namaste <b>${name}</b>!\n\n` +
    linkLine +
    `📋 <b>Tumhara Telegram Chat ID:</b>\n` +
    `<code>${chatId}</code>\n\n` +
    `👆 Is number ko StudyPlanner ke Chat ID field mein paste karke notifications ON aur Save karo.\n\n` +
    (linkedUid ? `📚 Phir roz <b>6:00 AM IST</b> pe aaj ka study plan yahan milega!` : '') +
    aiLine;
  bot.sendMessage(chatId, text, { parse_mode: 'HTML' })
    .then(() => console.log(`${linkedUid ? '✅ Linked and replied' : 'ℹ️ Replied'} to chat ${chatId} (${name})`))
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
bot.onText(/^\/help$/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `📖 <b>StudyPlanner Bot Commands:</b>\n\n` +
    `/start — Apna Chat ID pao\n` +
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
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS ||
  'https://examzen.in,https://www.examzen.in,https://appassets.androidengine,http://localhost:5173')
  .split(',').map(origin => origin.trim().replace(/\/$/, '')).filter(Boolean));
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

function telegramChatClaimForUserData(userData) {
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
  return crypto.createHash('sha256').update(uid + '\n' + fileId).digest('hex');
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
  return crypto.createHmac('sha256', secret).update(uid + '\n' + fileId).digest('hex');
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

  /* ── Secure Telegram account linking ──────────────────────────────────
     Firebase-authenticated browser creates a short-lived random challenge;
     only the Telegram account that sends that challenge back to this bot can
     create the server-owned chatId → UID mapping. */
  if (req.method === 'POST' && (
    req.url === '/telegram-link/start'
    || req.url === '/telegram-link/status'
    || req.url === '/trial/start'
  )) {
    let body = '';
    let bodyBytes = 0;
    let aborted = false;
    req.on('data', chunk => {
      bodyBytes += chunk.length;
      if (bodyBytes > 4096) {
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
        if (req.url === '/trial/start') {
          if (rateLimited('trial:' + actor.uid)) {
            throw Object.assign(new Error('Too many trial attempts. Try again in a minute.'), { status: 429 });
          }
          const trial = await issueSelfServeTrial(actor.uid);
          sendJson(res, 200, { ok: true, trial });
          return;
        }
        if (req.url === '/telegram-link/start') {
          if (rateLimited('link:' + actor.uid)) {
            throw Object.assign(new Error('Too many link attempts. Try again in a minute.'), { status: 429 });
          }
          const token = await createTelegramLinkChallenge(actor.uid);
          sendJson(res, 200, {
            ok: true,
            url: `https://t.me/SSCplannerbot?start=${encodeURIComponent(token)}`,
            expiresInSeconds: TELEGRAM_LINK_TTL_MS / 1000
          });
          return;
        }

        const payload = body ? JSON.parse(body) : {};
        const chatId = String(payload.chatId || '').trim();
        const verified = !!(await verifiedTelegramChatForUid(actor.uid, chatId));
        sendJson(res, 200, { ok: true, verified });
      } catch (error) {
        sendJson(res, error.status || 400, { ok: false, error: error.message || 'linking failed' });
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
        const claimedChatId = telegramChatClaimForUserData(relayUser);
        const chatId = await verifiedTelegramChatForUid(actor.uid, claimedChatId);
        if (!chatId) throw Object.assign(new Error('Securely link this Telegram chat in your profile first'), { status: 400 });
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
