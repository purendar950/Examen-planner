/* Telegram Dashboard v6 presentation patch.
 * Loaded before the existing senders so we can improve presentation without
 * changing their data/Firestore logic.
 */
const lib = require('./telegram-lib');

const SUBJECT_EMOJIS = [
  [/polity|constitution|article|fundamental|dp|amendment|parliament|supreme court|high court|judiciary|laxmikanth|preamble/i, '⚖️'],
  [/geography|climate|map|river|mountain|ocean|soil|monsoon|latitud|longitude|earthquake|volcano/i, '🌍'],
  [/math|calcul|number|algebra|geometry|trigon|profit|loss|percent|speed|time.*work|interest|simplif|averag|ratio|proportion|lcm|hcf|mensur/i, '🧮'],
  [/reason|syllog|coding|decod|seri|analog|blood relat|direc|dice|calendar|rank|puzzle|mirror|water/i, '🧠'],
  [/english|gram|vocab|comprehen|cloze|error|spot|fill|phras|idiom|synonym|antonym|passage|sentence/i, '📖'],
  [/econom|budget|plan|gdp|inflat|tax|market|bank|rbi|sebi|supply|demand|niti|five year/i, '💰'],
  [/histor|mughal|british|ancient|medieval|modern|freedom|independ|guerilla|dynasty|empire|sultanate|vijay|chola|pallava/i, '🏛️'],
  [/science|physics|chemistry|biolog|botan|zoolog|cell|atom|gravit|element|reaction|geneti|evolut|digest/i, '🔬'],
  [/current affair|news|event|award|appointment|sport|summit|index|report|committee|mission|scheme|yojana/i, '📰'],
  [/gk|general know|static|national|capital|currenc|symbol|festival|dance|river/i, '❓'],
  [/essay|writ|letter|précis|comprehension|draft/i, '✍️'],
  [/mock|test|practice|solve|attempt|question|quiz|mcq|previous year|pyq/i, '📝'],
  [/revision|revise|review|re-read|doobara/i, '🔄'],
  [/video|lecture|watch|see|youtube|class/i, '🎬'],
  [/di|data interpret|chart|graph|table/i, '📊'],
];

lib.subjectEmoji = function subjectEmojiV6(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return '';
  for (const [pattern, emoji] of SUBJECT_EMOJIS) {
    if (pattern.test(t)) return emoji;
  }
  return '➜';
};

const dashboard = require('./telegram-dashboard');

/* The Telegram report is intentionally read-only. */
dashboard.morningKeyboard = () => undefined;
dashboard.eveningKeyboard = () => undefined;

function polish(text) {
  if (!text) return text;
  return text
    .replace(/MORNING MISSION/g, 'GOOD MORNING')
    .replace(/DAILY AUDIT/g, 'DAILY REVIEW')
    .replace(/TODAY'S PERFORMANCE/g, "TODAY'S RESULT")
    .replace(/STILL PENDING/g, 'NOT COMPLETED')
    .replace(/DAY SCORE:/g, 'TODAY:')
    .replace(/\n{3,}/g, '\n\n');
}

const originalMorning = dashboard.buildMorningDashboard;
const originalEvening = dashboard.buildEveningDashboard;
dashboard.buildMorningDashboard = (...args) => {
  const result = originalMorning(...args);
  result.text = polish(result.text);
  return result;
};
dashboard.buildEveningDashboard = (...args) => {
  const result = originalEvening(...args);
  result.text = polish(result.text);
  return result;
};
