/* ══════════════════════════════════════════════
   DOM SAFETY HELPERS
══════════════════════════════════════════════ */
function escapeHtml(value) {
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

