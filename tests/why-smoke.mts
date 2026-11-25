/** Focused proof/comparison checks. No user archive, network or full suite. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { GameAnalysis, EngineEvalResult } from '../src/types/chess';
const require = createRequire(import.meta.url);
const { Chess } = require('chess.js');
const { whyLine, tacticalReasons, positionDifferences, playUci } = require('../src/utils/whyEvidence');
const { explainWhy, whyCandidates, whyContext } = require('../src/utils/whyComparison');
const { compareWhyLine, ownValue, whyScore } = require('../src/utils/whyTemplates');
const { fixtureGame, CARO_POLISH } = require('./opening-phase-fixtures');
const evaluation = (uci: string, pv: string[], scoreCp = 100, mate?: number): EngineEvalResult => ({ bestMoveUci: uci, pv, scoreCp, mate, depth: 14, actualDepth: 14, status: 'complete', bound: 'exact' });
function gameAt(fen: string, uci: string): GameAnalysis {
  const board = new Chess(fen), move = playUci(board, uci), base = fixtureGame('why-fixture', CARO_POLISH);
  return { ...base, pgn: `[SetUp "1"]\n[FEN "${fen}"]\n\n${move.san} *`, moves: [{ ...base.moves[0], ply: 1, moveNumber: Number(fen.split(' ')[5]), color: move.color, uci, san: move.san,
    from: move.from, to: move.to, piece: move.piece, fenBefore: fen, fenAfter: board.fen(), evalBefore: evaluation(uci, [uci]), evalAfter: evaluation('', []) }] };
}

const pawns = '6k1/8/8/3p4/2P1P3/8/8/6K1 w - - 0 1';
assert.ok(whyCandidates(pawns, 'c4d5', 'g1f1', 'e4d5').includes('e4d5'));
const a = whyLine(pawns, [], ['c4d5'], null, 'best', 'a', false), b = whyLine(pawns, [], ['e4d5'], null, 'alternative', 'b', false);
assert.ok(positionDifferences(pawns, a, b).some((reason: any) => reason.motif === 'P01'));
assert.ok(positionDifferences(pawns, a, b).every((reason: any) => reason.level === 'positional_observation'));
const pinned = '4k3/4p3/3p4/2B5/8/8/8/4R1K1 w - - 0 1';
assert.ok(tacticalReasons(pinned, whyLine(pinned, [], ['c5d6'], null, 'best', '', true)).some((reason: any) => reason.motif === 'T02'));
const unpinned = '5k2/4p3/3p4/2B5/8/8/8/4R1K1 w - - 0 1';
assert.ok(!tacticalReasons(unpinned, whyLine(unpinned, [], ['c5d6'], null, 'best', '', true)).some((reason: any) => reason.motif === 'T02'));
const relativePin = '4q1k1/4p3/3p4/2B5/8/8/8/4R1K1 w - - 0 1';
assert.ok(!tacticalReasons(relativePin, whyLine(relativePin, [], ['c5d6'], null, 'best', '', true)).some((reason: any) => reason.motif === 'T02'), 'Relative pin does not prohibit recapture');
const queenTrade = '3r2k1/8/8/3q4/8/8/8/3Q2K1 w - - 0 1';
assert.equal(whyLine(queenTrade, [], ['d1d5', 'd8d5'], null, 'best', '', true).materialGain, 0, 'A recaptured queen trade is not a queen win');
const mate = '7k/8/5KQ1/8/8/8/8/8 w - - 0 1';
const checkmate = whyLine(mate, [], ['g6g7'], null, 'best', '', true);
assert.equal(checkmate.terminal, 'win');
assert.ok(tacticalReasons(mate, checkmate).some((reason: any) => reason.motif === 'T22'));
const stalemate = whyLine(mate, [], ['g6f7'], null, 'alternative', '', true);
assert.equal(stalemate.terminal, 'draw');
assert.match(compareWhyLine(checkmate, stalemate, 'w'), /sofort matt/);
assert.throws(() => whyLine(mate, [], ['g6g7', 'h8h7'], null, 'best', '', true), /vollständig legal/);
const blackMateFen = '8/8/8/8/8/5kq1/8/7K b - - 0 1';
assert.equal(whyLine(blackMateFen, [], ['g3g2'], null, 'best', '', true).terminal, 'win');
assert.equal(ownValue(evaluation('g3g2', ['g3g2'], -300), 'b'), 300);
assert.equal(whyScore({ ...a, reliable: true, evaluation: evaluation(a.uci, [a.uci], -300) }, 'b'), '+3.0');
const repeated = ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1'];
assert.equal(whyLine(new Chess().fen(), repeated, ['f6g8'], null, 'alternative', '', true).terminal, 'draw', 'Repetition uses complete history');
const promotion = '8/k1P5/2K5/8/8/8/8/8 w - - 0 1';
assert.equal(whyLine(promotion, [], ['c7c8q'], null, 'alternative', '', true).terminal, 'draw');
assert.equal(whyLine(promotion, [], ['c7c8r'], null, 'alternative', '', true).terminal, null);
assert.ok(whyCandidates(promotion, 'c7c8r', 'c7c8q').includes('c7c8n'), 'Underpromotions remain distinct candidates');

const overload = '3q2k1/3r2pp/8/2B5/8/8/8/3R1RK1 w - - 0 1';
const game = gameAt(overload, 'd1d7');
let calls = 0;
const contexts: any[] = [];
const fake = { evaluateFen: async (start: string, depth: number, history: string[], current: string, options: any) => {
  calls++; contexts.push({ start, history: [...history], current, options });
  const board = new Chess(start); history.forEach(uci => playUci(board, uci)); assert.equal(board.fen(), current);
  if (history.length === 2 && history[1] === 'd8d7') return evaluation('f1f8', ['f1f8'], 1000, 1);
  const legal = board.moves({ verbose: true }).map((move: any) => move.from + move.to + (move.promotion || ''));
  const uci = options.searchMoves?.[0] || 'd1d7';
  assert.ok(legal.includes(uci));
  return evaluation(uci, uci === 'd1d7' ? ['d1d7', 'd8e8'] : [uci], 400);
} };
const result = await explainWhy(game, 1, fake, { engineKey: 'mock-overload', reply: 'd8d7' }, { requestId: 'why-mock', cancelled: () => false });
assert.ok(result.reasons.some((reason: any) => reason.motif === 'T12'), 'Two actual duties plus legal losing recapture support overload');
assert.ok(result.reasons.some((reason: any) => reason.motif === 'T17'));
assert.ok(result.replies.some((line: any) => line.terminal === 'win'));
assert.ok(contexts.some(context => context.history.join(' ') === 'd1d7 d8d7'));
const oldCalls = calls;
await explainWhy(game, 1, fake, { engineKey: 'mock-overload', reply: 'd8d7' }, { requestId: 'why-cache', cancelled: () => false });
assert.equal(calls, oldCalls, 'Reopening does not repeat completed engine work');
await assert.rejects(explainWhy(game, 1, fake, {}, { requestId: 'why-cancel', cancelled: () => true }), { name: 'AbortError' });
const historyGame = fixtureGame('history', CARO_POLISH);
const context = whyContext(historyGame, 6);
assert.equal(context.history.length, 5);
assert.equal(context.anchorFen, historyGame.moves[5].fenBefore);
const forced = await explainWhy(gameAt('7k/5K2/6R1/8/8/8/8/8 b - - 0 1', 'h8h7'), 1,
  { evaluateFen: async () => { throw Error('A sole legal move needs no search'); } }, {}, { requestId: 'why-forced', cancelled: () => false });
assert.ok(forced.forced && forced.reasons.some((reason: any) => reason.motif === 'T25'));
const custom = await explainWhy(gameAt(overload, 'f1f2'), 1, fake, { engineKey: 'mock-choice', alternative: 'g1h1' }, { requestId: 'why-choice', cancelled: () => false });
assert.match(custom.summary, /Kh1/, 'Summary centers on the explicitly selected alternative');
const safeCapture = { evaluateFen: async (start: string, depth: number, history: string[], current: string, options: any) =>
  history.length === 2 ? evaluation('g1h1', ['g1h1'], 0) : fake.evaluateFen(start, depth, history, current, options) };
const notOverloaded = await explainWhy(game, 1, safeCapture, { engineKey: 'mock-safe-capture' }, { requestId: 'why-negative', cancelled: () => false });
assert.ok(!notOverloaded.reasons.some((reason: any) => reason.motif === 'T12'), 'Two duties without a concrete losing branch are not overload proof');
for (const badResult of [
  { ...evaluation('d1d7', ['d1d7']), status: 'partial' },
  evaluation('d1d7', ['d1d7', 'b7b6']),
]) await assert.rejects(explainWhy(game, 1, { evaluateFen: async () => badResult }, { engineKey: 'mock-bad-' + badResult.status }, { requestId: 'why-bad', cancelled: () => false }), /keine ausreichend tiefe/);
// Advance the injected clock inside a never-started/queued search. Its UI
// deadline expires immediately; the unresolved bridge promise cannot block it.
const realNow = Date.now, cancelledDeadlines: string[] = [];
let offset = 0;
try {
  Date.now = () => realNow() + offset;
  await assert.rejects(explainWhy(game, 1, {
    evaluateFen: () => { offset = 23000; return new Promise(() => {}); },
    cancelRequest: async (id: string) => { cancelledDeadlines.push(id); },
  }, { engineKey: 'mock-queued-timeout' }, { requestId: 'why-deadline', cancelled: () => false }), /keine ausreichend tiefe/);
  assert.deepEqual(cancelledDeadlines, ['why-deadline']);
} finally { Date.now = realNow; }
console.log('Why smoke passed: legal history/repetition, both colors, pawn alternatives, pins, net recaptures, mate vs stalemate, forced move, overload witness/negative, user choice, partial/illegal PV rejection, cancellation and cache.');

if (process.argv.includes('--engine')) {
  const Module = (await import('node:module')).default as any, load = Module._load;
  Module._load = function(request: string, parent: unknown, main: boolean) { if (request === 'electron') return { app: { getPath: () => process.cwd(), getAppPath: () => process.cwd() } }; return load.call(this, request, parent, main); };
  const { StockfishEngine } = require('../electron/stockfish'); Module._load = load;
  const engine = new StockfishEngine();
  try {
    const standard = new Chess(), start = standard.fen(); standard.move('e4');
    const restricted = await engine.evaluateFen(start, 12, ['e2e4'], standard.fen(), { requestId: 'why-restrict', maxTimeMs: 3000, searchMoves: ['c7c6'] });
    assert.equal(restricted.bestMoveUci, 'c7c6');
    assert.equal((await engine.evaluateFen(start, 12, [], start, { searchMoves: ['c7c6'] })).status, 'unavailable');
    const queen = gameAt('6k1/8/8/3q4/8/8/8/3Q2K1 w - - 0 1', 'g1f1');
    const real = await explainWhy(queen, 1, engine, { engineKey: 'local-engine' }, { requestId: 'why-real', cancelled: () => false, progress: (value: string) => console.log(value) });
    assert.equal(real.best.uci, 'd1d5');
    assert.ok(real.alternatives.some((line: any) => line.uci === 'g1f1'));
    assert.ok(real.reasons.some((reason: any) => reason.motif === 'T01'));
    assert.ok(!real.limited, 'Reference fixture should fit the normal budget');
    const realOverload = await explainWhy(game, 1, engine, { engineKey: 'local-overload', reply: 'd8d7' }, { requestId: 'why-real-overload', cancelled: () => false });
    assert.equal(realOverload.best.uci, 'd1d7');
    assert.ok(realOverload.reasons.some((reason: any) => reason.motif === 'T12'));
    const expensive = engine.evaluateFenMultiPv(start, 30, 3, [], start, { requestId: 'review-stop' });
    const queued = engine.evaluateFen(start, 18, [], start, { requestId: 'why-skip', maxTimeMs: 5000 });
    await new Promise(resolve => setTimeout(resolve, 80));
    engine.cancelRequest('why-skip'); engine.cancelRequest('review-stop');
    assert.notEqual((await expensive).status, 'complete');
    assert.equal((await queued).status, 'unavailable');
    const ordinary = await engine.evaluateFen(start, 12, [], start);
    assert.equal(ordinary.status, 'complete', 'Cancellation does not poison other review searches');
    console.log(`Real Stockfish passed: restricted/history search, queen comparison (${real.alternatives.length} alternatives), cancellation of active/queued work and queue recovery.`);
  } finally { engine.dispose(); }
}
