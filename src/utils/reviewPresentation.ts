import { Chess, type Square } from 'chess.js';
import type { EngineEvalResult, GameAnalysis, MoveAnalysis } from '../types/chess';
import { legalEngineArrow } from './analysis';
import type { MultiPvResponse, TopMoveResult } from '../types/electron';
import { isReliableEvaluation } from './evaluationReliability';

export interface LiveReviewEvaluation extends MultiPvResponse {
  gameId: string;
  fen: string;
  requestedDepth: number;
  contextKey?: string;
}

export function reviewPosition(game: GameAnalysis | null, selectedPly: number) {
  const ply = game ? Math.max(0, Math.min(game.moves.length, Math.trunc(selectedPly) || 0)) : 0;
  const move = game && ply > 0 ? game.moves[ply - 1] : undefined;
  const fen = move?.fenAfter || game?.moves[0]?.fenBefore || new Chess().fen();
  const evaluation = move?.evalAfter || game?.moves[0]?.evalBefore;
  return { ply, move, fen, evaluation, turn: fen.split(' ')[1] === 'b' ? 'b' as const : 'w' as const };
}

/** A legal move can belong to an older position too: FEN identity is mandatory. */
export function matchingLiveReview(
  result: LiveReviewEvaluation | null, gameId: string | undefined, fen: string, depth: number,
  contextKey?: string,
): LiveReviewEvaluation | null {
  return result && result.gameId === gameId && result.fen === fen && result.requestedDepth === depth &&
    (contextKey === undefined || result.contextKey === contextKey) && result.status !== 'unavailable' ? result : null;
}

export function legalReviewTopMoves(fen: string, result: LiveReviewEvaluation | null): TopMoveResult[] {
  return result ? result.moves.filter(move => legalEngineArrow(fen, move.uci)) : [];
}

export function reviewBestArrow(fen: string, saved: EngineEvalResult | undefined, live: LiveReviewEvaluation | null) {
  if (live?.fen === fen) {
    const best = legalReviewTopMoves(fen, live)[0];
    // Use only a search for this exact position, never a newer reply position.
    return best ? legalEngineArrow(fen, best.uci) : null;
  }
  return saved?.status === 'unavailable' ? null : legalEngineArrow(fen, saved?.bestMoveUci);
}

/** Historical comparison on the board AFTER a move: validate the alternative
 * in fenBefore. Its source square may now be empty, or its target occupied. */
export function reviewMoveBestArrow(move: Pick<MoveAnalysis, 'fenBefore' | 'evalBefore'> | null | undefined) {
  return move && isReliableEvaluation(move.evalBefore) ? reviewBestArrow(move.fenBefore, move.evalBefore, null) : null;
}

export function principalVariationSan(fen: string, moves: string[]): string[] {
  const sans: string[] = [];
  try {
    const chess = new Chess(fen);
    for (const uci of moves) {
      if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) break;
      try { sans.push(chess.move({ from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion: uci[4] }).san); }
      catch { break; }
    }
  } catch { /* An invalid position has no principal variation. */ }
  return sans;
}

export interface ReviewMoveRow { number: number; white?: { move: MoveAnalysis; ply: number }; black?: { move: MoveAnalysis; ply: number } }
export function reviewMoveRows(moves: MoveAnalysis[]): ReviewMoveRow[] {
  const rows: ReviewMoveRow[] = [];
  for (const [index, move] of moves.entries()) {
    let row = rows[rows.length - 1];
    if (!row || row.number !== move.moveNumber || row[move.color === 'w' ? 'white' : 'black']) {
      row = { number: move.moveNumber };
      rows.push(row);
    }
    row[move.color === 'w' ? 'white' : 'black'] = { move, ply: index + 1 };
  }
  return rows;
}
