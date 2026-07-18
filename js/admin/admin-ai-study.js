/* PrepPath Admin — AI Study command center.
   Presentation-only module: preserves the existing Firestore fields, DOM IDs
   and global action handlers while providing a dedicated operations UI.
   Loaded after admin-actions.js. */

var _aiStudyHealth = null;
var _aiStudyLastTested = null;

function aiStudyProviderInitials(label) {
  return String(label || 'AI').replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean)
    .map(function (part) { return part.charAt(0); }).join('').slice(0, 2).toUpperCase() || 'AI';
}

function aiStudyConfiguredProviderCount() {
  return STUDY_PROVIDER_ORDER.filter(function (pid) { return studyKeysFor(pid).length > 0; }).length;
}

function aiStudyTotalKeyCount() {
  return STUDY_PROVIDER_ORDER.reduce(function (total, pid) {
    return total + studyKeysFor(pid).length;
  }, 0);
}

function aiStudyHealthState(pid) {
  var result = _aiStudyHealth && _aiStudyHealth[pid];
  if (!result || !result.configured) return { state: 'idle', label: 'Untested' };
  if (result.ok) return { state: 'ok', label: (result.latency_ms || 0) + ' ms' };
  return { state: 'error', label: 'Issue' };
}

function toggleStudyKeyVisibility(pid, button) {
  var field = document.getElementById('study-key-' + pid);
  if (!field) return;
  var revealed = field.classList.toggle('is-revealed');
  if (button) {
    var provider = STUDY_PROVIDERS[pid] || {};
    button.textContent = revealed ? 'Hide' : 'Show';
    button.setAttribute('aria-pressed', String(revealed));
    button.setAttribute('aria-label', (revealed ? 'Hide ' : 'Show ') + (provider.label || pid) + ' API keys');
  }
}

function aiStudyReload() {
  AI_CONFIG.loaded = false;
  AI_LIMITS.loaded = false;
  render();
  loadAiStudyData();
}

function aiStudyScrollTo(id) {
  var target = document.getElementById(id);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function aiStudyHealthMarkup(results) {
  if (!results) {
    return '<div class="ai-health-empty"><span class="ai-health-empty-icon">⌁</span><div><strong>No network test yet</strong><span>Run diagnostics to verify credentials, latency and model availability.</span></div></div>';
  }
  return '<div class="ai-health-table" role="table" aria-label="AI provider health results">' +
    '<div class="ai-health-row ai-health-row--header" role="row"><div role="columnheader">Provider</div><div role="columnheader">Status</div><div role="columnheader">Model / detail</div><div role="columnheader">Latency</div></div>' +
    STUDY_PROVIDER_ORDER.map(function (pid) {
      var provider = STUDY_PROVIDERS[pid] || {};
      var result = results[pid];
      var state = !result || !result.configured ? 'idle' : (result.ok ? 'ok' : 'error');
      var stateLabel = state === 'ok' ? 'Operational' : (state === 'error' ? 'Degraded' : 'Not configured');
      var latency = result && result.ok ? (result.latency_ms || 0) + ' ms' : '—';
      var detail = result && result.ok
        ? (result.model || studyModelFor(pid))
        : (result && result.configured ? studyTestMsg(result.status || 0).text : 'Add an API key to activate');
      return '<div class="ai-health-row" role="row">' +
        '<div class="ai-health-provider" role="cell"><span class="ai-provider-monogram ai-provider-monogram--small">' + esc(aiStudyProviderInitials(provider.label)) + '</span><span><strong>' + esc(provider.label || pid) + '</strong><small>' + esc(provider.host || 'Managed endpoint') + '</small></span></div>' +
        '<div role="cell"><span class="ai-status-pill is-' + state + '"><i></i>' + stateLabel + '</span></div>' +
        '<div class="ai-health-model" role="cell">' + esc(detail) + '</div>' +
        '<div class="ai-health-latency" role="cell">' + esc(latency) + '</div>' +
      '</div>';
    }).join('') + '</div>';
}

function aiStudyUpdateProviderHealth(results) {
  STUDY_PROVIDER_ORDER.forEach(function (pid) {
    var result = results && results[pid];
    var el = document.getElementById('study-health-' + pid);
    if (!el) return;
    var state = !result || !result.configured ? 'idle' : (result.ok ? 'ok' : 'error');
    var label = state === 'ok' ? (result.latency_ms || 0) + ' ms' : (state === 'error' ? 'Issue' : 'Untested');
    el.className = 'ai-provider-health is-' + state;
    el.innerHTML = '<i></i>' + label;
  });
}

async function testStudyProviders() {
  var out = document.getElementById('study-test-out');
  var buttons = document.querySelectorAll('[data-ai-health-button]');
  buttons.forEach(function (button) {
    button.disabled = true;
    button.innerHTML = '<span class="ai-button-spinner"></span> Testing network';
  });
  if (out) {
    out.innerHTML = '<div class="ai-health-loading"><span class="ai-button-spinner"></span><div><strong>Running provider diagnostics</strong><span>Routes are checked sequentially; each configured provider can take up to 25 seconds and a full portfolio can take about four minutes.</span></div></div>';
  }
  var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  var timeout = controller ? setTimeout(function () { controller.abort(); }, 240000) : null;
  try {
    var response = await fetch(STUDY_BACKEND + '/api/study/test', controller ? { signal: controller.signal } : undefined);
    var payload = await response.json();
    if (payload && payload.error) throw new Error(payload.detail || payload.error);
    _aiStudyHealth = payload && payload.results ? payload.results : {};
    // Direct health probe for Kiro provider (bypasses the proxy which doesn't
    // know about Kiro yet). Hits the /api/diag endpoint on kiro-key-test.
    await testKiroProviderDirect(_aiStudyHealth);
    _aiStudyLastTested = new Date();
    if (out) out.innerHTML = aiStudyHealthMarkup(_aiStudyHealth);
    aiStudyUpdateProviderHealth(_aiStudyHealth);
    var time = document.getElementById('ai-health-time');
    if (time) time.textContent = 'Tested ' + _aiStudyLastTested.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    showToast('Provider health check complete.');
  } catch (error) {
    var errorMessage = error && error.name === 'AbortError'
      ? 'Diagnostics timed out after four minutes. Retry when provider traffic is lower.'
      : (error.message || String(error));
    if (out) {
      out.innerHTML = '<div class="ai-health-empty is-error"><span class="ai-health-empty-icon">!</span><div><strong>Diagnostics unavailable</strong><span>' + esc(errorMessage) + '</span></div></div>';
    }
    showToast('Provider test failed: ' + errorMessage, 'error');
  } finally {
    if (timeout) clearTimeout(timeout);
    buttons.forEach(function (button) {
      button.disabled = false;
      button.textContent = 'Run health check';
    });
  }
}

/* Direct health probe for the Kiro provider. The main youtube-turbo-proxy
   doesn't know about Kiro, so we test it client-side via /api/diag which
   reports binaryExists, apiKeySet, and version without exposing the key. */
async function testKiroProviderDirect(results) {
  var kiroKeys = studyKeysFor('kiro');
  if (!kiroKeys.length) return; // no key configured → leave as "not configured"
  var kiroBase = (STUDY_PROVIDERS.kiro && STUDY_PROVIDERS.kiro.baseUrl) || 'https://kiro-key-test.onrender.com';
  var start = Date.now();
  try {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var to = ctrl ? setTimeout(function () { ctrl.abort(); }, 25000) : null;
    var r = await fetch(kiroBase + '/api/diag', ctrl ? { signal: ctrl.signal } : undefined);
    var j = await r.json();
    if (to) clearTimeout(to);
    var latency = Date.now() - start;
    if (j && j.binaryExists && j.apiKeySet) {
      results.kiro = { configured: true, ok: true, model: j.version || 'kiro-cli', latency_ms: latency };
    } else {
      results.kiro = { configured: true, ok: false, status: 503,
        detail: !j.binaryExists ? 'kiro-cli binary missing' : 'KIRO_API_KEY not set on server' };
    }
  } catch (e) {
    results.kiro = { configured: true, ok: false, status: 0,
      detail: e.name === 'AbortError' ? 'Timeout (25s)' : (e.message || 'unreachable') };
  }
}

function studyActiveChanged() {
  var selectedPid = selectedStudyProvider();
  var persistedPid = activeStudyProvider();
  var dirty = selectedPid !== persistedPid;
  _modelsWorkPid = null;
  STUDY_PROVIDER_ORDER.forEach(function (key) {
    var live = key === persistedPid;
    var pending = dirty && key === selectedPid;
    var configured = studyKeysFor(key).length > 0;
    var badge = document.getElementById('study-badge-' + key);
    var card = document.getElementById('study-provider-card-' + key);
    if (badge) {
      var badgeState = live ? 'is-active' : (pending ? 'is-pending' : (configured ? 'is-ready' : 'is-empty'));
      var badgeText = live ? 'Live route' : (pending ? 'Pending save' : (configured ? 'Standby' : 'Setup'));
      badge.className = 'ai-provider-state ' + badgeState;
      badge.innerHTML = '<i></i>' + badgeText;
    }
    if (card) {
      card.classList.toggle('is-active', live);
      card.classList.toggle('is-pending', pending);
    }
  });
  paintModelsManage();
  var activeLabel = document.getElementById('ai-active-provider-label');
  var modelLabel = document.getElementById('ai-active-model-label');
  var kpiLabel = document.getElementById('ai-route-kpi-label');
  var savebar = document.getElementById('ai-route-savebar');
  var saveTitle = document.getElementById('ai-route-save-title');
  var saveNote = document.getElementById('ai-route-save-note');
  var selectedConfig = STUDY_PROVIDERS[selectedPid] || {};
  var persistedConfig = STUDY_PROVIDERS[persistedPid] || {};
  if (activeLabel) activeLabel.textContent = selectedConfig.label || selectedPid;
  if (modelLabel) modelLabel.textContent = studyModelFor(selectedPid);
  if (kpiLabel) kpiLabel.textContent = dirty ? 'Pending provider' : 'Live provider';
  if (savebar) savebar.classList.toggle('is-dirty', dirty);
  if (saveTitle) saveTitle.textContent = dirty
    ? 'Pending route: ' + (persistedConfig.label || persistedPid) + ' → ' + (selectedConfig.label || selectedPid)
    : 'Live route: ' + (persistedConfig.label || persistedPid);
  if (saveNote) saveNote.textContent = dirty
    ? 'Save provider routing to publish this change to the proxy.'
    : 'Saving updates every provider credential and the active proxy mirror.';
}

function aiStudyProviderCard(pid, activePid) {
  var provider = STUDY_PROVIDERS[pid];
  var keys = studyKeysFor(pid);
  var models = studyModelsFor(pid);
  var active = pid === activePid;
  var configured = keys.length > 0;
  var stateClass = active ? 'is-active' : (configured ? 'is-ready' : 'is-empty');
  var stateText = active ? 'Live route' : (configured ? 'Standby' : 'Setup');
  var endpoint = provider.baseUrl || 'Managed by Bynara';
  var health = aiStudyHealthState(pid);
  var keyLink = provider.keyUrl
    ? '<a class="ai-provider-link" href="' + esc(provider.keyUrl) + '" target="_blank" rel="noopener">Get API key ↗</a>'
    : '<span class="ai-provider-link is-muted">Private endpoint</span>';

  return '<article id="study-provider-card-' + pid + '" class="ai-provider-card' + (active ? ' is-active' : '') + '">' +
    '<div class="ai-provider-card-head">' +
      '<label class="ai-provider-choice">' +
        '<input type="radio" name="study-active" value="' + pid + '"' + (active ? ' checked' : '') + ' onchange="studyActiveChanged()">' +
        '<span class="ai-provider-monogram">' + esc(aiStudyProviderInitials(provider.label)) + '</span>' +
        '<span class="ai-provider-name"><strong>' + esc(provider.label) + '</strong><small>' + esc(provider.host || 'Managed endpoint') + '</small></span>' +
      '</label>' +
      '<span id="study-badge-' + pid + '" class="ai-provider-state ' + stateClass + '"><i></i>' + stateText + '</span>' +
    '</div>' +
    '<div class="ai-provider-metrics">' +
      '<span><b>' + keys.length + '</b> key' + (keys.length === 1 ? '' : 's') + '</span>' +
      '<span><b>' + models.length + '</b> models</span>' +
      '<span id="study-health-' + pid + '" class="ai-provider-health is-' + health.state + '"><i></i>' + health.label + '</span>' +
    '</div>' +
    '<div class="ai-provider-endpoint" title="' + esc(endpoint) + '"><span>Endpoint</span><code>' + esc(endpoint.replace(/^https?:\/\//, '')) + '</code></div>' +
    '<div class="ai-secret-label"><label for="study-key-' + pid + '">API credentials</label><button type="button" onclick="toggleStudyKeyVisibility(\'' + pid + '\',this)" aria-pressed="false" aria-label="Show ' + esc(provider.label) + ' API keys">Show</button></div>' +
    '<textarea id="study-key-' + pid + '" class="ai-secret-field" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="One API key per line">' + esc(keys.join('\n')) + '</textarea>' +
    '<div class="ai-provider-card-foot"><span>' + esc(provider.note) + '</span>' + keyLink + '</div>' +
  '</article>';
}

function renderAiStudy() {
  if (!AI_CONFIG.loaded || !AI_LIMITS.loaded) {
    return '<div class="ai-loading-shell" aria-live="polite"><span class="ai-button-spinner"></span><div><strong>Loading AI operations</strong><span>Fetching providers, models and policy controls…</span></div></div>';
  }

  var activeProvider = activeStudyProvider();
  var activeConfig = STUDY_PROVIDERS[activeProvider] || STUDY_PROVIDERS.bynara;
  var activeKeys = studyKeysFor(activeProvider);
  var activeModel = studyModelFor(activeProvider);
  var configuredCount = aiStudyConfiguredProviderCount();
  var totalKeys = aiStudyTotalKeyCount();
  var focusCount = AI_LIMITS && AI_LIMITS.focusUsers ? Object.keys(AI_LIMITS.focusUsers).length : 0;
  var unlimitedCount = AI_LIMITS && AI_LIMITS.unlimited ? Object.keys(AI_LIMITS.unlimited).length : 0;
  var showRegen = !!(AI_CONFIG && AI_CONFIG.showRegenerate);
  var showFocus = !!(AI_CONFIG && AI_CONFIG.showFocusBox);
  var focusEmails = AI_LIMITS && Array.isArray(AI_LIMITS.focusEmails) ? AI_LIMITS.focusEmails.join('\n') : '';
  var unlimitedEmails = AI_LIMITS && Array.isArray(AI_LIMITS.unlimitedEmails) ? AI_LIMITS.unlimitedEmails.join('\n') : '';
  var studyLimit = AI_LIMITS && AI_LIMITS.studyPerHour != null ? AI_LIMITS.studyPerHour : 15;
  var tutorHour = AI_LIMITS && AI_LIMITS.tutorPerHour != null ? AI_LIMITS.tutorPerHour : 20;
  var tutorDay = AI_LIMITS && AI_LIMITS.tutorPerDay != null ? AI_LIMITS.tutorPerDay : 80;
  var operational = activeKeys.length > 0;
  var providers = STUDY_PROVIDER_ORDER.map(function (pid) { return aiStudyProviderCard(pid, activeProvider); }).join('');
  var lastTested = _aiStudyLastTested
    ? 'Tested ' + _aiStudyLastTested.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
    : 'Not tested this session';
  _modelsWorkPid = null;

  return '<div class="ai-fintech">' +
    '<section class="ai-command-hero">' +
      '<div class="ai-command-glow"></div>' +
      '<div class="ai-command-copy">' +
        '<span class="ai-command-eyebrow">AI infrastructure desk</span>' +
        '<h2>Study AI Command Center</h2>' +
        '<p>Route generation traffic, manage provider resilience and govern feature access from one operational workspace.</p>' +
        '<div class="ai-command-meta"><span class="ai-live-indicator ' + (operational ? 'is-live' : 'is-warning') + '"><i></i>' + (operational ? 'Production route active' : 'Active route needs a key') + '</span><span>Last saved ' + esc(fmtDate(AI_CONFIG.savedAt)) + '</span></div>' +
      '</div>' +
      '<div class="ai-command-actions">' +
        '<button class="ai-btn ai-btn-primary" type="button" data-ai-health-button onclick="testStudyProviders()">Run health check</button>' +
        '<button class="ai-btn ai-btn-ghost" type="button" onclick="aiStudyReload()">Refresh configuration</button>' +
      '</div>' +
    '</section>' +

    '<section class="ai-kpi-grid" aria-label="AI Study operational summary">' +
      '<article class="ai-kpi"><span class="ai-kpi-icon is-violet">⌁</span><div><small id="ai-route-kpi-label">Live provider</small><strong id="ai-active-provider-label">' + esc(activeConfig.label) + '</strong><span id="ai-active-model-label">' + esc(activeModel) + '</span></div></article>' +
      '<article class="ai-kpi"><span class="ai-kpi-icon is-green">✓</span><div><small>Provider coverage</small><strong>' + configuredCount + ' / ' + STUDY_PROVIDER_ORDER.length + '</strong><span>' + totalKeys + ' credential' + (totalKeys === 1 ? '' : 's') + ' secured</span></div></article>' +
      '<article class="ai-kpi"><span class="ai-kpi-icon is-blue">↗</span><div><small>Generation policy</small><strong>' + studyLimit + ' / hr</strong><span>Tutor ' + tutorHour + '/hr · ' + tutorDay + '/day</span></div></article>' +
      '<article class="ai-kpi"><span class="ai-kpi-icon is-amber">♙</span><div><small>Privileged access</small><strong>' + unlimitedCount + ' unlimited</strong><span>' + focusCount + ' focus grants</span></div></article>' +
    '</section>' +

    '<nav class="ai-section-nav" aria-label="AI Study sections">' +
      '<button type="button" onclick="aiStudyScrollTo(\'ai-providers\')">Provider portfolio</button>' +
      '<button type="button" onclick="aiStudyScrollTo(\'ai-routing\')">Routing & models</button>' +
      '<button type="button" onclick="aiStudyScrollTo(\'ai-health\')">Network health</button>' +
      '<button type="button" onclick="aiStudyScrollTo(\'ai-policy\')">Access policy</button>' +
    '</nav>' +

    '<section id="ai-providers" class="ai-panel ai-anchor-section">' +
      '<div class="ai-panel-heading"><div><span class="ai-panel-eyebrow">Provider portfolio</span><h3>Credential vault & failover routes</h3><p>Choose the live route and maintain independent credentials for every provider.</p></div><div class="ai-heading-metric"><strong>' + configuredCount + '</strong><span>funded routes</span></div></div>' +
      '<div class="ai-provider-grid">' + providers + '</div>' +
      '<div id="ai-route-savebar" class="ai-provider-savebar"><div><span class="ai-savebar-dot"></span><span><strong id="ai-route-save-title">Live route: ' + esc(activeConfig.label) + '</strong><small id="ai-route-save-note">Saving updates every provider credential and the active proxy mirror.</small></span></div><button class="ai-btn ai-btn-dark" type="button" onclick="saveStudyAiConfig()">Save provider routing</button></div>' +
    '</section>' +

    '<div id="ai-routing" class="ai-operations-grid ai-anchor-section">' +
      '<section class="ai-panel ai-route-panel">' +
        '<div class="ai-panel-heading is-compact"><div><span class="ai-panel-eyebrow">Routing desk</span><h3>Active model allocation</h3><p>The model list follows the selected live provider.</p></div><span class="ai-route-badge">/api/study</span></div>' +
        '<div class="ai-field"><label for="study-model">Production model</label><select id="study-model">' + studyModelOptions(studyModelsFor(activeProvider), activeModel) + '</select><span>Used for notes, quizzes, cards and insights.</span></div>' +
        '<div class="ai-model-manager"><div class="ai-model-manager-title"><label>Approved models · <span id="study-models-pid">' + esc(activeConfig.label) + '</span></label><small>Removing a model hides it from all users.</small></div><div id="study-models-manage" class="ai-model-tokens">' + studyModelChipsHtml(activeProvider) + '</div><label class="ai-add-model-label" for="study-model-add">New model ID</label><div class="ai-inline-form"><input id="study-model-add" type="text" autocomplete="off" spellcheck="false" placeholder="e.g. google/gemma-4-31b-it:free"><button class="ai-btn ai-btn-soft" type="button" onclick="addStudyModel()">Add model</button><button class="ai-btn ai-btn-secondary" type="button" onclick="saveStudyModels()">Save model list</button></div></div>' +
      '</section>' +

      '<section class="ai-panel ai-import-panel">' +
        '<div class="ai-panel-heading is-compact"><div><span class="ai-panel-eyebrow">Quick onboarding</span><h3>Import from cURL</h3><p>Auto-detect a supported provider, credential and model from an API snippet.</p></div><span class="ai-code-icon">&lt;/&gt;</span></div>' +
        '<label class="sr-only" for="study-curl">Paste cURL or API snippet</label><textarea id="study-curl" class="ai-code-input" spellcheck="false" placeholder="Paste cURL for Mistral, Cerebras, Bynara, OpenRouter or NVIDIA"></textarea>' +
        '<div class="ai-import-actions"><span>Credentials are moved to the matching vault field.</span><button class="ai-btn ai-btn-secondary" type="button" onclick="parseCurlIntoStudy()">Parse & fill</button></div>' +
      '</section>' +
    '</div>' +

    '<section id="ai-health" class="ai-panel ai-anchor-section">' +
      '<div class="ai-panel-heading"><div><span class="ai-panel-eyebrow">Network health</span><h3>Provider diagnostics</h3><p>Run server-side probes for availability, latency, quota and model compatibility.</p></div><div class="ai-heading-actions"><span id="ai-health-time">' + esc(lastTested) + '</span><button class="ai-btn ai-btn-soft" type="button" data-ai-health-button onclick="testStudyProviders()">Run health check</button></div></div>' +
      '<div id="study-test-out" aria-live="polite">' + aiStudyHealthMarkup(_aiStudyHealth) + '</div>' +
    '</section>' +

    '<div id="ai-policy" class="ai-policy-grid ai-anchor-section">' +
      '<section class="ai-panel">' +
        '<div class="ai-panel-heading is-compact"><div><span class="ai-panel-eyebrow">Experience controls</span><h3>Feature access policy</h3><p>Control expensive generation actions and targeted quiz tools.</p></div><span class="ai-policy-score ' + (showRegen || showFocus ? 'is-open' : '') + '">' + (showRegen || showFocus ? 'Custom' : 'Restricted') + '</span></div>' +
        '<div class="ai-switch-list">' +
          '<label class="ai-switch-row" for="study-show-regen"><span><strong>Regenerate results</strong><small>Allow everyone to discard saved output and spend quota again.</small></span><span class="ai-toggle"><input id="study-show-regen" type="checkbox"' + (showRegen ? ' checked' : '') + '><i></i></span></label>' +
          '<label class="ai-switch-row" for="study-show-focus"><span><strong>Focus prompt for everyone</strong><small>Show question/card targeting controls globally.</small></span><span class="ai-toggle"><input id="study-show-focus" type="checkbox"' + (showFocus ? ' checked' : '') + '><i></i></span></label>' +
        '</div>' +
        '<div class="ai-grant-editor"><div><label for="study-focus-emails">Targeted focus grants</label><span>' + focusCount + ' active</span></div><p>One registered user email per line. Saving replaces the current focus grant list.</p><textarea id="study-focus-emails" placeholder="student@example.com">' + esc(focusEmails) + '</textarea></div>' +
        '<button class="ai-btn ai-btn-dark ai-save-wide" type="button" onclick="saveStudyControls()">Save experience policy</button>' +
      '</section>' +

      '<section class="ai-panel">' +
        '<div class="ai-panel-heading is-compact"><div><span class="ai-panel-eyebrow">Risk controls</span><h3>Usage & quota policy</h3><p>Per-IP limits protect provider balances from automated abuse.</p></div><span class="ai-policy-score is-safe">Protected</span></div>' +
        '<div class="ai-limit-grid">' +
          '<label><span>Generations</span><strong><input id="ail-study" type="number" min="0" value="' + esc(studyLimit) + '"><small>/ hour</small></strong></label>' +
          '<label><span>Tutor messages</span><strong><input id="ail-tutor-h" type="number" min="0" value="' + esc(tutorHour) + '"><small>/ hour</small></strong></label>' +
          '<label><span>Daily tutor cap</span><strong><input id="ail-tutor-d" type="number" min="0" value="' + esc(tutorDay) + '"><small>/ day</small></strong></label>' +
        '</div>' +
        '<div class="ai-grant-editor"><div><label for="ail-emails">Unlimited accounts</label><span>' + unlimitedCount + ' active</span></div><p>These registered users bypass every Study AI limit. Saving replaces the current list.</p><textarea id="ail-emails" placeholder="premium@example.com">' + esc(unlimitedEmails) + '</textarea></div>' +
        '<button class="ai-btn ai-btn-dark ai-save-wide" type="button" onclick="saveAiLimits()">Save usage policy</button>' +
      '</section>' +
    '</div>' +
  '</div>';
}
