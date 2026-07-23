/* ══════════════════════════════════════════════
   STUDYPLANNER REFERRAL SYSTEM — PRO DAYS REWARD
   ══════════════════════════════════════════════
   Rules:
   - 1 friend = 3 days Pro free
   - Each additional friend = +2 more days
   - Formula: totalDays = 3 + (friends - 1) * 2
   - Works ONLY for new device + new account
   - No cash payment. Only Pro days.
   ══════════════════════════════════════════════ */

/* ── 1. DEVICE FINGERPRINT ──
   Generates a unique ID for this device/browser.
   Stored in localStorage. If cleared, regenerated. */
function ezGetDeviceId() {
  var key = 'sp_device_id';
  var id = localStorage.getItem(key);
  if (!id) {
    // Generate unique device fingerprint
    var raw = [
      navigator.userAgent || '',
      navigator.language || '',
      screen.width + 'x' + screen.height,
      screen.colorDepth || '',
      new Date().getTimezoneOffset(),
      navigator.hardwareConcurrency || '',
      navigator.platform || '',
      Math.random().toString(36).substring(2)
    ].join('|');
    // Simple hash
    var hash = 0;
    for (var i = 0; i < raw.length; i++) {
      var chr = raw.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash |= 0;
    }
    id = 'dev_' + Math.abs(hash).toString(36) + '_' + Date.now().toString(36);
    localStorage.setItem(key, id);
  }
  return id;
}

/* ── 2. REFERRAL LINK GENERATION ── */
function ezRefLink() {
  if (!currentUser) return '';
  var base = location.origin + location.pathname.replace(/app.html.*$/, '');
  return base + '?ref=' + encodeURIComponent(currentUser.uid);
}

/* ── 3. REFERRAL REWARD CALCULATION ──
   1 friend = 3 days, each additional = +2 days */
function ezReferralDays(friendCount) {
  if (friendCount <= 0) return 0;
  return 3 + (friendCount - 1) * 2;
}

/* Total days for ALL friends combined (cumulative milestone total) */
function ezReferralTotalDays(friendCount) {
  if (friendCount <= 0) return 0;
  // Sum: 3 + 5 + 7 + 9 + ... for each friend
  // = sum of (3 + (i-1)*2) for i=1 to n
  // = 3n + 2 * (n*(n-1)/2) = 3n + n*(n-1) = n^2 + 2n
  return friendCount * friendCount + 2 * friendCount;
}

/* ── 4. PROCESS INCOMING REFERRAL (when new user signs up with ?ref=) ──
   Called during auth/signup flow */
async function ezProcessReferralOnSignup(newUserId) {
  try {
    var refCode = localStorage.getItem('sp_pending_referral_code');
    if (!refCode) return;
    // Don't remove the key until the whole flow finishes — this lets us
    // retry on a page refresh if the user reopens the tab mid-signup.

    // Block self-referral
    if (refCode === newUserId) {
      console.log('[Referral] Self-referral blocked.');
      localStorage.removeItem('sp_pending_referral_code');
      return;
    }

    var deviceId = ezGetDeviceId();

    // Check Firestore: is this a truly new account + new device?
    if (typeof db !== 'undefined' && db && typeof firebase !== 'undefined' && firebase) {
      // Check 1: Has this device been used before?
      var deviceSnap = await db.collection('referral_devices').doc(deviceId).get();
      if (deviceSnap.exists) {
        console.log('[Referral] Device already registered. Referral rejected.');
        if (typeof showToast === 'function') showToast('Referral: This device already has an account.', 'info');
        localStorage.removeItem('sp_pending_referral_code');
        return;
      }

      // Check 2: Does the referrer exist?
      var referrerDoc = await db.collection('users').doc(refCode).get();
      if (!referrerDoc.exists) {
        console.log('[Referral] Referrer not found.');
        localStorage.removeItem('sp_pending_referral_code');
        return;
      }

      // Check 3: Is the new account truly new? (created just now)
      var newUserDoc = await db.collection('users').doc(newUserId).get();
      if (newUserDoc.exists) {
        var userData = newUserDoc.data();
        // If account was created more than 5 minutes ago, it's not new
        if (userData.createdAt) {
          var created = new Date(userData.createdAt);
          var fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
          if (created < fiveMinAgo) {
            console.log('[Referral] Account is not new. Referral rejected.');
            localStorage.removeItem('sp_pending_referral_code');
            return;
          }
        }
      }

      // ✅ All checks passed — register device + count referral
      // Register this device
      await db.collection('referral_devices').doc(deviceId).set({
        userId: newUserId,
        referrer: refCode,
        registeredAt: new Date().toISOString(),
        userAgent: navigator.userAgent || ''
      });

      // Increment referrer's count
      await db.collection('users').doc(refCode).set({
        'profile.refCount': firebase.firestore.FieldValue.increment(1),
        'profile.referrals': firebase.firestore.FieldValue.arrayUnion({
          userId: newUserId,
          deviceId: deviceId,
          date: new Date().toISOString()
        })
      }, { merge: true });

      // Calculate and grant Pro days to referrer
      var referrerProfile = (referrerDoc.data() && referrerDoc.data().profile) || {};
      var newRefCount = (referrerProfile.refCount || 0) + 1;
      var bonusDays = ezReferralDays(newRefCount); // Days for THIS friend (3, 5, 7, 9...)

      // Extend referrer's Pro expiry
      var currentExpiry = referrerProfile.planExpiry
        ? new Date(referrerProfile.planExpiry)
        : new Date();
      if (currentExpiry < new Date()) currentExpiry = new Date(); // Start from today if expired

      var newExpiry = new Date(currentExpiry.getTime() + bonusDays * 86400000);

      await db.collection('users').doc(refCode).set({
        'profile.plan': 'referral',
        'profile.planExpiry': newExpiry.toISOString().split('T')[0],
        'profile.referralDaysEarned': firebase.firestore.FieldValue.increment(bonusDays),
        'profile.lastReferralBonus': bonusDays,
        'profile.lastReferralDate': new Date().toISOString()
      }, { merge: true });

      // Grant 1 day Pro to the new user (welcome bonus)
      var welcomeExpiry = new Date(Date.now() + 86400000);
      await db.collection('users').doc(newUserId).set({
        'profile.plan': 'referral_welcome',
        'profile.planExpiry': welcomeExpiry.toISOString().split('T')[0],
        'profile.referredBy': refCode
      }, { merge: true });

      // Log for admin
      await db.collection('referral_log').add({
        referrer: refCode,
        referee: newUserId,
        deviceId: deviceId,
        bonusDays: bonusDays,
        totalRefCount: newRefCount,
        date: new Date().toISOString()
      });

      console.log('[Referral] ✅ Success! Referrer gets ' + bonusDays + ' days Pro.');
      if (typeof showToast === 'function') {
        showToast('🎉 Referral successful! Your friend got 1 day Pro free.', 'success');
      }
      localStorage.removeItem('sp_pending_referral_code');
    }
  } catch (e) {
    console.error('[Referral] Processing error:', e);
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
    { friends: 3, days: 7, label: '3 friends' },
    { friends: 5, days: 11, label: '5 friends' },
    { friends: 10, days: 21, label: '10 friends' },
    { friends: 20, days: 41, label: '20 friends' }
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
          '<span>1st friend → <strong style="color:var(--text,#fff)">3 days</strong></span>' +
          '<span>2nd friend → <strong style="color:var(--text,#fff)">+5 days</strong></span>' +
          '<span>3rd friend → <strong style="color:var(--text,#fff)">+7 days</strong></span>' +
          '<span>4th friend → <strong style="color:var(--text,#fff)">+9 days</strong></span>' +
          '<span>5th friend → <strong style="color:var(--text,#fff)">+11 days</strong></span>' +
          '<span>Each next → <strong style="color:var(--text,#fff)">+2 more</strong></span>' +
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
            nextMilestone.days + ' days per friend' +
          '</div>'
        : '<div style="font-size:0.78rem;color:#10b981;text-align:center;">🏆 All milestones reached! Keep referring!</div>') +

      /* Rules */
      '<div style="margin-top:0.75rem;padding-top:0.75rem;border-top:1px solid var(--border,#333);font-size:0.72rem;color:var(--muted,#999);">' +
        '<p style="font-weight:600;margin-bottom:4px;">📋 Rules:</p>' +
        '<p>• Referral counts only for <strong>new device + new account</strong></p>' +
        '<p>• Same device or existing account = not counted</p>' +
        '<p>• Self-referral not allowed</p>' +
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
