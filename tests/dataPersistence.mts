/** Real IPC handlers + filesystem, isolated userData; no native windows/network. */
import { createRequire } from 'node:module';
import Module from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const parent = path.resolve('tmp'); fs.mkdirSync(parent, { recursive: true });
const dir = fs.mkdtempSync(path.join(parent, 'backup-tests-'));
const exportPath = path.join(dir, 'portable.json');
const handlers = new Map<string, (...args: any[]) => any>();
const loader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = loader._load;
loader._load = function(request, from, main) {
  if (request === 'electron') return {
    app: { getPath: () => dir, getAppPath: () => process.cwd(), requestSingleInstanceLock: () => true, on: () => {}, whenReady: () => new Promise(() => {}) },
    ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) },
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: exportPath }), showOpenDialog: async () => ({ canceled: false, filePaths: [exportPath] }) },
  };
  return originalLoad.call(this, request, from, main);
};
const { APP_SETTINGS_DEFAULTS } = require('../src/types/chess') as typeof import('../src/types/chess');
const { decodeDataBundle } = require('../electron/dataBundle') as typeof import('../electron/dataBundle');
let count = 0;
const check = (name: string, value: unknown) => { assert.ok(value, name); count++; console.log(`  OK ${name}`); };
try {
  require('../electron/main');
  loader._load = originalLoad;
  const invoke = (name: string, ...args: unknown[]) => handlers.get(name)!(null, ...args);
  const zero = { brilliant: 0, great: 0, best: 0, excellent: 0, good: 0, book: 0, inaccuracy: 0, mistake: 0, blunder: 0, miss: 0 };
  const game = { id: 'game_0000000000000001', white: 'Alice', black: 'Bob', pgn: '1. e4 *', createdAt: '2026-10-21T00:00:00Z', date: '2026.10.20', result: '*', accuracyWhite: 90, accuracyBlack: 90, summaryWhite: zero, summaryBlack: zero, moves: [] };
  await invoke('settings:save', { ...APP_SETTINGS_DEFAULTS, playerName: 'Alice' });
  await invoke('db:save-game', game);
  const learning = { 'personal-chess-analyzer-reviews-v1:local-profile': JSON.stringify({ version: 1, reviews: { 'card:1': { dueAt: 10000, intervalIdx: 0, lapses: 1, helps: 0, attempts: 1, correct: 0 } } }), 'personal-chess-analyzer-repertoires-v2:local-profile': '["course:caro-kann"]' };
  const backup = invoke('app:create-backup', learning);
  check('Backup includes local learning history', JSON.stringify(JSON.parse(fs.readFileSync(path.join(backup.path, 'learning_storage.json'), 'utf8'))) === JSON.stringify(learning));
  check('Local backup is directly restorable', decodeDataBundle(fs.readFileSync(path.join(backup.path, 'app-backup.json'), 'utf8')).games.length === 1);
  check('Portable export succeeds', await invoke('app:export-data', learning) === exportPath);
  const bundle = await invoke('app:inspect-data');
  check('Preview contains profile and all learning storage', bundle.settings.playerName === 'Alice' && Object.keys(bundle.learningStorage).length === 2);
  await invoke('db:save-game', { ...game, id: 'game_0000000000000002' });
  await invoke('settings:save', { playerName: 'Renamed' });
  fs.writeFileSync(path.join(dir, 'lichess_jobs.json'), JSON.stringify({ version: 1, knownIds: ['lichess:missing-from-backup'], jobs: [] }));
  bundle.settings.stockfishPath = 'untrusted-backup-engine.exe';
  await invoke('app:restore-data', bundle);
  check('Restore replaces archive with previewed content', (await invoke('db:get-games')).length === 1);
  check('Restore restores profile', (await invoke('settings:get')).playerName === 'Alice');
  check('Restore resets discovery caches so missing games can sync again', JSON.parse(fs.readFileSync(path.join(dir, 'lichess_jobs.json'), 'utf8')).knownIds.length === 0);
  check('Portable backup cannot select another executable', (await invoke('settings:get')).stockfishPath !== 'untrusted-backup-engine.exe');
  await invoke('db:save-game', { ...game, id: 'game_0000000000000002' });
  const rename = fs.renameSync;
  const { writeJsonFileAtomic } = require('../electron/jsonStore') as typeof import('../electron/jsonStore');
  const retryPath = path.join(dir, 'retry.json');
  let retries = 0;
  fs.renameSync = (source, target) => {
    if (process.platform === 'win32' && target === retryPath && retries++ < 2) throw Object.assign(new Error('Transient sharing violation'), { code: 'EPERM' });
    return rename(source, target);
  };
  try { writeJsonFileAtomic(retryPath, { saved: true }); }
  finally { fs.renameSync = rename; }
  check('Windows transient sharing errors retry atomically', JSON.parse(fs.readFileSync(retryPath, 'utf8')).saved === true && (process.platform !== 'win32' || retries === 3));
  let failed = false;
  fs.renameSync = (source, target) => {
    if (!failed && target === path.join(dir, 'settings.json')) { failed = true; throw new Error('Simulated settings write failure'); }
    return rename(source, target);
  };
  try { assert.throws(() => invoke('app:restore-data', bundle), /Simulated/); }
  finally { fs.renameSync = rename; }
  check('Failed restore rolls archive back', (await invoke('db:get-games')).length === 2);
  check('Failed restore retains valid settings', (await invoke('settings:get')).playerName === 'Alice');
  const corrupt = JSON.parse(fs.readFileSync(exportPath, 'utf8')); corrupt.checksum = 'invalid'; fs.writeFileSync(exportPath, JSON.stringify(corrupt));
  await assert.rejects(invoke('app:inspect-data'), /Prüfsumme/); count++;
  console.log(`Persistence: ${count} checks passed.`);
} finally {
  loader._load = originalLoad;
  // The only recursive delete targets the freshly created, verified test directory.
  if (path.dirname(path.resolve(dir)) !== parent || !path.basename(dir).startsWith('backup-tests-')) throw new Error('Unsafe test cleanup path');
  fs.rmSync(dir, { recursive: true, force: true });
}
