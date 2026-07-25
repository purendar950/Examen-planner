/* ══════════════════════════════════════════════
   PREPPATH PHASE 4 — FREE/PRO GATING + THEME TOGGLE
══════════════════════════════════════════════ */
/* REQUEST NEW OPTION - users can suggest features/content/exams */
(function() {
  var s = document.createElement('style');
  s.textContent = '#ez-req-fab{cursor:pointer;border-radius:99px;padding:5px 12px;font-size:0.72rem;font-weight:700;border:1px solid rgba(0,200,150,0.35);background:rgba(0,200,150,0.08);color:var(--accent);white-space:nowrap;font-family:var(--font);}#ez-req-fab:hover{background:var(--accent);color:#000;}#ez-req-overlay{position:fixed;inset:0;z-index:200000;background:rgba(0,0,0,0.6);display:none;align-items:center;justify-content:center;padding:1rem;}#ez-req-overlay.open{display:flex;}#ez-req-modal{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:1.75rem 1.5rem;width:100%;max-width:460px;position:relative;box-shadow:0 24px 60px rgba(0,0,0,0.45);}.req-type-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:1rem;}.req-type-btn{padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--muted);font-size:0.78rem;cursor:pointer;text-align:center;font-family:var(--font);font-weight:500;}.req-type-btn.active,.req-type-btn:hover{border-color:var(--accent);color:var(--accent);background:rgba(0,200,150,0.08);}#ez-req-detail{width:100%;min-height:90px;padding:0.65rem;background:var(--surface);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:0.875rem;resize:vertical;outline:none;font-family:var(--font);margin-bottom:0.85rem;}#ez-req-detail:focus{border-color:var(--accent);}#ez-req-submit{width:100%;padding:0.78rem;background:var(--accent);color:#000;border:none;border-radius:8px;font-weight:700;font-size:0.92rem;cursor:pointer;font-family:var(--font);}#ez-req-submit:disabled{opacity:0.55;cursor:not-allowed;}#ez-req-cancel{width:100%;padding:0.65rem;background:transparent;color:var(--muted);border:1px solid var(--border);border-radius:8px;font-weight:600;font-size:0.85rem;cursor:pointer;font-family:var(--font);margin-top:8px;}';
  document.head.appendChild(s);
  var RTYPES=[{id:'feature',label:'New Feature'},{id:'exam',label:'Add New Exam'},{id:'chapter',label:'Add Chapter/Topic'},{id:'youtube',label:'YouTube Resource'},{id:'bug',label:'Bug Report'},{id:'other',label:'Other'}];
  var selType='';
  function buildModal(){
    var old=document.getElementById('ez-req-overlay');if(old)old.remove();
    var ov=document.createElement('div');ov.id='ez-req-overlay';
    ov.onclick=function(e){if(e.target===ov)window.closeReq();};
    var btns=RTYPES.map(function(t){return '<button class="req-type-btn" onclick="ezPickReqType(\'' + t.id + '\',this)">'+t.label+'</button>';}).join('');
    ov.innerHTML='<div id="ez-req-modal"><button onclick="closeReq()" style="position:absolute;top:14px;right:14px;background:none;border:none;color:var(--muted);cursor:pointer;font-size:1.1rem;">&#x2715;</button><h3 style="font-size:1rem;margin-bottom:0.35rem;">&#128161; Request a New Option</h3><p style="font-size:0.78rem;color:var(--muted);margin-bottom:1.25rem;">Koi feature, exam, chapter ya suggestion chahiye? Bolo hame!</p><div id="ez-req-body"><div class="req-type-grid">'+btns+'</div><textarea id="ez-req-detail" placeholder="Detail mein describe karo..."></textarea><button id="ez-req-submit" onclick="ezSubmitRequest()">&#128640; Submit Request</button><button id="ez-req-cancel" onclick="closeReq()">Cancel</button></div></div>';
    document.body.appendChild(ov);
  }
  window.openReqModal=function(){
    if(typeof currentUser==='undefined'||!currentUser){showToast('Pehle login karo.','error');return;}
    selType='';buildModal();
    document.getElementById('ez-req-overlay').classList.add('open');
    document.body.style.overflow='hidden';
  };
  window.closeReq=function(){var ov=document.getElementById('ez-req-overlay');if(ov)ov.classList.remove('open');document.body.style.overflow='';};
  window.ezPickReqType=function(type,el){selType=type;document.querySelectorAll('.req-type-btn').forEach(function(b){b.classList.remove('active');});if(el)el.classList.add('active');};
  window.ezSubmitRequest=async function(){
    if(!selType){showToast('Type choose karo pehle.','error');return;}
    var detail=(document.getElementById('ez-req-detail').value||'').trim();
    if(!detail||detail.length<10){showToast('Thoda detail mein describe karo (min. 10 chars).','error');return;}
    var btn=document.getElementById('ez-req-submit');if(btn){btn.disabled=true;btn.textContent='Submitting...';}
    try{
      var ts=(typeof _fbReady!=='undefined'&&_fbReady&&typeof firebase!=='undefined')?firebase.firestore.FieldValue.serverTimestamp():new Date().toISOString();
      var payload={uid:currentUser.uid,email:currentUser.email,name:currentUser.name||'',type:selType,detail:detail,status:'new',createdAt:ts};
      if(typeof _fbReady!=='undefined'&&_fbReady&&typeof db!=='undefined'&&db){await db.collection('requests').add(payload);}
      else{var reqs=JSON.parse(localStorage.getItem('ez_requests')||'[]');reqs.push(payload);localStorage.setItem('ez_requests',JSON.stringify(reqs));}
      var body=document.getElementById('ez-req-body');
      if(body)body.innerHTML='<div style="text-align:center;padding:1.5rem 0;"><div style="font-size:2.5rem;margin-bottom:10px;">&#127881;</div><div style="font-weight:800;margin-bottom:6px;">Request Submitted!</div><div style="font-size:0.82rem;color:var(--muted);line-height:1.65;margin-bottom:1.25rem;">Shukriya! Admin review karega.</div><button onclick="closeReq()" style="background:var(--accent);color:#000;border:none;border-radius:8px;padding:0.7rem 1.6rem;font-weight:700;cursor:pointer;">Close</button></div>';
      showToast('Request submitted!','success');
    }catch(e){showToast('Submit failed: '+(e.message||e),'error');if(btn){btn.disabled=false;btn.textContent='Submit Request';}}
  };
  window.addEventListener('load',function(){
    setTimeout(function(){
      if(document.getElementById('ez-req-fab'))return;
      var right=document.querySelector('.topbar-right');if(!right)return;
      var fab=document.createElement('button');fab.id='ez-req-fab';
      fab.innerHTML='&#128161; Request';fab.title='Request a new feature, exam or content';
      fab.onclick=window.openReqModal;
      right.insertBefore(fab,right.firstChild);
    },350);
  });
})();

let EZ_FREE_LIMITS = {
  mocks: 5,                // total mock saves (keep) — global cap so free users still see value in saving
  mocksPerDay: 3,          // NEW: daily cap on NEW mock saves (was unlimited) — creates daily habit
  mediaSaves: 3,           // CHANGED: 2 → 3 playlists/links (more generous)
  notes: 10,               // keep
  aiTutorPerDay: 5,        // NEW: AI Tutor messages/day — let them experience AI value
  aiTimetablePerWeek: 1,   // NEW: AI timetable generations/week — let them taste the magic
  telegramMorning: true,   // NEW: free gets morning plan
  telegramEvening: false   // NEW: evening check-in + weekly report is Pro
}; // loaded from Firestore config/free

function ezGetTrialDaysLeft() {
  if (!EZ_PROFILE || !EZ_PROFILE.trialExpiry) return 0;
  const expiry = new Date(EZ_PROFILE.trialExpiry + 'T23:59:59');
  const today = new Date();
  return Math.max(0, Math.ceil((expiry - today) / 86400000));
}

function ezIsTrialActive() {
  if (EZ_PROFILE === null) return false; // profile not loaded yet
  if (EZ_PROFILE.trialSuspended) return false;
  return ezGetTrialDaysLeft() > 0;
}

/* Client-side Pro/trial gate. The two server-side jobs (bot/bot-server.js
   and scripts/send-telegram.js) run the SAME rules via shared/proGating.js
   (Node/CommonJS, can't be imported into this classic <script> file). If you
   change the rules here, mirror the change in shared/proGating.js too. */
function ezIsPro() {
  // App data may render from a UID-keyed local cache, but paid access remains
  // closed until Firestore confirms this exact account from the server.
  if (currentUser && window._ezEntitlementPendingUid === currentUser.uid) return false;
  if (_ezIsAdminCache === true) return true; // admin = always pro
  if (!EZ_PROFILE) return false;
  const today = new Date().toISOString().slice(0, 10);
  // FIX (Bug 3): Strict plan expiry check — an expired plan must NOT grant Pro access.
  // planExpiry is a YYYY-MM-DD string; compare as string (ISO date sort = lexicographic sort).
  // FIX 4: Plans without a planExpiry are ONLY active if they are 'lifetime' plans.
  //        Any other plan (monthly/quarterly/annual) requires a valid non-expired planExpiry.
  //        This prevents admin accidentally setting plan='pro' with no expiry date, giving
  //        the user permanent free Pro access.
  const planName = EZ_PROFILE.plan || 'free';
  const isLifetime = planName.toLowerCase().includes('lifetime');
  const planActive = !!(planName && planName !== 'free' && (
    isLifetime
      ? true                                          // lifetime: no expiry needed
      : (EZ_PROFILE.planExpiry && EZ_PROFILE.planExpiry >= today)  // others: must have valid expiry
  ));
  // FIX (Bug 3): Also check admin-granted trial from EZ_PROFILE (separate from self-serve trial).
  // If admin set trialExpiry AND it has not expired, it counts as Pro.
  const adminTrialActive = !!(EZ_PROFILE.trialExpiry &&
    !EZ_PROFILE.trialSuspended &&
    EZ_PROFILE.trialExpiry >= today);
  return !!(planActive || adminTrialActive || ezIsTrialActive());
}
/* Gating applies only to real logged-in free users */
// FIX 6: ezGated() returns true (gated/restricted) for any logged-in user
// who is NOT on an active Pro plan or trial.
// When EZ_PROFILE is null (still loading from Firestore), ezIsPro() returns false
// → ezGated() returns true → gates are CLOSED by default until plan data arrives.
// This is the correct fail-safe: deny Pro features until we've confirmed Pro status.
// ezLoadProfile() calls ezRefreshGates() once EZ_PROFILE loads, which opens gates
// for users who actually have a valid Pro plan/trial.
function ezGated() { return !!(currentUser && !ezIsPro()); }
function ezLockedMsg(feature) {
  if (typeof ezEntitlementDisplayPending === 'function' ? ezEntitlementDisplayPending() : EZ_PROFILE === null) {
    showToast('Aapka plan check ho raha hai — connection milte hi access update ho jayega.', 'info');
    try { ezLoadProfile(); } catch(e) {}
    return;
  }
  showToast('💎 ' + feature + ' — Pro plan mein milta hai.', 'error');
  setTimeout(ezOpenUpgrade, 600);
}

/* 1. Multi-exam switching
   FIX: free users may switch exams freely so they can VIEW any exam's
   Syllabus / Exam Pattern. Switching no longer shows an upgrade popup.
   Pro is still enforced per-feature on non-target exams:
     - marking/bookmark/difficulty/notes  -> ezCanEditSyllabus() (read-only)
     - planner week/month/3-month views   -> Pro-gated
     - mock saves (global cap) + analysis -> Pro
     - AI timetable                       -> Pro */
const _switchExamGate = switchExam;
switchExam = function(examId) {
  _switchExamGate(examId);
  // FIX 3: Re-apply syllabus lock UI after exam switch with a slightly longer
  // delay (200ms) so it runs AFTER buildSyllabus()'s own 80ms timeout and
  // after the DOM is fully rendered. This ensures free users switching to a
  // non-target exam always see the locked checkboxes, even on slow connections
  // where EZ_PROFILE may have been null during the 80ms timeout inside buildSyllabus().
  setTimeout(function() {
    try { ezApplySyllabusLockUI(); } catch(e) {}
  }, 200);
};
function ezApplyExamLock() {
  // No exam button is locked anymore (viewing every exam is free). Just
  // clear any leftover dimming/tooltips from sessions cached before this fix.
  document.querySelectorAll('.exam-select-btn').forEach(b => { b.style.opacity = ''; b.title = ''; });
}

/* 2. Mock saves → max 5 free (existing saves never deleted, only new blocked)
   ADDED (free-tier-hook): free users can only SAVE up to 3 NEW mocks per day
   (in addition to the global 5 cap). Daily counter resets at midnight local.
   Pro/trial users skip both checks. */
const _mockSaveGate = mockSave;
mockSave = function() {
  if (ezGated() && !mockEditId) {
    // Global cap first
    let count = 0;
    const mk = appState.mocks || {};
    Object.keys(mk).forEach(ex => Object.keys(mk[ex] || {}).forEach(tk => { count += (mk[ex][tk] || []).length; }));
    if (count >= EZ_FREE_LIMITS.mocks) { ezLockedMsg('Free plan: max ' + EZ_FREE_LIMITS.mocks + ' mock saves. Unlimited saves'); return; }
    // NEW: per-day cap (only on new saves, not edits)
    const today = new Date().toISOString().split('T')[0];
    const dayKey = 'sp_mock_saves_' + today;
    const dayCount = parseInt(localStorage.getItem(dayKey) || '0', 10);
    const maxPerDay = EZ_FREE_LIMITS.mocksPerDay || 3;
    if (dayCount >= maxPerDay) {
      ezLockedMsg('Free plan: max ' + maxPerDay + ' mock saves/day. Pro: unlimited saves');
      return;
    }
    try { localStorage.setItem(dayKey, String(dayCount + 1)); } catch(e) {}
  }
  _mockSaveGate();
};

/* 3. Mock analysis → Free gets BASIC (score + correct/wrong + per-mock summary),
   Pro gets FULL (trends, weak areas, percentile, charts).
   CHANGED (free-tier-hook): instead of blurring the entire analysis, we let
   the basic score card render fully and only blur the ADVANCED sections
   (.trend-chart, .weak-topics, .percentile-section). Free users SEE the value
   of the analysis, then get nudged to upgrade for the deep insights. */
const _mockAnalysisGate = mockRenderAnalysis;
mockRenderAnalysis = function() {
  _mockAnalysisGate();
  if (!ezGated()) return; // Pro: full analysis, no overlay

  const el = document.getElementById('mock-analysis');
  if (!el || !el.innerHTML.trim()) return;

  // Free users: show basic score but blur advanced charts
  const advancedSections = el.querySelectorAll('.trend-chart, .weak-topics, .percentile-section, [data-pro="advanced"]');
  advancedSections.forEach(function (section) {
    if (section.querySelector('.pro-blur-overlay')) return; // already wrapped
    section.style.position = 'relative';
    const ov = document.createElement('div');
    ov.className = 'pro-blur-overlay';
    ov.style.cssText = 'position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;background:rgba(0,0,0,0.45);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border-radius:12px;text-align:center;padding:1rem;';
    ov.innerHTML = '<div style="font-size:1.5rem;">💎</div>' +
      '<div style="font-size:0.75rem;color:rgba(255,255,255,0.8);max-width:240px;">Trends, weak areas & percentile — Pro</div>' +
      '<button class="btn-modal-save" style="font-size:0.75rem;padding:6px 14px;" onclick="ezOpenUpgrade()">Upgrade</button>';
    section.appendChild(ov);
  });
};

/* 4. AI Timetable → Free gets 1 generation/week; Pro gets unlimited + auto-reschedule.
   CHANGED (free-tier-hook): was fully Pro, now free users can generate the
   timetable ONCE per ISO week. The counter resets every Monday (ISO week
   boundary). Pro users skip the check. */
const _genTimetableGate = generateTimetable;
generateTimetable = function() {
  if (ezGated()) {
    const weekKey = 'sp_timetable_week_' + ezIsoWeekKey();
    const count = parseInt(localStorage.getItem(weekKey) || '0', 10);
    const maxFree = EZ_FREE_LIMITS.aiTimetablePerWeek || 1;

    if (count >= maxFree) {
      const c = document.getElementById('timetable-container');
      if (c) c.innerHTML = '<div class="info-card" style="text-align:center;">' +
        '<div style="font-size:2.2rem;">💎</div>' +
        '<div style="font-weight:800;margin:6px 0;">AI Timetable — Weekly limit reached</div>' +
        '<div style="font-size:0.8rem;color:var(--muted);">Free plan: ' + maxFree + ' generation/week. Pro: unlimited + auto-reschedule on missed days.</div>' +
        '<button class="btn-modal-save" style="margin-top:12px;" onclick="ezOpenUpgrade()">💎 Upgrade to Pro</button></div>';
      return;
    }
    try { localStorage.setItem(weekKey, String(count + 1)); } catch(e) {}
  }
  _genTimetableGate();
};

/* ISO-week helper used by the AI Timetable gate. Returns e.g. "2026_W30".
   Using ISO 8601 week numbering so all users hit the same boundary. */
function ezIsoWeekKey() {
  const d = new Date();
  // Copy date so don't modify original
  const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  // Thursday in current week decides the year
  const dayNum = (target.getUTCDay() + 6) % 7; // Mon=0, Sun=6
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((target - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return target.getUTCFullYear() + '_W' + (week < 10 ? '0' + week : week);
}

/* 5. Playlist Organiser courses → configurable free limit; Pro/trial users can save up to 20 */
const _ytoLoadGate = ytoLoadPlaylist;
ytoLoadPlaylist = async function() {
  const url = (document.getElementById('yto-url-input') || { value: '' }).value.trim();
  const plId = ytExtractPlaylistId(url);
  const lib = ytoLib();
  const existing = plId && lib[plId];
  const maxSaved = ezIsPro() ? 20 : EZ_FREE_LIMITS.mediaSaves;
  if (currentUser && !existing && Object.keys(lib).length >= maxSaved) {
    if (ezIsPro()) showToast('Pro users max 20 playlists/videos save kar sakte hain. Admin panel se user limit manage karein.', 'error');
    else ezLockedMsg('Free plan: sirf ' + EZ_FREE_LIMITS.mediaSaves + ' playlists/videos save. Pro mein 20 tak save kar sakte ho');
    return;
  }
  return _ytoLoadGate();
};

/* 6. Chapter video links → configurable free limit; Pro/trial users can save up to 10 */
const _chLinkSaveGate = chLinkSave;
chLinkSave = function() {
  if (!appState.ytLinks) appState.ytLinks = {};
  const existing = chLinkCurrentId && appState.ytLinks[chLinkCurrentId];
  const maxLinks = ezIsPro() ? 10 : EZ_FREE_LIMITS.mediaSaves;
  if (currentUser && !existing && Object.keys(appState.ytLinks).length >= maxLinks) {
    chLinkClose();
    if (ezIsPro()) showToast('Pro users max 10 chapter video links save kar sakte hain. Admin panel se user limit manage karein.', 'error');
    else ezLockedMsg('Free plan: sirf ' + EZ_FREE_LIMITS.mediaSaves + ' chapter video links. Pro mein 10 tak save kar sakte ho');
    return;
  }
  _chLinkSaveGate();
};

/* 7. Video notes → max 10 free */
const _ytSaveNoteGate = ytSaveNote;
ytSaveNote = function() {
  if (ezGated() && ytNotes.length >= EZ_FREE_LIMITS.notes) {
    ezLockedMsg('Free plan: max ' + EZ_FREE_LIMITS.notes + ' video notes. Unlimited notes');
    return;
  }
  _ytSaveNoteGate();
};

/* 8. Daily Telegram auto-send → Free gets MORNING only; Pro gets morning + evening + weekly report.
   CHANGED (free-tier-hook): free users can now enable Telegram (morning plan only).
   The actual sending still re-checks plan status server-side in scripts/send-telegram.js.
   If/when an evening toggle is added to the UI (#tg-evening-enabled), it stays Pro-gated. */
function ezApplyTelegramLock() {
  const badge = document.getElementById('tg-pro-badge');
  if (!badge) return;
  // While entitlement is unresolved, keep the Pro badge hidden instead of
  // presenting a cached Free result as authoritative.
  if (typeof ezEntitlementDisplayPending === 'function' ? ezEntitlementDisplayPending() : EZ_PROFILE === null) { badge.style.display = 'none'; return; }
  // Morning plan is free for all logged-in users — hide the Pro badge
  badge.style.display = 'none';

  // If the UI ever adds an evening toggle, lock it for free users with a 💎 Pro pill
  const eveningToggle = document.getElementById('tg-evening-enabled');
  if (eveningToggle && ezGated()) {
    eveningToggle.disabled = true;
    eveningToggle.title = 'Evening check-in — Pro feature';
    if (!eveningToggle.parentElement.querySelector('.tg-pro-lock')) {
      const lock = document.createElement('span');
      lock.className = 'tg-pro-lock';
      lock.style.cssText = 'font-size:0.7rem;color:var(--accent);margin-left:6px;font-weight:700;';
      lock.textContent = '💎 Pro';
      eveningToggle.parentElement.appendChild(lock);
    }
  }
}
const _saveTelegramGate = saveTelegramSettings;
saveTelegramSettings = function() {
  const eveningEl = document.getElementById('tg-evening-enabled');
  // If a free user somehow has evening enabled (e.g. old cached UI), force it off and nudge
  if (ezGated() && eveningEl && eveningEl.checked) {
    eveningEl.checked = false;
    ezLockedMsg('Evening Telegram check-in + Weekly report');
    return;
  }
  // Morning is free for everyone — let the original save handler run
  _saveTelegramGate();
};

/* ─────────────────────────────────────────────────────────────
   free-tier-hook: NEW GATES (10–14)
   These gate previously-ungated Pro features so the upgrade nudge
   has a clear, visible place. Each gate:
     - lets the function run unmodified for Pro/trial users
     - shows a soft "💎 Pro feature" toast + opens upgrade modal for free users
     - is fail-open if the function doesn't exist yet (early-load guard)
   ───────────────────────────────────────────────────────────── */

/* 10. AI Tutor messages → max 5/day free (was ungated).
   Wraps `sendTutor` from js/features/ai-tutor.js (the function the
   chat Send button + the suggestion chips call). */
function ezShowTutorLimitPreview(maxFree) {
  const el = document.getElementById('tutor-chat') ||
             document.getElementById('ai-tutor-messages') ||
             document.querySelector('.tutor-messages');
  if (el) {
    ezBlurPreview(el, {
      title: 'AI Tutor — Daily Limit Reached',
      desc: 'Free plan: ' + maxFree + ' AI messages/day. Pro: unlimited AI Tutor with priority responses.',
      height: 'md', icon: '🤖', previewType: 'aitutor'
    });
  } else {
    ezLockedMsg('Free plan: max ' + maxFree + ' AI messages/day. Pro: unlimited AI Tutor');
  }
}
const _aiTutorSendGate = typeof sendTutor === 'function' ? sendTutor : null;
if (_aiTutorSendGate) {
  sendTutor = function() {
    if (ezGated()) {
      const today = new Date().toISOString().split('T')[0];
      const key = 'sp_ai_tutor_' + today;
      const count = parseInt(localStorage.getItem(key) || '0', 10);
      const maxFree = EZ_FREE_LIMITS.aiTutorPerDay || 5;
      if (count >= maxFree) {
        ezShowTutorLimitPreview(maxFree);
        return;
      }
      try { localStorage.setItem(key, String(count + 1)); } catch(e) {}
    }
    return _aiTutorSendGate.apply(this, arguments);
  };
}

/* 11. Turbo 4× Player → Pro only.
   Wraps `ytToggleTurbo` from js/features/turbo-player.js. The function
   already shows its own ezLockedMsg, but we replace it with our
   hook so the upgrade modal opens after the toast. */
const _turboPlayGate = typeof ytToggleTurbo === 'function' ? ytToggleTurbo : null;
if (_turboPlayGate) {
  ytToggleTurbo = function() {
    if (ezGated()) {
      ezLockedMsg('Turbo 4× Player — watch lectures 4× faster');
      return;
    }
    _turboPlayGate.apply(this, arguments);
  };
}

/* 12. AI Study Insights → Pro only.
   Wraps `aiGetSmartInsights` from js/tabs/planner-ai-insights.js. */
const _aiInsightsGate = typeof aiGetSmartInsights === 'function' ? aiGetSmartInsights : null;
if (_aiInsightsGate) {
  aiGetSmartInsights = function() {
    if (ezGated()) {
      const el = document.getElementById('ai-insights-container') ||
                 document.querySelector('[data-tab="ai-insights"]');
      if (el) {
        el.innerHTML = '<div style="text-align:center;padding:2rem;">' +
          '<div style="font-size:2.2rem;">💎</div>' +
          '<div style="font-weight:800;margin:8px 0;">AI Study Insights — Pro feature</div>' +
          '<div style="font-size:0.8rem;color:var(--muted);max-width:300px;margin:0 auto;">' +
          'Weak topics, score predictions, study recommendations — Pro plan mein milta hai.</div>' +
          '<button class="btn-modal-save" style="margin-top:12px;" onclick="ezOpenUpgrade()">💎 Upgrade to Pro</button>' +
          '</div>';
      }
      return null;
    }
    return _aiInsightsGate.apply(this, arguments);
  };
}

/* 13. Spaced Repetition / Revision queue → Pro only.
   Wraps `renderRevisionQueue` from js/tabs/revision.js. */
const _revisionGate = typeof renderRevisionQueue === 'function' ? renderRevisionQueue : null;
if (_revisionGate) {
  renderRevisionQueue = function() {
    if (ezGated()) {
      const el = document.getElementById('revision-container') ||
                 document.getElementById('revision-queue') ||
                 document.querySelector('[data-tab="revision"]');
      if (el) {
        el.innerHTML = '<div style="text-align:center;padding:2rem;">' +
          '<div style="font-size:2.2rem;">💎</div>' +
          '<div style="font-weight:800;margin:8px 0;">Spaced Repetition — Pro feature</div>' +
          '<div style="font-size:0.8rem;color:var(--muted);max-width:300px;margin:0 auto;">' +
          'Auto-scheduled revision at Day 1, 3, 7, 14, 30 based on the forgetting curve. Pro plan mein milta hai.</div>' +
          '<button class="btn-modal-save" style="margin-top:12px;" onclick="ezOpenUpgrade()">💎 Upgrade to Pro</button>' +
          '</div>';
      }
      return;
    }
    _revisionGate.apply(this, arguments);
  };
}

/* 9. FIX: this used to lock free users to the Syllabus tab only — every
   other page (Dashboard, Exam Pattern, Planner, YouTube, Playlist
   Organiser, Revision, Mock Tests) was dimmed, blocked, and bounced back to
   Syllabus on click. That made every per-feature free allowance below (and
   in Phase 5) unreachable, since free users could never get to the pages
   those features live on — hence "no free features unlocked" for new
   users. Free users now get full page navigation; Free vs Pro is enforced
   per-feature instead, exactly like the rest of this file already does:
   mock save cap (#2), mock analysis charts (#3), AI timetable (#4), media
   saves cap (#5/#6), notes cap (#7), Telegram auto-send (#8), week/month
   planner view + PDF export (Phase 5), multi-exam switching (#1).
   ezApplyPageLock() is kept as a harmless style-reset for old cached
   sessions that still have tabs dimmed from before this fix. */
const EZ_PAGE_LABELS = {
  dashboard: 'Dashboard', 'exam-pattern': 'Exam Pattern', planner: 'Planner',
  youtube: 'YouTube', 'yt-organiser': 'Playlist Organiser', revision: 'Revision', mocks: 'Mock Tests'
};
function ezApplyPageLock() {
  // No pages are blocked anymore (see FIX note above) — just clear any
  // leftover dimmed styling from sessions cached before this fix.
  Object.keys(EZ_PAGE_LABELS).forEach(function(pid) {
    const tab = document.getElementById('nav-' + pid);
    if (!tab) return;
    tab.style.opacity = '';
    tab.title = '';
  });
}
onPageActivated('*', function () {
  // Free users can open every page; individual features enforce plan access.
  try { ezApplyPageLock(); } catch (e) {}
});

/* Apply exam lock after profile loads */
const _ezLoadProfileBase4 = ezLoadProfile;
ezLoadProfile = async function() {
  await _ezLoadProfileBase4();
  ezApplyExamLock();
  ezApplyTelegramLock();
  ezApplyPageLock();
};



/* ══════════════════════════════════════════════
   PRO FEATURE BLUR PREVIEW SYSTEM
   Shows actual content blurred with a Pro overlay
   instead of hard-locking it. User sees the value
   → wants to upgrade.
   ══════════════════════════════════════════════ */

/* Generate realistic fake preview content so the user
   sees what they'd get with Pro. Pure DOM string — no
   dependency on real data. */
function ezGeneratePreviewContent(previewType) {
  var previews = {
    insights:
      '<div style="padding:1rem;">' +
        '<div style="font-weight:700;margin-bottom:12px;">📊 Your AI Study Report</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">' +
          '<div style="background:var(--bg-secondary,#16213e);padding:12px;border-radius:8px;"><div style="font-size:1.2rem;font-weight:800;color:#ef4444;">Time & Work</div><div style="font-size:0.75rem;color:var(--muted,#999);">Weakest topic — 42% accuracy</div></div>' +
          '<div style="background:var(--bg-secondary,#16213e);padding:12px;border-radius:8px;"><div style="font-size:1.2rem;font-weight:800;color:#10b981;">Polity</div><div style="font-size:0.75rem;color:var(--muted,#999);">Strongest — 89% accuracy</div></div>' +
        '</div>' +
        '<div style="background:var(--bg-secondary,#16213e);padding:12px;border-radius:8px;">' +
          '<div style="font-weight:600;margin-bottom:6px;">🎯 Predicted Score: 142-156/200</div>' +
          '<div style="height:8px;background:var(--bg-primary,#0a0a0f);border-radius:4px;overflow:hidden;"><div style="height:100%;width:71%;background:linear-gradient(90deg,#6366f1,#a855f7);border-radius:4px;"></div></div>' +
          '<div style="font-size:0.75rem;color:var(--muted,#999);margin-top:4px;">Based on last 5 mock tests</div>' +
        '</div>' +
      '</div>',

    revision:
      '<div style="padding:1rem;">' +
        '<div style="font-weight:700;margin-bottom:12px;">🔁 Revision Schedule (Auto-generated)</div>' +
        '<div style="display:flex;flex-direction:column;gap:8px;">' +
          '<div style="display:flex;align-items:center;gap:10px;background:var(--bg-secondary,#16213e);padding:10px;border-radius:8px;"><span style="color:#ef4444;font-weight:700;">TODAY</span><span>Polity Ch.4 — Fundamental Rights (Day 7 review)</span></div>' +
          '<div style="display:flex;align-items:center;gap:10px;background:var(--bg-secondary,#16213e);padding:10px;border-radius:8px;"><span style="color:#f59e0b;font-weight:700;">Tomorrow</span><span>Arithmetic — Time & Work (Day 3 review)</span></div>' +
          '<div style="display:flex;align-items:center;gap:10px;background:var(--bg-secondary,#16213e);padding:10px;border-radius:8px;"><span style="color:#6366f1;font-weight:700;">Day 3</span><span>Geography — Indian Rivers (Day 14 review)</span></div>' +
          '<div style="display:flex;align-items:center;gap:10px;background:var(--bg-secondary,#16213e);padding:10px;border-radius:8px;"><span style="color:var(--muted,#999);font-weight:700;">Day 5</span><span>History — Mughal Era (Day 30 review)</span></div>' +
        '</div>' +
      '</div>',

    timetable:
      '<div style="padding:1rem;">' +
        '<div style="font-weight:700;margin-bottom:12px;">📅 AI-Generated Study Plan (This Week)</div>' +
        '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:6px;font-size:0.7rem;">' +
          '<div style="background:var(--bg-secondary,#16213e);padding:8px;border-radius:6px;text-align:center;"><div style="font-weight:700;">Mon</div><div style="margin-top:4px;">Polity<br>Ch.5</div><div style="color:#10b981;">2h</div></div>' +
          '<div style="background:var(--bg-secondary,#16213e);padding:8px;border-radius:6px;text-align:center;"><div style="font-weight:700;">Tue</div><div style="margin-top:4px;">Maths<br>T&W</div><div style="color:#10b981;">3h</div></div>' +
          '<div style="background:var(--bg-secondary,#16213e);padding:8px;border-radius:6px;text-align:center;"><div style="font-weight:700;">Wed</div><div style="margin-top:4px;">Geo<br>Rivers</div><div style="color:#10b981;">2h</div></div>' +
          '<div style="background:var(--bg-secondary,#16213e);padding:8px;border-radius:6px;text-align:center;"><div style="font-weight:700;">Thu</div><div style="margin-top:4px;">History<br>Mughal</div><div style="color:#10b981;">2h</div></div>' +
          '<div style="background:var(--bg-secondary,#16213e);padding:8px;border-radius:6px;text-align:center;"><div style="font-weight:700;">Fri</div><div style="margin-top:4px;">Mock<br>Test</div><div style="color:#f59e0b;">1.5h</div></div>' +
          '<div style="background:var(--bg-secondary,#16213e);padding:8px;border-radius:6px;text-align:center;"><div style="font-weight:700;">Sat</div><div style="margin-top:4px;">Revision<br>Week</div><div style="color:#6366f1;">3h</div></div>' +
          '<div style="background:var(--bg-secondary,#16213e);padding:8px;border-radius:6px;text-align:center;"><div style="font-weight:700;">Sun</div><div style="margin-top:4px;">Rest<br>+ Light</div><div style="color:var(--muted,#999);">1h</div></div>' +
        '</div>' +
      '</div>',

    turbo:
      '<div style="padding:1rem;text-align:center;">' +
        '<div style="font-size:3rem;margin-bottom:8px;">📺</div>' +
        '<div style="font-weight:700;margin-bottom:6px;">Turbo 4× Player</div>' +
        '<div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:12px;flex-wrap:wrap;">' +
          '<span style="background:var(--bg-secondary,#16213e);padding:4px 10px;border-radius:4px;font-size:0.8rem;">1×</span>' +
          '<span style="background:var(--bg-secondary,#16213e);padding:4px 10px;border-radius:4px;font-size:0.8rem;">1.5×</span>' +
          '<span style="background:var(--bg-secondary,#16213e);padding:4px 10px;border-radius:4px;font-size:0.8rem;">2×</span>' +
          '<span style="background:linear-gradient(135deg,#6366f1,#a855f7);padding:4px 10px;border-radius:4px;font-size:0.8rem;font-weight:700;color:#fff;">4× ⚡</span>' +
        '</div>' +
        '<div style="font-size:0.8rem;color:var(--muted,#999);">Watch a 2-hour lecture in just 30 minutes</div>' +
        '<div style="margin-top:8px;height:6px;background:var(--bg-secondary,#16213e);border-radius:3px;overflow:hidden;"><div style="height:100%;width:75%;background:linear-gradient(90deg,#6366f1,#a855f7);"></div></div>' +
        '<div style="font-size:0.7rem;color:var(--muted,#999);margin-top:4px;">1:30:00 / 2:00:00 at 4× speed</div>' +
      '</div>',

    weekly:
      '<div style="padding:1rem;">' +
        '<div style="font-weight:700;margin-bottom:12px;">📅 Weekly Overview — Week 23</div>' +
        '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px;">' +
          '<div style="background:rgba(16,185,129,0.15);padding:8px;border-radius:6px;text-align:center;font-size:0.7rem;"><div>Mon</div><div style="font-weight:700;color:#10b981;">4/5 ✓</div></div>' +
          '<div style="background:rgba(16,185,129,0.15);padding:8px;border-radius:6px;text-align:center;font-size:0.7rem;"><div>Tue</div><div style="font-weight:700;color:#10b981;">5/5 ✓</div></div>' +
          '<div style="background:rgba(245,158,11,0.15);padding:8px;border-radius:6px;text-align:center;font-size:0.7rem;"><div>Wed</div><div style="font-weight:700;color:#f59e0b;">3/5</div></div>' +
          '<div style="background:rgba(239,68,68,0.15);padding:8px;border-radius:6px;text-align:center;font-size:0.7rem;"><div>Thu</div><div style="font-weight:700;color:#ef4444;">1/5</div></div>' +
          '<div style="background:var(--bg-secondary,#16213e);padding:8px;border-radius:6px;text-align:center;font-size:0.7rem;"><div>Fri</div><div style="color:var(--muted,#999);">—</div></div>' +
          '<div style="background:var(--bg-secondary,#16213e);padding:8px;border-radius:6px;text-align:center;font-size:0.7rem;"><div>Sat</div><div style="color:var(--muted,#999);">—</div></div>' +
          '<div style="background:var(--bg-secondary,#16213e);padding:8px;border-radius:6px;text-align:center;font-size:0.7rem;"><div>Sun</div><div style="color:var(--muted,#999);">—</div></div>' +
        '</div>' +
      '</div>',

    aitutor:
      '<div style="padding:1rem;">' +
        '<div style="font-weight:700;margin-bottom:12px;">🤖 AI Tutor — Live</div>' +
        '<div style="background:var(--bg-secondary,#16213e);padding:12px;border-radius:8px;margin-bottom:8px;">' +
          '<div style="font-size:0.7rem;color:var(--muted,#999);margin-bottom:4px;">You asked:</div>' +
          '<div>Explain Article 370 with examples</div>' +
        '</div>' +
        '<div style="background:linear-gradient(135deg,rgba(99,102,241,0.1),rgba(168,85,247,0.1));padding:12px;border-radius:8px;border:1px solid rgba(99,102,241,0.3);">' +
          '<div style="font-size:0.7rem;color:#a78bfa;margin-bottom:4px;">🤖 AI Tutor:</div>' +
          '<div style="font-size:0.85rem;">Article 370 granted special autonomous status to Jammu & Kashmir...</div>' +
        '</div>' +
      '</div>',

    generic:
      '<div style="padding:1.5rem;text-align:center;">' +
        '<div style="display:flex;gap:8px;justify-content:center;margin-bottom:12px;">' +
          '<div style="width:60px;height:8px;background:var(--bg-secondary,#16213e);border-radius:4px;"></div>' +
          '<div style="width:40px;height:8px;background:var(--bg-secondary,#16213e);border-radius:4px;"></div>' +
          '<div style="width:80px;height:8px;background:var(--bg-secondary,#16213e);border-radius:4px;"></div>' +
        '</div>' +
        '<div style="width:80%;height:8px;background:var(--bg-secondary,#16213e);border-radius:4px;margin:0 auto 8px;"></div>' +
        '<div style="width:60%;height:8px;background:var(--bg-secondary,#16213e);border-radius:4px;margin:0 auto 8px;"></div>' +
        '<div style="width:70%;height:8px;background:var(--bg-secondary,#16213e);border-radius:4px;margin:0 auto;"></div>' +
      '</div>'
  };
  return previews[previewType] || previews.generic;
}

/**
 * ezBlurPreview(containerEl, options)
 * Wraps existing content in a blur container with a Pro overlay.
 *
 * @param {HTMLElement} containerEl
 * @param {Object} options
 * @param {string} options.title
 * @param {string} options.desc
 * @param {string} options.height 'sm' | 'md' | 'lg' | 'xl'
 * @param {boolean} options.partial  If true, fade bottom instead of blurring
 * @param {string} options.icon
 * @param {string} options.previewType  Which fake-content block to use
 */
function ezBlurPreview(containerEl, options) {
  if (!containerEl) return;
  if (typeof ezIsPro === 'function' && ezIsPro()) return; // Pro: no blur
  if (typeof ezGated === 'function' && !ezGated()) return; // Not logged in: no blur
  if (containerEl.querySelector('.pro-blur-overlay')) return; // already wrapped

  var opts = options || {};
  var title = opts.title || 'Pro Feature';
  var desc = opts.desc || 'Upgrade to Pro to unlock this feature.';
  var height = opts.height || 'md';
  var icon = opts.icon || '💎';
  var partial = !!opts.partial;
  var previewType = opts.previewType || 'generic';

  var existingContent = containerEl.innerHTML;
  if (!existingContent || !existingContent.trim()) {
    existingContent = ezGeneratePreviewContent(previewType);
  }

  containerEl.innerHTML =
    '<div class="pro-blur-container pro-blur-h-' + height + (partial ? ' pro-blur-partial' : '') + '">' +
      '<div class="pro-blur-content">' + existingContent + '</div>' +
      '<div class="pro-blur-overlay">' +
        '<div class="pro-lock-icon">' + icon + '</div>' +
        '<div class="pro-lock-title">' + title + '</div>' +
        '<div class="pro-lock-desc">' + desc + '</div>' +
        '<button class="pro-lock-btn" type="button" onclick="ezOpenUpgrade()">💎 Upgrade to Pro</button>' +
        '<div class="pro-lock-price">Starting at ₹49/month · 7-day free trial</div>' +
      '</div>' +
    '</div>';
}

/* ══════════════════════════════════════════════
   UPGRADE EXISTING GATES → BLUR PREVIEWS
   Keep the toast/limit logic; just wrap the
   container in a blur with realistic preview
   instead of showing a hard "💎 Pro feature" wall.
   ══════════════════════════════════════════════ */

/* 12b. AI Study Insights → blur with score-prediction preview.
   Override the hard-lock innerHTML set in gate #12 with a blur preview. */
(function () {
  var _orig12 = aiGetSmartInsights;
  if (typeof _orig12 !== 'function') return;
  aiGetSmartInsights = function () {
    if (typeof ezGated === 'function' && ezGated()) {
      var el = document.getElementById('ai-insights-container') ||
               document.querySelector('[data-tab="ai-insights"]') ||
               document.getElementById('planner-ai-insights');
      if (el) {
        el.innerHTML = '<div class="pro-blur-h-lg" style="position:relative;"></div>';
        ezBlurPreview(el.firstChild, {
          title: 'AI Study Insights',
          desc: 'Weak topics, score predictions, study recommendations, and time allocation advice — powered by AI.',
          height: 'lg',
          icon: '📊',
          previewType: 'insights'
        });
      }
      return null;
    }
    return _orig12.apply(this, arguments);
  };
})();

/* 13b. Spaced Repetition → blur with revision-schedule preview. */
(function () {
  var _orig13 = renderRevisionQueue;
  if (typeof _orig13 !== 'function') return;
  renderRevisionQueue = function () {
    if (typeof ezGated === 'function' && ezGated()) {
      var el = document.getElementById('revision-container') ||
               document.getElementById('revision-queue') ||
               document.querySelector('[data-tab="revision"]');
      if (el) {
        el.innerHTML = '<div class="pro-blur-h-lg" style="position:relative;"></div>';
        ezBlurPreview(el.firstChild, {
          title: 'Spaced Repetition Revision',
          desc: 'Auto-scheduled revision at Day 1, 3, 7, 14, 30 based on forgetting-curve science. Never forget a topic again.',
          height: 'lg',
          icon: '🔁',
          previewType: 'revision'
        });
      }
      return;
    }
    _orig13.apply(this, arguments);
  };
})();

/* 4b. AI Timetable weekly-limit wall → blur with weekly-plan preview.
   The free user already gets 1 generation/week; the BLUR fires only
   when the weekly cap is hit (i.e. after the free generation). */
(function () {
  var _orig4 = generateTimetable;
  if (typeof _orig4 !== 'function') return;
  generateTimetable = function () {
    if (typeof ezGated === 'function' && ezGated()) {
      var weekKey = 'sp_timetable_week_' + ezIsoWeekKey();
      var count = parseInt(localStorage.getItem(weekKey) || '0', 10);
      var maxFree = EZ_FREE_LIMITS.aiTimetablePerWeek || 1;
      if (count >= maxFree) {
        var c = document.getElementById('timetable-container');
        if (c) {
          c.innerHTML = '<div class="pro-blur-h-lg" style="position:relative;"></div>';
          ezBlurPreview(c.firstChild, {
            title: 'AI Timetable — Weekly Limit Reached',
            desc: 'Free plan: ' + maxFree + ' generation/week. Pro: unlimited + auto-reschedule on missed days.',
            height: 'lg',
            icon: '📅',
            previewType: 'timetable'
          });
        }
        return;
      }
      try { localStorage.setItem(weekKey, String(count + 1)); } catch (e) {}
    }
    _orig4.apply(this, arguments);
  };
})();

/* 11b. Turbo 4× → show the player UI blurred for free users.
   Free users still get a "Turbo not available" toast on toggle, but
   the player surface itself is rendered as a preview so they can
   see what they'd unlock. */
(function () {
  function _blurTurboSurface() {
    var controls = document.getElementById('yt-turbo-controls');
    var gated = (typeof ezGated === 'function') ? ezGated() : false;

    // Pro (or logged-out): make sure no stale blur overlay is left behind.
    // The blur may have been applied during the brief window where EZ_PROFILE
    // was still loading (ezIsPro() === false ⇒ ezGated() === true). Once the
    // profile confirms Pro, ezRefreshGates() re-runs this and we MUST remove
    // the overlay — otherwise a paying Pro user stays stuck on "Upgrade to Pro".
    if (!gated) {
      if (controls && controls.querySelector('.pro-blur-container')) {
        controls.remove();                                   // drop blurred wrapper
        if (typeof window.ytTurboInitUI === 'function') {
          try { window.ytTurboInitUI(); } catch (e) {}       // rebuild clean controls
        }
      }
      return;
    }

    var surfaces = document.querySelectorAll(
      '.yt-turbo-toggle, .turbo-section, [data-turbo="speed-selector"], #turbo-speed-buttons'
    );
    if (!surfaces.length) return;
    var surface = controls || surfaces[0].parentElement;
    if (!surface || surface.querySelector('.pro-blur-overlay')) return;
    ezBlurPreview(surface, {
      title: 'Turbo 4× Player',
      desc: 'Watch any YouTube lecture at 4× speed. A 2-hour video finishes in 30 minutes. Save 14+ hours per week.',
      height: 'md',
      icon: '🚀',
      previewType: 'turbo'
    });
  }
  // Exposed so ezRefreshGates() can re-run it once the Pro profile resolves.
  window._blurTurboSurface = _blurTurboSurface;
  // Re-blur whenever YouTube surfaces become active.
  if (typeof onPageActivated === 'function') {
    onPageActivated('youtube', function () { setTimeout(_blurTurboSurface, 300); });
    onPageActivated('yt-organiser', function () { setTimeout(_blurTurboSurface, 300); });
  }
  if (typeof ytToggleTurbo === 'function') {
    var _origT = ytToggleTurbo;
    ytToggleTurbo = function () {
      if (typeof ezGated === 'function' && ezGated()) {
        ezLockedMsg('Turbo 4× Player — watch lectures 4× faster');
        try { _blurTurboSurface(); } catch (e) {}
        return;
      }
      _origT.apply(this, arguments);
    };
  }
  // Also fire on load
  window.addEventListener('load', function () { setTimeout(_blurTurboSurface, 1500); });
})();

/* AI Tutor quota/preview is handled by the single sendTutor gate above. */

/* PDF Export buttons → blur/disable with 💎 lock icon. */
function ezBlurPdfButtons() {
  if (typeof ezGated === 'function' && !ezGated()) return;
  var pdfBtns = document.querySelectorAll(
    '[onclick*="exportPdf"], [onclick*="downloadPdf"], [onclick*="ezExportPdf"], .btn-pdf-export'
  );
  pdfBtns.forEach(function (btn) {
    if (btn.dataset.proBlurred) return;
    btn.dataset.proBlurred = '1';
    btn.style.position = 'relative';
    btn.style.opacity = '0.5';
    btn.style.pointerEvents = 'none';
    var lock = document.createElement('span');
    lock.style.cssText = 'position:absolute;right:6px;top:50%;transform:translateY(-50%);font-size:0.8rem;';
    lock.textContent = '💎';
    btn.appendChild(lock);
    btn.title = 'PDF Export — Pro feature';
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      ezLockedMsg('PDF Export — download plans, notes & reports');
    }, true);
  });
}

/* Hook PDF blur into the existing gate refresh. */
(function () {
  if (typeof ezRefreshGates !== 'function') return;
  var _orig = ezRefreshGates;
  ezRefreshGates = function () {
    _orig.apply(this, arguments);
    setTimeout(ezBlurPdfButtons, 500);
  };
})();

/* ══════════════════════════════════════════════
   COMMUNITY EXCLUSIVITY — PRO PERKS & STATUS
   Make Pro feel like a club, not just features.
   ══════════════════════════════════════════════ */

/* C1. PRO BADGE IN TOPBAR — shows plan + "since" date for Pro users,
   trial days for trialing users, "Free Plan" for free. The existing
   ezRenderPlanBadge in phase2-plans.js handles the basic version;
   this one extends it with the "since" date and click → upgrade. */
function ezRenderProStatusBadge() {
  var existing = document.getElementById('pro-status-badge');
  if (existing) existing.remove();

  if (typeof currentUser === 'undefined' || !currentUser) return;

  var right = document.querySelector('.topbar-right');
  if (!right) return;

  var isPro = (typeof ezIsPro === 'function') ? ezIsPro() : false;
  var p = (typeof EZ_PROFILE !== 'undefined' && EZ_PROFILE) ? EZ_PROFILE : {};

  var badge = document.createElement('div');
  badge.id = 'pro-status-badge';

  if (isPro) {
    var planLabel = p.plan === 'pro_annual' ? 'Yearly' :
                    p.plan === 'pro_halfyearly' ? '6 Months' :
                    p.plan === 'pro_quarterly' ? '3 Months' :
                    p.plan === 'pro_monthly' ? 'Monthly' :
                    p.plan === 'referral' ? 'Referral' :
                    p.plan === 'referral_welcome' ? 'Welcome' : 'Pro';
    var since = p.paidAt ? new Date(p.paidAt).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }) : '';
    badge.style.cssText = 'background:linear-gradient(135deg,rgba(99,102,241,0.15),rgba(168,85,247,0.15));border:1px solid rgba(99,102,241,0.3);color:#a78bfa;';
    badge.innerHTML = '👑 Pro' + (since ? ' · since ' + since : '');
    badge.title = planLabel + ' plan' + (p.planExpiry ? ' · Expires: ' + p.planExpiry : '');
  } else if (typeof ezIsProTrialActive === 'function' && ezIsProTrialActive()) {
    var daysLeft = (typeof ezProTrialDaysLeft === 'function') ? ezProTrialDaysLeft() : 0;
    badge.style.cssText = 'background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.3);color:#f59e0b;';
    badge.innerHTML = '⏳ Trial: ' + daysLeft + 'd left';
    badge.title = 'Pro trial active — click to upgrade';
  } else {
    badge.style.cssText = 'background:var(--bg-secondary);border:1px solid var(--border);color:var(--muted);';
    badge.innerHTML = '🆓 Free Plan';
    badge.title = 'Click to upgrade to Pro';
  }

  badge.onclick = function () {
    try { ezOpenUpgrade(); } catch (e) {}
  };

  // Insert next to the existing plan badge (which is at position 0)
  var existingBadge = document.getElementById('ez-plan-badge');
  if (existingBadge && existingBadge.parentElement) {
    existingBadge.parentElement.insertBefore(badge, existingBadge.nextSibling);
  } else {
    right.insertBefore(badge, right.firstChild);
  }
}

/* C2. PRO EXCLUSIVE WIDGET — Dashboard widget showing perks.
   Pro users see 4 unlocked perk tiles + motivational line.
   Free users see 4 locked perk tiles + "Unlock all" button. */
function ezRenderProExclusiveWidget() {
  if (typeof currentUser === 'undefined' || !currentUser) return;

  var dashboard = document.getElementById('page-dashboard');
  if (!dashboard) return;

  var existing = document.getElementById('pro-exclusive-widget');
  if (existing) existing.remove();

  var isPro = (typeof ezIsPro === 'function') ? ezIsPro() : false;

  var widget = document.createElement('div');
  widget.id = 'pro-exclusive-widget';
  widget.className = 'pro-exclusive-widget';

  if (isPro) {
    widget.style.background = 'linear-gradient(135deg,rgba(99,102,241,0.1),rgba(168,85,247,0.1))';
    widget.style.border = '1px solid rgba(99,102,241,0.25)';
    widget.innerHTML =
      '<h4 style="margin:0 0 0.75rem;font-size:0.95rem;">👑 Pro Member Perks</h4>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:0.8rem;">' +
        '<a href="#" onclick="try{ezOpenTelegramGroup()}catch(e){}return false;" style="display:flex;align-items:center;gap:8px;padding:10px;background:var(--bg-secondary);border-radius:8px;color:var(--text);text-decoration:none;">' +
          '<span>💬</span><span>Exclusive Telegram Group</span></a>' +
        '<a href="#" onclick="try{ezOpenLiveQA()}catch(e){}return false;" style="display:flex;align-items:center;gap:8px;padding:10px;background:var(--bg-secondary);border-radius:8px;color:var(--text);text-decoration:none;">' +
          '<span>📺</span><span>Monthly Live Q&A</span></a>' +
        '<a href="#" onclick="try{ezOpenPdfNotes()}catch(e){}return false;" style="display:flex;align-items:center;gap:8px;padding:10px;background:var(--bg-secondary);border-radius:8px;color:var(--text);text-decoration:none;">' +
          '<span>📄</span><span>PDF Notes Download</span></a>' +
        '<a href="#" onclick="try{ezOpenEarlyAccess()}catch(e){}return false;" style="display:flex;align-items:center;gap:8px;padding:10px;background:var(--bg-secondary);border-radius:8px;color:var(--text);text-decoration:none;">' +
          '<span>🚀</span><span>Early Access Features</span></a>' +
      '</div>' +
      '<div style="margin-top:0.75rem;padding:8px 12px;background:rgba(16,185,129,0.1);border-radius:8px;font-size:0.75rem;color:#10b981;text-align:center;">' +
        '🎯 You\'re in the top 15% of active aspirants. Keep going!' +
      '</div>';
  } else {
    widget.style.background = 'var(--bg-secondary)';
    widget.style.border = '1px solid var(--border)';
    widget.innerHTML =
      '<h4 style="margin:0 0 0.75rem;font-size:0.95rem;">👑 Pro Member Perks <span style="font-size:0.7rem;color:var(--muted);font-weight:400;">(locked)</span></h4>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:0.8rem;opacity:0.6;">' +
        '<div style="display:flex;align-items:center;gap:8px;padding:10px;background:var(--bg-primary);border-radius:8px;"><span>💬</span><span>Exclusive Telegram Group</span><span style="margin-left:auto;">🔒</span></div>' +
        '<div style="display:flex;align-items:center;gap:8px;padding:10px;background:var(--bg-primary);border-radius:8px;"><span>📺</span><span>Monthly Live Q&amp;A</span><span style="margin-left:auto;">🔒</span></div>' +
        '<div style="display:flex;align-items:center;gap:8px;padding:10px;background:var(--bg-primary);border-radius:8px;"><span>📄</span><span>PDF Notes Download</span><span style="margin-left:auto;">🔒</span></div>' +
        '<div style="display:flex;align-items:center;gap:8px;padding:10px;background:var(--bg-primary);border-radius:8px;"><span>🚀</span><span>Early Access Features</span><span style="margin-left:auto;">🔒</span></div>' +
      '</div>' +
      '<button onclick="try{ezOpenUpgrade()}catch(e){}" type="button" style="width:100%;margin-top:0.75rem;padding:10px;border-radius:8px;border:none;background:linear-gradient(135deg,#6366f1,#a855f7);color:#fff;font-weight:700;font-size:0.85rem;cursor:pointer;font-family:inherit;">' +
        '💎 Unlock All Pro Perks — ₹49/mo</button>';
  }

  // Try common dashboard content containers in order of preference
  var dashContent = dashboard.querySelector('.dashboard-content, .dash-grid, .fin-hero-grid, .page-content');
  if (dashContent) {
    dashContent.appendChild(widget);
  } else {
    dashboard.appendChild(widget);
  }
}

/* C3. PRO EXCLUSIVE ACTIONS — link out to Telegram group, Live Q&A, etc. */
function ezOpenTelegramGroup() {
  var groupLink = 'https://t.me/studyplanner_pro';
  if (typeof db !== 'undefined' && db) {
    db.collection('config').doc('pro').get().then(function (doc) {
      if (doc.exists && doc.data().telegramGroupLink) groupLink = doc.data().telegramGroupLink;
      window.open(groupLink, '_blank', 'noopener');
    }).catch(function () { window.open(groupLink, '_blank', 'noopener'); });
  } else {
    window.open(groupLink, '_blank', 'noopener');
  }
}

function ezOpenLiveQA() {
  var qaLink = 'https://youtube.com/@studyplanner/live';
  if (typeof db !== 'undefined' && db) {
    db.collection('config').doc('pro').get().then(function (doc) {
      if (doc.exists && doc.data().liveQALink) qaLink = doc.data().liveQALink;
      window.open(qaLink, '_blank', 'noopener');
    }).catch(function () { window.open(qaLink, '_blank', 'noopener'); });
  } else {
    window.open(qaLink, '_blank', 'noopener');
  }
}

function ezOpenPdfNotes() {
  if (typeof switchPage === 'function') switchPage('notes');
  if (typeof showToast === 'function') showToast('📄 PDF export is enabled for Pro members. Look for the download button.', 'success');
}

function ezOpenEarlyAccess() {
  var existing = document.getElementById('early-access-modal');
  if (existing) existing.remove();

  var modal = document.createElement('div');
  modal.id = 'early-access-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:10001;display:flex;align-items:center;justify-content:center;padding:1rem;';
  modal.innerHTML =
    '<div style="position:absolute;inset:0;background:rgba(0,0,0,0.7);" onclick="this.parentElement.remove()"></div>' +
    '<div style="position:relative;background:var(--surface,#1a1a2e);border:1px solid var(--border,#333);border-radius:16px;padding:2rem;max-width:400px;width:100%;">' +
      '<h3 style="margin-bottom:1rem;">🚀 Early Access — Coming Soon</h3>' +
      '<div style="display:flex;flex-direction:column;gap:10px;font-size:0.85rem;">' +
        '<div style="padding:10px;background:var(--bg-secondary);border-radius:8px;display:flex;align-items:center;gap:10px;"><span>🧠</span><span>AI Weakness Report (Weekly PDF)</span><span style="margin-left:auto;font-size:0.7rem;color:#f59e0b;">Beta</span></div>' +
        '<div style="padding:10px;background:var(--bg-secondary);border-radius:8px;display:flex;align-items:center;gap:10px;"><span>🎯</span><span>Cut-off Predictor</span><span style="margin-left:auto;font-size:0.7rem;color:#6366f1;">Soon</span></div>' +
        '<div style="padding:10px;background:var(--bg-secondary);border-radius:8px;display:flex;align-items:center;gap:10px;"><span>👥</span><span>Study Buddy Matching</span><span style="margin-left:auto;font-size:0.7rem;color:#6366f1;">Soon</span></div>' +
        '<div style="padding:10px;background:var(--bg-secondary);border-radius:8px;display:flex;align-items:center;gap:10px;"><span>📱</span><span>Offline Mode (PWA)</span><span style="margin-left:auto;font-size:0.7rem;color:#6366f1;">Soon</span></div>' +
      '</div>' +
      '<p style="font-size:0.75rem;color:var(--muted);margin-top:1rem;text-align:center;">Pro members get these features 1-2 weeks before free users.</p>' +
      '<button onclick="this.closest(\'#early-access-modal\').remove()" type="button" style="width:100%;margin-top:0.75rem;padding:10px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text);cursor:pointer;font-family:inherit;">Close</button>' +
    '</div>';
  document.body.appendChild(modal);
}

/* C4. PRIORITY AI FLAG — Pro users get faster/longer AI responses.
   Returns { priority, maxTokens, label } for the AI Tutor call site
   to consume. Free users get normal priority + 800 tokens; Pro gets
   high priority + 2000 tokens. */
function ezGetAIPriority() {
  if (typeof ezIsPro === 'function' && ezIsPro()) {
    return { priority: 'high', maxTokens: 2000, label: '⚡ Priority' };
  }
  return { priority: 'normal', maxTokens: 800, label: '' };
}

/* C5. RENDER ALL PRO STATUS ELEMENTS — topbar badge + dashboard widget. */
function ezRenderProStatus() {
  try { ezRenderProStatusBadge(); } catch (e) {}
  try { ezRenderProExclusiveWidget(); } catch (e) {}
}

/* Hook into profile load + dashboard render so the badge & widget
   re-render whenever plan state might have changed. */
(function () {
  if (typeof ezLoadProfile === 'function') {
    var _origLP = ezLoadProfile;
    ezLoadProfile = async function () {
      await _origLP.apply(this, arguments);
      try { ezRenderProStatus(); } catch (e) {}
    };
  }
  if (typeof updateDashboard === 'function') {
    var _origUD = updateDashboard;
    updateDashboard = function () {
      _origUD.apply(this, arguments);
      if (typeof EZ_PROFILE !== 'undefined' && EZ_PROFILE) {
        try { ezRenderProStatus(); } catch (e) {}
      }
    };
  }
})();
