/* ══════════════════════════════════════════
   AI CHAT TAB — a standalone chat page, separate from the video-grounded
   AI Tutor in the YouTube tab. Hidden by default; only shown once the backend
   confirms (via /api/ai-chat/status) that an admin has granted this account
   access. Always talks to the ONE provider/model the admin locked in the
   admin panel (config/aiChat) — the browser never sees which provider that
   is, never mind its API key; every answer is proxied through
   youtube-turbo-proxy's /api/ai-chat, which resolves the locked provider
   server-side via _load_ai_config(prefer_provider=...).

   Self-injecting (same pattern as js/tabs/profile.js): creates #page-ai-chat
   and a #nav-ai-chat tab so app.html needs no markup changes. The nav tab
   stays hidden until the access check above passes.

   Chat history is stored ONLY in localStorage, per the product decision to
   keep this lightweight and per-device — never written to Firestore, and
   never sent anywhere except back to this same backend as short-lived
   conversation context on each new message. It persists across reloads and
   is only removed if the user explicitly clears it (no auto-expiry). ══════ */
(function () {
  'use strict';

  var BACKEND = (localStorage.getItem('turboBackendUrl')
    || 'https://youtube-turbo-proxy-gej4.onrender.com').replace(/\/+$/, '');
  var HISTORY_MAX = 20;      // messages kept as context sent to the backend
  var _checked = false;      // avoid re-checking /status on every page switch
  var _sending = false;

  function esc(s) { return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function mdLite(s) {
    return esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
  }
  function toast(m, t) { try { showToast(m, t); } catch (e) {} }

  /* ── history: localStorage only, per signed-in uid ── */
  function historyKey() {
    var uid = (typeof currentUser !== 'undefined' && currentUser && currentUser.uid) || 'guest';
    return 'preppath_ai_chat_history_' + uid;
  }
  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(historyKey()) || '[]'); } catch (e) { return []; }
  }
  function saveHistory(list) {
    try { localStorage.setItem(historyKey(), JSON.stringify(list)); } catch (e) {}
  }

  /* ── styles ── */
  var st = document.createElement('style');
  st.textContent =
    '.aic-wrap{max-width:820px;margin:0 auto;display:flex;flex-direction:column;height:calc(100vh - 140px);min-height:420px;}' +
    '.aic-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding-bottom:0.75rem;flex-wrap:wrap;}' +
    '.aic-head h2{font-size:1.05rem;margin:0;}' +
    '.aic-head .aic-sub{color:var(--muted);font-size:0.78rem;}' +
    '.aic-log{flex:1;overflow-y:auto;border:1px solid var(--border);border-radius:14px;background:var(--card);padding:1rem;display:flex;flex-direction:column;gap:0.85rem;}' +
    '.aic-msg{max-width:88%;padding:0.6rem 0.85rem;border-radius:12px;font-size:0.9rem;line-height:1.55;white-space:normal;word-break:break-word;}' +
    '.aic-msg.user{align-self:flex-end;background:var(--accent);color:#000;}' +
    '.aic-msg.assistant{align-self:flex-start;background:var(--surface);border:1px solid var(--border);}' +
    '.aic-msg.error{align-self:flex-start;background:rgba(231,76,60,0.1);border:1px solid rgba(231,76,60,0.35);color:#e74c3c;}' +
    '.aic-msg code{background:rgba(0,0,0,0.12);padding:1px 5px;border-radius:4px;font-size:0.85em;}' +
    '.aic-empty{color:var(--muted);font-size:0.85rem;text-align:center;margin:auto;padding:1.5rem;}' +
    '.aic-typing{align-self:flex-start;color:var(--muted);font-size:0.82rem;font-style:italic;}' +
    '.aic-form{display:flex;gap:8px;padding-top:0.75rem;align-items:flex-end;}' +
    '.aic-input{flex:1;resize:none;min-height:44px;max-height:140px;padding:10px 12px;border-radius:10px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:0.9rem;font-family:var(--font);outline:none;}' +
    '.aic-input:focus{border-color:var(--accent);}' +
    '.aic-send{padding:10px 18px;border-radius:10px;border:none;background:var(--accent);color:#000;font-weight:700;font-size:0.85rem;cursor:pointer;white-space:nowrap;}' +
    '.aic-send:disabled{opacity:0.5;cursor:default;}' +
    '.aic-clear{background:none;border:1px solid var(--border);color:var(--muted);border-radius:8px;padding:6px 10px;font-size:0.76rem;cursor:pointer;}' +
    '.aic-clear:hover{border-color:#e74c3c;color:#e74c3c;}';
  document.head.appendChild(st);

  /* ── page markup ── */
  var MARKUP = [
    '<div class="aic-wrap">',
    '  <div class="aic-head">',
    '    <div><h2>\uD83E\uDD16 AI Chat</h2><div class="aic-sub">General-purpose AI assistant. Not tied to any video.</div></div>',
    '    <button class="aic-clear" onclick="aicClearChat()">\uD83D\uDDD1 Clear chat</button>',
    '  </div>',
    '  <div class="aic-log" id="aic-log"><div class="aic-empty">Ask anything — this chat stays only on this device.</div></div>',
    '  <form class="aic-form" onsubmit="aicSend(event)">',
    '    <textarea class="aic-input" id="aic-input" rows="1" placeholder="Message AI Chat…" onkeydown="aicKeydown(event)"></textarea>',
    '    <button class="aic-send" id="aic-send-btn" type="submit">Send</button>',
    '  </form>',
    '</div>'
  ].join('\n');

  function injectPage() {
    if (document.getElementById('page-ai-chat')) return;
    var mc = document.querySelector('.main-content');
    if (!mc) return;
    var page = document.createElement('div');
    page.className = 'page';
    page.id = 'page-ai-chat';
    page.innerHTML = MARKUP;
    mc.appendChild(page);
    injectNavTab();
  }

  /* Nav tab is inserted next to Planner (same anchor mock-tests.js uses),
     hidden until the access check below flips it on. */
  function injectNavTab() {
    if (document.getElementById('nav-ai-chat')) return;
    var anchor = document.getElementById('nav-planner');
    var html = '<div class="nav-tab" id="nav-ai-chat" onclick="switchPage(\'ai-chat\')" title="AI Chat" style="display:none;">' +
      '<span class="tab-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg></span>' +
      '<span class="nav-tab-label"> AI Chat</span></div>';
    if (anchor) anchor.insertAdjacentHTML('afterend', html);
    else {
      var tabs = document.querySelector('.shell-nav-scroll') || document.querySelector('.nav-tabs');
      if (tabs) tabs.insertAdjacentHTML('beforeend', html);
    }
  }

  /* ── access check: ask the backend, only reveal the tab if allowed ── */
  function backendAuthFetch(path, options) {
    options = options || {};
    return getFirebaseIdToken().then(function (token) {
      var headers = Object.assign({}, options.headers || {}, { Authorization: 'Bearer ' + token });
      return fetch(BACKEND + path, Object.assign({}, options, { headers: headers }));
    });
  }

  function checkAccess() {
    if (typeof currentUser === 'undefined' || !currentUser) return;
    if (typeof _fbReady === 'undefined' || !_fbReady) return;   // no backend identity offline
    backendAuthFetch('/api/ai-chat/status')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var nav = document.getElementById('nav-ai-chat');
        if (nav) nav.style.display = (j && j.enabled) ? '' : 'none';
        // If access was just revoked while the user is sitting on the page,
        // send them somewhere sane instead of leaving a dead-end tab open.
        if (nav && nav.style.display === 'none') {
          var pg = document.getElementById('page-ai-chat');
          if (pg && pg.classList.contains('active') && typeof switchPage === 'function') switchPage('dashboard');
        }
      })
      .catch(function () { /* leave the tab hidden on any error — fail closed */ });
  }

  /* Re-check whenever login completes (initApp runs after loginUser). A small
     delay lets currentUser/getFirebaseIdToken settle, matching profile.js's
     own post-load wiring pattern. */
  window.addEventListener('load', function () {
    injectPage();
    setTimeout(function () { _checked = true; checkAccess(); }, 800);
  });
  // Re-check on every dashboard activation too (cheap, cached 60s server-side)
  // so a freshly-granted user sees the tab without a full page reload.
  if (typeof onPageActivated === 'function') {
    onPageActivated('dashboard', function () { if (_checked) checkAccess(); });
  }

  /* ── rendering ── */
  function renderLog() {
    var log = document.getElementById('aic-log');
    if (!log) return;
    var history = loadHistory();
    if (!history.length) {
      log.innerHTML = '<div class="aic-empty">Ask anything — this chat stays only on this device.</div>';
      return;
    }
    log.innerHTML = history.map(function (m) {
      var cls = m.role === 'user' ? 'user' : (m.role === 'error' ? 'error' : 'assistant');
      return '<div class="aic-msg ' + cls + '">' + mdLite(m.content) + '</div>';
    }).join('');
    log.scrollTop = log.scrollHeight;
  }

  function setSending(on) {
    _sending = on;
    var btn = document.getElementById('aic-send-btn');
    if (btn) { btn.disabled = on; btn.textContent = on ? 'Sending…' : 'Send'; }
  }

  window.aicKeydown = function (ev) {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      window.aicSend(ev);
    }
  };

  window.aicSend = function (ev) {
    if (ev) ev.preventDefault();
    if (_sending) return;
    var input = document.getElementById('aic-input');
    var q = ((input && input.value) || '').trim();
    if (!q) return;
    if (typeof currentUser === 'undefined' || !currentUser) { toast('Pehle login karo.', 'error'); return; }

    var history = loadHistory();
    history.push({ role: 'user', content: q });
    saveHistory(history);
    renderLog();
    if (input) { input.value = ''; input.style.height = 'auto'; }

    var log = document.getElementById('aic-log');
    var typing = document.createElement('div');
    typing.className = 'aic-typing';
    typing.id = 'aic-typing-indicator';
    typing.textContent = 'AI is thinking…';
    if (log) { log.appendChild(typing); log.scrollTop = log.scrollHeight; }

    setSending(true);
    var contextHistory = history.slice(-HISTORY_MAX - 1, -1); // exclude the just-added question, capped
    backendAuthFetch('/api/ai-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: q, history: contextHistory })
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, data: j || {} }; }); })
      .then(function (res) {
        var cur = loadHistory();
        if (res.ok && res.data && res.data.answer) {
          cur.push({ role: 'assistant', content: res.data.answer });
        } else {
          var msg = (res.data && (res.data.detail || res.data.error)) || 'Something went wrong. Try again.';
          cur.push({ role: 'error', content: '\u26a0\uFE0F ' + msg });
        }
        saveHistory(cur);
        renderLog();
      })
      .catch(function () {
        var cur = loadHistory();
        cur.push({ role: 'error', content: '\u26a0\uFE0F Network error — check your connection and try again.' });
        saveHistory(cur);
        renderLog();
      })
      .finally(function () { setSending(false); });
  };

  window.aicClearChat = function () {
    if (!confirm('Clear this chat? This only clears it on this device and cannot be undone.')) return;
    saveHistory([]);
    renderLog();
    toast('Chat cleared 🗑', 'success');
  };

  /* auto-grow the textarea like a normal chat input */
  document.addEventListener('input', function (ev) {
    if (ev.target && ev.target.id === 'aic-input') {
      ev.target.style.height = 'auto';
      ev.target.style.height = Math.min(140, ev.target.scrollHeight) + 'px';
    }
  });

  if (typeof onPageActivated === 'function') {
    onPageActivated('ai-chat', function () { renderLog(); });
  }
})();
