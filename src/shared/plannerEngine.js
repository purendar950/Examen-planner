import { addDays, formatDate } from './dateUtils.js';

export function distributeStudyItems({ items = [], startDate = new Date(), dailyLimit = 3, restDay = -1 } = {}) {
  const schedule = {};
  let date = addDays(startDate, 0);
  let countForDay = 0;

  items.forEach((item) => {
    while (restDay >= 0 && date.getDay() === Number(restDay)) {
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
  offDates = [],
} = {}) {
  const offSet = new Set(offDates);
  const schedule = {};
  let date = addDays(startDate, 0);
  let pointsForDay = 0;

  items.forEach((item) => {
    while (
      (restDay >= 0 && date.getDay() === Number(restDay)) ||
      offSet.has(formatDate(date))
    ) {
      date = addDays(date, 1);
      pointsForDay = 0;
    }

    const weight = Number(item.points) || effortPoints(item.topic, item.chapter);
    const key = formatDate(date);

    if (pointsForDay > 0 && pointsForDay + weight > dailyPoints) {
      do { date = addDays(date, 1); } while (
        (restDay >= 0 && date.getDay() === Number(restDay)) ||
        offSet.has(formatDate(date))
      );
      pointsForDay = 0;
    }

    const dayKey = formatDate(date);
    schedule[dayKey] ||= [];
    schedule[dayKey].push(item);
    pointsForDay += weight;
  });

  return schedule;
}
