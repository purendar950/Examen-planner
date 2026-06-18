/**
 * ExamZen Telegram Bot Server
 * ─────────────────────────────────────────────────────────────────────────────
 * Ye bot kya karta hai:
 *   - Jab user /start dabata hai → apna Telegram Chat ID reply karta hai
 *   - Woh ID user ExamZen app mein paste karta hai → daily plan milta hai
 *
 * Deploy on Render (free Worker):
 *   1. GitHub par push karo
 *   2. Render → New Worker → connect repo
 *   3. Root directory: bot/
 *   4. Build: npm install
 *   5. Start: node bot-server.js
 *   6. Env var: TELEGRAM_BOT_TOKEN = <BotFather token>
 * ─────────────────────────────────────────────────────────────────────────────
 */

const TelegramBot = require('node-telegram-bot-api');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN env var missing. Set it in Render dashboard.');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

console.log('🤖 ExamZen Bot running (long-polling)...');

/* ── /start handler ─────────────────────────────────────────────────────── */
bot.onText(/^\/start(.*)$/, (msg) => {
  const chatId   = msg.chat.id;
  const name     = msg.from.first_name || 'Student';

  const text =
    `👋 Namaste <b>${name}</b>!\n\n` +
    `✅ Bot se successfully connect ho gaye!\n\n` +
    `📋 <b>Tumhara Telegram Chat ID:</b>\n` +
    `<code>${chatId}</code>\n\n` +
    `👆 Upar wala number <b>copy karo</b> aur ExamZen app mein:\n` +
    `<b>Profile → Daily Plan on Telegram → Chat ID field</b> mein paste karo, toggle ON karo, Save karo.\n\n` +
    `📚 Phir roz <b>6:00 AM IST</b> pe aaj ka study plan yahan milega!`;

  bot.sendMessage(chatId, text, { parse_mode: 'HTML' })
    .then(() => console.log(`✅ Sent chat ID to ${chatId} (${name})`))
    .catch(err => console.error(`❌ sendMessage error for ${chatId}:`, err.message));
});

/* ── /id  or  /chatid  — in case user forgot their ID ─────────────────── */
bot.onText(/^\/(id|chatid)$/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
    `🆔 Tumhara Chat ID: <code>${chatId}</code>\n\nIse ExamZen app mein paste karo.`,
    { parse_mode: 'HTML' }
  ).catch(err => console.error('sendMessage error:', err.message));
});

/* ── /help ──────────────────────────────────────────────────────────────── */
bot.onText(/^\/help$/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `📖 <b>ExamZen Bot Commands:</b>\n\n` +
    `/start — Apna Chat ID pao\n` +
    `/id — Chat ID dobara dekho\n` +
    `/help — Yeh help message\n\n` +
    `🌐 App: <a href="https://examzen.in">examzen.in</a>`,
    { parse_mode: 'HTML', disable_web_page_preview: true }
  ).catch(err => console.error('sendMessage error:', err.message));
});

/* ── Handle any other text — guide them to /start ──────────────────────── */
bot.on('message', (msg) => {
  if (msg.text && !msg.text.startsWith('/')) {
    bot.sendMessage(msg.chat.id,
      `👋 Hi! Apna Chat ID pane ke liye <b>/start</b> dabao.`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }
});

/* ── Polling error handler ─────────────────────────────────────────────── */
bot.on('polling_error', (err) => {
  console.error('⚠️  Polling error:', err.code, err.message);
  /* Don't exit — let Render restart if needed */
});

/* ── Keep alive on Render free tier (pings self every 14 min) ─────────── */
if (process.env.RENDER_EXTERNAL_URL) {
  const https = require('https');
  const http  = require('http');
  const url   = process.env.RENDER_EXTERNAL_URL;

  /* Tiny HTTP server so Render health checks don't fail */
  const server = require('http').createServer((req, res) => {
    res.writeHead(200);
    res.end('ExamZen Bot is alive 🤖');
  });
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`🌐 Health server on :${PORT}`));

  /* Ping self every 14 minutes to prevent sleep on free tier */
  setInterval(() => {
    try {
      const mod = url.startsWith('https') ? https : http;
      mod.get(url, (r) => console.log(`💓 Keep-alive ping → ${r.statusCode}`))
         .on('error', (e) => console.log('Keep-alive ping error:', e.message));
    } catch(e) {}
  }, 14 * 60 * 1000);
}
