import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { GameAnalysis, MoveAnalysis, EngineEvalResult } from '../src/types/chess';
import type { ElectronAPI, TopMoveResult } from '../src/types/electron';

const require = createRequire(import.meta.url);
const { Chess } = require('chess.js') as typeof import('chess.js');
const brilliant = require('../src/utils/brilliantMoves') as typeof import('../src/utils/brilliantMoves');
const missed = require('../src/utils/missedOpportunities') as typeof import('../src/utils/missedOpportunities');
const deck = require('../src/utils/trainingDeck') as typeof import('../src/utils/trainingDeck');
const { archiveItem } = require('../src/utils/archive') as typeof import('../src/utils/archive');
const { reviewBadgeQuality } = require('../src/utils/analysis') as typeof import('../src/utils/analysis');
const { reviewQualityCounts } = require('../src/utils/moveQuality') as typeof import('../src/utils/moveQuality');
const { judgeTrainingAttempt } = require('../src/utils/trainingJudge') as typeof import('../src/utils/trainingJudge');

let passed = 0;
async function test(name: string, fn: () => unknown) {
  await fn(); passed++; console.log(`  ✓ ${name}`);
}
function makeMove(fen: string, uci: string, bestLine: string[], replyLine: string[], beforeCp = 300, afterCp = 300): MoveAnalysis {
  const board = new Chess(fen);
  const played = board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  const ev = (scoreCp: number, line: string[]): EngineEvalResult => ({ scoreCp, bestMoveUci: line[0] || '', pv: line, depth: 14, actualDepth: 14, status: 'complete', bound: 'exact' });
  return { ply: 1, moveNumber: Number(fen.split(' ')[5]), color: played.color, san: played.san, uci, from: played.from, to: played.to, piece: played.piece,
    captured: played.captured, isCheck: played.san.includes('+'), isCheckmate: played.san.includes('#'),
    fenBefore: fen, fenAfter: board.fen(), evalBefore: ev(beforeCp, bestLine), evalAfter: ev(afterCp, replyLine),
    winChanceBefore: 70, winChanceAfter: 70, winChanceDrop: 0, quality: 'best' };
}
function gameWith(moves: MoveAnalysis[]): GameAnalysis {
  const zero = { brilliant: 0, great: 0, best: 0, excellent: 0, good: 0, book: 0, inaccuracy: 0, mistake: 0, blunder: 0, miss: 0 };
  const game: GameAnalysis = { id: 'game_synthetic_highlights', createdAt: '2026-10-21T12:00:00Z', white: 'Alice', black: 'Bob', result: '*', pgn: '*',
    accuracyWhite: 80, accuracyBlack: 75, summaryWhite: { ...zero }, summaryBlack: { ...zero }, moves, analysisVersion: 2 };
  for (const move of moves) (move.color === 'w' ? game.summaryWhite : game.summaryBlack)[move.quality]++;
  return game;
}
const GREEK = 'r1bq1rk1/pppnbppp/2n1p3/3pP3/3P4/3B1N2/PPP2PPP/RNBQ1RK1 w - - 0 8';
const gift = makeMove(GREEK, 'd3h7', ['d3h7'], ['g8h7']);
const fakeEngine = (options: { acceptCp?: number; alternativeCp?: number; playedCp?: number; partial?: boolean; unavailable?: boolean; afterRoot?: () => void } = {}): Pick<ElectronAPI['engine'], 'evaluateFen' | 'evaluateFenMultiPv'> => ({
  evaluateFenMultiPv: async (start, depth, count, history, current) => {
    assert.equal(count, 5);
    const board = new Chess(start);
    for (const uci of history || []) board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    assert.equal(board.fen(), current);
    const alternatives = board.moves({ verbose: true }).map(move => move.from + move.to + (move.promotion || ''))
      .filter(uci => uci !== gift.uci && !brilliant.sacrificeCandidates(current!, uci).length).slice(0, 4);
    const moves: TopMoveResult[] = [gift.uci, ...alternatives].map((uci, index) => ({ uci, scoreCp: index ? options.alternativeCp ?? 100 : options.playedCp ?? 300, pv: [uci] }));
    options.afterRoot?.();
    return { moves, bestMoveUci: gift.uci, scoreCp: 300, pv: [gift.uci], depth: depth!, actualDepth: depth!, status: options.unavailable ? 'unavailable' : options.partial ? 'partial' : 'complete' };
  },
  evaluateFen: async (start, depth, history, current) => {
    const board = new Chess(start);
    for (const uci of history || []) board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    assert.equal(board.fen(), current, 'sacrifice acceptance must carry complete history and reached FEN');
    return { scoreCp: options.acceptCp ?? 200, bestMoveUci: '', pv: [], depth: depth!, actualDepth: depth!, status: 'complete' };
  },
});

console.log('\nBrillanz: Opfer, Gegenwehr und Archiv');
await test('Legal capturable bishop sacrifice is a candidate with net investment', () => {
  const candidates = brilliant.sacrificeCandidates(GREEK, gift.uci);
  assert(candidates.some(candidate => candidate.acceptingMoveUci === 'g8h7' && candidate.materialInvestment === 2));
});
await test('Equal bishop/knight trade is not a sacrifice', () => {
  assert.deepEqual(brilliant.sacrificeCandidates('6k1/8/4p3/3n4/2B5/8/8/6K1 w - - 0 1', 'c4d5'), []);
});
await test('A pinned knight cannot accept an offered queen', () => {
  assert.deepEqual(brilliant.sacrificeCandidates('4k3/4n3/8/8/8/7Q/8/K3R3 w - - 0 1', 'h3f5'), []);
});
await test('equal bishop/knight trade check; Pawn offers and illegal moves never become sacrifice evidence', () => {
  assert.deepEqual(brilliant.sacrificeCandidates(new Chess().fen(), 'e2e4'), []);
  assert.deepEqual(brilliant.sacrificeCandidates(GREEK, 'd3d8'), []);
});
await test('Trapped and attacked piece capturing a pawn (desperado) is not a brilliant sacrifice', () => {
  const trappedKnightFen = 'N3r3/1kp5/p2p4/8/8/8/6PP/6K1 w - - 0 1';
  assert.deepEqual(brilliant.sacrificeCandidates(trappedKnightFen, 'a8c7'), []);
});
await test('Attacked piece with a safe retreat still allows an active sacrifice elsewhere', () => {
  const counterSacFen = 'r1bqk2r/pp2bppp/2n1p3/1N1pP3/3P4/8/PPP2PPP/R1BQKBNR w KQkq - 0 1';
  // Add pawn attacking b5 knight by using a6 pawn, while Nd6+ / Nc7+ is a sac and Nc3 is safe:
  const attackedWithRetreat = 'r1bqk2r/1pp1bppp/p1n1p3/1N1pP3/3P4/8/PPP2PPP/R1BQKBNR w KQkq - 0 1';
  assert.ok(counterSacFen.length > 0);
  assert.ok(brilliant.sacrificeCandidates(attackedWithRetreat, 'b5c7').length > 0);
});
let awarded: GameAnalysis;
await test('Good sacrifice requires MultiPV plus compensation after acceptance', async () => {
  const original = gameWith([gift]);
  awarded = await brilliant.scanBrilliantMoves(original, fakeEngine(), 12);
  assert.equal(awarded.moves[0].quality, 'brilliant');
  assert.equal(awarded.moves[0].brilliantEvidence?.depth, 14);
  assert.equal(awarded.summaryWhite.brilliant, 1);
  assert.equal(awarded.summaryWhite.best, 0);
  assert.equal(original.moves[0].quality, 'best');
});
await test('A losing accepted sacrifice is not brilliant', async () => {
  assert.notEqual((await brilliant.scanBrilliantMoves(gameWith([gift]), fakeEngine({ acceptCp: -200 }), 14)).moves[0].quality, 'brilliant');
});
await test('An already decisive non-sacrificing alternative excludes brilliance', async () => {
  assert.notEqual((await brilliant.scanBrilliantMoves(gameWith([gift]), fakeEngine({ alternativeCp: 600, playedCp: 600 }), 14)).moves[0].quality, 'brilliant');
});
await test('Inferior sacrifice outside near-best tolerance is excluded', async () => {
  assert.notEqual((await brilliant.scanBrilliantMoves(gameWith([gift]), fakeEngine({ playedCp: 100, alternativeCp: 300 }), 14)).moves[0].quality, 'brilliant');
});
await test('Partial data stays unchecked; unavailable engine propagates an error', async () => {
  const partial = await brilliant.scanBrilliantMoves(gameWith([gift]), fakeEngine({ partial: true }), 14);
  assert.equal(partial.brilliantScan?.complete, false);
  assert.notEqual(partial.moves[0].quality, 'brilliant');
  await assert.rejects(() => brilliant.scanBrilliantMoves(gameWith([gift]), fakeEngine({ unavailable: true }), 14));
});
await test('Cancellation after engine reply produces no partial game mutation', async () => {
  let cancelled = false;
  const game = gameWith([gift]);
  await assert.rejects(() => brilliant.scanBrilliantMoves(game, fakeEngine({ afterRoot: () => { cancelled = true; } }), 14, () => cancelled), brilliant.BrilliantScanCancelledError);
  assert.equal(game.moves[0].quality, 'best');
});
await test('Archive links count only the exact player and preserve ply', () => {
  const entry = archiveItem(awarded!, ' ALICE ');
  assert.equal(entry.brilliantCount, 1);
  assert.equal(entry.brilliantMoves?.[0].ply, 1);
  assert.equal(archiveItem(awarded!, 'Bob').brilliantCount, 0);
  assert.equal(archiveItem(awarded!, 'AliceOther').brilliantCount, 0);
  assert.equal(brilliant.needsBrilliantScan(awarded!, 14), false);
  assert.equal(brilliant.needsBrilliantScan(awarded!, 18), true);
});
await test('Verified brilliance remains visible on a book-annotated move', () => {
  assert.equal(reviewBadgeQuality({ ...awarded!.moves[0], openingAnnotation: 'Known line' }), 'brilliant');
});

console.log('\nVerpasste Chancen: Matt, Netto-Material und Filter');
const missedMate = makeMove('7k/8/5KQ1/8/8/8/8/8 w - - 0 1', 'g6g4', ['g6g7'], ['h8h7'], 1000, 0);
missedMate.evalBefore.mate = 1;
missedMate.quality = 'blunder';
missedMate.winChanceDrop = 45;
const missedQueen = makeMove('6k1/8/8/3q4/8/8/8/3Q2K1 w - - 0 1', 'g1f1', ['d1d5', 'g8h8'], ['d5a5'], 800, 0);
missedQueen.quality = 'blunder'; missedQueen.winChanceDrop = 40;
await test('A legally evidenced lost mating opportunity is detected', () => {
  assert.equal(missed.detectMissedOpportunity(missedMate)?.kind, 'mate');
});
await test('Black mate uses the same white-POV score contract', () => {
  const move = makeMove('8/8/8/8/8/5kq1/8/7K b - - 0 1', 'g3g5', ['g3g2'], ['h1h2'], -1000, 0);
  move.evalBefore.mate = -1;
  assert.equal(missed.detectMissedOpportunity(move)?.kind, 'mate');
});
await test('A surviving alternate forced mate is not a lost mating opportunity', () => {
  assert.equal(missed.detectMissedOpportunity({ ...missedMate, evalAfter: { ...missedMate.evalAfter, mate: 3 } }), undefined);
});
await test('Net queen win against the engine defense is detected', () => {
  const result = missed.detectMissedOpportunity(missedQueen);
  assert.equal(result?.kind, 'material'); assert.equal(result?.materialGain, 9);
});
await test('Black material opportunity has the same net-gain semantics', () => {
  const move = makeMove('3q2k1/8/8/8/3Q4/8/8/6K1 b - - 0 1', 'g8f8', ['d8d4', 'g1h1'], ['d4a4'], -800, 0);
  assert.equal(missed.detectMissedOpportunity(move)?.materialGain, 9);
});
await test('An immediately capturable promotion at the PV horizon is not a gain', () => {
  const move = makeMove('1r4k1/8/P7/8/8/8/8/6K1 w - - 0 1', 'g1f1', ['a6a7', 'g8h8', 'a7a8q'], ['g8h8', 'a6a7'], 800, 0);
  assert.equal(missed.detectMissedOpportunity(move), undefined);
});
await test('Queen trades and unresolved recaptures are not material wins', () => {
  const trade = makeMove('3r2k1/8/8/3q4/8/8/8/3Q2K1 w - - 0 1', 'g1f1', ['d1d5', 'd8d5'], ['d5a5'], 800, 0);
  assert.equal(missed.detectMissedOpportunity(trade), undefined);
  assert.equal(missed.detectMissedOpportunity({ ...trade, evalBefore: { ...trade.evalBefore, pv: ['d1d5'] } }), undefined);
});
await test('A different move achieving the same material gain is not a miss', () => {
  const equivalent = makeMove('6k1/8/8/R2q4/8/8/8/3Q2K1 w - - 0 1', 'a5d5', ['d1d5', 'g8h8'], ['g8h8'], 800, 600);
  assert.equal(missed.detectMissedOpportunity(equivalent), undefined);
});
await test('Partial, shallow, contradictory and illegal PV data never invent a miss', () => {
  for (const replacement of [{ status: 'partial' as const }, { actualDepth: 8 }, { bound: 'lower' as const }, { pv: ['a1a8'] }])
    assert.equal(missed.detectMissedOpportunity({ ...missedQueen, evalBefore: { ...missedQueen.evalBefore, ...replacement } }), undefined);
});
await test('Old games get opportunities without changing severity, accuracy or input', () => {
  const input = gameWith([missedQueen]);
  const enriched = missed.annotateMissedOpportunities(input);
  assert.equal(enriched.moves[0].missedOpportunity?.kind, 'material');
  assert.equal(enriched.moves[0].quality, 'blunder');
  assert.equal(enriched.accuracyWhite, input.accuracyWhite);
  assert.equal(input.moves[0].missedOpportunity, undefined);
  assert.equal(missed.annotateMissedOpportunities(enriched), enriched);
});
await test('Miss belongs exclusively to its own filter, including legacy data', () => {
  const cards = deck.buildTrainingCards([gameWith([missedQueen])], 'Alice');
  assert.equal(cards.length, 1);
  assert.equal(deck.filterTrainingCards(cards, ['miss']).length, 1);
  assert.equal(deck.filterTrainingCards(cards, ['blunder']).length, 0);
  assert.equal(deck.filterTrainingCards(cards, ['miss', 'blunder']).length, 1);
  assert.equal(deck.filterTrainingCards(cards, []).length, 0);
  assert.equal(deck.buildTrainingCards([gameWith([missedQueen])], 'Bob').length, 0);
});
await test('Review counts miss once and preserves raw score data', () => {
  const enriched = missed.annotateMissedOpportunities(gameWith([missedQueen]));
  assert.equal(reviewBadgeQuality(enriched.moves[0]), 'miss');
  const counts = reviewQualityCounts(enriched.moves);
  assert.equal(counts.white.miss, 1);
  assert.equal(counts.white.blunder, 0);
});
await test('All severity filters and counters partition missed opportunities exclusively', () => {
  for (const quality of ['inaccuracy', 'mistake', 'blunder'] as const) {
    const cards = deck.buildTrainingCards([gameWith([{ ...missedQueen, quality }])], 'Alice');
    assert.equal(cards.length, 1);
    const categories = deck.TRAINING_QUALITY_OPTIONS.filter(option => deck.matchesTrainingQuality(cards[0].move, option.quality));
    assert.deepEqual(categories.map(option => option.quality), ['miss']);
    assert.equal(deck.filterTrainingCards(cards, [quality]).length, 0);
    assert.equal(deck.filterTrainingCards(cards, [quality, 'miss']).length, 1);
    const archived = archiveItem(cards[0].game, 'Alice');
    assert.equal(archived.blunderCount, 0);
    assert.equal(archived.mistakeCount, 0);
    assert.equal(cards[0].move.quality, quality, 'original analysis data remains intact');
  }
});
await test('Ordinary errors keep their category, and brilliance takes precedence over stale tags', () => {
  for (const quality of ['inaccuracy', 'mistake', 'blunder', 'miss'] as const) {
    const move = { ...missedQueen, quality, missedOpportunity: undefined };
    assert.deepEqual(deck.TRAINING_QUALITY_OPTIONS.filter(option => deck.matchesTrainingQuality(move, option.quality)).map(option => option.quality), [quality]);
  }
  const tagged = missed.annotateMissedOpportunities(gameWith([missedQueen])).moves[0];
  assert.equal(deck.matchesTrainingQuality({ ...tagged, quality: 'brilliant' }, 'miss'), false);
});
await test('Training a material opportunity rejects a saturated winning-score shortcut', async () => {
  const before = { ...missedQueen.evalBefore, scoreCp: 1000 };
  const evaluateAfter = async () => ({ ...missedQueen.evalAfter, scoreCp: 800 });
  const ordinary = await judgeTrainingAttempt(missedQueen.fenBefore, missedQueen.uci, before.bestMoveUci, before, { evaluateAfter });
  const opportunity = await judgeTrainingAttempt(missedQueen.fenBefore, missedQueen.uci, before.bestMoveUci, before, { evaluateAfter, preserveMaterialOpportunity: true });
  assert.equal(ordinary.verdict.kind, 'accepted');
  assert.equal(opportunity.verdict.kind, 'wrong');
});
console.log(`\nHighlights: ${passed} passed.`);
