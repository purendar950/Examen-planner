/* ══════════════════════════════════════════════
   CALCULATION & FORMULA TAB
   Lazy-loads the standalone Calc Master formula page (formula/index.html)
   into an iframe on first activation, and keeps the iframe height in sync
   with the formula page's internal chapter/section views.
══════════════════════════════════════════════ */
(function () {
  var loaded = false;

  function resizeFrame() {
    var frame = document.getElementById('formula-frame');
    if (!frame || !frame.contentDocument || !frame.contentDocument.body) return;
    var height = frame.contentDocument.body.scrollHeight;
    if (height > 150) frame.style.height = height + 'px';
  }

  function loadFormula() {
    var frame = document.getElementById('formula-frame');
    var loading = document.getElementById('pf-loading');
    if (!frame) return;
    if (loaded) { resizeFrame(); return; }
    loaded = true;

    frame.addEventListener('load', function () {
      if (loading) loading.style.display = 'none';
      resizeFrame();
      try {
        frame.contentWindow.addEventListener('hashchange', function () {
          setTimeout(resizeFrame, 60);
        });
      } catch (e) {}
      setTimeout(resizeFrame, 120);
    });
    frame.src = 'formula/index.html';
  }

  if (typeof onPageActivated === 'function') {
    onPageActivated('formula', loadFormula);
  }

  // If Formula is the restored active page, start loading right away.
  if (document.getElementById('page-formula') &&
      document.getElementById('page-formula').classList.contains('active')) {
    loadFormula();
  }

  window.addEventListener('resize', function () {
    if (loaded) setTimeout(resizeFrame, 80);
  });
})();
