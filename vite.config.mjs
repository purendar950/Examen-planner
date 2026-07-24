import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const rootDir = resolve(import.meta.dirname);
const outDir = resolve(rootDir, 'dist');
const legacyDirectories = ['css', 'js', 'pages', 'demo', 'assets'];
// test-engine.html is a self-contained page (inline scripts + CDN + relative
// legacy js). It is copied as-is rather than added as a Vite entry, because Vite
// would try to bundle its <script src="js/supabase-config.js"> (an optional file
// that may be absent) and fail the build. Copying keeps it working standalone and
// makes it reachable at /Examen-planner/test-engine.html in production.
// editor.html is the standalone StudyPlanner question editor (opened from the
// Telegram report buttons, in a browser or as a Telegram Mini App). Like
// test-engine.html it is self-contained (inline JS + CDN + relative legacy js),
// so it is copied as-is rather than added as a Vite bundle entry.
const legacyFiles = ['test-engine.html', 'editor.html'];

function copyLegacyStaticAssets() {
  return {
    name: 'copy-legacy-static-assets',
    apply: 'build',
    enforce: 'post',
    closeBundle() {
      console.log('📋 Copying legacy assets to dist...');
      mkdirSync(outDir, { recursive: true });

      legacyDirectories.forEach((dir) => {
        const from = resolve(rootDir, dir);
        const to = resolve(outDir, dir);
        if (existsSync(from)) {
          console.log(`  ✓ Copying ${dir}/ → dist/${dir}/`);
          cpSync(from, to, { recursive: true, force: true });
        }
      });

      legacyFiles.forEach((file) => {
        const from = resolve(rootDir, file);
        const to = resolve(outDir, file);
        if (existsSync(from)) {
          if (file.endsWith('.html')) {
            const html = readFileSync(from, 'utf8').replace(
              /((?:src)\s*=\s*["'])(vendor\/[^"'?]+\.js)(?:\?[^"']*)?(["'])/g,
              (whole, pre, url, post) => {
                const vendorFile = resolve(rootDir, 'public', url);
                if (!existsSync(vendorFile)) return whole;
                const hash = createHash('sha256').update(readFileSync(vendorFile)).digest('hex').slice(0, 8);
                return `${pre}${url}?v=${hash}${post}`;
              }
            );
            writeFileSync(to, html);
          } else {
            cpSync(from, to, { force: true });
          }
          console.log(`  ✓ Copying ${file} → dist/${file}`);
        }
      });
      
      console.log('✅ Legacy assets copied successfully!');
    }
  };
}

// ── Automated cache-busting ────────────────────────────────────────────────
// Vite already content-hashes assets that live in its module graph (the
// `type="module"` entry src/main.js and every <link rel="stylesheet">). But
// this app also loads ~50 classic `<script src="js/...">` files and its HTML
// partials via `data-include="pages/*.html"` — neither is seen by Vite, so
// historically each carried a HAND-TYPED `?v=YYYYMMDDx` token that had to be
// bumped manually on every edit. Forgetting to bump left browsers/CDN serving
// a stale cached copy ("I changed it but the URL is the same").
//
// This plugin removes that manual step: at build time it rewrites every local
// js/ and pages/ reference in the emitted HTML to `?v=<contentHash>`, where the
// hash is the first 8 hex chars of the file's SHA-256. The URL therefore
// changes if and ONLY if that specific file's bytes change — so unchanged files
// stay cached (fast for mobile users) and edited files always cache-bust.
// Source HTML keeps the bare `href="js/..."` / `data-include="pages/..."`; the
// version is injected only into the built output.
function contentHashCacheBust() {
  const hashCache = new Map();
  const hashFor = (relPath) => {
    if (hashCache.has(relPath)) return hashCache.get(relPath);
    let hash = null;
    try {
      const sourcePath = relPath.startsWith('vendor/')
        ? resolve(rootDir, 'public', relPath)
        : resolve(rootDir, relPath);
      const bytes = readFileSync(sourcePath);
      hash = createHash('sha256').update(bytes).digest('hex').slice(0, 8);
    } catch {
      hash = null; // referenced file not on disk → leave unversioned
    }
    hashCache.set(relPath, hash);
    return hash;
  };

  return {
    name: 'content-hash-cache-bust',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return html.replace(
          /((?:href|src|data-include)\s*=\s*["'])([^"']+)(["'])/g,
          (whole, pre, url, post) => {
            // Skip external / protocol-relative / data URLs and Vite's own
            // already-hashed bundle output under assets/.
            if (/^(?:https?:)?\/\//i.test(url) || url.startsWith('data:')) return whole;
            const path = url.split('?')[0].split('#')[0];
            // Only bust the two categories Vite can't fingerprint itself.
            if (!/(?:^|\/)(?:js|pages|css|vendor)\/[^?#]+\.(?:js|html|css)$/.test(path)) return whole;
            // Normalise to a source-relative path by dropping any leading base
            // prefix (e.g. "/Examen-planner/") or "./" before the managed dir.
            const rel = path.replace(/^.*?(?=(?:js|pages|css|vendor)\/)/, '');
            const hash = hashFor(rel);
            // Rebuild with a clean single ?v=; if the file is missing, emit the
            // reference without any stale query string.
            return pre + path + (hash ? '?v=' + hash : '') + post;
          }
        );
      }
    }
  };
}

export default defineConfig({
  // GitHub Pages serves this project from /Examen-planner/, not the domain
  // root. Vite defaults to absolute root-relative asset paths (/assets/...),
  // which 404 on a project Pages site and leave the deployed app unstyled.
  // Setting `base` scopes every built <script>/<link> reference to the
  // correct subpath so CSS/JS actually load in production.
  base: '/Examen-planner/',
  appType: 'mpa',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(rootDir, 'index.html'),
        app: resolve(rootDir, 'app.html'),
        admin: resolve(rootDir, 'admin.html'),
        ytProxyDemo: resolve(rootDir, 'yt-proxy-demo.html'),
        opencodeDemo: resolve(rootDir, 'opencode-demo.html')
      }
    }
  },
  plugins: [contentHashCacheBust(), copyLegacyStaticAssets()]
});
