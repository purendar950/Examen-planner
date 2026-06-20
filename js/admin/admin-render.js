/* PrepPath Admin — RENDER: all render*() view builders (read-only HTML generation).
   Depends on globals from admin-core.js; must load after it. */

function userMeta(u) {
  return '<div class="muted" style="margin-top:3px;">📱 ' + esc(u.p.mobile || '—') + ' · 🎯 ' + esc((u.p.examTarget || '—').toUpperCase()) + ' · 🕒 ' + fmtDate(u.p.requestedAt || u.p.createdAt) + (u.p.referredBy ? ' · 🔗 ref: ' + esc(u.p.referredBy.substring(0, 10)) + '…' : '') + '</div>' +
    '<div class="muted">fp: ' + esc(u.p.fp || '—') + ' · ip: ' + esc(u.p.ip || '—') + '</div>' +
    flagsFor(u).map(f => '<span class="flag">⚠ ' + f + '</span>').join('');
}

/* Initials for the user avatar (e.g. "Vijay Sharma" -> "VS"). */
function userInitials(name, email) {
  const src = (name || '').trim() || (email || '').trim();
  if (!src) return '?';
  const parts = src.split(/[\s._@]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.substring(0, 2).toUpperCase();
}

/* Deterministic avatar background gradient from a string. */
function avatarColor(str) {
  const palette = [
    ['#6366F1', '#8B5CF6'], ['#0EA5E9', '#22D3EE'], ['#10B981', '#34D399'],
    ['#F59E0B', '#FBBF24'], ['#EF4444', '#F87171'], ['#EC4899', '#F472B6'],
    ['#14B8A6', '#2DD4BF'], ['#8B5CF6', '#A78BFA']
  ];
  let h = 0;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const [a, b] = palette[h % palette.length];
  return 'linear-gradient(135deg,' + a + ',' + b + ')';
}

function renderAnalytics() {
  var now = new Date();
  var dayMs = 86400000;
  function tsToDate(ts) { try { return ts && ts.toDate ? ts.toDate() : (ts ? new Date(ts) : null); } catch(e) { return null; } }
  function within(ts, days) {
    var d = tsToDate(ts); if (!d) return false;
    return (now - d) <= days * dayMs;
  }

  var total = USERS.length;
  var pending = USERS.filter(function(u){ return u.p.status === 'pending'; }).length;
  var approved = USERS.filter(function(u){ return u.p.status === 'approved' || !u.p.status; }).length;
  var paid = USERS.filter(function(u){ return u.p.plan && u.p.plan !== 'free'; }).length;
  var free = total - paid;

  var new1 = USERS.filter(function(u){ return within(u.p.createdAt || u.p.requestedAt, 1); }).length;
  var new7 = USERS.filter(function(u){ return within(u.p.createdAt || u.p.requestedAt, 7); }).length;
  var new30 = USERS.filter(function(u){ return within(u.p.createdAt || u.p.requestedAt, 30); }).length;

  /* Revenue from verified payments (status approved/verified). */
  var verified = PAYMENTS.filter(function(p){ return p.status === 'approved' || p.status === 'verified'; });
  var revenue = verified.reduce(function(t, p){ return t + (Number(p.amount) || 0); }, 0);
  var rev30 = verified.filter(function(p){ return within(p.createdAt, 30); }).reduce(function(t, p){ return t + (Number(p.amount) || 0); }, 0);
  var payPending = PAYMENTS.filter(function(p){ return p.status === 'pending'; }).length;

  var redemptions = (REDEMPTIONS || []).length;
  var freePct = total ? Math.round(free / total * 100) : 0;
  var paidPct = total ? Math.round(paid / total * 100) : 0;

  /* Exam distribution. */
  var examCount = {};
  USERS.forEach(function(u){ var e = (u.p.examTarget || 'unknown'); examCount[e] = (examCount[e] || 0) + 1; });
  var examRows = Object.keys(examCount).sort(function(a,b){ return examCount[b] - examCount[a]; }).map(function(e){
    var pct = total ? Math.round(examCount[e] / total * 100) : 0;
    return '<div style="margin-bottom:6px;"><div class="row" style="justify-content:space-between;"><span style="font-size:.8rem;">' + esc(e.toUpperCase()) + '</span><span class="muted">' + examCount[e] + ' (' + pct + '%)</span></div>' +
      '<span class="bar-mini" style="width:' + Math.max(2, pct) + '%;"></span></div>';
  }).join('') || '<div class="muted">No data.</div>';

  /* Top feature-request types. */
  var reqType = {};
  (REQUESTS || []).forEach(function(r){ var t = r.type || 'other'; reqType[t] = (reqType[t] || 0) + 1; });
  var reqRows = Object.keys(reqType).sort(function(a,b){ return reqType[b] - reqType[a]; }).map(function(t){
    return '<tr><td style="padding:5px 8px;font-size:.8rem;">' + esc(t) + '</td><td style="padding:5px 8px;text-align:right;font-weight:700;">' + reqType[t] + '</td></tr>';
  }).join('') || '<tr><td class="muted" style="padding:8px;">No requests yet.</td></tr>';

  var stat = function(val, label, color) {
    return '<div class="stat"><b' + (color ? ' style="color:' + color + '"' : '') + '>' + val + '</b><div>' + label + '</div></div>';
  };

  return '<h3>📊 Overview</h3>' +
    '<div class="stat-row">' +
      stat(total, 'Total users') +
      stat(new1, 'New today', 'var(--accent-dark)') +
      stat(new7, 'New (7 days)', 'var(--accent-dark)') +
      stat(new30, 'New (30 days)', 'var(--accent-dark)') +
    '</div>' +
    '<div class="stat-row">' +
      stat(paid + ' (' + paidPct + '%)', 'Pro / paid', 'var(--blue)') +
      stat(free + ' (' + freePct + '%)', 'Free users') +
      stat('₹' + revenue, 'Revenue (verified)', 'var(--accent-dark)') +
      stat('₹' + rev30, 'Revenue (30d)', 'var(--accent-dark)') +
    '</div>' +
    '<div class="stat-row">' +
      stat(verified.length, 'Verified payments') +
      stat(payPending, 'Payments to verify', 'var(--red)') +
      stat(redemptions, 'Coupon redemptions') +
      stat(pending, 'Pending approvals', 'var(--amber)') +
    '</div>' +
    '<div class="card"><h3>🎯 Users by target exam</h3>' + examRows + '</div>' +
    '<div class="card"><h3>💡 Feature requests by type</h3>' +
      '<table style="width:100%;border-collapse:collapse;"><tbody>' + reqRows + '</tbody></table></div>' +
    '<div class="muted" style="margin-top:4px;">Read-only snapshot. Use ↻ Refresh for the latest.</div>';
}

function renderPending() {
  const list = USERS.filter(u => u.p.status === 'pending');
  if (!list.length) return '<div class="empty">&#127881; Koi pending request nahi hai.</div>';
  return list.map(u => {
    const dupBadge = u.p.deviceDuplicate
      ? '<span class="badge badge-amber" title="Same device fingerprint as an existing account">&#128273; Same Device</span>'
      : '<span class="badge badge-green">New Device</span>';
    const examBadge = u.p.examTarget
      ? '<span class="badge badge-blue">' + esc(u.p.examTarget) + '</span>'
      : '';
    return '<div class="card"><div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:10px;">' +
    '<div style="flex:1;min-width:220px;">' +
    '<strong>' + esc(u.p.name || '?') + '</strong> ' + dupBadge + ' ' + examBadge +
    '<div class="muted" style="margin-top:3px;font-size:0.8rem;">' + esc(u.p.email || '') + ' &middot; ' + esc(u.p.mobile || '') + ' &middot; ' + fmtDate(u.p.requestedAt) + '</div>' +
    userMeta(u) + '</div>' +
    '<div class="row">' +
    '<button class="btn btn-green" onclick="approveUser(\'' + u.id + '\')">&#10003; Approve</button>' +
    '<button class="btn btn-red" onclick="rejectUser(\'' + u.id + '\')">&#10005; Reject</button>' +
    '</div></div></div>';
  }).join('');
}

function renderUsers() {
  const search = (document.getElementById('user-search')?.value || '').toLowerCase().trim();
  const filter = document.getElementById('user-filter')?.value || 'all';
  const exam   = document.getElementById('user-exam')?.value || 'all';
  let list = USERS.filter(u => u.p.status !== 'pending');
  if (search) list = list.filter(u =>
    (u.p.name   || '').toLowerCase().includes(search) ||
    (u.p.email  || '').toLowerCase().includes(search) ||
    (u.p.mobile || '').toLowerCase().includes(search) ||
    (u.id       || '').toLowerCase().includes(search)
  );
  if (filter === 'paid')      list = list.filter(u => u.p.plan && u.p.plan !== 'free');
  else if (filter === 'free') list = list.filter(u => !u.p.plan || u.p.plan === 'free');
  else if (filter === 'suspended') list = list.filter(u => u.p.status === 'rejected');
  if (exam !== 'all') list = list.filter(u => u.p.examTarget === exam);
  const totalCount = USERS.filter(u => u.p.status !== 'pending').length;
  const examOptions = [...new Set(USERS.map(u => u.p.examTarget).filter(Boolean))].sort();
  const toolbar = '<div class="card" style="padding:0.75rem 1rem;">' +
    '<div class="row" style="gap:8px;flex-wrap:wrap;">' +
      '<input id="user-search" placeholder="🔍 Search name, email, mobile, UID…" ' +
             'value="' + esc(search) + '" style="flex:1;min-width:200px;" oninput="render()">' +
      '<select id="user-filter" onchange="render()">' +
        '<option value="all"'         + (filter==='all'?' selected':'') + '>All (' + totalCount + ')</option>' +
        '<option value="paid"'        + (filter==='paid'?' selected':'') + '>Paid only</option>' +
        '<option value="free"'        + (filter==='free'?' selected':'') + '>Free only</option>' +
        '<option value="suspended"'   + (filter==='suspended'?' selected':'') + '>Suspended</option>' +
      '</select>' +
      '<select id="user-exam" onchange="render()">' +
        '<option value="all">All exams</option>' +
        examOptions.map(e => '<option value="' + esc(e) + '"' + (exam===e?' selected':'') + '>' + esc(e).toUpperCase() + '</option>').join('') +
      '</select>' +
      (search || filter !== 'all' || exam !== 'all'
        ? '<button class="btn btn-gray" onclick="document.getElementById(\'user-search\').value=\'\';document.getElementById(\'user-filter\').value=\'all\';document.getElementById(\'user-exam\').value=\'all\';render();">↻ Clear</button>'
        : '') +
    '</div>' +
    '<div class="muted" style="margin-top:6px;">Showing <strong>' + list.length + '</strong> of ' + totalCount + ' users</div>' +
    '</div>';
  if (!totalCount) return '<div class="empty">Koi user nahi.</div>';
  if (!list.length) return toolbar + '<div class="empty">No users match your filters.</div>';
  const planOpts = (sel) => '<option value="free">Free</option>' + PLANS.map(p => '<option value="' + p.id + '"' + (sel === p.name ? ' selected' : '') + '>' + esc(p.name) + ' (₹' + (p.price || 0) + ')</option>').join('');
  return toolbar + list.map(u => {
    const suspended = u.p.status === 'rejected';
    const trialSuspended = !!u.p.trialSuspended;
    const isPaid = u.p.plan && u.p.plan !== 'free';
    const planBadge = isPaid
      ? '<span class="badge badge-blue">⭐ ' + esc(u.p.plan) + (u.p.planExpiry ? ' · till ' + esc(u.p.planExpiry) : '') + '</span>'
      : '<span class="badge badge-green">Free</span>';
    const badges = planBadge +
      (suspended ? ' <span class="badge badge-red">⏸ Suspended</span>' : '') +
      (trialSuspended ? ' <span class="badge badge-red">Trial Suspended</span>' : '') +
      (u.p.trialExpiry && !trialSuspended ? ' <span class="badge badge-amber">🎁 Trial</span>' : '');

    // Metadata chips
    const chips = [];
    chips.push('<span class="uc-chip">📱 ' + esc(u.p.mobile || '—') + '</span>');
    if (u.p.examTarget) chips.push('<span class="uc-chip">🎯 ' + esc(u.p.examTarget.toUpperCase()) + '</span>');
    chips.push('<span class="uc-chip">🕒 ' + fmtDate(u.p.requestedAt || u.p.createdAt) + '</span>');
    if (u.p.ip) chips.push('<span class="uc-chip">🌐 ' + esc(u.p.ip) + '</span>');
    if (u.p.referredBy) chips.push('<span class="uc-chip">🔗 ' + esc(u.p.referredBy.substring(0, 8)) + '…</span>');
    flagsFor(u).forEach(f => chips.push('<span class="uc-chip warn">⚠ ' + f + '</span>'));

    // Context-aware trial button
    const trialBtn = u.p.trialSuspended
      ? '<button class="btn btn-green btn-sm" onclick="restoreTrial(\'' + u.id + '\')" title="Restore suspended trial access">▶ Restore Trial</button>'
      : u.p.trialExpiry
        ? '<button class="btn btn-amber btn-sm" onclick="clearTrial(\'' + u.id + '\')" title="Remove this user trial">✕ Remove Trial</button>'
        : '<button class="btn btn-gray btn-sm" onclick="giveTrial(\'' + u.id + '\')" title="Grant a free trial">🎁 Give Trial</button>';

    return '<div class="card user-card">' +
      '<div class="uc-top">' +
        '<div class="uc-avatar" style="background:' + avatarColor(u.p.name || u.p.email || u.id) + ';">' + esc(userInitials(u.p.name, u.p.email)) + '</div>' +
        '<div class="uc-info">' +
          '<div class="uc-name">' + esc(u.p.name || 'Unnamed user') + '</div>' +
          '<div class="uc-email">' + esc(u.p.email || '') + '</div>' +
          '<div class="uc-badges">' + badges + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="uc-meta">' + chips.join('') + '</div>' +
      '<div class="uc-actions">' +
        '<div class="uc-plan-group">' +
          '<select id="plan-' + u.id + '">' + planOpts(u.p.plan) + '</select>' +
          '<button class="btn btn-blue btn-sm" onclick="setPlan(\'' + u.id + '\')">Set Plan</button>' +
        '</div>' +
        trialBtn +
        '<button class="btn btn-gray btn-sm" onclick="showUserPayments(\'' + u.id + '\')" title="View this user payments">🧾 Payments</button>' +
        ((u.p.fp || u.p.deviceDuplicate) ? '<button class="btn btn-gray btn-sm" onclick="resetDeviceFlag(\'' + u.id + '\')" title="Clear device fingerprint / duplicate flag">🔓 Reset Device</button>' : '') +
        (suspended
          ? '<button class="btn btn-green btn-sm" onclick="approveUser(\'' + u.id + '\')">✓ Re-activate</button>'
          : '<button class="btn btn-red btn-sm" onclick="suspendUser(\'' + u.id + '\')">⏸ Suspend</button>') +
      '</div>' +
      '<div id="user-pay-' + u.id + '" style="display:none;padding:0 1.1rem 0.9rem;"></div>' +
    '</div>';
  }).join('');
}

/* Show a user's payment history inline (from already-loaded PAYMENTS). */
function showUserPayments(uid) {
  const box = document.getElementById('user-pay-' + uid);
  if (!box) return;
  if (box.style.display === 'block') { box.style.display = 'none'; return; }
  const list = PAYMENTS.filter(p => p.uid === uid);
  if (!list.length) {
    box.innerHTML = '<div class="muted" style="padding:8px;border-top:1px solid var(--border);">No payments for this user.</div>';
  } else {
    const badge = s => s === 'verified' || s === 'approved' ? 'badge-green' : (s === 'declined' ? 'badge-red' : 'badge-amber');
    box.innerHTML = '<div style="border-top:1px solid var(--border);padding-top:8px;">' +
      '<table style="width:100%;border-collapse:collapse;font-size:.78rem;"><thead><tr style="text-align:left;color:var(--muted);">' +
      '<th style="padding:4px 6px;">Date</th><th style="padding:4px 6px;">Plan</th><th style="padding:4px 6px;">Amount</th><th style="padding:4px 6px;">Txn</th><th style="padding:4px 6px;">Status</th></tr></thead><tbody>' +
      list.map(p => '<tr>' +
        '<td style="padding:4px 6px;">' + fmtDate(p.createdAt) + '</td>' +
        '<td style="padding:4px 6px;">' + esc(p.planName || p.planId || '') + '</td>' +
        '<td style="padding:4px 6px;">₹' + (Number(p.amount) || 0) + '</td>' +
        '<td style="padding:4px 6px;">' + esc(p.txnId || '') + '</td>' +
        '<td style="padding:4px 6px;"><span class="badge ' + badge(p.status) + '">' + esc(p.status || '') + '</span></td>' +
      '</tr>').join('') +
      '</tbody></table></div>';
  }
  box.style.display = 'block';
}

/* Clear a user's device fingerprint + duplicate flag (e.g. wrongly flagged). */
async function resetDeviceFlag(id) {
  if (!confirm('Is user ka device fingerprint / duplicate flag clear karein?')) return;
  try {
    await db.collection('users').doc(id).update({ 'profile.fp': '', 'profile.deviceDuplicate': false });
    showToast('✅ Device flag reset.');
    await loadAll(); render();
  } catch(e) { showToast('Failed: ' + (e.message || e)); }
}

function renderPlans() {
  /* ── Expiring Soon section ── */
  const today = new Date().toISOString().slice(0, 10);
  const in7   = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const expiring = USERS.filter(u =>
    u.p.plan && u.p.plan !== 'free' &&
    u.p.planExpiry && u.p.planExpiry >= today && u.p.planExpiry <= in7
  ).sort((a, b) => (a.p.planExpiry || '').localeCompare(b.p.planExpiry || ''));
  let h = '';
  if (expiring.length) {
    h += '<div class="card" style="border-color:var(--amber);background:rgba(245,158,11,0.04);margin-bottom:1rem;">' +
      '<h3 style="color:var(--amber);">⏰ Expiring Soon — ' + expiring.length + ' user' + (expiring.length > 1 ? 's' : '') + ' (next 7 days)</h3>' +
      '<div class="muted" style="margin-bottom:10px;">These Pro plans expire within 7 days. Reach out to renew.</div>' +
      expiring.map(u =>
        '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;padding:8px 0;border-top:1px solid var(--border);">' +
        '<div><strong>' + esc(u.p.name || '?') + '</strong> <span class="muted">' + esc(u.p.email || '') + '</span>' +
        '<div class="muted">Plan: <strong>' + esc(u.p.plan) + '</strong> · Expires: <strong style="color:var(--amber);">' + esc(u.p.planExpiry) + '</strong> · 📱 ' + esc(u.p.mobile || '—') + '</div></div>' +
        '<div class="row">' +
        '<select id="renew-plan-' + u.id + '">' + PLANS.map(p => '<option value="' + p.id + '">' + esc(p.name) + ' (₹' + (p.price||0) + ')</option>').join('') + '</select>' +
        '<button class="btn btn-green" onclick="renewPlan(\'' + u.id + '\')">🔄 Renew</button>' +
        '</div></div>'
      ).join('') +
    '</div>';
  }
  h += '<div class="card"><h3>⚙ Payment Settings (UPI)</h3><div class="row">' +
    '<input id="cfg-upi" placeholder="UPI ID (e.g. name@okhdfcbank)" value="' + esc(CONFIG.upiId || '') + '" style="flex:1;min-width:200px;">' +
    '<input id="cfg-payee" placeholder="Payee name" value="' + esc(CONFIG.payeeName || '') + '" style="width:160px;">' +
    '<button class="btn btn-green" onclick="saveUpiConfig()">Save UPI</button></div>' +
    '<div class="muted" style="margin-top:6px;">Ye UPI ID users ko app ke Upgrade modal mein dikhegi. Pehle ise zaroor set karo.</div></div>';
  const fr = CONFIG.free || { mocks:5, mediaSaves:2, notes:10 };
  h += '<div class="card"><h3>🆓 Free Plan Limits</h3>' +
    '<div class="row" style="gap:12px;flex-wrap:wrap;">' +
    '<label style="display:flex;flex-direction:column;gap:4px;font-size:.82rem;color:var(--muted);">Mock saves<input id="free-mocks" type="number" min="0" value="' + (fr.mocks||5) + '" style="width:80px;"></label>' +
    '<label style="display:flex;flex-direction:column;gap:4px;font-size:.82rem;color:var(--muted);">Playlists / links<input id="free-media" type="number" min="0" value="' + (fr.mediaSaves||2) + '" style="width:80px;"></label>' +
    '<label style="display:flex;flex-direction:column;gap:4px;font-size:.82rem;color:var(--muted);">Video notes<input id="free-notes" type="number" min="0" value="' + (fr.notes||10) + '" style="width:80px;"></label>' +
    '<button class="btn btn-green" style="align-self:flex-end;" onclick="saveFreeLimits()">Save Limits</button>' +
    '</div><div class="muted" style="margin-top:6px;">App automatically loads these from Firestore on next refresh.</div></div>';
  h += '<div class="card"><h3>➕ Add / Edit Plan</h3><div class="row">' +
    '<input id="pl-name" placeholder="Plan name (e.g. Pro 1 Month)" style="flex:1;min-width:160px;">' +
    '<input id="pl-price" type="number" placeholder="Price ₹" style="width:100px;">' +
    '<input id="pl-days" type="number" placeholder="Days" style="width:90px;">' +
    '<input id="pl-feat" placeholder="Features (comma separated)" style="flex:2;min-width:200px;">' +
    '<button class="btn btn-green" onclick="savePlan()">Save Plan</button></div>' +
    '<input type="hidden" id="pl-id"></div>';
  if (!PLANS.length) h += '<div class="empty">Abhi koi plan nahi banaya. Upar se pehla plan add karo (e.g. Pro 1 Month · ₹99 · 30 days).</div>';
  h += PLANS.map(p =>
    '<div class="card row" style="justify-content:space-between;">' +
    '<div><strong>' + esc(p.name) + '</strong> · ₹' + (p.price || 0) + ' · ' + (p.days || 0) + ' days<div class="muted">' + esc(p.features || '') + '</div></div>' +
    '<div class="row"><button class="btn btn-gray" onclick="editPlan(\'' + p.id + '\')">✏ Edit</button>' +
    '<button class="btn btn-red" onclick="deletePlan(\'' + p.id + '\')">🗑</button></div></div>'
  ).join('');
  return h;
}

function renderPayments() {
  // Sub-tab toggle: List vs Reconcile
  const subtabs = '<div class="subtabs">' +
    '<button class="subtab ' + (PAY_VIEW === 'list' ? 'active' : '') + '" onclick="PAY_VIEW=\'list\';render();">📋 List</button>' +
    '<button class="subtab ' + (PAY_VIEW === 'reconcile' ? 'active' : '') + '" onclick="PAY_VIEW=\'reconcile\';render();">💹 Reconcile</button>' +
    '</div>';

  if (PAY_VIEW === 'reconcile') return subtabs + renderReconciliation();
  return subtabs + renderPaymentList();
}

function renderPaymentList() {
  const counts = { all: PAYMENTS.length, pending: 0, verified: 0, declined: 0 };
  PAYMENTS.forEach(p => { if (counts[p.status] !== undefined) counts[p.status]++; });
  let h = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:1rem;align-items:center;">' +
    ['all','pending','verified','declined'].map(f =>
      '<button class="btn ' + (PAY_FILTER===f ? 'btn-green' : 'btn-gray') + '" onclick="PAY_FILTER=\'' + f + '\';render();">'
      + (f==='all'?'All':f.charAt(0).toUpperCase()+f.slice(1)) + ' (' + counts[f] + ')</button>'
    ).join('') +
    '<button class="btn btn-blue" onclick="exportPaymentsCSV()" style="margin-left:auto;">⬇ Export CSV</button>' +
    '</div>';

  // Pre-compute duplicate txnId groups so we can flag them inline
  const txnCounts = {};
  PAYMENTS.forEach(p => { if (p.txnId) { const k = String(p.txnId).trim().toLowerCase(); if (k) txnCounts[k] = (txnCounts[k] || 0) + 1; } });
  const dupTxnSet = new Set(Object.keys(txnCounts).filter(k => txnCounts[k] > 1));

  const list = PAY_FILTER === 'all' ? PAYMENTS : PAYMENTS.filter(p => p.status === PAY_FILTER);
  if (!list.length) return h + '<div class="empty">Is filter mein koi payment nahi.</div>';
  h += list.map(p => {
    const st = p.status === 'verified' ? '<span class="badge badge-green">Verified</span>' : p.status === 'declined' ? '<span class="badge badge-red">Declined</span>' : '<span class="badge badge-amber">Pending</span>';
    const ss = p.screenshotUrl ? '<a href="' + esc(p.screenshotUrl) + '" target="_blank" style="font-size:0.78rem;color:var(--accent);margin-left:8px;">View Screenshot</a>' : '';
    const isDup = p.txnId && dupTxnSet.has(String(p.txnId).trim().toLowerCase());
    const dupFlag = isDup ? ' <span class="flag" style="background:rgba(239,68,68,0.15);color:var(--red);">⚠ Duplicate Txn (' + txnCounts[String(p.txnId).trim().toLowerCase()] + 'x)</span>' : '';
    return '<div class="card ' + (isDup ? 'dup-row' : '') + '" style="margin-bottom:10px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px;">' +
      '<div style="flex:1;min-width:220px;"><strong>' + esc(p.email || p.uid) + '</strong> ' + st + ss + dupFlag +
      '<div class="muted" style="margin-top:4px;">Plan: ' + esc(p.planName || p.planId || '?') + ' &middot; ' +
        (p.couponCode
          ? '<s style="color:var(--muted);">Rs.' + (p.originalAmount || 0) + '</s> <strong style="color:var(--accent);">Rs.' + (p.amount || 0) + '</strong> <span class="badge badge-blue">\ud83c\udfaf ' + esc(p.couponCode) + ' (' + (p.couponPercent||0) + '% off)</span> &middot; '
          : 'Rs.' + (p.amount || 0) + ' &middot; ') +
      'Txn: <strong>' + esc(p.txnId || '-') + '</strong> &middot; ' + fmtDate(p.createdAt) + '</div>' +
      (p.screenshotUrl ? '<div style="margin-top:8px;"><img src="' + esc(p.screenshotUrl) + '" style="max-width:220px;max-height:130px;border-radius:8px;border:1px solid var(--border);cursor:pointer;" onclick="openLightbox(this.src)" title="Click to enlarge"></div>' : '') +
      '</div>' +
      (p.status === 'pending'
        ? '<div class="row" style="flex-shrink:0;align-items:flex-start;"><button class="btn btn-green" onclick="verifyPayment(\'' + p.id + '\')">Verify & Activate</button>' +
          '<button class="btn btn-red" onclick="declinePayment(\'' + p.id + '\')">Decline</button></div>'
        : '') +
      '</div></div>';
  }).join('');
  return h;
}

/* ═══ RECONCILIATION VIEW — money leak detection ═══ */
function paymentDate(p) { try { return p.createdAt && p.createdAt.toDate ? p.createdAt.toDate() : (p.createdAt ? new Date(p.createdAt) : null); } catch(e) { return null; } }
function inRange(p, fromMs, toMs) {
  const d = paymentDate(p); if (!d) return false;
  const t = d.getTime();
  return t >= fromMs && t < toMs;
}
function rangeStats(list) {
  const verified = list.filter(p => p.status === 'verified');
  const pending  = list.filter(p => p.status === 'pending');
  const declined = list.filter(p => p.status === 'declined');
  const sum = (arr) => arr.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  return {
    total: list.length,
    verifiedCount: verified.length,
    pendingCount: pending.length,
    declinedCount: declined.length,
    verifiedAmount: sum(verified),
    pendingAmount: sum(pending),
    declinedAmount: sum(declined),
    approvalRate: list.length ? Math.round((verified.length / list.length) * 100) : 0,
    declineRate: list.length ? Math.round((declined.length / list.length) * 100) : 0
  };
}

function renderReconciliation() {
  if (!PAYMENTS.length) return '<div class="empty">Abhi koi payment record nahi.</div>';

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const endOfToday   = startOfToday + 86400000;
  const startOf7     = now.getTime() - 7 * 86400000;
  const startOf30    = now.getTime() - 30 * 86400000;

  const today = rangeStats(PAYMENTS.filter(p => inRange(p, startOfToday, endOfToday)));
  const week  = rangeStats(PAYMENTS.filter(p => inRange(p, startOf7, endOfToday)));
  const month = rangeStats(PAYMENTS.filter(p => inRange(p, startOf30, endOfToday)));
  const all   = rangeStats(PAYMENTS);

  const card = (label, s, klass) => '<div class="recon-stat ' + (klass||'') + '">' +
    '<b>\u20b9' + s.verifiedAmount.toLocaleString('en-IN') + '</b>' +
    '<div>' + label + ' \u00b7 ' + s.verifiedCount + ' verified' +
      (s.pendingAmount ? ' \u00b7 <span style="color:var(--amber);">\u20b9' + s.pendingAmount + ' pending</span>' : '') +
    '</div></div>';

  let h = '<div class="recon-grid">' +
    card('Today', today, 'good') +
    card('Last 7 days', week) +
    card('Last 30 days', month) +
    card('All time', all) +
    '</div>';

  // Health strip
  h += '<div class="recon-card" style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;align-items:center;">' +
    '<div><strong>Approval health</strong> &middot; ' + all.approvalRate + '% verified &middot; ' + all.declineRate + '% declined &middot; ' + (PAYMENTS.length - all.verifiedCount - all.declinedCount) + ' still pending</div>' +
    '<div class="row"><button class="btn btn-gray" onclick="exportPaymentsCSV()">⬇ Export CSV</button><button class="btn btn-blue" onclick="PAY_VIEW=\'list\';PAY_FILTER=\'pending\';render();">Review ' + today.pendingCount + ' pending today →</button></div>' +
    '</div>';

  /* ── Duplicate txn detection ── */
  const txnGroups = {};
  PAYMENTS.forEach(p => {
    const k = p.txnId ? String(p.txnId).trim().toLowerCase() : '';
    if (!k) return;
    (txnGroups[k] = txnGroups[k] || []).push(p);
  });
  const dupGroups = Object.entries(txnGroups).filter(([k, arr]) => arr.length > 1);
  const dupRows = [];
  dupGroups.forEach(([k, arr]) => {
    const totalAmount = arr.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    dupRows.push({ key: k, payments: arr, totalAmount });
  });
  dupRows.sort((a, b) => b.payments.length - a.payments.length);

  h += '<div class="recon-card">';
  h += '<h3>\ud83d\udeab Duplicate Txn IDs (' + dupRows.length + ')</h3>';
  if (!dupRows.length) {
    h += '<div class="muted">\u2705 Koi duplicate txn ID nahi mila. Sab clean hai.</div>';
  } else {
    h += '<div class="muted" style="margin-bottom:10px;">Same UPI txn ID se multiple payment submissions. Usually same user ne do baar screenshot bhej diya, ya koi abuse kar raha hai ek txn ko activate karne ke liye do accounts pe.</div>';
    h += dupRows.map(g => {
      const verifiedCount = g.payments.filter(p => p.status === 'verified').length;
      const isCritical = verifiedCount > 1; // same txn verified more than once = real money leak
      return '<div class="recon-card ' + (isCritical ? 'dup-row' : '') + '" style="margin-bottom:8px;padding:0.7rem 0.9rem;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">' +
          '<div><strong>Txn:</strong> <code style="background:#EEF2F6;padding:2px 6px;border-radius:4px;">' + esc(g.payments[0].txnId) + '</code> ' +
            '<span class="badge ' + (isCritical ? 'badge-red' : 'badge-amber') + '">' + g.payments.length + 'x submissions</span> ' +
            (isCritical ? '<span class="flag" style="background:rgba(239,68,68,0.15);color:var(--red);">\u26a0 CRITICAL: ' + verifiedCount + ' verified \u2014 money already activated on multiple accounts</span>' : '') +
          '</div>' +
          '<div class="muted">Total claimed: \u20b9' + g.totalAmount + '</div>' +
        '</div>' +
        g.payments.map(p => {
          const st = p.status === 'verified' ? '<span class="badge badge-green">Verified</span>' : p.status === 'declined' ? '<span class="badge badge-red">Declined</span>' : '<span class="badge badge-amber">Pending</span>';
          return '<div class="muted" style="margin-top:6px;padding-left:10px;border-left:2px solid var(--border);display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;">' +
            '<span>' + esc(p.email || p.uid) + ' \u00b7 \u20b9' + (p.amount||0) + ' \u00b7 ' + esc(p.planName || p.planId || '?') + ' ' + st + ' \u00b7 ' + fmtDate(p.createdAt) + '</span>' +
            (p.status === 'pending' ? '<button class="btn btn-red" style="padding:4px 10px;font-size:0.75rem;" onclick="declinePayment(\'' + p.id + '\')">Decline dup</button>' : '') +
          '</div>';
        }).join('') +
      '</div>';
    }).join('');
  }
  h += '</div>';

  /* ── Daily revenue bar (last 14 days) ── */
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i).getTime();
    const d1 = d0 + 86400000;
    const s = rangeStats(PAYMENTS.filter(p => inRange(p, d0, d1)));
    days.push({ label: (new Date(d0).getDate()) + '/' + (new Date(d0).getMonth() + 1), ...s });
  }
  const maxRev = Math.max(1, ...days.map(d => d.verifiedAmount));
  h += '<div class="recon-card"><h3>\ud83d\udcca Last 14 days</h3>';
  h += '<div style="display:flex;align-items:flex-end;gap:4px;height:90px;border-bottom:1px solid var(--border);padding-bottom:4px;">';
  days.forEach(d => {
    const h2 = Math.max(2, Math.round((d.verifiedAmount / maxRev) * 80));
    const isToday = d.label === (now.getDate() + '/' + (now.getMonth() + 1));
    h += '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;" title="' + d.label + ': \u20b9' + d.verifiedAmount + ' verified, ' + d.pendingCount + ' pending">' +
      '<div style="font-size:0.6rem;color:var(--muted);">' + (d.verifiedCount || '') + '</div>' +
      '<div class="bar-mini" style="width:100%;height:' + h2 + 'px;background:' + (isToday ? 'var(--red)' : 'var(--accent)') + ';"></div>' +
    '</div>';
  });
  h += '</div><div style="display:flex;justify-content:space-between;margin-top:4px;"><span class="muted">' + days[0].label + '</span><span class="muted" style="color:var(--red);">today: \u20b9' + today.verifiedAmount + '</span><span class="muted">' + days[days.length-1].label + '</span></div>';
  h += '</div>';

  /* ── Plan mix ── */
  const planMix = {};
  PAYMENTS.filter(p => p.status === 'verified').forEach(p => {
    const k = p.planName || p.planId || 'Unknown';
    planMix[k] = (planMix[k] || 0) + (Number(p.amount) || 0);
  });
  const planMixEntries = Object.entries(planMix).sort((a, b) => b[1] - a[1]);
  if (planMixEntries.length) {
    const totalMix = planMixEntries.reduce((s, [k, v]) => s + v, 0) || 1;
    h += '<div class="recon-card"><h3>\ud83c\udfaf Revenue by Plan (verified)</h3>';
    planMixEntries.forEach(([k, v]) => {
      const pct = Math.round((v / totalMix) * 100);
      h += '<div style="margin-bottom:8px;"><div style="display:flex;justify-content:space-between;font-size:0.85rem;"><strong>' + esc(k) + '</strong><span>\u20b9' + v.toLocaleString('en-IN') + ' (' + pct + '%)</span></div>' +
        '<div style="background:#EEF2F6;height:8px;border-radius:4px;overflow:hidden;margin-top:3px;"><div class="bar-mini" style="width:' + pct + '%;height:8px;background:var(--accent);"></div></div></div>';
    });
    h += '</div>';
  }

  return h;
}

/* CSV export — saves to local Downloads via Blob */
function exportPaymentsCSV() {
  if (!PAYMENTS.length) { showToast('Koi payment nahi export karne ko.'); return; }
  const headers = ['id','createdAt','email','uid','planId','planName','amount','txnId','status','verifiedAt','screenshotUrl'];
  const rows = PAYMENTS.map(p => headers.map(h => {
    let v = p[h];
    if (v && typeof v === 'object' && v.toDate) v = v.toDate().toISOString();
    else if (v && typeof v === 'object' && v.seconds) v = new Date(v.seconds * 1000).toISOString();
    if (v == null) v = '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? '"' + s + '"' : s;
  }).join(','));
  const csv = headers.join(',') + '\n' + rows.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'preppath-payments-' + new Date().toISOString().slice(0,10) + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('\u2705 Exported ' + PAYMENTS.length + ' payments');
}

/* Payment screenshot lightbox */
function openLightbox(url) {
  // Remove any existing lightbox first
  const old = document.getElementById('ez-lightbox');
  if (old) old.remove();
  const lb = document.createElement('div');
  lb.id = 'ez-lightbox';
  lb.style.cssText = 'position:fixed;inset:0;background:rgba(8,12,20,0.92);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:zoom-out;padding:1rem;backdrop-filter:blur(4px);';
  lb.innerHTML = '<div style="position:relative;max-width:96vw;max-height:92vh;display:flex;flex-direction:column;align-items:center;">' +
    '<img src="' + esc(url) + '" style="max-width:96vw;max-height:88vh;border-radius:10px;box-shadow:0 20px 60px rgba(0,0,0,0.5);background:#fff;object-fit:contain;">' +
    '<div style="margin-top:10px;color:#fff;font-size:0.85rem;opacity:0.85;">Click anywhere or press <strong>Esc</strong> to close</div>' +
    '<button onclick="document.getElementById(\'ez-lightbox\')?.remove()" style="position:absolute;top:-12px;right:-12px;width:32px;height:32px;border-radius:50%;background:var(--accent);color:#fff;border:none;font-size:1.1rem;font-weight:700;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,0.3);">×</button>' +
    '</div>';
  lb.onclick = (e) => { if (e.target === lb) lb.remove(); };
  document.body.appendChild(lb);
  // ESC to close
  const onKey = (e) => { if (e.key === 'Escape') { lb.remove(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
}

function renderReferrals() {
  const refMap = {};
  USERS.forEach(u => { if (u.p.referredBy) { (refMap[u.p.referredBy] = refMap[u.p.referredBy] || []).push(u); } });
  const keys = Object.keys(refMap);
  if (!keys.length) return '<div class="empty">Abhi koi referral nahi hua.</div>';
  return keys.map(refUid => {
    const referrer = USERS.find(x => x.id === refUid);
    const referred = refMap[refUid];
    const paidCount = referred.filter(x => x.p.plan && x.p.plan !== 'free').length;
    return '<div class="card">' +
      '<div><strong>' + esc(referrer ? (referrer.p.name + ' (' + referrer.p.email + ')') : refUid) + '</strong> ' +
      '<span class="badge badge-blue">' + referred.length + ' referred</span> ' +
      '<span class="badge badge-green">' + paidCount + ' paid · ₹' + (paidCount * 10) + ' earned</span></div>' +
      referred.map(r => '<div class="muted" style="margin-top:6px;padding-left:10px;border-left:2px solid var(--border);">' + esc(r.p.name || '?') + ' · ' + esc(r.p.email || '') + ' · ' + (r.p.plan && r.p.plan !== 'free' ? '<span class="badge badge-green">' + esc(r.p.plan) + '</span>' : 'Free') + ' ' + flagsFor(r).map(f => '<span class="flag">⚠ ' + f + '</span>').join('') + '</div>').join('') +
      '</div>';
  }).join('');
}

function renderPayouts() {
  const refMap = {};
  USERS.forEach(u => { if (u.p.referredBy) { (refMap[u.p.referredBy] = refMap[u.p.referredBy] || []).push(u); } });
  const rows = Object.keys(refMap).map(refUid => {
    const referrer = USERS.find(x => x.id === refUid);
    const paidCount = refMap[refUid].filter(x => x.p.plan && x.p.plan !== 'free').length;
    const earned = paidCount * 10;
    const alreadyPaid = (referrer && referrer.p.payoutPaidAmount) || 0;
    const due = earned - alreadyPaid;
    return { refUid, referrer, paidCount, earned, alreadyPaid, due, eligible: paidCount >= 20 };
  }).filter(r => r.paidCount > 0);
  if (!rows.length) return '<div class="empty">Abhi koi paid referral nahi. Payout tab unlock hota hai jab kisi referrer ke 20 paid referrals complete hon.</div>';
  return rows.map(r =>
    '<div class="card row" style="justify-content:space-between;">' +
    '<div style="flex:1;min-width:220px;"><strong>' + esc(r.referrer ? r.referrer.p.name + ' (' + r.referrer.p.email + ')' : r.refUid) + '</strong>' +
    '<div class="muted">' + r.paidCount + '/20 paid referrals · Earned ₹' + r.earned + ' · Already paid ₹' + r.alreadyPaid + ' · <strong>Due ₹' + r.due + '</strong></div>' +
    (r.eligible ? '<span class="badge badge-green">✓ Payout unlocked</span>' : '<span class="badge badge-amber">Locked — needs 20 paid referrals</span>') + '</div>' +
    (r.eligible && r.due > 0 ? '<button class="btn btn-green" onclick="markPayout(\'' + r.refUid + '\',' + r.earned + ')">💸 Mark ₹' + r.due + ' Paid</button>' : '') +
    '</div>'
  ).join('');
}

