import { Chess, type Move, type Square } from 'chess.js';

export const MATERIAL_VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
export function materialBalance(board: Chess, color: 'w' | 'b'): number {
  return board.board().flat().reduce((sum, piece) => sum + (piece ? MATERIAL_VALUES[piece.type] * (piece.color === color ? 1 : -1) : 0), 0);
}

/** A legal, complete prefix with no immediately unresolved recapture at its end. */
export function lineEvidence(fen: string, line: readonly string[], color: 'w' | 'b') {
  try {
    const board = new Chess(fen);
    const initial = materialBalance(board, color);
    const captures: Move[] = [];
    let last: Move | undefined;
    for (const uci of line) {
      last = board.move({ from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion: uci[4] });
      if (last.captured) captures.push(last);
    }
    if (!last) return null;
    const settled = !board.moves({ verbose: true }).some(move => move.captured && move.to === last!.to);
    return { board, last, captures, settled, material: materialBalance(board, color), gain: materialBalance(board, color) - initial,
      ownMate: board.isCheckmate() && board.turn() !== color };
  } catch { return null; }
}
