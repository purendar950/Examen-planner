/*
 * PrepPath — v5 Dashboard builders (interactive single-message Telegram dashboards)
 * ─────────────────────────────────────────────────────────────────────────────
 * New helpers for the redesigned morning/evening dashboards.
 * These complement (not replace) telegram-lib.js.
 *
 * Exports:
 *   sendTelegramMessageWithKeyboard, editTelegramMessage, answerCallbackQuery,
 *   morningKeyboard, eveningKeyboard,
 *   buildMorningDashboard, buildEveningDashboard,
 *   calculateStreak, findWeakArea, deriveFocus, getTopPriorities
 * ─────────────────────────────────────────────────────────────────────────────
 */

const {
  todayIST, shiftDate, fmtDM, fmtShort, escHtml,
  buildTaskSections, todayTotalTasks,
  progressBar, subjectEmoji, sectionHeader,
  boxTop, boxBottom, boxMid,
  capTaskLines, sleep,
} = require('./telegram-lib');

/* ================================================================
   TELEGRAM API HELPERS
   ================================================================ */

/** Send a message via Telegram Bot API with inline keyboard.
 *  Throws with .skip = true for blocked/bad chat. */
async function sendTelegramMessageWithKeyboard(botToken, chatId, text, replyMarkup) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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

/** Edit an existing Telegram message (text + inline keyboard).
 *  Returns the API result on success.
 *  Returns { stale: true } if message is too old to edit.
 *  Throws with .skip=true for blocked chats. */
async function editTelegramMessage(botToken, chatId, messageId, text, replyMarkup) {
  const url = `https://api.telegram.org/bot${botToken}/editMessageText`;
  const body = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    const desc = data.description || 'Unknown Telegram error';
    if (desc.includes('message to edit not found') || desc.includes('message can\'t be edited')) {
      return { stale: true, description: desc };
    }
    if (data.error_code === 403 || (data.error_code === 400 && desc.includes('chat not found'))) {
      throw Object.assign(new Error(desc), { skip: true });
    }
    throw new Error(`Telegram API error ${data.error_code}: ${desc}`);
  }
  return data.result;
}

/** Answer a Telegram callback query (stops the loading spinner on the button). */
async function answerCallbackQuery(botToken, callbackQueryId, text, showAlert) {
  const url = `https://api.telegram.org/bot${botToken}/answerCallbackQuery`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text: text || '',
      show_alert: !!showAlert,
    }),
  }).catch(() => {});
}

/* ================================================================
   INLINE KEYBOARDS
   ================================================================ */

/** Build the inline keyboard for morning dashboard navigation. */
function morningKeyboard(dateStr) {
  return {
    inline_keyboard: [
      [
        { text: '\u25C0\uFE0F PREV', callback_data: `pm:prev:${dateStr}` },
        { text: 'TODAY', callback_data: `pm:today:${dateStr}` },
        { text: 'NEXT \u25B6\uFE0F', callback_data: `pm:next:${dateStr}` },
      ],
      [
        { text: '\uD83D\uDCD6 OPEN PLANNER', url: 'https://examzen.in' },
      ],
    ],
  };
}

/** Build the inline keyboard for evening dashboard navigation + actions. */
function eveningKeyboard(dateStr) {
  return {
    inline_keyboard: [
      [
        { text: '\u25C0\uFE0F PREV', callback_data: `pe:prev:${dateStr}` },
        { text: 'TODAY', callback_data: `pe:today:${dateStr}` },
        { text: 'NEXT \u25B6\uFE0F', callback_data: `pe:next:${dateStr}` },
      ],
      [
        { text: '\uD83D\uDD25 FINISH NOW', callback_data: `pe:finish:${dateStr}` },
        { text: '\uD83D\uDCC5 MOVE TO TOMORROW', callback_data: `pe:move:${dateStr}` },
      ],
      [
        { text: '\uD83C\uDFE0 OPEN PLANNER', url: 'https://examzen.in' },
      ],
    ],
  };
}

/* ================================================================
   DATA HELPERS
   ================================================================ */

/** Calculate study streak from appState.streak or from completed task dates. */
function calculateStreak(appState) {
  /* If the app already stores streak, use it */
  if (appState && appState.streak && typeof appState.streak === 'number' && appState.streak > 0) {
    return appState.streak;
  }
  /* Fallback: count consecutive days with completed tasks ending at today/yesterday */
  const tasks = (appState && appState.tasks) || {};
  const today = todayIST();
  let streak = 0;
  let checkDate = today;
  /* If nothing done today, check from yesterday */
  const todayTasks = Array.isArray(tasks[today]) ? tasks[today] : [];
  const todayDone = todayTasks.some(t => t && (t.done === true || t.status === 'done'));
  if (!todayDone) {
    checkDate = shiftDate(today, -1);
  }
  for (let i = 0; i < 365; i++) {
    const dayTasks = Array.isArray(tasks[checkDate]) ? tasks[checkDate] : [];
    const hasDone = dayTasks.some(t => t && (t.done === true || t.status === 'done'));
    if (hasDone) {
      streak++;
      checkDate = shiftDate(checkDate, -1);
    } else {
      break;
    }
  }
  return streak;
}

/** Determine the weakest subject based on pending/overdue tasks.
 *  Returns { emoji, name, count } or null. */
function findWeakArea(todoLines) {
  const subjectCounts = {};
  for (const t of todoLines) {
    const raw = t.rawText || '';
    const emoji = subjectEmoji(raw);
    if (emoji && emoji !== '\u27A4') {
      subjectCounts[emoji] = (subjectCounts[emoji] || 0) + 1;
    }
  }
  let maxEmoji = '';
  let maxCount = 0;
  for (const [emoji, count] of Object.entries(subjectCounts)) {
    if (count > maxCount) {
      maxCount = count;
      maxEmoji = emoji;
    }
  }
  if (!maxEmoji) return null;
  /* Find a representative task text for that subject */
  const repTask = todoLines.find(t => subjectEmoji(t.rawText || '') === maxEmoji);
  const raw = repTask ? repTask.rawText : '';
  let subjectName = raw.length > 40 ? raw.slice(0, 40) + '...' : raw;
  return { emoji: maxEmoji, name: subjectName, count: maxCount };
}

/** Derive today's focus from the first high-priority or overdue task. */
function deriveFocus(todoLines, topicDigest) {
  if (topicDigest && topicDigest.trim()) {
    const first = topicDigest.trim().split('\n')[0].trim();
    if (first) return first;
  }
  const overdue = todoLines.find(t => t.overdue);
  if (overdue) return overdue.rawText || 'Review pending tasks';
  if (todoLines.length > 0) return todoLines[0].rawText || 'Complete your tasks';
  return 'No tasks scheduled';
}

/** Get top 3 priority tasks (overdue first, then pending). */
function getTopPriorities(todoLines) {
  const overdue = todoLines.filter(t => t.overdue);
  const pending = todoLines.filter(t => !t.overdue);
  const combined = overdue.concat(pending).slice(0, 3);
  return combined;
}

/** Convert the subject icon into a compact, stable group label. */
function subjectLabel(emoji, fallbackText) {
  const labels = {
    '\u2696\uFE0F': 'POLITY',
    '\u{1F30D}': 'GEOGRAPHY',
    '\u{1F9EE}': 'MATHS',
    '\u{1F9E0}': 'REASONING',
    '\u{1F4D6}': 'ENGLISH',
    '\u{1F4B0}': 'ECONOMICS',
    '\u{1F3DB}\uFE0F': 'HISTORY',
    '\u{1F52C}': 'SCIENCE',
    '\u{1F4F0}': 'CURRENT AFFAIRS',
    '\u2753': 'GENERAL KNOWLEDGE',
    '\u270D\uFE0F': 'WRITING',
    '\u{1F4DD}': 'PRACTICE',
    '\u{1F504}': 'REVISION',
    '\u{1F3AC}': 'VIDEOS',
    '\u{1F4CA}': 'DATA INTERPRETATION',
    '\u27A4': 'TASKS',
  };
  if (labels[emoji]) return labels[emoji];
  return String(fallbackText || 'Tasks').trim().split(/\s+/).slice(0, 3).join(' ').toUpperCase();
}

/** Group tasks by subject for the study plan section.
 *  Returns an array of { emoji, subject, tasks: string[] }. */
function groupTasksBySubject(todoLines) {
  const groups = {};
  for (const t of todoLines) {
    if (t.overdue) continue; // overdue shown separately
    const raw = t.rawText || 'Other';
    const emoji = subjectEmoji(raw) || '\u27A4';
    const key = emoji;
    if (!groups[key]) groups[key] = { emoji, subject: subjectLabel(emoji, raw), tasks: [] };
    groups[key].tasks.push(t.line);
  }
  return Object.values(groups);
}

/* ================================================================
   MORNING DASHBOARD BUILDER
   ================================================================ */

/** Build the complete morning dashboard HTML message.
 *  Returns { text, hasContent }. */
function buildMorningDashboard(name, appState, topicDigest, dateStr) {
  const { todoLines, videoItems, doneCount } = buildTaskSections(appState, dateStr);
  /* todayTotalTasks counts ALL non-video tasks (done + pending), so it IS the total.
     doneCount from buildTaskSections is the subset that are done. */
  const total = todayTotalTasks(appState, dateStr);
  const todayPending = todoLines.filter(t => !t.overdue).length;
  const overdueCount = todoLines.filter(t => t.overdue).length;
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;
  const hasContent = (topicDigest && topicDigest.trim()) || todoLines.length || videoItems.length;
  const streak = calculateStreak(appState);
  const focus = deriveFocus(todoLines, topicDigest);
  const weakArea = findWeakArea(todoLines);
  const priorities = getTopPriorities(todoLines);

  /* Format date for header */
  const dateLabel = fmtShort(dateStr).toUpperCase();
  const focusEmoji = subjectEmoji(focus);

  const L = [];

  if (!hasContent) {
    L.push(boxTop());
    L.push(`        \u2600\uFE0F MORNING MISSION`);
    L.push(`        ${dateLabel}`);
    L.push(boxMid());
    L.push(`\uD83C\uDFAF TODAY'S FOCUS`);
    L.push(`No plan scheduled today`);
    L.push('');
    L.push(`\uD83D\uDCCA PROGRESS`);
    L.push(`No tasks tracked`);
    L.push('');
    L.push(`\uD83D\uDD25 STUDY STREAK: ${streak} DAYS`);
    L.push(boxBottom());
    return { text: L.join('\n'), hasContent: false };
  }

  /* ── FULL DASHBOARD ── */
  L.push(boxTop());
  L.push(`        \u2600\uFE0F MORNING MISSION`);
  L.push(`        ${dateLabel}`);
  L.push(boxMid());

  /* TODAY'S FOCUS */
  L.push(`\uD83C\uDFAF TODAY'S FOCUS`);
  L.push(`${focusEmoji} ${escHtml(focus.length > 50 ? focus.slice(0, 50) + '...' : focus)}`);
  L.push('');

  /* PROGRESS */
  L.push(`\uD83D\uDCCA PROGRESS`);
  if (total > 0) {
    L.push(progressBar(doneCount, total, 10));
    L.push(`${doneCount} / ${total} tasks completed`);
  } else {
    L.push('No tasks tracked');
  }
  L.push('');

  /* TOP PRIORITIES */
  if (priorities.length > 0) {
    L.push(`\uD83D\uDD25 TOP PRIORITIES`);
    const circledNums = ['\u2460', '\u2461', '\u2462'];
    priorities.forEach((t, i) => {
      const num = circledNums[i] || `${i + 1}`;
      const emoji = subjectEmoji(t.rawText || '');
      const raw = t.rawText || 'Task';
      L.push(`${num} ${emoji} ${escHtml(raw.length > 35 ? raw.slice(0, 35) + '...' : raw)}`);
    });
    L.push('');
  }

  /* STUDY PLAN — group tasks by subject */
  const todayTasks = todoLines.filter(t => !t.overdue);
  const overdueTasks = todoLines.filter(t => t.overdue);
  const subjectGroups = groupTasksBySubject(todayTasks);

  if (subjectGroups.length > 0 || (topicDigest && topicDigest.trim())) {
    L.push(`\uD83D\uDCDA STUDY PLAN`);
    L.push('');

    /* Topic digest lines (from the plan schedule) */
    if (topicDigest && topicDigest.trim()) {
      const topicLines = topicDigest.trim().split('\n').filter(l => l.trim());
      /* Show up to 3 digest lines */
      topicLines.slice(0, 3).forEach(line => {
        const emoji = subjectEmoji(line);
        L.push(`${emoji} ${escHtml(line)}`);
      });
      if (topicLines.length > 3) {
        L.push(`  <i>...+${topicLines.length - 3} more topics</i>`);
      }
      L.push('');
    }

    /* Task groups by subject */
    subjectGroups.forEach(g => {
      L.push(`${g.emoji} ${g.subject || 'TASKS'}`);
      g.tasks.slice(0, 4).forEach(t => {
        L.push(`  ${t}`);
      });
      if (g.tasks.length > 4) {
        L.push(`  <i>...+${g.tasks.length - 4} more</i>`);
      }
      L.push('');
    });
  }

  /* VIDEOS */
  if (videoItems.length > 0) {
    L.push(`\uD83C\uDFAC VIDEOS`);
    videoItems.slice(0, 4).forEach(v => {
      const emoji = '\u{1F3AC}';
      L.push(`  \u25B6 ${emoji} <a href="${v.url}">${escHtml(v.title.length > 40 ? v.title.slice(0, 40) + '...' : v.title)}</a>`);
    });
    if (videoItems.length > 4) {
      L.push(`  <i>...+${videoItems.length - 4} more</i>`);
    }
    L.push('');
  }

  /* WEAK AREA */
  if (weakArea) {
    L.push(`\u26A0\uFE0F WEAK AREA`);
    L.push(`${weakArea.emoji} ${escHtml(weakArea.name)} — ${weakArea.count} pending`);
    L.push('');
  }

  /* STREAK */
  L.push(`\uD83D\uDD25 STUDY STREAK: ${streak} DAYS`);
  L.push(boxBottom());

  return { text: L.join('\n'), hasContent: true };
}

/* ================================================================
   EVENING DASHBOARD BUILDER
   ================================================================ */

/** Build the complete evening dashboard HTML message.
 *  Returns { text, hasContent }. */
function buildEveningDashboard(name, appState, dateStr) {
  const { todoLines, videoItems, doneCount } = buildTaskSections(appState, dateStr);
  /* todayTotalTasks counts ALL non-video tasks (done + pending), so it IS the total.
     doneCount from buildTaskSections is the subset that are done. */
  const total = todayTotalTasks(appState, dateStr);
  const pending = todoLines.length > 0 || videoItems.length > 0;
  const todayPending = todoLines.filter(t => !t.overdue).length;
  const overdueCount = todoLines.filter(t => t.overdue).length;
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;
  const streak = calculateStreak(appState);
  const weakArea = findWeakArea(todoLines);

  const dateLabel = fmtShort(dateStr).toUpperCase();
  const L = [];

  if (!pending && doneCount === 0) {
    return { text: '', hasContent: false };
  }

  L.push(boxTop());
  L.push(`         \uD83C\uDF19 DAILY AUDIT`);
  L.push(`        ${dateLabel}`);
  L.push(boxMid());

  /* TODAY'S PERFORMANCE */
  L.push(`\uD83D\uDCCA TODAY'S PERFORMANCE`);
  L.push('');
  if (total > 0) {
    L.push(progressBar(doneCount, total, 10));
    L.push('');
    L.push(`\u2705 Completed       ${doneCount}`);
    L.push(`\u25CB Pending          ${todayPending}`);
    L.push(`\u26A0\uFE0F Overdue         ${overdueCount}`);
  } else {
    L.push('No tracked tasks today');
  }
  L.push('');

  /* STILL PENDING */
  const todayTasks = todoLines.filter(t => !t.overdue);
  if (todayTasks.length > 0) {
    L.push(`\u26A0\uFE0F STILL PENDING`);
    L.push(capTaskLines(todayTasks, 5));
    L.push('');
  }

  /* OVERDUE */
  const overdueTasks = todoLines.filter(t => t.overdue);
  if (overdueTasks.length > 0) {
    L.push(`\uD83D\uDD34 OVERDUE`);
    L.push(capTaskLines(overdueTasks, 3));
    L.push('');
  }

  /* ALL DONE celebration */
  if (!pending && doneCount > 0) {
    L.push(`\u2728 ALL TASKS DONE!`);
    L.push(`\uD83C\uDF89 ${doneCount}/${total} completed — shabash!`);
    L.push('');
  }

  /* VIDEOS PENDING */
  if (videoItems.length > 0) {
    L.push(`\uD83C\uDFAC VIDEOS PENDING`);
    videoItems.slice(0, 3).forEach(v => {
      const emoji = '\u{1F3AC}';
      L.push(`  \u25B6 ${emoji} <a href="${v.url}">${escHtml(v.title.length > 40 ? v.title.slice(0, 40) + '...' : v.title)}</a>`);
    });
    if (videoItems.length > 3) {
      L.push(`  <i>...+${videoItems.length - 3} more</i>`);
    }
    L.push('');
  }

  /* WEAK AREA */
  if (weakArea) {
    L.push(`\uD83D\uDCC8 WEAK AREA`);
    L.push(`${weakArea.emoji} ${escHtml(weakArea.name)}`);
    L.push('');
  }

  /* TOMORROW PREVIEW */
  const tomorrow = shiftDate(dateStr, 1);
  const tomorrowTasks = appState && appState.tasks && Array.isArray(appState.tasks[tomorrow])
    ? appState.tasks[tomorrow].filter(t => t && !t.done && t.status !== 'done')
    : [];
  if (tomorrowTasks.length > 0) {
    L.push(`\uD83D\uDD2E TOMORROW`);
    tomorrowTasks.slice(0, 4).forEach(t => {
      const raw = t.text || 'Task';
      const emoji = subjectEmoji(raw);
      L.push(`${emoji} ${escHtml(raw.length > 40 ? raw.slice(0, 40) + '...' : raw)}`);
    });
    if (tomorrowTasks.length > 4) {
      L.push(`  <i>...+${tomorrowTasks.length - 4} more</i>`);
    }
    L.push('');
  }

  /* DAY SCORE + STREAK */
  if (total > 0) {
    L.push(`\uD83D\uDD25 DAY SCORE: ${doneCount} / ${total}`);
  }
  L.push(`\uD83D\uDD25 STREAK: ${streak} DAYS`);
  L.push(boxBottom());

  return { text: L.join('\n'), hasContent: true };
}

/* ================================================================
   PRIORITY HELPER
   ================================================================ */

/** Simple priority helper for tasks.
 *  HIGH: overdue or explicitly marked high.
 *  MEDIUM: normal scheduled task.
 *  LOW: optional/revision task.
 *  Reuses existing priority field if available. */
function taskPriority(task) {
  if (!task) return 'medium';
  if (task.overdue) return 'high';
  if (task.priority === 'high' || task.priority === 'HIGH') return 'high';
  if (task.priority === 'low' || task.priority === 'LOW') return 'low';
  /* Detect revision tasks as lower priority */
  const text = (task.text || task.rawText || '').toLowerCase();
  if (/revision|revise|review|re-read/i.test(text)) return 'low';
  return 'medium';
}

module.exports = {
  sendTelegramMessageWithKeyboard,
  editTelegramMessage,
  answerCallbackQuery,
  morningKeyboard,
  eveningKeyboard,
  buildMorningDashboard,
  buildEveningDashboard,
  calculateStreak,
  findWeakArea,
  deriveFocus,
  getTopPriorities,
  groupTasksBySubject,
  taskPriority,
};
