/** Narrow regression for the timing/origin of historical review arrows. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Chess } = require('chess.js');
const { reviewMoveBestArrow, reviewBestArrow, reviewPosition } = require('../src/utils/reviewPresentation');
const evaluation = (uci: string) => ({ scoreCp: 0, bestMoveUci: uci, pv: [uci], depth: 14, actualDepth: 14, status: 'complete' });
const board = new Chess(), moves: any[] = [];
for (const [played, best] of [['f3', 'f2f4'], ['e6', 'e7e5'], ['Nh3', 'e2e4']]) {
  const fenBefore = board.fen(), move = board.move(played);
  moves.push({ fenBefore, fenAfter: board.fen(), color: move.color, uci: move.from + move.to, evalBefore: evaluation(best), evalAfter: evaluation('a7a6') });
  assert.deepEqual(reviewMoveBestArrow(moves.at(-1)), { from: best.slice(0, 2), to: best.slice(2, 4) });
}
assert.equal(reviewMoveBestArrow(reviewPosition({ moves }, 0).move), null, 'No spoiler before the first move');
assert.equal(new Chess(moves[0].fenAfter).get('f2'), undefined, 'Alternative still points from the original square after the pawn left it');
assert.equal(reviewMoveBestArrow({ ...moves[0], evalBefore: { ...evaluation('e2e4'), status: 'partial' } }), null);
assert.equal(reviewMoveBestArrow({ ...moves[0], evalBefore: { ...evaluation('e2e4'), actualDepth: 4 } }), null);
assert.equal(reviewMoveBestArrow({ ...moves[0], evalBefore: evaluation('e7e5') }), null, 'Never show the opposing reply as the reviewed player best move');
assert.deepEqual(reviewMoveBestArrow({ fenBefore: 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', evalBefore: evaluation('e1g1') }), { from: 'e1', to: 'g1' });
assert.deepEqual(reviewMoveBestArrow({ fenBefore: '7k/P7/8/8/8/8/8/7K w - - 0 1', evalBefore: evaluation('a7a8q') }), { from: 'a7', to: 'a8' });
const stale = { ...evaluation('e2e4'), moves: [{ uci: 'e2e4', scoreCp: 0, pv: ['e2e4'] }], fen: new Chess().fen() };
assert.deepEqual(reviewBestArrow(moves[1].fenBefore, moves[1].evalBefore, stale), { from: 'e7', to: 'e5' }, 'Ignore a search from another position');
assert.deepEqual(reviewMoveBestArrow(reviewPosition({ moves }, 2).move), { from: 'e7', to: 'e5' }, 'Navigation uses selected move, not previous live engine output');
console.log('Review arrow checks passed: historical white/black alternative, empty origin, no initial spoiler, reliable data, castling, promotion and stale search isolation.');
