/**
 * Regressionstests für die P0-Audit-Umsetzung (T01–T06).
 * Läuft ohne Electron/Engine: testet nur die pure Logic
 * (pgn.ts, analysis.ts, jsonStore.ts, LineAssembler, isValidFen).
 *
 * WICHTIG: Module werden via createRequire geladen (Runtime-CJS-Zugriff).
 * Grund: tsx + package.json ohne "type": "module" → statische ESM-Named-Imports
 * aus transpilierten CJS-Modulen scheitern an der cjs-module-lexer-Erkennung
 * ("does not provide an export named"). require() greift zur Laufzeit auf
 * module.exports zu — robust. Typsicherheit via typeof import(...)-Casts
 * (Type-Level, zur Laufzeit entfernt).
 *
 * Ausführen: npm test  (tsx tests/regression.mts)
 */
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Chess as ChessInstance } from 'chess.js';
import type { EngineEvalResult, GameAnalysis, MoveAnalysis } from '../src/types/chess';
import type { parsePgnMetadata as ParsePgnMeta, extractMovesFromPgn as ExtractMoves } from '../src/utils/pgn';
import type { classifyMove as ClassifyMove, formatEval as FormatEval, calculateWinChance as CalcWinChance, terminalEval as TerminalEval, legalEngineArrow as LegalEngineArrow } from '../src/utils/analysis';
import type { writeJsonFileAtomic as WriteJsonAtomic } from '../electron/jsonStore';
import type { LineAssembler as LineAssemblerType, isValidFen as IsValidFen } from '../electron/uci';

const require = createRequire(import.meta.url);

const { Chess } = require('chess.js') as { Chess: new (fen?: string) => ChessInstance };
const { parsePgnMetadata, extractMovesFromPgn } = require('../src/utils/pgn') as {
  parsePgnMetadata: typeof ParsePgnMeta;
  extractMovesFromPgn: typeof ExtractMoves;
};
const { repairAlternatingPovAnalysis } = require('../src/utils/repairAlternatingPov') as typeof import('../src/utils/repairAlternatingPov');
const { classifyMove, formatEval, calculateWinChance, terminalEval, legalEngineArrow, calculateMoveAccuracy, getPlayerWinChance } = require('../src/utils/analysis') as {
  classifyMove: typeof ClassifyMove;
  formatEval: typeof FormatEval;
  calculateWinChance: typeof CalcWinChance;
  terminalEval: typeof TerminalEval;
  legalEngineArrow: typeof LegalEngineArrow;
  calculateMoveAccuracy: typeof import('../src/utils/analysis').calculateMoveAccuracy;
  getPlayerWinChance: typeof import('../src/utils/analysis').getPlayerWinChance;
};
const { threatenedPieceArrows, capturedMaterial, capturedMaterialAfterLine } = require('../src/utils/boardPresentation') as typeof import('../src/utils/boardPresentation');
const { writeJsonFileAtomic } = require('../electron/jsonStore') as { writeJsonFileAtomic: typeof WriteJsonAtomic };
const { LineAssembler, isValidFen } = require('../electron/uci') as {
  LineAssembler: typeof LineAssemblerType;
  isValidFen: typeof IsValidFen;
};

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
section('T06 — Stabile Partieidentität');
// ---------------------------------------------------------------------------

const PGN_MANUAL = `[Event "Casual Game"]
[Site "Local"]
[Date "2024.01.15"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 *`;

const m1 = parsePgnMetadata(PGN_MANUAL);
const m2 = parsePgnMetadata(PGN_MANUAL);
check('Gleiche PGN → identische ID (keine Zufalls-UUID mehr)', m1.id === m2.id);
check('ID hat stabiles Format (game_ + 16 Hex)', /^game_[0-9a-f]{16}$/.test(m1.id), m1.id);

const differentDate = parsePgnMetadata(PGN_MANUAL.replace('2024.01.15', '2024.02.20'));
check('Unterschiedliches Datum → unterschiedliche ID (F07)', differentDate.id !== m1.id);

const differentMoves = parsePgnMetadata(PGN_MANUAL.replace('5. O-O Be7', '5. O-O d6'));
check('Unterschiedliche Zugfolge → unterschiedliche ID', differentMoves.id !== m1.id);

const PGN_CHESSCOM = PGN_MANUAL.replace('[Site "Local"]', '[Site "https://www.chess.com/game/live/987654321"]');
const cc1 = parsePgnMetadata(PGN_CHESSCOM);
const cc2 = parsePgnMetadata(PGN_CHESSCOM.replace('2024.01.15', '2024.03.01'));
check('chess.com-Live-URL → ID nur aus der Partie-ID (datumstabil)', cc1.id === cc2.id);
check('chess.com-ID unterscheidet sich von manueller ID', cc1.id !== m1.id);
check('chess.com-ID hat stabiles Format', /^game_[0-9a-f]{16}$/.test(cc1.id));

// ---------------------------------------------------------------------------
section('T04 — Buchzug ↔ Zugqualität getrennt');
// ---------------------------------------------------------------------------

const evalBeforeEqual = { scoreCp: 0, bestMoveUci: 'e2e4', pv: ['e2e4'], depth: 14, status: 'complete' as const };
const evalAfterBlunder = { scoreCp: -1500, bestMoveUci: 'e7e5', pv: ['e7e5'], depth: 14, status: 'complete' as const };

const bookBlunder = classifyMove({
  color: 'w',
  evalBefore: evalBeforeEqual,
  evalAfter: evalAfterBlunder,
  isPlayedMoveBest: false,
  plyNumber: 3,
  isBookMove: true,
  bookName: 'Barnes Opening',
});
check('Buchzug mit Patzer → quality ist blunder, NICHT book', bookBlunder.quality === 'blunder', bookBlunder);
check('Buchzugehörigkeit als openingAnnotation erhalten', bookBlunder.openingAnnotation === 'Buchzug (Barnes Opening)');
check('winChanceDrop ist real, nicht 0', bookBlunder.winChanceDrop > 25, bookBlunder.winChanceDrop);

const bookBest = classifyMove({
  color: 'w',
  evalBefore: evalBeforeEqual,
  evalAfter: { scoreCp: 10, bestMoveUci: 'e2e4', pv: ['e2e4'], depth: 14, status: 'complete' },
  isPlayedMoveBest: true,
  plyNumber: 1,
  isBookMove: true,
  bookName: 'Italian Game',
});
check('Buchzug-Bestzug → quality best (normale Bewertung)', bookBest.quality === 'best');
check('Buchzug-Bestzug → openingAnnotation gesetzt', bookBest.openingAnnotation === 'Buchzug (Italian Game)');

const plainMove = classifyMove({
  color: 'b',
  evalBefore: evalBeforeEqual,
  evalAfter: { scoreCp: 25, bestMoveUci: 'g1f3', pv: ['g1f3'], depth: 14, status: 'complete' },
  isPlayedMoveBest: false,
  plyNumber: 5,
  isBookMove: false,
});
check('Nicht-Buchzug → openingAnnotation undefined', plainMove.openingAnnotation === undefined);

// Instabilitätsguard: Bestzug laut Suche, aber großer Verlust → ehrliche Kennzeichnung
const unstable = classifyMove({
  color: 'w',
  evalBefore: evalBeforeEqual,
  evalAfter: { scoreCp: -900, bestMoveUci: 'e2e4', pv: ['e2e4'], depth: 14, status: 'complete' },
  isPlayedMoveBest: true,
  plyNumber: 20,
});
check('Bestzug + winChanceDrop ≥ 15 → inaccuracy (Instabilitätsguard)', unstable.quality === 'inaccuracy', unstable);

// Alte Heuristik darf nicht zurückkommen: kein plyNumber-basiertes 'book'
const earlyBest = classifyMove({
  color: 'w',
  evalBefore: evalBeforeEqual,
  evalAfter: { scoreCp: 20, bestMoveUci: 'e2e4', pv: ['e2e4'], depth: 14, status: 'complete' },
  isPlayedMoveBest: true,
  plyNumber: 2,
  isBookMove: false,
});
check('Früher Bestzug ohne Buch → quality best, NICHT book (Heuristik entfernt)', earlyBest.quality === 'best');

// ---------------------------------------------------------------------------
section('T03 — Matt/Remis/Terminal-Handling');
// ---------------------------------------------------------------------------

check("formatEval(mate 0, weiß gewinnt) → '#'", formatEval(100000, 0) === '#');
check("formatEval(mate 0, schwarz gewinnt) → '-#'", formatEval(-100000, 0) === '-#');
check('formatEval(mate 2) → M2', formatEval(0, 2) === 'M2');
check('formatEval(cp) → +1.4', formatEval(140) === '+1.4');

// Narrenmatt: 1.f3 e5 2.g4 Dh4#
const foolMate = new Chess();
foolMate.move('f3');
foolMate.move('e5');
foolMate.move('g4');
foolMate.move('Qh4');
const foolTerminal = terminalEval(foolMate);
check('Narrenmatt wird als terminal erkannt', foolTerminal !== null);
check('Schwarz hat mattgesetzt → scoreCp negativ (white-POV)', foolTerminal?.scoreCp === -100000, foolTerminal);
check('Terminal-Eval: bestMoveUci leer, status complete', foolTerminal?.bestMoveUci === '' && foolTerminal?.status === 'complete');
// R10: der PRODUZENT liefert mate 0 — Anzeige-Kette terminalEval → formatEval zeigt -# (nicht ±1000.0)
check('R10: Terminal-Eval führt mate 0 → formatEval zeigt -#', foolTerminal?.mate === 0 && formatEval(foolTerminal.scoreCp, foolTerminal.mate) === '-#');

// Win-Chance für terminale Bewertung: Schwarz gewinnt → Weiß ~0%
check('calculateWinChance(-100000) ≈ 0%', calculateWinChance(-100000) < 0.1);

// Patt-Stellung → Remis-Bewertung 0
const stalemate = new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
check('Test-FEN ist tatsächlich Patt', stalemate.isStalemate());
const staleTerminal = terminalEval(stalemate);
check('Patt → scoreCp 0, status complete', staleTerminal?.scoreCp === 0 && staleTerminal?.status === 'complete', staleTerminal);

// Nicht-terminale Stellung → null (Engine entscheidet)
const openGame = new Chess();
openGame.move('e4');
check('Offene Stellung → terminalEval null', terminalEval(openGame) === null);

// ---------------------------------------------------------------------------
section('T05 — Atomare Persistenz');
// ---------------------------------------------------------------------------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pca-regression-'));
const target = path.join(tmpDir, 'games_db.json');
writeJsonFileAtomic(target, { games: [{ id: 'g1' }] });
check('Atomarer Write erzeugt gültiges JSON', JSON.parse(fs.readFileSync(target, 'utf-8')).games.length === 1);

const leftovers = fs.readdirSync(tmpDir).filter((f) => f.includes('.tmp-'));
check('Keine tmp-Restdateien nach erfolgreichem Write', leftovers.length === 0, leftovers);

let threw = false;
try {
  writeJsonFileAtomic(path.join(tmpDir, 'does-not-exist', 'x.json'), { a: 1 });
} catch {
  threw = true;
}
check('Schreibfehler werden PROPAGIERT, nicht verschluckt (T05)', threw);

let threwInvalid = false;
try {
  // Echte Zirkularreferenz (nicht {circular: null} — das ist gültiges JSON!)
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  writeJsonFileAtomic(target, circular);
} catch {
  threwInvalid = true;
}
check('Nicht-serialisierbare Daten werfen Fehler (kein kaputtes JSON)', threwInvalid);

fs.rmSync(tmpDir, { recursive: true, force: true });

// ---------------------------------------------------------------------------
section('T02 — UCI-Zeilenparsing & IPC-Grenze');
// ---------------------------------------------------------------------------

const assembler = new LineAssembler();
let lines = assembler.push('info depth 1 score cp 10 pv e2e4\r\nbestmo');
check('Geteilte Zeile an Chunk-Grenze: erster Chunk → 1 Zeile', lines.length === 1, lines);
lines = assembler.push('ve e2e4\ninfo depth 2');
check('Fortsetzungs-Chunk vervollständigt bestmove-Zeile', lines[0] === 'bestmove e2e4', lines);
lines = assembler.push(' score cp 20 pv d2d4\r\n\r\n');
check('CRLF + Leerzeilen korrekt getrennt', lines.length === 2 && lines[1] === '', lines);

check('isValidFen akzeptiert Startstellung', isValidFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'));
check('isValidFen lehnt Müll ab (kein freier Text an Engine)', !isValidFen('DROP TABLE games; --'));
check('isValidFen lehnt leeren String ab', !isValidFen(''));
check('isValidFen lehnt falschen Typ ab', !isValidFen(42 as unknown as string));

// ---------------------------------------------------------------------------
section('Extraktion — Promotion & SetUp/FEN');
// ---------------------------------------------------------------------------

const promoPgn = `[Event "T"]
[Site "Local"]
[Date "2024.01.01"]
[White "W"]
[Black "B"]
[Result "1-0"]

1. e4 d5 2. exd5 c6 3. dxc6 Nf6 4. cxb7 Bd7 5. bxa8=Q *`;
const promoMoves = extractMovesFromPgn(promoPgn);
check('Umwandlungszug enthält promotion + uci-Suffix', promoMoves.some((mv) => mv.promotion === 'q' && mv.uci === 'b7a8q'), promoMoves.find((mv) => mv.uci === 'b7a8q'));
check('fenBefore/fenAfter für alle Züge vorhanden', promoMoves.every((mv) => mv.fenBefore && mv.fenAfter));

const setUpPgn = `[Event "T"]
[Site "Local"]
[Date "2024.01.01"]
[White "W"]
[Black "B"]
[Result "*"]
[SetUp "1"]
[FEN "k7/8/8/8/8/8/8/K6R w - - 0 1"]

1. Rh7 *`;
const setUpMoves = extractMovesFromPgn(setUpPgn);
check('SetUp/FEN-Partie: fenBefore nutzt die Start-FEN', setUpMoves[0]?.fenBefore === 'k7/8/8/8/8/8/8/K6R w - - 0 1', setUpMoves[0]?.fenBefore);
check('SetUp/FEN-Partie: Zug korrekt nachgespielt', setUpMoves[0]?.uci === 'h1h7', setUpMoves[0]);

// ===========================================================================
section('Phase 2 — T12/T13/T14 (Farb-Resolver, Phasen-Heuristik, Zeitklassen, Buch-Erkennung, ehrliches ECO)');
const {
  resolvePlayerColor,
  isEndgamePosition,
  findEvidencedLostPiece,
} = require('../src/utils/moveInsights') as typeof import('../src/utils/moveInsights');
const { classifyTimeControl } = require('../electron/db') as typeof import('../electron/db');

check('resolvePlayerColor: weiß', resolvePlayerColor('PlayerA', 'Gegner', 'PlayerA') === 'w');
check('resolvePlayerColor: schwarz', resolvePlayerColor('Gegner', 'PlayerA', 'PlayerA') === 'b');
check('resolvePlayerColor: null bei Fremdpartie', resolvePlayerColor('A', 'B', 'PlayerA') === null);
check('isEndgamePosition: Startstellung = nein', isEndgamePosition('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1') === false);
check('isEndgamePosition: geringes Material = ja', isEndgamePosition('8/5k2/8/8/8/3K4/4P3/8 w - - 0 1') === true);
const hangFen = 'k7/8/8/3q4/8/8/8/K2Q4 b - - 0 1';
check('findEvidencedLostPiece: Dame per PV belegbar', findEvidencedLostPiece(hangFen, ['d5d1'], 'w') === 'q', findEvidencedLostPiece(hangFen, ['d5d1'], 'w'));
check('findEvidencedLostPiece: ohne PV null', findEvidencedLostPiece(hangFen, undefined, 'w') === null);
check('classifyTimeControl: timeClass hat Vorrang', classifyTimeControl('600', 'blitz') === 'Blitz' && classifyTimeControl('60', 'rapid') === 'Schnellschach');
check('classifyTimeControl: Sekunden-Parsing', classifyTimeControl('60+0') === 'Bullet' && classifyTimeControl('600') === 'Schnellschach' && classifyTimeControl('1800') === 'Klassisch');
check('classifyTimeControl: Unbekannt', classifyTimeControl('*') === 'Unbekannt' && classifyTimeControl(undefined, undefined) === 'Unbekannt');
const caroMeta = parsePgnMetadata(`[Event "T"]\n[White "A"]\n[Black "B"]\n[Result "*"]\n\n1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 *`);
check('Buch-Erkennung: Caro-Kann ohne ECO-Header (T12)', caroMeta.openingName.includes('Caro-Kann') && caroMeta.eco === 'B15', caroMeta);
const fenMeta = parsePgnMetadata(`[Event "T"]\n[Site "Local"]\n[Date "2024.01.01"]\n[White "W"]\n[Black "B"]\n[Result "*"]\n[SetUp "1"]\n[FEN "k7/8/8/8/8/8/8/K6R w - - 0 1"]\n\n1. Rh7 *`);
check('Buch-Erkennung: ehrliches Eco leer statt A00 (T12)', fenMeta.eco === '' && fenMeta.openingName === 'Standard Opening', fenMeta);

// ---------------------------------------------------------------------------
section('Phase 3 — T15 (Wiederholungssystem: deterministisch, Hilfe ≠ unabhängig, Migration)');
const {
  INTERVALS_MS,
  applyReview,
  isDue,
  isMastered,
  formatDueIn,
  migrateGameIdKeys,
  migrateLegacySolved,
  scheduleIntervalsMs,
  recalculateDueAts,
} = require('../src/utils/reviews') as typeof import('../src/utils/reviews');

const T0 = 1_700_000_000_000;
const mkStore = (): import('../src/utils/reviews').ReviewStore => ({ version: 1, reviews: {} });

// Unabhängige richtige Antworten: Treppe 1/3/7/14/30 Tage, Obergrenze 30.
const s1 = mkStore();
const r1 = applyReview(s1, 'g1:12', 'correct', T0);
check('T15: erste richtige Antwort → 1 Tag', r1.intervalIdx === 1 && r1.dueAt === T0 + INTERVALS_MS[1]);
const r2 = applyReview(s1, 'g1:12', 'correct', T0 + 86_400_000);
check('T15: zweite richtige → 3 Tage, Zähler geführt', r2.intervalIdx === 2 && r2.attempts === 2 && r2.correct === 2);
applyReview(s1, 'g1:12', 'correct', s1.reviews['g1:12'].dueAt);
applyReview(s1, 'g1:12', 'correct', s1.reviews['g1:12'].dueAt);
const r5 = applyReview(s1, 'g1:12', 'correct', s1.reviews['g1:12'].dueAt);
check('T15: fünfte richtige → 30 Tage (letztes Intervall)', r5.intervalIdx === INTERVALS_MS.length - 1);
const sixthAt = r5.dueAt;
const r6 = applyReview(s1, 'g1:12', 'correct', sixthAt);
check('T15: Obergrenze bleibt 30 Tage', r6.intervalIdx === INTERVALS_MS.length - 1 && r6.dueAt === sixthAt + INTERVALS_MS[5]);

// Fehlversuch: Lapse + kurze Wiederholung.
const s2 = mkStore();
applyReview(s2, 'g2:3', 'correct', T0);
const w1 = applyReview(s2, 'g2:3', 'wrong', T0 + 1_000);
check('T15: Fehler → Lapse + kurze Wiederholung', w1.intervalIdx === 0 && w1.lapses === 1 && w1.dueAt === T0 + 1_000 + INTERVALS_MS[0]);

// Hilfe: zählt NICHT als unabhängige Lösung — kurze Wiederholung, Treppe bleibt.
const h1 = applyReview(s2, 'g2:3', 'help', T0 + 2_000);
check('T15: Hilfe → kurze Wiederholung ohne Intervallfortschritt', h1.intervalIdx === 0 && h1.helps === 1 && h1.attempts === 2); // attempts: 1 korrekt + 1 falsch davor
const s3 = mkStore();
applyReview(s3, 'g3:1', 'correct', T0);
const h2 = applyReview(s3, 'g3:1', 'help', T0 + 1_000);
check('T15: Hilfe setzt Beherrschung zurueck', h2.intervalIdx === 0 && h2.spacedCorrect === 0);
const c3 = applyReview(s3, 'g3:1', 'correct', h2.dueAt);
check('T15: nach Hilfe faellige richtige Antwort startet bei 1 Tag', c3.intervalIdx === 1 && c3.correct === 2);

// Fälligkeit/Gemeistert.
check('T15: isDue fällig/nicht fällig', isDue(s3.reviews['g3:1'], T0 + 300_000_000) === true && isDue(s3.reviews['g3:1'], T0) === false);
check('T15: isDue ohne Eintrag = neue Karte fällig', isDue(undefined) === true);
check('T15: isMastered erst bei 30 Tagen', isMastered(c3) === false && isMastered(s1.reviews['g1:12']) === true);

// Legacy-Migration: 7-Tage-Intervall OHNE erfundene Historie, idempotent.
const s4 = mkStore();
const migrated = migrateLegacySolved(s4, ['g4:7', 'g4:9'], T0);
const t15Legacy = s4.reviews['g4:7'];
check('T15: Legacy-Migration 7-Tage-Intervall ohne Historie', migrated === 2 && t15Legacy.intervalIdx === 3 && t15Legacy.legacy === true && t15Legacy.attempts === 0 && t15Legacy.correct === 0 && t15Legacy.dueAt === T0 + INTERVALS_MS[3]);
check('T15: Migration idempotent (bestehende Keys bleiben)', migrateLegacySolved(s4, ['g4:7'], T0) === 0);
check('T15: formatDueIn Texte', formatDueIn(undefined) === 'neu' && formatDueIn(s4.reviews['g4:7'], T0).includes('7 Tag'));

// ---------------------------------------------------------------------------
section('Phase 3 — T16 (Pipeline-Kern: Fenster, Filter, Quell-ID, Patch/Queue)');
const {
  monthsForWindow,
  isSupportedGame,
  sourceIdOf,
  applyJobPatch,
  nextQueuedJob,
  emptyPipelineData,
  mergeDiscoveryIntoPipeline,
  withinDiscoveryWindow,
} = require('../electron/chesscomPipelineCore') as typeof import('../electron/chesscomPipelineCore');

const SEP30 = Date.UTC(2026, 8, 30, 12); // 2026-09-30
const t16Months = monthsForWindow(SEP30, 30);
check('T16: 30-Tage-Fenster umfasst Sep + Aug 2026', t16Months.length === 2 && t16Months.some((m) => m.year === 2026 && m.month === 9) && t16Months.some((m) => m.year === 2026 && m.month === 8));
const t16Base = { pgn: '1. e4 e5 2. Nf3 *', white: 'A', black: 'B', result: '*' } as import('../electron/chesscom').ChessComGameSummary;
check('T16: isSupportedGame nur beendete Standardpartien', isSupportedGame({ ...t16Base, rules: 'chess', endTime: 5 }) && !isSupportedGame({ ...t16Base, rules: 'chess960', endTime: 5 }) && !isSupportedGame({ ...t16Base, rules: 'chess' }));
// --- R05/R06: Pipeline-Resume + Fensterfilter (pur) ---
const r05Failed = { id: 'jF', username: 'A', status: 'failed' as const, games: [{ sourceId: 's1', pgn: 'p1' }, { sourceId: 's2', pgn: 'p2' }], cursor: 1, savedCount: 1, failedCount: 0, lastError: 'engine unavailable', createdAt: 1, updatedAt: 2 };
const r05Data = { version: 1 as const, knownIds: [], jobs: [r05Failed] };
const r05Merged = mergeDiscoveryIntoPipeline(r05Data, 'a', [{ sourceId: 's3', pgn: 'p3' }], 300);
check('R05: failed-Job wird wiederaufgenommen (queued, cursor, lastError weg, Append)', r05Merged.created === false && r05Failed.status === 'queued' && r05Failed.lastError === undefined && r05Failed.cursor === 1 && r05Failed.games.length === 3 && r05Failed.games[2].sourceId === 's3' && r05Merged.job === r05Failed);
const r05SavedJob = { id: 'jS', username: 'B', status: 'saved' as const, games: [], cursor: 0, savedCount: 5, failedCount: 0, createdAt: 1, updatedAt: 2 };
const r05Data2 = { version: 1 as const, knownIds: [], jobs: [r05SavedJob] };
const r05Merged2 = mergeDiscoveryIntoPipeline(r05Data2, 'B', [{ sourceId: 'x1', pgn: 'x' }], 400);
check('R05: nach saved-Job wird neu angelegt (created)', r05Merged2.created === true && r05SavedJob.status === 'saved' && r05Data2.jobs.length === 2);
const r05Queued = { id: 'jQ', username: 'C', status: 'queued' as const, games: [{ sourceId: 'q1', pgn: 'q' }], cursor: 0, savedCount: 0, failedCount: 0, createdAt: 1, updatedAt: 2 };
const r05Data3 = { version: 1 as const, knownIds: [], jobs: [r05Queued] };
const r05Merged3 = mergeDiscoveryIntoPipeline(r05Data3, 'C', [], 500);
check('R05: aktiver Job wiederverwendet (idempotent)', r05Merged3.created === false && r05Merged3.job === r05Queued && r05Queued.games.length === 1);
const r05PatchJob = { id: 'jP', username: 'D', status: 'failed' as const, games: [], cursor: 0, savedCount: 0, failedCount: 0, createdAt: 1, updatedAt: 2 };
applyJobPatch(r05PatchJob, { status: 'queued' }, 300);
check('R05: applyJobPatch erlaubt failed→queued (expliziter Retry)', r05PatchJob.status === 'queued');
const r06Fresh = { ...t16Base, rules: 'chess', endTime: SEP30 - 2 * 86_400_000 } as import('../electron/chesscom').ChessComGameSummary;
const r06Old = { ...t16Base, rules: 'chess', endTime: SEP30 - 10 * 86_400_000 } as import('../electron/chesscom').ChessComGameSummary;
check('R06: Discovery-Fensterfilter (2 Tage ok bei 30, 10 Tage draußen bei 5)', withinDiscoveryWindow(r06Fresh, SEP30, 30) && !withinDiscoveryWindow(r06Old, SEP30, 5));
const r06SecFresh = { ...t16Base, rules: 'chess', endTime: Math.floor(SEP30 / 1000) - 2 * 86_400 } as import('../electron/chesscom').ChessComGameSummary;
const r06SecOld = { ...t16Base, rules: 'chess', endTime: Math.floor(SEP30 / 1000) - 10 * 86_400 } as import('../electron/chesscom').ChessComGameSummary;
check('R06: Discovery-Fensterfilter verarbeitet Unix-Sekunden korrekt', withinDiscoveryWindow(r06SecFresh, SEP30, 30) && !withinDiscoveryWindow(r06SecOld, SEP30, 5));
check('T16: sourceIdOf Präferenz uuid → url → hash', sourceIdOf({ ...t16Base, uuid: 'u1' }) === 'uuid:u1' && sourceIdOf({ ...t16Base, url: 'https://x/1' }) === 'url:https://x/1' && sourceIdOf(t16Base).startsWith('hash:'));
const t16Job = { id: 'j1', username: 'A', status: 'queued' as const, games: [1, 2, 3, 4, 5].map((n) => ({ sourceId: `s${n}`, pgn: `pgn${n}` })), cursor: 0, savedCount: 0, failedCount: 0, createdAt: 1, updatedAt: 1 };
applyJobPatch(t16Job, { savedDelta: 2, cursorSet: 3, failedDelta: 1 }, 100);
check('T16: Patch — Deltas + Cursor (geklemmt auf games.length) + Zeitstempel', t16Job.savedCount === 2 && t16Job.failedCount === 1 && t16Job.cursor === 3 && t16Job.updatedAt === 100);
const t16Clamp = { ...t16Job, cursor: 0 };
applyJobPatch(t16Clamp, { cursorSet: 99 }, 101);
check('T16: Cursor-Clamp auf Partieanzahl', t16Clamp.cursor === 5);
const t16Analyzing = { ...t16Job, status: 'analyzing' as const };
applyJobPatch(t16Analyzing, { status: 'queued' }, 101);
check('T16: Requeue aus analyzing erlaubt (App-Neustart)', t16Analyzing.status === 'queued');
const t16Saved = { ...t16Job, status: 'saved' as const };
applyJobPatch(t16Saved, { status: 'queued' }, 102);
check('T16: fertige Jobs nicht requeuable', t16Saved.status === 'saved');
const t16Queue = nextQueuedJob([
  { ...t16Job, id: 'b', createdAt: 5, status: 'queued' as const },
  { ...t16Job, id: 'a', createdAt: 2, status: 'queued' as const },
  { ...t16Job, id: 'c', createdAt: 1, status: 'analyzing' as const },
]);
check('T16: ältester queued-Job zuerst, analyzing bleibt außen', t16Queue?.id === 'a');
check('T16: leere Pipeline leer', emptyPipelineData().jobs.length === 0);

// ---------------------------------------------------------------------------
// T03-Hotfix-Regression (interaktive Abnahme 2026-09-30): analyzePgnGame muss
// der Engine das START-FEN der Partie plus kumulative Zughistorie senden
// (position fen <start> moves ...) — NICHT die aktuelle Stellung plus History
// (sonst soll die Engine die Partie ab der bereits aktuellen Stellung nochmal
// spielen → illegal ab 1.e4, Analyse bricht ab). IPC-Mock zeichnet (fen,
// history)-Paare auf.
const { analyzePgnGame } = await import('../src/utils/analyzeGame');
const t03Calls: Array<{ fen: string; history: string[]; currentFen?: string }> = [];
(globalThis as unknown as { window: unknown }).window = {
  electronAPI: {
    engine: {
      evaluateFen: async (fen: string, _depth: number, history: string[] | undefined, currentFen: string | undefined) => {
        t03Calls.push({ fen, history: [...(history || [])], currentFen });
        return {
          scoreCp: 20,
          bestMoveUci: 'g1f3',
          bestMoveSan: 'Nf3',
          pv: ['g1f3'],
          depth: 8,
          actualDepth: 8,
          bound: 'exact' as const,
          status: 'complete' as const,
        };
      },
    },
  },
};
const t03Game = await analyzePgnGame(
  ['[Event "T03 Hotfix"]', '[White "W"]', '[Black "B"]', '', '1. e4 e5 2. Nf3 *'].join('\n'),
  8
);
check('T03-Hotfix: kurze Partie wird vollständig analysiert', t03Game.moves.length === 3);
check('T03-Hotfix: Start-Eval ohne History', t03Calls[0]?.history.length === 0);
check(
  'T03-Hotfix: Loop-Eval nutzt START-FEN (nicht fenAfter)',
  t03Calls[1]?.fen === t03Game.moves[0].fenBefore
);
check(
  'T03-Hotfix: History nach 1.e4 = [e2e4]',
  t03Calls[1]?.history.length === 1 && t03Calls[1].history[0] === 'e2e4'
);
check(
  'T03-Hotfix: History kumuliert korrekt',
  t03Calls[3]?.history.length === 3 &&
    t03Calls[3].history[0] === 'e2e4' &&
    t03Calls[3].history[1] === 'e7e5' &&
    t03Calls[3].history[2] === 'g1f3'
);
check(
  'T03-Hotfix/R01: currentFen = erreichte Stellung (POV/Richtung)',
  t03Calls[1]?.currentFen === t03Game.moves[0].fenAfter &&
    t03Calls[2]?.currentFen === t03Game.moves[1].fenAfter
);

section('Review-Pfeile: nur Züge aus der sichtbaren Stellung');
const afterE4 = new Chess();
afterE4.move('e4');
const replyArrow = legalEngineArrow(afterE4.fen(), 'e7e5');
check('Grüner Pfeil zeigt legalen nächsten Zug', replyArrow?.from === 'e7' && replyArrow?.to === 'e5');
check('Bestzug aus der vorherigen Stellung wird unterdrückt', legalEngineArrow(afterE4.fen(), 'e2e4') === null);
check('Ungültige oder veraltete Engine-Daten erzeugen keinen Pfeil', legalEngineArrow(afterE4.fen(), 'bad') === null);
const reviewView = require('../src/utils/reviewPresentation') as typeof import('../src/utils/reviewPresentation');
const arrowView = require('../src/utils/boardArrows') as typeof import('../src/utils/boardArrows');
const qualityView = require('../src/utils/moveQuality') as typeof import('../src/utils/moveQuality');
const liveReviewResult: import('../src/utils/reviewPresentation').LiveReviewEvaluation = {
  gameId: 'review-game', fen: afterE4.fen(), requestedDepth: 16, depth: 16, actualDepth: 16,
  status: 'complete', scoreCp: 20, bestMoveUci: 'c7c5', pv: ['c7c5', 'g1f3'],
  moves: [{ uci: 'c7c5', scoreCp: 20, pv: ['c7c5', 'g1f3'] }],
};
const afterD4 = new Chess(); afterD4.move('d4');
check('Auch zufällig legaler Bestzug aus einer anderen Stellung wird verworfen', !!legalEngineArrow(afterD4.fen(), 'c7c5') && reviewView.matchingLiveReview(liveReviewResult, 'review-game', afterD4.fen(), 16) === null);
check('Live-Auswertung gehört exakt zur Partie, Stellung und eingestellten Tiefe', reviewView.matchingLiveReview(liveReviewResult, 'review-game', afterE4.fen(), 16) === liveReviewResult && reviewView.matchingLiveReview(liveReviewResult, 'other-game', afterE4.fen(), 16) === null && reviewView.matchingLiveReview(liveReviewResult, 'review-game', afterE4.fen(), 14) === null);
check('Bestzug-Helfer verwendet die Top 3 nur für die angefragte Stellung', reviewView.reviewBestArrow(afterE4.fen(), { ...evalBeforeEqual, bestMoveUci: 'e7e5' }, liveReviewResult)?.to === 'c5');
check('Ohne Live-Ergebnis bleibt die gespeicherte legale Antwort verfügbar', reviewView.reviewBestArrow(afterE4.fen(), { ...evalBeforeEqual, bestMoveUci: 'e7e5' }, null)?.to === 'e5');
check('Nicht verfügbare Engine-Ergebnisse erzeugen keine erfundenen Bestzüge', reviewView.reviewBestArrow(afterE4.fen(), { ...evalBeforeEqual, status: 'unavailable', bestMoveUci: 'e7e5' }, null) === null && reviewView.matchingLiveReview({ ...liveReviewResult, status: 'unavailable' }, 'review-game', afterE4.fen(), 16) === null);
check('Top-3-Fortsetzung beginnt nach dem Hauptzug statt ihn zu wiederholen', reviewView.principalVariationSan(new Chess().fen(), ['e2e4', 'e7e5', 'g1f3', 'b8c6']).slice(1).join(' ') === 'e5 Nf3 Nc6');
check('Schwarze Zugfolge und illegales Variantenende werden korrekt dargestellt', reviewView.principalVariationSan(afterE4.fen(), ['e7e5', 'g1f3', 'a1a8']).join(' ') === 'e5 Nf3');
const setUpBlackMoves = extractMovesFromPgn('[SetUp "1"]\n[FEN "k7/8/8/8/8/8/8/K6R b - - 0 42"]\n\n42... Kb7 43. Rh7+ *') as MoveAnalysis[];
const blackRows = reviewView.reviewMoveRows(setUpBlackMoves);
check('Zugliste behält bei schwarzer Startstellung Farbe und tatsächliche Zugnummer', blackRows[0].number === 42 && blackRows[0].black?.ply === 1 && !blackRows[0].white && blackRows[1].number === 43 && blackRows[1].white?.ply === 2);
check('Positionswahl wird geklemmt und benutzt die tatsächlich erreichte Stellung', reviewView.reviewPosition(deckGameForReview(), 999).fen === afterE4.fen());
function deckGameForReview(): import('../src/types/chess').GameAnalysis { return { moves: [{ fenBefore: new Chess().fen(), fenAfter: afterE4.fen(), evalBefore: evalBeforeEqual, evalAfter: evalBeforeEqual }] } as import('../src/types/chess').GameAnalysis; }
const arrowLayers = arrowView.displayBoardArrows({ from: 'g1', to: 'f3' }, [{ from: 'g1', to: 'f3' }, { from: 'd8', to: 'd1' }], { from: 'g1', to: 'f3' });
check('Identische Pfeile haben genau eine Farbe und Bestzug hat Vorrang', arrowLayers.length === 2 && arrowLayers.find(arrow => arrow.from === 'g1')?.kind === 'best');
const knightArrow = arrowView.boardArrowGeometry('g1', 'f3')!;
const knightFlipped = arrowView.boardArrowGeometry('g1', 'f3', true)!;
check('Springerpfeil hat einen rechten Winkel und endet im Zielfeldzentrum', knightArrow.points.length === 3 && knightArrow.tip.x === arrowView.boardSquareCenter('f3').x && knightArrow.tip.y === arrowView.boardSquareCenter('f3').y);
check('Brettdrehen spiegelt die gesamte Pfeilsilhouette korrekt', knightArrow.polygon.every((point, i) => Math.abs(point.x + knightFlipped.polygon[i].x - 100) < 0.001 && Math.abs(point.y + knightFlipped.polygon[i].y - 100) < 0.001));
check('Fehlerhafte oder leere Pfeile werden nicht gezeichnet', arrowView.boardArrowGeometry('bad', 'e4') === null && arrowView.displayBoardArrows({ from: 'e4', to: 'e4' }).length === 0);
const summaryQualityCounts = qualityView.reviewQualityCounts([{ color: 'w', quality: 'blunder', openingAnnotation: 'Buchzug' }, { color: 'b', quality: 'best', openingAnnotation: 'Buchzug' }, { color: 'w', quality: 'excellent' }] as MoveAnalysis[]);
check('Bewertungsübersicht zählt Buchfehler als Fehler und jeden Zug genau einmal', summaryQualityCounts.white.blunder === 1 && summaryQualityCounts.white.book === 0 && summaryQualityCounts.black.book === 1 && Object.values(summaryQualityCounts.white).reduce((sum, value) => sum + value, 0) === 2);

section('Review-Brett: Bedrohungen und geschlagene Figuren');
const threatenedRook = '4k3/8/8/8/8/3p4/4R3/4K3 w - - 0 1';
check('Oranger Pfeil zeigt Angriff auf wertvollere Figur', threatenedPieceArrows(threatenedRook).some(arrow => arrow.from === 'd3' && arrow.to === 'e2'));
check('Startstellung ohne relevante Bedrohung bleibt frei', threatenedPieceArrows(new Chess().fen()).length === 0);
check('Ungültige FEN erzeugt keine Bedrohungspfeile', threatenedPieceArrows('invalid').length === 0);
const pinnedAttacker = '4k3/1Q2r3/8/8/8/8/8/K3R3 w - - 0 1';
check('Gefesselter gegnerischer Turm erzeugt keinen falschen Drohungspfeil', !threatenedPieceArrows(pinnedAttacker).some(arrow => arrow.from === 'e7' && arrow.to === 'b7'));
const actualCheck = '4k3/8/8/8/8/8/4r3/4K3 w - - 0 1';
check('Tatsächliches Schach wird als Bedrohung des Königs markiert', threatenedPieceArrows(actualCheck).some(arrow => arrow.from === 'e2' && arrow.to === 'e1'));
check('Geschützter gleichwertiger Abtausch wird nicht als Materialdrohung markiert', !threatenedPieceArrows('4k3/8/8/8/8/3p4/4P3/3RK3 w - - 0 1').some(arrow => arrow.to === 'e2'));
const exchangeMoves = extractMovesFromPgn('1. e4 d5 2. exd5 Qxd5 *') as unknown as MoveAnalysis[];
const afterWhiteCapture = capturedMaterial(exchangeMoves, 3);
const afterExchange = capturedMaterial(exchangeMoves, 4);
check('Geschlagener Bauer erscheint zuerst bei Weiß', afterWhiteCapture.byWhite.join() === 'p' && afterWhiteCapture.byBlack.length === 0 && afterWhiteCapture.whiteLead === 1);
check('Nach Rückschlag zeigen beide Seiten ihre Beute und keinen Materialvorsprung', afterExchange.byWhite.join() === 'p' && afterExchange.byBlack.join() === 'p' && afterExchange.whiteLead === 0 && afterExchange.blackLead === 0);
const promoted = capturedMaterial([{ color: 'w', uci: 'a7a8q', captured: 'r' } as MoveAnalysis], 1);
check('Umwandlung zählt beim Materialvorsprung zusätzlich zum Schlagzug', promoted.byWhite.join() === 'r' && promoted.whiteLead === 13);
const trainingCapture = capturedMaterialAfterLine(exchangeMoves, 3, exchangeMoves[2].fenAfter, ['d8d5']);
check('Fehlerkarten-Widerlegung ergänzt Schläge beider Seiten zur sichtbaren Stellung', trainingCapture.byWhite.join() === 'p' && trainingCapture.byBlack.join() === 'p' && trainingCapture.whiteLead === 0);
const trainingPromotion = capturedMaterialAfterLine([], 0, '4k2r/P7/8/8/8/8/8/4K3 w - - 0 1', ['a7a8q']);
check('SetUp-Variante zeigt nach Umwandlung den tatsächlichen Materialvorsprung', trainingPromotion.byWhite.length === 0 && trainingPromotion.byBlack.length === 0 && trainingPromotion.whiteLead === 4);

// ---------------------------------------------------------------------------
// R03 — TrainingJudge: unbelastbare Bewertungen erzeugen 'uncertain' statt
// falscher Verdikte; Remis mit belegtem Matt-Bestzug ist Gewinnverspielung.
// ---------------------------------------------------------------------------
const { judgeTrainingAttempt } = require('../src/utils/trainingJudge') as typeof import('../src/utils/trainingJudge');

section('R03 — TrainingJudge: uncertain-Gates + Mate-Nachweis (R03)');
check('R03: judgeTrainingAttempt ist geladen', typeof judgeTrainingAttempt === 'function');

const R03_PROBE_FEN = '7k/8/5QK1/8/8/8/8/8 w - - 0 1'; // Qf6+Kg6 vs Kh8: Qf7 = patt, Qg7# = Matt
const R03_BASE_EVAL: EngineEvalResult = {
  scoreCp: 500,
  bestMoveUci: 'f6g7',
  pv: ['f6g7'],
  depth: 12,
  actualDepth: 12,
  bound: 'exact',
  status: 'complete',
};

// 1) Ausgangsbewertung unavailable → uncertain (kein Urteil aus 0-cp-Garbage)
const r03a = await judgeTrainingAttempt(
  R03_PROBE_FEN,
  'f6f7',
  'f6g7',
  { ...R03_BASE_EVAL, status: 'unavailable', actualDepth: 0, scoreCp: 0 },
  { evaluateAfter: async () => null },
);
check('R03: unavailable-Ausgangsbewertung → uncertain', r03a.verdict.kind === 'uncertain', r03a.verdict);

// 2) evaluateAfter wirft → uncertain (nicht 'accepted', nicht 'wrong')
let r03ThrowCount = 0;
const r03b = await judgeTrainingAttempt(
  // K+R vs K: NICHT insufficient material — sonst greift der Terminal-Remis-
  // Zweig vor dem cp-Vergleich (KvK wäre dafür die falsche Probe-Stellung).
  '4k3/8/8/8/8/8/8/4K2R w - - 0 1',
  'e1e2',
  'e1f1',
  R03_BASE_EVAL,
  {
    evaluateAfter: async () => {
      r03ThrowCount += 1;
      throw new Error('engine down');
    },
  },
);
check('R03: evaluateAfter-Wurf → uncertain', r03b.verdict.kind === 'uncertain' && r03ThrowCount === 1, r03b.verdict);

// 3) evaluateAfter liefert unavailable → uncertain
const r03c = await judgeTrainingAttempt(
  '4k3/8/8/8/8/8/8/4K2R w - - 0 1',
  'e1e2',
  'e1f1',
  R03_BASE_EVAL,
  { evaluateAfter: async () => ({ ...R03_BASE_EVAL, status: 'unavailable', actualDepth: 0, scoreCp: 0 }) },
);
check('R03: unavailable-After-Eval → uncertain', r03c.verdict.kind === 'uncertain', r03c.verdict);

// 4) Audit-Probe: Patt-Zug, belegter Bestzug setzt sofort Matt → 'wrong'
const r03d = await judgeTrainingAttempt(R03_PROBE_FEN, 'f6f7', 'f6g7', R03_BASE_EVAL, { evaluateAfter: async () => null });
check('R03: Patt trotz belegtem Matt-in-1 → wrong (Gewinnverspielung)', r03d.verdict.kind === 'wrong', r03d.verdict);

// 5) Rettungs-Remis OHNE belegten Matt-Bestzug bleibt akzeptiert (T07-Vertrag)
const r03e = await judgeTrainingAttempt('7k/8/6K1/8/8/8/8/5Q2 w - - 0 1', 'f1f7', 'f1f2', R03_BASE_EVAL, { evaluateAfter: async () => null });
check('R03: Rettungs-Patt ohne Matt-in-1 bleibt accepted', r03e.verdict.kind === 'accepted', r03e.verdict);

// ── R07 — Identität: Zwillingspartien + Lernschlüssel-Migration ──
const { sameSourceIdentity, mergePreviousIds, gameIdentityKey, stableGameId, isStableGameId } = require('../src/utils/pgn') as typeof import('../src/utils/pgn');
// Verschiedene Tage, identische Züge → verschiedene stabile IDs (Audit-Probe)
const r07IdA = stableGameId(gameIdentityKey({ white: 'Amy', black: 'Bob', date: '2025.09.01', site: 'Chess.com', result: '1/2-1/2', timeControl: '600', uciMoves: ['e2e4', 'e7e5'] }));
const r07IdB = stableGameId(gameIdentityKey({ white: 'Amy', black: 'Bob', date: '2025.09.02', site: 'Chess.com', result: '1/2-1/2', timeControl: '600', uciMoves: ['e2e4', 'e7e5'] }));
check('R07: identische Züge, verschiedene Tage → verschiedene IDs', r07IdA !== r07IdB && isStableGameId(r07IdA) && isStableGameId(r07IdB));
check('R07: verschiedenes Datum = nicht dieselbe Quelle (erhalten statt verschmelzen)', !sameSourceIdentity({ date: '2025.09.01', result: '1/2-1/2' }, { date: '2025.09.02', result: '1/2-1/2' }));
check('R07: deckende Metadaten = dieselbe Quelle (Reanalyse ersetzt)', sameSourceIdentity({ date: '2025.09.01', timeControl: '600' }, { date: '2025.09.01', timeControl: '600' }));
check('R07: chess.com-Live-ID entscheidet allein', sameSourceIdentity({ site: 'chess.com/game/live/111' }, { site: 'chess.com/game/live/111' }) && !sameSourceIdentity({ site: 'chess.com/game/live/111' }, { site: 'chess.com/game/live/222' }));
check('R07: chess.com-Daily-URLs teilen Identität und Quelle über Datums-/Pfadvarianten', gameIdentityKey({ white: 'A', black: 'B', date: '2025.09.01', site: 'https://www.chess.com/game/daily/555666' }) === gameIdentityKey({ white: 'X', black: 'Y', date: '2025.09.02', site: 'https://www.chess.com/games/daily/555666' }) && sameSourceIdentity({ site: 'https://www.chess.com/game/daily/555666' }, { site: 'https://www.chess.com/games/daily/555666' }) && !sameSourceIdentity({ site: 'https://www.chess.com/game/daily/555666' }, { site: 'https://www.chess.com/game/daily/777888' }));
check('R07: ohne jeden Beweis unklar → nicht verschmelzen', !sameSourceIdentity({ timeControl: '600' }, { timeControl: '600' }));
const r07Merged = mergePreviousIds({ id: 'legacy-uuid-1', previousIds: ['legacy-uuid-2'] }, { id: r07IdA });
check('R07: Legacy-IDs bleiben der neuen ID zugeordnet', JSON.stringify(r07Merged) === JSON.stringify(['legacy-uuid-2', 'legacy-uuid-1']));
const s7 = mkStore();
applyReview(s7, 'legacy-uuid-2:3', 'correct', T0);
const r07IdMap: Record<string, string> = { 'legacy-uuid-1': r07IdA, 'legacy-uuid-2': r07IdA };
check('R07: Lernschlüssel wandern zur aktuellen ID (Werte erhalten, Legacy-Key bleibt)', migrateGameIdKeys(s7, r07IdMap) === 1 && !!s7.reviews[r07IdA + ':3'] && s7.reviews[r07IdA + ':3'].dueAt === T0 + INTERVALS_MS[1] && !!s7.reviews['legacy-uuid-2:3']);
check('R07: Migration idempotent', migrateGameIdKeys(s7, r07IdMap) === 0);

// ── Phase 6 — Settings: Normalisierung (alte Dateien + Klampen) ──
const { normalizeAppSettings, normalizeTrainingSchedule } = require('../src/types/chess') as typeof import('../src/types/chess');
const p6Old = normalizeAppSettings({ playerName: 'Kim', engineDepth: 999, engineThreads: -5, theme: 'neon' });
check('P6: alte settings.json lädt unverändert, neue Felder erhalten Defaults', p6Old.playerName === 'Kim' && p6Old.engineDepth === 30 && p6Old.engineThreads === 1 && p6Old.chessComUsername === '' && p6Old.autoSyncOnStartup === false && p6Old.autoAnalyzeNewGames === true && p6Old.trainingSchedule.preset === 'normal' && p6Old.theme === 'chesscom-green' && p6Old.settingsVersion === 1);
check('P6: ungültige Felder normalisiert (Typ-Fallback + Klampen)', normalizeAppSettings({ engineHashMb: 'x', engineDepth: 0 }).engineHashMb === 64 && normalizeAppSettings({ engineDepth: 0 }).engineDepth === 1);
check('P6: custom-Schedule validiert (steigend, gefiltert, max 8)', JSON.stringify(normalizeTrainingSchedule({ mode: 'custom', preset: 'relaxed', intervalsDays: [3, 7, 14, 30] })) === '{"mode":"custom","preset":"relaxed","intervalsDays":[3,7,14,30]}' && normalizeTrainingSchedule({ mode: 'custom', intervalsDays: [30, 3, 7] }).intervalsDays?.length === 1 && normalizeTrainingSchedule({ mode: 'custom', intervalsDays: ['x'] }).mode === 'preset');
check('P6: unbekannter Preset-Name → normal', normalizeTrainingSchedule({ preset: 'schnell' }).preset === 'normal');

// ── Phase 6 Welle 2 — Lichess-Pipeline-Helfer (pure, netzfrei) ──
const { isSupportedLichessGame, withinLichessWindow } = require('../electron/lichess') as typeof import('../electron/lichess');
const lichessBase = { sourceId: 'lichess:abc12345', pgn: '1. e4 e5', endedAt: Date.now(), variant: 'standard', status: 'resign', white: 'A', black: 'B' };
check('P6: Lichess-Filter — Varianten/ungültige Status raus', isSupportedLichessGame(lichessBase) === true && isSupportedLichessGame({ ...lichessBase, variant: 'kingOfTheHill' }) === false && isSupportedLichessGame({ ...lichessBase, status: 'aborted' }) === false && isSupportedLichessGame({ ...lichessBase, pgn: '' }) === false);
check('P6: Lichess-Fenster — zu-alte Partien raus', withinLichessWindow(Date.now() - 40 * 86_400_000, Date.now(), 30) === false && withinLichessWindow(Date.now() - 5 * 86_400_000, Date.now(), 30) === true);
check('P6: Lichess-Quell-ID eindeutig präfixiert', lichessBase.sourceId.startsWith('lichess:') && !lichessBase.sourceId.includes('/'));

// ── Phase 6 Welle 3 — Review-Schedule (pure, storage-frei) ──
check('P6: Preset-Leitern — normal = bestehende INTERVALS_MS', JSON.stringify(scheduleIntervalsMs({ mode: 'preset', preset: 'normal' })) === JSON.stringify(INTERVALS_MS) && scheduleIntervalsMs(undefined).length === INTERVALS_MS.length && scheduleIntervalsMs({ mode: 'preset', preset: 'relaxed' })[1] === 2 * 86_400_000);
check('P6: custom-Schedule → ms (10-min-Untergrenze wirkt)', JSON.stringify(scheduleIntervalsMs({ mode: 'custom', preset: 'normal', intervalsDays: [0.00694, 3, 7] })) === JSON.stringify([600_000, 3 * 86_400_000, 7 * 86_400_000]));
check('P6: recalculateDueAts — dueAt = lastReviewedAt + Stufe der aktiven Leiter', (() => {
  const store = mkStore();
  store.reviews['k1'] = { key: 'k1', dueAt: 0, intervalIdx: 2, lapses: 0, helps: 0, attempts: 1, correct: 1, lastReviewedAt: 1000 };
  const changed = recalculateDueAts(store, { mode: 'preset', preset: 'normal' }, 5000);
  return changed === 1 && store.reviews['k1'].dueAt === 1000 + INTERVALS_MS[2] && store.reviews['k1'].intervalIdx === 2;
})());

section('Fehlerkarten: kombinierbare Fehlerarten und gespeicherte Auswahl');
const trainingDeck = require('../src/utils/trainingDeck') as typeof import('../src/utils/trainingDeck');
const deckQualities = ['blunder', 'mistake', 'inaccuracy', 'miss', 'good'] as const;
const emptyDeckSummary = { brilliant: 0, great: 0, best: 0, excellent: 0, good: 0, book: 0, inaccuracy: 0, mistake: 0, blunder: 0, miss: 0 };
const deckGame: import('../src/types/chess').GameAnalysis = {
  ...parsePgnMetadata(PGN_MANUAL), pgn: PGN_MANUAL, openingName: 'Test Opening',
  accuracyWhite: 50, accuracyBlack: 50, summaryWhite: emptyDeckSummary, summaryBlack: emptyDeckSummary,
  moves: extractMovesFromPgn(PGN_MANUAL).map((move): MoveAnalysis => ({
    ...move, quality: move.color === 'w' ? deckQualities[move.moveNumber - 1] : 'blunder',
    evalBefore: evalBeforeEqual, evalAfter: evalBeforeEqual,
    winChanceBefore: 50, winChanceAfter: 40, winChanceDrop: 10,
  })),
};
const allDeckCards = trainingDeck.buildTrainingCards([deckGame], ' ALICE ');
check('Deck bietet alle vier Fehlerarten, ausschließlich eigene Fehler', allDeckCards.length === 4 && allDeckCards.every(card => card.move.color === 'w' && card.move.quality !== 'good'));
check('Einzelner Haken trainiert nur Patzer', trainingDeck.filterTrainingCards(allDeckCards, ['blunder']).length === 1 && trainingDeck.filterTrainingCards(allDeckCards, ['blunder'])[0]?.move.quality === 'blunder');
check('Mehrere Haken vereinigen leichte und gröbere Fehler ohne Duplikate', trainingDeck.filterTrainingCards(allDeckCards, ['inaccuracy', 'mistake', 'mistake']).length === 2 && trainingDeck.filterTrainingCards(allDeckCards, ['inaccuracy', 'mistake']).every(card => card.move.quality === 'inaccuracy' || card.move.quality === 'mistake'));
check('Alle Haken abgewählt ergibt ein leeres Deck', trainingDeck.filterTrainingCards(allDeckCards, []).length === 0);
check('Fremdpartien und Fehler ohne Engine-Empfehlung bleiben ausgeschlossen', trainingDeck.buildTrainingCards([deckGame], 'Unbeteiligt').length === 0 && trainingDeck.buildTrainingCards([{ ...deckGame, moves: deckGame.moves.map(move => ({ ...move, evalBefore: { ...move.evalBefore, bestMoveUci: '' } })) }], 'Alice').length === 0);
check('Fehlerarten ergänzen den bestehenden Eröffnungsfilter', trainingDeck.filterTrainingCards(trainingDeck.buildTrainingCards([deckGame], 'Alice', { opening: 'Test Opening' }), ['inaccuracy']).length === 1 && trainingDeck.buildTrainingCards([deckGame], 'Alice', { opening: 'Andere Eröffnung' }).length === 0);
const deckSavedStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const deckPrefStorage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => deckPrefStorage.get(key) ?? null,
  setItem: (key: string, value: string) => { deckPrefStorage.set(key, value); },
} });
check('Standardauswahl erhält Patzer, Fehler und verpasste Chancen', trainingDeck.loadTrainingQualities('Alice').join(',') === 'blunder,mistake,miss');
trainingDeck.saveTrainingQualities('Alice', ['inaccuracy']);
check('Fehlerauswahl bleibt pro Profil gespeichert und normalisiert', trainingDeck.loadTrainingQualities(' ALICE ').join(',') === 'inaccuracy' && trainingDeck.loadTrainingQualities('Bob').join(',') === 'blunder,mistake,miss');
trainingDeck.saveTrainingQualities('Alice', []);
check('Absichtlich leere Auswahl bleibt nach erneutem Öffnen leer', trainingDeck.loadTrainingQualities('Alice').length === 0);
for (const key of deckPrefStorage.keys()) deckPrefStorage.set(key, 'invalid json');
check('Beschädigte Filtereinstellung lädt sichere Standardauswahl', trainingDeck.loadTrainingQualities('Alice').join(',') === 'blunder,mistake,miss');
if (deckSavedStorage) Object.defineProperty(globalThis, 'localStorage', deckSavedStorage);
else Reflect.deleteProperty(globalThis, 'localStorage');

section('Eröffnungskatalog: Suche, Sterne und trainierbare Zugfolgen');
const catalog = require('../src/utils/openingCatalog') as typeof import('../src/utils/openingCatalog');
const caroCatalog = catalog.searchOpeningCatalog('Caro-Kann').find(entry => entry.movesUci.length >= 2);
check('Katalog enthält ECO-Zugfolgen statt nur Stellungsnamen', catalog.OPENING_CATALOG.length > 3000 && !!caroCatalog);
check('Suche findet Namen, deutsche Aliasform und ECO', catalog.searchOpeningCatalog('Sizilianisch').length > 0 && catalog.searchOpeningCatalog('B20').some(entry => entry.eco === 'B20'));
check('Suche bevorzugt die Grundform vor Namensverweisen anderer Eröffnungen', catalog.searchOpeningCatalog('Sizilianisch')[0]?.name.startsWith('Sicilian Defense') && catalog.searchOpeningCatalog('Caro-Kann')[0]?.name === 'Caro-Kann Defense');
const previewLine = { id: 'preview', eco: 'B10', name: 'Caro-Kann Defense', movesUci: ['e2e4', 'c7c6', 'd2d4', 'd7d5'] };
const slavGroups = catalog.groupOpeningCatalogEntries(catalog.searchOpeningCatalog('slawisch'));
const slavD10 = slavGroups.find(group => group.eco === 'D10' && group.name === 'Slav Defense');
check('Gleich benannte Eröffnungen erscheinen als eine Gruppe mit allen Zugfolgen', !!slavD10 && slavD10.entries.length >= 3 && new Set(slavD10.entries.map(entry => entry.movesUci.join(','))).size === slavD10.entries.length);
check('Gruppierung behält ECO-Code und Suchreihenfolge bei', slavGroups[0]?.eco === catalog.searchOpeningCatalog('slawisch')[0]?.eco && slavGroups.every(group => group.entries.every(entry => entry.eco === group.eco && entry.name === group.name)));
check('Weiß/Schwarz-Vorschau zeigt jeweils nur eigene Züge', catalog.openingTrainingMovePreview(previewLine, 'w') === '1.e4 2.d4' && catalog.openingTrainingMovePreview(previewLine, 'b') === '1...c6 2...d5');
check('Kurze Linie ohne schwarzen Zug ist für Schwarz nur ansehbar', !catalog.hasTrainingMove({ id: 'short', eco: 'A00', name: 'Short', movesUci: ['e2e4'] }, 'b'));
check('Favorisierte ECO-Zugfolge wird zu spielbarem Training', !!caroCatalog && catalog.selectedOpeningLine({ id: caroCatalog.id, color: 'b' })?.mainMoves.join(',') === caroCatalog.movesUci.join(','));
check('Kommentierter Caro-Kann-Kurs trainiert Schwarz mit Antwort c6 auf e4', catalog.selectedOpeningLine({ id: 'course:caro-kann', color: 'b' })?.color === 'b' && catalog.selectedOpeningLine({ id: 'course:caro-kann', color: 'b' })?.mainMoves.slice(0, 2).join(',') === 'e2e4,c7c6');
if (caroCatalog) {
  const whiteCaro = { id: caroCatalog.id, color: 'w' as const };
  const blackCaro = { id: caroCatalog.id, color: 'b' as const };
  const switched = catalog.changeOpeningSelectionColor([whiteCaro], whiteCaro, 'b');
  check('Farbwechsel eines Favoriten erhält die Caro-Kann-Zugfolge und trainiert Schwarz', switched[0]?.color === 'b' && catalog.selectedOpeningLine(switched[0])?.mainMoves.join(',') === caroCatalog.movesUci.join(',') && catalog.selectedOpeningLine(switched[0])?.id !== catalog.selectedOpeningLine(whiteCaro)?.id);
  check('Farbwechsel erzeugt keinen doppelten schwarzen Favoriten', catalog.changeOpeningSelectionColor([whiteCaro, blackCaro], whiteCaro, 'b').length === 1);
}
const fixedCourseSelections = catalog.defaultOpeningSelections();
check('Kommentierte Kurse behalten die zum Text passende Trainingsfarbe', catalog.changeOpeningSelectionColor(fixedCourseSelections, { id: 'course:caro-kann', color: 'b' }, 'w') === fixedCourseSelections);
const savedStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const openingStorage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => openingStorage.get(key) ?? null,
  setItem: (key: string, value: string) => { openingStorage.set(key, value); },
} });
check('Neues Profil startet mit drei vorhandenen Kursen', catalog.loadOpeningSelections('Profile A').length === 3);
check('Kommentierte Kurse bleiben nach Auswahl erneut trainierbar', catalog.defaultOpeningSelections().every(selection => !!catalog.selectedOpeningLine(selection)));
if (caroCatalog) {
  const star = { id: caroCatalog.id, color: 'b' as const };
  check('Stern wird pro Profil gespeichert', catalog.saveOpeningSelections('Profile A', [star]) && catalog.loadOpeningSelections('Profile A')[0]?.id === star.id && catalog.loadOpeningSelections('Profile B').length === 3);
  check('Entsternen erhält eine absichtlich leere Auswahl', catalog.saveOpeningSelections('Profile A', []) && catalog.loadOpeningSelections('Profile A').length === 0);
}
if (savedStorage) Object.defineProperty(globalThis, 'localStorage', savedStorage);
else Reflect.deleteProperty(globalThis, 'localStorage');

section('Repertoiretraining: feste Seite, vollständige Zufallsvarianten und Migration');
const repertoireTraining = require('../src/utils/openingTraining') as typeof import('../src/utils/openingTraining');
const caroRepertoire = repertoireTraining.getOpeningRepertoire('course:caro-kann')!;
check('Caro-Kann ist genau ein schwarzes Repertoire mit acht Varianten', caroRepertoire.color === 'b' && caroRepertoire.branches.length === 8 && repertoireTraining.searchOpeningRepertoires('caro kann').filter(item => item.name === 'Caro-Kann').length === 1);
check('Caro-Kann enthält Hauptlinie, Vorstoß, Abtausch, Fantasy und Panov', ['Klassisch', 'Vorstoß', 'Abtausch', 'Fantasy', 'Panov'].every(name => caroRepertoire.branches.some(branch => branch.name.includes(name))));
check('Kein Variantenpaket endet nach nur c6; klassische Linie erreicht Zug 10', caroRepertoire.branches.every(branch => repertoireTraining.openingOwnMoveCount(branch.moves, 'b') >= 4) && caroRepertoire.branches[0].moves.length === 20);
let allRepertoireLinesLegal = true;
let ownPolicyConsistent = true;
for (const repertoire of repertoireTraining.OPENING_REPERTOIRES) {
  const responseByPrefix = new Map<string, string>();
  for (const branch of repertoire.branches) {
    const chess = new Chess();
    try {
      branch.moves.forEach((uci, index) => {
        if (chess.turn() === repertoire.color) {
          const prefix = branch.moves.slice(0, index).join(' ');
          if (responseByPrefix.has(prefix) && responseByPrefix.get(prefix) !== uci) ownPolicyConsistent = false;
          responseByPrefix.set(prefix, uci);
        }
        repertoireTraining.playOpeningMove(chess, uci);
      });
      if (repertoireTraining.openingOwnMoveCount(branch.moves, repertoire.color) < 4) allRepertoireLinesLegal = false;
    } catch { allRepertoireLinesLegal = false; }
  }
}
check('Alle erzeugten Repertoirevarianten sind legal und enthalten mindestens vier eigene Züge', allRepertoireLinesLegal);
check('Zufallswahl verändert keine eigene Antwort in identischer Zugfolge', ownPolicyConsistent);
const branchSeen: string[] = [];
const branchReviews = { version: 1 as const, reviews: {} };
for (let i = 0; i < caroRepertoire.branches.length; i++) {
  const chosen = repertoireTraining.chooseOpeningBranch(caroRepertoire.branches, branchReviews, branchSeen, () => 0)!;
  branchSeen.push(chosen.id);
}
check('Alle acht Caro-Kann-Varianten kommen vor der ersten Wiederholung dran', new Set(branchSeen).size === 8);
check('Nach vollständigem Durchlauf wird die letzte Variante nicht direkt wiederholt', repertoireTraining.chooseOpeningBranch(caroRepertoire.branches, branchReviews, branchSeen, () => 0)?.id !== branchSeen.at(-1));
const blackTrainingBoard = new Chess();
const startPly = repertoireTraining.advanceOpeningOpponent(blackTrainingBoard, caroRepertoire.branches[0].moves, 'b', 0);
check('Schwarzes Training startet nach automatischem e4 mit eigener Antwort c6', startPly === 1 && blackTrainingBoard.turn() === 'b' && caroRepertoire.branches[0].moves[startPly] === 'c7c6');
const repertoireStorageBefore = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const repertoireStorage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => repertoireStorage.get(key) ?? null, setItem: (key: string, value: string) => { repertoireStorage.set(key, value); } } });
if (caroCatalog) {
  catalog.saveOpeningSelections('Migration Player', [{ id: caroCatalog.id, color: 'w' }, { id: 'course:caro-kann', color: 'b' }]);
  check('Alte weiße Caro-Kann-Einzelzeile wird ohne Dublette zum schwarzen Repertoire', repertoireTraining.loadRepertoireFavorites('Migration Player').join(',') === 'course:caro-kann');
}
repertoireTraining.saveRepertoireFavorites('Migration Player', []);
check('Absichtlich leeres Repertoire bleibt leer; anderes Profil behält Standardkurse', repertoireTraining.loadRepertoireFavorites('Migration Player').length === 0 && repertoireTraining.loadRepertoireFavorites('Other Profile').length === 3);
repertoireTraining.saveOpeningScope('Migration Player', caroRepertoire.id, [caroRepertoire.branches[0].id]);
check('Variantenauswahl bleibt pro Repertoire und Profil gespeichert', repertoireTraining.loadOpeningScope('Migration Player', caroRepertoire).length === 1 && repertoireTraining.loadOpeningScope('Other Profile', caroRepertoire).length === 8);
repertoireTraining.saveOpeningScope('Migration Player', caroRepertoire.id, []);
check('Alle Varianten können bewusst abgewählt und später wieder aktiviert werden', repertoireTraining.loadOpeningScope('Migration Player', caroRepertoire).length === 0);
if (repertoireStorageBefore) Object.defineProperty(globalThis, 'localStorage', repertoireStorageBefore);
else Reflect.deleteProperty(globalThis, 'localStorage');

section('Gemischtes Eröffnungstraining: fällige und neue Aufgaben');
const practice = require('../src/utils/openingPractice') as typeof import('../src/utils/openingPractice');
const { REPERTOIRE_LINES } = require('../src/data/repertoire') as typeof import('../src/data/repertoire');
const openingSelections = catalog.defaultOpeningSelections();
const emptyOpeningReviews = { version: 1 as const, reviews: {} };
const newPractice = practice.planOpeningPractice(openingSelections, emptyOpeningReviews, T0, 5);
check('Fünf neue Aufgaben aus mehreren Kursen statt nur dem ersten', newPractice.tasks.length === 5 && new Set(newPractice.tasks.slice(0, 3).map(task => task.lineId)).size === 3 && newPractice.tasks.every(task => task.kind === 'new'));
if (caroCatalog) {
  const ecoSelection = { id: caroCatalog.id, color: 'b' as const };
  const ecoLine = catalog.selectedOpeningLine(ecoSelection)!;
  const reviewKey = `opening:${ecoLine.id}`;
  const reviewStore = { version: 1 as const, reviews: {} as Record<string, import('../src/utils/reviews').ReviewEntry> };
  applyReview(reviewStore, reviewKey, 'wrong', T0 - INTERVALS_MS[0]);
  const duePractice = practice.planOpeningPractice([...openingSelections, ecoSelection], reviewStore, T0, 5);
  check('Fällige ECO-Linie kommt vor neuen Aufgaben', duePractice.tasks[0]?.reviewKey === reviewKey && duePractice.tasks[0]?.kind === 'due');
  applyReview(reviewStore, reviewKey, 'correct', T0);
  check('Erst künftig fällige Linie wird ausgelassen', !practice.planOpeningPractice([ecoSelection], reviewStore, T0).tasks.length);
}
const firstDeviation = REPERTOIRE_LINES[0].deviations[0];
const secondDeviation = REPERTOIRE_LINES[0].deviations[1];
const forcedTask = newPractice.tasks.find(task => task.lineId === REPERTOIRE_LINES[0].id)!;
check('Gemischte Runde injiziert nur die gewählte Abweichung', practice.practiceDeviationCandidates([firstDeviation, secondDeviation], forcedTask, REPERTOIRE_LINES[0].id).length === 1 && practice.practiceDeviationCandidates([firstDeviation], forcedTask, 'other-line').length === 0);

section('repairAlternatingPovAnalysis — Zwangs­züge in der Genauigkeit');
const makeAlternatingBugGame = (options: { allWhiteForced: boolean }): GameAnalysis => {
  const initialEval: EngineEvalResult = {
    scoreCp: 220,
    bestMoveUci: 'd2d4',
    pv: ['d2d4'],
    depth: 14,
    actualDepth: 14,
    status: 'complete',
  };
  const moves: MoveAnalysis[] = Array.from({ length: 14 }, (_, idx) => {
    const ply = idx + 1;
    const color: 'w' | 'b' = ply % 2 === 1 ? 'w' : 'b';
    // True eval drops cleanly to +80 on ply 1 and stays +80; odd plies stored inverted (-80) by pre-v2 POV bug.
    const rawCp = ply % 2 === 1 ? -80 : 80;
    const isForced = color === 'w' && (options.allWhiteForced || ply > 1);
    const prevTrueCp = idx === 0 ? 220 : 80;
    const evalBefore: EngineEvalResult = idx === 0
      ? initialEval
      : { scoreCp: prevTrueCp, bestMoveUci: 'e2e4', pv: ['e2e4'], depth: 14, actualDepth: 14, status: 'complete' };
    const evalAfter: EngineEvalResult = {
      scoreCp: rawCp,
      bestMoveUci: 'e7e5',
      pv: ['e7e5'],
      depth: 14,
      actualDepth: 14,
      status: 'complete',
    };
    return {
      ply,
      moveNumber: Math.ceil(ply / 2),
      color,
      san: color === 'w' ? 'e4' : 'e5',
      uci: color === 'w' ? 'e2e4' : 'e7e5',
      fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      fenAfter: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
      evalBefore,
      evalAfter,
      bestMoveUci: 'd2d4',
      bestMoveSan: 'd4',
      quality: 'good',
      comment: '',
      winChanceBefore: 50,
      winChanceAfter: 50,
      winChanceDrop: 0,
      isForced,
      isBook: false,
      isCheckmate: false,
    };
  });

  return {
    id: 'game_pov_forced_test',
    pgn: '1. e4 e5',
    white: 'Alice',
    black: 'Bob',
    result: '1/2-1/2',
    date: '2025.09.01',
    timeControl: '600',
    event: 'Test',
    site: 'Local',
    analyzedAt: Date.now(),
    engineDepth: 14,
    accuracyWhite: 0,
    accuracyBlack: 0,
    summaryWhite: { brilliant: 0, great: 0, best: 0, excellent: 0, good: 7, book: 0, inaccuracy: 0, mistake: 0, blunder: 0, miss: 0 },
    summaryBlack: { brilliant: 0, great: 0, best: 0, excellent: 0, good: 7, book: 0, inaccuracy: 0, mistake: 0, blunder: 0, miss: 0 },
    moves,
    analysisVersion: 1,
  };
};

const repairedAllForcedWhite = repairAlternatingPovAnalysis(makeAlternatingBugGame({ allWhiteForced: true }));
check('repairAlternatingPov: alle Weiß-Züge erzwungen → accuracyWhite ist 100 (nicht 0)', repairedAllForcedWhite !== null && repairedAllForcedWhite.accuracyWhite === 100 && repairedAllForcedWhite.summaryWhite.best === 7, repairedAllForcedWhite?.accuracyWhite);

const mixedForcedGame = makeAlternatingBugGame({ allWhiteForced: false });
const repairedMixedForced = repairAlternatingPovAnalysis(mixedForcedGame);
const expectedFirstDrop = Math.max(0, getPlayerWinChance(mixedForcedGame.moves[0].evalBefore, 'w') - getPlayerWinChance({ ...mixedForcedGame.moves[0].evalAfter, scoreCp: 80 }, 'w'));
const expectedWhiteAcc = Math.round(calculateMoveAccuracy(expectedFirstDrop) * 10) / 10;
check('repairAlternatingPov: schließt isForced-Züge aus Genauigkeit aus', repairedMixedForced !== null && repairedMixedForced.accuracyWhite === expectedWhiteAcc && repairedMixedForced.accuracyWhite < 100, { got: repairedMixedForced?.accuracyWhite, expected: expectedWhiteAcc });

section('PC ↔ Handy LAN-Sync Merge (Fehlerkarten, Repertoires, Partien)');
const lanMerge = require('../src/utils/lanSyncMerge') as typeof import('../src/utils/lanSyncMerge');
const chessTypesForLan = require('../src/types/chess') as typeof import('../src/types/chess');

const pcReviews: import('../src/utils/reviews').ReviewStore = {
  version: 1,
  reviews: {
    'game_1:5': { key: 'game_1:5', dueAt: T0 + 1000, intervalIdx: 1, lapses: 0, helps: 0, attempts: 1, correct: 1, spacedCorrect: 1, lastResult: 'correct', lastReviewedAt: T0 - 5000 },
    'game_2:9': { key: 'game_2:9', dueAt: T0 + 86_400_000, intervalIdx: 2, lapses: 0, helps: 0, attempts: 2, correct: 2, spacedCorrect: 2, lastResult: 'correct', lastReviewedAt: T0 + 1000 },
  },
};
const phoneReviews: import('../src/utils/reviews').ReviewStore = {
  version: 1,
  reviews: {
    'game_1:5': { key: 'game_1:5', dueAt: T0 + 3 * 86_400_000, intervalIdx: 3, lapses: 0, helps: 0, attempts: 2, correct: 2, spacedCorrect: 2, lastResult: 'correct', lastReviewedAt: T0 + 2000 },
    'game_3:11': { key: 'game_3:11', dueAt: T0 + 600_000, intervalIdx: 0, lapses: 1, helps: 0, attempts: 1, correct: 0, spacedCorrect: 0, lastResult: 'wrong', lastReviewedAt: T0 + 3000 },
  },
};
const mergedStores = lanMerge.mergeReviewStores(pcReviews, phoneReviews);
check(
  'LAN-Sync Merge: jüngerer Handy-Review gewinnt für game_1:5, PC-Review bleibt für game_2:9, Handy-Karte game_3:11 ergänzt',
  mergedStores.store.reviews['game_1:5']?.intervalIdx === 3 &&
    mergedStores.store.reviews['game_1:5']?.attempts === 2 &&
    mergedStores.store.reviews['game_2:9']?.intervalIdx === 2 &&
    mergedStores.store.reviews['game_3:11']?.lapses === 1 &&
    mergedStores.updatedCount === 2,
  mergedStores,
);

const pcSettings = chessTypesForLan.normalizeAppSettings({ ...chessTypesForLan.APP_SETTINGS_DEFAULTS, profileId: 'prof-pc-1', playerName: 'MaxChess', chessComUsername: 'max_cc', stockfishPath: 'C:\\engine\\stockfish.exe' });
const phoneSettings = chessTypesForLan.normalizeAppSettings({ ...chessTypesForLan.APP_SETTINGS_DEFAULTS, profileId: 'prof-phone-9', playerName: 'Mein Profil', lichessUsername: 'max_li', stockfishPath: 'Offline' });
const pcGame = makeAlternatingBugGame({ allWhiteForced: false });
const phoneOnlyGame: GameAnalysis = { ...pcGame, id: 'game_phone_only', date: '2026.02.02' };

const fullMerge = lanMerge.mergeSyncPayloads(
  {
    format: 'personal-chess-analyzer-lan-sync',
    version: 1,
    sentAt: new Date(T0).toISOString(),
    deviceName: 'Windows-PC',
    games: [pcGame],
    settings: pcSettings,
    learningStorage: {
      'personal-chess-analyzer-reviews-v1:prof-pc-1': JSON.stringify(pcReviews),
      'personal-chess-analyzer-repertoires-v2:prof-pc-1': JSON.stringify(['course:caro-kann']),
    },
  },
  {
    format: 'personal-chess-analyzer-lan-sync',
    version: 1,
    sentAt: new Date(T0 + 5000).toISOString(),
    deviceName: 'Android-Handy',
    games: [pcGame, phoneOnlyGame],
    settings: phoneSettings,
    learningStorage: {
      'personal-chess-analyzer-reviews-v1:prof-phone-9': JSON.stringify(phoneReviews),
      'personal-chess-analyzer-repertoires-v2:prof-phone-9': JSON.stringify(['course:slav']),
    },
  },
);

const mergedRevRaw = fullMerge.mergedPayload.learningStorage['personal-chess-analyzer-reviews-v1:prof-pc-1'];
const mergedRepRaw = fullMerge.mergedPayload.learningStorage['personal-chess-analyzer-repertoires-v2:prof-pc-1'];
const mergedRevObj = JSON.parse(mergedRevRaw || '{}') as import('../src/utils/reviews').ReviewStore;
const mergedRepArr = JSON.parse(mergedRepRaw || '[]') as string[];

check(
  'LAN-Sync Payload: vereint unterschiedliche profileIds, behält PC stockfishPath, übernimmt Konten & Partien',
  fullMerge.mergedPayload.settings.profileId === 'prof-pc-1' &&
    fullMerge.mergedPayload.settings.playerName === 'MaxChess' &&
    fullMerge.mergedPayload.settings.chessComUsername === 'max_cc' &&
    fullMerge.mergedPayload.settings.lichessUsername === 'max_li' &&
    fullMerge.mergedPayload.settings.stockfishPath === 'C:\\engine\\stockfish.exe' &&
    fullMerge.summary.gamesAdded === 1 &&
    fullMerge.summary.totalGames === 2 &&
    Object.keys(mergedRevObj.reviews).length === 3 &&
    mergedRevObj.reviews['game_1:5']?.intervalIdx === 3 &&
    mergedRepArr.includes('course:caro-kann') &&
    mergedRepArr.includes('course:slav'),
  fullMerge.summary,
);

// ---------------------------------------------------------------------------
console.log(`\n════════════════════════════════`);
console.log(`Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen`);
console.log(`════════════════════════════════`);
process.exit(failed > 0 ? 1 : 0);
