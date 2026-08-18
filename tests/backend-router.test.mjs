import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routerSource = readFileSync(resolve(rootDir, 'js/core/backend-router.js'), 'utf8');
const turboSource = readFileSync(resolve(rootDir, 'js/features/turbo-player.js'), 'utf8');
const tutorSource = readFileSync(resolve(rootDir, 'js/features/ai-tutor.js'), 'utf8');
const notebookSource = readFileSync(resolve(rootDir, 'js/tabs/yt-notebook.js'), 'utf8');
const chatSource = readFileSync(resolve(rootDir, 'js/tabs/ai-chat.js'), 'utf8');
const MEDIA = { id: 'render-media', label: 'Render media', url: 'https://media.example.com', enabled: true, routes: ['media'] };
const AI = { id: 'local-ai', label: 'Local AI proxy', url: 'https://ai.example.com', enabled: true, routes: ['ai'] };
const BACKUP = { id: 'backup', label: 'AI backup', url: 'https://backup.example.com', enabled: true, routes: ['ai'] };
const SHARED = { id: 'shared', label: 'Shared proxy', url: 'https://shared.example.com', enabled: true, routes: ['media', 'ai'] };
const MEDIA_BACKUP = { id: 'media-backup', label: 'Media backup', url: 'https://media-backup.example.com', enabled: true, routes: ['media'] };
const legacyServer = server => {
  const { routes, ...legacy } = server;
  return legacy;
};

function response(status = 200, body = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    clone() { return response(status, body); },
    async json() { return body; },
    async text() { return JSON.stringify(body); }
  };
}

function createRouter(fetchImpl, savedLocal = null, remoteData = null) {
  const writes = [];
  const remoteSnapshot = remoteData == null ? null : {
    exists: true,
    data: () => remoteData,
    metadata: { fromCache: false, hasPendingWrites: false }
  };
  const remoteHandles = remoteSnapshot ? {
    authReady: Promise.resolve(),
    auth: { currentUser: { uid: 'user-1' } },
    db: { collection: () => ({ doc: () => ({
      get: async () => remoteSnapshot,
      onSnapshot: () => () => {}
    }) }) }
  } : null;
  const localStorage = {
    getItem(key) { return key === 'preppath_backend_registry_v1' ? savedLocal : null; },
    setItem(key, value) { writes.push({ key, value }); }
  };
  const window = {
    fetch: fetchImpl,
    dispatchEvent() {},
    PrepPathFirebase: remoteHandles,
    PrepPathAdminFirebase: null
  };
  vm.runInNewContext(routerSource, {
    window,
    localStorage,
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    AbortController,
    URL,
    Date,
    Promise,
    Object,
    Array,
    String,
    Number,
    RegExp,
    JSON,
    setTimeout,
    clearTimeout,
    console: { log() {}, warn() {}, error() {} }
  });
  return { api: window.PrepPathBackend, writes };
}

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(`  ✓ ${name}`); }
  catch (error) { results.push(`  ✗ ${name}\n    ${error.message}`); process.exitCode = 1; }
}

await test('classifies transcript/Turbo as media and all AI prefixes as AI', async () => {
  const { api } = createRouter(async () => response());
  const cases = [
    ['/api/info?id=x', 'media'],
    ['/api/transcript?id=x', 'media'],
    ['/api/stream?id=x', 'media'],
    ['/tg-photo?file_id=x', 'media'],
    ['/send-photo', 'media'],
    ['/health', 'media'],
    ['/api/study', 'ai'],
    ['/api/study/jobs/abc/stream?token=x', 'ai'],
    ['/api/tutor/stream', 'ai'],
    ['/api/tutor/library/prepare', 'ai'],
    ['/api/tutor/memory-update', 'ai'],
    ['/api/ai-chat', 'ai'],
    ['/api/ai-chat/video/jobs/abc/media', 'ai'],
    ['/api/admin/model-catalogs/sync', 'ai'],
    ['/api/status', 'ai']
  ];
  for (const [path, expected] of cases) assert.equal(api.routeForPath(path), expected, path);
});

await test('strict role routing never crosses Render media and AI proxy traffic', async () => {
  const calls = [];
  const { api } = createRouter(async (url, options) => {
    calls.push({ url, options });
    return response(200);
  });
  api.configure({
    servers: [MEDIA, AI],
    mediaMode: 'strict', mediaServerId: MEDIA.id,
    aiMode: 'strict', aiServerId: AI.id
  }, false);

  await api.fetch('/api/transcript?id=video');
  await api.fetch('/api/info?id=video');
  await api.fetch('/api/study/jobs');
  await api.fetch('/api/tutor/stream');
  await api.fetch('/api/ai-chat/stream');

  assert.deepEqual(calls.map(call => call.url), [
    'https://media.example.com/api/transcript?id=video',
    'https://media.example.com/api/info?id=video',
    'https://ai.example.com/api/study/jobs',
    'https://ai.example.com/api/tutor/stream',
    'https://ai.example.com/api/ai-chat/stream'
  ]);
  assert.equal(api.baseUrl('media'), MEDIA.url);
  assert.equal(api.baseUrl('ai'), AI.url);
  assert.equal(api.baseUrl(), MEDIA.url, 'legacy direct URLs remain on the media route');
});

await test('strict AI failure is fail-closed and never tries the media server', async () => {
  const calls = [];
  const { api } = createRouter(async url => {
    calls.push(url);
    throw new Error('offline');
  });
  api.configure({
    servers: [MEDIA, AI],
    mediaMode: 'strict', mediaServerId: MEDIA.id,
    aiMode: 'strict', aiServerId: AI.id
  }, false);
  await assert.rejects(() => api.fetch('/api/study', { timeoutMs: 20 }), /offline from Local AI proxy/);
  assert.deepEqual(calls, ['https://ai.example.com/api/study']);
});

await test('manual AI preference can fail over without changing the media route', async () => {
  const calls = [];
  const { api } = createRouter(async url => {
    calls.push(url);
    if (url.startsWith(AI.url)) throw new Error('AI proxy sleeping');
    return response(200);
  });
  api.configure({
    servers: [MEDIA, AI, BACKUP],
    mediaMode: 'strict', mediaServerId: MEDIA.id,
    aiMode: 'manual', aiServerId: AI.id
  }, false);
  await api.fetch('/api/ai-chat/stream');
  assert.deepEqual(calls.slice(0, 2), [AI.url + '/api/ai-chat/stream', BACKUP.url + '/api/ai-chat/stream']);
  assert.equal(api.baseUrl('media'), MEDIA.url);
});

await test('manual failover reports its server and stateful affinity never crosses hosts', async () => {
  const calls = [];
  const optionSnapshots = [];
  const { api } = createRouter(async (url, options) => {
    calls.push(url);
    optionSnapshots.push({ ...options });
    if (url.startsWith(AI.url)) throw new Error('preferred AI unavailable');
    return response(url.includes('/poll') ? 404 : 200);
  });
  api.configure({
    servers: [MEDIA, AI, BACKUP],
    mediaMode: 'strict', mediaServerId: MEDIA.id,
    aiMode: 'manual', aiServerId: AI.id
  }, false);

  const created = await api.fetch('/api/study/jobs', { method: 'POST' });
  assert.deepEqual(JSON.parse(JSON.stringify(api.serverForResponse(created))), { id: BACKUP.id, url: BACKUP.url, route: 'ai' });
  calls.length = 0;
  const polled = await api.fetch('/api/study/jobs/abc/poll', {
    backendRoute: 'ai', backendServerId: BACKUP.id, timeoutMs: 25, cache: 'no-store'
  });
  assert.equal(polled.status, 404, 'the owner response is returned without fallback');
  assert.deepEqual(calls, [BACKUP.url + '/api/study/jobs/abc/poll']);
  const sent = optionSnapshots.at(-1);
  assert.equal(Object.hasOwn(sent, 'backendRoute'), false);
  assert.equal(Object.hasOwn(sent, 'backendServerId'), false);
  assert.equal(Object.hasOwn(sent, 'timeoutMs'), false);
  assert.equal(sent.cache, 'no-store');

  await assert.rejects(
    () => api.fetch('/api/study/jobs/abc', { backendServerId: MEDIA.id }),
    /no longer available for the selected route/
  );
  assert.deepEqual(calls, [BACKUP.url + '/api/study/jobs/abc/poll'], 'wrong-role affinity fails before fetch');
});

await test('a server is reserved before stateful creation and cannot fail over', async () => {
  const calls = [];
  const { api } = createRouter(async url => {
    calls.push(url);
    throw new Error('response lost');
  });
  api.configure({
    servers: [AI, BACKUP],
    mediaMode: 'auto', mediaServerId: '',
    aiMode: 'manual', aiServerId: AI.id
  }, false);
  const owner = await api.selectServer('ai');
  assert.deepEqual(JSON.parse(JSON.stringify(owner)), { id: AI.id, url: AI.url, route: 'ai' });
  await assert.rejects(
    () => api.fetch('/api/study/jobs', { method: 'POST', backendServerId: owner.id }),
    /response lost from Local AI proxy/
  );
  assert.deepEqual(calls, [AI.url + '/api/study/jobs']);
});

await test('shared proxy diagnostics propagate failure cooldown to both roles', async () => {
  const calls = [];
  const { api } = createRouter(async url => {
    calls.push(url);
    if (url === SHARED.url + '/health') return response(503);
    return response(200);
  });
  api.configure({
    servers: [SHARED, MEDIA_BACKUP, BACKUP],
    mediaMode: 'auto', mediaServerId: '',
    aiMode: 'auto', aiServerId: ''
  }, false);
  const result = await api.probeRoutes(SHARED);
  assert.equal(result.ok, false);
  calls.length = 0;
  await api.fetch('/api/info?id=x');
  await api.fetch('/api/study/jobs/x');
  assert.deepEqual(calls, [
    MEDIA_BACKUP.url + '/api/info?id=x',
    BACKUP.url + '/api/study/jobs/x'
  ]);
});

await test('strict policy cannot be bypassed by a stale job affinity', async () => {
  const calls = [];
  const { api } = createRouter(async url => { calls.push(url); return response(200); });
  api.configure({
    servers: [AI, BACKUP],
    mediaMode: 'auto', mediaServerId: '',
    aiMode: 'strict', aiServerId: AI.id
  }, false);
  await assert.rejects(
    () => api.fetch('/api/ai-chat/video/jobs/old', { backendServerId: BACKUP.id }),
    /no longer available for the selected route/
  );
  assert.equal(calls.length, 0);
});

await test('persisted split registry leaves legacy storage media-only', async () => {
  const { api, writes } = createRouter(async () => response());
  api.configure({
    servers: [MEDIA, AI, BACKUP],
    mediaMode: 'manual', mediaServerId: MEDIA.id,
    aiMode: 'manual', aiServerId: AI.id
  }, true);
  const saved = JSON.parse(writes.at(-1).value);
  assert.deepEqual(saved.splitServers.map(server => server.id), [MEDIA.id, AI.id, BACKUP.id]);
  assert.deepEqual(saved.servers.map(server => server.id), [MEDIA.id]);
  assert.equal(saved.mode, 'manual');
  assert.equal(saved.manualServerId, MEDIA.id);
});

await test('stateful AI creation and every follow-up retain server affinity', async () => {
  assert.match(tutorSource, /reserveBackendServer\('ai', job\.backendServerId\)[\s\S]*?saveStudyJob\(job\)[\s\S]*?backendAuthFetch\('\/api\/study\/jobs'/);
  assert.match(tutorSource, /streamOptions\.backendServerId = cfg\.backendServerId/);
  assert.match(tutorSource, /requestStudyJobStop\(jobId, attempt \+ 1, backendServerId\)/);
  assert.match(tutorSource, /reserveBackendServer\('ai', preparationServerId\(courseId\)\)/);
  assert.match(tutorSource, /method: 'DELETE', backendServerId: backendServerId/);
  assert.match(notebookSource, /kit\.reserveServer\('ai', job\.backendServerId\)[\s\S]*?ytnbSaveJob\(job\)[\s\S]*?kit\.authFetch\('\/api\/study\/bundles'/);
  assert.match(notebookSource, /backendServerId: job\.backendServerId \|\| ''[\s\S]*?method: 'DELETE'/);
  assert.match(chatSource, /selectServer\('ai'\)[\s\S]*?starting: true[\s\S]*?backendAuthFetch\('\/api\/ai-chat\/video\/jobs'/);
  assert.match(chatSource, /video\/jobs\/[\s\S]*?timeoutMs: 15000, backendServerId: backendServerId/);
  assert.match(chatSource, /\/media'[\s\S]*?backendServerId: backendServerId/);
});

await test('Turbo stream URL stays on the server that returned info', async () => {
  const start = turboSource.indexOf("var infoPath = '/api/info");
  const end = turboSource.indexOf("candidate.addEventListener('loadedmetadata'", start);
  const handoff = turboSource.slice(start, end);
  assert.match(handoff, /serverForResponse\(r\)/);
  assert.match(handoff, /var streamBase = res\.owner\.url/);
  assert.doesNotMatch(handoff, /baseUrl\('media'\)/);
});

await test('an internal route override is honored but never forwarded to fetch', async () => {
  let seen;
  const { api } = createRouter(async (url, options) => {
    seen = { url, options };
    return response(200);
  });
  api.configure({
    servers: [MEDIA, AI],
    mediaMode: 'strict', mediaServerId: MEDIA.id,
    aiMode: 'strict', aiServerId: AI.id
  }, false);
  await api.fetch('/health', { backendRoute: 'ai', cache: 'no-store' });
  assert.equal(seen.url, AI.url + '/health');
  assert.equal(Object.hasOwn(seen.options, 'backendRoute'), false);
  assert.equal(seen.options.cache, 'no-store');
});

await test('legacy one-policy configuration automatically applies to both roles', async () => {
  const { api } = createRouter(async () => response());
  const snapshot = api.configure({ servers: [legacyServer(MEDIA), legacyServer(AI)], mode: 'strict', manualServerId: MEDIA.id }, false);
  assert.equal(snapshot.mediaMode, 'strict');
  assert.equal(snapshot.aiMode, 'strict');
  assert.equal(snapshot.mediaServerId, MEDIA.id);
  assert.equal(snapshot.aiServerId, MEDIA.id);
  assert.equal(api.baseUrl('media'), MEDIA.url);
  assert.equal(api.baseUrl('ai'), MEDIA.url);
});

await test('authoritative split documents prefer the full tagged registry', async () => {
  const { api } = createRouter(async () => response(), null, {
    backendSplitServers: [MEDIA, AI, BACKUP],
    backendServers: [MEDIA],
    backendMode: 'manual',
    backendManualServerId: MEDIA.id,
    backendMediaMode: 'strict',
    backendMediaServerId: MEDIA.id,
    backendAiMode: 'strict',
    backendAiServerId: AI.id
  });
  const snapshot = await api.loadRemote();
  assert.deepEqual(Array.from(snapshot.servers, server => server.id), [MEDIA.id, AI.id, BACKUP.id]);
  assert.equal(api.baseUrl('media'), MEDIA.url);
  assert.equal(api.baseUrl('ai'), AI.url);
});

await test('authoritative legacy documents still map one registry and policy to both roles', async () => {
  const legacyMedia = legacyServer(MEDIA);
  const legacyAi = legacyServer(AI);
  const { api } = createRouter(async () => response(), null, {
    backendServers: [legacyMedia, legacyAi],
    backendMode: 'strict',
    backendManualServerId: AI.id
  });
  const snapshot = await api.loadRemote();
  assert.equal(snapshot.mediaMode, 'strict');
  assert.equal(snapshot.aiMode, 'strict');
  assert.equal(snapshot.mediaServerId, AI.id);
  assert.equal(snapshot.aiServerId, AI.id);
  assert.equal(api.baseUrl('media'), AI.url);
  assert.equal(api.baseUrl('ai'), AI.url);
});

await test('old localStorage shape migrates both roles without a rewrite requirement', async () => {
  const saved = JSON.stringify({ servers: [legacyServer(MEDIA), legacyServer(AI)], mode: 'manual', manualServerId: AI.id, activeId: MEDIA.id });
  const { api } = createRouter(async () => response(), saved);
  const snapshot = api.getConfig();
  assert.equal(snapshot.mediaMode, 'manual');
  assert.equal(snapshot.aiMode, 'manual');
  assert.equal(snapshot.mediaServerId, AI.id);
  assert.equal(snapshot.aiServerId, AI.id);
});

/* Request budgets. The reported bug was an AI tutor answer that always failed
   with "Request timed out after 12000 ms": the router applied one flat
   media-sized budget to every route, so the abort always fired while the model
   was still generating. Aborting the fetch immediately lets these assert the
   resolved budget through the public error message without real waiting. */
function abortError() {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}
function splitRouter(fetchImpl) {
  const { api } = createRouter(fetchImpl);
  api.configure({
    servers: [MEDIA, AI],
    mediaMode: 'strict', mediaServerId: MEDIA.id,
    aiMode: 'strict', aiServerId: AI.id
  }, false);
  return api;
}

await test('AI generation gets a longer budget than the media route', async () => {
  const api = splitRouter(async () => { throw abortError(); });
  await assert.rejects(api.fetch('/api/tutor/stream', { method: 'POST' }),
    /timed out after 45000 ms from Local AI proxy/);
  // The media route must keep failing over fast — it is not LLM work.
  await assert.rejects(api.fetch('/api/transcript?id=x'),
    /timed out after 12000 ms from Render media/);
});

await test('an explicit timeout is honoured and reported, never a hardcoded default', async () => {
  const api = splitRouter(async () => { throw abortError(); });
  // The message used to print `options.timeoutMs || 12000` independently of the
  // timer, so an overridden budget was reported as 12000 and read as a bug.
  await assert.rejects(api.fetch('/api/tutor', { method: 'POST', timeoutMs: 180000 }),
    /timed out after 180000 ms from Local AI proxy/);
  await assert.rejects(api.fetch('/api/info?id=x', { timeoutMs: 3000 }),
    /timed out after 3000 ms from Render media/);
});

await test('the timeout is consumed by the router and never forwarded to fetch', async () => {
  let seen;
  const api = splitRouter(async (url, options) => { seen = options; return response(200); });
  await api.fetch('/api/tutor', { method: 'POST', timeoutMs: 180000 });
  assert.equal(Object.hasOwn(seen, 'timeoutMs'), false);
  assert.ok(seen.signal, 'the router still supplies its own abort signal');
});

await test('the tutor sends its own budgets for streaming and one-shot generation', async () => {
  // A stream only needs to *start* before the deadline, so it carries the
  // connect-time budget; the one-shot reply has to finish generating before any
  // headers arrive, so it carries the full generation budget.
  assert.match(tutorSource, /var STREAM_START_TIMEOUT_MS = (\d+);/);
  assert.match(tutorSource, /var GENERATION_TIMEOUT_MS = (\d+);/);
  const streamBudget = Number(/var STREAM_START_TIMEOUT_MS = (\d+);/.exec(tutorSource)[1]);
  const generationBudget = Number(/var GENERATION_TIMEOUT_MS = (\d+);/.exec(tutorSource)[1]);
  assert.ok(streamBudget >= 60000, 'a stream must survive a cold start');
  assert.ok(generationBudget > streamBudget, 'a full generation needs more room than a connect');
  assert.match(tutorSource, /backendAuthFetch\(streamPath,[\s\S]{0,500}?timeoutMs: STREAM_START_TIMEOUT_MS/);
  assert.match(tutorSource, /backendAuthFetch\(oncePath \|\| '\/api\/tutor',[\s\S]{0,500}?timeoutMs: GENERATION_TIMEOUT_MS/);
  // Synchronous study generation shares the one-shot failure mode.
  assert.match(tutorSource, /function apiGet\(path, signal, timeoutMs\)/);
  assert.ok(/apiGet\([^)]*GENERATION_TIMEOUT_MS\)/.test(tutorSource), 'study generation passes the budget');
});

await test('a transport failure reaches the student as advice, not a proxy label', async () => {
  // The chat used to persist `String(error)`, e.g. "Error: Request timed out
  // after 12000 ms from render storebook", which blames the student's question.
  assert.match(tutorSource, /function tutorErrorMessage\(error\)/);
  assert.match(tutorSource, /catch\(function \(e\) \{\s*var answer = tutorErrorMessage\(e\);/);
  const message = /if \(\/timed out\|abort\/i\.test\(raw\)\) \{\s*return '([^']*)' \+\s*'([^']*)';/.exec(tutorSource);
  assert.ok(message, 'the timeout branch returns a student-facing string');
  const text = message[1] + message[2];
  assert.doesNotMatch(text, /\d{4,} ?ms|storebook/, 'no millisecond counts or server labels');
  assert.match(text, /ask again/i, 'it tells the student what to do next');
});

console.log('Independent backend role routing');
console.log(results.join('\n'));
if (!process.exitCode) console.log(`\n${results.length} checks passed`);
