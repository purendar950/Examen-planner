/*
 * Duplicate-instance detection tests.
 *
 * Telegram gives each update to exactly one getUpdates consumer, so a second
 * process polling the same token competes for updates and answers them with its
 * own build and configuration. Symptom: one /calc produced three different
 * replies — a stale build's preset list, the current build's buttons, and
 * "Server-side dikkat hai" from an instance with no Firestore credential.
 *
 * HTTP 409 from Telegram is the only authoritative signal, so the predicate that
 * recognises it must not miss a shape, and must not mistake ordinary network
 * noise for a conflict (which would cry wolf on every timeout).
 *
 * Run with:  npm run test:bot-instance      (also part of `npm run check`)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import vm from 'node:vm';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(rootDir, 'bot/bot-server.js'), 'utf8');

function section(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + 1);
  assert.ok(start !== -1 && end > start, `could not locate section: ${from}`);
  return source.slice(start, end);
}

/** Load the identity block with a chosen set of Render environment variables. */
function loadInstance(env) {
  return vm.runInNewContext(
    section('const INSTANCE = {', 'const bot = new TelegramBot')
    + ';({ INSTANCE, describeInstance })',
    { crypto, process: { env: env || {} } }
  );
}

const conflictApi = vm.runInNewContext(
  section('function isPollingConflict', 'let lastConflictWarnAt') + ';({ isPollingConflict })',
  {}
);

const results = [];
function test(name, fn) {
  try { fn(); results.push(`  ✓ ${name}`); }
  catch (error) { results.push(`  ✗ ${name}\n    ${error.message}`); process.exitCode = 1; }
}

/* ── recognising the collision ───────────────────────────────────────────── */
test('recognises the 409 error code from the API response', () => {
  assert.equal(conflictApi.isPollingConflict({ response: { body: { error_code: 409 } } }), true);
  /* node-telegram-bot-api sometimes stringifies it. */
  assert.equal(conflictApi.isPollingConflict({ response: { body: { error_code: '409' } } }), true);
});

test("recognises Telegram's conflict message text", () => {
  const message = 'ETELEGRAM: 409 Conflict: terminated by other getUpdates request; '
    + 'make sure that only one bot instance is running';
  assert.equal(conflictApi.isPollingConflict({ code: 'ETELEGRAM', message }), true);
  /* Wording has changed before, so either half is enough on its own. */
  assert.equal(conflictApi.isPollingConflict({ message: 'terminated by other getUpdates request' }), true);
  assert.equal(conflictApi.isPollingConflict({ message: 'make sure that only one bot instance is running' }), true);
});

test('does not mistake ordinary network noise for a conflict', () => {
  /* Crying wolf on every timeout would bury the real banner. */
  for (const error of [
    { code: 'EFATAL', message: 'EFATAL: read ECONNRESET' },
    { code: 'ETELEGRAM', message: 'ETELEGRAM: 502 Bad Gateway' },
    { code: 'ETELEGRAM', message: 'ETELEGRAM: 401 Unauthorized' },
    { code: 'ETELEGRAM', message: 'ETELEGRAM: 429 Too Many Requests: retry after 5' },
    { response: { body: { error_code: 400, description: 'Bad Request: message is not modified' } } },
    { message: 'socket hang up' },
    {},
    null
  ]) {
    assert.equal(conflictApi.isPollingConflict(error), false,
      `false positive on ${JSON.stringify(error)}`);
  }
});

test('a number that merely contains 409 is not a conflict', () => {
  /* \b anchors the match, so a retry-after or byte count cannot trigger it. */
  assert.equal(conflictApi.isPollingConflict({ message: 'ETELEGRAM: 429 retry after 4090' }), false);
  assert.equal(conflictApi.isPollingConflict({ message: 'wrote 1409 bytes' }), false);
});

/* ── identifying which build is answering ────────────────────────────────── */
test('uses the Render identity when present', () => {
  const { INSTANCE, describeInstance } = loadInstance({
    RENDER_INSTANCE_ID: 'srv-abc123-xyz789',
    RENDER_SERVICE_NAME: 'examen-planner-2',
    RENDER_GIT_COMMIT: 'f9f37af0123456789',
    RENDER_GIT_BRANCH: 'main'
  });
  assert.equal(INSTANCE.service, 'examen-planner-2');
  assert.equal(INSTANCE.commit, 'f9f37af', 'the commit is shortened for logs');
  assert.equal(INSTANCE.branch, 'main');
  assert.equal(INSTANCE.id.length, 12, 'the instance id is bounded');
  assert.match(describeInstance(), /^examen-planner-2@f9f37af \(instance .{1,12}\)$/);
});

test('falls back to a usable identity off Render', () => {
  const { INSTANCE, describeInstance } = loadInstance({});
  assert.equal(INSTANCE.service, 'local');
  assert.equal(INSTANCE.commit, '');
  assert.match(INSTANCE.id, /^[0-9a-f]{12}$/, 'a random id still distinguishes processes');
  assert.match(describeInstance(), /^local@unknown \(instance [0-9a-f]{12}\)$/);
});

test('two processes on the same host get different ids', () => {
  assert.notEqual(loadInstance({}).INSTANCE.id, loadInstance({}).INSTANCE.id);
});

test('startedAt is an ISO timestamp, so uptime can be compared across services', () => {
  const { INSTANCE } = loadInstance({});
  assert.match(INSTANCE.startedAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  assert.ok(!Number.isNaN(Date.parse(INSTANCE.startedAt)));
});

test('the identity carries no secret', () => {
  /* It is served on the public /health endpoint. */
  const { INSTANCE } = loadInstance({
    RENDER_SERVICE_NAME: 'examen-planner-2',
    RENDER_GIT_COMMIT: 'f9f37af',
    TELEGRAM_BOT_TOKEN: '123456:SECRET-TOKEN',
    FIREBASE_SERVICE_ACCOUNT: '{"private_key":"-----BEGIN PRIVATE KEY-----"}'
  });
  const serialized = JSON.stringify(INSTANCE);
  assert.ok(!serialized.includes('SECRET-TOKEN'));
  assert.ok(!serialized.includes('PRIVATE KEY'));
  assert.deepEqual(Object.keys(INSTANCE).sort(), ['branch', 'commit', 'id', 'service', 'startedAt']);
});

console.log('Duplicate bot instance detection');
console.log(results.join('\n'));
if (process.exitCode) {
  console.error('\nBot instance tests FAILED');
} else {
  console.log(`\n${results.length} checks passed`);
}
