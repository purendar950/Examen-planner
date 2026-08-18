/* StudyPlanner backend registry.
   Turbo/transcript traffic and AI generation can use independent full-proxy
   routes from the same Admin-owned registry. Legacy configuration still maps
   both roles to one policy, so older config/turbo documents keep working. */
(function () {
  'use strict';

  var DEFAULT_SERVERS = [
    { id: 'render-primary', label: 'Render primary', url: 'https://youtube-turbo-proxy-gej4.onrender.com', enabled: true, routes: ['media', 'ai'] },
    { id: 'render-secondary', label: 'Render backup', url: 'https://youtube-turbo-proxy.onrender.com', enabled: true, routes: ['media', 'ai'] }
  ];
  var STORAGE_KEY = 'preppath_backend_registry_v1';
  var responseServers = new WeakMap();
  var state = {
    servers: DEFAULT_SERVERS.slice(),
    mediaMode: 'auto',
    mediaServerId: '',
    aiMode: 'auto',
    aiServerId: '',
    remoteLoaded: false,
    remoteUid: '',
    authBound: false,
    activeIds: { media: '', ai: '' },
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
  function normalizeMode(value) {
    return value === 'strict' ? 'strict' : (value === 'manual' ? 'manual' : 'auto');
  }
  function normalizeRouteKind(value) {
    return value === 'ai' ? 'ai' : 'media';
  }
  function normalizeRoutes(value, fallback) {
    var explicit = Array.isArray(value);
    var source = explicit ? value : (Array.isArray(fallback) ? fallback : ['media', 'ai']);
    var routes = [];
    source.forEach(function (route) {
      route = route === 'ai' ? 'ai' : (route === 'media' ? 'media' : '');
      if (route && routes.indexOf(route) === -1) routes.push(route);
    });
    return routes.length ? routes : (explicit ? [] : ['media', 'ai']);
  }
  function normalizeServers(input, fallbackRoutes) {
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
      out.push({
        id: id,
        label: String(item.label || id).slice(0, 80),
        url: url,
        enabled: item.enabled !== false,
        routes: normalizeRoutes(item.routes, fallbackRoutes)
      });
    });
    return out.length ? out.slice(0, 12) : DEFAULT_SERVERS.slice();
  }
  function routeMode(routeKind) {
    return normalizeRouteKind(routeKind) === 'ai' ? state.aiMode : state.mediaMode;
  }
  function routeServerId(routeKind) {
    return normalizeRouteKind(routeKind) === 'ai' ? state.aiServerId : state.mediaServerId;
  }
  function routeStateKey(routeKind, serverId) {
    return normalizeRouteKind(routeKind) + ':' + serverId;
  }
  function readLocal() {
    try {
      var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved && (Array.isArray(saved.splitServers) || Array.isArray(saved.servers))) {
        // New clients keep the full role-tagged registry separately. The legacy
        // `servers` projection is media-only so older tabs cannot call AI hosts.
        state.servers = normalizeServers(Array.isArray(saved.splitServers) ? saved.splitServers : saved.servers);
        var legacyMode = normalizeMode(saved.mode);
        var legacyServerId = String(saved.manualServerId || '');
        state.mediaMode = normalizeMode(saved.mediaMode == null ? legacyMode : saved.mediaMode);
        state.mediaServerId = String(saved.mediaServerId == null ? legacyServerId : saved.mediaServerId || '');
        state.aiMode = normalizeMode(saved.aiMode == null ? legacyMode : saved.aiMode);
        state.aiServerId = String(saved.aiServerId == null ? legacyServerId : saved.aiServerId || '');
        var savedActiveIds = saved.activeIds || {};
        var legacyActiveId = String(saved.activeId || '');
        state.activeIds.media = state.mediaMode === 'strict' ? state.mediaServerId : String(savedActiveIds.media || legacyActiveId);
        state.activeIds.ai = state.aiMode === 'strict' ? state.aiServerId : String(savedActiveIds.ai || legacyActiveId);
      } else {
        var legacy = cleanUrl(localStorage.getItem('turboBackendUrl'));
        if (legacy && legacy !== DEFAULT_SERVERS[0].url) state.servers = normalizeServers([{ id: 'legacy', label: 'Saved server', url: legacy }, DEFAULT_SERVERS[0], DEFAULT_SERVERS[1]]);
      }
    } catch (e) {}
  }
  function writeLocal() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        splitServers: state.servers,
        servers: state.servers.filter(function (server) { return server.routes.indexOf('media') !== -1; }),
        // Keep legacy aliases for older deployed clients. Their registry is the
        // media-only projection above, so auto/manual failover stays on Render.
        mode: state.mediaMode,
        manualServerId: state.mediaServerId,
        activeId: state.activeIds.media,
        mediaMode: state.mediaMode,
        mediaServerId: state.mediaServerId,
        aiMode: state.aiMode,
        aiServerId: state.aiServerId,
        activeIds: state.activeIds
      }));
    } catch (e) {}
  }
  function enabledServers(routeKind) {
    routeKind = normalizeRouteKind(routeKind);
    return state.servers.filter(function (server) {
      return server.enabled !== false && server.routes.indexOf(routeKind) !== -1;
    });
  }
  function serverCooling(server, routeKind) {
    var mode = routeMode(routeKind);
    return mode !== 'manual' && mode !== 'strict' && Number(state.cooldownUntil[routeStateKey(routeKind, server.id)] || 0) > Date.now();
  }
  function orderedServers(routeKind) {
    routeKind = normalizeRouteKind(routeKind);
    var mode = routeMode(routeKind);
    var selectedId = routeServerId(routeKind);
    var all = enabledServers(routeKind);
    // Strict is fail-closed independently for each role. A missing AI proxy can
    // never spill into the Render transcript route, and vice versa.
    if (mode === 'strict') {
      return all.filter(function (server) { return server.id === selectedId; }).slice(0, 1);
    }
    var list = all.filter(function (server) { return !serverCooling(server, routeKind); });
    if (!list.length) list = all.slice();
    if (mode === 'manual' && selectedId) {
      list.sort(function (a, b) { return a.id === selectedId ? -1 : b.id === selectedId ? 1 : 0; });
    } else if (state.activeIds[routeKind]) {
      list.sort(function (a, b) { return a.id === state.activeIds[routeKind] ? -1 : b.id === state.activeIds[routeKind] ? 1 : 0; });
    }
    return list;
  }
  function backendRouteForPath(path) {
    var value = String(path || '');
    try {
      if (/^https?:\/\//i.test(value)) value = new URL(value).pathname;
      else value = value.split(/[?#]/, 1)[0];
    } catch (e) { value = value.split(/[?#]/, 1)[0]; }
    if (/^\/api\/(?:study|tutor|ai-chat)(?:\/|$)/.test(value) ||
        /^\/api\/admin\/model-catalogs(?:\/|$)/.test(value) ||
        value === '/api/status') return 'ai';
    return 'media';
  }
  function emit() {
    try { window.dispatchEvent(new CustomEvent('preppath:backend-status', { detail: getSnapshot() })); } catch (e) {}
  }
  function failureCooldownMs(detail) {
    var text = String(detail || '').toLowerCase();
    if (/503|502|504|service suspended|failed to fetch|networkerror|network error|timed out|timeout|abort/.test(text)) return 120000;
    return 20000;
  }
  function mark(server, ok, detail, routeKind) {
    routeKind = normalizeRouteKind(routeKind);
    state.health[server.id] = { ok: !!ok, detail: detail || '', checkedAt: Date.now(), route: routeKind };
    var key = routeStateKey(routeKind, server.id);
    if (ok) {
      if (routeMode(routeKind) !== 'strict' || server.id === routeServerId(routeKind)) state.activeIds[routeKind] = server.id;
      delete state.cooldownUntil[key];
      writeLocal();
    } else {
      state.cooldownUntil[key] = Date.now() + failureCooldownMs(detail);
    }
    emit();
  }
  function getSnapshot() {
    return {
      servers: state.servers.map(function (server) {
        return Object.assign({}, server, {
          health: state.health[server.id] || null,
          active: server.id === state.activeIds.media || server.id === state.activeIds.ai,
          activeFor: {
            media: server.id === state.activeIds.media,
            ai: server.id === state.activeIds.ai
          }
        });
      }),
      // Legacy aliases continue to describe the media/transcript route.
      mode: state.mediaMode,
      manualServerId: state.mediaServerId,
      activeId: state.activeIds.media,
      mediaMode: state.mediaMode,
      mediaServerId: state.mediaServerId,
      mediaActiveId: state.activeIds.media,
      aiMode: state.aiMode,
      aiServerId: state.aiServerId,
      aiActiveId: state.activeIds.ai,
      activeIds: Object.assign({}, state.activeIds),
      remoteLoaded: state.remoteLoaded
    };
  }
  function applyConfig(config, persist) {
    config = config || {};
    if (Array.isArray(config.servers) && config.servers.length) state.servers = normalizeServers(config.servers);
    var legacyModeProvided = config.mode === 'strict' || config.mode === 'manual' || config.mode === 'auto';
    var legacyMode = legacyModeProvided ? normalizeMode(config.mode) : null;
    if (config.mediaMode === 'strict' || config.mediaMode === 'manual' || config.mediaMode === 'auto') state.mediaMode = config.mediaMode;
    else if (legacyModeProvided) state.mediaMode = legacyMode;
    if (config.aiMode === 'strict' || config.aiMode === 'manual' || config.aiMode === 'auto') state.aiMode = config.aiMode;
    else if (legacyModeProvided) state.aiMode = legacyMode;
    if (config.mediaServerId != null) state.mediaServerId = String(config.mediaServerId || '');
    else if (config.manualServerId != null) state.mediaServerId = String(config.manualServerId || '');
    if (config.aiServerId != null) state.aiServerId = String(config.aiServerId || '');
    else if (config.manualServerId != null) state.aiServerId = String(config.manualServerId || '');
    if (state.mediaMode === 'strict') state.activeIds.media = state.mediaServerId;
    if (state.aiMode === 'strict') state.activeIds.ai = state.aiServerId;
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
    var legacyMode = normalizeMode(data.backendMode);
    var legacyServerId = data.backendManualServerId == null ? '' : String(data.backendManualServerId);
    var splitServers = Array.isArray(data.backendSplitServers) && data.backendSplitServers.length
      ? data.backendSplitServers
      : (Array.isArray(data.backendServers) && data.backendServers.length ? data.backendServers : DEFAULT_SERVERS);
    return {
      servers: splitServers,
      mode: legacyMode,
      manualServerId: legacyServerId,
      mediaMode: data.backendMediaMode == null ? legacyMode : normalizeMode(data.backendMediaMode),
      mediaServerId: data.backendMediaServerId == null ? legacyServerId : String(data.backendMediaServerId || ''),
      aiMode: data.backendAiMode == null ? legacyMode : normalizeMode(data.backendAiMode),
      aiServerId: data.backendAiServerId == null ? legacyServerId : String(data.backendAiServerId || '')
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
  function responseServer(response) {
    var meta = response && responseServers.get(response);
    return meta ? Object.assign({}, meta) : null;
  }
  async function selectServer(routeKind) {
    await syncRemotePolicyBeforeRequest();
    routeKind = normalizeRouteKind(routeKind);
    var selected = orderedServers(routeKind)[0];
    if (!selected) throw new Error(routeMode(routeKind) === 'strict'
      ? 'The selected ' + (routeKind === 'ai' ? 'AI generation' : 'Turbo/transcript') + ' server is not configured or enabled.'
      : 'No backend servers are configured for the ' + routeKind + ' route.');
    return { id: selected.id, url: selected.url, route: routeKind };
  }
  async function request(path, options) {
    options = Object.assign({}, options || {});
    await syncRemotePolicyBeforeRequest();
    var routeKind = normalizeRouteKind(options.backendRoute || backendRouteForPath(path));
    var affinityServerId = String(options.backendServerId || '');
    delete options.backendRoute;
    delete options.backendServerId;
    var servers;
    if (affinityServerId) {
      var strictMismatch = routeMode(routeKind) === 'strict' && routeServerId(routeKind) !== affinityServerId;
      var affinityServer = strictMismatch ? null : enabledServers(routeKind).find(function (server) {
        return server.id === affinityServerId;
      });
      if (!affinityServer) {
        throw new Error('The server that owns this ' + (routeKind === 'ai' ? 'AI job' : 'media request') +
          ' is no longer available for the selected route.');
      }
      // Stateful follow-ups must never cross servers: a 404 elsewhere means
      // "wrong host", not "job gone". Affinity deliberately ignores cooldown.
      servers = [affinityServer];
    } else {
      servers = orderedServers(routeKind);
    }
    if (!servers.length) throw new Error(routeMode(routeKind) === 'strict'
      ? 'The selected ' + (routeKind === 'ai' ? 'AI generation' : 'Turbo/transcript') + ' server is not configured or enabled.'
      : 'No backend servers are configured for the ' + routeKind + ' route.');
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
          responseServers.set(response, { id: server.id, url: server.url, route: routeKind });
          mark(server, true, 'HTTP ' + response.status, routeKind);
          return response;
        }
        var responseDetail = await responseErrorDetail(response);
        lastError = new Error('HTTP ' + response.status + ' from ' + server.label + (responseDetail ? ': ' + responseDetail : ''));
        attempts.push(lastError.message);
        mark(server, false, lastError.message, routeKind);
      } catch (error) {
        timed.clear();
        if (error && error.name === 'AbortError') {
          lastError = new Error('Request timed out after ' + (options.timeoutMs || 12000) + ' ms from ' + server.label);
        } else {
          lastError = new Error((error && error.message ? error.message : 'Network error') + ' from ' + server.label);
        }
        attempts.push(lastError.message);
        mark(server, false, lastError.message || 'Network error', routeKind);
      }
    }
    if (attempts.length > 1) throw new Error('All backend servers failed: ' + attempts.join(' | ').slice(0, 900));
    throw lastError || new Error('All backend servers failed.');
  }
  async function probe(server, routeKind) {
    routeKind = normalizeRouteKind(routeKind);
    var target = typeof server === 'string' ? state.servers.find(function (item) { return item.id === server || item.url === server; }) : server;
    if (!target) return null;
    var timed = withTimeout(null, 8000);
    try {
      var response = await window.fetch(target.url + '/health', { method: 'GET', cache: 'no-store', signal: timed.signal });
      timed.clear();
      var detail = 'HTTP ' + response.status;
      mark(target, response.ok, detail, routeKind);
      return { id: target.id, route: routeKind, ok: response.ok, status: response.status, detail: detail };
    } catch (e) {
      timed.clear();
      mark(target, false, e && e.message ? e.message : 'Network error', routeKind);
      return { id: target.id, route: routeKind, ok: false, status: 0, detail: e && e.message ? e.message : 'Network error' };
    }
  }
  async function probeRoutes(server) {
    var target = typeof server === 'string' ? state.servers.find(function (item) {
      return item.id === server || item.url === server;
    }) : server;
    if (!target) return null;
    var routes = Array.isArray(target.routes) && target.routes.length ? target.routes.slice() : ['media', 'ai'];
    var result = await probe(target, routes[0]);
    if (result) routes.slice(1).forEach(function (routeKind) {
      mark(target, result.ok, result.detail, routeKind);
    });
    return result;
  }
  async function probeAll() { return Promise.all(state.servers.map(probeRoutes)); }
  async function probeRoutable() {
    var targets = [];
    ['media', 'ai'].forEach(function (routeKind) {
      orderedServers(routeKind).forEach(function (server) {
        if (!targets.some(function (target) { return target.id === server.id; })) targets.push(server);
      });
    });
    return Promise.all(targets.map(probeRoutes));
  }
  function baseUrl(routeKind) {
    routeKind = normalizeRouteKind(routeKind);
    var selected = orderedServers(routeKind)[0];
    if (!selected && routeMode(routeKind) === 'strict') return '';
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
      if (error) console.warn('[backend] policy bootstrap failed:', error.code || error.message || error);
    });
  }
  window.PrepPathBackend = Object.freeze({
    fetch: request,
    selectServer: selectServer,
    probe: probe,
    probeRoutes: probeRoutes,
    probeAll: probeAll,
    loadRemote: loadRemote,
    syncPolicy: syncRemotePolicyBeforeRequest,
    configure: configure,
    getConfig: getSnapshot,
    baseUrl: baseUrl,
    serverForResponse: responseServer,
    routeForPath: backendRouteForPath,
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
