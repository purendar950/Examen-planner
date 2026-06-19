/* ══════════════════════════════════════════════
   EXAMZEN PHASE 4 — FREE/PRO GATING + THEME TOGGLE
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
    if(currentUser.isGuest){showToast('Guest mode mein request nahi.','error');return;}
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

let EZ_FREE_LIMITS = { mocks: 5, mediaSaves: 2, notes: 10 }; // loaded from Firestore config/free

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

function ezIsPro() {
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
/* Gating applies only to real (non-guest) logged-in free users */
// FIX 6: ezGated() returns true (gated/restricted) for any real logged-in user
// who is NOT on an active Pro plan or trial.
// When EZ_PROFILE is null (still loading from Firestore), ezIsPro() returns false
// → ezGated() returns true → gates are CLOSED by default until plan data arrives.
// This is the correct fail-safe: deny Pro features until we've confirmed Pro status.
// ezLoadProfile() calls ezRefreshGates() once EZ_PROFILE loads, which opens gates
// for users who actually have a valid Pro plan/trial.
function ezGated() { return !!(currentUser && !currentUser.isGuest && !ezIsPro()); }
function ezLockedMsg(feature) {
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

/* 2. Mock saves → max 5 free (existing saves never deleted, only new blocked) */
const _mockSaveGate = mockSave;
mockSave = function() {
  if (ezGated() && !mockEditId) {
    let count = 0;
    const mk = appState.mocks || {};
    Object.keys(mk).forEach(ex => Object.keys(mk[ex] || {}).forEach(tk => { count += (mk[ex][tk] || []).length; }));
    if (count >= EZ_FREE_LIMITS.mocks) { ezLockedMsg('Free plan: max ' + EZ_FREE_LIMITS.mocks + ' mock saves. Unlimited saves'); return; }
  }
  _mockSaveGate();
};

/* 3. Mock analysis charts → Pro (blurred preview + upgrade CTA) */
const _mockAnalysisGate = mockRenderAnalysis;
mockRenderAnalysis = function() {
  _mockAnalysisGate();
  if (!ezGated()) return;
  const el = document.getElementById('mock-analysis');
  if (!el || !el.innerHTML.trim()) return;
  el.style.position = 'relative';
  const ov = document.createElement('div');
  ov.style.cssText = 'position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;background:rgba(0,0,0,0.45);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border-radius:12px;text-align:center;padding:1.25rem;';
  ov.innerHTML = '<div style="font-size:2.2rem;">💎</div>' +
    '<div style="font-weight:800;color:#fff;">Mock Test Analysis — Pro feature</div>' +
    '<div style="font-size:0.8rem;color:rgba(255,255,255,0.75);max-width:300px;">Score trend chart, accuracy % aur weakest section insights Pro plan mein milte hain.</div>' +
    '<button class="btn-modal-save" onclick="ezOpenUpgrade()">💎 Upgrade to Pro</button>';
  el.appendChild(ov);
};

/* 4. AI Timetable → Pro */
const _genTimetableGate = generateTimetable;
generateTimetable = function() {
  if (ezGated()) {
    const c = document.getElementById('timetable-container');
    if (c) c.innerHTML = '<div class="info-card" style="text-align:center;"><div style="font-size:2.2rem;">💎</div>' +
      '<div style="font-weight:800;margin:6px 0;">AI Timetable — Pro feature</div>' +
      '<div style="font-size:0.8rem;color:var(--muted);">Daily chapter-wise plan jo miss hone par auto-reschedule hota hai — Pro mein milta hai.</div>' +
      '<button class="btn-modal-save" style="margin-top:12px;" onclick="ezOpenUpgrade()">💎 Upgrade to Pro</button></div>';
    return;
  }
  _genTimetableGate();
};

/* 5. Playlist Organiser courses → configurable free limit; Pro/trial users can save up to 10 */
const _ytoLoadGate = ytoLoadPlaylist;
ytoLoadPlaylist = async function() {
  const url = (document.getElementById('yto-url-input') || { value: '' }).value.trim();
  const plId = ytExtractPlaylistId(url);
  const lib = ytoLib();
  const existing = plId && lib[plId];
  const maxSaved = ezIsPro() ? 10 : EZ_FREE_LIMITS.mediaSaves;
  if (currentUser && !currentUser.isGuest && !existing && Object.keys(lib).length >= maxSaved) {
    if (ezIsPro()) showToast('Pro users max 10 playlists/videos save kar sakte hain. Admin panel se user limit manage karein.', 'error');
    else ezLockedMsg('Free plan: sirf ' + EZ_FREE_LIMITS.mediaSaves + ' playlists/videos save. Pro mein 10 tak save kar sakte ho');
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
  if (currentUser && !currentUser.isGuest && !existing && Object.keys(appState.ytLinks).length >= maxLinks) {
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

/* 8. Daily Telegram auto-send → Pro only (the actual sending also re-checks
   plan status server-side in scripts/send-telegram.js; this just stops free
   users from turning it on / gives them a clear upgrade nudge). */
function ezApplyTelegramLock() {
  const badge = document.getElementById('tg-pro-badge');
  if (!badge) return;
  // FIX: while EZ_PROFILE is unresolved (null) keep the Pro badge hidden
  // instead of treating the user as gated — avoids flashing locks on a
  // fresh free login before the profile loads.
  if (EZ_PROFILE === null) { badge.style.display = 'none'; return; }
  badge.style.display = ezGated() ? 'inline-block' : 'none';
}
const _saveTelegramGate = saveTelegramSettings;
saveTelegramSettings = function() {
  const onEl = document.getElementById('tg-enabled');
  if (ezGated() && onEl && onEl.checked) {
    onEl.checked = false;
    ezLockedMsg('Daily Telegram plan auto-send');
    return;
  }
  _saveTelegramGate();
};

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
const _switchPageGate = switchPage;
switchPage = function(page) {
  // FIX: free users can open every page now — only specific features
  // inside each page stay Pro-gated (see gate list in the comment above).
  _switchPageGate(page);
  try { ezApplyPageLock(); } catch(e) {}
};

/* Apply exam lock after profile loads */
const _ezLoadProfileBase4 = ezLoadProfile;
ezLoadProfile = async function() {
  await _ezLoadProfileBase4();
  ezApplyExamLock();
  ezApplyTelegramLock();
  ezApplyPageLock();
};

