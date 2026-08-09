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

console.log('\nMulti-video notebook browser contracts');
console.log(results.join('\n'));
if (!process.exitCode) console.log(`\n${results.length} checks passed`);
