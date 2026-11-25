import { Chess, type Square } from 'chess.js';

export interface ReviewVariation {
  gameId: string;
  anchorPly: number;
  returnPly?: number;
  line: string[];
  cursor: number;
  label: string;
}

/** Replay from the anchor every time: promotion, castling, en passant and black
 * SetUp positions use the same legal-move rules as the actual game. */
export function variationPosition(fen: string, line: readonly string[], cursor = line.length) {
  const board = new Chess(fen);
  const steps: { uci: string; san: string; from: string; to: string; number: number; color: 'w' | 'b' }[] = [];
  for (const uci of line) {
    try {
      const number = Number(board.fen().split(' ')[5]);
      const move = board.move({ from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion: uci[4] });
      steps.push({ uci, san: move.san, from: move.from, to: move.to, number, color: move.color });
    } catch { break; }
  }
  const selected = Math.max(0, Math.min(steps.length, cursor));
  while (board.history().length > selected) board.undo();
  return { board, fen: board.fen(), steps, cursor: selected, lastMove: steps[selected - 1] ?? null };
}

export function appendVariation(fen: string, variation: ReviewVariation, uci: string): ReviewVariation | null {
  const prefix = variation.line.slice(0, variation.cursor);
  const result = variationPosition(fen, [...prefix, uci]);
  if (result.steps.length !== prefix.length + 1) return null;
  return { ...variation, line: result.steps.map(step => step.uci), cursor: result.steps.length, label: 'Eigene Variante' };
}
