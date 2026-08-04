/* ══════════════════════════════════════════════
   CALCULATION PRACTICE TAB
   Lazy-loads the standalone StudyPlanner maths practice app
   (calc/index.html) into an iframe on first activation.
══════════════════════════════════════════════ */
(function () {
  var loaded = false;

  function syncCalcTheme() {
    var frame = document.getElementById('calc-frame');
    if (!frame || !frame.contentWindow) return;
    frame.contentWindow.postMessage({
      source: 'studyplanner',
      type: 'theme',
      theme: document.documentElement.dataset.theme || 'dark'
    }, window.location.origin);
  }

  function loadCalc() {
    var frame = document.getElementById('calc-frame');
    var loading = document.getElementById('cp-loading');
    if (!frame) return;
    if (loaded) return;
    loaded = true;

    frame.addEventListener('load', function () {
      if (loading) loading.style.display = 'none';
      syncCalcTheme();
    });
    frame.src = 'calc/index.html';
  }

  if (typeof onPageActivated === 'function') {
    onPageActivated('calc', loadCalc);
  }

  window.addEventListener('ez-theme-change', syncCalcTheme);

  // If Calculation Practice is the restored active page, start loading right away.
  if (document.getElementById('page-calc') &&
      document.getElementById('page-calc').classList.contains('active')) {
    loadCalc();
  }
})();
