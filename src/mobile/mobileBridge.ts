import { Chess } from 'chess.js';
import {
  APP_SETTINGS_DEFAULTS,
  normalizeAppSettings,
  type AppSettings,
  type ArchiveItem,
  type GameAnalysis,
  type MissedIdea,
  type PlayerStats,
} from '../types/chess';
import type { DataBundle } from '../types/data';
import type {
  ChessComGameSummary,
  ElectronAPI,
  LanSyncStatus,
  PipelineDataInfo,
  PipelineJobInfo,
} from '../types/electron';
import type { StatisticsFilter } from '../types/statistics';
import { moveCategory } from '../utils/analysis';
import { archiveItem } from '../utils/archive';
import { isReliableGame, isReliableGameMove } from '../utils/evaluationReliability';
import { buildDeepDiagnostics } from '../utils/deepDiagnostics';
import { isValidSyncPayload, type SyncPayload, type SyncSummary } from '../utils/lanSyncMerge';
import { migrateGameTime, playedAt } from '../utils/gameTime';
import { annotateMissedOpportunities } from '../utils/missedOpportunities';
import {
  MISSED_IDEA_LABELS,
  classifyMatePattern,
  findEvidencedLostPiece,
  moveIdea,
  resolvePlayerColor,
} from '../utils/moveInsights';
import { detectOpeningFromFens } from '../utils/openingBook';
import { buildOpeningPhaseStats, normalizeOpeningWindow } from '../utils/openingPhase';
import { buildPerformanceOverview, gamePhase } from '../utils/performanceStatistics';
import { isStableGameId, mergePreviousIds, sameSourceIdentity } from '../utils/pgn';
import { configureProfile } from '../utils/profile';
import { repairAlternatingPovAnalysis } from '../utils/repairAlternatingPov';
import { matchesStatisticsFilter, normalizeStatisticsFilter } from '../utils/statisticsFilter';
import { classifyTimeControl } from '../utils/timeControl';
import { createMobileEngine } from './mobileEngine';

export const MOBILE_DB_NAME = 'pca_mobile_db_v1';
const IDB_STORE_NAME = 'kv';
const KNOWN_IDS_CAP = 5000;
const MOBILE_SEED_FLAG_KEY = 'pca_mobile_initial_seed_v1';

interface MobileInitialSeed {
  version: number;
  games: GameAnalysis[];
  settings?: Partial<AppSettings>;
  learningStorage?: Record<string, string>;
}

async function fetchInitialMobileSeed(): Promise<MobileInitialSeed | null> {
  if (typeof window === 'undefined' || typeof fetch !== 'function' || typeof DecompressionStream === 'undefined') {
    return null;
  }
  try {
    const response = await fetch('./mobile-initial-seed.bin', { cache: 'no-store' });
    if (!response.ok || !response.body) return null;
    const decompressed = response.body.pipeThrough(new DecompressionStream('gzip'));
    const parsed = (await new Response(decompressed).json()) as Partial<MobileInitialSeed> | null;
    if (!parsed || !Array.isArray(parsed.games)) return null;
    return {
      version: Number(parsed.version) || 1,
      games: parsed.games,
      settings: parsed.settings,
      learningStorage: parsed.learningStorage,
    };
  } catch {
    return null;
  }
}

interface ChessComGameSummaryExt extends ChessComGameSummary {
  uuid?: string;
  rules?: string;
}

interface StoredBackupRecord {
  id: string;
  createdAt: string;
  bundle?: DataBundle;
  compressedBundle?: Uint8Array;
}

const annotatedGameCache = new WeakSet<GameAnalysis>();

function ensureAnnotatedGame(game: GameAnalysis): GameAnalysis {
  if (annotatedGameCache.has(game)) return game;
  const enriched = annotateMissedOpportunities(migrateGameTime(game));
  annotatedGameCache.add(enriched);
  return enriched;
}

async function compressBackupBundle(bundle: DataBundle): Promise<Pick<StoredBackupRecord, 'bundle' | 'compressedBundle'>> {
  if (typeof CompressionStream !== 'undefined') {
    try {
      const rawStream = new Blob([JSON.stringify(bundle)], { type: 'application/json' }).stream();
      const compressedStream = rawStream.pipeThrough(new CompressionStream('gzip'));
      const buf = await new Response(compressedStream).arrayBuffer();
      return { compressedBundle: new Uint8Array(buf) };
    } catch {
      // Fallback to uncompressed object below
    }
  }
  return { bundle };
}

interface MobileStoreState {
  games: GameAnalysis[];
  settings: AppSettings;
  chesscom: PipelineDataInfo;
  lichess: PipelineDataInfo;
  backups: StoredBackupRecord[];
}

interface JobPatch {
  savedDelta?: number;
  failedDelta?: number;
  cursorSet?: number;
  status?: PipelineJobInfo['status'];
  lastError?: string;
}

interface AndroidExportBridge {
  saveFile?: (filename: string, content: string) => void;
  httpRequestAsync?: (requestId: string, method: string, url: string, jsonBody: string) => void;
}

const DEFAULT_LAN_SYNC_PORT = 47821;

function normalizeLanPeerEndpoint(hostOrIp: string): string {
  let cleaned = hostOrIp.trim();
  if (!cleaned) throw new Error('Bitte IP-Adresse des PCs im Heimnetz eingeben (z. B. 192.168.178.42).');
  if (!/^https?:\/\//i.test(cleaned)) cleaned = `http://${cleaned}`;
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new Error('Ungültige Adresse. Beispiel: 192.168.178.42');
  }
  const port = parsed.port || String(DEFAULT_LAN_SYNC_PORT);
  return `${parsed.protocol}//${parsed.hostname}:${port}`;
}

function sendLanPostJson(url: string, payload: SyncPayload): Promise<{ status: number; text: string }> {
  const androidBridge = (window as unknown as { AndroidExport?: AndroidExportBridge }).AndroidExport;
  const body = JSON.stringify(payload);

  if (androidBridge?.httpRequestAsync) {
    return new Promise((resolve, reject) => {
      const reqId = `lan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const win = window as unknown as {
        __pcaNativeHttpPending?: Map<string, (status: number, body: string, error: string) => void>;
        __pcaNativeHttpDone?: (id: string, status: number, body: string, error: string) => void;
      };
      if (!win.__pcaNativeHttpPending) win.__pcaNativeHttpPending = new Map();
      if (!win.__pcaNativeHttpDone) {
        win.__pcaNativeHttpDone = (id, status, respBody, error) => {
          const cb = win.__pcaNativeHttpPending?.get(id);
          if (cb) {
            win.__pcaNativeHttpPending?.delete(id);
            cb(status, respBody, error);
          }
        };
      }

      const timer = window.setTimeout(() => {
        win.__pcaNativeHttpPending?.delete(reqId);
        reject(new Error('Zeitüberschreitung beim Verbinden mit dem PC. Ist die PC-App geöffnet und im selben WLAN?'));
      }, 50_000);

      win.__pcaNativeHttpPending.set(reqId, (status, respBody, error) => {
        window.clearTimeout(timer);
        if (error) {
          reject(new Error(`Verbindung zum PC fehlgeschlagen (${error}). Gleiches WLAN & Windows-Firewall prüfen.`));
          return;
        }
        resolve({ status, text: respBody });
      });

      androidBridge.httpRequestAsync!(reqId, 'POST', url, body);
    });
  }

  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }).then(async (res) => ({ status: res.status, text: await res.text() }));
}

const emptyPipelineData = (): PipelineDataInfo => ({
  version: 1,
  knownIds: [],
  jobs: [],
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// SHA-256 helper (WebCrypto with pure-TS fallback for non-secure HTTP contexts)
// ---------------------------------------------------------------------------
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256HexSync(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  return Array.from(h)
    .map((n) => n.toString(16).padStart(8, '0'))
    .join('');
}

async function sha256Hex(input: string): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
      return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    } catch {
      // Fallback below
    }
  }
  return sha256HexSync(input);
}

// ---------------------------------------------------------------------------
// IndexedDB + localStorage persistence layer
// ---------------------------------------------------------------------------
function openMobileDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(MOBILE_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
          db.createObjectStore(IDB_STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function idbGet<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE_NAME, 'readonly');
      const req = tx.objectStore(IDB_STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

function idbPut(db: IDBDatabase, key: string, value: unknown): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
      tx.objectStore(IDB_STORE_NAME).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

function readLocalStorageSnapshot(): Partial<MobileStoreState> | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(MOBILE_DB_NAME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MobileStoreState>;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeLocalStorageSnapshot(state: MobileStoreState): void {
  try {
    if (typeof localStorage === 'undefined') return;
    // Keep games solely in IndexedDB so multi-MB archives never block the UI thread
    // or exhaust the 5 MB localStorage quota needed by learningStorage cards.
    localStorage.setItem(
      MOBILE_DB_NAME,
      JSON.stringify({
        settings: state.settings,
        chesscom: state.chesscom,
        lichess: state.lichess,
      })
    );
  } catch {
    // IndexedDB remains authoritative when localStorage is unavailable or full.
  }
}

// ---------------------------------------------------------------------------
// DataBundle validation (matches electron/dataBundle.ts contract)
// ---------------------------------------------------------------------------
function validateLearningStorage(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Ungültiger Lernspeicher.');
  }
  const entries = Object.entries(raw);
  if (entries.some(([key, value]) => !key.startsWith('personal-chess-analyzer-') || typeof value !== 'string')) {
    throw new Error('Ungültiger Lernspeichereintrag.');
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function validateDataBundle(raw: unknown): DataBundle {
  const value = raw as DataBundle;
  if (
    !value ||
    value.format !== 'personal-chess-analyzer' ||
    value.version !== 1 ||
    !Array.isArray(value.games) ||
    !value.settings ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    throw new Error('Kein unterstütztes vollständiges App-Backup.');
  }
  const ids = new Set<string>();
  for (const game of value.games) {
    if (
      !game ||
      typeof game.id !== 'string' ||
      !game.id ||
      ids.has(game.id) ||
      typeof game.pgn !== 'string' ||
      typeof game.white !== 'string' ||
      typeof game.black !== 'string' ||
      !Array.isArray(game.moves) ||
      !game.summaryWhite ||
      !game.summaryBlack
    ) {
      throw new Error('Ungültige oder doppelte Partie im Backup.');
    }
    ids.add(game.id);
    for (const move of game.moves) {
      if (
        !move ||
        !move.evalBefore ||
        !move.evalAfter ||
        !Number.isFinite(move.ply) ||
        !Number.isFinite(move.evalBefore.scoreCp) ||
        !Number.isFinite(move.evalAfter.scoreCp) ||
        typeof move.san !== 'string' ||
        typeof move.uci !== 'string'
      ) {
        throw new Error('Ungültige Analyse im Backup.');
      }
      try {
        new Chess(move.fenBefore);
        new Chess(move.fenAfter);
      } catch {
        throw new Error('Ungültige Brettstellung im Backup.');
      }
    }
  }
  return {
    ...value,
    settings: normalizeAppSettings(value.settings),
    learningStorage: validateLearningStorage(value.learningStorage),
  };
}

async function encodeDataBundleMobile(bundle: DataBundle): Promise<string> {
  const payload = JSON.stringify(validateDataBundle(bundle));
  const checksum = await sha256Hex(payload);
  return JSON.stringify({ checksum, payload });
}

async function decodeDataBundleMobile(text: string): Promise<DataBundle> {
  const parsed = JSON.parse(text) as { checksum?: unknown; payload?: unknown } & Partial<DataBundle>;
  if (typeof parsed?.payload === 'string' && typeof parsed?.checksum === 'string') {
    const expected = await sha256Hex(parsed.payload);
    if (parsed.checksum !== expected) {
      throw new Error('Backup beschädigt: Prüfsumme stimmt nicht.');
    }
    return validateDataBundle(JSON.parse(parsed.payload));
  }
  return validateDataBundle(parsed);
}

// ---------------------------------------------------------------------------
// Game deduplication & identity helpers (mirrors electron/db.ts)
// ---------------------------------------------------------------------------
function gameFingerprint(game: GameAnalysis): string {
  const normalize = (value: string | undefined) => (value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const moves = (game.moves || []).map((move) => move.uci).join(',');
  return [normalize(game.white), normalize(game.black), moves || normalize(game.pgn)].join('|');
}

function deduplicateAndRepairGames(games: GameAnalysis[]): GameAnalysis[] {
  const uniqueGames: GameAnalysis[] = [];
  const indexByKey = new Map<string, number>();
  for (const game of games) {
    const stable = isStableGameId(game.id);
    const key = stable ? `id:${game.id}` : `fp:${gameFingerprint(game)}`;
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, uniqueGames.length);
      uniqueGames.push(game);
      continue;
    }
    const existing = uniqueGames[existingIndex];
    const sameId = key.startsWith('id:');
    if (sameId || sameSourceIdentity(existing, game)) {
      uniqueGames[existingIndex] = { ...game, previousIds: mergePreviousIds(existing, game) };
    } else {
      uniqueGames.push(game);
    }
  }
  return uniqueGames.map((game) => repairAlternatingPovAnalysis(game) ?? game);
}

// ---------------------------------------------------------------------------
// CORS-safe Chess.com & Lichess API clients
// ---------------------------------------------------------------------------
function parseTag(pgn: string, tag: string): string | undefined {
  const match = pgn.match(new RegExp(`\\[${tag} "([^"]*)"\\]`));
  return match && match[1] ? match[1] : undefined;
}

async function fetchWithBackoff(url: string, accept: string = 'application/json'): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      // Do not set User-Agent header in browser/WebView fetch (forbidden header; causes CORS issues).
      const response = await fetch(url, {
        headers: { Accept: accept },
        signal: controller.signal,
      });
      if (response.status === 429 && attempt < 2) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const delay =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 10000)
            : (attempt + 1) * 1500;
        await sleep(delay);
        lastError = new Error('Anfrage gedrosselt (429).');
        continue;
      }
      return response;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('Timeout beim Laden der Online-Partien.');
      }
      lastError = err;
      if (attempt < 2) {
        await sleep((attempt + 1) * 1000);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Netzwerkanfrage fehlgeschlagen.');
}

interface ChessComApiGame {
  url?: string;
  uuid?: string;
  rules?: string;
  pgn?: string;
  time_control?: string | number;
  time_class?: string;
  end_time?: number;
  white?: { username: string; result: string; rating?: number };
  black?: { username: string; result: string; rating?: number };
}

export async function fetchArchives(username: string): Promise<string[]> {
  const name = username.trim();
  if (!name) throw new Error('Kein chess.com-Benutzername angegeben.');
  const response = await fetchWithBackoff(
    `https://api.chess.com/pub/player/${encodeURIComponent(name)}/games/archives`
  );
  if (response.status === 404) throw new Error(`Chess.com-Benutzer "${name}" wurde nicht gefunden.`);
  if (!response.ok) throw new Error(`Chess.com-Archive konnten nicht geladen werden (HTTP ${response.status}).`);
  const payload = (await response.json()) as { archives?: unknown };
  if (!Array.isArray(payload.archives)) {
    throw new Error('Chess.com hat keine gültige Archivliste zurückgegeben.');
  }
  return payload.archives.filter((v): v is string => typeof v === 'string');
}

export async function fetchGamesFromArchive(archiveUrl: string): Promise<ChessComGameSummaryExt[]> {
  const response = await fetchWithBackoff(archiveUrl);
  if (response.status === 404) return [];
  if (response.status === 403) {
    throw new Error('Chess.com hat die Anfrage abgelehnt (403). Bitte später erneut versuchen.');
  }
  if (!response.ok) {
    throw new Error(`Chess.com-Monatsarchiv konnte nicht geladen werden (HTTP ${response.status}).`);
  }
  const payload = (await response.json()) as { games?: ChessComApiGame[] };
  const games = Array.isArray(payload.games) ? payload.games : [];
  const summaries: ChessComGameSummaryExt[] = [];
  for (const game of games) {
    if (!game.pgn) continue;
    summaries.push({
      pgn: game.pgn,
      url: game.url,
      uuid: game.uuid,
      rules: game.rules,
      timeClass: game.time_class,
      timeControl: typeof game.time_control === 'string' ? game.time_control : undefined,
      endTime: game.end_time,
      white: game.white?.username || parseTag(game.pgn, 'White') || 'White',
      black: game.black?.username || parseTag(game.pgn, 'Black') || 'Black',
      result: parseTag(game.pgn, 'Result') || '*',
      date: parseTag(game.pgn, 'Date'),
    });
  }
  summaries.sort((a, b) => (b.endTime || 0) - (a.endTime || 0));
  return summaries;
}

async function fetchMonthlyGames(username: string, year: number, month: number): Promise<ChessComGameSummaryExt[]> {
  const cleanName = username.trim();
  if (!cleanName) throw new Error('Kein chess.com-Benutzername angegeben.');
  const url = `https://api.chess.com/pub/player/${encodeURIComponent(cleanName)}/games/${year}/${String(month).padStart(2, '0')}`;
  return fetchGamesFromArchive(url);
}

export async function fetchRecentRapidGames(username: string, limit = 20): Promise<ChessComGameSummaryExt[]> {
  const archives = await fetchArchives(username);
  const recentUrls = archives.slice(-2).reverse();
  const collected: ChessComGameSummaryExt[] = [];
  for (const url of recentUrls) {
    const games = await fetchGamesFromArchive(url);
    for (const g of games) {
      if ((!g.rules || g.rules === 'chess') && g.timeClass === 'rapid') {
        collected.push(g);
        if (collected.length >= limit) return collected;
      }
    }
  }
  return collected;
}

// ---------------------------------------------------------------------------
// Shared Pipeline State Machine (matches electron/chesscomPipelineCore.ts)
// ---------------------------------------------------------------------------
function monthsForWindow(nowMs: number, daysWindow: number): { year: number; month: number }[] {
  const days = Math.max(1, Math.floor(daysWindow));
  const start = new Date(nowMs - days * 86_400_000);
  const end = new Date(nowMs);
  const months: { year: number; month: number }[] = [];
  let year = start.getFullYear();
  let month = start.getMonth() + 1;
  while (year < end.getFullYear() || (year === end.getFullYear() && month <= end.getMonth() + 1)) {
    months.push({ year, month });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

function isSupportedChessComGame(summary: ChessComGameSummaryExt): boolean {
  if (summary.rules !== undefined && summary.rules !== 'chess') return false;
  if (!summary.pgn) return false;
  if (!summary.endTime) return false;
  return true;
}

function withinChessComWindow(summary: ChessComGameSummaryExt, nowMs: number, daysWindow: number): boolean {
  if (!summary.endTime) return false;
  return nowMs - summary.endTime * 1000 <= (daysWindow + 1) * 86_400_000;
}

function chessComSourceIdOf(summary: ChessComGameSummaryExt): string {
  if (summary.uuid) return `uuid:${summary.uuid}`;
  if (summary.url) return `url:${summary.url}`;
  return `hash:${summary.white}|${summary.black}|${summary.endTime}|${summary.pgn.length}`;
}

const LICHESS_FINISHED_STATUSES = new Set([
  'mate',
  'resign',
  'outoftime',
  'draw',
  'stalemate',
  'fifty',
  'insufficient',
  'timeout',
  'unknownFinish',
]);

interface LichessApiGame {
  id?: string;
  variant?: string;
  status?: string;
  createdAt?: number;
  lastMoveAt?: number;
  pgn?: string;
}

async function fetchLichessGamesMobile(
  username: string,
  sinceMs: number
): Promise<Array<{ sourceId: string; pgn: string; endedAt: number; variant: string; status: string }>> {
  const cleanName = username.trim();
  if (!cleanName) throw new Error('Kein Lichess-Benutzername angegeben.');
  const url =
    `https://lichess.org/api/games/user/${encodeURIComponent(cleanName)}` +
    `?since=${Math.floor(sinceMs)}&until=${Date.now()}&pgnInJson=true&opening=false&clocks=false&evals=false`;
  const response = await fetchWithBackoff(url, 'application/x-ndjson');
  if (response.status === 404) {
    throw new Error(`Lichess-Account "${cleanName}" wurde nicht gefunden.`);
  }
  if (response.status === 429) {
    throw new Error('Lichess hat die Anfrage gedrosselt (429). Bitte später erneut versuchen.');
  }
  if (!response.ok) {
    throw new Error(`Lichess-Partieliste konnte nicht geladen werden (HTTP ${response.status}).`);
  }
  const text = await response.text();
  const summaries: Array<{ sourceId: string; pgn: string; endedAt: number; variant: string; status: string }> = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let game: LichessApiGame;
    try {
      game = JSON.parse(trimmed) as LichessApiGame;
    } catch {
      throw new Error('Unvollständige Lichess-Antwort. Bitte Synchronisierung erneut starten.');
    }
    if (!game.id || !game.pgn) continue;
    summaries.push({
      sourceId: `lichess:${game.id}`,
      pgn: game.pgn,
      endedAt: game.lastMoveAt || game.createdAt || 0,
      variant: game.variant || 'standard',
      status: game.status || 'unknown',
    });
  }
  summaries.sort((a, b) => b.endedAt - a.endedAt);
  return summaries;
}

function mergeDiscoveryIntoPipeline(
  data: PipelineDataInfo,
  cleanName: string,
  discoveredGames: PipelineJobInfo['games'],
  nowMs: number
): { job: PipelineJobInfo; created: boolean } {
  const byName = (j: PipelineJobInfo) => j.username.toLowerCase() === cleanName.toLowerCase();
  const resumable = data.jobs.find(
    (j) => byName(j) && (j.status === 'queued' || j.status === 'analyzing' || j.status === 'failed')
  );
  if (resumable) {
    resumable.status = 'queued';
    resumable.lastError = undefined;
    const known = new Set(resumable.games.map((g) => g.sourceId));
    for (const g of discoveredGames) {
      if (!known.has(g.sourceId)) {
        resumable.games.push(g);
        known.add(g.sourceId);
      }
    }
    resumable.updatedAt = nowMs;
    return { job: resumable, created: false };
  }
  const job: PipelineJobInfo = {
    id: `job_${nowMs.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    username: cleanName,
    status: 'queued',
    games: [...discoveredGames],
    cursor: 0,
    savedCount: 0,
    failedCount: 0,
    createdAt: nowMs,
    updatedAt: nowMs,
  };
  data.jobs.push(job);
  return { job, created: true };
}

function applyJobPatch(job: PipelineJobInfo, patch: JobPatch, nowMs: number): void {
  if (patch.savedDelta) job.savedCount += patch.savedDelta;
  if (patch.failedDelta) job.failedCount += patch.failedDelta;
  if (patch.cursorSet !== undefined) {
    job.cursor = Math.max(0, Math.min(job.games.length, patch.cursorSet));
  }
  if (patch.status) {
    const validStatuses: PipelineJobInfo['status'][] = ['queued', 'analyzing', 'saved', 'failed', 'cancelled'];
    if (!validStatuses.includes(patch.status)) return;
    if (!(patch.status === 'queued' && job.status !== 'analyzing' && job.status !== 'failed')) {
      job.status = patch.status;
    }
  }
  if (patch.lastError !== undefined) job.lastError = patch.lastError;
  job.updatedAt = nowMs;
}

function resumeStaleJobs(data: PipelineDataInfo): boolean {
  let changed = false;
  for (const job of data.jobs) {
    if (job.status === 'analyzing') {
      job.status = 'queued';
      job.updatedAt = Date.now();
      changed = true;
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Player stats calculation (mirrors electron/db.ts + forced/winRate fixes)
// ---------------------------------------------------------------------------
async function computePlayerStatsAsync(
  allGames: GameAnalysis[],
  targetPlayer: string,
  openingWindowMoves: number,
  requestedFilter?: Partial<StatisticsFilter>,
  shouldCancel: () => boolean = () => false,
): Promise<PlayerStats> {
  const throwIfCancelled = () => {
    if (shouldCancel()) throw new DOMException('Diagnostik-Berechnung abgebrochen.', 'AbortError');
  };
  throwIfCancelled();
  const filter = normalizeStatisticsFilter(requestedFilter);
  const now = Date.now();
  const isValidAccuracy = (v: number | undefined): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;

  const ownGames: GameAnalysis[] = [];
  for (let i = 0; i < allGames.length; i++) {
    const g = allGames[i];
    if (resolvePlayerColor(g.white, g.black, targetPlayer, g.site) !== null) {
      ownGames.push(ensureAnnotatedGame(g));
    }
    if ((i & 15) === 15) {
      await sleep(0);
      throwIfCancelled();
    }
  }
  const playerGames = ownGames
    .filter((game) => matchesStatisticsFilter(game, filter, now))
    .filter(isReliableGame);

  let winCount = 0;
  let lossCount = 0;
  let drawCount = 0;
  let totalAcc = 0;
  let countedAccGames = 0;
  const colorStats = {
    white: { games: 0, wins: 0, losses: 0, draws: 0, accSum: 0, accCount: 0 },
    black: { games: 0, wins: 0, losses: 0, draws: 0, accSum: 0, accCount: 0 },
  };
  let openingBlunders = 0;
  let middlegameBlunders = 0;
  let endgameBlunders = 0;
  let errorSeveritySum = 0;
  let errorSeverityCount = 0;
  let worstError: PlayerStats['worstError'] = null;
  const timeControlMap: Record<
    string,
    { games: number; wins: number; losses: number; draws: number; accSum: number; accCount: number }
  > = {};
  const blunderedPieces: Record<string, number> = { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 };
  const ideaCounts: Record<MissedIdea, number> = { mate: 0, capture: 0, fork: 0, check: 0, quiet: 0 };
  let ideaTotal = 0;
  const ideaExamples: PlayerStats['overlookedIdeas']['examples'] = [];
  const matePatterns = { backRank: 0, smothered: 0, net: 0, total: 0 };
  const variationMap: Record<
    string,
    { games: number; blunders: number; accSum: number; accCount: number; openingPhaseBlunders: number }
  > = {};
  const openingMap: Record<
    string,
    {
      name: string;
      eco: string;
      games: number;
      wins: number;
      losses: number;
      draws: number;
      accSum: number;
      accCount: number;
      blunders: number;
      whiteGames: number;
      whiteWins: number;
      blackGames: number;
      blackWins: number;
    }
  > = {};

  for (let gameIdx = 0; gameIdx < playerGames.length; gameIdx++) {
    const game = playerGames[gameIdx];
    if (gameIdx > 0 && (gameIdx & 7) === 0) {
      await sleep(0);
      throwIfCancelled();
    }
    const userColor = resolvePlayerColor(game.white, game.black, targetPlayer, game.site);
    if (!userColor) continue;

    const bookHit = detectOpeningFromFens(game.moves.map((m) => m.fenAfter));
    const variationKey = bookHit?.name || game.openingName || 'Ohne Theorielinie';
    if (!variationMap[variationKey]) {
      variationMap[variationKey] = { games: 0, blunders: 0, accSum: 0, accCount: 0, openingPhaseBlunders: 0 };
    }
    variationMap[variationKey].games++;
    const userAcc = userColor === 'w' ? game.accuracyWhite : game.accuracyBlack;
    if (isValidAccuracy(userAcc)) {
      variationMap[variationKey].accSum += userAcc;
      variationMap[variationKey].accCount++;
      totalAcc += userAcc;
      countedAccGames++;
    }

    const userLost =
      (userColor === 'w' && game.result === '0-1') || (userColor === 'b' && game.result === '1-0');
    if (userLost && game.moves.length > 0) {
      const last = game.moves[game.moves.length - 1];
      if (last.isCheckmate && last.color !== userColor) {
        const pattern = classifyMatePattern(last.fenBefore, last.uci);
        if (pattern) {
          matePatterns[pattern]++;
          matePatterns.total++;
        }
      }
    }

    if (game.result === '1-0') {
      if (userColor === 'w') winCount++;
      else lossCount++;
    } else if (game.result === '0-1') {
      if (userColor === 'b') winCount++;
      else lossCount++;
    } else if (game.result === '1/2-1/2') {
      drawCount++;
    }

    const tcLabel = classifyTimeControl(game.timeControl, game.timeClass);
    if (!timeControlMap[tcLabel]) {
      timeControlMap[tcLabel] = { games: 0, wins: 0, losses: 0, draws: 0, accSum: 0, accCount: 0 };
    }
    const tcBucket = timeControlMap[tcLabel];
    tcBucket.games++;
    if (isValidAccuracy(userAcc)) {
      tcBucket.accSum += userAcc;
      tcBucket.accCount++;
    }
    if ((game.result === '1-0' && userColor === 'w') || (game.result === '0-1' && userColor === 'b')) {
      tcBucket.wins++;
    } else if ((game.result === '0-1' && userColor === 'w') || (game.result === '1-0' && userColor === 'b')) {
      tcBucket.losses++;
    } else if (game.result === '1/2-1/2') {
      tcBucket.draws++;
    }

    const opKey = game.openingName || game.eco || 'Standard';
    if (!openingMap[opKey]) {
      openingMap[opKey] = {
        name: game.openingName || 'Standard',
        eco: game.eco || '',
        games: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        accSum: 0,
        accCount: 0,
        blunders: 0,
        whiteGames: 0,
        whiteWins: 0,
        blackGames: 0,
        blackWins: 0,
      };
    }
    openingMap[opKey].games++;
    if (isValidAccuracy(userAcc)) {
      openingMap[opKey].accSum += userAcc;
      openingMap[opKey].accCount++;
    }
    const colorBucket = userColor === 'w' ? colorStats.white : colorStats.black;
    colorBucket.games++;
    if (isValidAccuracy(userAcc)) {
      colorBucket.accSum += userAcc;
      colorBucket.accCount++;
    }
    if (userColor === 'w') openingMap[opKey].whiteGames++;
    else openingMap[opKey].blackGames++;

    if ((game.result === '1-0' && userColor === 'w') || (game.result === '0-1' && userColor === 'b')) {
      openingMap[opKey].wins++;
      colorBucket.wins++;
      if (userColor === 'w') openingMap[opKey].whiteWins++;
      else openingMap[opKey].blackWins++;
    } else if ((game.result === '0-1' && userColor === 'w') || (game.result === '1-0' && userColor === 'b')) {
      openingMap[opKey].losses++;
      colorBucket.losses++;
    } else if (game.result === '1/2-1/2') {
      openingMap[opKey].draws++;
      colorBucket.draws++;
    }

    for (const move of game.moves) {
      if (move.color !== userColor || move.isForced || !isReliableGameMove(game, move)) continue;
      const category = moveCategory(move);
      if (!['blunder', 'mistake', 'miss'].includes(category)) continue;
      const ideaResult = moveIdea(move);
      if (ideaResult) {
        ideaTotal++;
        ideaCounts[ideaResult.idea]++;
        ideaExamples.push({
          san: move.san,
          bestSan: ideaResult.bestSan,
          moveNumber: move.moveNumber,
          idea: ideaResult.idea,
          heuristic: ideaResult.heuristic ?? false,
          winChanceDrop: move.winChanceDrop,
          date: game.date,
          openingName: game.openingName || game.eco,
          gameId: game.id,
          ply: move.ply,
        });
      }

      if (category === 'blunder' || category === 'mistake') {
        const phase = gamePhase(move, normalizeOpeningWindow(openingWindowMoves));
        if (phase === 'opening') {
          openingBlunders++;
          variationMap[variationKey].openingPhaseBlunders++;
        } else if (phase === 'endgame') {
          endgameBlunders++;
        } else {
          middlegameBlunders++;
        }

        const lostPiece =
          findEvidencedLostPiece(move.fenAfter, move.evalAfter?.pv, userColor, move) ??
          (move.piece === 'k' ? 'k' : null);
        if (lostPiece && blunderedPieces[lostPiece] !== undefined) {
          blunderedPieces[lostPiece]++;
        }

        openingMap[opKey].blunders++;
        variationMap[variationKey].blunders++;
        errorSeveritySum += move.winChanceDrop;
        errorSeverityCount++;
        if (!worstError || move.winChanceDrop > worstError.winChanceDrop) {
          worstError = {
            san: move.san,
            moveNumber: move.moveNumber,
            winChanceDrop: move.winChanceDrop,
            date: game.date,
            openingName: game.openingName || game.eco,
            color: userColor,
            gameId: game.id,
            ply: move.ply,
          };
        }
      }
    }
  }

  const avgAccuracy = countedAccGames > 0 ? Math.round((totalAcc / countedAccGames) * 10) / 10 : 0;
  const openingsStats = Object.values(openingMap)
    .map((op) => ({
      name: op.name,
      eco: op.eco,
      games: op.games,
      wins: op.wins,
      losses: op.losses,
      draws: op.draws,
      avgAccuracy: op.accCount > 0 ? Math.round((op.accSum / op.accCount) * 10) / 10 : 0,
      blunders: op.blunders,
      whiteGames: op.whiteGames,
      whiteWins: op.whiteWins,
      blackGames: op.blackGames,
      blackWins: op.blackWins,
    }))
    .sort((a, b) => b.games - a.games);

  const accuracyHistory = playerGames
    .filter((g) => !!playedAt(g))
    .filter((g) => {
      const userColor = resolvePlayerColor(g.white, g.black, targetPlayer, g.site);
      if (!userColor) return false;
      const acc = userColor === 'w' ? g.accuracyWhite : g.accuracyBlack;
      return isValidAccuracy(acc);
    })
    .map((g) => {
      const userColor = resolvePlayerColor(g.white, g.black, targetPlayer, g.site) as 'w' | 'b';
      const win = (userColor === 'w' && g.result === '1-0') || (userColor === 'b' && g.result === '0-1');
      const draw = g.result === '1/2-1/2';
      return {
        date: g.date,
        createdAt: g.createdAt,
        playedAt: playedAt(g),
        accuracy: userColor === 'w' ? g.accuracyWhite : g.accuracyBlack,
        result: g.result,
        win,
        draw,
      };
    })
    .sort((a, b) => (a.playedAt || '').localeCompare(b.playedAt || '') || (a.createdAt || '').localeCompare(b.createdAt || ''));

  const completedTc = (s: { wins: number; losses: number; draws: number }) => s.wins + s.losses + s.draws;
  const timeControlStats = Object.entries(timeControlMap)
    .map(([label, s]) => ({
      label,
      games: s.games,
      wins: s.wins,
      losses: s.losses,
      draws: s.draws,
      avgAccuracy: s.accCount > 0 ? Math.round((s.accSum / s.accCount) * 10) / 10 : 0,
      winRate: completedTc(s) > 0 ? Math.round((s.wins / completedTc(s)) * 100) : 0,
    }))
    .sort((a, b) => b.games - a.games);

  const avgErrorSeverity = errorSeverityCount > 0 ? Math.round((errorSeveritySum / errorSeverityCount) * 10) / 10 : 0;
  const topIdeaExamples = ideaExamples.sort((a, b) => b.winChanceDrop - a.winChanceDrop).slice(0, 5);
  const variationStats = Object.entries(variationMap)
    .map(([variation, s]) => ({
      variation,
      games: s.games,
      blunders: s.blunders,
      blundersPerGame: s.games > 0 ? Math.round((s.blunders / s.games) * 100) / 100 : 0,
      openingPhaseBlunders: s.openingPhaseBlunders,
      avgAccuracy: s.accCount > 0 ? Math.round((s.accSum / s.accCount) * 10) / 10 : 0,
    }))
    .filter((v) => v.blunders > 0)
    .sort((a, b) => b.blundersPerGame - a.blundersPerGame || b.games - a.games)
    .slice(0, 7);

  const coachingInsights: string[] = [];
  const totalBlunders = openingBlunders + middlegameBlunders + endgameBlunders;

  if (ideaTotal > 0) {
    const ideasSorted = Object.entries(ideaCounts).sort((a, b) => b[1] - a[1]);
    const [topIdea, topIdeaCount] = ideasSorted[0];
    if (topIdeaCount > 0) {
      const label = MISSED_IDEA_LABELS[topIdea as MissedIdea];
      coachingInsights.push(
        `🧩 **Übersehene Ideen (${label})**: In ${topIdeaCount} von ${ideaTotal} Fehlerfällen war die bessere Idee: ${label.toLowerCase()}. Nach jedem Gegner-Zug aktiv nach Motiven suchen: hängende Figuren, Mattmuster, Gabeln.`
      );
    }
  }

  if (totalBlunders > 0) {
    const midPct = Math.round((middlegameBlunders / totalBlunders) * 100);
    const openPct = Math.round((openingBlunders / totalBlunders) * 100);
    const endPct = Math.round((endgameBlunders / totalBlunders) * 100);
    if (midPct >= 50) {
      coachingInsights.push(
        `⚠️ **Mittelspiel-Fokus**: ${midPct}% deiner schwerwiegenden Fehler entstehen im Mittelspiel.`
      );
    } else if (openPct >= 35) {
      coachingInsights.push(
        `📖 **Eröffnungsphase**: ${openPct}% deiner gröberen Fehler und Patzer entstehen in den ersten ${normalizeOpeningWindow(openingWindowMoves)} Zügen.`
      );
    } else if (endPct >= 35) {
      coachingInsights.push(
        `👑 **Endspieltechnik**: ${endPct}% deiner Fehler treten im späten Endspiel auf.`
      );
    }
    const piecesSorted = Object.entries(blunderedPieces).sort((a, b) => b[1] - a[1]);
    if (piecesSorted[0] && piecesSorted[0][1] > 0) {
      const pieceNames: Record<string, string> = { q: 'Damen', r: 'Türme', b: 'Läufer', n: 'Springer', p: 'Bauern', k: 'König' };
      const pieceName = pieceNames[piecesSorted[0][0]] || 'Figuren';
      coachingInsights.push(
        `♟️ **Taktische Verwundbarkeit (${pieceName})**: Am häufigsten betroffen (${piecesSorted[0][1]}x).`
      );
    }
  } else {
    coachingInsights.push(
      '🎯 Analysiere weitere Partien, um personalisierte Fehler-Cluster und taktische Schwerpunkte zu generieren.'
    );
  }

  const whiteCompleted = colorStats.white.wins + colorStats.white.losses + colorStats.white.draws;
  const blackCompleted = colorStats.black.wins + colorStats.black.losses + colorStats.black.draws;

  await sleep(0);
  throwIfCancelled();
  const performance = buildPerformanceOverview(ownGames, targetPlayer, filter, normalizeOpeningWindow(openingWindowMoves), now);
  await sleep(0);
  throwIfCancelled();
  const deepDiagnostics = buildDeepDiagnostics(playerGames, targetPlayer);
  await sleep(0);
  throwIfCancelled();
  const openingPhaseStats = buildOpeningPhaseStats(playerGames, targetPlayer, openingWindowMoves);

  return {
    playerName: targetPlayer,
    performance,
    deepDiagnostics,
    totalGames: playerGames.length,
    winCount,
    lossCount,
    drawCount,
    avgAccuracy,
    openingWindowMoves: normalizeOpeningWindow(openingWindowMoves),
    openingPhaseStats,
    colorPerformance: {
      white: {
        games: colorStats.white.games,
        wins: colorStats.white.wins,
        losses: colorStats.white.losses,
        draws: colorStats.white.draws,
        avgAccuracy: colorStats.white.accCount > 0 ? Math.round((colorStats.white.accSum / colorStats.white.accCount) * 10) / 10 : 0,
        winRate: whiteCompleted > 0 ? Math.round((colorStats.white.wins / whiteCompleted) * 100) : 0,
      },
      black: {
        games: colorStats.black.games,
        wins: colorStats.black.wins,
        losses: colorStats.black.losses,
        draws: colorStats.black.draws,
        avgAccuracy: colorStats.black.accCount > 0 ? Math.round((colorStats.black.accSum / colorStats.black.accCount) * 10) / 10 : 0,
        winRate: blackCompleted > 0 ? Math.round((colorStats.black.wins / blackCompleted) * 100) : 0,
      },
    },
    phaseDistribution: { openingBlunders, middlegameBlunders, endgameBlunders },
    blunderedPieces: {
      p: blunderedPieces.p,
      n: blunderedPieces.n,
      b: blunderedPieces.b,
      r: blunderedPieces.r,
      q: blunderedPieces.q,
      k: blunderedPieces.k,
    },
    openingsStats,
    accuracyHistory,
    timeControlStats,
    avgErrorSeverity,
    worstError,
    coachingInsights,
    overlookedIdeas: { total: ideaTotal, counts: ideaCounts, examples: topIdeaExamples },
    matePatterns,
    variationStats,
  };
}

// ---------------------------------------------------------------------------
// File export / import helpers for Browser & Android WebView
// ---------------------------------------------------------------------------
export function openExternalMobile(url: string): void {
  if (typeof window !== 'undefined' && /^https?:\/\//i.test(url)) {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

function triggerBrowserDownload(filename: string, content: string): void {
  const androidBridge = (window as unknown as { AndroidExport?: AndroidExportBridge }).AndroidExport;
  if (androidBridge?.saveFile) {
    androidBridge.saveFile(filename, content);
    return;
  }
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function pickJsonFileText(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.style.display = 'none';
    let settled = false;

    const cleanup = () => {
      window.removeEventListener('focus', onFocusBack);
      if (input.parentNode) input.parentNode.removeChild(input);
    };

    const finish = (value: string | null, err?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve(value);
    };

    const onFocusBack = () => {
      setTimeout(() => {
        if (!settled && (!input.files || input.files.length === 0)) {
          finish(null);
        }
      }, 450);
    };

    input.addEventListener('cancel', () => finish(null));
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) {
        finish(null);
        return;
      }
      if (file.size > 512 * 1024 * 1024) {
        finish(null, new Error('Backup größer als 512 MB.'));
        return;
      }
      try {
        const text = await file.text();
        finish(text);
      } catch (err) {
        finish(null, err);
      }
    });

    document.body.appendChild(input);
    window.addEventListener('focus', onFocusBack);
    input.click();
  });
}

// ---------------------------------------------------------------------------
// Mobile ElectronAPI factory & bootstrap
// ---------------------------------------------------------------------------
export function createMobileElectronAPI(): ElectronAPI {
  const engine = createMobileEngine();
  let dbPromise: Promise<IDBDatabase | null> | null = null;
  let state: MobileStoreState | null = null;
  let loadPromise: Promise<MobileStoreState> | null = null;
  let statsRequestToken = 0;

  const getDb = () => {
    if (!dbPromise) dbPromise = openMobileDb();
    return dbPromise;
  };

  const persistKeys = async (keys: Array<keyof MobileStoreState>): Promise<void> => {
    if (!state) return;
    const db = await getDb();
    if (db) {
      await Promise.all(keys.map((k) => idbPut(db, k, state![k])));
    }
    writeLocalStorageSnapshot(state);
  };

  const ensureLoaded = async (): Promise<MobileStoreState> => {
    if (state) return state;
    if (loadPromise) return loadPromise;

    loadPromise = (async () => {
      const status = await engine.getStatus();
      const db = await getDb();
      const lsFallback = readLocalStorageSnapshot();

      let rawGames = (db ? await idbGet<GameAnalysis[]>(db, 'games') : undefined) ?? lsFallback?.games ?? [];
      let rawSettings = (db ? await idbGet<AppSettings>(db, 'settings') : undefined) ?? lsFallback?.settings;
      const seedVersion =
        (db ? await idbGet<number>(db, 'seedVersion') : undefined) ??
        (typeof localStorage !== 'undefined' && localStorage.getItem(MOBILE_SEED_FLAG_KEY) === '1' ? 1 : 0);

      let seededInitially = false;
      if (!seedVersion && (!Array.isArray(rawGames) || rawGames.length === 0)) {
        const seed = await fetchInitialMobileSeed();
        if (seed && seed.games.length > 0) {
          rawGames = seed.games;
          if (!rawSettings && seed.settings) {
            rawSettings = normalizeAppSettings(seed.settings, status.path);
          }
          if (seed.learningStorage && typeof localStorage !== 'undefined') {
            for (const [k, v] of Object.entries(seed.learningStorage)) {
              if (k.startsWith('personal-chess-analyzer-') && typeof v === 'string' && localStorage.getItem(k) === null) {
                try {
                  localStorage.setItem(k, v);
                } catch {
                  // Ignore quota limits on secondary keys
                }
              }
            }
          }
          seededInitially = true;
        }
      }
      const rawChesscom =
        (db ? await idbGet<PipelineDataInfo>(db, 'chesscom') : undefined) ??
        lsFallback?.chesscom ??
        emptyPipelineData();
      const rawLichess =
        (db ? await idbGet<PipelineDataInfo>(db, 'lichess') : undefined) ??
        lsFallback?.lichess ??
        emptyPipelineData();
      const rawBackups = (db ? await idbGet<StoredBackupRecord[]>(db, 'backups') : undefined) ?? [];

      const games = deduplicateAndRepairGames(Array.isArray(rawGames) ? rawGames : []).map(ensureAnnotatedGame);
      const settings = normalizeAppSettings(rawSettings, status.path);
      configureProfile(settings);

      const chesscom: PipelineDataInfo = {
        version: 1,
        knownIds: Array.isArray(rawChesscom.knownIds) ? rawChesscom.knownIds : [],
        lastSync: rawChesscom.lastSync,
        jobs: Array.isArray(rawChesscom.jobs) ? rawChesscom.jobs : [],
      };
      const lichess: PipelineDataInfo = {
        version: 1,
        knownIds: Array.isArray(rawLichess.knownIds) ? rawLichess.knownIds : [],
        lastSync: rawLichess.lastSync,
        jobs: Array.isArray(rawLichess.jobs) ? rawLichess.jobs : [],
      };

      const changedCc = resumeStaleJobs(chesscom);
      const changedLi = resumeStaleJobs(lichess);

      state = {
        games,
        settings,
        chesscom,
        lichess,
        backups: Array.isArray(rawBackups) ? rawBackups : [],
      };

      if (seededInitially) {
        if (db) {
          await idbPut(db, 'seedVersion', 1);
        }
        try {
          localStorage?.setItem(MOBILE_SEED_FLAG_KEY, '1');
        } catch {
          // Non-fatal
        }
        await persistKeys(['games', 'settings']);
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new Event('pca-lan-sync-applied'));
        }
      }

      if (changedCc || changedLi) {
        await persistKeys(['chesscom', 'lichess']);
      }
      return state;
    })();

    return loadPromise;
  };

  const makePipelineMethods = (platform: 'chesscom' | 'lichess') => ({
    listJobs: async (): Promise<PipelineDataInfo> => {
      const s = await ensureLoaded();
      return s[platform];
    },

    claimNextJob: async (): Promise<PipelineJobInfo | null> => {
      const s = await ensureLoaded();
      const data = s[platform];
      const queued = data.jobs.filter((j) => j.status === 'queued').sort((a, b) => a.createdAt - b.createdAt);
      const job = queued[0] || null;
      if (!job) return null;
      job.status = 'analyzing';
      job.updatedAt = Date.now();
      for (const g of job.games) {
        if (!data.knownIds.includes(g.sourceId)) data.knownIds.push(g.sourceId);
      }
      if (data.knownIds.length > KNOWN_IDS_CAP) {
        data.knownIds = data.knownIds.slice(data.knownIds.length - KNOWN_IDS_CAP);
      }
      await persistKeys([platform]);
      return job;
    },

    markJob: async (id: string, patch: JobPatch): Promise<PipelineJobInfo | null> => {
      const s = await ensureLoaded();
      const data = s[platform];
      const job = data.jobs.find((j) => j.id === id);
      if (!job) return null;
      applyJobPatch(job, patch, Date.now());
      if (job.status === 'saved') {
        data.lastSync = {
          username: job.username,
          at: job.updatedAt,
          savedCount: job.savedCount,
          failedCount: job.failedCount,
          newCount: job.savedCount,
        };
      }
      await persistKeys([platform]);
      return job;
    },

    cancelJob: async (id: string): Promise<PipelineJobInfo | null> => {
      const s = await ensureLoaded();
      const data = s[platform];
      const job = data.jobs.find((j) => j.id === id);
      if (!job) return null;
      if (job.status === 'queued' || job.status === 'failed') {
        applyJobPatch(job, { status: 'cancelled' }, Date.now());
        await persistKeys([platform]);
      }
      return job;
    },
  });

  const chesscomPipeline = makePipelineMethods('chesscom');
  const lichessPipeline = makePipelineMethods('lichess');

  return {
    isMobile: true,
    engine,

    db: {
      saveGame: async (game: GameAnalysis): Promise<GameAnalysis> => {
        const s = await ensureLoaded();
        const enriched = ensureAnnotatedGame(game);
        let replacedGame: GameAnalysis | null = null;
        const existingIndex = s.games.findIndex((g) => g.id === enriched.id);

        if (existingIndex >= 0) {
          const prev = s.games[existingIndex];
          replacedGame = ensureAnnotatedGame({
            ...enriched,
            createdAt: prev.createdAt || enriched.createdAt,
            playedAt: enriched.playedAt || prev.playedAt,
            previousIds: mergePreviousIds(prev, enriched),
          });
          s.games[existingIndex] = replacedGame;
        } else {
          const fp = gameFingerprint(enriched);
          const dupIndex = s.games.findIndex((g) => {
            if (isStableGameId(enriched.id) && isStableGameId(g.id)) return false;
            if (gameFingerprint(g) !== fp) return false;
            return sameSourceIdentity(g, enriched);
          });
          if (dupIndex >= 0) {
            const prev = s.games[dupIndex];
            replacedGame = ensureAnnotatedGame({
              ...enriched,
              createdAt: prev.createdAt || enriched.createdAt,
              playedAt: enriched.playedAt || prev.playedAt,
              previousIds: mergePreviousIds(prev, enriched),
            });
            s.games[dupIndex] = replacedGame;
          } else {
            s.games = [enriched, ...s.games];
          }
        }
        await persistKeys(['games']);
        return replacedGame || enriched;
      },

      getGames: async (playerName?: string): Promise<ArchiveItem[]> => {
        const s = await ensureLoaded();
        const target = playerName ?? s.settings.playerName;
        let changed = false;
        const annotated = s.games.map((g) => {
          const next = ensureAnnotatedGame(g);
          if (next !== g) changed = true;
          return next;
        });
        if (changed) s.games = annotated;
        return s.games.map((g) => archiveItem(g, target));
      },

      getGame: async (id: string): Promise<GameAnalysis | null> => {
        const s = await ensureLoaded();
        const idx = s.games.findIndex((g) => g.id === id);
        if (idx < 0) return null;
        const current = s.games[idx];
        const enriched = ensureAnnotatedGame(current);
        if (enriched !== current) s.games[idx] = enriched;
        return enriched;
      },

      deleteGame: async (id: string): Promise<boolean> => {
        const s = await ensureLoaded();
        const before = s.games.length;
        s.games = s.games.filter((g) => g.id !== id);
        if (s.games.length === before) return false;
        await persistKeys(['games']);
        return true;
      },

      getPlayerStats: async (playerName: string, filter?: StatisticsFilter): Promise<PlayerStats> => {
        const token = ++statsRequestToken;
        const s = await ensureLoaded();
        if (token !== statsRequestToken) {
          throw new DOMException('Diagnostik-Berechnung abgebrochen.', 'AbortError');
        }
        return computePlayerStatsAsync(
          s.games,
          playerName,
          s.settings.openingWindowMoves,
          filter,
          () => token !== statsRequestToken,
        );
      },

      cancelPlayerStats: async (): Promise<void> => {
        statsRequestToken++;
      },

      getStableGameIds: async (): Promise<string[]> => {
        const s = await ensureLoaded();
        return s.games.map((g) => g.id).filter(isStableGameId);
      },

      getReviewIdMap: async (): Promise<Record<string, string>> => {
        const s = await ensureLoaded();
        const map: Record<string, string> = {};
        for (const g of s.games) {
          if (!isStableGameId(g.id) || !g.previousIds) continue;
          for (const prevId of g.previousIds) {
            if (prevId && !map[prevId]) map[prevId] = g.id;
          }
        }
        return map;
      },
    },

    chesscom: {
      fetchGames: (username: string, year: number, month: number) =>
        fetchMonthlyGames(username, year, month),

      fetchUserProfile: async (username: string): Promise<{ exists: boolean; name?: string }> => {
        const cleanName = username.trim();
        if (!cleanName) return { exists: false };
        try {
          const response = await fetchWithBackoff(
            `https://api.chess.com/pub/player/${encodeURIComponent(cleanName)}`
          );
          if (response.status === 404) return { exists: false };
          if (!response.ok) return { exists: true };
          const payload = (await response.json()) as { username?: string };
          return { exists: true, name: payload.username };
        } catch {
          return { exists: true };
        }
      },

      fetchLatestGame: async (username: string): Promise<ChessComGameSummary | null> => {
        const name = username.trim();
        if (!/^[A-Za-z0-9_-]{1,30}$/.test(name)) {
          throw new Error('Bitte hinterlege einen gültigen Chess.com-Benutzernamen in den Einstellungen.');
        }
        const archives = await fetchArchives(name);
        const months = [
          ...new Set(
            archives.flatMap((value) => {
              const match = value.match(/\/games\/(\d{4})\/(\d{2})$/);
              return match && Number(match[2]) >= 1 && Number(match[2]) <= 12
                ? [`${match[1]}/${match[2]}`]
                : [];
            })
          ),
        ]
          .sort()
          .reverse();
        for (const month of months) {
          const [y, m] = month.split('/').map(Number);
          const games = await fetchMonthlyGames(name, y, m);
          const latest = games.find(
            (game) =>
              (!game.rules || game.rules === 'chess') &&
              ['1-0', '0-1', '1/2-1/2'].includes(game.result)
          );
          if (latest) return latest;
        }
        return null;
      },

      ...chesscomPipeline,

      createJob: async (username: string, daysWindow: number) => {
        const cleanName = username.trim();
        if (!/^[A-Za-z0-9_-]{1,30}$/.test(cleanName)) {
          throw new Error('Ungültiger chess.com-Benutzername (max. 30 Zeichen, Buchstaben/Zahlen/-/_).');
        }
        const days = Math.max(1, Math.min(365, Math.floor(daysWindow) || 30));
        const s = await ensureLoaded();
        const knownAtStart = new Set(s.chesscom.knownIds);
        const nowMs = Date.now();
        const months = monthsForWindow(nowMs, days);
        const discovered: PipelineJobInfo['games'] = [];

        for (const { year, month } of months) {
          const summaries = await fetchMonthlyGames(cleanName, year, month);
          for (const summary of summaries) {
            if (!isSupportedChessComGame(summary)) continue;
            if (!withinChessComWindow(summary, nowMs, days)) continue;
            const id = chessComSourceIdOf(summary);
            if (knownAtStart.has(id)) continue;
            knownAtStart.add(id);
            discovered.push({
              sourceId: id,
              pgn: summary.pgn,
              playedAt: summary.endTime ? new Date(summary.endTime * 1000).toISOString() : undefined,
            });
          }
        }

        const freshKnown = new Set(s.chesscom.knownIds);
        const games = discovered.filter((g) => !freshKnown.has(g.sourceId));
        for (const g of games) {
          if (!s.chesscom.knownIds.includes(g.sourceId)) s.chesscom.knownIds.push(g.sourceId);
        }
        if (s.chesscom.knownIds.length > KNOWN_IDS_CAP) {
          s.chesscom.knownIds = s.chesscom.knownIds.slice(s.chesscom.knownIds.length - KNOWN_IDS_CAP);
        }
        const merged = mergeDiscoveryIntoPipeline(s.chesscom, cleanName, games, Date.now());
        await persistKeys(['chesscom']);
        return merged;
      },
    },

    lichess: {
      ...lichessPipeline,

      createJob: async (username: string, daysWindow: number) => {
        const cleanName = username.trim();
        if (!/^[A-Za-z0-9_-]{1,25}$/.test(cleanName)) {
          throw new Error('Ungültiger Lichess-Benutzername (max. 25 Zeichen, Buchstaben/Zahlen/-/_).');
        }
        const days = Math.max(1, Math.min(365, Math.floor(daysWindow) || 30));
        const s = await ensureLoaded();
        const knownAtStart = new Set(s.lichess.knownIds);
        const nowMs = Date.now();
        const sinceMs = nowMs - days * 86_400_000;
        const fetched = await fetchLichessGamesMobile(cleanName, sinceMs);
        const discovered: PipelineJobInfo['games'] = [];

        for (const summary of fetched) {
          if (summary.variant !== 'standard' || !summary.pgn || !summary.endedAt) continue;
          if (!LICHESS_FINISHED_STATUSES.has(summary.status)) continue;
          if (nowMs - summary.endedAt > (days + 1) * 86_400_000) continue;
          if (knownAtStart.has(summary.sourceId)) continue;
          knownAtStart.add(summary.sourceId);
          discovered.push({
            sourceId: summary.sourceId,
            pgn: summary.pgn,
            playedAt: new Date(summary.endedAt).toISOString(),
          });
        }

        const freshKnown = new Set(s.lichess.knownIds);
        const games = discovered.filter((g) => !freshKnown.has(g.sourceId));
        for (const g of games) {
          if (!s.lichess.knownIds.includes(g.sourceId)) s.lichess.knownIds.push(g.sourceId);
        }
        if (s.lichess.knownIds.length > KNOWN_IDS_CAP) {
          s.lichess.knownIds = s.lichess.knownIds.slice(s.lichess.knownIds.length - KNOWN_IDS_CAP);
        }
        const merged = mergeDiscoveryIntoPipeline(s.lichess, cleanName, games, Date.now());
        await persistKeys(['lichess']);
        return merged;
      },
    },

    data: {
      getPath: async (): Promise<string> => `IndexedDB://${MOBILE_DB_NAME}`,

      openFolder: async (): Promise<void> => {
        throw new Error(
          'Auf Mobilgeräten gibt es keinen lokalen Datenordner. Nutze „Vollständig exportieren“ zum Sichern.'
        );
      },

      createBackup: async (learningStorage: Record<string, string>) => {
        const s = await ensureLoaded();
        const createdAt = new Date().toISOString();
        const id = `backup-${createdAt.replace(/[:.]/g, '-')}`;
        const bundle: DataBundle = {
          format: 'personal-chess-analyzer',
          version: 1,
          createdAt,
          games: s.games,
          settings: s.settings,
          learningStorage: validateLearningStorage(learningStorage),
        };
        const packed = await compressBackupBundle(bundle);
        s.backups = [{ id, createdAt, ...packed }, ...s.backups].slice(0, 3);
        await persistKeys(['backups']);
        return { path: `IndexedDB://${MOBILE_DB_NAME}/backups/${id}`, files: 3 };
      },

      exportData: async (learningStorage: Record<string, string>): Promise<string | null> => {
        const s = await ensureLoaded();
        const bundle: DataBundle = {
          format: 'personal-chess-analyzer',
          version: 1,
          createdAt: new Date().toISOString(),
          games: s.games,
          settings: s.settings,
          learningStorage: validateLearningStorage(learningStorage),
        };
        const encoded = await encodeDataBundleMobile(bundle);
        const filename = `chess-backup-${new Date().toISOString().slice(0, 10)}.json`;
        triggerBrowserDownload(filename, encoded);
        return filename;
      },

      inspectData: async (): Promise<DataBundle | null> => {
        const text = await pickJsonFileText();
        if (!text) return null;
        return decodeDataBundleMobile(text);
      },

      restoreData: async (bundle: DataBundle): Promise<boolean> => {
        const validated = validateDataBundle(bundle);
        const s = await ensureLoaded();
        const status = await engine.getStatus();
        const restoredSettings = normalizeAppSettings(
          { ...validated.settings, stockfishPath: s.settings.stockfishPath || status.path },
          status.path
        );
        s.games = validated.games.map(ensureAnnotatedGame);
        s.settings = restoredSettings;
        s.chesscom = emptyPipelineData();
        s.lichess = emptyPipelineData();
        configureProfile(restoredSettings);
        await persistKeys(['games', 'settings', 'chesscom', 'lichess']);
        return true;
      },
    },

    settings: {
      get: async (): Promise<AppSettings | null> => {
        const s = await ensureLoaded();
        return s.settings;
      },

      save: async (partial: Partial<AppSettings>): Promise<AppSettings> => {
        const s = await ensureLoaded();
        const current = s.settings;
        const status = await engine.getStatus();
        const updated = normalizeAppSettings(
          {
            ...current,
            ...partial,
            profileId: current.profileId,
            playerAliases: [...new Set([...current.playerAliases, current.playerName])],
            accountAliases: {
              chessCom: [...new Set([...current.accountAliases.chessCom, current.chessComUsername])].filter(Boolean),
              lichess: [...new Set([...current.accountAliases.lichess, current.lichessUsername])].filter(Boolean),
            },
          },
          status.path || APP_SETTINGS_DEFAULTS.stockfishPath
        );
        s.settings = updated;
        configureProfile(updated);
        await persistKeys(['settings']);
        return updated;
      },
    },

    lanSync: (() => {
      let lastSync: SyncSummary | null = null;
      const statusObj = (): LanSyncStatus => ({
        running: false,
        port: DEFAULT_LAN_SYNC_PORT,
        ips: [],
        deviceName: 'Android / Mobilgerät',
        lastSync,
      });

      return {
        getStatus: async (): Promise<LanSyncStatus> => statusObj(),
        startServer: async (): Promise<LanSyncStatus> => statusObj(),
        stopServer: async (): Promise<LanSyncStatus> => statusObj(),
        syncWithPeer: async (hostOrIp: string, learningStorage: Record<string, string>) => {
          const baseUrl = normalizeLanPeerEndpoint(hostOrIp);
          const s = await ensureLoaded();
          const localPayload: SyncPayload = {
            format: 'personal-chess-analyzer-lan-sync',
            version: 1,
            sentAt: new Date().toISOString(),
            deviceName: 'Android / Mobilgerät',
            games: s.games,
            settings: s.settings,
            learningStorage: validateLearningStorage(learningStorage),
          };
          const { status: httpStatus, text } = await sendLanPostJson(`${baseUrl}/api/lan-sync/sync`, localPayload);
          let parsed: { ok?: boolean; mergedPayload?: unknown; summary?: SyncSummary; error?: string };
          try {
            parsed = JSON.parse(text) as { ok?: boolean; mergedPayload?: unknown; summary?: SyncSummary; error?: string };
          } catch {
            throw new Error(`Ungültige Server-Antwort vom PC (HTTP ${httpStatus}).`);
          }
          if (httpStatus < 200 || httpStatus >= 300 || !parsed.ok || !isValidSyncPayload(parsed.mergedPayload) || !parsed.summary) {
            throw new Error(parsed.error || `Heimnetz-Sync fehlgeschlagen (HTTP ${httpStatus}).`);
          }

          const status = await engine.getStatus();
          const mergedSettings = normalizeAppSettings(
            {
              ...parsed.mergedPayload.settings,
              stockfishPath: s.settings.stockfishPath || status.path,
            },
            status.path || APP_SETTINGS_DEFAULTS.stockfishPath
          );
          s.games = parsed.mergedPayload.games.map(ensureAnnotatedGame);
          s.settings = mergedSettings;
          configureProfile(mergedSettings);
          await persistKeys(['games', 'settings']);
          lastSync = parsed.summary;

          return {
            summary: parsed.summary,
            mergedLearningStorage: validateLearningStorage(parsed.mergedPayload.learningStorage),
          };
        },
      };
    })(),
  };
}

export function ensureMobileElectronAPI(): ElectronAPI | undefined {
  if (typeof window === 'undefined') return undefined;
  if (!window.electronAPI) {
    window.electronAPI = createMobileElectronAPI();
  }
  return window.electronAPI;
}
