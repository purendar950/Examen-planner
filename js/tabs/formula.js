/* ══════════════════════════════════════════════
   CALCULATION & FORMULA TAB
   Lazy-loads the standalone Calc Master formula page (formula/index.html)
   into an iframe and bridges the app's light/dark theme into that document.
══════════════════════════════════════════════ */
(function () {
  var loaded = false;
  var THEME_STYLE_ID = 'ez-formula-theme-bridge';

  function resizeFrame() {
    var frame = document.getElementById('formula-frame');
    if (!frame || !frame.contentDocument || !frame.contentDocument.body) return;
    var doc = frame.contentDocument;
    var height = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight);
    if (height > 150) frame.style.height = height + 'px';
  }

  function getTheme() {
    return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  }

  function getColorfulCardStyles(theme) {
    var accents = theme === 'dark'
      ? ['#34D399', '#60A5FA', '#A78BFA', '#FB7185', '#FBBF24', '#22D3EE']
      : ['#047857', '#1D4ED8', '#6D28D9', '#BE123C', '#B45309', '#0E7490'];
    var rgbValues = ['52,211,153', '96,165,250', '167,139,250', '251,113,133', '251,191,36', '34,211,238'];
    var tintAlpha = theme === 'dark' ? '.14' : '.08';
    var borderAlpha = theme === 'dark' ? '.34' : '.24';
    var iconAlpha = theme === 'dark' ? '.16' : '.10';
    var rules = '';

    accents.forEach(function (accent, index) {
      var position = index + 1;
      rules +=
        'body .chapter-card:nth-child(6n+' + position + '),' +
        'body .section-card:nth-child(6n+' + position + '),' +
        'body .formula-card:nth-child(6n+' + position + '){' +
          '--ez-card-accent:' + accent + ';' +
          '--ez-card-rgb:' + rgbValues[index] + ';' +
        '}';
    });

    return rules +
      'body :is(.chapter-card,.section-card,.formula-card){' +
        'position:relative;overflow:hidden;' +
        'background:linear-gradient(135deg,rgba(var(--ez-card-rgb),'+ tintAlpha +'),transparent 62%),var(--ez-formula-card)!important;' +
        'border-color:rgba(var(--ez-card-rgb),'+ borderAlpha +')!important;' +
        'box-shadow:0 8px 22px rgba(0,0,0,' + (theme === 'dark' ? '.18' : '.07') + ')!important;' +
      '}' +
      'body :is(.chapter-card,.section-card,.formula-card)::before{' +
        'content:"";position:absolute;inset:0 auto 0 0;width:3px;background:var(--ez-card-accent);opacity:.92;' +
      '}' +
      'body :is(.chapter-card,.section-card){transition:transform .18s ease,border-color .18s ease,box-shadow .18s ease!important;}' +
      'body :is(.chapter-card,.section-card):hover{' +
        'transform:translateY(-3px);border-color:var(--ez-card-accent)!important;' +
        'box-shadow:0 14px 30px rgba(var(--ez-card-rgb),' + (theme === 'dark' ? '.18' : '.14') + ')!important;' +
      '}' +
      'body .chapter-card .chapter-icon{' +
        'display:inline-grid;place-items:center;min-width:36px;height:36px;padding:0 8px;margin-right:10px;' +
        'background:rgba(var(--ez-card-rgb),'+ iconAlpha +')!important;' +
        'border:1px solid rgba(var(--ez-card-rgb),'+ borderAlpha +');border-radius:10px;' +
        'color:var(--ez-card-accent)!important;font-weight:800;' +
      '}' +
      'body :is(.chapter-card,.section-card) .go-arrow{color:var(--ez-card-accent)!important;}' +
      'body .chapter-card .tag{' +
        'background:rgba(var(--ez-card-rgb),'+ iconAlpha +')!important;' +
        'border:1px solid rgba(var(--ez-card-rgb),'+ borderAlpha +')!important;' +
        'color:var(--ez-card-accent)!important;' +
      '}' +
      'body .formula-card .formula-card-formula{' +
        'background:linear-gradient(135deg,rgba(var(--ez-card-rgb),'+ iconAlpha +'),transparent 75%),var(--ez-formula-surface)!important;' +
        'border-left-color:var(--ez-card-accent)!important;' +
      '}' +
      'body .formula-card .formula-card-trick{' +
        'background:rgba(var(--ez-card-rgb),'+ iconAlpha +')!important;' +
        'border-color:rgba(var(--ez-card-rgb),'+ borderAlpha +')!important;' +
        'color:var(--ez-formula-text)!important;' +
      '}' +
      'body .formula-card .formula-card-title{color:var(--ez-card-accent)!important;}' +
      'body .formula-card .formula-card-title :is(.katex,.katex *){color:var(--ez-card-accent)!important;border-color:var(--ez-card-accent)!important;}' +
      'body .formula-card .katex-display{' +
        'background:linear-gradient(135deg,rgba(var(--ez-card-rgb),'+ iconAlpha +'),transparent 72%),var(--ez-formula-surface)!important;' +
        'border-left-color:var(--ez-card-accent)!important;' +
      '}' +
      '@media (prefers-reduced-motion:reduce){body :is(.chapter-card,.section-card){transition:none!important;}}';
  }

  function getThemeStyles(theme) {
    var palette = theme === 'dark'
      ? { bg: '#0A0D12', surface: '#111620', card: '#161B26', border: '#1E2535', text: '#EAF0F7', muted: '#9BA7B8', soft: 'rgba(0,200,150,.10)' }
      : { bg: '#F4F7FA', surface: '#EEF3F8', card: '#FFFFFF', border: '#DCE4EE', text: '#16202E', muted: '#5D687A', soft: 'rgba(0,200,150,.10)' };

    return ':root{' +
      '--ez-formula-bg:' + palette.bg + ';' +
      '--ez-formula-surface:' + palette.surface + ';' +
      '--ez-formula-card:' + palette.card + ';' +
      '--ez-formula-border:' + palette.border + ';' +
      '--ez-formula-text:' + palette.text + ';' +
      '--ez-formula-muted:' + palette.muted + ';' +
      '--ez-formula-accent:#00C896;' +
      '--ez-formula-soft:' + palette.soft + ';' +
      '--bg:' + palette.bg + ';' +
      '--card:' + palette.card + ';' +
      '--accent:#00C896;' +
      '--accent2:#34D6AE;' +
      '--text:' + palette.text + ';' +
      '--muted:' + palette.muted + ';' +
      '--border:' + palette.border + ';' +
    '}' +
    'html{background:var(--ez-formula-bg)!important;color:var(--ez-formula-text)!important;color-scheme:' + theme + ';}' +
    'body{background:var(--ez-formula-bg)!important;color:var(--ez-formula-text)!important;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;}' +
    '.topnav{background:' + (theme === 'dark' ? 'rgba(10,13,18,.94)' : 'rgba(255,255,255,.94)') + '!important;border-color:var(--ez-formula-border)!important;}' +
    'body :is(.chapter-card-title,.section-card-title,.formula-card-title,.chapter-card-count,.formula-search-title,.formula-result-title){color:var(--ez-formula-text)!important;}' +
    'body :is(.topbar,.crumb,.formula-card-note,.formula-search-help,.formula-search-status){color:var(--ez-formula-muted)!important;}' +
    'body :is(h1,h2,h3,h4,h5,h6,strong,b){color:var(--ez-formula-text)!important;}' +
    'body :is(p,small,label,li,td,th){color:var(--ez-formula-text);}' +
    'body a{color:var(--ez-formula-accent)!important;}' +
    'body :is(button,[role="button"],input[type="button"],input[type="submit"],input[type="reset"]){background:var(--ez-formula-surface)!important;border-color:var(--ez-formula-border)!important;color:var(--ez-formula-text)!important;border-radius:8px!important;}' +
    'body :is(button,[role="button"],input[type="button"],input[type="submit"],input[type="reset"]):hover{border-color:var(--ez-formula-accent)!important;color:var(--ez-formula-accent)!important;}' +
    'body :is(input:not([type="checkbox"]):not([type="radio"]),select,textarea){background:var(--ez-formula-surface)!important;border-color:var(--ez-formula-border)!important;color:var(--ez-formula-text)!important;border-radius:8px!important;}' +
    'body :is(input,select,textarea):focus{border-color:var(--ez-formula-accent)!important;outline-color:var(--ez-formula-accent)!important;}' +
    'body :is(table,th,td){border-color:var(--ez-formula-border)!important;}' +
    'body :is(th,thead){background:var(--ez-formula-surface)!important;}' +
    'body :is(pre,code){background:var(--ez-formula-surface)!important;color:var(--ez-formula-text)!important;border-color:var(--ez-formula-border)!important;}' +
    'body :is(article,section,div)[class*="formula"],body :is(article,section,div)[class*="equation"],body :is(article,section,div)[class*="calculation"],body :is(article,section,div)[class*="result"],body :is(article,section,div)[class*="card"],body :is(article,section,div)[class*="panel"]{background-color:var(--ez-formula-card)!important;border-color:var(--ez-formula-border)!important;color:var(--ez-formula-text)!important;}' +
    'body :is(.katex,mjx-container){color:var(--ez-formula-text)!important;}' +
    'body :is(.katex-display,mjx-container[display="true"]){display:block;overflow-x:auto;background:linear-gradient(135deg,var(--ez-formula-soft),transparent 62%),var(--ez-formula-surface)!important;border:1px solid var(--ez-formula-border)!important;border-left:3px solid var(--ez-formula-accent)!important;border-radius:10px!important;margin:1rem 0!important;padding:.8rem 1rem!important;color:var(--ez-formula-text)!important;}' +
    'body img{border-radius:8px;}' +
    getColorfulCardStyles(theme);
  }

  function applyFormulaTheme() {
    var frame = document.getElementById('formula-frame');
    if (!frame || !frame.contentDocument || !frame.contentDocument.head) return;

    try {
      var doc = frame.contentDocument;
      var theme = getTheme();
      var style = doc.getElementById(THEME_STYLE_ID);
      if (!style) {
        style = doc.createElement('style');
        style.id = THEME_STYLE_ID;
        doc.head.appendChild(style);
      }
      doc.documentElement.dataset.ezTheme = theme;
      style.textContent = getThemeStyles(theme);
    } catch (e) {
      // Keep the standalone page usable if the iframe ever becomes cross-origin.
    }
  }

  function loadFormula() {
    var frame = document.getElementById('formula-frame');
    var loading = document.getElementById('pf-loading');
    if (!frame) return;
    if (loaded) {
      applyFormulaTheme();
      resizeFrame();
      return;
    }
    loaded = true;

    frame.addEventListener('load', function () {
      applyFormulaTheme();
      if (loading) loading.style.display = 'none';
      resizeFrame();
      try {
        frame.contentWindow.addEventListener('hashchange', function () {
          setTimeout(function () {
            applyFormulaTheme();
            resizeFrame();
          }, 60);
        });
      } catch (e) {}
      setTimeout(function () {
        applyFormulaTheme();
        resizeFrame();
      }, 120);
    });
    frame.src = 'formula/index.html?v=2';
  }

  if (typeof onPageActivated === 'function') {
    onPageActivated('formula', loadFormula);
  }

  if (window.MutationObserver) {
    new MutationObserver(function () {
      if (loaded) applyFormulaTheme();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
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
