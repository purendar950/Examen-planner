const assert = require('node:assert/strict');
const {
  buildMorningDashboard,
  buildEveningDashboard,
} = require('../scripts/telegram-dashboard');
const { subjectEmoji } = require('../scripts/telegram-lib');

const DATE = '2026-08-21';
const appState = {
  tasks: {
    [DATE]: [
      { text: 'Revise: Economics GDP (rolled over)', done: false, rolledFrom: '2026-08-20' },
      { text: 'Revise: Calendar revise (rolled over)', done: false, rolledFrom: '2026-08-20' },
      { text: 'Revise: Gharana kal (rolled over)', done: false, rolledFrom: '2026-08-20' },
      { text: 'HE Maths', done: false },
      { text: 'Black book vocabulary', done: false },
      { text: 'Coordinate Geometry BHUTESH SIR', done: false },
      { text: 'Abhas saini sir Pre practice batch lecture', type: 'video', videoId: 'video-1', url: 'https://www.youtube.com/watch?v=video-1', done: false },
    ],
  },
};

const morning = buildMorningDashboard('Test', appState, 'Revise: Economics GDP (rolled over)\nRevise: Calendar revise (rolled over)\nRevise: Gharana kal (rolled over)', DATE).text;
const evening = buildEveningDashboard('Test', appState, DATE).text;

assert.equal(subjectEmoji('Economics GDP'), '💰');
assert.equal(subjectEmoji('Calendar revise'), '🧠');
assert.equal(subjectEmoji('HE Maths'), '🧮');
assert.equal(subjectEmoji('lecture'), '🎬');
assert.match(morning, /STUDY PLAN/);
assert.match(morning, /▶ 🎬 <a href=/);
assert.match(morning, /💰 Revise: Economics GDP/);
assert.match(morning, /MATHS/);
assert.doesNotMatch(morning, /[\u1100-\uFFFF]0|[\u1100-\uFFFF]D|[\u1100-\uFFFF]E/);
assert.doesNotMatch(morning, /undefined/);
assert.match(evening, /STREAK/);
assert.match(evening, /🧠/);
console.log('dashboard layout harness passed');
