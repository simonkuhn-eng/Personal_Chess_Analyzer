#!/usr/bin/env node
/**
 * Erstellt ein eigenständiges, portables Windows-App-Paket unter:
 *   release/PersonalChessAnalyzer-win32-x64/
 *
 * Bündelt direkt aus dem lokalen `node_modules/electron/dist` (offline-fähig,
 * ohne langsame NSIS/winCodeSign-Downloads) inklusive Frontend (`dist/`),
 * Main-Prozess (`dist-electron/`), benötigter Runtime-Abhängigkeiten (`chess.js`)
 * und Stockfish-Engine (`resources/app/engine/stockfish.exe`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { builtinModules, createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const APP_EXE_NAME = 'PersonalChessAnalyzer.exe';
const RELEASE_DIR = path.join(ROOT_DIR, 'release');
const OUT_DIR = path.join(RELEASE_DIR, 'PersonalChessAnalyzer-win32-x64');
const STAGING_DIR = path.join(RELEASE_DIR, '.staging-PersonalChessAnalyzer-win32-x64');
const OLD_DIR = path.join(RELEASE_DIR, '.old-PersonalChessAnalyzer-win32-x64');

const args = new Set(process.argv.slice(2));
const SKIP_BUILD = args.has('--skip-build');
const SKIP_TYPECHECK = args.has('--skip-typecheck');
const VERIFY_ONLY = args.has('--verify-only');

const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((mod) => (mod.startsWith('node:') ? mod : `node:${mod}`)),
  'electron',
]);

function logStep(step, message) {
  console.log(`\n[${step}] ${message}`);
}

function fail(message) {
  console.error(`\n[FEHLER] ${message}`);
  process.exit(1);
}

function runNpmScript(scriptName) {
  if (!/^[a-zA-Z0-9:_-]+$/.test(scriptName)) {
    fail(`Ungültiger npm-Skriptname: ${scriptName}`);
  }
  const result =
    process.platform === 'win32'
      ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm run ${scriptName}`], {
          cwd: ROOT_DIR,
          stdio: 'inherit',
        })
      : spawnSync('npm', ['run', scriptName], {
          cwd: ROOT_DIR,
          stdio: 'inherit',
        });
  if (result.error) {
    fail(`Aufruf von "npm run ${scriptName}" fehlgeschlagen: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`"npm run ${scriptName}" wurde mit Exit-Code ${result.status} beendet.`);
  }
}

const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  if (ms > 0) {
    Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
  }
}

function isLockError(err) {
  const code = err && typeof err === 'object' ? err.code : '';
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY';
}

function retryFsSync(operation, { attempts = 6, baseDelayMs = 150 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return operation();
    } catch (err) {
      lastError = err;
      if (!isLockError(err) || attempt >= attempts) {
        throw err;
      }
      sleepSync(baseDelayMs * attempt);
    }
  }
  throw lastError;
}

function ensureAppNotLocked(targetDir) {
  if (!fs.existsSync(targetDir)) return;
  const lockCheckTargets = [
    path.join(targetDir, APP_EXE_NAME),
    path.join(targetDir, 'resources', 'app', 'engine', 'stockfish.exe'),
  ];
  for (const filePath of lockCheckTargets) {
    if (!fs.existsSync(filePath)) continue;
    try {
      retryFsSync(
        () => {
          const fd = fs.openSync(filePath, 'r+');
          fs.closeSync(fd);
        },
        { attempts: 3, baseDelayMs: 150 }
      );
    } catch (err) {
      if (isLockError(err)) {
        const code = err && typeof err === 'object' ? err.code : '';
        fail(
          `${path.basename(filePath)} läuft aktuell noch oder eine Datei in "${targetDir}" ist gesperrt (${code}). ` +
          'Bitte die Anwendung schließen (oder update.bat verwenden) und erneut versuchen.'
        );
      }
      throw err;
    }
  }
}

function collectRelativeTree(rootDir, prefix = '', out = { files: [], dirs: [] }) {
  if (!fs.existsSync(rootDir)) return out;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const relPath = prefix ? path.join(prefix, entry.name) : entry.name;
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      out.dirs.push(relPath);
      collectRelativeTree(fullPath, relPath, out);
    } else {
      out.files.push(relPath);
    }
  }
  return out;
}

function wrapRelPathError(action, relPath, err) {
  const message = `${action} "${relPath}" fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`;
  const wrapped = new Error(message);
  if (err && typeof err === 'object' && 'code' in err) {
    wrapped.code = err.code;
  }
  wrapped.relPath = relPath;
  return wrapped;
}

/**
 * Spiegelt Staging-Inhalte direkt in ein bestehendes Zielverzeichnis,
 * falls Windows den Zielordner wegen eines Ordner-Handles nicht umbenennen lässt.
 */
function mirrorDirectoryInPlace(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const srcTree = collectRelativeTree(srcDir);
  const srcFilesSet = new Set(srcTree.files.map((p) => p.toLowerCase()));
  const srcDirsSet = new Set(srcTree.dirs.map((p) => p.toLowerCase()));

  for (const relSubDir of srcTree.dirs) {
    const destSubDir = path.join(destDir, relSubDir);
    try {
      if (fs.existsSync(destSubDir) && !fs.lstatSync(destSubDir).isDirectory()) {
        retryFsSync(() => fs.rmSync(destSubDir, { force: true }));
      }
      fs.mkdirSync(destSubDir, { recursive: true });
    } catch (err) {
      throw wrapRelPathError('Anlegen des Zielordners', relSubDir, err);
    }
  }

  for (const relFile of srcTree.files) {
    const srcPath = path.join(srcDir, relFile);
    const destPath = path.join(destDir, relFile);
    try {
      if (fs.existsSync(destPath) && fs.lstatSync(destPath).isDirectory()) {
        retryFsSync(() => fs.rmSync(destPath, { recursive: true, force: true }));
      }
      retryFsSync(() => fs.copyFileSync(srcPath, destPath));
    } catch (err) {
      throw wrapRelPathError('Kopieren der Datei', relFile, err);
    }
  }

  const destTree = collectRelativeTree(destDir);
  for (const relFile of destTree.files) {
    if (!srcFilesSet.has(relFile.toLowerCase())) {
      const stalePath = path.join(destDir, relFile);
      try {
        retryFsSync(() => fs.rmSync(stalePath, { force: true }));
      } catch (err) {
        throw wrapRelPathError('Entfernen der veralteten Datei', relFile, err);
      }
    }
  }

  const obsoleteDirs = destTree.dirs
    .filter((relSubDir) => !srcDirsSet.has(relSubDir.toLowerCase()))
    .sort((a, b) => b.split(path.sep).length - a.split(path.sep).length || b.length - a.length);

  for (const relSubDir of obsoleteDirs) {
    const staleDirPath = path.join(destDir, relSubDir);
    try {
      retryFsSync(() => fs.rmdirSync(staleDirPath), { attempts: 3, baseDelayMs: 100 });
    } catch (err) {
      console.warn(
        `[HINWEIS] Veralteter leerer Unterordner "${relSubDir}" konnte nicht entfernt werden: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
}

function collectFilesRecursive(dirPath, predicate) {
  const results = [];
  if (!fs.existsSync(dirPath)) return results;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFilesRecursive(full, predicate));
    } else if (!predicate || predicate(full, entry.name)) {
      results.push(full);
    }
  }
  return results;
}

function toPackageName(specifier) {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || path.isAbsolute(specifier)) {
    return null;
  }
  if (NODE_BUILTINS.has(specifier) || specifier.startsWith('node:')) {
    return null;
  }
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return specifier.split('/')[0];
}

function scanCompiledExternalPackages(distElectronDir) {
  const packages = new Set();
  const jsFiles = collectFilesRecursive(distElectronDir, (_full, name) => name.endsWith('.js') || name.endsWith('.cjs'));
  const requireRegex = /\brequire\(\s*(['"])([^'"]+)\1\s*\)/g;
  const importRegex = /\bfrom\s+(['"])([^'"]+)\1/g;

  for (const file of jsFiles) {
    const content = fs.readFileSync(file, 'utf8');
    for (const regex of [requireRegex, importRegex]) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(content)) !== null) {
        const pkgName = toPackageName(match[2]);
        if (pkgName && !NODE_BUILTINS.has(pkgName)) {
          packages.add(pkgName);
        }
      }
    }
  }
  return Array.from(packages).sort();
}

function resolveInstalledPackageDir(pkgName, fromDir) {
  // Sucht ausgehend von fromDir aufwärts in node_modules (inkl. Scoped-Packages).
  let current = fromDir;
  while (true) {
    const candidate = path.join(current, 'node_modules', ...pkgName.split('/'));
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  try {
    const req = createRequire(path.join(fromDir, 'package.json'));
    const pkgJson = req.resolve(`${pkgName}/package.json`);
    return path.dirname(pkgJson);
  } catch {
    return null;
  }
}

function collectRuntimeDependencyClosure(entryPackages, rootPkg) {
  const queue = entryPackages.map((name) => ({ name, fromDir: ROOT_DIR }));
  const visited = new Map(); // name -> { dir, pkg }

  while (queue.length > 0) {
    const { name, fromDir } = queue.shift();
    if (NODE_BUILTINS.has(name) || visited.has(name)) continue;

    const pkgDir = resolveInstalledPackageDir(name, fromDir);
    if (!pkgDir) {
      fail(`Benötigtes Runtime-Paket "${name}" wurde in node_modules nicht gefunden. Bitte "npm install" ausführen.`);
    }

    const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    visited.set(name, { dir: pkgDir, pkg: pkgJson });

    const deps = Object.keys(pkgJson.dependencies || {});
    for (const dep of deps) {
      queue.push({ name: dep, fromDir: pkgDir });
    }
    const optDeps = Object.keys(pkgJson.optionalDependencies || {});
    for (const dep of optDeps) {
      if (resolveInstalledPackageDir(dep, pkgDir)) {
        queue.push({ name: dep, fromDir: pkgDir });
      }
    }
  }

  const topLevelDeps = {};
  for (const name of entryPackages) {
    const entry = visited.get(name);
    topLevelDeps[name] =
      (rootPkg.dependencies && rootPkg.dependencies[name]) ||
      (entry && entry.pkg.version ? `^${entry.pkg.version}` : '*');
  }

  return { closure: visited, topLevelDeps };
}

function findStockfishSource() {
  const engineRoot = path.join(ROOT_DIR, 'engine');
  const candidates = [
    path.join(engineRoot, 'stockfish.exe'),
    // Unterstützt entpackte Zip-Ordnerstruktur "engine/stockfish.exe/stockfish.exe"
    path.join(engineRoot, 'stockfish.exe', 'stockfish.exe'),
    path.join(engineRoot, 'stockfish.exe', 'stockfish', 'stockfish-windows-x86-64-universal.exe'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  // Fallback: beliebige .exe direkt/rekursiv in engine/ (C++-Quellordner auslassen)
  const stack = fs.existsSync(engineRoot) ? [engineRoot] : [];
  while (stack.length > 0) {
    const dir = stack.shift();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (['src', 'scripts', 'wiki', '.git'].includes(entry.name)) continue;
        stack.push(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.exe')) {
        return path.join(dir, entry.name);
      }
    }
  }
  return null;
}

function verifyReleaseDir(targetDir, expectedDeps, requireStockfish) {
  const checks = [];
  const exePath = path.join(targetDir, APP_EXE_NAME);
  const defaultAsar = path.join(targetDir, 'resources', 'default_app.asar');
  const appDir = path.join(targetDir, 'resources', 'app');
  const indexHtml = path.join(appDir, 'dist', 'index.html');
  const mainJs = path.join(appDir, 'dist-electron', 'electron', 'main.js');
  const preloadJs = path.join(appDir, 'dist-electron', 'electron', 'preload.js');
  const openingBook = path.join(appDir, 'dist-electron', 'src', 'data', 'openingBook.json');
  const prodPkgPath = path.join(appDir, 'package.json');
  const bundledStockfish = path.join(appDir, 'engine', 'stockfish.exe');

  if (!fs.existsSync(exePath) || !fs.statSync(exePath).isFile() || fs.statSync(exePath).size === 0) {
    fail(`Verifikation fehlgeschlagen: "${exePath}" fehlt oder ist leer.`);
  }
  checks.push(`Executable OK (${APP_EXE_NAME})`);

  if (fs.existsSync(defaultAsar)) {
    fail(`Verifikation fehlgeschlagen: "${defaultAsar}" darf nicht mehr vorhanden sein.`);
  }
  checks.push('resources/default_app.asar entfernt');

  for (const [label, filePath] of [
    ['dist/index.html', indexHtml],
    ['dist-electron/electron/main.js', mainJs],
    ['dist-electron/electron/preload.js', preloadJs],
    ['dist-electron/src/data/openingBook.json', openingBook],
    ['package.json', prodPkgPath],
  ]) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      fail(`Verifikation fehlgeschlagen: "${filePath}" fehlt.`);
    }
    checks.push(`${label} vorhanden`);
  }

  const indexContent = fs.readFileSync(indexHtml, 'utf8');
  if (/\b(?:src|href)="\/assets\//.test(indexContent)) {
    fail('Verifikation fehlgeschlagen: dist/index.html enthält absolute "/assets/"-Pfade statt relativer "./assets/"-Pfade.');
  }

  const prodPkg = JSON.parse(fs.readFileSync(prodPkgPath, 'utf8'));
  const resolvedMain = path.join(appDir, prodPkg.main || '');
  if (!fs.existsSync(resolvedMain)) {
    fail(`Verifikation fehlgeschlagen: package.json main ("${prodPkg.main}") existiert nicht.`);
  }

  const appRequire = createRequire(prodPkgPath);
  for (const dep of expectedDeps) {
    try {
      const resolved = appRequire.resolve(dep);
      if (!resolved.startsWith(appDir)) {
        fail(`Abhängigkeit "${dep}" wurde außerhalb von resources/app aufgelöst: ${resolved}`);
      }
    } catch (err) {
      fail(`Abhängigkeit "${dep}" kann in resources/app nicht geladen werden: ${err.message}`);
    }
  }
  checks.push(`Runtime-Module OK (${expectedDeps.join(', ') || 'keine'})`);

  if (fs.existsSync(bundledStockfish)) {
    const stat = fs.statSync(bundledStockfish);
    if (!stat.isFile() || stat.size === 0) {
      fail(`Verifikation fehlgeschlagen: "${bundledStockfish}" ist keine gültige Datei.`);
    }
    checks.push(`Stockfish OK (${(stat.size / (1024 * 1024)).toFixed(1)} MB unter resources/app/engine/stockfish.exe)`);
  } else if (requireStockfish) {
    fail(`Verifikation fehlgeschlagen: Stockfish wurde unter "${bundledStockfish}" erwartet, fehlt aber.`);
  } else {
    checks.push('Stockfish nicht gebündelt (engine/stockfish.exe lokal nicht vorhanden)');
  }

  return checks;
}

function computeDirectoryStats(dirPath) {
  let bytes = 0;
  let files = 0;
  for (const file of collectFilesRecursive(dirPath)) {
    files += 1;
    bytes += fs.statSync(file).size;
  }
  return { files, bytes };
}

function main() {
  console.log('========================================================');
  console.log('  Personal Chess Analyzer - Windows Standalone Packager');
  console.log('========================================================');

  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  const distElectronDir = path.join(ROOT_DIR, 'dist-electron');

  if (VERIFY_ONLY) {
    const externalDeps = scanCompiledExternalPackages(path.join(OUT_DIR, 'resources', 'app', 'dist-electron'));
    const checks = verifyReleaseDir(OUT_DIR, externalDeps, false);
    console.log('\nVerifikation bestanden:');
    for (const c of checks) console.log(`  - ${c}`);
    return;
  }

  // 1. Kompilieren
  if (!SKIP_BUILD) {
    if (!SKIP_TYPECHECK) {
      logStep('1/6', 'TypeScript-Prüfung (npm run typecheck)...');
      runNpmScript('typecheck');
    }
    logStep('2/6', 'Frontend & Electron bauen (npm run build)...');
    runNpmScript('build');
  } else {
    logStep('1/6', 'Build übersprungen (--skip-build) — verwende vorhandene dist/ & dist-electron/.');
  }

  // 2. Voraussetzungs-Checks
  const electronDistDir = path.join(ROOT_DIR, 'node_modules', 'electron', 'dist');
  const electronExe = path.join(electronDistDir, 'electron.exe');
  if (!fs.existsSync(electronExe)) {
    fail(`Electron-Runtime nicht gefunden unter "${electronExe}". Bitte "npm install" ausführen.`);
  }
  if (!fs.existsSync(path.join(ROOT_DIR, 'dist', 'index.html'))) {
    fail('Build-Ausgabe "dist/index.html" fehlt.');
  }
  if (!fs.existsSync(path.join(distElectronDir, 'electron', 'main.js'))) {
    fail('Build-Ausgabe "dist-electron/electron/main.js" fehlt.');
  }

  ensureAppNotLocked(OUT_DIR);

  // 3. Staging vorbereiten & Electron kopieren
  logStep('3/6', 'Kopiere Electron-Runtime nach Staging-Verzeichnis...');
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  retryFsSync(() => fs.rmSync(STAGING_DIR, { recursive: true, force: true }));
  retryFsSync(() => fs.rmSync(OLD_DIR, { recursive: true, force: true }));

  fs.cpSync(electronDistDir, STAGING_DIR, { recursive: true });
  retryFsSync(() => fs.renameSync(path.join(STAGING_DIR, 'electron.exe'), path.join(STAGING_DIR, APP_EXE_NAME)));

  const defaultAsar = path.join(STAGING_DIR, 'resources', 'default_app.asar');
  if (fs.existsSync(defaultAsar)) {
    retryFsSync(() => fs.rmSync(defaultAsar, { force: true }));
  }

  // 4. resources/app zusammenstellen
  logStep('4/6', 'Erstelle resources/app (dist, dist-electron, package.json, Runtime-Abhängigkeiten)...');
  const appDir = path.join(STAGING_DIR, 'resources', 'app');
  fs.mkdirSync(appDir, { recursive: true });
  fs.cpSync(path.join(ROOT_DIR, 'dist'), path.join(appDir, 'dist'), { recursive: true });
  fs.cpSync(distElectronDir, path.join(appDir, 'dist-electron'), { recursive: true });

  const externalPackages = scanCompiledExternalPackages(distElectronDir);
  const { closure, topLevelDeps } = collectRuntimeDependencyClosure(externalPackages, rootPkg);

  const appNodeModulesDir = path.join(appDir, 'node_modules');
  fs.mkdirSync(appNodeModulesDir, { recursive: true });
  for (const [pkgName, { dir }] of closure.entries()) {
    const destPkgDir = path.join(appNodeModulesDir, ...pkgName.split('/'));
    fs.mkdirSync(path.dirname(destPkgDir), { recursive: true });
    fs.cpSync(dir, destPkgDir, {
      recursive: true,
      filter: (src) => path.basename(src) !== '.bin' && path.basename(src) !== '.git',
    });
  }

  const prodPackageJson = {
    name: rootPkg.name || 'personal-chess-analyzer',
    version: rootPkg.version || '1.0.0',
    description: rootPkg.description || 'Personal Chess Analysis Desktop App',
    main: 'dist-electron/electron/main.js',
    author: rootPkg.author || '',
    license: rootPkg.license || 'MIT',
    dependencies: topLevelDeps,
  };
  fs.writeFileSync(path.join(appDir, 'package.json'), `${JSON.stringify(prodPackageJson, null, 2)}\n`, 'utf8');

  // 5. Stockfish-Engine bündeln (resources/app/engine/stockfish.exe = possiblePaths[0] in electron/stockfish.ts)
  logStep('5/6', 'Bündele Stockfish-Engine...');
  const appEngineDir = path.join(appDir, 'engine');
  fs.mkdirSync(appEngineDir, { recursive: true });
  const engineReadme = path.join(ROOT_DIR, 'engine', 'README.txt');
  if (fs.existsSync(engineReadme)) {
    fs.copyFileSync(engineReadme, path.join(appEngineDir, 'README.txt'));
  }

  const stockfishSrc = findStockfishSource();
  if (stockfishSrc) {
    fs.copyFileSync(stockfishSrc, path.join(appEngineDir, 'stockfish.exe'));
    console.log(`  Quelle: ${path.relative(ROOT_DIR, stockfishSrc)}`);
    console.log('  Ziel:   resources/app/engine/stockfish.exe');
  } else {
    console.warn(
      '  [WARNUNG] Keine Stockfish-.exe unter engine/ gefunden. ' +
      'Die App startet trotzdem, benötigt dann aber stockfish.exe in resources/app/engine/ oder über Einstellungen.'
    );
  }

  // Optionale App-Icons kopieren, falls künftig build/icon.ico existiert
  const optionalIcon = path.join(ROOT_DIR, 'build', 'icon.ico');
  if (fs.existsSync(optionalIcon)) {
    fs.copyFileSync(optionalIcon, path.join(appDir, 'icon.ico'));
  }

  // 6. Staging verifizieren & atomar aktivieren (mit Retries, Rollback und In-Place-Fallback)
  logStep('6/6', 'Prüfe Paketintegrität und aktiviere Release-Ordner...');
  verifyReleaseDir(STAGING_DIR, externalPackages, Boolean(stockfishSrc));

  let movedOutToOld = false;
  let usedInPlaceSync = false;

  try {
    if (fs.existsSync(OUT_DIR)) {
      retryFsSync(() => fs.renameSync(OUT_DIR, OLD_DIR));
      movedOutToOld = true;
    }
    retryFsSync(() => fs.renameSync(STAGING_DIR, OUT_DIR));
  } catch (swapErr) {
    const swapCode = swapErr && typeof swapErr === 'object' ? swapErr.code : '';

    if (movedOutToOld) {
      try {
        if (!fs.existsSync(OUT_DIR) && fs.existsSync(OLD_DIR)) {
          retryFsSync(() => fs.renameSync(OLD_DIR, OUT_DIR));
        }
      } catch (rollbackErr) {
        console.error(
          `[WARNUNG] Rollback von "${OLD_DIR}" nach "${OUT_DIR}" fehlgeschlagen: ${
            rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
          }`
        );
      }
    } else if (fs.existsSync(OUT_DIR) && (swapCode === 'EBUSY' || swapCode === 'EPERM' || swapCode === 'EACCES')) {
      console.warn(
        `[HINWEIS] Zielordner konnte wegen eines Ordner-Handles nicht umbenannt werden (${swapCode}) — aktualisiere Dateien direkt im Zielordner...`
      );
      ensureAppNotLocked(OUT_DIR);
      try {
        mirrorDirectoryInPlace(STAGING_DIR, OUT_DIR);
        usedInPlaceSync = true;
      } catch (syncErr) {
        try {
          retryFsSync(() => fs.rmSync(STAGING_DIR, { recursive: true, force: true }), { attempts: 3, baseDelayMs: 100 });
        } catch {
          // best-effort Cleanup
        }
        const syncCode = syncErr && typeof syncErr === 'object' ? syncErr.code : '';
        const relTarget =
          syncErr && typeof syncErr === 'object' && 'relPath' in syncErr ? ` (Datei: ${syncErr.relPath})` : '';
        if (syncCode === 'EBUSY' || syncCode === 'EPERM' || syncCode === 'EACCES') {
          fail(
            `Zielordner "${OUT_DIR}" konnte auch direkt nicht vollständig aktualisiert werden (${syncCode})${relTarget}. ` +
            'Bitte PersonalChessAnalyzer.exe (und ggf. Explorer-Fenster im Release-Ordner) schließen und erneut versuchen.'
          );
        }
        throw syncErr;
      }
    }

    if (!usedInPlaceSync) {
      try {
        retryFsSync(() => fs.rmSync(STAGING_DIR, { recursive: true, force: true }), { attempts: 3, baseDelayMs: 100 });
      } catch {
        // best-effort Cleanup
      }
      if (swapCode === 'EBUSY' || swapCode === 'EPERM' || swapCode === 'EACCES') {
        fail(
          `Zielordner "${OUT_DIR}" konnte nicht ersetzt werden (${swapCode}). ` +
          'Bitte PersonalChessAnalyzer.exe (und ggf. Explorer-Fenster im Release-Ordner) schließen und erneut versuchen.'
        );
      }
      throw swapErr;
    }
  }

  if (usedInPlaceSync && fs.existsSync(STAGING_DIR)) {
    try {
      retryFsSync(() => fs.rmSync(STAGING_DIR, { recursive: true, force: true }));
    } catch {
      console.warn(`[HINWEIS] Temporärer Staging-Ordner "${STAGING_DIR}" wird beim nächsten Lauf entfernt.`);
    }
  }

  if (fs.existsSync(OLD_DIR)) {
    try {
      retryFsSync(() => fs.rmSync(OLD_DIR, { recursive: true, force: true }));
    } catch {
      console.warn(`[HINWEIS] Temporärer Backup-Ordner "${OLD_DIR}" wird beim nächsten Lauf entfernt.`);
    }
  }

  const finalChecks = verifyReleaseDir(OUT_DIR, externalPackages, Boolean(stockfishSrc));
  const { files, bytes } = computeDirectoryStats(OUT_DIR);

  console.log('\n========================================================');
  console.log('  Standalone-Paket erfolgreich erstellt!');
  console.log('========================================================');
  console.log(`  Ausgabe:  ${OUT_DIR}`);
  console.log(`  Start:    ${path.join(OUT_DIR, APP_EXE_NAME)}`);
  console.log(`  Umfang:   ${files} Dateien (${(bytes / (1024 * 1024)).toFixed(1)} MB)`);
  console.log('  Prüfungen:');
  for (const c of finalChecks) {
    console.log(`    ✓ ${c}`);
  }
}

main();
