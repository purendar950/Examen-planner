/* ══════════════════════════════════════════════
   ⚡ TURBO PLAYER  (Pro-only, opt-in)
   ──────────────────────────────────────────────
   Plays a single YouTube video through the self-hosted backend
   (youtube-turbo-proxy: yt-dlp + PO-token + byte-proxy) in a NATIVE
   <video> element, which unlocks:
     • true playback speed up to 4x (YouTube's iframe caps at 2x)
     • native Picture-in-Picture (works on mobile too)

   DESIGN (safe by default):
     • Default player = the original YouTube iframe. Untouched.
     • Turbo is OFF by default and only usable by Pro users.
     • If the backend is unreachable, a video is bot-gated, or has no
       single-file stream, Turbo SILENTLY FALLS BACK to the iframe so a
       Pro user is never left with a broken player.
     • Playlists always use the original player (Turbo is single-video only).

   This file only WRAPS existing globals (ytDoLoad / ytSetSpeed / ytPiP /
   switchPage) — the same additive pattern used by preppath-phase4-gating.js.
   It loads AFTER youtube.js and the gating file (see app.html).
══════════════════════════════════════════════ */
(function () {
  'use strict';

  /* Your deployed Render backend. Override at runtime with:
     localStorage.setItem('turboBackendUrl', 'https://your-service.onrender.com') */
  var TURBO_BACKEND_URL = (localStorage.getItem('turboBackendUrl')
    || 'https://youtube-turbo-proxy-gej4.onrender.com').replace(/\/+$/, '');

  /* Where the Turbo screenshot is POSTed. It goes to the SAME backend that
     streams the video (the proxy exposes /send-photo, which relays to Telegram
     server-side using the token from Firestore). Reusing TURBO_BACKEND_URL
     means there's no separate bot URL to configure — if video plays, sending
     works. Override only if you host the relay elsewhere:
       localStorage.setItem('telegramBotUrl','https://your-relay.onrender.com') */
  var TELEGRAM_BOT_URL = (localStorage.getItem('telegramBotUrl')
    || TURBO_BACKEND_URL).replace(/\/+$/, '');

  // Turbo is OFF by default on every page load (session-only toggle).
  // The design doc says: "Default player = the original YouTube iframe.
  // Untouched."  Persisting the enabled state caused every video start,
  // resume, and playlist-next to route through Turbo, which is not the
  // intended default behaviour.
  var turboEnabled = false;
  var turboVideoEl = null;      // the native <video>
  var turboActiveNow = false;   // true while a video is actually playing via Turbo
  var turboInlineHome = null;   // original player-wrap position while docked in Notes Focus
  var turboInlineContainer = null;
  var turboPipBlocked = false;  // runtime rejection: offer in-app mini-player instead
  var turboLoadSeq = 0;         // identity guard for overlapping async loads
  var turboLoadController = null;
  var turboPendingLoad = null;  // {seq,id,resume,iframe,fallback}
  var turboPhase = turboEnabled ? 'idle' : 'off'; // off | idle | loading | ready | unavailable
  var turboFailure = '';
  var turboVid = null;          // current video id playing in Turbo
  var turboVidTitle = '';       // current video title (from /api/info) for saved moments
  var lastSave = 0;
  var turboWatchAccum = 0;      // real (wall-clock) seconds watched, pending credit to Study Time
  var turboWatchLastTs = 0;     // Date.now() at the previous timeupdate

  /* Bank accumulated Turbo watch time into today's Study Time (mirrors the
     iframe player's ytFlushWatchTime). */
  function flushTurboWatchTime() {
    if (turboWatchAccum < 1) return;
    var secs = Math.round(turboWatchAccum);
    turboWatchAccum = 0;
    if (typeof creditVideoWatchTime === 'function') creditVideoWatchTime(secs);
  }

  function isPro() {
    return typeof ezIsPro === 'function' ? ezIsPro() : true;
  }

  /* Turbo is "active" (controls should target the native video) only when it's
     enabled AND the native video is the thing currently on screen. */
  function turboActive() {
    return turboActiveNow && turboVideoEl && turboVideoEl.style.display !== 'none';
  }

  /* Public lifecycle snapshot used by Notes Focus Mode. Keeping this read-only
     avoids coupling the notes UI to Turbo's private DOM or asynchronous fetch
     details. Every meaningful transition emits examzen:turbo-state. */
  function turboPipSupported() {
    return !!(!turboPipBlocked && turboVideoEl && typeof turboVideoEl.requestPictureInPicture === 'function' &&
      document.pictureInPictureEnabled !== false);
  }
  function turboState() {
    return {
      enabled: !!turboEnabled,
      active: !!turboActive(),
      phase: turboPhase,
      failure: turboFailure,
      videoId: turboVid || '',
      singleVideo: !!currentSingleVideoId(),
      pipSupported: turboPipSupported(),
      pipActive: !!(turboVideoEl && document.pictureInPictureElement === turboVideoEl),
      inlineActive: !!(turboInlineContainer && turboVideoEl && turboVideoEl.parentNode === turboInlineContainer),
      pro: !!isPro()
    };
  }
  function emitTurboState() {
    var detail = turboState();
    try {
      window.dispatchEvent(new CustomEvent('examzen:turbo-state', { detail: detail }));
    } catch (e) {
      try {
        var event = document.createEvent('CustomEvent');
        event.initCustomEvent('examzen:turbo-state', false, false, detail);
        window.dispatchEvent(event);
      } catch (ignored) {}
    }
  }
  window.ytTurboGetState = turboState;

  function restoreTurboInline(emit) {
    if (!turboVideoEl || !turboInlineContainer) return false;
    var home = turboInlineHome;
    turboInlineContainer = null;
    turboInlineHome = null;
    turboVideoEl.classList.remove('yt-turbo-inline');
    if (home && home.parent && home.parent.isConnected) {
      if (home.next && home.next.parentNode === home.parent) home.parent.insertBefore(turboVideoEl, home.next);
      else home.parent.appendChild(turboVideoEl);
    }
    if (emit !== false) emitTurboState();
    return true;
  }

  /* In browsers/WebViews without native PiP, Focus Mode can dock the SAME
     playing video element above the notes. Reparenting (rather than cloning)
     preserves currentTime, playbackRate, progress and Follow synchronization. */
  window.ytTurboMountInline = function (container) {
    if (!container || !turboActive() || turboPhase !== 'ready') return false;
    if (turboInlineContainer === container && turboVideoEl.parentNode === container) return true;
    restoreTurboInline(false);
    turboInlineHome = { parent: turboVideoEl.parentNode, next: turboVideoEl.nextSibling };
    turboInlineContainer = container;
    container.appendChild(turboVideoEl);
    turboVideoEl.classList.add('yt-turbo-inline');
    turboVideoEl.style.display = 'block';
    emitTurboState();
    return true;
  };
  window.ytTurboRestoreInline = function () { return restoreTurboInline(true); };

  /* ── one-time styles ── */
  (function injectCss() {
    var s = document.createElement('style');
    s.textContent =
      '#yt-turbo-video{position:absolute;inset:0;width:100%;height:100%;background:#000;display:none;object-fit:contain;z-index:2;}' +
      '#yt-turbo-status{position:absolute;inset:0;z-index:3;display:none;flex-direction:column;align-items:center;justify-content:center;gap:10px;background:rgba(0,0,0,0.82);color:#fff;text-align:center;padding:18px;font-size:0.85rem;}' +
      '#yt-turbo-status .sp{width:30px;height:30px;border:3px solid rgba(255,255,255,0.25);border-top-color:var(--accent,#00c896);border-radius:50%;animation:tbspin 0.8s linear infinite;}' +
      '@keyframes tbspin{to{transform:rotate(360deg)}}' +
      '.yt-turbo-toggle{cursor:pointer;border-radius:99px;padding:4px 12px;font-size:0.72rem;font-weight:700;font-family:var(--font);border:1px solid var(--border);background:var(--surface);color:var(--muted);white-space:nowrap;}' +
      '.yt-turbo-toggle.on{border-color:var(--accent,#00c896);background:rgba(0,200,150,0.12);color:var(--accent,#00c896);}' +
      /* pointer-events:none — the badge is purely decorative and must never
         intercept taps on the video/controls beneath it (even if some other
         rule changes its size on small screens). */
      '.yt-turbo-badge{position:absolute;top:10px;left:10px;z-index:4;background:rgba(0,0,0,0.7);color:var(--accent,#00c896);padding:3px 9px;border-radius:6px;font-size:0.68rem;font-weight:700;display:none;pointer-events:none;}';
    document.head.appendChild(s);
  })();

  /* ── build / fetch the native video element inside the player wrap ── */
  function ensureVideoEl() {
    if (turboVideoEl && document.body.contains(turboVideoEl)) return turboVideoEl;
    var wrap = document.getElementById('yt-player-wrap');
    if (!wrap) return null;

    var v = document.createElement('video');
    v.id = 'yt-turbo-video';
    v.setAttribute('playsinline', '');
    v.setAttribute('controls', '');   // native play/seek/fullscreen/volume
    // crossorigin MUST be set BEFORE src is assigned, otherwise drawing this
    // video onto a <canvas> "taints" it and canvas.toDataURL() throws — which
    // is exactly what the Turbo screenshot→Telegram feature needs. The proxy
    // sends Access-Control-Allow-Origin:* on /api/stream, so "anonymous" is safe.
    v.setAttribute('crossorigin', 'anonymous');
    wrap.appendChild(v);
    turboVideoEl = v;

    // "Turbo" badge
    if (!document.getElementById('yt-turbo-badge')) {
      var badge = document.createElement('div');
      badge.id = 'yt-turbo-badge';
      badge.className = 'yt-turbo-badge';
      badge.textContent = '⚡ Turbo';
      wrap.appendChild(badge);
    }
    // status overlay
    if (!document.getElementById('yt-turbo-status')) {
      var st = document.createElement('div');
      st.id = 'yt-turbo-status';
      wrap.appendChild(st);
    }

    // progress + resume + auto-mark (mirrors the iframe player's behaviour)
    v.addEventListener('timeupdate', function () {
      var now = Date.now();
      // Accumulate REAL elapsed watch time (wall-clock) between timeupdate
      // events while actually playing. Ignore gaps > 5s (paused/seeked/buffered
      // or the tab was backgrounded) so only genuine playback is credited.
      if (!v.paused && turboWatchLastTs) {
        var d = (now - turboWatchLastTs) / 1000;
        if (d > 0 && d <= 5) turboWatchAccum += d;
      }
      turboWatchLastTs = now;
      if (now - lastSave > 10000) { lastSave = now; saveTurboProgress(); flushTurboWatchTime(); }
      try {
        if (v.duration && v.duration > 0) {
          var pct = Math.round(v.currentTime / v.duration * 100);
          // Update the on-screen "X% watched" label — the iframe player does
          // this in its polling loop, but Turbo's native <video> must do it
          // itself, otherwise the watch % never updates in Turbo mode.
          if (typeof ytUpdateVideoWatchLabel === 'function' && turboVid) {
            ytUpdateVideoWatchLabel(turboVid, pct);
          }
          if (pct >= 90 && typeof ytAutoMarkOnComplete === 'function') {
            ytAutoMarkOnComplete();
          }
        }
      } catch (e) {}
    });
    v.addEventListener('pause', function () { saveTurboProgress(); turboWatchLastTs = 0; flushTurboWatchTime(); });
    v.addEventListener('enterpictureinpicture', function () {
      showBadge(true);
      // Keep the hidden background YouTube iframe silenced while the native
      // <video> is in PiP. Without this, the browser media session can wake
      // the background iframe on pause/resume and playback "escapes" back
      // into the original YouTube iframe. The onStateChange guard in
      // youtube.js re-pauses the iframe whenever this flag is set.
      window.ytPipBlockMain = true;
      try { if (typeof ytPlayer !== 'undefined' && ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo(); } catch (e) {}
      // Claim the media-session play/pause actions for the native <video>.
      // A page has a single media session and the YouTube iframe owns it, so
      // the PiP window's play button otherwise routes "play" to the iframe
      // (which the youtube.js guard re-pauses) — leaving the PiP video stuck
      // paused. Routing these actions to the native video lets it resume.
      setPipMediaSession(true);
      emitTurboState();
    });
    v.addEventListener('leavepictureinpicture', function () {
      showBadge(false);
      window.ytPipBlockMain = false;
      // Release the media-session handlers so normal playback controls behave
      // as before once we're out of PiP.
      setPipMediaSession(false);
      emitTurboState();
    });
    return v;
  }

  /* A fresh media element is created for every asynchronous Turbo load. These
     playback listeners are deliberately separate from load-completion events:
     a candidate cannot affect global state until its own immutable closure wins
     the sequence guard and promotes it to turboVideoEl. */
  function bindTurboRuntimeEvents(v) {
    v.addEventListener('timeupdate', function () {
      var now = Date.now();
      if (!v.paused && turboWatchLastTs) {
        var d = (now - turboWatchLastTs) / 1000;
        if (d > 0 && d <= 5) turboWatchAccum += d;
      }
      turboWatchLastTs = now;
      if (now - lastSave > 10000) { lastSave = now; saveTurboProgress(); flushTurboWatchTime(); }
      try {
        if (v.duration && v.duration > 0) {
          var pct = Math.round(v.currentTime / v.duration * 100);
          if (typeof ytUpdateVideoWatchLabel === 'function' && turboVid) ytUpdateVideoWatchLabel(turboVid, pct);
          if (pct >= 90 && typeof ytAutoMarkOnComplete === 'function') ytAutoMarkOnComplete();
        }
      } catch (e) {}
    });
    v.addEventListener('pause', function () { saveTurboProgress(); turboWatchLastTs = 0; flushTurboWatchTime(); });
    v.addEventListener('enterpictureinpicture', function () {
      showBadge(true);
      window.ytPipBlockMain = true;
      try { if (typeof ytPlayer !== 'undefined' && ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo(); } catch (e) {}
      setPipMediaSession(true);
      emitTurboState();
    });
    v.addEventListener('leavepictureinpicture', function () {
      showBadge(false);
      window.ytPipBlockMain = false;
      setPipMediaSession(false);
      emitTurboState();
    });
  }

  function showBadge(on) {
    var b = document.getElementById('yt-turbo-badge');
    if (b) b.style.display = on ? 'block' : 'none';
  }

  /* Route the OS / PiP-window play & pause buttons to the native <video>
     while it is in Picture-in-Picture. Setting these to null on exit hands
     control back to the browser default (and the YouTube iframe). */
  function setPipMediaSession(on) {
    if (!('mediaSession' in navigator)) return;
    try {
      if (on) {
        navigator.mediaSession.setActionHandler('play', function () {
          try { if (turboVideoEl) { var p = turboVideoEl.play(); if (p && p.catch) p.catch(function () {}); } } catch (e) {}
        });
        navigator.mediaSession.setActionHandler('pause', function () {
          try { if (turboVideoEl) turboVideoEl.pause(); } catch (e) {}
        });
      } else {
        navigator.mediaSession.setActionHandler('play', null);
        navigator.mediaSession.setActionHandler('pause', null);
      }
    } catch (e) {}
  }
  function status(msg) {
    var st = document.getElementById('yt-turbo-status');
    if (!st) return;
    if (msg === null) { st.style.display = 'none'; st.innerHTML = ''; return; }
    st.style.display = 'flex';
    st.innerHTML = '<div class="sp"></div><div>' + msg + '</div>';
  }

  function saveTurboProgress() {
    try {
      var v = turboVideoEl;
      if (!v || !turboVid) return;
      var cur = v.currentTime, dur = v.duration;
      if (!cur || cur < 1) return;
      var plKey = (typeof ytoCurrentPl !== 'undefined' && ytoCurrentPl)
        || (typeof ytCurrentPlaylistId !== 'undefined' && ytCurrentPlaylistId) || '_single';
      appState.ytVidTime = appState.ytVidTime || {};
      appState.ytVidTime[plKey] = appState.ytVidTime[plKey] || {};
      appState.ytVidTime[plKey][turboVid] = Math.floor(cur);
      if (dur > 0) {
        var pct = Math.round(cur / dur * 100);
        appState.ytVidProgress = appState.ytVidProgress || {};
        appState.ytVidProgress[plKey] = appState.ytVidProgress[plKey] || {};
        appState.ytVidProgress[plKey][turboVid] = pct;
      }
      if (typeof saveProgress === 'function') saveProgress();
    } catch (e) {}
  }

  /* Hide Turbo video, cancel any preparation, restore the iframe surface. */
  function deactivateTurbo(nextPhase, failure) {
    turboLoadSeq += 1;                // invalidate every pending callback/event
    if (turboLoadController) {
      try { turboLoadController.abort(); } catch (e) {}
    }
    if (turboPendingLoad) {
      clearTimeout(turboPendingLoad.mediaTimer);
      var pendingCandidate = turboPendingLoad.candidate;
      if (pendingCandidate && pendingCandidate !== turboVideoEl) {
        pendingCandidate.removeAttribute('src');
        try { pendingCandidate.load(); } catch (e) {}
        if (pendingCandidate.parentNode) pendingCandidate.parentNode.removeChild(pendingCandidate);
      }
    }
    turboLoadController = null;
    turboPendingLoad = null;
    restoreTurboInline(false);
    turboActiveNow = false;
    turboPhase = nextPhase || (turboEnabled ? 'idle' : 'off');
    turboFailure = failure || '';
    showBadge(false);
    status(null);
    if (turboVideoEl) {
      try { turboVideoEl.pause(); } catch (e) {}
      turboVideoEl.removeAttribute('src');
      delete turboVideoEl.dataset.turboLoadSeq;
      try { turboVideoEl.load(); } catch (e) {}
      turboVideoEl.style.display = 'none';
    }
    emitTurboState();
  }

  function turboResumePoint(id) {
    // Switching the SAME currently-playing video to Turbo must preserve the
    // exact live position, not a progress snapshot last saved up to 10s ago.
    try {
      if (turboActive() && turboVid === id && turboVideoEl) return turboVideoEl.currentTime || 0;
    } catch (e) {}
    try {
      var currentId = (typeof ytCurrentVideoId !== 'undefined') ? String(ytCurrentVideoId || '') : '';
      if (currentId === id && typeof ytPlayer !== 'undefined' && ytPlayer && ytPlayer.getCurrentTime) {
        return ytPlayer.getCurrentTime() || 0;
      }
    } catch (e) {}
    try { return (typeof ytResumeSeconds === 'function') ? (ytResumeSeconds(id) || 0) : 0; }
    catch (e) { return 0; }
  }

  function failTurboLoad(seq, reason) {
    var pending = turboPendingLoad;
    if (!pending || pending.seq !== seq || seq !== turboLoadSeq) return;
    clearTimeout(pending.mediaTimer);
    var id = pending.id;
    var resume = pending.resume;
    var iframeEl = pending.iframe;
    var fallback = pending.fallback;
    var candidate = pending.candidate;
    if (candidate && candidate !== turboVideoEl) {
      try { candidate.pause(); } catch (e) {}
      candidate.removeAttribute('src');
      try { candidate.load(); } catch (e) {}
      if (candidate.parentNode) candidate.parentNode.removeChild(candidate);
    }
    turboPendingLoad = null;
    turboLoadController = null;
    deactivateTurbo('unavailable', reason || 'stream-unavailable');
    if (iframeEl) iframeEl.style.display = 'block';
    if (typeof showToast === 'function') {
      showToast('⚡ Turbo is video ke liye available nahi — normal player use kar rahe hain.', 'info');
    }
    var resumedExistingIframe = false;
    try {
      var data = (typeof ytPlayer !== 'undefined' && ytPlayer && ytPlayer.getVideoData) ? ytPlayer.getVideoData() : null;
      if (data && data.video_id === id) {
        if (ytPlayer.seekTo) ytPlayer.seekTo(resume, true);
        if (ytPlayer.playVideo) ytPlayer.playVideo();
        resumedExistingIframe = true;
      }
    } catch (e) {}
    if (!resumedExistingIframe && typeof fallback === 'function') fallback();
  }

  /* ── core: prepare a video through the backend, then atomically activate it ── */
  function turboLoad(id, fallback) {
    var v = ensureVideoEl();
    if (!v) { fallback(); return; }

    var resume = turboResumePoint(id);
    var seq = ++turboLoadSeq;
    if (turboLoadController) {
      try { turboLoadController.abort(); } catch (e) {}
    }
    if (turboPendingLoad) {
      clearTimeout(turboPendingLoad.mediaTimer);
      var oldCandidate = turboPendingLoad.candidate;
      if (oldCandidate && oldCandidate !== v) {
        oldCandidate.removeAttribute('src');
        try { oldCandidate.load(); } catch (e) {}
        if (oldCandidate.parentNode) oldCandidate.parentNode.removeChild(oldCandidate);
      }
    }
    restoreTurboInline(false);
    try { v.pause(); } catch (e) {}
    v.removeAttribute('src');
    try { v.load(); } catch (e) {}
    v.style.display = 'none';

    // Pause—but keep—the iframe as the active timestamp source during proxy
    // wake-up. Focus/Follow therefore hold the exact current cue until Turbo is
    // genuinely ready, rather than jumping to the native element's 0:00.
    try { if (typeof ytPlayer !== 'undefined' && ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo(); } catch (e) {}

    turboVid = id;
    turboActiveNow = false;
    turboPipBlocked = false;
    turboPhase = 'loading';
    turboFailure = '';
    var ph = document.getElementById('yt-placeholder');
    if (ph) ph.style.display = 'none';
    var iframeEl = document.getElementById('yt-player');
    if (iframeEl) iframeEl.style.display = 'block';
    showBadge(false);
    status('⚡ Turbo: fetching stream… (first load can take ~30–60s if the server was asleep)');

    var ctrl = new AbortController();
    turboLoadController = ctrl;
    turboPendingLoad = { seq: seq, id: id, resume: resume, iframe: iframeEl, fallback: fallback };
    emitTurboState();
    var timer = setTimeout(function () { if (seq === turboLoadSeq) ctrl.abort(); }, 95000);

    var infoPath = '/api/info?id=' + encodeURIComponent(id);
    (window.PrepPathBackend && typeof window.PrepPathBackend.fetch === 'function'
      ? window.PrepPathBackend.fetch(infoPath, { signal: ctrl.signal, timeoutMs: 95000 })
      : Promise.reject(new Error('Backend routing is unavailable. Reload the app.')))
      .then(function (r) {
        var owner = window.PrepPathBackend.serverForResponse(r);
        return r.json().then(function (d) { return { ok: r.ok, d: d, owner: owner }; });
      })
      .then(function (res) {
        clearTimeout(timer);
        if (seq !== turboLoadSeq || !turboPendingLoad || turboPendingLoad.seq !== seq) return;
        if (!res.ok || !res.d || !res.d.formats || !res.d.formats.length) {
          throw new Error((res.d && (res.d.detail || res.d.error)) || 'no stream');
        }
        turboVidTitle = (res.d && res.d.title) || turboVidTitle;
        var f = res.d.formats[0];              // highest single-file quality
        var current = (typeof ytSpeedCurrent !== 'undefined') ? ytSpeedCurrent : 1;
        if (!res.owner || !res.owner.url) throw new Error('Turbo server affinity is unavailable. Reload the app.');
        var streamBase = res.owner.url;
        var streamUrl = streamBase + '/api/stream?id=' + encodeURIComponent(id) + '&itag=' + encodeURIComponent(f.itag);
        // Each asynchronous load owns a fresh media element. Event closures now
        // carry immutable seq/id/source identity, so an old queued media event
        // cannot observe mutable state from—and corrupt—a newer request.
        var candidate = v.cloneNode(false);
        candidate.removeAttribute('src');
        candidate.dataset.turboLoadSeq = String(seq);
        candidate.style.display = 'none';
        bindTurboRuntimeEvents(candidate);
        turboPendingLoad.src = streamUrl;
        turboPendingLoad.candidate = candidate;
        candidate.addEventListener('loadedmetadata', function () {
          var pending = turboPendingLoad;
          if (!pending || pending.candidate !== candidate || pending.seq !== seq ||
              seq !== turboLoadSeq || pending.id !== id || pending.src !== streamUrl) return;
          try { if (pending.resume > 0) candidate.currentTime = pending.resume; } catch (e) {}
          candidate.defaultPlaybackRate = current || 1;
          candidate.playbackRate = current || 1;
          var oldVideo = turboVideoEl;
          try { if (oldVideo) oldVideo.pause(); } catch (e) {}
          if (oldVideo && oldVideo.parentNode) oldVideo.parentNode.removeChild(oldVideo);
          var wrap = document.getElementById('yt-player-wrap');
          var anchor = document.getElementById('yt-turbo-badge') || document.getElementById('yt-turbo-status');
          if (!wrap) { failTurboLoad(seq, 'player-unavailable'); return; }
          if (anchor && anchor.parentNode === wrap) wrap.insertBefore(candidate, anchor);
          else wrap.appendChild(candidate);
          turboVideoEl = candidate;
          turboActiveNow = true;
          turboPhase = 'ready';
          turboFailure = '';
          if (pending.iframe) pending.iframe.style.display = 'none';
          candidate.style.display = 'block';
          status(null);
          clearTimeout(pending.mediaTimer);
          turboPendingLoad = null;
          turboLoadController = null;
          var play = candidate.play();
          if (play && play.catch) play.catch(function () {});
          emitTurboState();
        }, { once: true });
        candidate.addEventListener('error', function () {
          var pending = turboPendingLoad;
          if (pending && pending.candidate === candidate && pending.seq === seq && seq === turboLoadSeq) {
            failTurboLoad(seq, 'stream-error');
          }
        }, { once: true });
        candidate.src = streamUrl;
        // Set BOTH rates: on a fresh stream the browser resets playbackRate to
        // defaultPlaybackRate, so without setting defaultPlaybackRate too, Turbo
        // reverts to 1x (the "still slow after changing speed" bug).
        candidate.defaultPlaybackRate = current || 1;
        candidate.playbackRate = current || 1;
        status('⚡ Turbo: stream found — preparing video…');
        turboPendingLoad.mediaTimer = setTimeout(function () {
          failTurboLoad(seq, 'stream-timeout');
        }, 45000);
        candidate.load();
      })
      .catch(function (err) {
        clearTimeout(timer);
        // A superseded request is expected to abort; it must never deactivate
        // or fall back over a newer successful load.
        if (seq !== turboLoadSeq || !turboPendingLoad || turboPendingLoad.seq !== seq) return;
        failTurboLoad(seq, err && err.name === 'AbortError' ? 'timeout' : 'stream-unavailable');
      });
  }

  /* ══════════════════════════════════════════════
     WRAP EXISTING GLOBALS
  ══════════════════════════════════════════════ */

  // Track the chosen speed so Turbo loads start at the user's selected rate.
  var ytSpeedCurrent = 1;
  window.ytSpeedCurrent = ytSpeedCurrent;

  if (typeof ytDoLoad === 'function') {
    var _origYtDoLoad = ytDoLoad;
    ytDoLoad = function (type, id) {
      if (turboEnabled && type === 'video' && isPro() && typeof id === 'string' && id.length === 11) {
        turboLoad(id, function () { _origYtDoLoad(type, id); });
      } else {
        deactivateTurbo();
        _origYtDoLoad(type, id);
      }
    };
  }

  if (typeof ytSetSpeed === 'function') {
    var _origYtSetSpeed = ytSetSpeed;
    ytSetSpeed = function (rate) {
      ytSpeedCurrent = rate;
      window.ytSpeedCurrent = rate;
      if (turboActive()) {
        // Set both so the speed sticks across buffering / reloads.
        try { turboVideoEl.defaultPlaybackRate = rate; turboVideoEl.playbackRate = rate; } catch (e) {}
        if (typeof showToast === 'function') showToast('Speed: ' + rate + 'x', 'info');
        document.querySelectorAll('.yt-speed-btn').forEach(function (b) {
          b.classList.toggle('active', parseFloat(b.dataset.rate) === rate);
        });
        // The Turbo path bypasses youtube.js, so keep the compact selector in
        // sync here as well when a quick-preset button changes the rate.
        var speedSelect = document.getElementById('yt-speed-select');
        if (speedSelect && Array.prototype.some.call(speedSelect.options, function (o) {
          return parseFloat(o.value) === rate;
        })) speedSelect.value = String(rate);
      } else {
        _origYtSetSpeed(rate);
      }
    };
  }

  if (typeof ytPiP === 'function') {
    var _origYtPiP = ytPiP;
    ytPiP = function () {
      if (turboActive()) {
        return window.ytTurboOpenPiP().catch(function () {
          if (typeof showToast === 'function') showToast('PiP is not supported here. Try Chrome or Edge on desktop.', 'error');
        });
      }
      return _origYtPiP();
    };
  }

  /* ══════════════════════════════════════════════
     SCREENSHOT → TELEGRAM  (Turbo-only)
     ──────────────────────────────────────────────
     Turbo plays a NATIVE <video>, so — unlike the cross-origin YouTube iframe —
     we can paint the exact current frame onto a <canvas> and read the pixels
     back. We then POST that JPEG to the bot server, which relays it to the
     user's connected Telegram chat via sendPhoto.

     Only usable while Turbo is actually on screen (turboActive()); in iframe
     mode there is no readable frame, so the button is hidden entirely.
  ══════════════════════════════════════════════ */

  /* mm:ss / h:mm:ss for the caption timecode. */
  function turboFmtTs(secs) {
    secs = Math.max(0, Math.floor(secs || 0));
    var h = Math.floor(secs / 3600);
    var m = Math.floor((secs % 3600) / 60);
    var s = secs % 60;
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return h > 0 ? (h + ':' + pad(m) + ':' + pad(s)) : (m + ':' + pad(s));
  }

  /* Minimal HTML-escape for the caption (Telegram parse_mode:HTML). */
  function turboEsc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function turboSendToTelegram() {
    var v = turboVideoEl;
    if (!turboActive() || !v) {
      if (typeof showToast === 'function') showToast('📤 Screenshot sirf Turbo mein video chalte waqt bhej sakte ho.', 'error');
      return;
    }
    if (!v.videoWidth || !v.videoHeight) {
      if (typeof showToast === 'function') showToast('Video abhi load ho raha hai — 1–2 second ruk ke try karo.', 'error');
      return;
    }

    /* The server resolves the destination from the verified Firebase identity.
       Never accept a browser-provided Telegram chat ID. */
    if (!TELEGRAM_BOT_URL) {
      if (typeof showToast === 'function') showToast('Bot URL set nahi hai (telegramBotUrl).', 'error');
      return;
    }

    /* Paint the current frame. */
    var base64;
    try {
      var canvas = document.createElement('canvas');
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
      // toDataURL throws a SecurityError if the canvas is tainted (i.e. the
      // proxy didn't send Access-Control-Allow-Origin on the stream).
      base64 = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
    } catch (e) {
      if (typeof showToast === 'function') showToast('⚠️ Server ne frame block kiya (CORS). Backend cookies/headers check karo.', 'error');
      return;
    }
    if (!base64) {
      if (typeof showToast === 'function') showToast('Screenshot capture fail hua — dobara try karo.', 'error');
      return;
    }

    var t = Math.floor(v.currentTime || 0);
    var title = (typeof ytCurrentVideoTitle !== 'undefined' && ytCurrentVideoTitle) ? ytCurrentVideoTitle : 'YouTube video';
    var caption = '📸 <b>' + turboEsc(title) + '</b>\n⏱ ' + turboFmtTs(t) + '  ·  ⚡ Turbo';

    var btn = document.getElementById('yt-turbo-tg');
    if (btn) { btn.disabled = true; btn.dataset.busy = '1'; }
    if (typeof showToast === 'function') showToast('📤 Telegram par bhej rahe hain…', 'info');

    getFirebaseIdToken().then(function (token) {
      var requestOptions = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ imageBase64: base64, caption: caption })
      };
      if (!window.PrepPathBackend || typeof window.PrepPathBackend.fetch !== 'function' ||
          typeof window.PrepPathBackend.syncPolicy !== 'function') {
        throw new Error('Backend routing is unavailable. Reload the app.');
      }
      return window.PrepPathBackend.syncPolicy().then(function (config) {
        var strictBackend = !!(config && config.mode === 'strict');
        // A per-device relay override is allowed in auto/manual mode only. Strict
        // mode guarantees this upload uses the one Admin-selected backend too.
        var hasCustomRelay = !strictBackend && !!localStorage.getItem('telegramBotUrl');
        return strictBackend || !hasCustomRelay
          ? window.PrepPathBackend.fetch('/send-photo', requestOptions)
          : fetch(TELEGRAM_BOT_URL + '/send-photo', requestOptions);
      });
    })
      .then(function (r) { return r.json().catch(function () { return { ok: r.ok }; }); })
      .then(function (res) {
        if (res && res.ok) {
          if (typeof showToast === 'function') showToast('✅ Screenshot Telegram par bhej diya!', 'success');
          // Save a lightweight moment (only the Telegram file_id, no image
          // bytes) so it shows up in the Gallery / Analysis tab.
          if (res.fileId) turboSaveMoment(res.fileId, t, title);
        } else {
          if (typeof showToast === 'function') showToast('❌ Nahi bhej paye: ' + ((res && res.error) || 'unknown'), 'error');
        }
      })
      .catch(function () {
        if (typeof showToast === 'function') showToast('❌ Bot tak nahi pahuche — bot URL / server check karo.', 'error');
      })
      .then(function () {
        if (btn) { btn.disabled = false; delete btn.dataset.busy; }
      });
  }
  window.turboSendToTelegram = turboSendToTelegram;

  /* Persist a captured screenshot as a gallery "moment" WITHOUT storing image
     bytes — we keep only the Telegram file_id and point the thumbnail at the
     proxy's /tg-photo streamer. Reuses the existing yt-screenshots store, so
     the moment automatically appears in the YouTube gallery AND the Analysis →
     Gallery tab (same folder structure: Playlist → Video → Moment). */
  function turboSaveMoment(fileId, ts, title) {
    try {
      if (!fileId || typeof ssGetState !== 'function') return;

      /* Use turboVid — the id of the video actually playing in Turbo — as the
         source of truth. ytCurrentVideoId is NOT reliable here because Turbo's
         entry paths can bypass the loader that sets it, so ssGetCurrentContext()
         would return 'unknown' and the moment would never save. */
      var vid = String(turboVid || '').replace('playlist_', '');
      if (!vid && typeof ytCurrentVideoId !== 'undefined' && ytCurrentVideoId) {
        vid = String(ytCurrentVideoId).replace('playlist_', '');
      }
      if (!vid) return;

      var vname = title || turboVidTitle
        || ((typeof ytCurrentVideoTitle !== 'undefined' && ytCurrentVideoTitle) ? ytCurrentVideoTitle : 'Video');

      /* Best-effort playlist grouping (doesn't matter for the flat Screenshots
         tab, but keeps the gallery folder structure consistent). */
      var plId = 'general', plName = 'General';
      if (typeof ytCurrentPlaylistId !== 'undefined' && ytCurrentPlaylistId) { plId = ytCurrentPlaylistId; plName = 'Playlist'; }
      else if (typeof ytoCurrentPl !== 'undefined' && ytoCurrentPl) { plId = ytoCurrentPl; plName = 'Course'; }

      var state = ssGetState();
      if (!state.folders[plId]) state.folders[plId] = { name: plName, videos: {} };
      var folder = state.folders[plId];
      if (!folder.videos[vid]) folder.videos[vid] = { name: vname, items: [] };
      var vf = folder.videos[vid];
      if (vname && (vf.name === 'Video' || vf.name === 'Unknown Video')) vf.name = vname;

      var num = vf.items.filter(function (i) { return i.type === 'screenshot'; }).length + 1;
      vf.items.push({
        id: 'tg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        type: 'screenshot',
        number: num,
        timestamp: ts,
        timeLabel: turboFmtTs(ts),
        // Telegram's opaque file reference is kept; the app retrieves it with
        // a Firebase-authenticated request when rendering the thumbnail.
        tgFileId: fileId,
        videoId: vid,
        videoTitle: vname,
        createdAt: Date.now(),
        label: 'Moment_' + num,
        source: 'turbo-telegram'
      });
      if (typeof ssSave === 'function') ssSave();
      if (typeof ssRenderGallery === 'function') ssRenderGallery();
      if (typeof ssUpdateBadge === 'function') ssUpdateBadge();
    } catch (e) {}
  }

  /* ══════════════════════════════════════════════
     UI — toggle button + speed-bar tidy-up
  ══════════════════════════════════════════════ */
  function ytToggleTurbo() {
    if (!isPro()) {
      if (typeof ezLockedMsg === 'function') ezLockedMsg('⚡ Turbo Player (4x speed + Picture-in-Picture)');
      else if (typeof showToast === 'function') showToast('⚡ Turbo Pro plan mein milta hai.', 'error');
      return;
    }
    turboEnabled = !turboEnabled;
    turboPhase = turboEnabled ? 'idle' : 'off';
    turboFailure = '';
    // Intentionally NOT persisted — Turbo resets to OFF on every page
    // load so normal YouTube is always the default player.
    // localStorage.setItem('turboEnabled', turboEnabled ? '1' : '0');
    updateToggleUI();
    applySpeedVisibility();
    emitTurboState();
    if (typeof showToast === 'function') {
      showToast(turboEnabled ? '⚡ Turbo ON — up to 4x speed + PiP' : 'Turbo OFF — normal player', turboEnabled ? 'success' : 'info');
    }
    // Reload the currently-open single video in the newly selected mode.
    var cur = (typeof ytCurrentVideoId !== 'undefined') ? ytCurrentVideoId : null;
    if (cur && typeof cur === 'string' && cur.length === 11 && typeof ytDoLoad === 'function') {
      ytDoLoad('video', cur);
    } else if (!turboEnabled) {
      deactivateTurbo();
      var iframeEl = document.getElementById('yt-player');
      if (iframeEl && turboVid) iframeEl.style.display = 'block';
    }
  }
  window.ytToggleTurbo = ytToggleTurbo;

  function currentSingleVideoId() {
    var cur = '';
    try { if (typeof ytCurrentVideoId !== 'undefined' && ytCurrentVideoId) cur = String(ytCurrentVideoId); } catch (e) {}
    // Keep the existing product contract: a loaded playlist stays on the
    // original YouTube player. Switching it to a detached native stream would
    // break queue progression and auto-next semantics.
    if (cur.indexOf('playlist_') === 0) return '';
    if (!cur) {
      try {
        if (typeof ssGetCurrentContext === 'function') {
          var context = ssGetCurrentContext();
          if (context && context.videoId) cur = String(context.videoId);
        }
      } catch (e) {}
    }
    cur = cur.replace('playlist_', '');
    return /^[A-Za-z0-9_-]{11}$/.test(cur) ? cur : '';
  }

  /* One-way preparation action for Notes Focus Mode. Unlike ytToggleTurbo this
     can never turn Turbo off by accident. It begins the potentially slow proxy
     wake-up and returns immediately; callers observe examzen:turbo-state and
     expose a separate Open PiP click once loadedmetadata marks the video ready. */
  window.ytTurboStart = function () {
    if (!isPro()) {
      turboPhase = 'unavailable';
      turboFailure = 'pro-required';
      emitTurboState();
      if (typeof ezLockedMsg === 'function') ezLockedMsg('⚡ Turbo Player (4x speed + Picture-in-Picture)');
      return false;
    }
    var cur = currentSingleVideoId();
    if (!cur) {
      var playlistLoaded = false;
      try { playlistLoaded = typeof ytCurrentVideoId !== 'undefined' && String(ytCurrentVideoId || '').indexOf('playlist_') === 0; } catch (e) {}
      turboPhase = 'unavailable';
      turboFailure = playlistLoaded ? 'playlist' : 'no-video';
      emitTurboState();
      if (typeof showToast === 'function') {
        showToast(playlistLoaded ? 'Turbo supports individual videos only. Regular playlist playback is unchanged.'
                                 : 'Play an individual video before starting Turbo.', 'info');
      }
      return false;
    }
    if (turboActive() && turboPhase === 'ready' && turboVid === cur) {
      emitTurboState();
      return true;
    }
    // Activate Turbo in MEMORY only — do NOT persist to localStorage.
    // This prevents Notes Focus Mode from permanently flipping the default
    // player to Turbo for all future video loads. The user must explicitly
    // toggle the ⚡ Turbo button to persist the preference.
    turboEnabled = true;
    turboPhase = 'loading';
    turboFailure = '';
    updateToggleUI();
    applySpeedVisibility();
    emitTurboState();
    if (typeof ytDoLoad === 'function') ytDoLoad('video', cur);
    return true;
  };

  /* Promise-returning native PiP action. It must be called directly from the
     student's SECOND click after Turbo is ready; automatically entering PiP at
     the end of a fetch would lose browser user activation and be rejected. */
  window.ytTurboOpenPiP = function () {
    if (!turboActive() || turboPhase !== 'ready') {
      return Promise.reject(new Error('turbo-not-ready'));
    }
    if (!turboPipSupported()) return Promise.reject(new Error('pip-unsupported'));
    try {
      if (document.pictureInPictureElement === turboVideoEl) {
        return Promise.resolve(document.exitPictureInPicture());
      }
      if (turboVideoEl.paused) {
        var play = turboVideoEl.play();
        if (play && play.catch) play.catch(function () {});
      }
      return Promise.resolve(turboVideoEl.requestPictureInPicture()).catch(function (err) {
        // Some WebViews expose the method but reject every request. Remember
        // that runtime result so Focus Mode immediately offers its inline mini
        // player instead of trapping the student in a failing retry loop.
        turboPipBlocked = true;
        emitTurboState();
        throw err;
      });
    } catch (e) {
      turboPipBlocked = true;
      emitTurboState();
      return Promise.reject(e);
    }
  };

  /* ── Expose Turbo playback state to other modules ──
     Save Moment (yt-screenshots.js) must read the ACTUAL playback time from the
     native <video> when Turbo is on — the YouTube iframe it normally polls is
     paused/hidden with a stale time in Turbo mode. These return 0 / false when
     Turbo isn't active so callers cleanly fall back to the iframe player. */
  window.ytTurboActive = function () {
    try { return turboActive(); } catch (e) { return false; }
  };
  window.ytTurboCurrentTime = function () {
    try { return (turboActive() && turboVideoEl) ? (turboVideoEl.currentTime || 0) : 0; }
    catch (e) { return 0; }
  };
  window.ytTurboPlaying = function () {
    try { return !!(turboActive() && turboVideoEl && !turboVideoEl.paused && !turboVideoEl.ended); }
    catch (e) { return false; }
  };
  window.ytTurboDuration = function () {
    try { return (turboActive() && turboVideoEl) ? (turboVideoEl.duration || 0) : 0; }
    catch (e) { return 0; }
  };

  function updateToggleUI() {
    var btn = document.getElementById('yt-turbo-toggle');
    if (!btn) return;
    var pro = isPro();
    btn.classList.toggle('on', turboEnabled && pro);
    btn.textContent = !pro ? '⚡ Turbo 💎'
      : (turboEnabled ? '⚡ Turbo ON' : '⚡ Turbo');
    btn.title = !pro
      ? 'Turbo (4x speed + PiP) — Pro feature'
      : (turboEnabled ? 'Turbo ON — playing via your server at up to 4x. Click to turn off.'
                      : 'Turn on Turbo for real 4x speed + Picture-in-Picture');
  }

  /* Keep every supported rate available in the compact selector. The five
     common-rate buttons in the markup remain one-tap shortcuts; Turbo-only
     rates are enabled only while Turbo is on. */
  var TURBO_RATES = ['2.25', '2.5', '2.75', '3', '3.25', '3.5', '3.75', '4'];

  function applySpeedVisibility() {
    var bar = document.getElementById('yt-speed-bar');
    if (!bar) return;

    var select = document.getElementById('yt-speed-select');
    if (select) {
      TURBO_RATES.forEach(function (r) {
        var option = Array.prototype.find.call(select.options, function (o) { return o.value === r; });
        if (!option) {
          option = document.createElement('option');
          option.value = r;
          option.textContent = r + '×' + (parseFloat(r) > 3 ? ' Turbo' : '');
          select.appendChild(option);
        }
        option.disabled = !turboEnabled && parseFloat(r) > 2;
        option.hidden = !turboEnabled && parseFloat(r) > 2;
      });
      if (!turboEnabled && parseFloat(select.value) > 2) {
        select.value = '2';
        if (typeof ytSetSpeed === 'function') ytSetSpeed(2);
      }
    }

    // Quick presets always represent the most useful iframe-compatible rates.
    // Higher Turbo rates stay available from the adjacent selector.
    bar.querySelectorAll('.yt-speed-btn').forEach(function (b) {
      b.style.display = parseFloat(b.dataset.rate) <= 2 ? '' : 'none';
    });

    var tgBtn = document.getElementById('yt-turbo-tg');
    if (tgBtn) tgBtn.style.display = turboEnabled ? '' : 'none';
  }

  function initUI() {
    var bar = document.getElementById('yt-speed-bar');
    if (!bar) return;
    if (!document.getElementById('yt-turbo-controls')) {
      // Vertical stack at the start of the speed bar: the Turbo toggle on top,
      // the TG (screenshot) button directly BELOW it. align-items:stretch makes
      // both buttons the SAME width/size.
      var col = document.createElement('div');
      col.id = 'yt-turbo-controls';
      col.style.cssText = 'display:flex;flex-direction:column;gap:4px;align-items:stretch;';

      var btn = document.createElement('button');
      btn.id = 'yt-turbo-toggle';
      btn.className = 'yt-turbo-toggle';
      btn.setAttribute('onclick', 'ytToggleTurbo()');
      col.appendChild(btn);

      // Send-screenshot-to-Telegram — same class as the Turbo button (= same
      // size), placed right below it. Only shown in Turbo mode.
      var tg = document.createElement('button');
      tg.id = 'yt-turbo-tg';
      tg.className = 'yt-turbo-toggle';
      tg.textContent = '📤 TG';
      tg.title = 'Send a screenshot of this exact frame to your Telegram';
      tg.setAttribute('onclick', 'turboSendToTelegram()');
      col.appendChild(tg);

      bar.insertBefore(col, bar.firstChild);
    }
    ensureVideoEl();
    updateToggleUI();
    applySpeedVisibility();
    emitTurboState();
  }

  // Init when the YouTube page opens (markup is injected via include-loader).
  if (typeof onPageActivated === 'function') {
    onPageActivated('youtube', function () { setTimeout(initUI, 60); });
  }
  window.addEventListener('load', function () { setTimeout(initUI, 800); });
})();
