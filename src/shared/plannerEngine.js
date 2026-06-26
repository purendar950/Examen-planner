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
