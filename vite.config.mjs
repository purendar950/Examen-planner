import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const rootDir = resolve(import.meta.dirname);
const outDir = resolve(rootDir, 'dist');
const legacyDirectories = ['css', 'js', 'pages', 'demo'];
const legacyFiles = ['PrepPath.png'];

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
          console.log(`  ✓ Copying ${file} → dist/${file}`);
          cpSync(from, to, { force: true });
        }
      });
      
      console.log('✅ Legacy assets copied successfully!');
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
        ytProxyDemo: resolve(rootDir, 'yt-proxy-demo.html')
      }
    }
  },
  plugins: [copyLegacyStaticAssets()]
});
