/* ══════════════════════════════════════════════
   STUDYPLANNER REFERRAL SYSTEM — PRO DAYS REWARD
   ══════════════════════════════════════════════
   Rules:
   - Each eligible verified new account grants 3 Pro days
   - Maximum 10 rewarded referrals per referrer (30 days lifetime)
   - Eligibility is verified server-side; browser/device IDs are not trusted
   - No cash payment. Only Pro days.
   ══════════════════════════════════════════════ */

/* ── 2. REFERRAL LINK GENERATION ── */
function ezRefLink() {
  if (!currentUser) return '';
  var base = location.origin + location.pathname.replace(/app.html.*$/, '');
  return base + '?ref=' + encodeURIComponent(currentUser.uid);
}

/* ── 3. REFERRAL REWARD CALCULATION ──
   Fixed 3-day reward, capped to 10 eligible referrals by the backend. */
function ezReferralDays(friendCount) {
  return friendCount > 0 && friendCount <= 10 ? 3 : 0;
}

function ezReferralTotalDays(friendCount) {
  return Math.max(0, Math.min(10, Number(friendCount) || 0)) * 3;
}

/* ── 4. PROCESS INCOMING REFERRAL (when new user signs up with ?ref=) ──
   Called during auth/signup flow */
async function ezProcessReferralOnSignup(newUserId) {
  var refCode = localStorage.getItem('sp_pending_referral_code');
  if (!refCode || !newUserId || refCode === newUserId) {
    if (refCode === newUserId) localStorage.removeItem('sp_pending_referral_code');
    return;
  }

  try {
    if (typeof auth === 'undefined' || !auth || !auth.currentUser || auth.currentUser.uid !== newUserId) {
      throw new Error('Sign in again to claim the referral reward.');
    }
    var token = await getFirebaseIdToken();
    var backend = privilegedBackendUrl();
    var response = await fetch(backend + '/referrals/claim', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        referrerUid: refCode
      })
    });
    var result = await response.json().catch(function () { return {}; });
    if (!response.ok || result.ok !== true) {
      throw new Error(result.error || 'Referral could not be verified.');
    }

    if (result.duplicate) {
      localStorage.removeItem('sp_pending_referral_code');
      return;
    }
    if (result.rejected) {
      var needsVerification = /verify your email/i.test(String(result.reason || ''));
      if (!needsVerification) localStorage.removeItem('sp_pending_referral_code');
      if (needsVerification && auth.currentUser && typeof auth.currentUser.sendEmailVerification === 'function') {
        try { await auth.currentUser.sendEmailVerification(); } catch (verificationError) {}
      }
      if (typeof showToast === 'function') showToast(result.reason || 'Referral reward was not eligible.', 'info');
      return;
    }
    localStorage.removeItem('sp_pending_referral_code');
    if (typeof showToast === 'function') {
      showToast('🎉 Referral verified! Your welcome Pro day is active.', 'success');
    }
    try { if (typeof ezLoadProfile === 'function') await ezLoadProfile(); } catch (e) {}
  } catch (e) {
    /* Keep the pending code for retry after a transient backend/network error.
       Entitlement writes happen only in the authenticated server transaction. */
    console.error('[Referral] Processing error:', e);
    if (typeof showToast === 'function') showToast(e.message || 'Referral verification failed.', 'info');
  }
}

/* ── 5. REFERRAL WIDGET UI (No Cash — Pro Days Only) ── */
function ezRenderRefWidget() {
  if (!currentUser) return;

  // Find or create widget slot (dashboard + youtube organiser)
  var slots = [
    document.getElementById('yto-referral-slot'),
    document.getElementById('dashboard-referral-slot')
  ];

  var p = (typeof EZ_PROFILE !== 'undefined' && EZ_PROFILE) ? EZ_PROFILE : {};
  var refCount = p.refCount || 0;
  var totalDaysEarned = p.referralDaysEarned || 0;
  var lastBonus = p.lastReferralBonus || 0;
  var link = ezRefLink();

  // Calculate next reward
  var nextFriendNum = refCount + 1;
  var nextBonusDays = ezReferralDays(nextFriendNum);

  // Milestone progress
  var milestones = [
    { friends: 1, days: 3, label: '1st friend' },
    { friends: 3, days: 9, label: '3 friends' },
    { friends: 5, days: 15, label: '5 friends' },
    { friends: 10, days: 30, label: '10 friends' }
  ];

  var nextMilestone = null;
  for (var i = 0; i < milestones.length; i++) {
    if (refCount < milestones[i].friends) { nextMilestone = milestones[i]; break; }
  }

  var widgetHtml =
    '<div class="ref-widget" style="background:var(--surface,#1a1a2e);border:1px solid var(--border,#333);border-radius:12px;padding:1.25rem;margin:1rem 0;">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;">' +
        '<h4 style="margin:0;font-size:1rem;">🎁 Refer & Get Pro Days</h4>' +
        '<span style="font-size:0.75rem;color:var(--accent,#6366f1);font-weight:600;">No cash. Only Pro days.</span>' +
      '</div>' +

      /* Stats row */
      '<div style="display:flex;gap:12px;margin-bottom:1rem;flex-wrap:wrap;">' +
        '<div style="flex:1;min-width:80px;background:var(--bg-secondary,#16213e);border-radius:8px;padding:10px;text-align:center;">' +
          '<div style="font-size:1.4rem;font-weight:800;color:var(--accent,#6366f1);">' + refCount + '</div>' +
          '<div style="font-size:0.7rem;color:var(--muted,#999);">Friends Joined</div>' +
        '</div>' +
        '<div style="flex:1;min-width:80px;background:var(--bg-secondary,#16213e);border-radius:8px;padding:10px;text-align:center;">' +
          '<div style="font-size:1.4rem;font-weight:800;color:#10b981;">' + totalDaysEarned + '</div>' +
          '<div style="font-size:0.7rem;color:var(--muted,#999);">Pro Days Earned</div>' +
        '</div>' +
        '<div style="flex:1;min-width:80px;background:var(--bg-secondary,#16213e);border-radius:8px;padding:10px;text-align:center;">' +
          '<div style="font-size:1.4rem;font-weight:800;color:#f59e0b;">+' + nextBonusDays + '</div>' +
          '<div style="font-size:0.7rem;color:var(--muted,#999);">Next Friend Bonus</div>' +
        '</div>' +
      '</div>' +

      /* Reward table */
      '<div style="background:var(--bg-secondary,#16213e);border-radius:8px;padding:0.75rem;margin-bottom:1rem;font-size:0.78rem;">' +
        '<p style="font-weight:700;margin-bottom:6px;font-size:0.8rem;">📊 Reward Structure:</p>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;color:var(--muted,#999);">' +
          '<span>Each eligible friend → <strong style="color:var(--text,#fff)">3 days</strong></span>' +
          '<span>3 friends → <strong style="color:var(--text,#fff)">9 days total</strong></span>' +
          '<span>5 friends → <strong style="color:var(--text,#fff)">15 days total</strong></span>' +
          '<span>10 friends → <strong style="color:var(--text,#fff)">30 days total</strong></span>' +
          '<span>Reward limit → <strong style="color:var(--text,#fff)">10 friends</strong></span>' +
          '<span>Friend welcome → <strong style="color:var(--text,#fff)">1 day</strong></span>' +
        '</div>' +
      '</div>' +

      /* Referral link + share buttons */
      '<div style="display:flex;gap:8px;margin-bottom:0.75rem;">' +
        '<input readonly value="' + link + '" id="ez-ref-link" aria-label="Your referral link" ' +
          'onclick="this.select()" style="flex:1;padding:8px 12px;border-radius:8px;border:1px solid var(--border,#333);background:var(--bg-primary,#0a0a0f);color:var(--text,#fff);font-size:0.8rem;font-family:monospace;">' +
        '<button onclick="ezCopyRef()" style="padding:8px 14px;border-radius:8px;border:1px solid var(--border,#333);background:var(--bg-secondary,#16213e);color:var(--text,#fff);cursor:pointer;font-size:0.8rem;white-space:nowrap;">📋 Copy</button>' +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-bottom:0.75rem;">' +
        '<button onclick="ezShareWa()" style="flex:1;padding:10px;border-radius:8px;border:none;background:#25D366;color:#fff;font-weight:600;cursor:pointer;font-size:0.85rem;">📱 WhatsApp</button>' +
        '<button onclick="ezShareTg()" style="flex:1;padding:10px;border-radius:8px;border:none;background:#0088cc;color:#fff;font-weight:600;cursor:pointer;font-size:0.85rem;">✈️ Telegram</button>' +
      '</div>' +

      /* Next milestone */
      (nextMilestone
        ? '<div style="font-size:0.78rem;color:var(--muted,#999);text-align:center;">' +
            '🎯 Next milestone: <strong style="color:var(--text,#fff)">' + nextMilestone.friends + ' friends</strong> → ' +
            nextMilestone.days + ' days total' +
          '</div>'
        : '<div style="font-size:0.78rem;color:#10b981;text-align:center;">🏆 All milestones reached! Keep referring!</div>') +

      /* Rules */
      '<div style="margin-top:0.75rem;padding-top:0.75rem;border-top:1px solid var(--border,#333);font-size:0.72rem;color:var(--muted,#999);">' +
        '<p style="font-weight:600;margin-bottom:4px;">📋 Rules:</p>' +
        '<p>• Referral counts only for a <strong>verified account created in the last 24 hours</strong></p>' +
        '<p>• One reward per verified account; maximum 10 rewarded friends</p>' +
        '<p>• Self-referral is not allowed</p>' +
        '<p>• Friend gets 1 day Pro free as welcome bonus</p>' +
        '<p>• Pro days added to your existing plan expiry</p>' +
      '</div>' +
    '</div>';

  // Render into available slots
  slots.forEach(function (slot) {
    if (!slot) return;
    var existing = slot.querySelector('.ref-widget');
    if (existing) existing.remove();
    slot.insertAdjacentHTML('beforeend', widgetHtml);
  });

  // Also render on dashboard if no dedicated slot
  var dashboard = document.getElementById('page-dashboard');
  if (dashboard && !document.getElementById('dashboard-referral-slot')) {
    var dashExisting = dashboard.querySelector('.ref-widget');
    if (!dashExisting) {
      var wrapper = document.createElement('div');
      wrapper.id = 'dashboard-referral-slot';
      wrapper.innerHTML = widgetHtml;
      var dashContent = dashboard.querySelector('.dashboard-content, .dash-grid, .page-content, .dashboard-grid');
      if (dashContent) dashContent.appendChild(wrapper);
    }
  }
}

/* ── 6. SHARE FUNCTIONS ── */
function ezCopyRef() {
  try {
    var input = document.getElementById('ez-ref-link');
    if (input) {
      navigator.clipboard.writeText(input.value);
      if (typeof showToast === 'function') showToast('Referral link copied! 🔗', 'success');
    }
  } catch (e) {
    if (typeof showToast === 'function') showToast('Link select karke manually copy karo.', 'info');
  }
}

function ezShareWa() {
  var msg = '📚 StudyPlanner — SSC/UPSC/Banking/Railway ki smart study planner!\n\n' +
    'AI Tutor, Turbo 4× YouTube, Mock Tests, Telegram reminders — sab ek jagah.\n\n' +
    '🎁 Mere link se join karo — tumhe 1 din Pro FREE milega!\n' +
    'Aur mujhe bhi Pro days milenge. Win-win! 🎉\n\n' +
    '👉 ' + ezRefLink();
  window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank');
}

function ezShareTg() {
  var url = ezRefLink();
  var msg = '📚 StudyPlanner — Smart study planner for SSC/UPSC/Banking!\n' +
    '🎁 Join with my link — get 1 day Pro FREE!\n' +
    'AI Tutor + Turbo 4× + Unlimited Quizzes + Telegram reminders';
  window.open('https://t.me/share/url?url=' + encodeURIComponent(url) + '&text=' + encodeURIComponent(msg), '_blank');
}

/* ── 7. HOOK INTO AUTH FLOW ──
   Process referral when a new user signs up */
(function () {
  // Hook into Firebase auth state change (only if Firebase is available)
  if (typeof firebase !== 'undefined' && firebase.auth) {
    try {
      firebase.auth().onAuthStateChanged(function (user) {
        if (user) {
          // Check if there's a pending referral code
          var pendingRef = localStorage.getItem('sp_pending_referral_code');
          if (pendingRef && pendingRef !== user.uid) {
            // Small delay to ensure user doc is created
            setTimeout(function () {
              ezProcessReferralOnSignup(user.uid);
            }, 2000);
          }
        }
      });
    } catch (e) {
      console.warn('[Referral] Firebase auth hook skipped:', e);
    }
  }

  // Capture ?ref= param on page load
  try {
    var params = new URLSearchParams(window.location.search);
    var refCode = params.get('ref');
    if (refCode) {
      localStorage.setItem('sp_pending_referral_code', refCode);
      // Clean URL
      if (window.history && window.history.replaceState) {
        window.history.replaceState({}, '', window.location.pathname);
      }
    }
  } catch (e) {
    console.warn('[Referral] URL param capture failed:', e);
  }
})();

/* ── 8. RENDER WIDGET AFTER PROFILE LOAD ── */
var _ezLoadProfileBase3 = (typeof ezLoadProfile === 'function') ? ezLoadProfile : null;
if (_ezLoadProfileBase3) {
  ezLoadProfile = async function () {
    await _ezLoadProfileBase3();
    try { ezRenderRefWidget(); } catch(e) {}
  };
}

var _updateDashboardEZ3 = (typeof updateDashboard === 'function') ? updateDashboard : null;
if (_updateDashboardEZ3) {
  updateDashboard = function () {
    _updateDashboardEZ3();
    if (typeof EZ_PROFILE !== 'undefined' && EZ_PROFILE) {
      try { ezRenderRefWidget(); } catch(e) {}
    }
  };
}

/* ── 9. ADMIN: VIEW REFERRAL STATS ──
   Called from admin panel to show referral analytics */
function ezGetReferralStats() {
  var p = (typeof EZ_PROFILE !== 'undefined' && EZ_PROFILE) ? EZ_PROFILE : {};
  return {
    refCount: p.refCount || 0,
    totalDaysEarned: p.referralDaysEarned || 0,
    referrals: p.referrals || [],
    lastBonus: p.lastReferralBonus || 0,
    lastReferralDate: p.lastReferralDate || null,
    planExpiry: p.planExpiry || null
  };
}
