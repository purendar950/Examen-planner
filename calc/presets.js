/* Editable Calculation Practice presets, finite sessions, results, and persistence. */
(function () {
  'use strict';

  var STORAGE_KEY = 'studyplanner_calculation_practice_v2';
  var LEGACY_STORAGE_KEY = 'studyplanner_calculation_practice_v1';
  var MAX_PRESETS = 30;
  var MAX_HISTORY = 60;
  var DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var editingPresetId = null;
  var editingTemplateId = null;
  var state;
  var activeSession = null;
  var lastResult = null;
  var timerHandle = null;
  var settingsBackup = null;
  var presetSendStates = Object.create(null);
  /* Ranges typed on a quick preset card, and the transient "added" confirmation,
     both keyed by template id. Neither is persisted. */
  var templateRangeDrafts = Object.create(null);
  var templateSaveStates = Object.create(null);
  var templateSaveTimer = null;
  /* Quick presets ticked for combining, and the result of the last combine. */
  var combineSelection = Object.create(null);
  var combineStatus = null;
  var parentSessionKey = '';
  /* Telegram Mini App mode: the practice is launched from a Telegram message
     and the account is proven by Telegram's signed initData, because Google
     sign-in cannot run inside an embedded webview. */
  var miniApp = { active: false, presetId: '', preset: null, tg: null, resultStatus: '', sdkPromise: null };

  var QUIZ_CHOICES = [
    ['addition', 'Addition'], ['subtraction', 'Subtraction'],
    ['mult1', 'Multiplication · Answer'], ['mult2', 'Multiplication · Missing factor'], ['mult3', 'Multiplication · Two factors'],
    ['tablewrite', 'Writing table'], ['mult2d', 'Two-digit multiplication'], ['mult3d', 'Three-digit multiplication'],
    ['squares', 'Squares'], ['sqroots', 'Square roots'], ['cubes', 'Cubes'], ['cuberoots', 'Cube roots'], ['higherpow', 'Higher powers'],
    ['pctfrac', 'Percentage → fraction'], ['pctnum', 'Percentage of a number'],
    ['trig', 'Trigonometric ratios'], ['pyth', 'Pythagorean triples'],
    ['ci_si', 'Simple interest %'], ['ci_ci', 'Compound interest %'],
    ['primeinrange', 'List primes in range'], ['isprime', 'Is it prime?'],
    ['astr1', 'Alphabet position'], ['astr2', 'Alphabet letter'], ['arev1', 'Reverse alphabet position'], ['arev2', 'Reverse alphabet letter']
  ];
  var VALID_QUIZ_IDS = new Set(QUIZ_CHOICES.map(function (entry) { return entry[0]; }));

  /* Which settings each question type actually reads. Normalized settings hold
     every key (unused ones carry difficulty fallbacks), so merging presets must
     consult this map or one preset's fallback would overwrite another's real
     range. Types absent from the map read no settings. */
  var QUIZ_SETTING_KEYS = {
    addition: ['digits'], subtraction: ['digits'],
    mult1: ['multFrom', 'multTo', 'multiplierFrom', 'multiplierTo'],
    mult2: ['multFrom', 'multTo', 'multiplierFrom', 'multiplierTo'],
    mult3: ['multFrom', 'multTo', 'multiplierFrom', 'multiplierTo'],
    tablewrite: ['multFrom', 'multTo', 'multiplierFrom', 'multiplierTo'],
    mult2d: ['mult2Min', 'mult2Max'],
    mult3d: ['mult3Min', 'mult3Max', 'mult3ByMin', 'mult3ByMax'],
    squares: ['sqMin', 'sqMax'], sqroots: ['sqMin', 'sqMax'],
    cubes: ['cubeMin', 'cubeMax'], cuberoots: ['cubeMin', 'cubeMax'],
    primeinrange: ['primeMax'], isprime: ['primeMax'],
    ci_si: ['ciYears'], ci_ci: ['ciYears']
  };
  /* The lower end of a range pair. When two presets both own a key, ranges are
     widened rather than one silently winning: lows take the minimum, everything
     else takes the maximum. */
  var COMBINE_LOW_KEYS = {
    multFrom: true, multiplierFrom: true, mult2Min: true, mult3Min: true,
    mult3ByMin: true, sqMin: true, cubeMin: true
  };
  function settingKeysFor(quizIds) {
    var keys = [];
    (quizIds || []).forEach(function (id) {
      (QUIZ_SETTING_KEYS[id] || []).forEach(function (key) {
        if (keys.indexOf(key) < 0) keys.push(key);
      });
    });
    return keys;
  }

  /* Ready-made presets shown on the dashboard. `rangeFields` are rendered as
     inputs on the card itself, so the range is chosen before starting without
     having to save a copy first. */
  var TEMPLATE_PRESETS = [
    {
      id: 'template-writing-table', name: 'Writing Table', icon: '🧮', color: '#00C896',
      description: 'Write out a full table, row by row.', questionCount: 5, difficulty: 'custom', timerMinutes: 0,
      quizIds: ['tablewrite'], allowHints: true, allowSkip: true, shuffle: true,
      settings: { multFrom: 2, multTo: 12, multiplierFrom: 1, multiplierTo: 10 },
      rangeFields: [
        { key: 'multFrom', label: 'Tables from', min: 1, max: 100 },
        { key: 'multTo', label: 'Tables to', min: 1, max: 100 }
      ]
    },
    {
      id: 'template-two-digit-mult', name: 'Two-Digit Multiplication', icon: '⚡', color: '#F59E0B',
      description: 'Multiply any two two-digit numbers.', questionCount: 10, difficulty: 'custom', timerMinutes: 0,
      quizIds: ['mult2d'], allowHints: true, allowSkip: true, shuffle: true,
      settings: { mult2Min: 10, mult2Max: 99 },
      rangeFields: [
        { key: 'mult2Min', label: 'From', min: 10, max: 99 },
        { key: 'mult2Max', label: 'To', min: 10, max: 99 }
      ]
    },
    {
      id: 'template-three-digit-mult', name: 'Three-Digit Multiplication', icon: '📈', color: '#3B82F6',
      description: 'Multiply a three-digit number.', questionCount: 10, difficulty: 'custom', timerMinutes: 0,
      quizIds: ['mult3d'], allowHints: true, allowSkip: true, shuffle: true,
      settings: { mult3Min: 100, mult3Max: 999, mult3ByMin: 100, mult3ByMax: 999 },
      rangeFields: [
        { key: 'mult3Min', label: 'From', min: 100, max: 999 },
        { key: 'mult3Max', label: 'To', min: 100, max: 999 },
        { key: 'mult3ByMin', label: 'By from', min: 2, max: 999 },
        { key: 'mult3ByMax', label: 'By to', min: 2, max: 999 }
      ]
    },
    {
      id: 'template-squares', name: 'Squares', icon: '🏆', color: '#A855F7',
      description: 'Squares across your own base range.', questionCount: 10, difficulty: 'custom', timerMinutes: 0,
      quizIds: ['squares'], allowHints: true, allowSkip: true, shuffle: true,
      settings: { sqMin: 2, sqMax: 30 },
      rangeFields: [
        { key: 'sqMin', label: 'Base from', min: 1, max: 100 },
        { key: 'sqMax', label: 'Base to', min: 1, max: 100 }
      ]
    },
    {
      id: 'template-cubes', name: 'Cubes', icon: '🎲', color: '#8B5CF6',
      description: 'Cubes across your own base range.', questionCount: 10, difficulty: 'custom', timerMinutes: 0,
      quizIds: ['cubes'], allowHints: true, allowSkip: true, shuffle: true,
      settings: { cubeMin: 2, cubeMax: 15 },
      rangeFields: [
        { key: 'cubeMin', label: 'Base from', min: 1, max: 100 },
        { key: 'cubeMax', label: 'Base to', min: 1, max: 100 }
      ]
    },
    {
      id: 'template-compound-interest-3y', name: 'Compound Interest · 3 Years', icon: '📈', color: '#14B8A6',
      description: 'SI % and CI % for a three-year rate.', questionCount: 10, difficulty: 'custom', timerMinutes: 0,
      quizIds: ['ci_si', 'ci_ci'], allowHints: true, allowSkip: true, shuffle: true,
      settings: { ciYears: 3 }
    },
    {
      id: 'template-fraction-form', name: 'Fraction Form', icon: '🎯', color: '#EF476F',
      description: 'Turn a percentage into its fraction.', questionCount: 10, difficulty: 'standard', timerMinutes: 0,
      quizIds: ['pctfrac'], allowHints: true, allowSkip: true, shuffle: true
    },
    {
      id: 'template-pythagorean-triples', name: 'Pythagorean Triples', icon: '🧠', color: '#3B82F6',
      description: 'Recall the missing side of a triple.', questionCount: 10, difficulty: 'standard', timerMinutes: 0,
      quizIds: ['pyth'], allowHints: true, allowSkip: true, shuffle: true
    }
  ].map(function (template) {
    /* normalizePreset only keeps known preset keys, so the card metadata is
       re-attached afterwards. */
    var preset = normalizePreset(template, true);
    preset.rangeFields = Array.isArray(template.rangeFields) ? template.rangeFields : [];
    return preset;
  });

  state = loadLocalState();

  function element(id) { return document.getElementById(id); }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function clamp(value, min, max, fallback) {
    var number = Number(value);
    if (!Number.isFinite(number)) number = fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
  }
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>'"]/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char];
    });
  }
  function uniqueId(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }
  function localDateKey(date) {
    var d = date || new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function formatDuration(seconds) {
    var total = Math.max(0, Math.round(Number(seconds) || 0));
    var mins = Math.floor(total / 60);
    var secs = total % 60;
    return mins ? mins + 'm ' + secs + 's' : secs + 's';
  }
  function formatTimeLabel(time) {
    if (!/^\d{2}:\d{2}$/.test(time || '')) return 'Any time';
    var parts = time.split(':');
    var hour = Number(parts[0]);
    var suffix = hour >= 12 ? 'PM' : 'AM';
    var display = hour % 12 || 12;
    return display + ':' + parts[1] + ' ' + suffix;
  }
  function quizLabel(id) {
    var found = QUIZ_CHOICES.find(function (entry) { return entry[0] === id; });
    return found ? found[1] : id;
  }

  /* Squares/square roots and cubes/cube roots keep separate base ranges: cubes
     grow far faster, so a range that suits squares is punishing for cubes. It
     also means combining a squares preset with a cubes preset cannot force one
     of them onto the other's range. */
  function difficultySettings(level) {
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

  function normalizeSettings(raw, difficulty) {
    var fallback = difficultySettings(difficulty === 'custom' ? 'standard' : difficulty);
    raw = raw && typeof raw === 'object' ? raw : {};
    var multFrom = clamp(raw.multFrom, 1, 100, fallback.multFrom);
    var multTo = clamp(raw.multTo, 1, 100, fallback.multTo);
    if (multTo < multFrom) { var multSwap = multFrom; multFrom = multTo; multTo = multSwap; }
    var multiplierFrom = clamp(raw.multiplierFrom, 1, 100, fallback.multiplierFrom);
    var multiplierTo = clamp(raw.multiplierTo, 1, 100, fallback.multiplierTo);
    if (multiplierTo < multiplierFrom) { var multiplierSwap = multiplierFrom; multiplierFrom = multiplierTo; multiplierTo = multiplierSwap; }
    var orderedPair = function (rawLow, rawHigh, min, max, fallbackLow, fallbackHigh) {
      var low = clamp(rawLow, min, max, fallbackLow);
      var high = clamp(rawHigh, min, max, fallbackHigh);
      return high < low ? [high, low] : [low, high];
    };
    var twoDigit = orderedPair(raw.mult2Min, raw.mult2Max, 10, 99, fallback.mult2Min, fallback.mult2Max);
    var threeDigit = orderedPair(raw.mult3Min, raw.mult3Max, 100, 999, fallback.mult3Min, fallback.mult3Max);
    var threeDigitBy = orderedPair(raw.mult3ByMin, raw.mult3ByMax, 2, 999, fallback.mult3ByMin, fallback.mult3ByMax);
    /* Presets saved before the split carry a single rangeMin/rangeMax, which
       seeds both base ranges so existing presets keep behaving the same. */
    var legacyLow = raw.sqMin == null && raw.cubeMin == null ? raw.rangeMin : null;
    var legacyHigh = raw.sqMax == null && raw.cubeMax == null ? raw.rangeMax : null;
    var squareBase = orderedPair(
      raw.sqMin != null ? raw.sqMin : legacyLow, raw.sqMax != null ? raw.sqMax : legacyHigh,
      1, 100, fallback.sqMin, fallback.sqMax);
    var cubeBase = orderedPair(
      raw.cubeMin != null ? raw.cubeMin : legacyLow, raw.cubeMax != null ? raw.cubeMax : legacyHigh,
      1, 100, fallback.cubeMin, fallback.cubeMax);
    return {
      digits: clamp(raw.digits, 1, 4, fallback.digits),
      sqMin: squareBase[0],
      sqMax: squareBase[1],
      cubeMin: cubeBase[0],
      cubeMax: cubeBase[1],
      multFrom: multFrom,
      multTo: multTo,
      multiplierFrom: multiplierFrom,
      multiplierTo: multiplierTo,
      mult2Min: twoDigit[0],
      mult2Max: twoDigit[1],
      mult3Min: threeDigit[0],
      mult3Max: threeDigit[1],
      mult3ByMin: threeDigitBy[0],
      mult3ByMax: threeDigitBy[1],
      primeMax: clamp(raw.primeMax, 10, 300, fallback.primeMax),
      ciYears: clamp(raw.ciYears, 2, 5, fallback.ciYears)
    };
  }

  function validTime(value) {
    if (!/^\d{2}:\d{2}$/.test(value || '')) return false;
    var parts = value.split(':').map(Number);
    return parts[0] >= 0 && parts[0] <= 23 && parts[1] >= 0 && parts[1] <= 59;
  }

  function normalizeWeights(raw, quizIds) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var weights = {};
    quizIds.forEach(function (id) { weights[id] = clamp(raw[id], 1, 10, 1); });
    return weights;
  }

  function normalizeReminder(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var leadOptions = [0, 5, 10, 15, 30, 60];
    var snoozeOptions = [5, 10, 15, 30, 60];
    var maxOptions = [0, 1, 2, 3, 5];
    return {
      telegramEnabled: raw.telegramEnabled === true,
      reminderMinutes: leadOptions.includes(Number(raw.reminderMinutes)) ? Number(raw.reminderMinutes) : 0,
      snoozeMinutes: snoozeOptions.includes(Number(raw.snoozeMinutes)) ? Number(raw.snoozeMinutes) : 10,
      maxSnoozes: maxOptions.includes(Number(raw.maxSnoozes)) ? Number(raw.maxSnoozes) : 2
    };
  }

  function normalizePreset(raw, template) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var difficulty = ['easy', 'standard', 'exam', 'custom'].includes(raw.difficulty) ? raw.difficulty : 'standard';
    var quizIds = Array.isArray(raw.quizIds) ? raw.quizIds.filter(function (id) { return VALID_QUIZ_IDS.has(id); }) : [];
    quizIds = Array.from(new Set(quizIds)).slice(0, VALID_QUIZ_IDS.size);
    if (!quizIds.length) quizIds = ['addition', 'subtraction', 'mult1'];
    var days = Array.isArray(raw.days) ? raw.days.map(Number).filter(function (day) { return day >= 0 && day <= 6; }) : [1, 2, 3, 4, 5, 6, 0];
    days = Array.from(new Set(days));
    if (!days.length) days = [1, 2, 3, 4, 5, 6, 0];
    return {
      id: String(raw.id || uniqueId(template ? 'template' : 'preset')).slice(0, 80),
      name: String(raw.name || 'My Practice').trim().slice(0, 40) || 'My Practice',
      icon: String(raw.icon || '🧮').slice(0, 4),
      color: /^#[0-9a-f]{6}$/i.test(raw.color || '') ? raw.color : '#00C896',
      description: String(raw.description || '').trim().slice(0, 100),
      questionCount: clamp(raw.questionCount, 3, 50, 10),
      difficulty: difficulty,
      timerMinutes: [0, 3, 5, 10, 15].includes(Number(raw.timerMinutes)) ? Number(raw.timerMinutes) : 0,
      quizIds: quizIds,
      weights: normalizeWeights(raw.weights, quizIds),
      allowHints: raw.allowHints !== false,
      allowSkip: raw.allowSkip !== false,
      shuffle: raw.shuffle !== false,
      retryWrong: ['immediate', 'end', 'none'].includes(raw.retryWrong) ? raw.retryWrong : 'immediate',
      settings: normalizeSettings(raw.settings, difficulty),
      dailyEnabled: raw.dailyEnabled === true,
      dailyTime: validTime(raw.dailyTime) ? raw.dailyTime : '07:00',
      days: days,
      reminder: normalizeReminder(raw.reminder),
      sourceTemplateId: raw.sourceTemplateId ? String(raw.sourceTemplateId).slice(0, 80) : (template ? String(raw.id || '') : ''),
      createdAt: raw.createdAt || new Date().toISOString(),
      updatedAt: raw.updatedAt || new Date().toISOString()
    };
  }

  function defaultState() {
    return { version: 2, presets: [], dailyPresetId: '', history: [] };
  }
  function normalizeHistory(entry) {
    entry = entry && typeof entry === 'object' ? entry : {};
    return {
      id: String(entry.id || uniqueId('attempt')).slice(0, 80),
      presetId: String(entry.presetId || '').slice(0, 80),
      presetName: String(entry.presetName || 'Practice').slice(0, 40),
      date: /^\d{4}-\d{2}-\d{2}$/.test(entry.date || '') ? entry.date : localDateKey(),
      completedAt: entry.completedAt || new Date().toISOString(),
      total: clamp(entry.total, 1, 50, 10),
      answered: clamp(entry.answered, 0, 50, 0),
      firstTryCorrect: clamp(entry.firstTryCorrect, 0, 50, 0),
      wrongAttempts: clamp(entry.wrongAttempts, 0, 500, 0),
      hintsUsed: clamp(entry.hintsUsed, 0, 50, 0),
      skipped: clamp(entry.skipped, 0, 50, 0),
      durationSec: clamp(entry.durationSec, 0, 86400, 0),
      reason: ['completed', 'time'].includes(entry.reason) ? entry.reason : 'completed',
      mistakeQuizIds: Array.isArray(entry.mistakeQuizIds) ? entry.mistakeQuizIds.filter(function (id) { return VALID_QUIZ_IDS.has(id); }).slice(0, 20) : [],
      presetSnapshot: entry.presetSnapshot ? normalizePreset(entry.presetSnapshot, false) : null
    };
  }
  function migrateState(raw) {
    raw = raw && typeof raw === 'object' ? clone(raw) : {};
    if (Number(raw.version) >= 2) return raw;
    var migratePreset = function (preset) {
      preset = preset && typeof preset === 'object' ? preset : {};
      var quizIds = Array.isArray(preset.quizIds) ? preset.quizIds : [];
      if (!preset.weights || typeof preset.weights !== 'object') {
        preset.weights = {};
        quizIds.forEach(function (id) { preset.weights[id] = 1; });
      }
      if (!['immediate', 'end', 'none'].includes(preset.retryWrong)) preset.retryWrong = 'immediate';
      if (!preset.reminder || typeof preset.reminder !== 'object') {
        preset.reminder = { telegramEnabled: false, reminderMinutes: 0, snoozeMinutes: 10, maxSnoozes: 2 };
      }
      return preset;
    };
    raw.presets = Array.isArray(raw.presets) ? raw.presets.map(migratePreset) : [];
    if (Array.isArray(raw.history)) {
      raw.history.forEach(function (entry) {
        if (entry && entry.presetSnapshot) entry.presetSnapshot = migratePreset(entry.presetSnapshot);
      });
    }
    raw.version = 2;
    return raw;
  }
  function normalizeState(raw) {
    raw = migrateState(raw);
    var presets = Array.isArray(raw.presets) ? raw.presets.map(function (preset) { return normalizePreset(preset, false); }).slice(0, MAX_PRESETS) : [];
    var ids = new Set();
    presets = presets.filter(function (preset) {
      if (ids.has(preset.id)) return false;
      ids.add(preset.id);
      return true;
    });
    var dailyPresetId = presets.some(function (preset) { return preset.id === raw.dailyPresetId; }) ? raw.dailyPresetId : '';
    presets.forEach(function (preset) { preset.dailyEnabled = preset.id === dailyPresetId; });
    var history = Array.isArray(raw.history) ? raw.history.map(normalizeHistory).slice(0, MAX_HISTORY) : [];
    return { version: 2, presets: presets, dailyPresetId: dailyPresetId, history: history };
  }
  function loadLocalState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
      var migrated = raw ? normalizeState(JSON.parse(raw)) : defaultState();
      if (raw) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      }
      return migrated;
    } catch (error) {
      return defaultState();
    }
  }
  function sendToParent(type, payload) {
    if (window.parent === window || window.location.origin === 'null') return false;
    try {
      window.parent.postMessage(Object.assign({ source: 'calc-practice', type: type }, payload || {}), window.location.origin);
      return true;
    } catch (error) { return false; }
  }
  function persistState() {
    state = normalizeState(state);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (error) {}
    sendToParent('state-save', { state: state, sessionKey: parentSessionKey });
    renderDashboard();
  }

  function applyPresetSettings(preset) {
    settingsBackup = clone(catSettings);
    var values = preset.settings;
    catSettings.addsub = { digits: values.digits };
    catSettings.multtables = { f1: values.multFrom, f2: values.multTo, t1: values.multiplierFrom, t2: values.multiplierTo };
    catSettings.mult2d = { r1: values.mult2Min, r2: values.mult2Max };
    catSettings.mult3d = { f1: values.mult3Min, f2: values.mult3Max, t1: values.mult3ByMin, t2: values.mult3ByMax };
    catSettings.squares = { r1: values.sqMin, r2: values.sqMax };
    catSettings.sqroots = { r1: values.sqMin, r2: values.sqMax };
    catSettings.cubes = { r1: values.cubeMin, r2: values.cubeMax };
    catSettings.cuberoots = { r1: values.cubeMin, r2: values.cubeMax };
    catSettings.compoundint = { years: values.ciYears };
    catSettings.primes = { r1: 1, r2: values.primeMax };
  }
  function restoreCategorySettings() {
    if (!settingsBackup) return;
    Object.keys(settingsBackup).forEach(function (key) { catSettings[key] = settingsBackup[key]; });
    settingsBackup = null;
  }
  function shuffle(items) {
    for (var index = items.length - 1; index > 0; index--) {
      var swapIndex = Math.floor(Math.random() * (index + 1));
      var value = items[index]; items[index] = items[swapIndex]; items[swapIndex] = value;
    }
    return items;
  }
  function buildQueue(preset) {
    var ids = preset.quizIds.slice();
    var totalWeight = ids.reduce(function (sum, id) { return sum + preset.weights[id]; }, 0);
    var allocation = ids.map(function (id, order) {
      var exact = preset.questionCount * preset.weights[id] / totalWeight;
      return { id: id, count: Math.floor(exact), remainder: exact - Math.floor(exact), order: order };
    });
    var assigned = allocation.reduce(function (sum, item) { return sum + item.count; }, 0);
    allocation.slice().sort(function (left, right) {
      return right.remainder - left.remainder || left.order - right.order;
    }).slice(0, preset.questionCount - assigned).forEach(function (item) { item.count++; });
    var queue = [];
    while (queue.length < preset.questionCount) {
      var added = false;
      allocation.forEach(function (item) {
        if (item.count > 0) { queue.push({ quizId: item.id, question: null, isReview: false }); item.count--; added = true; }
      });
      if (!added) break;
    }
    return preset.shuffle ? shuffle(queue) : queue;
  }

  function startPreset(preset) {
    if (!preset) return;
    if (activeSession) stopSession(false);
    preset = normalizePreset(clone(preset), false);
    applyPresetSettings(preset);
    activeSession = {
      preset: preset,
      queue: buildQueue(preset),
      originalQuestionCount: preset.questionCount,
      index: 0,
      answered: 0,
      firstTryCorrect: 0,
      wrongAttempts: 0,
      hintsUsed: 0,
      skipped: 0,
      questionHadWrong: false,
      questionUsedHint: false,
      mistakeQuizIds: new Set(),
      startedAt: Date.now(),
      deadline: preset.timerMinutes ? Date.now() + preset.timerMinutes * 60000 : 0
    };
    updateSessionChrome();
    startTimer();
    openQuiz(activeSession.queue[0].quizId, 'home', { preset: true });
  }

  function stopSession(renderHomeAfter) {
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
    restoreCategorySettings();
    activeSession = null;
    updateSessionChrome();
    if (renderHomeAfter) { renderDashboard(); show('home'); }
  }
  function requestExitSession() {
    if (!activeSession) return false;
    if (!window.confirm('Exit this practice session? Current progress will not be saved.')) return true;
    stopSession(true);
    return true;
  }
  function nextQuizId() {
    if (!activeSession) return '';
    var entry = activeSession.queue[activeSession.index];
    return entry ? entry.quizId : '';
  }
  function questionSnapshot() {
    if (!activeSession) return null;
    var entry = activeSession.queue[activeSession.index];
    return entry && entry.question ? clone(entry.question) : null;
  }
  function questionNumber() { return activeSession ? activeSession.index + 1 : 0; }
  function onQuestionStarted(quizId, question) {
    if (!activeSession) return;
    activeSession.currentQuestion = clone(question);
    activeSession.questionHadWrong = false;
    activeSession.questionUsedHint = false;
    updateSessionChrome();
  }
  function onWrong() {
    if (!activeSession) return null;
    var firstWrong = !activeSession.questionHadWrong;
    var entry = activeSession.queue[activeSession.index];
    activeSession.questionHadWrong = true;
    activeSession.wrongAttempts++;
    activeSession.mistakeQuizIds.add(entry.quizId);
    if (activeSession.preset.retryWrong === 'end') {
      if (firstWrong && !entry.isReview) {
        activeSession.answered++;
        activeSession.queue.push({ quizId: entry.quizId, question: clone(activeSession.currentQuestion), isReview: true });
      }
      return { advance: true, message: entry.isReview ? 'Review recorded — moving on' : 'This question will return at the end' };
    }
    if (activeSession.preset.retryWrong === 'none') {
      if (firstWrong && !entry.isReview) activeSession.answered++;
      return { advance: true, message: 'Answer recorded — moving on' };
    }
    return null;
  }
  function onHint() {
    if (!activeSession) return true;
    if (!activeSession.preset.allowHints) {
      var feedback = element('feedback');
      if (feedback) feedback.innerHTML = '<span class="bad">Hints are disabled for this preset.</span>';
      return false;
    }
    if (!activeSession.questionUsedHint && !activeSession.queue[activeSession.index].isReview) activeSession.hintsUsed++;
    activeSession.questionUsedHint = true;
    activeSession.mistakeQuizIds.add(activeSession.queue[activeSession.index].quizId);
    return true;
  }
  function onCorrect() {
    if (!activeSession) return null;
    var entry = activeSession.queue[activeSession.index];
    if (!entry.isReview) {
      activeSession.answered++;
      if (!activeSession.questionHadWrong && !activeSession.questionUsedHint) activeSession.firstTryCorrect++;
    }
    return { firstTryCorrect: activeSession.firstTryCorrect };
  }
  function advanceAfterCorrect() {
    if (!activeSession) return;
    activeSession.index++;
    if (activeSession.index >= activeSession.queue.length) finishSession('completed');
    else nextQ();
  }
  function advanceAfterWrong() {
    if (!activeSession) return;
    activeSession.index++;
    if (activeSession.index >= activeSession.queue.length) finishSession('completed');
    else nextQ();
  }
  function skipQuestion() {
    if (!activeSession || busy || !activeSession.preset.allowSkip) return;
    var entry = activeSession.queue[activeSession.index];
    if (!entry.isReview) activeSession.skipped++;
    activeSession.mistakeQuizIds.add(entry.quizId);
    activeSession.index++;
    if (activeSession.index >= activeSession.queue.length) finishSession('completed');
    else nextQ();
  }

  function startTimer() {
    if (timerHandle) clearInterval(timerHandle);
    if (!activeSession || !activeSession.deadline) { updateTimer(); return; }
    timerHandle = setInterval(function () {
      if (!activeSession) return;
      updateTimer();
      if (Date.now() >= activeSession.deadline) finishSession('time');
    }, 500);
    updateTimer();
  }
  function updateTimer() {
    var timer = element('presetTimer');
    if (!timer) return;
    if (!activeSession || !activeSession.deadline) { timer.textContent = ''; return; }
    var remaining = Math.max(0, Math.ceil((activeSession.deadline - Date.now()) / 1000));
    timer.textContent = String(Math.floor(remaining / 60)).padStart(2, '0') + ':' + String(remaining % 60).padStart(2, '0');
  }
  function updateSessionChrome() {
    var meta = element('presetSessionMeta');
    var name = element('presetSessionName');
    var hint = element('hintbtn');
    var skip = element('skipbtn');
    if (!meta || !name || !hint || !skip) return;
    if (!activeSession) {
      meta.classList.remove('active');
      skip.classList.remove('active');
      hint.style.display = '';
      return;
    }
    meta.classList.add('active');
    name.textContent = activeSession.preset.name + ' · ' + (activeSession.index + 1) + '/' + activeSession.queue.length;
    hint.style.display = activeSession.preset.allowHints ? '' : 'none';
    skip.classList.toggle('active', activeSession.preset.allowSkip);
    updateTimer();
  }

  function finishSession(reason) {
    if (!activeSession) return;
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
    var session = activeSession;
    var result = normalizeHistory({
      id: uniqueId('attempt'),
      presetId: session.preset.id,
      presetName: session.preset.name,
      date: localDateKey(),
      completedAt: new Date().toISOString(),
      total: session.originalQuestionCount,
      answered: session.answered,
      firstTryCorrect: session.firstTryCorrect,
      wrongAttempts: session.wrongAttempts,
      hintsUsed: session.hintsUsed,
      skipped: session.skipped,
      durationSec: Math.round((Date.now() - session.startedAt) / 1000),
      reason: reason,
      mistakeQuizIds: Array.from(session.mistakeQuizIds),
      presetSnapshot: session.preset
    });
    lastResult = result;
    state.history.unshift(result);
    state.history = state.history.slice(0, MAX_HISTORY);
    restoreCategorySettings();
    activeSession = null;
    updateSessionChrome();
    persistState();
    miniApp.resultStatus = '';
    renderResult(result);
    show('presetResult');
    /* In Telegram the attempt is written server-side, since the Mini App has no
       authenticated app shell to persist through. */
    if (miniApp.active) submitMiniAppResult(result);
  }

  function accuracy(result) {
    return result.total ? Math.round(result.firstTryCorrect / result.total * 100) : 0;
  }
  function renderResult(result) {
    var card = element('presetResultCard');
    if (!card) return;
    var pct = accuracy(result);
    var heading = result.reason === 'time' ? 'Time is up' : (pct >= 80 ? 'Excellent work!' : pct >= 50 ? 'Practice complete' : 'Keep building speed');
    var mistakesAction = result.mistakeQuizIds.length ? '<button type="button" class="preset-btn" id="resultMistakesBtn">Practice mistakes</button>' : '';
    /* Inside Telegram there is no preset dashboard to go back to, so the last
       action closes the Mini App and the sync state is shown instead. */
    var closingAction = miniApp.active
      ? '<button type="button" class="preset-btn" id="resultCloseBtn">Close</button>'
      : '<button type="button" class="preset-btn" id="resultHomeBtn">Back to presets</button>';
    /* A failed sync must be recoverable: "Practice again" would discard the
       attempt, so offer an explicit retry of the submission itself. */
    var retrySyncAction = miniApp.active && miniApp.resultSyncFailed
      ? '<button type="button" class="preset-btn" id="resultRetrySyncBtn">Retry save</button>'
      : '';
    var syncNote = miniApp.active && miniApp.resultStatus
      ? '<p class="preset-muted" id="resultSyncNote" role="status">' + escapeHtml(miniApp.resultStatus) + '</p>'
      : '';
    card.innerHTML =
      '<div class="result-mark">' + (pct >= 80 ? '🏆' : pct >= 50 ? '🎯' : '📈') + '</div>' +
      '<h2>' + escapeHtml(heading) + '</h2>' +
      '<p>' + escapeHtml(result.presetName) + ' · ' + result.answered + ' answered of ' + result.total + '</p>' +
      '<div class="result-stats">' +
        '<div class="result-stat"><strong>' + result.firstTryCorrect + '/' + result.total + '</strong><span>First try</span></div>' +
        '<div class="result-stat"><strong>' + pct + '%</strong><span>Accuracy</span></div>' +
        '<div class="result-stat"><strong>' + result.wrongAttempts + '</strong><span>Retries</span></div>' +
        '<div class="result-stat"><strong>' + escapeHtml(formatDuration(result.durationSec)) + '</strong><span>Time</span></div>' +
      '</div>' +
      syncNote +
      '<div class="result-actions">' + retrySyncAction + '<button type="button" class="preset-btn primary" id="resultRepeatBtn">Practice again</button>' + mistakesAction + closingAction + '</div>';
    if (element('resultRetrySyncBtn')) {
      element('resultRetrySyncBtn').onclick = function () { submitMiniAppResult(result); };
    }
    element('resultRepeatBtn').onclick = function () {
      var repeat = result.presetSnapshot || miniApp.preset;
      if (repeat) startPreset(repeat);
    };
    if (element('resultCloseBtn')) element('resultCloseBtn').onclick = closeMiniApp;
    if (element('resultMistakesBtn')) element('resultMistakesBtn').onclick = function () {
      var retry = clone(result.presetSnapshot);
      retry.id = uniqueId('mistakes');
      retry.name = result.presetName + ' · Mistakes';
      retry.quizIds = result.mistakeQuizIds.slice();
      retry.questionCount = Math.min(20, Math.max(3, retry.quizIds.length * 3));
      retry.timerMinutes = 0;
      startPreset(retry);
    };
    if (element('resultHomeBtn')) element('resultHomeBtn').onclick = function () { renderDashboard(); show('home'); };
  }

  function getTemplate(id) { return TEMPLATE_PRESETS.find(function (preset) { return preset.id === id; }); }
  function getPreset(id) { return state.presets.find(function (preset) { return preset.id === id; }); }
  function presetTags(preset) {
    var values = preset.settings;
    var uses = function (ids) {
      return preset.quizIds.some(function (id) { return ids.indexOf(id) >= 0; });
    };
    var tags = [preset.questionCount + ' questions', preset.difficulty === 'exam' ? 'Exam' : preset.difficulty.charAt(0).toUpperCase() + preset.difficulty.slice(1)];
    if (preset.timerMinutes) tags.push(preset.timerMinutes + ' min');
    if (uses(['mult1', 'mult2', 'mult3', 'tablewrite'])) {
      tags.push(values.multFrom === values.multTo ? 'Table ' + values.multFrom : 'Tables ' + values.multFrom + '–' + values.multTo);
    }
    if (uses(['mult2d'])) tags.push('2-digit ' + values.mult2Min + '–' + values.mult2Max);
    if (uses(['mult3d'])) tags.push(values.mult3Min + '–' + values.mult3Max + ' × ' + values.mult3ByMin + '–' + values.mult3ByMax);
    if (uses(['squares', 'sqroots'])) tags.push('Sq base ' + values.sqMin + '–' + values.sqMax);
    if (uses(['cubes', 'cuberoots'])) tags.push('Cube base ' + values.cubeMin + '–' + values.cubeMax);
    if (uses(['ci_si', 'ci_ci'])) tags.push(values.ciYears + ' years');
    tags.push(preset.quizIds.length + (preset.quizIds.length === 1 ? ' type' : ' types'));
    return tags;
  }
  function presetSendPending(presetId) {
    return !!(presetSendStates[presetId] && presetSendStates[presetId].status === 'pending');
  }
  function requestPresetSend(presetId) {
    var preset = getPreset(presetId);
    var current = presetSendStates[presetId];
    if (!preset || presetSendPending(presetId)) return;
    var requestId = current && current.status === 'error' && current.retrySameRequest
      ? current.requestId
      : uniqueId('send');
    presetSendStates[presetId] = { status: 'pending', message: 'Sending…', requestId: requestId, retrySameRequest: false };
    renderPresetGrids();
    if (!sendToParent('preset-send-request', { presetId: presetId, requestId: requestId, sessionKey: parentSessionKey })) {
      presetSendStates[presetId] = { status: 'error', message: 'Open Calculation Practice inside StudyPlanner to send.', requestId: requestId, retrySameRequest: false };
      renderPresetGrids();
    }
  }
  function applyPresetSendResult(data) {
    var presetId = String(data.presetId || '').slice(0, 80);
    var requestId = String(data.requestId || '').slice(0, 100);
    var resultSessionKey = String(data.sessionKey || '').slice(0, 100);
    var current = presetSendStates[presetId];
    if (!current || current.requestId !== requestId || !parentSessionKey || resultSessionKey !== parentSessionKey) return;
    presetSendStates[presetId] = {
      status: data.ok === true ? 'success' : 'error',
      message: data.ok === true ? 'Sent ✓' : String(data.error || 'Could not send. Try again.').slice(0, 180),
      requestId: requestId,
      retrySameRequest: data.ok !== true && data.retrySameRequest === true
    };
    renderPresetGrids();
  }
  /* Range values typed into a template card, keyed by settings field. */
  function cardRangeValues(card, rangeFields) {
    var values = {};
    rangeFields.forEach(function (field) {
      var input = card.querySelector('[data-range-key="' + field.key + '"]');
      if (input) values[field.key] = clamp(input.value, field.min, field.max, field.min);
    });
    return values;
  }
  /* Saving or finishing a session re-renders the grid, which would rebuild the
     cards with their factory ranges. Remembering what was typed keeps the
     chosen range on screen. */
  function rememberCardRanges(templateId, card, rangeFields) {
    templateRangeDrafts[templateId] = cardRangeValues(card, rangeFields);
  }
  function cardRangeValue(preset, field) {
    var draft = templateRangeDrafts[preset.id];
    var raw = draft && draft[field.key] != null ? draft[field.key] : preset.settings[field.key];
    return clamp(raw, field.min, field.max, field.min);
  }
  function presetWithCardRanges(preset, card, rangeFields) {
    if (!rangeFields.length) return preset;
    var draft = clone(preset);
    delete draft.rangeFields;
    draft.settings = Object.assign({}, draft.settings, cardRangeValues(card, rangeFields));
    return normalizePreset(draft, false);
  }
  function uniquePresetName(name) {
    var taken = function (candidate) {
      return state.presets.some(function (preset) { return preset.name === candidate; });
    };
    if (!taken(name)) return name;
    for (var suffix = 2; suffix <= MAX_PRESETS + 1; suffix++) {
      var candidate = (name + ' ' + suffix).slice(0, 40);
      if (!taken(candidate)) return candidate;
    }
    return name;
  }
  /* One-click copy of a quick preset into My Presets, using the ranges currently
     shown on the card. */
  function saveTemplateAsPreset(preset, card, rangeFields) {
    if (state.presets.length >= MAX_PRESETS) {
      templateSaveStates[preset.id] = { status: 'error', message: 'Preset limit reached (' + MAX_PRESETS + '). Delete one first.' };
      renderPresetGrids();
      clearTemplateSaveStatesSoon();
      return;
    }
    var draft = clone(presetWithCardRanges(preset, card, rangeFields));
    delete draft.rangeFields;
    draft.id = uniqueId('preset');
    draft.sourceTemplateId = preset.id;
    draft.name = uniquePresetName(preset.name);
    draft.dailyEnabled = false;
    draft.reminder.telegramEnabled = false;
    draft.createdAt = draft.updatedAt = new Date().toISOString();
    state.presets.unshift(normalizePreset(draft, false));
    templateSaveStates[preset.id] = { status: 'success', message: 'Added to My Presets as “' + draft.name + '” ✓' };
    persistState();
    clearTemplateSaveStatesSoon();
  }
  /* Selection spans both grids, so a quick preset and a saved preset can be
     merged together. Kept in dashboard order so the merged name is predictable
     rather than depending on click order. */
  function combinablePresets() {
    return TEMPLATE_PRESETS.concat(state.presets);
  }
  function selectedTemplates() {
    return combinablePresets().filter(function (preset) { return combineSelection[preset.id]; });
  }
  function pruneCombineSelection() {
    var known = Object.create(null);
    combinablePresets().forEach(function (preset) { known[preset.id] = true; });
    Object.keys(combineSelection).forEach(function (id) {
      if (!known[id]) delete combineSelection[id];
    });
  }
  function combinedName(presets) {
    var joined = presets.map(function (preset) { return preset.name; }).join(' + ');
    return joined.length <= 40 ? joined : 'Mixed Practice (' + presets.length + ' presets)';
  }
  /* Merge two or more quick presets into a single preset: the question types are
     unioned and each preset contributes only the ranges it owns, so nothing gets
     overwritten. */
  function buildCombinedPreset(presets) {
    var settings = {};
    var quizIds = [];
    var questionCount = 0;
    var timerMinutes = 0;
    var weights = {};
    presets.forEach(function (preset) {
      var typed = templateRangeDrafts[preset.id] || {};
      settingKeysFor(preset.quizIds).forEach(function (key) {
        var value = typed[key] != null ? typed[key] : preset.settings[key];
        if (!(key in settings)) settings[key] = value;
        /* Two presets can legitimately own the same key (two saved presets that
           both practise squares). Widen to cover both instead of letting the
           later one win, which would make the result depend on click order. */
        else settings[key] = COMBINE_LOW_KEYS[key] ? Math.min(settings[key], value) : Math.max(settings[key], value);
      });
      preset.quizIds.forEach(function (id) {
        if (quizIds.indexOf(id) < 0) quizIds.push(id);
        var weight = preset.weights && preset.weights[id] ? preset.weights[id] : 1;
        weights[id] = Math.max(weights[id] || 1, weight);
      });
      questionCount += preset.questionCount;
      timerMinutes = Math.max(timerMinutes, preset.timerMinutes);
    });
    return normalizePreset({
      id: uniqueId('preset'),
      name: combinedName(presets),
      icon: presets[0].icon,
      color: presets[0].color,
      description: presets.map(function (preset) { return preset.name; }).join(', '),
      questionCount: Math.min(50, Math.max(3, questionCount)),
      difficulty: 'custom',
      timerMinutes: timerMinutes,
      quizIds: quizIds,
      weights: weights,
      /* A rule the sources agree on is kept; otherwise the stricter one wins. */
      allowHints: presets.every(function (preset) { return preset.allowHints; }),
      allowSkip: presets.every(function (preset) { return preset.allowSkip; }),
      shuffle: presets.every(function (preset) { return preset.shuffle; }),
      retryWrong: presets[0].retryWrong,
      settings: settings
    }, false);
  }
  /* Each section shows a bar only when it holds part of the selection, but the
     buttons always act on the whole selection. */
  function renderCombineBars() {
    renderCombineBar('quick', TEMPLATE_PRESETS);
    renderCombineBar('my', state.presets);
  }
  function renderCombineBar(prefix, sectionPresets) {
    var bar = element(prefix + 'CombineBar');
    if (!bar) return;
    var inSection = sectionPresets.some(function (preset) { return combineSelection[preset.id]; });
    bar.hidden = !inSection;
    if (!inSection) return;
    var presets = selectedTemplates();
    var enough = presets.length >= 2;
    var combined = enough ? buildCombinedPreset(presets) : null;
    element(prefix + 'CombineCount').textContent = presets.length === 1
      ? '1 preset selected'
      : presets.length + ' presets selected · ' + combinedName(presets);
    element(prefix + 'CombineDetail').textContent = enough
      ? combined.quizIds.length + (combined.quizIds.length === 1 ? ' question type · ' : ' question types · ') + combined.questionCount + ' questions'
      : 'Tick at least one more preset to combine.';
    element(prefix + 'CombineStart').disabled = !enough;
    element(prefix + 'CombineSave').disabled = !enough;
    var status = element(prefix + 'CombineStatus');
    status.textContent = combineStatus ? combineStatus.message : '';
    status.className = 'preset-send-status' + (combineStatus ? ' ' + combineStatus.status : '');
  }
  function startCombined() {
    var presets = selectedTemplates();
    if (presets.length < 2) return;
    startPreset(buildCombinedPreset(presets));
  }
  function saveCombined() {
    var presets = selectedTemplates();
    if (presets.length < 2) return;
    if (state.presets.length >= MAX_PRESETS) {
      combineStatus = { status: 'error', message: 'Preset limit reached (' + MAX_PRESETS + '). Delete one first.' };
      renderCombineBars();
      return;
    }
    var combined = buildCombinedPreset(presets);
    combined.name = uniquePresetName(combined.name);
    state.presets.unshift(combined);
    combineStatus = { status: 'success', message: 'Added to My Presets as “' + combined.name + '” ✓' };
    persistState();
  }
  function clearCombineSelection() {
    combineSelection = Object.create(null);
    combineStatus = null;
    renderPresetGrids();
  }
  function clearTemplateSaveStatesSoon() {
    if (templateSaveTimer) clearTimeout(templateSaveTimer);
    templateSaveTimer = setTimeout(function () {
      templateSaveTimer = null;
      templateSaveStates = Object.create(null);
      renderPresetGrids();
    }, 5000);
  }
  function createCard(preset, template) {
    var card = document.createElement('article');
    card.className = 'preset-card';
    card.style.setProperty('--preset-color', preset.color);
    var recent = state.history.find(function (entry) { return entry.presetId === preset.id; });
    var dailyBadge = state.dailyPresetId === preset.id ? '<span class="preset-badge">Daily</span>' : '';
    /* Lives in the wrapping actions row rather than the title row: a fixed-width
       control up there squeezed long preset names into a few pixels. */
    var combineMarkup = '<label class="preset-combine-toggle"><input type="checkbox" data-combine' +
      (combineSelection[preset.id] ? ' checked' : '') +
      ' aria-label="Select ' + escapeHtml(preset.name) + ' for combining"><span>Combine</span></label>';
    var rangeFields = template && Array.isArray(preset.rangeFields) ? preset.rangeFields : [];
    var rangeMarkup = rangeFields.length
      ? '<div class="preset-range-fields">' + rangeFields.map(function (field) {
        return '<label>' + escapeHtml(field.label) +
          '<input type="number" data-range-key="' + escapeHtml(field.key) + '" min="' + field.min + '" max="' + field.max +
          '" value="' + cardRangeValue(preset, field) + '"></label>';
      }).join('') + '</div>'
      : '';
    var tags = presetTags(preset).map(function (tag) { return '<span class="preset-tag">' + escapeHtml(tag) + '</span>'; }).join('');
    var sendState = presetSendStates[preset.id] || null;
    var sendPending = !!(sendState && sendState.status === 'pending');
    var pendingDisabled = sendPending ? ' disabled' : '';
    var saveState = template ? templateSaveStates[preset.id] : null;
    var sendStatus = !template && sendState
      ? '<span class="preset-send-status ' + escapeHtml(sendState.status) + '" data-send-status role="status">' + escapeHtml(sendState.message) + '</span>'
      : '';
    if (saveState) {
      sendStatus = '<span class="preset-send-status ' + escapeHtml(saveState.status) + '" role="status">' + escapeHtml(saveState.message) + '</span>';
    }
    var actions = template
      ? '<button type="button" class="preset-btn primary" data-action="start">Start</button><button type="button" class="preset-btn" data-action="save">+ Add to My Presets</button><button type="button" class="preset-btn" data-action="customize">Customize</button>'
      : '<button type="button" class="preset-btn primary" data-action="start">Start</button><button type="button" class="preset-btn" data-action="send"' + pendingDisabled + '>Send to Telegram</button><button type="button" class="preset-btn" data-action="edit"' + pendingDisabled + '>Edit</button><button type="button" class="preset-btn" data-action="duplicate">Duplicate</button><button type="button" class="preset-btn" data-action="schedule"' + pendingDisabled + '>Schedule</button><button type="button" class="preset-btn" data-action="reset"' + pendingDisabled + '>Reset</button><button type="button" class="preset-btn danger" data-action="delete"' + pendingDisabled + '>Delete</button>';
    card.innerHTML =
      '<div class="preset-card-top"><div class="preset-icon">' + escapeHtml(preset.icon) + '</div><div class="preset-card-title"><h3>' + escapeHtml(preset.name) + '</h3><p>' + escapeHtml(preset.description || (recent ? 'Last score ' + accuracy(recent) + '%' : 'Ready to practice')) + '</p></div>' + dailyBadge + '</div>' +
      '<div class="preset-tags">' + tags + '</div>' + rangeMarkup +
      '<div class="preset-actions">' + combineMarkup + actions + sendStatus + '</div>';
    card.querySelector('[data-action="start"]').onclick = function () {
      startPreset(presetWithCardRanges(preset, card, rangeFields));
    };
    if (combineSelection[preset.id]) card.classList.add('combine-selected');
    var combineToggle = card.querySelector('[data-combine]');
    if (combineToggle) {
      combineToggle.addEventListener('change', function () {
        if (combineToggle.checked) combineSelection[preset.id] = true;
        else delete combineSelection[preset.id];
        card.classList.toggle('combine-selected', combineToggle.checked);
        combineStatus = null;
        renderCombineBars();
      });
    }
    if (template) {
      rangeFields.forEach(function (field) {
        var input = card.querySelector('[data-range-key="' + field.key + '"]');
        if (input) input.addEventListener('input', function () { rememberCardRanges(preset.id, card, rangeFields); });
      });
      /* Save straight into My Presets with the ranges shown on the card. */
      card.querySelector('[data-action="save"]').onclick = function () {
        saveTemplateAsPreset(preset, card, rangeFields);
      };
      /* Carry the ranges typed on the card into the editor, so switching to a
         saved copy does not silently discard them. */
      card.querySelector('[data-action="customize"]').onclick = function () {
        openEditor(null, preset.id, false, cardRangeValues(card, rangeFields));
      };
    } else {
      card.querySelector('[data-action="send"]').onclick = function () { requestPresetSend(preset.id); };
      card.querySelector('[data-action="edit"]').onclick = function () { openEditor(preset.id); };
      card.querySelector('[data-action="duplicate"]').onclick = function () { duplicatePreset(preset.id); };
      card.querySelector('[data-action="schedule"]').onclick = function () { openSchedule(preset.id); };
      card.querySelector('[data-action="reset"]').onclick = function () { resetPreset(preset.id); };
      card.querySelector('[data-action="delete"]').onclick = function () { deletePreset(preset.id); };
    }
    return card;
  }

  function calculateStreak() {
    var dates = new Set(state.history.filter(function (entry) { return entry.reason === 'completed'; }).map(function (entry) { return entry.date; }));
    if (!dates.size) return 0;
    var cursor = new Date();
    if (!dates.has(localDateKey(cursor))) cursor.setDate(cursor.getDate() - 1);
    var streak = 0;
    while (dates.has(localDateKey(cursor))) { streak++; cursor.setDate(cursor.getDate() - 1); }
    return streak;
  }
  function renderDaily() {
    var container = element('presetDailyCard');
    if (!container) return;
    var preset = getPreset(state.dailyPresetId);
    if (!preset) {
      var recommended = TEMPLATE_PRESETS[0];
      container.innerHTML = '<div><div class="preset-eyebrow">Recommended daily practice</div><h2>' + escapeHtml(recommended.icon + ' ' + recommended.name) + '</h2><p class="preset-muted">' + escapeHtml(recommended.description + ' Pick a preset below to make it your own.') + '</p></div><div class="preset-actions"><button type="button" class="preset-btn primary" id="dailyStartRecommended">Start now</button><button type="button" class="preset-btn" id="dailyCustomizeRecommended">Customize</button></div>';
      element('dailyStartRecommended').onclick = function () { startPreset(recommended); };
      element('dailyCustomizeRecommended').onclick = function () { openEditor(null, recommended.id, true); };
      return;
    }
    var completedToday = state.history.some(function (entry) { return entry.presetId === preset.id && entry.date === localDateKey() && entry.reason === 'completed'; });
    var editDisabled = presetSendPending(preset.id) ? ' disabled' : '';
    var daysText = preset.days.length === 7 ? 'Every day' : preset.days.map(function (day) { return DAY_LABELS[day]; }).join(', ');
    container.innerHTML = '<div><div class="preset-eyebrow">' + (completedToday ? 'Completed today' : 'Your daily practice') + '</div><h2>' + escapeHtml(preset.icon + ' ' + preset.name) + '</h2><p class="preset-muted">' + escapeHtml(daysText + ' · ' + formatTimeLabel(preset.dailyTime) + ' · ' + preset.questionCount + ' questions') + '</p></div><div class="preset-actions"><button type="button" class="preset-btn primary" id="dailyStartBtn">' + (completedToday ? 'Practice again' : 'Start daily practice') + '</button><button type="button" class="preset-btn" id="dailyEditBtn"' + editDisabled + '>Edit</button></div>';
    element('dailyStartBtn').onclick = function () { startPreset(preset); };
    element('dailyEditBtn').onclick = function () { openEditor(preset.id); };
  }
  function renderSummary() {
    var container = element('presetSummary');
    if (!container) return;
    var sessions = state.history.length;
    var average = sessions ? Math.round(state.history.reduce(function (sum, entry) { return sum + accuracy(entry); }, 0) / sessions) : 0;
    container.innerHTML = '<div class="preset-stat"><strong>' + calculateStreak() + '</strong><span>Day streak</span></div><div class="preset-stat"><strong>' + sessions + '</strong><span>Sessions</span></div><div class="preset-stat"><strong>' + average + '%</strong><span>Avg accuracy</span></div>';
  }
  function renderPresetGrids() {
    pruneCombineSelection();
    var mine = element('myPresetGrid');
    var quick = element('quickPresetGrid');
    if (!mine || !quick) return;
    mine.innerHTML = '';
    if (!state.presets.length) mine.innerHTML = '<div class="preset-empty">No custom presets yet. Create one or customize a quick preset below.</div>';
    else state.presets.forEach(function (preset) { mine.appendChild(createCard(preset, false)); });
    quick.innerHTML = '';
    TEMPLATE_PRESETS.forEach(function (preset) { quick.appendChild(createCard(preset, true)); });
    renderCombineBars();
  }
  function renderHistory() {
    var section = element('presetHistorySection');
    var list = element('presetHistoryList');
    if (!section || !list) return;
    list.innerHTML = '';
    if (!state.history.length) {
      list.innerHTML = '<div class="preset-empty">Complete a preset to see accuracy, retries, and time here.</div>';
      element('clearHistoryBtn').style.display = 'none';
      return;
    }
    element('clearHistoryBtn').style.display = '';
    state.history.slice(0, 8).forEach(function (entry) {
      var row = document.createElement('div');
      row.className = 'preset-history-row';
      var date = new Date(entry.completedAt);
      row.innerHTML = '<div><strong>' + escapeHtml(entry.presetName) + '</strong><small>' + escapeHtml(date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })) + ' · ' + entry.firstTryCorrect + '/' + entry.total + ' first try</small></div><div class="preset-history-score">' + accuracy(entry) + '%</div><div class="preset-history-time">' + escapeHtml(formatDuration(entry.durationSec)) + '</div>';
      list.appendChild(row);
    });
  }
  function renderDashboard() {
    renderDaily();
    renderSummary();
    renderPresetGrids();
    renderHistory();
  }

  function renderQuizChoices(selected, weights) {
    var grid = element('presetQuizGrid');
    grid.innerHTML = '';
    weights = weights && typeof weights === 'object' ? weights : {};
    QUIZ_CHOICES.forEach(function (entry) {
      var checked = selected.includes(entry[0]);
      var item = document.createElement('div');
      item.className = 'preset-check';
      item.dataset.quizId = entry[0];
      item.innerHTML = '<label class="preset-check-main"><input type="checkbox" value="' + escapeHtml(entry[0]) + '"' + (checked ? ' checked' : '') + '><span>' + escapeHtml(entry[1]) + '</span></label><label class="preset-weight"><span>Weight</span><input type="number" min="1" max="10" value="' + clamp(weights[entry[0]], 1, 10, 1) + '"' + (checked ? '' : ' disabled') + ' aria-label="' + escapeHtml(entry[1]) + ' weight"></label>';
      var toggle = item.querySelector('input[type="checkbox"]');
      var weight = item.querySelector('input[type="number"]');
      toggle.addEventListener('change', function () { weight.disabled = !toggle.checked; });
      grid.appendChild(item);
    });
  }
  function renderDays(selected) {
    var container = element('presetDays');
    container.innerHTML = '';
    DAY_LABELS.forEach(function (label, day) {
      var item = document.createElement('label');
      item.className = 'preset-day';
      item.innerHTML = '<input type="checkbox" value="' + day + '"' + (selected.includes(day) ? ' checked' : '') + '><span>' + label.slice(0, 2) + '</span>';
      container.appendChild(item);
    });
  }
  function setOtherRangeInputs(settings) {
    element('presetDigits').value = settings.digits;
    element('presetSqMin').value = settings.sqMin;
    element('presetSqMax').value = settings.sqMax;
    element('presetCubeMin').value = settings.cubeMin;
    element('presetCubeMax').value = settings.cubeMax;
    element('presetMult2Min').value = settings.mult2Min;
    element('presetMult2Max').value = settings.mult2Max;
    element('presetMult3Min').value = settings.mult3Min;
    element('presetMult3Max').value = settings.mult3Max;
    element('presetMult3ByMin').value = settings.mult3ByMin;
    element('presetMult3ByMax').value = settings.mult3ByMax;
    element('presetPrimeMax').value = settings.primeMax;
    element('presetCiYears').value = settings.ciYears;
  }
  function setRangeInputs(settings) {
    setOtherRangeInputs(settings);
    element('presetMultFrom').value = settings.multFrom;
    element('presetMultTo').value = settings.multTo;
    element('presetMultiplierFrom').value = settings.multiplierFrom;
    element('presetMultiplierTo').value = settings.multiplierTo;
  }
  function updateTableMode() {
    var single = element('presetTableMode').value === 'single';
    var from = clamp(element('presetMultFrom').value, 1, 100, 2);
    if (single) element('presetMultTo').value = from;
    element('presetMultTo').disabled = single;
    element('presetMultFromLabel').textContent = single ? 'Table number' : 'Tables from';
    var to = single ? from : clamp(element('presetMultTo').value, 1, 100, from);
    var low = Math.min(from, to);
    var high = Math.max(from, to);
    var multiplierFrom = clamp(element('presetMultiplierFrom').value, 1, 100, 1);
    var multiplierTo = clamp(element('presetMultiplierTo').value, 1, 100, 10);
    var multiplierLow = Math.min(multiplierFrom, multiplierTo);
    var multiplierHigh = Math.max(multiplierFrom, multiplierTo);
    element('presetTablePreview').textContent = (low === high ? 'Table ' + low : 'Tables ' + low + '–' + high) + ' · ×' + multiplierLow + ' to ×' + multiplierHigh;
  }
  function editorSourcePreset() {
    if (editingPresetId) return getPreset(editingPresetId);
    if (editingTemplateId) return getTemplate(editingTemplateId);
    return null;
  }
  function populateEditor(preset, makeDaily) {
    element('presetName').value = preset.name;
    element('presetIcon').value = preset.icon;
    element('presetColor').value = preset.color;
    element('presetQuestionCount').value = preset.questionCount;
    element('presetDifficulty').value = preset.difficulty;
    element('presetTimerMinutes').value = preset.timerMinutes;
    element('presetAllowHints').checked = preset.allowHints;
    element('presetAllowSkip').checked = preset.allowSkip;
    element('presetShuffle').checked = preset.shuffle;
    element('presetRetryWrong').value = preset.retryWrong;
    element('presetDailyEnabled').checked = makeDaily || preset.dailyEnabled || state.dailyPresetId === preset.id;
    element('presetDailyTime').value = preset.dailyTime;
    element('presetTelegramEnabled').checked = preset.reminder.telegramEnabled;
    element('presetReminderMinutes').value = preset.reminder.reminderMinutes;
    element('presetSnoozeMinutes').value = preset.reminder.snoozeMinutes;
    element('presetMaxSnoozes').value = preset.reminder.maxSnoozes;
    setRangeInputs(preset.settings);
    element('presetTableMode').value = preset.settings.multFrom === preset.settings.multTo ? 'single' : 'range';
    renderQuizChoices(preset.quizIds, preset.weights);
    renderDays(preset.days);
    updateTableMode();
  }
  function genericPreset() {
    return normalizePreset({
      name: 'My Practice', icon: '🧮', color: '#00C896', questionCount: 10, difficulty: 'standard',
      quizIds: ['addition', 'subtraction', 'mult1'], allowHints: true, allowSkip: true, shuffle: true,
      retryWrong: 'immediate', reminder: { telegramEnabled: false, reminderMinutes: 0, snoozeMinutes: 10, maxSnoozes: 2 }
    }, false);
  }
  function openEditor(presetId, templateId, makeDaily, settingsOverride) {
    if (presetId && presetSendPending(presetId)) return;
    editingPresetId = presetId || null;
    editingTemplateId = templateId || null;
    var source = presetId ? getPreset(presetId) : templateId ? getTemplate(templateId) : genericPreset();
    if (!source) return;
    var draft = normalizePreset(clone(source), false);
    if (settingsOverride) {
      draft.settings = normalizeSettings(Object.assign({}, draft.settings, settingsOverride), draft.difficulty);
    }
    if (!presetId) {
      draft.id = uniqueId('preset');
      draft.sourceTemplateId = templateId || '';
      if (templateId) draft.name = source.name + ' · My preset';
    }
    element('presetEditorTitle').textContent = presetId ? 'Edit Preset' : templateId ? 'Customize Preset' : 'Create Preset';
    element('presetRestoreBtn').style.display = '';
    element('presetEditorError').classList.remove('show');
    populateEditor(draft, makeDaily);
    element('presetEditorForm').dataset.draftId = draft.id;
    show('presetEditor');
    setTimeout(function () { element('presetName').focus(); }, 0);
  }
  function openSchedule(presetId) {
    openEditor(presetId);
    setTimeout(function () {
      element('presetSchedulePanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      element('presetDailyEnabled').focus();
    }, 0);
  }
  function readEditorPreset() {
    var difficulty = element('presetDifficulty').value;
    /* Every range input is editable, so the form is always the source of truth.
       Difficulty only pre-fills the inputs when it changes. */
    var rawSettings = {
      digits: element('presetDigits').value,
      sqMin: element('presetSqMin').value,
      sqMax: element('presetSqMax').value,
      cubeMin: element('presetCubeMin').value,
      cubeMax: element('presetCubeMax').value,
      mult2Min: element('presetMult2Min').value,
      mult2Max: element('presetMult2Max').value,
      mult3Min: element('presetMult3Min').value,
      mult3Max: element('presetMult3Max').value,
      mult3ByMin: element('presetMult3ByMin').value,
      mult3ByMax: element('presetMult3ByMax').value,
      primeMax: element('presetPrimeMax').value,
      ciYears: element('presetCiYears').value
    };
    rawSettings.multFrom = element('presetMultFrom').value;
    rawSettings.multTo = element('presetTableMode').value === 'single' ? element('presetMultFrom').value : element('presetMultTo').value;
    rawSettings.multiplierFrom = element('presetMultiplierFrom').value;
    rawSettings.multiplierTo = element('presetMultiplierTo').value;
    var selectedQuizIds = Array.from(element('presetQuizGrid').querySelectorAll('input[type="checkbox"]:checked')).map(function (input) { return input.value; });
    var selectedWeights = {};
    element('presetQuizGrid').querySelectorAll('.preset-check').forEach(function (item) {
      var toggle = item.querySelector('input[type="checkbox"]');
      var weight = item.querySelector('input[type="number"]');
      if (toggle.checked) selectedWeights[toggle.value] = weight.value;
    });
    var selectedDays = Array.from(element('presetDays').querySelectorAll('input:checked')).map(function (input) { return Number(input.value); });
    var existing = editingPresetId ? getPreset(editingPresetId) : null;
    return normalizePreset({
      id: element('presetEditorForm').dataset.draftId,
      name: element('presetName').value,
      icon: element('presetIcon').value,
      color: element('presetColor').value,
      description: existing ? existing.description : (editingTemplateId && getTemplate(editingTemplateId) ? getTemplate(editingTemplateId).description : ''),
      questionCount: element('presetQuestionCount').value,
      difficulty: difficulty,
      timerMinutes: element('presetTimerMinutes').value,
      quizIds: selectedQuizIds,
      weights: selectedWeights,
      allowHints: element('presetAllowHints').checked,
      allowSkip: element('presetAllowSkip').checked,
      shuffle: element('presetShuffle').checked,
      retryWrong: element('presetRetryWrong').value,
      settings: rawSettings,
      dailyEnabled: element('presetDailyEnabled').checked,
      dailyTime: element('presetDailyTime').value,
      days: selectedDays,
      reminder: {
        telegramEnabled: element('presetTelegramEnabled').checked,
        reminderMinutes: element('presetReminderMinutes').value,
        snoozeMinutes: element('presetSnoozeMinutes').value,
        maxSnoozes: element('presetMaxSnoozes').value
      },
      sourceTemplateId: existing ? existing.sourceTemplateId : editingTemplateId,
      createdAt: existing ? existing.createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }, false);
  }
  function showEditorError(message) {
    var error = element('presetEditorError');
    error.textContent = message;
    error.classList.add('show');
    error.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function saveEditor(event) {
    event.preventDefault();
    var name = element('presetName').value.trim();
    var count = Number(element('presetQuestionCount').value);
    var selected = element('presetQuizGrid').querySelectorAll('input:checked').length;
    var days = element('presetDays').querySelectorAll('input:checked').length;
    if (!name) return showEditorError('Enter a preset name.');
    if (!Number.isInteger(count) || count < 3 || count > 50) return showEditorError('Question count must be between 3 and 50.');
    if (!selected) return showEditorError('Select at least one question type.');
    if (element('presetDailyEnabled').checked && !days) return showEditorError('Select at least one practice day for a daily preset.');
    if (element('presetTelegramEnabled').checked && !element('presetDailyEnabled').checked) return showEditorError('Turn on daily practice before enabling Telegram reminders.');
    var preset = readEditorPreset();
    var index = state.presets.findIndex(function (item) { return item.id === preset.id; });
    if (index >= 0) state.presets[index] = preset;
    else {
      if (state.presets.length >= MAX_PRESETS) return showEditorError('You can save up to ' + MAX_PRESETS + ' presets. Delete one before creating another.');
      state.presets.unshift(preset);
    }
    if (preset.dailyEnabled) state.dailyPresetId = preset.id;
    else if (state.dailyPresetId === preset.id) state.dailyPresetId = '';
    state.presets.forEach(function (item) { item.dailyEnabled = item.id === state.dailyPresetId; });
    persistState();
    show('home');
  }
  function restoreEditorDefaults() {
    var source = editorSourcePreset();
    var templateId = editingTemplateId || (source && source.sourceTemplateId);
    var template = getTemplate(templateId);
    var draft = normalizePreset(clone(template || genericPreset()), false);
    draft.id = element('presetEditorForm').dataset.draftId;
    draft.sourceTemplateId = templateId || '';
    draft.createdAt = source && source.createdAt ? source.createdAt : draft.createdAt;
    if (template) draft.name = template.name + ' · My preset';
    populateEditor(draft, false);
  }
  function resetPreset(id) {
    if (presetSendPending(id)) return;
    var original = getPreset(id);
    if (!original || !window.confirm('Restore defaults for "' + original.name + '"? Practice history will be kept.')) return;
    var template = getTemplate(original.sourceTemplateId);
    var restored = normalizePreset(clone(template || genericPreset()), false);
    restored.id = original.id;
    restored.sourceTemplateId = original.sourceTemplateId || '';
    restored.createdAt = original.createdAt;
    restored.updatedAt = new Date().toISOString();
    if (template) restored.name = template.name + ' · My preset';
    var index = state.presets.findIndex(function (item) { return item.id === id; });
    state.presets[index] = restored;
    if (state.dailyPresetId === id) state.dailyPresetId = '';
    persistState();
  }
  function duplicatePreset(id) {
    var original = getPreset(id);
    if (!original || state.presets.length >= MAX_PRESETS) return;
    var duplicate = normalizePreset(clone(original), false);
    duplicate.id = uniqueId('preset');
    duplicate.name = (original.name + ' Copy').slice(0, 40);
    duplicate.dailyEnabled = false;
    duplicate.reminder.telegramEnabled = false;
    duplicate.createdAt = duplicate.updatedAt = new Date().toISOString();
    state.presets.unshift(duplicate);
    persistState();
  }
  function deletePreset(id) {
    if (presetSendPending(id)) return;
    var preset = getPreset(id);
    if (!preset || !window.confirm('Delete "' + preset.name + '"? Practice history will be kept.')) return;
    state.presets = state.presets.filter(function (item) { return item.id !== id; });
    if (state.dailyPresetId === id) state.dailyPresetId = '';
    persistState();
  }
  function clearHistory() {
    if (!state.history.length || !window.confirm('Clear all Calculation Practice history? Your presets will not be deleted.')) return;
    state.history = [];
    persistState();
  }

  function botBaseUrl() {
    var override = '';
    try { override = localStorage.getItem('telegramBotUrl') || ''; } catch (error) {}
    return (override || 'https://examen-planner-2.onrender.com').replace(/\/+$/, '');
  }
  function telegramWebApp() {
    return (window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : null;
  }
  /* Fetch Telegram's SDK only for a Telegram launch, so the embedded and
     standalone browser modes never wait on a third-party script. */
  function loadTelegramSdk() {
    if (telegramWebApp()) return Promise.resolve(telegramWebApp());
    if (!miniApp.sdkPromise) {
      miniApp.sdkPromise = new Promise(function (resolve) {
        var script = document.createElement('script');
        script.src = 'https://telegram.org/js/telegram-web-app.js';
        script.async = true;
        script.onload = function () { resolve(telegramWebApp()); };
        script.onerror = function () { resolve(null); };
        document.head.appendChild(script);
      });
    }
    return miniApp.sdkPromise;
  }
  function miniOverlay(state) {
    var overlay = element('miniOverlay');
    if (!overlay) return;
    overlay.hidden = state === null;
    if (state === null) return;
    element('miniOverlayIcon').textContent = state.icon || '🧮';
    element('miniOverlaySpinner').hidden = !state.busy;
    element('miniOverlayTitle').textContent = state.title || '';
    element('miniOverlayText').textContent = state.text || '';
    var actions = element('miniOverlayActions');
    actions.innerHTML = '';
    (state.actions || []).forEach(function (action) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'preset-btn' + (action.primary ? ' primary' : '');
      button.textContent = action.label;
      button.onclick = action.onClick;
      actions.appendChild(button);
    });
  }
  function closeMiniApp() {
    var tg = telegramWebApp();
    if (tg && typeof tg.close === 'function') tg.close();
  }
  async function requestMiniApp(path, payload) {
    var tg = telegramWebApp();
    var initData = tg && tg.initData ? String(tg.initData) : '';
    if (!initData) throw new Error('Open this practice from your Telegram chat.');
    var response;
    /* The bot can cold-start slowly; without a timeout the launch screen would
       spin forever with no way back. */
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timeout = controller ? setTimeout(function () { controller.abort(); }, 30000) : null;
    try {
      response = await fetch(botBaseUrl() + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ initData: initData }, payload || {})),
        signal: controller ? controller.signal : undefined
      });
    } catch (error) {
      throw new Error(error && error.name === 'AbortError'
        ? 'StudyPlanner took too long to respond. Try again.'
        : 'Could not reach StudyPlanner. Check your connection and try again.');
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    var body = await response.json().catch(function () { return {}; });
    if (!response.ok || body.ok !== true) {
      throw new Error(String(body.error || 'Request failed. Try again.').slice(0, 200));
    }
    return body;
  }
  function applyTelegramChrome(tg) {
    if (!tg) return;
    try { tg.ready(); } catch (error) {}
    try { tg.expand(); } catch (error) {}
    var apply = function () {
      document.documentElement.dataset.theme = tg.colorScheme === 'light' ? 'light' : 'dark';
    };
    apply();
    try { tg.onEvent('themeChanged', apply); } catch (error) {}
  }
  async function loadMiniAppPreset() {
    miniOverlay({ busy: true, title: 'Loading your practice', text: 'Checking your Telegram account…' });
    try {
      var body = await requestMiniApp('/mini/calculation-preset', { presetId: miniApp.presetId });
      miniApp.preset = normalizePreset(body.preset, false);
      miniOverlay(null);
      startPreset(miniApp.preset);
    } catch (error) {
      miniOverlay({
        icon: '⚠️',
        title: 'Could not start practice',
        text: error && error.message ? error.message : 'Something went wrong.',
        actions: [
          { label: 'Try again', primary: true, onClick: loadMiniAppPreset },
          { label: 'Close', onClick: closeMiniApp }
        ]
      });
    }
  }
  async function submitMiniAppResult(result) {
    miniApp.resultStatus = 'Saving to your account…';
    miniApp.resultSyncFailed = false;
    renderResult(result);
    try {
      await requestMiniApp('/mini/calculation-result', {
        presetId: miniApp.presetId,
        result: {
          /* Stable id so a retried submission is not stored twice. */
          id: result.id,
          total: result.total,
          answered: result.answered,
          firstTryCorrect: result.firstTryCorrect,
          wrongAttempts: result.wrongAttempts,
          hintsUsed: result.hintsUsed,
          skipped: result.skipped,
          durationSec: result.durationSec,
          reason: result.reason,
          mistakeQuizIds: result.mistakeQuizIds,
          /* Used only if the preset was deleted while practising. */
          presetName: result.presetName
        }
      });
      miniApp.resultStatus = 'Saved to your account ✓';
      miniApp.resultSyncFailed = false;
    } catch (error) {
      miniApp.resultStatus = (error && error.message ? error.message : 'Could not save this attempt.') + ' Your score is shown above.';
      miniApp.resultSyncFailed = true;
    }
    renderResult(result);
  }
  function miniAppLaunchPresetId() {
    try { return String(new URLSearchParams(window.location.search).get('tgpreset') || '').slice(0, 80); }
    catch (error) { return ''; }
  }
  async function startMiniApp() {
    var presetId = miniAppLaunchPresetId();
    if (!presetId) return;
    miniApp.presetId = presetId;
    miniOverlay({ busy: true, title: 'Loading your practice', text: 'Connecting to Telegram…' });
    var tg = await loadTelegramSdk();
    /* A launch link opened in a normal browser has no Telegram signature, so it
       cannot be authorized here. Send the user to the full app instead, which
       signs in normally and opens the same preset. */
    if (!tg || !tg.initData) {
      miniOverlay({
        icon: '📱',
        title: 'Open this from Telegram',
        text: 'This link runs practice inside Telegram. Tap “Practice here” on the message in your Telegram chat, or continue in the full StudyPlanner app.',
        actions: [
          { label: 'Open in StudyPlanner', primary: true, onClick: function () {
            window.location.href = '../app.html?open=calc&preset=' + encodeURIComponent(presetId);
          } },
          { label: 'Browse practice library', onClick: function () {
            miniOverlay(null);
            sendToParent('state-request');
          } }
        ]
      });
      return;
    }
    miniApp.active = true;
    miniApp.tg = tg;
    applyTelegramChrome(tg);
    loadMiniAppPreset();
  }

  function onScreenChange() {}
  function receiveParentState(event) {
    if (event.source !== window.parent || event.origin !== window.location.origin) return;
    var data = event.data;
    if (!data || data.source !== 'studyplanner') return;
    if (data.type === 'preset-send-result') {
      applyPresetSendResult(data);
      return;
    }
    if (data.type === 'start-preset') {
      var linkedPreset = getPreset(String(data.presetId || '').slice(0, 80)) || getTemplate(String(data.presetId || '').slice(0, 80));
      if (linkedPreset) startPreset(linkedPreset);
      sendToParent('deep-link-consumed');
      return;
    }
    if (data.type !== 'calc-state') return;
    var nextSessionKey = String(data.sessionKey || '').slice(0, 100);
    if (parentSessionKey && nextSessionKey && nextSessionKey !== parentSessionKey) {
      presetSendStates = Object.create(null);
      if (activeSession) stopSession(false);
      lastResult = null;
      show('home');
    }
    parentSessionKey = nextSessionKey;
    state = normalizeState(data.state);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (error) {}
    renderDashboard();
  }
  function init() {
    renderHome();
    renderDashboard();
    renderQuizChoices([], {});
    renderDays([0, 1, 2, 3, 4, 5, 6]);
    element('createPresetBtn').onclick = function () { openEditor(); };
    element('presetEditorBack').onclick = function () { show('home'); };
    element('presetCancelBtn').onclick = function () { show('home'); };
    element('presetRestoreBtn').onclick = restoreEditorDefaults;
    element('presetTelegramEnabled').addEventListener('change', function () {
      if (this.checked) element('presetDailyEnabled').checked = true;
    });
    element('presetDailyEnabled').addEventListener('change', function () {
      if (!this.checked) element('presetTelegramEnabled').checked = false;
    });
    element('presetEditorForm').addEventListener('submit', saveEditor);
    element('presetTableMode').addEventListener('change', updateTableMode);
    ['presetMultFrom', 'presetMultTo', 'presetMultiplierFrom', 'presetMultiplierTo'].forEach(function (id) {
      element(id).addEventListener('input', updateTableMode);
      element(id).addEventListener('change', updateTableMode);
    });
    element('presetDifficulty').addEventListener('change', function () {
      var difficulty = this.value;
      if (difficulty !== 'custom') setOtherRangeInputs(normalizeSettings(difficultySettings(difficulty), difficulty));
      updateTableMode();
    });
    ['quick', 'my'].forEach(function (prefix) {
      element(prefix + 'CombineStart').onclick = startCombined;
      element(prefix + 'CombineSave').onclick = saveCombined;
      element(prefix + 'CombineClear').onclick = clearCombineSelection;
    });
    element('clearHistoryBtn').onclick = clearHistory;
    window.addEventListener('message', receiveParentState);
    /* A Telegram launch authorizes itself and starts the requested preset;
       every other mode asks the parent app for account state as before. */
    if (miniAppLaunchPresetId()) startMiniApp();
    else sendToParent('state-request');
  }

  window.CalcPresets = {
    startPreset: startPreset,
    stopSession: stopSession,
    requestExitSession: requestExitSession,
    nextQuizId: nextQuizId,
    questionSnapshot: questionSnapshot,
    questionNumber: questionNumber,
    onQuestionStarted: onQuestionStarted,
    onWrong: onWrong,
    onHint: onHint,
    onCorrect: onCorrect,
    advanceAfterCorrect: advanceAfterCorrect,
    advanceAfterWrong: advanceAfterWrong,
    skipQuestion: skipQuestion,
    onScreenChange: onScreenChange,
    renderDashboard: renderDashboard,
    getState: function () { return clone(state); }
  };

  init();
})();
