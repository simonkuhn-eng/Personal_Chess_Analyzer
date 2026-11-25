import type { EngineEvalResult, GameAnalysis, MoveAnalysis, QualitySummary } from '../types/chess';
import { calculateMoveAccuracy, classifyMove, getPlayerWinChance } from './analysis';

/** Renderer/Preload-Analysen vor der IPC-Korrektur nutzten auf jeder zweiten
 * Stellung die falsche Seite für UCI-Scores. Version 2 hat den vollständigen
 * POV-Vertrag; die Reparatur wird nur bei einem klaren Alternationsmuster aktiv.
 */
export const ANALYSIS_VERSION = 2;

function correctedScore(move: MoveAnalysis): number {
  return move.ply % 2 === 1 ? -move.evalAfter.scoreCp : move.evalAfter.scoreCp;
}

/** Sichere Signatur: die Korrektur muss die Volatilität massiv reduzieren. */
export function hasAlternatingPovBug(game: GameAnalysis): boolean {
  if (game.analysisVersion === ANALYSIS_VERSION) return false;
  const moves = game.moves.slice(0, 50);
  let rawVolatility = 0;
  let correctedVolatility = 0;
  let pairs = 0;

  for (let i = 1; i < moves.length; i++) {
    const before = moves[i - 1].evalAfter;
    const after = moves[i].evalAfter;
    // Die betroffene Engine-Generation speicherte actualDepth. Ältere,
    // bereits korrekte Analysen ohne dieses Feld bleiben unangetastet.
    if (!before.actualDepth || !after.actualDepth || before.mate !== undefined || after.mate !== undefined) continue;
    const a = before.scoreCp;
    const b = after.scoreCp;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (Math.abs(a) < 15 || Math.abs(b) < 15 || Math.abs(a) > 1500 || Math.abs(b) > 1500) continue;
    rawVolatility += Math.abs(b - a);
    correctedVolatility += Math.abs(correctedScore(moves[i]) - correctedScore(moves[i - 1]));
    pairs++;
  }

  return pairs >= 12 && rawVolatility > 0 && correctedVolatility < rawVolatility * 0.45;
}

function isSyntheticTerminal(evalResult: EngineEvalResult): boolean {
  return evalResult.actualDepth === 0 && evalResult.bestMoveUci === '' && evalResult.status === 'complete';
}

function newSummary(): QualitySummary {
  return { brilliant: 0, great: 0, best: 0, excellent: 0, good: 0, book: 0, inaccuracy: 0, mistake: 0, blunder: 0, miss: 0 };
}

/** Rechnet gespeicherte Bewertungen und alle davon abgeleiteten Felder neu.
 * Keine neue Engine-Suche nötig; PV/Bestzug/FEN bleiben unverändert.
 */
export function repairAlternatingPovAnalysis(game: GameAnalysis): GameAnalysis | null {
  if (!hasAlternatingPovBug(game)) return null;

  const summaryWhite = newSummary();
  const summaryBlack = newSummary();
  let whiteAccuracy = 0;
  let blackAccuracy = 0;
  let whiteMoves = 0;
  let blackMoves = 0;
  let previousEval = { ...game.moves[0].evalBefore };

  const moves = game.moves.map((move): MoveAnalysis => {
    const shouldFlip = move.ply % 2 === 1 && !isSyntheticTerminal(move.evalAfter);
    const evalAfter: EngineEvalResult = shouldFlip
      ? {
          ...move.evalAfter,
          scoreCp: -move.evalAfter.scoreCp,
          mate: move.evalAfter.mate === undefined ? undefined : -move.evalAfter.mate,
        }
      : { ...move.evalAfter };
    const classification = classifyMove({
      color: move.color,
      evalBefore: previousEval,
      evalAfter,
      isPlayedMoveBest: previousEval.bestMoveUci !== '' && previousEval.bestMoveUci === move.uci,
      isCheckmate: move.isCheckmate,
      isForced: move.isForced,
    });
    const winChanceBefore = getPlayerWinChance(previousEval, move.color);
    const winChanceAfter = getPlayerWinChance(evalAfter, move.color);
    const accuracy = calculateMoveAccuracy(classification.winChanceDrop);
    if (move.color === 'w') {
      summaryWhite[classification.quality]++;
      if (!move.isForced) {
        whiteAccuracy += accuracy;
        whiteMoves++;
      }
    } else {
      summaryBlack[classification.quality]++;
      if (!move.isForced) {
        blackAccuracy += accuracy;
        blackMoves++;
      }
    }
    const repaired = {
      ...move,
      evalBefore: previousEval,
      evalAfter,
      winChanceBefore,
      winChanceAfter,
      winChanceDrop: classification.winChanceDrop,
      quality: classification.quality,
      comment: classification.comment,
      brilliantEvidence: undefined,
      missedOpportunity: undefined,
    };
    previousEval = evalAfter;
    return repaired;
  });

  return {
    ...game,
    moves,
    summaryWhite,
    summaryBlack,
    accuracyWhite: whiteMoves
      ? Math.round((whiteAccuracy / whiteMoves) * 10) / 10
      : (moves.some((move) => move.color === 'w') ? 100 : 0),
    accuracyBlack: blackMoves
      ? Math.round((blackAccuracy / blackMoves) * 10) / 10
      : (moves.some((move) => move.color === 'b') ? 100 : 0),
    analysisVersion: ANALYSIS_VERSION,
    brilliantScan: undefined,
    missedOpportunityVersion: undefined,
    forcedMoveVersion: undefined,
    moveClassificationVersion: undefined,
  };
}
