/* PrepPath Admin — CORE: Firebase init, auth/role gate, data loading, realtime, render dispatcher.
   Loaded first (defines db/auth + all shared globals). Split from the original monolithic admin.js. */
/* ══ CONFIG — admin role stored in Firestore admins/{uid} ══ */
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyDTBc3RAED-HuFZv7xyT2X0WFBRIXr9png",
  authDomain:        "syncstudy-3d734.firebaseapp.com",
  projectId:         "syncstudy-3d734",
  storageBucket:     "syncstudy-3d734.firebasestorage.app",
  messagingSenderId: "729906734037",
  appId:             "1:729906734037:web:d75d73d101bfbb52c3535c"
};
firebase.initializeApp(FIREBASE_CONFIG);
const db = firebase.firestore(), auth = firebase.auth();

let USERS = [], PLANS = [], PAYMENTS = [], REQUESTS = [], COUPONS = [], REDEMPTIONS = [], TAB = 'pending', PAY_FILTER = 'all', PAY_VIEW = 'list'; // 'list' | 'reconcile'
let CONFIG = {}, SETTINGS = { requireApproval: false };
let DUP = { mobile:{}, fp:{}, ip:{} };
let TG_USERS = [], TG_CONFIG = { botToken: '', loaded: false }, TG_SENDING = false;

function showToast(msg) { let t=document.getElementById('adm-toast'); if(!t){t=document.createElement('div');t.id='adm-toast';t.style.cssText='position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#222;color:#fff;padding:10px 20px;border-radius:10px;font-size:0.85rem;z-index:999;';document.body.appendChild(t);} t.textContent=msg;t.style.opacity='1';clearTimeout(t._t);t._t=setTimeout(()=>t.style.opacity='0',2500); }
function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtDate(ts) { try { const d = ts && ts.toDate ? ts.toDate() : (ts ? new Date(ts) : null); return d ? d.toLocaleString('en-IN', {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : '—'; } catch(e){ return '—'; } }

/* ══ AUTH ══ */
function admErr(m) { const e = document.getElementById('adm-err'); e.textContent = m; e.style.display = 'block'; }
async function adminLoginEmail() {
  const em = document.getElementById('adm-email').value.trim(), pw = document.getElementById('adm-pass').value;
  if (!em || !pw) { admErr('Email aur password dono bharo.'); return; }
  try { await auth.signInWithEmailAndPassword(em, pw); } catch(e) { admErr('Login failed: ' + (e.code || e.message)); }
}
async function adminLoginGoogle() {
  try { await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()); } catch(e) { admErr('Google login failed: ' + (e.code || e.message)); }
}
auth.onAuthStateChanged(async (u) => {
  if (!u) { document.getElementById('login-screen').style.display = 'flex'; document.getElementById('panel').style.display = 'none'; return; }
  try {
    const adminDoc = await db.collection('admins').doc(u.uid).get();
    if (!adminDoc.exists) {
      await auth.signOut();
      admErr('Access denied — this account does not have admin access.');
      return;
    }
  } catch(e) { await auth.signOut(); admErr('Access denied — could not verify admin access.'); return; }
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('panel').style.display = 'block';
  document.getElementById('admin-email').textContent = u.email;
  await loadAll();
  render();
  subscribeRealtime();
});

/* Unsubscribe helper — call before logout / on logout to stop listeners */
let _unsubs = [];
function subscribeRealtime() {
  // Detach any old listeners (defensive)
  _unsubs.forEach(u => { try { u(); } catch(e){} });
  _unsubs = [];

  // 1) Pending users — most important for admin workflow
  try {
    const unsub = db.collection('users')
      .where('profile.status', '==', 'pending')
      .onSnapshot(snap => {
        let added = 0, removed = 0, changed = 0;
        snap.docChanges().forEach(change => {
          const data = change.doc.data();
          const u = { id: change.doc.id, p: (data.profile || {}) };
          const idx = USERS.findIndex(x => x.id === u.id);
          if (change.type === 'added') { if (idx < 0) { USERS.push(u); added++; } }
          else if (change.type === 'modified') { if (idx >= 0) USERS[idx] = u; else USERS.push(u); changed++; }
          else if (change.type === 'removed') { if (idx >= 0) USERS.splice(idx, 1); removed++; }
        });
        if (added) console.log('[realtime] +' + added + ' new pending');
        rebuildDupIndex();
        render();
        if (added > 0 && TAB === 'pending') {
          showToast('🔔 ' + added + ' new pending request' + (added>1?'s':'') + '!');
        }
      }, err => {
        console.warn('pending snapshot error', err);
      });
    _unsubs.push(unsub);
  } catch(e) { console.warn('subscribe pending failed', e); }

  // 2) Payment changes — update verify/decline buttons live
  try {
    const unsub = db.collection('payments')
      .onSnapshot(snap => {
        let dirty = false;
        snap.docChanges().forEach(change => {
          const data = change.doc.data();
          const u = { id: change.doc.id, ...data };
          const idx = PAYMENTS.findIndex(x => x.id === u.id);
          if (change.type === 'added') { if (idx < 0) { PAYMENTS.push(u); dirty = true; } }
          else if (change.type === 'modified') { if (idx >= 0) PAYMENTS[idx] = u; else PAYMENTS.push(u); dirty = true; }
          else if (change.type === 'removed') { if (idx >= 0) PAYMENTS.splice(idx, 1); dirty = true; }
        });
        if (dirty) {
          PAYMENTS.sort((a,b) => ((b.createdAt&&b.createdAt.seconds)||0) - ((a.createdAt&&a.createdAt.seconds)||0));
          render();
        }
      }, err => { console.warn('payments snapshot error', err); });
    _unsubs.push(unsub);
  } catch(e) { console.warn('subscribe payments failed', e); }

  // 3) New user requests (the 💡 Requests tab) — live toast
  try {
    const unsub = db.collection('requests')
      .where('status', '==', 'new')
      .onSnapshot(snap => {
        const ids = snap.docs.map(d => d.id);
        const prev = (REQUESTS || []).filter(r => r.status === 'new').map(r => r.id).sort().join(',');
        const now  = ids.sort().join(',');
        if (prev !== now && ids.length > (REQUESTS||[]).filter(r=>r.status==='new').length) {
          showToast('💡 New user request received');
        }
        // Refresh full list in background
        db.collection('requests').get().then(rs => {
          REQUESTS = rs.docs.map(d => ({ id: d.id, ...d.data() }));
          REQUESTS.sort((a,b) => ((b.createdAt&&b.createdAt.seconds)||0) - ((a.createdAt&&a.createdAt.seconds)||0));
          render();
        });
      }, err => { console.warn('requests snapshot error', err); });
    _unsubs.push(unsub);
  } catch(e) { console.warn('subscribe requests failed', e); }
}

function rebuildDupIndex() {
  DUP = { mobile:{}, fp:{}, ip:{} };
  USERS.forEach(u => {
    if (u.p.mobile) DUP.mobile[u.p.mobile] = (DUP.mobile[u.p.mobile] || 0) + 1;
    if (u.p.fp)     DUP.fp[u.p.fp]         = (DUP.fp[u.p.fp]         || 0) + 1;
    if (u.p.ip)     DUP.ip[u.p.ip]         = (DUP.ip[u.p.ip]         || 0) + 1;
  });
}

/* ══ DATA ══ */
async function loadAll() {
  try {
    const us = await db.collection('users').get();
    USERS = us.docs.map(d => ({ id: d.id, p: (d.data().profile || {}) }));
  } catch(e) { alert('Users load failed — Firestore rules update kiye? ' + e.message); USERS = []; }
  try { const ps = await db.collection('plans').get(); PLANS = ps.docs.map(d => ({ id: d.id, ...d.data() })); } catch(e) { PLANS = []; }
  try {
    const pay = await db.collection('payments').get();
    PAYMENTS = pay.docs.map(d => ({ id: d.id, ...d.data() }));
    PAYMENTS.sort((a,b) => ((b.createdAt&&b.createdAt.seconds)||0) - ((a.createdAt&&a.createdAt.seconds)||0));
  } catch(e) { PAYMENTS = []; }
  try { const cf = await db.collection('config').doc('payment').get(); CONFIG = cf.exists ? cf.data() : {}; } catch(e) { CONFIG = {}; }
  try { const ff = await db.collection('config').doc('free').get(); CONFIG.free = ff.exists ? ff.data() : { mocks:5, mediaSaves:2, notes:10 }; } catch(e) { CONFIG.free = { mocks:5, mediaSaves:2, notes:10 }; }
  DUP = { mobile:{}, fp:{}, ip:{} };
  USERS.forEach(u => {
    if (u.p.mobile) DUP.mobile[u.p.mobile] = (DUP.mobile[u.p.mobile] || 0) + 1;
    if (u.p.fp) DUP.fp[u.p.fp] = (DUP.fp[u.p.fp] || 0) + 1;
    if (u.p.ip) DUP.ip[u.p.ip] = (DUP.ip[u.p.ip] || 0) + 1;
  });
  await syncReferralStats();
  try { const rq = await db.collection('requests').get(); REQUESTS = rq.docs.map(d => ({ id: d.id, ...d.data() })); REQUESTS.sort((a,b) => ((b.createdAt&&b.createdAt.seconds)||0) - ((a.createdAt&&a.createdAt.seconds)||0)); } catch(e) { REQUESTS = []; }
  try { const cp = await db.collection('coupons').get(); COUPONS = cp.docs.map(d => ({ id: d.id, ...d.data() })); COUPONS.sort((a,b) => ((b.createdAt&&b.createdAt.seconds)||0) - ((a.createdAt&&a.createdAt.seconds)||0)); } catch(e) { COUPONS = []; }
  try { const rd = await db.collection('coupon_redemptions').get(); REDEMPTIONS = rd.docs.map(d => ({ id: d.id, ...d.data() })); REDEMPTIONS.sort((a,b) => ((b.createdAt&&b.createdAt.seconds)||0) - ((a.createdAt&&a.createdAt.seconds)||0)); } catch(e) { REDEMPTIONS = []; }
  try { const sv = await db.collection('config').doc('settings').get(); SETTINGS = sv.exists ? sv.data() : { requireApproval: false }; } catch(e) { SETTINGS = { requireApproval: false }; }
}

/* Write referral counters onto each referrer's profile so the app can show
   their Share & Earn progress (normal users cannot query other users) */
async function syncReferralStats() {
  const refMap = {};
  USERS.forEach(u => { if (u.p.referredBy) { (refMap[u.p.referredBy] = refMap[u.p.referredBy] || []).push(u); } });
  for (const refUid of Object.keys(refMap)) {
    const referrer = USERS.find(x => x.id === refUid); if (!referrer) continue;
    const total = refMap[refUid].length;
    const paid = refMap[refUid].filter(x => x.p.plan && x.p.plan !== 'free').length;
    if (referrer.p.refTotalCount !== total || referrer.p.refPaidCount !== paid) {
      try {
        await db.collection('users').doc(refUid).update({ 'profile.refTotalCount': total, 'profile.refPaidCount': paid });
        referrer.p.refTotalCount = total; referrer.p.refPaidCount = paid;
      } catch(e) {}
    }
  }
}
function flagsFor(u) {
  const f = [];
  if (u.p.mobile && DUP.mobile[u.p.mobile] > 1) f.push('Duplicate mobile');
  if (u.p.fp && DUP.fp[u.p.fp] > 1) f.push('Same device');
  if (u.p.ip && DUP.ip[u.p.ip] > 1) f.push('Same IP');
  if (u.p.referredBy && u.p.referredBy === u.id) f.push('Self-referral');
  return f;
}
/* ══ RENDER ══ */
function setTab(t) {
  TAB = t;
  document.querySelectorAll('.tab').forEach(el => el.classList.toggle('active', el.dataset.t === t));
  if (t === 'telegram' && !TG_CONFIG.loaded) loadTelegramData();
  render();
}
function render() {
  const pending = USERS.filter(u => u.p.status === 'pending').length;
  const approved = USERS.filter(u => u.p.status === 'approved' || !u.p.status).length;
  const paid = USERS.filter(u => u.p.plan && u.p.plan !== 'free').length;
  const payPending = PAYMENTS.filter(p => p.status === 'pending').length;
  document.getElementById('cnt-pending').textContent = pending ? '(' + pending + ')' : '';
  const newReqs = (REQUESTS || []).filter(r => r.status === 'new').length;
  const cntReqEl = document.getElementById('cnt-requests');
  if (cntReqEl) cntReqEl.textContent = newReqs ? '(' + newReqs + ')' : '';
  const tgEnabled = TG_USERS.filter(u => u.tg.enabled && u.tg.chatId).length;
  const cntTgEl = document.getElementById('cnt-tg');
  if (cntTgEl) cntTgEl.textContent = tgEnabled ? '(' + tgEnabled + ')' : '';
  document.getElementById('stats').innerHTML =
    '<div class="stat"><b>' + USERS.length + '</b><div>Total users</div></div>' +
    '<div class="stat"><b style="color:var(--amber)">' + pending + '</b><div>Pending requests</div></div>' +
    '<div class="stat"><b style="color:var(--accent-dark)">' + approved + '</b><div>Active users</div></div>' +
    '<div class="stat"><b style="color:var(--blue)">' + paid + '</b><div>Paid plans</div></div>' +
    '<div class="stat"><b style="color:var(--red)">' + payPending + '</b><div>Payments to verify</div></div>';
  const c = document.getElementById('content');
  if (TAB === 'analytics') c.innerHTML = renderAnalytics();
  else if (TAB === 'pending') c.innerHTML = renderPending();
  else if (TAB === 'users') c.innerHTML = renderUsers();
  else if (TAB === 'plans') c.innerHTML = renderPlans();
  else if (TAB === 'payments') c.innerHTML = renderPayments();
  else if (TAB === 'referrals') c.innerHTML = renderReferrals();
  else if (TAB === 'payouts') c.innerHTML = renderPayouts();
  else if (TAB === 'coupons') c.innerHTML = renderCoupons();
  else if (TAB === 'requests') c.innerHTML = renderRequests();
  else if (TAB === 'telegram') c.innerHTML = renderTelegram();
  else if (TAB === 'settings') c.innerHTML = renderSettings();
}
