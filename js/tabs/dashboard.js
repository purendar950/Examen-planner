/* ══════════════════════════════════════════════
   DASHBOARD
══════════════════════════════════════════════ */

function updateDashboard() {
  const allChapters = getActiveSubjects().flatMap(s => s.chapters);
  const done = allChapters.filter(c => appState.progress[c.id]?.done).length;
  const bookmarked = allChapters.filter(c => appState.progress[c.id]?.bookmarked).length;

  document.getElementById('stat-total').textContent = allChapters.length;
  document.getElementById('stat-done').textContent = done;
  document.getElementById('stat-remaining').textContent = allChapters.length - done;
  document.getElementById('stat-bookmarked').textContent = bookmarked;
  document.getElementById('streak-count').textContent = appState.streak || 0;

  // Subject progress cards
  const container = document.getElementById('subject-progress-cards');
  container.innerHTML = '';
  getActiveSubjects().forEach(sub => {
    const total = sub.chapters.length;
    const doneCount = sub.chapters.filter(c => appState.progress[c.id]?.done).length;
    const pct = total > 0 ? Math.round(doneCount/total*100) : 0;
    const card = document.createElement('div');
    card.className = 'info-card';
    card.style.padding = '1rem 1.25rem';
    card.style.cursor = 'pointer';
    card.onclick = () => switchPage('syllabus');
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <span style="font-weight:600;font-size:0.875rem;">${sub.name}</span>
        <span style="font-size:0.75rem;color:var(--muted);">${doneCount}/${total}</span>
      </div>
      <div style="display:flex;align-items:center;gap:10px;">
        <div class="progress-bar" style="flex:1;"><div class="progress-fill" style="width:${pct}%;background:${sub.color};"></div></div>
        <span style="font-size:0.78rem;font-weight:700;color:${sub.color};min-width:32px;">${pct}%</span>
      </div>`;
    container.appendChild(card);
  });

  // Recent activity
  const recentEl = document.getElementById('recent-activity-list');
  const completedChapters = allChapters
    .filter(c => appState.progress[c.id]?.done && appState.progress[c.id]?.completedAt)
    .sort((a,b) => new Date(appState.progress[b.id].completedAt) - new Date(appState.progress[a.id].completedAt))
    .slice(0, 5);

  if (!completedChapters.length) {
    recentEl.innerHTML = '<div class="empty-state"><div class="empty-icon">📚</div><p>No chapters completed yet. Start from the Syllabus tab!</p></div>';
  } else {
    recentEl.innerHTML = completedChapters.map(c => {
      const sub = getActiveSubjects().find(s => s.chapters.some(ch => ch.id === c.id));
      return `<div class="streak-bar" style="margin-bottom:8px;">
        <span style="font-size:0.9rem;">✅</span>
        <div><div style="font-weight:600;font-size:0.85rem;">${c.name}</div>
        <div style="font-size:0.72rem;color:var(--muted);">${sub?.name || ''}</div></div>
        <span class="streak-hint">${new Date(appState.progress[c.id].completedAt).toLocaleDateString('en-IN')}</span>
      </div>`;
    }).join('');
  }

  // ── Continue Watching card ──
  const lv = appState.ytLastVideo;
  const contCard = document.getElementById('yt-continue-card');
  if (lv && lv.id && contCard) {
    const thumb = lv.type === 'video'
      ? `https://i.ytimg.com/vi/${lv.id}/mqdefault.jpg`
      : (lv.id ? `https://i.ytimg.com/vi/${lv.id}/mqdefault.jpg` : '');
    const badge = lv.type === 'playlist' ? '📋 Playlist' : '▶ Video';
    contCard.style.display = 'block';
    contCard.innerHTML = `
      <div style="font-size:0.65rem;text-transform:uppercase;color:var(--muted);letter-spacing:0.08em;margin-bottom:6px;">▶ Continue Watching</div>
      <div style="display:flex;align-items:center;gap:12px;">
        <div style="width:84px;height:48px;border-radius:6px;overflow:hidden;flex-shrink:0;background:var(--surface);">
          ${thumb ? `<img src="${thumb}" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display='none'" alt="">` : '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:1.2rem;">▶</div>'}
        </div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:0.85rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(lv.title || 'Video')}</div>
          <div style="font-size:0.7rem;color:var(--muted);margin-top:2px;">${badge}</div>
        </div>
        <button onclick="event.stopPropagation();switchPage('youtube');setTimeout(ytResume,120)"
          style="background:var(--accent);color:#000;border:none;border-radius:8px;padding:6px 14px;font-size:0.78rem;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0;">
          ▶ Resume
        </button>
      </div>`;
  } else if (contCard) {
    contCard.style.display = 'none';
  }
}

