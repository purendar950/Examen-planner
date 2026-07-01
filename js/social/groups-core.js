/* ══════════════════════════════════════════════
   STUDY GROUPS — CORE FUNCTIONS
   Peer study groups for exam preparation accountability
══════════════════════════════════════════════ */

// ── State ──────────────────────────────────────
let userGroups = [];
let _groupsUnsub = null;

// ── Helper Functions ───────────────────────────

/**
 * Get the start of the current week (Monday 00:00:00)
 */
function getWeekStart(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust for Sunday
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

/**
 * Generate a random invite code
 */
function generateInviteCode(length = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Removed confusing chars
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/**
 * Validate group name
 */
function validateGroupName(name) {
  if (!name || typeof name !== 'string') return { valid: false, error: 'Group name is required.' };
  if (name.length < 3) return { valid: false, error: 'Group name must be at least 3 characters.' };
  if (name.length > 50) return { valid: false, error: 'Group name must be under 50 characters.' };
  if (!/^[a-zA-Z0-9\s\-_]+$/.test(name)) return { valid: false, error: 'Only letters, numbers, spaces, - and _ allowed.' };
  return { valid: true };
}

// ── Group CRUD Operations ──────────────────────

/**
 * Create a new study group
 * @param {Object} options - Group options
 * @param {string} options.name - Group name
 * @param {string} options.examId - Exam ID (e.g., 'upsc', 'cgl')
 * @param {number} options.targetYear - Target exam year
 * @param {boolean} options.isPublic - Whether group is publicly discoverable
 * @param {string} options.description - Optional group description
 * @param {number} options.maxMembers - Maximum members (default: 50)
 */
async function createGroup(options) {
  if (!_fbReady || !db || !currentUser) {
    showToast('Firebase not configured. Cannot create group.', 'error');
    return null;
  }

  // Validate inputs
  const validation = validateGroupName(options.name);
  if (!validation.valid) {
    showToast(validation.error, 'error');
    return null;
  }

  if (!ALL_EXAMS[options.examId]) {
    showToast('Invalid exam selected.', 'error');
    return null;
  }

  const maxMembers = options.maxMembers || 50;
  if (maxMembers < 2 || maxMembers > 100) {
    showToast('Group size must be between 2 and 100.', 'error');
    return null;
  }

  try {
    const groupData = {
      name: options.name.trim(),
      examId: options.examId,
      targetYear: options.targetYear || new Date().getFullYear(),
      isPublic: options.isPublic !== false,
      description: (options.description || '').trim().slice(0, 200),
      maxMembers,
      createdBy: currentUser.uid,
      members: [currentUser.uid],
      memberNames: { [currentUser.uid]: currentUser.name },
      inviteCode: options.isPublic === false ? generateInviteCode() : null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    const docRef = await db.collection('groups').add(groupData);

    // Create initial stats for the creator
    const weekStart = getWeekStart();
    await db.collection('groupStats').doc(`${docRef.id}_${currentUser.uid}_${weekStart}`).set({
      groupId: docRef.id,
      uid: currentUser.uid,
      userName: currentUser.name,
      weekStart,
      weeklyTasksCompleted: 0,
      weeklyStreak: appState.streak || 0,
      weeklyMockAvg: 0,
      weeklyStudyHours: 0,
      weeklyScore: (appState.streak || 0) * 5,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    showToast(`Group "${options.name}" created! 🎉`, 'success');
    
    // Refresh user groups
    await loadUserGroups();

    return { id: docRef.id, ...groupData };
  } catch (e) {
    console.error('Error creating group:', e);
    showToast('Failed to create group: ' + e.message, 'error');
    return null;
  }
}

/**
 * Join a study group
 * @param {string} groupId - Group ID to join
 * @param {string} inviteCode - Optional invite code for private groups
 */
async function joinGroup(groupId, inviteCode = null) {
  if (!_fbReady || !db || !currentUser) {
    showToast('Firebase not configured.', 'error');
    return false;
  }

  try {
    const groupRef = db.collection('groups').doc(groupId);
    const groupSnap = await groupRef.get();

    if (!groupSnap.exists) {
      showToast('Group not found.', 'error');
      return false;
    }

    const groupData = groupSnap.data();

    // Check if already a member
    if (groupData.members && groupData.members.includes(currentUser.uid)) {
      showToast('You are already a member of this group.', 'info');
      return true;
    }

    // Check group size
    if (groupData.members && groupData.members.length >= groupData.maxMembers) {
      showToast('This group is full.', 'error');
      return false;
    }

    // Check invite code for private groups
    if (!groupData.isPublic) {
      if (!inviteCode) {
        showToast('This group requires an invite code.', 'error');
        return false;
      }
      if (inviteCode.toUpperCase() !== groupData.inviteCode) {
        showToast('Invalid invite code.', 'error');
        return false;
      }
    }

    // Add user to group
    await groupRef.update({
      members: firebase.firestore.FieldValue.arrayUnion(currentUser.uid),
      [`memberNames.${currentUser.uid}`]: currentUser.name,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    // Create initial stats for the new member
    const weekStart = getWeekStart();
    await db.collection('groupStats').doc(`${groupId}_${currentUser.uid}_${weekStart}`).set({
      groupId,
      uid: currentUser.uid,
      userName: currentUser.name,
      weekStart,
      weeklyTasksCompleted: 0,
      weeklyStreak: appState.streak || 0,
      weeklyMockAvg: 0,
      weeklyStudyHours: 0,
      weeklyScore: (appState.streak || 0) * 5,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    showToast(`Joined "${groupData.name}"! 🎉`, 'success');
    
    // Refresh user groups
    await loadUserGroups();

    return true;
  } catch (e) {
    console.error('Error joining group:', e);
    showToast('Failed to join group: ' + e.message, 'error');
    return false;
  }
}

/**
 * Leave a study group
 * @param {string} groupId - Group ID to leave
 */
async function leaveGroup(groupId) {
  if (!_fbReady || !db || !currentUser) {
    showToast('Firebase not configured.', 'error');
    return false;
  }

  try {
    const groupRef = db.collection('groups').doc(groupId);
    const groupSnap = await groupRef.get();

    if (!groupSnap.exists) {
      showToast('Group not found.', 'error');
      return false;
    }

    const groupData = groupSnap.data();

    // Check if user is a member
    if (!groupData.members || !groupData.members.includes(currentUser.uid)) {
      showToast('You are not a member of this group.', 'error');
      return false;
    }

    // Check if user is the creator
    if (groupData.createdBy === currentUser.uid) {
      // If creator, either delete group or transfer ownership
      if (groupData.members.length === 1) {
        // Only member - delete group
        await groupRef.delete();
        showToast('Group deleted.', 'info');
      } else {
        // Transfer ownership to next member
        const newOwner = groupData.members.find(m => m !== currentUser.uid);
        await groupRef.update({
          createdBy: newOwner,
          members: firebase.firestore.FieldValue.arrayRemove(currentUser.uid),
          [`memberNames.${currentUser.uid}`]: firebase.firestore.FieldValue.delete(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        showToast(`Left group. Ownership transferred.`, 'info');
      }
    } else {
      // Regular member - just leave
      await groupRef.update({
        members: firebase.firestore.FieldValue.arrayRemove(currentUser.uid),
        [`memberNames.${currentUser.uid}`]: firebase.firestore.FieldValue.delete(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      showToast(`Left "${groupData.name}".`, 'info');
    }

    // Refresh user groups
    await loadUserGroups();

    return true;
  } catch (e) {
    console.error('Error leaving group:', e);
    showToast('Failed to leave group: ' + e.message, 'error');
    return false;
  }
}

/**
 * Get public groups for an exam
 * @param {string} examId - Exam ID to filter by
 * @param {number} limit - Maximum number of groups to return
 */
async function getPublicGroups(examId = null, limit = 20) {
  if (!_fbReady || !db) return [];

  try {
    let query = db.collection('groups').where('isPublic', '==', true);

    if (examId) {
      query = query.where('examId', '==', examId);
    }

    const snapshot = await query.orderBy('createdAt', 'desc').limit(limit).get();

    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      createdAt: doc.data().createdAt?.toDate?.()?.toISOString?.() || doc.data().createdAt
    }));
  } catch (e) {
    console.error('Error fetching public groups:', e);
    return [];
  }
}

/**
 * Load all groups the current user belongs to
 */
async function loadUserGroups() {
  if (!_fbReady || !db || !currentUser) {
    userGroups = [];
    return [];
  }

  try {
    const snapshot = await db.collection('groups')
      .where('members', 'array-contains', currentUser.uid)
      .orderBy('updatedAt', 'desc')
      .get();

    userGroups = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      createdAt: doc.data().createdAt?.toDate?.()?.toISOString?.() || doc.data().createdAt
    }));

    return userGroups;
  } catch (e) {
    console.error('Error loading user groups:', e);
    userGroups = [];
    return [];
  }
}

/**
 * Get group details
 * @param {string} groupId - Group ID
 */
async function getGroupDetails(groupId) {
  if (!_fbReady || !db) return null;

  try {
    const doc = await db.collection('groups').doc(groupId).get();

    if (!doc.exists) return null;

    return {
      id: doc.id,
      ...doc.data(),
      createdAt: doc.data().createdAt?.toDate?.()?.toISOString?.() || doc.data().createdAt
    };
  } catch (e) {
    console.error('Error fetching group details:', e);
    return null;
  }
}

/**
 * Join group by invite code
 * @param {string} inviteCode - Invite code
 */
async function joinGroupByInviteCode(inviteCode) {
  if (!_fbReady || !db || !currentUser) {
    showToast('Firebase not configured.', 'error');
    return false;
  }

  try {
    const code = inviteCode.toUpperCase().trim();
    
    // Find group with this invite code
    const snapshot = await db.collection('groups')
      .where('inviteCode', '==', code)
      .limit(1)
      .get();

    if (snapshot.empty) {
      showToast('Invalid invite code.', 'error');
      return false;
    }

    const groupDoc = snapshot.docs[0];
    return await joinGroup(groupDoc.id, code);
  } catch (e) {
    console.error('Error joining group by invite code:', e);
    showToast('Failed to join group: ' + e.message, 'error');
    return false;
  }
}

/**
 * Update group settings (creator only)
 * @param {string} groupId - Group ID
 * @param {Object} updates - Fields to update
 */
async function updateGroup(groupId, updates) {
  if (!_fbReady || !db || !currentUser) {
    showToast('Firebase not configured.', 'error');
    return false;
  }

  try {
    const groupRef = db.collection('groups').doc(groupId);
    const groupSnap = await groupRef.get();

    if (!groupSnap.exists) {
      showToast('Group not found.', 'error');
      return false;
    }

    const groupData = groupSnap.data();

    if (groupData.createdBy !== currentUser.uid) {
      showToast('Only the group creator can update settings.', 'error');
      return false;
    }

    // Validate name if provided
    if (updates.name) {
      const validation = validateGroupName(updates.name);
      if (!validation.valid) {
        showToast(validation.error, 'error');
        return false;
      }
    }

    const allowedUpdates = {};
    if (updates.name) allowedUpdates.name = updates.name.trim();
    if (updates.description !== undefined) allowedUpdates.description = updates.description.trim().slice(0, 200);
    if (updates.maxMembers !== undefined) {
      if (updates.maxMembers < groupData.members.length) {
        showToast(`Cannot reduce size below current member count (${groupData.members.length}).`, 'error');
        return false;
      }
      allowedUpdates.maxMembers = updates.maxMembers;
    }
    allowedUpdates.updatedAt = firebase.firestore.FieldValue.serverTimestamp();

    await groupRef.update(allowedUpdates);
    showToast('Group updated!', 'success');
    
    await loadUserGroups();
    return true;
  } catch (e) {
    console.error('Error updating group:', e);
    showToast('Failed to update group: ' + e.message, 'error');
    return false;
  }
}

/**
 * Remove a member from group (creator only)
 * @param {string} groupId - Group ID
 * @param {string} memberUid - Member UID to remove
 */
async function removeGroupMember(groupId, memberUid) {
  if (!_fbReady || !db || !currentUser) {
    showToast('Firebase not configured.', 'error');
    return false;
  }

  try {
    const groupRef = db.collection('groups').doc(groupId);
    const groupSnap = await groupRef.get();

    if (!groupSnap.exists) {
      showToast('Group not found.', 'error');
      return false;
    }

    const groupData = groupSnap.data();

    if (groupData.createdBy !== currentUser.uid) {
      showToast('Only the group creator can remove members.', 'error');
      return false;
    }

    if (memberUid === currentUser.uid) {
      showToast('Use "Leave Group" to remove yourself.', 'error');
      return false;
    }

    await groupRef.update({
      members: firebase.firestore.FieldValue.arrayRemove(memberUid),
      [`memberNames.${memberUid}`]: firebase.firestore.FieldValue.delete(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    showToast('Member removed.', 'info');
    await loadUserGroups();
    return true;
  } catch (e) {
    console.error('Error removing member:', e);
    showToast('Failed to remove member: ' + e.message, 'error');
    return false;
  }
}

// ── Real-time Listeners ─────────────────────────

/**
 * Subscribe to real-time updates for user's groups
 */
function subscribeToUserGroups() {
  if (!_fbReady || !db || !currentUser) return;

  // Unsubscribe existing listener
  if (_groupsUnsub) {
    _groupsUnsub();
    _groupsUnsub = null;
  }

  _groupsUnsub = db.collection('groups')
    .where('members', 'array-contains', currentUser.uid)
    .onSnapshot(snapshot => {
      userGroups = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
        createdAt: doc.data().createdAt?.toDate?.()?.toISOString?.() || doc.data().createdAt
      }));

      // Update UI if on groups page
      if (typeof renderGroupsPage === 'function') {
        renderGroupsPage();
      }

      // Update dashboard widget
      if (typeof renderGroupsDashboardWidget === 'function') {
        renderGroupsDashboardWidget();
      }
    }, error => {
      console.error('Groups subscription error:', error);
    });
}

/**
 * Unsubscribe from groups listener
 */
function unsubscribeFromGroups() {
  if (_groupsUnsub) {
    _groupsUnsub();
    _groupsUnsub = null;
  }
}

// ── Initialize on load ────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Subscribe when user logs in
  const checkAuth = setInterval(() => {
    if (currentUser && _fbReady) {
      clearInterval(checkAuth);
      loadUserGroups();
      subscribeToUserGroups();
    }
  }, 500);
});
