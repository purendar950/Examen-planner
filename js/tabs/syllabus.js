/* ══════════════════════════════════════════════
   AI STUDY TIMETABLE GENERATOR
══════════════════════════════════════════════ */
function generateTimetable() {
  const examDate = appState.examDate || '2026-07-14';
  const today = new Date(); today.setHours(0,0,0,0);
  const target = new Date(examDate); target.setHours(0,0,0,0);
  const daysLeft = Math.max(1, Math.ceil((target - today) / 86400000));

  // Build remaining chapter queue interleaved by subject
  const subjects = getActiveSubjects();
  const remaining = subjects.map(sub => ({
    name: sub.name, color: sub.color,
    chapters: sub.chapters.filter(c => !appState.progress[c.id]?.done)
  })).filter(s => s.chapters.length > 0);

  const totalRemaining = remaining.reduce((t, s) => t + s.chapters.length, 0);
  const container = document.getElementById('timetable-container');

  if (totalRemaining === 0) {
    container.innerHTML = `<div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1.5rem;text-align:center;">
      <div style="font-size:2rem;margin-bottom:8px;">🎉</div>
      <div style="font-weight:700;color:var(--accent);font-size:1rem;">Sab chapters complete ho gaye!</div>
      <div style="font-size:0.82rem;color:var(--muted);margin-top:4px;">Ab revision mode on karo.</div>
    </div>`;
    return;
  }

  const chapPerDay  = Math.max(1, Math.ceil(totalRemaining / daysLeft));
  const daysToShow  = Math.min(daysLeft, 14);

  // Interleave chapters across subjects for variety
  const queue = [];
  const maxLen = Math.max(...remaining.map(s => s.chapters.length));
  for (let i = 0; i < maxLen; i++) {
    for (const sub of remaining) {
      if (i < sub.chapters.length) {
        queue.push({ ...sub.chapters[i], subName: sub.name, color: sub.color });
      }
    }
  }

  // Distribute into days
  const plan = []; let ptr = 0;
  for (let d = 0; d < daysToShow && ptr < queue.length; d++) {
    const date = new Date(today); date.setDate(today.getDate() + d);
    const dayChaps = queue.slice(ptr, ptr + chapPerDay); ptr += chapPerDay;
    const totalMins = dayChaps.reduce((t, ch) => t + (ch.diff==='Hard'?60:ch.diff==='Medium'?45:30), 0);
    plan.push({ date, chapters: dayChaps, totalMins });
  }

  const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const MON_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  container.innerHTML = `
    <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:0.75rem;color:var(--muted);margin-bottom:1rem;background:var(--surface);border-radius:8px;padding:0.65rem 0.85rem;">
      <span>📚 <strong style="color:var(--text)">${totalRemaining}</strong> chapters remaining</span>
      <span>📅 <strong style="color:var(--text)">${daysLeft}</strong> days left</span>
      <span>⚡ <strong style="color:var(--text)">${chapPerDay}</strong> chapters/day needed</span>
    </div>
    ${plan.map((day, i) => {
      const isToday    = i === 0;
      const isTomorrow = i === 1;
      const label      = isToday ? 'Today' : isTomorrow ? 'Tomorrow' : `${DAY_NAMES[day.date.getDay()]} ${day.date.getDate()} ${MON_NAMES[day.date.getMonth()]}`;
      const h = Math.floor(day.totalMins/60), m = day.totalMins%60;
      const timeStr = h > 0 ? `${h}h ${m}m` : `${m}m`;
      return `<div class="tt-day-card">
        <div class="tt-day-header">
          <span class="tt-day-label${isToday?' today':''}">${label}</span>
          <span class="tt-day-meta">⏱ ~${timeStr} · ${day.chapters.length} chapters</span>
        </div>
        <div style="padding:0.5rem 0;">
          ${day.chapters.map(ch => `
            <div class="tt-chapter-row">
              <div class="tt-dot" style="background:${ch.color};"></div>
              <span style="flex:1;">${escapeHtml(ch.name)}</span>
              <span style="font-size:0.65rem;color:var(--muted);margin-right:4px;">${ch.subName}</span>
              <span style="font-size:0.65rem;padding:1px 5px;border-radius:3px;background:var(--surface);color:var(--muted);">${ch.diff==='Hard'?'60m':ch.diff==='Medium'?'45m':'30m'}</span>
            </div>`).join('')}
        </div>
      </div>`;
    }).join('')}
    <div style="text-align:right;margin-top:0.5rem;">
      <button onclick="generateTimetable()" style="font-size:0.72rem;color:var(--muted);background:none;border:1px solid var(--border);border-radius:6px;padding:3px 10px;cursor:pointer;font-family:var(--font);">🔄 Regenerate</button>
    </div>`;
}
function buildSyllabus() {
  const container = document.getElementById('syllabus-list');
  // Apply lock UI after DOM is built so free users see locked checkboxes on non-target exams
  setTimeout(function() { try { ezApplySyllabusLockUI(); } catch(e) {} }, 80);
  container.innerHTML = '';

  // FIX 5: Show a locked-exam banner for free users on non-target exams
  // so they immediately understand why checkboxes are disabled.
  try {
    var _existBanner = document.getElementById('ez-syllabus-lock-banner');
    if (_existBanner) _existBanner.remove();
    if (typeof ezGated === 'function' && ezGated() && typeof EZ_PROFILE !== 'undefined' && EZ_PROFILE) {
      var _target = EZ_PROFILE.examTarget || null;
      if (_target && currentExam !== _target) {
        var _allExamsMap = (typeof ALL_EXAMS !== 'undefined') ? ALL_EXAMS : {};
        var _targetName = (_allExamsMap[_target] && _allExamsMap[_target].name) ? _allExamsMap[_target].name : _target.toUpperCase();
        var _banner = document.createElement('div');
        _banner.id = 'ez-syllabus-lock-banner';
        _banner.style.cssText = 'background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.25);border-radius:10px;padding:10px 14px;margin-bottom:14px;display:flex;align-items:center;gap:10px;font-size:0.82rem;color:var(--muted);';
        _banner.innerHTML = '<span style="font-size:1.1rem;">🔒</span>' +
          '<span>Free users sirf <strong style="color:var(--text);">' + _targetName + '</strong> mein topics mark kar sakte hain. ' +
          'Is exam ke liye <a href="#" onclick="ezOpenUpgrade();return false;" style="color:var(--accent);font-weight:700;">Pro upgrade karo</a>.</span>';
        container.parentNode.insertBefore(_banner, container);
      }
    }
  } catch(e) {}

  getActiveSubjects().forEach(sub => {
    const block = document.createElement('div');
    block.className = 'subject-block';
    block.id = 'sub-block-' + sub.id;

    const doneCount = sub.chapters.filter(c => appState.progress[c.id]?.done).length;
    const pct = sub.chapters.length > 0 ? Math.round(doneCount/sub.chapters.length*100) : 0;

    block.innerHTML = `
      <div class="subject-header" onclick="toggleSubject('${sub.id}')">
        <span class="subject-chevron" id="chev-${sub.id}">▼</span>
        <span style="font-size:1.1rem;">${subjectIcon(sub.id)}</span>
        <span class="subject-name">${sub.name}</span>
        <span class="subject-badge" id="badge-${sub.id}">${doneCount} / ${sub.chapters.length}</span>
      </div>
      <div class="subject-progress-bar" style="margin:0 1.25rem 0;"><div class="subject-progress-fill" style="width:${pct}%;background:${sub.color};" id="prog-${sub.id}"></div></div>
      <div class="chapter-list open" id="chlist-${sub.id}">
        ${sub.chapters.map(ch => buildChapterHTML(ch, sub)).join('')}
      </div>`;
    container.appendChild(block);
  });
}

function subjectIcon(id) {
  const icons = { reasoning:'🧩', ga:'🌏', quant:'🔢', english:'📖' };
  return icons[id] || '📚';
}

function buildChapterHTML(ch, sub) {
  const prog = appState.progress[ch.id] || {};
  const checked = prog.done || false;
  const bookmarked = prog.bookmarked || false;
  const diff = prog.difficulty || ch.diff || 'Easy';
  const diffClass = { Easy:'diff-easy', Medium:'diff-medium', Hard:'diff-hard' }[diff] || 'diff-easy';
  const revState = checked ? getRevisionState(ch.id) : null;
  const masteryPct = revState ? Math.min(100, (revState.mastery / 5) * 100) : 0;
  const dueToday = revState && revState.dueToday;

  return `
    <div class="chapter-item${checked?' completed':''}${dueToday?' rev-due':''}" id="chi-${ch.id}" data-subject="${sub.id}" data-done="${checked}" data-bookmarked="${bookmarked}">
      <div class="ch-checkbox${checked?' checked':''}" onclick="toggleChapter('${ch.id}','${sub.id}')" id="chk-${ch.id}">${checked?'✓':''}</div>
      <div class="ch-info">
        <div class="ch-name">${ch.name}${dueToday?'<span class="ch-rev-due-badge">DUE NOW</span>':''}</div>
        <div class="ch-sub">${ch.sub}</div>
        ${checked && revState ? `
          <div class="ch-mastery-row">
            <div class="ch-mastery-bar"><div class="ch-mastery-fill" style="width:${masteryPct}%;"></div></div>
            <div class="ch-mastery-lbl">${revState.mastery}/5</div>
          </div>` : ''}
      </div>
      <select class="difficulty-pill ${diffClass}" onchange="setDifficulty('${ch.id}',this)" id="diff-${ch.id}">
        <option value="Easy"${diff==='Easy'?' selected':''}>Easy</option>
        <option value="Medium"${diff==='Medium'?' selected':''}>Medium</option>
        <option value="Hard"${diff==='Hard'?' selected':''}>Hard</option>
      </select>
      <div class="ch-actions">
        ${checked ? `<button class="ch-revise-btn${dueToday?' due':''}" onclick="openReviseModal('${ch.id}')" title="${dueToday?'Revision due! Click to revise':'Click to mark as revised'}">🔁 Rev ${revState.revisionCount}</button>` : ''}
        <button class="ch-action-btn" onclick="toggleNotePanel('${ch.id}')" title="Notes">📄</button>
        <button class="ch-action-btn${bookmarked?' bookmarked':''}" onclick="toggleBookmark('${ch.id}','${sub.id}')" id="bkm-${ch.id}" title="Bookmark">${bookmarked?'🔖':'🔖'}</button>
        <button class="ch-yt-btn${appState.ytLinks&&appState.ytLinks[ch.id]?' has-link':''}" id="ytbtn-${ch.id}" onclick="chLinkOpen('${ch.id}','${ch.name.replace(/'/g,"\\'")}')" title="${appState.ytLinks&&appState.ytLinks[ch.id]?'YouTube link saved – click to edit or play':'Add YouTube link'}">▶</button>
      </div>
    </div>
    <div class="ch-notes-panel" id="notes-panel-${ch.id}">
      <textarea placeholder="Quick notes for ${ch.name}..." id="ch-note-txt-${ch.id}">${prog.note||''}</textarea>
      <div class="ch-notes-save">
        <button class="btn-sm green" onclick="saveChapterNote('${ch.id}')">Save Note</button>
      </div>
    </div>`;
}

function toggleSubject(subId) {
  const list = document.getElementById('chlist-' + subId);
  const chev = document.getElementById('chev-' + subId);
  const isOpen = list.classList.contains('open');
  list.classList.toggle('open', !isOpen);
  chev.classList.toggle('open', !isOpen);
}

function toggleChapter(chId, subId) {
  if (!appState.progress[chId]) appState.progress[chId] = {};
  const wasDone = appState.progress[chId].done;
  appState.progress[chId].done = !wasDone;
  _cachedRemainingCount = null; // invalidate countdown cache
  if (!wasDone) {
    appState.progress[chId].completedAt = new Date().toISOString();
    if (!appState.progress[chId].nextRevisionAt) {
      appState.progress[chId].nextRevisionAt = addDaysISO(new Date(), 1);
    }
    updateStreak();
    showToast('Chapter marked complete! 🎯 First revision: tomorrow', 'success');
  } else {
    showToast('Chapter unmarked.', 'info');
  }
  saveProgress();

  // Update DOM
  const item = document.getElementById('chi-' + chId);
  const chk = document.getElementById('chk-' + chId);
  item.dataset.done = String(appState.progress[chId].done);
  item.classList.toggle('completed', appState.progress[chId].done);
  chk.classList.toggle('checked', appState.progress[chId].done);
  chk.textContent = appState.progress[chId].done ? '✓' : '';

  updateSubjectBadge(subId);
  applyFilter();
}

function toggleBookmark(chId, subId) {
  if (!appState.progress[chId]) appState.progress[chId] = {};
  appState.progress[chId].bookmarked = !appState.progress[chId].bookmarked;
  saveProgress();
  const btn = document.getElementById('bkm-' + chId);
  const item = document.getElementById('chi-' + chId);
  item.dataset.bookmarked = String(appState.progress[chId].bookmarked);
  btn.classList.toggle('bookmarked', appState.progress[chId].bookmarked);
  const msg = appState.progress[chId].bookmarked ? 'Bookmarked! 🔖' : 'Bookmark removed.';
  showToast(msg, 'info');
  applyFilter();
}

function setDifficulty(chId, sel) {
  if (!appState.progress[chId]) appState.progress[chId] = {};
  appState.progress[chId].difficulty = sel.value;
  const diffClass = { Easy:'diff-easy', Medium:'diff-medium', Hard:'diff-hard' }[sel.value];
  sel.className = 'difficulty-pill ' + diffClass;
  saveProgress();
}

function toggleNotePanel(chId) {
  const panel = document.getElementById('notes-panel-' + chId);
  panel.classList.toggle('open');
  if (panel.classList.contains('open')) {
    document.getElementById('ch-note-txt-' + chId).focus();
  }
}

function saveChapterNote(chId) {
  const txt = document.getElementById('ch-note-txt-' + chId).value;
  if (!appState.progress[chId]) appState.progress[chId] = {};
  appState.progress[chId].note = txt;
  saveProgress();
  document.getElementById('notes-panel-' + chId).classList.remove('open');
  showToast('Note saved! 📄', 'success');
}

function updateSubjectBadge(subId) {
  const sub = getActiveSubjects().find(s => s.id === subId);
  if (!sub) return;
  const done = sub.chapters.filter(c => appState.progress[c.id]?.done).length;
  const pct = Math.round(done/sub.chapters.length*100);
  const badge = document.getElementById('badge-' + subId);
  const prog = document.getElementById('prog-' + subId);
  if (badge) badge.textContent = `${done} / ${sub.chapters.length}`;
  if (prog) prog.style.width = pct + '%';
}

/* FILTER & SEARCH */
function filterChapters(query) {
  currentSearchQuery = query.toLowerCase();
  applyFilter();
}

function setFilter(f, el) {
  currentFilter = f;
  document.querySelectorAll('.filter-pills .pill').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  applyFilter();
}

function applyFilter() {
  const items = document.querySelectorAll('.chapter-item');
  items.forEach(item => {
    const done = item.dataset.done === 'true';
    const bookmarked = item.dataset.bookmarked === 'true';
    const name = item.querySelector('.ch-name')?.textContent?.toLowerCase() || '';
    const sub = item.querySelector('.ch-sub')?.textContent?.toLowerCase() || '';
    const matchesSearch = !currentSearchQuery || name.includes(currentSearchQuery) || sub.includes(currentSearchQuery);
    const matchesFilter =
      currentFilter === 'all' ||
      (currentFilter === 'completed' && done) ||
      (currentFilter === 'pending' && !done) ||
      (currentFilter === 'bookmarked' && bookmarked);
    item.classList.toggle('hidden', !(matchesSearch && matchesFilter));
  });
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

