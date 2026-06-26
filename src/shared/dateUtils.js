const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function toDate(value) {
  if (value instanceof Date) return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  if (typeof value === 'string' && DATE_RE.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatDate(value = new Date()) {
  const date = toDate(value);
  if (!date) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function addDays(value, days) {
  const date = toDate(value);
  if (!date) return null;
  date.setDate(date.getDate() + Number(days || 0));
  return date;
}

export function daysBetween(start, end) {
  const a = toDate(start);
  const b = toDate(end);
  if (!a || !b) return 0;
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((b - a) / msPerDay);
}

export function isSameDate(a, b) {
  return formatDate(a) === formatDate(b);
}

export function clampDate(value, min, max) {
  const date = toDate(value);
  const minDate = min ? toDate(min) : null;
  const maxDate = max ? toDate(max) : null;
  if (!date) return minDate || maxDate || null;
  if (minDate && date < minDate) return minDate;
  if (maxDate && date > maxDate) return maxDate;
  return date;
}
