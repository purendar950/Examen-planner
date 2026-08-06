/* ══════════════════════════════════════════════
   DASHBOARD
══════════════════════════════════════════════ */

/* hex → rgba tint (for subject-colored tags) */
function dashTint(hex, a) {
  let h = (hex || '#00C896').replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
}

/* Best-effort current user's first name */
function dashUserName() {
  let nm = '';
  try { if (window.EZ_PROFILE && EZ_PROFILE.name) nm = EZ_PROFILE.name; } catch (e) {}
  try { if (!nm && typeof currentUser !== 'undefined' && currentUser) nm = currentUser.name || currentUser.displayName || ''; } catch (e) {}
  try { if (!nm && typeof appState !== 'undefined' && appState.userName) nm = appState.userName; } catch (e) {}
  nm = (nm || 'Aspirant').trim().split(/\s+/)[0];
  return nm.charAt(0).toUpperCase() + nm.slice(1);
}

function dashGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning,';
  if (h < 17) return 'Good afternoon,';
  return 'Good evening,';
}

/* ── date/format helpers shared by the momentum tiles ── */
function dashDateKey(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

/* Compact duration for the study-time tile: 0h / 45m / 3h 20m */
function dashDuration(seconds) {
  const mins = Math.round((seconds || 0) / 60);
  if (mins <= 0) return '0h';
  if (mins < 60) return mins + 'm';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? h + 'h ' + m + 'm' : h + 'h';
}

/* Days remaining to the exam — mirrors countdown.js so the pace check and the
   countdown never disagree. */
function dashDaysToExam() {
  try {
    const iso = (typeof safeExamDate === 'function') ? safeExamDate() : appState.examDate;
    const target = new Date(iso + 'T09:00:00');
    const diff = target - new Date();
    if (!isFinite(diff) || diff < 0) return 0;
    return Math.floor(diff / 86400000);
  } catch (e) { return 0; }
}

/* ══════════════════════════════════════════════
   PACE CHECK
   The old dashboard printed remaining/days as a neutral "target", so a student
   with 161 chapters and 7 days was told to do 23 chapters a day as if that were
   a normal goal. This grades the number and offers the fix instead.
══════════════════════════════════════════════ */
function dashUpdatePace(remaining, days) {
  const card = document.getElementById('dash-pace-card');
  if (!card) return;
  const $ = id => document.getElementById(id);
  if (typeof remaining !== 'number') {
    const subjects = getActiveSubjects();
    remaining = subjects.reduce((t, s) => t + s.chapters.filter(c => !appState.progress[c.id]?.done).length, 0);
  }
  if (typeof days !== 'number') days = dashDaysToExam();

  const valueEl = $('chapters-per-day');
  const action = $('dash-pace-action');
  card.classList.remove('is-tight', 'is-risk', 'is-clear');

  // Syllabus already covered — nothing to pace.
  if (remaining <= 0) {
    if (valueEl) valueEl.textContent = '0';
    if ($('dash-pace-unit')) $('dash-pace-unit').textContent = 'chapters / day';
    if ($('dash-pace-icon')) $('dash-pace-icon').textContent = '✓';
    if ($('dash-pace-title')) $('dash-pace-title').textContent = 'Syllabus covered';
    if ($('dash-pace-note')) $('dash-pace-note').textContent = 'Nothing left to schedule. Protect it with revision and mocks.';
    card.classList.add('is-clear');
    if (action) { action.hidden = true; action.onclick = null; }
    return;
  }

  const perDay = days > 0 ? Math.ceil(remaining / days) : remaining;
  if (valueEl) valueEl.textContent = perDay;
  if ($('dash-pace-unit')) $('dash-pace-unit').textContent = (perDay === 1 ? 'chapter' : 'chapters') + ' / day';

  let icon = '↗', title = 'Daily completion target', note, state = '', cta = null;

  if (days <= 0) {
    icon = '!';
    title = 'Exam date has passed';
    note = remaining + ' chapter' + (remaining === 1 ? '' : 's') + ' still uncovered. Set your next exam date to get a realistic plan.';
    state = 'is-risk';
    cta = { label: 'Set exam date', run: dashFocusExamDate };
  } else if (perDay > 8) {
    icon = '!';
    title = 'This pace is not realistic';
    note = perDay + ' chapters a day for ' + days + ' day' + (days === 1 ? '' : 's') +
           ' is not achievable. Prioritise high-weight chapters, or move your exam date if you can.';
    state = 'is-risk';
    cta = { label: 'Build a plan', run: () => switchPage('planner') };
  } else if (perDay > 4) {
    icon = '↗';
    title = 'Ambitious but possible';
    note = 'You need ' + perDay + ' chapters a day for the next ' + days + ' day' + (days === 1 ? '' : 's') +
           '. Block dedicated study time to hold this.';
    state = 'is-tight';
    cta = { label: 'Build a plan', run: () => switchPage('planner') };
  } else {
    note = 'Hold this pace and you will finish the syllabus with ' + days + ' day' + (days === 1 ? '' : 's') + ' to spare.';
  }

  if ($('dash-pace-icon')) $('dash-pace-icon').textContent = icon;
  if ($('dash-pace-title')) $('dash-pace-title').textContent = title;
  if ($('dash-pace-note')) $('dash-pace-note').textContent = note;
  if (state) card.classList.add(state);
  if (action) {
    if (cta) {
      action.hidden = false;
      action.textContent = cta.label;
      action.onclick = cta.run;
    } else {
      action.hidden = true;
      action.onclick = null;
    }
  }
}

/* Jump the student straight to the exam-date picker in the readiness card. */
function dashFocusExamDate() {
  const input = document.getElementById('exam-date-picker');
  if (!input) return;
  input.scrollIntoView({ behavior: 'smooth', block: 'center' });
  try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
  try { if (typeof input.showPicker === 'function') input.showPicker(); } catch (e) {}
}

/* ══════════════════════════════════════════════
   TODAY'S PRIORITIES — actions
══════════════════════════════════════════════ */
/* Open a specific chapter on the Syllabus tab. Clears any active search/filter
   first, otherwise the target row can be hidden and the jump looks broken. */
function dashOpenChapter(chId, subId) {
  try { switchPage('syllabus'); } catch (e) {}
  setTimeout(function () {
    try { if (typeof sylSwitchSub === 'function') sylSwitchSub('chapters'); } catch (e) {}

    // Reset search + filter so the chapter cannot be filtered out of view.
    try {
      const search = document.getElementById('search-input');
      if (search) search.value = '';
      currentSearchQuery = '';
      currentFilter = 'all';
      document.querySelectorAll('.filter-pills .pill').forEach((p, i) => p.classList.toggle('active', i === 0));
      if (typeof applyFilter === 'function') applyFilter();
    } catch (e) {}

    const list = document.getElementById('chlist-' + subId);
    const chev = document.getElementById('chev-' + subId);
    if (list && !list.classList.contains('open')) {
      list.classList.add('open');
      if (chev) chev.classList.add('open');
    }

    const item = document.getElementById('chi-' + chId);
    if (item) {
      item.scrollIntoView({ behavior: 'smooth', block: 'center' });
      item.classList.add('dash-jump-target');
      setTimeout(() => item.classList.remove('dash-jump-target'), 1800);
    }
  }, 160);
}

/* Tick a priority off without leaving the dashboard. */
function dashCompleteChapter(event, chId, subId) {
  if (event) { event.preventDefault(); event.stopPropagation(); }
  try { toggleChapter(chId, subId); } catch (e) { return; }
  try { updateDashboard(); } catch (e) {}
}

/* "Start next chapter" — opens the first priority rather than the top of the
   syllabus, so the button lands where the list says it will. */
function dashStartNext() {
  const first = document.querySelector('#dash-today-list .dash-todo-item[data-ch-id]');
  if (first) {
    dashOpenChapter(first.dataset.chId, first.dataset.subId);
  } else {
    switchPage('syllabus');
  }
}

function updateDashboard() {
  const $ = id => document.getElementById(id);
  const subjects = getActiveSubjects();
  const allChapters = subjects.flatMap(s => s.chapters);
  const total = allChapters.length;
  const done = allChapters.filter(c => appState.progress[c.id]?.done).length;
  const bookmarked = allChapters.filter(c => appState.progress[c.id]?.bookmarked).length;
  const remaining = total - done;
  const pct = total > 0 ? Math.round(done / total * 100) : 0;

  // Header: exam title, greeting, username
  try {
    const ex = (typeof ALL_EXAMS !== 'undefined' && ALL_EXAMS[currentExam]) ? ALL_EXAMS[currentExam] : null;
    if ($('dash-exam-title') && ex) $('dash-exam-title').textContent = ex.fullName || ex.name || 'Your Exam';
  } catch (e) {}
  if ($('dash-greeting')) $('dash-greeting').textContent = dashGreeting();
  if ($('dash-username')) $('dash-username').textContent = dashUserName();

  // Target score / rank — its own column between name and exam date (green, black glow)
  const rankEl = $('dash-target-rank');
  if (rankEl) {
    let tRank = '';
    try { tRank = (appState.studyProfile && appState.studyProfile.targetScore) || ''; } catch (e) {}
    if (!tRank) { try { tRank = (window.EZ_PROFILE && EZ_PROFILE.targetScore) || ''; } catch (e) {} }
    tRank = (tRank || '').trim();
    if (tRank) {
      rankEl.innerHTML = '<span class="dr-label">RANK</span>' +
                         '<span class="dr-val">Target: ' + tRank + '</span>';
      rankEl.style.display = '';
    } else {
      rankEl.innerHTML = '';
      rankEl.style.display = 'none';
    }
  }

  // Momentum tiles. Total/completed are intentionally not repeated here — the
  // readiness ring and its "chapters done" fraction already carry them.
  if ($('stat-remaining')) $('stat-remaining').textContent = remaining;
  if ($('stat-bookmarked')) $('stat-bookmarked').textContent = bookmarked;
  if ($('streak-count')) $('streak-count').textContent = appState.streak || 0;

  // Last 7 days: chapters finished + study time logged.
  const weekKeys = [];
  const weekStart = new Date(); weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - 6);
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart); d.setDate(weekStart.getDate() + i);
    weekKeys.push(dashDateKey(d));
  }
  if ($('stat-week-done')) {
    const weekDone = allChapters.filter(c => {
      const at = appState.progress[c.id]?.completedAt;
      if (!at) return false;
      const d = new Date(at);
      return !isNaN(d.getTime()) && weekKeys.indexOf(dashDateKey(d)) !== -1;
    }).length;
    $('stat-week-done').textContent = weekDone;
  }
  if ($('stat-week-time')) {
    // Prefer the planner's own day total (tasks + video) so the two tabs agree.
    const dayTotal = (typeof plannerDayTotalSeconds === 'function')
      ? plannerDayTotalSeconds
      : (ds => ((appState.tasks[ds] || []).reduce((s, t) => s + (t.totalSeconds || 0), 0) +
                ((appState.videoStudyLog && appState.videoStudyLog[ds]) || 0)));
    let secs = 0;
    weekKeys.forEach(ds => { try { secs += dayTotal(ds) || 0; } catch (e) {} });
    $('stat-week-time').textContent = dashDuration(secs);
  }

  // Syllabus readiness — the headline is derived only from real completion data.
  if ($('dash-syllabus-pct')) $('dash-syllabus-pct').textContent = pct + '%';
  if ($('dash-done-frac')) $('dash-done-frac').textContent = done + ' / ' + total;
  const readinessTitle = $('dash-readiness-title');
  const readinessNote = $('dash-readiness-note');
  if (readinessTitle) {
    readinessTitle.textContent = pct >= 100 ? 'Syllabus covered' :
      pct >= 75 ? 'Ready for the final stretch' :
      pct >= 40 ? 'Momentum is building' :
      pct > 0 ? 'Keep compounding progress' : 'Build your momentum';
  }
  if (readinessNote) {
    readinessNote.textContent = pct >= 100
      ? 'Your coverage is complete. Shift attention to revision and mock performance.'
      : remaining + ' chapter' + (remaining === 1 ? '' : 's') + ' remain. Complete today’s priorities to improve your coverage.';
  }
  const ring = $('dash-syllabus-ring');
  if (ring) {
    const C = 326.726;
    ring.style.strokeDashoffset = (C * (1 - pct / 100)).toFixed(1);
  }
  // The ring is the headline number, so give it a text equivalent.
  const ringWrap = $('dash-syllabus-ring-wrap');
  if (ringWrap) {
    ringWrap.setAttribute('aria-label',
      'Syllabus coverage ' + pct + ' percent — ' + done + ' of ' + total + ' chapters complete');
  }

  // Exam urgency — escalate the metric instead of leaving "07 days" as quiet
  // tertiary text next to everything else.
  const daysLeft = dashDaysToExam();
  const examInEl = $('dash-exam-in');
  if (examInEl) {
    examInEl.classList.toggle('is-urgent', daysLeft <= 14);
    examInEl.classList.toggle('is-soon', daysLeft > 14 && daysLeft <= 30);
  }

  // Pace check (states + CTA) — recomputed from the same numbers as above.
  dashUpdatePace(remaining, daysLeft);

  // Today's focus — next incomplete chapter from each active subject.
  const focusLine = $('dash-focus-line');
  const focusCount = $('dash-focus-count');
  const todoEl = $('dash-today-list');
  if (todoEl) {
    const nextChapters = [];
    for (const sub of subjects) {
      const idx = sub.chapters.findIndex(c => !appState.progress[c.id]?.done);
      if (idx !== -1) nextChapters.push({ ch: sub.chapters[idx], sub, idx, of: sub.chapters.length });
    }
    if (focusCount) focusCount.textContent = nextChapters.length + ' priorit' + (nextChapters.length === 1 ? 'y' : 'ies');
    if (!nextChapters.length) {
      if (focusLine) focusLine.textContent = 'All caught up — great work!';
      todoEl.innerHTML = '<div class="dash-todo-empty">Syllabus coverage is complete. Continue with revision and mock tests to protect your progress.</div>';
    } else {
      if (focusLine) focusLine.textContent = 'Complete these ' + nextChapters.length + ' to stay on track';
      /* Each row is now (a) tickable in place and (b) a deep link to that exact
         chapter. The old version repeated "Next incomplete chapter" on every
         row and sent all four clicks to the top of the syllabus. */
      todoEl.innerHTML = nextChapters.map(x => {
        const chId = escapeHtml(String(x.ch.id));
        const subId = escapeHtml(String(x.sub.id));
        const marked = appState.progress[x.ch.id]?.bookmarked ? ' · 🔖 Bookmarked' : '';
        return '<div class="dash-todo-item" data-ch-id="' + chId + '" data-sub-id="' + subId + '"' +
            ' onclick="dashOpenChapter(\'' + chId + '\',\'' + subId + '\')"' +
            ' onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();this.click();}"' +
            ' tabindex="0" role="button">' +
          '<button type="button" class="dash-todo-check" aria-label="Mark ' + escapeHtml(x.ch.name) + ' complete"' +
            ' title="Mark complete"' +
            ' onclick="dashCompleteChapter(event,\'' + chId + '\',\'' + subId + '\')"></button>' +
          '<div><div class="dash-todo-name">' + escapeHtml(x.ch.name) + '</div>' +
          '<div class="dash-todo-sub">Chapter ' + (x.idx + 1) + ' of ' + x.of + marked + '</div></div>' +
          '<span class="dash-todo-tag" style="background:' + dashTint(x.sub.color, 0.14) + ';color:' + x.sub.color + ';">' + escapeHtml(x.sub.name) + '</span>' +
        '</div>';
      }).join('');
    }
  }

  // Subject allocation cards
  const container = $('subject-progress-cards');
  if (container) {
    container.innerHTML = subjects.map(sub => {
      const t = sub.chapters.length;
      const d = sub.chapters.filter(c => appState.progress[c.id]?.done).length;
      const p = t > 0 ? Math.round(d / t * 100) : 0;
      const next = sub.chapters.find(c => !appState.progress[c.id]?.done);
      return '<div class="dash-subj" style="--subject-color:' + sub.color + '" onclick="switchPage(\'syllabus\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();this.click();}" tabindex="0" role="button">' +
        '<div class="dash-subj-top">' +
          '<span class="dash-subj-name"><span class="sw" style="background:' + sub.color + ';"></span>' + escapeHtml(sub.name) + '</span>' +
          '<span class="dash-subj-frac">' + d + ' / ' + t + ' chapters</span>' +
        '</div>' +
        '<div class="dash-subj-row">' +
          '<div class="dash-bar"><div style="width:' + p + '%;background:' + sub.color + ';"></div></div>' +
          '<span class="dash-subj-pct" style="color:' + sub.color + ';">' + p + '%</span>' +
        '</div>' +
        '<div class="dash-subj-next"><span>Next:</span><strong>' + escapeHtml(next ? next.name : 'Syllabus complete') + '</strong><span>Continue →</span></div>' +
      '</div>';
    }).join('');
  }

  // Recent activity
  const recentEl = $('recent-activity-list');
  if (recentEl) {
    const completed = allChapters
      .filter(c => appState.progress[c.id]?.done && appState.progress[c.id]?.completedAt)
      .sort((a, b) => new Date(appState.progress[b.id].completedAt) - new Date(appState.progress[a.id].completedAt))
      .slice(0, 5);
    if (!completed.length) {
      recentEl.innerHTML = '<div class="empty-state"><div><div class="empty-icon">✓</div><p>No chapters completed yet. Tick off your first priority above and it will show up here.</p><button onclick="dashStartNext()">Start first chapter →</button></div></div>';
    } else {
      recentEl.innerHTML = '<div class="dash-recent">' + completed.map(c => {
        const sub = subjects.find(s => s.chapters.some(ch => ch.id === c.id));
        const d = new Date(appState.progress[c.id].completedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
        return '<div class="dash-r">' +
          '<span class="dash-r-ck">✓</span>' +
          '<div class="dash-r-i"><div class="t">' + escapeHtml(c.name) + '</div><div class="s">' + escapeHtml(sub?.name || '') + '</div></div>' +
          '<span class="dash-r-d">' + d + '</span>' +
        '</div>';
      }).join('') + '</div>';
    }
  }

  // Continue Watching remains visible even before the first video so the
  // three-card operations grid never collapses or hides the feature.
  const lv = appState.ytLastVideo;
  const contCard = $('yt-continue-card');
  if (lv && lv.id && contCard) {
    const thumb = `https://i.ytimg.com/vi/${lv.id}/mqdefault.jpg`;
    const badge = lv.type === 'playlist' ? 'Playlist' : 'Video';
    contCard.innerHTML = `
      <div class="fin-video-content">
        <div class="fin-action-title-row">
          <div class="fin-action-icon fin-green">▶</div>
          <h3>Continue Watching</h3>
          <span class="fin-arrow" aria-hidden="true">↗</span>
        </div>
        <div class="fin-video-main">
          <div class="fin-video-thumb">
            <img src="${thumb}" onerror="this.style.display='none'" alt="">
            <span class="fin-video-play">▶</span>
          </div>
          <div class="fin-video-copy">
            <strong>${escapeHtml(lv.title || 'Video')}</strong>
            <span>${badge} · Resume your last session</span>
          </div>
        </div>
        <span class="fin-video-resume">Resume learning →</span>
      </div>`;
  } else if (contCard) {
    contCard.innerHTML = `
      <div class="fin-video-content">
        <div class="fin-action-title-row">
          <div class="fin-action-icon fin-green">▶</div>
          <h3>Continue Watching</h3>
          <span class="fin-arrow" aria-hidden="true">↗</span>
        </div>
        <p class="fin-action-muted">Start a course in the YouTube workspace and your latest lesson will appear here.</p>
        <span class="fin-video-resume">Browse courses →</span>
      </div>`;
  }
}
