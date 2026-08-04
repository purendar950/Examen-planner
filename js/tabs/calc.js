/* ══════════════════════════════════════════════
   CALCULATION PRACTICE TAB
   Lazy-loads the standalone StudyPlanner maths practice app
   (calc/index.html) into an iframe on first activation.
══════════════════════════════════════════════ */
(function () {
  var loaded = false;

  function loadCalc() {
    var frame = document.getElementById('calc-frame');
    var loading = document.getElementById('cp-loading');
    if (!frame) return;
    if (loaded) return;
    loaded = true;

    frame.addEventListener('load', function () {
      if (loading) loading.style.display = 'none';
    });
    frame.src = 'calc/index.html';
  }

  if (typeof onPageActivated === 'function') {
    onPageActivated('calc', loadCalc);
  }

  // If Calculation Practice is the restored active page, start loading right away.
  if (document.getElementById('page-calc') &&
      document.getElementById('page-calc').classList.contains('active')) {
    loadCalc();
  }
})();
