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
    document: { getElementById: (id) => elements[id] || null }
  };
  vm.createContext(context);
  vm.runInContext(
    [
      section('function parseClock(raw) {', 'function readRangeInputs()'),
      section('function readRangeInputs() {', "/* Mirrors the backend's"),
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

test('a transcript at the ceiling still fits', () => {
  assert.equal(ytFitsWhole({ charCount: YT_WHOLE_VIDEO_CHARS }), true);
});

test('a multi-hour lecture is flagged as not fitting', () => {
  // The reported case: 5:40:23, which is ~180k-245k characters of captions.
  assert.equal(ytFitsWhole({ charCount: 200000 }), false);
  assert.equal(ytFitsWhole({ charCount: YT_WHOLE_VIDEO_CHARS + 1 }), false);
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

console.log(`\n${results.join('\n')}`);
console.log(`\n${results.length} checks${process.exitCode ? ' — FAILURES ABOVE' : ' passed'}`);
