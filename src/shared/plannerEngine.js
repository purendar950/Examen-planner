import { addDays, formatDate, toDate } from './dateUtils.js';

export function distributeStudyItems({ items = [], startDate = new Date(), dailyLimit = 3, restDay = -1, restDays = [] } = {}) {
  const schedule = {};
  let date = addDays(startDate, 0);
  let countForDay = 0;
  const restSet = new Set(normalizeRestDays(restDays, restDay));

  items.forEach((item) => {
    while (restSet.has(date.getDay())) {
      date = addDays(date, 1);
      countForDay = 0;
    }

    const key = formatDate(date);
    schedule[key] ||= [];
    schedule[key].push(item);
    countForDay += 1;

    if (countForDay >= Math.max(1, Number(dailyLimit) || 1)) {
      date = addDays(date, 1);
      countForDay = 0;
    }
  });

  return schedule;
}

export function expandChapterSlots(chapters = [], chapterConfig = {}) {
  return chapters.flatMap((chapter) => {
    const config = chapterConfig[chapter.id] || {};
    const days = Math.max(1, Number(config.days) || 1);
    const gap = Math.max(0, Number(config.gap) || 0);
    const studySlots = Array.from({ length: days }, (_, index) => ({
      type: 'study',
      chapter,
      part: days > 1 ? `(${index + 1}/${days})` : ''
    }));
    const spacerSlots = Array.from({ length: gap }, () => ({ type: 'spacer', chapter }));
    return [...studySlots, ...spacerSlots];
  });
}

export function normalizeRestDays(restDays = [], legacyRestDay = -1) {
  const values = Array.isArray(restDays) ? restDays : [restDays];
  const normalized = new Set(
    values
      .map(value => Number(value))
      .filter(value => Number.isInteger(value) && value >= 0 && value <= 6)
  );

  const legacy = Number(legacyRestDay);
  if (Number.isInteger(legacy) && legacy >= 0 && legacy <= 6) normalized.add(legacy);
  return [...normalized].sort((a, b) => a - b);
}

export function isRestDate(date, restDays = [], legacyRestDay = -1) {
  const day = toDate(date)?.getDay();
  if (day == null) return false;
  return normalizeRestDays(restDays, legacyRestDay).includes(day);
}

export function countWorkDays({ startDate, endDate, restDays = [], legacyRestDay = -1 } = {}) {
  const start = toDate(startDate);
  const end = toDate(endDate);
  if (!start || !end || end < start) return 0;

  const restSet = new Set(normalizeRestDays(restDays, legacyRestDay));
  let count = 0;
  for (let date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
    if (!restSet.has(date.getDay())) count += 1;
  }
  return count;
}

export function calculateDeadlinePace({
  startDate,
  endDate,
  totalPoints,
  restDays = [],
  legacyRestDay = -1,
} = {}) {
  const availableDays = countWorkDays({ startDate, endDate, restDays, legacyRestDay });
  const points = Math.max(0, Number(totalPoints) || 0);
  const requiredDailyPoints = availableDays ? Math.ceil(points / availableDays) : 0;
  return {
    availableDays,
    requiredDailyPoints,
    requiredDailyHours: Math.ceil((requiredDailyPoints / 2) * 2) / 2,
    feasible: Boolean(availableDays),
  };
}

export const TOPIC_SIZES = { SMALL: 'small', MEDIUM: 'medium', BIG: 'big' };
export const TOPIC_POINTS = { small: 1, medium: 2, big: 4 };

export function effectiveSize(topic, chapter) {
  if (topic && topic.size) return String(topic.size).toLowerCase();
  const diff = chapter ? String(chapter.diff || chapter.difficulty || '').toLowerCase() : '';
  if (diff === 'hard' || diff === 'tough') return TOPIC_SIZES.BIG;
  if (diff === 'easy') return TOPIC_SIZES.SMALL;
  return TOPIC_SIZES.MEDIUM;
}

export function effortPoints(topic, chapter) {
  return TOPIC_POINTS[effectiveSize(topic, chapter)] || 2;
}

export function distributeByPoints({
  items = [],
  startDate = new Date(),
  dailyPoints = 6,
  restDay = -1,
  restDays = [],
  offDates = [],
} = {}) {
  const offSet = new Set(offDates);
  const schedule = {};
  let date = addDays(startDate, 0);
  let pointsForDay = 0;
  const restSet = new Set(normalizeRestDays(restDays, restDay));

  items.forEach((item) => {
    while (restSet.has(date.getDay()) || offSet.has(formatDate(date))) {
      date = addDays(date, 1);
      pointsForDay = 0;
    }

    const weight = Number(item.points) || effortPoints(item.topic, item.chapter);
    const key = formatDate(date);

    if (pointsForDay > 0 && pointsForDay + weight > dailyPoints) {
      do { date = addDays(date, 1); } while (restSet.has(date.getDay()) || offSet.has(formatDate(date)));
      pointsForDay = 0;
    }

    const dayKey = formatDate(date);
    schedule[dayKey] ||= [];
    schedule[dayKey].push(item);
    pointsForDay += weight;
  });

  return schedule;
}
