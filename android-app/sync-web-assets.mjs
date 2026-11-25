import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const distDir = path.join(repoRoot, 'dist');
const targetDir = path.join(scriptDir, 'android', 'app', 'src', 'main', 'assets', 'public');

function countFilesAndBytes(dirPath) {
  let files = 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const sub = countFilesAndBytes(fullPath);
      files += sub.files;
      bytes += sub.bytes;
    } else if (entry.isFile()) {
      files += 1;
      bytes += fs.statSync(fullPath).size;
    }
  }
  return { files, bytes };
}

const indexPath = path.join(distDir, 'index.html');
if (!fs.existsSync(indexPath)) {
  console.error(`Missing built web bundle at: ${indexPath}`);
  console.error('Run "npm run build" in the repository root first.');
  process.exit(1);
}

fs.rmSync(targetDir, { recursive: true, force: true });
fs.mkdirSync(targetDir, { recursive: true });
fs.cpSync(distDir, targetDir, { recursive: true });

const seedSrc = path.join(scriptDir, 'seed', 'mobile-initial-seed.bin');
if (fs.existsSync(seedSrc)) {
  fs.copyFileSync(seedSrc, path.join(targetDir, 'mobile-initial-seed.bin'));
}

const copiedIndex = path.join(targetDir, 'index.html');
if (!fs.existsSync(copiedIndex)) {
  console.error(`Verification failed: ${copiedIndex} was not created.`);
  process.exit(1);
}

const { files, bytes } = countFilesAndBytes(targetDir);
const kb = (bytes / 1024).toFixed(1);
console.log(`Synced ${files} web asset file(s) (${kb} KB) from "${distDir}" -> "${targetDir}".`);
