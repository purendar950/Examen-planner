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

/* Best-effort current user's first name. */
function dashUserName() {
  if (typeof ezDisplayFirstName === 'function') return ezDisplayFirstName();
  return 'Aspirant';
}

function dashGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning,';
  if (h < 17) return 'Good afternoon,';
  return 'Good evening,';
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

  try {
    const ex = (typeof ALL_EXAMS !== 'undefined' && ALL_EXAMS[currentExam]) ? ALL_EXAMS[currentExam] : null;
    if ($('dash-exam-title') && ex) $('dash-exam-title').textContent = ex.fullName || ex.name || 'Your Exam';
  } catch (e) {}
  if ($('dash-greeting')) $('dash-greeting').textContent = dashGreeting();
  if ($('dash-username')) $('dash-username').textContent = dashUserName();

  const rankEl = $('dash-target-rank');
  if (rankEl) {
    let tRank = '';
    try { tRank = (appState.studyProfile && appState.studyProfile.targetScore) || ''; } catch (e) {}
    if (!tRank) { try { tRank = (window.EZ_PROFILE && EZ_PROFILE.targetScore) || ''; } catch (e) {} }
    tRank = (tRank || '').trim();
    if (tRank) {
      rankEl.innerHTML = '<span class="dr-label">TARGET</span> ' + escapeHtml(tRank);
      rankEl.style.display = '';
    } else {
      rankEl.innerHTML = '';
      rankEl.style.display = 'none';
    }
  }

  if ($('stat-total')) $('stat-total').textContent = total;
  if ($('stat-done')) $('stat-done').textContent = done;
  if ($('stat-remaining')) $('stat-remaining').textContent = remaining;
  if ($('stat-bookmarked')) $('stat-bookmarked').textContent = bookmarked;
  if ($('streak-count')) $('streak-count').textContent = appState.streak || 0;
  if ($('streak-count-head')) $('streak-count-head').textContent = appState.streak || 0;

  if ($('dash-syllabus-pct')) $('dash-syllabus-pct').textContent = pct + '%';
  if ($('dash-done-frac')) $('dash-done-frac').textContent = done + ' / ' + total;
  const readinessTitle = $('dash-readiness-title');
  const readinessNote = $('dash-readiness-note');
  if (readinessTitle) {
    readinessTitle.textContent = pct >= 100 ? 'Syllabus covered' : pct >= 75 ? 'Ready for the final stretch' : pct >= 40 ? 'Momentum is building' : pct > 0 ? 'Keep compounding progress' : 'Build your momentum';
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

  const focusLine = $('dash-focus-line');
  const focusCount = $('dash-focus-count');
  const todoEl = $('dash-today-list');
  if (todoEl) {
    const nextChapters = [];
    for (const sub of subjects) {
      const ch = sub.chapters.find(c => !appState.progress[c.id]?.done);
      if (ch) nextChapters.push({ ch, sub });
    }
    if (focusCount) focusCount.textContent = nextChapters.length + ' priorit' + (nextChapters.length === 1 ? 'y' : 'ies');
    if (!nextChapters.length) {
      if (focusLine) focusLine.textContent = 'All caught up — great work!';
      todoEl.innerHTML = '<div class="dash-todo-empty">Syllabus coverage is complete. Continue with revision and mock tests to protect your progress.</div>';
    } else {
      if (focusLine) focusLine.textContent = 'Complete these ' + nextChapters.length + ' to stay on track';
      todoEl.innerHTML = nextChapters.map((x, index) =>
        '<div class="dash-todo-item dv-generated-todo" onclick="switchPage(\'syllabus\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();this.click();}" tabindex="0" role="button">' +
          '<div class="dash-todo-check dv-num">' + String(index + 1).padStart(2, '0') + '</div>' +
          '<div><div class="dash-todo-name dv-todo-name">' + escapeHtml(x.ch.name) + '</div>' +
          '<div class="dash-todo-sub dv-todo-sub">Next incomplete chapter</div></div>' +
          '<span class="dash-todo-tag dv-todo-tag" style="background:' + dashTint(x.sub.color, 0.14) + ';color:' + x.sub.color + ';">' + escapeHtml(x.sub.name) + '</span>' +
        '</div>'
      ).join('');
    }
  }

  const container = $('subject-progress-cards');
  if (container) {
    container.innerHTML = subjects.map(sub => {
      const t = sub.chapters.length;
      const d = sub.chapters.filter(c => appState.progress[c.id]?.done).length;
      const p = t > 0 ? Math.round(d / t * 100) : 0;
      const next = sub.chapters.find(c => !appState.progress[c.id]?.done);
      return '<div class="dash-subj dv-subject" style="--subject-color:' + sub.color + '" onclick="switchPage(\'syllabus\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();this.click();}" tabindex="0" role="button">' +
        '<div class="dash-subj-top dv-subj-title">' +
          '<span class="dash-subj-name"><span class="sw" style="background:' + sub.color + ';"></span>' + escapeHtml(sub.name) + '</span>' +
          '<span class="dash-subj-frac">' + d + ' / ' + t + ' chapters</span>' +
        '</div>' +
        '<div class="dash-subj-row dv-subj-percent-row">' +
          '<div class="dash-bar dv-subj-bar"><div style="width:' + p + '%;background:' + sub.color + ';"></div></div>' +
          '<span class="dash-subj-pct" style="color:' + sub.color + ';">' + p + '%</span>' +
        '</div>' +
        '<div class="dash-subj-next dv-subj-next"><span>Next:</span> <strong>' + escapeHtml(next ? next.name : 'Syllabus complete') + '</strong></div>' +
        '<div class="dv-subj-btn" style="--subject-color:' + sub.color + '">Continue →</div>' +
      '</div>';
    }).join('');
  }

  const recentEl = $('recent-activity-list');
  if (recentEl) {
    const completed = allChapters
      .filter(c => appState.progress[c.id]?.done && appState.progress[c.id]?.completedAt)
      .sort((a, b) => new Date(appState.progress[b.id].completedAt) - new Date(appState.progress[a.id].completedAt))
      .slice(0, 5);
    if (!completed.length) {
      recentEl.innerHTML = '<div class="dv-empty"><strong>No recent completions yet</strong>Finish a priority chapter and your activity will appear here.<br><button onclick="switchPage(\'syllabus\')">Start a chapter →</button></div>';
    } else {
      recentEl.innerHTML = '<div class="dash-recent dv-recent">' + completed.map(c => {
        const sub = subjects.find(s => s.chapters.some(ch => ch.id === c.id));
        const d = new Date(appState.progress[c.id].completedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
        return '<div class="dash-r dv-recent-item">' +
          '<span class="dash-r-ck dv-check">✓</span>' +
          '<div class="dash-r-i"><div class="t dv-recent-title">' + escapeHtml(c.name) + '</div><div class="s dv-recent-sub">' + escapeHtml(sub?.name || '') + ' · ' + d + '</div></div>' +
        '</div>';
      }).join('') + '</div>';
    }
  }

  if (window.NotesLibrary) {
    try { window.NotesLibrary.renderDashboardCard(); } catch (e) {}
  }

  const lv = appState.ytLastVideo;
  const contCard = $('yt-continue-card');
  if (lv && lv.id && contCard) {
    const thumb = `https://i.ytimg.com/vi/${lv.id}/mqdefault.jpg`;
    const badge = lv.type === 'playlist' ? 'Playlist' : 'Video';
    contCard.innerHTML = `
      <div class="fin-video-content dv-video-content">
        <div class="fin-action-title-row dv-op-head"><div class="fin-action-icon fin-green dv-op-icon green">▶</div><h3>Continue Watching</h3><span class="fin-arrow">↗</span></div>
        <div class="fin-video-main dv-video-main"><div class="fin-video-thumb dv-thumb"><img src="${thumb}" onerror="this.style.display='none'" alt=""><span class="fin-video-play dv-play">▶</span></div><div class="fin-video-copy dv-video-copy"><strong>${escapeHtml(lv.title || 'Video')}</strong><span>${badge} · Resume your last session</span></div></div>
        <span class="fin-video-resume dv-op-action green">Resume now →</span>
      </div>`;
  } else if (contCard) {
    contCard.innerHTML = `
      <div class="fin-video-content dv-video-content">
        <div class="fin-action-title-row dv-op-head"><div class="fin-action-icon fin-green dv-op-icon green">▶</div><h3>Continue Watching</h3><span class="fin-arrow">↗</span></div>
        <p class="fin-action-muted muted">Start a course in the YouTube workspace and your latest lesson will appear here.</p>
        <span class="fin-video-resume dv-op-action green">Browse courses →</span>
      </div>`;
  }
}
