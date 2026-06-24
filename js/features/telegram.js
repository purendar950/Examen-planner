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
      const items = (map[ds] || []).filter(it => it.type !== 'spacer');
      if (!items.length) continue;
      const lines = items.map(it => {
        const ch = it.ch || {};
        if (it.type === 'revise') return `🔁 Revise: ${ch.name || ''}${it.dueLabel ? ' (' + it.dueLabel + ')' : ''}`;
        return `📖 ${ch.name || ''}${it.part ? ' ' + it.part : ''}${ch.subName ? '  — ' + ch.subName : ''}`;
      });
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



/* ══════════════════════════════════════════════
   TELEGRAM → PLANNER INBOX (AI auto-schedule)
   The Telegram bot writes tasks/videos a user texts it into a SEPARATE
   `telegramInbox` array on their user doc (NOT inside appState, so the
   browser's full-appState save can never clobber them). Here we drain that
   inbox into appState.tasks, resolve subject names → subject ids, then clear
   the inbox. Driven by the existing onSnapshot listener in auth.js, so new
   tasks appear live (no manual reload).
══════════════════════════════════════════════ */

/* Map any telegram task's free-text subject name onto a real subject id (for
   the colored subject chip). Runs over all tasks; only fills empty .subject. */
function resolveTelegramTaskSubjects() {
  try {
    const subs = (typeof getActiveSubjects === 'function') ? getActiveSubjects() : [];
    if (!subs.length || !appState.tasks) return;
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    Object.keys(appState.tasks).forEach(ds => {
      (appState.tasks[ds] || []).forEach(t => {
        if (t.subject || !t.subjectName) return;
        const key = norm(t.subjectName);
        if (!key) return;
        let hit = subs.find(s => norm(s.name) === key);
        if (!hit) hit = subs.find(s => norm(s.name).includes(key) || key.includes(norm(s.name)));
        if (!hit) {
          /* match on the first word of the subject name (e.g. "General Science") */
          hit = subs.find(s => { const first = norm(s.name.split(/[ &]/)[0]); return first && (first === key || key.includes(first) || first.includes(key)); });
        }
        if (hit) t.subject = hit.id;
      });
    });
  } catch (e) {}
}

/* Drain the telegramInbox array from a Firestore user-doc snapshot into the
   planner. Safe to call on every snapshot — it no-ops when the inbox is empty
   and clears the inbox after merging so items are processed exactly once. */
function drainTelegramInbox(snapData) {
  try {
    const inbox = snapData && snapData.telegramInbox;
    if (!Array.isArray(inbox) || !inbox.length) return;
    if (!appState.tasks) appState.tasks = {};

    const fmt = (typeof fmtDate === 'function') ? fmtDate : (d => d.toISOString().slice(0, 10));
    const todayStr = fmt(new Date());
    let added = 0;

    inbox.forEach(item => {
      if (!item) return;
      const date = /^\d{4}-\d{2}-\d{2}$/.test(item.date) ? item.date : todayStr;
      if (!appState.tasks[date]) appState.tasks[date] = [];
      const list = appState.tasks[date];

      /* De-dupe: same video already on the day, or same text already added from Telegram. */
      if (item.videoId && list.some(t => t.videoId === item.videoId)) return;
      const txt = (item.text || item.title || '').trim();
      if (!item.videoId && txt && list.some(t => t.fromTelegram && (t.text || '').trim().toLowerCase() === txt.toLowerCase())) return;

      const task = {
        id: 'tg_' + (item.id || (Date.now().toString())) + Math.random().toString(36).slice(2, 6),
        text: txt || 'Task',
        done: false,
        status: 'todo',
        priority: ['high', 'normal', 'low'].includes(item.priority) ? item.priority : 'normal',
        subject: '',
        subjectName: item.subjectName || '',
        type: item.kind === 'video' ? 'video' : 'study',
        fromTelegram: true
      };
      if (item.kind === 'video' && item.videoId) {
        task.type = 'video';
        task.videoId = item.videoId;
        task.url = item.url || ('https://www.youtube.com/watch?v=' + item.videoId);
      }
      list.push(task);
      added++;
    });

    /* Clear the server inbox so items aren't re-added on the next snapshot. */
    try {
      if (db && currentUser) db.collection('users').doc(currentUser.uid).update({ telegramInbox: [] }).catch(() => {});
    } catch (e) {}

    if (added) {
      resolveTelegramTaskSubjects();
      if (typeof saveProgress === 'function') saveProgress();
      try { if (typeof buildPlannerCalendar === 'function') buildPlannerCalendar(); } catch (e) {}
      if (typeof showToast === 'function') {
        showToast('📩 ' + added + ' naya task' + (added > 1 ? 's' : '') + ' Telegram se add hua! Planner check karo.', 'success');
      }
    }
  } catch (e) {}
}
