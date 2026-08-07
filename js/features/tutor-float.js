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
  var _activeTurns = {};
  var _anonymousTurns = 0;
  var _lastFocus = null;
  var _entryTimer = 0;

  function core() { return window.AiTutorCore || null; }

  /* ── the tutor character ──────────────────────────────────────────────────
     A hand-built SVG standing in for the LottieFiles character, driven by CSS
     keyframes. ~3 KB inline and no player library, against ~102 KB gzipped for
     lottie-web plus the animation JSON — a poor trade for a 56px decoration
     that loads on every page, when the two are hard to tell apart at that size.

     States mirror the original animation's segments:
       idle      aura breath, sheen, gentle bob, blink and eye glances
       thinking  faster aura, spinner and orbiting dots (reply in progress)
       alert     amber shake and exclamation mark (daily limit reached)
       yes / no  green check or red cross acknowledgements (public API)       */
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
        '<clipPath id="tcFaceClip"><circle cx="50" cy="50" r="42"/></clipPath>' +
      '</defs>' +
      // Two quiet rings make the character feel powered-on without changing
      // its 56px hitbox. The dashed ring moves independently from the body.
      '<g class="tc-aura" fill="none" stroke="#a88bff">' +
        '<circle class="tc-aura-ring" cx="50" cy="50" r="46" stroke-width="1.8"/>' +
        '<circle class="tc-aura-dashes" cx="50" cy="50" r="49" stroke-width="1.2" ' +
          'stroke-linecap="round" stroke-dasharray="7 11"/>' +
      '</g>' +
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
        '<path class="tc-check" d="M33 50l11 11 24-27" fill="none" stroke="#fff" ' +
          'stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>' +
        '<g class="tc-cross" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round">' +
          '<path d="M36 36l28 28"/><path d="M64 36L36 64"/>' +
        '</g>' +
      '</g>' +
      // A clipped highlight crosses the face occasionally and immediately on
      // hover/open. Thinking gets two chunky orbiting dots beside its spinner.
      '<g class="tc-sheen" clip-path="url(#tcFaceClip)">' +
        '<path d="M23 69L63 20" fill="none" stroke="#fff" stroke-width="7" ' +
          'stroke-linecap="round"/>' +
      '</g>' +
      '<g class="tc-think-dots" fill="#fff">' +
        '<circle cx="50" cy="12" r="3.5"/><circle cx="85" cy="50" r="2.5"/>' +
      '</g>' +
      '<g class="tc-sparks" fill="#fff">' +
        '<path d="M16 25l1.8 4.2L22 31l-4.2 1.8L16 37l-1.8-4.2L10 31l4.2-1.8z"/>' +
        '<path d="M82 17l1.3 3.1 3.2 1.3-3.2 1.4-1.3 3.1-1.3-3.1-3.2-1.4 3.2-1.3z"/>' +
        '<circle cx="87" cy="68" r="2.5"/>' +
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
      '#tutor-fab{position:fixed;z-index:8002;right:max(1.15rem,env(safe-area-inset-right));',
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
      /* ── the character ── */
      '.tc{display:block}',
      '.tc .tc-skin{fill:url(#tcSkin)}',
      '.tc.is-alert .tc-skin{fill:url(#tcSkinAlert)}',
      '.tc.is-yes .tc-skin{fill:url(#tcSkinYes)}',
      '.tc.is-no .tc-skin{fill:url(#tcSkinNo)}',
      '.tc.is-alert .tc-aura{stroke:#ffd45a}',
      '.tc.is-yes .tc-aura{stroke:#45ffd0}',
      '.tc.is-no .tc-aura{stroke:#ff6f91}',
      // A soft powered-on aura breathes behind the character. Its dashed outer
      // ring rotates slowly, then accelerates while a tutor reply is arriving.
      // Keeping the glow inside SVG leaves the button's focus/drag filter free.
      '.tc-aura{opacity:.3;transform-origin:50px 50px;animation:tcAuraBreathe 4.8s ease-in-out infinite}',
      '.tc-aura-dashes{transform-origin:50px 50px;animation:tcAuraOrbit 8s linear infinite}',
      '@keyframes tcAuraBreathe{0%,100%{opacity:.2;transform:scale(.96)}',
      '50%{opacity:.58;transform:scale(1.035)}}',
      '@keyframes tcAuraOrbit{to{transform:rotate(360deg)}}',
      // A face sheen passes occasionally at idle and responds instantly to an
      // open or hover. It is clipped to the blob, so artwork never grows wider.
      '.tc-sheen{opacity:0;transform-origin:50px 50px}',
      '.tc:not(.is-thinking):not(.is-alert):not(.is-yes):not(.is-no) .tc-sheen{',
      'animation:tcSheenIdle 7s ease-in-out infinite}',
      '@keyframes tcSheenIdle{0%,72%,100%{opacity:0;transform:translate(-18px,14px)}',
      '80%{opacity:.38}90%{opacity:0;transform:translate(18px,-14px)}}',
      '#tutor-fab:hover .tc:not(.is-thinking):not(.is-alert):not(.is-yes):not(.is-no) .tc-sheen,',
      '#tutor-fab.is-opening .tc:not(.is-thinking):not(.is-alert):not(.is-yes):not(.is-no) .tc-sheen{',
      'animation:tcSheenSweep .9s ease-out}',
      '@keyframes tcSheenSweep{0%{opacity:0;transform:translate(-20px,16px)}',
      '42%{opacity:.52}100%{opacity:0;transform:translate(20px,-16px)}}',
      '.tc-think-dots{opacity:0;transform-origin:50px 50px}',
      // Idle motion: a slow bob, occasional blink, and two tiny eye glances.
      // Anchoring low gives the blob weight instead of making it hover rigidly.
      '.tc-body{transform-origin:50px 64px;animation:tcBob 3.2s ease-in-out infinite}',
      '@keyframes tcBob{0%,100%{transform:translateY(0) scale(1,1)}',
      '30%{transform:translateY(-2px) scale(.986,1.014)}',
      '62%{transform:translateY(.8px) scale(1.016,.984)}}',
      '.tc-eyes{transform-origin:50px 49.5px;animation:tcEyesAlive 6.4s ease-in-out infinite}',
      '@keyframes tcEyesAlive{',
      '0%,18%,30%,58%,72%,92%,100%{transform:translateX(0) scaleY(1)}',
      '23%{transform:translateX(2.5px) scaleY(1)}',
      '64%{transform:translateX(-2px) scaleY(1)}',
      '95%{transform:translateX(0) scaleY(.1)}}',
      '.tc-gloss{opacity:.9;animation:tcGloss 3.2s ease-in-out infinite}',
      '@keyframes tcGloss{0%,100%{opacity:.9;transform:translateX(0)}',
      '50%{opacity:.56;transform:translateX(-1px)}}',
      '.tc-spin{transform-origin:50px 50px;opacity:0}',
      '.tc-bang,.tc-check,.tc-cross{opacity:0}',
      '.tc-sparks{opacity:0;transform-origin:50px 50px}',

      // Opening the chat gets one friendly hello bounce, then returns to idle.
      // is-opening is removed after this entry sequence, unlike persistent
      // is-open, so later hovers can start a fresh sheen sweep.
      '#tutor-fab.is-opening .tc-body{animation:tcHello .72s cubic-bezier(.2,.9,.25,1),',
      'tcBob 3.2s .72s ease-in-out infinite}',
      '#tutor-fab.is-opening .tc-sparks{animation:tcSpark 1.15s ease-out}',
      '@keyframes tcHello{0%{transform:scale(1)}35%{transform:translateY(-7px) scale(.9,1.1) rotate(-5deg)}',
      '65%{transform:translateY(1px) scale(1.08,.92) rotate(4deg)}100%{transform:scale(1)}}',
      '@keyframes tcSpark{0%{opacity:0;transform:scale(.4) rotate(-20deg)}',
      '35%{opacity:1;transform:scale(1.15) rotate(8deg)}100%{opacity:0;transform:scale(1.35) rotate(20deg)}}',

      // Animate the artwork wrapper, not .tc-body: mood animations own the
      // body's transform, so targeting the wrapper keeps drag motion visible
      // while Thinking, Alert, Yes, or No is active.
      '#tutor-fab.is-dragging .tutor-fab-art{animation:tcDragWiggle .42s ease-in-out infinite alternate}',
      '@keyframes tcDragWiggle{from{transform:rotate(-5deg) scale(.96,1.04)}',
      'to{transform:rotate(5deg) scale(1.04,.96)}}',

      // Thinking: hide the eyes, breathe faster, spin the arc and orbit two
      // small satellites. The aura accelerates to make activity readable even
      // when the icon is viewed peripherally.
      '.tc.is-thinking .tc-eyes{opacity:0}',
      '#tutor-fab .tc.is-thinking .tc-body{animation:tcThinkBreathe 1.15s ease-in-out infinite}',
      '.tc.is-thinking .tc-spin{opacity:1;animation:tcSpin .9s linear infinite}',
      '.tc.is-thinking .tc-aura{animation:tcAuraThink 1.15s ease-in-out infinite}',
      '.tc.is-thinking .tc-aura-dashes{animation-duration:1.35s}',
      '.tc.is-thinking .tc-think-dots{opacity:.92;animation:tcThinkOrbit 1.4s linear infinite}',
      '@keyframes tcThinkBreathe{0%,100%{transform:scale(1)}50%{transform:scale(1.055)}}',
      '@keyframes tcAuraThink{0%,100%{opacity:.32;transform:scale(.96)}',
      '50%{opacity:.82;transform:scale(1.055)}}',
      '@keyframes tcThinkOrbit{to{transform:rotate(360deg)}}',
      '@keyframes tcSpin{to{transform:rotate(360deg)}}',

      // Alert, yes and no now have their own movement and glyph — not just a
      // colour swap. These mirror the source Lottie's expressive states.
      '.tc.is-alert .tc-eyes{opacity:0}',
      '.tc.is-alert .tc-bang{opacity:1;animation:tcBang .65s ease-in-out infinite alternate}',
      '#tutor-fab .tc.is-alert .tc-body{animation:tcAlertShake .42s ease-in-out 3}',
      '@keyframes tcAlertShake{0%,100%{transform:translateX(0)}25%{transform:translateX(-3px) rotate(-3deg)}',
      '75%{transform:translateX(3px) rotate(3deg)}}',
      '@keyframes tcBang{from{transform:scale(.9);transform-origin:50px 50px}',
      'to{transform:scale(1.08);transform-origin:50px 50px}}',
      '.tc.is-yes .tc-eyes,.tc.is-no .tc-eyes{opacity:0}',
      '.tc.is-yes .tc-check{opacity:1;stroke-dasharray:55;animation:tcCheck .55s ease-out both}',
      '#tutor-fab .tc.is-yes .tc-body{animation:tcYesBounce .7s cubic-bezier(.2,.9,.2,1)}',
      '@keyframes tcCheck{from{stroke-dashoffset:55}to{stroke-dashoffset:0}}',
      '@keyframes tcYesBounce{0%{transform:scale(.9)}45%{transform:translateY(-5px) scale(1.09)}',
      '75%{transform:translateY(1px) scale(.98)}100%{transform:scale(1)}}',
      '.tc.is-no .tc-cross{opacity:1}',
      '#tutor-fab .tc.is-no .tc-body{animation:tcNoShake .58s ease-in-out}',
      '@keyframes tcNoShake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-4px)}',
      '40%,80%{transform:translateX(4px)}}',
      // Respect a stated preference for stillness: keep the character, drop the
      // motion. The state colours and glyphs still carry all the meaning.
      '@media(prefers-reduced-motion:reduce){',
      '.tutor-fab-art,.tc-aura,.tc-aura-dashes,.tc-sheen,.tc-think-dots,.tc-body,.tc-eyes,',
      '.tc-gloss,.tc-spin,.tc-bang,.tc-check,.tc-cross,.tc-sparks,',
      '#tutor-fab,#tutor-fab.is-busy,#tutor-float{animation:none!important;transition:none!important}',
      '.tc.is-thinking .tc-spin,.tc.is-thinking .tc-think-dots,.tc.is-alert .tc-bang,',
      '.tc.is-yes .tc-check,.tc.is-no .tc-cross{opacity:1}',
      '}',

      /* ── the window ── */
      '#tutor-float{position:fixed;z-index:8000;display:none;flex-direction:column;overflow:hidden;',
      'right:max(1.15rem,env(safe-area-inset-right));bottom:max(1.15rem,calc(env(safe-area-inset-bottom) + .6rem));',
      'width:min(410px,calc(100vw - 2rem));height:min(580px,calc(var(--shell-vh,100dvh) - 5.5rem));',
      'background:var(--card,#151a24);border:1px solid var(--border,#2a3140);border-radius:16px;',
      'box-shadow:0 26px 64px rgba(0,0,0,.5);color:var(--text,#e7ecf5);',
      'transition:left .18s ease,top .18s ease,right .18s ease,bottom .18s ease}',
      'body.' + OPEN_CLASS + ' #tutor-float{display:flex}',
      // The character stays above the window and becomes the visible open/close
      // control. Keeping it present also means it can be moved while chatting.
      'body.' + OPEN_CLASS + ' #tutor-fab{z-index:8002}',
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
     Students can park the character ANYWHERE in the usable viewport — it no
     longer snaps to a side. The position is stored as x/y fractions of the
     available travel area, not raw pixels, so rotation and Android browser-bar
     changes preserve the relative spot without stranding it off-screen.        */
  var POS_KEY = 'tutorFabPos';
  var DRAG_SLOP = 6;          // px of travel before a tap becomes a drag
  var _suppressClick = false;
  var _pos = null;            // { xRatio: 0..1, yRatio: 0..1 }

  function loadPos() {
    try {
      var raw = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
      if (raw && typeof raw.xRatio === 'number' && typeof raw.yRatio === 'number') {
        _pos = {
          xRatio: Math.min(1, Math.max(0, raw.xRatio)),
          yRatio: Math.min(1, Math.max(0, raw.yRatio))
        };
      } else if (raw && (raw.side === 'left' || raw.side === 'right') && typeof raw.topRatio === 'number') {
        // One-time migration from PR #612. Its topRatio was rect.top divided by
        // the FULL layout-viewport height, while the new yRatio is relative to
        // the safe travel area. Reconstruct the old pixel point first; copying
        // the ratio directly would move a bottom mobile placement upward by
        // roughly 100px and then permanently discard the original value.
        var fw = (_fab && _fab.offsetWidth) || 56;
        var fh = (_fab && _fab.offsetHeight) || 56;
        var vb = viewportBox();
        var oldBounds = fabBounds(fw, fh);
        var oldLeft = raw.side === 'left' ? oldBounds.minX : oldBounds.maxX;
        var oldTop = vb.top + raw.topRatio * vb.height;
        _pos = ratiosFromPoint(oldLeft, oldTop, fw, fh);
        savePos();
      }
    } catch (e) {}
  }
  function savePos() {
    try { localStorage.setItem(POS_KEY, JSON.stringify(_pos)); } catch (e) {}
  }

  /* visualViewport tracks the actually visible area when a mobile keyboard or
     browser chrome shrinks/offsets it. Falling back to the layout viewport keeps
     desktop and older WebViews unchanged. */
  function viewportBox() {
    var vv = window.visualViewport;
    if (vv && typeof vv.width === 'number' && typeof vv.height === 'number') {
      return {
        left: vv.offsetLeft || 0,
        top: vv.offsetTop || 0,
        width: vv.width,
        height: vv.height,
        right: (vv.offsetLeft || 0) + vv.width,
        bottom: (vv.offsetTop || 0) + vv.height
      };
    }
    return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight,
      right: window.innerWidth, bottom: window.innerHeight };
  }

  function fabBounds(w, h) {
    var vb = viewportBox();
    var minX = vb.left + Math.max(8, safeInset('left'));
    var minY = vb.top + Math.max(8, safeInset('top'));
    // Keep clear of the full-width toast band on phones; desktop toasts only
    // occupy one corner, so a small safety gap is enough there.
    var reserveBottom = vb.width <= 768 ? 76 : 12;
    var maxX = Math.max(minX, vb.right - w - Math.max(8, safeInset('right')));
    var maxY = Math.max(minY, vb.bottom - h - Math.max(reserveBottom, safeInset('bottom') + 8));
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
  }

  // CSS env() values cannot be read directly from JS. A hidden probe converts
  // the active safe-area inset into pixels in browsers/WebViews that expose it.
  var _insetProbe = null;
  function safeInset(side) {
    if (!_insetProbe) {
      _insetProbe = document.createElement('div');
      _insetProbe.setAttribute('aria-hidden', 'true');
      _insetProbe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;' +
        'padding-top:env(safe-area-inset-top);padding-right:env(safe-area-inset-right);' +
        'padding-bottom:env(safe-area-inset-bottom);padding-left:env(safe-area-inset-left)';
      document.body.appendChild(_insetProbe);
    }
    try {
      var styles = getComputedStyle(_insetProbe);
      return parseFloat(styles['padding' + side.charAt(0).toUpperCase() + side.slice(1)]) || 0;
    } catch (e) { return 0; }
  }

  function clampFabPoint(left, top, w, h) {
    var b = fabBounds(w, h);
    return {
      left: Math.min(b.maxX, Math.max(b.minX, left)),
      top: Math.min(b.maxY, Math.max(b.minY, top)),
      bounds: b
    };
  }

  function ratiosFromPoint(left, top, w, h) {
    var p = clampFabPoint(left, top, w, h), b = p.bounds;
    return {
      xRatio: (p.left - b.minX) / Math.max(1, b.maxX - b.minX),
      yRatio: (p.top - b.minY) / Math.max(1, b.maxY - b.minY)
    };
  }

  /* Applies the remembered free position. Until the character has been dragged
     once, nothing is written inline and the stylesheet's default corner stands. */
  function applyFabPosition() {
    if (!_fab || !_pos) return;
    var w = _fab.offsetWidth || 56, h = _fab.offsetHeight || 56;
    var b = fabBounds(w, h);
    var left = b.minX + _pos.xRatio * Math.max(0, b.maxX - b.minX);
    var top = b.minY + _pos.yRatio * Math.max(0, b.maxY - b.minY);
    var p = clampFabPoint(left, top, w, h);
    _fab.style.right = 'auto';
    _fab.style.bottom = 'auto';
    _fab.style.left = Math.round(p.left) + 'px';
    _fab.style.top = Math.round(p.top) + 'px';
    if (_open) syncPanelPlacement();
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
      var w = fab.offsetWidth || 56, h = fab.offsetHeight || 56;
      var p = clampFabPoint(originLeft + dx, originTop + dy, w, h);
      fab.style.right = 'auto';
      fab.style.bottom = 'auto';
      fab.style.left = p.left + 'px';
      fab.style.top = p.top + 'px';
    }
    function end() {
      if (!dragging) return;
      dragging = false;
      pointerId = null;
      if (!moved) return;                 // a tap: let the click handler open it
      fab.classList.remove('is-dragging');
      _suppressClick = true;              // the drag's click must not open the chat
      var r = fab.getBoundingClientRect();
      _pos = ratiosFromPoint(r.left, r.top, r.width || 56, r.height || 56);
      savePos();
      applyFabPosition();                 // preserve the exact free position
      if (_open) syncPanelPlacement();
      if (typeof showToast === 'function' && !_posToastShown) {
        _posToastShown = true;
        showToast('Character moved. Place it anywhere — the spot is remembered.', 'info');
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

    // Keyboard users can move freely too. Shift accelerates the move.
    fab.addEventListener('keydown', function (e) {
      var step = e.shiftKey ? 40 : 12;
      var r = fab.getBoundingClientRect();
      var left = r.left, top = r.top, handled = true;
      if (e.key === 'ArrowUp') top -= step;
      else if (e.key === 'ArrowDown') top += step;
      else if (e.key === 'ArrowLeft') left -= step;
      else if (e.key === 'ArrowRight') left += step;
      else handled = false;
      if (!handled) return;
      e.preventDefault();
      _pos = ratiosFromPoint(left, top, r.width || 56, r.height || 56);
      savePos();
      applyFabPosition();
    });
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
    _reflow = setTimeout(function () {
      _reflow = 0;
      applyFabPosition();
      if (_open) syncPanelPlacement();
    }, 120);
  }
  window.addEventListener('resize', scheduleReflow);
  window.addEventListener('orientationchange', scheduleReflow);
  if (window.visualViewport && typeof window.visualViewport.addEventListener === 'function') {
    window.visualViewport.addEventListener('resize', scheduleReflow);
    window.visualViewport.addEventListener('scroll', scheduleReflow);
  }

  /* Place the desktop chat beside the freely positioned character without
     covering it. Four candidates (left/right/above/below) are evaluated after
     clamping to the safe viewport; overlap is penalised first, then how far a
     candidate had to be pulled back on-screen. On narrow screens the chat is a
     full-width bottom sheet, so inline placement is cleared and CSS takes over. */
  function syncPanelPlacement() {
    if (!_panel || !_fab || !_open) return;
    if (window.innerWidth <= 768) {
      _panel.style.left = '';
      _panel.style.right = '';
      _panel.style.top = '';
      _panel.style.bottom = '';
      _panel.style.width = '';
      _panel.removeAttribute('data-placement');
      return;
    }

    _panel.style.width = '';
    var vb = viewportBox();
    var fr = _fab.getBoundingClientRect();
    var pw = _panel.offsetWidth || Math.min(410, vb.width - 32);
    var ph = _panel.offsetHeight || Math.min(580, vb.height - 88);
    var gap = 14;
    var minX = vb.left + Math.max(12, safeInset('left'));
    var minY = vb.top + Math.max(12, safeInset('top'));
    var maxX = Math.max(minX, vb.right - pw - Math.max(12, safeInset('right')));
    var maxY = Math.max(minY, vb.bottom - ph - Math.max(12, safeInset('bottom')));
    var centerX = fr.left + fr.width / 2 - pw / 2;
    var centerY = fr.top + fr.height / 2 - ph / 2;
    var candidates = [
      { name: 'right', x: fr.right + gap, y: centerY },
      { name: 'left', x: fr.left - gap - pw, y: centerY },
      { name: 'below', x: centerX, y: fr.bottom + gap },
      { name: 'above', x: centerX, y: fr.top - gap - ph }
    ];

    function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
    function overlapArea(a, b) {
      var w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      var h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      return w * h;
    }

    var best = null;
    candidates.forEach(function (c, index) {
      var x = clamp(c.x, minX, maxX), y = clamp(c.y, minY, maxY);
      var box = { left: x, top: y, right: x + pw, bottom: y + ph };
      // Expand the character's avoidance rect slightly so the panel does not
      // visually kiss its drop shadow.
      var avoid = { left: fr.left - 6, top: fr.top - 6, right: fr.right + 6, bottom: fr.bottom + 6 };
      var overlap = overlapArea(box, avoid);
      var displacement = Math.abs(x - c.x) + Math.abs(y - c.y);
      var score = overlap * 1000000 + displacement * 100 + index;
      if (!best || score < best.score) {
        best = { x: x, y: y, name: c.name, score: score, overlap: overlap };
      }
    });

    /* A compact desktop can be too short for above/below and too narrow for a
       410px card beside a centred character. Ranking the four overlapping boxes
       is not enough — the higher-z character would mask chat controls. In that
       case shrink the panel into whichever horizontal lane is wider. At the
       desktop breakpoint (769px+) one side is always at least ~330px, still a
       comfortable chat width, and overlap becomes mathematically impossible. */
    if (best && best.overlap > 0) {
      var rightEdge = vb.right - Math.max(12, safeInset('right'));
      var leftSpace = Math.max(0, fr.left - gap - minX);
      var rightSpace = Math.max(0, rightEdge - (fr.right + gap));
      var useRight = rightSpace >= leftSpace;
      var laneWidth = Math.floor(Math.max(leftSpace, rightSpace));
      if (laneWidth >= 260) {
        pw = Math.min(pw, laneWidth);
        _panel.style.width = pw + 'px';
        maxY = Math.max(minY, vb.bottom - ph - Math.max(12, safeInset('bottom')));
        best = {
          x: useRight ? fr.right + gap : fr.left - gap - pw,
          y: clamp(centerY, minY, maxY),
          name: useRight ? 'compact-right' : 'compact-left',
          overlap: 0,
          score: 0
        };
      }
    }

    if (!best) return;
    _panel.style.right = 'auto';
    _panel.style.bottom = 'auto';
    _panel.style.left = Math.round(best.x) + 'px';
    _panel.style.top = Math.round(best.y) + 'px';
    _panel.setAttribute('data-placement', best.name);
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
    if (_open) { syncChrome(); syncPanelPlacement(); return; }
    _lastFocus = document.activeElement;
    _open = true;
    document.body.classList.add(OPEN_CLASS);
    if (_fab) {
      _fab.hidden = false;
      _fab.classList.add('is-open');
      _fab.classList.add('is-opening');
      if (_entryTimer) clearTimeout(_entryTimer);
      _entryTimer = setTimeout(function () {
        _entryTimer = 0;
        if (_fab) _fab.classList.remove('is-opening');
      }, 1250);
      _fab.setAttribute('aria-expanded', 'true');
      _fab.setAttribute('aria-label', 'Close the AI Tutor');
      _fab.title = 'Close AI Tutor — drag to move';
    }
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
    // The panel must be measurable before it can be placed. The open body class
    // above makes it display:flex synchronously; RAF catches the final layout.
    syncPanelPlacement();
    requestAnimationFrame(syncPanelPlacement);
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
    if (_entryTimer) { clearTimeout(_entryTimer); _entryTimer = 0; }
    if (_panel) { _panel.style.transform = ''; _panel.classList.remove('is-dragging'); }
    if (_fab) {
      _fab.hidden = false;
      _fab.classList.remove('is-open');
      _fab.classList.remove('is-opening');
      _fab.setAttribute('aria-expanded', 'false');
      _fab.setAttribute('aria-label', 'Ask the AI Tutor');
      _fab.title = 'Ask the AI Tutor — drag to move';
    }
    if (_lastFocus && _lastFocus.isConnected && typeof _lastFocus.focus === 'function') {
      try { _lastFocus.focus(); } catch (e) {}
    } else if (_fab) {
      try { _fab.focus(); } catch (e) {}
    }
  }

  function toggle() { if (_open) close(); else open(); }

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

  /* ── request-level character activity ────────────────────────────────────
     This tracks accepted sends by immutable turn id, rather than polling the
     currently selected chat history. A student can switch video/course while a
     reply is in flight and the character will still think until THAT request
     settles. */
  function activeTurnCount() {
    var count = _anonymousTurns;
    Object.keys(_activeTurns).forEach(function (key) { if (_activeTurns[key]) count++; });
    return count;
  }
  function refreshActivityMood() {
    var busy = activeTurnCount() > 0;
    if (_fab) _fab.classList.toggle('is-busy', busy);
    // Alert is a temporary higher-priority state. Its timer calls this again,
    // restoring Thinking when another accepted request is still running.
    if (_mood !== 'alert') setMood(busy ? 'thinking' : 'idle');
  }
  function startPulse(detail) {
    if (detail && detail.turnId) _activeTurns[detail.turnId] = true;
    else _anonymousTurns++;
    refreshActivityMood();
  }
  function settlePulse(detail) {
    if (detail && detail.turnId) delete _activeTurns[detail.turnId];
    else _anonymousTurns = Math.max(0, _anonymousTurns - 1);
    refreshActivityMood();
  }
  window.addEventListener('examzen:tutor-send', function (event) {
    startPulse(event && event.detail);
  });
  window.addEventListener('examzen:tutor-settled', function (event) {
    settlePulse(event && event.detail);
  });

  /* The free plan's daily message limit. Worth showing on the character because
     the student may well have the window closed when they hit it. It does NOT
     cancel another in-flight request's activity; after six seconds, the real
     request count decides whether to restore Thinking or Idle. */
  var _alertTimer = 0;
  window.addEventListener('examzen:tutor-limit', function () {
    if (!_fab) return;
    setMood('alert');
    if (_alertTimer) clearTimeout(_alertTimer);
    _alertTimer = setTimeout(function () {
      _alertTimer = 0;
      if (_mood === 'alert') {
        // Leave alert before refreshing, otherwise its priority guard would
        // intentionally preserve it.
        _mood = 'idle';
        refreshActivityMood();
      }
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
