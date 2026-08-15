/* StudyPlanner backend registry.
   A single routing layer keeps Turbo, AI Chat, tutor, Telegram helpers, and admin
   tools on the same primary/backup policy. Server configuration is admin-owned
   in config/turbo; localStorage remains a compatibility fallback only. */
(function () {
  'use strict';

  var DEFAULT_SERVERS = [
    { id: 'render-primary', label: 'Render primary', url: 'https://youtube-turbo-proxy.onrender.com', enabled: true },
    // The former gej4 deployment currently returns Render's suspended-service
    // page. Keep it visible for administrators, but never route user requests
    // there unless it is explicitly re-enabled after recovery.
    { id: 'render-legacy-gej4', label: 'Render legacy (suspended)', url: 'https://youtube-turbo-proxy-gej4.onrender.com', enabled: false }
  ];
  var STORAGE_KEY = 'preppath_backend_registry_v1';
  var state = {
    servers: DEFAULT_SERVERS.slice(),
    mode: 'auto',
    manualServerId: '',
    remoteLoaded: false,
    authBound: false,
    activeId: '',
    health: {},
    cooldownUntil: {}
  };

  function cleanUrl(url) {
    return String(url || '').trim().replace(/\/+$/, '');
  }
  function safeId(value, fallback) {
    var id = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    return id || fallback;
  }
  function normalizeServers(input) {
    var list = Array.isArray(input) ? input : [];
    var out = [], seen = {};
    list.forEach(function (item, index) {
      if (typeof item === 'string') item = { url: item };
      if (!item || !cleanUrl(item.url)) return;
      var url = cleanUrl(item.url);
      if (!/^https?:\/\//i.test(url) || seen[url]) return;
      seen[url] = true;
      var id = safeId(item.id, 'server-' + (index + 1));
      while (out.some(function (server) { return server.id === id; })) id += '-1';
      out.push({ id: id, label: String(item.label || id).slice(0, 80), url: url, enabled: item.enabled !== false });
    });
    return out.length ? out.slice(0, 12) : DEFAULT_SERVERS.slice();
  }
  function readLocal() {
    try {
      var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved && Array.isArray(saved.servers)) {
        state.servers = normalizeServers(saved.servers);
        state.mode = saved.mode === 'manual' ? 'manual' : 'auto';
        state.manualServerId = String(saved.manualServerId || '');
        state.activeId = String(saved.activeId || '');
      } else {
        var legacy = cleanUrl(localStorage.getItem('turboBackendUrl'));
        if (legacy && legacy !== DEFAULT_SERVERS[0].url) state.servers = normalizeServers([{ id: 'legacy', label: 'Saved server', url: legacy }, DEFAULT_SERVERS[0], DEFAULT_SERVERS[1]]);
      }
    } catch (e) {}
  }
  function writeLocal() {
        try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ servers: state.servers, mode: state.mode, manualServerId: state.manualServerId, activeId: state.activeId }));
 } catch (e) {}
  }
  function enabledServers() { return state.servers.filter(function (server) { return server.enabled !== false; }); }
  function serverCooling(server) {
    return state.mode !== 'manual' && Number(state.cooldownUntil[server.id] || 0) > Date.now();
  }
  function orderedServers() {
    var all = enabledServers();
    var list = all.filter(function (server) { return !serverCooling(server); });
    // Never leave the app without an attempt path if every server is cooling;
    // retry the full enabled set once so a recovered backend can be detected.
    if (!list.length) list = all.slice();
    if (state.mode === 'manual' && state.manualServerId) {
      list.sort(function (a, b) { return a.id === state.manualServerId ? -1 : b.id === state.manualServerId ? 1 : 0; });
    } else if (state.activeId) {
      list.sort(function (a, b) { return a.id === state.activeId ? -1 : b.id === state.activeId ? 1 : 0; });
    }
    return list;
  }
  function emit() {
    try { window.dispatchEvent(new CustomEvent('preppath:backend-status', { detail: getSnapshot() })); } catch (e) {}
  }
  function failureCooldownMs(detail) {
    var text = String(detail || '').toLowerCase();
    if (/503|502|504|service suspended|failed to fetch|networkerror|network error|timed out|timeout|abort/.test(text)) return 120000;
    return 20000;
  }
  function mark(server, ok, detail) {
    state.health[server.id] = { ok: !!ok, detail: detail || '', checkedAt: Date.now() };
    if (ok) {
      state.activeId = server.id;
      delete state.cooldownUntil[server.id];
      writeLocal();
    } else {
      state.cooldownUntil[server.id] = Date.now() + failureCooldownMs(detail);
    }
    emit();
  }
  function getSnapshot() {
    return {
      servers: state.servers.map(function (server) { return Object.assign({}, server, { health: state.health[server.id] || null, active: server.id === state.activeId }); }),
      mode: state.mode,
      manualServerId: state.manualServerId,
      activeId: state.activeId,
      remoteLoaded: state.remoteLoaded
    };
  }
  function applyConfig(config, persist) {
    config = config || {};
    if (Array.isArray(config.servers) && config.servers.length) state.servers = normalizeServers(config.servers);
    if (config.mode === 'manual' || config.mode === 'auto') state.mode = config.mode;
    if (config.manualServerId != null) state.manualServerId = String(config.manualServerId || '');
    if (!state.servers.some(function (server) { return server.id === state.manualServerId; })) state.manualServerId = '';
    if (persist !== false) writeLocal();
    emit();
    return getSnapshot();
  }
  function getFirebaseHandles() { return window.PrepPathFirebase || window.PrepPathAdminFirebase || null; }
  async function loadRemote() {
    var handles = getFirebaseHandles();
    if (!handles || !handles.db) return getSnapshot();
    if (handles.auth && !handles.auth.currentUser) return getSnapshot();
    try {
      var snap = await handles.db.collection('config').doc('turbo').get();
      if (snap.exists) {
        var data = snap.data() || {};
        applyConfig({ servers: data.backendServers, mode: data.backendMode, manualServerId: data.backendManualServerId }, false);
        state.remoteLoaded = true;
        emit();
      }
    } catch (e) {}
    return getSnapshot();
  }
  function withTimeout(signal, ms) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, ms || 9000);
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', function () { controller.abort(); }, { once: true });
    }
    return { signal: controller.signal, clear: function () { clearTimeout(timer); } };
  }
  async function request(path, options) {
    options = Object.assign({}, options || {});
    var isImageGeneration = String(path || '').split('?', 1)[0] === '/api/ai-chat/image';
    var servers = orderedServers();
    if (!servers.length) throw new Error('No backend servers are configured.');
    var lastError = null;
    var attempts = [];
    for (var i = 0; i < servers.length; i += 1) {
      var server = servers[i];
      var timed = withTimeout(options.signal, options.timeoutMs || 12000);
      var requestOptions = Object.assign({}, options, { signal: timed.signal });
      delete requestOptions.timeoutMs;
      try {
        var response = await window.fetch(server.url + (String(path || '').charAt(0) === '/' ? path : '/' + path), requestOptions);
        timed.clear();
        var imageApplicationFailure = false;
        if (isImageGeneration && (response.status === 502 || response.status === 503) &&
            (response.headers.get('content-type') || '').toLowerCase().indexOf('application/json') >= 0) {
          try {
            var imageErrorPayload = await response.clone().json();
            imageApplicationFailure = !!(imageErrorPayload && [
              'image_failed', 'image_not_configured', 'omniroute_unavailable', 'image_edit_not_configured'
            ].indexOf(String(imageErrorPayload.error || '')) >= 0);
          } catch (ignore) {}
        }
        // Return recognized application errors without replaying a non-idempotent
        // generation. HTML/plain infrastructure 502/503 responses still fail
        // over, including Render's suspended-service page.
        if (response.ok || imageApplicationFailure ||
            (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429)) {
          mark(server, true, 'HTTP ' + response.status);
          return response;
        }
        var responseDetail = await responseErrorDetail(response);
        lastError = new Error('HTTP ' + response.status + ' from ' + server.label + (responseDetail ? ': ' + responseDetail : ''));
        attempts.push(lastError.message);
        mark(server, false, lastError.message);
      } catch (error) {
        timed.clear();
        // AbortController produces a browser-specific AbortError. Normalize it
        // so the UI can distinguish a slow/cold backend from an offline client.
        if (error && error.name === 'AbortError') {
          lastError = new Error('Request timed out after ' + (options.timeoutMs || 12000) + ' ms from ' + server.label);
        } else {
          lastError = new Error((error && error.message ? error.message : 'Network error') + ' from ' + server.label);
        }
        attempts.push(lastError.message);
        mark(server, false, lastError && lastError.message ? lastError.message : 'Network error');
      }
    }
    if (attempts.length > 1) {
      throw new Error('All backend servers failed: ' + attempts.join(' | ').slice(0, 900));
    }
    throw lastError || new Error('All backend servers failed.');
  }
  async function probe(server) {
    var target = typeof server === 'string' ? state.servers.find(function (item) { return item.id === server || item.url === server; }) : server;
    if (!target) return null;
    var timed = withTimeout(null, 8000);
    try {
      var response = await window.fetch(target.url + '/health', { method: 'GET', cache: 'no-store', signal: timed.signal });
      timed.clear();
      var detail = 'HTTP ' + response.status;
      mark(target, response.ok, detail);
      return { id: target.id, ok: response.ok, status: response.status, detail: detail };
    } catch (e) {
      timed.clear();
      mark(target, false, e && e.message ? e.message : 'Network error');
      return { id: target.id, ok: false, status: 0, detail: e && e.message ? e.message : 'Network error' };
    }
  }
  async function probeAll() { return Promise.all(state.servers.map(probe)); }
  function baseUrl() { return (orderedServers()[0] || DEFAULT_SERVERS[0]).url; }
  function configure(config, persist) { return applyConfig(config, persist); }
  async function responseErrorDetail(response) {
    if (!response || response.ok) return '';
    try {
      var clone = response.clone();
      var contentType = String(clone.headers.get('content-type') || '').toLowerCase();
      if (contentType.indexOf('json') >= 0) {
        var payload = await clone.json();
        if (payload && typeof payload === 'object') {
          var detail = payload.detail || payload.message || payload.error;
          if (detail && typeof detail === 'object') detail = detail.message || detail.detail || JSON.stringify(detail);
          if (detail) return String(detail).replace(/\s+/g, ' ').slice(0, 420);
        }
      } else {
        var text = await clone.text();
        if (text && !/^<!doctype html|^<html/i.test(text.trim())) return text.replace(/\s+/g, ' ').slice(0, 420);
      }
    } catch (e) {}
    return '';
  }

  readLocal();
  function bindAuth() {
    var handles = getFirebaseHandles();
    if (!handles || !handles.auth || state.authBound) return;
    state.authBound = true;
    handles.auth.onAuthStateChanged(function (user) { if (user) loadRemote(); });
  }
  window.PrepPathBackend = Object.freeze({
    fetch: request,
    probe: probe,
    probeAll: probeAll,
    loadRemote: loadRemote,
    configure: configure,
    getConfig: getSnapshot,
    baseUrl: baseUrl,
    defaults: DEFAULT_SERVERS.slice()
  });
  if (window.addEventListener) {
    window.addEventListener('preppath:firebase-ready', function () {
      bindAuth();
      Promise.resolve(loadRemote()).then(function () { return probeAll(); }).catch(function () {});
    });
    bindAuth();
    setTimeout(function () {
      bindAuth();
      Promise.resolve(loadRemote()).then(function () { return probeAll(); }).catch(function () {});
    }, 900);
  }
})();

/* Firebase core exposes these handles after initialization so the router can
   load the admin-owned config without duplicating Firebase initialization. */
