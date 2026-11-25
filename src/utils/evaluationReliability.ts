import { Chess } from 'chess.js';
import type { EngineEvalResult, GameAnalysis, MoveAnalysis } from '../types/chess';

export const MIN_RELIABLE_DEPTH = 12;

/** Bounds and interrupted searches are observations, never learning verdicts. */
export function isReliableEvaluation(value: EngineEvalResult | undefined, minDepth = MIN_RELIABLE_DEPTH): boolean {
  return !!value && (value.status === undefined || value.status === 'complete') &&
    (!value.bound || value.bound === 'exact') && Number.isFinite(value.scoreCp) &&
    (value.mate === undefined || Number.isFinite(value.mate)) &&
    Number.isFinite(value.actualDepth ?? value.depth) && (value.actualDepth ?? value.depth) >= minDepth;
}

function terminal(fen: string): boolean {
  try { return new Chess(fen).isGameOver(); } catch { return false; }
}

export function isReliableMove(move: MoveAnalysis): boolean {
  // Normal completed searches need no board replay or legal move generation.
  return isReliableEvaluation(move.evalBefore) && (isReliableEvaluation(move.evalAfter) || terminal(move.fenAfter));
}

/** Repetition is proven by history, not by FEN alone. */
export function isReliableGameMove(game: GameAnalysis, move: MoveAnalysis): boolean {
  if (isReliableMove(move)) return true;
  if (!isReliableEvaluation(move.evalBefore) || move.evalAfter.status !== 'complete' || move.evalAfter.actualDepth !== 0 || move.evalAfter.scoreCp !== 0 || move.evalAfter.bestMoveUci !== '') return false;
  try {
    const board = new Chess(game.moves[0].fenBefore);
    for (const step of game.moves) {
      board.move({ from: step.uci.slice(0, 2), to: step.uci.slice(2, 4), promotion: step.uci[4] });
      if (step === move) return board.fen() === move.fenAfter && board.isDraw();
    }
  } catch { /* No trustworthy terminal proof. */ }
  return false;
}

export function isReliableGame(game: GameAnalysis): boolean {
  return !game.analysisPartial && game.moves.length > 0 && game.moves.every(move => isReliableGameMove(game, move));
}
