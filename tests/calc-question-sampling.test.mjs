/*
 * No-repeat question sampling tests.
 *
 * Every gen() in calc/index.html draws independently through Math.random() with
 * no memory, so a narrow range repeats heavily. Squares over 10–30 is a pool of
 * 21 values; asking 10 questions from it has only a ~8% chance of avoiding a
 * repeat, so almost every session asked one value two or three times while
 * others never appeared. drawQuestion() rejects values already asked.
 *
 * These run the REAL generators (QUIZZES and its data tables are evaluated in a
 * sandbox) so the test cannot drift from the engines it is meant to protect.
 *
 * calc/index.html holds its script inline, so `node --check` cannot see it —
 * the last test parses it, which is the only syntax gate that file has.
 *
 * Run with:  npm run test:calc-sampling      (also part of `npm run check`)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(rootDir, 'calc/index.html'), 'utf8');

function section(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + 1);
  assert.ok(start !== -1 && end > start, `could not locate section: ${from}`);
  return source.slice(start, end);
}

/* Data tables, the higher-power groups, the engines, and the sampler — the real
   code, assembled in dependency order. */
const api = vm.runInNewContext(
  section('const DEGREES=', 'const CATEGORIES=')
  + section('const HIGHER_POWERS={', 'const HP_ORDER=')
  + section('const QUIZZES={', 'const QUIZ_TITLES=')
  + section('const DRAW_ATTEMPTS=', 'function openQuiz(')
  + ';({ QUIZZES, drawQuestion, resetAskedPools, questionKey, DRAW_ATTEMPTS })',
  {}
);

const results = [];
function test(name, fn) {
  try { fn(); results.push(`  ✓ ${name}`); }
  catch (error) { results.push(`  ✗ ${name}\n    ${error.message}`); process.exitCode = 1; }
}

/** Draw `count` questions for a quiz id and return their keys. */
function drawMany(quizId, settings, count) {
  const def = api.QUIZZES[quizId];
  assert.ok(def, `unknown quiz id ${quizId}`);
  const keys = [];
  for (let index = 0; index < count; index++) {
    const question = api.drawQuestion(def, settings, quizId);
    assert.ok(question && question.q !== undefined, `draw ${index} produced no question`);
    keys.push(api.questionKey(question));
  }
  return keys;
}

const SQUARES_10_30 = { r1: 10, r2: 30 };

/* ── the reported case ───────────────────────────────────────────────────── */
test('squares 10–30: ten questions are all different', () => {
  /* Previously ~92% of sessions repeated. Repeat the whole session many times so
     a lucky run cannot pass this. */
  for (let session = 0; session < 200; session++) {
    api.resetAskedPools();
    const keys = drawMany('squares', SQUARES_10_30, 10);
    assert.equal(new Set(keys).size, 10, `session ${session} repeated a value`);
  }
});

test('squares 10–30: twenty-one questions cover every value exactly once', () => {
  for (let session = 0; session < 50; session++) {
    api.resetAskedPools();
    const keys = drawMany('squares', SQUARES_10_30, 21);
    assert.equal(new Set(keys).size, 21, `session ${session} did not cover the pool`);
    const bases = keys.map(key => JSON.parse(key)[0]).sort((a, b) => a - b);
    assert.deepEqual(bases, Array.from({ length: 21 }, (_, i) => i + 10),
      'every base from 10 to 30 should appear exactly once');
  }
});

test('squares 10–30: asking more than the pool starts a fresh cycle', () => {
  /* 25 questions from 21 values must repeat 4 — but only after all 21 are used. */
  api.resetAskedPools();
  const keys = drawMany('squares', SQUARES_10_30, 25);
  assert.equal(new Set(keys.slice(0, 21)).size, 21, 'the first cycle must be exhaustive');
  assert.equal(new Set(keys).size, 21, 'a second cycle draws from the same pool');
  for (let index = 1; index < keys.length; index++) {
    assert.notEqual(keys[index], keys[index - 1], `question ${index} repeated the one on screen`);
  }
});

test('a tiny range still works and never shows the same question twice running', () => {
  /* 12..14 is three values; 12 questions is four cycles. */
  api.resetAskedPools();
  const keys = drawMany('squares', { r1: 12, r2: 14 }, 12);
  assert.equal(new Set(keys).size, 3);
  for (let index = 1; index < keys.length; index++) {
    assert.notEqual(keys[index], keys[index - 1], `question ${index} repeated back to back`);
  }
});

/* ── the degenerate pool that must not hang ──────────────────────────────── */
test('a single-question pool returns immediately instead of spinning', () => {
  /* primeinrange is fully determined by its settings: pool size 1. Rejection
     sampling can never succeed, so the exhaustion path must give up cleanly. */
  api.resetAskedPools();
  const started = Date.now();
  const keys = drawMany('primeinrange', { r1: 1, r2: 100 }, 8);
  assert.equal(new Set(keys).size, 1, 'there is only one possible question');
  assert.ok(Date.now() - started < 2000, 'must not spin on an exhausted pool');
});

/* ── other small pools ──────────────────────────────────────────────────── */
test('writing table 2–12 covers all eleven tables before repeating', () => {
  api.resetAskedPools();
  const keys = drawMany('tablewrite', { f1: 2, f2: 12, t1: 1, t2: 10 }, 11);
  assert.equal(new Set(keys).size, 11, 'each table should be asked once');
});

test('cubes, square roots and cube roots deduplicate too', () => {
  for (const [quizId, settings, expected] of [
    ['cubes', { r1: 2, r2: 15 }, 14],
    ['sqroots', { r1: 10, r2: 30 }, 21],
    ['cuberoots', { r1: 5, r2: 20 }, 16]
  ]) {
    api.resetAskedPools();
    assert.equal(new Set(drawMany(quizId, settings, expected)).size, expected, `${quizId} repeated`);
  }
});

test('alphabet and trig pools deduplicate without settings', () => {
  api.resetAskedPools();
  assert.equal(new Set(drawMany('astr1', {}, 26)).size, 26, 'all 26 letters');
  api.resetAskedPools();
  assert.equal(new Set(drawMany('trig', {}, 20)).size, 20, 'trig combinations repeated');
});

test('a large pool is unaffected and stays fast', () => {
  api.resetAskedPools();
  const started = Date.now();
  const keys = drawMany('pctnum', {}, 50);
  assert.equal(new Set(keys).size, 50);
  assert.ok(Date.now() - started < 2000, 'a large pool should accept the first draw');
});

/* ── pool scoping ───────────────────────────────────────────────────────── */
test('the same quiz over two ranges keeps separate pools', () => {
  /* A combined preset can practise squares 10–30 in one part and 2–12 in
     another. Exhausting one must not suppress the other. */
  api.resetAskedPools();
  drawMany('squares', SQUARES_10_30, 21);
  const narrow = drawMany('squares', { r1: 2, r2: 12 }, 11);
  assert.equal(new Set(narrow).size, 11, 'the second range was suppressed by the first');
});

test('different quizzes do not share a pool', () => {
  api.resetAskedPools();
  drawMany('squares', SQUARES_10_30, 21);
  assert.equal(new Set(drawMany('sqroots', SQUARES_10_30, 21)).size, 21,
    'square roots should not be blocked by squares');
});

test('resetAskedPools starts a clean cycle', () => {
  api.resetAskedPools();
  const first = drawMany('squares', SQUARES_10_30, 21);
  api.resetAskedPools();
  const second = drawMany('squares', SQUARES_10_30, 21);
  assert.equal(new Set(first).size, 21);
  assert.equal(new Set(second).size, 21, 'a new run must be able to ask the same values again');
});

/* ── the key ─────────────────────────────────────────────────────────────── */
test('questions are keyed on what is displayed, not the answer', () => {
  /* Engines share answers — 2² and √4 both answer 4 — so keying on the answer
     would wrongly treat different questions as the same one. */
  assert.equal(api.questionKey({ q: [12], ans: '144' }), api.questionKey({ q: [12], ans: 'whatever' }));
  assert.notEqual(api.questionKey({ q: [12] }), api.questionKey({ q: [13] }));
  assert.equal(api.questionKey(null), 'null', 'must not throw on a malformed question');
});

/* ── the only syntax gate calc/index.html has ────────────────────────────── */
test('every inline script in calc/index.html parses', () => {
  const blocks = [...source.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.ok(blocks.length >= 1, 'expected at least one inline script');
  let checked = 0;
  for (const [, code] of blocks) {
    if (!code.trim()) continue;
    checked++;
    /* Parses without running: node --check cannot reach inline HTML scripts. */
    assert.doesNotThrow(() => new vm.Script(code), `inline script ${checked} has a syntax error`);
  }
  assert.ok(checked >= 1, 'no inline script was actually parsed');
});

console.log('Calculation question sampling');
console.log(results.join('\n'));
if (process.exitCode) {
  console.error('\nQuestion sampling tests FAILED');
} else {
  console.log(`\n${results.length} checks passed`);
}
