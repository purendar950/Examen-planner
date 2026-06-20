/* ══════════════════════════════════════════════
   PREPPATH — REBRAND + APPROVAL FLOW + REFERRAL META
══════════════════════════════════════════════ */
const EZ_ADMIN_EMAILS = []; // legacy — roles now stored in Firestore admins/{uid}
let _ezIsAdminCache = null;
async function ezIsAdmin(uid) {
  if (!uid || !_fbReady || !db) return false;
  if (_ezIsAdminCache !== null) return _ezIsAdminCache;
  try { const snap = await db.collection('admins').doc(uid).get(); _ezIsAdminCache = snap.exists; }
  catch(e) { _ezIsAdminCache = false; }
  return _ezIsAdminCache;
}

/* Capture referral code from URL (?ref=...) */
(function() { try { const r = new URLSearchParams(location.search).get('ref'); if (r) localStorage.setItem('ez_ref', r); } catch(e) {} })();
function ezGetRef() { try { return localStorage.getItem('ez_ref') || null; } catch(e) { return null; } }

/* Soft device fingerprint — flagging signal for admin review only */
function ezFingerprint() {
  try {
    const s = [navigator.userAgent, screen.width + 'x' + screen.height, Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.language, navigator.hardwareConcurrency || ''].join('|');
    let h = 0; for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
    return 'fp_' + Math.abs(h).toString(36);
  } catch(e) { return 'fp_unknown'; }
}
async function ezGetIp() {
  try { const r = await fetch('https://api.ipify.org?format=json'); const j = await r.json(); return j.ip || ''; } catch(e) { return ''; }
}

/* Rebrand to PrepStride */
(function() {
  document.title = 'PrepStride — Study Planner';
  const tt = document.querySelector('.topbar-title'); if (tt) tt.innerHTML = 'Prep<span class="z">Stride</span>';
  try {
    const box = document.querySelector('.auth-logo > div:last-child');
    if (box && box.firstElementChild) box.firstElementChild.textContent = 'PrepStride';
  } catch(e) {}
})();

/* Extra registration fields: mobile + target exam */
(function() {
  const regPass = document.getElementById('reg-pass');
  const grp = regPass ? regPass.closest('.form-group') : null;
  if (!grp || document.getElementById('reg-mobile')) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = '<div class="form-group"><label class="form-label">Mobile Number</label>' +
    '<input class="form-input" type="tel" id="reg-mobile" placeholder="10-digit mobile number" maxlength="10"></div>' +
    '<div class="form-group"><label class="form-label">Target Exam</label>' +
    '<select class="form-input" id="reg-exam">' +
    '<option value="">Select your exam...</option>' +
    '<option value="cgl">SSC CGL</option><option value="ntpc">RRB NTPC</option>' +
    '<option value="gd">SSC GD</option><option value="ibps">IBPS PO</option>' +
    '<option value="upsc">UPSC CSE</option><option value="uppcs">UPPCS</option>' +
    '<option value="bpsc">BPSC</option></select></div>';
  while (wrap.firstChild) grp.parentNode.insertBefore(wrap.firstChild, grp.nextSibling === null ? null : grp.nextSibling);
})();

