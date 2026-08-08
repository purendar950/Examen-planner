/* ══════════════════════════════════════════════
   DOM SAFETY HELPERS
══════════════════════════════════════════════ */
/* Canonical escapeHtml now lives in src/shared/domUtils.js (loaded as an ES
   module by src/main.js). Module scripts are deferred, so window.PrepPathModules
   may not exist yet the first time this file is parsed/called — every call
   re-checks and falls back to the identical inline implementation below if
   the shared module hasn't finished loading. This keeps a single source of
   truth for the escaping rules without introducing any load-order risk. */
function escapeHtml(value) {
  const mods = window.PrepPathModules;
  if (mods && mods.domUtils && typeof mods.domUtils.escapeHtml === 'function') {
    return mods.domUtils.escapeHtml(value);
  }
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setText(target, value) {
  const el = typeof target === 'string' ? document.querySelector(target) : target;
  if (el) el.textContent = value ?? '';
  return el;
}

function bindEvent(target, eventName, handler, options) {
  const el = typeof target === 'string' ? document.querySelector(target) : target;
  if (!el) return function noopUnbind() {};
  el.addEventListener(eventName, handler, options);
  return () => el.removeEventListener(eventName, handler, options);
}

/* ══════════════════════════════════════════════
   TOAST
══════════════════════════════════════════════ */
let toastTimeout;
function showToast(msg, type='info') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.className = `toast ${type} show`;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { toast.classList.remove('show'); }, 3000);
}

/* ══════════════════════════════════════════════
   DISPLAY NAME
   One source of truth for "what do we call this user on screen". The welcome
   greeting, the account chip, its avatar initial and the dashboard heading all
   read this, so they can no longer disagree with each other.

   Presentation only — identity data keeps the full raw name: currentUser.name,
   the um-name dropdown line and the ez_user_name bridge to test-engine.html
   are all left untouched.
══════════════════════════════════════════════ */
const EZ_NAME_FALLBACK = 'Aspirant';

/* Reduce whatever we know to a presentable first name. Also covers the case
   where the only thing available is an email local part ("rahul.kumar123"),
   which previously reached the greeting verbatim. Returns '' when nothing
   usable survives, so callers can fall through to the next source. */
function ezPrettyFirstName(raw) {
  let nm = String(raw ?? '').trim();
  if (!nm) return '';
  // A displayName is sometimes the address itself; never show the domain.
  if (nm.includes('@')) nm = nm.split('@')[0];
  // Split on spaces and on the separators address local parts use, so both
  // "Rahul Kumar" and "rahul.kumar123" reduce to "rahul".
  let first = nm.split(/[\s._\-+]+/).filter(Boolean)[0] || '';
  // Trailing digits are address noise ("rahul123"), not part of a name.
  first = first.replace(/\d+$/, '');
  if (!first) return '';
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/* Preference order: the in-app editable Firestore profile name (the user's own
   choice) → the auth record → the email local part → the localStorage identity
   bridge → a neutral fallback. */
function ezDisplayFirstName() {
  let nm = '';
  try { if (window.EZ_PROFILE && EZ_PROFILE.name) nm = ezPrettyFirstName(EZ_PROFILE.name); } catch (e) {}
  if (!nm) try { if (typeof currentUser !== 'undefined' && currentUser) nm = ezPrettyFirstName(currentUser.name || currentUser.displayName); } catch (e) {}
  if (!nm) try { if (typeof currentUser !== 'undefined' && currentUser) nm = ezPrettyFirstName(currentUser.email); } catch (e) {}
  if (!nm) try { nm = ezPrettyFirstName(localStorage.getItem('ez_user_name')); } catch (e) {}
  return nm || EZ_NAME_FALLBACK;
}

/* Paint the canonical name into every surface that shows it, in one call, so a
   rename or a late-arriving profile can never update one and miss another.
   setText() no-ops on absent nodes, so this is safe before the dashboard
   include has been injected. */
function ezRenderDisplayName() {
  const display = ezDisplayFirstName();
  setText('#user-name-display', display);
  setText('#user-avatar-text', display.charAt(0).toUpperCase());
  setText('#dash-username', display);
  return display;
}

/* ══════════════════════════════════════════════
   KEYBOARD SHORTCUTS
══════════════════════════════════════════════ */
document.addEventListener('keydown', e => {
  if (!currentUser) return;
  if (e.ctrlKey && e.key === 's') { e.preventDefault(); saveProgress(); showToast('Progress saved!', 'success'); }
});

/* Allow pressing Enter in auth inputs */
document.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const loginForm = document.getElementById('form-login');
    const regForm = document.getElementById('form-register');
    if (loginForm.style.display !== 'none') handleLogin();
    else if (regForm.style.display !== 'none') handleRegister();
  }
});

