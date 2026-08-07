/* ══════════════════════════════════════════════════════════════════════════
   Floating AI Tutor — global bubble + chat window
   ─────────────────────────────────────────────────────────────────────────
   The AI Tutor used to be reachable only from the 4th tab of the AI Study
   panel, which mounts into the right column of the YouTube page. From the
   Dashboard, Planner, Syllabus, Analysis or Quiz pages there was no way to
   reach it at all. This file adds a bubble on every page.

   IT DOES NOT CONTAIN A SECOND CHAT. The conversation, streaming, history and
   scope logic all stay in js/features/ai-tutor.js, which keeps exactly ONE
   .ai-tutor-shell node alive and re-parents it between the panel body and the
   window opened here (see the "Dock hand-off" section there). That is what lets
   an in-flight reply keep streaming — and a half-typed question survive — while
   the chat moves. It also keeps the fixed ids inside the chat markup
   (#ai-chat, #ai-chat-in, #ai-chat-send) unambiguous: with two live copies,
   getElementById would resolve to whichever came first in the document and a
   streaming reply could paint into the hidden one.

   Loads after ai-tutor.js so window.AiTutorCore exists.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var OPEN_CLASS = 'tutor-float-open';
  var HISTORY_KEY = 'tutorFloat';
  var _token = 0;
  var _historyPushed = false;
  var _open = false;
  var _pulseTimer = 0;
  var _lastFocus = null;

  function core() { return window.AiTutorCore || null; }

  /* ── styles ───────────────────────────────────────────────────────────────
     The chat's own layout rules in css/app.css are all scoped to #page-youtube,
     so they do not reach the window here — the shell layout is restated below,
     scoped to #tutor-float.

     z-index sits at 8000: above the page and the desktop sidebar rail (70) but
     BELOW every dialog in this app (9000+), so the bubble can never end up
     floating on top of an open modal. Toasts (1000000) stay above it.        */
  (function injectCss() {
    if (document.getElementById('tutor-float-css')) return;
    var s = document.createElement('style');
    s.id = 'tutor-float-css';
    s.textContent = [
      /* ── the bubble ── */
      '#tutor-fab{position:fixed;z-index:7998;right:max(1.15rem,env(safe-area-inset-right));',
      'bottom:max(1.15rem,calc(env(safe-area-inset-bottom) + .6rem));width:54px;height:54px;border-radius:50%;',
      'border:1px solid rgba(0,200,150,.45);background:linear-gradient(150deg,var(--accent,#00c896),#039b76);',
      'color:#04120d;font-size:1.35rem;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;',
      'box-shadow:0 10px 30px rgba(0,0,0,.38),0 0 0 0 rgba(0,200,150,.42);transition:transform .16s ease,box-shadow .16s ease;padding:0}',
      '#tutor-fab:hover{transform:translateY(-2px) scale(1.04)}',
      '#tutor-fab:active{transform:translateY(0) scale(.97)}',
      '#tutor-fab:focus-visible{outline:3px solid var(--accent,#00c896);outline-offset:3px}',
      '#tutor-fab[hidden]{display:none!important}',
      /* a reply that is still streaming while the window is closed */
      '#tutor-fab.is-busy{animation:tutorFabPulse 1.7s ease-out infinite}',
      '@keyframes tutorFabPulse{0%{box-shadow:0 10px 30px rgba(0,0,0,.38),0 0 0 0 rgba(0,200,150,.5)}',
      '70%{box-shadow:0 10px 30px rgba(0,0,0,.38),0 0 0 13px rgba(0,200,150,0)}',
      '100%{box-shadow:0 10px 30px rgba(0,0,0,.38),0 0 0 0 rgba(0,200,150,0)}}',
      '#tutor-fab .tutor-fab-dot{position:absolute;top:3px;right:3px;width:11px;height:11px;border-radius:50%;',
      'background:#ffcc32;border:2px solid #04120d;display:none}',
      '#tutor-fab.is-busy .tutor-fab-dot{display:block}',

      /* ── the window ── */
      '#tutor-float{position:fixed;z-index:8000;display:none;flex-direction:column;overflow:hidden;',
      'right:max(1.15rem,env(safe-area-inset-right));bottom:max(1.15rem,calc(env(safe-area-inset-bottom) + .6rem));',
      'width:min(410px,calc(100vw - 2rem));height:min(580px,calc(var(--shell-vh,100dvh) - 5.5rem));',
      'background:var(--card,#151a24);border:1px solid var(--border,#2a3140);border-radius:16px;',
      'box-shadow:0 26px 64px rgba(0,0,0,.5);color:var(--text,#e7ecf5)}',
      'body.' + OPEN_CLASS + ' #tutor-float{display:flex}',
      '#tutor-float-head{display:flex;align-items:center;gap:.5rem;flex:0 0 auto;padding:.6rem .7rem;',
      'background:var(--surface,#1b1f2a);border-bottom:1px solid var(--border,#2a3140)}',
      '#tutor-float-head .tutor-float-title{font:800 .82rem/1.2 var(--font,inherit);color:var(--text,#e7ecf5);',
      'display:flex;align-items:center;gap:.4rem;min-width:0}',
      '#tutor-float-head .tutor-float-title span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#tutor-float-head .tutor-float-where{font:700 .58rem/1 var(--font,inherit);letter-spacing:.04em;',
      'text-transform:uppercase;color:var(--muted,#8b93a7);border:1px solid var(--border,#2a3140);',
      'border-radius:999px;padding:.2rem .42rem;flex:none}',
      '#tutor-float-head .tutor-float-btns{display:flex;align-items:center;gap:.25rem;margin-left:auto;flex:none}',
      '.tutor-float-icon{width:29px;height:29px;display:flex;align-items:center;justify-content:center;padding:0;',
      'border:1px solid var(--border,#2a3140);border-radius:8px;background:transparent;color:var(--muted,#8b93a7);',
      'cursor:pointer;font-size:.85rem;line-height:1;font-family:inherit}',
      // The class sets display:flex, which would otherwise defeat the UA's
      // [hidden] rule when the Dock button is hidden off the YouTube page.
      '.tutor-float-icon[hidden]{display:none!important}',
      '.tutor-float-icon:hover{color:var(--text,#e7ecf5);border-color:var(--accent,#00c896)}',
      '.tutor-float-icon:focus-visible{outline:2px solid var(--accent,#00c896);outline-offset:2px}',
      '#tutor-float-body{flex:1 1 auto;display:flex;flex-direction:column;min-height:0;overflow:hidden;padding:.6rem .7rem .7rem}',
      '#tutor-float-grab{display:none}',

      /* ── the chat shell inside the window (app.css rules are #page-youtube-scoped) ── */
      '#tutor-float .ai-tutor-shell{display:flex;flex:1 1 auto;flex-direction:column;min-height:0}',
      '#tutor-float .ai-tutor-topline{display:flex;align-items:center;flex-wrap:wrap;gap:.35rem;margin-bottom:.45rem}',
      '#tutor-float .ai-scope-toggle{display:inline-flex;align-items:center;gap:2px;padding:2px;',
      'border:1px solid var(--border,#2a3140);border-radius:9px;background:var(--surface,#1b1f2a)}',
      '#tutor-float .ai-scope-option{min-height:25px;padding:.2rem .48rem;border:0;border-radius:6px;background:transparent;',
      'color:var(--muted,#8b93a7);cursor:pointer;font:800 .6rem/1 var(--font,inherit);white-space:nowrap;font-family:inherit}',
      '#tutor-float .ai-scope-option.on{background:var(--accent,#00c896);color:#04120d}',
      '#tutor-float .ai-scope-option:focus-visible{outline:2px solid var(--accent,#00c896);outline-offset:2px}',
      '#tutor-float .ai-tutor-actions{display:inline-flex;align-items:center;gap:.25rem;margin-left:auto}',
      '#tutor-float .ai-tutor-actions .ai-btn,#tutor-float .ai-tutor-dock-btn{min-height:25px;padding:.2rem .44rem;',
      'font-size:.57rem;white-space:nowrap}',
      '#tutor-float select.ai-btn{max-width:8.5rem;font-size:.6rem;padding:.2rem .3rem}',
      '#tutor-float #ai-lib-coverage{margin-bottom:.4rem!important;font-size:.6rem!important}',
      '#tutor-float .ai-prepare-status{margin-bottom:.35rem;font-size:.62rem}',
      '#tutor-float .ai-chat{display:flex;flex:1 1 auto;min-height:0;max-height:none;margin-bottom:.45rem;',
      'overflow-y:auto;padding-right:.15rem}',
      '#tutor-float .ai-chips{flex:0 0 auto;flex-wrap:nowrap;margin:0 0 .4rem;overflow-x:auto;scrollbar-width:none}',
      '#tutor-float .ai-chips::-webkit-scrollbar{display:none}',
      '#tutor-float .ai-chip{flex:0 0 auto}',
      '#tutor-float .ai-input-row{flex:0 0 auto}',
      '#tutor-float .ai-input-row input{min-width:0}',

      /* ── the "no video" / "chat is floating" cards ── */
      '.ai-tutor-notice{display:flex;flex:1 1 auto;flex-direction:column;align-items:center;justify-content:center;',
      'gap:.5rem;padding:1rem .9rem;text-align:center}',
      '.ai-tutor-notice-icon{font-size:1.85rem;line-height:1}',
      '.ai-tutor-notice strong{font-size:.92rem;color:var(--text,#e7ecf5)}',
      '.ai-tutor-notice p{margin:0;max-width:23rem;font-size:.78rem;line-height:1.6;color:var(--muted,#8b93a7)}',
      '.ai-tutor-notice-actions{display:flex;flex-wrap:wrap;gap:.4rem;justify-content:center;margin-top:.15rem}',
      '.ai-tutor-notice-foot{font-size:.68rem!important;opacity:.85}',

      /* ── mobile: a bottom sheet, because a 410px card does not fit a phone ── */
      '@media(max-width:768px){',
      '#tutor-fab{width:50px;height:50px;font-size:1.25rem;right:max(.9rem,env(safe-area-inset-right));',
      /* clear the full-width toast band (.toast is left/right 1rem, bottom 1rem on mobile) */
      'bottom:max(4.9rem,calc(env(safe-area-inset-bottom) + 4.4rem))}',
      '#tutor-float{right:0;left:0;bottom:0;width:auto;height:min(86dvh,calc(var(--shell-vh,100dvh) - 3rem));',
      'border-radius:18px 18px 0 0;border-bottom:0;box-shadow:0 -14px 44px rgba(0,0,0,.55)}',
      '#tutor-float-grab{display:block;flex:0 0 auto;padding:.5rem 0 .1rem;cursor:grab;touch-action:none}',
      '#tutor-float-grab::before{content:"";display:block;width:42px;height:4px;margin:0 auto;border-radius:999px;',
      'background:var(--border,#2a3140)}',
      '#tutor-float-grab:active{cursor:grabbing}',
      '#tutor-float-body{padding-bottom:calc(.7rem + env(safe-area-inset-bottom))}',
      '#tutor-float.is-dragging{transition:none}',
      /* the sheet already fills the screen — a second "where" pill just adds noise */
      '#tutor-float-head .tutor-float-where{display:none}',
      '}',

      /* Notes Focus Mode is a full-screen reading surface with its own
         picture-in-picture player parked bottom-right. Stay out of its way. */
      'body.ai-notes-focus-open #tutor-fab,body.ai-notes-focus-open #tutor-float{display:none!important}'
    ].join('');
    document.head.appendChild(s);
  })();

  /* ── DOM ── */
  function buildFab() {
    var fab = document.createElement('button');
    fab.type = 'button';
    fab.id = 'tutor-fab';
    fab.title = 'Ask the AI Tutor';
    fab.setAttribute('aria-label', 'Ask the AI Tutor');
    fab.setAttribute('aria-haspopup', 'dialog');
    fab.setAttribute('aria-expanded', 'false');
    fab.innerHTML = '<span aria-hidden="true">\uD83D\uDCAC</span><span class="tutor-fab-dot" aria-hidden="true"></span>';
    fab.onclick = function () { toggle(); };
    return fab;
  }

  function buildPanel() {
    var box = document.createElement('div');
    box.id = 'tutor-float';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'false');
    box.setAttribute('aria-label', 'AI Tutor');
    box.innerHTML =
      '<div id="tutor-float-grab" aria-hidden="true"></div>' +
      '<div id="tutor-float-head">' +
        '<div class="tutor-float-title"><span aria-hidden="true">\uD83D\uDCAC</span><span>AI Tutor</span></div>' +
        '<span class="tutor-float-where" id="tutor-float-where"></span>' +
        '<div class="tutor-float-btns">' +
          '<button type="button" class="tutor-float-icon" id="tutor-float-dock" ' +
            'title="Move this chat back into the AI Study panel" aria-label="Dock into the AI Study panel">\u21F1</button>' +
          '<button type="button" class="tutor-float-icon" id="tutor-float-close" ' +
            'title="Close (Esc)" aria-label="Close the tutor window">\u2715</button>' +
        '</div>' +
      '</div>' +
      '<div id="tutor-float-body"></div>';
    return box;
  }

  var _fab = null, _panel = null;
  function ensureDom() {
    if (_panel && _panel.isConnected) return;
    _fab = buildFab();
    _panel = buildPanel();
    document.body.appendChild(_fab);
    document.body.appendChild(_panel);
    _panel.querySelector('#tutor-float-close').onclick = function () { close(); };
    _panel.querySelector('#tutor-float-dock').onclick = function () {
      var c = core();
      if (c && typeof c.dockToPanel === 'function') c.dockToPanel();
    };
    setupSheetDrag(_panel.querySelector('#tutor-float-grab'));
  }

  /* The Dock button is only useful where the AI Study panel is actually on
     screen; anywhere else it would hide the chat behind a page the student is
     not looking at. */
  function syncChrome() {
    if (!_panel) return;
    var c = core();
    var ytPage = document.getElementById('page-youtube');
    var panelReachable = !!(ytPage && ytPage.classList.contains('active') &&
      c && typeof c.panelAvailable === 'function' && c.panelAvailable());
    var dock = _panel.querySelector('#tutor-float-dock');
    if (dock) dock.hidden = !panelReachable;
    var where = _panel.querySelector('#tutor-float-where');
    if (where && c) {
      var lib = typeof c.isLibraryScope === 'function' && c.isLibraryScope();
      where.textContent = lib ? 'Library' : (c.hasVideo && c.hasVideo() ? 'This video' : 'No video');
    }
  }

  /* ── open / close ─────────────────────────────────────────────────────────
     A synthetic history entry makes Android's hardware Back close the sheet
     instead of navigating the WebView away from the app (MainActivity routes
     Back to webView.goBack()). Same approach as Notes Focus Mode in
     ai-tutor.js, which already relies on it.                                */
  function open() {
    ensureDom();
    var c = core();
    if (!c || typeof c.mountFloat !== 'function') {
      if (typeof showToast === 'function') showToast('AI Tutor is still loading — try again in a moment.', 'info');
      return;
    }
    if (_open) { syncChrome(); focusInput(); return; }
    _lastFocus = document.activeElement;
    _open = true;
    document.body.classList.add(OPEN_CLASS);
    if (_fab) { _fab.hidden = true; _fab.setAttribute('aria-expanded', 'true'); }
    if (!_historyPushed) {
      try {
        var base = (history.state && typeof history.state === 'object') ? history.state : {};
        var mark = {};
        Object.keys(base).forEach(function (k) { mark[k] = base[k]; });
        mark[HISTORY_KEY] = ++_token;
        history.pushState(mark, '', location.href);
        _historyPushed = true;
      } catch (e) {}
    }
    c.mountFloat();          // hands the single chat node to #tutor-float-body
    syncChrome();
    stopPulse();
    focusInput();
  }

  /* Hide first, then consume the synthetic Back entry so the student never has
     to press Back twice to leave the page.

     The teardown is deliberately synchronous rather than waiting on popstate:
     an embedded WebView can suppress popstate during a lifecycle transition,
     which would leave the sheet impossible to dismiss. finishClose() has
     already cleared _open by the time history.back() lands, so the popstate it
     triggers is a no-op. */
  function close() {
    if (!_open) return;
    var ours = _historyPushed && history.state && history.state[HISTORY_KEY] === _token;
    finishClose();
    if (ours) { try { history.back(); } catch (e) {} }
  }

  /* Closing HIDES the chat; it does not move it. Deliberate: popping out is what
     gives the video its full width, so having ✕ quietly re-open the AI Study
     panel would undo that behind the student's back. The conversation stays
     parked in the hidden window and the bubble brings it straight back. Use the
     Dock button (or the panel's Tutor tab) to move it.

     Nothing is lost either way — a reply still streaming is written to
     localStorage when it completes, whether or not anything is on screen. */
  function finishClose() {
    if (!_open) return;
    _open = false;
    _historyPushed = false;
    document.body.classList.remove(OPEN_CLASS);
    if (_panel) { _panel.style.transform = ''; _panel.classList.remove('is-dragging'); }
    if (_fab) { _fab.hidden = false; _fab.setAttribute('aria-expanded', 'false'); }
    if (_lastFocus && _lastFocus.isConnected && typeof _lastFocus.focus === 'function') {
      try { _lastFocus.focus(); } catch (e) {}
    } else if (_fab) {
      try { _fab.focus(); } catch (e) {}
    }
  }

  function toggle() { if (_open) close(); else open(); }

  function focusInput() {
    // Never steal focus on a phone: the on-screen keyboard would cover the
    // conversation the moment the sheet opens.
    if (window.innerWidth <= 768) return;
    requestAnimationFrame(function () {
      var input = document.getElementById('ai-chat-in');
      if (input) { try { input.focus(); } catch (e) {} }
    });
  }

  window.addEventListener('popstate', function (event) {
    if (!_open) return;
    var mark = event.state && event.state[HISTORY_KEY];
    if (mark === _token) return;    // forward navigation back onto our entry
    _historyPushed = false;         // the entry is already gone
    finishClose();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !_open) return;
    // Notes Focus Mode owns Esc while it is up.
    if (document.body.classList.contains('ai-notes-focus-open')) return;
    close();
  });

  /* ── mobile: drag the sheet down to dismiss ── */
  function setupSheetDrag(grab) {
    if (!grab) return;
    var startY = 0, delta = 0, dragging = false;
    function begin(y) {
      dragging = true; startY = y; delta = 0;
      if (_panel) _panel.classList.add('is-dragging');
    }
    function move(y) {
      if (!dragging || !_panel) return;
      delta = Math.max(0, y - startY);
      _panel.style.transform = 'translateY(' + delta + 'px)';
    }
    function end() {
      if (!dragging || !_panel) return;
      dragging = false;
      _panel.classList.remove('is-dragging');
      _panel.style.transform = '';
      if (delta > 90) close();
      delta = 0;
    }
    grab.addEventListener('touchstart', function (e) {
      if (!e.touches || !e.touches.length) return;
      begin(e.touches[0].clientY);
    }, { passive: true });
    grab.addEventListener('touchmove', function (e) {
      if (!e.touches || !e.touches.length) return;
      move(e.touches[0].clientY);
    }, { passive: true });
    grab.addEventListener('touchend', end);
    grab.addEventListener('touchcancel', end);
  }

  /* ── the bubble shows that a reply is still arriving while it is closed ── */
  function startPulse() {
    if (!_fab || _open) return;
    _fab.classList.add('is-busy');
    if (_pulseTimer) return;
    _pulseTimer = setInterval(function () {
      var c = core();
      var busy = !!(c && typeof c.isStreaming === 'function' && c.isStreaming());
      if (busy && !_open) return;
      stopPulse();
    }, 1200);
  }
  function stopPulse() {
    if (_pulseTimer) { clearInterval(_pulseTimer); _pulseTimer = 0; }
    if (_fab) _fab.classList.remove('is-busy');
  }
  window.addEventListener('examzen:tutor-send', function () {
    if (!_open) startPulse();
  });

  /* ── boot ── */
  function boot() {
    ensureDom();
    syncChrome();
    // Keep the Dock button and the scope pill honest as the student moves around.
    // switchPage() emits this for every navigation, so no polling is needed.
    if (typeof onPageActivated === 'function') onPageActivated('*', syncChrome);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.TutorFloat = {
    open: open,
    close: close,
    toggle: toggle,
    isOpen: function () { return _open; },
    syncChrome: syncChrome
  };
})();
