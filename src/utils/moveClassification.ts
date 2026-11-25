import type { GameAnalysis, MoveAnalysis } from '../types/chess';
import { classifyMove, MOVE_CLASSIFICATION_VERSION } from './analysis';

/** Correct old overgenerous stars from the saved evaluations, once per version.
 * No board replay, new engine search, accuracy change or learning-key change. */
export function updateMoveClassifications(game: GameAnalysis): GameAnalysis {
  if (game.moveClassificationVersion === MOVE_CLASSIFICATION_VERSION) return game;
  let changed = false;
  const moves = game.moves.map((move): MoveAnalysis => {
    if (move.quality !== 'best') return move;
    const classified = classifyMove({ color: move.color, evalBefore: move.evalBefore, evalAfter: move.evalAfter,
      isPlayedMoveBest: !!move.evalBefore.bestMoveUci && move.evalBefore.bestMoveUci === move.uci,
      isForced: move.isForced, isCheckmate: move.isCheckmate });
    if (classified.quality === move.quality && classified.comment === move.comment) return move;
    changed = true;
    return { ...move, quality: classified.quality, comment: classified.comment };
  });
  if (!changed) return { ...game, moveClassificationVersion: MOVE_CLASSIFICATION_VERSION };
  const summaryWhite = { ...game.summaryWhite }, summaryBlack = { ...game.summaryBlack };
  for (const key of Object.keys(summaryWhite) as Array<keyof typeof summaryWhite>) { summaryWhite[key] = 0; summaryBlack[key] = 0; }
  for (const move of moves) (move.color === 'w' ? summaryWhite : summaryBlack)[move.quality]++;
  return { ...game, moves, summaryWhite, summaryBlack, moveClassificationVersion: MOVE_CLASSIFICATION_VERSION };
}
