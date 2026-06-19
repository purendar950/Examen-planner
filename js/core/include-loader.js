/* ═══════════════════════════════════════════════════════════════
   HTML INCLUDE LOADER
   Pulls each tab's markup from pages/*.html into the page and swaps
   the placeholder <div data-include="..."> with the partial's real
   markup (via outerHTML), so the resulting DOM is identical to the
   original single-file layout.

   WHY SYNCHRONOUS:
   This script runs BEFORE every app script (firebase.js, tabs/*, …).
   Those scripts (and the post-login render functions) expect the page
   containers — #page-dashboard, #page-planner, .main-content, etc. —
   to already exist. A synchronous fetch guarantees the partials are
   injected before any of that code runs, with no race conditions.

   NOTE: like the rest of the app (Firebase, YouTube API), this needs
   to be served over http(s) — e.g. GitHub Pages or any local server.
   Opening app.html directly from disk (file://) will block the fetch.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  var placeholders = Array.prototype.slice.call(
    document.querySelectorAll('[data-include]')
  );

  placeholders.forEach(function (el) {
    var url = el.getAttribute('data-include');
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, false); // synchronous — must finish before app scripts
      xhr.send(null);
      if (xhr.status >= 200 && xhr.status < 300) {
        // Replace the placeholder entirely so no extra wrapper remains.
        el.outerHTML = xhr.responseText;
      } else {
        console.error('[include-loader] Failed to load', url, '— HTTP', xhr.status);
      }
    } catch (e) {
      console.error('[include-loader] Error loading', url, e);
    }
  });
})();
