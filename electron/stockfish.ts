import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { Chess } from 'chess.js';
import { LineAssembler, isValidFen } from './uci';
import type { EngineSearchOptions } from '../src/types/chess';

export interface EvalOptions {
  depth?: number;
  multiPv?: number;
}

export type AnalysisStatus = 'complete' | 'partial' | 'unavailable';

export interface EngineResult {
  scoreCp: number;
  mate?: number;
  bestMoveUci: string;
  pv: string[];
  /** Angeforderte Tiefe (Kompatibilität zu bestehenden Aufrufern). */
  depth: number;
  /** Tatsächlich per `info depth N` erreichte Tiefe dieser Suche. */
  actualDepth: number;
  /** Score-Qualität laut UCI (lowerbound/upperbound bei gestoppten Suchen). */
  bound: 'exact' | 'lower' | 'upper';
  /** complete = bestmove erhalten; partial = abgebrochen mit Teildaten; unavailable = keine Engine. */
  status: AnalysisStatus;
}

export interface MultiPvResult extends EngineResult {
  moves: { uci: string; scoreCp: number; mate?: number; pv: string[] }[];
}

// ---------------------------------------------------------------------------
// Grenzwerte (T02: harte Gesamtlaufzeit zusätzlich zur Output-Inaktivität)
// ---------------------------------------------------------------------------
const INIT_TIMEOUT_MS = 8000;
const OUTPUT_TIMEOUT_MS = 15000;
const SEARCH_HARD_LIMIT_MS = 120000;
const STOP_GRACE_MS = 2000;
const KILL_FAILSAFE_MS = 1000;
const MAX_DEPTH = 30;
const MAX_MULTIPV = 5;
/** Pseudo-Score für terminale Stellungen (Matt am Brett) in cp. */
export const TERMINAL_SCORE_CP = 100000;

/**
 * UCI-Zeilengrenzen (LineAssembler) und FEN-Validierung (isValidFen) leben in
 * uci.ts — electron-frei und damit in Regressionstests ladbar (T02).
 */

/** Ein lebhafte Engine-Prozess mit eigenem Zustand (T01: Generationen statt shared mutable this.process). */
interface EngineSession {
  proc: ChildProcess;
  generation: number;
  name: string;
  ready: boolean;
  assembler: LineAssembler;
  /** Aktive Suche — maximal eine gleichzeitig (Queue serialisiert). */
  search: ActiveSearch | null;
  /** Laufender uci/isready-Handshake. */
  handshake: { resolve: (ok: boolean) => void; timer: NodeJS.Timeout } | null;
}

interface ActiveSearch {
  requestId?: string;
  requestedDepth: number;
  multiPv: number;
  isWhiteToMove: boolean;
  // Primär-Variante (multipv 1 bzw. Einzel-PV)
  scoreCp: number;
  mate: number | undefined;
  bestPv: string[];
  bound: 'exact' | 'lower' | 'upper';
  actualDepth: number;
  // MultiPV-Sammlung
  pvMap: Map<number, { uci: string; scoreCp: number; mate?: number; pv: string[]; depth: number }>;
  sawInfo: boolean;
  stopRequested: boolean;
  settled: boolean;
  resolve: (result: MultiPvResult) => void;
  inactivityTimer: NodeJS.Timeout;
  hardTimer: NodeJS.Timeout;
  stopGraceTimer: NodeJS.Timeout | null;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** `(none)` und `0000` sind Leerzüge — beides als leer normalisieren. */
function normalizeBestMove(token: string): string {
  if (!token || token === '(none)' || token === '0000') return '';
  return token;
}

function normalizeSearchOptions(rawOptions?: EngineSearchOptions): EngineSearchOptions | undefined {
  return rawOptions && typeof rawOptions === 'object' ? {
    requestId: typeof rawOptions.requestId === 'string' && /^(why|review|ai)-[a-zA-Z0-9-]{1,100}$/.test(rawOptions.requestId) ? rawOptions.requestId : undefined,
    maxTimeMs: rawOptions.maxTimeMs === undefined ? undefined : clampInt(rawOptions.maxTimeMs, 100, 10000, 2500),
    deadlineAt: typeof rawOptions.deadlineAt === 'number' && Number.isFinite(rawOptions.deadlineAt) ? Math.min(rawOptions.deadlineAt, Date.now() + 60000) : undefined,
    searchMoves: Array.isArray(rawOptions.searchMoves) ? rawOptions.searchMoves.filter(uci => typeof uci === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)).slice(0, 16) : undefined,
  } : undefined;
}

export class StockfishEngine {
  private currentPath: string = '';
  private engineName: string = 'Stockfish';
  /** Aktuelle Session — Event-Handler greifen immer auf ihre EIGENE Session zu. */
  private session: EngineSession | null = null;
  private sessionGeneration = 0;
  /** Geteilte Initialisierungs-Promise: parallele Aufrufe teilen denselben Handshake (T01). */
  private initPromise: Promise<boolean> | null = null;
  /** R02: Während eines laufenden Handshakes verwaltete Session (killbar). */
  private initSession: EngineSession | null = null;
  /** Serialisiert alle UCI-Suchen: nie zwei `go depth` mit gemischten info-Zeilen. */
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private cancelledRequests = new Set<string>();
  /** Phase 6: UCI-Optionen (Threads/Hash) — angewandt vor der nächsten Suche. */
  private desiredThreads = 1;
  private desiredHashMb = 64;

  constructor() {
    this.currentPath = this.getDefaultPath();
  }

  /** Phase 6: Engine-Threads/Hash setzen (UCI) — Anwendung vor der nächsten Suche. */
  setEngineOptions(threads: number, hashMb: number): void {
    this.desiredThreads = Math.max(1, Math.min(4, Math.round(threads) || 1));
    this.desiredHashMb = Math.max(16, Math.min(512, Math.round(hashMb) || 64));
  }

  getDefaultPath(): string {
    const appPath = app.getAppPath();
    const cwd = process.cwd();
    const possiblePaths = [
      path.join(appPath, 'engine', 'stockfish.exe'),
      path.join(cwd, 'engine', 'stockfish.exe'),
      // Handle case where user placed the zip-extracted folder as "engine/stockfish.exe/"
      path.join(appPath, 'engine', 'stockfish.exe', 'stockfish.exe'),
      path.join(cwd, 'engine', 'stockfish.exe', 'stockfish.exe'),
      path.join(appPath, 'engine', 'stockfish.exe', 'stockfish', 'stockfish-windows-x86-64-universal.exe'),
      path.join(cwd, 'engine', 'stockfish.exe', 'stockfish', 'stockfish-windows-x86-64-universal.exe'),
      path.join(app.getPath('userData'), 'stockfish.exe'),
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p) && !fs.statSync(p).isDirectory()) {
        return p;
      }
    }
    return possiblePaths[0];
  }

  isInstalled(): boolean {
    return fs.existsSync(this.currentPath) && !fs.statSync(this.currentPath).isDirectory();
  }

  getPath(): string {
    return this.currentPath;
  }

  /** Rein beobachtend — startet NIEMALS einen Prozess (T01). */
  getStatus(): { installed: boolean; path: string; engineName: string; ready: boolean } {
    return {
      installed: this.isInstalled(),
      path: this.currentPath,
      engineName: this.engineName,
      ready: this.isReady(),
    };
  }

  private isReady(): boolean {
    return !!this.session && this.session.ready && this.session.proc.exitCode === null;
  }

  /**
   * Idempotente Initialisierung: läuft bereits ein Handshake, teilen alle
   * Aufrufer dieselbe Promise; ist die Session bereit, passiert nichts.
   */
  ensureReady(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (this.isReady()) return Promise.resolve(true);
    if (!this.isInstalled()) return Promise.resolve(false);
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInit().finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  setPath(newPath: string): boolean {
    if (fs.existsSync(newPath) && !fs.statSync(newPath).isDirectory()) {
      this.currentPath = newPath;
      // Kontrollierter Abbruch: laufende Suche wird via exit-Event mit
      // Teildaten aufgelöst, die Queue läuft weiter, die nächste Suche
      // initialisiert gegen den neuen Pfad (T01).
      this.restartSession();
      return true;
    }
    return false;
  }

  private restartSession(): void {
    this.initPromise = null;
    const session = this.session;
    this.session = null;
    if (session) {
      session.ready = false;
      const hs = session.handshake;
      if (hs) {
        clearTimeout(hs.timer);
        session.handshake = null;
        hs.resolve(false);
      }
      if (session.search) {
        const search = session.search;
        session.search = null;
        this.settleSearch(session, search, 'unavailable');
      }
      try {
        session.proc.kill();
      } catch (e) {
        /* Prozess war bereits tot */
      }
    }
    // R02: Auch eine NOCH startende Session (laufender Handshake) muss
    // verworfen werden — dispose()/setPath() dürfen keinen Spawn zurücklassen.
    const pendingInit = this.initSession;
    this.initSession = null;
    if (pendingInit && pendingInit !== session) {
      pendingInit.ready = false;
      const hs = pendingInit.handshake;
      if (hs) {
        clearTimeout(hs.timer);
        pendingInit.handshake = null;
        hs.resolve(false);
      }
      try {
        pendingInit.proc.kill();
      } catch (e) {
        /* Prozess war bereits tot */
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.restartSession();
  }

  // -------------------------------------------------------------------------
  // Initialisierung / Session-Aufbau
  // -------------------------------------------------------------------------

  private doInit(): Promise<boolean> {
    if (!this.isInstalled()) return Promise.resolve(false);

    return new Promise<boolean>((resolve) => {
      let proc: ChildProcess;
      try {
        proc = spawn(this.currentPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch {
        resolve(false);
        return;
      }

      const session: EngineSession = {
        proc,
        generation: ++this.sessionGeneration,
        name: this.engineName,
        ready: false,
        assembler: new LineAssembler(),
        search: null,
        handshake: null,
      };

      const finish = (ok: boolean) => {
        if (session.handshake) {
          clearTimeout(session.handshake.timer);
          session.handshake = null;
        }
        // R02: Ein veralteter Initialisierungslauf (zwischenzeitlich durch
        // restartSession/setPath/dispose ersetzt) darf this.session NIEMALS
        // werden — sonst überlebt bzw. reanimiert ein verworfener Prozess.
        const isCurrentInit = this.initSession === session && !this.disposed;
        if (this.initSession === session) this.initSession = null;
        if (ok && isCurrentInit) {
          this.session = session;
          this.engineName = session.name;
          resolve(true);
        } else {
          if (this.session === session) this.session = null;
          try {
            proc.kill();
          } catch (e) {
            /* Spawn fehlgeschlagen — nichts zu killen */
          }
          resolve(false);
        }
      };

      this.initSession = session;
      session.handshake = { resolve: finish, timer: setTimeout(() => finish(false), INIT_TIMEOUT_MS) };

      proc.on('error', () => {
        session.ready = false;
        finish(false);
      });
      proc.on('exit', () => {
        session.ready = false;
        finish(false);
        this.onSessionExit(session);
      });
      proc.stdout?.setEncoding('utf8');
      proc.stdout?.on('data', (chunk: string) => {
        for (const line of session.assembler.push(chunk)) {
          this.handleLine(session, line);
        }
      });

      try {
        proc.stdin?.write('uci\n');
      } catch {
        finish(false);
      }
    });
  }

  /**
   * Zentrale Zeilenverarbeitung. Jede Zeile gehört zu genau einer Session;
   * tote Sessions können nie wieder in den aktuellen Zustand schreiben.
   */
  private handleLine(session: EngineSession, rawLine: string): void {
    const line = rawLine.trim();
    if (!line) return;

    if (line.startsWith('id name ')) {
      session.name = line.slice('id name '.length).trim() || session.name;
      return;
    }

    if (line === 'uciok') {
      try {
        session.proc.stdin?.write('isready\n');
      } catch (e) {
        /* Handshake schlägt über den exit-Handler fehl */
      }
      return;
    }

    if (line === 'readyok') {
      session.ready = true;
      const hs = session.handshake;
      if (hs) {
        clearTimeout(hs.timer);
        session.handshake = null;
        hs.resolve(true);
      }
      return;
    }

    if (session.search) {
      this.handleSearchLine(session, session.search, line);
    }
    // Alles andere (info string, debug, ...) außerhalb einer Suche ignorieren.
  }

  // -------------------------------------------------------------------------
  // Such-Zustandsautomat (T02)
  // -------------------------------------------------------------------------

  private handleSearchLine(session: EngineSession, search: ActiveSearch, line: string): void {
    if (line.startsWith('info')) {
      const depthMatch = line.match(/\bdepth (\d+)/);
      const multiPvMatch = line.match(/\bmultipv (\d+)/);
      const pvIdx = multiPvMatch ? parseInt(multiPvMatch[1], 10) : 1;
      const scoreMatch = line.match(/\bscore (cp|mate) (-?\d+)/);
      const pvMatch = line.match(/\bpv (.+)$/);

      if (!scoreMatch && !pvMatch) return; // currmove/hash/NPS-Zeilen interessieren nicht

      const isLowerbound = /\blowerbound\b/.test(line);
      const isUpperbound = /\bupperbound\b/.test(line);
      const bound: 'exact' | 'lower' | 'upper' = isLowerbound ? 'lower' : isUpperbound ? 'upper' : 'exact';
      const depth = depthMatch ? parseInt(depthMatch[1], 10) : search.actualDepth;
      const pvArr = pvMatch ? pvMatch[1].trim().split(/\s+/) : [];

      let cpRaw = 0;
      let mateRaw: number | undefined;
      if (scoreMatch) {
        if (scoreMatch[1] === 'cp') {
          cpRaw = parseInt(scoreMatch[2], 10);
        } else {
          mateRaw = parseInt(scoreMatch[2], 10);
        }
      }
      const scoreCpWhitePov = search.isWhiteToMove ? cpRaw : -cpRaw;
      const mateWhitePov = mateRaw !== undefined ? (search.isWhiteToMove ? mateRaw : -mateRaw) : undefined;
      const uci = pvArr[0] ? normalizeBestMove(pvArr[0]) : '';

      const entry = {
        uci: uci || (pvIdx === 1 ? '' : ''),
        scoreCp: scoreCpWhitePov,
        mate: mateWhitePov,
        pv: pvArr,
        depth,
      };

      // MultiPV-Map immer pflegen (auch bei multiPv=1 — Kosten ~0, Logik einheitlich)
      const existing = search.pvMap.get(pvIdx);
      // Nur "echte" Iterationen überschreiben: bound-Zeilen (mit hi/lo) nicht
      // als endgültigen Wert einer besser bewerteten Variante verdrängen lassen.
      const better =
        !existing ||
        depth >= existing.depth ||
        (bound === 'exact' && existing ? true : false);
      if (better) search.pvMap.set(pvIdx, entry);

      if (pvIdx === 1) {
        search.scoreCp = scoreCpWhitePov;
        search.mate = mateWhitePov;
        search.bound = bound;
        if (depth > search.actualDepth) search.actualDepth = depth;
        if (pvArr.length > 0) search.bestPv = pvArr;
      }
      search.sawInfo = true;
      this.resetInactivity(session, search);
      return;
    }

    if (line.startsWith('bestmove')) {
      // Dieser bestmove gehört ZWINGEND zur laufenden Suche: die Queue startet
      // die nächste Suche erst, NACHDEM dieser gesetzt und die Suche aufgelöst
      // wurde (T02: stop → bestmove-Kopplung).
      const token = line.split(/\s+/)[1] || '';
      const best = normalizeBestMove(token);
      search.stopGraceTimer = null;
      // R09: Abgebrochene/leere Läufe niemals als 'complete' melden:
      // - bestmove ganz ohne info-Frame → 'unavailable' (scoreCp wäre nur der
      //   0-Platzhalter, keine belastbare Auswertung);
      // - bestmove nach angefordertem stop → 'partial' (Tiefe nicht erreicht,
      //   auch wenn das letzte info-Frame 'exact' meldete);
      // - bound !== 'exact' → 'partial' (letzte Meldung war eine Grenzsuche).
      // Niedrige Tiefe ALLEIN ist KEIN Fehler: legitime frühe Engine-Abschlüsse
      // (z. B. gefundenes Matt) bleiben 'complete'.
      const abortedStatus: AnalysisStatus = !search.sawInfo
        ? 'unavailable'
        : search.stopRequested || search.bound !== 'exact'
          ? 'partial'
          : 'complete';
      this.settleSearch(session, search, abortedStatus, best);
    }
  }

  private resetInactivity(session: EngineSession, search: ActiveSearch): void {
    clearTimeout(search.inactivityTimer);
    search.inactivityTimer = setTimeout(() => {
      this.handleSearchTimeout(session, search);
    }, OUTPUT_TIMEOUT_MS);
  }

  /** Inaktivitäts- ODER harte Gesamtlaufzeit überschritten: kontrolliert stoppen. */
  private handleSearchTimeout(session: EngineSession, search: ActiveSearch, cancelled = false): void {
    if (search.settled) return;
    if (search.stopRequested) return;
    search.stopRequested = true;
    if (!cancelled) console.warn('[Stockfish] Suche reagiert nicht — stop angefordert.');
    try {
      session.proc.stdin?.write('stop\n');
    } catch (e) {
      /* Prozess tot — exit-Handler löst auf */
    }
    search.stopGraceTimer = setTimeout(() => {
      if (search.settled) return;
      // bestmove blieb aus: Prozess kontrolliert ersetzen, BEVOR die Queue
      // freigegeben wird — sonst würde das späte bestmove in die nächste
      // Suche rutschen (Originaldefekt T02).
      console.warn('[Stockfish] bestmove nach stop ausgeblieben — Engine-Prozess wird ersetzt.');
      this.killSession(session);
    }, STOP_GRACE_MS);
  }

  private clearSearchTimers(search: ActiveSearch): void {
    clearTimeout(search.inactivityTimer);
    clearTimeout(search.hardTimer);
    if (search.stopGraceTimer) {
      clearTimeout(search.stopGraceTimer);
      search.stopGraceTimer = null;
    }
  }

  private settleSearch(
    session: EngineSession | null,
    search: ActiveSearch,
    status: AnalysisStatus,
    bestMoveOverride?: string,
  ): void {
    if (search.settled) return;
    search.settled = true;
    this.clearSearchTimers(search);
    if (session && session.search === search) {
      session.search = null;
    }

    // R09: Der bestmove-Pfad markiert abgebrochene/leere Läufe bereits als
    // 'partial'/'unavailable' (stopRequested/sawInfo/bound). Hier verbleibt
    // die bound-Sicherung für 'complete'-Aufrufe. Niedrige Tiefe ALLEIN ist
    // KEIN Fehler — legitime frühe Engine-Abschlüsse (z. B. gefundenes Matt)
    // bleiben 'complete'.
    const finalStatus: AnalysisStatus =
      status === 'complete' && search.bound !== 'exact'
        ? 'partial'
        : status;
    const bestMoveUci =
      bestMoveOverride !== undefined
        ? bestMoveOverride
        : normalizeBestMove(search.bestPv[0] || '');

    const primary = search.pvMap.get(1);
    const result: MultiPvResult = {
      scoreCp: primary ? primary.scoreCp : search.scoreCp,
      mate: primary ? primary.mate : search.mate,
      bestMoveUci: bestMoveUci || (primary ? primary.uci : ''),
      pv: search.bestPv,
      depth: search.requestedDepth,
      actualDepth: primary ? Math.max(search.actualDepth, primary.depth) : search.actualDepth,
      bound: search.bound,
      status: finalStatus,
      moves:
        search.multiPv > 1
          ? Array.from({ length: search.multiPv }, (_, i) => search.pvMap.get(i + 1))
              .filter((m): m is NonNullable<typeof m> => !!m && !!m.uci)
              .map(({ uci, scoreCp, mate, pv }) => ({ uci, scoreCp, mate, pv }))
          : [],
    };
    search.resolve(result);
  }

  private onSessionExit(session: EngineSession): void {
    session.ready = false;
    const hs = session.handshake;
    if (hs) {
      clearTimeout(hs.timer);
      session.handshake = null;
      hs.resolve(false);
    }
    if (session.search) {
      const search = session.search;
      session.search = null;
      // Crash mitten in der Suche: gesammelte Teildaten mit Kennzeichnung liefern,
      // Queue weiterlaufen lassen (T02: Crash blockiert Queue nicht).
      this.settleSearch(session, search, search.sawInfo ? 'partial' : 'unavailable');
    }
    if (this.session === session) {
      this.session = null;
    }
  }

  private killSession(session: EngineSession): void {
    session.ready = false;
    try {
      session.proc.kill();
    } catch (e) {
      /* bereits tot */
    }
    // Fail-safe: garantiertes Auflösen, falls das exit-Event ausbleibt.
    const search = session.search;
    if (search) {
      setTimeout(() => {
        this.settleSearch(session, search, search.sawInfo ? 'partial' : 'unavailable');
      }, KILL_FAILSAFE_MS);
    }
  }

  // -------------------------------------------------------------------------
  // Öffentliche Such-API (Queue-serialisiert)
  // -------------------------------------------------------------------------

  cancelRequest(requestId: string): void {
    this.cancelledRequests.add(requestId);
    if (this.cancelledRequests.size > 300) this.cancelledRequests.delete(this.cancelledRequests.values().next().value!);
    const session = this.session;
    if (session?.search?.requestId === requestId) this.handleSearchTimeout(session, session.search, true);
  }

  async evaluateFen(fen: string, depth: number = 14, historyUci?: string[], currentFen?: string, rawOptions?: EngineSearchOptions): Promise<EngineResult> {
    const options = normalizeSearchOptions(rawOptions);
    const task = () => this.evaluateInternal(fen, depth, historyUci, 1, currentFen, options);
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async evaluateFenMultiPv(fen: string, depth: number = 14, multiPv: number = 3, historyUci?: string[], currentFen?: string, rawOptions?: EngineSearchOptions): Promise<MultiPvResult> {
    const options = normalizeSearchOptions(rawOptions);
    const task = () => this.evaluateInternal(fen, depth, historyUci, multiPv, currentFen, options);
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async evaluateInternal(fen: string, depth: number, historyUci: string[] | undefined, multiPv: number, currentFen?: string, options?: EngineSearchOptions): Promise<MultiPvResult> {
    const unavailable = (): MultiPvResult => ({
      scoreCp: 0,
      bestMoveUci: '',
      pv: [],
      depth: clampInt(depth, 1, MAX_DEPTH, 14),
      actualDepth: 0,
      bound: 'exact',
      status: 'unavailable' as AnalysisStatus,
      moves: [],
    });

    if (this.disposed) return unavailable();
    const stopped = () => !!(options?.requestId && this.cancelledRequests.has(options.requestId)) || !!(options?.deadlineAt && Date.now() >= options.deadlineAt);
    if (stopped()) return unavailable();
    if (!isValidFen(fen)) return unavailable();
    const validHistory = Array.isArray(historyUci)
      ? historyUci.filter((u) => typeof u === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(u)).slice(0, 1024)
      : [];

    if (options) {
      try {
        if (validHistory.length !== (historyUci?.length || 0)) return unavailable();
        const board = new Chess(fen);
        for (const uci of validHistory) board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
        if (currentFen && board.fen() !== currentFen) return unavailable();
        if (options.searchMoves) {
          const legal = new Set(board.moves({ verbose: true }).map(move => move.from + move.to + (move.promotion || '')));
          if (!options.searchMoves.length || options.searchMoves.some(uci => !legal.has(uci))) return unavailable();
        }
      } catch { return unavailable(); }
    }

    if (!this.isInstalled()) return unavailable();

    const ready = await this.ensureReady();
    const session = this.session;
    if (!ready || !session || session.proc.exitCode !== null || !session.ready || stopped()) {
      return unavailable();
    }

    const requestedDepth = clampInt(depth, 1, MAX_DEPTH, 14);
    const clampedMultiPv = clampInt(multiPv, 1, MAX_MULTIPV, 3);
    return this.runSearch(session, fen, requestedDepth, clampedMultiPv, validHistory, currentFen, options);
  }

  private runSearch(session: EngineSession, fen: string, requestedDepth: number, multiPv: number, historyUci: string[], currentFen?: string, options?: EngineSearchOptions): Promise<MultiPvResult> {
    return new Promise<MultiPvResult>((resolve) => {
      if (this.disposed || session.proc.exitCode !== null || !session.ready) {
        resolve({
          scoreCp: 0,
          bestMoveUci: '',
          pv: [],
          depth: requestedDepth,
          actualDepth: 0,
          bound: 'exact',
          status: 'unavailable',
          moves: [],
        });
        return;
      }

      const search: ActiveSearch = {
        requestId: options?.requestId,
        requestedDepth,
        multiPv,
        // R01-Nachtrag: POV/Richtung muss aus der ERREICHTEN Suchstellung
        // stammen — `fen` ist die Start-FEN, von der aus historyUci gespielt
        // wird; bei gespielter Historie ist die Seite am Zug dort eine andere.
        // Die Zugrichtung ist aus Start-FEN + Historienlänge eindeutig.
        // Damit bleibt die POV-Konversion auch dann korrekt, wenn ein älterer
        // IPC-Aufrufer currentFen nicht weiterreicht.
        isWhiteToMove: currentFen
          ? currentFen.includes(' w ')
          : (fen.includes(' w ') !== (historyUci.length % 2 === 1)),
        scoreCp: 0,
        mate: undefined,
        bestPv: [],
        bound: 'exact',
        actualDepth: 0,
        pvMap: new Map(),
        sawInfo: false,
        stopRequested: false,
        settled: false,
        resolve,
        inactivityTimer: undefined as unknown as NodeJS.Timeout,
        hardTimer: undefined as unknown as NodeJS.Timeout,
        stopGraceTimer: null,
      };

      search.inactivityTimer = setTimeout(() => this.handleSearchTimeout(session, search), OUTPUT_TIMEOUT_MS);
      const deadlineBudget = options?.deadlineAt ? Math.max(1, options.deadlineAt - Date.now()) : SEARCH_HARD_LIMIT_MS;
      search.hardTimer = setTimeout(() => this.handleSearchTimeout(session, search), Math.min(SEARCH_HARD_LIMIT_MS, deadlineBudget, options?.maxTimeMs ? options.maxTimeMs + 1500 : SEARCH_HARD_LIMIT_MS));

      session.search = search;

      // UCI empfiehlt die Zughistorie mitzuliefern (Wiederholungs-/50-Züge-Erkennung).
      const movesSuffix = historyUci.length > 0 ? ` moves ${historyUci.join(' ')}` : '';
      try {
        session.proc.stdin?.write(`setoption name MultiPV value ${multiPv}\n`);
        // Phase 6: Threads/Hash vor jeder Suche (setoption nur im Idle-Zustand — hier idle).
        session.proc.stdin?.write(`setoption name Threads value ${this.desiredThreads}\n`);
        session.proc.stdin?.write(`setoption name Hash value ${this.desiredHashMb}\n`);
        session.proc.stdin?.write(`position fen ${fen}${movesSuffix}\n`);
        const budget = options?.maxTimeMs ? ` movetime ${options.maxTimeMs}` : '';
        const restricted = options?.searchMoves ? ` searchmoves ${options.searchMoves.join(' ')}` : '';
        session.proc.stdin?.write(`go depth ${requestedDepth}${budget}${restricted}\n`);
      } catch {
        this.settleSearch(session, search, 'unavailable');
      }
    });
  }
}
