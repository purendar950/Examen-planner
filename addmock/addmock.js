(function () {
  'use strict';

  var state = {
    exams: [],
    defaultExam: '',
    today: '',
    requestId: '',
    submittedFingerprint: '',
    saving: false
  };

  function element(id) { return document.getElementById(id); }
  function telegramWebApp() {
    return window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  }
  function botBaseUrl() {
    /* Telegram initData is a bearer credential. Never send it to the app-wide
       `telegramBotUrl` relay override; this Mini App talks only to the bot host
       controlled by this deployment. */
    return 'https://examen-planner-2.onrender.com';
  }
  function randomRequestId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return 'mock-' + window.crypto.randomUUID().replace(/-/g, '');
      }
    } catch (error) {}
    return 'mock-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 14);
  }
  function requestId() {
    if (state.requestId) return state.requestId;
    try { state.requestId = sessionStorage.getItem('telegramMockRequestId') || ''; } catch (error) {}
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(state.requestId)) state.requestId = randomRequestId();
    try { sessionStorage.setItem('telegramMockRequestId', state.requestId); } catch (error) {}
    return state.requestId;
  }
  function resetRequestId() {
    state.requestId = '';
    try { sessionStorage.removeItem('telegramMockRequestId'); } catch (error) {}
  }
  function applyTelegramChrome(tg) {
    if (!tg) return;
    try { tg.ready(); } catch (error) {}
    try { tg.expand(); } catch (error) {}
    function applyTheme() {
      document.documentElement.dataset.theme = tg.colorScheme === 'light' ? 'light' : 'dark';
    }
    applyTheme();
    try { tg.onEvent('themeChanged', applyTheme); } catch (error) {}
  }
  function showStatus(title, text, canRetry) {
    element('status-card').hidden = false;
    element('mock-form').hidden = true;
    element('success-card').hidden = true;
    element('status-title').textContent = title;
    element('status-text').textContent = text;
    element('status-spinner').hidden = !!canRetry;
    element('retry-button').hidden = !canRetry;
  }
  function showForm() {
    element('status-card').hidden = true;
    element('success-card').hidden = true;
    element('mock-form').hidden = false;
  }
  function showError(message) {
    var error = element('form-error');
    error.textContent = message || '';
    error.hidden = !message;
  }
  async function requestMiniApp(path, payload) {
    var tg = telegramWebApp();
    var initData = tg && tg.initData ? String(tg.initData) : '';
    if (!initData) throw new Error('Open this form from /addmock in your private Telegram chat.');
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timeout = controller ? setTimeout(function () { controller.abort(); }, 30000) : null;
    var response;
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
  function selectedExam() {
    var id = element('exam-select').value;
    return state.exams.find(function (exam) { return exam.id === id; }) || state.exams[0] || null;
  }
  function selectedTier() {
    var exam = selectedExam();
    var id = element('tier-select').value;
    return exam && (exam.tiers.find(function (tier) { return tier.id === id; }) || exam.tiers[0]) || null;
  }
  function option(value, label) {
    var item = document.createElement('option');
    item.value = value;
    item.textContent = label;
    return item;
  }
  function renderExamOptions() {
    var select = element('exam-select');
    select.textContent = '';
    state.exams.forEach(function (exam) { select.appendChild(option(exam.id, exam.label)); });
    var preferred = state.exams.some(function (exam) { return exam.id === state.defaultExam; })
      ? state.defaultExam
      : (state.exams[0] && state.exams[0].id || '');
    select.value = preferred;
    renderTierOptions();
  }
  function renderTierOptions() {
    var select = element('tier-select');
    var exam = selectedExam();
    var previous = select.value;
    select.textContent = '';
    (exam ? exam.tiers : []).forEach(function (tier) { select.appendChild(option(tier.id, tier.label)); });
    if (exam && exam.tiers.some(function (tier) { return tier.id === previous; })) select.value = previous;
    renderSectionFields();
  }
  function renderSectionFields() {
    var container = element('section-fields');
    var tier = selectedTier();
    container.textContent = '';
    if (!tier) return;
    element('tier-heading').textContent = tier.label + ' marks';
    var maximum = 0;
    tier.sections.forEach(function (section) {
      maximum += Number(section.max) || 0;
      var row = document.createElement('label');
      row.className = 'section-row';

      var copy = document.createElement('span');
      copy.className = 'section-name';
      var title = document.createElement('strong');
      title.textContent = section.name;
      var range = document.createElement('span');
      range.textContent = 'Allowed: ' + section.min + ' to ' + section.max;
      copy.appendChild(title);
      copy.appendChild(range);

      var wrap = document.createElement('span');
      wrap.className = 'mark-wrap';
      var input = document.createElement('input');
      input.type = 'number';
      input.inputMode = 'decimal';
      input.step = '0.01';
      input.min = String(section.min);
      input.max = String(section.max);
      input.placeholder = '0';
      input.dataset.section = section.key;
      input.setAttribute('aria-label', section.name + ' marks');
      input.addEventListener('input', updateTotal);
      var max = document.createElement('span');
      max.textContent = '/ ' + section.max;
      wrap.appendChild(input);
      wrap.appendChild(max);

      row.appendChild(copy);
      row.appendChild(wrap);
      container.appendChild(row);
    });
    element('maximum-score').textContent = 'out of ' + roundScore(maximum);
    updateTotal();
  }
  function roundScore(value) { return Math.round(Number(value || 0) * 100) / 100; }
  function markInputs() {
    return Array.prototype.slice.call(element('section-fields').querySelectorAll('input[data-section]'));
  }
  function updateTotal() {
    var total = markInputs().reduce(function (sum, input) {
      var value = input.value.trim() === '' ? 0 : Number(input.value);
      return sum + (Number.isFinite(value) ? value : 0);
    }, 0);
    element('total-score').textContent = String(roundScore(total));
  }
  function collectMarks() {
    var tier = selectedTier();
    var marks = {};
    var anyFilled = false;
    markInputs().forEach(function (input) {
      var section = tier.sections.find(function (item) { return item.key === input.dataset.section; });
      var raw = input.value.trim();
      if (raw !== '') anyFilled = true;
      var value = raw === '' ? 0 : Number(raw);
      if (!Number.isFinite(value)) throw new Error(section.name + ': enter valid marks.');
      if (value < section.min || value > section.max) {
        throw new Error(section.name + ': marks must be between ' + section.min + ' and ' + section.max + '.');
      }
      marks[section.key] = roundScore(value);
    });
    if (!anyFilled) throw new Error('Enter marks for at least one section. Blank sections will count as 0.');
    return marks;
  }
  function setSaving(saving) {
    state.saving = saving;
    element('save-button').disabled = saving;
    element('save-label').textContent = saving ? 'Saving…' : 'Save Mock Result';
  }
  function noteFormChanged() {
    /* Keep the same id for an unchanged network retry. Once the user edits an
       attempted payload, the next save is a new request and must not collide
       with a result that may already have reached Firestore. */
    if (!state.submittedFingerprint || state.saving) return;
    state.submittedFingerprint = '';
    resetRequestId();
    requestId();
  }
  async function loadConfig() {
    showStatus('Loading your mock form', 'Checking your linked StudyPlanner account…', false);
    try {
      var body = await requestMiniApp('/mini/mock-config');
      state.exams = Array.isArray(body.exams) ? body.exams : [];
      state.defaultExam = String(body.defaultExam || '');
      state.today = String(body.today || '');
      if (!state.exams.length) throw new Error('No mock exams are configured.');
      element('mock-date').value = state.today;
      renderExamOptions();
      requestId();
      showForm();
    } catch (error) {
      showStatus('Could not open mock form', error && error.message ? error.message : 'Something went wrong.', true);
    }
  }
  async function saveMock(event) {
    event.preventDefault();
    if (state.saving) return;
    showError('');
    var exam = selectedExam();
    var tier = selectedTier();
    if (!exam || !tier) { showError('Choose a valid exam and tier.'); return; }
    var date = element('mock-date').value;
    if (!date) { showError('Choose the mock date.'); return; }
    var marks;
    try { marks = collectMarks(); }
    catch (error) { showError(error.message); return; }

    setSaving(true);
    try {
      var payload = {
        exam: exam.id,
        tier: tier.id,
        name: element('mock-name').value.trim(),
        date: date,
        marks: marks
      };
      var fingerprint = JSON.stringify(payload);
      if (state.submittedFingerprint && state.submittedFingerprint !== fingerprint) {
        resetRequestId();
      }
      state.submittedFingerprint = fingerprint;
      payload.requestId = requestId();
      var body = await requestMiniApp('/mini/mock-result', payload);
      resetRequestId();
      state.submittedFingerprint = '';
      element('mock-form').hidden = true;
      element('success-card').hidden = false;
      element('success-name').textContent = body.name || 'Mock result added';
      element('success-details').textContent = exam.label + ' · ' + tier.label + ' · Total ' + body.total
        + '. It will sync into Mock Tests when you open StudyPlanner.';
      var tg = telegramWebApp();
      try { if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success'); } catch (error) {}
    } catch (error) {
      showError(error && error.message ? error.message : 'Could not save this mock. Try again.');
      var tg = telegramWebApp();
      try { if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('error'); } catch (ignored) {}
    } finally {
      setSaving(false);
    }
  }
  function closeMiniApp() {
    var tg = telegramWebApp();
    if (tg && typeof tg.close === 'function') tg.close();
    else window.close();
  }

  element('exam-select').addEventListener('change', renderTierOptions);
  element('tier-select').addEventListener('change', renderSectionFields);
  element('mock-form').addEventListener('submit', saveMock);
  element('mock-form').addEventListener('input', noteFormChanged);
  element('mock-form').addEventListener('change', noteFormChanged);
  element('retry-button').addEventListener('click', loadConfig);
  element('close-button').addEventListener('click', closeMiniApp);

  applyTelegramChrome(telegramWebApp());
  loadConfig();
})();
