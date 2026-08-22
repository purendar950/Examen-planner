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
  var ronflixPendingEnable = false;
  var ronflixWrappedLoad = null;
  var ronflixPreviousSpeed = null;
  var normalRestoreSeq = 0;
  var ronflixPreviousPiP = null;

  function validId(id) { return /^[A-Za-z0-9_-]{11}$/.test(String(id || '')); }
  function currentId() {
    try {
      var id = (typeof ytCurrentVideoId !== 'undefined' && ytCurrentVideoId) || '';
      id = String(id || '').replace(/^playlist_/, '');
      if (validId(id)) return id;
      if (typeof ytPlayer !== 'undefined' && ytPlayer && typeof ytPlayer.getVideoData === 'function') {
        var data = ytPlayer.getVideoData() || {};
        if (validId(data.video_id)) return String(data.video_id);
      }
      return validId(ronflixId) ? ronflixId : '';
    } catch (e) { return validId(ronflixId) ? ronflixId : ''; }
  }
  function currentTitle() {
    try {
      var title = (typeof ytCurrentVideoTitle !== 'undefined' && ytCurrentVideoTitle) || '';
      if (title && title !== 'Playlist' && title !== 'Unknown Video') return title;
      if (typeof ytPlayer !== 'undefined' && ytPlayer && typeof ytPlayer.getVideoData === 'function') {
        var data = ytPlayer.getVideoData() || {};
        if (data.title) return String(data.title);
      }
      return title || ronflixTitle || 'YouTube video';
    } catch (e) { return ronflixTitle || 'YouTube video'; }
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
      '#yt-ronflix-video{position:absolute;top:0;left:0;width:100%;height:100%;display:none;background:#000;object-fit:contain;z-index:5;}' +
      '#yt-ronflix-status{position:absolute;inset:0;z-index:6;display:none;flex-direction:column;align-items:center;justify-content:center;gap:10px;background:rgba(0,0,0,.84);color:#fff;text-align:center;padding:18px;font-size:.85rem;line-height:1.5;}' +
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
    updateToggleUi();
    ronflixWatchLastTs = 0;
    flushWatchTime();
    saveProgress();
    var tapResume = document.getElementById('yt-tap-resume');
    if (tapResume && isActive()) tapResume.style.display = 'none';
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
    ronflixSeq += 1;
    if (ronflixAbort) { try { ronflixAbort.abort(); } catch (e) {} }
    ronflixAbort = null;
    ronflixActiveNow = false;
    ronflixEnabled = false;
    updateToggleUi();
    if (ronflixVideo) {
      try { ronflixVideo.pause(); } catch (e) {}
      ronflixVideo.removeAttribute('src');
      try { ronflixVideo.load(); } catch (e) {}
      ronflixVideo.style.display = 'none';
    }
    setStatus('');
    var iframe = document.getElementById('yt-player');
    if (iframe) iframe.style.display = 'block';
    var placeholder = document.getElementById('yt-placeholder');
    if (placeholder) placeholder.style.display = 'none';
    showToastSafe('RonFlix unavailable — normal player use kar rahe hain.' + (reason ? ' ' + reason : ''), 'info');
    restoreNormalPlayer('video', id);
  }

  function startRonflix(id, title) {
    var client = window.RonflixStream;
    if (!validId(id) || !client || typeof (client.getAllVideoStreams || client.getVideoStream) !== 'function') {
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
    updateToggleUi();
    normalRestoreSeq += 1;
    try {
      if (typeof ytPlayer !== 'undefined' && ytPlayer) {
        if (typeof ytPlayer.stopVideo === 'function') ytPlayer.stopVideo();
        else if (typeof ytPlayer.pauseVideo === 'function') ytPlayer.pauseVideo();
      }
    } catch (e) {}
    var iframe = document.getElementById('yt-player');
    if (iframe) iframe.style.display = 'none';
    var placeholder = document.getElementById('yt-placeholder');
    if (placeholder) placeholder.style.display = 'none';
    video.style.display = 'none';
    var resumeOverlay = document.getElementById('yt-tap-resume');
    if (resumeOverlay) resumeOverlay.style.display = 'none';
    setStatus('RonFlix: fetching stream…');

    var fetchFn = typeof client.getAllVideoStreams === 'function'
      ? function () { return client.getAllVideoStreams(id, { signal: ctrl.signal, timeoutMs: 12000 }); }
      : function () { return client.getVideoStream(id, { signal: ctrl.signal, timeoutMs: 12000 }).then(function (s) { return { streams: [s] }; }); };

    fetchFn()
      .then(function (result) {
        if (seq !== ronflixSeq || !ronflixEnabled || ctrl.signal.aborted) return null;
        var streams = result.streams || [];
        if (!streams.length) throw new Error('No playable streams returned by RonFlix server');
        setStatus('RonFlix: found ' + streams.length + ' stream(s), loading…');

        var resume = 0;
        try { if (typeof ytResumeSeconds === 'function') resume = ytResumeSeconds(id) || 0; } catch (e) {}
        video.defaultPlaybackRate = (window.ytSpeedCurrent || 1);
        video.playbackRate = (window.ytSpeedCurrent || 1);

        function attempt(index) {
          if (index >= streams.length) return Promise.reject(new Error('All ' + streams.length + ' stream URLs failed'));
          if (seq !== ronflixSeq || ctrl.signal.aborted) return Promise.reject(new Error('aborted'));
          var entry = streams[index];
          setStatus('RonFlix: loading ' + (entry.quality || 'stream') + ' (' + (index + 1) + '/' + streams.length + ')…');
          video.src = entry.url;
          return new Promise(function (resolve, reject) {
            var timer = setTimeout(function () { cleanup(); reject(new Error('timeout')); }, 15000);
            function loaded() { clearTimeout(timer); cleanup(); resolve(); }
            function failed() { clearTimeout(timer); cleanup(); reject(new Error('load-failed')); }
            function cleanup() {
              video.removeEventListener('loadedmetadata', loaded);
              video.removeEventListener('error', failed);
            }
            video.addEventListener('loadedmetadata', loaded);
            video.addEventListener('error', failed);
            video.load();
          }).catch(function (err) {
            console.warn('RonFlix attempt ' + (index + 1) + ' (' + (entry.quality || '?') + '):', err.message);
            return attempt(index + 1);
          });
        }

        return attempt(0).then(function () {
          if (seq !== ronflixSeq || !ronflixEnabled || ctrl.signal.aborted) return;
          try { if (resume > 0) video.currentTime = resume; } catch (e) {}
          ronflixActiveNow = true;
          updateToggleUi();
          ronflixWatchLastTs = Date.now();
          ronflixLastSave = Date.now();
          setStatus('');
          video.style.display = 'block';
          var play = video.play();
          if (play && play.catch) {
            play.catch(function (playError) {
              console.warn('RonFlix autoplay blocked:', playError.message || playError);
              video.muted = true;
              var mutedPlay = video.play();
              if (mutedPlay && mutedPlay.catch) mutedPlay.catch(function () {});
              showToastSafe('Tap the video to unmute.', 'info');
            });
          }
        });
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
    var active = !!(ronflixEnabled && ronflixActiveNow);
    var hasVideo = !!validId(currentId());
    button.classList.toggle('on', active);
    button.textContent = active
      ? '\u25c8 RonFlix ON'
      : (hasVideo ? '\u25c8 RonFlix' : '\u25c8 RonFlix (load video)');
    button.disabled = !hasVideo && !active;
    button.style.opacity = (!hasVideo && !active) ? '0.55' : '';
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    button.title = active
      ? 'RonFlix ON — playing via the RonFlix server. Click to switch back.'
      : hasVideo
        ? 'RonFlix — click to play this video through the RonFlix/Piped server.'
        : 'Load a YouTube video first, then click RonFlix to switch playback.';
  }

  function reloadCurrent() {
    var id = currentId();
    if (!validId(id)) return;
    startRonflix(id, currentTitle());
  }

  function setEnabled(next) {
    next = !!next;
    console.log('[RonFlix] toggle clicked — enabling:', next, '| currentId:', currentId());
    if (next && !validId(currentId())) {
      // No video loaded yet: remember the intent and tell the user clearly.
      ronflixPendingEnable = true;
      updateToggleUi();
      showToastSafe('Pehle ek video load karo, phir RonFlix auto-on ho jayega.', 'info');
      return;
    }
    ronflixPendingEnable = false;
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
    showToastSafe(next ? '\u25c8 RonFlix ON — native stream player' : 'RonFlix OFF — normal player', next ? 'success' : 'info');
  }

  // Called by the periodic watcher: if the user asked to enable RonFlix before
  // a video was loaded, auto-enable now that one is available.
  function maybeAutoEnable() {
    if (ronflixPendingEnable && !ronflixEnabled && validId(currentId())) {
      ronflixPendingEnable = false;
      setEnabled(true);
    }
  }

  window.ytToggleRonflix = function () { setEnabled(!ronflixEnabled); };
  window.ytRonflixGetState = function () {
    return { enabled: ronflixEnabled, active: isActive(), videoId: ronflixId, title: ronflixTitle };
  };

  function initUi() {
    var bar = document.getElementById('yt-speed-bar');
    if (!bar) return false;
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
      controls.appendChild(button);
    }
    // Always rebind the visible button. The YouTube/Turbo UI can re-render and
    // replace nodes; if we only bound newly-created nodes the button could
    // look clickable but do nothing. Re-binding on every init keeps it live.
    button.onclick = function (event) {
      if (event) event.preventDefault();
      return window.ytToggleRonflix();
    };
    updateToggleUi();
    return true;
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

  // Self-contained activation: do NOT depend solely on onPageActivated, because
  // the speed bar / turbo controls may not be ready when that fires. Poll until
  // the button exists and stays bound, and keep it synced with the player state.
  function bootRonflixUi() {
    if (initUi()) {
      updateToggleUi();
      maybeAutoEnable();
    }
  }
  if (typeof onPageActivated === 'function') onPageActivated('youtube', function () { setTimeout(bootRonflixUi, 60); });
  window.addEventListener('load', function () { setTimeout(bootRonflixUi, 800); });
  document.addEventListener('DOMContentLoaded', function () { setTimeout(bootRonflixUi, 100); });
  // Fallback polling in case the above events were missed or the markup is
  // injected late (include-loader, partial re-render, etc.).
  var ronflixBootTries = 0;
  var ronflixBootTimer = setInterval(function () {
    ronflixBootTries += 1;
    bootRonflixUi();
    if (document.getElementById('yt-ronflix-toggle')) {
      clearInterval(ronflixBootTimer);
    } else if (ronflixBootTries > 40) {
      clearInterval(ronflixBootTimer);
    }
  }, 500);
  // Keep the button state in sync with whether a video is loaded, and honour a
  // pending enable-once-a-video-loads request.
  setInterval(function () {
    if (document.getElementById('yt-ronflix-toggle')) {
      updateToggleUi();
      maybeAutoEnable();
    }
  }, 1000);
  document.addEventListener('visibilitychange', function () { if (document.hidden && isActive()) { saveProgress(); flushWatchTime(); } });
  window.addEventListener('pagehide', function () { if (isActive()) { saveProgress(); flushWatchTime(); } });
})();