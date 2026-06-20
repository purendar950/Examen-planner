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

  // Target score / rank — shown in glowing golden under the name
  const rankEl = $('dash-target-rank');
  if (rankEl) {
    let tRank = '';
    try { tRank = (appState.studyProfile && appState.studyProfile.targetScore) || ''; } catch (e) {}
    if (!tRank) { try { tRank = (window.EZ_PROFILE && EZ_PROFILE.targetScore) || ''; } catch (e) {} }
    tRank = (tRank || '').trim();
    if (tRank) {
      rankEl.textContent = '🎯 Target: ' + tRank;
      rankEl.style.display = '';
    } else {
      rankEl.textContent = '';
      rankEl.style.display = 'none';
    }
  }

  // Stats
  if ($('stat-total')) $('stat-total').textContent = total;
  if ($('stat-done')) $('stat-done').textContent = done;
  if ($('stat-remaining')) $('stat-remaining').textContent = remaining;
  if ($('stat-bookmarked')) $('stat-bookmarked').textContent = bookmarked;
  if ($('streak-count')) $('streak-count').textContent = appState.streak || 0;

  // Syllabus ring
  if ($('dash-syllabus-pct')) $('dash-syllabus-pct').textContent = pct + '%';
  if ($('dash-done-frac')) $('dash-done-frac').textContent = done + ' / ' + total;
  const ring = $('dash-syllabus-ring');
  if (ring) {
    const C = 326.726;
    ring.style.strokeDashoffset = (C * (1 - pct / 100)).toFixed(1);
  }

  // Today's focus — next incomplete chapters
  const focusLine = $('dash-focus-line');
  const todoEl = $('dash-today-list');
  if (todoEl) {
    // one incomplete topic from each subject
    const nextChapters = [];
    for (const sub of subjects) {
      const ch = sub.chapters.find(c => !appState.progress[c.id]?.done);
      if (ch) nextChapters.push({ ch, sub });
    }
    if (!nextChapters.length) {
      if (focusLine) focusLine.textContent = 'All caught up — great work! 🎉';
      todoEl.innerHTML = '<div class="dash-todo-empty">🎉 Syllabus complete. Time to revise & take mock tests!</div>';
    } else {
      if (focusLine) focusLine.textContent = 'Finish these ' + nextChapters.length + ' to stay on track';
      todoEl.innerHTML = nextChapters.map(x =>
        '<div class="dash-todo-item" onclick="switchPage(\'syllabus\')">' +
          '<div class="dash-todo-check"></div>' +
          '<div class="dash-todo-name">' + escapeHtml(x.ch.name) + '</div>' +
          '<span class="dash-todo-tag" style="background:' + dashTint(x.sub.color, 0.14) + ';color:' + x.sub.color + ';">' + escapeHtml(x.sub.name) + '</span>' +
        '</div>'
      ).join('');
    }
  }

  // Subject progress
  const container = $('subject-progress-cards');
  if (container) {
    container.innerHTML = subjects.map(sub => {
      const t = sub.chapters.length;
      const d = sub.chapters.filter(c => appState.progress[c.id]?.done).length;
      const p = t > 0 ? Math.round(d / t * 100) : 0;
      return '<div class="dash-subj" onclick="switchPage(\'syllabus\')">' +
        '<div class="dash-subj-top">' +
          '<span class="dash-subj-name"><span class="sw" style="background:' + sub.color + ';"></span>' + escapeHtml(sub.name) + '</span>' +
          '<span class="dash-subj-frac">' + d + ' / ' + t + '</span>' +
        '</div>' +
        '<div class="dash-subj-row">' +
          '<div class="dash-bar"><div style="width:' + p + '%;background:' + sub.color + ';"></div></div>' +
          '<span class="dash-subj-pct" style="color:' + sub.color + ';">' + p + '%</span>' +
        '</div>' +
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
      recentEl.innerHTML = '<div class="empty-state"><div class="empty-icon">📚</div><p>No chapters completed yet. Start from the Syllabus tab!</p></div>';
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

  // ── Continue Watching card ──
  const lv = appState.ytLastVideo;
  const contCard = $('yt-continue-card');
  if (lv && lv.id && contCard) {
    const thumb = `https://i.ytimg.com/vi/${lv.id}/mqdefault.jpg`;
    const badge = lv.type === 'playlist' ? '📋 Playlist' : '▶ Video';
    contCard.style.display = 'block';
    contCard.innerHTML = `
      <div style="font-size:0.65rem;text-transform:uppercase;color:var(--muted);letter-spacing:0.08em;margin-bottom:8px;font-weight:700;">▶ Continue Watching</div>
      <div style="display:flex;align-items:center;gap:11px;">
        <div style="width:70px;height:44px;border-radius:8px;overflow:hidden;flex-shrink:0;background:var(--surface);">
          ${thumb ? `<img src="${thumb}" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display='none'" alt="">` : '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:1.1rem;">▶</div>'}
        </div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:0.84rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(lv.title || 'Video')}</div>
          <div style="font-size:0.7rem;color:var(--muted);margin-top:3px;">${badge}</div>
        </div>
        <button onclick="event.stopPropagation();switchPage('youtube');setTimeout(ytResume,120)"
          style="background:var(--accent);color:#04130d;border:none;border-radius:9px;padding:7px 14px;font-size:0.78rem;font-weight:800;cursor:pointer;white-space:nowrap;flex-shrink:0;">
          ▶ Resume
        </button>
      </div>`;
  } else if (contCard) {
    contCard.innerHTML = '<div style="font-size:0.65rem;text-transform:uppercase;color:var(--muted);letter-spacing:0.08em;margin-bottom:8px;font-weight:700;">▶ Continue Watching</div><div style="font-size:0.82rem;color:var(--muted);">No video yet — open the YouTube tab to start a course.</div>';
  }
}
