/* ══════════════════════════════════════════════
   DASHBOARD — Reference Replica
   State/rendering logic preserved; presentation lives in pages/dashboard.html.
══════════════════════════════════════════════ */
function dashTint(hex, a) {
  let h = (hex || '#00C896').replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
}
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
function applyDashboardV2LayoutFixes() {
  if (document.getElementById('dashboard-shell-fix')) return;
  const style = document.createElement('style');
  style.id = 'dashboard-shell-fix';
  style.textContent = `
    body:has(#page-dashboard.active) .topbar,
    body:has(#page-dashboard.active) .nav-tabs { display:flex !important; }
    body:has(#page-dashboard.active) #app { margin-left:initial !important; padding:initial !important; max-width:initial !important; width:initial !important; }
    body:has(#page-dashboard.active) .ref-nav { display:none !important; }
  `;
  document.head.appendChild(style);
}
function updateDashboard() {
  applyDashboardV2LayoutFixes();
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
  const name = dashUserName();
  if ($('dash-greeting')) $('dash-greeting').textContent = dashGreeting();
  if ($('dash-username')) $('dash-username').textContent = name;
  if ($('ref-user-name')) $('ref-user-name').textContent = name;
  if ($('dv-avatar')) $('dv-avatar').textContent = (name || 'P').trim().charAt(0).toUpperCase();
  const rankEl = $('dash-target-rank');
  if (rankEl) {
    let tRank = '';
    try { tRank = (appState.studyProfile && appState.studyProfile.targetScore) || ''; } catch (e) {}
    if (!tRank) { try { tRank = (window.EZ_PROFILE && EZ_PROFILE.targetScore) || ''; } catch (e) {} }
    tRank = (tRank || '').trim();
    if (tRank) { rankEl.textContent = tRank; rankEl.style.display = ''; }
    else { rankEl.textContent = ''; rankEl.style.display = 'none'; }
  }
  if ($('stat-total')) $('stat-total').textContent = total;
  if ($('stat-done')) $('stat-done').textContent = done;
  if ($('stat-remaining')) $('stat-remaining').textContent = remaining;
  if ($('stat-bookmarked')) $('stat-bookmarked').textContent = bookmarked;
  if ($('streak-count')) $('streak-count').textContent = appState.streak || 0;
  if ($('streak-count-head')) $('streak-count-head').textContent = appState.streak || 0;
  if ($('dash-syllabus-pct')) $('dash-syllabus-pct').textContent = pct + '%';
  if ($('dash-done-frac')) $('dash-done-frac').textContent = done + ' / ' + total;
  const bar = $('ref-syllabus-bar');
  if (bar) bar.style.width = pct + '%';
  const ring = $('dash-syllabus-ring');
  if (ring) ring.style.strokeDashoffset = (326.726 * (1 - pct / 100)).toFixed(1);
  const readinessTitle = $('dash-readiness-title');
  const readinessNote = $('dash-readiness-note');
  if (readinessTitle) readinessTitle.textContent = pct >= 100 ? 'Syllabus covered' : pct >= 75 ? 'Ready for the final stretch' : pct >= 40 ? 'Momentum is building' : pct > 0 ? 'Keep compounding progress' : 'Build your momentum';
  if (readinessNote) readinessNote.textContent = remaining + ' chapter' + (remaining === 1 ? '' : 's') + ' remain.';
  const focusCount = $('dash-focus-count');
  const todoEl = $('dash-today-list');
  if (todoEl) {
    const nextChapters = [];
    for (const sub of subjects) {
      const ch = sub.chapters.find(c => !appState.progress[c.id]?.done);
      if (ch) nextChapters.push({ ch, sub });
    }
    if (focusCount) focusCount.textContent = nextChapters.length + ' Priority Tasks';
    if (!nextChapters.length) {
      todoEl.innerHTML = '<div class="dv-empty">All caught up — continue with revision and mock tests.</div>';
    } else {
      todoEl.innerHTML = nextChapters.map((x, index) => {
        const numClass = index === 1 ? 'blue' : index === 2 ? 'amber' : index === 3 ? 'purple' : '';
        return '<div class="ref-task dv-generated-todo" onclick="switchPage(\'syllabus\')" tabindex="0" role="button">' +
          '<span class="ref-num ' + numClass + '">' + String(index + 1).padStart(2, '0') + '</span>' +
          '<div><div class="ref-task-name">' + escapeHtml(x.ch.name) + '</div><div class="ref-task-sub">' + escapeHtml(x.sub.name) + '</div></div>' +
          '<span class="ref-tag" style="color:' + x.sub.color + ';background:' + dashTint(x.sub.color, .09) + '">' + escapeHtml(x.sub.name) + '</span></div>';
      }).join('');
    }
  }
  const container = $('subject-progress-cards');
  if (container) {
    container.innerHTML = subjects.map((sub, index) => {
      const t = sub.chapters.length;
      const d = sub.chapters.filter(c => appState.progress[c.id]?.done).length;
      const p = t > 0 ? Math.round(d / t * 100) : 0;
      const next = sub.chapters.find(c => !appState.progress[c.id]?.done);
      const icons = ['♧','◉','▣','▤'];
      return '<article class="ref-card ref-subject dv-subject" style="--subject-color:' + sub.color + '" onclick="switchPage(\'syllabus\')" tabindex="0" role="button">' +
        '<div class="ref-subj-head"><span class="ref-subj-icon">' + icons[index % icons.length] + '</span><span class="ref-subj-name">' + escapeHtml(sub.name) + '</span></div>' +
        '<div class="ref-subj-percent">' + p + '%</div><div class="ref-subj-meta">' + d + ' / ' + t + ' Topics</div>' +
        '<div class="ref-subj-bar"><div style="width:' + p + '%"></div></div>' +
        '<div class="ref-subj-next">Next: <strong>' + escapeHtml(next ? next.name : 'Syllabus complete') + '</strong></div>' +
        '<div class="ref-subj-btn">Continue&nbsp; →</div></article>';
    }).join('');
  }
  const recentEl = $('recent-activity-list');
  if (recentEl) {
    const completed = allChapters
      .filter(c => appState.progress[c.id]?.done && appState.progress[c.id]?.completedAt)
      .sort((a, b) => new Date(appState.progress[b.id].completedAt) - new Date(appState.progress[a.id].completedAt))
      .slice(0, 4);
    if (!completed.length) {
      recentEl.innerHTML = '<div class="dv-empty">No recent completions yet. Finish a priority chapter and your activity will appear here.</div>';
    } else {
      recentEl.innerHTML = '<div class="ref-recent">' + completed.map(c => {
        const sub = subjects.find(s => s.chapters.some(ch => ch.id === c.id));
        const d = new Date(appState.progress[c.id].completedAt).toLocaleDateString('en-IN', { day:'numeric', month:'short' });
        return '<div class="ref-recent-item"><span class="ref-check">✓</span><div><div class="ref-recent-title">' + escapeHtml(c.name) + '</div><div class="ref-recent-sub">' + escapeHtml(sub?.name || '') + ' · ' + d + '</div></div></div>';
      }).join('') + '</div>';
    }
  }
  const lv = appState.ytLastVideo;
  const contCard = $('yt-continue-card');
  if (lv && lv.id && contCard) {
    const thumb = 'https://i.ytimg.com/vi/' + lv.id + '/mqdefault.jpg';
    contCard.innerHTML = '<div class="ref-op-head"><span class="ref-op-icon green">▶</span></div><h3>Continue Watching</h3><div class="ref-video-main"><div class="ref-thumb"><img src="' + thumb + '" alt=""><span class="play">▶</span></div><div class="ref-video-copy"><strong>' + escapeHtml(lv.title || 'Video') + '</strong><span>' + (lv.type === 'playlist' ? 'Playlist' : 'Video') + '</span></div></div><div class="ref-action green">Resume Now&nbsp; →</div>';
  }
}
