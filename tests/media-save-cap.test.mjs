/* Course Library save cap: the precedence between the per-user admin override,
   the admin-set Pro cap and the free cap, plus the re-import exemption. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gatingSource = readFileSync(resolve(root, 'js/features/preppath-phase4-gating.js'), 'utf8');
const plansSource = readFileSync(resolve(root, 'js/features/preppath-phase2-plans.js'), 'utf8');
const adminActions = readFileSync(resolve(root, 'js/admin/admin-actions.js'), 'utf8');
const adminRender = readFileSync(resolve(root, 'js/admin/admin-render.js'), 'utf8');
const organiser = readFileSync(resolve(root, 'js/tabs/playlist-organiser.js'), 'utf8');
const notebook = readFileSync(resolve(root, 'js/tabs/yt-notebook.js'), 'utf8');

function section(source, from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + 1);
  assert.ok(start !== -1 && end > start, `could not locate section: ${from}`);
  return source.slice(start, end);
}

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(`  ✓ ${name}`); }
  catch (error) { results.push(`  ✗ ${name}\n    ${error.message}`); process.exitCode = 1; }
}

/* Load the cap resolver with a controllable profile / plan / library. */
function loadCap({ saved = 0, pro = false, profile = {}, free = {} } = {}) {
  const toasts = [];
  const locked = [];
  const lib = {};
  for (let i = 0; i < saved; i += 1) lib['PL' + i] = { id: 'PL' + i };
  const context = {
    currentUser: { uid: 'u1' },
    EZ_PROFILE: profile,
    EZ_FREE_LIMITS: { mediaSaves: 3, proMediaSaves: 20, ...free },
    ezIsPro: () => pro,
    ytoLib: () => lib,
    showToast: (msg, kind) => toasts.push({ msg, kind }),
    ezLockedMsg: (msg) => locked.push(msg),
    window: {},
    isFinite, Number, Object
  };
  const api = vm.runInNewContext(
    section(gatingSource, 'const EZ_SAVES_UNLIMITED = -1;', 'const _ytoLoadGate = ytoLoadPlaylist;') +
    ';({ max: ezMediaSaveMax, denied: ezMediaSaveDenied, guard: ezMediaSaveGuard })',
    context
  );
  return { ...api, toasts, locked, lib };
}

await test('a Pro user gets the admin-set cap, defaulting to 20', () => {
  assert.equal(loadCap({ pro: true }).max(), 20);
  assert.equal(loadCap({ pro: true, free: { proMediaSaves: 50 } }).max(), 50);
  // A corrupt or cleared value must not become "no saves allowed".
  assert.equal(loadCap({ pro: true, free: { proMediaSaves: 0 } }).max(), 20);
  assert.equal(loadCap({ pro: true, free: { proMediaSaves: null } }).max(), 20);
});

await test('a free user gets the free cap, not the Pro one', () => {
  assert.equal(loadCap({ pro: false }).max(), 3);
  assert.equal(loadCap({ pro: false, free: { mediaSaves: 7 } }).max(), 7);
});

await test('a per-user override beats both plan caps', () => {
  assert.equal(loadCap({ pro: true, profile: { mediaSavesMax: 100 } }).max(), 100);
  // Lowering one account below the Pro cap has to work too, not just raising it.
  assert.equal(loadCap({ pro: true, profile: { mediaSavesMax: 5 } }).max(), 5);
  assert.equal(loadCap({ pro: false, profile: { mediaSavesMax: 40 } }).max(), 40);
});

await test('an unlimited grant is truly unlimited', () => {
  const cap = loadCap({ pro: true, saved: 5000, profile: { mediaSavesMax: -1 } });
  assert.equal(cap.max(), Infinity);
  assert.equal(cap.denied(null), '');
  assert.equal(cap.guard(null), false);
});

await test('saves are blocked only once the cap is actually reached', () => {
  assert.equal(loadCap({ pro: true, saved: 19 }).denied(null), '');
  assert.notEqual(loadCap({ pro: true, saved: 20 }).denied(null), '');
  assert.notEqual(loadCap({ pro: true, saved: 25 }).denied(null), '');
});

await test('re-importing something already saved never counts against the cap', () => {
  const cap = loadCap({ pro: true, saved: 20 });
  assert.equal(cap.denied({ id: 'PL0' }), '', 'a re-sync of an existing course must be allowed');
  assert.notEqual(cap.denied(null), '');
});

await test('a signed-out visitor is not gated by a per-account cap', () => {
  const context = {
    currentUser: null, EZ_PROFILE: {},
    EZ_FREE_LIMITS: { mediaSaves: 3, proMediaSaves: 20 },
    ezIsPro: () => false, ytoLib: () => ({ a: 1, b: 2, c: 3, d: 4 }),
    showToast: () => {}, ezLockedMsg: () => {}, window: {}, isFinite, Number, Object
  };
  const api = vm.runInNewContext(
    section(gatingSource, 'const EZ_SAVES_UNLIMITED = -1;', 'const _ytoLoadGate = ytoLoadPlaylist;') +
    ';({ denied: ezMediaSaveDenied })', context
  );
  assert.equal(api.denied(null), '');
});

await test('a blocked free user is offered the upgrade, a Pro user is not', () => {
  const free = loadCap({ pro: false, saved: 3 });
  assert.equal(free.guard(null), true);
  assert.equal(free.locked.length, 1);
  assert.match(free.locked[0], /Pro mein 20 tak/);
  assert.equal(free.toasts.length, 0);

  const pro = loadCap({ pro: true, saved: 20 });
  assert.equal(pro.guard(null), true);
  assert.equal(pro.locked.length, 0, 'a paying user must not be shown an upgrade prompt');
  assert.equal(pro.toasts.length, 1);
  assert.match(pro.toasts[0].msg, /max 20 playlists/);
});

await test('the Pro cap reaches the app from admin config, not a literal', () => {
  // The whole point of the change: no hard-coded 20 left in the gate, and the
  // value the admin panel writes is the value the app reads.
  const gate = section(gatingSource, 'const _ytoLoadGate = ytoLoadPlaylist;', '/* 6. Chapter video links');
  assert.doesNotMatch(gate, /\b20\b/, 'the gate must not hard-code the cap any more');
  assert.match(plansSource, /proMediaSaves:\s+\(fd\.proMediaSaves/);
  assert.match(adminActions, /proMediaSaves/);
  assert.match(adminRender, /id="free-pro-media"/);
});

await test('every save path is guarded, not just the organiser URL box', () => {
  // The original gate wrapped ytoLoadPlaylist only, so these three paths wrote
  // to the library without ever consulting the cap.
  const channelImport = section(organiser, 'async function ytoImportChannelPlaylist(plId, btn)', 'const orig = btn ? btn.innerHTML');
  assert.match(channelImport, /ezMediaSaveGuard/, 'channel ＋ button');
  assert.match(section(organiser, 'async function ytoSaveChannelVideo(videoId, btn)', 'const orig = btn ?'),
    /ezMediaSaveGuard/, 'channel single-video save');
  assert.match(section(organiser, 'async function ytoLoadSingleVideo(vId)', 'const info = await ytFetchVideoInfo'),
    /ezMediaSaveGuard/, 'single video URL');
  assert.match(notebook, /ezMediaSaveDenied/, 'notebook URL import');
  // The bulk channel import must stop AT the cap rather than blow past it.
  assert.match(organiser, /ezMediaSaveDenied\(null\);\s*\n\s*if \(capMsg\) \{ showToast/);
});

await test('saving plan limits cannot wipe the rest of the free-tier config', () => {
  const save = section(adminActions, 'async function saveFreeLimits()', 'async function setMediaSaveLimit(id)');
  assert.match(save, /\{ merge: true \}/, 'config/free also holds mocksPerDay, aiTutorPerDay and the telegram flags');
  assert.match(save, /Math\.max\(1, Math\.min\(500,/, 'a typo must not lock Pro users out of saving');
});

await test('the per-user limit accepts a number, unlimited, or a reset', () => {
  const fn = section(adminActions, 'async function setMediaSaveLimit(id)', 'async function giveTrial(id)');
  assert.match(fn, /'u' \|\| text === 'unlimited' \|\| text === '-1'/);
  assert.match(fn, /FieldValue\.delete\(\)/, 'blank must clear the override, not store 0');
  assert.match(fn, /profile\.mediaSavesMax/);
  assert.match(fn, /adminLog\('set_media_saves'/);
});

console.log('\nCourse Library save cap');
console.log(results.join('\n'));
if (!process.exitCode) console.log(`\n${results.length} checks passed`);
