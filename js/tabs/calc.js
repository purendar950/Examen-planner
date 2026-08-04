/* ══════════════════════════════════════════════
   CALCULATION PRACTICE TAB
   Lazy-loads calc/index.html, synchronizes the app theme, and persists
   editable presets/results through the authenticated appState.
══════════════════════════════════════════════ */
(function () {
  var loaded = false;
  var deepLinkSent = false;
  var VALID_QUIZ_IDS = new Set([
    'addition', 'subtraction', 'mult1', 'mult2', 'mult3', 'squares', 'sqroots', 'cubes', 'cuberoots', 'higherpow',
    'pctfrac', 'pctnum', 'trig', 'pyth', 'ci_si', 'ci_ci', 'primeinrange', 'isprime', 'astr1', 'astr2', 'arev1', 'arev2'
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

  function sanitizePreset(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var validDifficulties = ['easy', 'standard', 'exam', 'custom'];
    var validTimers = [0, 3, 5, 10, 15];
    var quizIds = Array.isArray(raw.quizIds)
      ? raw.quizIds.map(function (id) { return safeText(id, 32); }).filter(function (id) { return VALID_QUIZ_IDS.has(id); }).slice(0, VALID_QUIZ_IDS.size)
      : [];
    var days = Array.isArray(raw.days)
      ? raw.days.map(Number).filter(function (day) { return Number.isInteger(day) && day >= 0 && day <= 6; }).slice(0, 7)
      : [];
    var settings = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
    var rawWeights = raw.weights && typeof raw.weights === 'object' ? raw.weights : {};
    var weights = {};
    Array.from(new Set(quizIds)).forEach(function (id) { weights[id] = clampNumber(rawWeights[id], 1, 10, 1); });
    var rawReminder = raw.reminder && typeof raw.reminder === 'object' ? raw.reminder : {};
    var leadOptions = [0, 5, 10, 15, 30, 60];
    var snoozeOptions = [5, 10, 15, 30, 60];
    var maxSnoozeOptions = [0, 1, 2, 3, 5];
    return {
      id: safeText(raw.id, 80),
      name: safeText(raw.name, 40) || 'My Practice',
      icon: safeText(raw.icon, 4) || '🧮',
      color: /^#[0-9a-f]{6}$/i.test(raw.color || '') ? raw.color : '#00C896',
      description: safeText(raw.description, 100),
      questionCount: clampNumber(raw.questionCount, 3, 50, 10),
      difficulty: validDifficulties.includes(raw.difficulty) ? raw.difficulty : 'standard',
      timerMinutes: validTimers.includes(Number(raw.timerMinutes)) ? Number(raw.timerMinutes) : 0,
      quizIds: Array.from(new Set(quizIds)),
      weights: weights,
      allowHints: raw.allowHints !== false,
      allowSkip: raw.allowSkip !== false,
      shuffle: raw.shuffle !== false,
      retryWrong: ['immediate', 'end', 'none'].includes(raw.retryWrong) ? raw.retryWrong : 'immediate',
      settings: {
        digits: clampNumber(settings.digits, 1, 4, 2),
        rangeMin: clampNumber(settings.rangeMin, 1, 100, 2),
        rangeMax: clampNumber(settings.rangeMax, 2, 100, 25),
        multFrom: clampNumber(settings.multFrom, 1, 100, 2),
        multTo: clampNumber(settings.multTo, 1, 100, 9),
        multiplierTo: clampNumber(settings.multiplierTo, 2, 100, 10),
        primeMax: clampNumber(settings.primeMax, 10, 300, 100),
        ciYears: clampNumber(settings.ciYears, 2, 5, 2)
      },
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
    presets = presets.filter(function (preset) {
      if (!preset.id || validIds.has(preset.id) || !preset.quizIds.length) return false;
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

  function syncCalcState() {
    var stored = (typeof appState !== 'undefined' && appState && appState.calculationPractice)
      ? appState.calculationPractice
      : defaultCalcState();
    postToCalc({
      source: 'studyplanner',
      type: 'calc-state',
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

  function handleCalcMessage(event) {
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
    if (data.type !== 'state-save') return;
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
    frame.src = 'calc/index.html';
  }

  if (typeof onPageActivated === 'function') onPageActivated('calc', loadCalc);
  window.addEventListener('ez-theme-change', syncCalcTheme);
  window.addEventListener('message', handleCalcMessage);

  // If Calculation Practice is the restored active page, start loading right away.
  if (document.getElementById('page-calc') &&
      document.getElementById('page-calc').classList.contains('active')) {
    loadCalc();
  }
})();
