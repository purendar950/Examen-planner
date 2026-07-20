import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(projectRoot, 'public/vendor');

const vendorAssets = [
  ['node_modules/firebase/firebase-app-compat.js', 'firebase-app-compat.js'],
  ['node_modules/firebase/firebase-auth-compat.js', 'firebase-auth-compat.js'],
  ['node_modules/firebase/firebase-firestore-compat.js', 'firebase-firestore-compat.js'],
  ['node_modules/firebase/firebase-storage-compat.js', 'firebase-storage-compat.js'],
  ['node_modules/@supabase/supabase-js/dist/umd/supabase.js', 'supabase.js']
];

mkdirSync(outputDirectory, { recursive: true });

for (const [sourcePath, outputName] of vendorAssets) {
  const source = resolve(projectRoot, sourcePath);
  if (!existsSync(source)) {
    throw new Error(`Missing ${sourcePath}. Run npm install before syncing vendor assets.`);
  }

  copyFileSync(source, resolve(outputDirectory, outputName));
}

console.log(`Synced ${vendorAssets.length} package-managed browser assets to public/vendor/.`);
