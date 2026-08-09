/*
 * The AI Tutor's live web search, browser side: the 🌐 mode toggle, and rendering
 * the sources an answer cites.
 *
 * The interesting failure here is a security one. esc() is a TEXT escaper — it
 * deliberately leaves quotes alone — so putting a third-party search-result title
 * or URL into an HTML attribute lets a crafted value close the attribute early and
 * everything after it is parsed as MORE attributes. `x" onmouseover=alert(1)`
 * becomes a live event handler. escAttr() exists for exactly that, and these
 * results are the only place in the app where genuinely untrusted third-party text
 * reaches an attribute.
 *
 * The server side of this feature (provider chain, the DuckDuckGo parser, the
 * "is this question time-sensitive" heuristic) is covered by
 * youtube-turbo-proxy/tests/test_tutor.py.
 *
 * Run with:  npm run test:tutor-web       (also part of `npm run check`)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';
import vm from 'node:vm';

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

const escapers = vm.runInNewContext(
  section('  function esc(s)', '  function mdInline(s)') + ';({ esc, escAttr })', {}
);

const store = {};
const api = vm.runInNewContext(
  section("  var WEB_KEY = 'aiTutorWeb';", '  /* ── Asking about the notes') +
  ';({ tutorWebMode, setTutorWebMode, cycleTutorWebMode, webModeUi, webBtnHtml,' +
  ' safeHttpUrl, webSourcesHtml, WEB_MODES })',
  {
    esc: escapers.esc,
    escAttr: escapers.escAttr,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); }
    }
  }
);

/* ── the escapers themselves ────────────────────────────────────────────────── */
test('esc() is a text escaper and leaves quotes alone', () => {
  /* Documenting the trap rather than "fixing" it: esc() is correct for text
     content, and dozens of call sites rely on that. */
  assert.equal(escapers.esc('<b>&</b>'), '&lt;b&gt;&amp;&lt;/b&gt;');
  assert.ok(escapers.esc('say "hi"').includes('"'));
});

test('escAttr() also neutralises both quote characters', () => {
  assert.equal(escapers.escAttr('a"b\'c'), 'a&quot;b&#39;c');
  assert.equal(escapers.escAttr('<x>&'), '&lt;x&gt;&amp;');
  assert.equal(escapers.escAttr(null), '');
});

/* ── the 🌐 mode toggle ─────────────────────────────────────────────────────── */
test('web mode defaults to auto', () => {
  /* auto searches only time-sensitive questions, so "explain photosynthesis"
     never pays for a lookup. */
  assert.equal(api.tutorWebMode(), 'auto');
  /* joined rather than deepEqual: the array comes from another vm realm, so its
     prototype is not the one assert.deepEqual expects. */
  assert.equal([...api.WEB_MODES].join(','), 'auto,on,off');
});

test('web mode round-trips and rejects rubbish', () => {
  api.setTutorWebMode('on');
  assert.equal(api.tutorWebMode(), 'on');
  api.setTutorWebMode('off');
  assert.equal(api.tutorWebMode(), 'off');
  api.setTutorWebMode('nonsense');
  assert.equal(api.tutorWebMode(), 'auto');
  store.aiTutorWeb = 'value-from-an-older-build';
  assert.equal(api.tutorWebMode(), 'auto');
});

test('the toggle cycles auto → on → off → auto', () => {
  api.setTutorWebMode('auto');
  assert.deepEqual(
    [api.cycleTutorWebMode(), api.cycleTutorWebMode(), api.cycleTutorWebMode()],
    ['on', 'off', 'auto']
  );
});

test('every mode has a label, a tooltip and a toast', () => {
  for (const mode of api.WEB_MODES) {
    const ui = api.webModeUi(mode);
    assert.ok(ui.label && ui.title && ui.toast, `${mode} is missing copy`);
  }
  assert.equal(api.webModeUi('garbage'), api.webModeUi('auto'), 'unknown modes fall back');
});

test('the button reports its state to assistive tech and to CSS', () => {
  api.setTutorWebMode('auto');
  let html = api.webBtnHtml();
  assert.match(html, /class="ai-btn sec ai-tutor-web-btn on"/, 'auto counts as enabled');
  assert.match(html, /data-web-mode="auto"/);
  assert.match(html, /aria-label="/);
  api.setTutorWebMode('off');
  html = api.webBtnHtml();
  assert.ok(!/ai-tutor-web-btn on"/.test(html), 'off must not look enabled');
  assert.match(html, /data-web-mode="off"/);
});

/* ── rendering the cited sources ────────────────────────────────────────────── */
test('only http(s) URLs are ever rendered', () => {
  for (const good of ['https://x.com/a', 'http://x.com', '  https://ok.com  ']) {
    assert.ok(api.safeHttpUrl(good), `${good} should be allowed`);
  }
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', '//evil.com',
    'vbscript:x', 'file:///etc/passwd', '', null, undefined]) {
    assert.equal(api.safeHttpUrl(bad), '', `${String(bad)} must be rejected`);
  }
});

test('no sources means no footer at all', () => {
  assert.equal(api.webSourcesHtml(null), '');
  assert.equal(api.webSourcesHtml([]), '');
  /* Not even an empty shell when every entry is unusable. */
  assert.equal(api.webSourcesHtml([{ title: 't', url: 'javascript:x', site: 's' }]), '');
});

test('citation numbers match the array the server sent, gaps included', () => {
  /* The model writes [Web 2] inline; if a skipped entry renumbered the list, the
     student would be pointed at the wrong source. */
  const html = api.webSourcesHtml([
    { title: 'SSC calendar', url: 'https://ssc.gov.in/cal', site: 'ssc.gov.in' },
    { title: 'bad', url: 'javascript:alert(1)', site: 'evil' },
    { title: 'Sanjay Malhotra — Wikipedia', url: 'https://en.wikipedia.org/wiki/X', site: 'en.wikipedia.org' }
  ]);
  assert.equal((html.match(/<a /g) || []).length, 2);
  assert.ok(html.includes('[Web 1]'));
  assert.ok(html.includes('[Web 3]'));
  assert.ok(!html.includes('[Web 2]'), 'the dropped entry must not be renumbered away');
  assert.ok(!html.includes('javascript:'));
});

test('links cannot be used to reach back into the app', () => {
  const html = api.webSourcesHtml([{ title: 't', url: 'https://x.com', site: 'x.com' }]);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer nofollow"/);
});

test('a hostile search-result title cannot break out of an attribute', () => {
  /* The regression that mattered. With esc() the title attribute closed early and
     `onerror=...` was parsed as a real attribute on the anchor. */
  const html = api.webSourcesHtml([{
    title: '"><img src=x onerror=alert(1)>',
    url: 'https://x.com/?a=1&b=2',
    site: '<script>alert(1)</script>'
  }]);
  assert.ok(!html.includes('<img'), 'no injected element');
  assert.ok(!html.includes('<script>'), 'no injected script');
  assert.equal((html.match(/title="/g) || []).length, 1, 'exactly one title attribute');
  assert.ok(!html.includes('title=""'), 'the attribute must not be closed early');
  assert.ok(html.includes('&quot;'), 'quotes must be encoded');
  assert.ok(html.includes('a=1&amp;b=2'), 'ampersands encoded in the href');
});

test('a hostile URL that passes the scheme check still cannot inject', () => {
  const html = api.webSourcesHtml([{
    title: 'ok', site: 'ok', url: 'https://x.com/" onmouseover="alert(1)'
  }]);
  assert.ok(!html.includes('" onmouseover="'), 'no live event handler');
  assert.ok(html.includes('&quot;'));
});

console.log('AI Tutor web search (browser side)');
console.log(results.join('\n'));
if (process.exitCode) {
  console.error('\nWeb search tests FAILED');
} else {
  console.log(`\n${results.length} checks passed`);
}
