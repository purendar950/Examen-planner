/* Accessible dialog behavior for the app's vanilla-JS modal surfaces.
   Presentation follows shadcn's composable overlay/content/header/footer model
   without introducing a React runtime into the existing classic-script app. */
(function () {
  var openDialogs = [];
  var openers = new WeakMap();

  function isVisible(element) {
    if (!element || !element.isConnected || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
    var style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.offsetParent !== null;
  }

  function focusableElements(dialog) {
    return Array.prototype.filter.call(dialog.querySelectorAll(
      'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ), isVisible);
  }

  function topDialog() {
    for (var index = openDialogs.length - 1; index >= 0; index -= 1) {
      if (openDialogs[index].classList.contains('open')) return openDialogs[index];
    }
    return null;
  }

  function fallbackFocusTarget(closingOverlay) {
    var candidates = document.querySelectorAll(
      '#examBtn-cgl, .topbar button:not([disabled]), #app button:not([disabled]), #app a[href], #app [tabindex]:not([tabindex="-1"])'
    );
    for (var index = 0; index < candidates.length; index += 1) {
      if (!closingOverlay.contains(candidates[index]) && isVisible(candidates[index])) return candidates[index];
    }
    return null;
  }

  function open(id, options) {
    var overlay = typeof id === 'string' ? document.getElementById(id) : id;
    if (!overlay) return false;
    var dialog = overlay.querySelector('[role="dialog"]') || overlay.firstElementChild;
    if (!dialog) return false;

    var alreadyOpen = overlay.classList.contains('open');
    if (!alreadyOpen) {
      var active = document.activeElement;
      if (active && active !== document.body && active !== document.documentElement && !overlay.contains(active)) {
        openers.set(overlay, active);
      }
      if (openDialogs.indexOf(overlay) === -1) openDialogs.push(overlay);
    }

    overlay.style.removeProperty('display');
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    document.body.classList.add('sp-dialog-open');

    if (!alreadyOpen) {
      window.requestAnimationFrame(function () {
        var target = null;
        if (options && options.initialFocus) target = dialog.querySelector(options.initialFocus);
        if (!isVisible(target)) target = focusableElements(dialog)[0] || dialog;
        if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
      });
    }
    return true;
  }

  function close(id) {
    var overlay = typeof id === 'string' ? document.getElementById(id) : id;
    if (!overlay || !overlay.classList.contains('open')) return false;
    overlay.classList.remove('open');
    overlay.style.removeProperty('display');
    overlay.setAttribute('aria-hidden', 'true');
    openDialogs = openDialogs.filter(function (item) { return item !== overlay; });
    if (!topDialog()) document.body.classList.remove('sp-dialog-open');

    var opener = openers.get(overlay);
    openers.delete(overlay);
    window.requestAnimationFrame(function () {
      var target = opener;
      if (!target || target === document.body || target === document.documentElement || overlay.contains(target) || !isVisible(target)) {
        target = fallbackFocusTarget(overlay);
      }
      if (target && typeof target.focus === 'function') {
        target.focus({ preventScroll: true });
        return;
      }
      var app = document.getElementById('app');
      if (app) {
        app.setAttribute('tabindex', '-1');
        app.focus({ preventScroll: true });
      }
    });
    return true;
  }

  document.addEventListener('keydown', function (event) {
    var overlay = topDialog();
    if (!overlay) return;
    var dialog = overlay.querySelector('[role="dialog"]') || overlay.firstElementChild;
    if (!dialog) return;

    if (event.key === 'Escape') {
      var closeButton = dialog.querySelector('[data-dialog-close]');
      if (closeButton) {
        event.preventDefault();
        closeButton.click();
      }
      return;
    }

    if (event.key !== 'Tab') return;
    var focusable = focusableElements(dialog);
    if (!focusable.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (!dialog.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  window.StudyPlannerDialog = Object.freeze({ open: open, close: close });
})();
