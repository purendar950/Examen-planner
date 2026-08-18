/* Multi-video notebook browser contracts that cross the notebook page and unified shelf. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const notebookSource = readFileSync(resolve(root, 'js/tabs/yt-notebook.js'), 'utf8');
const librarySource = readFileSync(resolve(root, 'js/features/notes-library.js'), 'utf8');

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

const savedKey = vm.runInNewContext(
  section(notebookSource, 'function ytnbSavedKey(entry)', '/* Record a finished notebook') +
  ';ytnbSavedKey', {}
);
const libraryKey = vm.runInNewContext(
  section(librarySource, '  function notebookKey(e)', '  /* Record a single-video note') +
  ';notebookKey', {}
);

await test('unified shelf and notebook page use the same route-aware key', () => {
  const entry = {
    fp: 'abc12345', shape: 'merge', mode: 'notes', style: 'topic', lang: 'English',
    cacheProvider: 'gemini', cacheModel: 'gemini-2.5-flash'
  };
  assert.equal(libraryKey(entry).replace(/^nb\|/, ''), savedKey(entry));
});

await test('legacy recipes use matching empty route fields', () => {
  const entry = { fp: 'abc12345', shape: 'compile', mode: 'summary', lang: 'Hinglish' };
  assert.equal(libraryKey(entry).replace(/^nb\|/, ''), savedKey(entry));
  assert.ok(savedKey(entry).endsWith('||'));
});

await test('different provider/model recipes remain separately addressable', () => {
  const base = { fp: 'abc12345', shape: 'merge', mode: 'notes', style: 'topic', lang: 'English' };
  assert.notEqual(
    savedKey({ ...base, cacheProvider: 'gemini', cacheModel: 'model-a' }),
    savedKey({ ...base, cacheProvider: 'gemini', cacheModel: 'model-b' })
  );
});

await test('saved-body rebuild reuses lecture caches instead of force-regenerating', () => {
  const entry = {
    ids: ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'], courseId: 'course',
    shape: 'merge', mode: 'notes', style: 'topic', lang: 'English',
    cacheProvider: 'gemini', cacheModel: 'model-a'
  };
  let started = null;
  const context = {
    _ytnbMaxVideos: 2,
    YTNB_OPTS_KEY: 'opts',
    ytnbKit: () => ({
      newJobId: () => 'job-12345678901234567890',
      provider: () => 'fallback-provider', model: () => 'fallback-model'
    }),
    ytnbFindSaved: () => entry,
    ytnbSaveSelection: () => {},
    localStorage: { setItem: () => {} },
    ytnbApplyOptionsToUi: () => {},
    ytnbStart: (job) => { started = job; }
  };
  const rebuild = vm.runInNewContext(
    section(notebookSource, 'function ytnbRebuildSaved(key)', '/* ── entry points') +
    ';ytnbRebuildSaved', context
  );
  rebuild('key');
  assert.ok(started);
  assert.equal(started.force, false);
  assert.equal(started.rebuild, true);
  assert.equal(started.ids.join(','), 'aaaaaaaaaaa,bbbbbbbbbbb');
  assert.equal(started.provider, 'gemini');
  assert.equal(started.model, 'model-a');
});

await test('regenerate uses the notebook being viewed, not stale picker selection', () => {
  let started = null;
  const shown = {
    ids: ['aaaaaaaaaaa', 'bbbbbbbbbbb'], courseId: 'viewed-course',
    shape: 'compile', mode: 'summary', style: 'topic', lang: 'Hindi',
    provider: 'gemini', model: 'model-viewed'
  };
  const context = {
    _ytnbDisplayedRecipe: shown,
    _ytnbMaxVideos: 15,
    ytnbKit: () => ({
      newJobId: () => 'job-12345678901234567890',
      provider: () => 'wrong-provider', model: () => 'wrong-model'
    }),
    ytnbStart: (job) => { started = job; },
    ytnbOptions: () => ({ shape: 'merge', mode: 'notes', style: 'topic', lang: 'English' }),
    ytnbSelection: () => [{ id: 'zzzzzzzzzzz', courseId: 'wrong-course' }],
    ytnbBackToPicker: () => {},
    Set
  };
  const regenerate = vm.runInNewContext(
    section(notebookSource, 'function ytnbRegenerate()', '/* Reattach to a notebook') +
    ';ytnbRegenerate', context
  );
  regenerate();
  assert.ok(started);
  assert.equal(started.ids.join(','), shown.ids.join(','));
  assert.equal(started.courseId, 'viewed-course');
  assert.equal(started.model, 'model-viewed');
  assert.equal(started.force, true);
});

await test('server-accepted video IDs replace a broader pre-cap selection', async () => {
  let finishedJob = null;
  const savedJobs = [];
  const kit = {
    provider: () => 'gemini', model: () => 'model-a',
    stageMessage: () => '',
    reserveServer: async () => 'ai-owner',
    responseServer: () => ({ id: 'ai-owner' }),
    authFetch: async () => ({
      ok: true,
      json: async () => ({
        jobId: 'job-12345678901234567890', status: 'completed', content: 'done',
        videoIds: ['aaaaaaaaaaa', 'bbbbbbbbbbb']
      })
    })
  };
  const context = {
    ytnbKit: () => kit,
    ytnbSaveJob: (job) => savedJobs.push([...job.ids]),
    ytnbShowView: () => {},
    document: { getElementById: () => null },
    ytnbRenderChecklist: () => {},
    ytnbSetTools: () => {},
    ytnbFinish: (job) => { finishedJob = { ...job, ids: [...job.ids] }; },
    ytnbEnded: () => {},
    ytnbStream: () => {}
  };
  const start = vm.runInNewContext(
    section(notebookSource, 'function ytnbStart(job, isResume)', 'function ytnbStream(job, created)') +
    ';ytnbStart', context
  );
  start({
    jobId: 'job-12345678901234567890', ids: ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'],
    courseId: 'course', shape: 'merge', mode: 'notes', style: 'topic', lang: 'English'
  }, false);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.ok(finishedJob);
  assert.equal(finishedJob.ids.join(','), 'aaaaaaaaaaa,bbbbbbbbbbb');
  assert.equal(savedJobs.at(-1).join(','), 'aaaaaaaaaaa,bbbbbbbbbbb');
});

await test('import success waits for immediate cloud persistence', async () => {
  let persisted = 0;
  const helper = vm.runInNewContext(
    section(notebookSource, 'async function ytnbPersistImportedLibrary()', 'async function ytnbImportUrl()') +
    ';ytnbPersistImportedLibrary',
    { ytoPersist: () => { persisted += 1; }, saveProgressNow: async () => true }
  );
  await helper();
  assert.equal(persisted, 1);
});

await test('an unsynced import is not reported as ready for generation', async () => {
  const helper = vm.runInNewContext(
    section(notebookSource, 'async function ytnbPersistImportedLibrary()', 'async function ytnbImportUrl()') +
    ';ytnbPersistImportedLibrary',
    { ytoPersist: () => {}, saveProgressNow: async () => false }
  );
  await assert.rejects(helper(), /could not sync to the cloud/i);
});

/* The run view has no real DOM here, so these stand in for the few elements the
   progress bar and live panel touch. */
function fakeEl() {
  return {
    hidden: true, textContent: '', innerHTML: '', scrollTop: 0, scrollHeight: 400,
    style: {}, attrs: {}, flags: {},
    classList: {
      toggle(name, on) { this.owner.flags[name] = !!on; },
      add(name) { this.owner.flags[name] = true; },
      remove(name) { this.owner.flags[name] = false; }
    },
    setAttribute(key, value) { this.attrs[key] = value; }
  };
}
function fakeDoc(ids) {
  const els = {};
  ids.forEach((id) => {
    const el = fakeEl();
    el.classList.owner = el;
    els[id] = el;
  });
  return { els, getElementById: (id) => els[id] || null };
}
const BAR_IDS = ['ytnb-bar', 'ytnb-bar-track', 'ytnb-bar-fill', 'ytnb-bar-phase',
  'ytnb-bar-pct', 'ytnb-bar-eta'];
const PHASE_LABELS = {
  queued: 'Getting ready…', lectures: 'Reading lectures', merging: 'Merging topics',
  assembling: 'Finishing the notebook', done: 'Notebook ready'
};

function loadBar(doc) {
  const context = {
    document: doc, Date, Math, Number, String,
    YTNB_PHASES: PHASE_LABELS, _ytnbBarStart: 0, _ytnbBarShown: 0
  };
  const api = vm.runInNewContext(
    section(notebookSource, 'function ytnbCount(n)', '/* ── live writing panel') +
    ';({ paint: ytnbPaintBar, phase: ytnbPhaseText, eta: ytnbEtaText, count: ytnbCount })',
    context
  );
  api.context = context;
  return api;
}

await test('the bar keeps moving through the topic merge instead of parking at 100%', () => {
  const doc = fakeDoc(BAR_IDS);
  const bar = loadBar(doc);
  const readyItems = [{ state: 'ready' }, { state: 'ready' }, { state: 'ready' }];
  bar.paint(readyItems, 3, 'running',
    { progress: 71, phase: 'merging', mergeDone: 0, mergeTotal: 8 });
  assert.equal(doc.els['ytnb-bar-fill'].style.width, '71%');
  bar.paint(readyItems, 3, 'running',
    { progress: 83, phase: 'merging', mergeDone: 4, mergeTotal: 8 });
  assert.equal(doc.els['ytnb-bar-fill'].style.width, '83%');
  // The lectures are all done, so a bar built from lecture counts alone would
  // have read 100% for this entire stage. It must name the real work instead.
  assert.equal(doc.els['ytnb-bar-phase'].textContent, 'Merging topics — 4 of 8');
  assert.equal(doc.els['ytnb-bar-pct'].textContent, '83%');
});

await test('a bar that would go backwards holds its position', () => {
  const doc = fakeDoc(BAR_IDS);
  const bar = loadBar(doc);
  const items = [{ state: 'ready' }, { state: 'processing' }];
  bar.paint(items, 1, 'running', { progress: 60, phase: 'lectures' });
  bar.paint(items, 1, 'running', { progress: 40, phase: 'lectures' });
  assert.equal(doc.els['ytnb-bar-fill'].style.width, '60%');
});

await test('a finished notebook fills the bar and says so', () => {
  const doc = fakeDoc(BAR_IDS);
  const bar = loadBar(doc);
  bar.paint([{ state: 'ready' }], 1, 'completed', { progress: 97, phase: 'assembling' });
  assert.equal(doc.els['ytnb-bar-fill'].style.width, '100%');
  assert.equal(doc.els['ytnb-bar-phase'].textContent, PHASE_LABELS.done);
  assert.equal(doc.els['ytnb-bar-track'].attrs['aria-valuenow'], '100');
  assert.equal(doc.els['ytnb-bar-eta'].textContent, '');
});

await test('a proxy that reports no progress still drives the bar from lectures', () => {
  const doc = fakeDoc(BAR_IDS);
  const bar = loadBar(doc);
  const items = [{ state: 'ready' }, { state: 'ready' }, { state: 'queued' }, { state: 'queued' }];
  bar.paint(items, 2, 'running', null);
  const pct = Number(String(doc.els['ytnb-bar-fill'].style.width).replace('%', ''));
  assert.ok(pct > 40 && pct < 60, `unexpected fallback width: ${pct}`);
  assert.equal(doc.els['ytnb-bar-phase'].textContent, 'Reading lectures — 2 of 4');
});

await test('no time estimate is shown before there is enough of a run to judge', () => {
  const doc = fakeDoc(BAR_IDS);
  const bar = loadBar(doc);
  bar.context._ytnbBarStart = Date.now();          // this instant
  assert.equal(bar.eta(50), '');
  bar.context._ytnbBarStart = Date.now() - 60000;   // a minute in, halfway
  assert.match(bar.eta(50), /min left|s left|almost done/);
});

await test('live writing is shown separately from the notebook itself', () => {
  const doc = fakeDoc(['ytnb-live', 'ytnb-live-what', 'ytnb-live-count', 'ytnb-live-text']);
  const render = vm.runInNewContext(
    section(notebookSource, 'function ytnbRenderLive(preview, active)', 'function ytnbLectureMap(items)') +
    ';ytnbRenderLive',
    { document: doc, ytnbCount: (n) => `${n} chars` }
  );
  render({ label: 'V2', title: 'Lecture two', text: '## Gravity\n\n- being written', chars: 26 }, true);
  assert.equal(doc.els['ytnb-live'].hidden, false);
  assert.equal(doc.els['ytnb-live-what'].textContent, 'Writing V2 · Lecture two');
  assert.match(doc.els['ytnb-live-text'].textContent, /being written/);
  // Nothing is being written any more, so the panel must not linger.
  render(null, false);
  assert.equal(doc.els['ytnb-live'].hidden, true);
  // A stream that has produced nothing yet is not "live" either.
  render({ label: 'V1', title: 'Lecture one', text: '   ', chars: 0 }, true);
  assert.equal(doc.els['ytnb-live'].hidden, true);
});

await test('a lecture being written reports how much of it exists', () => {
  const doc = fakeDoc(['ytnb-checklist', 'ytnb-progress-summary']);
  const context = {
    document: doc, Date, Number,
    YTNB_STATES: {
      queued: { icon: '○', label: 'queued' },
      processing: { icon: '◍', label: 'reading captions…' },
      ready: { icon: '●', label: 'notes ready' }
    },
    ytnbEsc: (value) => String(value == null ? '' : value),
    ytnbCount: (n) => `${n} chars`,
    ytnbPaintBar: () => {},
    _ytnbBarStart: 0, _ytnbBarShown: 0
  };
  const renderChecklist = vm.runInNewContext(
    section(notebookSource, 'function ytnbRenderChecklist(items, counts, status, run)', '/* ── progress bar') +
    ';ytnbRenderChecklist',
    context
  );
  renderChecklist([
    { label: 'V1', video_id: 'aaaaaaaaaaa', title: 'One', state: 'ready', source: 'cached' },
    { label: 'V2', video_id: 'bbbbbbbbbbb', title: 'Two', state: 'processing', chars: 1800 },
    { label: 'V3', video_id: 'ccccccccccc', title: 'Three', state: 'processing' }
  ], { ready: 1 }, 'running');
  const html = doc.els['ytnb-checklist'].innerHTML;
  assert.match(html, /writing… 1800 chars/);
  assert.match(html, /reused saved notes/);
  // A lecture that has not produced text yet keeps the honest caption.
  assert.match(html, /reading captions…/);
});

await test('a merged notebook is never advertised as instant', () => {
  function estimateFor(opts, ids, cached) {
    const doc = fakeDoc(['ytnb-estimate', 'ytnb-go', 'ytnb-shape-link']);
    const context = {
      document: doc, Math, Number,
      YTNB_SECS_PER_VIDEO: 45, YTNB_LECTURE_PARALLELISM: 2.2, YTNB_MERGE_SECS_PER_VIDEO: 14,
      _ytnbMaxVideos: 15,
      _ytnbCached: cached,
      ytnbSelectedIds: () => ids,
      ytnbOptions: () => opts,
      ytnbShapeLabel: () => 'shape',
      ytnbStyleLabel: () => 'style',
      ytnbModeLabel: () => 'mode'
    };
    const update = vm.runInNewContext(
      section(notebookSource, 'function ytnbUpdateEstimate()', 'function ytnbStyleLabel(style)') +
      ';ytnbUpdateEstimate',
      context
    );
    update();
    return doc.els['ytnb-estimate'].innerHTML;
  }
  const ids = ['a', 'b', 'c', 'd'];
  const allCached = { a: true, b: true, c: true, d: true };
  // Every lecture is saved, but a merged notebook still has to WRITE the topic
  // pass, so promising "ready instantly" was simply false.
  const merged = estimateFor({ shape: 'merge', mode: 'notes', style: 'topic', lang: 'English' }, ids, allCached);
  assert.doesNotMatch(merged, /ready instantly/);
  assert.match(merged, /~\d+ min/);
  // A compiled notebook over saved lectures genuinely is instant.
  const compiled = estimateFor({ shape: 'compile', mode: 'notes', style: 'topic', lang: 'English' }, ids, allCached);
  assert.match(compiled, /ready instantly/);
});

await test('the estimate reflects that lectures are read concurrently', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const doc = fakeDoc(['ytnb-estimate', 'ytnb-go', 'ytnb-shape-link']);
  const update = vm.runInNewContext(
    section(notebookSource, 'function ytnbUpdateEstimate()', 'function ytnbStyleLabel(style)') +
    ';ytnbUpdateEstimate',
    {
      document: doc, Math, Number,
      YTNB_SECS_PER_VIDEO: 45, YTNB_LECTURE_PARALLELISM: 2.2, YTNB_MERGE_SECS_PER_VIDEO: 14,
      _ytnbMaxVideos: 15, _ytnbCached: {},
      ytnbSelectedIds: () => ids,
      ytnbOptions: () => ({ shape: 'merge', mode: 'notes', style: 'topic', lang: 'English' }),
      ytnbShapeLabel: () => 'shape', ytnbStyleLabel: () => 'style', ytnbModeLabel: () => 'mode'
    }
  );
  update();
  const reported = Number(/~(\d+) min/.exec(doc.els['ytnb-estimate'].innerHTML)[1]);
  // The old model was strictly one lecture after another plus a flat 40s merge.
  const sequential = Math.max(1, Math.round((ids.length * 45 + 40) / 60));
  assert.ok(reported < sequential, `expected under ${sequential} min, got ${reported}`);
  assert.ok(reported >= 1);
});

console.log('\nMulti-video notebook browser contracts');
console.log(results.join('\n'));
if (!process.exitCode) console.log(`\n${results.length} checks passed`);
