import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { StockfishEngine } from './stockfish';
import { ChessDatabase } from './db';
import { fetchLatestGame, fetchMonthlyGames, fetchUserProfile } from './chesscom';
import { cancelJob, claimNextJob, createJob, markJob, readPipeline, resumeStaleJobs } from './chesscomPipeline';
import { cancelLichessJob, claimNextLichessJob, createLichessJob, markLichessJob, readLichessPipeline, resumeStaleLichessJobs } from './lichessPipeline';
import { writeJsonFileAtomic } from './jsonStore';
import { AppSettings, GameAnalysis, APP_SETTINGS_DEFAULTS, normalizeAppSettings } from '../src/types/chess';
import { configureProfile } from '../src/utils/profile';
import { decodeDataBundle, encodeDataBundle, validateDataBundle, validateLearningStorage, type DataBundle } from './dataBundle';
import { emptyPipelineData } from './chesscomPipelineCore';
import { writePipelineFile } from './pipelineStore';
import {
  buildLocalSyncPayload,
  getLanSyncStatus,
  startLanSyncServer,
  stopLanSyncServer,
  syncWithLanPeer,
} from './lanSync';
import type { SyncPayload, SyncSummary } from '../src/utils/lanSyncMerge';
import { AiCoachMcpServer } from './aiCoachMcp';
import { AiCoachService } from './aiCoach';
import type { AiCoachExplainRequest } from '../src/types/aiCoach';

// Single-Instance-Lock: mehrere App-Instanzen würden games_db.json gegenseitig
// beschädigen (T05).
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

let mainWindow: BrowserWindow | null = null;
const engine = new StockfishEngine();
const db = new ChessDatabase();
const aiCoachMcp = new AiCoachMcpServer(engine);
const aiCoach = new AiCoachService(aiCoachMcp, () => app.getPath('userData'));

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings(): AppSettings {
  try {
    const sPath = getSettingsPath();
    if (fs.existsSync(sPath)) {
      // Phase 6: Normalisierung (Typ-Guards + Klampen) — alte settings.json lädt
      // unverändert, fehlende/ungültige Felder erhalten die zentralen Defaults.
      const parsed = JSON.parse(fs.readFileSync(sPath, 'utf-8'));
      const normalized = normalizeAppSettings(parsed, engine.getPath());
      configureProfile(normalized);
      return normalized;
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
  const normalized = normalizeAppSettings(undefined, engine.getPath());
  configureProfile(normalized);
  return normalized;
}

/**
 * Settings-Persistenz: Fehler werden NICHT verschluckt, sondern an den Renderer
 * propagiert (T05) — sonst meldet die UI Erfolg, obwohl nichts gespeichert wurde.
 */
function saveSettings(settings: Partial<AppSettings>): AppSettings {
  const current = loadSettings();
  const updated = normalizeAppSettings({ ...current, ...settings, profileId: current.profileId,
    playerAliases: [...new Set([...current.playerAliases, current.playerName])],
    accountAliases: { chessCom: [...new Set([...current.accountAliases.chessCom, current.chessComUsername])].filter(Boolean), lichess: [...new Set([...current.accountAliases.lichess, current.lichessUsername])].filter(Boolean) },
  }, engine.getPath());
  writeJsonFileAtomic(getSettingsPath(), updated);
  configureProfile(updated);
  return updated;
}

function createWindow() {
  const iconCandidates = [
    path.join(app.getAppPath(), 'icon.ico'),
    path.join(app.getAppPath(), 'build', 'icon.ico'),
    path.join(app.getAppPath(), 'build', 'icon.png'),
    path.join(process.resourcesPath, 'icon.ico'),
  ];
  const windowIcon = iconCandidates.find((candidate) => fs.existsSync(candidate));
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#161512',
    title: 'Personal Chess Analyzer',
    ...(windowIcon ? { icon: windowIcon } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Remove menu bar for clean desktop app aesthetic
  mainWindow.setMenuBarVisibility(false);

  const isDev = process.env.NODE_ENV === 'development';
  const distIndex = path.join(app.getAppPath(), 'dist', 'index.html');

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else if (fs.existsSync(distIndex)) {
    mainWindow.loadFile(distIndex);
  } else {
    mainWindow.loadURL('http://localhost:5173');
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    engine.dispose();
  });
}

const RENDERER_CSP =
  // T22: Renderer nur eigene Ressourcen; React-style-Props brauchen
  // 'unsafe-inline' bei style-src; Dev (Vite-HMR) über ws/localhost; die
  // chess.com-API läuft im Main-Prozess — der Renderer braucht kein externes Netz.
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: http://localhost:* http://127.0.0.1:* http://192.168.*:* http://10.*:* http://172.*:*";

function getLearningBackupPath(): string {
  return path.join(app.getPath('userData'), 'learning_storage.json');
}

async function readLiveLearningStorage(): Promise<Record<string, string>> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      const live = await mainWindow.webContents.executeJavaScript(
        `(() => { const out = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('personal-chess-analyzer-')) out[k] = localStorage.getItem(k); } return out; })()`,
      );
      if (live && typeof live === 'object' && !Array.isArray(live)) {
        return validateLearningStorage(live);
      }
    } catch {
      // Fallback auf letzte Sicherung unten
    }
  }
  try {
    const backupPath = getLearningBackupPath();
    if (fs.existsSync(backupPath)) {
      return validateLearningStorage(JSON.parse(fs.readFileSync(backupPath, 'utf-8')));
    }
  } catch {
    // Keine Sicherung vorhanden
  }
  return {};
}

const execFileAsync = promisify(execFile);

function resolveAdbExecutable(): string {
  const candidates = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe') : '',
    process.env.ANDROID_HOME ? path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb.exe') : '',
    process.env.ANDROID_SDK_ROOT ? path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools', 'adb.exe') : '',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return process.platform === 'win32' ? 'adb.exe' : 'adb';
}

async function prepareAdbSyncTunnel(targetPort: number): Promise<{ ok: boolean; deviceSerial?: string; port: number; message: string }> {
  const adbExe = resolveAdbExecutable();
  try {
    const { stdout } = await execFileAsync(adbExe, ['devices'], { timeout: 6000, windowsHide: true });
    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('List of devices'));
    const connected = lines.find((line) => /\sdevice$/.test(line));
    if (!connected) {
      if (lines.some((line) => /\sunauthorized$/.test(line))) {
        return { ok: false, port: targetPort, message: 'Android-Gerät erkannt, aber USB-Debugging wurde auf dem Handy noch nicht bestätigt.' };
      }
      return { ok: false, port: targetPort, message: 'Kein Android-Gerät per USB/ADB gefunden. Handy anstecken & USB-Debugging aktivieren.' };
    }
    const serial = connected.split(/\s+/)[0];
    await execFileAsync(adbExe, ['-s', serial, 'reverse', `tcp:${targetPort}`, `tcp:${targetPort}`], {
      timeout: 6000,
      windowsHide: true,
    });
    return {
      ok: true,
      deviceSerial: serial,
      port: targetPort,
      message: `USB-Tunnel (ADB) aktiv für ${serial} (Port ${targetPort}). Jetzt am Handy auf „Per USB (ADB) mit PC syncen“ tippen.`,
    };
  } catch (err) {
    const code = err && typeof err === 'object' ? (err as NodeJS.ErrnoException).code : '';
    if (code === 'ENOENT') {
      return {
        ok: false,
        port: targetPort,
        message: 'adb.exe wurde nicht gefunden (Android SDK Platform-Tools fehlen im PATH / AppData). Alternativ WLAN-Sync nutzen.',
      };
    }
    return {
      ok: false,
      port: targetPort,
      message: `ADB-Fehler: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function applyMergedLanSyncPayload(
  merged: SyncPayload,
  summary: SyncSummary,
  notifyRenderer: boolean,
): Promise<void> {
  const currentSettings = loadSettings();
  const safeSettings = normalizeAppSettings(
    { ...merged.settings, stockfishPath: currentSettings.stockfishPath },
    engine.getPath(),
  );
  const safeLearning = validateLearningStorage(merged.learningStorage);

  db.replaceGames(merged.games);
  writeJsonFileAtomic(getSettingsPath(), safeSettings);
  writeJsonFileAtomic(getLearningBackupPath(), safeLearning);
  configureProfile(safeSettings);
  engine.setPath(safeSettings.stockfishPath);
  engine.setEngineOptions(safeSettings.engineThreads, safeSettings.engineHashMb);

  if (notifyRenderer && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('lan-sync:applied', {
      learningStorage: safeLearning,
      summary,
    });
  }
}

app.on('web-contents-created', (_event, contents) => {
  contents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [RENDERER_CSP] },
    });
  });
  // T22: Navigation auf eigene Inhalte begrenzen; externe Links bewusst im
  // Standardbrowser öffnen statt im Electron-Fenster.
  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://') && !url.startsWith('http://localhost:') && !url.startsWith('http://127.0.0.1:')) {
      event.preventDefault();
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
});

app.whenReady().then(() => {
  // T16: hängengebliebene Pipeline-Analysen beim Start fortsetzen (analyzing → queued)
  resumeStaleJobs();
  resumeStaleLichessJobs();

  // Apply saved stockfish path if configured
  const settings = loadSettings();
  if (settings.stockfishPath) {
    engine.setPath(settings.stockfishPath);
  }

  createWindow();

  void startLanSyncServer({
    getLocalPayload: async () =>
      buildLocalSyncPayload(db.exportGames(), loadSettings(), await readLiveLearningStorage()),
    applyMergedPayload: async (merged, summary) => {
      await applyMergedLanSyncPayload(merged, summary, true);
    },
  })
    .then((status) => {
      void prepareAdbSyncTunnel(status.port).catch(() => {});
    })
    .catch((err) => {
      console.warn('LAN-Sync-Server konnte nicht gestartet werden:', err);
    });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  // Letzte Chance: kein Engine-Prozess darf das App-Ende überleben (T01).
  aiCoach.dispose();
  void aiCoachMcp.stop();
  engine.dispose();
  void stopLanSyncServer();
});

// IPC Engine Handlers
ipcMain.handle('engine:get-status', async () => {
  // Rein beobachtend — KEIN init() mehr, das bei jedem Aufruf einen neuen
  // Engine-Prozess erzeugt (T01).
  return engine.getStatus();
});

ipcMain.handle('engine:open-engine-folder', async () => {
  const engineFolder = path.dirname(engine.getPath());
  if (!fs.existsSync(engineFolder)) {
    fs.mkdirSync(engineFolder, { recursive: true });
  }
  await shell.openPath(engineFolder);
  return true;
});

ipcMain.handle('engine:select-file', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Stockfish Executable (stockfish.exe) auswählen',
    filters: [{ name: 'Executables', extensions: ['exe'] }],
    properties: ['openFile'],
  });
  if (!result.canceled && result.filePaths.length > 0) {
    const chosen = result.filePaths[0];
    engine.setPath(chosen);
    saveSettings({ stockfishPath: chosen });
    return chosen;
  }
  return null;
});

ipcMain.handle('engine:set-path', async (_, customPath: string) => {
  const success = engine.setPath(customPath);
  if (success) {
    saveSettings({ stockfishPath: customPath });
  }
  return success;
});

// FEN/Depth/MultiPV an der IPC-Grenze validieren und klemmen (T02/T22).
ipcMain.handle('engine:evaluate-fen', async (_, fen: unknown, depth?: unknown, historyUci?: unknown, currentFen?: unknown, options?: import('../src/types/chess').EngineSearchOptions) => {
  const d = typeof depth === 'number' && Number.isFinite(depth) ? Math.round(depth) : 14;
  const history = Array.isArray(historyUci) ? (historyUci as string[]) : undefined;
  const curFen = typeof currentFen === 'string' && currentFen.length > 0 ? currentFen : undefined;
  return await engine.evaluateFen(fen as string, Math.min(30, Math.max(1, d)), history, curFen, options);
});

ipcMain.handle('engine:cancel-request', (_, requestId: unknown) => {
  if (typeof requestId === 'string' && /^(why|review|ai)-[a-zA-Z0-9-]{1,100}$/.test(requestId)) engine.cancelRequest(requestId);
});

ipcMain.handle('engine:evaluate-fen-multipv', async (_, fen: unknown, depth?: unknown, multiPv?: unknown, historyUci?: unknown, currentFen?: unknown, options?: import('../src/types/chess').EngineSearchOptions) => {
  const d = typeof depth === 'number' && Number.isFinite(depth) ? Math.round(depth) : 14;
  const pv = typeof multiPv === 'number' && Number.isFinite(multiPv) ? Math.round(multiPv) : 3;
  const history = Array.isArray(historyUci) ? (historyUci as string[]) : undefined;
  const curFen = typeof currentFen === 'string' && currentFen.length > 0 ? currentFen : undefined;
  return await engine.evaluateFenMultiPv(fen as string, Math.min(30, Math.max(1, d)), Math.min(5, Math.max(1, pv)), history, curFen, options);
});

// IPC Database Handlers
ipcMain.handle('db:save-game', async (_, game: GameAnalysis) => {
  return db.saveGame(game);
});

// T13: Fehler-/Patzerzähler zählen nur die eigenen Züge des konfigurierten
// Spielers (ArchiveView zeigt "Eigene Patzer")
ipcMain.handle('db:get-games', async () => {
  return db.getGamesAsync(loadSettings().playerName);
});

ipcMain.handle('db:get-game', async (_, id: string) => {
  return db.getGame(id);
});

ipcMain.handle('db:delete-game', async (_, id: string) => {
  return db.deleteGame(id);
});

  ipcMain.handle('db:get-player-stats', async (_, playerName: string, filter?: import('../src/types/statistics').StatisticsFilter) => {
  const settings = loadSettings();
    return db.getPlayerStats(playerName, settings.openingWindowMoves, filter);
});

ipcMain.handle('db:get-stable-game-ids', async () => {
  return db.getStableGameIds();
});

ipcMain.handle('db:get-review-id-map', async () => {
  return db.getReviewIdMap();
});

// IPC Chess.com Handlers
ipcMain.handle('chesscom:fetch-games', async (_, username: string, year: number, month: number) => {
  return fetchMonthlyGames(username, year, month);
});

ipcMain.handle('chesscom:fetch-latest-game', async (_, username: unknown) => {
  if (typeof username !== 'string') throw new Error('Ungültiger Chess.com-Benutzername.');
  return fetchLatestGame(username);
});

// T17: Profil-Existenz-Check — 404 des Monatsarchivs ≠ "Nutzer existiert nicht"
ipcMain.handle('chesscom:fetch-profile', async (_, username: string) => {
  return fetchUserProfile(username);
});

// T16: persistierte Pipeline-Jobs — Discovery im Main-Prozess, Analyse im
// Renderer-Driver (analyzePgnGame nutzt die Renderer-Engine-IPC). Claim ist
// im Main atomar → keine Doppelanalyse paralleler Trigger.
ipcMain.handle('chesscom:jobs:list', () => readPipeline());
// T22: Eingabevalidierung vor Verarbeitung — Renderer-Typen ersetzen keine
// Laufzeitprüfung: Benutzernamen hart begrenzen, Job-IDs als kurze Strings.
const CHESSCOM_USERNAME_RE = /^[A-Za-z0-9_-]{1,30}$/;
const isValidJobId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 64;

ipcMain.handle('chesscom:jobs:create', (_, username: string, daysWindow: number) => {
  if (typeof username !== 'string' || !CHESSCOM_USERNAME_RE.test(username.trim())) {
    throw new Error('Ungültiger chess.com-Benutzername (max. 30 Zeichen, Buchstaben/Zahlen/-/_).');
  }
  return createJob(username, daysWindow);
});
ipcMain.handle('chesscom:jobs:claim', () => claimNextJob());
ipcMain.handle('chesscom:jobs:mark', (_, id: string, patch: Parameters<typeof markJob>[1]) => {
  if (!isValidJobId(id)) throw new Error('Ungültige Job-ID.');
  return markJob(id, patch);
});
ipcMain.handle('chesscom:jobs:cancel', (_, id: string) => {
  if (!isValidJobId(id)) throw new Error('Ungültige Job-ID.');
  return cancelJob(id);
});

// Phase 6: Lichess-Pipeline — Spiegel der chess.com-Pipeline (eigene Datei
// lichess_jobs.json, eigene Quell-IDs lichess:<id>, geteilte Status-Maschine).
const LICHESS_USERNAME_RE = /^[A-Za-z0-9_-]{1,25}$/;
ipcMain.handle('lichess:jobs:list', () => readLichessPipeline());
ipcMain.handle('lichess:jobs:create', (_, username: string, daysWindow: number) => {
  if (typeof username !== 'string' || !LICHESS_USERNAME_RE.test(username.trim())) {
    throw new Error('Ungültiger Lichess-Benutzername (max. 25 Zeichen, Buchstaben/Zahlen/-/_).');
  }
  return createLichessJob(username, daysWindow);
});
ipcMain.handle('lichess:jobs:claim', () => claimNextLichessJob());
ipcMain.handle('lichess:jobs:mark', (_, id: string, patch: Parameters<typeof markLichessJob>[1]) => {
  if (!isValidJobId(id)) throw new Error('Ungültige Job-ID.');
  return markLichessJob(id, patch);
});
ipcMain.handle('lichess:jobs:cancel', (_, id: string) => {
  if (!isValidJobId(id)) throw new Error('Ungültige Job-ID.');
  return cancelLichessJob(id);
});

// IPC Settings Handlers
ipcMain.handle('settings:get', async () => {
  const settings = loadSettings();
  engine.setEngineOptions(settings.engineThreads, settings.engineHashMb);
  return settings;
});

ipcMain.handle('settings:save', async (_, newSettings: Partial<AppSettings>) => {
  // Rejected Promise erreicht den Renderer → UI kann echten Fehler zeigen (T05).
  const updated = saveSettings(newSettings);
  engine.setEngineOptions(updated.engineThreads, updated.engineHashMb);
  return updated;
});

// Phase 6: Datenpfad + Ordner-Öffnung (Daten & Datenschutz)
ipcMain.handle('app:get-data-path', () => app.getPath('userData'));
ipcMain.handle('app:open-data-folder', async () => {
  const err = await shell.openPath(app.getPath('userData'));
  if (err) throw new Error(err);
});

// Phase 6 W3: Backup — Kopie aller JSON-Datendateien in backups/<Zeitstempel>/.
// Keine Token beteiligt: Es werden nur lokale Dateien kopiert, nichts verlässt
// das Geraet. Lernspeicher und ein vollstaendiges Restore-Paket sind enthalten.
ipcMain.handle('app:create-backup', (_, learningStorage: unknown) => {
  const base = app.getPath('userData');
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.hrtime.bigint()}`;
  const dir = path.join(base, 'backups', stamp);
  fs.mkdirSync(dir, { recursive: true });
  let files = 0;
  for (const name of fs.readdirSync(base)) {
    if (!name.endsWith('.json')) continue;
    fs.copyFileSync(path.join(base, name), path.join(dir, name));
    files++;
  }
  writeJsonFileAtomic(path.join(dir, 'learning_storage.json'), validateLearningStorage(learningStorage));
  files++;
  writeJsonFileAtomic(path.join(dir, 'app-backup.json'), JSON.parse(encodeDataBundle({ format: 'personal-chess-analyzer', version: 1, createdAt: new Date().toISOString(), games: db.exportGames(), settings: loadSettings(), learningStorage: validateLearningStorage(learningStorage) })));
  files++;
  if (files === 0) throw new Error('Keine JSON-Datendateien gefunden.');
  return { path: dir, files };
});

ipcMain.handle('app:export-data', async (_, learningStorage: unknown) => {
  const result = await dialog.showSaveDialog({ title: 'Vollständiges Backup exportieren', defaultPath: `chess-backup-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'App-Backup', extensions: ['json'] }] });
  if (result.canceled || !result.filePath) return null;
  const bundle: DataBundle = { format: 'personal-chess-analyzer', version: 1, createdAt: new Date().toISOString(), games: db.exportGames(), settings: loadSettings(), learningStorage: validateLearningStorage(learningStorage) };
  // Atomic writer receives a JSON object, preserving checksum payload exactly.
  writeJsonFileAtomic(result.filePath, JSON.parse(encodeDataBundle(bundle)));
  return result.filePath;
});

ipcMain.handle('app:inspect-data', async () => {
  const result = await dialog.showOpenDialog({ title: 'App-Backup öffnen', properties: ['openFile'], filters: [{ name: 'App-Backup', extensions: ['json'] }] });
  if (result.canceled || !result.filePaths[0]) return null;
  const file = result.filePaths[0];
  if (fs.statSync(file).size > 512 * 1024 * 1024) throw new Error('Backup größer als 512 MB.');
  return decodeDataBundle(fs.readFileSync(file, 'utf8'));
});

ipcMain.handle('app:restore-data', (_, raw: unknown) => {
  const bundle = validateDataBundle(raw);
  const previousGames = db.exportGames();
  const previousSettings = loadSettings();
  const previousPipelines = { chesscom: readPipeline(), lichess: readLichessPipeline() };
  // A portable data file must not select an executable on this machine.
  const restoredSettings = { ...bundle.settings, stockfishPath: previousSettings.stockfishPath };
  // Keep a full safety copy before replacing either file.
  const safety = path.join(app.getPath('userData'), 'backups', `before-restore-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(safety), { recursive: true });
  writeJsonFileAtomic(safety, { games: previousGames, settings: previousSettings });
  try {
    db.replaceGames(bundle.games);
    writeJsonFileAtomic(getSettingsPath(), restoredSettings);
    configureProfile(restoredSettings);
    engine.setPath(restoredSettings.stockfishPath);
    engine.setEngineOptions(restoredSettings.engineThreads, restoredSettings.engineHashMb);
    // Discovery caches from the replaced archive must not hide missing games.
    writePipelineFile(path.join(app.getPath('userData'), 'chesscom_jobs.json'), emptyPipelineData());
    writePipelineFile(path.join(app.getPath('userData'), 'lichess_jobs.json'), emptyPipelineData());
  } catch (error) {
    db.replaceGames(previousGames);
    writeJsonFileAtomic(getSettingsPath(), previousSettings);
    configureProfile(previousSettings);
    writePipelineFile(path.join(app.getPath('userData'), 'chesscom_jobs.json'), previousPipelines.chesscom);
    writePipelineFile(path.join(app.getPath('userData'), 'lichess_jobs.json'), previousPipelines.lichess);
    throw error;
  }
  return true;
});

ipcMain.handle('lan-sync:get-status', () => getLanSyncStatus());

ipcMain.handle('lan-sync:start', async () =>
  startLanSyncServer({
    getLocalPayload: async () =>
      buildLocalSyncPayload(db.exportGames(), loadSettings(), await readLiveLearningStorage()),
    applyMergedPayload: async (merged, summary) => {
      await applyMergedLanSyncPayload(merged, summary, true);
    },
  }),
);

ipcMain.handle('lan-sync:stop', () => stopLanSyncServer());

ipcMain.handle('lan-sync:prepare-adb', async () => {
  const status = await startLanSyncServer({
    getLocalPayload: async () =>
      buildLocalSyncPayload(db.exportGames(), loadSettings(), await readLiveLearningStorage()),
    applyMergedPayload: async (merged, summary) => {
      await applyMergedLanSyncPayload(merged, summary, true);
    },
  });
  return prepareAdbSyncTunnel(status.port);
});

ipcMain.handle('lan-sync:sync-peer', async (_, hostOrIp: unknown, learningStorage: unknown) => {
  if (typeof hostOrIp !== 'string' || !hostOrIp.trim()) {
    throw new Error('Bitte eine gültige IP-Adresse im Heimnetz eingeben.');
  }
  const safeLearning = validateLearningStorage(learningStorage);
  const localPayload = buildLocalSyncPayload(db.exportGames(), loadSettings(), safeLearning);
  const { mergedPayload, summary } = await syncWithLanPeer(hostOrIp, localPayload);
  await applyMergedLanSyncPayload(mergedPayload, summary, false);
  return {
    summary,
    mergedLearningStorage: validateLearningStorage(mergedPayload.learningStorage),
  };
});

ipcMain.handle('ai-coach:get-status', async () => aiCoach.getStatus());

ipcMain.handle('ai-coach:explain', async (_, rawRequest: unknown) => {
  if (!rawRequest || typeof rawRequest !== 'object') {
    return { ok: false, error: 'Ungültige KI-Anfrage.' };
  }
  const r = rawRequest as Record<string, unknown>;
  const requestId = typeof r.requestId === 'string' && /^[a-zA-Z0-9-]{4,100}$/.test(r.requestId)
    ? r.requestId
    : '';
  const fenBefore = typeof r.fenBefore === 'string' ? r.fenBefore.trim() : '';
  const fenAfter = typeof r.fenAfter === 'string' ? r.fenAfter.trim() : fenBefore;
  if (!requestId || !fenBefore || fenBefore.length > 150 || fenAfter.length > 150) {
    return { ok: false, error: 'Ungültige Parameter für die KI-Erklärung.' };
  }

  const modelFamily = r.modelFamily === 'neon' ? 'neon' : 'hydrogen';
  const parsedEffort =
    r.effort === 'low' || r.effort === 'medium' || r.effort === 'high' || r.effort === 'xhigh'
      ? r.effort
      : modelFamily === 'hydrogen'
        ? 'high'
        : 'medium';

  const req: AiCoachExplainRequest = {
    requestId,
    modelFamily,
    effort: modelFamily === 'hydrogen' && (parsedEffort === 'low' || parsedEffort === 'medium') ? 'high' : parsedEffort,
    fenBefore,
    fenAfter,
    moveNumber: typeof r.moveNumber === 'number' && Number.isFinite(r.moveNumber) ? Math.max(0, Math.round(r.moveNumber)) : 1,
    color: r.color === 'b' ? 'b' : 'w',
    playedSan: typeof r.playedSan === 'string' ? r.playedSan.slice(0, 32) : '',
    playedUci: typeof r.playedUci === 'string' ? r.playedUci.slice(0, 10) : '',
    quality: typeof r.quality === 'string' ? r.quality.slice(0, 24) : undefined,
    bestMoveSan: typeof r.bestMoveSan === 'string' ? r.bestMoveSan.slice(0, 32) : undefined,
    bestMoveUci: typeof r.bestMoveUci === 'string' ? r.bestMoveUci.slice(0, 10) : undefined,
    evalBeforeText: typeof r.evalBeforeText === 'string' ? r.evalBeforeText.slice(0, 32) : undefined,
    evalAfterText: typeof r.evalAfterText === 'string' ? r.evalAfterText.slice(0, 32) : undefined,
    bestLineSan: Array.isArray(r.bestLineSan)
      ? r.bestLineSan.filter((s): s is string => typeof s === 'string').slice(0, 8)
      : undefined,
    afterLineSan: Array.isArray(r.afterLineSan)
      ? r.afterLineSan.filter((s): s is string => typeof s === 'string').slice(0, 8)
      : undefined,
    winChanceDrop: typeof r.winChanceDrop === 'number' && Number.isFinite(r.winChanceDrop) ? r.winChanceDrop : undefined,
    openingName: typeof r.openingName === 'string' ? r.openingName.slice(0, 120) : undefined,
    playerColor: r.playerColor === 'w' || r.playerColor === 'b' ? r.playerColor : null,
    gameContextMovesSan: Array.isArray(r.gameContextMovesSan)
      ? r.gameContextMovesSan.filter((s): s is string => typeof s === 'string').slice(-16)
      : undefined,
    question: typeof r.question === 'string' ? r.question.slice(0, 1000) : undefined,
    conversationId: typeof r.conversationId === 'string' ? r.conversationId.slice(0, 80) : undefined,
    isPositionOnly: Boolean(r.isPositionOnly),
    language: r.language === 'en' ? 'en' : 'de',
  };

  return await aiCoach.explainMove(req, (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ai-coach:event', event);
    }
  });
});

ipcMain.handle('ai-coach:cancel', async (_, requestId: unknown) => {
  if (typeof requestId === 'string' && requestId.length <= 100) {
    aiCoach.cancel(requestId);
  }
});
