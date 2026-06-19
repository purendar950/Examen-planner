/* ================================================================
   REGISTRATION — Same-device duplicate detection
   Logic:
     1. Generate device fingerprint (fp)
     2. Check Firestore: any existing user with same fp?
     3. YES -> status = 'pending'  (2nd account from device = needs admin OK)
     4. NO  -> status = 'approved' (first account from this device = instant)
   Admin can still force-approve from the Pending tab anytime.
   ================================================================ */
handleRegister = async function() {
  const name   = document.getElementById('reg-name').value.trim();
  const email  = document.getElementById('reg-email').value.trim();
  const pass   = document.getElementById('reg-pass').value;
  const mobile = (document.getElementById('reg-mobile') ? document.getElementById('reg-mobile').value : '').trim();
  const examT  = document.getElementById('reg-exam') ? document.getElementById('reg-exam').value : '';
  if (!name || !email || !pass) { showAuthError('reg', 'Please fill all fields.'); return; }
  if (pass.length < 6) { showAuthError('reg', 'Password must be at least 6 characters.'); return; }
  if (!/^[6-9][0-9]{9}$/.test(mobile)) { showAuthError('reg', 'Valid 10-digit mobile number dalo.'); return; }
  if (!examT) { showAuthError('reg', 'Apna target exam select karo.'); return; }

  const btn = document.getElementById('btn-register');
  btn.disabled = true; btn.textContent = 'Checking device...';
  document.getElementById('reg-error').style.display = 'none';

  const fp = ezFingerprint();
  const ip = await ezGetIp();

  /* ── localStorage-only fallback (no Firebase) ── */
  if (!_fbReady) {
    const users = JSON.parse(localStorage.getItem('ssc_users') || '{}');
    if (users[email]) { showAuthError('reg', 'Email already registered.'); btn.disabled = false; btn.textContent = 'Create Account →'; return; }
    const deviceUsed = Object.values(users).some(u => u.profile && u.profile.fp === fp);
    // FIX: approve regardless of device; deviceDuplicate is only an admin flag.
    const regStatus  = 'approved';
    users[email] = { name, password: btoa(pass), uid: email, state: getDefaultState(),
      profile: { name, email, mobile, examTarget: examT, status: regStatus, plan: 'free', fp, ip, deviceDuplicate: deviceUsed } };
    localStorage.setItem('ssc_users', JSON.stringify(users));
    btn.disabled = false; btn.textContent = 'Create Account →';
    _afterRegisterRedirect(email);
    _ezShowRegBanner(regStatus);
    return;
  }

  /* ── Firebase path ── */
  try {
    /* Step 1: Note whether this device fingerprint already has an account.
       FIX: this is now only an ADMIN-REVIEW FLAG, not a login block. Multiple
       real users may legitimately share one device (guest mode was removed),
       so a duplicate device no longer forces 'pending' status — which was
       causing the second user to be logged out by the approval gate. */
    let deviceAlreadyUsed = false;
    try {
      const fpSnap = await db.collection('users')
        .where('profile.fp', '==', fp)
        .limit(1)
        .get();
      deviceAlreadyUsed = !fpSnap.empty;
    } catch(e) {
      deviceAlreadyUsed = false; // index not ready yet — default safe
    }

    // Always approve on registration; deviceDuplicate stays as a flag the
    // admin can review/suspend manually if abuse is suspected.
    const regStatus = 'approved';
    btn.textContent = 'Creating account...';

    _justRegistered = true;
    const cred = await auth.createUserWithEmailAndPassword(email, pass);
    await cred.user.updateProfile({ displayName: name });
    await db.collection('users').doc(cred.user.uid).set({
      profile: {
        name, email, mobile, examTarget: examT,
        status: regStatus, plan: 'free',
        referredBy: ezGetRef(), fp, ip,
        deviceDuplicate: deviceAlreadyUsed,
        requestedAt: firebase.firestore.FieldValue.serverTimestamp(),
        createdAt:   firebase.firestore.FieldValue.serverTimestamp()
      },
      appState: getDefaultState()
    });
    await auth.signOut();
    _justRegistered = false;
    btn.disabled = false; btn.textContent = 'Create Account →';
    _afterRegisterRedirect(email);
    _ezShowRegBanner(regStatus);
  } catch(e) {
    _justRegistered = false;
    const msg = e.code === 'auth/email-already-in-use' ? 'Email already registered.'
      : e.code === 'auth/weak-password' ? 'Password too weak. Use 6+ characters.'
      : e.message;
    showAuthError('reg', msg);
    btn.disabled = false; btn.textContent = 'Create Account →';
  }
};

function _ezShowRegBanner(regStatus) {
  const banner = document.getElementById('reg-success-banner');
  if (!banner) return;
  if (regStatus === 'pending') {
    banner.innerHTML = '⏳ <strong>Request submitted!</strong><br>Is device se pehle se ek account registered hai. Admin approval ke baad login kar paoge.';
  } else {
    banner.innerHTML = '?? <strong>Account created successfully!</strong><br>Ab apna email aur password daal kar Sign In karo.';
  }
}


/* Approval gate on login */
const _loginUserBaseEZ = loginUser;
loginUser = function(email, name, uid, state) {
  _loginUserBaseEZ(email, name, uid, state);
  if (currentUser && !currentUser.isGuest) ezCheckApproval(uid, email);
};

async function ezCheckApproval(uid, email) {
  if (await ezIsAdmin(uid)) return; // Firestore admins/{uid} role check
  let status = 'approved', reason = '';
  if (_fbReady && db) {
    try {
      const snap = await db.collection('users').doc(uid).get();
      const p = (snap.exists && snap.data().profile) || {};
      status = p.status || 'approved'; // existing users without status stay approved
      reason = p.rejectReason || '';
    } catch(e) { return; }
  } else {
    try {
      const users = JSON.parse(localStorage.getItem('ssc_users') || '{}');
      status = (users[email] && users[email].profile && users[email].profile.status) || 'approved';
    } catch(e) { return; }
  }
  const old = document.getElementById('ez-gate');
  if (status === 'approved') { if (old) old.remove(); return; }
  ezShowGate(status, reason);
}

function ezShowGate(status, reason) {
  let ov = document.getElementById('ez-gate');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'ez-gate';
    ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:var(--bg);display:flex;align-items:center;justify-content:center;padding:1rem;';
    document.body.appendChild(ov);
  }
  const pending = status === 'pending';
  ov.innerHTML = '<div style="max-width:420px;width:100%;background:var(--card);border:1px solid var(--border);border-radius:16px;padding:2rem;text-align:center;">' +
    '<div style="font-size:2.5rem;margin-bottom:0.75rem;">' + (pending ? '⏳' : '🚫') + '</div>' +
    '<h2 style="margin-bottom:0.5rem;">' + (pending ? 'Approval Pending' : 'Access Denied') + '</h2>' +
    '<p style="color:var(--muted);line-height:1.7;margin-bottom:1.5rem;font-size:0.875rem;">' +
    (pending
      ? 'Aapki request admin ke paas pahunch gayi hai. Approval milte hi aap ExamZen use kar paoge. Thodi der baad dobara login karke check karo.'
      : 'Aapki request approve nahi hui.' + (reason ? '<br><br><strong>Reason:</strong> ' + escapeHtml(reason) : '')) +
    '</p>' +
    '<button onclick="ezGateLogout()" style="background:var(--accent);color:#000;border:none;border-radius:8px;padding:0.7rem 1.6rem;font-weight:700;cursor:pointer;font-family:var(--font);">← Logout</button>' +
    '</div>';
}
function ezGateLogout() {
  const ov = document.getElementById('ez-gate'); if (ov) ov.remove();
  handleLogout();
}

