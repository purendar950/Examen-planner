/*
 * FIREBASE_SERVICE_ACCOUNT loader tests.
 *
 * A mis-pasted service account leaves `db` null, and every Firestore-backed
 * feature (/calc, /setup, AI auto-schedule, the Mini App routes, both send
 * proxies) then fails separately — one env var presenting as several unrelated
 * bugs. These cover the shapes the value actually arrives in from a hosting
 * dashboard, and pin the failure codes that GET /health reports.
 *
 * Exercised against the real source in bot/bot-server.js (the functions are
 * evaluated in a sandbox, so no bot token or Firebase project is needed).
 *
 * Run with:  npm run test:service-account      (also part of `npm run check`)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(rootDir, 'bot/bot-server.js'), 'utf8');

function section(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to);
  assert.ok(start !== -1 && end > start, `could not locate section: ${from}`);
  return source.slice(start, end);
}

const warnings = [];
const api = vm.runInNewContext(
  section('function escapeControlCharsInJsonStrings', 'let db = null;')
  + ';({ parseServiceAccount, escapeControlCharsInJsonStrings })',
  { Buffer, console: { warn: (...args) => warnings.push(args.join(' ')), log() {}, error() {} } }
);

/* Shaped like a real key: a PEM body with newlines is the part that gets
   mangled, so every fixture carries one. */
const PEM = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ\nEXAMPLEBODY==\n-----END PRIVATE KEY-----\n';
const CLEAN = {
  type: 'service_account',
  project_id: 'examzen-prod',
  private_key_id: 'abc123',
  private_key: PEM,
  client_email: 'bot@examzen-prod.iam.gserviceaccount.com'
};
const ONE_LINE = JSON.stringify(CLEAN);
const PRETTY = JSON.stringify(CLEAN, null, 2);

const results = [];
function test(name, fn) {
  try { fn(); results.push(`  ✓ ${name}`); }
  catch (error) { results.push(`  ✗ ${name}\n    ${error.message}`); process.exitCode = 1; }
}

/** Assert the value loads and the PEM survived intact. */
function accepts(value, label) {
  const out = api.parseServiceAccount(value);
  assert.ok(!out.code, `${label}: rejected as ${out.code} — ${out.detail}`);
  assert.equal(out.serviceAccount.project_id, 'examzen-prod', label);
  assert.match(out.serviceAccount.private_key, /^-----BEGIN PRIVATE KEY-----\n/, `${label}: PEM head lost`);
  assert.ok(out.serviceAccount.private_key.includes('\n-----END PRIVATE KEY-----'), `${label}: PEM tail lost`);
  return out;
}

/** Assert the value is refused with a specific, stable code. */
function refuses(value, code, label) {
  const out = api.parseServiceAccount(value);
  assert.equal(out.code, code, `${label}: got ${out.code || 'success'}`);
  assert.ok(out.detail, `${label}: a failure must explain itself in the logs`);
  return out;
}

/* ── shapes that must work ───────────────────────────────────────────────── */
test('clean single-line JSON, as Firebase generates it', () => accepts(ONE_LINE, 'one-line'));

test('pretty-printed JSON is parsed without repair', () => {
  warnings.length = 0;
  accepts(PRETTY, 'pretty');
  assert.equal(warnings.length, 0, 'valid JSON must not report a repair');
});

test('base64-encoded JSON, plain and with stray whitespace', () => {
  accepts(Buffer.from(ONE_LINE, 'utf8').toString('base64'), 'base64');
  accepts(`\n  ${Buffer.from(PRETTY, 'utf8').toString('base64')}  \n`, 'base64-padded');
});

test('wrapped in quotes by a dashboard or shell', () => {
  /* A double-quote wrap escapes the inner quotes, so the outer value is itself a
     JSON string literal — stripping the pair alone would leave `{\"type\":…`. */
  accepts(`"${ONE_LINE.replace(/"/g, '\\"')}"`, 'double-quoted');
  accepts(`'${ONE_LINE}'`, 'single-quoted');
});

test('leading BOM and surrounding whitespace', () => accepts(`\uFEFF  ${ONE_LINE}\n`, 'bom'));

test('private_key pasted with real newlines is repaired', () => {
  const mangled = `{"type":"service_account","project_id":"examzen-prod","private_key":"${PEM}","client_email":"bot@examzen-prod.iam.gserviceaccount.com"}`;
  assert.throws(() => JSON.parse(mangled), 'precondition: a raw newline in a string is invalid JSON');
  warnings.length = 0;
  accepts(mangled, 'real-newlines');
  assert.match(warnings.join(' '), /unescaped newlines/);
});

test('repair fixes newlines inside strings without breaking pretty-printing', () => {
  const mangled = `{\n  "project_id": "examzen-prod",\n  "private_key": "${PEM}"\n}`;
  assert.throws(() => JSON.parse(mangled));
  accepts(mangled, 'pretty-and-mangled');
});

test('double-escaped \\n in private_key is un-escaped', () => {
  const doubled = JSON.stringify({ ...CLEAN, private_key: PEM.replace(/\n/g, '\\n') });
  assert.ok(!JSON.parse(doubled).private_key.includes('\n'), 'precondition: no real newlines survive');
  warnings.length = 0;
  accepts(doubled, 'double-escaped');
  assert.match(warnings.join(' '), /double-escaped/);
  accepts(Buffer.from(doubled, 'utf8').toString('base64'), 'base64-double-escaped');
});

/* ── failures must report a stable code for GET /health ──────────────────── */
test('absent, empty, or whitespace-only → not-set', () => {
  refuses(undefined, 'not-set', 'undefined');
  refuses('', 'not-set', 'empty');
  refuses('   \n ', 'not-set', 'whitespace');
});

test('undecodable input → not-json', () => {
  refuses('this is not json at all !!', 'not-json', 'garbage');
  refuses('{ "unterminated": ', 'not-json', 'truncated');
  refuses(JSON.stringify('a bare string'), 'not-json', 'string literal');
});

test('missing required fields → incomplete', () => {
  refuses(JSON.stringify({ private_key: PEM }), 'incomplete', 'no project_id');
  refuses(JSON.stringify({ project_id: 'p' }), 'incomplete', 'no private_key');
});

test('a private_key that is not a PEM block → bad-private-key', () => {
  refuses(JSON.stringify({ project_id: 'p', private_key: 'REDACTED' }), 'bad-private-key', 'not pem');
});

test('a failure detail never echoes key material', () => {
  /* `detail` is logged, and /health must be able to stay coarse: the code is
     safe to expose precisely because the detail is not. */
  const out = api.parseServiceAccount(JSON.stringify({ project_id: 'p', private_key: 'SUPERSECRETBODY==' }));
  assert.ok(!out.detail.includes('SUPERSECRETBODY'), 'detail leaked key material');
});

/* ── the string scanner underpinning the repair ──────────────────────────── */
test('scanner preserves escaped quotes, backslashes, and non-ASCII', () => {
  const escapedQuotes = JSON.parse(api.escapeControlCharsInJsonStrings('{"a":"say \\"hi\\"","b":"x\ny"}'));
  assert.equal(escapedQuotes.a, 'say "hi"');
  assert.equal(escapedQuotes.b, 'x\ny');

  const trailingBackslash = JSON.parse(api.escapeControlCharsInJsonStrings('{"path":"C:\\\\dir\\\\","n":"a\nb"}'));
  assert.equal(trailingBackslash.path, 'C:\\dir\\');
  assert.equal(trailingBackslash.n, 'a\nb');

  const unicode = JSON.parse(api.escapeControlCharsInJsonStrings('{"k":"नमस्ते 🧮","n":"a\nb"}'));
  assert.equal(unicode.k, 'नमस्ते 🧮');
});

console.log('FIREBASE_SERVICE_ACCOUNT loader');
console.log(results.join('\n'));
if (process.exitCode) {
  console.error('\nService account loader tests FAILED');
} else {
  console.log(`\n${results.length} checks passed`);
}
