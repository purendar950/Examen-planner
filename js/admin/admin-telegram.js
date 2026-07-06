/* PrepPath Admin — TELEGRAM: bot-token + send-time config, Groq AI auto-schedule
   config, per-user + bulk send via the Render proxy, enable/disable toggle, and
   the Telegram admin tab renderer.
   Depends on globals from admin-core.js (auth, db, TG_CONFIG, TG_USERS,
   AI_CONFIG, TG_SENDING, esc, showToast, render). */

/* ════════════════════════════════════════════════════════════════════
   TELEGRAM ADMIN TAB
   ════════════════════════════════════════════════════════════════════ */

/* Load bot token from Firestore + all users' telegram data */
async function loadTelegramData() {
  TG_CONFIG.loaded = true;
  /* Load bot token */
  try {
    const snap = await db.collection('config').doc('telegram').get();
    TG_CONFIG = { ...(snap.exists ? snap.data() : {}), loaded: true };
  } catch(e) { TG_CONFIG = { loaded: true }; }
  /* Load AI (Groq) auto-schedule config */
  try {
    const aiSnap = await db.collection('config').doc('ai').get();
    AI_CONFIG = { groqApiKey:'', model:'llama-3.1-8b-instant', enabled:false, ...(aiSnap.exists ? aiSnap.data() : {}), loaded: true };
  } catch(e) { AI_CONFIG = { groqApiKey:'', model:'llama-3.1-8b-instant', enabled:false, loaded: true }; }
  /* Load every user's full doc to get appState.telegram */
  try {
    const snap = await db.collection('users').get();
    TG_USERS = snap.docs
      .map(d => {
        const data = d.data() || {};
        const tg   = (data.appState && data.appState.telegram) || {};
        const prof = data.profile || {};
        return {
          id:   d.id,
          name: prof.name  || 'Unknown',
          email:prof.email || '',
          tg:   {
            chatId:  tg.chatId  || prof.telegramChatId || '',
            enabled: (typeof tg.enabled === 'boolean') ? tg.enabled : !!prof.telegramEnabled,
            digest:  tg.digest  || {}
          }
        };
      })
      .filter(u => u.tg.chatId); /* only users who've set a chat ID */
    TG_USERS.sort((a,b) => (b.tg.enabled ? 1 : 0) - (a.tg.enabled ? 1 : 0));
  } catch(e) { TG_USERS = []; showToast('TG users load failed: ' + e.message); }
  render();
}

/* Save bot token to Firestore */
async function saveTgBotToken() {
  const el = document.getElementById('tg-token-input');
  if (!el) return;
  const token = el.value.trim();
  if (!token || !/^\d+:/.test(token)) { showToast('⚠️ Valid bot token daalo (format: 123456:ABC-xyz)'); return; }
  try {
    await db.collection('config').doc('telegram').set({ botToken: token, savedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
    TG_CONFIG.botToken = token;
    showToast('✅ Bot token saved!');
    render();
  } catch(e) { showToast('Failed: ' + e.message); }
}

/* Save the daily auto-send time (IST) to Firestore. The GitHub Actions
   sender reads config/telegram.sendTime and only sends once per day at/after
   this time. Admin-only write is allowed by the Firestore rules. */
async function saveTgSendTime() {
  const el = document.getElementById('tg-sendtime-input');
  if (!el) return;
  const t = (el.value || '').trim();
  if (!/^\d{2}:\d{2}$/.test(t)) { showToast('⚠️ Valid time chahiye (HH:MM)'); return; }
  const [h, m] = t.split(':').map(n => parseInt(n, 10));
  if (h > 23 || m > 59) { showToast('⚠️ Invalid time (00:00–23:59)'); return; }
  try {
    await db.collection('config').doc('telegram').set({
      sendTime: t, sendHour: h, sendMinute: m,
      sendTimeUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    TG_CONFIG.sendTime = t; TG_CONFIG.sendHour = h; TG_CONFIG.sendMinute = m;
    showToast('✅ Auto-send time set to ' + t + ' IST');
    render();
  } catch(e) { showToast('Failed: ' + e.message); }
}

/* ── AI auto-schedule (Groq) config ─────────────────────────────────────────
   Saves the Groq API key + chosen model + on/off flag to Firestore config/ai.
   The Telegram bot server reads this doc to parse incoming user messages into
   planner tasks. Admin-only write (Firestore rules must allow config/ai like
   config/telegram). The key lives only in Firestore — never in the codebase. */
async function saveGroqConfig() {
  const keyEl   = document.getElementById('ai-groq-key');
  const modelEl = document.getElementById('ai-model');
  const onEl    = document.getElementById('ai-enabled');
  if (!keyEl || !modelEl || !onEl) return;
  const key   = keyEl.value.trim();
  const model = modelEl.value;
  const on    = !!onEl.checked;
  if (on && !key) { showToast('⚠️ Groq API key daalo (gsk_…) ya AI toggle OFF karo'); keyEl.focus(); return; }
  if (key && !/^gsk_/.test(key)) { showToast('⚠️ Groq key usually starts with "gsk_"'); }
  try {
    await db.collection('config').doc('ai').set({
      groqApiKey: key,
      model: model,
      enabled: on,
      provider: 'groq',
      savedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    AI_CONFIG.groqApiKey = key; AI_CONFIG.model = model; AI_CONFIG.enabled = on;
    showToast('✅ AI auto-schedule config saved!');
    render();
  } catch(e) { showToast('Failed: ' + e.message); }
}

function buildTgMessage(name, digest) {
  const today = (function() {
    const now = new Date();
    const ist = new Date(now.getTime() + (5*60+30)*60000);
    return ist.toISOString().slice(0,10);
  })();
  const header = '☀️ <b>Good morning, ' + name + '!</b>\n📅 Aaj ka study plan (' + today + ')\n\n';
  const plan   = digest && digest[today];
  const body   = (plan && plan.trim())
    ? plan
    : '📋 Aaj koi topic scheduled nahi.\n💡 App kholo → Planner mein topics add karo → Save karo.';
  return header + body + '\n\n— StudyPlanner';
}

/* Render bot proxy URL — routes /send to Telegram server-side (fixes CORS) */
const RENDER_BOT_URL = 'https://examen-planner-2.onrender.com';

/* Send a message to one user via Render bot proxy (avoids browser CORS block).
   AUTH: the /send proxy is now admin-only. We attach the signed-in admin's
   Firebase ID token as a Bearer credential; the bot server verifies it and
   confirms admins/{uid} exists before relaying anything through the bot token.
   Without this header the server responds 401 and no message is sent. */
async function tgSendOne(chatId, text, token) {
  let idToken = '';
  try {
    if (auth.currentUser) idToken = await auth.currentUser.getIdToken();
  } catch(e) { /* fall through — request will be rejected 401 below */ }
  if (!idToken) throw new Error('Not signed in as admin — reload and log in again.');
  const res = await fetch(RENDER_BOT_URL + '/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + idToken
    },
    body: JSON.stringify({ chatId, text })
  });
  const data = await res.json();
  if (!data.ok) throw new Error('Telegram: ' + (data.error || 'Send failed'));
  return data;
}

/* Send to a single user from the table row */
async function tgSendToUser(uid) {
  const token = TG_CONFIG.botToken;
  if (!token) { showToast('⚠️ Pehle Bot Token save karo!'); document.getElementById('tg-token-input') && document.getElementById('tg-token-input').focus(); return; }
  const u = TG_USERS.find(x => x.id === uid);
  if (!u) return;
  const btn = document.getElementById('tg-btn-' + uid);
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  try {
    const msg = buildTgMessage(u.name.split(' ')[0], u.tg.digest);
    await tgSendOne(u.tg.chatId, msg, token);
    if (btn) { btn.textContent = '✅ Sent'; btn.style.background = 'var(--accent-dark)'; }
    showToast('✅ Sent to ' + u.name);
  } catch(e) {
    if (btn) { btn.disabled = false; btn.textContent = '📤 Send'; btn.style.background = ''; }
    showToast('❌ ' + u.name + ': ' + e.message);
  }
}

/* Send to ALL enabled users */
async function tgSendAll(testMode) {
  const token = TG_CONFIG.botToken;
  if (!token) { showToast('⚠️ Pehle Bot Token save karo!'); return; }
  if (TG_SENDING) { showToast('Already sending…'); return; }
  const targets = testMode
    ? TG_USERS.filter(u => u.tg.chatId) /* test: send to all with chatId, even disabled */
    : TG_USERS.filter(u => u.tg.enabled && u.tg.chatId);
  if (!targets.length) { showToast('No users to send to.'); return; }
  if (!confirm('Send Telegram message to ' + targets.length + ' user(s)' + (testMode ? ' (TEST — includes disabled users)' : ' (enabled only)') + '?')) return;
  TG_SENDING = true;
  const logEl = document.getElementById('tg-send-log');
  if (logEl) { logEl.style.display = 'block'; logEl.innerHTML = '<b>Sending…</b><br>'; }
  let ok = 0, fail = 0;
  for (const u of targets) {
    try {
      const msg = buildTgMessage(u.name.split(' ')[0], u.tg.digest);
      await tgSendOne(u.tg.chatId, msg, token);
      ok++;
      if (logEl) logEl.innerHTML += '✅ ' + esc(u.name) + ' (' + esc(u.tg.chatId) + ')<br>';
    } catch(e) {
      fail++;
      if (logEl) logEl.innerHTML += '❌ ' + esc(u.name) + ': ' + esc(e.message) + '<br>';
    }
    await new Promise(r => setTimeout(r, 80)); /* small delay to avoid rate-limit */
  }
  TG_SENDING = false;
  if (logEl) logEl.innerHTML += '<br><b>Done. ✅ ' + ok + ' sent  ❌ ' + fail + ' failed</b>';
  showToast('Done: ' + ok + ' sent, ' + fail + ' failed');
}

/* Toggle enabled flag for a user (saves to Firestore) */
async function tgToggleUser(uid) {
  const u = TG_USERS.find(x => x.id === uid); if (!u) return;
  const newVal = !u.tg.enabled;
  try {
    await db.collection('users').doc(uid).update({
      'appState.telegram.enabled': newVal,
      'profile.telegramEnabled':   newVal
    });
    u.tg.enabled = newVal;
    showToast((newVal ? '✅ Enabled' : '🔕 Disabled') + ' for ' + u.name);
    render();
  } catch(e) { showToast('Update failed: ' + e.message); }
}

/* Render the Telegram admin tab */
function renderTelegram() {
  const total   = TG_USERS.length;
  const enabled = TG_USERS.filter(u => u.tg.enabled && u.tg.chatId).length;
  const noDigest= TG_USERS.filter(u => {
    const today = (function() { const n=new Date(); const i=new Date(n.getTime()+(5*60+30)*60000); return i.toISOString().slice(0,10); })();
    return u.tg.enabled && u.tg.chatId && !(u.tg.digest && u.tg.digest[today]);
  }).length;
  const tokenSet = TG_CONFIG.botToken ? true : false;

  /* ── Stats bar ── */
  var s = '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;">' +
    '<div class="stat"><b style="color:#229ED9">' + total + '</b><div>Chat IDs saved</div></div>' +
    '<div class="stat"><b style="color:var(--accent-dark)">' + enabled + '</b><div>Notifications ON</div></div>' +
    '<div class="stat"><b style="color:var(--amber)">' + noDigest + '</b><div>No plan today</div></div>' +
    '<div class="stat"><b style="color:' + (tokenSet ? 'var(--accent-dark)' : 'var(--red)') + '">' + (tokenSet ? '✓' : '✗') + '</b><div>Bot token</div></div>' +
    '</div>';

  /* ── Bot Token Card ── */
  s += '<div class="card" style="margin-bottom:12px;">' +
    '<h3 style="margin:0 0 10px;">🤖 Bot Settings</h3>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">' +
      '<input id="tg-token-input" type="password" placeholder="Bot Token (BotFather se mila tha)" ' +
        'value="' + esc(TG_CONFIG.botToken || '') + '" ' +
        'style="flex:1;min-width:240px;font-family:monospace;font-size:.82rem;" ' +
        'oninput="document.getElementById(\'tg-token-show\').textContent=this.value?\'●●●●●●●●…\':\'\'">' +
      '<button class="btn btn-blue" onclick="saveTgBotToken()">💾 Save Token</button>' +
      '<button class="btn btn-gray" onclick="var i=document.getElementById(\'tg-token-input\');i.type=i.type===\'password\'?\'text\':\'password\';">👁 Show/Hide</button>' +
    '</div>' +
    '<div id="tg-token-show" class="muted" style="font-size:.72rem;margin-top:4px;">' + (TG_CONFIG.botToken ? '✅ Token saved in Firestore' : '⚠️ Token nahi set hai — Send Now kaam nahi karega') + '</div>' +
    '<div class="muted" style="font-size:.72rem;margin-top:6px;">💡 Token sirf Firestore mein store hoga (config/telegram) — code mein nahi. GitHub Secrets mein bhi alag se add karo daily cron ke liye.</div>' +
    '</div>';

  /* ── AI Auto-Schedule (Groq) Card ── */
  var aiOn    = AI_CONFIG && AI_CONFIG.enabled;
  var aiKeySet= AI_CONFIG && AI_CONFIG.groqApiKey;
  var aiModel = (AI_CONFIG && AI_CONFIG.model) || 'llama-3.1-8b-instant';
  var aiModels = [
    ['llama-3.1-8b-instant',   'Llama 3.1 8B Instant (fast, cheap — recommended)'],
    ['llama-3.3-70b-versatile','Llama 3.3 70B Versatile (smartest)'],
    ['openai/gpt-oss-120b',    'GPT-OSS 120B'],
    ['openai/gpt-oss-20b',     'GPT-OSS 20B']
  ];
  s += '<div class="card" style="margin-bottom:12px;">' +
    '<h3 style="margin:0 0 4px;">🧠 AI Auto-Schedule (Groq)</h3>' +
    '<div class="muted" style="font-size:.74rem;margin-bottom:10px;line-height:1.6;">' +
      'Jab user bot ko apna task ya YouTube link bhejta hai, AI usse padhke subject auto-detect karke ' +
      'uske planner ki To-Do list mein add kar deta hai. YouTube link click karne pe video YouTube tab mein chalti hai.' +
    '</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px;">' +
      '<input id="ai-groq-key" type="password" placeholder="Groq API Key (gsk_…)" ' +
        'value="' + esc(AI_CONFIG.groqApiKey || '') + '" ' +
        'style="flex:1;min-width:240px;font-family:monospace;font-size:.82rem;">' +
      '<button class="btn btn-gray" onclick="var i=document.getElementById(\'ai-groq-key\');i.type=i.type===\'password\'?\'text\':\'password\';">👁 Show/Hide</button>' +
    '</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px;">' +
      '<span style="font-size:.82rem;font-weight:700;">Model:</span>' +
      '<select id="ai-model" style="font-size:.82rem;padding:6px 8px;border:1px solid var(--border);border-radius:8px;min-width:260px;">' +
        aiModels.map(function(m){ return '<option value="'+m[0]+'"'+(aiModel===m[0]?' selected':'')+'>'+m[1]+'</option>'; }).join('') +
      '</select>' +
    '</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">' +
      '<label style="display:flex;align-items:center;gap:6px;font-size:.85rem;font-weight:700;cursor:pointer;">' +
        '<input id="ai-enabled" type="checkbox"' + (aiOn ? ' checked' : '') + '> AI auto-schedule ON' +
      '</label>' +
      '<button class="btn btn-blue" onclick="saveGroqConfig()">💾 Save AI Config</button>' +
    '</div>' +
    '<div class="muted" style="font-size:.72rem;margin-top:8px;">' +
      (aiKeySet ? '✅ Groq key saved' : '⚠️ Groq key not set') + ' · ' +
      (aiOn ? '🟢 AI ON' : '⚪ AI OFF') + ' · model: <b>' + esc(aiModel) + '</b><br>' +
      '🔑 <a href="https://console.groq.com/keys" target="_blank">console.groq.com/keys</a> se free key banao. ' +
      'Render bot ko <code>FIREBASE_SERVICE_ACCOUNT</code> env var chahiye taki ye config padh sake.' +
    '</div>' +
    '</div>';

  /* ── Send Controls Card ── */
  s += '<div class="card" style="margin-bottom:12px;">' +
    '<h3 style="margin:0 0 10px;">📤 Send Controls</h3>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
      '<button class="btn btn-green" onclick="tgSendAll(false)" style="font-weight:700;">' +
        '📤 Send to All Enabled (' + enabled + ')' +
      '</button>' +
      '<button class="btn btn-gray" onclick="tgSendAll(true)">' +
        '🧪 Test — Send to All with ChatID (' + total + ')' +
      '</button>' +
      '<button class="btn btn-gray" onclick="TG_CONFIG.loaded=false;loadTelegramData();">🔄 Refresh Users</button>' +
    '</div>' +
    '<div id="tg-send-log" style="display:none;max-height:200px;overflow-y:auto;background:#f8f9fa;border-radius:8px;padding:10px;margin-top:10px;font-size:.77rem;font-family:monospace;border:1px solid var(--border);"></div>' +
    /* ── Auto-send schedule (admin-set time, saved to config/telegram) ── */
    '<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border);">' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">' +
        '<span style="font-size:.82rem;font-weight:700;">⏰ Daily auto-send time (IST):</span>' +
        '<input id="tg-sendtime-input" type="time" value="' + esc(TG_CONFIG.sendTime || '06:00') + '" ' +
          'style="font-size:.85rem;padding:5px 8px;border:1px solid var(--border);border-radius:8px;">' +
        '<button class="btn btn-blue" onclick="saveTgSendTime()">💾 Save Time</button>' +
      '</div>' +
      '<div class="muted" style="font-size:.72rem;margin-top:8px;line-height:1.6;">' +
        '⏰ GitHub Actions har <b>~15 min</b> chalta hai aur set time ke baad pehle run pe sabhi enabled users ko bhejta hai (free, automatic, din mein ek hi baar). ' +
        'Abhi set: <b>' + esc(TG_CONFIG.sendTime || '06:00') + ' IST</b>' +
        (TG_CONFIG.lastSentDate ? ' · last auto-sent: <b>' + esc(TG_CONFIG.lastSentDate) + '</b>' : '') +
      '</div>' +
    '</div>' +
    '</div>';

  /* ── Users Table ── */
  if (!TG_CONFIG.loaded || (TG_USERS.length === 0 && TG_CONFIG.loaded)) {
    s += '<div class="card"><div class="muted" style="text-align:center;padding:20px;">' +
      (TG_CONFIG.loaded ? '⚠️ Koi user nahi mila jisne Telegram connect kiya ho.' : '⏳ Loading users…') +
      '</div></div>';
    return s;
  }

  const today = (function() { const n=new Date(); const i=new Date(n.getTime()+(5*60+30)*60000); return i.toISOString().slice(0,10); })();

  s += '<div class="card">' +
    '<h3 style="margin:0 0 10px;">👥 Connected Users (' + total + ')</h3>' +
    '<div style="overflow-x:auto;">' +
    '<table style="width:100%;border-collapse:collapse;font-size:.8rem;">' +
    '<thead><tr style="text-align:left;border-bottom:2px solid var(--border);color:var(--muted);">' +
      '<th style="padding:7px 8px;">User</th>' +
      '<th style="padding:7px 8px;">Chat ID</th>' +
      '<th style="padding:7px 8px;">Status</th>' +
      '<th style="padding:7px 8px;">Plan today</th>' +
      '<th style="padding:7px 8px;">Actions</th>' +
    '</tr></thead><tbody>';

  TG_USERS.forEach(function(u) {
    const hasDigest = u.tg.digest && u.tg.digest[today];
    const statusBadge = u.tg.enabled
      ? '<span class="badge badge-green">ON</span>'
      : '<span class="badge" style="background:#eee;color:#666;">OFF</span>';
    const digestBadge = hasDigest
      ? '<span class="badge badge-blue">✓ Ready</span>'
      : '<span class="badge badge-amber">No plan</span>';

    s += '<tr style="border-bottom:1px solid var(--border);">' +
      '<td style="padding:7px 8px;"><b>' + esc(u.name) + '</b><div class="muted" style="font-size:.72rem;">' + esc(u.email) + '</div></td>' +
      '<td style="padding:7px 8px;font-family:monospace;font-size:.78rem;">' + esc(u.tg.chatId) + '</td>' +
      '<td style="padding:7px 8px;">' + statusBadge + '</td>' +
      '<td style="padding:7px 8px;">' + digestBadge + '</td>' +
      '<td style="padding:7px 8px;">' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
          '<button id="tg-btn-' + u.id + '" class="btn btn-blue" onclick="tgSendToUser(\'' + u.id + '\')" style="padding:4px 10px;font-size:.75rem;">📤 Send Now</button>' +
          '<button class="btn btn-gray" onclick="tgToggleUser(\'' + u.id + '\')" style="padding:4px 10px;font-size:.75rem;">' +
            (u.tg.enabled ? '🔕 Disable' : '✅ Enable') +
          '</button>' +
        '</div>' +
      '</td>' +
    '</tr>';
  });

  s += '</tbody></table></div></div>';
  return s;
}
