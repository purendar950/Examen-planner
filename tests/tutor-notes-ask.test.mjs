/*
 * In-note AI interaction: the Explain/Verify/Example/Ask affordances on generated
 * study notes, the request they build, and the Focus Mode surfaces they use.
 *
 * The failure modes here are quiet ones, and one of them has already shipped:
 *   - the section button opened the popover and an unrelated selection handler
 *     closed it ~10ms later, visible only on desktop (see "event race" below)
 *   - a passage staged with "Ask…" silently attaching to a later, unrelated question
 *   - MCQ question cards getting no affordance at all, which is exactly where a
 *     hallucinated answer key does the most damage
 *   - the note excerpt leaking into the visible chat bubble, or the injected
 *     button leaking into the text sent to the model
 *   - a search-result title breaking out of an HTML attribute (esc() does not
 *     escape quotes, so attributes need escAttr)
 *
 * Everything is evaluated from the real js/features/ai-tutor.js, so the shipped
 * code is what is under test.
 *
 * Run with:  npm run test:tutor-notes      (also part of `npm run check`)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(rootDir, 'js/features/ai-tutor.js'), 'utf8');

function section(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + 1);
  assert.ok(start !== -1 && end > start, `could not locate section: ${from}`);
  return source.slice(start, end);
}

const results = [];
function test(name, fn) {
  try { fn(); results.push(`  ✓ ${name}`); }
  catch (error) { results.push(`  ✗ ${name}\n    ${error.message}`); process.exitCode = 1; }
}
async function testAsync(name, fn) {
  try { await fn(); results.push(`  ✓ ${name}`); }
  catch (error) { results.push(`  ✗ ${name}\n    ${error.message}`); process.exitCode = 1; }
}

/* The escapers, lifted verbatim so the tests use the same ones the app does. */
const escapers = vm.runInNewContext(
  section('  function esc(s)', '  function mdInline(s)') + ';({ esc, escAttr })', {}
);

/* ── notebook markup, mirroring what nbInner()/nbCard() emit ─────────────────
   Flat sibling divs under .ai-nb; .sec headings are flex rows carrying a .num
   counter and an .ai-ts anchor; MCQ questions are .qkeep > .q-card > .q-head with
   the explanation as a SIBLING of .qkeep, not a child. */
const NOTEBOOK = `<!doctype html><body><div id="ai-sub">
  <div class="ai-scroll nb"><div class="ai-nb">
    <div class="sec"><span class="num">1</span>Fundamental Rights <a class="ai-ts" data-s="0">\u23e9 0:00</a></div>
    <p id="p1">Article <span class="fig">21</span> protects life and personal liberty.</p>
    <ul><li>Article 21A covers education</li></ul>
    <div class="factbox"><span class="badge key">KEY</span>Added by the 86th Amendment</div>
    <div class="sec"><span class="num">2</span>Directive Principles <a class="ai-ts" data-s="754">\u23e9 12:34</a></div>
    <p id="p2">Part IV, not enforceable by courts.</p>
    <div class="qkeep"><div class="q-card"><div class="q-head"><span class="qtag">Q1</span><span class="q-text">Which article covers education?</span></div>
      <div class="q-body"><div class="opt right"><span class="lbl">A</span> 21A</div><div class="opt wrong"><span class="lbl">B</span> 19</div></div></div>
      <div class="answer"><span class="ok">Answer: <mark class="ans">A</mark></span></div></div>
    <div class="explain"><div class="xh">Explanation</div><p>Inserted by the 86th Amendment.</p></div>
    <div class="qkeep"><div class="q-card"><div class="q-head"><span class="qtag">Q2</span><span class="q-text">Part IV is enforceable?</span></div></div></div>
  </div></div>
  <div class="ai-note-pop" id="ai-note-pop" hidden></div>
</div></body>`;

function buildNotes() {
  const dom = new JSDOM(NOTEBOOK);
  const { window } = dom;
  // jsdom reports an all-zero rect, which readNoteSelection() correctly rejects as
  // "no visible selection"; give ranges and elements real ones.
  window.Range.prototype.getBoundingClientRect =
    () => ({ left: 10, top: 40, width: 120, height: 18, bottom: 58, right: 130 });
  window.Element.prototype.getBoundingClientRect =
    () => ({ left: 200, top: 80, width: 27, height: 22, bottom: 102, right: 227 });

  const state = { markTool: 'move', asked: [], focus: null };
  const sandbox = {
    window,
    document: window.document,
    // The selection handler defers settle() by 10ms; a bare vm context has no
    // timers, so without these it would silently never run and the event-race
    // test below would pass for the wrong reason.
    setTimeout,
    clearTimeout,
    _lecBlocks: [],
    get _notesFocus() { return state.focus; },
    esc: escapers.esc,
    escAttr: escapers.escAttr,
    paintFocusAskQuote: () => {},
    notesFocusMarkState: () => ({ tool: state.markTool }),
    askAboutNote: (q, passage, ts, opts) => { state.asked.push({ q, passage, ts, opts }); return true; },
    openTutorInFocus: () => true,
    showTutorTab: () => true
  };
  const api = vm.runInNewContext(
    section('  var NOTE_EXCERPT_MAX = 12000;', '  /* ── Whole-note check') +
    ';({ noteSnippet, noteBlockText, noteFullText, noteBlockOf, noteBlockTs, noteSectionText,' +
    ' noteAskBtnHtml, setupNoteAsk, runNoteAction, hideNotePop, notePopVisible, fromNoteAffordance,' +
    ' setPendingNoteContext, takePendingNoteContext, NOTE_ACTIONS, NOTE_EXCERPT_MAX,' +
    ' NOTE_SNIPPET_MAX, NOTE_CONTEXT_TTL_MS,' +
    ' _peekPending: () => _pendingNoteContext, _popCtx: () => _notePopCtx })',
    sandbox
  );
  return { window, api, state, box: window.document.getElementById('ai-sub') };
}

/* ── note text extraction ──────────────────────────────────────────────────── */
{
  const { api, box } = buildNotes();
  const nb = box.querySelector('.ai-nb');
  const blocks = [...nb.children];

  test('a heading passage drops the decorative counter and the seek glyph', () => {
    /* Without this the model (and the chat bubble) saw "1Fundamental Rights ⏩". */
    assert.equal(api.noteBlockText(blocks[0]), 'Fundamental Rights 0:00');
  });

  test('inline spans survive, whitespace collapses', () => {
    assert.equal(api.noteBlockText(blocks[1]), 'Article 21 protects life and personal liberty.');
  });

  test('the injected ask button never reaches the model', () => {
    blocks[0].insertAdjacentHTML('beforeend', api.noteAskBtnHtml(0));
    assert.ok(blocks[0].querySelector('.ai-nb-ask'), 'button should be rendered');
    assert.ok(!api.noteBlockText(blocks[0]).includes('💬'));
    assert.ok(!api.noteFullText(nb).includes('💬'));
  });

  test('a snippet is collapsed and bounded, and never throws on empty input', () => {
    assert.equal(api.noteSnippet('a\n\n b\tc '), 'a b c');
    assert.equal(api.noteSnippet(null), '');
    const long = api.noteSnippet('x'.repeat(400));
    assert.equal(long.length, api.NOTE_SNIPPET_MAX);
    assert.ok(long.endsWith('…'));
  });
}

/* ── resolving a click or selection to a notebook block ─────────────────────── */
{
  const { window, api, box } = buildNotes();
  const nb = box.querySelector('.ai-nb');
  const blocks = [...nb.children];

  test('a nested element and a text node both resolve to their top-level block', () => {
    const fig = blocks[1].querySelector('.fig');
    assert.equal(api.noteBlockOf(fig), blocks[1]);
    assert.equal(api.noteBlockOf(fig.firstChild), blocks[1]);
  });

  test('a click outside the notebook resolves to nothing', () => {
    assert.equal(api.noteBlockOf(window.document.body), null);
    assert.equal(api.noteBlockOf(null), null);
  });

  test('deep MCQ nodes resolve to .qkeep, the unit the notebook lays out', () => {
    const qText = nb.querySelector('.q-text');
    assert.ok(api.noteBlockOf(qText).classList.contains('qkeep'));
  });
}

/* ── transcript grounding ───────────────────────────────────────────────────── */
{
  const { api, box } = buildNotes();
  const blocks = [...box.querySelector('.ai-nb').children];

  test('a block carrying its own timestamp uses it', () => {
    assert.equal(api.noteBlockTs(blocks[0]), 0);
    assert.equal(api.noteBlockTs(blocks[4]), 754);
  });

  test('blocks with no cue inherit the nearest PRECEDING one', () => {
    /* Same "a cue owns everything until the next cue" model lecIndex() uses, so a
       paragraph is attributed to the heading above it and not to the next one. */
    assert.equal(api.noteBlockTs(blocks[1]), 0);
    assert.equal(api.noteBlockTs(blocks[3]), 0);
    assert.equal(api.noteBlockTs(blocks[5]), 754);
    assert.equal(api.noteBlockTs(blocks[7]), 754);
  });

  test('notes with no timestamps at all do not get an invented one', () => {
    const bare = new JSDOM('<div class="ai-nb"><p>no cues</p></div>')
      .window.document.querySelector('p');
    assert.equal(api.noteBlockTs(bare), null);
    assert.equal(api.noteBlockTs(null), null);
  });
}

/* ── what "this section" means ──────────────────────────────────────────────── */
{
  const { api, box } = buildNotes();
  const blocks = [...box.querySelector('.ai-nb').children];

  test('a heading owns its body but stops at the next heading', () => {
    const text = api.noteSectionText(blocks[0]);
    assert.ok(text.startsWith('Fundamental Rights'));
    assert.ok(text.includes('personal liberty'));
    assert.ok(text.includes('Article 21A'));
    assert.ok(text.includes('86th Amendment'));
    assert.ok(!text.includes('Directive Principles'), 'must not run into the next section');
    assert.equal(text.split('\n').length, 4, 'one line per block');
  });

  test('an MCQ card owns its trailing explanation, which is a SIBLING not a child', () => {
    const card = blocks.find((b) => b.classList.contains('qkeep'));
    const text = api.noteSectionText(card);
    assert.ok(text.includes('Which article covers education?'));
    assert.ok(text.includes('21A'), 'options belong to the question');
    assert.ok(text.includes('Inserted by the 86th Amendment'), 'explanation must be picked up');
  });

  test('an MCQ card stops at the next card', () => {
    const card = blocks.find((b) => b.classList.contains('qkeep'));
    assert.ok(!api.noteSectionText(card).includes('Part IV is enforceable'));
  });

  test('a passage is bounded by NOTE_EXCERPT_MAX', () => {
    const dom = new JSDOM('<div class="ai-nb"><div class="sec">H</div><p>' +
      'y'.repeat(30000) + '</p></div>');
    const wide = buildNotes();
    const head = dom.window.document.querySelector('.sec');
    assert.ok(wide.api.noteSectionText(head).length <= wide.api.NOTE_EXCERPT_MAX);
  });
}

/* ── the affordance is attached where it is useful ──────────────────────────── */
{
  const { api, box } = buildNotes();
  api.setupNoteAsk(box);
  const nb = box.querySelector('.ai-nb');

  test('every block gets a stable index, which the notebook never had', () => {
    [...nb.children].forEach((block, i) => {
      assert.equal(block.getAttribute('data-nb-block'), String(i));
    });
  });

  test('headings get a button', () => {
    assert.equal(nb.querySelectorAll('.sec > .ai-nb-ask').length, 2);
  });

  test('MCQ question cards get one too, inside the flex .q-head', () => {
    /* nbMCQ emits .qkeep with no .sec, so before this MCQ notes had no ask button
       anywhere — and a wrong answer key is the worst thing generated notes can
       contain. .q-head is chosen because it is already a flex row: a child pushed
       over with margin-left:auto cannot change the block height, and the private
       annotation canvas is anchored to the notebook's geometry. */
    assert.equal(nb.querySelectorAll('.q-head > .ai-nb-ask').length, 2);
  });

  test('the button says what it will ask about', () => {
    assert.match(nb.querySelector('.sec > .ai-nb-ask').getAttribute('aria-label'), /this section/);
    assert.match(nb.querySelector('.q-head > .ai-nb-ask').getAttribute('aria-label'), /this question/);
  });

  test('a second setup pass does not double up the buttons', () => {
    api.setupNoteAsk(box);
    assert.equal(nb.querySelectorAll('.ai-nb-ask').length, 4);
  });
}

/* ── the event race that already shipped once ───────────────────────────────── */
await testAsync('the section button opens the popover and it STAYS open', async () => {
  /* Regression. Two listeners live on .ai-nb: a click handler that opens the
     popover, and a pointerup handler that defers settle() by 10ms to catch text
     selections. On desktop the order is pointerdown -> pointerup -> click, so the
     click opened the popover and settle() then found no text selection and closed
     it. Touch hid the bug by delaying `click` past the timer.
     Verified to fail if fromNoteAffordance() stops guarding the pointer handlers. */
  const { window, api, box } = buildNotes();
  api.setupNoteAsk(box);
  const btn = box.querySelector('.sec > .ai-nb-ask');
  const fire = (el, type) =>
    el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));

  window.getSelection().removeAllRanges();
  fire(btn, 'pointerdown');
  fire(btn, 'pointerup');
  fire(btn, 'click');
  assert.equal(api.notePopVisible(), true, 'popover should open on click');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(api.notePopVisible(), true, 'popover must survive the deferred settle()');
  assert.ok(api._popCtx().passage.startsWith('Fundamental Rights'));
  assert.equal(api._popCtx().ts, 0);
});

await testAsync('a second tap on the same button dismisses it; a different one re-anchors', async () => {
  const { window, api, box } = buildNotes();
  api.setupNoteAsk(box);
  const btns = [...box.querySelectorAll('.sec > .ai-nb-ask')];
  const fire = (el, type) =>
    el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));

  fire(btns[0], 'click');
  assert.equal(api.notePopVisible(), true);
  fire(btns[0], 'click');
  assert.equal(api.notePopVisible(), false, 'same button should toggle closed');
  fire(btns[0], 'click');
  fire(btns[1], 'click');
  assert.equal(api.notePopVisible(), true, 'a different section must not close it');
  assert.equal(api._popCtx().ts, 754, 'and must re-anchor to that section');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(api.notePopVisible(), true);
});

await testAsync('a text selection opens it, and losing the selection closes it', async () => {
  const { window, api, box } = buildNotes();
  api.setupNoteAsk(box);
  const doc = window.document;
  const para = doc.getElementById('p1');
  const fire = (el, type) =>
    el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));

  const range = doc.createRange();
  range.selectNodeContents(para);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);
  fire(para, 'pointerup');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(api.notePopVisible(), true);
  assert.equal(api._popCtx().passage, 'Article 21 protects life and personal liberty.');
  assert.equal(api._popCtx().anchor, null, 'a selection has no button anchor');

  window.getSelection().removeAllRanges();
  fire(para, 'pointerup');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(api.notePopVisible(), false);
});

await testAsync('selection is disarmed while a pen or highlighter is armed', async () => {
  /* The annotation canvas takes the pointer events for every tool except 'move',
     so there is no selection to act on and the popover would only be in the way. */
  const { window, api, box, state } = buildNotes();
  api.setupNoteAsk(box);
  const doc = window.document;
  const para = doc.getElementById('p2');
  state.markTool = 'pen';
  const range = doc.createRange();
  range.selectNodeContents(para);
  window.getSelection().addRange(range);
  para.dispatchEvent(new window.Event('pointerup', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(api.notePopVisible(), false);
});

test('the guard recognises the controls that own the popover', () => {
  const { api, box } = buildNotes();
  api.setupNoteAsk(box);
  const btn = box.querySelector('.ai-nb-ask');
  assert.equal(api.fromNoteAffordance({ target: btn }), true);
  assert.equal(api.fromNoteAffordance({ target: box.querySelector('#ai-note-pop') }), true);
  assert.equal(api.fromNoteAffordance({ target: box.querySelector('#p1') }), false);
  assert.equal(api.fromNoteAffordance({}), false);
  assert.equal(api.fromNoteAffordance(null), false);
});

/* ── the actions ────────────────────────────────────────────────────────────── */
test('Verify forces a live web lookup; Explain and Example do not', () => {
  /* Checking whether a fact still holds against stale training data is the exact
     failure being fixed, so Verify must not be able to inherit web:'off'. */
  const { api } = buildNotes();
  assert.equal(api.NOTE_ACTIONS.verify.web, 'on');
  assert.ok(!api.NOTE_ACTIONS.explain.web);
  assert.ok(!api.NOTE_ACTIONS.example.web);
});

test('every action embeds the passage and asks something answerable', () => {
  const { api } = buildNotes();
  for (const key of Object.keys(api.NOTE_ACTIONS)) {
    const spec = api.NOTE_ACTIONS[key];
    assert.ok(spec.label && spec.title, `${key} needs a label and a title`);
    assert.ok(spec.prompt('SOME CLAIM').includes('SOME CLAIM'), `${key} must quote the passage`);
  }
  const verify = api.NOTE_ACTIONS.verify.prompt('X');
  assert.match(verify, /this lecture\s+actually say/i, 'Verify must ask about the LECTURE');
  assert.match(verify, /correct version/i, 'Verify must ask for the correction');
});

test('an action sends the full passage and the timestamp, not just the snippet', () => {
  const { api, box, state } = buildNotes();
  api.setupNoteAsk(box);
  const card = [...box.querySelector('.ai-nb').children].find((b) => b.classList.contains('qkeep'));
  api.runNoteAction('verify', api.noteSectionText(card), api.noteBlockTs(card));
  assert.equal(state.asked.length, 1);
  const call = state.asked[0];
  assert.ok(call.passage.includes('Inserted by the 86th Amendment'), 'full passage travels');
  assert.equal(call.ts, 754);
  assert.equal(call.opts.web, 'on');
  assert.ok(call.q.length < call.passage.length + 300, 'the question stays a question');
});

test('an empty passage is not sent anywhere', () => {
  const { api, state } = buildNotes();
  assert.equal(api.runNoteAction('verify', '   ', 0), false);
  assert.equal(api.runNoteAction('nonsense-action', 'text', 0), false);
  assert.equal(state.asked.length, 0);
});

/* ── the passage staged by "Ask…" ───────────────────────────────────────────── */
{
  const { api } = buildNotes();
  test('a staged passage is consumed exactly once', () => {
    api.setPendingNoteContext('Article 21A', 754);
    assert.equal(api.takePendingNoteContext().passage, 'Article 21A');
    assert.equal(api.takePendingNoteContext(), null, 'must not re-attach silently');
  });

  test('a staged passage can be cleared', () => {
    api.setPendingNoteContext('X', 1);
    api.setPendingNoteContext(null, null);
    assert.equal(api.takePendingNoteContext(), null);
  });

  test('a staged passage expires, so it cannot land on an unrelated question', () => {
    api.setPendingNoteContext('stale', 1);
    api._peekPending().at -= api.NOTE_CONTEXT_TTL_MS - 1000;
    assert.notEqual(api.takePendingNoteContext(), null, 'still valid inside the TTL');
    api.setPendingNoteContext('stale', 1);
    api._peekPending().at -= api.NOTE_CONTEXT_TTL_MS + 1000;
    assert.equal(api.takePendingNoteContext(), null, 'dropped past the TTL');
    assert.equal(api._peekPending(), null, 'and cleared, so it cannot come back');
  });

  test('a staged passage is bounded', () => {
    api.setPendingNoteContext('z'.repeat(30000), 1);
    assert.equal(api._peekPending().passage.length, api.NOTE_EXCERPT_MAX);
  });
}

/* ── the request body: the contract _tutor_prepare() reads ──────────────────── */
{
  const flags = { lib: false, course: false, web: 'auto' };
  const tutorBody = vm.runInNewContext(
    section('  function tutorBody(vid, question, mode, histForApi, opts) {',
      '  function paintTutorBubble(') + ';tutorBody',
    {
      NOTE_EXCERPT_MAX: 12000,
      isLibraryScope: () => flags.lib,
      isCourseTutorScope: () => flags.course,
      outLang: () => 'Hinglish',
      outProvider: () => 'google',
      outModel: () => 'gemini-flash-latest',
      tutorCourseId: () => 'PL123',
      tutorWebMode: () => flags.web,
      window: { TutorMemory: { contextText: () => 'Weak topics: Polity' } }
    }
  );
  const body = (...args) => JSON.parse(tutorBody(...args));

  test('the pre-existing contract is unchanged when no options are passed', () => {
    const b = body('vid00000001', 'what is article 21', 'chat', []);
    assert.equal(b.id, 'vid00000001');
    assert.equal(b.q, 'what is article 21');
    assert.equal(b.mode, 'chat');
    assert.equal(b.out, 'Hinglish');
    assert.equal(b.web, 'auto');
    assert.equal(b.memory, 'Weak topics: Polity');
    assert.ok(!('note_excerpt' in b) && !('note_ts' in b));
    assert.ok(!('scope' in b) && !('course_id' in b));
  });

  test('the passage travels in its own field, never glued into the question', () => {
    /* Otherwise it would fill the chat bubble, be truncated out of the replayed
       history, and be learned by the memory profiler as something the student said. */
    const b = body('v', 'Verify this', 'chat', [], { noteExcerpt: 'PASSAGE', noteTs: 754 });
    assert.equal(b.note_excerpt, 'PASSAGE');
    assert.equal(b.note_ts, 754);
    assert.equal(b.q, 'Verify this');
  });

  test('a per-call web override beats the toggle, in both directions', () => {
    assert.equal(body('v', 'q', 'chat', [], { web: 'on' }).web, 'on');
    flags.web = 'off';
    assert.equal(body('v', 'q', 'chat', [], { web: 'on' }).web, 'on');
    assert.equal(body('v', 'q', 'chat', [], {}).web, 'off');
    flags.web = 'auto';
  });

  test('timestamp 0 survives, and rubbish timestamps are dropped', () => {
    assert.equal(body('v', 'q', 'c', [], { noteExcerpt: 'x', noteTs: 0 }).note_ts, 0);
    assert.equal(body('v', 'q', 'c', [], { noteExcerpt: 'x', noteTs: 12.7 }).note_ts, 13);
    for (const bad of [null, undefined, 'abc', -5, NaN]) {
      assert.ok(!('note_ts' in body('v', 'q', 'c', [], { noteExcerpt: 'x', noteTs: bad })),
        `note_ts should be omitted for ${String(bad)}`);
    }
    assert.ok(!('note_ts' in body('v', 'q', 'c', [], { noteTs: 12 })),
      'a timestamp with no passage means nothing');
  });

  test('the excerpt is capped before it goes on the wire', () => {
    assert.equal(body('v', 'q', 'c', [], { noteExcerpt: 'y'.repeat(99999) }).note_excerpt.length, 12000);
    assert.ok(!('note_excerpt' in body('v', 'q', 'c', [], { noteExcerpt: '' })));
  });

  test('library scope sends its own shape', () => {
    flags.lib = true; flags.course = true;
    let b = body('', 'revision plan', 'chat', []);
    assert.equal(b.scope, 'course');
    assert.equal(b.course_id, 'PL123');
    assert.ok(!('id' in b) && !('mode' in b));
    flags.course = false;
    b = body('', 'q', 'chat', []);
    assert.equal(b.scope, 'library');
    assert.equal(b.course_id, '');
    flags.lib = false;
  });
}

/* ── Focus Mode chrome: the toolbar and the inversion toggle ────────────────── */
{
  const dom = new JSDOM('<!doctype html><body><div id="ai-sub"></div></body>');
  const store = {};
  const invert = vm.runInNewContext(
    section("  var NOTES_INVERT_KEY = 'aiNotesInvert';", '  function notesFocusToolbarHtml()') +
    section('  function notesFocusToolbarHtml() {', '  function notesFocusTimeLabel(') +
    ';({ notesInverted, setNotesInverted, applyNotesInvert, toggleNotesInvert, notesFocusToolbarHtml })',
    {
      window: dom.window,
      document: dom.window.document,
      localStorage: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); }
      },
      esc: escapers.esc,
      escAttr: escapers.escAttr,
      curTitle: () => 'Polity L3'
    }
  );
  const box = dom.window.document.getElementById('ai-sub');
  box.innerHTML = invert.notesFocusToolbarHtml();

  test('the Focus toolbar still carries every control', () => {
    /* It is one long string concatenation; a dropped closing tag would nest later
       regions inside an earlier one instead of failing loudly. */
    const want = ['ai-focus-close', 'ai-focus-fullscreen', 'ai-focus-invert', 'ai-focus-video',
      'ai-focus-follow', 'ai-focus-ask-toggle', 'ai-focus-verify', 'ai-focus-annotations-toggle',
      'ai-focus-pdf', 'ai-focus-time', 'ai-focus-video-title', 'ai-focus-annotation-bar',
      'ai-focus-mini-video', 'ai-focus-mini-close', 'ai-focus-ask', 'ai-focus-ask-body',
      'ai-focus-ask-quote', 'ai-focus-ask-left', 'ai-focus-ask-close', 'ai-note-pop',
      'ai-focus-mark-undo', 'ai-focus-mark-redo', 'ai-focus-mark-clear', 'ai-focus-mark-done'];
    const missing = want.filter((id) => !box.querySelector('#' + id));
    assert.deepEqual(missing, []);
    assert.equal(box.querySelectorAll('[data-focus-mark-tool]').length, 4);
    assert.equal(box.querySelectorAll('[data-focus-mark-color]').length, 5);
  });

  test('the ask sheet, popover, annotation bar and mini video all start hidden', () => {
    for (const id of ['ai-focus-ask', 'ai-note-pop', 'ai-focus-annotation-bar', 'ai-focus-mini-video']) {
      assert.equal(box.querySelector('#' + id).hidden, true, `#${id} should start hidden`);
    }
  });

  test('the five top-level regions are siblings, none swallowed', () => {
    const tops = [...box.children].map((e) => String(e.className).split(' ')[0]);
    assert.deepEqual(tops, ['ai-focus-toolbar', 'ai-focus-annotation-bar', 'ai-focus-mini-video',
      'ai-focus-ask', 'ai-note-pop']);
  });

  test('the invert toggle sits in the cluster that never scrolls', () => {
    /* The actions row scrolls sideways on a phone; a display control must not be
       able to slide off screen. */
    assert.ok(box.querySelector('.ai-focus-heading #ai-focus-invert'));
    assert.ok(!box.querySelector('.ai-focus-actions #ai-focus-invert'));
  });

  test('inversion defaults to off and round-trips', () => {
    assert.equal(invert.notesInverted(), false);
    invert.applyNotesInvert(box);
    assert.ok(!box.classList.contains('ai-notes-invert'));

    invert.toggleNotesInvert(box);
    const btn = box.querySelector('#ai-focus-invert');
    assert.ok(box.classList.contains('ai-notes-invert'));
    assert.equal(btn.getAttribute('aria-pressed'), 'true');
    assert.ok(btn.classList.contains('ai-focus-control-active'));
    assert.match(btn.title, /paper look/i, 'the label should offer the way back');
    assert.equal(btn.getAttribute('aria-label'), btn.title);

    invert.toggleNotesInvert(box);
    assert.ok(!box.classList.contains('ai-notes-invert'));
    assert.equal(btn.getAttribute('aria-pressed'), 'false');
    assert.match(btn.title, /invert/i);
  });

  test('inversion is restored on a re-render, and bad stored values read as off', () => {
    invert.setNotesInverted(true);
    box.innerHTML = invert.notesFocusToolbarHtml();
    box.classList.remove('ai-notes-invert');
    invert.applyNotesInvert(box);
    assert.ok(box.classList.contains('ai-notes-invert'));
    assert.equal(box.querySelector('#ai-focus-invert').getAttribute('aria-pressed'), 'true');

    store.aiNotesInvert = 'garbage';
    assert.equal(invert.notesInverted(), false);
    invert.applyNotesInvert(null);              // must not throw
    invert.applyNotesInvert(dom.window.document.createElement('div'));
  });
}

console.log('In-note AI interaction (notes ask / verify / Focus Mode)');
console.log(results.join('\n'));
if (process.exitCode) {
  console.error('\nNotes ask tests FAILED');
} else {
  console.log(`\n${results.length} checks passed`);
}
