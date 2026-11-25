import { isReliableGame } from './evaluationReliability';
import type { ArchiveItem, GameAnalysis } from '../types/chess';
import { resolvePlayerColor } from './moveInsights';
import { moveCategory } from './analysis';

/** Keep archive counts and direct links scoped to the exact selected player. */
export function archiveItem(game: GameAnalysis, targetPlayer?: string): ArchiveItem {
  const color = targetPlayer ? resolvePlayerColor(game.white, game.black, targetPlayer, game.site) : null;
  const moves = targetPlayer ? (color ? game.moves.filter(move => move.color === color) : []) : game.moves;
  const { moves: _moves, pgn: _pgn, summaryWhite: _white, summaryBlack: _black, ...metadata } = game;
  const brilliantMoves = moves.filter(move => move.quality === 'brilliant')
    .map(({ ply, moveNumber, san, color }) => ({ ply, moveNumber, san, color }));
  return { ...metadata, analysisPartial: !isReliableGame(game), mistakeCount: moves.filter(move => moveCategory(move) === 'mistake').length,
    blunderCount: moves.filter(move => moveCategory(move) === 'blunder').length,
    brilliantCount: brilliantMoves.length, brilliantMoves };
}
