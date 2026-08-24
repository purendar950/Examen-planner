/* AI Chat — YouTube attachment client helpers.
 *
 * Covers the pure logic behind the transcript attachment, all of which shipped
 * broken or missing in the first cut of the feature:
 *
 *   parseClock         the Section inputs. A student writes "90" meaning ninety
 *                      MINUTES into a lecture, not ninety seconds, and an
 *                      invalid entry must be rejected rather than silently
 *                      becoming a window that drops the whole video.
 *   readRangeInputs    the same, plus the inverted-range guard.
 *   ytFitsWhole        whether to warn that a lecture is too long to be read in
 *                      one request. Silence here is what made a 5-hour video
 *                      look like it had been summarised in full.
 *   isOversizedFailure recognising a provider's "prompt too long" rejection, so
 *                      the identical oversized request is not simply retried.
 *
 * The helpers live inside ai-chat.js's IIFE, so they are sliced out and run in a
 * vm with a tiny DOM stub — the same approach as media-save-cap.test.mjs.
 *
 * Run with:  node tests/ai-chat-youtube.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(root, 'js/tabs/ai-chat.js'), 'utf8');

function section(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + 1);
  assert.ok(start !== -1 && end > start, `could not locate section: ${from}`);
  return source.slice(start, end);
}

const results = [];
function test(name, fn) {
  try { fn(); results.push(`  \u2713 ${name}`); }
  catch (error) { results.push(`  \u2717 ${name}\n    ${error.message}`); process.exitCode = 1; }
}

/* The range inputs are read straight off the DOM, so the stub lets each case
   choose what the two fields contain. */
function load(fields = {}) {
  const elements = {
    'aic-yt-from-input': { value: fields.from ?? '' },
    'aic-yt-to-input': { value: fields.to ?? '' }
  };
  const context = {
    document: { getElementById: (id) => elements[id] || null },
    // No status payload and no thread: stands for "the selected route's window is
    // unknown", which is what makes ytFitsWhole fall back to the backstop.
    _statusCache: null,
    getThread: () => null,
    currentThreadId: () => 't1'
  };
  vm.createContext(context);
  vm.runInContext(
    [
      section('function parseClock(raw) {', 'function readRangeInputs()'),
      section('function readRangeInputs() {', '/* Backstop matching the'),
      section('var YT_WHOLE_VIDEO_CHARS =', '  var _ytAttachInFlight'),
      'globalThis.parseClock = parseClock;',
      'globalThis.readRangeInputs = readRangeInputs;',
      'globalThis.ytFitsWhole = ytFitsWhole;',
      'globalThis.isOversizedFailure = isOversizedFailure;',
      'globalThis.ytSizeAdvice = ytSizeAdvice;',
      'globalThis.YT_WHOLE_VIDEO_CHARS = YT_WHOLE_VIDEO_CHARS;'
    ].join('\n'),
    context
  );
  return context;
}

const { parseClock, ytFitsWhole, isOversizedFailure, ytSizeAdvice, YT_WHOLE_VIDEO_CHARS } = load();

console.log('\nPanel controls survive the composer-toolbox hide rule');

/* The YouTube panel is mounted INSIDE #aic-composer-toolbox, which hides
   .aic-image-prompt, .aic-media-prompt and .aic-send outright — for a
   prompt-driven tool the composer's own textarea is the prompt and its Send
   button submits, so the in-panel duplicates are redundant. This panel instead
   configures an attachment, so its URL field and Attach button are neither. The
   first cut reused those exact classes and both controls vanished, leaving no
   way to attach a video at all: the panel rendered with only the optional
   Section inputs visible. */
const hiddenInToolbox = (() => {
  const rule = source
    .split('\n')
    .find((line) => line.includes('.aic-composer-toolbox .aic-image-prompt'));
  assert.ok(rule, 'could not find the composer-toolbox hide rule');
  assert.match(rule, /display:\s*none/, 'the rule is expected to hide these');
  return [...rule.matchAll(/\.aic-composer-toolbox\s+\.([\w-]+)/g)].map((m) => m[1]);
})();

const youtubeBoxMarkup = (() => {
  const line = source.split('\n').find((l) => l.includes('id="aic-youtube-box"'));
  assert.ok(line, 'could not find the YouTube panel markup');
  return line;
})();

test('the hide rule is understood to cover the classes it always has', () => {
  for (const cls of ['aic-image-prompt', 'aic-media-prompt', 'aic-send']) {
    assert.ok(hiddenInToolbox.includes(cls), `expected the rule to hide .${cls}`);
  }
});

test('no control in the YouTube panel wears a class the toolbox hides', () => {
  const classAttrs = [...youtubeBoxMarkup.matchAll(/class="([^"]*)"/g)]
    .flatMap((m) => m[1].split(/\s+/))
    .filter(Boolean);
  const collisions = classAttrs.filter((c) => hiddenInToolbox.includes(c));
  assert.deepEqual(
    collisions, [],
    `these classes are hidden inside the composer toolbox: ${collisions.join(', ')}`
  );
});

test('the URL field and Attach button are actually present in the panel', () => {
  assert.match(youtubeBoxMarkup, /id="aic-yt-url-input"/, 'URL field missing');
  assert.match(youtubeBoxMarkup, /aicAttachYoutubeFromInput\(\)/, 'Attach action missing');
  assert.match(youtubeBoxMarkup, /class="aic-yt-url"/, 'URL field should use its own class');
  assert.match(youtubeBoxMarkup, /class="aic-yt-attach"/, 'Attach should use its own class');
});

test('both replacement classes are actually styled, not just renamed', () => {
  // Renaming away from a hidden class fixes nothing if the new class has no rule:
  // the field would render unstyled and the button would lose its affordance.
  assert.match(source, /\.aic-yt-url\{[^}]*padding/, '.aic-yt-url needs styling');
  assert.match(source, /\.aic-yt-attach\{[^}]*background/, '.aic-yt-attach needs styling');
});

test('the language picker is gone, so one cached transcript is shared per video', () => {
  // The cache is keyed by video AND language while every other consumer asks for
  // "auto", so offering a language guaranteed a miss and a duplicate B2 object.
  assert.doesNotMatch(source, /aic-yt-lang-select/,
    'the language picker should be removed entirely');
  assert.match(source, /var YT_LANG = 'auto'/, 'attachments should pin auto');
});

console.log('\nQuick actions must reach chat, not a media generator');

/* The reported "clicking Send does nothing". isVideoIntent is anchored at ^ and
   fires on a generation verb followed by "video" within 100 characters, which
   "Make structured revision notes from this video" satisfies exactly — so Notes
   and Quiz were routed to AI video GENERATION. requestVideo's first line
   Promise.reject()s when no video model is configured, and aicSend called it with
   .finally() but no .catch(), so the rejection vanished: composer cleared, button
   reset, nothing shown anywhere. Two layers are asserted here — the prompts no
   longer trip the heuristic, AND aicSend suppresses it when a video is attached,
   which is what protects whatever the student types themselves. */
const intents = (() => {
  const ctx = { };
  vm.createContext(ctx);
  vm.runInContext(
    [
      // isImageIntent delegates to isImageEditIntent, so the real one is loaded
      // rather than stubbed — a stub would change what counts as image intent and
      // the checks below would prove nothing about the shipped behaviour.
      section('function isImageIntent(text) {', 'function removePendingImageMessages'),
      section('function isSearchIntent(text) {', 'function isSpeechIntent'),
      section('function isSpeechIntent(text) {', 'function isVideoIntent'),
      section('function isVideoIntent(text) {', 'function latestAssistantText'),
      'globalThis.isImageIntent = isImageIntent;',
      'globalThis.isSearchIntent = isSearchIntent;',
      'globalThis.isSpeechIntent = isSpeechIntent;',
      'globalThis.isVideoIntent = isVideoIntent;'
    ].join('\n'),
    ctx
  );
  return ctx;
})();

const quickPrompts = [...section('var YT_ACTIONS = [', '];')
  .matchAll(/prompt:\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'"));

test('all seven quick-action prompts were found', () => {
  assert.equal(quickPrompts.length, 7, `found ${quickPrompts.length}`);
});

test('no quick action is mistaken for a VIDEO generation request', () => {
  const broken = quickPrompts.filter((p) => intents.isVideoIntent(p));
  assert.deepEqual(broken, [], `these would generate a video: ${broken.join(' | ')}`);
});

test('no quick action is mistaken for an IMAGE generation request', () => {
  const broken = quickPrompts.filter((p) => intents.isImageIntent(p));
  assert.deepEqual(broken, [], `these would generate an image: ${broken.join(' | ')}`);
});

test('no quick action is mistaken for a web SEARCH or SPEECH request', () => {
  const broken = quickPrompts.filter((p) => intents.isSearchIntent(p) || intents.isSpeechIntent(p));
  assert.deepEqual(broken, [], `these would be misrouted: ${broken.join(' | ')}`);
});

test('the exact prompt from the bug report no longer routes to video', () => {
  assert.equal(
    intents.isVideoIntent(
      'Make structured revision notes from this video. Use headings and bullet '
      + 'points, keep every formula and definition, and cite the [m:ss] timestamp '
      + 'for each section.'
    ),
    true,
    'the heuristic itself still matches this wording — which is why the guard exists'
  );
  assert.equal(intents.isVideoIntent(quickPrompts[0]), false,
    'but the shipped Notes prompt must not match');
});

test('aicSend suppresses the video heuristic when a lecture is attached', () => {
  // The guard, not the wording, is what protects a student typing "make a
  // summary of this video" by hand.
  assert.match(source, /var ytAttached = !!ytAttachment\(t\)/,
    'aicSend should compute whether a video is attached');
  assert.match(source, /if \(!ytAttached && isVideoIntent\(q\)\)/,
    'the video heuristic must be skipped when a video is attached');
});

test('a genuine video request still works when nothing is attached', () => {
  assert.equal(intents.isVideoIntent('make a video of a spinning cube'), true);
  assert.equal(intents.isVideoIntent('generate a short animation'), true);
});

console.log('\nFailed media requests are never silent');

test('every media call surfaces its rejection instead of swallowing it', () => {
  // requestVideo/requestSpeech/requestWebSearch all Promise.reject() immediately
  // when no model is configured. A .finally() without a .catch() resets the Send
  // button and shows nothing at all, which reads as a dead button.
  const orphans = [...source.matchAll(
    /request(?:WebSearch|Speech|Video)\([^)]*\)\s*\.finally/g
  )].map((m) => m[0]);
  assert.deepEqual(orphans, [],
    `these reject silently, with no .catch(): ${orphans.join(' | ')}`);
});

test('the failure helper records an error and offers a plain-chat retry', () => {
  const helper = section('function mediaFailed(threadId, kind, q, err) {', '\n  function requestVideo');
  assert.match(helper, /role: 'error'/, 'should push a visible error message');
  assert.match(helper, /retry: \{ kind: 'text'/,
    "retry should be 'text' so a misrouted prompt can be resent as chat");
  assert.match(helper, /toast\(/, 'should also toast');
});

console.log('\nSection time parsing');

test('a blank field means "no bound", not zero', () => {
  assert.equal(parseClock(''), null);
  assert.equal(parseClock('   '), null);
  assert.equal(parseClock(null), null);
  assert.equal(parseClock(undefined), null);
});

test('a bare number is read as MINUTES, which is how a lecture is described', () => {
  assert.equal(parseClock('90'), 5400);
  assert.equal(parseClock('0'), 0);
  assert.equal(parseClock('45'), 2700);
});

test('m:ss is read as minutes and seconds', () => {
  assert.equal(parseClock('45:00'), 2700);
  assert.equal(parseClock('1:30'), 90);
  assert.equal(parseClock('0:05'), 5);
});

test('h:mm:ss is read as hours, minutes and seconds', () => {
  assert.equal(parseClock('1:30:00'), 5400);
  assert.equal(parseClock('5:40:23'), 20423);
  assert.equal(parseClock('0:00:30'), 30);
});

test('whitespace around a valid time is tolerated', () => {
  assert.equal(parseClock('  1:30:00  '), 5400);
});

test('junk is rejected as NaN, never coerced to a window', () => {
  for (const bad of ['abc', '1:2:3:4', '-5', '1.5', '1:', ':30', '9,0', '1:2a']) {
    assert.ok(Number.isNaN(parseClock(bad)), `${bad} should be NaN, got ${parseClock(bad)}`);
  }
});

test('an out-of-range seconds/minutes field is rejected', () => {
  assert.ok(Number.isNaN(parseClock('1:60')), '1:60 has no 60th minute');
  assert.ok(Number.isNaN(parseClock('1:00:99')), '99 seconds is not a time');
});

console.log('\nSection range validation');

/* Compared field by field rather than with deepEqual: these objects are built
   inside the vm realm, so their prototype is not the host's Object and a strict
   deep comparison fails on identity even when every value matches. */
function assertRange(actual, expected) {
  assert.equal(actual.error, undefined, `unexpected error: ${actual.error}`);
  assert.equal(actual.startS, expected.startS, 'startS');
  assert.equal(actual.endS, expected.endS, 'endS');
}

test('two blank fields mean the whole video', () => {
  const { readRangeInputs } = load();
  assertRange(readRangeInputs(), { startS: null, endS: null });
});

test('a start alone runs to the end of the video', () => {
  const { readRangeInputs } = load({ from: '1:30:00' });
  assertRange(readRangeInputs(), { startS: 5400, endS: null });
});

test('an end alone runs from the beginning', () => {
  const { readRangeInputs } = load({ to: '45' });
  assertRange(readRangeInputs(), { startS: null, endS: 2700 });
});

test('a normal range is accepted', () => {
  const { readRangeInputs } = load({ from: '0:00', to: '45:00' });
  assertRange(readRangeInputs(), { startS: 0, endS: 2700 });
});

test('an inverted range is refused with a readable reason', () => {
  const { readRangeInputs } = load({ from: '45', to: '10' });
  const out = readRangeInputs();
  assert.ok(out.error, 'expected an error');
  assert.match(out.error, /end must be after its start/i);
});

test('a zero-length range is refused', () => {
  const { readRangeInputs } = load({ from: '10', to: '10' });
  assert.ok(readRangeInputs().error);
});

test('a malformed entry is refused, and says what a valid one looks like', () => {
  const { readRangeInputs } = load({ from: 'half way' });
  const out = readRangeInputs();
  assert.ok(out.error, 'expected an error');
  assert.match(out.error, /1:30:00|minutes/i);
});

console.log('\n"Too long to read in one request" hint');

test('a video with no known size is not warned about', () => {
  assert.equal(ytFitsWhole(null), true);
  assert.equal(ytFitsWhole({}), true);
  assert.equal(ytFitsWhole({ charCount: 0 }), true);
});

test('a normal lecture fits and is NOT warned about', () => {
  // ~40 minutes of English captions.
  assert.equal(ytFitsWhole({ charCount: 35000 }), true);
});

test('a transcript at the backstop still fits', () => {
  assert.equal(ytFitsWhole({ charCount: YT_WHOLE_VIDEO_CHARS }), true);
});

test('an implausibly huge transcript is flagged even with no route info', () => {
  assert.equal(ytFitsWhole({ charCount: YT_WHOLE_VIDEO_CHARS + 1 }), false);
});

/* The route's real window decides, not a fixed number. Verified against a live
   OmniRoute /v1/models response: 5509 routes, windows from 8k to 2M, and the same
   model name differing by route (mistral-large is 128000 on one, 262144 on
   another). A 5:40:23 Hindi lecture is ~245k characters, which does NOT fit a
   128k-token route but fits a 1M one with room to spare — so a single hardcoded
   threshold would have to be wrong in one direction or the other. */
function loadWithRoute({ contextTokens, selectedKey = 'omniroute::r' } = {}) {
  const elements = {
    'aic-yt-from-input': { value: '' },
    'aic-yt-to-input': { value: '' },
    'aic-model-select': { value: selectedKey }
  };
  const context = {
    document: { getElementById: (id) => elements[id] || null },
    _statusCache: {
      models: [{ key: 'omniroute::r', model: 'r', provider: 'omniroute', contextTokens }]
    },
    getThread: () => ({ model: selectedKey }),
    currentThreadId: () => 't1'
  };
  vm.createContext(context);
  vm.runInContext(
    [
      section('function parseClock(raw) {', 'function readRangeInputs()'),
      section('function readRangeInputs() {', '/* Backstop matching the'),
      section('var YT_WHOLE_VIDEO_CHARS =', '  var _ytAttachInFlight'),
      'globalThis.ytFitsWhole = ytFitsWhole;',
      'globalThis.selectedModelContextTokens = selectedModelContextTokens;'
    ].join('\n'),
    context
  );
  return context;
}

const HINDI_5H40 = { charCount: 245000, lang: 'hi', title: '2D MENSURATION ONE SHOT' };

test('the selected route\'s window is read from the status payload', () => {
  const { selectedModelContextTokens } = loadWithRoute({ contextTokens: 1000000 });
  assert.equal(selectedModelContextTokens(), 1000000);
});

test('a 5:40:23 Hindi lecture does NOT fit a 128k route', () => {
  const { ytFitsWhole: fits } = loadWithRoute({ contextTokens: 128000 });
  assert.equal(fits(HINDI_5H40), false);
});

test('the same lecture DOES fit a 1M route, so no warning is shown', () => {
  const { ytFitsWhole: fits } = loadWithRoute({ contextTokens: 1000000 });
  assert.equal(fits(HINDI_5H40), true);
});

test('an 8k route rejects even a short video', () => {
  const { ytFitsWhole: fits } = loadWithRoute({ contextTokens: 8192 });
  assert.equal(fits({ charCount: 35000 }), false);
});

test('Devanagari is charged more context than Latin of the same length', () => {
  const { ytFitsWhole: fits } = loadWithRoute({ contextTokens: 128000 });
  const chars = 300000;
  assert.equal(fits({ charCount: chars, lang: 'en' }), true, 'Latin should fit');
  assert.equal(fits({ charCount: chars, lang: 'hi' }), false, 'Devanagari should not');
});

test('an undescribed route falls back to the backstop rather than warning always', () => {
  const { ytFitsWhole: fits } = loadWithRoute({ contextTokens: 0 });
  assert.equal(fits({ charCount: 35000 }), true);
  assert.equal(fits({ charCount: 500000 }), false);
});

console.log('\nOversized-prompt detection');

test('the wordings providers actually return are recognised', () => {
  for (const msg of [
    'context_length_exceeded',
    'This model has a maximum context length of 8192 tokens',
    'Please reduce the length of the messages',
    'too many tokens in the request',
    'prompt is too long',
    'Request too large for this model',
    'HTTP 413 Payload Too Large',
    'input too long'
  ]) {
    assert.equal(isOversizedFailure(msg), true, `should match: ${msg}`);
  }
});

test('unrelated failures are NOT mistaken for a size problem', () => {
  for (const msg of [
    'Network error from Render',
    'HTTP 401 unauthorized',
    'rate limit exceeded',
    'The request timed out',
    'ai_failed: empty response',
    '',
    null
  ]) {
    assert.equal(isOversizedFailure(msg), false, `should not match: ${msg}`);
  }
});

test('advice is only offered when a video is actually attached', () => {
  assert.equal(ytSizeAdvice(null), '');
  assert.equal(ytSizeAdvice({}), '');
  assert.equal(ytSizeAdvice({ youtube: null }), '');
});

test('a whole-video attachment is told to set a Section', () => {
  const advice = ytSizeAdvice({ youtube: { id: 'x', startS: null, endS: null } });
  assert.match(advice, /Section/);
});

test('an already-sectioned attachment is told to shorten it, not to set one', () => {
  const advice = ytSizeAdvice({ youtube: { id: 'x', startS: 0, endS: 2700 } });
  assert.match(advice, /shorter section|bigger context/i);
  assert.doesNotMatch(advice, /set a Section/);
});

console.log('\nTranscript attachment is a visible, downloadable server file');

function loadTranscriptFile(att) {
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    [
      section('function transcriptFileInfo(att) {', 'function renderYoutubeBar()'),
      'globalThis.transcriptFileInfo = transcriptFileInfo;',
      'globalThis.transcriptStoreLabel = transcriptStoreLabel;',
      'globalThis.transcriptDownloadPayload = transcriptDownloadPayload;'
    ].join('\n'),
    context
  );
  return {
    file: context.transcriptFileInfo(att),
    label: (file) => context.transcriptStoreLabel(file),
    downloadPayload: (data) => context.transcriptDownloadPayload(data)
  };
}

test('an old backend response never fabricates a durable B2 object', () => {
  const { file, label } = loadTranscriptFile({ id: 'dQw4w9WgXcQ', requestedLang: 'auto' });
  assert.equal(file.name, 'dQw4w9WgXcQ__auto.json');
  assert.equal(file.documentId, 'dQw4w9WgXcQ__auto');
  assert.equal(file.objectKey, null);
  assert.equal(file.ready, false);
  assert.equal(label(file), 'storage not confirmed');
});

test('confirmed backend storage metadata wins over the rollout fallback', () => {
  const server = {
    name: 'custom.json', document_id: 'custom',
    object_key: 'transcripts/custom.json', store: 'backblaze_b2', ready: true
  };
  const { file, label } = loadTranscriptFile({ id: 'dQw4w9WgXcQ', transcriptFile: server });
  assert.equal(file.name, server.name);
  assert.equal(file.objectKey, server.object_key);
  assert.equal(file.store, 'backblaze_b2');
  assert.equal(label(file), 'Backblaze B2');
});

test('download exports the persisted transcript body, not response metadata', () => {
  const { downloadPayload } = loadTranscriptFile({ id: 'dQw4w9WgXcQ' });
  const payload = downloadPayload({
    id: 'dQw4w9WgXcQ', segment_count: 1,
    segments: [{ start: 0, text: 'hello' }], text: 'hello',
    transcript_file: { document_id: 'dQw4w9WgXcQ__auto' }
  });
  assert.equal(payload.text, 'hello');
  assert.equal(payload.transcript_file, undefined);
});

test('download refuses a 200 no-captions response instead of saving an empty file', () => {
  const { downloadPayload } = loadTranscriptFile({ id: 'dQw4w9WgXcQ' });
  assert.throws(() => downloadPayload({ warning: 'no_captions', segment_count: 0, segments: [] }),
    /no longer has a transcript/i);
});

test('the attachment renderer outputs the confirmed Backblaze file card', () => {
  const bar = { style: {}, innerHTML: '' };
  const att = {
    id: 'dQw4w9WgXcQ', title: 'Thermodynamics Lecture', requestedLang: 'auto',
    lang: 'en', duration: 3600,
    transcriptFile: {
      name: 'dQw4w9WgXcQ__auto.json', document_id: 'dQw4w9WgXcQ__auto',
      object_key: 'transcripts/dQw4w9WgXcQ__auto.json', store: 'backblaze_b2', ready: true
    }
  };
  const context = {
    document: { getElementById: (id) => id === 'aic-yt-bar' ? bar : null },
    getThread: () => ({ youtube: att }), currentThreadId: () => 't1',
    fmtClock: () => '1:00:00', ytFitsWhole: () => true,
    esc: (value) => String(value), escAttr: (value) => String(value), YT_ACTIONS: []
  };
  vm.createContext(context);
  vm.runInContext(
    [
      'function ytAttachment(thread) { return thread && thread.youtube && thread.youtube.id ? thread.youtube : null; }',
      section('function transcriptFileInfo(att) {', 'function renderYoutubeBar()'),
      section('function renderYoutubeBar() {', 'function renderYoutubeCurrent()'),
      'renderYoutubeBar();'
    ].join('\n'),
    context
  );
  assert.equal(bar.style.display, 'flex');
  assert.match(bar.innerHTML, /dQw4w9WgXcQ__auto\.json/);
  assert.match(bar.innerHTML, /Backblaze object/);
  assert.match(bar.innerHTML, /transcripts\/dQw4w9WgXcQ__auto\.json/);
  assert.match(bar.innerHTML, /YouTube source: Thermodynamics Lecture/);
  assert.match(bar.innerHTML, /aicDownloadYoutubeTranscript\(\)/);
});

test('the attachment renderer shows a filename, exact object key, and download action', () => {
  const renderer = section('function renderYoutubeBar() {', 'function renderYoutubeCurrent()');
  assert.match(renderer, /file\.name/, 'visible filename missing');
  assert.match(renderer, /file\.objectKey/, 'visible storage location missing');
  assert.match(renderer, /aicDownloadYoutubeTranscript\(\)/, 'download action missing');
  assert.match(source, /window\.aicDownloadYoutubeTranscript = function/, 'download handler missing');
});

test('attaching stores the transcript_file metadata returned by the backend', () => {
  const attach = section('function attachYoutube(videoId, fallbackTitle) {', '/* ── file upload / RAG');
  assert.match(attach, /transcriptFile:\s*d\.transcript_file/);
  assert.match(attach, /object_key:\s*null[\s\S]*store:\s*'unknown'[\s\S]*ready:\s*false/,
    'an old backend response must remain explicitly unverified');
});

test('Download and Send carry the same server-issued transcript document ID', () => {
  const download = section('window.aicDownloadYoutubeTranscript = function () {', 'window.aicYoutubeAction');
  const send = section('window.aicSend = function (ev) {', '/* auto-grow the textarea');
  assert.match(download, /documentId=' \+ encodeURIComponent\(file\.documentId\)/);
  assert.match(send, /documentId:\s*transcriptFileInfo\(t\.youtube\)\.documentId/);
});

console.log('\nSmall study artifacts complete in one response');

function loadProjectClassifiers() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    [
      section('function isLargeProjectRequest(prompt) {', 'function projectTitleFromPrompt(prompt) {'),
      section('function isCreationRequest(prompt) {', 'function artifactExtension(language) {'),
      'globalThis.isCreationRequest = isCreationRequest;',
      'globalThis.isLargeProjectRequest = isLargeProjectRequest;',
      'globalThis.isSingleFileStudyArtifactRequest = isSingleFileStudyArtifactRequest;',
      'globalThis.shouldUseProjectWorkflow = shouldUseProjectWorkflow;'
    ].join('\n'),
    context
  );
  return context;
}

const projectClassifiers = loadProjectClassifiers();
const exactFormulaSheetPrompt = 'Make a structured formula sheet using figures and use html css and js';

test('the reported formula-sheet prompt is a small one-shot creation', () => {
  assert.equal(projectClassifiers.isCreationRequest(exactFormulaSheetPrompt), true);
  assert.equal(projectClassifiers.isLargeProjectRequest(exactFormulaSheetPrompt), false);
  assert.equal(projectClassifiers.isSingleFileStudyArtifactRequest(exactFormulaSheetPrompt), true);
  assert.equal(projectClassifiers.shouldUseProjectWorkflow(
    exactFormulaSheetPrompt, true, false, false, { active: true }
  ), false, 'a stale active plan must not force a scaffold milestone');
});

test('explicit separate-file requests are not forced into one HTML file', () => {
  assert.equal(projectClassifiers.isSingleFileStudyArtifactRequest(
    'Make a formula sheet using HTML CSS and JS in three separate files'
  ), false);
});

test('non-formula study pages are not forced through geometry validation', () => {
  assert.equal(projectClassifiers.isSingleFileStudyArtifactRequest(
    'Make revision notes for Indian history using HTML CSS and JavaScript'
  ), false);
});

test('a detailed formula-sheet prompt keeps one-file precedence over length heuristics', () => {
  const detailed = `${exactFormulaSheetPrompt}. Include every transcript timestamp, labelled diagrams, searchable cards, mobile layout, print styles, definitions, derivations, examples, accessibility labels, navigation, and a compact revision mode for students preparing for examinations.`;
  assert.equal(projectClassifiers.isSingleFileStudyArtifactRequest(detailed), true);
  assert.equal(projectClassifiers.isLargeProjectRequest(detailed), true,
    'the generic heuristic is intentionally broad');
  const send = section('window.aicSend = function (ev) {', '/* auto-grow the textarea');
  assert.match(send, /var largeProject = !singleFileStudyArtifact && isLargeProjectRequest\(q\)/,
    'explicit formula-sheet intent must override generic prompt length');
});

test('genuinely large apps and explicit continuation retain project milestones', () => {
  const large = 'Build a complete responsive HTML dashboard project with login, database, backend API, admin screens, deployment, and multiple pages';
  assert.equal(projectClassifiers.isLargeProjectRequest(large), true);
  assert.equal(projectClassifiers.shouldUseProjectWorkflow(large, true, true, false, null), true);
  assert.equal(projectClassifiers.shouldUseProjectWorkflow(
    'Continue the next milestone', false, false, false, { active: true }
  ), true);
});

test('Send omits project state and requests one HTML artifact for the exact prompt', () => {
  const send = section('window.aicSend = function (ev) {', '/* auto-grow the textarea');
  assert.match(send, /project:\s*projectWorkflow \? projectPayload\(t\) : null/);
  assert.match(send, /artifactMode:\s*singleFileStudyArtifact \? 'single-html-study' : ''/);
  assert.match(send, /timeoutMs:\s*singleFileStudyArtifact \? 240000/,
    'an automatic repair attempt needs enough time to finish');
  assert.match(send, /if \(creatingProject && !projectWorkflow/,
    'small creation should retire a stale milestone plan');
});

test('single-file study tools keep inline JavaScript in the sandboxed preview', () => {
  const preview = section('function previewHtml(t) {', 'function refreshWorkspacePreview(t) {');
  assert.match(preview, /var inlineScripts = \[\]/);
  assert.match(preview, /inlineScripts\.push\(String\(code\)\)/);
  assert.match(preview, /var scripts = inlineScripts\.concat/);
  assert.match(preview, /if \(!\/\\bsrc\\s\*=\/i\.test/,
    'external script sources must remain blocked');
});

function loadStudyArtifactValidator() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    [
      section('function isCreationRequest(prompt) {', 'function materializeCreationArtifacts'),
      'globalThis.singleHtmlStudyArtifactIssue = singleHtmlStudyArtifactIssue;'
    ].join('\n'),
    context
  );
  return context.singleHtmlStudyArtifactIssue;
}

const studyArtifactIssue = loadStudyArtifactValidator();
const substantiveStudyText = Array.from({ length: 40 }, (_, index) =>
  `<p>Triangle area and perimeter revision explanation ${index + 1}: choose the correct base, height, radius, diagonal, sector, arc, rectangle, square, rhombus, trapezium, circle, Heron semiperimeter and circumference rule.</p>`
).join('\n');
const completeStudyHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Mensuration Formula Sheet</title>
<style>body{font-family:sans-serif}.card{padding:1rem}.hidden{display:none}svg{border:1px solid}</style></head>
<body><input id="search" aria-label="Search formulas">
<nav><button data-topic="triangle">Triangle</button></nav>
<main>${substantiveStudyText}
<section class="card">[0:15] Triangle area: A = 1/2 × b × h</section>
<section class="card">[4:20] Rectangle perimeter: P = 2(l + w)</section>
<section class="card">[9:05] Circle area: A = πr²</section>
<section class="card">[12:40] Circumference: C = 2πr</section>
<section>Heron: Area = √(s(s-a)(s-b)(s-c)); diagonal and sector formulas are searchable.</section>
<svg viewBox="0 0 200 120" aria-label="Labelled triangle"><title>Triangle with base and height</title><path d="M20 100L100 20L180 100Z"/><text x="92" y="115">base b</text><text x="105" y="65">height h</text></svg>
<svg viewBox="0 0 200 120" aria-label="Labelled circle"><title>Circle with radius</title><circle cx="100" cy="60" r="45"/><text x="105" y="55">radius r</text></svg>
</main><script>document.querySelector('#search').addEventListener('input', function (event) { document.querySelectorAll('.card').forEach(function (card) { card.classList.toggle('hidden', !card.textContent.toLowerCase().includes(event.target.value.toLowerCase())); }); });</script>
</body></html>`;
function namedHtmlArtifact(html) { return `FILE: index.html\n\n\`\`\`html\n${html}\n\`\`\``; }

test('the artifact validator accepts a complete interactive one-file formula sheet', () => {
  assert.equal(studyArtifactIssue(namedHtmlArtifact(completeStudyHtml), true), '');
});

test('an unnamed HTML fence cannot bypass the exact FILE: index.html contract', () => {
  assert.match(studyArtifactIssue(`\`\`\`html\n${completeStudyHtml}\n\`\`\``, true),
    /exactly one FILE: index\.html/i);
});

test('the headings-only scaffold from the bug report is rejected, not saved', () => {
  const scaffold = `<!doctype html><html><head><style>body{font-family:sans-serif}</style></head><body>
    <h2>Triangle</h2><section></section><h2>Quadrilateral</h2><section></section>
    <h2>Circle</h2><section></section><script>document.querySelector('body');</script></body></html>`;
  assert.match(studyArtifactIssue(namedHtmlArtifact(scaffold), true), /too short|formulas/i);
});

test('JavaScript assignments cannot masquerade as displayed equations', () => {
  const noDisplayedEquations = completeStudyHtml
    .replace(/<section class="card">[\s\S]*?<\/section>\n<section class="card">[\s\S]*?<\/section>\n<section class="card">[\s\S]*?<\/section>\n<section class="card">[\s\S]*?<\/section>/,
      '<section>[0:15] [4:20] [9:05] Formula explanations without symbolic equations.</section>')
    .replace(/<section>Heron:[\s\S]*?<\/section>/, '<section>Heron area and sector formula explanation.</section>');
  assert.match(studyArtifactIssue(namedHtmlArtifact(noDisplayedEquations), true), /formulas and equations/i);
});

test('two empty or unlabelled SVG boxes do not satisfy the figure requirement', () => {
  const unlabelled = completeStudyHtml.replace(/<svg[\s\S]*?<\/svg>/g, '<svg viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg>');
  assert.match(studyArtifactIssue(namedHtmlArtifact(unlabelled), true), /need visible or accessible labels/i);
});

test('all generation completion paths pass the artifact mode into validation', () => {
  const send = section('window.aicSend = function (ev) {', '/* auto-grow the textarea');
  const wired = send.match(/materializeCreationArtifacts\(cur,\s*last,\s*q,\s*body\.artifactMode\)/g) || [];
  assert.equal(wired.length, 2, 'both streaming and blocking completion paths must validate');
});

console.log('\nComposer submission uses programmatic DOM listeners');

function composerMarkup() {
  const marker = 'var MARKUP = `';
  const start = source.indexOf(marker);
  const end = source.indexOf('`;\n\n  function dispatchComposerSend', start + marker.length);
  assert.ok(start !== -1 && end > start, 'could not locate AI Chat markup');
  return source.slice(start + marker.length, end);
}

function loadComposerBinding(sendHandler = () => {}) {
  const dom = new JSDOM(`<!doctype html><body>${composerMarkup()}</body>`);
  const notifications = [];
  const errors = [];
  const context = {
    window: dom.window,
    document: dom.window.document,
    toast: (message, kind) => notifications.push({ message, kind }),
    console: { error: (message) => errors.push(message) }
  };
  if (sendHandler) dom.window.aicSend = sendHandler;
  vm.createContext(context);
  vm.runInContext(
    [
      section('function dispatchComposerSend(ev) {', 'function injectPage() {'),
      'globalThis.bindComposerSubmission = bindComposerSubmission;'
    ].join('\n'),
    context
  );
  const page = dom.window.document;
  assert.equal(context.bindComposerSubmission(page), true, 'initial binding should succeed');
  return { context, dom, page, notifications, errors };
}

test('the critical Send controls no longer depend on inline event attributes', () => {
  const dom = new JSDOM(composerMarkup());
  const doc = dom.window.document;
  assert.equal(doc.querySelector('.aic-form').hasAttribute('onsubmit'), false);
  assert.equal(doc.querySelector('#aic-input').hasAttribute('onkeydown'), false);
  assert.equal(doc.querySelector('#aic-send-btn').type, 'button');
  dom.window.close();
});

test('one visible Send-button click dispatches exactly once', () => {
  let calls = 0;
  const fixture = loadComposerBinding(() => { calls += 1; });
  fixture.page.querySelector('#aic-send-btn').click();
  assert.equal(calls, 1);
  fixture.dom.window.close();
});

test('Enter dispatches exactly once while Shift+Enter keeps a new line', () => {
  let calls = 0;
  const fixture = loadComposerBinding(() => { calls += 1; });
  const input = fixture.page.querySelector('#aic-input');
  const enter = new fixture.dom.window.KeyboardEvent('keydown', {
    key: 'Enter', bubbles: true, cancelable: true
  });
  input.dispatchEvent(enter);
  assert.equal(calls, 1);
  assert.equal(enter.defaultPrevented, true);

  const shifted = new fixture.dom.window.KeyboardEvent('keydown', {
    key: 'Enter', shiftKey: true, bubbles: true, cancelable: true
  });
  input.dispatchEvent(shifted);
  assert.equal(calls, 1, 'Shift+Enter must not send');
  assert.equal(shifted.defaultPrevented, false);
  fixture.dom.window.close();
});

test('the visible Stop control invokes generation cancellation without sending again', () => {
  let stops = 0;
  let sends = 0;
  const fixture = loadComposerBinding(() => { sends += 1; });
  fixture.context.window.aicStopGeneration = () => { stops += 1; };
  const stop = fixture.page.querySelector('#aic-stop-btn');
  assert.equal(stop.type, 'button');
  stop.click();
  assert.equal(stops, 1);
  assert.equal(sends, 0);
  fixture.dom.window.close();
});

test('Ctrl/Cmd+K activates the advertised New chat shortcut', () => {
  const start = source.indexOf('window.aicKeydown = function (ev) {');
  const end = source.indexOf('/* ── sending: streams via SSE', start);
  assert.ok(start !== -1 && end > start, 'could not locate AI Chat keyboard handler');
  const context = { window: {}, document: {} };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  context.window.aicNewThread = () => { context.created = true; };
  context.window.aicKeydown({
    key: 'k', ctrlKey: true, metaKey: false, shiftKey: false,
    preventDefault: () => { context.prevented = true; }
  });
  assert.equal(context.created, true);
  assert.equal(context.prevented, true);
});

test('a form submit dispatches exactly once and is prevented', () => {
  let calls = 0;
  const fixture = loadComposerBinding(() => { calls += 1; });
  const submit = new fixture.dom.window.Event('submit', { bubbles: true, cancelable: true });
  const notCancelled = fixture.page.querySelector('.aic-form').dispatchEvent(submit);
  assert.equal(calls, 1);
  assert.equal(notCancelled, false);
  assert.equal(submit.defaultPrevented, true);
  fixture.dom.window.close();
});

test('binding twice does not duplicate Send dispatch', () => {
  let calls = 0;
  const fixture = loadComposerBinding(() => { calls += 1; });
  assert.equal(fixture.context.bindComposerSubmission(fixture.page), false);
  fixture.page.querySelector('#aic-send-btn').click();
  assert.equal(calls, 1);
  fixture.dom.window.close();
});

test('a missing Send handler visibly fails and still prevents form navigation', () => {
  const fixture = loadComposerBinding(null);
  const submit = new fixture.dom.window.Event('submit', { bubbles: true, cancelable: true });
  const notCancelled = fixture.page.querySelector('.aic-form').dispatchEvent(submit);
  assert.equal(notCancelled, false);
  assert.equal(submit.defaultPrevented, true);
  assert.equal(fixture.notifications.length, 1);
  assert.equal(fixture.notifications[0].kind, 'error');
  assert.match(fixture.notifications[0].message, /could not send/i);
  assert.equal(fixture.errors.length, 1);
  fixture.dom.window.close();
});

test('reparented Save and Close tool buttons never submit the composer', () => {
  let sends = 0;
  const fixture = loadComposerBinding(() => { sends += 1; });
  const toolbox = fixture.page.querySelector('#aic-composer-toolbox');
  for (const kind of ['persona', 'github', 'youtube', 'image', 'search', 'speech', 'video']) {
    toolbox.appendChild(fixture.page.querySelector(`#aic-${kind}-box`));
  }
  const controls = [...toolbox.querySelectorAll(
    'button[onclick="aicSavePersona()"], button[onclick^="aicClose"]'
  )];
  assert.equal(controls.length, 7, `expected seven Save/Close controls, found ${controls.length}`);
  for (const control of controls) {
    assert.equal(control.type, 'button', `${control.textContent.trim()} must not submit`);
    control.click();
  }
  assert.equal(sends, 0);
  fixture.dom.window.close();
});

console.log('\nEvery Send exit explains itself');

test('busy, blank, and missing-thread Send exits all notify the student', () => {
  const send = section('window.aicSend = function (ev) {', '/* auto-grow the textarea');
  assert.match(send, /if \(_sending\) \{ toast\(/, 'busy Send should notify');
  assert.match(send, /if \(!q && _activeComposerTool !== 'speech'\) \{ toast\(/,
    'blank Send should notify');
  assert.match(send, /if \(!t\) \{ toast\(/, 'missing-thread Send should notify');
});

test('media retry failures use the same visible failure helper', () => {
  const retry = section('window.aicRetryMessage = function (btn) {', '/* ── YouTube transcript attachment');
  assert.match(retry, /mediaRetry\s*\n\s*\.catch\(function \(err\) \{ mediaFailed\(/,
    'media retry rejection must be caught');
});

test('late app-shell initialization retries instead of disappearing silently', () => {
  assert.match(source, /function ensurePageInjected\(attempt\)/);
  assert.match(source, /setTimeout\(function \(\) \{ ensurePageInjected\(attempt \+ 1\); \}, 250\)/);
});

console.log(`\n${results.join('\n')}`);
console.log(`\n${results.length} checks${process.exitCode ? ' — FAILURES ABOVE' : ' passed'}`);
