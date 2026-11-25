/** Local Stockfish integration; never reads/writes the user's game database. */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import Module from 'node:module';
import type { GameAnalysis, MoveAnalysis } from '../src/types/chess';
const require = createRequire(import.meta.url);
const { Chess } = require('chess.js') as typeof import('chess.js');
const { scanBrilliantMoves } = require('../src/utils/brilliantMoves') as typeof import('../src/utils/brilliantMoves');
const { classifyMove, getPlayerWinChance } = require('../src/utils/analysis') as typeof import('../src/utils/analysis');
const { detectMissedOpportunity } = require('../src/utils/missedOpportunities') as typeof import('../src/utils/missedOpportunities');
const { analyzePgnGame } = require('../src/utils/analyzeGame') as typeof import('../src/utils/analyzeGame');
const loader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const previous = loader._load;
loader._load = function(request, parent, isMain) {
  if (request === 'electron') return { app: { getAppPath: () => process.cwd(), getPath: () => process.cwd() } };
  return previous.call(this, request, parent, isMain);
};
const { StockfishEngine } = require('../electron/stockfish') as typeof import('../electron/stockfish');
loader._load = previous;
const engine = new StockfishEngine();
const depth = 14;
async function evaluateMove(fen: string, uci: string): Promise<MoveAnalysis> {
  const board = new Chess(fen);
  const played = board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  const evalBefore = await engine.evaluateFen(fen, depth, [], fen);
  const evalAfter = await engine.evaluateFen(fen, depth, [uci], board.fen());
  const classification = classifyMove({ color: played.color, evalBefore, evalAfter, isPlayedMoveBest: evalBefore.bestMoveUci === uci });
  return { ply: 1, moveNumber: Number(fen.split(' ')[5]), color: played.color, san: played.san, uci,
    from: played.from, to: played.to, piece: played.piece, captured: played.captured,
    fenBefore: fen, fenAfter: board.fen(), evalBefore, evalAfter,
    isCheck: played.san.includes('+'), isCheckmate: played.san.includes('#'),
    winChanceBefore: getPlayerWinChance(evalBefore, played.color), winChanceAfter: getPlayerWinChance(evalAfter, played.color), ...classification };
}
function gameWith(move: MoveAnalysis): GameAnalysis {
  const zero = { brilliant: 0, great: 0, best: 0, excellent: 0, good: 0, book: 0, inaccuracy: 0, mistake: 0, blunder: 0, miss: 0 };
  return { id: 'engine_fixture', white: 'Fixture', black: 'Opponent', result: '*', pgn: '*', createdAt: '2026-10-21T12:00:00Z',
    summaryWhite: { ...zero }, summaryBlack: { ...zero }, accuracyWhite: 100, accuracyBlack: 100, moves: [move] };
}
try {
  const gift = await evaluateMove('r1bq1rk1/pppnbppp/2n1p3/3pP3/3P3P/3B1N2/PPP2PP1/RNBQK2R w KQ - 0 8', 'd3h7');
  const checked = await scanBrilliantMoves(gameWith(gift), engine, depth);
  console.log(JSON.stringify({ san: gift.san, before: gift.evalBefore, after: gift.evalAfter, result: checked.moves[0].quality, evidence: checked.moves[0].brilliantEvidence }, null, 2));
  assert.equal(checked.moves[0].quality, 'brilliant', 'Greek gift must be confirmed by the real engine');
  (globalThis as unknown as { window: unknown }).window = { electronAPI: { engine } };
  const automatic = await analyzePgnGame(`[SetUp "1"]\n[FEN "${gift.fenBefore}"]\n[White "Fixture"]\n[Black "Opponent"]\n\n8. Bxh7+ *`, depth);
  assert.equal(automatic.moves[0].quality, 'brilliant');
  assert.equal(automatic.summaryWhite.brilliant, 1);
  assert.equal(automatic.missedOpportunityVersion, 1);
  (globalThis as unknown as { window: unknown }).window = { electronAPI: { engine: {
    evaluateFen: (...args: Parameters<typeof engine.evaluateFen>) => engine.evaluateFen(...args),
    evaluateFenMultiPv: async () => ({ scoreCp: 0, bestMoveUci: '', pv: [], moves: [], depth, status: 'unavailable' }),
  } } };
  const withoutOptionalSearch = await analyzePgnGame(`[SetUp "1"]\n[FEN "${gift.fenBefore}"]\n[White "Fixture"]\n[Black "Opponent"]\n\n8. Bxh7+ *`, depth);
  assert.equal(withoutOptionalSearch.moves.length, 1, 'a failed optional highlight search must preserve the analysed game');
  assert.equal(withoutOptionalSearch.brilliantScan?.complete, false);
  const missedQueen = await evaluateMove('6k1/8/8/3q4/8/8/8/3Q2K1 w - - 0 1', 'g1f1');
  assert.equal(detectMissedOpportunity(missedQueen)?.kind, 'material');
  const badGift = await evaluateMove('r1bq1rk1/pppnbppp/2n1p3/3pP3/3P4/3B1N2/PPP2PPP/RNBQ1RK1 w - - 0 8', 'd3h7');
  assert.notEqual((await scanBrilliantMoves(gameWith(badGift), engine, depth)).moves[0].quality, 'brilliant');
  const scholar = new Chess();
  for (const san of ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6']) scholar.move(san);
  const missedMate = await evaluateMove(scholar.fen(), 'h5e2');
  assert.equal(detectMissedOpportunity(missedMate)?.kind, 'mate');
  console.log('Real Stockfish: good/bad sacrifice, missed queen win and missed mate passed.');
} finally {
  engine.dispose();
}
