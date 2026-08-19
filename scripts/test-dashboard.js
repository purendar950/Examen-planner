/**
 * Tests for the v5 Telegram dashboard system.
 * Run: cd scripts && node test-dashboard.js
 * Does not need Firebase or Telegram tokens — tests only the pure functions.
 */

const {
  buildMorningDashboard,
  buildEveningDashboard,
  morningKeyboard,
  eveningKeyboard,
  calculateStreak,
  findWeakArea,
  deriveFocus,
  getTopPriorities,
  taskPriority,
} = require('./telegram-dashboard');

const { shiftDate, todayIST, fmtShort, subjectEmoji } = require('./telegram-lib');

let passed = 0, failed = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  \u2705 ${label}`);
    passed++;
  } else {
    console.log(`  \u274C ${label} — ${detail || 'failed'}`);
    failed++;
  }
}

/* ── 1. Morning dashboard: zero tasks ── */
console.log('\n1. Morning dashboard — zero tasks');
const emptyState = { tasks: {}, streak: 0 };
const emptyMorning = buildMorningDashboard('User', emptyState, '', todayIST());
assert('has text', !!emptyMorning.text);
assert('hasContent = false', emptyMorning.hasContent === false);
assert('contains MORNING MISSION', emptyMorning.text.includes('MORNING MISSION'));
assert('contains streak', emptyMorning.text.includes('STREAK'));

/* ── 2. Morning dashboard: one task ── */
console.log('\n2. Morning dashboard — one task');
const oneTaskState = {
  tasks: { [todayIST()]: [{ text: 'Polity Article 14', done: false }] },
  streak: 3,
};
const oneMorning = buildMorningDashboard('Rahul', oneTaskState, '', todayIST());
assert('has text', !!oneMorning.text);
assert('hasContent = true', oneMorning.hasContent === true);
assert('contains task text', oneMorning.text.includes('Article 14'));
assert('contains focus', oneMorning.text.includes("TODAY'S FOCUS"));
assert('contains progress', oneMorning.text.includes('PROGRESS'));

/* ── 3. Morning dashboard: all tasks completed ── */
console.log('\n3. Morning dashboard — all completed');
const allDoneState = {
  tasks: { [todayIST()]: [
    { text: 'Task 1', done: true },
    { text: 'Task 2', done: true },
    { text: 'Task 3', done: true },
  ] },
  streak: 5,
};
const allDoneMorning = buildMorningDashboard('Priya', allDoneState, 'Geometry Revision\nMaths Algebra', todayIST());
assert('has text', !!allDoneMorning.text);
assert('hasContent = true', allDoneMorning.hasContent === true);
assert('contains progress 100%', allDoneMorning.text.includes('100%'));
assert('contains study plan', allDoneMorning.text.includes('STUDY PLAN'));

/* ── 4. Morning dashboard: mixed completed/pending ── */
console.log('\n4. Morning dashboard — mixed');
const mixedState = {
  tasks: { [todayIST()]: [
    { text: 'Task 1', done: true },
    { text: 'Geometry Revision', done: false },
    { text: 'Direction Sense', done: false },
    { text: 'Article 15', done: true },
    { text: 'Heron Formula', done: false },
  ] },
  streak: 6,
};
const mixedMorning = buildMorningDashboard('Amit', mixedState, 'Polity Fundamental Rights', todayIST());
assert('has text', !!mixedMorning.text);
assert('contains progress bar', mixedMorning.text.includes('40%'));
assert('contains priorities', mixedMorning.text.includes('TOP PRIORITIES'));
assert('contains streak 6', mixedMorning.text.includes('6 DAYS'));

/* ── 5. Morning dashboard: overdue tasks ── */
console.log('\n5. Morning dashboard — overdue tasks');
const yesterday = shiftDate(todayIST(), -1);
const overdueState = {
  tasks: {
    [yesterday]: [{ text: 'Modern History Revision', done: false }],
    [todayIST()]: [{ text: 'Today Task', done: true }],
  },
  streak: 2,
};
const overdueMorning = buildMorningDashboard('Sneha', overdueState, '', todayIST());
assert('has text', !!overdueMorning.text);
assert('hasContent = true', overdueMorning.hasContent === true);

/* ── 6. Morning dashboard: long task names ── */
console.log('\n6. Morning dashboard — long task names');
const longTaskState = {
  tasks: { [todayIST()]: [
    { text: 'A'.repeat(200), done: false },
  ] },
};
const longMorning = buildMorningDashboard('Test', longTaskState, '', todayIST());
assert('text not too long', longMorning.text.length < 5000);

/* ── 7. Morning dashboard: HTML characters ── */
console.log('\n7. Morning dashboard — HTML safety');
const htmlState = {
  tasks: { [todayIST()]: [
    { text: 'Task with <b>bold</b> and &amp; stuff', done: false },
  ] },
};
const htmlMorning = buildMorningDashboard('Test', htmlState, '', todayIST());
assert('escapes HTML tags', !htmlMorning.text.includes('<b>bold</b>'));
assert('escapes ampersand', !htmlMorning.text.includes('&amp; stuff') || htmlMorning.text.includes('&amp;amp;'));

/* ── 8. Morning dashboard: videos ── */
console.log('\n8. Morning dashboard — videos');
const videoState = {
  tasks: { [todayIST()]: [
    { text: 'Polity Lecture', done: false, type: 'video', videoId: 'abc123', url: 'https://youtube.com/watch?v=abc123' },
  ] },
};
const videoMorning = buildMorningDashboard('Test', videoState, '', todayIST());
assert('contains VIDEOS section', videoMorning.text.includes('VIDEOS'));

/* ── 9. Morning keyboard ── */
console.log('\n9. Morning keyboard');
const mkb = morningKeyboard('2026-08-18');
assert('has inline_keyboard', !!mkb.inline_keyboard);
assert('3 nav buttons', mkb.inline_keyboard[0].length === 3);
assert('PREV button', mkb.inline_keyboard[0][0].text.includes('PREV'));
assert('TODAY button', mkb.inline_keyboard[0][1].text === 'TODAY');
assert('NEXT button', mkb.inline_keyboard[0][2].text.includes('NEXT'));
assert('OPEN PLANNER button', mkb.inline_keyboard[1][0].text.includes('PLANNER'));
assert('OPEN PLANNER is URL button', !!mkb.inline_keyboard[1][0].url);

/* ── 10. Evening dashboard: 100% complete ── */
console.log('\n10. Evening dashboard — 100%');
const fullState = {
  tasks: { [todayIST()]: [
    { text: 'Task 1', done: true },
    { text: 'Task 2', done: true },
    { text: 'Task 3', done: true },
  ] },
  streak: 10,
};
const fullEvening = buildEveningDashboard('User', fullState, todayIST());
assert('has text', !!fullEvening.text);
assert('hasContent = true', fullEvening.hasContent === true);
assert('contains DAILY AUDIT', fullEvening.text.includes('DAILY AUDIT'));
assert('contains 100%', fullEvening.text.includes('100%'));

/* ── 11. Evening dashboard: 0% (all pending) ── */
console.log('\n11. Evening dashboard — 0%');
const zeroPctState = {
  tasks: { [todayIST()]: [
    { text: 'Task 1', done: false },
    { text: 'Task 2', done: false },
    { text: 'Task 3', done: false },
  ] },
  streak: 0,
};
const zeroPctEvening = buildEveningDashboard('User', zeroPctState, todayIST());
assert('has text', !!zeroPctEvening.text);
assert('contains 0%', zeroPctEvening.text.includes('0%'));
assert('contains STILL PENDING', zeroPctEvening.text.includes('STILL PENDING'));

/* ── 12. Evening dashboard: no tasks ── */
console.log('\n12. Evening dashboard — no tasks');
const noTaskEvening = buildEveningDashboard('User', { tasks: {} }, todayIST());
assert('hasContent = false', noTaskEvening.hasContent === false);
assert('empty text', !noTaskEvening.text);

/* ── 13. Evening dashboard: 50% ── */
console.log('\n13. Evening dashboard — 50%');
const halfState = {
  tasks: { [todayIST()]: [
    { text: 'Done 1', done: true },
    { text: 'Pending 1', done: false },
  ] },
  streak: 3,
};
const halfEvening = buildEveningDashboard('User', halfState, todayIST());
assert('has text', !!halfEvening.text);
assert('hasContent = true', halfEvening.hasContent === true);

/* ── 14. Evening keyboard ── */
console.log('\n14. Evening keyboard');
const ekb = eveningKeyboard('2026-08-18');
assert('has inline_keyboard', !!ekb.inline_keyboard);
assert('3 nav buttons', ekb.inline_keyboard[0].length === 3);
assert('FINISH NOW button', ekb.inline_keyboard[1][0].text.includes('FINISH'));
assert('MOVE TO TOMORROW button', ekb.inline_keyboard[1][1].text.includes('MOVE'));
assert('OPEN PLANNER button', ekb.inline_keyboard[2][0].text.includes('PLANNER'));
assert('FINISH is callback', !!ekb.inline_keyboard[1][0].callback_data);
assert('MOVE is callback', !!ekb.inline_keyboard[1][1].callback_data);

/* ── 15. Date navigation: month boundaries ── */
console.log('\n15. Date navigation — month boundaries');
assert('31 Aug -> 1 Sep', shiftDate('2026-08-31', 1) === '2026-09-01');
assert('1 Sep -> 31 Aug', shiftDate('2026-09-01', -1) === '2026-08-31');
assert('30 Nov -> 1 Dec', shiftDate('2026-11-30', 1) === '2026-12-01');
assert('1 Mar -> 28 Feb (non-leap)', shiftDate('2026-03-01', -1) === '2026-02-28');

/* ── 16. Date navigation: year boundaries ── */
console.log('\n16. Date navigation — year boundaries');
assert('31 Dec -> 1 Jan', shiftDate('2026-12-31', 1) === '2027-01-01');
assert('1 Jan -> 31 Dec', shiftDate('2027-01-01', -1) === '2026-12-31');

/* ── 17. Streak calculation ── */
console.log('\n17. Streak calculation');
assert('stored streak used', calculateStreak({ streak: 7 }) === 7);
assert('no streak = 0', calculateStreak({ tasks: {} }) === 0);

/* ── 18. Weak area detection ── */
console.log('\n18. Weak area detection');
const weakLines = [
  { line: 'Geometry task', overdue: false, rawText: 'Geometry Revision' },
  { line: 'Geometry task 2', overdue: false, rawText: 'Geometry Heron Formula' },
  { line: 'Polity task', overdue: false, rawText: 'Article 14' },
];
const weak = findWeakArea(weakLines);
assert('finds weak area', !!weak);
assert('is maths (geometry)', weak.emoji === subjectEmoji('Geometry Revision'));
assert('count = 2', weak.count === 2);

/* ── 19. Priority helper ── */
console.log('\n19. Priority helper');
assert('overdue = high', taskPriority({ overdue: true }) === 'high');
assert('explicit high = high', taskPriority({ priority: 'high' }) === 'high');
assert('normal = medium', taskPriority({ text: 'Some task' }) === 'medium');
assert('revision = low', taskPriority({ text: 'Revision of chapter 5' }) === 'low');

/* ── 20. Top priorities ── */
console.log('\n20. Top priorities');
const prioLines = [
  { overdue: true, rawText: 'Overdue task' },
  { overdue: true, rawText: 'Another overdue' },
  { overdue: false, rawText: 'Normal task' },
  { overdue: false, rawText: 'Another normal' },
];
const prios = getTopPriorities(prioLines);
assert('max 3 items', prios.length <= 3);
assert('overdue first', prios[0].overdue === true);

/* ── 21. Callback data format ── */
console.log('\n21. Callback data format');
const pmPrev = morningKeyboard('2026-08-18').inline_keyboard[0][0];
const peNext = eveningKeyboard('2026-08-18').inline_keyboard[0][2];
const peFinish = eveningKeyboard('2026-08-18').inline_keyboard[1][0];
const peMove = eveningKeyboard('2026-08-18').inline_keyboard[1][1];
assert('pm:prev format', /^pm:prev:\d{4}-\d{2}-\d{2}$/.test(pmPrev.callback_data));
assert('pe:next format', /^pe:next:\d{4}-\d{2}-\d{2}$/.test(peNext.callback_data));
assert('pe:finish format', /^pe:finish:\d{4}-\d{2}-\d{2}$/.test(peFinish.callback_data));
assert('pe:move format', /^pe:move:\d{4}-\d{2}-\d{2}$/.test(peMove.callback_data));
assert('callback data < 64 bytes', peMove.callback_data.length < 64);

/* ── 22. fmtShort date formatting ── */
console.log('\n22. Date formatting');
assert('fmtShort format', /^\w{3} \d{1,2}$/.test(fmtShort('2026-08-18')));

/* ── SUMMARY ── */
console.log(`\n${'='.repeat(40)}`);
console.log(`Total: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\u274C SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('\u2705 ALL TESTS PASSED');
}