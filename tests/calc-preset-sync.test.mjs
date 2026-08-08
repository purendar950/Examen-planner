/*
 * Calculation Practice preset model: keep the three copies in sync.
 *
 * The preset shape is defined in calc/presets.js (the iframe, source of truth)
 * and re-implemented twice — in js/tabs/calc.js, which sanitizes presets on
 * their way into appState/Firestore, and in bot/bot-server.js, which reads them
 * back. When a copy drifts, data is lost silently:
 *
 *   - js/tabs/calc.js was missing the tablewrite / mult2d / mult3d question
 *     types, so the "Writing Table", "Two-Digit Multiplication" and
 *     "Three-Digit Multiplication" quick presets were stripped to no types and
 *     then dropped. They stayed visible in the iframe's own localStorage, so the
 *     symptom was "Save this preset before sending it to Telegram." on a preset
 *     that looked saved — and the next state push deleted it.
 *   - the same file omitted ten settings keys and the `segments` array, so
 *     customised squares/cubes and two/three-digit ranges reverted to defaults
 *     and combined multi-part presets flattened on every sync.
 *
 * These tests pin the copies together so the next added question type or range
 * cannot repeat it.
 *
 * Run with:  npm run test:calc-sync      (also part of `npm run check`)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(resolve(rootDir, file), 'utf8');
const presetsSource = read('calc/presets.js');
const tabSource = read('js/tabs/calc.js');
const botSource = read('bot/bot-server.js');

function section(source, from, to, label) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + 1);
  assert.ok(start !== -1 && end > start, `could not locate section: ${label || from}`);
  return source.slice(start, end);
}

/** Ids inside the first array literal of a block, e.g. ['mult1', …]. */
function quotedIds(block) {
  return [...block.matchAll(/'([a-z0-9_]+)'/g)].map(match => match[1]);
}

/* ── the three question-type lists ───────────────────────────────────────── */
const iframeIds = quotedIds(section(presetsSource, 'var QUIZ_CHOICES', 'var VALID_QUIZ_IDS', 'QUIZ_CHOICES'))
  /* QUIZ_CHOICES is [id, label] pairs; labels are capitalised or spaced, so the
     lowercase single-token values are the ids. */
  .filter((id, index, all) => all.indexOf(id) === index);
const tabIds = quotedIds(section(tabSource, 'var VALID_QUIZ_IDS', ']);', 'tab VALID_QUIZ_IDS'));
const botIds = quotedIds(section(botSource, 'const CALC_QUIZ_IDS', ']);', 'bot CALC_QUIZ_IDS'));

/* ── run the sanitizer under test ────────────────────────────────────────── */
const warnings = [];
const tabApi = vm.runInNewContext(
  section(tabSource, 'var VALID_QUIZ_IDS', 'function calcFrame()', 'tab sanitizers')
  + ';({ sanitizePreset, sanitizeCalcState, sanitizeSettings, difficultyDefaults, VALID_QUIZ_IDS })',
  { console: { warn: (...args) => warnings.push(args.join(' ')), log() {}, error() {} } }
);

/* The iframe's settings normalizer, for a key-by-key comparison. */
const iframeApi = vm.runInNewContext(
  `function clamp(value, min, max, fallback) {
     var number = Number(value);
     if (!Number.isFinite(number)) number = fallback;
     return Math.min(max, Math.max(min, Math.round(number)));
   }`
  + section(presetsSource, 'function difficultySettings', 'function validTime', 'iframe settings')
  + ';({ difficultySettings, normalizeSettings })',
  {}
);

const botApi = vm.runInNewContext(
  section(botSource, 'function calculationDifficultyDefaults', 'function sanitizeCalculationSettings', 'bot difficulty')
  + ';({ calculationDifficultyDefaults })',
  {}
);

const results = [];
function test(name, fn) {
  try { fn(); results.push(`  ✓ ${name}`); }
  catch (error) { results.push(`  ✗ ${name}\n    ${error.message}`); process.exitCode = 1; }
}

/* ── list parity ─────────────────────────────────────────────────────────── */
test('all three question-type lists are identical', () => {
  assert.ok(iframeIds.length >= 25, `expected the full catalogue, parsed ${iframeIds.length}`);
  assert.deepEqual([...tabIds].sort(), [...iframeIds].sort(),
    'js/tabs/calc.js has drifted from calc/presets.js — presets using the missing types will be silently altered');
  assert.deepEqual([...botIds].sort(), [...iframeIds].sort(),
    'bot/bot-server.js has drifted from calc/presets.js');
});

test('the types this bug was about are present everywhere', () => {
  for (const id of ['tablewrite', 'mult2d', 'mult3d']) {
    assert.ok(iframeIds.includes(id), `calc/presets.js lost ${id}`);
    assert.ok(tabIds.includes(id), `js/tabs/calc.js is missing ${id}`);
    assert.ok(botIds.includes(id), `bot/bot-server.js is missing ${id}`);
  }
});

/* ── settings parity ─────────────────────────────────────────────────────── */
test('settings keys match the iframe exactly, for every difficulty', () => {
  for (const difficulty of ['easy', 'standard', 'exam', 'custom']) {
    const expected = Object.keys(iframeApi.normalizeSettings({}, difficulty)).sort();
    const actual = Object.keys(tabApi.sanitizeSettings({}, difficulty)).sort();
    assert.deepEqual(actual, expected, `settings drifted at difficulty "${difficulty}"`);
    assert.equal(expected.length, 17, 'expected the full settings shape');
  }
});

test('difficulty tables agree across all three copies', () => {
  for (const level of ['easy', 'standard', 'exam']) {
    const expected = iframeApi.difficultySettings(level);
    assert.deepEqual({ ...tabApi.difficultyDefaults(level) }, { ...expected }, `js/tabs/calc.js differs at "${level}"`);
    assert.deepEqual({ ...botApi.calculationDifficultyDefaults(level) }, { ...expected }, `bot differs at "${level}"`);
  }
});

test('a fully customised settings object survives untouched', () => {
  const custom = {
    digits: 3, sqMin: 7, sqMax: 41, cubeMin: 4, cubeMax: 19, multFrom: 13, multTo: 24,
    multiplierFrom: 3, multiplierTo: 17, mult2Min: 24, mult2Max: 88, mult3Min: 210, mult3Max: 870,
    mult3ByMin: 14, mult3ByMax: 77, primeMax: 250, ciYears: 4
  };
  assert.deepEqual({ ...tabApi.sanitizeSettings(custom, 'custom') }, custom,
    'a customised range must not be reset to a difficulty default');
});

test('out-of-order and out-of-range values are still clamped', () => {
  const fixed = tabApi.sanitizeSettings({ sqMin: 90, sqMax: 3, mult2Min: 5, mult2Max: 5000, digits: 99 }, 'standard');
  assert.ok(fixed.sqMin <= fixed.sqMax, 'reversed pair not ordered');
  assert.equal(fixed.mult2Min, 10, 'two-digit lower bound not clamped');
  assert.equal(fixed.mult2Max, 99, 'two-digit upper bound not clamped');
  assert.equal(fixed.digits, 4, 'digits not clamped');
});

/* ── the reported regression ─────────────────────────────────────────────── */
test('a preset built only from the previously missing types survives', () => {
  for (const id of ['tablewrite', 'mult2d', 'mult3d']) {
    const saved = tabApi.sanitizePreset({ id: `preset-${id}`, name: 'Quick', quizIds: [id] });
    assert.deepEqual(Array.from(saved.quizIds), [id], `${id} was stripped from the preset`);
    const state = tabApi.sanitizeCalcState({ presets: [saved] });
    assert.equal(state.presets.length, 1, `a ${id} preset was dropped from the synced state`);
    assert.equal(state.presets[0].id, `preset-${id}`);
    assert.ok(Object.hasOwn(state.presets[0].weights, id), `weights lost ${id}`);
  }
});

test('a mixed preset keeps every one of its types', () => {
  const saved = tabApi.sanitizePreset({ id: 'mixed', quizIds: ['mult1', 'tablewrite', 'mult3d', 'squares'] });
  assert.deepEqual(Array.from(saved.quizIds), ['mult1', 'tablewrite', 'mult3d', 'squares']);
});

test('an unknown type is backfilled and reported, never silently dropped', () => {
  warnings.length = 0;
  const saved = tabApi.sanitizePreset({ id: 'future', name: 'From a newer build', quizIds: ['quantum_maths'] });
  assert.deepEqual(Array.from(saved.quizIds), ['addition', 'subtraction', 'mult1'],
    'must match the iframe backfill so the two agree');
  assert.equal(tabApi.sanitizeCalcState({ presets: [saved] }).presets.length, 1, 'the preset must survive');
  assert.match(warnings.join(' '), /no recognized question types/);
});

/* ── multi-part presets ──────────────────────────────────────────────────── */
test('parts of a combined preset survive the round trip', () => {
  const saved = tabApi.sanitizePreset({
    id: 'combo',
    quizIds: ['mult2d', 'squares'],
    sequential: true,
    segments: [
      { name: 'Two-digit', quizIds: ['mult2d'], share: 12, weights: { mult2d: 4 }, settings: { mult2Min: 20, mult2Max: 60 } },
      { name: 'Squares', quizIds: ['squares'], share: 8, settings: { sqMin: 5, sqMax: 30 } }
    ]
  });
  assert.equal(saved.segments.length, 2, 'parts were dropped');
  assert.equal(saved.sequential, true);
  assert.equal(saved.segments[0].name, 'Two-digit');
  assert.deepEqual(Array.from(saved.segments[0].quizIds), ['mult2d']);
  assert.equal(saved.segments[0].share, 12);
  assert.equal(saved.segments[0].weights.mult2d, 4);
  assert.equal(saved.segments[0].settings.mult2Min, 20, "a part's own range must be kept");
  assert.equal(saved.segments[1].settings.sqMax, 30);
});

test('parts that no longer cover the selected types are discarded', () => {
  /* Mirrors normalizePreset(): a stale part would practise something the preset
     no longer lists. */
  const stale = tabApi.sanitizePreset({
    id: 'stale', quizIds: ['mult1'],
    segments: [{ name: 'A', quizIds: ['mult2d'] }, { name: 'B', quizIds: ['squares'] }]
  });
  assert.deepEqual(Array.from(stale.segments), []);
  assert.equal(stale.sequential, false);
});

/* ── every quick preset must round-trip ──────────────────────────────────── */
test('every quick preset in calc/presets.js survives the sanitizer', () => {
  const block = section(presetsSource, 'var TEMPLATE_PRESETS', '\n  ].map(', 'TEMPLATE_PRESETS');
  const entries = block.split(/\{\s*id:/).slice(1);
  assert.ok(entries.length >= 3, `expected quick presets, parsed ${entries.length}`);
  let checked = 0;
  for (const entry of entries) {
    const id = (entry.match(/^\s*'([\w-]+)'/) || [])[1];
    const quizBlock = (entry.match(/quizIds:\s*\[([^\]]*)\]/) || [])[1];
    if (!id || !quizBlock) continue;
    const ids = quotedIds(`[${quizBlock}]`);
    if (!ids.length) continue;
    checked++;
    const saved = tabApi.sanitizePreset({ id: `copy-of-${id}`, quizIds: ids });
    assert.deepEqual(Array.from(saved.quizIds), ids, `quick preset "${id}" lost question types`);
    assert.equal(tabApi.sanitizeCalcState({ presets: [saved] }).presets.length, 1,
      `quick preset "${id}" was dropped when synced`);
  }
  assert.ok(checked >= 3, `expected to check several quick presets, checked ${checked}`);
});

console.log('Calculation preset model sync');
console.log(results.join('\n'));
if (process.exitCode) {
  console.error('\nCalculation preset sync tests FAILED');
} else {
  console.log(`\n${results.length} checks passed`);
}
