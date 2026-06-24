/* ══════════════════════════════════════════════
   TELEGRAM DAILY PLAN — link + precomputed digest
   The actual sending is done by a daily GitHub Actions job (server-side).
   The browser's only jobs are:
     1. let the user opt in + store their Telegram chatId
     2. precompute a per-date plain-text digest so the job can just read it
══════════════════════════════════════════════ */

/* Build up to 7 days (today + next 6) of plan text from the combined schedule
   map (study topics + due revisions). Stored as { 'YYYY-MM-DD': 'line\nline' }. */
function buildTelegramDigest() {
  const digest = {};
  try {
    const map = (typeof getPlanScheduleMap === 'function') ? getPlanScheduleMap() : {};
    const start = new Date();
    for (let i = 0; i < 7; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const ds = (typeof fmtDate === 'function') ? fmtDate(d) : d.toISOString().slice(0, 10);

      /* Scheduled study/revision topics from the active plan(s). */
      const items = (map[ds] || []).filter(it => it.type !== 'spacer');
      const lines = items.map(it => {
        const ch = it.ch || {};
        if (it.type === 'revise') return `🔁 Revise: ${ch.name || ''}${it.dueLabel ? ' (' + it.dueLabel + ')' : ''}`;
        return `📖 ${ch.name || ''}${it.part ? ' ' + it.part : ''}${ch.subName ? '  — ' + ch.subName : ''}`;
      });

      /* Manually-added tasks for that day (includes tasks sent via the Telegram
         bot, which writes them straight into appState.tasks). Skip ones already
         covered by a scheduled topic line so the digest stays clean. */
      try {
        const tasks = (appState.tasks && appState.tasks[ds]) || [];
        const seen = new Set(lines.map(l => l.toLowerCase()));
        tasks.forEach(t => {
          if (!t || !t.text) return;
          const line = `📝 ${t.text}${t.priority === 'high' ? ' ❗' : ''}`;
          if (seen.has(line.toLowerCase())) return;
          seen.add(line.toLowerCase());
          lines.push(line);
        });
      } catch(e) {}

      if (!lines.length) continue;
      digest[ds] = lines.join('\n');
    }
  } catch(e) {}
  return digest;
}

/* Refresh the stored digest (called whenever the plan or progress changes). */
function refreshTelegramDigest() {
  if (!appState.telegram) appState.telegram = { chatId:'', username:'', enabled:false, digest:null };
  appState.telegram.digest = buildTelegramDigest();
}

/* Save the Telegram settings from the Study Profile modal. */
function saveTelegramSettings() {
  if (!appState.telegram) appState.telegram = { chatId:'', username:'', enabled:false, digest:null };
  const chatEl   = document.getElementById('tg-chatid');
  const onEl     = document.getElementById('tg-enabled');
  const statusEl = document.getElementById('tg-status-msg');
  if (chatEl) appState.telegram.chatId = (chatEl.value || '').trim();
  if (onEl)   appState.telegram.enabled = !!onEl.checked;

  /* Warn if enabled but no chat ID */
  if (appState.telegram.enabled && !appState.telegram.chatId) {
    if (statusEl) { statusEl.style.color = '#e74c3c'; statusEl.textContent = '⚠️ Pehle Chat ID daalo — "Step 1: Bot kholo" dabao ya @userinfobot se ID lo.'; }
    if (typeof showToast === 'function') showToast('⚠️ Chat ID missing! Pehle bot se ya @userinfobot se ID lo.', 'info');
    return;
  }

  refreshTelegramDigest();
  saveProgress();

  const ok = appState.telegram.enabled && appState.telegram.chatId;
  if (statusEl) {
    statusEl.style.color = ok ? '#27ae60' : 'var(--muted)';
    statusEl.textContent = ok
      ? '✅ Saved! Kal subah 6 AM IST pe message aayega.'
      : appState.telegram.enabled ? '' : '🔕 Telegram notifications OFF.';
  }
  if (typeof showToast === 'function') {
    showToast(appState.telegram.enabled
      ? (appState.telegram.chatId ? '📩 Daily Telegram plan ON ✅' : '⚠️ Chat ID daalo pehle')
      : '🔕 Telegram daily plan OFF', ok ? 'success' : 'info');
  }
}

/* Open the bot so the user can press Start; payload carries their uid. */
const TELEGRAM_BOT_USERNAME = 'SSCplannerbot'; /* Connect button opens https://t.me/SSCplannerbot */
function connectTelegram() {
  const uid = (currentUser && currentUser.uid) ? currentUser.uid : '';
  const url = 'https://t.me/' + TELEGRAM_BOT_USERNAME + (uid ? '?start=' + encodeURIComponent(uid) : '');
  window.open(url, '_blank');
  /* After opening, show guidance so user knows what to do next */
  setTimeout(function() {
    const msg = document.getElementById('tg-status-msg');
    if (msg) {
      msg.style.color = '#229ED9';
      msg.textContent = '✅ Bot khul gaya! "Start" dabao → bot apna Chat ID reply karega → woh ID oopar paste karo.';
    }
    if (typeof showToast === 'function') {
      showToast('Bot open hua! Start dabao → Chat ID copy karo → yahan paste karo 👆', 'info');
    }
  }, 800);
}

/* Verify that the entered chat ID looks valid and test-ping it */
async function verifyTelegramChatId() {
  const chatEl = document.getElementById('tg-chatid');
  const statusEl = document.getElementById('tg-status-msg');
  const chatId = (chatEl && chatEl.value || '').trim();
  if (!chatId || !/^-?\d+$/.test(chatId)) {
    if (statusEl) { statusEl.style.color = '#e74c3c'; statusEl.textContent = '⚠️ Valid numeric Chat ID daalo (e.g. 987654321)'; }
    return;
  }
  if (statusEl) { statusEl.style.color = 'var(--muted)'; statusEl.textContent = '⏳ Testing...'; }
  try {
    const token = null; /* Bot token is only in GitHub Secrets — we can't test-send from browser */
    /* Without token in browser we just validate format and show success */
    if (statusEl) { statusEl.style.color = '#27ae60'; statusEl.textContent = '✅ Chat ID format sahi hai! Save karo aur GitHub Actions se test karo.'; }
  } catch(e) {
    if (statusEl) { statusEl.style.color = '#e74c3c'; statusEl.textContent = '❌ Error: ' + e.message; }
  }
}

/* Opened from the user dropdown — close the menu and show the Study Profile
   modal, which contains the full Telegram daily-plan section. */
function openTelegramSettings() {
  try {
    const menu = document.getElementById('user-menu-dropdown');
    if (menu) menu.classList.remove('open');
  } catch(e) {}
  if (typeof openStudyProfileModal === 'function') {
    openStudyProfileModal(3); /* jump straight to the Schedule & Telegram step */
    /* Scroll the Telegram section into view inside the modal. */
    setTimeout(function() {
      try {
        const el = document.getElementById('tg-chatid');
        if (el) el.scrollIntoView({ behavior:'smooth', block:'center' });
      } catch(e) {}
    }, 200);
  } else if (typeof showToast === 'function') {
    showToast('Open Planner → ⚙️ Profile to connect Telegram.', 'info');
  }
}

