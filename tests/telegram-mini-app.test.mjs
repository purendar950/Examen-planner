/*
 * Telegram Mini App authorization tests.
 *
 * These cover the two places where a regression is a security event rather than
 * a cosmetic one: verifying Telegram's signed `initData`, and mapping the
 * verified Telegram user onto a StudyPlanner account. Both are exercised
 * against the real source in bot/bot-server.js (the relevant functions are
 * evaluated in a sandbox, so no bot token or Firebase project is needed).
 *
 * Run with:  npm run test:telegram      (also part of `npm run check`)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import vm from 'node:vm';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(rootDir, 'bot/bot-server.js'), 'utf8');
const TOKEN = '123456:TEST-BOT-TOKEN';

function section(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to);
  assert.ok(start !== -1 && end > start, `could not locate section: ${from}`);
  return source.slice(start, end);
}

/* Shared helpers the extracted sections rely on. */
const prelude = `
function positivePrivateChatId(value) {
  const chatId = String(value == null ? '' : value).trim();
  return /^\\d+$/.test(chatId) && Number(chatId) > 0 ? chatId : '';
}
function boundedInteger(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}
function todayIST() { return new Date(Date.now() + (5 * 60 + 30) * 60000).toISOString().slice(0, 10); }
`;

const miniAppSource = prelude
  + section('const MINI_APP_MAX_INIT_DATA', '/* Resolve the StudyPlanner account')
  + section('/* Resolve the StudyPlanner account', 'async function miniAppPresetForRequest')
  + ';({ verifyTelegramInitData, miniAppAccountForTelegramUser, sanitizeCalculationPracticeConfig,'
  + ' sanitizeMiniAppResult, queueMiniAppAttempt })';

/** Build the module under test with a stubbed Firestore. */
function loadMiniApp({ accountsByChatId = {}, links = {}, admins = [], proUids = [], docs = {} } = {}) {
  const writes = [];
  const db = {
    collection(name) {
      return {
        doc(id) {
          const ref = { __collection: name, __id: id };
          ref.get = async () => {
            if (name === 'telegram_links') {
              return { exists: Object.hasOwn(links, id), data: () => ({ uid: links[id] }) };
            }
            if (name === 'admins') return { exists: admins.includes(id) };
            return { exists: Boolean(docs[id]), data: () => docs[id] || {} };
          };
          return ref;
        },
        where(field, op, value) {
          return {
            limit: () => ({
              get: async () => {
                const uids = accountsByChatId[value] || [];
                return {
                  empty: uids.length === 0,
                  size: uids.length,
                  docs: uids.map(uid => ({ id: uid, data: () => docs[uid] || {} }))
                };
              }
            })
          };
        }
      };
    },
    async runTransaction(handler) {
      return handler({
        get: async ref => ({ exists: Boolean(docs[ref.__id]), data: () => docs[ref.__id] || {} }),
        set: (ref, value) => writes.push({ id: ref.__id, value })
      });
    }
  };

  const context = {
    db,
    crypto,
    URLSearchParams,
    Buffer,
    TOKEN,
    console: { log() {}, warn() {}, error() {} },
    isAdminUid: async uid => admins.includes(uid),
    isProUser: data => proUids.includes(data && data.__uid)
  };
  return { api: vm.runInNewContext(miniAppSource, context), writes };
}

/** Sign an initData payload the way Telegram does. */
function signInitData(fields, token = TOKEN) {
  const params = new URLSearchParams(fields);
  const dataCheckString = Array.from(params.entries())
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex'));
  return params.toString();
}

const nowSec = () => Math.floor(Date.now() / 1000);
const results = [];
function test(name, fn) {
  try { fn(); results.push(`  ✓ ${name}`); }
  catch (error) { results.push(`  ✗ ${name}\n    ${error.message}`); process.exitCode = 1; }
}
async function testAsync(name, fn) {
  try { await fn(); results.push(`  ✓ ${name}`); }
  catch (error) { results.push(`  ✗ ${name}\n    ${error.message}`); process.exitCode = 1; }
}
function rejects(fn) {
  return fn().then(
    () => { throw new Error('expected a rejection'); },
    error => error
  );
}

/* ── initData verification ───────────────────────────────────────────────── */
const { api } = loadMiniApp();

test('accepts a correctly signed payload', () => {
  const initData = signInitData({ auth_date: String(nowSec()), user: JSON.stringify({ id: 987654321 }) });
  assert.equal(api.verifyTelegramInitData(initData).telegramUserId, '987654321');
});

test('rejects a payload signed with another bot token', async () => {
  const initData = signInitData({ auth_date: String(nowSec()), user: JSON.stringify({ id: 1 }) }, '999:WRONG');
  assert.throws(() => api.verifyTelegramInitData(initData), error => error.status === 401);
});

test('rejects a tampered user field', () => {
  const params = new URLSearchParams(signInitData({ auth_date: String(nowSec()), user: JSON.stringify({ id: 1 }) }));
  params.set('user', JSON.stringify({ id: 2 }));
  assert.throws(() => api.verifyTelegramInitData(params.toString()), error => error.status === 401);
});

test('rejects a stale payload', () => {
  const initData = signInitData({ auth_date: String(nowSec() - 90000), user: JSON.stringify({ id: 1 }) });
  assert.throws(() => api.verifyTelegramInitData(initData), error => error.status === 401);
});

test('accepts a stale payload when a longer window is allowed', () => {
  const initData = signInitData({ auth_date: String(nowSec() - 20000), user: JSON.stringify({ id: 7 }) });
  assert.throws(() => api.verifyTelegramInitData(initData), error => error.status === 401);
  assert.equal(api.verifyTelegramInitData(initData, 86400).telegramUserId, '7');
});

test('rejects a missing hash, a missing user, and a group id', () => {
  assert.throws(() => api.verifyTelegramInitData(`auth_date=${nowSec()}&user=%7B%22id%22%3A5%7D`), error => error.status === 401);
  assert.throws(() => api.verifyTelegramInitData(signInitData({ auth_date: String(nowSec()) })), error => error.status === 401);
  assert.throws(
    () => api.verifyTelegramInitData(signInitData({ auth_date: String(nowSec()), user: JSON.stringify({ id: -100123 }) })),
    error => error.status === 401
  );
});

test('rejects empty and oversized payloads', () => {
  assert.throws(() => api.verifyTelegramInitData(''), error => error.status === 400);
  assert.throws(() => api.verifyTelegramInitData('a'.repeat(5000)), error => error.status === 400);
});

/* ── Account mapping ─────────────────────────────────────────────────────── */
const VICTIM = 'victim-uid';
const ATTACKER = 'attacker-uid';
const VICTIM_CHAT = '987654321';
const telegramOn = { enabled: true, chatId: VICTIM_CHAT };
const victimDoc = { __uid: VICTIM, appState: { telegram: telegramOn } };

await testAsync('links an account when the account and the chat both agree', async () => {
  const { api: mini } = loadMiniApp({
    accountsByChatId: { [VICTIM_CHAT]: [VICTIM] },
    links: { [VICTIM_CHAT]: VICTIM },
    proUids: [VICTIM],
    docs: { [VICTIM]: victimDoc }
  });
  const account = await mini.miniAppAccountForTelegramUser(VICTIM_CHAT);
  assert.equal(account.uid, VICTIM);
});

await testAsync('refuses when only the chat side is linked (/start <uid> claim)', async () => {
  const { api: mini } = loadMiniApp({
    accountsByChatId: {},
    links: { [VICTIM_CHAT]: VICTIM },
    proUids: [VICTIM],
    docs: { [VICTIM]: victimDoc }
  });
  const error = await rejects(() => mini.miniAppAccountForTelegramUser(VICTIM_CHAT));
  assert.equal(error.status, 403);
});

await testAsync('refuses when only the account side claims the chat id', async () => {
  /* An attacker typing someone else's Telegram id into their own profile must
     not capture that person's Mini App session. */
  const { api: mini } = loadMiniApp({
    accountsByChatId: { [VICTIM_CHAT]: [ATTACKER] },
    links: {},
    proUids: [ATTACKER],
    docs: { [ATTACKER]: { __uid: ATTACKER, appState: { telegram: telegramOn } } }
  });
  const error = await rejects(() => mini.miniAppAccountForTelegramUser(VICTIM_CHAT));
  assert.equal(error.status, 403);
});

await testAsync('ignores an unverified duplicate claim instead of locking the owner out', async () => {
  const { api: mini } = loadMiniApp({
    accountsByChatId: { [VICTIM_CHAT]: [ATTACKER, VICTIM] },
    links: { [VICTIM_CHAT]: VICTIM },
    proUids: [VICTIM, ATTACKER],
    docs: {
      [VICTIM]: victimDoc,
      [ATTACKER]: { __uid: ATTACKER, appState: { telegram: telegramOn } }
    }
  });
  const account = await mini.miniAppAccountForTelegramUser(VICTIM_CHAT);
  assert.equal(account.uid, VICTIM);
});

await testAsync('refuses when Telegram is switched off for the account', async () => {
  const { api: mini } = loadMiniApp({
    accountsByChatId: { [VICTIM_CHAT]: [VICTIM] },
    links: { [VICTIM_CHAT]: VICTIM },
    proUids: [VICTIM],
    docs: { [VICTIM]: { __uid: VICTIM, appState: { telegram: { enabled: false, chatId: VICTIM_CHAT } } } }
  });
  const error = await rejects(() => mini.miniAppAccountForTelegramUser(VICTIM_CHAT));
  assert.equal(error.status, 403);
});

await testAsync('refuses a free account and allows an admin', async () => {
  const free = loadMiniApp({
    accountsByChatId: { [VICTIM_CHAT]: [VICTIM] },
    links: { [VICTIM_CHAT]: VICTIM },
    proUids: [],
    docs: { [VICTIM]: victimDoc }
  });
  const error = await rejects(() => free.api.miniAppAccountForTelegramUser(VICTIM_CHAT));
  assert.equal(error.status, 403);

  const admin = loadMiniApp({
    accountsByChatId: { [VICTIM_CHAT]: [VICTIM] },
    links: { [VICTIM_CHAT]: VICTIM },
    admins: [VICTIM],
    docs: { [VICTIM]: victimDoc }
  });
  assert.equal((await admin.api.miniAppAccountForTelegramUser(VICTIM_CHAT)).uid, VICTIM);
});

/* ── Sanitizers and attempt queueing ────────────────────────────────────── */
test('clamps a practice config and mirrors difficulty defaults', () => {
  const exam = api.sanitizeCalculationPracticeConfig({ id: 'p1', difficulty: 'exam', quizIds: ['mult1'] });
  assert.equal(exam.settings.multFrom, 11);
  assert.equal(exam.settings.digits, 3);

  const tampered = api.sanitizeCalculationPracticeConfig({
    id: 'p2', questionCount: 9999, quizIds: ['mult1', 'not-a-quiz'], weights: { mult1: 999 },
    settings: { multFrom: 900, multTo: 1, multiplierFrom: 80, multiplierTo: 2 }
  });
  assert.equal(tampered.questionCount, 50);
  /* Array.from crosses back into this realm, so the comparison is not a
     prototype mismatch against the sandbox's Array. */
  assert.deepEqual(Array.from(tampered.quizIds), ['mult1']);
  assert.equal(tampered.weights.mult1, 10);
  assert.ok(tampered.settings.multFrom <= tampered.settings.multTo);
  assert.ok(tampered.settings.multiplierFrom <= tampered.settings.multiplierTo);
});

test('keeps the client attempt id, clamps scores, and never stamps a local day', () => {
  const preset = api.sanitizeCalculationPracticeConfig({ id: 'p1', quizIds: ['mult1'] });
  const attempt = api.sanitizeMiniAppResult({
    id: 'attempt-abc123', total: 3, answered: 99, firstTryCorrect: 99,
    reason: 'nonsense', mistakeQuizIds: ['mult1', 'bogus']
  }, preset);
  assert.equal(attempt.id, 'attempt-abc123');
  assert.equal(attempt.answered, 3);
  assert.equal(attempt.firstTryCorrect, 3);
  assert.equal(attempt.reason, 'completed');
  assert.deepEqual(Array.from(attempt.mistakeQuizIds), ['mult1']);
  assert.ok(!('date' in attempt), 'the local day is the browser\'s to decide');
  assert.match(api.sanitizeMiniAppResult({ id: 'no' }, preset).id, /^tgmini-/);
});

await testAsync('queues attempts outside appState and drops duplicates', async () => {
  const doc = { __uid: VICTIM };
  const queue = loadMiniApp({ docs: { [VICTIM]: doc } });
  const preset = queue.api.sanitizeCalculationPracticeConfig({ id: 'p1', quizIds: ['mult1'] });
  const attempt = queue.api.sanitizeMiniAppResult({ id: 'attempt-xyz789', total: 3 }, preset);

  await queue.api.queueMiniAppAttempt(VICTIM, attempt);
  assert.equal(queue.writes.length, 1);
  assert.ok(queue.writes[0].value.calculationAttemptInbox, 'must use the top-level inbox');
  assert.ok(!queue.writes[0].value.appState, 'must not write into appState');

  doc.calculationAttemptInbox = queue.writes[0].value.calculationAttemptInbox;
  await queue.api.queueMiniAppAttempt(VICTIM, attempt);
  assert.equal(queue.writes.length, 1, 'a replayed submission must not be stored twice');
});

console.log('Telegram Mini App authorization');
console.log(results.join('\n'));
if (process.exitCode) {
  console.error('\nTelegram Mini App tests FAILED');
} else {
  console.log(`\n${results.length} checks passed`);
}
