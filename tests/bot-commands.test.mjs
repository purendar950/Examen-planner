/*
 * Read-only Telegram command tests.
 *
 * /status /plan /pending /exam /stats /mock all render Firestore state into a
 * chat message. The failure modes that matter are quiet ones: reporting "nothing
 * scheduled" when the truth is "the app never built a digest", comparing a mock
 * against a different paper, mis-stating a plan expiry, or letting a user-typed
 * preset name break the HTML of the whole message.
 *
 * The builders are evaluated from the real bot/bot-server.js against the real
 * scripts/telegram-lib.js, so no bot token or Firebase project is needed.
 *
 * Run with:  npm run test:bot-commands      (also part of `npm run check`)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(rootDir, 'bot/bot-server.js'), 'utf8');
const adminSource = readFileSync(resolve(rootDir, 'js/admin/admin-actions.js'), 'utf8');
const omnirouteLocalUrlCases = JSON.parse(readFileSync(
  resolve(rootDir, 'tests/omniroute-local-url-cases.json'), 'utf8'));
const tgLib = createRequire(import.meta.url)(resolve(rootDir, 'scripts/telegram-lib.js'));

function sourceSection(text, from, to) {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start + 1);
  assert.ok(start !== -1 && end > start, `could not locate section: ${from}`);
  return text.slice(start, end);
}

function section(from, to) {
  return sourceSection(source, from, to);
}

/* Fixed "today" so a countdown or streak cannot drift with the clock. */
const TODAY = '2026-08-08';
const api = vm.runInNewContext(
  section('function accountAppState(', "registerAccountCommand({ name: 'status'")
  + ';({ buildStatusMessage, buildPlanMessage, buildPendingMessage, buildExamMessage,'
  + ' buildStatsMessage, buildMockMessage, collectMockAttempts, calculationStreak,'
  + ' calculationAccuracy, daysBetweenDates, isDateString })',
  {
    tgLib,
    todayIST: () => TODAY,
    isLifetimePlan: plan => !!(plan && String(plan).toLowerCase().includes('lifetime')),
    escapeTelegramHtml: value => String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    FIRESTORE_STATUS: { code: 'ready' },
    describeInstance: () => 'examen-planner-2@abc1234 (instance xyz)',
    console: { log() {}, warn() {}, error() {} }
  }
);

/** Wrap an appState/profile fixture the way Firestore hands it over. */
const account = (appState, profile, extra) => ({
  uid: 'user-1',
  data: Object.assign({ appState: appState || {}, profile: profile || {} }, extra || {})
});

const results = [];
function test(name, fn) {
  try { fn(); results.push(`  ✓ ${name}`); }
  catch (error) { results.push(`  ✗ ${name}\n    ${error.message}`); process.exitCode = 1; }
}
/* Awaited, so an async assertion cannot escape as an unhandled rejection and
   cannot interleave with the next test's request counters. */
async function testAsync(name, fn) {
  try { await fn(); results.push(`  ✓ ${name}`); }
  catch (error) { results.push(`  ✗ ${name}\n    ${error.message}`); process.exitCode = 1; }
}

/* ── /status ─────────────────────────────────────────────────────────────── */
const LINKED = { telegram: { enabled: true, chatId: '555000111', digest: {} } };

test('status distinguishes a lifetime plan, a dated plan, a trial and free', () => {
  const lifetime = api.buildStatusMessage(account(LINKED, { plan: 'pro-lifetime' }));
  assert.match(lifetime, /lifetime/);

  const dated = api.buildStatusMessage(account(LINKED, { plan: 'pro-monthly', planExpiry: '2026-08-18' }));
  assert.match(dated, /10 din baaki/, 'should count days to the plan expiry');

  const expired = api.buildStatusMessage(account(LINKED, { plan: 'pro-monthly', planExpiry: '2026-07-01' }));
  assert.match(expired, /expired/);

  const trial = api.buildStatusMessage(account(LINKED, { trialExpiry: '2026-08-11' }));
  assert.match(trial, /trial · 3 din baaki/);

  assert.match(api.buildStatusMessage(account(LINKED, {})), /Plan: free/);
});

test('status says whether the plan digest is fresh, stale, or never built', () => {
  const fresh = api.buildStatusMessage(account({ telegram: { digest: { [TODAY]: 'Polity' } } }, {}));
  assert.match(fresh, /Aaj ka plan: <b>ready<\/b>/);

  /* The distinction that matters: a missing digest means the app has not been
     opened, not that nothing is scheduled. */
  const stale = api.buildStatusMessage(account({ telegram: { digest: { '2026-08-02': 'Polity' } } }, {}));
  assert.match(stale, /last 2 Aug/);
  assert.match(stale, /App kholo/);

  assert.match(api.buildStatusMessage(account(LINKED, {})), /kabhi banaya nahi/);
});

test('status reports the daily preset, last practice and exam date', () => {
  const text = api.buildStatusMessage(account({
    telegram: { digest: {} },
    examDate: '2026-09-07',
    calculationPractice: {
      presets: [{ id: 'p1', name: 'Tables Blast' }],
      dailyPresetId: 'p1',
      history: [{ date: '2026-08-07', total: 10, firstTryCorrect: 9, reason: 'completed' }]
    }
  }, {}));
  assert.match(text, /Tables Blast/);
  assert.match(text, /7 Aug · 90%/);
  assert.match(text, /30 din baaki/, 'exam countdown');
  assert.match(text, /Firestore <b>ready<\/b>/);
});

test('status nudges when no daily preset is set', () => {
  assert.match(api.buildStatusMessage(account(LINKED, {})), /set nahi hai/);
});

/* ── /plan ───────────────────────────────────────────────────────────────── */
test('plan shows topics, to-dos and videos together', () => {
  const text = api.buildPlanMessage(account({
    telegram: { digest: { [TODAY]: 'Polity — Article 14' } },
    tasks: { [TODAY]: [
      { text: 'Revise percentages' },
      { text: 'Watch DI lecture', type: 'video', videoId: 'abc123', url: 'https://youtu.be/abc123' },
      { text: 'Done thing', done: true }
    ] }
  }, {}));
  assert.match(text, /Article 14/);
  assert.match(text, /Revise percentages/);
  assert.match(text, /Watch DI lecture/);
  assert.match(text, /1 already done/);
});

test('plan separates "nothing scheduled" from "no plan ever built"', () => {
  const scheduledNothing = api.buildPlanMessage(account({ telegram: { digest: { '2026-08-01': 'old' } } }, {}));
  assert.match(scheduledNothing, /kuch scheduled nahi/);

  const neverBuilt = api.buildPlanMessage(account({ telegram: { digest: {} } }, {}));
  assert.match(neverBuilt, /koi plan nahi bana/);
  assert.match(neverBuilt, /app kholo/i);
});

/* ── /pending ────────────────────────────────────────────────────────────── */
test('pending celebrates a finished day and lists an unfinished one', () => {
  const allDone = api.buildPendingMessage(account({ tasks: { [TODAY]: [{ text: 'a', done: true }] } }, {}));
  assert.match(allDone, /Sab complete/);

  const left = api.buildPendingMessage(account({ tasks: { [TODAY]: [{ text: 'Read Polity' }, { text: 'x', done: true }] } }, {}));
  assert.match(left, /Read Polity/);
  assert.match(left, /1 done/);

  assert.match(api.buildPendingMessage(account({}, {})), /kuch track nahi/);
});

test('pending honours the deleted-task ledger', () => {
  /* A task the user deleted must not come back in a chat reply. */
  const text = api.buildPendingMessage(account({
    tasks: { [TODAY]: [{ text: 'Deleted task' }] },
    deletedTaskKeys: ['txt:deleted task']
  }, {}));
  assert.ok(!/Deleted task/.test(text), 'a deleted task was re-surfaced');
});

/* ── /exam ───────────────────────────────────────────────────────────────── */
test('exam counts down, greets exam day, and reports one that has passed', () => {
  assert.match(api.buildExamMessage(account({ examDate: '2026-08-18' }, {})), /<b>10<\/b> din baaki/);
  assert.match(api.buildExamMessage(account({ examDate: TODAY }, {})), /Aaj exam hai/);
  assert.match(api.buildExamMessage(account({ examDate: '2026-01-01' }, {})), /Exam ho gaya/);
  assert.match(api.buildExamMessage(account({}, {})), /Koi exam date set nahi/);
});

test('exam lists other upcoming exams but never past ones', () => {
  const text = api.buildExamMessage(account({
    examDate: '2026-08-18',
    examDates: { cgl: '2026-08-18', chsl: '2026-10-02', mts: '2025-01-01' }
  }, {}));
  assert.match(text, /CHSL/);
  assert.ok(!/MTS/.test(text), 'a past exam should not be listed');
});

/* ── /stats ──────────────────────────────────────────────────────────────── */
test('streak counts back from today and stops at the first gap', () => {
  const history = [
    { date: '2026-08-08', reason: 'completed' },
    { date: '2026-08-07', reason: 'completed' },
    { date: '2026-08-06', reason: 'completed' },
    { date: '2026-08-04', reason: 'completed' }
  ];
  assert.equal(api.calculationStreak(history, TODAY), 3);
  /* An abandoned session does not keep a streak alive. */
  assert.equal(api.calculationStreak([{ date: TODAY, reason: 'time' }], TODAY), 0);
  assert.equal(api.calculationStreak([], TODAY), 0);
});

test('accuracy is first-try correct over total', () => {
  assert.equal(api.calculationAccuracy({ total: 10, firstTryCorrect: 7 }), 70);
  assert.equal(api.calculationAccuracy({ total: 0, firstTryCorrect: 0 }), 0, 'must not divide by zero');
});

test('stats aggregates sessions and flags attempts still syncing', () => {
  const text = api.buildStatsMessage(account({
    calculationPractice: { history: [
      { date: '2026-08-08', presetName: 'Tables', total: 10, firstTryCorrect: 9, reason: 'completed', durationSec: 120 },
      { date: '2026-08-07', presetName: 'Squares', total: 10, firstTryCorrect: 7, reason: 'completed', durationSec: 180 }
    ] }
  }, {}, { calculationAttemptInbox: [{ id: 'a' }, { id: 'b' }] }));
  assert.match(text, /Streak: <b>2<\/b>/);
  assert.match(text, /80%/, 'average of 90 and 70');
  assert.match(text, /Sessions: <b>2<\/b> · 20 questions · 5 min/);
  assert.match(text, /2 attempt sync hone baaki/, 'Mini App attempts are not silently dropped');
});

test('stats invites a first session when there is no history', () => {
  assert.match(api.buildStatsMessage(account({}, {})), /koi practice session nahi/);
});

/* ── /mock ───────────────────────────────────────────────────────────────── */
const MOCKS = {
  mocks: {
    cgl: {
      tier1: [
        { id: '1', name: 'Testbook 12', date: '2026-08-06', total: 132.5, s: {}, weakTopics: ['Syllogism'] },
        { id: '2', name: 'Testbook 13', date: '2026-08-07', total: 145, s: {}, weakTopics: [] }
      ],
      tier2: [{ id: '3', name: 'Tier2 Paper 1', date: '2026-08-08', total: 300, s: {}, weakTopics: [] }]
    }
  }
};

test('mock reports the newest attempt across every exam and tier', () => {
  const attempts = api.collectMockAttempts(MOCKS);
  assert.equal(attempts.length, 3);
  assert.equal(attempts[0].date, '2026-08-08', 'newest first');
  const text = api.buildMockMessage(account(MOCKS, {}));
  assert.match(text, /Tier2 Paper 1/);
  assert.match(text, /Score: <b>300<\/b>/);
});

test('the trend compares only the same exam and tier', () => {
  /* The newest attempt is tier2 with no earlier tier2 paper, so there must be no
     comparison — comparing it against a tier1 score would invent a jump. */
  assert.ok(!/vs pichhla/.test(api.buildMockMessage(account(MOCKS, {}))), 'compared across tiers');

  const sameTier = { mocks: { cgl: { tier1: MOCKS.mocks.cgl.tier1 } } };
  const text = api.buildMockMessage(account(sameTier, {}));
  assert.match(text, /vs pichhla \(6 Aug\): 📈 \+12.5/);
});

test('mock shows weak topics and an average, and handles no data', () => {
  const sameTier = { mocks: { cgl: { tier1: [MOCKS.mocks.cgl.tier1[0]] } } };
  assert.match(api.buildMockMessage(account(sameTier, {})), /Weak: Syllogism/);
  assert.match(api.buildMockMessage(account(MOCKS, {})), /Average: <b>192.5<\/b> over 3 mocks/);
  assert.match(api.buildMockMessage(account({}, {})), /Koi mock test save nahi hua/);
});

test('an undated mock attempt is ignored rather than shown as today', () => {
  const undated = { mocks: { cgl: { tier1: [{ id: '9', name: 'No date', total: 100 }] } } };
  assert.deepEqual(Array.from(api.collectMockAttempts(undated)), []);
});

/* ── untrusted text ──────────────────────────────────────────────────────── */
test('user-typed names cannot break the message HTML', () => {
  const nasty = '<b>oops</b> & co';
  const statusText = api.buildStatusMessage(account({
    telegram: { digest: {} },
    calculationPractice: { presets: [{ id: 'p1', name: nasty }], dailyPresetId: 'p1', history: [] }
  }, {}));
  assert.ok(!statusText.includes('<b>oops</b>'), 'preset name was not escaped');
  assert.match(statusText, /&lt;b&gt;oops&lt;\/b&gt; &amp; co/);

  const mockText = api.buildMockMessage(account({
    mocks: { cgl: { tier1: [{ id: '1', name: nasty, date: TODAY, total: 10, weakTopics: [nasty] }] } }
  }, {}));
  assert.ok(!mockText.includes('<b>oops</b>'), 'mock name was not escaped');
});

/* ── date helpers ────────────────────────────────────────────────────────── */
test('date helpers reject malformed input instead of guessing', () => {
  assert.equal(api.daysBetweenDates(TODAY, '2026-08-18'), 10);
  assert.equal(api.daysBetweenDates(TODAY, 'tomorrow'), null);
  assert.equal(api.isDateString('2026-08-08'), true);
  assert.equal(api.isDateString('8 Aug 2026'), false);
  assert.equal(api.isDateString(undefined), false);
});

/* ── /ask provider routing ───────────────────────────────────────────────── */
/* The admin panel writes a flattened mirror of the selected provider into
   config/ai (studyProvider / studyBaseUrl / studyApiKeys / studyModel /
   studyTransport). /ask reads that mirror rather than hard-coding a provider, so
   OmniRoute's ngrok URL can change without a redeploy. */
let askFetchCalls = [];
let askFetchQueue = [];
const askProcess = { env: {
  OMNIROUTE_LOCAL_URL: '',
  OMNIROUTE_ALLOW_ADMIN_LOCAL_URL: '',
  OMNIROUTE_URL: 'https://env-fallback.ngrok-free.dev/v1/chat/completions'
} };
const askApi = vm.runInNewContext(
  section('const ASK_TIMEOUT_MS', 'bot.onText(/^\\/ask')
  + ';({ studyProviderFromConfig, groqFallbackProvider, callStudyProvider, buildTutorMessages, studyApiKeyList, normalizeOmnirouteBaseUrl, normalizeOmnirouteLocalBaseUrl, resolveOmniroutePublicBaseUrl, resolveOmnirouteBaseUrl, buildFallbackProviderList })',
  {
    /* The real validator, so a base the bot would reject is rejected here too. */
    normalizeAppBaseUrl: value => {
      const candidate = String(value == null ? '' : value).trim().replace(/\/+$/, '');
      if (!candidate) return '';
      try {
        const parsed = new URL(candidate);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
        return candidate;
      } catch (error) { return ''; }
    },
    URL,
    process: askProcess,
    AbortSignal: { timeout: () => undefined },
    fetch: async (url, init) => {
      askFetchCalls.push({ url, init });
      const next = askFetchQueue.shift();
      if (!next) throw new Error('no queued response');
      if (next.throw) throw new Error(next.throw);
      return {
        ok: next.status === 200,
        status: next.status,
        json: async () => next.body || { choices: [{ message: { content: next.answer || '' } }] }
      };
    },
    console: { log() {}, warn() {}, error() {} }
  }
);

const adminOmnirouteApi = vm.runInNewContext(
  sourceSection(adminSource, 'function normalizeOmnirouteBaseUrl(', 'function omnirouteBaseUrl()')
  + ';({ normalizeOmnirouteBaseUrl, normalizeOmnirouteLocalBaseUrl })',
  { URL, OMNIROUTE_RETIRED_BASE_URL: 'https://squeak-earthly-obliged.ngrok-free.dev/v1' }
);

const adminInputs = {
  'study-key-omniroute': { value: 'admin-key' },
  'study-model': { value: 'auto' },
  'study-base-url-omniroute': { value: 'https://precut-uniformly-handsfree.ngrok-free.dev/v1', focus() {} },
  'study-local-base-url-omniroute': { value: 'http://localhost:20128/v1', focus() {} },
  'omniroute-browser-direct': { checked: false }
};
const adminWrites = [];
const adminConfig = {};
const adminSaveApi = vm.runInNewContext(
  sourceSection(adminSource, 'async function saveStudyAiConfig()', '/* ── AI Study controls')
  + ';({ saveStudyAiConfig })',
  {
    selectedStudyProvider: () => 'omniroute',
    STUDY_PROVIDER_ORDER: ['omniroute'],
    STUDY_PROVIDERS: { omniroute: {
      label: 'OmniRoute', baseUrl: '', def: 'auto', transport: 'openai_chat',
      keyField: 'omnirouteApiKeys', modelField: 'omnirouteModel'
    } },
    splitStudyKeys: raw => String(raw || '').split(/[\n,]+/).map(value => value.trim()).filter(Boolean),
    document: { getElementById: id => adminInputs[id] || null },
    normalizeOmnirouteBaseUrl: adminOmnirouteApi.normalizeOmnirouteBaseUrl,
    normalizeOmnirouteLocalBaseUrl: adminOmnirouteApi.normalizeOmnirouteLocalBaseUrl,
    omnirouteBaseUrl: () => 'https://precut-uniformly-handsfree.ngrok-free.dev/v1',
    omnirouteLocalBaseUrl: () => '',
    firebase: { firestore: { FieldValue: { serverTimestamp: () => 'server-time' } } },
    db: { collection: () => ({ doc: () => ({
      set: async payload => { adminWrites.push(JSON.parse(JSON.stringify(payload))); }
    }) }) },
    AI_CONFIG: adminConfig,
    showToast() {}, render() {}
  }
);

const OMNIROUTE_CONFIG = {
  enabled: true,
  studyProvider: 'omniroute',
  omnirouteBaseUrl: 'https://precut-uniformly-handsfree.ngrok-free.dev/v1',
  /* The retired generic mirror must never override the dedicated endpoint. */
  studyBaseUrl: 'https://squeak-earthly-obliged.ngrok-free.dev/v1',
  studyApiKeys: ['key-one', 'key-two'],
  studyModel: 'auto',
  studyTransport: 'openai_chat'
};

test('the selected OmniRoute provider uses the Admin-editable endpoint', () => {
  const provider = askApi.studyProviderFromConfig(OMNIROUTE_CONFIG);
  assert.equal(provider.provider, 'omniroute');
  assert.equal(provider.url, 'https://precut-uniformly-handsfree.ngrok-free.dev/v1/chat/completions');
  assert.equal(provider.model, 'auto');
  assert.deepEqual(Array.from(provider.keys), ['key-one', 'key-two']);
});

test('public OmniRoute validation is identical in Admin and bot', () => {
  for (const [value, expected] of omnirouteLocalUrlCases.publicAccepted) {
    assert.equal(askApi.normalizeOmnirouteBaseUrl(value), expected, value);
    assert.equal(adminOmnirouteApi.normalizeOmnirouteBaseUrl(value), expected, `Admin: ${value}`);
  }
  for (const value of omnirouteLocalUrlCases.publicRejected) {
    assert.equal(askApi.normalizeOmnirouteBaseUrl(value), '', value);
    assert.equal(adminOmnirouteApi.normalizeOmnirouteBaseUrl(value), '', `Admin: ${value}`);
  }
});

test('OmniRoute resolver honors dedicated, legacy, env, then default precedence', () => {
  assert.equal(askApi.resolveOmnirouteBaseUrl(OMNIROUTE_CONFIG),
    'https://precut-uniformly-handsfree.ngrok-free.dev/v1');
  assert.equal(askApi.resolveOmnirouteBaseUrl({
    studyProvider: 'omniroute', studyTransport: 'openai_chat',
    studyBaseUrl: 'https://legacy-live.ngrok-free.dev/v1'
  }), 'https://legacy-live.ngrok-free.dev/v1');
  assert.equal(askApi.resolveOmnirouteBaseUrl({
    studyProvider: 'omniroute', studyBaseUrl: 'https://squeak-earthly-obliged.ngrok-free.dev/v1'
  }), 'https://env-fallback.ngrok-free.dev/v1');
  const previous = askProcess.env.OMNIROUTE_URL;
  askProcess.env.OMNIROUTE_URL = '';
  assert.equal(askApi.resolveOmnirouteBaseUrl({}),
    'https://precut-uniformly-handsfree.ngrok-free.dev/v1');
  askProcess.env.OMNIROUTE_URL = previous;
});

test('a local bot deployment prefers only its private environment override', () => {
  const previous = askProcess.env.OMNIROUTE_LOCAL_URL;
  askProcess.env.OMNIROUTE_LOCAL_URL = 'http://10.74.7.68:20128/v1/chat/completions';
  assert.equal(askApi.resolveOmnirouteBaseUrl(OMNIROUTE_CONFIG),
    'http://10.74.7.68:20128/v1');
  assert.equal(askApi.resolveOmniroutePublicBaseUrl(OMNIROUTE_CONFIG),
    'https://precut-uniformly-handsfree.ngrok-free.dev/v1');
  assert.equal(askApi.studyProviderFromConfig(OMNIROUTE_CONFIG).url,
    'http://10.74.7.68:20128/v1/chat/completions');
  askProcess.env.OMNIROUTE_LOCAL_URL = previous;
});

test('local OmniRoute validation is identical in Admin and bot', () => {
  for (const [value, expected] of omnirouteLocalUrlCases.accepted) {
    assert.equal(askApi.normalizeOmnirouteLocalBaseUrl(value), expected, value);
    assert.equal(adminOmnirouteApi.normalizeOmnirouteLocalBaseUrl(value), expected, `Admin: ${value}`);
  }
  for (const value of omnirouteLocalUrlCases.rejected) {
    assert.equal(askApi.normalizeOmnirouteLocalBaseUrl(value), '', value);
    assert.equal(adminOmnirouteApi.normalizeOmnirouteLocalBaseUrl(value), '', `Admin: ${value}`);
  }
});

await testAsync('Admin saves, reloads in memory, and clears the local OmniRoute endpoint', async () => {
  adminWrites.length = 0;
  adminInputs['study-local-base-url-omniroute'].value = 'http://localhost:20128/v1';
  await adminSaveApi.saveStudyAiConfig();
  assert.equal(adminWrites[0].omnirouteLocalBaseUrl, 'http://localhost:20128/v1');
  assert.equal(adminConfig.omnirouteLocalBaseUrl, 'http://localhost:20128/v1');
  adminInputs['study-local-base-url-omniroute'].value = '';
  await adminSaveApi.saveStudyAiConfig();
  assert.equal(adminWrites[1].omnirouteLocalBaseUrl, '');
  assert.equal(adminConfig.omnirouteLocalBaseUrl, '');
});

test('an Admin local endpoint requires per-deployment opt-in', () => {
  const cfg = { ...OMNIROUTE_CONFIG, omnirouteLocalBaseUrl: 'http://localhost:20128/v1' };
  const previousAllow = askProcess.env.OMNIROUTE_ALLOW_ADMIN_LOCAL_URL;
  askProcess.env.OMNIROUTE_ALLOW_ADMIN_LOCAL_URL = '';
  assert.equal(askApi.resolveOmnirouteBaseUrl(cfg),
    'https://precut-uniformly-handsfree.ngrok-free.dev/v1');
  askProcess.env.OMNIROUTE_ALLOW_ADMIN_LOCAL_URL = '1';
  assert.equal(askApi.resolveOmnirouteBaseUrl(cfg), 'http://localhost:20128/v1');
  assert.equal(askApi.studyProviderFromConfig(cfg).url,
    'http://localhost:20128/v1/chat/completions');
  const fallbacks = askApi.buildFallbackProviderList(
    { ...cfg, studyProvider: 'mistral', omnirouteApiKeys: ['fallback-key'] }, null);
  assert.equal(Array.from(fallbacks).find(provider => provider.provider === 'omniroute').url,
    'http://localhost:20128/v1/chat/completions');
  askProcess.env.OMNIROUTE_ALLOW_ADMIN_LOCAL_URL = previousAllow;
});

test('invalid local environment values fall back to the public resolver', () => {
  const previous = askProcess.env.OMNIROUTE_LOCAL_URL;
  askProcess.env.OMNIROUTE_LOCAL_URL = 'http://169.254.169.254/v1';
  assert.equal(askApi.resolveOmnirouteBaseUrl(OMNIROUTE_CONFIG),
    'https://precut-uniformly-handsfree.ngrok-free.dev/v1');
  askProcess.env.OMNIROUTE_LOCAL_URL = previous;
});

test('keys are accepted as an array or as typed text', () => {
  assert.deepEqual(Array.from(askApi.studyApiKeyList(['a', ' b ', '', null])), ['a', 'b']);
  assert.deepEqual(Array.from(askApi.studyApiKeyList('a\n b ,c\n')), ['a', 'b', 'c']);
  assert.deepEqual(Array.from(askApi.studyApiKeyList(undefined)), []);
});

test('an unusable non-OmniRoute provider config resolves to null instead of a bad request', () => {
  const generic = { ...OMNIROUTE_CONFIG, studyProvider: 'custom', omnirouteBaseUrl: undefined };
  assert.equal(askApi.studyProviderFromConfig({ ...generic, studyApiKeys: [] }), null, 'no keys');
  assert.equal(askApi.studyProviderFromConfig({ ...generic, studyBaseUrl: '' }), null, 'no base url');
  assert.equal(askApi.studyProviderFromConfig({ ...generic, studyBaseUrl: 'not a url' }), null, 'malformed base');
  /* Gemini Interactions speaks a different protocol — it must fall through
     rather than be sent an OpenAI chat body. */
  assert.equal(askApi.studyProviderFromConfig({ ...OMNIROUTE_CONFIG, studyTransport: 'google_interactions' }), null);
  assert.equal(askApi.studyProviderFromConfig({}), null);
});

test('a trailing slash on a generic base URL does not double up', () => {
  const provider = askApi.studyProviderFromConfig({ ...OMNIROUTE_CONFIG,
    studyProvider: 'custom', omnirouteBaseUrl: undefined, studyBaseUrl: 'https://host.dev/v1///' });
  assert.equal(provider.url, 'https://host.dev/v1/chat/completions');
});

test('OmniRoute failover uses the same live endpoint and excludes an attempted primary', () => {
  const cfg = { ...OMNIROUTE_CONFIG, omnirouteApiKeys: ['fallback-key'] };
  const fallbacks = askApi.buildFallbackProviderList(cfg, askApi.groqFallbackProvider({ groqApiKey: 'gsk_x' }));
  const omni = Array.from(fallbacks).find(provider => provider.provider === 'omniroute');
  assert.equal(omni.url, 'https://precut-uniformly-handsfree.ngrok-free.dev/v1/chat/completions');
  assert.deepEqual(Array.from(omni.keys), ['fallback-key']);
  assert.equal(askApi.buildFallbackProviderList(cfg, askApi.studyProviderFromConfig(cfg))
    .some(provider => provider.provider === 'omniroute'), false);
});

test('Groq remains the fallback when no study provider is configured', () => {
  assert.equal(askApi.groqFallbackProvider({ groqApiKey: 'gsk_x' }).url,
    'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(askApi.groqFallbackProvider({}), null);
});

await testAsync('the request carries the model, the key and the ngrok header', async () => {
  askFetchCalls = [];
  askFetchCalls = [];
  askFetchQueue = [{ status: 200, answer: '126' }];
  const answer = await askApi.callStudyProvider(askApi.studyProviderFromConfig(OMNIROUTE_CONFIG),
    askApi.buildTutorMessages('15% of 840'));
  assert.equal(answer, '126');
  assert.equal(askFetchCalls.length, 1);
  const { init } = askFetchCalls[0];
  assert.equal(init.headers.Authorization, 'Bearer key-one');
  /* An ngrok dev domain otherwise answers with an HTML interstitial. */
  assert.equal(init.headers['ngrok-skip-browser-warning'], 'true');
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'auto');
  assert.equal(body.messages[1].content, '15% of 840');
  assert.match(body.messages[0].content, /competitive-exam/);
});

await testAsync('a dead key rotates to the next one', async () => {
  askFetchCalls = [];
  askFetchCalls = [];
  askFetchQueue = [{ status: 401 }, { status: 200, answer: 'answered by the second key' }];
  const answer = await askApi.callStudyProvider(askApi.studyProviderFromConfig(OMNIROUTE_CONFIG), []);
  assert.equal(answer, 'answered by the second key');
  assert.equal(askFetchCalls.length, 2);
  assert.equal(askFetchCalls[1].init.headers.Authorization, 'Bearer key-two');
});

await testAsync('a network failure or a down tunnel rotates too', async () => {
  askFetchCalls = [];
  askFetchQueue = [{ throw: 'fetch failed' }, { status: 200, answer: 'ok' }];
  assert.equal(await askApi.callStudyProvider(askApi.studyProviderFromConfig(OMNIROUTE_CONFIG), []), 'ok');
});

await testAsync('an empty completion is treated as a failure and rotates', async () => {
  askFetchCalls = [];
  askFetchQueue = [{ status: 200, answer: '   ' }, { status: 200, answer: 'real answer' }];
  assert.equal(await askApi.callStudyProvider(askApi.studyProviderFromConfig(OMNIROUTE_CONFIG), []), 'real answer');
});

await testAsync('a 400 is not retried, because every key would refuse it', async () => {
  askFetchCalls = [];
  askFetchCalls = [];
  askFetchQueue = [{ status: 400 }, { status: 200, answer: 'never reached' }];
  await assert.rejects(
    () => askApi.callStudyProvider(askApi.studyProviderFromConfig(OMNIROUTE_CONFIG), []),
    error => error.status === 400 && /chhota karke/i.test(error.message)
  );
  assert.equal(askFetchCalls.length, 1, 'must not burn the other keys on a bad request');
});

await testAsync('exhausting every key fails as unavailable, naming the provider only in the log', async () => {
  askFetchCalls = [];
  askFetchQueue = [{ status: 429 }, { status: 500 }];
  await assert.rejects(
    () => askApi.callStudyProvider(askApi.studyProviderFromConfig(OMNIROUTE_CONFIG), []),
    error => error.status === 502 && /omniroute responded 500/.test(error.message)
  );
});

test('every helper this sandbox supplies really exists in bot-server.js', () => {
  /* The vm context provides these so the builders can be evaluated in isolation
     — which also means a missing import in the real file would be invisible
     here. It already happened once: buildStatusMessage called isLifetimePlan
     while bot-server.js imported only isProUser, so /status threw in production
     while this suite stayed green. Pin each one to its real declaration. */
  const declarations = {
    tgLib: /const tgLib = require\('\.\.\/scripts\/telegram-lib'\)/,
    todayIST: /function todayIST\(/,
    escapeTelegramHtml: /function escapeTelegramHtml\(/,
    describeInstance: /function describeInstance\(/,
    FIRESTORE_STATUS: /const FIRESTORE_STATUS = /,
    isLifetimePlan: /const \{[^}]*\bisLifetimePlan\b[^}]*\} = require\('\.\.\/shared\/proGating'\)/,
    normalizeAppBaseUrl: /function normalizeAppBaseUrl\(/
  };
  for (const [name, pattern] of Object.entries(declarations)) {
    assert.match(source, pattern, `${name} is stubbed in the test but not available in bot-server.js`);
  }
});

/* ── the two hand-maintained lists must agree ────────────────────────────── */
test('every registered command is documented in /help and has a handler', () => {
  const menu = section('const BOT_COMMANDS = [', 'bot.setMyCommands(');
  const commands = [...menu.matchAll(/command:\s*'([a-z0-9_]+)'/g)].map(match => match[1]);
  assert.ok(commands.length >= 12, `expected the full menu, parsed ${commands.length}`);

  const help = section("bot.onText(/^\\/help$/", '/* ── Command menu');
  for (const command of commands) {
    assert.match(command, /^[a-z0-9_]{1,32}$/, `invalid command name: ${command}`);
    assert.ok(help.includes(`/${command} —`), `/help does not document /${command}`);
    /* A menu entry with no handler is a dead command in the UI. */
    const handler = new RegExp(`bot\\.onText\\(/\\^\\\\/(?:[a-z0-9_|:?()\\\\]*\\\\?)?${command}\\b`);
    assert.ok(handler.test(source) || source.includes(`name: '${command}'`),
      `no handler found for /${command}`);
  }
});

test('menu descriptions fit the Bot API limits', () => {
  const menu = section('const BOT_COMMANDS = [', 'bot.setMyCommands(');
  for (const [, description] of menu.matchAll(/description:\s*"([^"]+)"|description:\s*'([^']+)'/g)) {
    const text = description || '';
    if (!text) continue;
    assert.ok(text.length >= 1 && text.length <= 256, `description out of range: ${text}`);
  }
});

console.log('Read-only Telegram commands');
console.log(results.join('\n'));
if (process.exitCode) {
  console.error('\nBot command tests FAILED');
} else {
  console.log(`\n${results.length} checks passed`);
}
