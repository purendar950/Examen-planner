/* ══════════════════════════════════════════════
   CALCULATION PRACTICE TAB
   Lazy-loads calc/index.html, synchronizes the app theme, and persists
   editable presets/results through the authenticated appState.
══════════════════════════════════════════════ */
(function () {
  var loaded = false;
  var deepLinkSent = false;
  var calcSessionUid = null;
  var calcSessionKey = '';
  /* Every question type the practice app can generate. This list, QUIZ_CHOICES in
     calc/presets.js and CALC_QUIZ_IDS in bot/bot-server.js must stay identical:
     a type missing here is stripped from a preset on its way into appState, and a
     preset left with no types was then dropped outright. That is how the
     "Writing Table", "Two-Digit Multiplication" and "Three-Digit Multiplication"
     quick presets failed — saved in the iframe, absent from the cloud, so
     "Send to Telegram" answered "Save this preset before sending it to Telegram."
     tests/calc-preset-sync.test.mjs pins the three lists together. */
  var VALID_QUIZ_IDS = new Set([
    'addition', 'subtraction', 'mult1', 'mult2', 'mult3', 'tablewrite', 'mult2d', 'mult3d',
    'squares', 'sqroots', 'cubes', 'cuberoots', 'higherpow',
    'pctfrac', 'pctnum', 'trig', 'pyth', 'ci_si', 'ci_ci', 'primeinrange', 'isprime',
    'astr1', 'astr2', 'arev1', 'arev2'
  ]);

  function defaultCalcState() {
    return { version: 2, presets: [], dailyPresetId: '', history: [] };
  }

  function clampNumber(value, min, max, fallback) {
    var number = Number(value);
    if (!Number.isFinite(number)) number = fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
  }

  function safeText(value, maxLength) {
    return String(value == null ? '' : value).slice(0, maxLength);
  }

  function validTime(value) {
    if (!/^\d{2}:\d{2}$/.test(value || '')) return false;
    var parts = value.split(':').map(Number);
    return parts[0] >= 0 && parts[0] <= 23 && parts[1] >= 0 && parts[1] <= 59;
  }

  /* Mirrors difficultySettings() in calc/presets.js (and calculationDifficulty-
     Defaults() in bot/bot-server.js). Only a fallback for absent keys — the
     iframe always sends a full settings object — but a preset saved before the
     ranges were split relies on it. */
  function difficultyDefaults(level) {
    if (level === 'easy') {
      return {
        digits: 1, sqMin: 2, sqMax: 12, cubeMin: 2, cubeMax: 8, multFrom: 2, multTo: 9, multiplierFrom: 1, multiplierTo: 10,
        mult2Min: 10, mult2Max: 30, mult3Min: 100, mult3Max: 400, mult3ByMin: 2, mult3ByMax: 9, primeMax: 50, ciYears: 2
      };
    }
    if (level === 'exam') {
      return {
        digits: 3, sqMin: 10, sqMax: 50, cubeMin: 5, cubeMax: 25, multFrom: 11, multTo: 25, multiplierFrom: 1, multiplierTo: 20,
        mult2Min: 10, mult2Max: 99, mult3Min: 100, mult3Max: 999, mult3ByMin: 11, mult3ByMax: 99, primeMax: 300, ciYears: 3
      };
    }
    return {
      digits: 2, sqMin: 2, sqMax: 25, cubeMin: 2, cubeMax: 15, multFrom: 2, multTo: 9, multiplierFrom: 1, multiplierTo: 10,
      mult2Min: 10, mult2Max: 99, mult3Min: 100, mult3Max: 999, mult3ByMin: 2, mult3ByMax: 12, primeMax: 100, ciYears: 2
    };
  }

  /* Mirrors normalizeSettings() in calc/presets.js. Every key it produces has to
     survive this round trip: the ten it used to omit (squares, cubes, two- and
     three-digit multiplication bounds) were reset to difficulty defaults on
     every sync, so a customised range quietly reverted. */
  function sanitizeSettings(raw, difficulty) {
    var fallback = difficultyDefaults(difficulty === 'custom' ? 'standard' : difficulty);
    raw = raw && typeof raw === 'object' ? raw : {};
    var orderedPair = function (low, high, min, max, fallbackLow, fallbackHigh) {
      var lowValue = clampNumber(low, min, max, fallbackLow);
      var highValue = clampNumber(high, min, max, fallbackHigh);
      return highValue < lowValue ? [highValue, lowValue] : [lowValue, highValue];
    };
    /* A preset saved before the split carries one rangeMin/rangeMax pair, which
       seeds both base ranges so it keeps behaving the same. */
    var legacyLow = raw.sqMin == null && raw.cubeMin == null ? raw.rangeMin : null;
    var legacyHigh = raw.sqMax == null && raw.cubeMax == null ? raw.rangeMax : null;
    var square = orderedPair(
      raw.sqMin != null ? raw.sqMin : legacyLow, raw.sqMax != null ? raw.sqMax : legacyHigh,
      1, 100, fallback.sqMin, fallback.sqMax);
    var cube = orderedPair(
      raw.cubeMin != null ? raw.cubeMin : legacyLow, raw.cubeMax != null ? raw.cubeMax : legacyHigh,
      1, 100, fallback.cubeMin, fallback.cubeMax);
    var table = orderedPair(raw.multFrom, raw.multTo, 1, 100, fallback.multFrom, fallback.multTo);
    var multiplier = orderedPair(raw.multiplierFrom, raw.multiplierTo, 1, 100, fallback.multiplierFrom, fallback.multiplierTo);
    var twoDigit = orderedPair(raw.mult2Min, raw.mult2Max, 10, 99, fallback.mult2Min, fallback.mult2Max);
    var threeDigit = orderedPair(raw.mult3Min, raw.mult3Max, 100, 999, fallback.mult3Min, fallback.mult3Max);
    var threeDigitBy = orderedPair(raw.mult3ByMin, raw.mult3ByMax, 2, 999, fallback.mult3ByMin, fallback.mult3ByMax);
    return {
      digits: clampNumber(raw.digits, 1, 4, fallback.digits),
      sqMin: square[0],
      sqMax: square[1],
      cubeMin: cube[0],
      cubeMax: cube[1],
      multFrom: table[0],
      multTo: table[1],
      multiplierFrom: multiplier[0],
      multiplierTo: multiplier[1],
      mult2Min: twoDigit[0],
      mult2Max: twoDigit[1],
      mult3Min: threeDigit[0],
      mult3Max: threeDigit[1],
      mult3ByMin: threeDigitBy[0],
      mult3ByMax: threeDigitBy[1],
      primeMax: clampNumber(raw.primeMax, 10, 300, fallback.primeMax),
      ciYears: clampNumber(raw.ciYears, 2, 5, fallback.ciYears)
    };
  }

  /* Mirrors normalizeSegments() in calc/presets.js. Dropping these turned a
     combined multi-part preset back into a flat one on every sync — and the bot
     already reads parts, so Mini App practice never saw them either. */
  function sanitizeSegments(raw, difficulty) {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, 8).map(function (segment) {
      segment = segment && typeof segment === 'object' ? segment : {};
      var quizIds = Array.isArray(segment.quizIds)
        ? Array.from(new Set(segment.quizIds
          .map(function (id) { return safeText(id, 32); })
          .filter(function (id) { return VALID_QUIZ_IDS.has(id); })))
        : [];
      if (!quizIds.length) return null;
      var rawSegmentWeights = segment.weights && typeof segment.weights === 'object' ? segment.weights : {};
      var segmentWeights = {};
      quizIds.forEach(function (id) { segmentWeights[id] = clampNumber(rawSegmentWeights[id], 1, 10, 1); });
      return {
        name: safeText(segment.name, 40) || 'Part',
        quizIds: quizIds,
        weights: segmentWeights,
        share: clampNumber(segment.share, 1, 50, 10),
        settings: sanitizeSettings(segment.settings, difficulty)
      };
    }).filter(Boolean);
  }

  function sanitizePreset(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var validDifficulties = ['easy', 'standard', 'exam', 'custom'];
    var validTimers = [0, 3, 5, 10, 15];
    var difficulty = validDifficulties.includes(raw.difficulty) ? raw.difficulty : 'standard';
    var quizIds = Array.isArray(raw.quizIds)
      ? raw.quizIds.map(function (id) { return safeText(id, 32); }).filter(function (id) { return VALID_QUIZ_IDS.has(id); }).slice(0, VALID_QUIZ_IDS.size)
      : [];
    quizIds = Array.from(new Set(quizIds));
    /* Backfill exactly as normalizePreset() does rather than leaving the preset
       empty for sanitizeCalcState() to discard. A preset the user can still see
       in the iframe but that never reaches the cloud is the worst outcome: it
       cannot be sent, and the next state push deletes it. */
    if (!quizIds.length) {
      if (Array.isArray(raw.quizIds) && raw.quizIds.length) {
        console.warn('[calc] preset "' + safeText(raw.name, 40) + '" had no recognized question types', raw.quizIds);
      }
      quizIds = ['addition', 'subtraction', 'mult1'];
    }
    var days = Array.isArray(raw.days)
      ? raw.days.map(Number).filter(function (day) { return Number.isInteger(day) && day >= 0 && day <= 6; }).slice(0, 7)
      : [];
    var rawWeights = raw.weights && typeof raw.weights === 'object' ? raw.weights : {};
    var weights = {};
    quizIds.forEach(function (id) { weights[id] = clampNumber(rawWeights[id], 1, 10, 1); });
    var rawReminder = raw.reminder && typeof raw.reminder === 'object' ? raw.reminder : {};
    var leadOptions = [0, 5, 10, 15, 30, 60];
    var snoozeOptions = [5, 10, 15, 30, 60];
    var maxSnoozeOptions = [0, 1, 2, 3, 5];
    /* Parts are kept only while they cover exactly the selected types, matching
       normalizePreset() — otherwise a part would practise something the preset
       no longer lists, or a new type would never be asked. */
    var segments = sanitizeSegments(raw.segments, difficulty);
    var covered = [];
    segments.forEach(function (segment) {
      segment.quizIds.forEach(function (id) { if (covered.indexOf(id) < 0) covered.push(id); });
    });
    if (segments.length < 2 || covered.length !== quizIds.length
      || covered.some(function (id) { return quizIds.indexOf(id) < 0; })) segments = [];
    return {
      id: safeText(raw.id, 80),
      name: safeText(raw.name, 40) || 'My Practice',
      icon: safeText(raw.icon, 4) || '🧮',
      color: /^#[0-9a-f]{6}$/i.test(raw.color || '') ? raw.color : '#00C896',
      description: safeText(raw.description, 100),
      questionCount: clampNumber(raw.questionCount, 3, 50, 10),
      difficulty: difficulty,
      timerMinutes: validTimers.includes(Number(raw.timerMinutes)) ? Number(raw.timerMinutes) : 0,
      quizIds: quizIds,
      weights: weights,
      allowHints: raw.allowHints !== false,
      allowSkip: raw.allowSkip !== false,
      shuffle: raw.shuffle !== false,
      retryWrong: ['immediate', 'end', 'none'].includes(raw.retryWrong) ? raw.retryWrong : 'immediate',
      settings: sanitizeSettings(raw.settings, difficulty),
      segments: segments,
      sequential: segments.length >= 2 && raw.sequential !== false,
      dailyEnabled: raw.dailyEnabled === true,
      dailyTime: validTime(raw.dailyTime) ? raw.dailyTime : '07:00',
      days: Array.from(new Set(days)),
      reminder: {
        telegramEnabled: rawReminder.telegramEnabled === true,
        reminderMinutes: leadOptions.includes(Number(rawReminder.reminderMinutes)) ? Number(rawReminder.reminderMinutes) : 0,
        snoozeMinutes: snoozeOptions.includes(Number(rawReminder.snoozeMinutes)) ? Number(rawReminder.snoozeMinutes) : 10,
        maxSnoozes: maxSnoozeOptions.includes(Number(rawReminder.maxSnoozes)) ? Number(rawReminder.maxSnoozes) : 2
      },
      sourceTemplateId: safeText(raw.sourceTemplateId, 80),
      createdAt: safeText(raw.createdAt, 40),
      updatedAt: safeText(raw.updatedAt, 40)
    };
  }

  function canonicalPresetJson(value) {
    if (Array.isArray(value)) {
      return '[' + value.map(canonicalPresetJson).join(',') + ']';
    }
    if (value && typeof value === 'object') {
      return '{' + Object.keys(value).sort().map(function (key) {
        return JSON.stringify(key) + ':' + canonicalPresetJson(value[key]);
      }).join(',') + '}';
    }
    return JSON.stringify(value);
  }

  async function calculationPresetFingerprint(preset) {
    if (!window.crypto || !window.crypto.subtle || typeof TextEncoder === 'undefined') {
      throw new Error('Secure preset verification is unavailable. Reload StudyPlanner over HTTPS and try again.');
    }
    var bytes = new TextEncoder().encode(canonicalPresetJson(preset));
    var digest = await window.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map(function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
  }

  function sanitizeHistory(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    return {
      id: safeText(raw.id, 80),
      presetId: safeText(raw.presetId, 80),
      presetName: safeText(raw.presetName, 40) || 'Practice',
      date: /^\d{4}-\d{2}-\d{2}$/.test(raw.date || '') ? raw.date : '',
      completedAt: safeText(raw.completedAt, 40),
      total: clampNumber(raw.total, 1, 50, 10),
      answered: clampNumber(raw.answered, 0, 50, 0),
      firstTryCorrect: clampNumber(raw.firstTryCorrect, 0, 50, 0),
      wrongAttempts: clampNumber(raw.wrongAttempts, 0, 500, 0),
      hintsUsed: clampNumber(raw.hintsUsed, 0, 50, 0),
      skipped: clampNumber(raw.skipped, 0, 50, 0),
      durationSec: clampNumber(raw.durationSec, 0, 86400, 0),
      reason: raw.reason === 'time' ? 'time' : 'completed',
      mistakeQuizIds: Array.isArray(raw.mistakeQuizIds)
        ? raw.mistakeQuizIds.map(function (id) { return safeText(id, 32); }).filter(function (id) { return VALID_QUIZ_IDS.has(id); }).slice(0, 20)
        : [],
      presetSnapshot: raw.presetSnapshot ? sanitizePreset(raw.presetSnapshot) : null
    };
  }

  function sanitizeCalcState(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var presets = Array.isArray(raw.presets) ? raw.presets.map(sanitizePreset).slice(0, 30) : [];
    var validIds = new Set();
    /* sanitizePreset() backfills question types, so a preset can no longer be
       discarded for having none — that check silently deleted any preset built
       only from types this file did not recognise. A missing or duplicate id is
       the only reason left to drop one. */
    presets = presets.filter(function (preset) {
      if (!preset.id || validIds.has(preset.id)) return false;
      validIds.add(preset.id);
      return true;
    });
    var dailyPresetId = validIds.has(raw.dailyPresetId) ? raw.dailyPresetId : '';
    presets.forEach(function (preset) { preset.dailyEnabled = preset.id === dailyPresetId; });
    return {
      version: 2,
      presets: presets,
      dailyPresetId: dailyPresetId,
      history: Array.isArray(raw.history) ? raw.history.map(sanitizeHistory).slice(0, 60) : []
    };
  }

  function calcFrame() {
    return document.getElementById('calc-frame');
  }

  function postToCalc(payload) {
    var frame = calcFrame();
    if (!loaded || !frame || !frame.contentWindow) return;
    frame.contentWindow.postMessage(payload, window.location.origin);
  }

  function syncCalcTheme() {
    postToCalc({
      source: 'studyplanner',
      type: 'theme',
      theme: document.documentElement.dataset.theme || 'dark'
    });
  }

  function currentCalcSessionKey() {
    var uid = (typeof currentUser !== 'undefined' && currentUser && currentUser.uid) ? String(currentUser.uid) : '';
    if (uid !== calcSessionUid || !calcSessionKey) {
      calcSessionUid = uid;
      calcSessionKey = 'calc-session-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
    }
    return calcSessionKey;
  }

  function syncCalcState() {
    var stored = (typeof appState !== 'undefined' && appState && appState.calculationPractice)
      ? appState.calculationPractice
      : defaultCalcState();
    postToCalc({
      source: 'studyplanner',
      type: 'calc-state',
      sessionKey: currentCalcSessionKey(),
      state: sanitizeCalcState(stored)
    });
  }

  function syncCalcDeepLink() {
    if (deepLinkSent) return;
    var params;
    try { params = new URLSearchParams(window.location.search); } catch (error) { return; }
    if (params.get('open') !== 'calc') return;
    var presetId = safeText(params.get('preset'), 80);
    if (!presetId) return;
    deepLinkSent = true;
    postToCalc({ source: 'studyplanner', type: 'start-preset', presetId: presetId });
  }

  function clearCalcDeepLink() {
    try {
      var url = new URL(window.location.href);
      url.searchParams.delete('open');
      url.searchParams.delete('preset');
      window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    } catch (error) {}
  }

  function postPresetSendResult(frame, presetId, requestId, sessionKey, result) {
    if (!frame || !frame.contentWindow) return;
    frame.contentWindow.postMessage({
      source: 'studyplanner',
      type: 'preset-send-result',
      presetId: presetId,
      requestId: requestId,
      sessionKey: sessionKey,
      ok: result.ok === true,
      retrySameRequest: result.retrySameRequest === true,
      error: result.ok === true ? '' : safeText(result.error || 'Could not send. Try again.', 180)
    }, window.location.origin);
  }

  async function handleCalcMessage(event) {
    var frame = calcFrame();
    if (!frame || event.origin !== window.location.origin || event.source !== frame.contentWindow) return;
    var data = event.data;
    if (!data || data.source !== 'calc-practice') return;
    if (data.type === 'deep-link-consumed') {
      clearCalcDeepLink();
      return;
    }
    if (data.type === 'state-request') {
      syncCalcState();
      return;
    }
    if (data.type === 'mascot-feedback') {
      var outcome = data.outcome === 'correct' ? 'correct' : (data.outcome === 'wrong' ? 'wrong' : '');
      var feedbackKey = typeof data.key === 'string' ? data.key.slice(0, 140) : '';
      if (!outcome || !feedbackKey) return;
      try {
        window.dispatchEvent(new CustomEvent('examzen:mascot', { detail: {
          kind: 'feedback', outcome: outcome,
          key: 'calc:' + feedbackKey,
          message: outcome === 'correct' ? 'Correct calculation!' : 'Try that calculation again'
        }}));
      } catch (e) {}
      return;
    }
    if (data.type === 'preset-send-request') {
      var presetId = typeof data.presetId === 'string' ? data.presetId : '';
      var requestId = typeof data.requestId === 'string' ? data.requestId : '';
      var requestSessionKey = typeof data.sessionKey === 'string' ? data.sessionKey : '';
      var activeSessionKey = currentCalcSessionKey();
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(presetId) ||
          !/^[A-Za-z0-9][A-Za-z0-9_-]{7,99}$/.test(requestId) ||
          !/^[A-Za-z0-9-]{12,100}$/.test(requestSessionKey) ||
          requestSessionKey !== activeSessionKey) {
        postPresetSendResult(frame, presetId.slice(0, 80), requestId.slice(0, 100), requestSessionKey.slice(0, 100), { ok: false, error: 'This account session changed. Reload and try again.' });
        if (requestSessionKey !== activeSessionKey) syncCalcState();
        return;
      }
      var requestUid = (typeof currentUser !== 'undefined' && currentUser && currentUser.uid) ? String(currentUser.uid) : '';
      try {
        if (typeof appState === 'undefined' || !appState) throw new Error('Calculation presets are not ready yet.');
        var currentCalcState = sanitizeCalcState(appState.calculationPractice || defaultCalcState());
        var requestedPreset = currentCalcState.presets.find(function (preset) { return preset.id === presetId; });
        if (!requestedPreset) {
          throw new Error('Save this preset before sending it to Telegram.');
        }
        if (navigator.onLine === false) throw new Error('You are offline. Reconnect before sending.');
        if (!requestUid) throw new Error('Sign in before sending to Telegram.');
        if (typeof saveProgressNow !== 'function') throw new Error('Cloud sync is not ready yet.');
        await saveProgressNow();
        if (navigator.onLine === false) {
          throw new Error('You are offline. Reconnect before sending.');
        }
        var latestCalcState = sanitizeCalcState(appState.calculationPractice || defaultCalcState());
        requestedPreset = latestCalcState.presets.find(function (preset) { return preset.id === presetId; });
        if (!requestedPreset) throw new Error('This preset was deleted before it could be sent.');
        var presetFingerprint = await calculationPresetFingerprint(requestedPreset);
        if (typeof currentUser === 'undefined' || !currentUser || String(currentUser.uid || '') !== requestUid || currentCalcSessionKey() !== requestSessionKey) {
          syncCalcState();
          throw new Error('Your signed-in account changed. Send again from the current account.');
        }
        if (typeof sendCalculationPresetNow !== 'function') throw new Error('Telegram delivery is not ready. Reload and try again.');
        await sendCalculationPresetNow(presetId, requestId, requestUid, presetFingerprint);
        postPresetSendResult(frame, presetId, requestId, requestSessionKey, { ok: true });
      } catch (error) {
        postPresetSendResult(frame, presetId, requestId, requestSessionKey, {
          ok: false,
          retrySameRequest: !!(error && error.retrySameRequest),
          error: error && error.message ? error.message : 'Could not send. Try again.'
        });
      }
      return;
    }
    if (data.type !== 'state-save') return;
    var saveSessionKey = typeof data.sessionKey === 'string' ? data.sessionKey : '';
    if (!/^[A-Za-z0-9-]{12,100}$/.test(saveSessionKey) || saveSessionKey !== currentCalcSessionKey()) {
      syncCalcState();
      return;
    }
    var nextState = sanitizeCalcState(data.state);
    if (typeof appState === 'undefined' || !appState) return;
    var previous = JSON.stringify(appState.calculationPractice || defaultCalcState());
    var next = JSON.stringify(nextState);
    if (previous === next) return;
    appState.calculationPractice = nextState;
    if (typeof saveProgress === 'function') saveProgress();
  }

  function loadCalc() {
    var frame = calcFrame();
    var loading = document.getElementById('cp-loading');
    if (!frame) return;
    if (loaded) {
      syncCalcTheme();
      syncCalcState();
      return;
    }
    loaded = true;
    frame.addEventListener('load', function () {
      if (loading) loading.style.display = 'none';
      syncCalcTheme();
      syncCalcState();
      setTimeout(syncCalcDeepLink, 0);
    });
    /* Bumped whenever calc/index.html changes, or the iframe keeps serving the
       cached copy — v9 splits Writing Table rows into two compact sections. */
    frame.src = 'calc/index.html?v=9';
  }

  /* Lets other modules refresh the embedded practice tab, e.g. after Telegram
     Mini App results are merged into history. */
  window.ezSyncCalcState = syncCalcState;

  if (typeof onPageActivated === 'function') onPageActivated('calc', loadCalc);
  window.addEventListener('ez-theme-change', syncCalcTheme);
  window.addEventListener('message', handleCalcMessage);

  // If Calculation Practice is the restored active page, start loading right away.
  if (document.getElementById('page-calc') &&
      document.getElementById('page-calc').classList.contains('active')) {
    loadCalc();
  }
})();
