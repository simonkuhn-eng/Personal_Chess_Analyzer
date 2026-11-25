import { isReliableEvaluation } from './evaluationReliability';
import { parsePgnMetadata, extractMovesFromPgn } from './pgn';
import { calculateMoveAccuracy, classifyMove, getPlayerWinChance, terminalEval, MOVE_CLASSIFICATION_VERSION } from './analysis';
import { isKnownBookPosition, getBookOpening } from './openingBook';
import { GameAnalysis, MoveAnalysis, EngineEvalResult, QualitySummary } from '../types/chess';
import { Chess } from 'chess.js';
import { ANALYSIS_VERSION } from './repairAlternatingPov';
import { scanBrilliantMoves, BrilliantScanCancelledError, BrilliantEngineUnavailableError, BRILLIANT_VERSION } from './brilliantMoves';
import { annotateMissedOpportunities } from './missedOpportunities';
import { FORCED_MOVE_VERSION } from './forcedMoves';

/** Wird geworfen, wenn eine laufende Analyse über shouldCancel abgebrochen wurde. */
export class AnalysisCancelledError extends Error {
  constructor() {
    super('Analyse wurde abgebrochen.');
    this.name = 'AnalysisCancelledError';
  }
}

/**
 * Analysiert eine PGN-Partie Zug für Zug mit der Stockfish-Engine (via IPC)
 * und erzeugt ein vollständig klassifiziertes GameAnalysis-Objekt.
 * Von PgnImportModal UND ChessComImportModal genutzt — identische Logik.
 */
export async function analyzePgnGame(
  sourcePgn: string,
  depth: number,
  onProgress?: (current: number, total: number) => void,
  shouldCancel?: () => boolean,
): Promise<GameAnalysis> {
  const metadata = parsePgnMetadata(sourcePgn);
  const rawMoves = extractMovesFromPgn(sourcePgn);

  if (rawMoves.length === 0) {
    throw new Error('Keine gültigen Züge im PGN gefunden. Bitte überprüfe das Format.');
  }

  onProgress?.(0, rawMoves.length);

  // T03: Ohne Engine gibt es KEINE Scheinanalyse mehr (früher erfand ein
  // Math.sin-Fallback im Web-Preview "Bewertungen" mit unbrauchbaren Bestzügen).
  const electronAPI = window.electronAPI;
  if (!electronAPI?.engine?.evaluateFen) {
    throw new Error(
      'Partieanalyse erfordert die Desktop-App mit Stockfish-Engine. Im Browser ist keine echte Analyse möglich.'
    );
  }

  // Start-FEN aus dem PGN-Header (SetUp-Partien), sonst Standardaufstellung —
  // der Simulator muss exakt dieselbe Ausgangsstellung wie die Engine haben.
  const fenMatch = sourcePgn.match(/\[FEN\s+"([^"]+)"\]/);
  let board: Chess;
  try {
    board = fenMatch ? new Chess(fenMatch[1]) : new Chess();
  } catch {
    board = new Chess();
  }

  const analyzedMoves: MoveAnalysis[] = [];
  const summaryWhite: QualitySummary = { brilliant: 0, great: 0, best: 0, excellent: 0, good: 0, book: 0, inaccuracy: 0, mistake: 0, blunder: 0, miss: 0 };
  const summaryBlack: QualitySummary = { brilliant: 0, great: 0, best: 0, excellent: 0, good: 0, book: 0, inaccuracy: 0, mistake: 0, blunder: 0, miss: 0 };

  let whiteAccSum = 0;
  let blackAccSum = 0;
  let whiteCount = 0;
  let blackCount = 0;
  let analysisPartial = false;

  if (shouldCancel?.()) {
    throw new AnalysisCancelledError();
  }

  // Startstellung bewerten (nur hier ein Extra-Eval — für jeden weiteren Zug
  // wird das evalAfter des Vorgängers wiederverwendet).
  let previousEval: EngineEvalResult;
  const startTerminal = terminalEval(board);
  if (startTerminal) {
    previousEval = startTerminal;
  } else {
    previousEval = await electronAPI.engine.evaluateFen(rawMoves[0].fenBefore, depth, [], rawMoves[0].fenBefore);
    if (previousEval.status === 'unavailable') {
      throw new Error(
        'Stockfish ist nicht verfügbar — die Partie wurde NICHT analysiert. Bitte Engine-Pfad in den Einstellungen prüfen.'
      );
    }
    if (!isReliableEvaluation(previousEval)) {
      analysisPartial = true;
    }
  }

  // Kumulative UCI-Zughistorie: die Engine erhält die komplette Partie
  // (position fen <start> moves ...), damit Wiederholungs- und 50-Züge-Regeln
  // korrekt in die Bewertung einfließen (T03).
  const uciHistory: string[] = [];

  let outOfBook = false;

  for (let i = 0; i < rawMoves.length; i++) {
    if (shouldCancel?.()) {
      throw new AnalysisCancelledError();
    }
    const m = rawMoves[i];
    const isForced = board.moves({ verbose: true }).length === 1;
    onProgress?.(i + 1, rawMoves.length);

    // Simulator weiterschalten — chess.js 1.4.0 wirft bei illegalen Zügen;
    // Züge stammen aus einem geparsten PGN und sind daher legal.
    try {
      board.move({ from: m.from, to: m.to, promotion: m.promotion });
    } catch (err) {
      throw new Error(`Fehler beim Nachspielen von Zug ${m.moveNumber} (${m.san}): Partie intern inkonsistent.`);
    }
    uciHistory.push(m.uci);

    // T03: Terminale Stellung? Dann synthetisierte Bewertung, KEIN Engine-Aufruf
    // auf einer toten Position (früher: mate 0 → cp 0 → "ausgeglichen").
    let currentEval: EngineEvalResult;
    const terminal = terminalEval(board);
    if (terminal) {
      currentEval = terminal;
    } else {
      // T03-Hotfix (interaktive Abnahme): Die Engine bekommt das START-FEN
      // der Partie + die komplette Zughistorie (position fen <start> moves
      // ... wie im Kommentar beschrieben) und landet damit exakt auf fenAfter.
      // Vorher wurde fenAfter SELBST gesendet plus History → die Engine
      // sollte die Partie ab der bereits aktuellen Stellung nochmal spielen
      // → illegal ab dem ersten Zug (Analyse bricht nach 1.e4 ab).
      // R01-Nachtrag: currentFen (erreichte Stellung) für die Weiß/Schwarz-
      // Perspektive der Engine-Konversion — die Start-FEN allein würde bei
      // gespielter Historie die falsche Zugrichtung liefern.
      currentEval = await electronAPI.engine.evaluateFen(rawMoves[0].fenBefore, depth, [...uciHistory], m.fenAfter);
      if (currentEval.status === 'unavailable') {
        throw new Error(
          'Stockfish ist nicht verfügbar — die Partie wurde NICHT analysiert. Bitte Engine-Pfad in den Einstellungen prüfen.'
        );
      }
      if (!isReliableEvaluation(currentEval)) {
        analysisPartial = true;
      }
    }

    const isBest = previousEval.bestMoveUci !== '' && previousEval.bestMoveUci === m.uci;
    const classification = classifyMove({
      color: m.color,
      evalBefore: previousEval,
      evalAfter: currentEval,
      isPlayedMoveBest: isBest,
      isForced,
      isCheckmate: m.isCheckmate,
      plyNumber: m.ply,
      isBookMove: false,
      bookName: null,
    });

    // T04: Buch-Erkennung liefert nur noch die ZUSATZINFO (Theoriename) —
    // die Zugqualität kommt immer aus der realen Bewertung. Out-of-Book-Latch:
    // sobald eine Stellung unbekannt ist, wird nicht mehr ins Buch geschaut.
    let openingAnnotation: string | undefined;
    if (!outOfBook) {
      if (isKnownBookPosition(m.fenBefore) && isKnownBookPosition(m.fenAfter)) {
        const op = getBookOpening(m.fenAfter);
        if (op) {
          openingAnnotation = op.eco === 'REP' ? `Buchzug (${op.name})` : `Buchzug (${op.eco} – ${op.name})`;
        } else {
          openingAnnotation = 'Buchzug aus der Eröffnungstheorie';
        }
      } else {
        outOfBook = true;
      }
    }

    // Tally summary
    const summary = m.color === 'w' ? summaryWhite : summaryBlack;
    summary[classification.quality]++;

    const winChanceBefore = getPlayerWinChance(previousEval, m.color);
    const winChanceAfter = getPlayerWinChance(currentEval, m.color);
    const acc = calculateMoveAccuracy(classification.winChanceDrop);
    if (m.color === 'w' && !isForced) {
      whiteAccSum += acc;
      whiteCount++;
    } else if (!isForced) {
      blackAccSum += acc;
      blackCount++;
    }

    analyzedMoves.push({
      ply: m.ply,
      moveNumber: m.moveNumber,
      color: m.color,
      san: m.san,
      uci: m.uci,
      from: m.from,
      to: m.to,
      piece: m.piece,
      captured: m.captured,
      isCheck: m.isCheck,
      isCheckmate: m.isCheckmate,
      isForced,
      fenBefore: m.fenBefore,
      fenAfter: m.fenAfter,
      evalBefore: previousEval,
      evalAfter: currentEval,
      winChanceBefore,
      winChanceAfter,
      winChanceDrop: classification.winChanceDrop,
      quality: classification.quality,
      comment: classification.comment,
      openingAnnotation: openingAnnotation ?? classification.openingAnnotation,
    });

    previousEval = currentEval;
  }

  // Ehrliche Genauigkeit: wurde eine Farbe nicht bewertet (leere Partie),
  // bleibt der Wert 0 — kein erfundener 80%-Wert. (Praxis: kommt bei gültigen
  // Partien nicht vor, da immer beide Farben ziehen.)
  const accuracyWhite = whiteCount > 0 ? Math.round((whiteAccSum / whiteCount) * 10) / 10 : analyzedMoves.some(move => move.color === 'w') ? 100 : 0;
  const accuracyBlack = blackCount > 0 ? Math.round((blackAccSum / blackCount) * 10) / 10 : analyzedMoves.some(move => move.color === 'b') ? 100 : 0;

  const completeGame: GameAnalysis = {
    ...metadata,
    pgn: sourcePgn,
    analysisVersion: ANALYSIS_VERSION,
    forcedMoveVersion: FORCED_MOVE_VERSION,
    moveClassificationVersion: MOVE_CLASSIFICATION_VERSION,
    accuracyWhite,
    accuracyBlack,
    summaryWhite,
    summaryBlack,
    moves: analyzedMoves,
    analysisPartial,
  };

  try {
    return annotateMissedOpportunities(await scanBrilliantMoves(completeGame, electronAPI.engine, depth, shouldCancel));
  } catch (error) {
    if (error instanceof BrilliantScanCancelledError) throw new AnalysisCancelledError();
    if (error instanceof BrilliantEngineUnavailableError) {
      // Optional highlight verification must not discard the completed game.
      return annotateMissedOpportunities({ ...completeGame,
        brilliantScan: { version: BRILLIANT_VERSION, depth: Math.max(14, depth), complete: false } });
    }
    throw error;
  }
}
