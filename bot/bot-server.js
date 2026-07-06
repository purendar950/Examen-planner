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
 *   GET  /          → health check
 *   POST /send      → proxy: sends a Telegram message server-side (CORS-safe)
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
let fbAdmin = null; // module-level ref so the /send route can verify ID tokens
try {
  const admin = require('firebase-admin');
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT || '';
  if (raw.trim()) {
    const svc = JSON.parse(raw);
    if (svc.project_id && svc.private_key) {
      admin.initializeApp({
        credential: admin.credential.cert(svc),
        // Explicit projectId: cert() usually infers this, but on some hosts it
        // doesn't propagate to auth().verifyIdToken(), which then throws
        // auth/argument-error because it can't resolve the project to check the
        // token's audience against. Setting it explicitly removes that failure.
        projectId: svc.project_id
      });
      db = admin.firestore();
      fbAdmin = admin;
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
  const re = /(?:youtube\.com\/(?:watch\?(?:[^ ]*&)?v=|embed\/|shorts\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/g;
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
bot.onText(/^\/help$/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `📖 <b>StudyPlanner Bot Commands:</b>\n\n` +
    `/start — Apna Chat ID pao\n` +
    `/id — Chat ID dobara dekho\n` +
    `/help — Yeh help message\n\n` +
    `🧠 <b>AI auto-schedule:</b> Bas apna task likho (e.g. "Polity Article 14 kal") ` +
    `ya YouTube link bhejo — main planner mein add kar dunga.\n\n` +
    `🌐 App: <a href="https://examzen.in">examzen.in</a>`,
    { parse_mode: 'HTML', disable_web_page_preview: true }
  ).catch(err => console.error('sendMessage error:', err.message));
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

/* ── Polling error handler ──────────────────────────────────────────────── */
bot.on('polling_error', (err) => {
  console.error('⚠️  Polling error:', err.code, err.message);
});

/* ════════════════════════════════════════════════════════════════════════════
   HTTP Server (health check + /send proxy)
   ════════════════════════════════════════════════════════════════════════════ */
const PORT = process.env.PORT || 3000;

/* ── Admin auth for /send ────────────────────────────────────────────────────
   The /send proxy relays arbitrary messages through the bot token, so it must
   be admin-only (previously it was open to the whole internet). We verify the
   caller's Firebase ID token — sent by the admin panel as
   `Authorization: Bearer <idToken>` — and confirm an admins/{uid} doc exists,
   the same check admin-core.js runs client-side. Fails CLOSED: if Firebase
   Admin isn't configured we can't verify anyone, so we refuse rather than relay.
   (The daily cron in scripts/send-telegram.js talks to Telegram directly and
   never touches /send, so it is unaffected.) */
/* ── Google public-cert fetch + manual ID-token verification ─────────────────
   Some hosts (notably free-tier PaaS egress IPs) get an HTML "your client does
   not have permission" page back from Google's x509 cert endpoint instead of
   JSON. firebase-admin's internal fetch then throws `auth/argument-error:
   Error fetching public keys for Google certs`, which is NOT a bad token — the
   server just couldn't reach Google to verify a perfectly valid one.

   To stay resilient we (1) retry verifyIdToken a couple of times (the block is
   often intermittent), and (2) fall back to verifying the token ourselves:
   fetch the certs with the runtime's own fetch (a different HTTP path than the
   SDK's), then check the RS256 signature + standard Firebase claims. This uses
   only Node's built-in `crypto`, no extra dependency, and mirrors the exact
   checks documented for manual Firebase ID-token verification. */

const GOOGLE_X509_URL =
  'https://www.googleapis.com/robots/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let _certCache = { certs: null, exp: 0 };

/** True when an error is the "can't fetch Google certs" network failure. */
function isCertFetchError(e) {
  const msg = String((e && e.message) || '');
  return /public keys for Google certs/i.test(msg) ||
         /does not have permission to get URL/i.test(msg) ||
         /<!DOCTYPE html>/i.test(msg);
}

/** Fetch Google's securetoken x509 certs (kid → PEM), honouring cache-control. */
async function fetchGoogleCerts() {
  const now = Date.now();
  if (_certCache.certs && now < _certCache.exp) return _certCache.certs;
  const r = await fetch(GOOGLE_X509_URL, { headers: { Accept: 'application/json' } });
  const body = await r.text();
  if (!r.ok || body.trim().startsWith('<')) {
    throw new Error('Error fetching public keys for Google certs: ' + body.slice(0, 120));
  }
  const certs = JSON.parse(body);
  let maxAge = 3600;
  const cc = r.headers.get('cache-control') || '';
  const mm = /max-age=(\d+)/.exec(cc);
  if (mm) maxAge = parseInt(mm[1], 10);
  _certCache = { certs, exp: now + Math.max(60, maxAge) * 1000 };
  return certs;
}

function b64urlToBuf(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Verify a Firebase ID token by hand (signature + claims). Returns the decoded
 * payload ({ sub: uid, ... }) or throws. `projectId` is the Firebase project.
 */
async function verifyIdTokenManually(idToken, projectId) {
  const parts = String(idToken).split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const header  = JSON.parse(b64urlToBuf(parts[0]).toString('utf8'));
  const payload = JSON.parse(b64urlToBuf(parts[1]).toString('utf8'));
  if (header.alg !== 'RS256') throw new Error('unexpected alg ' + header.alg);
  if (!header.kid) throw new Error('no kid in token header');

  const certs = await fetchGoogleCerts();
  const pem = certs[header.kid];
  if (!pem) throw new Error('no matching public key for kid');

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(parts[0] + '.' + parts[1]);
  if (!verifier.verify(pem, b64urlToBuf(parts[2]))) throw new Error('signature verification failed');

  const now = Math.floor(Date.now() / 1000);
  const skew = 300; // tolerate 5 min of clock skew
  if (typeof payload.exp !== 'number' || payload.exp < now - skew) throw new Error('token expired');
  if (typeof payload.iat === 'number' && payload.iat > now + skew) throw new Error('token issued in the future');
  if (payload.aud !== projectId) throw new Error('token audience mismatch');
  if (payload.iss !== 'https://securetoken.google.com/' + projectId) throw new Error('token issuer mismatch');
  if (!payload.sub || typeof payload.sub !== 'string') throw new Error('token has no subject (uid)');
  return payload;
}

async function verifyAdmin(req) {
  if (!fbAdmin || !db) {
    return { ok: false, code: 503, error: 'Auth unavailable: server is missing FIREBASE_SERVICE_ACCOUNT' };
  }
  const hdr = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(hdr.trim());
  if (!m) return { ok: false, code: 401, error: 'Missing admin credentials' };
  const idToken = m[1];

  let decoded = null;
  let lastErr = null;

  /* 1. Preferred path: the Admin SDK. Retry once — the cert-endpoint block is
     frequently intermittent, so a second attempt often succeeds. */
  for (let attempt = 0; attempt < 2 && !decoded; attempt++) {
    try {
      decoded = await fbAdmin.auth().verifyIdToken(idToken);
    } catch (e) {
      lastErr = e;
      /* Only retry the transient cert-fetch network failure; a genuinely bad or
         expired token will fail deterministically, so bail immediately. */
      if (!isCertFetchError(e)) break;
      if (attempt === 0) await new Promise(r => setTimeout(r, 300));
    }
  }

  /* 2. Fallback: the SDK couldn't reach Google's cert endpoint. Verify the
     token ourselves via a direct fetch (different HTTP path than the SDK). */
  if (!decoded && isCertFetchError(lastErr)) {
    const projectId = (fbAdmin.app().options && fbAdmin.app().options.projectId) ||
                      process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '';
    if (projectId) {
      try {
        decoded = await verifyIdTokenManually(idToken, projectId);
        console.log('ℹ️  /send: verified admin token via manual fallback (SDK cert fetch was blocked)');
      } catch (e) {
        console.error('❌ /send manual verify failed:', e.message);
        if (isCertFetchError(e)) {
          /* Both the SDK and our own fetch were denied by Google → this is a
             server/network problem, not the admin's login. Say so clearly and
             return 503 so the panel doesn't tell the admin to re-log-in. */
          return {
            ok: false, code: 503,
            error: 'Server could not reach Google to verify the token ' +
                   '(cert endpoint blocked from the bot host, not your login). ' +
                   'Check the Render service network/region.'
          };
        }
        lastErr = e; // a real token problem surfaced during manual verify
      }
    }
  }

  if (!decoded) {
    console.error('❌ /send verifyIdToken failed:', (lastErr && lastErr.code) || '', '-', (lastErr && lastErr.message) || '');
    if (isCertFetchError(lastErr)) {
      return {
        ok: false, code: 503,
        error: 'Server could not reach Google to verify the token ' +
               '(cert endpoint blocked from the bot host, not your login).'
      };
    }
    const detail = ((lastErr && lastErr.code) || 'verify-failed') +
                   (lastErr && lastErr.message ? ': ' + String(lastErr.message).slice(0, 140) : '');
    return { ok: false, code: 401, error: 'Invalid or expired admin token [' + detail + ']' };
  }

  try {
    const adminDoc = await db.collection('admins').doc(decoded.uid || decoded.sub).get();
    if (!adminDoc.exists) return { ok: false, code: 403, error: 'Not an admin account' };
  } catch (e) {
    return { ok: false, code: 403, error: 'Could not verify admin access' };
  }
  return { ok: true, uid: decoded.uid || decoded.sub };
}

const server = http.createServer((req, res) => {

  /* CORS headers — allow admin.html on GitHub Pages to call this */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

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

  /* ── POST /send — proxy Telegram sendMessage ── */
  if (req.method === 'POST' && req.url === '/send') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        /* Admin-only: reject anyone without a valid admin ID token */
        const authz = await verifyAdmin(req);
        if (!authz.ok) {
          console.warn(`🚫 /send rejected (${authz.code}): ${authz.error}`);
          res.writeHead(authz.code, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: authz.error }));
          return;
        }

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
