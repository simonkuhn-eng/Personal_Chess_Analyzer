import { Chess } from 'chess.js';
import type { GameAnalysis, MoveAnalysis, MoveQuality, OpeningFocus, QualitySummary } from '../src/types/chess';

export const CARO_POLISH = 'e2e4 c7c6 b2b4 e7e5 c1b2'.split(' ');
export const POLISH = 'b2b4 g8f6 c1b2 g7g6 c2c4 f8g7 e2e3 d7d6 g1f3 e8g8 d2d4'.split(' ');
export const zero: QualitySummary = { brilliant: 0, great: 0, best: 0, excellent: 0, good: 0, book: 0, inaccuracy: 0, mistake: 0, blunder: 0, miss: 0 };
export function fixtureGame(id: string, prefix: string[], ownColor: 'w' | 'b' = 'b', errors: Record<number, MoveQuality> = {}): GameAnalysis {
  const board = new Chess(), moves: MoveAnalysis[] = [];
  const seen = new Set<string>();
  const play = (uci: string) => board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  for (let ply = 1; ply <= 32 && !board.isGameOver(); ply++) {
    const fenBefore = board.fen(), color = board.turn();
    const legal = board.moves({ verbose: true });
    // Reproducible legal continuations with no dependence on user data or engine.
    const options = legal.filter(move => !move.captured && move.piece !== 'k');
    const choices = options.length ? options : legal;
    let selected = choices[(ply * 17) % choices.length];
    for (const move of choices) {
      const probe = new Chess(fenBefore); probe.move(move);
      if (!seen.has(probe.fen().split(' ').slice(0, 4).join(' ')) && !probe.isGameOver()) { selected = move; break; }
    }
    const uci = prefix[ply - 1] || selected.from + selected.to + (selected.promotion || '');
    const best = legal.find(move => move.from + move.to + (move.promotion || '') !== uci) || legal[0];
    const played = play(uci), after = board.moves({ verbose: true })[0];
    const bestUci = best.from + best.to + (best.promotion || '');
    const quality = color === ownColor ? errors[Math.ceil(ply / 2)] || 'excellent' : 'excellent';
    const drop = quality === 'inaccuracy' ? 5 : quality === 'mistake' ? 12 : quality === 'blunder' ? 30 : 0;
    const evaluation = (bestMoveUci: string, scoreCp = 0) => ({ scoreCp, bestMoveUci, pv: bestMoveUci ? [bestMoveUci] : [], depth: 14, actualDepth: 14, status: 'complete' as const, bound: 'exact' as const });
    moves.push({ ply, moveNumber: Math.ceil(ply / 2), color, san: played.san, uci, from: played.from, to: played.to, piece: played.piece,
      captured: played.captured, isCheck: board.isCheck(), isCheckmate: board.isCheckmate(), fenBefore, fenAfter: board.fen(),
      evalBefore: evaluation(drop ? bestUci : uci), evalAfter: evaluation(after ? after.from + after.to + (after.promotion || '') : '', (color === 'w' ? -1 : 1) * drop * 10),
      quality, winChanceBefore: 50, winChanceAfter: 50 - drop, winChanceDrop: drop });
    seen.add(board.fen().split(' ').slice(0, 4).join(' '));
  }
  const summaryWhite = { ...zero }, summaryBlack = { ...zero };
  for (const move of moves) (move.color === 'w' ? summaryWhite : summaryBlack)[move.quality]++;
  return { id, white: ownColor === 'w' ? 'Alice' : 'Opponent', black: ownColor === 'b' ? 'Alice' : 'Opponent',
    pgn: board.pgn(), result: '*', openingName: prefix[0] === 'b2b4' ? 'Polish Opening' : 'Caro-Kann Defense: Polish Variation', eco: prefix[0] === 'b2b4' ? 'A00' : 'B12',
    createdAt: '2026-10-23T10:00:00Z', date: '2026.10.23', accuracyWhite: 72, accuracyBlack: 67, summaryWhite, summaryBlack, moves,
    analysisVersion: 2, forcedMoveVersion: 1, moveClassificationVersion: 1, missedOpportunityVersion: 1 };
}

export function caroPolishFocus(): OpeningFocus {
  const board = new Chess();
  CARO_POLISH.forEach(uci => board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) }));
  return { id: 'b:' + board.fen().split(' ').slice(0, 4).join(' '), name: 'Caro-Kann Defense: Polish Variation', eco: 'B12',
    color: 'b', anchorFen: board.fen(), prefixUci: CARO_POLISH, positionLabel: 'Nach 1.e4 1...c6 2.b4 2...e5 3.Bb2' };
}
