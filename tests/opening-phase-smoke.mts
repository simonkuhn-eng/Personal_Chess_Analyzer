/** Focused checks for opening-only diagnosis and the actual response preparation. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Chess } from 'chess.js';
const require = createRequire(import.meta.url);
const { fixtureGame, CARO_POLISH, POLISH, caroPolishFocus } = require('./opening-phase-fixtures');
const { buildOpeningPhaseStats, openingFocusForGame } = require('../src/utils/openingPhase');
const { buildTrainingCards } = require('../src/utils/trainingDeck');
const { prepareOpeningResponse } = require('../src/utils/openingResponses');
const { getOpeningRepertoire, loadRepertoireFavorites, loadResponseRepertoires, openingOwnMoveCount, playOpeningMove, responsePackage, saveRepertoireFavorites, saveResponseRepertoire } = require('../src/utils/openingTraining');

const memory = new Map<string, string>();
Object.assign(globalThis, { localStorage: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) } });
const late = fixtureGame('late-only', POLISH, 'b', { 13: 'blunder', 15: 'mistake' });
const early = fixtureGame('early', POLISH, 'b', { 11: 'inaccuracy', 13: 'blunder' });
assert.equal(late.moves.length, 32);
const lateRow = buildOpeningPhaseStats([late], 'Alice')[0];
assert.equal(lateRow.errors, 0, 'Middle-game errors never weaken opening statistics');
assert.equal(lateRow.avgAccuracy, 100);
assert.equal(lateRow.decisions, 12);
const row = buildOpeningPhaseStats([early, late], 'Alice')[0];
assert.equal(row.games, 2);
assert.equal(row.gamesWithErrors, 1);
assert.equal(row.errors, 1);
assert.equal(row.inaccuracies, 1);
assert.equal(row.examples[0].moveNumber, 11);
assert.equal(buildOpeningPhaseStats([early], 'Alice', 10)[0].errors, 0);
assert.equal(buildOpeningPhaseStats([early], 'Alice', 15)[0].errors, 2);
assert.equal(buildOpeningPhaseStats([early, { ...early, id: 'partial', analysisPartial: true }, { ...early, id: 'foreign', black: 'SomeoneElse' }], 'Alice')[0].games, 1);
const white = fixtureGame('white', POLISH, 'w', { 11: 'mistake' });
assert.equal(buildOpeningPhaseStats([white, early], 'Alice').length, 2, 'White and black results remain separate');
const forced = { ...early, moves: early.moves.map(move => move.moveNumber === 11 && move.color === 'b' ? { ...move, isForced: true } : move) };
assert.equal(buildOpeningPhaseStats([forced], 'Alice')[0].errors, 0);
const missed = { ...early, moves: early.moves.map(move => move.moveNumber === 11 && move.color === 'b' ? { ...move, quality: 'blunder', missedOpportunity: { version: 1, kind: 'material', bestMoveUci: move.evalBefore.bestMoveUci, bestSan: 'test', bestLine: move.evalBefore.pv, materialGain: 5, description: 'fixture', depth: 14 } } : move) };
const missedRow = buildOpeningPhaseStats([missed], 'Alice')[0];
assert.equal(missedRow.errors, 1);
assert.equal(missedRow.misses, 1);
assert.equal(missedRow.blunders, 0, 'A missed chance never counts twice');
const focus = openingFocusForGame(early, 'b')!;
const cards = buildTrainingCards([early, late, white, { ...early, id: 'partial', analysisPartial: true }], 'Alice', { openingFocus: focus, openingWindowMoves: 12 });
assert.deepEqual(cards.map(card => [card.game.id, card.move.moveNumber]), [['early', 11]]);
assert.equal(buildTrainingCards([forced], 'Alice', { openingFocus: focus }).length, 0);
assert.equal(buildTrainingCards([{ ...early, openingName: 'Incorrect PGN label' }], 'Alice', { openingFocus: focus }).length, 1);
assert.notEqual(openingFocusForGame(fixtureGame('caro', CARO_POLISH), 'b')!.id, focus.id, 'Polish 1.b4 is distinct from Caro-Kann 1.e4 c6 2.b4');
const transposed = ['e2e4 c7c6 d2d4 d7d5', 'd2d4 d7d5 e2e4 c7c6'].map((line, index) => {
  const game = fixtureGame('transposition-' + index, line.split(' '));
  return openingFocusForGame({ ...game, moves: game.moves.slice(0, 4) }, 'b')!;
});
assert.equal(transposed[0].id, transposed[1].id, 'Transpositions merge by actual position');
const mini = fixtureGame('mini', CARO_POLISH), position = new Chess(mini.moves[2].fenAfter);
assert.equal(buildOpeningPhaseStats([{ ...mini, moves: mini.moves.slice(3).map((move, i) => i ? move : { ...move, fenBefore: position.fen() }) }], 'Alice').length, 0, 'Custom starting positions do not count as opening data');

// Constructor rejects conflicting own responses even after a transposition.
const start = { ...caroPolishFocus(), id: 'test-root', anchorFen: new Chess().fen(), prefixUci: [] };
const consistent = responsePackage(start, [
  { name: 'first', moves: 'e2e4 e7e5 g1f3 b8c6 f1b5'.split(' ') },
  { name: 'conflict', moves: 'e2e4 c7c5 g1f3'.split(' ') },
], 'catalog');
assert.equal(consistent.branches.length, 1, 'A black repertoire does not demand different replies to the same e4 position');
saveResponseRepertoire('Alice', consistent);
saveRepertoireFavorites('Alice', [consistent.id]);
assert.equal(getOpeningRepertoire(consistent.id, 'Alice')?.branches.length, 1);
assert.deepEqual(loadRepertoireFavorites('Alice'), [consistent.id]);
assert.equal(loadResponseRepertoires('Bob').length, 0);
const longPath = Array.from({ length: 16 }, () => ['g1f3', 'g8f6', 'f3g1', 'f6g8']).flat();
const deep = responsePackage({ ...start, id: 'deep-limit' }, [{ name: 'storage-limit', moves: longPath }], 'engine');
saveResponseRepertoire('DeepFixture', deep);
assert.equal(getOpeningRepertoire(deep.id, 'DeepFixture')?.branches[0].moves.length, 64, 'Deep opening anchors retain room for further replies');
assert.throws(() => responsePackage(start, [{ name: 'too-long', moves: [...longPath, 'g1f3'] }], 'engine'), /konsistenten/);
await assert.rejects(prepareOpeningResponse(caroPolishFocus(), 'Bob', undefined, 12, () => true), /abgebrochen/);
console.log('Opening phase smoke: late errors excluded, window, own color, exclusive categories, reliability, focused cards, transpositions and package persistence passed.');

if (process.argv.includes('--engine')) {
  const require = createRequire(import.meta.url), Module = (await import('node:module')).default as any;
  const original = Module._load;
  Module._load = function(request: string, parent: unknown, main: boolean) { if (request === 'electron') return { app: { getAppPath: () => process.cwd(), getPath: () => process.cwd() } }; return original.call(this, request, parent, main); };
  const { StockfishEngine } = require('../electron/stockfish');
  Module._load = original;
  const engine = new StockfishEngine();
  let searches = 0;
  const bridge = { evaluateFenMultiPv: async (start: string, depth: number, count: number, moves: string[], fen: string) => {
    const replay = new Chess(start); moves.forEach(uci => playOpeningMove(replay, uci));
    assert.equal(replay.fen(), fen, 'Every engine request retains complete repetition history');
    searches++;
    return engine.evaluateFenMultiPv(start, depth, count, moves, fen);
  } };
  try {
    const response = await prepareOpeningResponse(caroPolishFocus(), 'EngineFixture', bridge, 12);
    assert.equal(response.source, 'engine', 'Sparse Polish naming prefix gets complete engine continuations');
    assert.equal(response.color, 'b');
    assert.ok(response.branches.length >= 2, 'Opponent varies between multiple good replies');
    for (const branch of response.branches) {
      assert.deepEqual(branch.moves.slice(0, 5), CARO_POLISH);
      assert.ok(openingOwnMoveCount(branch.moves, 'b') >= 5);
      const board = new Chess(); branch.moves.forEach(uci => playOpeningMove(board, uci));
    }
    saveResponseRepertoire('EngineFixture', response);
    assert.equal(getOpeningRepertoire(response.id, 'EngineFixture')?.branches.length, response.branches.length);
    const previousSearches = searches;
    assert.equal((await prepareOpeningResponse(caroPolishFocus(), 'EngineFixture', bridge, 12)).id, response.id);
    assert.equal(searches, previousSearches, 'Reuse prepared package without extra engine work');
    console.log(`Stockfish: ${response.branches.length} legal black Caro-Kann/Polish lines, ${searches} full-history searches, saved package reused.`);
  } finally { engine.dispose(); }
}
