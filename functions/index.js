/**
 * Cloud Functions for Examen Planner
 * Handles leaderboard caching and stats aggregation
 * 
 * Deploy: firebase deploy --only functions
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');

// Initialize Firebase Admin
admin.initializeApp();

const db = admin.firestore();

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

const WEEKLY_SCORE_WEIGHTS = {
  TASKS: 2,        // 2 pts per task
  STREAK: 5,       // 5 pts per streak day
  MOCK_AVG: 1,     // 1 pt per mock avg mark
  STUDY_HOURS: 1,  // 1 pt per study hour
  CONSISTENCY: 10  // 10 pts bonus for all 7 days active
};

// ─────────────────────────────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────────────────────────────

/**
 * Get the start of the current week (Monday 00:00:00 IST)
 */
function getWeekStart(date = new Date()) {
  const d = new Date(date);
  // Convert to IST (UTC+5:30)
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istTime = new Date(d.getTime() + istOffset);
  
  const day = istTime.getUTCDay();
  const diff = istTime.getUTCDate() - day + (day === 0 ? -6 : 1);
  
  const weekStart = new Date(istTime);
  weekStart.setUTCDate(diff);
  weekStart.setUTCHours(0, 0, 0, 0);
  
  // Convert back to ISO date string (YYYY-MM-DD)
  return weekStart.toISOString().slice(0, 10);
}

/**
 * Get week number (1-52)
 */
function getWeekNumber(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

/**
 * Calculate weekly score from stats
 */
function calculateWeeklyScore(stats) {
  const tasks = stats.weeklyTasksCompleted || 0;
  const streak = stats.weeklyStreak || 0;
  const mockAvg = stats.weeklyMockAvg || 0;
  const hours = stats.weeklyStudyHours || 0;
  const consistency = stats.consistencyBonus || 0;

  return (tasks * WEEKLY_SCORE_WEIGHTS.TASKS) +
         (streak * WEEKLY_SCORE_WEIGHTS.STREAK) +
         (mockAvg * WEEKLY_SCORE_WEIGHTS.MOCK_AVG) +
         (hours * WEEKLY_SCORE_WEIGHTS.STUDY_HOURS) +
         consistency;
}

/**
 * Generate leaderboard cache ID
 */
function getLeaderboardCacheId(groupId, weekStart) {
  return `${groupId}_${weekStart}`;
}

/**
 * Generate global leaderboard cache ID
 */
function getGlobalLeaderboardCacheId(examId, weekStart) {
  return `${examId}_${weekStart}`;
}

// ─────────────────────────────────────────────────────────────
// TRIGGERED FUNCTIONS
// ─────────────────────────────────────────────────────────────

/**
 * Trigger: When groupStats document is created/updated
 * Action: Update the group's leaderboard cache
 */
exports.onGroupStatsUpdate = functions.firestore
  .document('groupStats/{statId}')
  .onWrite(async (change, context) => {
    const statId = context.params.statId;
    
    // Get the stats data (from after if update, from before if delete)
    const statsData = change.after.exists ? change.after.data() : change.before.data();
    
    if (!statsData) {
      functions.logger.warn(`No stats data for ${statId}`);
      return null;
    }

    const { groupId, weekStart } = statsData;
    
    if (!groupId || !weekStart) {
      functions.logger.warn(`Missing groupId or weekStart in ${statId}`);
      return null;
    }

    try {
      // Recalculate the group's leaderboard
      await updateGroupLeaderboardCache(groupId, weekStart);
      
      // Also update global leaderboard if group is public
      const groupDoc = await db.collection('groups').doc(groupId).get();
      if (groupDoc.exists && groupDoc.data().isPublic) {
        await updateGlobalLeaderboardCache(groupDoc.data().examId, weekStart);
      }
      
      functions.logger.info(`Updated leaderboard cache for group ${groupId}`);
      return null;
    } catch (error) {
      functions.logger.error(`Error updating leaderboard for ${groupId}:`, error);
      return null;
    }
  });

/**
 * Trigger: When a group is created or updated
 * Action: Initialize leaderboard cache for new groups
 */
exports.onGroupWrite = functions.firestore
  .document('groups/{groupId}')
  .onWrite(async (change, context) => {
    const groupId = context.params.groupId;
    
    if (!change.after.exists) {
      // Group was deleted - cleanup leaderboard caches
      const weekStart = getWeekStart();
      await db.collection('leaderboardCache').doc(getLeaderboardCacheId(groupId, weekStart)).delete();
      functions.logger.info(`Cleaned up leaderboard cache for deleted group ${groupId}`);
      return null;
    }

    const groupData = change.after.data();
    
    // Only update if group is public (global leaderboard needs update)
    if (groupData.isPublic && groupData.examId) {
      const weekStart = getWeekStart();
      await updateGlobalLeaderboardCache(groupData.examId, weekStart);
    }
    
    return null;
  });

// ─────────────────────────────────────────────────────────────
// SCHEDULED FUNCTIONS
// ─────────────────────────────────────────────────────────────

/**
 * Scheduled: Every hour, refresh all leaderboard caches
 * Runs at minute 0 of every hour
 */
exports.hourlyLeaderboardRefresh = functions.pubsub
  .schedule('0 * * * *')
  .timeZone('Asia/Kolkata')
  .onRun(async (context) => {
    const weekStart = getWeekStart();
    functions.logger.info(`Hourly leaderboard refresh started for week ${weekStart}`);

    try {
      // Get all groups
      const groupsSnapshot = await db.collection('groups').get();
      
      const batch = db.batch();
      let updateCount = 0;

      for (const groupDoc of groupsSnapshot.docs) {
        const groupId = groupDoc.id;
        const groupData = groupDoc.data();
        
        // Update group leaderboard
        await updateGroupLeaderboardCache(groupId, weekStart);
        updateCount++;
        
        // Update global leaderboard for public groups
        if (groupData.isPublic && groupData.examId) {
          await updateGlobalLeaderboardCache(groupData.examId, weekStart);
        }
      }

      functions.logger.info(`Refreshed ${updateCount} group leaderboards`);
      return null;
    } catch (error) {
      functions.logger.error('Error in hourly leaderboard refresh:', error);
      return null;
    }
  });

/**
 * Scheduled: Daily at 00:05 IST, archive previous week's leaderboards
 * This creates a historical record of weekly leaderboards
 */
exports.dailyLeaderboardArchive = functions.pubsub
  .schedule('5 0 * * *')
  .timeZone('Asia/Kolkata')
  .onRun(async (context) => {
    const today = new Date();
    const weekStart = getWeekStart(today);
    
    // Check if today is Monday (new week started)
    const dayOfWeek = new Date(today.getTime() + (5.5 * 60 * 60 * 1000)).getUTCDay();
    
    if (dayOfWeek === 1) {
      functions.logger.info('New week detected - archiving previous week leaderboards');
      
      // Get previous week start
      const prevWeek = new Date(today);
      prevWeek.setDate(prevWeek.getDate() - 7);
      const prevWeekStart = getWeekStart(prevWeek);
      
      // Archive logic: mark leaderboards as archived
      const cacheSnapshot = await db.collection('leaderboardCache')
        .where('weekStart', '==', prevWeekStart)
        .get();
      
      const batch = db.batch();
      cacheSnapshot.docs.forEach(doc => {
        batch.update(doc.ref, { archived: true, archivedAt: admin.firestore.FieldValue.serverTimestamp() });
      });
      
      await batch.commit();
      functions.logger.info(`Archived ${cacheSnapshot.size} leaderboard entries for week ${prevWeekStart}`);
    }
    
    return null;
  });

// ─────────────────────────────────────────────────────────────
// HTTP FUNCTIONS (Callable)
// ─────────────────────────────────────────────────────────────

/**
 * Callable: Manually refresh a group's leaderboard
 * Can be called from client to force refresh
 */
exports.refreshGroupLeaderboard = functions.https.onCall(async (data, context) => {
  // Verify user is authenticated
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
  }

  const { groupId } = data;
  if (!groupId) {
    throw new functions.https.HttpsError('invalid-argument', 'groupId is required');
  }

  try {
    const weekStart = getWeekStart();
    await updateGroupLeaderboardCache(groupId, weekStart);
    
    return { success: true, weekStart };
  } catch (error) {
    functions.logger.error(`Error refreshing leaderboard for ${groupId}:`, error);
    throw new functions.https.HttpsError('internal', 'Failed to refresh leaderboard');
  }
});

/**
 * Callable: Get user's rank across all their groups
 */
exports.getUserRanks = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
  }

  const uid = context.auth.uid;
  const weekStart = getWeekStart();

  try {
    // Get user's groups
    const groupsSnapshot = await db.collection('groups')
      .where('members', 'array-contains', uid)
      .get();

    const ranks = [];

    for (const groupDoc of groupsSnapshot.docs) {
      const groupId = groupDoc.id;
      const groupName = groupDoc.data().name;
      
      // Get leaderboard cache
      const cacheDoc = await db.collection('leaderboardCache')
        .doc(getLeaderboardCacheId(groupId, weekStart))
        .get();

      if (cacheDoc.exists) {
        const cache = cacheDoc.data();
        const userEntry = (cache.topUsers || []).find(u => u.uid === uid);
        
        ranks.push({
          groupId,
          groupName,
          rank: userEntry?.rank || null,
          score: userEntry?.weeklyScore || 0
        });
      }
    }

    return { ranks, weekStart };
  } catch (error) {
    functions.logger.error('Error getting user ranks:', error);
    throw new functions.https.HttpsError('internal', 'Failed to get user ranks');
  }
});

// ─────────────────────────────────────────────────────────────
// HELPER FUNCTIONS FOR LEADERBOARD UPDATES
// ─────────────────────────────────────────────────────────────

/**
 * Update leaderboard cache for a specific group
 */
async function updateGroupLeaderboardCache(groupId, weekStart) {
  // Get all stats for this group and week
  const statsSnapshot = await db.collection('groupStats')
    .where('groupId', '==', groupId)
    .where('weekStart', '==', weekStart)
    .get();

  // Build leaderboard array
  const leaderboard = [];
  
  statsSnapshot.docs.forEach(doc => {
    const data = doc.data();
    leaderboard.push({
      uid: data.uid,
      userName: data.userName || 'Anonymous',
      weeklyTasksCompleted: data.weeklyTasksCompleted || 0,
      weeklyStreak: data.weeklyStreak || 0,
      weeklyMockAvg: data.weeklyMockAvg || 0,
      weeklyStudyHours: data.weeklyStudyHours || 0,
      weeklyScore: data.weeklyScore || calculateWeeklyScore(data),
      updatedAt: data.updatedAt || null
    });
  });

  // Sort by score descending
  leaderboard.sort((a, b) => b.weeklyScore - a.weeklyScore);

  // Add ranks
  leaderboard.forEach((entry, index) => {
    entry.rank = index + 1;
  });

  // Update cache
  const cacheRef = db.collection('leaderboardCache').doc(getLeaderboardCacheId(groupId, weekStart));
  
  await cacheRef.set({
    groupId,
    weekStart,
    topUsers: leaderboard,
    memberCount: leaderboard.length,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  return leaderboard;
}

/**
 * Update global leaderboard cache for an exam
 */
async function updateGlobalLeaderboardCache(examId, weekStart) {
  if (!examId) return;

  // Get all public groups for this exam
  const groupsSnapshot = await db.collection('groups')
    .where('examId', '==', examId)
    .where('isPublic', '==', true)
    .get();

  // Aggregate stats across all groups
  const userStatsMap = new Map();

  for (const groupDoc of groupsSnapshot.docs) {
    const groupId = groupDoc.id;
    
    // Get stats for this group
    const statsSnapshot = await db.collection('groupStats')
      .where('groupId', '==', groupId)
      .where('weekStart', '==', weekStart)
      .get();

    statsSnapshot.docs.forEach(doc => {
      const data = doc.data();
      const uid = data.uid;

      // If user appears in multiple groups, keep their best score
      if (!userStatsMap.has(uid)) {
        userStatsMap.set(uid, {
          uid,
          userName: data.userName || 'Anonymous',
          weeklyTasksCompleted: data.weeklyTasksCompleted || 0,
          weeklyStreak: data.weeklyStreak || 0,
          weeklyMockAvg: data.weeklyMockAvg || 0,
          weeklyStudyHours: data.weeklyStudyHours || 0,
          weeklyScore: data.weeklyScore || 0
        });
      } else {
        const existing = userStatsMap.get(uid);
        // Keep the higher score
        if ((data.weeklyScore || 0) > existing.weeklyScore) {
          userStatsMap.set(uid, {
            uid,
            userName: data.userName || 'Anonymous',
            weeklyTasksCompleted: data.weeklyTasksCompleted || 0,
            weeklyStreak: data.weeklyStreak || 0,
            weeklyMockAvg: data.weeklyMockAvg || 0,
            weeklyStudyHours: data.weeklyStudyHours || 0,
            weeklyScore: data.weeklyScore || 0
          });
        }
      }
    });
  }

  // Build sorted leaderboard
  const leaderboard = Array.from(userStatsMap.values())
    .sort((a, b) => b.weeklyScore - a.weeklyScore)
    .slice(0, 100); // Top 100

  // Add ranks
  leaderboard.forEach((entry, index) => {
    entry.rank = index + 1;
  });

  // Update cache
  const cacheRef = db.collection('globalLeaderboard').doc(getGlobalLeaderboardCacheId(examId, weekStart));
  
  await cacheRef.set({
    examId,
    weekStart,
    topUsers: leaderboard,
    totalParticipants: userStatsMap.size,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  return leaderboard;
}
