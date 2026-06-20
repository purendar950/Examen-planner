/* ══════════════════════════════════════════════
   PREPPATH PHASE 2 — PLANS, UPI PAYMENTS, PLAN BADGE
══════════════════════════════════════════════ */
/* Fallback UPI — used only if admin has not saved one in Admin Panel → Plans → Payment Settings */
const EZ_UPI_FALLBACK = { upiId: 'yourname@upi', payeeName: 'PrepStride' };
let EZ_PLANS = [], EZ_PROFILE = null, EZ_UPI = null, EZ_PENDING_PAY = null, _ezPickedPlan = null, _ezCoupon = null, _ezFinalAmount = 0;

async function ezLoadPlans() {
  if (!_fbReady || !db) return;
  try { const s = await db.collection('plans').get(); EZ_PLANS = s.docs.map(d => ({ id: d.id, ...d.data() })); } catch(e) {}
  try { const c = await db.collection('config').doc('payment').get(); EZ_UPI = c.exists ? c.data() : null; } catch(e) {}
  try {
    const fl = await db.collection('config').doc('free').get();
    if (fl.exists) {
      const fd = fl.data();
      EZ_FREE_LIMITS = {
        mocks:      (fd.mocks      > 0 ? fd.mocks      : 5),
        mediaSaves: (fd.mediaSaves > 0 ? fd.mediaSaves : 2),
        notes:      (fd.notes      > 0 ? fd.notes      : 10)
      };
    }
  } catch(e) {}
}

async function ezLoadProfile() {
  if (!currentUser || !_fbReady || !db) return;
  try {
    const s = await db.collection('users').doc(currentUser.uid).get();
    EZ_PROFILE = (s.exists && s.data().profile) || {};
  } catch(e) { EZ_PROFILE = {}; }
  try {
    const q = await db.collection('payments').where('uid', '==', currentUser.uid).get();
    const pend = q.docs.map(d => ({ id: d.id, ...d.data() })).filter(p => p.status === 'pending');
    EZ_PENDING_PAY = pend.length ? pend[0] : null;
  } catch(e) { EZ_PENDING_PAY = null; }
  ezRenderPlanBadge();
  // FIX 1: Re-apply ALL gates now that EZ_PROFILE is loaded from Firestore.
  // Without this, gates installed at loginUser() time all ran with EZ_PROFILE=null
  // (which makes ezIsPro() return false → ezGated() false → gates OPEN for everyone).
  // Calling ezRefreshGates() here corrects the gating state once the real plan
  // data arrives (~400ms after login).
  try { if (typeof ezRefreshGates === 'function') ezRefreshGates(); } catch(e) {}
  try { await ezLoadAnnouncement(); } catch(e) {}
}

/* ── Broadcast announcement banner (admin sets config/settings.announcement) ── */
let EZ_ANNOUNCE = null;
async function ezLoadAnnouncement() {
  if (!_fbReady || !db) return;
  try {
    const s = await db.collection('config').doc('settings').get();
    const data = s.exists ? s.data() : {};
    EZ_ANNOUNCE = (data && data.announcement) || null;
  } catch(e) { EZ_ANNOUNCE = null; }
  ezRenderAnnouncement();
}
function ezRenderAnnouncement() {
  const existing = document.getElementById('ez-announce-banner');
  const a = EZ_ANNOUNCE;
  const dismissed = (appState && appState.dismissedAnnouncement) || '';
  if (!a || !a.active || !a.text || a.id === dismissed) {
    if (existing) existing.remove();
    return;
  }
  let bar = existing;
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'ez-announce-banner';
    bar.style.cssText = 'position:relative;z-index:45;background:var(--accent-dim);border-bottom:1px solid rgba(0,200,150,0.3);color:var(--text);padding:8px 40px 8px 14px;font-size:0.82rem;line-height:1.5;text-align:center;';
    const app = document.getElementById('app');
    const topbar = app ? app.querySelector('.topbar') : null;
    if (topbar && topbar.nextSibling) topbar.parentNode.insertBefore(bar, topbar.nextSibling);
    else if (app) app.insertBefore(bar, app.firstChild);
    else document.body.insertBefore(bar, document.body.firstChild);
  }
  bar.innerHTML = '📢 ' + escapeHtml(a.text) +
    '<button onclick="ezDismissAnnouncement()" title="Dismiss" style="position:absolute;top:50%;right:10px;transform:translateY(-50%);background:none;border:none;color:var(--muted);font-size:1rem;cursor:pointer;">✕</button>';
}
function ezDismissAnnouncement() {
  if (EZ_ANNOUNCE && EZ_ANNOUNCE.id) {
    appState.dismissedAnnouncement = EZ_ANNOUNCE.id;
    try { saveProgress(); } catch(e) {}
  }
  const bar = document.getElementById('ez-announce-banner');
  if (bar) bar.remove();
}

function ezRenderPlanBadge() {
  let b = document.getElementById('ez-plan-badge');
  if (!b) {
    const right = document.querySelector('.topbar-right');
    if (!right) return;
    b = document.createElement('div');
    b.id = 'ez-plan-badge';
    b.style.cssText = 'cursor:pointer;border-radius:99px;padding:4px 12px;font-size:0.72rem;font-weight:700;border:1px solid var(--border);background:var(--surface);color:var(--muted);white-space:nowrap;';
    b.onclick = ezOpenUpgrade;
    right.insertBefore(b, right.firstChild);
  }
  const today = new Date().toISOString().slice(0, 10);
  const plan = (EZ_PROFILE && EZ_PROFILE.plan && EZ_PROFILE.plan !== 'free') ? EZ_PROFILE.plan : null;
  const expired = plan && EZ_PROFILE.planExpiry && EZ_PROFILE.planExpiry < today;
  if (plan && !expired) {
    // Active paid plan
    b.textContent = '💎 ' + plan;
    b.style.color = 'var(--accent)'; b.style.borderColor = 'rgba(0,200,150,0.4)';
  } else if (plan && expired) {
    // FIX 3a: Explicitly show expired plan state so user knows to renew.
    b.textContent = '💎 ' + plan + ' (Expired)';
    b.style.color = 'var(--red,#EF4444)'; b.style.borderColor = 'rgba(239,68,68,0.4)';
  } else if (typeof ezIsProTrialActive === 'function' && ezIsProTrialActive()) {
    // FIX 3b: Show active self-serve trial with days remaining.
    var daysLeft = (typeof ezProTrialDaysLeft === 'function') ? ezProTrialDaysLeft() : 0;
    b.textContent = '⏳ Trial: ' + daysLeft + 'd left';
    b.style.color = 'var(--accent)'; b.style.borderColor = 'rgba(0,200,150,0.3)';
  } else if (typeof ezIsTrialActive === 'function' && ezIsTrialActive()) {
    // FIX 3c: Admin-granted trial from EZ_PROFILE.trialExpiry.
    var adminDays = (typeof ezGetTrialDaysLeft === 'function') ? ezGetTrialDaysLeft() : 0;
    b.textContent = '⏳ Trial: ' + adminDays + 'd left';
    b.style.color = 'var(--accent)'; b.style.borderColor = 'rgba(0,200,150,0.3)';
  } else if (EZ_PENDING_PAY) {
    b.textContent = '⏳ Payment verifying';
    b.style.color = 'var(--amber,#F59E0B)'; b.style.borderColor = 'rgba(245,158,11,0.4)';
  } else {
    b.textContent = '⬆ Upgrade';
    b.style.color = 'var(--muted)'; b.style.borderColor = 'var(--border)';
  }
}

function ezOpenUpgrade() {
  if (!currentUser) return;
  let ov = document.getElementById('ez-upgrade-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'ez-upgrade-overlay';
    ov.className = 'ch-link-modal-overlay';
    ov.onclick = function(e) { if (e.target === ov) ov.classList.remove('open'); };
    document.body.appendChild(ov);
  }
  ov.classList.add('open');
  ezRenderUpgrade();
}

function ezRenderUpgrade() {
  const ov = document.getElementById('ez-upgrade-overlay'); if (!ov) return;
  let inner = '<div class="ch-link-modal" style="max-width:520px;max-height:85vh;overflow-y:auto;">';
  inner += '<h3>💎 Upgrade Plan</h3>';
  const today = new Date().toISOString().slice(0, 10);
  const plan = (EZ_PROFILE && EZ_PROFILE.plan && EZ_PROFILE.plan !== 'free') ? EZ_PROFILE.plan : null;
  const expired = plan && EZ_PROFILE.planExpiry && EZ_PROFILE.planExpiry < today;
  if (plan && !expired) inner += '<div class="modal-sub">Current plan: <strong style="color:var(--accent)">' + escapeHtml(plan) + '</strong>' + (EZ_PROFILE.planExpiry ? ' · valid till ' + EZ_PROFILE.planExpiry : '') + '</div>';
  if (expired) inner += '<div class="modal-sub" style="color:var(--red)">Aapka ' + escapeHtml(plan) + ' plan expire ho gaya (' + EZ_PROFILE.planExpiry + '). Renew karo ↓</div>';
  if (EZ_PENDING_PAY) {
    inner += '<div style="background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.3);border-radius:8px;padding:10px 14px;font-size:0.82rem;color:var(--amber);margin-bottom:1rem;line-height:1.6;">⏳ Aapki payment (Txn: <strong>' + escapeHtml(EZ_PENDING_PAY.txnId || '') + '</strong> · ₹' + (EZ_PENDING_PAY.amount || 0) + ' · ' + escapeHtml(EZ_PENDING_PAY.planName || '') + ') admin verification mein hai. Verify hote hi plan activate ho jayega.</div>';
  }
  if (!EZ_PLANS.length) {
    inner += '<div style="color:var(--muted);font-size:0.85rem;padding:1rem 0;">Abhi koi paid plan available nahi hai. Thodi der baad check karo.</div>';
  } else {
    inner += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin:1rem 0;">';
    EZ_PLANS.forEach(function(p, idx) {
      const isPopular = idx === 0;
      const featList = p.features ? (Array.isArray(p.features) ? p.features : String(p.features).split(',')) : [];
      inner +=
        '<div style="position:relative;border:2px solid ' + (isPopular ? 'var(--accent)' : 'var(--border)') + ';border-radius:16px;padding:1.4rem 1.2rem;text-align:center;background:' + (isPopular ? 'rgba(0,200,150,0.05)' : 'var(--surface)') + ';box-shadow:' + (isPopular ? '0 8px 24px rgba(0,200,150,0.15)' : 'none') + ';">' +
        (isPopular ? '<div style="position:absolute;top:-13px;left:50%;transform:translateX(-50%);background:var(--accent);color:#fff;font-size:0.68rem;font-weight:700;border-radius:99px;padding:3px 12px;white-space:nowrap;">MOST POPULAR</div>' : '') +
        '<div style="font-weight:700;font-size:1rem;margin-bottom:4px;">' + escapeHtml(p.name) + '</div>' +
        '<div style="font-size:2rem;font-weight:800;color:' + (isPopular ? 'var(--accent)' : 'var(--text)') + ';margin:8px 0 2px;">&#8377;' + (p.price || 0) + '</div>' +
        '<div style="font-size:0.72rem;color:var(--muted);margin-bottom:12px;">' + (p.days || 30) + ' days</div>' +
        (featList.length ? '<ul style="list-style:none;padding:0;margin:0 0 14px;text-align:left;">' + featList.map(function(f){ return '<li style="font-size:0.78rem;color:var(--muted);padding:3px 0;"><span style="color:var(--accent);font-weight:700;">✓</span> ' + escapeHtml(f.trim()) + '</li>'; }).join('') + '</ul>' : '') +
        '<button onclick="ezPickPlan(\'' + p.id + '\')" style="width:100%;padding:10px;border-radius:10px;border:none;background:' + (isPopular ? 'var(--accent)' : 'var(--border)') + ';color:' + (isPopular ? '#fff' : 'var(--text)') + ';font-weight:700;font-size:0.88rem;cursor:pointer;">Buy Now</button>' +
        '</div>';
    });
    inner += '</div>';
  }
  /* ── Free vs Pro comparison + self-serve 3-day trial ── */
  inner += ezFreeProCompareHtml();
  inner += '<div id="ez-pay-step" style="display:none;margin-top:1rem;border-top:1px solid var(--border);padding-top:1rem;"></div>';
  inner += '<div class="modal-actions" style="margin-top:1rem;"><button class="btn-modal-cancel" onclick="document.getElementById(\'ez-upgrade-overlay\').classList.remove(\'open\')">Close</button></div>';
  inner += '</div>';
  ov.innerHTML = inner;
}

/* Free vs Pro feature comparison shown inside the upgrade modal, plus a
   one-time 3-day trial CTA. */
function ezFreeProCompareHtml() {
  var rows = [
    ['App access', 'Full app — every page unlocked', 'Full app, no usage limits + advanced tools'],
    ['Exams', '1 (your target)', 'All exams + switching'],
    ['Mock tests — saves & analysis', 'Up to ' + EZ_FREE_LIMITS.mocks + ' saves, no analysis', 'Unlimited saves + full analysis (trends, weak areas, percentile)'],
    ['Video notes & saved playlists', 'Up to ' + EZ_FREE_LIMITS.notes + ' notes · ' + EZ_FREE_LIMITS.mediaSaves + ' playlists/links', 'Unlimited notes · up to 10 playlists/links'],
    ['Weekly / Monthly planner view', '—', '✓'],
    ['AI study plan + auto-reschedule', '—', '✓'],
    ['Auto daily plan on Telegram', '—', '✓'],
    ['PDF export (plans / notes)', '—', '✓']
  ];
  var body = rows.map(function(r) {
    return '<tr>' +
      '<td style="padding:6px 8px;font-size:.78rem;">' + r[0] + '</td>' +
      '<td style="padding:6px 8px;font-size:.78rem;color:var(--muted);text-align:center;">' + r[1] + '</td>' +
      '<td style="padding:6px 8px;font-size:.78rem;color:var(--accent);text-align:center;font-weight:700;">' + r[2] + '</td>' +
    '</tr>';
  }).join('');
  var trialBtn = '';
  const _todayForBadge = new Date().toISOString().slice(0, 10);
  const _expiredPlan = EZ_PROFILE && EZ_PROFILE.plan && EZ_PROFILE.plan !== 'free'
    && EZ_PROFILE.planExpiry && EZ_PROFILE.planExpiry < _todayForBadge;
  if (_expiredPlan) {
    // FIX 7a: Plan expired — show Renew CTA prominently instead of upgrade flow
    trialBtn = '<div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:10px 14px;margin-top:12px;text-align:center;">' +
      '<div style="font-size:.82rem;color:#EF4444;font-weight:700;margin-bottom:6px;">⚠ Aapka ' + escapeHtml(EZ_PROFILE.plan) + ' plan expire ho gaya (' + EZ_PROFILE.planExpiry + ')</div>' +
      '<div style="font-size:.72rem;color:var(--muted);">Neeche koi bhi plan select karke renew karo — Pro features turant restore ho jayenge.</div>' +
      '</div>';
  } else if (currentUser && typeof ezIsPro === 'function' && !ezIsPro() && !ezProTrialUsed()) {
    // No plan, no trial used yet — offer free trial
    trialBtn = '<button class="btn-modal-save" style="width:100%;margin-top:12px;" onclick="ezStartProTrial()">🎁 Start 3-day free Pro trial</button>' +
      '<div style="font-size:.68rem;color:var(--muted);text-align:center;margin-top:4px;">No payment needed — ek baar hi milta hai.</div>';
  } else if (typeof ezIsProTrialActive === 'function' && ezIsProTrialActive()) {
    // FIX 7b: Trial active — show countdown
    trialBtn = '<div style="font-size:.78rem;color:var(--accent);text-align:center;margin-top:12px;font-weight:700;">⏳ Pro trial active — ' + ezProTrialDaysLeft() + ' din baaki</div>';
  } else if (typeof ezProTrialUsed === 'function' && ezProTrialUsed() && !ezIsProTrialActive()) {
    // FIX 7c: Trial was used but has now expired — acknowledge it
    trialBtn = '<div style="font-size:.78rem;color:var(--muted);text-align:center;margin-top:12px;">Free trial khatam ho gaya. Neeche koi plan le kar upgrade karo.</div>';
  }
  return '<div style="margin-top:1.25rem;border-top:1px solid var(--border);padding-top:1rem;">' +
    '<div style="font-weight:700;font-size:.9rem;margin-bottom:8px;">Free vs Pro</div>' +
    '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;">' +
    '<thead><tr style="background:var(--surface);">' +
      '<th style="padding:6px 8px;text-align:left;font-size:.7rem;color:var(--muted);text-transform:uppercase;">Feature</th>' +
      '<th style="padding:6px 8px;font-size:.7rem;color:var(--muted);text-transform:uppercase;">Free</th>' +
      '<th style="padding:6px 8px;font-size:.7rem;color:var(--accent);text-transform:uppercase;">Pro</th>' +
    '</tr></thead><tbody>' + body + '</tbody></table></div>' +
    trialBtn +
  '</div>';
}

function ezPickPlan(pid) {
  _ezPickedPlan = EZ_PLANS.find(p => p.id === pid); if (!_ezPickedPlan) return;
  _ezCoupon = null;
  _ezFinalAmount = _ezPickedPlan.price || 0;
  const upi = EZ_UPI && EZ_UPI.upiId ? EZ_UPI : EZ_UPI_FALLBACK;
  const amount = _ezFinalAmount;
  const upiDeep = 'upi://pay?pa=' + encodeURIComponent(upi.upiId) +
    '&pn=' + encodeURIComponent(upi.payeeName || 'PrepStride') +
    '&am=' + amount + '&cu=INR' +
    '&tn=' + encodeURIComponent('PrepStride ' + _ezPickedPlan.name);
  const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=' + encodeURIComponent(upiDeep);
  const step = document.getElementById('ez-pay-step'); if (!step) return;
  step.style.display = 'block';
  step.innerHTML =
    '<div style="font-weight:700;margin-bottom:12px;">Pay via UPI &mdash; ' + escapeHtml(_ezPickedPlan.name) + ' (<span id="ez-amount-display">Rs.' + amount + '</span>)</div>' +
    '<div style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;margin-bottom:14px;">' +
      '<div style="text-align:center;">' +
        '<img id="ez-qr-img" src="' + qrUrl + '" width="140" height="140" style="border-radius:10px;border:1px solid var(--border);" alt="UPI QR" onerror="this.style.display=\'none\'">' +
        '<div style="font-size:0.72rem;color:var(--muted);margin-top:4px;">Scan with any UPI app</div>' +
      '</div>' +
      '<div style="flex:1;min-width:200px;">' +
        '<ol style="font-size:0.82rem;color:var(--muted);padding-left:1.2rem;line-height:2;margin-bottom:10px;">' +
          '<li><a id="ez-upi-link" href="' + upiDeep + '" style="color:var(--accent);font-weight:700;">Tap to open UPI app</a><br>' +
          '<span style="font-size:0.75rem;">(GPay / PhonePe / Paytm)</span></li>' +
          '<li>UPI ID: <strong style="color:var(--accent)">' + escapeHtml(upi.upiId) + '</strong>' +
            ' <button class="yt-dur-set-btn" onclick="ezCopyUpi(\'' + escapeHtml(upi.upiId) + '\')">Copy</button></li>' +
          '<li>Amount: <strong id="ez-amount-line">Rs.' + amount + '</strong></li>' +
          '<li>Payment ke baad UTR ID niche dalo</li>' +
        '</ol>' +
      '</div>' +
    '</div>' +
    /* Coupon row */
    '<div id="ez-coupon-row" style="display:flex;gap:6px;margin-bottom:12px;align-items:center;flex-wrap:wrap;background:var(--surface);padding:10px 12px;border-radius:10px;border:1px solid var(--border);">' +
      '<span style="font-size:0.82rem;font-weight:600;">\ud83c\udfaf Have a coupon?</span>' +
      '<input id="ez-coupon-input" placeholder="Enter code" style="text-transform:uppercase;flex:1;min-width:120px;max-width:180px;padding:6px 10px;border:1px solid var(--border);border-radius:7px;font-size:0.85rem;font-family:inherit;">' +
      '<button class="yt-dur-set-btn" onclick="ezApplyCoupon()">Apply</button>' +
      '<button id="ez-coupon-remove" class="yt-dur-set-btn" style="display:none;color:var(--red);" onclick="ezRemoveCoupon()">Remove</button>' +
      '<div id="ez-coupon-msg" style="width:100%;font-size:0.78rem;margin-top:2px;"></div>' +
    '</div>' +
    '<label style="font-size:0.8rem;color:var(--muted);display:block;margin-bottom:4px;">Screenshot attach karo (optional, max 3MB)</label>' +
    '<input type="file" id="ez-ss-file" accept="image/*" style="font-size:0.8rem;width:100%;padding:6px;border:1px solid var(--border);border-radius:8px;margin-bottom:10px;">' +
    '<input class="form-input" id="ez-txn-id" placeholder="UTR / UPI Transaction ID (min 6 chars)" style="margin-bottom:10px;">' +
    '<button class="btn-modal-save" style="width:100%;" onclick="ezSubmitPayment()">Submit for Verification</button>';
  step.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* Coupon: validate against Firestore, apply discount, re-render amount + QR + UPI deep link */
async function ezApplyCoupon() {
  if (!_ezPickedPlan) return;
  const input = document.getElementById('ez-coupon-input');
  const msg = document.getElementById('ez-coupon-msg');
  const code = ((input && input.value) || '').trim().toUpperCase();
  if (!code) { msg.innerHTML = '<span style="color:var(--red);">Code dalo.</span>'; return; }
  msg.innerHTML = '<span style="color:var(--muted);">Checking\u2026</span>';
  try {
    const snap = await db.collection('coupons').doc(code).get();
    if (!snap.exists) { msg.innerHTML = '<span style="color:var(--red);">\u274c Invalid coupon code.</span>'; _ezCoupon = null; return; }
    const c = snap.data();
    if (c.enabled === false) { msg.innerHTML = '<span style="color:var(--red);">\u274c This coupon is disabled.</span>'; _ezCoupon = null; return; }
    if (c.expiresAt) {
      const expMs = c.expiresAt.toDate ? c.expiresAt.toDate().getTime() : c.expiresAt;
      if (expMs < Date.now()) { msg.innerHTML = '<span style="color:var(--red);">\u274c This coupon has expired.</span>'; _ezCoupon = null; return; }
    }
    if (c.maxUses && (c.usedCount || 0) >= c.maxUses) { msg.innerHTML = '<span style="color:var(--red);">\u274c This coupon is fully used.</span>'; _ezCoupon = null; return; }
    const baseAmount = _ezPickedPlan.price || 0;
    if (c.minAmount && baseAmount < c.minAmount) { msg.innerHTML = '<span style="color:var(--red);">\u274c Minimum plan amount \u20b9' + c.minAmount + ' required.</span>'; _ezCoupon = null; return; }
    if (c.firstTimeOnly && currentUser && currentUser.uid) {
      const u = USERS.find ? USERS.find(x => x.id === currentUser.uid) : null;
      const profile = u && u.p ? u.p : (EZ_PROFILE || {});
      const hasPaidBefore = profile.plan && profile.plan !== 'free';
      if (hasPaidBefore) { msg.innerHTML = '<span style="color:var(--red);">\u274c Sirf pehli baar upgrade karne walo ke liye.</span>'; _ezCoupon = null; return; }
    }
    const pct = Math.max(1, Math.min(100, Number(c.percentOff) || 0));
    const discount = Math.round((baseAmount * pct) / 100);
    _ezFinalAmount = Math.max(1, baseAmount - discount);
    _ezCoupon = { code: code, percentOff: pct, discount: discount, originalAmount: baseAmount };
    msg.innerHTML = '<span style="color:var(--accent-dark);font-weight:700;">\u2705 ' + pct + '% off applied \u2014 you saved \u20b9' + discount + '!</span>';
    document.getElementById('ez-amount-display').innerHTML = '<s style="color:var(--muted);font-weight:400;">Rs.' + baseAmount + '</s> <strong style="color:var(--accent);">Rs.' + _ezFinalAmount + '</strong>';
    document.getElementById('ez-amount-line').innerHTML = 'Rs.' + _ezFinalAmount + ' (after coupon)';
    document.getElementById('ez-coupon-remove').style.display = 'inline-block';
    /* Re-render QR + deep link with new amount */
    const upi = EZ_UPI && EZ_UPI.upiId ? EZ_UPI : EZ_UPI_FALLBACK;
    const upiDeep = 'upi://pay?pa=' + encodeURIComponent(upi.upiId) +
      '&pn=' + encodeURIComponent(upi.payeeName || 'PrepStride') +
      '&am=' + _ezFinalAmount + '&cu=INR' +
      '&tn=' + encodeURIComponent('PrepStride ' + _ezPickedPlan.name + ' [' + code + ']');
    const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=' + encodeURIComponent(upiDeep);
    const qrImg = document.getElementById('ez-qr-img'); if (qrImg) qrImg.src = qrUrl;
    const upiLink = document.getElementById('ez-upi-link'); if (upiLink) upiLink.href = upiDeep;
    if (input) input.disabled = true;
  } catch(e) { msg.innerHTML = '<span style="color:var(--red);">Error: ' + escapeHtml(e.message) + '</span>'; }
}

function ezRemoveCoupon() {
  if (!_ezPickedPlan) return;
  const baseAmount = _ezPickedPlan.price || 0;
  _ezFinalAmount = baseAmount;
  _ezCoupon = null;
  const input = document.getElementById('ez-coupon-input');
  if (input) { input.disabled = false; input.value = ''; }
  document.getElementById('ez-amount-display').textContent = 'Rs.' + baseAmount;
  document.getElementById('ez-amount-line').textContent = 'Rs.' + baseAmount;
  document.getElementById('ez-coupon-remove').style.display = 'none';
  document.getElementById('ez-coupon-msg').innerHTML = '';
  /* Reset QR to full price */
  const upi = EZ_UPI && EZ_UPI.upiId ? EZ_UPI : EZ_UPI_FALLBACK;
  const upiDeep = 'upi://pay?pa=' + encodeURIComponent(upi.upiId) +
    '&pn=' + encodeURIComponent(upi.payeeName || 'PrepStride') +
    '&am=' + baseAmount + '&cu=INR' +
    '&tn=' + encodeURIComponent('PrepStride ' + _ezPickedPlan.name);
  const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=' + encodeURIComponent(upiDeep);
  const qrImg = document.getElementById('ez-qr-img'); if (qrImg) qrImg.src = qrUrl;
  const upiLink = document.getElementById('ez-upi-link'); if (upiLink) upiLink.href = upiDeep;
}

function ezCopyUpi(id) {
  try { navigator.clipboard.writeText(id); showToast('UPI ID copied! 📋', 'success'); } catch(e) { showToast(id, 'info'); }
}

async function ezSubmitPayment() {
  const txn = (document.getElementById('ez-txn-id') || { value: '' }).value.trim();
  if (!txn || txn.length < 6) { showToast('Valid UPI Transaction ID dalo.', 'error'); return; }
  if (!_ezPickedPlan || !currentUser || !_fbReady) return;
  const btn = document.querySelector('[onclick="ezSubmitPayment()"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Uploading...'; }
  try {
    let screenshotUrl = null;
    const fileInput = document.getElementById('ez-ss-file');
    if (fileInput && fileInput.files && fileInput.files[0]) {
      const file = fileInput.files[0];
      if (file.size > 3 * 1024 * 1024) {
        showToast('Screenshot max 3MB hona chahiye.', 'error');
        if (btn) { btn.disabled = false; btn.textContent = 'Submit for Verification'; }
        return;
      }
      const storageRef = firebase.storage().ref('payment_screenshots/' + currentUser.uid + '_' + Date.now());
      const snap = await storageRef.put(file);
      screenshotUrl = await snap.ref.getDownloadURL();
    }
    const payRef = await db.collection('payments').add({
      uid: currentUser.uid, email: currentUser.email,
      planId: _ezPickedPlan.id, planName: _ezPickedPlan.name,
      amount: _ezFinalAmount, originalAmount: _ezPickedPlan.price || 0,
      txnId: txn, screenshotUrl: screenshotUrl || null,
      couponCode: _ezCoupon ? _ezCoupon.code : null,
      couponPercent: _ezCoupon ? _ezCoupon.percentOff : null,
      discountAmount: _ezCoupon ? _ezCoupon.discount : 0,
      status: 'pending', createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    /* Log redemption + increment coupon usedCount atomically.
       We only count redemptions when a payment was actually submitted, so abandoned
       "Apply then close" attempts don't burn the code. */
    if (_ezCoupon) {
      try {
        await db.collection('coupon_redemptions').add({
          couponCode: _ezCoupon.code,
          uid: currentUser.uid, email: currentUser.email,
          planId: _ezPickedPlan.id, planName: _ezPickedPlan.name,
          originalAmount: _ezPickedPlan.price || 0,
          discountAmount: _ezCoupon.discount,
          finalAmount: _ezFinalAmount,
          paymentId: payRef.id,
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        await db.collection('coupons').doc(_ezCoupon.code).update({
          usedCount: firebase.firestore.FieldValue.increment(1)
        });
        // Track per-user coupons used (for first-time-only enforcement)
        try {
          await db.collection('users').doc(currentUser.uid).update({
            'profile.couponsUsed': firebase.firestore.FieldValue.arrayUnion(_ezCoupon.code)
          });
        } catch(e2) {}
      } catch(couponErr) {
        // Don't fail the whole submission if coupon log fails — admin will see discrepancy
        console.warn('Coupon log failed:', couponErr);
      }
    }
    showToast(_ezCoupon ? 'Payment submitted with ' + _ezCoupon.percentOff + '% off! Admin verify karega.' : 'Payment submitted! Admin verify karega aur plan activate hoga.', 'success');
    await ezLoadProfile();
    ezRenderUpgrade();
  } catch(e) {
    showToast('Submit failed: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Submit for Verification'; }
  }
}

/* Load plans + profile after login */
const _loginUserBaseEZ2 = loginUser;
loginUser = function(email, name, uid, state) {
  _loginUserBaseEZ2(email, name, uid, state);
  setTimeout(function() { ezLoadPlans().then(function() { return ezLoadProfile(); }); }, 400);
};

