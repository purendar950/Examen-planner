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

/* Best-effort current user's first name.
   Delegates to the canonical resolver in js/core/ui-helpers.js so the heading,
   the account chip and the welcome greeting cannot drift apart. The previous
   local copy of this fallback chain also probed appState.userName, which is
   never written anywhere in the codebase. */
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

  // Stats
  if ($('stat-total')) $('stat-total').textContent = total;
  if ($('stat-done')) $('stat-done').textContent = done;
  if ($('stat-remaining')) $('stat-remaining').textContent = remaining;
  if ($('stat-bookmarked')) $('stat-bookmarked').textContent = bookmarked;
  if ($('streak-count')) $('streak-count').textContent = appState.streak || 0;

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

  // Today's focus — next incomplete chapter from each active subject.
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
        '<div class="dash-todo-item" onclick="switchPage(\'syllabus\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();this.click();}" tabindex="0" role="button">' +
          '<div class="dash-todo-check">' + String(index + 1).padStart(2, '0') + '</div>' +
          '<div><div class="dash-todo-name">' + escapeHtml(x.ch.name) + '</div>' +
          '<div class="dash-todo-sub">Next incomplete chapter</div></div>' +
          '<span class="dash-todo-tag" style="background:' + dashTint(x.sub.color, 0.14) + ';color:' + x.sub.color + ';">' + escapeHtml(x.sub.name) + '</span>' +
        '</div>'
      ).join('');
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
      recentEl.innerHTML = '<div class="empty-state"><div><div class="empty-icon">✓</div><p>No chapters completed yet. Finish a priority to start your activity ledger.</p><button onclick="switchPage(\'syllabus\')">Open syllabus →</button></div></div>';
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

  // My AI Notes — a way back into anything already generated, from the page the
  // student lands on. Owned by NotesLibrary so all three surfaces agree.
  if (window.NotesLibrary) {
    try { window.NotesLibrary.renderDashboardCard(); } catch (e) {}
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
