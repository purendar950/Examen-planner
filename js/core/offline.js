/* Offline shell, install prompt, and reconnect replay controller. */
(function () {
  var registration = null;
  var installPrompt = null;
  var reloadingForUpdate = false;

  function setStatus(state, label) {
    if (typeof setSyncStatus === 'function') {
      setSyncStatus(state, label);
    } else {
      var indicator = document.getElementById('sync-indicator');
      var text = document.getElementById('sync-label');
      if (indicator) indicator.className = 'sync-indicator ' + (state || '');
      if (text) text.textContent = label || '';
    }

    var shellStatus = document.querySelector('.shell-sidebar-status');
    var shellCopy = shellStatus && shellStatus.querySelector('.shell-status-text span');
    if (shellStatus) shellStatus.classList.toggle('is-offline', state === 'offline');
    if (shellCopy) shellCopy.textContent = state === 'offline' ? 'Progress saved on this device' : 'Progress synced to cloud';
  }

  function showUpdateReady(worker) {
    var indicator = document.getElementById('sync-indicator');
    setStatus('update', 'Update ready — reload');
    if (!indicator) return;
    indicator.setAttribute('role', 'button');
    indicator.setAttribute('tabindex', '0');
    indicator.title = 'Reload to use the latest version';

    function activateUpdate(event) {
      if (event && event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
      if (event) event.preventDefault();
      worker.postMessage({ type: 'SKIP_WAITING' });
    }

    indicator.onclick = activateUpdate;
    indicator.onkeydown = activateUpdate;
  }

  async function replayPendingState() {
    if (typeof currentUser === 'undefined' || !currentUser || typeof saveProgressNow !== 'function') return;
    setStatus('saving', 'Back online — syncing');
    try {
      await saveProgressNow();
    } catch (error) {
      console.warn('[offline] reconnect sync failed', error);
      setStatus('error', 'Sync retry pending');
    }
  }

  function updateConnectivity() {
    if (navigator.onLine === false) {
      setStatus('offline', 'Offline — saved on device');
      return;
    }
    replayPendingState();
  }

  function bindInstallPrompt() {
    var button = document.getElementById('pwa-install-button');
    window.addEventListener('beforeinstallprompt', function (event) {
      event.preventDefault();
      installPrompt = event;
      if (button) button.hidden = false;
    });

    if (button) {
      button.addEventListener('click', async function () {
        if (!installPrompt) return;
        installPrompt.prompt();
        await installPrompt.userChoice;
        installPrompt = null;
        button.hidden = true;
      });
    }
    window.addEventListener('appinstalled', function () {
      installPrompt = null;
      if (button) button.hidden = true;
    });
  }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    try {
      var serviceWorkerUrl = new URL('sw.js', window.location.href);
      registration = await navigator.serviceWorker.register(serviceWorkerUrl.href, { scope: './' });

      if (registration.waiting) showUpdateReady(registration.waiting);
      registration.addEventListener('updatefound', function () {
        var installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', function () {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateReady(installing);
          }
        });
      });

      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (reloadingForUpdate) return;
        reloadingForUpdate = true;
        window.location.reload();
      });
    } catch (error) {
      console.warn('[offline] service worker registration failed', error);
    }
  }

  window.addEventListener('online', updateConnectivity);
  window.addEventListener('offline', updateConnectivity);

  function initOfflineController() {
    bindInstallPrompt();
    registerServiceWorker();
    if (navigator.onLine === false) updateConnectivity();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initOfflineController, { once: true });
  } else {
    initOfflineController();
  }
})();
