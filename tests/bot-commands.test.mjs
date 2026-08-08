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
const tgLib = createRequire(import.meta.url)(resolve(rootDir, 'scripts/telegram-lib.js'));

function section(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + 1);
  assert.ok(start !== -1 && end > start, `could not locate section: ${from}`);
  return source.slice(start, end);
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
    isLifetimePlan: /const \{[^}]*\bisLifetimePlan\b[^}]*\} = require\('\.\.\/shared\/proGating'\)/
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
