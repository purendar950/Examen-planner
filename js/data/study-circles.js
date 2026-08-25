/* ══════════════════════════════════════════════
   FOCUS CIRCLE — Firestore data layer
   Collections:
     studyCircles/{cid}
     studyCircles/{cid}/members/{uid}
     studyCircles/{cid}/joinRequests/{uid}
     studyCircles/{cid}/messages/{messageId}
     fc_presence/{uid}  (global focus presence)
   User's own circle IDs are mirrored in appState.fcCircleIds
   so "my circles" works without a collection-group query.
══════════════════════════════════════════════ */
(function() {
'use strict';

const REQUIRED_STREAK = 21;

function fcDb() {
  return (typeof db !== 'undefined' && db) ? db : null;
}

function generateJoinCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function creationEligibility() {
  const streak = (typeof appState !== 'undefined' && appState.streak) || 0;
  const isAdmin = typeof ezIsAdmin === 'function' && ezIsAdmin();
  return {
    allowed: streak >= REQUIRED_STREAK || isAdmin,
    requiredStreak: REQUIRED_STREAK,
    currentStreak: streak,
    adminBypass: isAdmin
  };
}

function _memberProfile(role) {
  return {
    uid: currentUser.uid,
    name: currentUser.displayName || 'Learner',
    avatar: currentUser.photoURL || '',
    role,
    joinedAt: new Date().toISOString(),
    isPremium: typeof ezIsPro === 'function' && ezIsPro(),
    isFocusing: false,
    weeklyFocusMinutes: 0,
    weekKey: _currentWeekKey()
  };
}

async function createCircle(name, visibility, approvalRequired = false) {
  const database = fcDb();
  if (!database) throw new Error('Firebase not configured');
  if (!currentUser) throw new Error('Not signed in');
  const elig = creationEligibility();
  if (!elig.allowed) throw new Error('Need a ' + REQUIRED_STREAK + '-day streak to create a circle.');
  const code = visibility === 'private' ? generateJoinCode() : '';
  const now = new Date().toISOString();
  const ref = await database.collection('studyCircles').add({
    name: name.trim(),
    ownerId: currentUser.uid,
    ownerName: currentUser.displayName || 'Learner',
    ownerAvatar: currentUser.photoURL || '',
    visibility: visibility === 'private' ? 'private' : 'public',
    joinCode: code,
    createdAt: now,
    memberCount: 1,
    focusingCount: 0,
    maxMembers: null,
    approvalRequired: visibility !== 'private' && !!approvalRequired
  });
  const cid = ref.id;
  await ref.collection('members').doc(currentUser.uid).set(_memberProfile('owner'));
  _trackMembership(cid, true);
  return { circleId: cid, joinCode: code };
}

async function _joinCircleBackend(payload) {
  if (!currentUser) throw new Error('Not signed in');
  if (typeof getFirebaseIdToken !== 'function' || typeof privilegedBackendUrl !== 'function') {
    throw new Error('Secure circle joining is unavailable.');
  }
  const token = await getFirebaseIdToken();
  const response = await fetch(privilegedBackendUrl() + '/study-circles/join', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload || {})
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok !== true) {
    throw new Error(result.error || 'Circle could not be joined securely.');
  }
  _trackMembership(result.circleId, true);
  return {
    alreadyMember: !!result.alreadyMember,
    circleId: result.circleId,
    status: 'approved'
  };
}

async function joinByCode(code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(normalized)) throw new Error('Enter a valid 6-character circle code.');
  return _joinCircleBackend({ code: normalized });
}

async function joinPublic(circleId) {
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(String(circleId || ''))) throw new Error('Invalid circle.');
  return _joinCircleBackend({ circleId });
}

async function requestToJoin(circleId) {
  const database = fcDb();
  if (!database) throw new Error('Firebase not configured');
  if (!currentUser) throw new Error('Not signed in');
  const circleRef = database.collection('studyCircles').doc(circleId);
  const [circleDoc, memberDoc] = await Promise.all([
    circleRef.get(),
    circleRef.collection('members').doc(currentUser.uid).get()
  ]);
  if (!circleDoc.exists) throw new Error('Circle not found.');
  if (memberDoc.exists) return { status: 'member', circleId };
  const circle = circleDoc.data() || {};
  if (circle.visibility !== 'public') {
    throw new Error('Private circles can only be joined with their invite code.');
  }
  if (!circle.approvalRequired) {
    return _joinCircleBackend({ circleId });
  }
  await circleRef.collection('joinRequests').doc(currentUser.uid).set({
    uid: currentUser.uid,
    name: currentUser.displayName || 'Learner',
    avatar: currentUser.photoURL || '',
    status: 'pending',
    requestedAt: new Date().toISOString()
  });
  _trackRequest(circleId, true);
  return { status: 'pending', circleId };
}

async function approveJoinRequest(cid, userId) {
  const database = fcDb();
  if (!database || !currentUser) throw new Error('Not signed in');
  const circleRef = database.collection('studyCircles').doc(cid);
  const requestRef = circleRef.collection('joinRequests').doc(userId);
  await database.runTransaction(async transaction => {
    const [circleDoc, requestDoc] = await transaction.getAll(circleRef, requestRef);
    if (!circleDoc.exists || !requestDoc.exists) throw new Error('Request is no longer available.');
    if (circleDoc.data().ownerId !== currentUser.uid) throw new Error('Only the owner can approve requests.');
    if (requestDoc.data().status === 'approved') return;
    if ((circleDoc.data().maxMembers || 0) <= (circleDoc.data().memberCount || 0)) throw new Error('Circle is full.');
    transaction.set(circleRef.collection('members').doc(userId), {
      uid: userId,
      name: requestDoc.data().name || 'Learner',
      avatar: requestDoc.data().avatar || '',
      role: 'member',
      joinedAt: new Date().toISOString(),
      isPremium: false,
      isFocusing: false,
      weeklyFocusMinutes: 0,
      weekKey: _currentWeekKey()
    });
    transaction.update(circleRef, { memberCount: firebase.firestore.FieldValue.increment(1) });
    transaction.update(requestRef, { status: 'approved', respondedAt: new Date().toISOString() });
  });
  return { approved: true };
}

async function rejectJoinRequest(cid, userId) {
  const database = fcDb();
  if (!database || !currentUser) throw new Error('Not signed in');
  await database.collection('studyCircles').doc(cid)
    .collection('joinRequests').doc(userId).update({
      status: 'rejected',
      respondedAt: new Date().toISOString()
    });
}

async function getJoinRequests(cid) {
  const database = fcDb();
  if (!database) return [];
  const snap = await database.collection('studyCircles').doc(cid)
    .collection('joinRequests').where('status', '==', 'pending').get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }))
    .sort((a, b) => String(a.requestedAt || '').localeCompare(String(b.requestedAt || '')));
}

function watchJoinRequest(cid, callback) {
  const database = fcDb();
  if (!database || !currentUser) return () => {};
  return database.collection('studyCircles').doc(cid)
    .collection('joinRequests').doc(currentUser.uid)
    .onSnapshot(doc => callback(doc.exists ? { id: doc.id, ...doc.data() } : null));
}

function subscribeMessages(cid, callback, errorCallback) {
  const database = fcDb();
  if (!database) {
    errorCallback && errorCallback(new Error('Firebase not configured'));
    return () => {};
  }
  return database.collection('studyCircles').doc(cid).collection('messages')
    .orderBy('createdAt', 'asc').limitToLast(120)
    .onSnapshot(snap => callback(snap.docs.map(doc => ({ id: doc.id, ...doc.data() }))), error => {
      console.error('Focus Circle messages:', error);
      errorCallback && errorCallback(error);
    });
}

async function sendMessage(cid, text) {
  const value = String(text || '').trim().slice(0, 1000);
  if (!value) return;
  const database = fcDb();
  if (!database || !currentUser) throw new Error('Not signed in');
  await database.collection('studyCircles').doc(cid).collection('messages').add({
    uid: currentUser.uid,
    name: currentUser.displayName || 'Learner',
    avatar: currentUser.photoURL || '',
    text: value,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

async function leaveCircle(cid) {
  const database = fcDb();
  if (!database || !currentUser) return;
  const circleRef = database.collection('studyCircles').doc(cid);
  const memberRef = circleRef.collection('members').doc(currentUser.uid);
  const memberDoc = await memberRef.get();
  if (!memberDoc.exists) return;
  const wasOwner = memberDoc.data().role === 'owner';
  const batch = database.batch();
  batch.delete(memberRef);
  batch.update(circleRef, { memberCount: firebase.firestore.FieldValue.increment(-1) });
  await batch.commit();
  _trackMembership(cid, false);
  if (wasOwner) await circleRef.delete();
}

async function setVisibility(cid, visibility) {
  if (!currentUser) throw new Error('Not signed in');
  const normalized = visibility === 'private' ? 'private' : 'public';
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(String(cid || ''))) throw new Error('Invalid circle.');
  const token = await getFirebaseIdToken();
  const response = await fetch(privilegedBackendUrl() + '/study-circles/visibility', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ circleId: cid, visibility: normalized })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok !== true) {
    throw new Error(result.error || 'Circle visibility could not be changed securely.');
  }
  return result;
}

async function renameCircle(cid, name) {
  const database = fcDb();
  if (!database) return;
  await database.collection('studyCircles').doc(cid).update({ name: name.trim() });
}

async function togglePin(cid, pinned) {
  if (typeof appState === 'undefined') return;
  appState.fcPinnedIds = appState.fcPinnedIds || [];
  const idx = appState.fcPinnedIds.indexOf(cid);
  if (pinned && idx < 0) appState.fcPinnedIds.push(cid);
  if (!pinned && idx >= 0) appState.fcPinnedIds.splice(idx, 1);
  saveProgress();
}

async function removeMember(cid, userId) {
  const database = fcDb();
  if (!database || !currentUser) return;
  await database.collection('studyCircles').doc(cid)
    .collection('members').doc(userId).delete();
  await database.collection('studyCircles').doc(cid).update({
    memberCount: firebase.firestore.FieldValue.increment(-1)
  });
}

async function getMyCircles() {
  const database = fcDb();
  if (!database) return [];
  const ids = (appState && Array.isArray(appState.fcCircleIds)) ? appState.fcCircleIds : [];
  if (!ids.length) return [];
  const circles = [];
  for (const cid of ids.slice(0, 10)) {
    const doc = await database.collection('studyCircles').doc(cid).get();
    if (doc.exists) circles.push({ id: doc.id, ...doc.data(), isPinned: (appState.fcPinnedIds||[]).includes(doc.id) });
  }
  circles.sort((a, b) => (b.isPinned ? 1 : 0) - (a.isPinned ? 1 : 0));
  return circles;
}

async function listPublicCircles(page, search) {
  const database = fcDb();
  if (!database) return { circles: [], hasMore: false, total: 0 };
  let q = database.collection('studyCircles')
    .where('visibility', '==', 'public')
    .orderBy('createdAt', 'desc')
    .limit(15);
  if (page > 1) {
    const prev = await database.collection('studyCircles')
      .where('visibility', '==', 'public')
      .orderBy('createdAt', 'desc')
      .limit((page - 1) * 15).get();
    if (!prev.empty) q = q.startAfter(prev.docs[prev.docs.length - 1]);
  }
  const snap = await q.get();
  let circles = snap.docs.map(d => ({ id: d.id, ...d.data(),
    joined: ((appState&&appState.fcCircleIds)||[]).includes(d.id),
    isPinned: ((appState&&appState.fcPinnedIds)||[]).includes(d.id)
  }));
  if (search) circles = circles.filter(c => c.name.toLowerCase().includes(search.toLowerCase()));
  return { circles, hasMore: snap.docs.length === 15, total: circles.length };
}

async function getCircleDetail(cid) {
  const database = fcDb();
  if (!database) return null;
  const doc = await database.collection('studyCircles').doc(cid).get();
  if (!doc.exists) return null;
  const membersSnap = await doc.ref.collection('members').orderBy('joinedAt', 'asc').get();
  return {
    id: doc.id, ...doc.data(),
    isPinned: (appState.fcPinnedIds || []).includes(cid),
    members: membersSnap.docs.map(m => ({ id: m.id, ...m.data() }))
  };
}

async function setPresence(active) {
  const database = fcDb();
  if (!database || !currentUser) return;
  const ids = (appState && Array.isArray(appState.fcCircleIds)) ? appState.fcCircleIds : [];
  await database.collection('fc_presence').doc(currentUser.uid).set({
    active: !!active,
    updatedAt: new Date().toISOString(),
    circleIds: ids,
    name: currentUser.displayName || 'Learner',
    avatar: currentUser.photoURL || ''
  });
}

async function recordFocusMinutes(minutes) {
  if (!minutes || minutes < 1) return;
  const database = fcDb();
  if (!database || !currentUser) return;
  const wk = _currentWeekKey();
  const ids = (appState && Array.isArray(appState.fcCircleIds)) ? appState.fcCircleIds : [];
  for (const cid of ids) {
    const mref = database.collection('studyCircles').doc(cid).collection('members').doc(currentUser.uid);
    const mdata = (await mref.get()).data() || {};
    // Reset the weekly counter when the ISO week rolls over so it stays weekly,
    // not a forever-growing lifetime number.
    const update = mdata.weekKey === wk
      ? { weeklyFocusMinutes: firebase.firestore.FieldValue.increment(minutes), weekKey: wk }
      : { weeklyFocusMinutes: minutes, weekKey: wk };
    await mref.set(update, { merge: true });
  }
  await recordUserFocusMinutes(minutes);
}

// Per-user lifetime + weekly focus stat (Safar-style "study hours").
// Stored at focusStats/{uid}; weeklyFocusMinutes resets on week change.
async function recordUserFocusMinutes(minutes) {
  if (!minutes || minutes < 1) return;
  const database = fcDb();
  if (!database || !currentUser) return;
  const wk = _currentWeekKey();
  const ref = database.collection('focusStats').doc(currentUser.uid);
  const data = (await ref.get()).data() || {};
  const update = data.weekKey === wk
    ? {
        totalFocusMinutes: firebase.firestore.FieldValue.increment(minutes),
        weeklyFocusMinutes: firebase.firestore.FieldValue.increment(minutes),
        weekKey: wk,
        updatedAt: new Date().toISOString()
      }
    : {
        totalFocusMinutes: (data.totalFocusMinutes || 0) + minutes,
        weeklyFocusMinutes: minutes,
        weekKey: wk,
        updatedAt: new Date().toISOString()
      };
  await ref.set(update, { merge: true });
}

async function getMyFocusStats() {
  const database = fcDb();
  if (!database || !currentUser) return null;
  const data = (await database.collection('focusStats').doc(currentUser.uid).get()).data() || {};
  const total = data.totalFocusMinutes || 0;
  return {
    totalFocusMinutes: total,
    weeklyFocusMinutes: data.weeklyFocusMinutes || 0,
    weekKey: data.weekKey || '',
    studyHours: Math.floor((total / 60) * 10) / 10
  };
}

async function getLiveSummary() {
  const database = fcDb();
  if (!database) return { totalFocusing: 0, activeCirclesCount: 0 };
  const snap = await database.collection('fc_presence')
    .where('active', '==', true).get();
  const circleSet = new Set();
  let focusing = 0;
  snap.forEach(d => {
    focusing++;
    (d.data().circleIds || []).forEach(c => circleSet.add(c));
  });
  return { totalFocusing: focusing, activeCirclesCount: circleSet.size };
}

function _currentWeekKey() {
  const d = new Date();
  const start = new Date(d.getFullYear(), 0, 1);
  const diff = Math.floor((d - start) / 86400000);
  return d.getFullYear() + '-W' + Math.ceil((diff + start.getDay() + 1) / 7);
}

function _trackMembership(cid, joining) {
  if (typeof appState === 'undefined') return;
  appState.fcCircleIds = Array.isArray(appState.fcCircleIds) ? appState.fcCircleIds : [];
  const idx = appState.fcCircleIds.indexOf(cid);
  if (joining && idx < 0) appState.fcCircleIds.push(cid);
  if (!joining && idx >= 0) appState.fcCircleIds.splice(idx, 1);
  saveProgress();
}

function _trackRequest(cid, pending) {
  if (typeof appState === 'undefined') return;
  appState.fcRequestIds = Array.isArray(appState.fcRequestIds) ? appState.fcRequestIds : [];
  const index = appState.fcRequestIds.indexOf(cid);
  if (pending && index < 0) appState.fcRequestIds.push(cid);
  if (!pending && index >= 0) appState.fcRequestIds.splice(index, 1);
  saveProgress();
}

window.FocusCircleData = {
  createCircle, joinByCode, joinPublic, leaveCircle,
  setVisibility, renameCircle, togglePin, removeMember,
  getMyCircles, listPublicCircles, getCircleDetail,
  requestToJoin, approveJoinRequest, rejectJoinRequest,
  getJoinRequests, watchJoinRequest, subscribeMessages, sendMessage,
  setPresence, recordFocusMinutes, recordUserFocusMinutes, getMyFocusStats, getLiveSummary,
  creationEligibility, generateJoinCode, REQUIRED_STREAK
};
})();
