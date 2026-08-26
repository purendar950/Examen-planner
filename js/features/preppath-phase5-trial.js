/* ══════════════════════════════════════════════
   PREPPATH PHASE 5 — 7-DAY TRIAL, WEEKLY/MONTHLY GATING, PDF EXPORT
   NOTE: the 7-day trial is stored in appState.proTrial because Firestore
   rules make profile.trialExpiry admin-only. appState is user-writable and
   syncs via saveProgress().
══════════════════════════════════════════════ */

/* ── Self-serve 7-day Pro trial (stored in appState) ──
   The tamper-guard logic in ezIsProTrialActive() below is mirrored
   server-side in shared/proGating.js (used by the bot + daily Telegram
   sender). Keep both in sync if you change the trial rules. ── */
function ezProTrialExpiry() {
  return (appState && appState.proTrial && appState.proTrial.expiry) ? appState.proTrial.expiry : null;
}
function ezIsProTrialActive() {
  // If profile hasn't loaded from Firestore yet, deny trial access.
  // This prevents the 400ms race window where free users bypass gating.
  if (EZ_PROFILE === null) return false;
  // Admin can suspend any trial by setting profile.trialSuspended = true
  // (admin-only writable field). Blocks access immediately on next snapshot.
  if (EZ_PROFILE.trialSuspended) return false;
  var exp = ezProTrialExpiry();
  if (!exp) return false;
  // FIX (Bug 3) + SECURITY FIX: Tamper guard — mirrors shared/proGating.js.
  // A trial with no startedAt, an unparseable startedAt, a future-dated
  // startedAt, or an expiry beyond startedAt + 4 days is denied. The old
  // guard skipped entirely when startedAt was missing and never checked
  // that startedAt is in the past, so hand-edited trials could pass.
  var trial = appState && appState.proTrial;
  if (!trial || !trial.startedAt) return false;               // no start marker — deny
  // The one-time marker is written by the authenticated trial endpoint and is
  // immutable to normal clients. A hand-edited appState trial cannot match it.
  if (!EZ_PROFILE.proTrialUsed || EZ_PROFILE.proTrialStartedAt !== trial.startedAt) return false;
  var startedAt = new Date(trial.startedAt);
  if (isNaN(startedAt.getTime())) return false;               // unparseable — deny
  if (startedAt.getTime() > Date.now() + 86400000) return false; // future-dated — deny
  var maxAllowedExpiry = new Date(startedAt.getTime() + 8 * 86400000); // 7 days + 1 grace
  var claimedExpiry = new Date(exp + 'T23:59:59');
  if (claimedExpiry > maxAllowedExpiry) return false;         // Tampered expiry — deny
  return claimedExpiry >= new Date();
}
function ezProTrialUsed() {
  // Once per account: the trial counts as USED if ANY durable marker says so.
  // Checking several independent sources keeps the rule resilient if a user
  // clears/edits their local appState — the flag also lives on the synced
  // profile doc, and any admin-granted trial (profile.trialExpiry) counts too.
  if (appState && appState.proTrial && appState.proTrial.startedAt) return true;
  if (appState && appState.proTrialUsed) return true;
  if (typeof EZ_PROFILE !== 'undefined' && EZ_PROFILE &&
      (EZ_PROFILE.proTrialUsed || EZ_PROFILE.trialExpiry)) return true;
  return false;
}
function ezProTrialDaysLeft() {
  var exp = ezProTrialExpiry();
  if (!exp) return 0;
  return Math.max(0, Math.ceil((new Date(exp + 'T23:59:59') - new Date()) / 86400000));
}
async function ezStartProTrial() {
  if (!currentUser) { showToast('Pehle account banao/login karo.', 'error'); return; }
  if (typeof ezEntitlementDisplayPending === 'function' ? ezEntitlementDisplayPending() : (typeof EZ_PROFILE === 'undefined' || EZ_PROFILE === null)) {
    showToast('Profile load ho raha hai — ek second baad try karo.', 'info'); return;
  }
  var legacyNeedsAdoption = !!(appState && appState.proTrial && appState.proTrial.startedAt
    && !(EZ_PROFILE && EZ_PROFILE.proTrialUsed));
  if (ezProTrialUsed() && !legacyNeedsAdoption) { showToast('Free trial pehle hi use ho chuka hai — ek account pe ek hi baar milta hai.', 'error'); return; }
  if (typeof ezIsPro === 'function' && ezIsPro()) { showToast('Aap already Pro ho 🎉', 'info'); return; }

  var button = document.getElementById('ez-start-trial-btn');
  if (button) { button.disabled = true; button.textContent = 'Starting securely…'; }
  try {
    var token = await getFirebaseIdToken();
    var backend = privilegedBackendUrl();
    var response = await fetch(backend + '/trials/start', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: '{}'
    });
    var result = await response.json().catch(function() { return {}; });
    if (!response.ok || result.ok !== true) {
      throw new Error(result.error || 'Trial could not be started.');
    }
    if (result.used || !result.trial) {
      EZ_PROFILE = Object.assign({}, EZ_PROFILE || {}, { proTrialUsed: true });
      throw new Error('Free trial pehle hi use ho chuka hai — ek account pe ek hi baar milta hai.');
    }

    appState.proTrial = result.trial;
    appState.proTrialUsed = true;
    EZ_PROFILE = Object.assign({}, EZ_PROFILE || {}, {
      proTrialUsed: true,
      proTrialStartedAt: result.trial.startedAt
    });
    try { saveProgress(); } catch(e) {}
    showToast('🎉 7-din ka Pro trial shuru! Saare Pro features unlock.', 'success');
    try { var ov = document.getElementById('ez-upgrade-overlay'); if (ov) ov.classList.remove('open'); } catch(e) {}
    try { if (typeof ezRefreshGates === 'function') ezRefreshGates(); } catch(e) {}
  } catch (e) {
    showToast(e.message || 'Trial start failed.', 'error');
    if (button) { button.disabled = false; button.textContent = '🎁 Start 7-day free Pro trial'; }
  }
}

/* Extend ezIsPro to also honor the self-serve trial (without losing the
   original profile-based logic). */
(function() {
  if (typeof ezIsPro !== 'function') return;
  var _ezIsProBase = ezIsPro;
  ezIsPro = function() {
    if (_ezIsProBase()) return true;
    return ezIsProTrialActive();
  };
})();

/* ── Central gate refresher ──
   Re-applies EVERY Pro/free gate. Call this whenever the user's Pro status
   could have changed (trial expiry, admin suspend, plan change) so the UI
   immediately reflects free-tier restrictions WITHOUT a page reload.
   This fixes: after trial expires/suspends, a user could still use Pro
   features (syllabus editing on other exams, week/month/3-month planner
   views) because those gates were only applied on login / navigation. */
function ezRefreshGates() {
  try { ezApplyExamLock(); }        catch(e) {}
  try { ezApplyTelegramLock(); }    catch(e) {}
  try { ezApplyPageLock(); }        catch(e) {}
  try { ezApplySyllabusLockUI(); }  catch(e) {}
  /* If a now-gated user is sitting on a Pro-only planner view, bounce them
     back to the free day view. */
  try {
    if (typeof ezGated === 'function' && ezGated() &&
        typeof plannerView !== 'undefined' &&
        (plannerView === 'week' || plannerView === 'month' || plannerView === '3month')) {
      plannerView = 'day';
      if (typeof renderPlannerView === 'function') renderPlannerView();
    }
  } catch(e) {}
  try { if (typeof updateDashboard === 'function') updateDashboard(); } catch(e) {}
  /* Remove any pro-blur overlay (e.g. Turbo 4× Player) that was applied while
     entitlement was still pending. youtube/yt-organiser pages aren't in the
     per-page rebuild list below, so without this they'd stay locked for the
     rest of the session even after the user is confirmed Pro. */
  try { if (typeof ezUnblurAllProSurfaces === 'function') ezUnblurAllProSurfaces(); } catch(e) {}
  /* Re-render the CURRENTLY ACTIVE page so Pro-only surfaces rendered while
     Pro (mock analysis charts, AI timetable, syllabus marks) immediately
     reflect free-tier gating without a reload. */
  try {
    var active = document.querySelector('.page.active');
    var pid = active ? active.id.replace('page-', '') : '';
    if (pid === 'syllabus' && typeof buildSyllabus === 'function') buildSyllabus();
    else if (pid === 'mocks' && typeof mockRenderPage === 'function') mockRenderPage();
    else if (pid === 'planner' && typeof renderPlannerView === 'function') renderPlannerView();
    else if (pid === 'dashboard' && typeof updateDashboard === 'function') updateDashboard();
  } catch(e) {}
  /* Refresh every entitlement label (top badge, open dropdown, profile page). */
  try {
    if (typeof ezRenderEntitlementSurfaces === 'function') ezRenderEntitlementSurfaces();
    else if (typeof ezRenderPlanBadge === 'function') ezRenderPlanBadge();
  } catch(e) {}
}

/* ── Trial expiry watchdog ──
   proTrial.expiry / planExpiry are date strings; nothing re-checks them once
   the app is open. This timer detects the moment a trial or plan lapses and
   immediately re-applies free-tier gating. Runs every 60s and once on load. */
(function() {
  var _wasPro = null;
  function checkExpiry() {
    if (!currentUser) return;
    // FIX 2a: EZ_PROFILE must be loaded before we can make a meaningful check.
    // If it's still null (loading race), skip this tick — the ezLoadProfile()
    // call will trigger ezRefreshGates() directly once it resolves.
    if (typeof EZ_PROFILE === 'undefined' || EZ_PROFILE === null) return;
    var nowPro = (typeof ezIsPro === 'function') ? ezIsPro() : false;
    if (_wasPro === null) { _wasPro = nowPro; return; }
    if (_wasPro && !nowPro) {
      // Just dropped from Pro → free (trial expired or plan ended)
      _wasPro = false;
      try { ezRefreshGates(); } catch(e) {}
      try { showToast('ℹ️ Aapka Pro access khatam ho gaya. Free plan active hai.', 'info'); } catch(e) {}
    } else if (!_wasPro && nowPro) {
      _wasPro = true;
      try { ezRefreshGates(); } catch(e) {}
    } else {
      _wasPro = nowPro;
    }
  }
  // FIX 2b: Check every 30s instead of 60s for faster expiry detection.
  setInterval(checkExpiry, 30 * 1000);
  // FIX 2c: Also check when the user returns to the tab (tab was hidden, time passed).
  // This catches the common case: user leaves tab open overnight, trial expired,
  // they come back next morning — should immediately see free-tier gating.
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') {
      setTimeout(checkExpiry, 200); // slight delay so EZ_PROFILE is stable
    }
  });
  // FIX 2d: Also check on window focus (e.g. user switches back from another app).
  window.addEventListener('focus', function() { setTimeout(checkExpiry, 200); });
  window.addEventListener('load', function() { setTimeout(checkExpiry, 2000); });
  window.ezCheckExpiryNow = checkExpiry;
})();

/* ── Gate the weekly + monthly planner views to Pro/trial ──
   setTimetableView('week') and the monthly planner view show a Pro CTA for
   free users; the day view stays free. */
(function() {
  if (typeof setTimetableView === 'function') {
    var _setView = setTimetableView;
    setTimetableView = function(view) {
      if ((view === 'week' || view === 'month') && ezGated()) {
        ezLockedMsg('Weekly / Monthly plan view');
        return _setView('day');
      }
      return _setView(view);
    };
  }
  /* FIX (Issue 1): the main planner Day/Week/Month/3 Months tabs call
     setPlannerView — this was NOT gated, so free users could open the
     3-month (and week/month) views. Block week/month/3month for free users
     and keep them on the day view. */
  if (typeof setPlannerView === 'function') {
    var _setPlannerView = setPlannerView;
    setPlannerView = function(view, btn) {
      if ((view === 'week' || view === 'month' || view === '3month') && ezGated()) {
        ezLockedMsg('Weekly / Monthly / 3-Month plan view');
        var dayTab = document.querySelector('.planner-view-tab[data-view="day"]');
        return _setPlannerView('day', dayTab);
      }
      return _setPlannerView(view, btn);
    };
  }
  if (typeof renderPlannerView === 'function') {
    var _renderPV = renderPlannerView;
    renderPlannerView = function() {
      /* Force free users back to day view if they somehow land on a gated view. */
      if (ezGated() && (typeof plannerView !== 'undefined') &&
          (plannerView === 'week' || plannerView === 'month' || plannerView === '3month')) {
        try { plannerView = 'day'; } catch(e) {}
      }
      return _renderPV();
    };
  }
})();

/* ══════════════════════════════════════════════
   FIX (Issue 2): SYLLABUS — view-only for non-target exams (free users)
   Free users can browse the full syllabus of every exam, but may only
   mark / save topics (complete toggle, bookmark, difficulty, notes) for
   their selected target exam. Other exams stay read-only with an upgrade
   nudge. Pro/trial users and admins are unaffected.
══════════════════════════════════════════════ */
function ezCanEditSyllabus() {
  // Not gated (Pro/trial/admin) — full edit access.
  if (!ezGated()) return true;
  // Free user: editing allowed only on their selected target exam.
  // FIX: the old fallback was `currentExam` — meaning if examTarget was
  // missing from the profile (e.g. old user, or profile not yet loaded),
  // `allowed` would equal `currentExam` and the check always returned true,
  // letting the free user mark topics on ANY exam they switched to.
  // New fallback: if EZ_PROFILE hasn't loaded yet (null) → DENY by default.
  // If profile is loaded but examTarget is missing → DENY (safe default).
  if (!EZ_PROFILE) return false; // profile not loaded yet — deny until confirmed
  var allowed = EZ_PROFILE.examTarget || null;
  if (!allowed) return false; // no target exam set in profile — deny all editing
  return currentExam === allowed;
}

/* Visual lock indicator on syllabus checkboxes for non-target exams.
   Free users see a 🔒 cursor + tooltip so they know upfront it is view-only. */
function ezApplySyllabusLockUI() {
  // Helper to remove lock styles from all checkboxes
  function _unlockAll() {
    document.querySelectorAll('.ch-checkbox[data-locked]').forEach(function(el) {
      el.removeAttribute('data-locked');
      el.title = ''; el.style.opacity = ''; el.style.cursor = '';
      el.style.pointerEvents = ''; // FIX 4: Restore click events when unlocking
    });
  }
  // Helper to lock all checkboxes with a tooltip
  function _lockAll(targetLabel) {
    document.querySelectorAll('.ch-checkbox').forEach(function(el) {
      el.setAttribute('data-locked', '1');
      el.title = '🔒 Sirf apne target exam (' + targetLabel + ') mein mark kar sakte ho. Upgrade karo all exams ke liye.';
      el.style.opacity = '0.4';
      el.style.cursor = 'not-allowed';
      // FIX 4: Disable pointer events so the onclick on the div doesn't fire at all.
      // Without this, the click event still reaches toggleChapter() even with cursor:not-allowed.
      el.style.pointerEvents = 'none';
    });
  }

  // Pro/trial/admin — full edit, remove any stale locks
  if (!ezGated()) { _unlockAll(); return; }

  // FIX 2: Profile not loaded yet → lock everything until we know the target.
  // This closes the race window where buildSyllabus() fires before ezLoadProfile()
  // resolves, causing the lock UI to run with EZ_PROFILE=null and skip locking.
  if (!EZ_PROFILE) { _lockAll('YOUR TARGET'); return; }

  var allowed = EZ_PROFILE.examTarget || null;

  // FIX 2: No target exam in profile → lock ALL exams (safe default).
  // Old code fell back to currentExam here, which made every exam editable.
  if (!allowed) { _lockAll('YOUR TARGET'); return; }

  if (currentExam === allowed) {
    // Currently on the target exam — unlock
    _unlockAll();
  } else {
    // Non-target exam — lock with the target exam name in the tooltip
    _lockAll(allowed.toUpperCase());
  }
}
(function() {
  function gateSyllabusEdit(name, feature) {
    if (typeof window[name] !== 'function') return;
    var _base = window[name];
    window[name] = function() {
      if (!ezCanEditSyllabus()) {
        ezLockedMsg(feature + ' — sirf apne selected exam ke liye allowed hai. All exams');
        return;
      }
      return _base.apply(this, arguments);
    };
  }
  gateSyllabusEdit('toggleChapter',   'Topic marking');
  gateSyllabusEdit('toggleBookmark',  'Bookmarking');
  gateSyllabusEdit('setDifficulty',   'Difficulty tagging');
  gateSyllabusEdit('saveChapterNote', 'Chapter notes');
})();

/* ── PDF / print export (Pro) ──
   Opens a clean print window of the given HTML so the user can Save as PDF. */
function ezExportPdf(title, bodyHtml) {
  if (ezGated()) { ezLockedMsg('PDF export'); return; }
  var w = window.open('', '_blank');
  if (!w) { showToast('Popup block ho gaya — PDF export ke liye popups allow karo.', 'error'); return; }
  w.document.write(
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + (title || 'StudyPlanner Export') + '</title>' +
    '<style>@page{margin:5mm;}' +
    'body{font-family:Inter,Arial,sans-serif;color:#16202E;padding:0;line-height:1.6;}' +
    'h1{font-size:1.3rem;margin-bottom:4px;}h2{font-size:1rem;margin:18px 0 6px;}' +
    '.muted{color:#64748B;font-size:.85rem;margin-bottom:16px;}' +
    'table{width:100%;border-collapse:collapse;font-size:.85rem;}td,th{border:1px solid #E3E8EF;padding:6px 8px;text-align:left;}' +
    'ul{margin:0 0 12px 18px;}@media print{button{display:none;}}</style></head><body>' +
    '<h1>' + (title || 'StudyPlanner Export') + '</h1>' +
    '<div class="muted">StudyPlanner — ' + new Date().toLocaleString('en-IN') + '</div>' +
    (bodyHtml || '<p>No data.</p>') +
    '<button onclick="window.print()" style="margin-top:20px;background:#00C896;color:#fff;border:none;border-radius:8px;padding:10px 18px;font-weight:700;cursor:pointer;">🖨 Save as PDF</button>' +
    '</body></html>'
  );
  w.document.close();
}

/* Export the current saved plans for this exam. */
function ezExportPlansPdf() {
  var plans = (typeof plansForCurrentExam === 'function') ? plansForCurrentExam() : (appState.plans || []);
  if (!plans.length) { showToast('Koi plan nahi hai export karne ke liye.', 'info'); return; }
  var rows = plans.map(function(p) {
    var sum = (typeof planShortSummary === 'function') ? planShortSummary(p) : '';
    return '<tr><td>' + escapeHtml(p.name || '') + '</td><td>' + escapeHtml((p.type || '')) + '</td><td>' + escapeHtml(sum) + '</td></tr>';
  }).join('');
  ezExportPdf('My Study Plans', '<table><thead><tr><th>Name</th><th>Type</th><th>Summary</th></tr></thead><tbody>' + rows + '</tbody></table>');
}

/* Export saved video notes. */
function ezExportNotesPdf() {
  var notes = (typeof ytNotes !== 'undefined' && Array.isArray(ytNotes)) ? ytNotes : (appState.ytNotes || []);
  if (!notes.length) { showToast('Koi note nahi hai export karne ke liye.', 'info'); return; }
  var html = notes.map(function(n) {
    var t = n.title || n.videoTitle || 'Note';
    var body = (n.text || n.body || n.content || '').toString();
    return '<h2>' + escapeHtml(t) + '</h2><div>' + escapeHtml(body).replace(/\n/g, '<br>') + '</div>';
  }).join('');
  ezExportPdf('My Notes', html);
}

/* ══════════════════════════════════════════════
   DAILY STUDY NOTIFICATIONS
   - Morning: today's schedule / things to do
   - 9 PM:   prompt to fill what was completed
   Client-side only (no backend). Fires while the app is open and catches up
   on app open. Each notification fires at most once per day per user.
══════════════════════════════════════════════ */
(function() {
  var MORNING_HOUR = 7;   // 7:00 AM local
  var EVENING_HOUR = 21;  // 9:00 PM local
  var _notifTimer = null;

  function todayKey() { try { return fmtDate(new Date()); } catch(e) { return new Date().toISOString().slice(0,10); } }

  function notifState() {
    if (!appState.notif || typeof appState.notif !== 'object') appState.notif = {};
    if (appState.notif.enabled === undefined) appState.notif.enabled = true;
    return appState.notif;
  }

  /* Build a short list of today's scheduled study items + open tasks. */
  function todaysThingsToDo() {
    var ds = todayKey();
    var items = [];
    try {
      var map = (typeof getPlanScheduleMap === 'function') ? getPlanScheduleMap() : {};
      (map[ds] || []).forEach(function(it) { var ch = it.ch || {}; if (ch.name) items.push(ch.name); });
    } catch(e) {}
    try {
      var tasks = (appState.tasks && appState.tasks[ds]) || [];
      tasks.filter(function(t) { return !t.done; }).forEach(function(t) { if (t.text) items.push(t.text); });
    } catch(e) {}
    return items;
  }

  function completedToday() {
    var ds = todayKey();
    try {
      var tasks = (appState.tasks && appState.tasks[ds]) || [];
      return { done: tasks.filter(function(t) { return t.done; }).length, total: tasks.length };
    } catch(e) { return { done: 0, total: 0 }; }
  }

  function canNotify() {
    return ('Notification' in window) && Notification.permission === 'granted' && notifState().enabled;
  }

  function fire(title, body, tag) {
    try {
      var n = new Notification(title, { body: body, tag: tag });
      n.onclick = function() { try { window.focus(); if (typeof switchPage === 'function') switchPage('planner'); } catch(e) {} n.close(); };
    } catch(e) {}
    /* Always also show an in-app toast as a fallback. */
    try { if (typeof showToast === 'function') showToast(title + ' — ' + body, 'info'); } catch(e) {}
  }

  function sendMorning() {
    var items = todaysThingsToDo();
    var body = items.length
      ? '📚 ' + items.slice(0, 4).join(', ') + (items.length > 4 ? ' +' + (items.length - 4) + ' more' : '')
      : 'Aaj koi item scheduled nahi — plan banao ya tasks add karo.';
    fire('🌅 Today ka schedule', body, 'ez-morning-' + todayKey());
  }

  function sendEvening() {
    var c = completedToday();
    var body = c.total
      ? 'Aaj ' + c.done + '/' + c.total + ' tasks done. Baaki kya complete hua? Tap karke update karo.'
      : 'Aaj kya complete hua? Tap karke apna progress fill karo.';
    fire('🌙 Day review (9 PM)', body, 'ez-evening-' + todayKey());
  }

  /* Fire any window whose time has passed today and hasn't fired yet. */
  function checkDue() {
    if (!canNotify()) return;
    var st = notifState();
    var now = new Date();
    var ds = todayKey();
    if (now.getHours() >= MORNING_HOUR && st.lastMorning !== ds) {
      sendMorning(); st.lastMorning = ds; try { saveProgress(); } catch(e) {}
    }
    if (now.getHours() >= EVENING_HOUR && st.lastEvening !== ds) {
      sendEvening(); st.lastEvening = ds; try { saveProgress(); } catch(e) {}
    }
  }

  function startScheduler() {
    if (_notifTimer) clearInterval(_notifTimer);
    checkDue();                       // catch up immediately
    _notifTimer = setInterval(checkDue, 60 * 1000); // re-check every minute
  }

  /* Ask for permission once (after login), then start the scheduler. */
  window.ezInitNotifications = function() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') { startScheduler(); return; }
    if (Notification.permission === 'denied') return;
    try {
      var r = Notification.requestPermission(function() { startScheduler(); });
      if (r && typeof r.then === 'function') r.then(function() { startScheduler(); });
    } catch(e) {}
  };

  /* Hook into the existing login flow used by the EZ phases. */
  if (typeof loginUser === 'function') {
    var _loginUserNotif = loginUser;
    loginUser = function(email, name, uid, state) {
      _loginUserNotif(email, name, uid, state);
      setTimeout(function() { try { window.ezInitNotifications(); } catch(e) {} }, 1200);
    };
  }
  /* Also start if the user is already logged in when this loads. */
  window.addEventListener('load', function() {
    setTimeout(function() {
      if (typeof currentUser !== 'undefined' && currentUser) {
        try { window.ezInitNotifications(); } catch(e) {}
      }
    }, 1500);
  });
})();

/* Pre-fill the Telegram fields whenever the Study Profile modal opens. */
(function() {
  if (typeof openStudyProfileModal === 'function') {
    var _openSPM = openStudyProfileModal;
    openStudyProfileModal = function() {
      _openSPM.apply(this, arguments);
      try {
        var tg = (appState && appState.telegram) || {};
        var c = document.getElementById('tg-chatid');
        var e = document.getElementById('tg-enabled');
        var s = document.getElementById('tg-status-msg');
        if (c) c.value = tg.chatId || '';
        if (e) e.checked = !!tg.enabled;
        if (s) {
          if (tg.enabled && tg.chatId) {
            s.style.color = '#27ae60';
            s.textContent = '✅ Connected — roz 6 AM IST pe message aata hai.';
          } else if (tg.chatId && !tg.enabled) {
            s.style.color = 'var(--muted)';
            s.textContent = '🔕 Chat ID saved, lekin notifications OFF hain.';
          } else {
            s.style.color = 'var(--muted)';
            s.textContent = '';
          }
        }
      } catch(err) {}
    };
  }
})();

/* ══════════════════════════════════════════════
   TRIAL ENHANCEMENTS — Reminders, modals, usage tracking
   (free-tier-hook prequel merged in #473; this branch adds the
    conversion-optimization layer for the 7-day trial.)
   Adap function-name references to this codebase:
     - aiTutorSend  → sendTutor         (js/features/ai-tutor.js)
     - turboPlay    → ytToggleTurbo     (js/features/turbo-player.js)
     - mockStart    → mockSave          (this codebase tracks completed
                                          mock attempts at the save point,
                                          since the test engine lives in a
                                          separate test-engine.html file)
     - generateTimetable  → unchanged (correct name in this codebase)
══════════════════════════════════════════════ */

/* ── 1. TRIAL USAGE TRACKING ──
   Increments a per-feature counter in appState.proTrial.usage whenever
   the user exercises a tracked Pro feature DURING an active trial. The
   counters are read by the "Trial Ending" and "Trial Ended" modals so
   we can show a personalised "you used AI Tutor 12×, Turbo 8×" summary
   that converts far better than generic copy. */
function ezTrialTrack(feature) {
  if (!appState || !appState.proTrial) return;
  if (typeof ezIsProTrialActive !== 'function' || !ezIsProTrialActive()) return;
  if (!appState.proTrial.usage || typeof appState.proTrial.usage !== 'object') {
    appState.proTrial.usage = {};
  }
  appState.proTrial.usage[feature] = (appState.proTrial.usage[feature] || 0) + 1;
  try { saveProgress(); } catch(e) {}
}

/* Hook into the real feature functions in this codebase. The wrappers
   call the original first, then increment the trial counter. Wrapped
   only when the user is on an active trial, so non-trial sessions take
   zero overhead. */
(function () {
  /* Track AI Tutor sends. This used to wrap `sendTutor`, but that function is
     declared inside the IIFE in js/features/ai-tutor.js and is not a window
     property, so `typeof sendTutor === 'function'` was false here and trial
     tutor usage was never actually counted. ai-tutor.js now emits an event for
     every accepted send instead, which also covers the suggestion chips, the
     quiz "re-explain" jump and the floating tutor window. */
  window.addEventListener('examzen:tutor-send', function () {
    try { ezTrialTrack('aiTutor'); } catch(e) {}
  });
  // Track Turbo 4× toggles (real function name: ytToggleTurbo)
  if (typeof ytToggleTurbo === 'function') {
    var _turbo = ytToggleTurbo;
    ytToggleTurbo = function () {
      var result;
      try { result = _turbo.apply(this, arguments); } catch(e) { result = undefined; }
      try { ezTrialTrack('turbo'); } catch(e) {}
      return result;
    };
  }
  // Track quiz / mock attempts at the save point. The actual quiz
  // is taken on test-engine.html, so this fires when the user returns
  // to the main app and saves the result.
  if (typeof mockSave === 'function') {
    var _mockSave = mockSave;
    mockSave = function () {
      var result;
      try { result = _mockSave.apply(this, arguments); } catch(e) { result = undefined; }
      try { ezTrialTrack('quiz'); } catch(e) {}
      return result;
    };
  }
  // Track AI Timetable generations
  if (typeof generateTimetable === 'function') {
    var _timetable = generateTimetable;
    generateTimetable = function () {
      var result;
      try { result = _timetable.apply(this, arguments); } catch(e) { result = undefined; }
      try { ezTrialTrack('timetable'); } catch(e) {}
      return result;
    };
  }
})();

/* ── 2. TRIAL STARTED WELCOME MODAL ──
   Fired once after a successful ezStartProTrial(). Lists the
   6 most compelling Pro features the user should try first. */
function ezShowTrialWelcomeModal() {
  var existing = document.getElementById('trial-welcome-modal');
  if (existing) existing.remove();

  var daysLeft = (typeof ezProTrialDaysLeft === 'function') ? ezProTrialDaysLeft() : 7;
  var expiry = (typeof ezProTrialExpiry === 'function') ? ezProTrialExpiry() : null;
  var expiryFormatted = expiry
    ? new Date(expiry + 'T23:59:59').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : '';

  var modal = document.createElement('div');
  modal.id = 'trial-welcome-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:10001;display:flex;align-items:center;justify-content:center;padding:1rem;';
  modal.innerHTML =
    '<div style="position:absolute;inset:0;background:rgba(0,0,0,0.7);" onclick="this.parentElement.remove()"></div>' +
    '<div style="position:relative;background:var(--surface,#1a1a2e);border:1px solid var(--border,#333);border-radius:16px;padding:2rem;max-width:440px;width:100%;text-align:center;animation:slideUp .3s ease;">' +
      '<div style="font-size:3rem;margin-bottom:0.5rem;">🎉</div>' +
      '<h3 style="font-size:1.3rem;margin-bottom:0.5rem;">7-Din Ka Pro Trial Shuru!</h3>' +
      '<p style="color:var(--muted,#999);font-size:0.9rem;margin-bottom:1rem;">Full access till <strong>' + expiryFormatted + '</strong> (' + daysLeft + ' days)</p>' +
      '<div style="background:var(--bg-secondary,#16213e);border-radius:10px;padding:1rem;margin-bottom:1.25rem;text-align:left;">' +
        '<p style="font-weight:700;font-size:0.85rem;margin-bottom:0.5rem;">🚀 Try these Pro features first:</p>' +
        '<ul style="margin:0;padding-left:1.2rem;font-size:0.82rem;color:var(--muted,#999);line-height:1.8;">' +
          '<li>🤖 <strong>AI Tutor</strong> — Ask any doubt, get instant answer</li>' +
          '<li>📺 <strong>Turbo 4×</strong> — Watch any lecture at 4× speed</li>' +
          '<li>📊 <strong>AI Insights</strong> — See weak topics + score prediction</li>' +
          '<li>📝 <strong>Unlimited Quizzes</strong> — Practice without limits</li>' +
          '<li>📅 <strong>AI Timetable</strong> — Auto-generated study plan</li>' +
          '<li>🔁 <strong>Spaced Repetition</strong> — Auto revision at 1/3/7/14/30 days</li>' +
        '</ul>' +
      '</div>' +
      '<button onclick="this.closest(\'#trial-welcome-modal\').remove();if(typeof switchPage===\'function\')switchPage(\'dashboard\');" ' +
        'style="width:100%;padding:12px;border-radius:10px;border:none;background:var(--accent,#00C896);color:#fff;font-weight:700;font-size:0.95rem;cursor:pointer;">' +
        'Start Exploring →</button>' +
      '<p style="font-size:0.72rem;color:var(--muted,#999);margin-top:0.75rem;">No payment needed · Ek baar hi milta hai · Cancel anytime</p>' +
    '</div>';
  document.body.appendChild(modal);
}

/* ── 3. TRIAL REMINDER BANNER (Day 5–1) ──
   Persistent strip across the top of the app, dismissible, with a direct
   "Upgrade Now" CTA that opens the upgrade modal. */
function ezShowTrialReminderBanner(daysLeft) {
  var existing = document.getElementById('trial-reminder-banner');
  if (existing) existing.remove();

  var messages = {
    5: '⚠️ Trial: 5 din baaki. Pro features enjoy karo!',
    4: '⚠️ Trial: 4 din baaki. AI Tutor + Turbo try kiya?',
    3: '⚠️ Trial: 3 din baaki. Upgrade karo — data safe rahega.',
    2: '🔴 Trial: Sirf 2 din baaki! Upgrade now — ₹49/month se shuru.',
    1: '🔴 Trial: LAST DAY! Kal se Pro features lock ho jayenge.'
  };
  var msg = messages[daysLeft] || ('⚠️ Trial: ' + daysLeft + ' din baaki.');

  var banner = document.createElement('div');
  banner.id = 'trial-reminder-banner';
  banner.setAttribute('role', 'alert');
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:10000;background:linear-gradient(135deg,#f59e0b,#ef4444);color:#fff;padding:10px 16px;text-align:center;font-size:0.85rem;font-weight:600;display:flex;align-items:center;justify-content:center;gap:12px;box-shadow:0 4px 12px rgba(0,0,0,0.3);';
  banner.innerHTML =
    '<span>' + msg + '</span>' +
    '<button onclick="try{ezOpenUpgrade();}catch(e){}this.parentElement.remove();" style="background:#fff;color:#ef4444;border:none;padding:5px 14px;border-radius:6px;font-weight:700;cursor:pointer;font-size:0.8rem;white-space:nowrap;">Upgrade Now</button>' +
    '<button onclick="this.parentElement.remove()" style="background:none;border:none;color:#fff;cursor:pointer;font-size:1.2rem;" aria-label="Dismiss">✕</button>';
  document.body.prepend(banner);
}

/* ── 4. TRIAL ENDING MODAL (Day 2–1) ──
   Shows a personalised usage summary + 3-tier pricing comparison + CTA.
   The summary line ("AI Tutor: 12 messages") is the social-proof lever
   that converts — it makes the user feel they invested effort, not just
   time. */
function ezShowTrialEndingModal(daysLeft) {
  var existing = document.getElementById('trial-ending-modal');
  if (existing) existing.remove();

  var usage = (appState && appState.proTrial && appState.proTrial.usage) || {};
  var usageLines = [];
  if (usage.aiTutor)    usageLines.push('🤖 AI Tutor: ' + usage.aiTutor + ' messages');
  if (usage.turbo)      usageLines.push('📺 Turbo 4×: ' + usage.turbo + ' videos watched');
  if (usage.quiz)       usageLines.push('📝 Quizzes: ' + usage.quiz + ' attempts');
  if (usage.timetable)  usageLines.push('📅 AI Timetable: ' + usage.timetable + ' plans generated');

  var usageHtml = usageLines.length
    ? '<div style="background:var(--bg-secondary,#16213e);border-radius:8px;padding:0.75rem 1rem;margin:0.75rem 0;text-align:left;font-size:0.82rem;line-height:1.8;">' +
        '<p style="font-weight:700;margin-bottom:4px;">📊 Your trial usage:</p>' +
        usageLines.join('<br>') +
      '</div>'
    : '<p style="font-size:0.82rem;color:var(--muted);margin:0.75rem 0;">You haven\'t explored much yet — try AI Tutor, Turbo 4×, and unlimited quizzes before your trial ends!</p>';

  var modal = document.createElement('div');
  modal.id = 'trial-ending-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:10001;display:flex;align-items:center;justify-content:center;padding:1rem;';
  modal.innerHTML =
    '<div style="position:absolute;inset:0;background:rgba(0,0,0,0.7);" onclick="this.parentElement.remove()"></div>' +
    '<div style="position:relative;background:var(--surface,#1a1a2e);border:1px solid var(--border,#333);border-radius:16px;padding:2rem;max-width:420px;width:100%;text-align:center;">' +
      '<div style="font-size:2.5rem;margin-bottom:0.5rem;">⏰</div>' +
      '<h3 style="font-size:1.2rem;margin-bottom:0.5rem;">Trial Ends in ' + daysLeft + ' Day' + (daysLeft > 1 ? 's' : '') + '!</h3>' +
      '<p style="color:var(--muted,#999);font-size:0.88rem;">You\'ll lose: AI Tutor, Turbo 4×, AI Insights, Unlimited Quizzes, Spaced Repetition, AI Timetable, Telegram Evening</p>' +
      usageHtml +
      '<div style="display:flex;gap:8px;margin:1rem 0;">' +
        '<div style="flex:1;padding:8px;border:1px solid var(--border,#333);border-radius:8px;text-align:center;"><span style="font-size:1.2rem;font-weight:800;">₹49</span><br><span style="font-size:0.7rem;color:var(--muted);">/month</span></div>' +
        '<div style="flex:1;padding:8px;border:1px solid var(--border,#333);border-radius:8px;text-align:center;"><span style="font-size:1.2rem;font-weight:800;">₹149</span><br><span style="font-size:0.7rem;color:var(--muted);">/3 months</span></div>' +
        '<div style="flex:1;padding:8px;border:2px solid var(--accent,#00C896);border-radius:8px;text-align:center;background:rgba(0,200,150,0.05);"><span style="font-size:1.2rem;font-weight:800;">₹399</span><br><span style="font-size:0.7rem;color:var(--accent);">/year (Save ₹189)</span></div>' +
      '</div>' +
      '<button onclick="this.closest(\'#trial-ending-modal\').remove();try{ezOpenUpgrade();}catch(e){};" ' +
        'style="width:100%;padding:12px;border-radius:10px;border:none;background:var(--accent,#00C896);color:#fff;font-weight:700;font-size:0.95rem;cursor:pointer;">' +
        'Upgrade to Pro →</button>' +
      '<button onclick="this.closest(\'#trial-ending-modal\').remove()" ' +
        'style="width:100%;padding:10px;border-radius:10px;border:1px solid var(--border,#333);background:transparent;color:var(--text,#fff);font-size:0.85rem;cursor:pointer;margin-top:8px;">' +
        'Maybe later</button>' +
      '<p style="font-size:0.72rem;color:var(--muted,#999);margin-top:0.75rem;">Your data is preserved for 30 days after trial ends.</p>' +
    '</div>';
  document.body.appendChild(modal);
}

/* ── 5. TRIAL ENDED MODAL ──
   Fires when the watchdog detects the trial just expired. Replaces the
   bare "ℹ️ Aapka Pro access khatam ho gaya" toast (which is fine but
   undersells the upgrade nudge) with a full modal that:
     - tallies total feature usage (loss-aversion)
     - enumerates the exact features now locked
     - shows pricing
     - reassures about 30-day data preservation */
function ezShowTrialEndedModal() {
  var existing = document.getElementById('trial-ended-modal');
  if (existing) existing.remove();

  var usage = (appState && appState.proTrial && appState.proTrial.usage) || {};
  var totalUsage = 0;
  for (var k in usage) {
    if (Object.prototype.hasOwnProperty.call(usage, k) && typeof usage[k] === 'number') {
      totalUsage += usage[k];
    }
  }

  var modal = document.createElement('div');
  modal.id = 'trial-ended-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:10001;display:flex;align-items:center;justify-content:center;padding:1rem;';
  modal.innerHTML =
    '<div style="position:absolute;inset:0;background:rgba(0,0,0,0.7);" onclick="this.parentElement.remove()"></div>' +
    '<div style="position:relative;background:var(--surface,#1a1a2e);border:1px solid var(--border,#333);border-radius:16px;padding:2rem;max-width:420px;width:100%;text-align:center;">' +
      '<div style="font-size:3rem;margin-bottom:0.5rem;">😢</div>' +
      '<h3 style="font-size:1.2rem;margin-bottom:0.5rem;">Your Pro Trial Has Ended</h3>' +
      (totalUsage > 0
        ? '<p style="color:var(--muted,#999);font-size:0.88rem;margin-bottom:0.75rem;">During your trial, you used Pro features <strong>' + totalUsage + ' times</strong>. Imagine what you could do with unlimited access!</p>'
        : '<p style="color:var(--muted,#999);font-size:0.88rem;margin-bottom:0.75rem;">You didn\'t get to explore much. Upgrade now and experience the full power of PrepPath Pro!</p>') +
      '<div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:0.75rem;margin-bottom:1rem;text-align:left;font-size:0.8rem;color:#ef4444;">' +
        '<p style="font-weight:700;margin-bottom:4px;">🔒 You just lost access to:</p>' +
        'AI Tutor · Turbo 4× · AI Insights · Unlimited Quizzes · Telegram Evening · AI Timetable · Spaced Repetition · PDF Export' +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-bottom:1rem;">' +
        '<div style="flex:1;padding:8px;border:1px solid var(--border,#333);border-radius:8px;"><span style="font-weight:800;">₹49</span><br><span style="font-size:0.7rem;color:var(--muted);">/mo</span></div>' +
        '<div style="flex:1;padding:8px;border:1px solid var(--border,#333);border-radius:8px;"><span style="font-weight:800;">₹249</span><br><span style="font-size:0.7rem;color:var(--muted);">/6mo</span></div>' +
        '<div style="flex:1;padding:8px;border:2px solid #10b981;border-radius:8px;background:rgba(16,185,129,0.05);"><span style="font-weight:800;">₹399</span><br><span style="font-size:0.7rem;color:#10b981;">/yr ⭐</span></div>' +
      '</div>' +
      '<button onclick="this.closest(\'#trial-ended-modal\').remove();try{ezOpenUpgrade();}catch(e){};" ' +
        'style="width:100%;padding:12px;border-radius:10px;border:none;background:var(--accent,#00C896);color:#fff;font-weight:700;font-size:0.95rem;cursor:pointer;">' +
        'Upgrade to Pro →</button>' +
      '<p style="font-size:0.72rem;color:var(--muted,#999);margin-top:0.75rem;">Your data is safe for 30 days. No progress lost.</p>' +
      '<button onclick="this.closest(\'#trial-ended-modal\').remove()" ' +
        'style="background:none;border:none;color:var(--muted,#999);cursor:pointer;margin-top:0.5rem;font-size:0.82rem;">' +
        'Continue with Free plan</button>' +
    '</div>';
  document.body.appendChild(modal);
}

/* ── 6. DASHBOARD TRIAL CTA ──
   Shown on the Dashboard page for users who are NOT Pro and haven't used
   their trial yet. This is the highest-conversion surface we own — users
   who land on the dashboard are already engaged, and the CTA converts
   far better than burying it inside the upgrade modal. */
function ezShowDashboardTrialCTA() {
  if (typeof currentUser === 'undefined' || !currentUser) return;
  if (typeof ezIsPro === 'function' && ezIsPro()) return; // already Pro
  if (typeof ezProTrialUsed === 'function' && ezProTrialUsed()) return; // already used
  // Wait for profile load so we don't re-render prematurely
  if (typeof EZ_PROFILE !== 'undefined' && EZ_PROFILE === null) return;

  var existing = document.getElementById('dashboard-trial-cta');
  if (existing) existing.remove();

  var dashboard = document.getElementById('page-dashboard');
  if (!dashboard || !dashboard.classList.contains('active')) return;

  var cta = document.createElement('div');
  cta.id = 'dashboard-trial-cta';
  cta.style.cssText = 'background:linear-gradient(135deg,rgba(0,200,150,0.15),rgba(99,102,241,0.15));border:1px solid rgba(0,200,150,0.3);border-radius:12px;padding:1rem 1.25rem;margin-bottom:1rem;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;';
  cta.innerHTML =
    '<div><p style="font-weight:700;font-size:0.9rem;margin-bottom:2px;">🎁 Try Pro Free for 7 Days</p>' +
    '<p style="font-size:0.78rem;color:var(--muted,#999);">AI Tutor, Turbo 4×, Unlimited Quizzes, AI Insights — no card needed</p></div>' +
    '<button onclick="try{ezStartProTrial();}catch(e){showToast(\'Error starting trial\',\'error\');}" style="padding:8px 18px;border-radius:8px;border:none;background:var(--accent,#00C896);color:#fff;font-weight:700;font-size:0.85rem;cursor:pointer;white-space:nowrap;">Start Free Trial →</button>';

  var firstChild = dashboard.querySelector('.dashboard-content, .dash-grid, .page-content, .dashboard-grid');
  if (firstChild) firstChild.prepend(cta);
  else dashboard.prepend(cta);
}

/* ── 7. ENHANCED TRIAL WATCHDOG ──
   Day-based UI: welcome modal on day 7, reminder banner on day 5–3,
   ending modal + banner on day 2–1, ended modal on day 0. The existing
   watchdog above (the one with `checkExpiry`) handles entitlement flips
   (Pro ↔ free); this one handles DAILY UI nudges. They are independent
   and additive — the existing one runs every 30s, this one runs every
   60s and on visibility/focus. */
(function () {
  var _lastTrialDayShown = null;

  function enhancedTrialCheck() {
    if (typeof currentUser === 'undefined' || !currentUser) return;
    if (typeof EZ_PROFILE === 'undefined' || EZ_PROFILE === null) return;
    if (typeof ezIsProTrialActive !== 'function' || !ezIsProTrialActive()) {
      // Trial just expired (we were showing day N, now it's day 0) —
      // fire the ended modal once.
      if (_lastTrialDayShown !== null && _lastTrialDayShown > 0) {
        _lastTrialDayShown = 0;
        try { ezShowTrialEndedModal(); } catch(e) {}
        var banner = document.getElementById('trial-reminder-banner');
        if (banner) banner.remove();
      }
      return;
    }
    var daysLeft = (typeof ezProTrialDaysLeft === 'function') ? ezProTrialDaysLeft() : 0;
    if (daysLeft === _lastTrialDayShown) return; // already shown for this day
    _lastTrialDayShown = daysLeft;
    // Day 7 (just started): welcome modal
    if (daysLeft === 7) {
      try { ezShowTrialWelcomeModal(); } catch(e) {}
    }
    // Day 5–3: reminder banner only
    else if (daysLeft <= 5 && daysLeft >= 3) {
      try { ezShowTrialReminderBanner(daysLeft); } catch(e) {}
    }
    // Day 2–1: banner + ending modal
    else if (daysLeft <= 2 && daysLeft >= 1) {
      try { ezShowTrialReminderBanner(daysLeft); } catch(e) {}
      try { ezShowTrialEndingModal(daysLeft); } catch(e) {}
    }
  }

  // Run on load + every 60s + on visibility/focus.
  if (window.addEventListener) {
    window.addEventListener('load', function () { setTimeout(enhancedTrialCheck, 3000); });
    setInterval(enhancedTrialCheck, 60 * 1000);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') setTimeout(enhancedTrialCheck, 500);
    });
    window.addEventListener('focus', function () { setTimeout(enhancedTrialCheck, 500); });
  }

  // Show dashboard CTA whenever the dashboard becomes active.
  if (typeof onPageActivated === 'function') {
    onPageActivated('dashboard', function () { setTimeout(ezShowDashboardTrialCTA, 300); });
  }
})();

/* ── 8. OVERRIDE ezStartProTrial TO ALSO SHOW WELCOME MODAL ──
   The original function still runs (toast + plan stamp + gate refresh);
   we just queue the welcome modal 500ms later so it doesn't fight the
   upgrade modal close animation. */
(function () {
  var _origStartTrial = ezStartProTrial;
  ezStartProTrial = async function () {
    await _origStartTrial();
    if (typeof ezIsProTrialActive === 'function' && ezIsProTrialActive()) {
      setTimeout(function() {
        try { ezShowTrialWelcomeModal(); } catch(e) {}
      }, 500);
    }
  };
})();

/* Adopt a still-active trial created by the previous client-only flow. The
   backend validates its original bounds and stamps the immutable profile
   marker without extending the expiry. */
(function () {
  var attempts = 0;
  function adoptLegacyTrial() {
    attempts += 1;
    if (!currentUser || typeof EZ_PROFILE === 'undefined' || EZ_PROFILE === null) {
      if (attempts < 12) setTimeout(adoptLegacyTrial, 1000);
      return;
    }
    var trial = appState && appState.proTrial;
    var active = trial && trial.startedAt && /^\d{4}-\d{2}-\d{2}$/.test(String(trial.expiry || ''))
      && new Date(trial.expiry + 'T23:59:59').getTime() >= Date.now();
    if (active && !EZ_PROFILE.proTrialUsed) {
      Promise.resolve(ezStartProTrial()).catch(function() {});
    }
  }
  window.addEventListener('load', function() { setTimeout(adoptLegacyTrial, 2500); });
})();

/* ── 9. TRIAL ANALYTICS (admin-facing) ──
   Best-effort: mirror the local usage counters to Firestore under
   `users/{uid}.profile.trialUsage` so the admin dashboard can compute
   trial→paid conversion + feature-engagement stats. We stamp on every
   track call (throttled naturally by the cadence of feature usage).
   Silently fails if Firestore rules disallow the write. */
(function () {
  var _origTrack = ezTrialTrack;
  ezTrialTrack = function (feature) {
    _origTrack(feature);
    try {
      if (typeof _fbReady !== 'undefined' && _fbReady &&
          typeof db !== 'undefined' && db &&
          typeof currentUser !== 'undefined' && currentUser && currentUser.uid &&
          appState && appState.proTrial) {
        db.collection('users').doc(currentUser.uid).update({
          'profile.trialUsage': appState.proTrial.usage || {},
          'profile.trialLastTrackedFeature': feature,
          'profile.trialLastTrackedAt': firebase.firestore.FieldValue.serverTimestamp()
        }).catch(function () { /* ignore permission errors */ });
      }
    } catch (e) { /* ignore */ }
  };
})();


