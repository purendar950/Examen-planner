/* ══════════════════════════════════════════════
   LEARN MODE TAB
   Lazy-loads the standalone Calc Master learn page (learn/index.html)
   into an iframe on first activation, and keeps the iframe height in sync
   with the learn page's internal category views.
══════════════════════════════════════════════ */
(function () {
  var loaded = false;

  function resizeFrame() {
    var frame = document.getElementById('learn-frame');
    if (!frame || !frame.contentDocument || !frame.contentDocument.body) return;
    var height = frame.contentDocument.body.scrollHeight;
    if (height > 150) frame.style.height = height + 'px';
  }

  function loadLearn() {
    var frame = document.getElementById('learn-frame');
    var loading = document.getElementById('pl-loading');
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
    frame.src = 'learn/index.html';
  }

  if (typeof onPageActivated === 'function') {
    onPageActivated('learn', loadLearn);
  }

  // If Learn is the restored active page, start loading right away.
  if (document.getElementById('page-learn') &&
      document.getElementById('page-learn').classList.contains('active')) {
    loadLearn();
  }

  window.addEventListener('resize', function () {
    if (loaded) setTimeout(resizeFrame, 80);
  });
})();
