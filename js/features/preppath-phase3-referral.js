/* ══════════════════════════════════════════════
   PREPPATH PHASE 3 — REFERRAL SHARE WIDGET + PAYOUT PROGRESS
══════════════════════════════════════════════ */
function ezRefLink() {
  if (!currentUser) return '';
  const base = location.origin + location.pathname.replace(/app\.html.*$/, '');
  return base + '?ref=' + encodeURIComponent(currentUser.uid);
}

function ezRenderRefWidget() {
  if (!currentUser) return;
  const organiser = document.getElementById('page-yt-organiser');
  const slot = document.getElementById('yto-referral-slot');
  if (!organiser || !slot) return;

  let w = document.getElementById('ez-ref-widget');
  if (!w) {
    w = document.createElement('div');
    w.id = 'ez-ref-widget';
  }
  if (w.parentElement !== slot) slot.appendChild(w);

  const p = EZ_PROFILE || {};
  const paid = p.refPaidCount || 0;
  const total = p.refTotalCount || 0;
  const earned = paid * 10;
  const paidOut = p.payoutPaidAmount || 0;
  const pct = Math.min(100, Math.round(paid / 20 * 100));
  const link = ezRefLink();
  const payoutNote = paid >= 20
    ? `Payout unlocked. ₹${Math.max(0, earned - paidOut)} is ready for admin transfer.`
    : `Payout unlocks at 20 paid referrals (₹200).`;

  w.innerHTML = `<details class="yto-referral-card">
    <summary>
      <span class="yto-referral-icon" aria-hidden="true">↗</span>
      <span class="yto-referral-summary">
        <strong>Share & Earn</strong>
        <span>${paid}/20 paid referrals · ${total} joined</span>
      </span>
      <span class="yto-referral-earned">₹${earned} earned</span>
      <span class="yto-referral-chevron" aria-hidden="true">▼</span>
    </summary>
    <div class="yto-referral-body">
      <div class="yto-referral-actions">
        <input readonly value="${escapeHtml(link)}" id="ez-ref-link" aria-label="Your referral link" onclick="this.select()">
        <button type="button" onclick="ezCopyRef()">Copy link</button>
        <button type="button" class="whatsapp" onclick="ezShareWa()">WhatsApp</button>
      </div>
      <div class="yto-referral-stats">
        <span><strong>${paid}/20</strong> purchases</span>
        <span>Earned <strong>₹${earned}</strong>${paidOut ? ` · ₹${paidOut} paid` : ''}</span>
      </div>
      <div class="yto-referral-progress" role="progressbar" aria-label="Payout progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>
      <div class="yto-referral-note">₹10 is added when someone buys a plan through your link. ${payoutNote}</div>
    </div>
  </details>`;
}

function ezCopyRef() {
  try {
    navigator.clipboard.writeText(document.getElementById('ez-ref-link').value);
    showToast('Referral link copied! 🔗', 'success');
  } catch(e) { showToast('Link select karke manually copy karo.', 'info'); }
}
function ezShareWa() {
  const msg = '🎯 StudyPlanner — SSC/Railway/Banking/UPSC ki smart study planner! Syllabus tracker, mock test analysis, YouTube course organiser — sab ek jagah. Mere link se join karo: ' + ezRefLink();
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

