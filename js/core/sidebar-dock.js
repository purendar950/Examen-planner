/* ══════════════════════════════════════════════
   SIDEBAR ACCOUNT DOCK
   On desktop the whole topbar utility cluster (plan badge, Pro badge,
   💡 Request, Install app, sync pill, theme toggle) plus the account chip are
   relocated into a single card at the bottom of the workspace rail. The nodes
   themselves are moved — never cloned — so every existing id, inline handler
   and injection target (`.topbar-right`) keeps working untouched.
   Below 901px the horizontal nav has no rail, so the cluster returns to the
   topbar where phones expect it.
══════════════════════════════════════════════ */
(function () {
  var DESKTOP_QUERY = '(min-width: 901px)';

  function byId(id) { return document.getElementById(id); }

  function isDesktop() {
    try { return window.matchMedia(DESKTOP_QUERY).matches; }
    catch (e) { return window.innerWidth >= 901; }
  }

  /* Move the cluster + chip between topbar and rail dock for the current
     breakpoint. Safe to call repeatedly: nodes are only touched when their
     parent is wrong. */
  function placeDock() {
    var tray = byId('shell-dock-tray');
    var account = byId('shell-dock-account');
    var topbar = document.querySelector('#app .topbar');
    var cluster = document.querySelector('.topbar-right');
    var chip = document.querySelector('.user-chip');
    if (!cluster) return;

    if (isDesktop() && tray && account) {
      if (cluster.parentElement !== tray) tray.appendChild(cluster);
      if (chip && chip.parentElement !== account) account.appendChild(chip);
      return;
    }

    if (topbar && cluster.parentElement !== topbar) topbar.appendChild(cluster);
    if (chip && chip.parentElement !== cluster) {
      // Restore the original topbar order: chip sits just before the theme button.
      var themeBtn = byId('ez-theme-btn');
      if (themeBtn && themeBtn.parentElement === cluster) cluster.insertBefore(chip, themeBtn);
      else cluster.appendChild(chip);
    }
  }

  /* The rail is sized from the measured viewport rather than 100vh: on Chrome
     for Android 100vh is the toolbar-hidden height, which made the rail taller
     than the screen and pushed the dock out of sight. */
  function syncRailHeight() {
    var height = window.innerHeight;
    if (!height || height < 1) return;
    document.documentElement.style.setProperty('--shell-vh', height + 'px');
  }

  /* The dock shows the signed-in email under the name (the topbar chip has no
     room for it), mirroring whatever the account menu already renders. */
  function syncAccountCopy() {
    var emailEl = byId('user-chip-email');
    var chip = document.querySelector('.user-chip');
    var user = null;
    try { user = (typeof currentUser !== 'undefined' && currentUser) ? currentUser : null; } catch (e) {}
    var email = (user && user.email) ? user.email : '';
    var name = (user && user.name) ? user.name : '';
    if (emailEl && emailEl.textContent !== email) emailEl.textContent = email;
    if (chip) chip.title = name ? (email ? name + ' · ' + email : name) : 'Account';
  }
  window.ezSyncDockAccount = syncAccountCopy;

  function start() {
    syncRailHeight();
    placeDock();
    syncAccountCopy();

    // Android Chrome resizes the viewport whenever the toolbar slides in or out.
    window.addEventListener('resize', syncRailHeight);
    window.addEventListener('orientationchange', syncRailHeight);
    if (window.visualViewport && window.visualViewport.addEventListener) {
      window.visualViewport.addEventListener('resize', syncRailHeight);
    }

    try {
      var mql = window.matchMedia(DESKTOP_QUERY);
      if (mql.addEventListener) mql.addEventListener('change', placeDock);
      else if (mql.addListener) mql.addListener(placeDock);
    } catch (e) {
      window.addEventListener('resize', placeDock);
    }

    // The name node is rewritten on login and on profile rename — that is also
    // the moment the email/avatar copy needs refreshing.
    var nameEl = byId('user-name-display');
    if (nameEl && window.MutationObserver) {
      new MutationObserver(syncAccountCopy).observe(nameEl, { childList: true, characterData: true, subtree: true });
    }
    // Badges are injected asynchronously (plan badge after profile load, the
    // request button 350ms after load) — re-place in case the cluster itself
    // was rebuilt by a late feature module.
    window.addEventListener('load', function () { setTimeout(placeDock, 500); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
