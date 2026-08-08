/*
 * /calc preset-list keyboard tests.
 *
 * The list used to be plain text, so starting a preset meant retyping its name.
 * It now carries one launch button per preset. The details that matter and are
 * easy to break silently:
 *
 *   - button labels are plain text, so HTML-escaping them would print a literal
 *     "&amp;" on the button;
 *   - `web_app` only works over https and only in private chats, so a non-https
 *     base and the rejection fallback must both degrade to plain url buttons;
 *   - the list is capped, and the overflow note is the only way the remaining
 *     presets stay reachable.
 *
 * Exercised against the real source in bot/bot-server.js (the functions are
 * evaluated in a sandbox, so no bot token or Firebase project is needed).
 *
 * Run with:  npm run test:calc-command      (also part of `npm run check`)
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

const api = vm.runInNewContext(
  section('const CALC_PRESET_LIST_LIMIT', 'bot.onText(/^\\/calc')
  + ';({ calculationPresetListButtons, calculationPresetButtonLabel, calculationPresetOverflowNote,'
  + ' findCalculationPreset, CALC_PRESET_LIST_LIMIT })',
  { console: { warn() {}, log() {}, error() {} } }
);

const BASE = 'https://purendar950.github.io/Examen-planner';
const LIMIT = api.CALC_PRESET_LIST_LIMIT;

const preset = (id, name, icon) => ({ id, name, icon: icon || '🧮' });
const SIX = [
  preset('p1', 'Mixed Practice (8 presets)', '🧠'),
  preset('p2', 'Pythagorean Triples', '🧠'),
  preset('p3', 'Fraction Form', '🎯'),
  preset('p4', 'Compound Interest · 3 Years', '📈'),
  preset('p5', 'Cubes', '🎲'),
  preset('p6', 'Squares', '🏆')
];

const results = [];
function test(name, fn) {
  try { fn(); results.push(`  ✓ ${name}`); }
  catch (error) { results.push(`  ✗ ${name}\n    ${error.message}`); process.exitCode = 1; }
}

const flatten = rows => rows.flat();

/* ── layout ──────────────────────────────────────────────────────────────── */
test('one button row per preset, in order, plus one shared browser row', () => {
  const rows = api.calculationPresetListButtons(SIX, BASE);
  assert.equal(rows.length, SIX.length + 1, 'expected a row per preset and one browser row');
  rows.slice(0, SIX.length).forEach((row, index) => {
    assert.equal(row.length, 1, 'names are long; one button per row keeps them readable');
    assert.match(row[0].text, new RegExp(SIX[index].name.replace(/[.*+?^${}()|[\]\\·]/g, '\\$&')));
  });
  const last = rows[rows.length - 1];
  assert.equal(last.length, 1);
  assert.match(last[0].text, /Open in browser/);
  assert.equal(last[0].url, `${BASE}/app.html?open=calc`);
  assert.ok(!last[0].web_app, 'the shared row must be a plain link');
});

test('each preset button launches the Mini App for that preset', () => {
  const rows = api.calculationPresetListButtons(SIX, BASE);
  assert.equal(rows[0][0].web_app.url, `${BASE}/calc/index.html?tgpreset=p1`);
  assert.equal(rows[4][0].web_app.url, `${BASE}/calc/index.html?tgpreset=p5`);
  /* Exactly one web_app per preset row, and none on the shared row. */
  assert.equal(flatten(rows).filter(button => button.web_app).length, SIX.length);
});

test('a preset id is URL-encoded into the launch link', () => {
  const rows = api.calculationPresetListButtons([preset('a b&c=d', 'Odd')], BASE);
  assert.equal(rows[0][0].web_app.url, `${BASE}/calc/index.html?tgpreset=a%20b%26c%3Dd`);
});

test('a trailing slash on the base does not double up', () => {
  const rows = api.calculationPresetListButtons(SIX, `${BASE}///`);
  assert.equal(rows[0][0].web_app.url, `${BASE}/calc/index.html?tgpreset=p1`);
});

/* ── labels ──────────────────────────────────────────────────────────────── */
test('labels are plain text, never HTML-escaped', () => {
  /* On a button "&" must stay "&" — escaping would render "&amp;" literally. */
  const label = api.calculationPresetButtonLabel(preset('x', 'Squares & Cubes <fast>', '🏆'));
  assert.ok(label.includes('Squares & Cubes <fast>'), `escaped label: ${label}`);
  assert.ok(!label.includes('&amp;'));
  assert.ok(!label.includes('&lt;'));
  assert.ok(!/<b>/.test(label), 'no HTML tags belong in button text');
});

test('labels carry the play affordance and the icon, and stay bounded', () => {
  assert.match(api.calculationPresetButtonLabel(SIX[0]), /^▶ 🧠 Mixed Practice/);
  const long = api.calculationPresetButtonLabel(preset('x', 'N'.repeat(120)));
  assert.ok(long.length <= 4 + 4 + 40 + 2, `label not bounded: ${long.length} chars`);
});

test('a preset with no name or icon still produces a usable label', () => {
  assert.equal(api.calculationPresetButtonLabel({ id: 'x' }), '▶ 🧮 Practice');
  assert.equal(api.calculationPresetButtonLabel({ id: 'x', name: '   ' }), '▶ 🧮 Practice');
});

/* ── degrading when the Mini App cannot be used ──────────────────────────── */
test('browserOnly turns every row into a plain link and drops the shared row', () => {
  const rows = api.calculationPresetListButtons(SIX, BASE, { browserOnly: true });
  assert.equal(rows.length, SIX.length, 'no shared row when each row is already a link');
  assert.equal(flatten(rows).filter(button => button.web_app).length, 0, 'no Mini App buttons may survive');
  assert.equal(rows[0][0].url, `${BASE}/app.html?open=calc&preset=p1`,
    'the fallback must still open the specific preset');
  rows.forEach(row => assert.match(row[0].text, /^▶ /, 'labels stay the same'));
});

test('a non-https base cannot produce a Mini App button', () => {
  /* Telegram refuses web_app over plain http, which would fail the whole
     message rather than just the button. */
  const rows = api.calculationPresetListButtons(SIX, 'http://localhost:5173/Examen-planner');
  assert.equal(flatten(rows).filter(button => button.web_app).length, 0);
  assert.ok(rows.every(row => row[0].url), 'every row must still be tappable');
  assert.equal(rows.length, SIX.length);
});

/* ── the cap and its note ────────────────────────────────────────────────── */
test('the list is capped and stays inside Telegram limits', () => {
  const many = Array.from({ length: 30 }, (_, index) => preset(`p${index}`, `Preset ${index}`));
  const rows = api.calculationPresetListButtons(many, BASE);
  assert.equal(rows.length, LIMIT + 1, `expected ${LIMIT} presets plus the browser row`);
  assert.ok(flatten(rows).length <= 100, 'inline keyboards are limited to 100 buttons');
  assert.equal(rows[0][0].web_app.url, `${BASE}/calc/index.html?tgpreset=p0`, 'the cap keeps the first presets');
});

test('the overflow note appears only when presets are hidden', () => {
  assert.equal(api.calculationPresetOverflowNote(SIX), '', 'no note when nothing is hidden');
  assert.equal(api.calculationPresetOverflowNote(Array.from({ length: LIMIT }, (_, i) => preset(`p${i}`, 'x'))), '');
  const note = api.calculationPresetOverflowNote(Array.from({ length: LIMIT + 5 }, (_, i) => preset(`p${i}`, 'x')));
  assert.match(note, /\/calc/, 'a hidden preset must stay reachable by name');
  assert.ok(note.includes('&lt;name&gt;'), 'the note is HTML, so the placeholder must be escaped');
});

test('an empty list produces no keyboard at all', () => {
  /* sendWithMiniAppFallback omits reply_markup for an empty array rather than
     sending an empty keyboard. */
  assert.deepEqual(api.calculationPresetListButtons([], BASE), []);
});

/* ── name matching feeding the list ──────────────────────────────────────── */
test('matching prefers id, then exact name, then a unique prefix', () => {
  assert.equal(api.findCalculationPreset(SIX, 'p3').preset.id, 'p3');
  assert.equal(api.findCalculationPreset(SIX, 'cubes').preset.id, 'p5');
  assert.equal(api.findCalculationPreset(SIX, 'MIXED').preset.id, 'p1', 'matching is case-insensitive');
  assert.equal(api.findCalculationPreset(SIX, 'squa').preset.id, 'p6');
});

test('an ambiguous term returns the candidates instead of guessing', () => {
  const pair = [preset('a', 'Speed Round A'), preset('b', 'Speed Round B')];
  const found = api.findCalculationPreset(pair, 'speed');
  assert.equal(found.preset, null);
  assert.equal(found.matches.length, 2, 'both candidates are offered as buttons');
});

test('an unknown term matches nothing', () => {
  const found = api.findCalculationPreset(SIX, 'nonsense');
  assert.equal(found.preset, null);
  /* Array.from crosses back into this realm, so the comparison is not a
     prototype mismatch against the sandbox's Array. */
  assert.deepEqual(Array.from(found.matches), []);
});

console.log('/calc preset list keyboard');
console.log(results.join('\n'));
if (process.exitCode) {
  console.error('\n/calc keyboard tests FAILED');
} else {
  console.log(`\n${results.length} checks passed`);
}
