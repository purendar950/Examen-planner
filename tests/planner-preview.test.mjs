import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  calculateDeadlinePace,
  countWorkDays,
  distributeByPoints,
  effortPoints,
  effectiveSize,
  normalizeRestDays
} from '../src/shared/plannerEngine.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wizard = readFileSync(join(root, 'js/tabs/plan-wizard.js'), 'utf8');
const generator = readFileSync(join(root, 'js/tabs/planner-generator.js'), 'utf8');
const appHtml = readFileSync(join(root, 'app.html'), 'utf8');

assert.match(wizard, /function pwBuildSyllabusConfig/);
assert.match(wizard, /function pwPreviewSyllabusPlan/);
assert.match(wizard, /function pwRenderPlanPreview/);
assert.match(wizard, /cfg\.dailyTopicPoints = Math\.max\(2, Math\.round\(\(Number\(cfg\.dailyHours\) \|\| 4\) \* 2\)\)/);
assert.match(wizard, /Live distribution preview/);
assert.match(wizard, /after your target/);
assert.ok(generator.includes('const dailyPoints = Math.max(2, parseInt(cfg.dailyTopicPoints, 10) || 6);'));
assert.match(wizard, /cfg\.restDays = planRestDays\(cfg\)/);
assert.match(wizard, /Deadline capacity:/);
assert.match(appHtml, /sp-rest-check/);
assert.match(generator, /function planRestDays/);
assert.match(generator, /restDays\.includes\(d\.getDay\(\)\)/);
assert.equal(JSON.stringify(normalizeRestDays([6, 'bad', 0, 0])), '[0,6]');
assert.equal(normalizeRestDays([], -1).length, 0);
assert.equal(countWorkDays({
  startDate: '2026-08-24',
  endDate: '2026-08-30',
  restDays: [0, 6]
}), 5);

const weekendFreeSchedule = distributeByPoints({
  startDate: new Date('2026-08-28T00:00:00'),
  dailyPoints: 6,
  restDays: [0, 6],
  items: [
    { id: 'a', points: 4 },
    { id: 'b', points: 4 },
    { id: 'c', points: 2 }
  ]
});
assert.deepEqual(Object.keys(weekendFreeSchedule), [
  '2026-08-28',
  '2026-08-31'
]);

const pace = calculateDeadlinePace({
  startDate: '2026-08-24',
  endDate: '2026-08-30',
  totalPoints: 12,
  restDays: [0, 6]
});
assert.equal(pace.availableDays, 5);
assert.equal(pace.requiredDailyPoints, 3);
assert.equal(pace.requiredDailyHours, 1.5);

assert.equal(effectiveSize({ size: 'big' }, { diff: 'easy' }), 'big');
assert.equal(effectiveSize({}, { diff: 'hard' }), 'big');
assert.equal(effortPoints({}, { diff: 'easy' }), 1);
assert.equal(effortPoints({}, {}), 2);

const schedule = distributeByPoints({
  startDate: new Date('2026-08-25T00:00:00'),
  dailyPoints: 6,
  restDay: -1,
  items: [
    { id: 'a', points: 4 },
    { id: 'b', points: 4 },
    { id: 'c', points: 2 }
  ]
});
const values = Object.values(schedule);
assert.equal(values.length, 2);
assert.equal(values[0].length, 1);
assert.equal(values[1].length, 2);

console.log('Planner preview contracts passed');
