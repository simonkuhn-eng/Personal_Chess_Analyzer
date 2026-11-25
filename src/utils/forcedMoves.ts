import { Chess } from 'chess.js';
import type { GameAnalysis, MoveAnalysis, QualitySummary } from '../types/chess';
import { calculateMoveAccuracy } from './analysis';

export const FORCED_MOVE_VERSION = 1;
export const FORCED_MOVE_COMMENT = 'Erzwungener Zug: Es gab nur einen legalen Zug.';

export function isOnlyLegalMove(board: Chess, uci: string): boolean {
  const legal = board.moves({ verbose: true });
  return legal.length === 1 && `${legal[0].from}${legal[0].to}${legal[0].promotion || ''}` === uci;
}

/** Repair only penalized legacy moves, once per game version. Never hide a
 * real mistake just because it was a check, recapture or plausible response. */
export function annotateForcedMoves(game: GameAnalysis): GameAnalysis {
  if (game.forcedMoveVersion === FORCED_MOVE_VERSION) return game;
  let changed = false;
  const moves = game.moves.map((move): MoveAnalysis => {
    if (!['inaccuracy', 'mistake', 'blunder', 'miss'].includes(move.quality) && !move.missedOpportunity) return move;
    try {
      const board = new Chess(move.fenBefore);
      if (board.turn() !== move.color || !isOnlyLegalMove(board, move.uci)) return move;
      const played = board.move({ from: move.from, to: move.to, promotion: move.uci[4] });
      if (!played || board.fen() !== move.fenAfter) return move;
    } catch { return move; }
    changed = true;
    return { ...move, isForced: true, quality: 'best', winChanceDrop: 0, comment: FORCED_MOVE_COMMENT, missedOpportunity: undefined, brilliantEvidence: undefined };
  });
  if (!changed) return { ...game, forcedMoveVersion: FORCED_MOVE_VERSION };
  const summaryWhite = Object.fromEntries(Object.keys(game.summaryWhite).map(key => [key, 0])) as unknown as QualitySummary;
  const summaryBlack = { ...summaryWhite };
  let whiteSum = 0, blackSum = 0, whiteCount = 0, blackCount = 0;
  for (const move of moves) {
    (move.color === 'w' ? summaryWhite : summaryBlack)[move.quality]++;
    if (move.isForced) continue;
    const accuracy = calculateMoveAccuracy(move.winChanceDrop);
    if (move.color === 'w') { whiteSum += accuracy; whiteCount++; }
    else { blackSum += accuracy; blackCount++; }
  }
  return { ...game, forcedMoveVersion: FORCED_MOVE_VERSION, moves, summaryWhite, summaryBlack,
    accuracyWhite: whiteCount ? Math.round(whiteSum / whiteCount * 10) / 10 : moves.some(move => move.color === 'w') ? 100 : 0,
    accuracyBlack: blackCount ? Math.round(blackSum / blackCount * 10) / 10 : moves.some(move => move.color === 'b') ? 100 : 0 };
}
