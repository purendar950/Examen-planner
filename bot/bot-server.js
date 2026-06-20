/**
 * PrepPath Telegram Bot Server
 * ─────────────────────────────────────────────────────────────────────────────
 * Routes:
 *   GET  /          → health check
 *   POST /send      → proxy: sends a Telegram message server-side (CORS-safe)
 *
 * Deploy on Render (Web Service):
 *   Root directory: bot
 *   Build:          npm install
 *   Start:          node bot-server.js
 *   Env vars:       TELEGRAM_BOT_TOKEN
 * ─────────────────────────────────────────────────────────────────────────────
 */

const TelegramBot = require('node-telegram-bot-api');
const http        = require('http');
const https       = require('https');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN env var missing. Set it in Render dashboard.');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
console.log('🤖 PrepPath Bot running (long-polling)...');

/* ── /start handler ─────────────────────────────────────────────────────── */
bot.onText(/^\/start(.*)$/, (msg) => {
  const chatId = msg.chat.id;
  const name   = msg.from.first_name || 'Student';
  const text =
    `👋 Namaste <b>${name}</b>!\n\n` +
    `✅ Bot se successfully connect ho gaye!\n\n` +
    `📋 <b>Tumhara Telegram Chat ID:</b>\n` +
    `<code>${chatId}</code>\n\n` +
    `👆 Upar wala number <b>copy karo</b> aur PrepPath app mein:\n` +
    `<b>Profile → Daily Plan on Telegram → Chat ID field</b> mein paste karo, toggle ON karo, Save karo.\n\n` +
    `📚 Phir roz <b>6:00 AM IST</b> pe aaj ka study plan yahan milega!`;
  bot.sendMessage(chatId, text, { parse_mode: 'HTML' })
    .then(() => console.log(`✅ Sent chat ID to ${chatId} (${name})`))
    .catch(err => console.error(`❌ sendMessage error for ${chatId}:`, err.message));
});

/* ── /id  or  /chatid ───────────────────────────────────────────────────── */
bot.onText(/^\/(id|chatid)$/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
    `🆔 Tumhara Chat ID: <code>${chatId}</code>\n\nIse PrepPath app mein paste karo.`,
    { parse_mode: 'HTML' }
  ).catch(err => console.error('sendMessage error:', err.message));
});

/* ── /help ──────────────────────────────────────────────────────────────── */
bot.onText(/^\/help$/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `📖 <b>PrepPath Bot Commands:</b>\n\n` +
    `/start — Apna Chat ID pao\n` +
    `/id — Chat ID dobara dekho\n` +
    `/help — Yeh help message\n\n` +
    `🌐 App: <a href="https://examzen.in">examzen.in</a>`,
    { parse_mode: 'HTML', disable_web_page_preview: true }
  ).catch(err => console.error('sendMessage error:', err.message));
});

/* ── Handle any other text ──────────────────────────────────────────────── */
bot.on('message', (msg) => {
  if (msg.text && !msg.text.startsWith('/')) {
    bot.sendMessage(msg.chat.id,
      `👋 Hi! Apna Chat ID pane ke liye <b>/start</b> dabao.`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }
});

/* ── Polling error handler ──────────────────────────────────────────────── */
bot.on('polling_error', (err) => {
  console.error('⚠️  Polling error:', err.code, err.message);
});

/* ── HTTP Server (health check + /send proxy) ───────────────────────────── */
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
