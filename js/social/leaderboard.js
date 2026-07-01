/* ══════════════════════════════════════════════
   LEADERBOARD — Display & Interaction
   Weekly leaderboards for study groups
══════════════════════════════════════════════ */

// ── State ──────────────────────────────────────
let _leaderboardUnsub = {};
let currentLeaderboardView = 'group'; // 'group' or 'global'
let selectedLeaderboardGroupId = null;

// ── Helper Functions ───────────────────────────

/**
 * Get rank emoji
 */
function getRankEmoji(rank) {
  switch (rank) {
    case 1: return '🥇';
    case 2: return '🥈';
    case 3: return '🥉';
    case 4: case 5: return '🏅';
    default: return '';
  }
}

/**
 * Get rank color
 */
function getRankColor(rank) {
  switch (rank) {
    case 1: return '#FFD700';
    case 2: return '#C0C0C0';
    case 3: return '#CD7F32';
    default: return 'var(--muted)';
  }
}

/**
 * Format week date range
 */
function formatWeekRange(weekStart) {
  const start = new Date(weekStart);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  
  const options = { month: 'short', day: 'numeric' };
  return `${start.toLocaleDateString('en-IN', options)} - ${end.toLocaleDateString('en-IN', options)}`;
}

/**
 * Get week number string
 */
function getWeekLabel(weekStart) {
  const weekNum = getWeekNumber(new Date(weekStart));
  return `Week ${weekNum}`;
}

// ── Leaderboard Rendering ──────────────────────

/**
 * Render group leaderboard
 */
async function renderGroupLeaderboard(groupId, containerId = 'group-leaderboard') {
  const container = document.getElementById(containerId);
  if (!container) return;

  const weekStart = getWeekStart();
  const leaderboard = await getGroupLeaderboard(groupId, weekStart);

  if (leaderboard.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🏆</div>
        <p>No leaderboard data yet. Start studying to appear here!</p>
      </div>
    `;
    return;
  }

  const group = userGroups.find(g => g.id === groupId);
  const groupName = group?.name || 'Study Group';

  container.innerHTML = `
    <div class="leaderboard-header">
      <h3>🏆 ${escapeHtml(groupName)} Leaderboard</h3>
      <div class="leaderboard-week">${getWeekLabel(weekStart)} · ${formatWeekRange(weekStart)}</div>
    </div>
    
    <div class="leaderboard-metrics">
      <div class="metric-pill">📋 Tasks: <strong>2 pts each</strong></div>
      <div class="metric-pill">🔥 Streak: <strong>5 pts/day</strong></div>
      <div class="metric-pill">📝 Mock Avg: <strong>1 pt/mark</strong></div>
      <div class="metric-pill">⏱️ Hours: <strong>1 pt/hour</strong></div>
    </div>

    <div class="leaderboard-list">
      ${leaderboard.map((user, index) => renderLeaderboardRow(user, index === 0)).join('')}
    </div>

    <div class="leaderboard-footer">
      <span class="leaderboard-updated">Updated: just now</span>
    </div>
  `;
}

/**
 * Render a single leaderboard row
 */
function renderLeaderboardRow(user, isFirst = false) {
  const rankClass = user.rank <= 3 ? `top-${user.rank}` : '';
  const currentUserClass = user.isCurrentUser ? 'current-user' : '';
  
  return `
    <div class="leaderboard-row ${rankClass} ${currentUserClass}" data-uid="${user.uid}">
      <div class="leaderboard-rank">
        ${getRankEmoji(user.rank)}
        <span class="rank-number">#${user.rank}</span>
      </div>
      
      <div class="leaderboard-user">
        <div class="user-avatar">${(user.userName || 'U')[0].toUpperCase()}</div>
        <div class="user-info">
          <div class="user-name">${escapeHtml(user.userName || 'Anonymous')}</div>
          <div class="user-stats">
            <span>📋 ${user.weeklyTasksCompleted}</span>
            <span>🔥 ${user.weeklyStreak}d</span>
            <span>📝 ${user.weeklyMockAvg}</span>
          </div>
        </div>
      </div>
      
      <div class="leaderboard-score">
        <div class="score-value">${user.weeklyScore}</div>
        <div class="score-label">pts</div>
      </div>
      
      ${user.isCurrentUser ? '<div class="you-badge">YOU</div>' : ''}
    </div>
  `;
}

/**
 * Render mini leaderboard for dashboard widget
 */
function renderMiniLeaderboard(leaderboard, maxRows = 5) {
  if (!leaderboard || leaderboard.length === 0) {
    return '<div class="empty-state mini"><p>Be the first on the leaderboard!</p></div>';
  }

  const userRank = leaderboard.find(u => u.isCurrentUser)?.rank;

  let html = leaderboard.slice(0, maxRows).map(user => `
    <div class="mini-leaderboard-row ${user.isCurrentUser ? 'current-user' : ''}">
      <span class="mini-rank">${getRankEmoji(user.rank) || `#${user.rank}`}</span>
      <span class="mini-name">${escapeHtml(user.userName || 'Anonymous')}</span>
      <span class="mini-score">${user.weeklyScore} pts</span>
    </div>
  `).join('');

  // Show user position if not in top
  if (userRank && userRank > maxRows) {
    const userData = leaderboard.find(u => u.isCurrentUser);
    html += `
      <div class="mini-leaderboard-gap">...</div>
      <div class="mini-leaderboard-row current-user">
        <span class="mini-rank">#${userRank}</span>
        <span class="mini-name">${escapeHtml(userData.userName)}</span>
        <span class="mini-score">${userData.weeklyScore} pts</span>
      </div>
    `;
  }

  return html;
}

/**
 * Render global leaderboard for an exam
 */
async function renderGlobalLeaderboard(examId, containerId = 'global-leaderboard') {
  const container = document.getElementById(containerId);
  if (!container) return;

  const weekStart = getWeekStart();
  const leaderboard = await getGlobalLeaderboard(examId, weekStart);
  const examName = ALL_EXAMS[examId]?.fullName || examId.toUpperCase();

  if (leaderboard.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🌍</div>
        <p>No global leaderboard data yet. Join a public group to compete!</p>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="leaderboard-header">
      <h3>🌍 Global ${escapeHtml(examName)} Leaderboard</h3>
      <div class="leaderboard-week">${getWeekLabel(weekStart)} · ${formatWeekRange(weekStart)}</div>
    </div>

    <div class="leaderboard-list">
      ${leaderboard.slice(0, 20).map((user, index) => renderLeaderboardRow(user, index === 0)).join('')}
    </div>

    <div class="leaderboard-footer">
      <span class="leaderboard-note">Based on public group rankings</span>
    </div>
  `;
}

// ── Real-time Subscriptions ────────────────────

/**
 * Subscribe to real-time leaderboard updates
 * Uses leaderboardCache collection populated by Cloud Functions
 */
function subscribeToLeaderboard(groupId) {
  if (!_fbReady || !db || !groupId) return;

  // Unsubscribe existing listener
  if (_leaderboardUnsub[groupId]) {
    _leaderboardUnsub[groupId]();
  }

  const weekStart = getWeekStart();
  const cacheId = `${groupId}_${weekStart}`;

  // Subscribe to leaderboard cache document
  _leaderboardUnsub[groupId] = db.collection('leaderboardCache')
    .doc(cacheId)
    .onSnapshot(snapshot => {
      const container = document.getElementById('group-leaderboard');
      if (!container) return;

      const group = userGroups.find(g => g.id === groupId);
      const groupName = group?.name || 'Study Group';

      if (!snapshot.exists || !snapshot.data().topUsers) {
        // Cache doesn't exist yet - show loading state
        container.innerHTML = `
          <div class="leaderboard-header">
            <h3>🏆 ${escapeHtml(groupName)} Leaderboard</h3>
            <div class="leaderboard-week">${getWeekLabel(weekStart)} · ${formatWeekRange(weekStart)}</div>
          </div>
          <div class="empty-state">
            <div class="empty-icon">⏳</div>
            <p>Loading leaderboard...</p>
          </div>
        `;
        return;
      }

      const cacheData = snapshot.data();
      const leaderboard = cacheData.topUsers.map(user => ({
        ...user,
        isCurrentUser: user.uid === currentUser?.uid
      }));

      container.innerHTML = `
        <div class="leaderboard-header">
          <h3>🏆 ${escapeHtml(groupName)} Leaderboard</h3>
          <div class="leaderboard-week">${getWeekLabel(weekStart)} · ${formatWeekRange(weekStart)}</div>
        </div>
        
        <div class="leaderboard-metrics">
          <div class="metric-pill">📋 Tasks: <strong>2 pts each</strong></div>
          <div class="metric-pill">🔥 Streak: <strong>5 pts/day</strong></div>
          <div class="metric-pill">📝 Mock Avg: <strong>1 pt/mark</strong></div>
        </div>

        <div class="leaderboard-list">
          ${leaderboard.map((user, index) => renderLeaderboardRow(user, index === 0)).join('')}
        </div>
        
        <div class="leaderboard-footer">
          <span class="leaderboard-updated">Updated: ${cacheData.updatedAt?.toDate ? formatTimeAgo(cacheData.updatedAt.toDate()) : 'just now'}</span>
        </div>
      `;
    }, error => {
      console.error('Leaderboard subscription error:', error);
    });
}

/**
 * Format time ago helper
 */
function formatTimeAgo(date) {
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

/**
 * Unsubscribe from leaderboard updates
 */
function unsubscribeFromLeaderboard(groupId) {
  if (_leaderboardUnsub[groupId]) {
    _leaderboardUnsub[groupId]();
    delete _leaderboardUnsub[groupId];
  }
}

/**
 * Unsubscribe from all leaderboard updates
 */
function unsubscribeFromAllLeaderboards() {
  Object.keys(_leaderboardUnsub).forEach(groupId => {
    unsubscribeFromLeaderboard(groupId);
  });
}

// ── Leaderboard Navigation ─────────────────────

/**
 * Switch leaderboard view (group vs global)
 */
function switchLeaderboardView(view, groupId = null) {
  currentLeaderboardView = view;
  
  if (view === 'group' && groupId) {
    selectedLeaderboardGroupId = groupId;
    renderGroupLeaderboard(groupId);
    subscribeToLeaderboard(groupId);
  } else if (view === 'global') {
    unsubscribeFromAllLeaderboards();
    renderGlobalLeaderboard(currentExam);
  }
}

// ── Badge System ───────────────────────────────

/**
 * Get badges for a user based on their stats
 */
function getUserBadges(user) {
  const badges = [];

  // Streak badges
  if (user.weeklyStreak >= 7) badges.push({ icon: '🔥', label: 'Perfect Week' });
  else if (user.weeklyStreak >= 5) badges.push({ icon: '⚡', label: '5-Day Streak' });
  else if (user.weeklyStreak >= 3) badges.push({ icon: '🌟', label: '3-Day Streak' });

  // Task badges
  if (user.weeklyTasksCompleted >= 20) badges.push({ icon: '📋', label: 'Task Master' });
  else if (user.weeklyTasksCompleted >= 10) badges.push({ icon: '✅', label: 'Productive' });

  // Mock badges
  if (user.weeklyMockAvg >= 150) badges.push({ icon: '🎯', label: 'Top Scorer' });
  else if (user.weeklyMockAvg >= 100) badges.push({ icon: '📈', label: 'Rising Star' });

  return badges;
}

/**
 * Render badges HTML
 */
function renderBadges(badges) {
  if (!badges || badges.length === 0) return '';

  return badges.map(badge => `
    <span class="badge" title="${badge.label}">${badge.icon}</span>
  `).join('');
}

// ── Initialize ─────────────────────────────────

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  unsubscribeFromAllLeaderboards();
});
