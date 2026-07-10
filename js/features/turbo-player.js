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
    || 'https://youtube-turbo-proxy.onrender.com').replace(/\/+$/, '');

  /* Where the Turbo screenshot is POSTed. It goes to the SAME backend that
     streams the video (the proxy exposes /send-photo, which relays to Telegram
     server-side using the token from Firestore). Reusing TURBO_BACKEND_URL
     means there's no separate bot URL to configure — if video plays, sending
     works. Override only if you host the relay elsewhere:
       localStorage.setItem('telegramBotUrl','https://your-relay.onrender.com') */
  var TELEGRAM_BOT_URL = (localStorage.getItem('telegramBotUrl')
    || TURBO_BACKEND_URL).replace(/\/+$/, '');

  var turboEnabled = localStorage.getItem('turboEnabled') === '1';
  var turboVideoEl = null;      // the native <video>
  var turboActiveNow = false;   // true while a video is actually playing via Turbo
  var turboVid = null;          // current video id playing in Turbo
  var turboVidTitle = '';       // current video title (from /api/info) for saved moments
  var lastSave = 0;

  function isPro() {
    return typeof ezIsPro === 'function' ? ezIsPro() : true;
  }

  /* Turbo is "active" (controls should target the native video) only when it's
     enabled AND the native video is the thing currently on screen. */
  function turboActive() {
    return turboActiveNow && turboVideoEl && turboVideoEl.style.display !== 'none';
  }

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
      '.yt-turbo-badge{position:absolute;top:10px;left:10px;z-index:4;background:rgba(0,0,0,0.7);color:var(--accent,#00c896);padding:3px 9px;border-radius:6px;font-size:0.68rem;font-weight:700;display:none;}';
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
    v.addEventListener('loadedmetadata', function () {
      try {
        var s = (typeof ytResumeSeconds === 'function') ? ytResumeSeconds(turboVid) : 0;
        if (s > 0) v.currentTime = s;
      } catch (e) {}
    });
    v.addEventListener('timeupdate', function () {
      var now = Date.now();
      if (now - lastSave > 10000) { lastSave = now; saveTurboProgress(); }
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
    v.addEventListener('pause', saveTurboProgress);
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
    });
    v.addEventListener('leavepictureinpicture', function () {
      showBadge(false);
      window.ytPipBlockMain = false;
      // Release the media-session handlers so normal playback controls behave
      // as before once we're out of PiP.
      setPipMediaSession(false);
    });
    return v;
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

  /* Hide Turbo video, restore the iframe surface. */
  function deactivateTurbo() {
    turboActiveNow = false;
    showBadge(false);
    status(null);
    if (turboVideoEl) {
      try { turboVideoEl.pause(); } catch (e) {}
      turboVideoEl.removeAttribute('src');
      try { turboVideoEl.load(); } catch (e) {}
      turboVideoEl.style.display = 'none';
    }
  }

  /* ── core: play a video through the backend, fall back on any failure ── */
  function turboLoad(id, fallback) {
    var v = ensureVideoEl();
    if (!v) { fallback(); return; }

    // Pause the iframe player so we never get double audio.
    try { if (typeof ytPlayer !== 'undefined' && ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo(); } catch (e) {}

    turboVid = id;
    turboActiveNow = true;
    var ph = document.getElementById('yt-placeholder');
    if (ph) ph.style.display = 'none';
    var iframeEl = document.getElementById('yt-player');
    if (iframeEl) iframeEl.style.display = 'none';
    v.style.display = 'block';
    showBadge(true);
    status('⚡ Turbo: fetching stream… (first load can take ~30–60s if the server was asleep)');

    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 95000);

    fetch(TURBO_BACKEND_URL + '/api/info?id=' + encodeURIComponent(id), { signal: ctrl.signal })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        clearTimeout(timer);
        if (!res.ok || !res.d || !res.d.formats || !res.d.formats.length) {
          throw new Error((res.d && (res.d.detail || res.d.error)) || 'no stream');
        }
        turboVidTitle = (res.d && res.d.title) || turboVidTitle;
        var f = res.d.formats[0];              // highest single-file quality
        var current = (typeof ytSpeedCurrent !== 'undefined') ? ytSpeedCurrent : 1;
        v.src = TURBO_BACKEND_URL + '/api/stream?id=' + encodeURIComponent(id) + '&itag=' + encodeURIComponent(f.itag);
        v.playbackRate = current || 1;
        status(null);
        var p = v.play();
        if (p && p.catch) p.catch(function () {});
      })
      .catch(function (err) {
        clearTimeout(timer);
        // Silent, graceful fallback to the original iframe player.
        deactivateTurbo();
        if (iframeEl) iframeEl.style.display = 'block';
        if (typeof showToast === 'function') {
          showToast('⚡ Turbo is video ke liye available nahi — normal player use kar rahe hain.', 'info');
        }
        fallback();
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
        try { turboVideoEl.playbackRate = rate; } catch (e) {}
        if (typeof showToast === 'function') showToast('Speed: ' + rate + 'x', 'info');
        document.querySelectorAll('.yt-speed-btn').forEach(function (b) {
          b.classList.toggle('active', parseFloat(b.dataset.rate) === rate);
        });
      } else {
        _origYtSetSpeed(rate);
      }
    };
  }

  if (typeof ytPiP === 'function') {
    var _origYtPiP = ytPiP;
    ytPiP = function () {
      if (turboActive()) {
        try {
          if (document.pictureInPictureElement) { document.exitPictureInPicture(); return; }
          if (turboVideoEl.paused) turboVideoEl.play();
          turboVideoEl.requestPictureInPicture();
        } catch (e) {
          if (typeof showToast === 'function') showToast('PiP is browser mein supported nahi.', 'error');
        }
      } else {
        _origYtPiP();
      }
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

    /* Destination = the user's own connected Telegram chat. */
    var chatId = '';
    try { chatId = (appState && appState.telegram && appState.telegram.chatId) ? String(appState.telegram.chatId).trim() : ''; } catch (e) {}
    if (!chatId) {
      if (typeof showToast === 'function') showToast('Pehle Telegram connect karo: Profile → Daily Plan on Telegram.', 'error');
      return;
    }
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

    fetch(TELEGRAM_BOT_URL + '/send-photo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: chatId, imageBase64: base64, caption: caption })
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
        // Real captured frame, served from Telegram via the proxy (no bytes stored here).
        imageUrl: TURBO_BACKEND_URL + '/tg-photo?file_id=' + encodeURIComponent(fileId),
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
    localStorage.setItem('turboEnabled', turboEnabled ? '1' : '0');
    updateToggleUI();
    applySpeedVisibility();
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

  /* Show >2x speed buttons only in Turbo (they do nothing on the YouTube
     iframe, which caps at 2x). Also injects 3.5x & 4x for Turbo. */
  function applySpeedVisibility() {
    var bar = document.getElementById('yt-speed-bar');
    if (!bar) return;
    if (!bar.querySelector('[data-rate="4"]')) {
      var pip = bar.querySelector('.yt-pip-btn');
      ['3.5', '4'].forEach(function (r) {
        var b = document.createElement('button');
        b.className = 'yt-speed-btn';
        b.dataset.rate = r;
        b.textContent = r + 'x';
        b.setAttribute('onclick', 'ytSetSpeed(' + r + ')');
        bar.insertBefore(b, pip);
      });
    }
    bar.querySelectorAll('.yt-speed-btn').forEach(function (b) {
      var r = parseFloat(b.dataset.rate);
      if (r > 2) b.style.display = turboEnabled ? '' : 'none';
    });

    // "Send screenshot to Telegram" — Turbo-only (needs the native <video>).
    if (!bar.querySelector('#yt-turbo-tg')) {
      var pip2 = bar.querySelector('.yt-pip-btn');
      var tg = document.createElement('button');
      tg.id = 'yt-turbo-tg';
      tg.className = 'yt-speed-btn';
      tg.textContent = '📤 TG';
      tg.title = 'Send a screenshot of this exact frame to your Telegram';
      tg.setAttribute('onclick', 'turboSendToTelegram()');
      bar.insertBefore(tg, pip2);
    }
    var tgBtn = bar.querySelector('#yt-turbo-tg');
    if (tgBtn) tgBtn.style.display = turboEnabled ? '' : 'none';
  }

  function initUI() {
    var bar = document.getElementById('yt-speed-bar');
    if (!bar) return;
    if (!document.getElementById('yt-turbo-toggle')) {
      var btn = document.createElement('button');
      btn.id = 'yt-turbo-toggle';
      btn.className = 'yt-turbo-toggle';
      btn.setAttribute('onclick', 'ytToggleTurbo()');
      bar.insertBefore(btn, bar.firstChild);
    }
    ensureVideoEl();
    updateToggleUI();
    applySpeedVisibility();
  }

  // Init when the YouTube page opens (markup is injected via include-loader).
  if (typeof switchPage === 'function') {
    var _origSwitchPageTurbo = switchPage;
    switchPage = function (page) {
      _origSwitchPageTurbo(page);
      if (page === 'youtube') setTimeout(initUI, 60);
    };
  }
  window.addEventListener('load', function () { setTimeout(initUI, 800); });
})();
