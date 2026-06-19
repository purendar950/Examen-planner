/* ══════════════════════════════════════════════
   EXAMZEN PHASE 3 — REFERRAL SHARE WIDGET + PAYOUT PROGRESS
══════════════════════════════════════════════ */
function ezRefLink() {
  if (!currentUser) return '';
  const base = location.origin + location.pathname.replace(/app\.html.*$/, '');
  return base + '?ref=' + encodeURIComponent(currentUser.uid);
}

function ezRenderRefWidget() {
  if (!currentUser) return;
  // Share & Earn now lives on the Playlist Organiser page (was on Dashboard).
  const organiser = document.getElementById('page-yt-organiser'); if (!organiser) return;
  let w = document.getElementById('ez-ref-widget');
  if (!w) {
    w = document.createElement('div');
    w.id = 'ez-ref-widget';
    // Place it at the very top of the organiser page, above the input bar.
    organiser.insertBefore(w, organiser.firstChild);
  }
  const p = EZ_PROFILE || {};
  const paid = p.refPaidCount || 0;
  const total = p.refTotalCount || 0;
  const earned = paid * 10;
  const paidOut = p.payoutPaidAmount || 0;
  const pct = Math.min(100, Math.round(paid / 20 * 100));
  const link = ezRefLink();
  w.innerHTML = '<div class="info-card" style="margin-bottom:1.5rem;">' +
    '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;">' +
    '<strong style="font-size:0.9rem;">🔗 Share & Earn — ₹10 per purchase</strong>' +
    '<span style="font-size:0.7rem;color:var(--muted);">Aapke link se koi paid plan le to aapko ₹10 milta hai</span></div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">' +
    '<input class="form-input" readonly value="' + escapeHtml(link) + '" id="ez-ref-link" style="flex:1;min-width:200px;font-size:0.75rem;" onclick="this.select()">' +
    '<button class="btn-modal-save" onclick="ezCopyRef()">📋 Copy</button>' +
    '<button class="btn-modal-save" style="background:#25D366;color:#fff;" onclick="ezShareWa()">WhatsApp</button></div>' +
    '<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:0.75rem;color:var(--muted);margin-bottom:4px;">' +
    '<span><strong style="color:var(--text);">' + paid + '/20</strong> paid referrals (' + total + ' joined)</span>' +
    '<span>Earned <strong style="color:var(--accent);">₹' + earned + '</strong>' + (paidOut ? ' · ₹' + paidOut + ' paid out' : '') + '</span></div>' +
    '<div class="progress-bar"><div class="progress-fill" style="width:' + pct + '%;"></div></div>' +
    '<div style="font-size:0.68rem;color:var(--muted);margin-top:5px;">' +
    (paid >= 20
      ? '🎉 Payout unlocked! Admin aapko ₹' + Math.max(0, earned - paidOut) + ' transfer karega.'
      : '🔓 Payout unlocks at <strong>20 paid referrals</strong> (₹200). Keep sharing!') +
    '</div></div>';
}

function ezCopyRef() {
  try {
    navigator.clipboard.writeText(document.getElementById('ez-ref-link').value);
    showToast('Referral link copied! 🔗', 'success');
  } catch(e) { showToast('Link select karke manually copy karo.', 'info'); }
}
function ezShareWa() {
  const msg = '🧘 ExamZen — SSC/Railway/Banking/UPSC ki smart study planner! Syllabus tracker, mock test analysis, YouTube course organiser — sab ek jagah. Mere link se join karo: ' + ezRefLink();
  window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank');
}

/* Render widget after profile load and on dashboard refreshes */
const _ezLoadProfileBase3 = ezLoadProfile;
ezLoadProfile = async function() {
  await _ezLoadProfileBase3();
  ezRenderRefWidget();
};
const _updateDashboardEZ3 = updateDashboard;
updateDashboard = function() {
  _updateDashboardEZ3();
  if (EZ_PROFILE) ezRenderRefWidget();
};

