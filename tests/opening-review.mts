/**
 * Real Stockfish smoke test for the opening label in a complete PGN analysis.
 * Run on a Windows checkout with the bundled engine:
 *   npm exec -- tsx tests/opening-review.mts
 * It uses only synthetic PGNs and never opens the user's stored games.
 */
import { createRequire } from 'node:module';
import Module from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { Chess } = require('chess.js') as typeof import('chess.js');
const { isKnownBookPosition, getBookOpening } = require('../src/utils/openingBook') as typeof import('../src/utils/openingBook');
const { analyzePgnGame } = require('../src/utils/analyzeGame') as typeof import('../src/utils/analyzeGame');
const { reviewBadgeQuality, classifyMove } = require('../src/utils/analysis') as typeof import('../src/utils/analysis');
const { ANALYSIS_VERSION, hasAlternatingPovBug, repairAlternatingPovAnalysis } = require('../src/utils/repairAlternatingPov') as typeof import('../src/utils/repairAlternatingPov');

const board = new Chess();
assert(isKnownBookPosition(board.fen()));
board.move('e4');
assert(isKnownBookPosition(board.fen()));
board.move('c6');
assert(isKnownBookPosition(board.fen()));
assert.equal(getBookOpening(board.fen())?.eco, 'B10');

// Also preserve the original audit requirement: a genuinely bad book move
// must remain visible as an engine error in the data model.
const bookBlunder = classifyMove({
  color: 'w',
  evalBefore: { scoreCp: 0, bestMoveUci: 'e2e4', pv: ['e2e4'], depth: 12, status: 'complete' },
  evalAfter: { scoreCp: -1500, bestMoveUci: 'e7e5', pv: ['e7e5'], depth: 12, status: 'complete' },
  isPlayedMoveBest: false,
  isBookMove: true,
  bookName: 'Synthetic book line',
});
assert.equal(bookBlunder.quality, 'blunder');
assert.equal(reviewBadgeQuality(bookBlunder), 'book');

// Exercise the real renderer -> preload -> IPC argument contract. This caught
// a regression where preload dropped currentFen and all black-to-move scores
// were interpreted from the wrong side's perspective.
const moduleLoader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = moduleLoader._load;
let engine: import('../electron/stockfish').StockfishEngine;
let forwardedCurrentFenCount = 0;
moduleLoader._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: { getAppPath: () => process.cwd(), getPath: () => process.cwd() },
      contextBridge: { exposeInMainWorld: () => {} },
      ipcRenderer: {
        invoke: (channel: string, ...args: unknown[]) => {
          if (channel === 'engine:evaluate-fen-multipv') {
            const [fen, depth, multiPv, history, currentFen] = args as [string, number, number, string[], string];
            const reached = new Chess(fen);
            for (const uci of history || []) reached.move({ from: uci.slice(0, 2) as import('chess.js').Square, to: uci.slice(2, 4) as import('chess.js').Square, promotion: uci[4] });
            assert.equal(currentFen, reached.fen(), 'MultiPV must preserve the same reached position and history');
            return engine.evaluateFenMultiPv(fen, depth, multiPv, history, currentFen);
          }
          if (channel !== 'engine:evaluate-fen') throw new Error(`Unexpected IPC channel: ${channel}`);
          const [fen, depth, history, currentFen] = args as [string, number, string[], string];
          const reached = new Chess(fen);
          for (const uci of history || []) {
            reached.move({ from: uci.slice(0, 2) as import('chess.js').Square, to: uci.slice(2, 4) as import('chess.js').Square, promotion: uci[4] });
          }
          assert.equal(currentFen, reached.fen(), 'preload must forward currentFen to IPC');
          forwardedCurrentFenCount++;
          return engine.evaluateFen(fen, depth, history, currentFen);
        },
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { StockfishEngine } = require('../electron/stockfish') as typeof import('../electron/stockfish');
const { electronAPI } = require('../electron/preload') as typeof import('../electron/preload');
moduleLoader._load = originalLoad;

engine = new StockfishEngine();
(globalThis as typeof globalThis & { window: unknown }).window = {
  electronAPI,
};

const pgn = '[White "White"]\n[Black "Black"]\n[Result "*"]\n\n1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Bf5 5. Ng3 Bg6 6. h4 h6 7. Nf3 Nd7 8. h5 Bh7 9. Bd3 Bxd3 10. Qxd3 e6 *';
try {
  const result = await analyzePgnGame(pgn, 10);
  const caro = result.moves[1];
  assert.equal(caro.san, 'c6');
  assert.match(caro.openingAnnotation || '', /B10.*Caro-Kann/);
  assert.equal(reviewBadgeQuality(caro), 'book');
  // Search ordering at depth 10 varies across Stockfish versions/CPU targets.
  // The book marker is invariant; engine-best and nearly optimal are both valid.
  assert(['best', 'excellent', 'good'].includes(caro.quality));
  assert(caro.winChanceDrop < 7, 'A solid book response must not have a large loss in this reference game');
  assert.equal(caro.evalAfter.status, 'complete');
  assert.ok(caro.evalAfter.actualDepth && caro.evalAfter.actualDepth > 0);
  assert.equal(forwardedCurrentFenCount, result.moves.length + 1);
  assert(result.moves.slice(0, 12).every(move => move.evalAfter.scoreCp > 0), 'Caro-Kann scores must remain white-POV through the IPC bridge');
  assert.equal(result.summaryWhite.blunder + result.summaryBlack.blunder, 0);
  const live = await electronAPI.engine.evaluateFenMultiPv(result.moves[0].fenBefore, 10, 3, result.moves.slice(0, 2).map(move => move.uci), caro.fenAfter);
  assert.equal(live.status, 'complete');
  assert.equal(live.moves.length, 3);
  assert.equal(live.bestMoveUci, live.moves[0].uci);
  const { reviewBestArrow, legalReviewTopMoves, principalVariationSan } = require('../src/utils/reviewPresentation') as typeof import('../src/utils/reviewPresentation');
  const liveView = { ...live, gameId: result.id, fen: caro.fenAfter, requestedDepth: 10 };
  const liveArrow = reviewBestArrow(caro.fenAfter, caro.evalAfter, liveView);
  assert(liveArrow);
  assert.equal(liveArrow.from + liveArrow.to, live.moves[0].uci.slice(0, 4));
  assert.equal(legalReviewTopMoves(caro.fenAfter, liveView).length, 3);
  assert(principalVariationSan(caro.fenAfter, live.moves[0].pv).length > 1);
  const invertedMoves = result.moves.map(move => ({
    ...move,
    evalAfter: { ...move.evalAfter, scoreCp: move.ply % 2 === 1 ? -move.evalAfter.scoreCp : move.evalAfter.scoreCp },
  }));
  const corrupted = {
    ...result,
    analysisVersion: undefined,
    moves: invertedMoves.map((move, index) => ({ ...move, evalBefore: index ? invertedMoves[index - 1].evalAfter : move.evalBefore })),
  };
  assert.equal(hasAlternatingPovBug(result), false);
  assert.equal(hasAlternatingPovBug(corrupted), true);
  const repaired = repairAlternatingPovAnalysis(corrupted);
  assert(repaired);
  assert.equal(repaired.analysisVersion, ANALYSIS_VERSION);
  assert.deepEqual(repaired.moves.map(move => move.evalAfter.scoreCp), result.moves.map(move => move.evalAfter.scoreCp));
  assert.equal(repaired.summaryWhite.blunder + repaired.summaryBlack.blunder, 0);
  assert.equal(repairAlternatingPovAnalysis(repaired), null);

  // Vite emits image URLs; Node's renderer smoke test needs the same contract.
  require.extensions['.png'] = (assetModule, filename) => { assetModule.exports = filename; };
  const { ReviewPanel } = require('../src/components/ReviewPanel') as typeof import('../src/components/ReviewPanel');
  const React = require('react') as typeof import('react');
  const { renderToStaticMarkup } = require('react-dom/server') as typeof import('react-dom/server');
  const markup = renderToStaticMarkup(React.createElement(ReviewPanel, {
    game: result,
    targetPlayer: 'Black',
    currentPly: 2,
    onSelectPly: () => {},
    onFlipBoard: () => {},
    onStartTraining: () => {},
    isPlaying: false,
    onTogglePlay: () => {},
    onReanalyze: () => {},
  }));
  assert.match(markup, /class="quality-glyph quality-glyph-book"[^>]*><img/);
  assert.match(markup, /Buch/);
  assert.match(markup, /Buchzug \(B10 – Caro-Kann Defense\)/);
  const activeMarkup = markup.slice(markup.indexOf('class="review-current-move"'), markup.indexOf('class="review-move-list"'));
  assert.doesNotMatch(activeMarkup, /data-quality="inaccuracy"/);
  const severeMarkup = renderToStaticMarkup(React.createElement(ReviewPanel, {
    game: {
      ...result,
      moves: result.moves.map(move => move.ply === caro.ply
        ? { ...move, quality: 'blunder' as const, comment: 'Synthetic severe mistake' }
        : move),
    },
    targetPlayer: 'Black',
    currentPly: 2,
    onSelectPly: () => {},
    onFlipBoard: () => {},
    onStartTraining: () => {},
    isPlaying: false,
    onTogglePlay: () => {},
    onReanalyze: () => {},
  }));
  assert.match(severeMarkup, /Buch/);
  assert.match(severeMarkup, /Patzer/);
  assert.match(severeMarkup, /Synthetic severe mistake/);
  console.log(JSON.stringify({
    opening: result.openingName,
    c6: { quality: caro.quality, annotation: caro.openingAnnotation, badge: reviewBadgeQuality(caro), scoreCpWhite: caro.evalAfter.scoreCp },
    trace: result.moves.map(move => ({ ply: move.ply, san: move.san, cp: move.evalAfter.scoreCp, mate: move.evalAfter.mate, quality: move.quality, depth: move.evalAfter.actualDepth, status: move.evalAfter.status })),
    checks: 'book data, engine analysis, white POV, review badge, severe book exception, live MultiPV and board arrow consistency',
  }, null, 2));
} finally {
  engine.dispose();
}
