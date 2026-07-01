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

