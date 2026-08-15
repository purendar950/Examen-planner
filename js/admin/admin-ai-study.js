/* StudyPlanner Admin — AI Study command center.
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
  AI_CHAT_CONFIG.loaded = false;
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
    var adminUser = auth && auth.currentUser;
    if (!adminUser) throw new Error('Admin session expired. Sign in again.');
    var idToken = await adminUser.getIdToken();
    var fetchOptions = { headers: { Authorization: 'Bearer ' + idToken } };
    if (controller) fetchOptions.signal = controller.signal;
    var response = window.PrepPathBackend
      ? await window.PrepPathBackend.fetch('/api/study/test', fetchOptions)
      : await fetch(STUDY_BACKEND + '/api/study/test', fetchOptions);
    var payload = await response.json();
    if (payload && payload.error) throw new Error(payload.detail || payload.error);
    _aiStudyHealth = payload && payload.results ? payload.results : {};
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
  var directBrowserBox = pid === 'omniroute'
    ? '<label class="ai-switch-row ai-provider-direct-toggle" for="omniroute-browser-direct"><span><strong>Direct browser requests</strong><small>Send OmniRoute chat, image generation, search, speech and video directly from AI Chat. This exposes the first configured OmniRoute key to authorized browsers and requires OmniRoute CORS to allow this app.</small></span><span class="ai-toggle"><input id="omniroute-browser-direct" type="checkbox"' + (AI_CONFIG && AI_CONFIG.omnirouteBrowserDirect ? ' checked' : '') + '><i></i></span></label>'
    : '';

  var metricsRow = '<div class="ai-provider-metrics">' +
        '<span><b>' + keys.length + '</b> key' + (keys.length === 1 ? '' : 's') + '</span>' +
        '<span><b>' + models.length + '</b> models</span>' +
        '<span id="study-health-' + pid + '" class="ai-provider-health is-' + health.state + '"><i></i>' + health.label + '</span>' +
      '</div>';
  var credentialsBox = '<div class="ai-secret-label"><label for="study-key-' + pid + '">API credentials</label><button type="button" onclick="toggleStudyKeyVisibility(\'' + pid + '\',this)" aria-pressed="false" aria-label="Show ' + esc(provider.label) + ' API keys">Show</button></div>' +
      '<textarea id="study-key-' + pid + '" class="ai-secret-field" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="One API key per line">' + esc(keys.join('\n')) + '</textarea>';

  return '<article id="study-provider-card-' + pid + '" class="ai-provider-card' + (active ? ' is-active' : '') + '">' +
    '<div class="ai-provider-card-head">' +
      '<label class="ai-provider-choice">' +
        '<input type="radio" name="study-active" value="' + pid + '"' + (active ? ' checked' : '') + ' onchange="studyActiveChanged()">' +
        '<span class="ai-provider-monogram">' + esc(aiStudyProviderInitials(provider.label)) + '</span>' +
        '<span class="ai-provider-name"><strong>' + esc(provider.label) + '</strong><small>' + esc(provider.host || 'Managed endpoint') + '</small></span>' +
      '</label>' +
      '<span id="study-badge-' + pid + '" class="ai-provider-state ' + stateClass + '"><i></i>' + stateText + '</span>' +
    '</div>' +
    metricsRow +
    '<div class="ai-provider-endpoint" title="' + esc(endpoint) + '"><span>Endpoint</span><code>' + esc(endpoint.replace(/^https?:\/\//, '')) + '</code></div>' +
    credentialsBox +
    directBrowserBox +
    '<div class="ai-provider-card-foot"><span>' + esc(provider.note) + '</span>' + keyLink + '</div>' +
  '</article>';
}

function aiStudyFreeModelSyncTime(value) {
  if (!value) return 'Not run yet';
  var date = null;
  try {
    if (typeof value.toDate === 'function') date = value.toDate();
    else if (typeof value.seconds === 'number') date = new Date(value.seconds * 1000);
    else date = new Date(value);
  } catch (e) { date = null; }
  if (!date || isNaN(date.getTime())) return 'Not run yet';
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(date);
}

function aiStudyModelCatalogRefreshMarkup(mode) {
  var info = mode === 'all'
    ? {
      panelId: 'ai-all-model-refresh', eyebrow: 'Complete catalog', heading: 'Daily free & paid model refresh',
      description: 'Add any configured provider here to fetch every currently available text/chat model, including free and paid models. Your provider account and its billing rules still apply. A verified catalog replaces only this provider\'s model list; failed, invalid or empty responses keep the current list.',
      addLabel: 'Add provider to full-model refresh',
      availability: 'All configured Study AI providers are available. A provider can be in only one refresh list; adding it here moves it from the free-only list.',
      empty: 'Add a provider below to replace its model list once per day with all currently available free and paid text/chat models.'
    }
    : {
      panelId: 'ai-free-model-refresh', eyebrow: 'Automated catalog', heading: 'Daily free-model refresh',
      description: 'Add any configured provider here. Each daily run replaces only models whose live catalog proves zero request, input and output pricing; new free models are added and removed ones disappear. Providers without machine-readable pricing keep their current models and report that the free catalog cannot be verified.',
      addLabel: 'Add provider to free-model refresh',
      availability: 'All configured Study AI providers are available. A provider can be in only one refresh list; adding it here moves it from the full-model list.',
      empty: 'Add a provider below to replace its verified zero-price model list once per day after a catalog fetch.'
    };
  var enabled = dailyModelCatalogProviders(mode);
  var other = dailyModelCatalogProviders(mode === 'all' ? 'free' : 'all');
  var available = STUDY_CATALOG_REFRESH_PROVIDERS.filter(function (pid) { return enabled.indexOf(pid) === -1; });
  var options = available.length
    ? available.map(function (pid) {
      var moved = other.indexOf(pid) !== -1 ? ' (move from other list)' : '';
      return '<option value="' + esc(pid) + '">' + esc((STUDY_PROVIDERS[pid] || {}).label || pid) + moved + '</option>';
    }).join('')
    : '<option value="">All supported catalogs are enabled</option>';
  var rows = enabled.length ? enabled.map(function (pid) {
    var provider = STUDY_PROVIDERS[pid] || {};
    var status = modelCatalogSyncStatusFor(mode, pid);
    var state = status.state === 'success' ? 'success' : (status.state === 'error' ? 'error' : 'idle');
    var statusLabel = state === 'success' ? 'Healthy' : (state === 'error' ? 'Needs attention' : 'Waiting for first run');
    var lastLabel = state === 'success' ? 'Last successful refresh' : 'Last refresh attempt';
    var lastAt = state === 'success' ? status.lastSuccessAt : status.lastAttemptAt;
    var activity = state === 'success'
      ? '+' + (status.added || 0) + ' added · −' + (status.removed || 0) + ' removed'
      : (status.lastError || 'The daily workflow will preserve current models until a verified catalog is available.');
    var replacement = status.activeModelReplaced
      ? '<span class="ai-free-refresh-note">Active model moved to <code>' + esc(status.activeModelReplaced) + '</code>.</span>'
      : '';
    return '<article class="ai-free-refresh-provider">' +
      '<div class="ai-free-refresh-provider-main">' +
        '<span class="ai-provider-monogram ai-provider-monogram--small">' + esc(aiStudyProviderInitials(provider.label || pid)) + '</span>' +
        '<div><strong>' + esc(provider.label || pid) + '</strong><small>' + studyModelsFor(pid).length + ' auto-managed model' + (studyModelsFor(pid).length === 1 ? '' : 's') + ' · ' + esc(lastLabel) + ': ' + esc(aiStudyFreeModelSyncTime(lastAt)) + '</small></div>' +
      '</div>' +
      '<div class="ai-free-refresh-provider-state"><span class="ai-status-pill is-' + state + '"><i></i>' + statusLabel + '</span><span>' + esc(activity) + '</span>' + replacement + '</div>' +
      '<button class="ai-free-refresh-remove" type="button" onclick="removeDailyModelCatalogProvider(\'' + mode + '\',\'' + esc(pid) + '\')" aria-label="Remove ' + esc(provider.label || pid) + ' from daily refresh">Remove</button>' +
    '</article>';
  }).join('') : '<div class="ai-free-refresh-empty"><strong>No provider is scheduled yet.</strong><span>' + esc(info.empty) + '</span></div>';

  return '<section id="' + info.panelId + '" class="ai-panel ai-anchor-section">' +
    '<div class="ai-panel-heading"><div><span class="ai-panel-eyebrow">' + esc(info.eyebrow) + '</span><h3>' + esc(info.heading) + '</h3><p>' + esc(info.description) + '</p></div><button class="ai-btn ai-btn-soft" type="button" onclick="syncDailyModelCatalogs(this)"' + (enabled.length ? '' : ' disabled') + '>Refresh now</button></div>' +
    '<div class="ai-free-refresh-list">' + rows + '</div>' +
    '<div class="ai-free-refresh-add"><div><label for="daily-' + mode + '-model-provider">' + esc(info.addLabel) + '</label><span>' + esc(info.availability) + '</span></div><div><select id="daily-' + mode + '-model-provider"' + (available.length ? '' : ' disabled') + '>' + options + '</select><button class="ai-btn ai-btn-secondary" type="button" onclick="addDailyModelCatalogProvider(\'' + mode + '\')"' + (available.length ? '' : ' disabled') + '>Add provider</button></div></div>' +
  '</section>';
}

function aiStudyFreeModelRefreshMarkup() { return aiStudyModelCatalogRefreshMarkup('free'); }
function aiStudyAllModelRefreshMarkup() { return aiStudyModelCatalogRefreshMarkup('all'); }

/* Live web search for the AI Tutor (config/ai, read by _load_search_config in
   youtube-turbo-proxy/app.py).

   This card exists because the feature shipped usable-but-degraded and there was
   no way to improve it from the panel. Without a key the server falls back to
   scraping DuckDuckGo — which answers a couple of requests from a datacenter IP
   and then serves a bot-check page — leaving Wikipedia as the only reliable
   source. That is fine for static GK and useless for "SSC CGL 2026 exam date".
   Any one of these keys fixes it, and all four have a free tier. */
function aiStudyWebSearchKeyRow(id, field, label, hint, placeholder) {
  var value = (AI_CONFIG && AI_CONFIG[field]) || '';
  return '<div class="ai-field">' +
    '<label for="' + id + '">' + esc(label) + '</label>' +
    '<input id="' + id + '" type="password" autocomplete="off" spellcheck="false" ' +
      'data-websearch-secret placeholder="' + esc(placeholder) + '" value="' + esc(value) + '">' +
    '<span>' + hint + '</span>' +
  '</div>';
}

function toggleWebSearchSecrets(button) {
  var fields = document.querySelectorAll('[data-websearch-secret]');
  if (!fields.length) return;
  var reveal = fields[0].type === 'password';
  Array.prototype.forEach.call(fields, function (f) { f.type = reveal ? 'text' : 'password'; });
  if (button) {
    button.textContent = reveal ? 'Hide keys' : 'Show keys';
    button.setAttribute('aria-pressed', String(reveal));
  }
}

/* ── AI Chat tab access policy card ──────────────────────────────────────
   A standalone chat page in the app, hidden by default. Enable it for
   specific users (one email per line) — that's the ONLY thing this card
   configures now. There is no separate model curation step: a granted user
   automatically sees EVERY provider/model configured above (the exact same
   list the Study AI tutor already exposes), and image generation
   auto-activates the moment any configured `google` model's name signals
   native image output (e.g. gemini-3.1-flash-image) — no third-party
   service, no extra toggle. Saved to a dedicated Firestore doc
   (config/aiChat) via saveAiChatConfig() so it can never collide with
   config/ai's own fields. */
function aiStudyChatMarkup() {
  var cfg = AI_CHAT_CONFIG || {};
  var emails = Array.isArray(cfg.allowedEmails) ? cfg.allowedEmails.join('\n') : '';
  var grantCount = cfg.allowedUsers ? Object.keys(cfg.allowedUsers).length : 0;
  var isImageModelName = function (m) {
    var lowered = String(m || '').toLowerCase();
    return lowered.indexOf('image') !== -1 || lowered.indexOf('nano-banana') !== -1 || lowered.indexOf('imagen') !== -1;
  };
  // Chat models exclude image-only ids, matching the backend's split — the two
  // dropdowns in the chat are deliberately disjoint.
  var configuredModelCount = STUDY_PROVIDER_ORDER.reduce(function (total, pid) {
    if (!studyKeysFor(pid).length) return total;
    return total + studyModelsFor(pid).filter(function (m) { return !isImageModelName(m); }).length;
  }, 0);
  /* Image models come from their OWN catalog (config/ai.imageModels, defaulting
     to the backend's IMAGE_PROVIDER_MODELS) — NOT from providerModels, which the
     nightly chat-catalog refresh strips every image id out of. Mirrors
     _ai_chat_image_models(): dedicated list + any hand-added image id still
     sitting in the provider's regular model list. */
  var IMAGE_MODEL_DEFAULTS = { google: ['gemini-3.1-flash-image', 'gemini-2.5-flash-image', 'gemini-3-pro-image'] };
  var imageCapableCount = Object.keys(IMAGE_MODEL_DEFAULTS).reduce(function (total, pid) {
    if (!studyKeysFor(pid).length) return total;
    var override = (AI_CONFIG && AI_CONFIG.imageModels && AI_CONFIG.imageModels[pid]);
    var list = (Array.isArray(override) && override.length) ? override : IMAGE_MODEL_DEFAULTS[pid];
    var extra = studyModelsFor(pid).filter(isImageModelName);
    var union = list.concat(extra).filter(function (m, i, arr) { return arr.indexOf(m) === i; });
    return total + union.length;
  }, 0);
  return '<section class="ai-panel">' +
    '<div class="ai-panel-heading is-compact"><div><span class="ai-panel-eyebrow">Standalone feature</span><h3>AI Chat tab access</h3><p>A separate chat page in the app, hidden unless a user is on this list. They automatically see every model configured in the provider portfolio above and can switch freely — no separate model curation here.</p></div><span class="ai-policy-score ' + (grantCount ? 'is-open' : '') + '">' + (grantCount ? grantCount + ' granted' : 'Nobody yet') + '</span></div>' +
    '<div class="ai-switch-list">' +
      '<div class="ai-switch-row" style="cursor:default;"><span><strong>Selectable models</strong><small>Every model from a configured provider above — currently <b>' + configuredModelCount + '</b> model' + (configuredModelCount === 1 ? '' : 's') + ' across ' + aiStudyConfiguredProviderCount() + ' provider' + (aiStudyConfiguredProviderCount() === 1 ? '' : 's') + '. Add or remove keys in the provider portfolio to change this list.</small></span></div>' +
      '<div class="ai-switch-row" style="cursor:default;"><span><strong>Image generation</strong><small>' + (imageCapableCount
        ? 'Auto-enabled — ' + imageCapableCount + ' Gemini image model' + (imageCapableCount === 1 ? '' : 's') + ' configured (e.g. gemini-3.1-flash-image). Uses the same Google Gemini key already entered above; no separate service or toggle.'
        : 'Off — no Gemini image model is configured yet. Add a Google Gemini API key above and keep an "-image" model (e.g. gemini-3.1-flash-image) in its model list to enable this automatically.') + '</small></span></div>' +
    '</div>' +
    '<div class="ai-grant-editor"><div><label for="aichat-emails">Allowed accounts</label><span>' + grantCount + ' active</span></div><p>One registered user email per line. Saving replaces the current list. Admins always get access regardless of this list.</p><textarea id="aichat-emails" placeholder="student@example.com">' + esc(emails) + '</textarea></div>' +
    '<button class="ai-btn ai-btn-dark ai-save-wide" type="button" onclick="saveAiChatConfig()">Save AI Chat access</button>' +
  '</section>';
}

function aiStudyWebSearchMarkup() {
  var cfg = AI_CONFIG || {};
  var enabled = cfg.tutorWebSearch !== false;      // absent = on, matching the server default
  var keyed = ['tavilyApiKey', 'serperApiKey', 'braveApiKey', 'searxngUrl']
    .some(function (f) { return !!String(cfg[f] || '').trim(); });
  var score = !enabled ? 'Off' : (keyed ? 'Keyed' : 'Keyless');
  var scoreClass = !enabled ? '' : (keyed ? 'is-safe' : 'is-open');
  return '<section id="ai-websearch" class="ai-panel ai-anchor-section">' +
    '<div class="ai-panel-heading"><div><span class="ai-panel-eyebrow">Tutor grounding</span>' +
      '<h3>Live web search</h3><p>Lets the tutor look up current affairs, exam dates and anything newer than the model\'s training data.</p></div>' +
      '<div class="ai-heading-actions"><span class="ai-policy-score ' + scoreClass + '">' + score + '</span>' +
      '<button class="ai-btn ai-btn-soft" type="button" aria-pressed="false" onclick="toggleWebSearchSecrets(this)">Show keys</button></div></div>' +
    '<div class="ai-switch-list">' +
      '<label class="ai-switch-row" for="websearch-enabled"><span><strong>Enable web search</strong>' +
        '<small>Off = the tutor answers from the transcript and its own knowledge only. Today\'s date is still provided either way.</small></span>' +
        '<span class="ai-toggle"><input id="websearch-enabled" type="checkbox"' + (enabled ? ' checked' : '') + '><i></i></span></label>' +
    '</div>' +
    (keyed ? '' :
      '<div class="ai-grant-editor"><div><label>No search key configured</label><span>degraded</span></div>' +
      '<p>The tutor currently falls back to DuckDuckGo scraping, which a datacenter IP gets bot-blocked from after a couple of requests, so answers come mostly from Wikipedia. Good enough for static general knowledge; not for exam dates or recent news. Add any ONE key below to fix it — every option has a free tier.</p></div>') +
    '<div class="ai-field-grid">' +
      aiStudyWebSearchKeyRow('websearch-tavily', 'tavilyApiKey', 'Tavily API key',
        'Built for LLM grounding. <a href="https://tavily.com" target="_blank" rel="noopener noreferrer">tavily.com</a>', 'tvly-…') +
      aiStudyWebSearchKeyRow('websearch-serper', 'serperApiKey', 'Serper API key',
        'Google results, includes the answer box. <a href="https://serper.dev" target="_blank" rel="noopener noreferrer">serper.dev</a>', '') +
      aiStudyWebSearchKeyRow('websearch-brave', 'braveApiKey', 'Brave Search API key',
        'Independent index. <a href="https://brave.com/search/api/" target="_blank" rel="noopener noreferrer">brave.com/search/api</a>', 'BSA…') +
      aiStudyWebSearchKeyRow('websearch-searxng', 'searxngUrl', 'SearXNG base URL',
        'Self-hosted, no key. Must have the JSON API enabled.', 'https://searx.example.com') +
    '</div>' +
    '<button class="ai-btn ai-btn-dark ai-save-wide" type="button" onclick="saveWebSearchConfig()">Save web search</button>' +
  '</section>';
}

function renderAiStudy() {
  if (!AI_CONFIG.loaded || !AI_LIMITS.loaded || !AI_CHAT_CONFIG.loaded) {
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
      '<button type="button" onclick="aiStudyScrollTo(\'ai-free-model-refresh\')">Free-model refresh</button>' +
      '<button type="button" onclick="aiStudyScrollTo(\'ai-all-model-refresh\')">Free & paid refresh</button>' +
      '<button type="button" onclick="aiStudyScrollTo(\'ai-health\')">Network health</button>' +
      '<button type="button" onclick="aiStudyScrollTo(\'ai-policy\')">Access policy</button>' +
      '<button type="button" onclick="aiStudyScrollTo(\'ai-chat-access\')">AI Chat tab</button>' +
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
        '<label class="sr-only" for="study-curl">Paste cURL or API snippet</label><textarea id="study-curl" class="ai-code-input" spellcheck="false" placeholder="Paste cURL for Gemini Interactions or any provider shown above"></textarea>' +
        '<div class="ai-import-actions"><span>Credentials are moved to the matching vault field.</span><button class="ai-btn ai-btn-secondary" type="button" onclick="parseCurlIntoStudy()">Parse & fill</button></div>' +
      '</section>' +
    '</div>' +

    aiStudyFreeModelRefreshMarkup() +

    aiStudyAllModelRefreshMarkup() +

    '<section id="ai-health" class="ai-panel ai-anchor-section">' +
      '<div class="ai-panel-heading"><div><span class="ai-panel-eyebrow">Network health</span><h3>Provider diagnostics</h3><p>Run server-side probes for availability, latency, quota and model compatibility.</p></div><div class="ai-heading-actions"><span id="ai-health-time">' + esc(lastTested) + '</span><button class="ai-btn ai-btn-soft" type="button" data-ai-health-button onclick="testStudyProviders()">Run health check</button></div></div>' +
      '<div id="study-test-out" aria-live="polite">' + aiStudyHealthMarkup(_aiStudyHealth) + '</div>' +
    '</section>' +

    aiStudyWebSearchMarkup() +

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

    '<div id="ai-chat-access" class="ai-anchor-section">' + aiStudyChatMarkup() + '</div>' +
  '</div>';
}
