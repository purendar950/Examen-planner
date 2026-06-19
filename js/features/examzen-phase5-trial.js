/* ══════════════════════════════════════════════
   EXAMZEN PHASE 5 — 7-DAY TRIAL, WEEKLY/MONTHLY GATING, PDF EXPORT
   NOTE: the 3-day trial is stored in appState.proTrial because Firestore
   rules make profile.trialExpiry admin-only. appState is user-writable and
   syncs via saveProgress().
══════════════════════════════════════════════ */

/* ── Self-serve 3-day Pro trial (stored in appState) ── */
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
  // FIX (Bug 3): Tamper guard — the trial expiry stored in user-writable
  // appState/localStorage must not exceed 4 days from startedAt.
  // If a user manually edits localStorage to extend their trial, we deny access.
  if (appState && appState.proTrial && appState.proTrial.startedAt) {
    var startedAt = new Date(appState.proTrial.startedAt);
    var maxAllowedExpiry = new Date(startedAt.getTime() + 4 * 86400000); // 3 days + 1 grace
    var claimedExpiry = new Date(exp + 'T23:59:59');
    if (claimedExpiry > maxAllowedExpiry) return false; // Tampered expiry — deny
  }
  return new Date(exp + 'T23:59:59') >= new Date();
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
function ezStartProTrial() {
  if (!currentUser) { showToast('Pehle account banao/login karo.', 'error'); return; }
  // Once per account: don't grant until we authoritatively know this account's
  // trial history. If the profile/appState hasn't loaded yet (offline, mid-load
  // or a cleared cache), granting now could RESET a trial the account already
  // used. EZ_PROFILE is null only during that load window, so wait for it.
  if (typeof EZ_PROFILE === 'undefined' || EZ_PROFILE === null) {
    showToast('Profile load ho raha hai — ek second baad try karo.', 'info'); return;
  }
  if (ezProTrialUsed()) { showToast('Free trial pehle hi use ho chuka hai — ek account pe ek hi baar milta hai.', 'error'); return; }
  if (typeof ezIsPro === 'function' && ezIsPro()) { showToast('Aap already Pro ho 🎉', 'info'); return; }
  var today = new Date();
  var exp = new Date(today.getTime() + 3 * 86400000);
  appState.proTrial = { startedAt: today.toISOString(), expiry: exp.toISOString().slice(0, 10), days: 3 };
  appState.proTrialUsed = true; // durable flag — survives even if proTrial obj is cleared
  try { saveProgress(); } catch(e) {}
  // Best-effort: also stamp the profile doc so the "used" marker survives an
  // appState reset/clear on another device. Silently ignored if Firestore
  // rules disallow the profile write — the appState flag still enforces it.
  try {
    if (_fbReady && db && currentUser && currentUser.uid) {
      db.collection('users').doc(currentUser.uid)
        .update({ 'profile.proTrialUsed': true, 'profile.proTrialStartedAt': appState.proTrial.startedAt })
        .catch(function() {});
    }
  } catch(e) {}
  showToast('🎉 3-din ka Pro trial shuru! Saare Pro features unlock.', 'success');
  try { var ov = document.getElementById('ez-upgrade-overlay'); if (ov) ov.classList.remove('open'); } catch(e) {}
  // FIX 8: Use ezRefreshGates() instead of calling individual lock functions —
  // it re-applies ALL gates, re-renders the active page, and updates the plan badge.
  try { if (typeof ezRefreshGates === 'function') ezRefreshGates(); } catch(e) {}
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
  /* Refresh the plan badge in the top bar (Upgrade vs 💎 Plan). */
  try { if (typeof ezRenderPlanBadge === 'function') ezRenderPlanBadge(); } catch(e) {}
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
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + (title || 'ExamZen Export') + '</title>' +
    '<style>body{font-family:Inter,Arial,sans-serif;color:#16202E;padding:24px;line-height:1.6;}' +
    'h1{font-size:1.3rem;margin-bottom:4px;}h2{font-size:1rem;margin:18px 0 6px;}' +
    '.muted{color:#64748B;font-size:.85rem;margin-bottom:16px;}' +
    'table{width:100%;border-collapse:collapse;font-size:.85rem;}td,th{border:1px solid #E3E8EF;padding:6px 8px;text-align:left;}' +
    'ul{margin:0 0 12px 18px;}@media print{button{display:none;}}</style></head><body>' +
    '<h1>' + (title || 'ExamZen Export') + '</h1>' +
    '<div class="muted">ExamZen — ' + new Date().toLocaleString('en-IN') + '</div>' +
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

