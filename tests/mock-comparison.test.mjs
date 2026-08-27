/*
 * Flexible mock comparison contracts.
 *
 * The comparison card lets the user choose how many recent mocks to compare
 * (3 / 5 / 10 / all) and reports marks, accuracy and negative-marking loss per
 * section. The selection helpers and the per-attempt metric maths are pulled
 * out of js/tabs/mock-tests-render.js and exercised directly, so a regression
 * in the window clamping or the negative-marking sum fails here instead of
 * silently rendering wrong numbers.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(rootDir, 'js/tabs/mock-tests-render.js'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start !== -1, `could not locate ${name}`);
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (!depth) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated function: ${name}`);
}

const TIER = {
  neg: 0.5,
  sections: [
    { k: 'qa', name: 'Quantitative Aptitude', q: 25, max: 50 },
    { k: 'en', name: 'English', q: 25, max: 50, neg: 0.25 }
  ]
};

function loadApi({ stored = null } = {}) {
  const store = new Map();
  if (stored) Object.entries(stored).forEach(([key, value]) => store.set(key, value));
  const rendered = [];
  const context = {
    currentExam: 'cgl',
    mockTierKey: () => 't1',
    mockRenderPage: () => { rendered.push(true); },
    localStorage: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)); }
    },
    Object, Array, String, Number, Math, JSON, parseInt
  };
  const script = [
    extractFunction('mockComparisonWindow'),
    extractFunction('mockSetComparisonWindow'),
    extractFunction('mockComparisonCount'),
    extractFunction('mockAttemptMetrics'),
    ';({ mockComparisonWindow, mockSetComparisonWindow, mockComparisonCount, mockAttemptMetrics })'
  ].join('\n');
  return { api: vm.runInNewContext(script, context), store, rendered };
}

const results = [];
function test(name, fn) {
  try { fn(); results.push(`  ✓ ${name}`); }
  catch (error) { results.push(`  ✗ ${name}\n    ${error.message}`); process.exitCode = 1; }
}

console.log('Flexible mock comparison');

test('defaults to the last 5 mocks', () => {
  const { api } = loadApi();
  assert.equal(api.mockComparisonWindow(), '5');
});

test('restores a stored selection and rejects an unsupported one', () => {
  const key = 'mockCompareWindow:cgl:t1';
  assert.equal(loadApi({ stored: { [key]: '10' } }).api.mockComparisonWindow(), '10');
  assert.equal(loadApi({ stored: { [key]: 'all' } }).api.mockComparisonWindow(), 'all');
  assert.equal(loadApi({ stored: { [key]: '7' } }).api.mockComparisonWindow(), '5');
});

test('persists the selection per exam+tier and re-renders', () => {
  const { api, store, rendered } = loadApi();
  api.mockSetComparisonWindow('10');
  assert.equal(store.get('mockCompareWindow:cgl:t1'), '10');
  assert.equal(api.mockComparisonWindow(), '10');
  assert.equal(rendered.length, 1);
  api.mockSetComparisonWindow('nonsense');
  assert.equal(api.mockComparisonWindow(), '5');
});

test('clamps the window to the mocks that actually exist', () => {
  const two = [{}, {}];
  const twelve = new Array(12).fill({});
  assert.equal(loadApi().api.mockComparisonCount(two), 2);
  assert.equal(loadApi().api.mockComparisonCount(twelve), 5);
  assert.equal(loadApi({ stored: { 'mockCompareWindow:cgl:t1': '10' } }).api.mockComparisonCount(twelve), 10);
  assert.equal(loadApi({ stored: { 'mockCompareWindow:cgl:t1': 'all' } }).api.mockComparisonCount(twelve), 12);
});

test('accuracy and negative marking use each section own penalty', () => {
  const { api } = loadApi();
  const metrics = api.mockAttemptMetrics({
    s: { qa: { c: 18, w: 6, m: 33 }, en: { c: 20, w: 4, m: 39 } }
  }, TIER);
  assert.equal(metrics.attempts, 48);
  assert.equal(metrics.correct, 38);
  assert.equal(metrics.wrong, 10);
  assert.equal(metrics.accuracy, 79);
  // qa: 6 wrong × 0.5 = 3, en: 4 wrong × 0.25 = 1
  assert.equal(metrics.negLost, 4);
  assert.equal(metrics.rows.qa.accuracy, 75);
  assert.equal(metrics.rows.qa.negLost, 3);
  assert.equal(metrics.rows.en.negLost, 1);
});

test('a marks-only mock reports no accuracy instead of zero', () => {
  const { api } = loadApi();
  const metrics = api.mockAttemptMetrics({ s: { qa: { m: 30 }, en: { m: 28 } } }, TIER);
  assert.equal(metrics.attempts, 0);
  assert.equal(metrics.accuracy, null);
  assert.equal(metrics.negLost, 0);
  assert.equal(metrics.rows.qa.accuracy, null);
});

console.log(results.join('\n'));
if (process.exitCode) console.error('Flexible mock comparison tests FAILED');
else console.log('Flexible mock comparison contracts passed');
