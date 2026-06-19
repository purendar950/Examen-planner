/* ══════════════════════════════════════════════
   TOAST
══════════════════════════════════════════════ */
let toastTimeout;
function showToast(msg, type='info') {
  const toast = document.getElementById('toast');
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

