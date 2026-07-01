/* ══════════════════════════════════════════════
   SOCIAL SYNC — Stats Synchronization
   Sync user progress to group stats for leaderboards
══════════════════════════════════════════════ */

// ── State ──────────────────────────────────────
let _syncDebounce = null;
let _lastSyncedStats = null;

// ── Helper Functions ───────────────────────────

/**
 * Get the start of the current week (Monday 00:00:00)
 */
function getWeekStart(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

/**
 * Get the week number (1-52)
 */
function getWeekNumber(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

/**
 * Count tasks completed this week
 */
function countWeeklyTasks() {
  const weekStart = new Date(getWeekStart());
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  let count = 0;
  const tasks = appState.tasks || {};

  Object.keys(tasks).forEach(subjectId => {
    const subjectTasks = tasks[subjectId];
    if (Array.isArray(subjectTasks)) {
      subjectTasks.forEach(task => {
        if (task.completed) {
          const completedDate = task.completedAt ? new Date(task.completedAt) : null;
          if (completedDate && completedDate >= weekStart && completedDate < weekEnd) {
            count++;
          }
        }
      });
    }
  });

  return count;
}

/**
 * Calculate average mock score from last N mocks
 */
function calculateMockAverage(examId = null, count = 3) {
  const exam = examId || currentExam || 'cgl';
  const mocks = (appState.mocks?.[exam]?.t1 || [])
    .slice(-count)
    .map(m => m.total);

  if (mocks.length === 0) return 0;
  return Math.round(mocks.reduce((a, b) => a + b, 0) / mocks.length);
}

/**
 * Estimate study hours from habits log
 */
function estimateStudyHours() {
  const weekStart = getWeekStart();
  const habitsLog = appState.habitsLog || {};

  // Count days with activity this week
  let activeDays = 0;
  Object.keys(habitsLog).forEach(dateStr => {
    if (dateStr >= weekStart) {
      const dayLog = habitsLog[dateStr];
      if (typeof dayLog === 'object') {
        const hasActivity = Object.values(dayLog).some(v => v === true);
        if (hasActivity) activeDays++;
      }
    }
  });

  // Estimate ~4 hours per active day (rough estimate)
  // This can be enhanced with actual time tracking
  return activeDays * 4;
}

/**
 * Calculate consistency bonus (all 7 days active)
 */
function calculateConsistencyBonus() {
  const weekStart = getWeekStart();
  const today = new Date();
  const daysSinceWeekStart = Math.floor((today - new Date(weekStart)) / (1000 * 60 * 60 * 24));
  
  // Check if today is after Sunday (end of week)
  if (today.getDay() === 0) {
    // It's Sunday - check if all days were active
    const habitsLog = appState.habitsLog || {};
    let activeDays = 0;
    
    for (let i = 0; i < 7; i++) {
      const date = new Date(weekStart);
      date.setDate(date.getDate() + i);
      const dateStr = date.toISOString().slice(0, 10);
      const dayLog = habitsLog[dateStr];
      if (dayLog && typeof dayLog === 'object') {
        const hasActivity = Object.values(dayLog).some(v => v === true);
        if (hasActivity) activeDays++;
      }
    }

    return activeDays >= 7 ? 10 : 0;
  }

  return 0;
}

// ── Stats Calculation ──────────────────────────

/**
 * Calculate all weekly stats for the current user
 */
function calculateWeeklyStats() {
  const weeklyTasks = countWeeklyTasks();
  const streak = appState.streak || 0;
  const mockAvg = calculateMockAverage();
  const studyHours = estimateStudyHours();
  const consistencyBonus = calculateConsistencyBonus();

  // Score calculation:
  // - Tasks: 2 pts each
  // - Streak: 5 pts per day
  // - Mock avg: 1 pt per mark
  // - Study hours: 1 pt per hour
  // - Consistency bonus: 10 pts if all 7 days active
  const weeklyScore = (weeklyTasks * 2) + (streak * 5) + mockAvg + studyHours + consistencyBonus;

  return {
    weeklyTasksCompleted: weeklyTasks,
    weeklyStreak: streak,
    weeklyMockAvg: mockAvg,
    weeklyStudyHours: studyHours,
    weeklyScore,
    consistencyBonus
  };
}

/**
 * Check if stats have changed since last sync
 */
function haveStatsChanged(newStats) {
  if (!_lastSyncedStats) return true;
  
  return JSON.stringify(_lastSyncedStats) !== JSON.stringify({
    weeklyTasksCompleted: newStats.weeklyTasksCompleted,
    weeklyStreak: newStats.weeklyStreak,
    weeklyMockAvg: newStats.weeklyMockAvg,
    weeklyStudyHours: newStats.weeklyStudyHours,
    weeklyScore: newStats.weeklyScore
  });
}

// ── Sync Functions ─────────────────────────────

/**
 * Sync user stats to all their groups
 */
async function syncUserGroupStats() {
  if (!_fbReady || !db || !currentUser || userGroups.length === 0) return;

  const stats = calculateWeeklyStats();
  
  // Skip if nothing changed
  if (!haveStatsChanged(stats)) return;

  const weekStart = getWeekStart();
  const batch = db.batch();

  userGroups.forEach(group => {
    const statRef = db.collection('groupStats').doc(`${group.id}_${currentUser.uid}_${weekStart}`);
    
    batch.set(statRef, {
      groupId: group.id,
      uid: currentUser.uid,
      userName: currentUser.name,
      weekStart,
      ...stats,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });

  try {
    await batch.commit();
    _lastSyncedStats = {
      weeklyTasksCompleted: stats.weeklyTasksCompleted,
      weeklyStreak: stats.weeklyStreak,
      weeklyMockAvg: stats.weeklyMockAvg,
      weeklyStudyHours: stats.weeklyStudyHours,
      weeklyScore: stats.weeklyScore
    };
  } catch (e) {
    console.error('Error syncing group stats:', e);
  }
}

/**
 * Schedule a debounced stats sync
 */
function scheduleStatsSync() {
  if (!currentUser || userGroups.length === 0) return;

  clearTimeout(_syncDebounce);
  _syncDebounce = setTimeout(() => syncUserGroupStats(), 3000);
}

/**
 * Force immediate stats sync
 */
async function forceStatsSync() {
  clearTimeout(_syncDebounce);
  await syncUserGroupStats();
}

// ── Leaderboard Calculation ────────────────────

/**
 * Get leaderboard for a specific group
 * @param {string} groupId - Group ID
 * @param {string} weekStart - Week start date (YYYY-MM-DD)
 */
async function getGroupLeaderboard(groupId, weekStart = null) {
  if (!_fbReady || !db) return [];

  const week = weekStart || getWeekStart();

  try {
    const snapshot = await db.collection('groupStats')
      .where('groupId', '==', groupId)
      .where('weekStart', '==', week)
      .orderBy('weeklyScore', 'desc')
      .limit(50)
      .get();

    return snapshot.docs.map((doc, index) => {
      const data = doc.data();
      return {
        rank: index + 1,
        uid: data.uid,
        userName: data.userName,
        weeklyTasksCompleted: data.weeklyTasksCompleted || 0,
        weeklyStreak: data.weeklyStreak || 0,
        weeklyMockAvg: data.weeklyMockAvg || 0,
        weeklyStudyHours: data.weeklyStudyHours || 0,
        weeklyScore: data.weeklyScore || 0,
        isCurrentUser: data.uid === currentUser?.uid
      };
    });
  } catch (e) {
    console.error('Error fetching group leaderboard:', e);
    return [];
  }
}

/**
 * Get global leaderboard for an exam
 * @param {string} examId - Exam ID
 * @param {string} weekStart - Week start date (YYYY-MM-DD)
 */
async function getGlobalLeaderboard(examId = null, weekStart = null) {
  if (!_fbReady || !db) return [];

  const week = weekStart || getWeekStart();
  const exam = examId || currentExam || 'cgl';
  const cacheId = `${exam}_${week}`;

  try {
    // Try cache first
    const cacheDoc = await db.collection('leaderboardCache').doc(cacheId).get();
    
    if (cacheDoc.exists) {
      return cacheDoc.data().topUsers || [];
    }

    // No cache - compute on client (for now)
    // In production, this should be done by Cloud Functions
    const groupsSnapshot = await db.collection('groups')
      .where('examId', '==', exam)
      .where('isPublic', '==', true)
      .get();

    const allStats = new Map();

    for (const groupDoc of groupsSnapshot.docs) {
      const statsSnapshot = await db.collection('groupStats')
        .where('groupId', '==', groupDoc.id)
        .where('weekStart', '==', week)
        .get();

      statsSnapshot.docs.forEach(doc => {
        const data = doc.data();
        const uid = data.uid;
        
        // Aggregate scores for users in multiple groups
        if (!allStats.has(uid)) {
          allStats.set(uid, {
            uid,
            userName: data.userName,
            weeklyTasksCompleted: data.weeklyTasksCompleted || 0,
            weeklyStreak: data.weeklyStreak || 0,
            weeklyMockAvg: data.weeklyMockAvg || 0,
            weeklyStudyHours: data.weeklyStudyHours || 0,
            weeklyScore: data.weeklyScore || 0,
            isCurrentUser: uid === currentUser?.uid
          });
        } else {
          const existing = allStats.get(uid);
          existing.weeklyScore = Math.max(existing.weeklyScore, data.weeklyScore || 0);
        }
      });
    }

    // Sort by score and return top 50
    return Array.from(allStats.values())
      .sort((a, b) => b.weeklyScore - a.weeklyScore)
      .slice(0, 50)
      .map((user, index) => ({ ...user, rank: index + 1 }));

  } catch (e) {
    console.error('Error fetching global leaderboard:', e);
    return [];
  }
}

/**
 * Get user's rank in a group
 * @param {string} groupId - Group ID
 */
async function getUserGroupRank(groupId) {
  if (!_fbReady || !db || !currentUser) return null;

  const leaderboard = await getGroupLeaderboard(groupId);
  const userEntry = leaderboard.find(u => u.uid === currentUser.uid);
  
  return userEntry ? userEntry.rank : null;
}

// ── Hook into Progress Save ────────────────────

// Monkey-patch saveProgress to also sync group stats
const _originalSaveProgress = typeof saveProgress === 'function' ? saveProgress : null;

if (_originalSaveProgress) {
  window.saveProgress = function() {
    _originalSaveProgress.apply(this, arguments);
    scheduleStatsSync();
  };
}

// ── Periodic Sync ──────────────────────────────

// Sync stats every 5 minutes when user is active
setInterval(() => {
  if (currentUser && userGroups.length > 0) {
    syncUserGroupStats();
  }
}, 5 * 60 * 1000);

// Sync on page visibility change
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentUser && userGroups.length > 0) {
    syncUserGroupStats();
  }
});

// Sync before page unload
window.addEventListener('beforeunload', () => {
  if (currentUser && userGroups.length > 0) {
    forceStatsSync();
  }
});
