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

  /* ── the tutor character ──────────────────────────────────────────────────
     A hand-built SVG standing in for the LottieFiles character, driven by CSS
     keyframes. ~2 KB inline and no player library, against ~102 KB gzipped for
     lottie-web plus the animation JSON — a poor trade for a 54px decoration
     that loads on every page, when the two are hard to tell apart at that size.

     States mirror the original animation's segments. Only `idle` and `thinking`
     are wired up so far; the rest are ready for whatever should trigger them:
       idle      gentle bob, occasional blink  (default, loops)
       thinking  eyes give way to a spinner    (a reply is still streaming)
       alert     amber, exclamation mark       (daily limit reached)
       yes / no  green / red acknowledgements  (unused)                       */
  var MOODS = ['idle', 'thinking', 'alert', 'yes', 'no'];

  function characterSvg() {
    return '<svg class="tc" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" focusable="false">' +
      '<defs>' +
        // the original's gradient: #0036ff → #631cff → #c700ff on a 45° axis
        '<linearGradient id="tcSkin" x1="0" y1="0" x2="1" y2="1">' +
          '<stop offset="0" stop-color="#0036ff"/><stop offset=".52" stop-color="#631cff"/>' +
          '<stop offset="1" stop-color="#c700ff"/></linearGradient>' +
        '<linearGradient id="tcSkinAlert" x1="0" y1="0" x2="1" y2="1">' +
          '<stop offset="0" stop-color="#ffd23d"/><stop offset="1" stop-color="#ff8a00"/></linearGradient>' +
        '<linearGradient id="tcSkinYes" x1="0" y1="0" x2="1" y2="1">' +
          '<stop offset="0" stop-color="#38ffc4"/><stop offset="1" stop-color="#00a37a"/></linearGradient>' +
        '<linearGradient id="tcSkinNo" x1="0" y1="0" x2="1" y2="1">' +
          '<stop offset="0" stop-color="#ff5c7a"/><stop offset="1" stop-color="#c2003f"/></linearGradient>' +
        // Kept deliberately faint. A stronger radial reads as a glossy 3D ball,
        // where the original is a flatter gradient disc.
        '<radialGradient id="tcShade" cx=".36" cy=".3" r=".82">' +
          '<stop offset="0" stop-color="#fff" stop-opacity=".16"/>' +
          '<stop offset=".6" stop-color="#fff" stop-opacity="0"/>' +
          '<stop offset="1" stop-color="#000" stop-opacity=".17"/></radialGradient>' +
      '</defs>' +
      '<g class="tc-body">' +
        '<circle class="tc-skin" cx="50" cy="50" r="43"/>' +
        '<circle cx="50" cy="50" r="43" fill="url(#tcShade)"/>' +
        '<path class="tc-gloss" d="M61 17.8a35 35 0 0 1 8.6 5.4" fill="none" stroke="#fff" ' +
          'stroke-width="3.2" stroke-linecap="round"/>' +
        '<g class="tc-eyes" fill="#fff">' +
          '<rect x="36.8" y="40.5" width="6.6" height="18" rx="3.3"/>' +
          '<rect x="56.6" y="40.5" width="6.6" height="18" rx="3.3"/>' +
        '</g>' +
        '<g class="tc-spin"><path d="M50 27a23 23 0 0 0-23 23" fill="none" stroke="#fff" ' +
          'stroke-width="5.4" stroke-linecap="round"/></g>' +
        '<g class="tc-bang" fill="#fff">' +
          '<rect x="46.6" y="34" width="6.8" height="21" rx="3.4"/>' +
          '<circle cx="50" cy="63.5" r="3.9"/>' +
        '</g>' +
      '</g></svg>';
  }

  var _mood = 'idle';
  function setMood(name) {
    if (MOODS.indexOf(name) === -1) name = 'idle';
    _mood = name;
    var svg = _fab && _fab.querySelector('.tc');
    if (!svg) return;
    MOODS.forEach(function (m) { svg.classList.toggle('is-' + m, m === name && m !== 'idle'); });
  }

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
      /* ── the bubble ──────────────────────────────────────────────────────
         The character IS the bubble, so there is no disc behind it: a green
         circle under a blue-magenta blob only clashes. The shadow therefore
         comes from drop-shadow, which follows the artwork instead of boxing
         a transparent square. */
      '#tutor-fab{position:fixed;z-index:7998;right:max(1.15rem,env(safe-area-inset-right));',
      'bottom:max(1.15rem,calc(env(safe-area-inset-bottom) + .6rem));width:56px;height:56px;',
      'border:0;background:none;padding:0;line-height:1;cursor:pointer;',
      'display:flex;align-items:center;justify-content:center;',
      '-webkit-tap-highlight-color:transparent;',
      'filter:drop-shadow(0 8px 16px rgba(0,0,0,.42));',
      'transition:transform .16s ease,filter .2s ease}',
      '#tutor-fab:hover{transform:translateY(-2px) scale(1.05)}',
      '#tutor-fab:active{transform:translateY(0) scale(.96)}',
      // The button box is transparent, so the focus ring has to hug the blob.
      '#tutor-fab:focus{outline:none}',
      '#tutor-fab:focus-visible .tc-skin{stroke:#fff;stroke-width:4}',
      '#tutor-fab:focus-visible{filter:drop-shadow(0 0 0 3px var(--accent,#00c896)) drop-shadow(0 8px 16px rgba(0,0,0,.42))}',
      '#tutor-fab[hidden]{display:none!important}',
      // Draggable: touch-action stops the page scrolling under the finger, and
      // the grab cursors advertise that the bubble can be moved.
      '#tutor-fab{touch-action:none;-webkit-user-select:none;user-select:none;cursor:grab}',
      '#tutor-fab.is-dragging{cursor:grabbing;transition:none;transform:scale(1.1);',
      'filter:drop-shadow(0 14px 26px rgba(0,0,0,.5))}',
      '#tutor-fab.is-dragging:hover{transform:scale(1.1)}',
      // Class-scoped rather than under #tutor-fab so the character can also be
      // dropped into an empty state or onboarding panel later.
      '.tutor-fab-art{display:flex;align-items:center;justify-content:center;',
      'width:100%;height:100%;pointer-events:none;line-height:1}',
      '.tutor-fab-art svg{width:100%;height:100%;display:block;overflow:visible}',
      /* A reply still arriving while the window is closed: the character's own
         thinking state carries it, plus a soft coloured glow so it is catchable
         from the corner of the eye. */
      '#tutor-fab.is-busy{animation:tutorFabGlow 1.9s ease-in-out infinite}',
      '@keyframes tutorFabGlow{',
      '0%,100%{filter:drop-shadow(0 8px 16px rgba(0,0,0,.42)) drop-shadow(0 0 0 rgba(99,28,255,0))}',
      '50%{filter:drop-shadow(0 8px 16px rgba(0,0,0,.42)) drop-shadow(0 0 10px rgba(140,60,255,.85))}}',

      /* ── the character ── */
      '.tc{display:block}',
      '.tc .tc-skin{fill:url(#tcSkin)}',
      '.tc.is-alert .tc-skin{fill:url(#tcSkinAlert)}',
      '.tc.is-yes .tc-skin{fill:url(#tcSkinYes)}',
      '.tc.is-no .tc-skin{fill:url(#tcSkinNo)}',
      // A slow bob with a touch of squash, anchored low so it reads as weight.
      '.tc-body{transform-origin:50px 64px;animation:tcBob 3.2s ease-in-out infinite}',
      '@keyframes tcBob{0%,100%{transform:translateY(0) scale(1,1)}',
      '30%{transform:translateY(-2px) scale(.986,1.014)}',
      '62%{transform:translateY(.8px) scale(1.016,.984)}}',
      '.tc-eyes{transform-origin:50px 49.5px;animation:tcBlink 5.2s ease-in-out infinite}',
      '@keyframes tcBlink{0%,93%,100%{transform:scaleY(1)}96%{transform:scaleY(.1)}}',
      '.tc-gloss{opacity:.9;animation:tcGloss 3.2s ease-in-out infinite}',
      '@keyframes tcGloss{0%,100%{opacity:.9}50%{opacity:.58}}',
      '.tc-spin{transform-origin:50px 50px;opacity:0}',
      '.tc-bang{opacity:0}',
      '.tc.is-thinking .tc-eyes{opacity:0}',
      '.tc.is-thinking .tc-spin{opacity:1;animation:tcSpin .9s linear infinite}',
      '@keyframes tcSpin{to{transform:rotate(360deg)}}',
      '.tc.is-alert .tc-eyes{opacity:0}',
      '.tc.is-alert .tc-bang{opacity:1}',
      // Respect a stated preference for stillness: keep the character, drop the
      // motion. The state colours and glyphs still carry all the meaning.
      '@media(prefers-reduced-motion:reduce){',
      '.tc-body,.tc-eyes,.tc-gloss,.tc-spin,#tutor-fab.is-busy{animation:none!important}',
      '.tc.is-thinking .tc-spin{opacity:1}',
      '}',

      /* ── the window ── */
      '#tutor-float{position:fixed;z-index:8000;display:none;flex-direction:column;overflow:hidden;',
      'right:max(1.15rem,env(safe-area-inset-right));bottom:max(1.15rem,calc(env(safe-area-inset-bottom) + .6rem));',
      'width:min(410px,calc(100vw - 2rem));height:min(580px,calc(var(--shell-vh,100dvh) - 5.5rem));',
      'background:var(--card,#151a24);border:1px solid var(--border,#2a3140);border-radius:16px;',
      'box-shadow:0 26px 64px rgba(0,0,0,.5);color:var(--text,#e7ecf5)}',
      'body.' + OPEN_CLASS + ' #tutor-float{display:flex}',
      /* The window opens on whichever side the bubble was parked — desktop only,
         because on a phone it is a full-width bottom sheet with no side to pick.
         Scoped in a min-width query rather than overridden later: a body-class
         selector outranks the plain #tutor-float rule in the mobile block, so an
         unscoped version would stretch the sheet off-centre. */
      '@media(min-width:769px){',
      'body.tutor-float-left #tutor-float{right:auto;left:max(1.15rem,env(safe-area-inset-left))}',
      '}',
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
    fab.title = 'Ask the AI Tutor — drag to move';
    fab.setAttribute('aria-label', 'Ask the AI Tutor');
    fab.setAttribute('aria-haspopup', 'dialog');
    fab.setAttribute('aria-expanded', 'false');
    // The artwork lives in its own element, isolated from the drag and open
    // logic so the visual can be swapped without touching behaviour.
    fab.innerHTML = '<span class="tutor-fab-art" id="tutor-fab-art" aria-hidden="true">' +
      characterSvg() + '</span>';
    fab.addEventListener('click', function (e) {
      // A click always follows a drag's pointerup; ignore that one.
      if (_suppressClick) { _suppressClick = false; e.preventDefault(); e.stopPropagation(); return; }
      toggle();
    });
    return fab;
  }

  /* ── dragging the bubble ──────────────────────────────────────────────────
     Students park the bubble wherever it does not cover what they are reading,
     so the position is theirs to choose and is remembered.

     Horizontally it snaps to the nearest edge (a half-off-screen bubble is a
     hit-target problem, and an edge-parked bubble covers the least content);
     vertically it stays exactly where it was dropped. The vertical position is
     stored as a fraction of the viewport so it survives rotation and the
     Android URL bar collapsing rather than drifting off-screen.            */
  var POS_KEY = 'tutorFabPos';
  var DRAG_SLOP = 6;          // px of travel before a tap becomes a drag
  var _suppressClick = false;
  var _pos = null;            // { side: 'left'|'right', topRatio: 0..1 }

  function loadPos() {
    try {
      var raw = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
      if (raw && (raw.side === 'left' || raw.side === 'right') && typeof raw.topRatio === 'number') {
        _pos = { side: raw.side, topRatio: Math.min(1, Math.max(0, raw.topRatio)) };
      }
    } catch (e) {}
  }
  function savePos() {
    try { localStorage.setItem(POS_KEY, JSON.stringify(_pos)); } catch (e) {}
  }

  function edgeGap() { return window.innerWidth <= 768 ? 14 : 18; }

  // Keep the bubble fully on screen and clear of the mobile toast band.
  function clampTop(top, h) {
    var min = 8;
    var reserveBottom = window.innerWidth <= 768 ? 76 : 12;   // toast strip on phones
    var max = window.innerHeight - h - reserveBottom;
    if (max < min) max = min;
    return Math.min(max, Math.max(min, top));
  }

  /* Applies the remembered position. Until the bubble has been dragged once,
     nothing is written to style and the stylesheet's default corner stands. */
  function applyFabPosition() {
    if (!_fab || !_pos) return;
    var w = _fab.offsetWidth || 54, h = _fab.offsetHeight || 54;
    var gap = edgeGap();
    var top = clampTop(Math.round(_pos.topRatio * window.innerHeight), h);
    _fab.style.right = 'auto';
    _fab.style.bottom = 'auto';
    _fab.style.left = (_pos.side === 'left' ? gap : window.innerWidth - w - gap) + 'px';
    _fab.style.top = top + 'px';
    // The window opens from the same side the bubble was parked on.
    document.body.classList.toggle('tutor-float-left', _pos.side === 'left');
  }

  function setupFabDrag(fab) {
    var startX = 0, startY = 0, originLeft = 0, originTop = 0;
    var dragging = false, moved = false, pointerId = null;

    function begin(x, y, id) {
      var r = fab.getBoundingClientRect();
      startX = x; startY = y;
      originLeft = r.left; originTop = r.top;
      dragging = true; moved = false; pointerId = id;
    }
    function move(x, y) {
      if (!dragging) return;
      var dx = x - startX, dy = y - startY;
      if (!moved && Math.abs(dx) + Math.abs(dy) < DRAG_SLOP) return;
      if (!moved) { moved = true; fab.classList.add('is-dragging'); }
      var w = fab.offsetWidth || 54, h = fab.offsetHeight || 54;
      var left = Math.min(window.innerWidth - w - 2, Math.max(2, originLeft + dx));
      fab.style.right = 'auto';
      fab.style.bottom = 'auto';
      fab.style.left = left + 'px';
      fab.style.top = clampTop(originTop + dy, h) + 'px';
    }
    function end() {
      if (!dragging) return;
      dragging = false;
      pointerId = null;
      if (!moved) return;                 // a tap: let the click handler open it
      fab.classList.remove('is-dragging');
      _suppressClick = true;              // the drag's click must not open the chat
      var r = fab.getBoundingClientRect();
      _pos = {
        side: (r.left + r.width / 2) < window.innerWidth / 2 ? 'left' : 'right',
        topRatio: r.top / Math.max(1, window.innerHeight)
      };
      savePos();
      applyFabPosition();                 // snap to the edge
      if (typeof showToast === 'function' && !_posToastShown) {
        _posToastShown = true;
        showToast('Bubble moved. Drag it anywhere — the spot is remembered.', 'info');
      }
    }

    if (window.PointerEvent) {
      fab.addEventListener('pointerdown', function (e) {
        if (e.button && e.button !== 0) return;
        begin(e.clientX, e.clientY, e.pointerId);
        try { fab.setPointerCapture(e.pointerId); } catch (err) {}
      });
      fab.addEventListener('pointermove', function (e) {
        if (pointerId !== null && e.pointerId !== pointerId) return;
        move(e.clientX, e.clientY);
      });
      fab.addEventListener('pointerup', end);
      fab.addEventListener('pointercancel', end);
    } else {
      // Older WebViews: mouse + touch.
      fab.addEventListener('mousedown', function (e) {
        if (e.button) return;
        begin(e.clientX, e.clientY, null);
      });
      document.addEventListener('mousemove', function (e) { move(e.clientX, e.clientY); });
      document.addEventListener('mouseup', end);
      fab.addEventListener('touchstart', function (e) {
        if (!e.touches || !e.touches.length) return;
        begin(e.touches[0].clientX, e.touches[0].clientY, null);
      }, { passive: true });
      fab.addEventListener('touchmove', function (e) {
        if (!e.touches || !e.touches.length) return;
        move(e.touches[0].clientX, e.touches[0].clientY);
      }, { passive: true });
      fab.addEventListener('touchend', end);
      fab.addEventListener('touchcancel', end);
    }

    // Keyboard users can move it too, and it is the only way back if the bubble
    // has been parked somewhere awkward.
    fab.addEventListener('keydown', function (e) {
      var step = e.shiftKey ? 40 : 12;
      var r = fab.getBoundingClientRect();
      var handled = true;
      if (e.key === 'ArrowUp') _pos = { side: sideOf(r), topRatio: (r.top - step) / window.innerHeight };
      else if (e.key === 'ArrowDown') _pos = { side: sideOf(r), topRatio: (r.top + step) / window.innerHeight };
      else if (e.key === 'ArrowLeft') _pos = { side: 'left', topRatio: r.top / window.innerHeight };
      else if (e.key === 'ArrowRight') _pos = { side: 'right', topRatio: r.top / window.innerHeight };
      else handled = false;
      if (!handled) return;
      e.preventDefault();
      savePos();
      applyFabPosition();
    });
    function sideOf(r) { return (r.left + r.width / 2) < window.innerWidth / 2 ? 'left' : 'right'; }
  }
  var _posToastShown = false;

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
    setupFabDrag(_fab);
    loadPos();
    applyFabPosition();
  }

  /* Rotating the phone, or the Android URL bar collapsing, changes the viewport
     under a bubble that is positioned in pixels — re-clamp so it can never end
     up stranded off-screen. */
  var _reflow = 0;
  function scheduleReflow() {
    if (_reflow) clearTimeout(_reflow);
    _reflow = setTimeout(function () { _reflow = 0; applyFabPosition(); }, 120);
  }
  window.addEventListener('resize', scheduleReflow);
  window.addEventListener('orientationchange', scheduleReflow);

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
    setMood('thinking');
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
    if (_mood === 'thinking') setMood('idle');
  }
  window.addEventListener('examzen:tutor-send', function () {
    if (!_open) startPulse();
  });

  /* The free plan's daily message limit. Worth showing on the bubble because the
     student may well have the window closed when they hit it. Clears itself so
     the character does not sit there scolding them. */
  var _alertTimer = 0;
  window.addEventListener('examzen:tutor-limit', function () {
    if (!_fab) return;
    stopPulse();
    setMood('alert');
    if (_alertTimer) clearTimeout(_alertTimer);
    _alertTimer = setTimeout(function () {
      _alertTimer = 0;
      if (_mood === 'alert') setMood('idle');
    }, 6000);
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
    syncChrome: syncChrome,
    // Character state: 'idle' | 'thinking' | 'alert' | 'yes' | 'no'.
    setMood: setMood,
    getMood: function () { return _mood; },
    moods: MOODS.slice()
  };
})();
