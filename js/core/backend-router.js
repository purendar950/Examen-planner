/* StudyPlanner backend registry.
   A single routing layer keeps Turbo, AI Chat, tutor, Telegram helpers, and admin
   tools on the same policy: automatic/manual failover or one admin-enforced
   server. Configuration is admin-owned in config/turbo; localStorage remains a
   compatibility fallback only. */
(function () {
  'use strict';

  var DEFAULT_SERVERS = [
    { id: 'render-primary', label: 'Render primary', url: 'https://youtube-turbo-proxy-gej4.onrender.com', enabled: true },
    { id: 'render-secondary', label: 'Render backup', url: 'https://youtube-turbo-proxy.onrender.com', enabled: true }
  ];
  var STORAGE_KEY = 'preppath_backend_registry_v1';
  var state = {
    servers: DEFAULT_SERVERS.slice(),
    mode: 'auto',
    manualServerId: '',
    remoteLoaded: false,
    remoteUid: '',
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
        state.mode = saved.mode === 'strict' ? 'strict' : (saved.mode === 'manual' ? 'manual' : 'auto');
        state.manualServerId = String(saved.manualServerId || '');
        state.activeId = state.mode === 'strict' ? state.manualServerId : String(saved.activeId || '');
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
    return state.mode !== 'manual' && state.mode !== 'strict' && Number(state.cooldownUntil[server.id] || 0) > Date.now();
  }
  function orderedServers() {
    var all = enabledServers();
    // Strict mode is an admin-enforced route, not a preference. Return only the
    // selected enabled server and fail closed when that selection is missing.
    // Never let cooldown recovery or active-server affinity reintroduce backups.
    if (state.mode === 'strict') {
      return all.filter(function (server) { return server.id === state.manualServerId; }).slice(0, 1);
    }
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
      // Health-checking every registered server must not change the route in
      // strict mode. Only the admin-selected server can become active there.
      if (state.mode !== 'strict' || server.id === state.manualServerId) state.activeId = server.id;
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
    if (config.mode === 'strict' || config.mode === 'manual' || config.mode === 'auto') state.mode = config.mode;
    if (config.manualServerId != null) state.manualServerId = String(config.manualServerId || '');
    if (!state.servers.some(function (server) { return server.id === state.manualServerId; })) state.manualServerId = '';
    if (state.mode === 'strict') state.activeId = state.manualServerId;
    if (persist !== false) writeLocal();
    emit();
    return getSnapshot();
  }
  function getFirebaseHandles() { return window.PrepPathFirebase || window.PrepPathAdminFirebase || null; }
  var remoteLoadPromise = null;
  var policyUnsubscribe = null;
  var policyGeneration = 0;

  function waitForInitialAuth(handles) {
    if (!handles || !handles.auth) return Promise.resolve();
    if (handles.authReady && typeof handles.authReady.then === 'function') return handles.authReady;
    return new Promise(function (resolve, reject) {
      var stop = function () {};
      stop = handles.auth.onAuthStateChanged(function () { stop(); resolve(); }, function (error) { stop(); reject(error); });
    });
  }
  function authoritativeConfig(snap) {
    var data = snap && snap.exists ? (snap.data() || {}) : {};
    return {
      servers: Array.isArray(data.backendServers) && data.backendServers.length ? data.backendServers : DEFAULT_SERVERS,
      mode: data.backendMode === 'strict' ? 'strict' : (data.backendMode === 'manual' ? 'manual' : 'auto'),
      manualServerId: data.backendManualServerId == null ? '' : String(data.backendManualServerId)
    };
  }
  function applyAuthoritativeSnapshot(snap) {
    applyConfig(authoritativeConfig(snap), true);
    state.remoteLoaded = true;
    emit();
    return getSnapshot();
  }
  function stopPolicySubscription() {
    if (policyUnsubscribe) {
      try { policyUnsubscribe(); } catch (e) {}
      policyUnsubscribe = null;
    }
  }
  function resetRemotePolicy(uid) {
    policyGeneration += 1;
    stopPolicySubscription();
    remoteLoadPromise = null;
    state.remoteLoaded = false;
    state.remoteUid = String(uid || '');
    emit();
  }
  function subscribePolicy(handles, uid, generation) {
    if (policyUnsubscribe || !handles || !handles.db) return;
    var ref = handles.db.collection('config').doc('turbo');
    policyUnsubscribe = ref.onSnapshot({ includeMetadataChanges: true }, function (snap) {
      if (generation !== policyGeneration || state.remoteUid !== uid) return;
      // Local cache and pending Admin writes are not authoritative. The Admin
      // policy becomes active in this tab only after Firestore confirms it.
      if (snap.metadata && (snap.metadata.fromCache || snap.metadata.hasPendingWrites)) return;
      applyAuthoritativeSnapshot(snap);
    }, function (error) {
      if (generation !== policyGeneration) return;
      console.warn('[backend] policy subscription failed:', error && (error.code || error.message) || error);
      stopPolicySubscription();
      state.remoteLoaded = false;
      emit();
    });
  }
  async function loadRemote() {
    var handles = getFirebaseHandles();
    if (!handles || !handles.db) return getSnapshot();
    await waitForInitialAuth(handles);
    var user = handles.auth && handles.auth.currentUser;
    if (handles.auth && !user) throw new Error('Please sign in before using the backend service.');
    var uid = user ? String(user.uid || '') : 'no-auth-provider';
    if (state.remoteUid !== uid) resetRemotePolicy(uid);
    if (state.remoteLoaded) return getSnapshot();
    if (remoteLoadPromise) return remoteLoadPromise;
    var generation = policyGeneration;
    var ref = handles.db.collection('config').doc('turbo');
    var loadPromise = ref.get({ source: 'server' }).then(function (snap) {
      if (generation !== policyGeneration || state.remoteUid !== uid) return getSnapshot();
      var result = applyAuthoritativeSnapshot(snap);
      subscribePolicy(handles, uid, generation);
      return result;
    });
    remoteLoadPromise = loadPromise;
    return loadPromise.then(function (result) {
      if (remoteLoadPromise === loadPromise) remoteLoadPromise = null;
      return result;
    }, function (error) {
      if (remoteLoadPromise === loadPromise) remoteLoadPromise = null;
      if (generation === policyGeneration) {
        state.remoteLoaded = false;
        emit();
      }
      throw error;
    });
  }
  async function syncRemotePolicyBeforeRequest() {
    var handles = getFirebaseHandles();
    // When Firebase exists, the server-confirmed Admin policy is mandatory.
    // Local/default routing remains only for deployments without Firebase.
    if (handles && handles.db) await loadRemote();
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
    await syncRemotePolicyBeforeRequest();
    var servers = orderedServers();
    if (!servers.length) throw new Error(state.mode === 'strict'
      ? 'The selected backend server is not configured or enabled.'
      : 'No backend servers are configured.');
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
        if (response.ok || (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429)) {
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
  // Explicit Admin diagnostics checks the whole registry; automatic app startup
  // checks only servers that the current policy is allowed to route through.
  async function probeAll() { return Promise.all(state.servers.map(probe)); }
  async function probeRoutable() { return Promise.all(orderedServers().map(probe)); }
  function baseUrl() {
    var selected = orderedServers()[0];
    // Direct media URLs must obey strict mode too; silently returning the old
    // primary here would bypass the admin's selected-server-only policy.
    if (!selected && state.mode === 'strict') return '';
    return (selected || DEFAULT_SERVERS[0]).url;
  }
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
    handles.auth.onAuthStateChanged(function (user) {
      var uid = user ? String(user.uid || '') : '';
      if (state.remoteUid !== uid) resetRemotePolicy(uid);
      if (user) loadRemoteAndProbe();
    });
  }
  function loadRemoteAndProbe() {
    return Promise.resolve(loadRemote()).then(function () {
      return state.remoteLoaded ? probeRoutable() : [];
    }).catch(function (error) {
      // Requests still fail closed and retry the authoritative bootstrap. This
      // startup helper is best-effort so a temporary Firestore outage does not
      // create an unhandled rejection in the page.
      if (error) console.warn('[backend] policy bootstrap failed:', error.code || error.message || error);
    });
  }
  window.PrepPathBackend = Object.freeze({
    fetch: request,
    probe: probe,
    probeAll: probeAll,
    loadRemote: loadRemote,
    syncPolicy: syncRemotePolicyBeforeRequest,
    configure: configure,
    getConfig: getSnapshot,
    baseUrl: baseUrl,
    defaults: DEFAULT_SERVERS.slice()
  });
  if (window.addEventListener) {
    window.addEventListener('preppath:firebase-ready', function () {
      bindAuth();
      loadRemoteAndProbe();
    });
    bindAuth();
    setTimeout(function () {
      bindAuth();
      loadRemoteAndProbe();
    }, 900);
  }
})();

/* Firebase core exposes these handles after initialization so the router can
   load the admin-owned config without duplicating Firebase initialization. */
