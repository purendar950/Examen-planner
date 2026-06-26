import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const rootDir = resolve(import.meta.dirname);
const outDir = resolve(rootDir, 'dist');
const legacyDirectories = ['css', 'js', 'pages'];
const legacyFiles = ['PrepPath.png', 'dashboard-demo.html', 'recurring-demo.html'];

function copyLegacyStaticAssets() {
  return {
    name: 'copy-legacy-static-assets',
    closeBundle() {
      mkdirSync(outDir, { recursive: true });

      legacyDirectories.forEach((dir) => {
        const from = resolve(rootDir, dir);
        if (existsSync(from)) cpSync(from, resolve(outDir, dir), { recursive: true });
      });

      legacyFiles.forEach((file) => {
        const from = resolve(rootDir, file);
        if (existsSync(from)) cpSync(from, resolve(outDir, file));
      });
    }
  };
}

export default defineConfig({
  appType: 'mpa',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(rootDir, 'index.html'),
        app: resolve(rootDir, 'app.html'),
        admin: resolve(rootDir, 'admin.html')
      }
    }
  },
  plugins: [copyLegacyStaticAssets()]
});
