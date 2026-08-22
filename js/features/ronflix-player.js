/*
   RONFLIX PLAYER MODE — main YouTube study tab
   Uses the shared RonflixStream Piped-compatible client and mirrors the iframe /
   Turbo lifecycle: native playback, resume position, watch progress, speed,
   Picture-in-Picture, and safe fallback to the previous player.
*/
(function () {
  'use strict';

  var ronflixEnabled = false;
  var ronflixVideo = null;
  var ronflixAbort = null;
  var ronflixSeq = 0;
  var ronflixId = '';
  var ronflixTitle = '';
  var ronflixActiveNow = false;
  var ronflixWatchAccum = 0;
  var ronflixWatchLastTs = 0;
  var ronflixLastSave = 0;
  var ronflixPreviousLoad = null;
  var ronflixWrappedLoad = null;
  var ronflixPreviousSpeed = null;
  var normalRestoreSeq = 0;
  var ronflixPreviousPiP = null;

  function validId(id) { return /^[A-Za-z0-9_-]{11}$/.test(String(id || '')); }
  function currentId() {
    try {
      var id = (typeof ytCurrentVideoId !== 'undefined' && ytCurrentVideoId) || ronflixId;
      return String(id || '').replace(/^playlist_/, '');
    } catch (e) { return ronflixId; }
  }
  function currentTitle() {
    try { return (typeof ytCurrentVideoTitle !== 'undefined' && ytCurrentVideoTitle) || ronflixTitle || 'YouTube video'; }
    catch (e) { return ronflixTitle || 'YouTube video'; }
  }
  function isActive() {
    return !!(ronflixActiveNow && ronflixVideo && ronflixVideo.style.display !== 'none');
  }
  function setStatus(message) {
    var el = document.getElementById('yt-ronflix-status');
    if (!el) return;
    if (!message) { el.style.display = 'none'; el.innerHTML = ''; return; }
    el.style.display = 'flex';
    el.innerHTML = '<div class="yt-ronflix-spinner"></div><div>' + escapeHtml(String(message)) + '</div>';
  }
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function showToastSafe(message, type) {
    if (typeof showToast === 'function') showToast(message, type || 'info');
  }
  function playerWrap() { return document.getElementById('yt-player-wrap'); }

  function injectStyles() {
    if (document.getElementById('yt-ronflix-style')) return;
    var style = document.createElement('style');
    style.id = 'yt-ronflix-style';
    style.textContent =
      '#yt-ronflix-video{position:absolute;inset:0;width:100%;height:100%;display:none;background:#000;object-fit:contain;z-index:2;}' +
      '#yt-ronflix-status{position:absolute;inset:0;z-index:3;display:none;flex-direction:column;align-items:center;justify-content:center;gap:10px;background:rgba(0,0,0,.84);color:#fff;text-align:center;padding:18px;font-size:.85rem;line-height:1.5;}' +
      '.yt-ronflix-spinner{width:30px;height:30px;border:3px solid rgba(255,255,255,.25);border-top-color:#8b5cf6;border-radius:50%;animation:ytRonflixSpin .8s linear infinite;}' +
      '@keyframes ytRonflixSpin{to{transform:rotate(360deg)}}' +
      '.yt-ronflix-toggle{border-color:#8b5cf6!important;color:#c4b5fd!important;}' +
      '.yt-ronflix-toggle.on{background:rgba(139,92,246,.14)!important;color:#ddd6fe!important;}';
    document.head.appendChild(style);
  }

  function ensureVideo() {
    var wrap = playerWrap();
    if (!wrap) return null;
    injectStyles();
    if (!ronflixVideo || !document.body.contains(ronflixVideo)) {
      ronflixVideo = document.getElementById('yt-ronflix-video');
      if (!ronflixVideo) {
        ronflixVideo = document.createElement('video');
        ronflixVideo.id = 'yt-ronflix-video';
        ronflixVideo.setAttribute('playsinline', '');
        ronflixVideo.setAttribute('controls', '');
        wrap.appendChild(ronflixVideo);
      }
      bindVideoEvents(ronflixVideo);
    }
    var status = document.getElementById('yt-ronflix-status');
    if (!status) {
      status = document.createElement('div');
      status.id = 'yt-ronflix-status';
      wrap.appendChild(status);
    }
    return ronflixVideo;
  }

  function flushWatchTime() {
    if (ronflixWatchAccum < 1) return;
    var seconds = Math.round(ronflixWatchAccum);
    ronflixWatchAccum = 0;
    if (typeof creditVideoWatchTime === 'function') creditVideoWatchTime(seconds);
  }

  function saveProgress() {
    var video = ronflixVideo;
    var id = ronflixId;
    if (!video || !id) return;
    var current = Number(video.currentTime || 0);
    var duration = Number(video.duration || 0);
    if (!current || current < 1) return;
    try {
      var key = (typeof ytoCurrentPl !== 'undefined' && ytoCurrentPl) ||
        (typeof ytCurrentPlaylistId !== 'undefined' && ytCurrentPlaylistId) || '_single';
      appState.ytVidTime = appState.ytVidTime || {};
      appState.ytVidTime[key] = appState.ytVidTime[key] || {};
      appState.ytVidTime[key][id] = Math.floor(current);
      if (duration > 0) {
        appState.ytVidProgress = appState.ytVidProgress || {};
        appState.ytVidProgress[key] = appState.ytVidProgress[key] || {};
        appState.ytVidProgress[key][id] = Math.round(current / duration * 100);
      }
      if (typeof window.saveProgress === 'function') window.saveProgress();
    } catch (e) {}
  }

  function bindVideoEvents(video) {
    video.addEventListener('timeupdate', function () {
      if (!isActive() || video !== ronflixVideo) return;
      var now = Date.now();
      if (!video.paused && ronflixWatchLastTs) {
        var delta = (now - ronflixWatchLastTs) / 1000;
        if (delta > 0 && delta <= 5) ronflixWatchAccum += delta;
      }
      ronflixWatchLastTs = now;
      var duration = Number(video.duration || 0);
      var current = Number(video.currentTime || 0);
      if (duration > 0) {
        var pct = Math.round(current / duration * 100);
        if (typeof ytUpdateVideoWatchLabel === 'function') ytUpdateVideoWatchLabel(ronflixId, pct);
        if (pct >= 90 && typeof ytAutoMarkOnComplete === 'function') ytAutoMarkOnComplete();
      }
      if (now - ronflixLastSave > 60000) {
        ronflixLastSave = now;
        saveProgress();
        flushWatchTime();
      }
    });
    video.addEventListener('play', function () {
      if (video === ronflixVideo) ronflixWatchLastTs = Date.now();
    });
    video.addEventListener('pause', function () {
      if (video !== ronflixVideo) return;
      saveProgress();
      ronflixWatchLastTs = 0;
      flushWatchTime();
    });
    video.addEventListener('ended', function () {
      if (video !== ronflixVideo) return;
      saveProgress();
      ronflixWatchLastTs = 0;
      flushWatchTime();
      if (typeof ytAutoMarkOnComplete === 'function') ytAutoMarkOnComplete();
    });
  }

  function stopRonflix(resetStatus) {
    ronflixSeq += 1;
    if (ronflixAbort) { try { ronflixAbort.abort(); } catch (e) {} }
    ronflixAbort = null;
    ronflixActiveNow = false;
    ronflixWatchLastTs = 0;
    flushWatchTime();
    saveProgress();
    if (ronflixVideo) {
      try { ronflixVideo.pause(); } catch (e) {}
      ronflixVideo.removeAttribute('src');
      try { ronflixVideo.load(); } catch (e) {}
      ronflixVideo.style.display = 'none';
    }
    var iframe = document.getElementById('yt-player');
    if (iframe && !ronflixEnabled) iframe.style.display = 'block';
    if (resetStatus !== false) setStatus('');
  }

  function revealNormalSurface() {
    var iframe = document.getElementById('yt-player');
    if (iframe) iframe.style.display = 'block';
    var placeholder = document.getElementById('yt-placeholder');
    if (placeholder) placeholder.style.display = 'none';
    var wrap = playerWrap();
    if (wrap) wrap.classList.add('ss-has-video');
  }

  function validNormalLoad(type, id) {
    if (type === 'video') return validId(id);
    if (type === 'playlist') return /^[A-Za-z0-9_-]{10,}$/.test(String(id || ''));
    return false;
  }

  function normalPlayerIsReady() {
    try {
      return typeof ytPlayerReady !== 'undefined' && !!ytPlayerReady &&
        typeof ytPlayer !== 'undefined' && !!ytPlayer;
    } catch (e) { return false; }
  }

  function ensureNormalIframe(type, id, seq) {
    if (seq !== normalRestoreSeq || ronflixEnabled || !validNormalLoad(type, id)) return;
    var host = document.getElementById('yt-player');
    if (!host || normalPlayerIsReady() || host.querySelector('iframe')) return;
    if (typeof ytBuildEmbedUrl !== 'function') return;
    var iframe = document.createElement('iframe');
    iframe.src = ytBuildEmbedUrl(type, id);
    iframe.title = 'YouTube player';
    iframe.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture';
    iframe.setAttribute('allowfullscreen', '');
    iframe.style.cssText = 'width:100%;height:100%;border:none;display:block;';
    host.innerHTML = '';
    host.appendChild(iframe);
    revealNormalSurface();
  }

  function restoreNormalPlayer(type, id) {
    if (!validNormalLoad(type, id)) return;
    var seq = ++normalRestoreSeq;
    revealNormalSurface();
    if (typeof ronflixPreviousLoad === 'function') {
      ronflixPreviousLoad(type, id);
    } else if (typeof window.ytDoLoad === 'function' && window.ytDoLoad !== ronflixWrappedLoad) {
      window.ytDoLoad(type, id);
    }
    // If the API is still pending and leaves the mount blank, restore a direct
    // iframe after its normal startup window instead of showing a black player.
    setTimeout(function () { ensureNormalIframe(type, id, seq); }, 1200);
  }

  function fallbackToPrevious(id, reason) {
    ronflixActiveNow = false;
    ronflixEnabled = false;
    if (ronflixVideo) ronflixVideo.style.display = 'none';
    setStatus('');
    updateToggleUi();
    var iframe = document.getElementById('yt-player');
    if (iframe) iframe.style.display = 'block';
    showToastSafe('RonFlix unavailable — previous player use kar rahe hain.' + (reason ? ' ' + reason : ''), 'info');
    if (typeof ronflixPreviousLoad === 'function') ronflixPreviousLoad('video', id);
  }

  function startRonflix(id, title) {
    if (!validId(id) || !window.RonflixStream || typeof window.RonflixStream.getVideoStream !== 'function') {
      fallbackToPrevious(id, 'Server client load nahi hua.');
      return;
    }
    var video = ensureVideo();
    if (!video) { fallbackToPrevious(id, 'Player unavailable.'); return; }
    var seq = ++ronflixSeq;
    if (ronflixAbort) { try { ronflixAbort.abort(); } catch (e) {} }
    var ctrl = new AbortController();
    ronflixAbort = ctrl;
    ronflixId = id;
    ronflixTitle = title || currentTitle();
    ronflixActiveNow = false;
    normalRestoreSeq += 1;
    try {
      if (typeof ytPlayer !== 'undefined' && ytPlayer && typeof ytPlayer.pauseVideo === 'function') ytPlayer.pauseVideo();
    } catch (e) {}
    var iframe = document.getElementById('yt-player');
    if (iframe) iframe.style.display = 'none';
    var placeholder = document.getElementById('yt-placeholder');
    if (placeholder) placeholder.style.display = 'none';
    video.style.display = 'none';
    setStatus('RonFlix: fetching stream…');
    window.RonflixStream.getVideoStream(id, { signal: ctrl.signal, timeoutMs: 12000 })
      .then(function (stream) {
        if (seq !== ronflixSeq || !ronflixEnabled || ctrl.signal.aborted) return;
        video.src = stream.url;
        var resume = 0;
        try { if (typeof ytResumeSeconds === 'function') resume = ytResumeSeconds(id) || 0; } catch (e) {}
        video.defaultPlaybackRate = (window.ytSpeedCurrent || 1);
        video.playbackRate = (window.ytSpeedCurrent || 1);
        setStatus('RonFlix: stream found — preparing video…');
        return new Promise(function (resolve, reject) {
          var timer = setTimeout(function () { reject(new Error('stream timeout')); }, 30000);
          var loaded = function () {
            clearTimeout(timer);
            video.removeEventListener('loadedmetadata', loaded);
            video.removeEventListener('error', failed);
            resolve(resume);
          };
          var failed = function () {
            clearTimeout(timer);
            video.removeEventListener('loadedmetadata', loaded);
            video.removeEventListener('error', failed);
            reject(new Error('stream failed to load (possibly CORS blocked)'));
          };
          video.addEventListener('loadedmetadata', loaded);
          video.addEventListener('error', failed);
          video.load();
        });
      })
      .then(function (resume) {
        if (seq !== ronflixSeq || !ronflixEnabled || ctrl.signal.aborted) return;
        try { if (resume > 0) video.currentTime = resume; } catch (e) {}
        ronflixActiveNow = true;
        ronflixWatchLastTs = Date.now();
        ronflixLastSave = Date.now();
        setStatus('');
        video.style.display = 'block';
        var play = video.play();
        if (play && play.catch) play.catch(function () {});
      })
      .catch(function (error) {
        if (seq !== ronflixSeq || ctrl.signal.aborted) return;
        console.warn('RonFlix player:', error);
        setStatus('RonFlix failed: ' + (error.message || 'stream unavailable'));
        fallbackToPrevious(id, 'Try Turbo ya normal player.');
      });
  }

  function updateToggleUi() {
    var button = document.getElementById('yt-ronflix-toggle');
    if (!button) return;
    button.classList.toggle('on', ronflixEnabled);
    button.textContent = ronflixEnabled ? '◈ RonFlix ON' : '◈ RonFlix';
    button.title = ronflixEnabled
      ? 'RonFlix ON — native playback through the public stream mirror. Click to turn off.'
      : 'Play individual YouTube videos through RonFlix/Piped native playback.';
  }

  function reloadCurrent() {
    var id = currentId();
    if (!validId(id)) return;
    startRonflix(id, currentTitle());
  }

  function setEnabled(next) {
    next = !!next;
    if (next && !validId(currentId())) {
      showToastSafe('RonFlix individual videos ke liye hai — playlist normal player mein chalegi.', 'info');
      return;
    }
    if (next === ronflixEnabled) return;
    if (next && typeof window.ytTurboGetState === 'function') {
      var turbo = window.ytTurboGetState();
      if (turbo && turbo.enabled && typeof window.ytToggleTurbo === 'function') window.ytToggleTurbo();
    }
    ronflixEnabled = next;
    updateToggleUi();
    if (!next) {
      stopRonflix(true);
      var normalId = currentId();
      if (validId(normalId)) restoreNormalPlayer('video', normalId);
    } else {
      reloadCurrent();
    }
    showToastSafe(next ? '◈ RonFlix ON — native stream player' : 'RonFlix OFF — normal player', next ? 'success' : 'info');
  }

  window.ytToggleRonflix = function () { setEnabled(!ronflixEnabled); };
  window.ytRonflixGetState = function () {
    return { enabled: ronflixEnabled, active: isActive(), videoId: ronflixId, title: ronflixTitle };
  };

  function initUi() {
    var bar = document.getElementById('yt-speed-bar');
    if (!bar) return;
    injectStyles();
    var controls = document.getElementById('yt-turbo-controls');
    if (!controls) {
      controls = document.createElement('div');
      controls.id = 'yt-turbo-controls';
      controls.style.cssText = 'display:flex;flex-direction:column;gap:4px;align-items:stretch;';
      bar.insertBefore(controls, bar.firstChild);
    }
    var button = document.getElementById('yt-ronflix-toggle');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.id = 'yt-ronflix-toggle';
      button.className = 'yt-turbo-toggle yt-ronflix-toggle';
      button.onclick = window.ytToggleRonflix;
      controls.appendChild(button);
    }
    updateToggleUi();
  }

  /* Capture the already-wrapped loader, so Turbo remains the fallback and keeps
     all of its existing Pro gating and stream behavior. */
  if (typeof ytDoLoad === 'function') {
    ronflixPreviousLoad = ytDoLoad;
    ronflixWrappedLoad = window.ytDoLoad = ytDoLoad = function (type, id) {
      if (ronflixEnabled && type === 'video' && validId(id)) startRonflix(id, (typeof ytCurrentVideoTitle !== 'undefined' ? ytCurrentVideoTitle : 'YouTube video'));
      else {
        if (type !== 'video' && ronflixEnabled) {
          ronflixEnabled = false;
          updateToggleUi();
        }
        stopRonflix(false);
        restoreNormalPlayer(type, id);
      }
    };
  }
  if (typeof ytSetSpeed === 'function') {
    ronflixPreviousSpeed = ytSetSpeed;
    window.ytSetSpeed = ytSetSpeed = function (rate) {
      if (isActive() && ronflixVideo) {
        ronflixVideo.defaultPlaybackRate = rate;
        ronflixVideo.playbackRate = rate;
        window.ytSpeedCurrent = rate;
        document.querySelectorAll('.yt-speed-btn').forEach(function (button) {
          button.classList.toggle('active', parseFloat(button.dataset.rate) === rate);
        });
      } else ronflixPreviousSpeed(rate);
    };
  }
  if (typeof ytPiP === 'function') {
    ronflixPreviousPiP = ytPiP;
    window.ytPiP = ytPiP = function () {
      if (isActive() && ronflixVideo && ronflixVideo.src) {
        var task = document.pictureInPictureElement === ronflixVideo
          ? document.exitPictureInPicture()
          : ronflixVideo.requestPictureInPicture();
        return task.catch(function () { showToastSafe('RonFlix PiP browser mein supported nahi hai.', 'info'); });
      }
      return ronflixPreviousPiP();
    };
  }
  if (typeof window.ytToggleTurbo === 'function') {
    var previousTurboToggle = window.ytToggleTurbo;
    window.ytToggleTurbo = function () {
      if (!ronflixEnabled) return previousTurboToggle();
      ronflixEnabled = false;
      stopRonflix(false);
      updateToggleUi();
      return previousTurboToggle();
    };
  }

  if (typeof onPageActivated === 'function') onPageActivated('youtube', function () { setTimeout(initUi, 60); });
  window.addEventListener('load', function () { setTimeout(initUi, 800); });
  document.addEventListener('visibilitychange', function () { if (document.hidden && isActive()) { saveProgress(); flushWatchTime(); } });
  window.addEventListener('pagehide', function () { if (isActive()) { saveProgress(); flushWatchTime(); } });
})();
