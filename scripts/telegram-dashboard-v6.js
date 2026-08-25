/*
 * Telegram Dashboard v6 — professional, read-only study command center.
 * No inline navigation or task-action buttons.
 */
const { buildTaskSections, todayTotalTasks, progressBar, fmtShort, escHtml, shiftDate } = require('./telegram-lib');

async function sendTelegramMessageWithKeyboard(botToken, chatId, text) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    const desc = data.description || 'Unknown Telegram error';
    if (data.error_code === 403 || (data.error_code === 400 && desc.includes('chat not found'))) {
      throw Object.assign(new Error(desc), { skip: true });
    }
    throw new Error(`Telegram API error ${data.error_code}: ${desc}`);
  }
  return data.result;
}

function morningKeyboard() { return null; }
function eveningKeyboard() { return null; }

function subjectEmoji(text) {
  const t = String(text || '').toLowerCase();
  if (/polity|constitution|article|fundamental|amendment|parliament|supreme court|judiciary|laxmikanth|preamble/.test(t)) return '⚖️';
  if (/geography|climate|map|river|mountain|ocean|soil|monsoon|latitude|longitude|earthquake|volcano/.test(t)) return '🌍';
  if (/math|calcul|number|algebra|geometry|trigon|profit|loss|percent|speed|time.*work|interest|simplif|averag|ratio|proportion|lcm|hcf|mensur/.test(t)) return '🧮';
  if (/reason|syllog|coding|decod|seri|analog|blood relat|direc|dice|calendar|rank|puzzle|mirror|water/.test(t)) return '🧠';
  if (/english|gram|vocab|comprehen|cloze|error|spot|fill|phras|idiom|synonym|antonym|passage|sentence/.test(t)) return '📖';
  if (/econom|budget|gdp|inflat|tax|market|bank|rbi|sebi|supply|demand|niti|five year/.test(t)) return '💰';
  if (/histor|mughal|british|ancient|medieval|modern|freedom|independ|guerilla|dynasty|empire|sultanate|vijay/.test(t)) return '🏛️';
  if (/science|physics|chemistry|biolog|botan|zoolog|cell|atom|gravit|element|reaction|geneti|evolut|digest/.test(t)) return '🔬';
  if (/current affair|news|event|award|appointment|sport|summit|index|report|committee|mission|scheme|yojana/.test(t)) return '📰';
  if (/gk|general know|static|national|capital|currenc|symbol|festival|dance/.test(t)) return '❓';
  if (/essay|writ|letter|précis|comprehension|draft/.test(t)) return '✍️';
  if (/mock|test|practice|solve|attempt|question|quiz|mcq|previous year|pyq/.test(t)) return '📝';
  if (/revision|revise|review|re-read|doobara/.test(t)) return '🔄';
  if (/video|lecture|watch|see|youtube|class/.test(t)) return '🎬';
  if (/di|data interpret|chart|graph|table/.test(t)) return '📊';
  return '•';
}

function calculateStreak(appState) {
  if (appState && typeof appState.streak === 'number' && appState.streak > 0) return appState.streak;
  const tasks = (appState && appState.tasks) || {};
  let date = new Date();
  const iso = d => d.toISOString().slice(0, 10);
  let today = iso(date);
  let todayDone = (tasks[today] || []).some(t => t && (t.done === true || t.status === 'done'));
  if (!todayDone) date.setUTCDate(date.getUTCDate() - 1);
  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const ds = iso(date);
    if (!(tasks[ds] || []).some(t => t && (t.done === true || t.status === 'done'))) break;
    streak++;
    date.setUTCDate(date.getUTCDate() - 1);
  }
  return streak;
}

function weakArea(todoLines) {
  const counts = new Map();
  for (const t of todoLines) {
    const e = subjectEmoji(t.rawText || '');
    if (e !== '•') counts.set(e, (counts.get(e) || 0) + 1);
  }
  let best = null;
  for (const [emoji, count] of counts) if (!best || count > best.count) best = { emoji, count };
  if (!best) return null;
  const rep = todoLines.find(t => subjectEmoji(t.rawText || '') === best.emoji);
  return { ...best, name: rep ? rep.rawText || 'Study area' : 'Study area' };
}

function buildMorningDashboard(name, appState, topicDigest, dateStr) {
  const { todoLines, videoItems, doneCount } = buildTaskSections(appState, dateStr);
  const total = todayTotalTasks(appState, dateStr);
  const pending = todoLines.filter(t => !t.overdue);
  const overdue = todoLines.filter(t => t.overdue);
  const streak = calculateStreak(appState);
  const focus = topicDigest && topicDigest.trim() ? topicDigest.trim().split('\n')[0] : (pending[0]?.rawText || overdue[0]?.rawText || 'No tasks scheduled');
  const priorities = [...overdue, ...pending].slice(0, 3);
  const weak = weakArea(todoLines);
  const L = [];

  L.push(`<b>☀️ GOOD MORNING${name && name !== 'there' ? `, ${escHtml(name.toUpperCase())}` : ''}</b>`);
  L.push(`<i>${fmtShort(dateStr).toUpperCase()}</i>`);
  L.push('━━━━━━━━━━━━━━━━━━━━');
  L.push('<b>🎯 TODAY’S FOCUS</b>');
  L.push(`${subjectEmoji(focus)} ${escHtml(focus.length > 80 ? focus.slice(0, 80) + '…' : focus)}`);
  L.push('');
  L.push('<b>📊 PROGRESS</b>');
  L.push(total ? `${progressBar(doneCount, total, 12)}\n<b>${doneCount}</b> completed  •  <b>${total - doneCount}</b> pending` : 'No tasks tracked today');
  L.push(`🔥 <b>${streak} day study streak</b>`);
  L.push('');

  if (priorities.length) {
    L.push('<b>🔥 TOP PRIORITIES</b>');
    priorities.forEach((t, i) => {
      const raw = t.rawText || 'Task';
      L.push(`${['①','②','③'][i] || `${i + 1}.`} ${subjectEmoji(raw)} ${escHtml(raw.length > 65 ? raw.slice(0, 65) + '…' : raw)}`);
    });
    L.push('');
  }

  if ((topicDigest && topicDigest.trim()) || pending.length || overdue.length) {
    L.push('<b>📚 STUDY PLAN</b>');
    if (topicDigest && topicDigest.trim()) {
      topicDigest.trim().split('\n').filter(Boolean).slice(0, 4).forEach(line => L.push(`${subjectEmoji(line)} ${escHtml(line)}`));
    }
    pending.slice(0, 6).forEach(t => {
      const raw = t.rawText || 'Task';
      L.push(`○ ${subjectEmoji(raw)} ${escHtml(raw.length > 70 ? raw.slice(0, 70) + '…' : raw)}`);
    });
    if (pending.length > 6) L.push(`<i>…+${pending.length - 6} more tasks</i>`);
    if (overdue.length) L.push(`⚠️ <b>ROLLED OVER</b>  ${overdue.length} task${overdue.length === 1 ? '' : 's'}`);
    L.push('');
  }

  if (videoItems.length) {
    L.push('<b>🎬 VIDEOS</b>');
    videoItems.slice(0, 4).forEach(v => L.push(`▶️ <a href="${v.url}">${escHtml(v.title.length > 70 ? v.title.slice(0, 70) + '…' : v.title)}</a>`));
    if (videoItems.length > 4) L.push(`<i>…+${videoItems.length - 4} more</i>`);
    L.push('');
  }

  if (weak) {
    L.push('<b>⚠️ NEEDS ATTENTION</b>');
    L.push(`${weak.emoji} ${escHtml(weak.name.length > 65 ? weak.name.slice(0, 65) + '…' : weak.name)}  •  ${weak.count} pending`);
    L.push('');
  }
  L.push('━━━━━━━━━━━━━━━━━━━━');
  L.push(`🔥 <b>STUDY STREAK: ${streak} DAYS</b>`);
  return { text: L.join('\n'), hasContent: true };
}

function buildEveningDashboard(name, appState, dateStr) {
  const { todoLines, videoItems, doneCount } = buildTaskSections(appState, dateStr);
  const tasks = appState && appState.tasks && Array.isArray(appState.tasks[dateStr]) ? appState.tasks[dateStr] : [];
  const total = todayTotalTasks(appState, dateStr);
  const pending = todoLines.filter(t => !t.overdue);
  const overdue = todoLines.filter(t => t.overdue);
  const completed = tasks.filter(t => t && (t.done === true || t.status === 'done'));
  const streak = calculateStreak(appState);
  const weak = weakArea(todoLines);
  const pct = total ? Math.round(doneCount / total * 100) : 0;
  const L = [];
  if (!total && !pending.length && !overdue.length && !videoItems.length) return { text: '', hasContent: false };

  L.push(`<b>🌙 DAILY REVIEW${name && name !== 'there' ? `, ${escHtml(name.toUpperCase())}` : ''}</b>`);
  L.push(`<i>${fmtShort(dateStr).toUpperCase()}</i>`);
  L.push('━━━━━━━━━━━━━━━━━━━━');
  L.push('<b>🏆 TODAY’S RESULT</b>');
  L.push(total ? `${progressBar(doneCount, total, 12)}\n<b>${doneCount}/${total}</b> tasks completed  •  <b>${pct}%</b>` : 'No tracked tasks today');
  L.push(`🔥 <b>${streak} day study streak</b>`);
  L.push('');

  if (completed.length) {
    L.push(`<b>✅ COMPLETED</b>  <i>${completed.length}</i>`);
    completed.slice(0, 6).forEach(t => {
      const raw = t.text || 'Task';
      L.push(`✓ ${subjectEmoji(raw)} ${escHtml(raw.length > 70 ? raw.slice(0, 70) + '…' : raw)}`);
    });
    if (completed.length > 6) L.push(`<i>…+${completed.length - 6} more</i>`);
    L.push('');
  }

  if (pending.length) {
    L.push(`<b>⏳ STILL PENDING</b>  <i>${pending.length}</i>`);
    pending.slice(0, 6).forEach(t => {
      const raw = t.rawText || 'Task';
      L.push(`○ ${subjectEmoji(raw)} ${escHtml(raw.length > 70 ? raw.slice(0, 70) + '…' : raw)}`);
    });
    if (pending.length > 6) L.push(`<i>…+${pending.length - 6} more</i>`);
    L.push('');
  }

  if (overdue.length) {
    L.push(`<b>⚠️ ROLLED OVER</b>  <i>${overdue.length}</i>`);
    overdue.slice(0, 4).forEach(t => {
      const raw = t.rawText || 'Task';
      L.push(`↻ ${subjectEmoji(raw)} ${escHtml(raw.length > 70 ? raw.slice(0, 70) + '…' : raw)}`);
    });
    L.push('');
  }

  if (videoItems.length) {
    L.push('<b>🎬 VIDEOS</b>');
    videoItems.slice(0, 3).forEach(v => L.push(`▶️ <a href="${v.url}">${escHtml(v.title.length > 70 ? v.title.slice(0, 70) + '…' : v.title)}</a>`));
    L.push('');
  }

  if (weak) {
    L.push('<b>⚠️ NEEDS ATTENTION</b>');
    L.push(`${weak.emoji} ${escHtml(weak.name.length > 65 ? weak.name.slice(0, 65) + '…' : weak.name)}  •  ${weak.count} pending`);
    L.push('');
  }

  const insight = pct >= 100 ? 'Excellent finish. Keep the streak going.' : pct >= 70 ? 'Good progress. Clear the remaining items tomorrow.' : pct >= 40 ? 'Decent progress. Protect your first study block tomorrow.' : 'Low completion today. Start tomorrow with the highest-priority task.';
  L.push('<b>🧠 TODAY’S INSIGHT</b>');
  L.push(insight);
  L.push('━━━━━━━━━━━━━━━━━━━━');
  return { text: L.join('\n'), hasContent: true };
}

module.exports = {
  sendTelegramMessageWithKeyboard,
  morningKeyboard,
  eveningKeyboard,
  buildMorningDashboard,
  buildEveningDashboard,
};
