import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { EngineEvalResult, GameAnalysis, MoveAnalysis } from '../src/types/chess';

const require = createRequire(import.meta.url);
const { Chess } = require('chess.js') as typeof import('chess.js');
const {
  buildTrainingCards,
  describeTrainingCard,
  filterTrainingCardsByOptions,
  loadIgnoredTrainingCards,
  loadTrainingPrefs,
  saveIgnoredTrainingCards,
  saveTrainingPrefs,
  selectSessionCards,
} = require('../src/utils/trainingDeck') as typeof import('../src/utils/trainingDeck');
const {
  MAX_TRAINING_JUDGE_DEPTH,
  MATERIAL_CP_TOLERANCE,
  SOLID_WIN_CHANCE_MAX_PCT,
  judgeTargetDepth,
  judgeTrainingAttempt,
} = require('../src/utils/trainingJudge') as typeof import('../src/utils/trainingJudge');
const { mergeLearningStorage } = require('../src/utils/lanSyncMerge') as typeof import('../src/utils/lanSyncMerge');

let passed = 0;
async function check(name: string, fn: () => unknown | Promise<unknown>) {
  await fn();
  passed += 1;
  console.log(`  OK ${name}`);
}

const ZERO_SUMMARY = {
  brilliant: 0,
  great: 0,
  best: 0,
  excellent: 0,
  good: 0,
  book: 0,
  inaccuracy: 0,
  mistake: 0,
  blunder: 0,
  miss: 0,
};

function makeMove(
  fenBefore: string,
  playedUci: string,
  evalBefore: Partial<EngineEvalResult>,
  evalAfter: Partial<EngineEvalResult>,
  overrides: Partial<MoveAnalysis> = {},
): MoveAnalysis {
  const board = new Chess(fenBefore);
  const move = board.move({
    from: playedUci.slice(0, 2),
    to: playedUci.slice(2, 4),
    promotion: (playedUci[4] || undefined) as never,
  });
  const baseEvalBefore: EngineEvalResult = {
    scoreCp: 0,
    bestMoveUci: '',
    pv: [],
    depth: 14,
    actualDepth: 14,
    status: 'complete',
    bound: 'exact',
    ...evalBefore,
  };
  const baseEvalAfter: EngineEvalResult = {
    scoreCp: 0,
    bestMoveUci: '',
    pv: [],
    depth: 14,
    actualDepth: 14,
    status: 'complete',
    bound: 'exact',
    ...evalAfter,
  };
  return {
    ply: 1,
    moveNumber: Number(fenBefore.split(' ')[5]) || 1,
    color: move.color,
    san: move.san,
    uci: playedUci,
    from: move.from,
    to: move.to,
    piece: move.piece,
    captured: move.captured,
    isCheck: move.san.includes('+'),
    isCheckmate: move.san.includes('#'),
    fenBefore,
    fenAfter: board.fen(),
    evalBefore: baseEvalBefore,
    evalAfter: baseEvalAfter,
    winChanceBefore: 50,
    winChanceAfter: 20,
    winChanceDrop: 30,
    quality: 'blunder',
    ...overrides,
  };
}

function wrapGame(id: string, moves: MoveAnalysis[]): GameAnalysis {
  return {
    id,
    createdAt: '2026-11-20T12:00:00Z',
    white: 'Alice',
    black: 'Bob',
    result: '*',
    pgn: '*',
    accuracyWhite: 60,
    accuracyBlack: 60,
    summaryWhite: { ...ZERO_SUMMARY },
    summaryBlack: { ...ZERO_SUMMARY },
    moves,
    analysisVersion: 2,
  };
}

console.log('\nFehlerkarten-Upgrade: Briefing, Klarheitsfilter, Fairness & Sync');

// 1. Mate briefing + non-spoiler hint
await check('describeTrainingCard detects mate mission and keeps conceptHint spoiler-free', () => {
  const mateFen = '7k/8/5KQ1/8/8/8/8/8 w - - 0 1';
  const prevBoard = new Chess('7k/8/5K2/6Q1/8/8/8/8 b - - 0 1'); // placeholder previous move not needed
  void prevBoard;
  const move = makeMove(
    mateFen,
    'g6g4',
    { scoreCp: 10000, mate: 1, bestMoveUci: 'g6g7', pv: ['g6g7'] },
    { scoreCp: 0, bestMoveUci: 'h8h7', pv: ['h8h7'] },
    { moveNumber: 42 },
  );
  const cards = buildTrainingCards([wrapGame('g_mate', [move])], 'Alice');
  assert.equal(cards.length, 1);
  const b = describeTrainingCard(cards[0]);
  assert.equal(b.mission, 'mate');
  assert.equal(b.missionBadge, 'Mattchance');
  assert.equal(b.phase, 'endgame');
  assert.equal(b.isClear, true);
  assert.equal(b.priorityTier, 1);
  assert.ok(b.prompt.includes('Matt in 1'));
  assert.ok(!b.conceptHint.includes('g6') && !b.conceptHint.includes('g7') && !b.conceptHint.includes('Qg7'));
  assert.ok(b.postMoveSummary && b.postMoveSummary.length > 0);
});

// 2. Material tactic briefing
await check('describeTrainingCard detects material tactic and priorityTier 1', () => {
  const queenFen = '6k1/8/8/3q4/8/8/8/3Q2K1 w - - 0 1';
  const move = makeMove(
    queenFen,
    'g1f1',
    { scoreCp: 900, bestMoveUci: 'd1d5', pv: ['d1d5', 'g8h8'] },
    { scoreCp: 0, bestMoveUci: 'd5a5', pv: ['d5a5'] },
    { moveNumber: 28, winChanceBefore: 96, winChanceAfter: 50, winChanceDrop: 46 },
  );
  const cards = buildTrainingCards([wrapGame('g_tac', [move])], 'Alice');
  const b = describeTrainingCard(cards[0]);
  assert.equal(b.mission, 'tactic');
  assert.equal(b.missionBadge, 'Materialgewinn');
  assert.equal(b.phase, 'endgame');
  assert.equal(b.isClear, true);
  assert.equal(b.priorityTier, 1);
  assert.deepEqual(b.bestLineUci, ['d1d5', 'g8h8']);
  assert.ok(!b.conceptHint.includes('d1') && !b.conceptHint.includes('d5') && !b.conceptHint.includes('Qxd5'));
});

// 3. Defense briefing (opponent threatens mate or material loss after played blunder)
await check('describeTrainingCard detects defense mission when played move allows mate/material loss', () => {
  // Position where playing Kh2 -> Rh1 allowed mate or hung a rook; use Fool's-mate defense
  const defFen = 'rnbqkbnr/pppp1ppp/8/4p3/6P1/8/PPPPPP1P/RNBQKBNR w KQkq - 0 2';
  const move = makeMove(
    defFen,
    'f2f3',
    { scoreCp: -100, bestMoveUci: 'h2h3', pv: ['h2h3', 'd7d5'] },
    { scoreCp: -10000, mate: -1, bestMoveUci: 'd8h4', pv: ['d8h4'] },
    { moveNumber: 2, winChanceBefore: 40, winChanceAfter: 0.1, winChanceDrop: 39.9 },
  );
  const cards = buildTrainingCards([wrapGame('g_def', [move])], 'Alice');
  const b = describeTrainingCard(cards[0]);
  assert.equal(b.mission, 'defense');
  assert.equal(b.missionBadge, 'Abwehr');
  assert.equal(b.phase, 'opening');
  assert.equal(b.prompt, 'Mattdrohung abwehren');
  assert.equal(b.isClear, true);
  assert.equal(b.priorityTier, 2);
  assert.deepEqual(b.playedRefutationUci, ['f2f3', 'd8h4']);
});

// 4. Lost/decided noisy positions filtered out in clear mode, visible in all mode
await check('isClear excludes already-lost (-6) and already-won (+8) non-opportunity positions in clear mode', () => {
  const board = new Chess();
  board.move('e4');
  const lostMove = makeMove(
    board.fen(),
    'g8f6',
    { scoreCp: -650, bestMoveUci: 'e7e5', pv: ['e7e5'] },
    { scoreCp: -900, bestMoveUci: 'd2d4', pv: ['d2d4'] },
    { ply: 2, moveNumber: 1, quality: 'mistake', winChanceBefore: 8, winChanceAfter: 3, winChanceDrop: 5 },
  );
  const wonMove = makeMove(
    '6k1/8/8/8/8/8/QQ6/6K1 w - - 0 30',
    'b2b3',
    { scoreCp: 1400, bestMoveUci: 'a2a3', pv: ['a2a3'] },
    { scoreCp: 900, bestMoveUci: 'g8f8', pv: ['g8f8'] },
    { moveNumber: 30, quality: 'mistake', winChanceBefore: 99, winChanceAfter: 96, winChanceDrop: 3 },
  );
  const aliceLost = { ...lostMove, fenBefore: new Chess().fen(), color: 'w' as const, uci: 'f2f3', san: 'f3', from: 'f2', to: 'f3' };
  const lostAfter = new Chess(); lostAfter.move('f3'); aliceLost.fenAfter = lostAfter.fen();
  aliceLost.evalBefore = { scoreCp: -650, bestMoveUci: 'e2e4', pv: ['e2e4'], depth: 14, actualDepth: 14, status: 'complete', bound: 'exact' };
  aliceLost.evalAfter = { scoreCp: -900, bestMoveUci: 'e7e5', pv: ['e7e5'], depth: 14, actualDepth: 14, status: 'complete', bound: 'exact' };

  const cards = buildTrainingCards([wrapGame('g_noise', [aliceLost, wonMove])], 'Alice');
  assert.equal(cards.length, 2);
  assert.equal(
    filterTrainingCardsByOptions(cards, { qualities: ['mistake', 'blunder', 'miss'], focusMode: 'clear' }).length,
    0,
  );
  assert.equal(
    filterTrainingCardsByOptions(cards, { qualities: ['mistake', 'blunder', 'miss'], focusMode: 'all' }).length,
    2,
  );
  // Ignored keys filter
  assert.equal(
    filterTrainingCardsByOptions(cards, {
      qualities: ['mistake', 'blunder', 'miss'],
      focusMode: 'all',
      ignoredKeys: new Set([cards[0].key]),
    }).length,
    1,
  );
});

// 5. Session selection prioritizes due cards first, then tier 1 -> tier 2 -> tier 3
await check('selectSessionCards puts due cards first, then tier 1 before tier 2 before tier 3', () => {
  const fenQuiet = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const tier3Move = makeMove(
    fenQuiet,
    'h2h3',
    { scoreCp: 25, bestMoveUci: 'e2e4', pv: ['e2e4', 'e7e5'] },
    { scoreCp: -25, bestMoveUci: 'e7e5', pv: ['e7e5'] },
    { ply: 1, moveNumber: 1, quality: 'inaccuracy', winChanceBefore: 53, winChanceAfter: 46, winChanceDrop: 7 },
  );
  const tier2Move = makeMove(
    'rnbqkbnr/pppp1ppp/8/4p3/6P1/8/PPPPPP1P/RNBQKBNR w KQkq - 0 2',
    'f2f3',
    { scoreCp: -100, bestMoveUci: 'h2h3', pv: ['h2h3'] },
    { scoreCp: -10000, mate: -1, bestMoveUci: 'd8h4', pv: ['d8h4'] },
    { ply: 3, moveNumber: 2, quality: 'blunder' },
  );
  const tier1Move = makeMove(
    '7k/8/5KQ1/8/8/8/8/8 w - - 0 42',
    'g6g4',
    { scoreCp: 10000, mate: 1, bestMoveUci: 'g6g7', pv: ['g6g7'] },
    { scoreCp: 0, bestMoveUci: 'h8h7', pv: ['h8h7'] },
    { ply: 5, moveNumber: 42, quality: 'blunder' },
  );
  const dueMove = makeMove(
    fenQuiet,
    'a2a3',
    { scoreCp: 20, bestMoveUci: 'd2d4', pv: ['d2d4'] },
    { scoreCp: -15, bestMoveUci: 'd7d5', pv: ['d7d5'] },
    { ply: 7, moveNumber: 3, quality: 'inaccuracy', winChanceBefore: 52, winChanceAfter: 46, winChanceDrop: 6 },
  );

  const cards = buildTrainingCards([wrapGame('g_order', [tier3Move, tier2Move, tier1Move, dueMove])], 'Alice');
  const now = 1_700_000_000_000;
  const ordered = selectSessionCards(
    cards,
    { [cards[3].key]: { dueAt: now - 5000 } },
    { maxCards: 10, nowMs: now },
  );
  assert.deepEqual(
    ordered.map(c => c.move.ply),
    [7, 5, 3, 1],
  );
});

// 6. TrainingJudge capped depth, relaxed clear-winning material tolerance, and refutation PV
await check('judgeTrainingAttempt caps depth at 14, allows +5->+4.3 on material opp, and returns refutationSan', async () => {
  assert.equal(MAX_TRAINING_JUDGE_DEPTH, 14);
  assert.equal(MATERIAL_CP_TOLERANCE, 85);

  const deepBefore: EngineEvalResult = {
    scoreCp: 500,
    bestMoveUci: 'd1d5',
    pv: ['d1d5'],
    depth: 18,
    actualDepth: 18,
    status: 'complete',
    bound: 'exact',
  };
  assert.equal(judgeTargetDepth(deepBefore), 14);

  const queenFen = '6k1/8/8/3q4/8/8/8/3Q2K1 w - - 0 1';
  const acceptedDeep = await judgeTrainingAttempt(queenFen, 'd1e2', 'd1d5', deepBefore, {
    preserveMaterialOpportunity: true,
    evaluateAfter: async () => ({
      scoreCp: 430,
      bestMoveUci: 'd5e5',
      pv: ['d5e5', 'e2e5'],
      depth: 14,
      actualDepth: 14,
      status: 'complete',
      bound: 'exact',
    }),
  });
  assert.equal(acceptedDeep.verdict.kind, 'accepted');

  // Shallow actualDepth 12 against baseline depth 14 must still return uncertain (BUG-01 contract)
  const shallowUncertain = await judgeTrainingAttempt(queenFen, 'd1e2', 'd1d5', { ...deepBefore, actualDepth: 14, depth: 14 }, {
    evaluateAfter: async () => ({
      scoreCp: 430,
      bestMoveUci: 'd5e5',
      pv: ['d5e5'],
      depth: 12,
      actualDepth: 12,
      status: 'complete',
      bound: 'exact',
    }),
  });
  assert.equal(shallowUncertain.verdict.kind, 'uncertain');

  // Wrong attempt carries refutationSan and refutationPv
  const wrongWithRefutation = await judgeTrainingAttempt(queenFen, 'g1f1', 'd1d5', deepBefore, {
    preserveMaterialOpportunity: true,
    evaluateAfter: async () => ({
      scoreCp: 0,
      bestMoveUci: 'd5a5',
      pv: ['d5a5', 'd1d4'],
      depth: 14,
      actualDepth: 14,
      status: 'complete',
      bound: 'exact',
    }),
  });
  assert.equal(wrongWithRefutation.verdict.kind, 'wrong');
  assert.equal(wrongWithRefutation.refutationSan, 'Qa5');
  assert.deepEqual(wrongWithRefutation.refutationPv, ['d5a5', 'd1d4']);
  assert.ok(wrongWithRefutation.verdict.reason.includes('Qa5'));

  // Option A: solid move with 5-7% win chance drop returns 'solid' when no material opp
  assert.equal(SOLID_WIN_CHANCE_MAX_PCT, 7.0);
  const openPos = new Chess().fen();
  const equalBefore: EngineEvalResult = {
    scoreCp: 100,
    bestMoveUci: 'e2e4',
    pv: ['e2e4'],
    depth: 14,
    actualDepth: 14,
    status: 'complete',
    bound: 'exact',
  };
  const solidMove = await judgeTrainingAttempt(openPos, 'd2d4', 'e2e4', equalBefore, {
    evaluateAfter: async () => ({
      scoreCp: 35,
      bestMoveUci: 'd7d5',
      pv: ['d7d5'],
      depth: 14,
      actualDepth: 14,
      status: 'complete',
      bound: 'exact',
    }),
  });
  assert.equal(solidMove.verdict.kind, 'solid');

  // Same 5-7% drop still counts as 'wrong' if preserveMaterialOpportunity=true
  const strictMaterialMove = await judgeTrainingAttempt(openPos, 'd2d4', 'e2e4', equalBefore, {
    preserveMaterialOpportunity: true,
    evaluateAfter: async () => ({
      scoreCp: 35,
      bestMoveUci: 'd7d5',
      pv: ['d7d5'],
      depth: 14,
      actualDepth: 14,
      status: 'complete',
      bound: 'exact',
    }),
  });
  assert.equal(strictMaterialMove.verdict.kind, 'wrong');

  // Losing forced mate also populates refutationPv & refutationSan
  const mateFen = '7k/8/5KQ1/8/8/8/8/8 w - - 0 1';
  const mateBefore: EngineEvalResult = {
    scoreCp: 10000,
    mate: 2,
    bestMoveUci: 'g6g7',
    pv: ['g6g7'],
    depth: 14,
    actualDepth: 14,
    status: 'complete',
    bound: 'exact',
  };
  const missedForcedMate = await judgeTrainingAttempt(mateFen, 'g6h5', 'g6g7', mateBefore, {
    evaluateAfter: async () => ({
      scoreCp: 120,
      bestMoveUci: 'h8g8',
      pv: ['h8g8', 'h5d5'],
      depth: 14,
      actualDepth: 14,
      status: 'complete',
      bound: 'exact',
    }),
  });
  assert.equal(missedForcedMate.verdict.kind, 'wrong');
  assert.equal(missedForcedMate.refutationSan, 'Kg8');
  assert.deepEqual(missedForcedMate.refutationPv, ['h8g8', 'h5d5']);

  // Mobile minReliableDepth: 12 accepts complete depth-12 result against depth-14 baseline,
  // while still rejecting partial status and actualDepth < 12 as uncertain.
  const mobileAccepted = await judgeTrainingAttempt(queenFen, 'd1e2', 'd1d5', deepBefore, {
    minReliableDepth: 12,
    evaluateAfter: async () => ({
      scoreCp: 480,
      bestMoveUci: 'd5e5',
      pv: ['d5e5'],
      depth: 14,
      actualDepth: 12,
      status: 'complete',
      bound: 'exact',
    }),
  });
  assert.equal(mobileAccepted.verdict.kind, 'accepted');

  const mobilePartialRejected = await judgeTrainingAttempt(queenFen, 'd1e2', 'd1d5', deepBefore, {
    minReliableDepth: 12,
    evaluateAfter: async () => ({
      scoreCp: 480,
      bestMoveUci: 'd5e5',
      pv: ['d5e5'],
      depth: 12,
      actualDepth: 12,
      status: 'partial',
      bound: 'exact',
    }),
  });
  assert.equal(mobilePartialRejected.verdict.kind, 'uncertain');

  const mobileSub12Rejected = await judgeTrainingAttempt(queenFen, 'd1e2', 'd1d5', deepBefore, {
    minReliableDepth: 12,
    evaluateAfter: async () => ({
      scoreCp: 480,
      bestMoveUci: 'd5e5',
      pv: ['d5e5'],
      depth: 12,
      actualDepth: 8,
      status: 'complete',
      bound: 'exact',
    }),
  });
  assert.equal(mobileSub12Rejected.verdict.kind, 'uncertain');
});

// 7. Prefs & ignored cards storage + LAN merge
await check('Prefs and ignored cards persist and ignored keys union across LAN sync merge', () => {
  const mem = new Map<string, string>();
  const savedLs = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      get length() { return mem.size; },
      key: (i: number) => [...mem.keys()][i] ?? null,
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => mem.set(k, v),
      removeItem: (k: string) => mem.delete(k),
    },
  });
  try {
    saveTrainingPrefs('Alice', { focusMode: 'all', phase: 'endgame', mission: 'defense', autoAdvance: true });
    assert.deepEqual(loadTrainingPrefs('Alice'), {
      focusMode: 'all',
      phase: 'endgame',
      mission: 'defense',
      autoAdvance: true,
    });
    saveIgnoredTrainingCards('Alice', ['g1:3', 'g2:7', 'g1:3']);
    assert.deepEqual(loadIgnoredTrainingCards('Alice'), ['g1:3', 'g2:7']);

    const merged = mergeLearningStorage(
      { 'personal-chess-analyzer-training-ignored-v1:alice': '["g1:3"]' },
      { 'personal-chess-analyzer-training-ignored-v1:oldalice': '["g2:7"]' },
      { targetNamespace: 'alice', aliasNamespaces: ['oldalice'] },
    );
    const list = JSON.parse(merged.learningStorage['personal-chess-analyzer-training-ignored-v1:alice']) as string[];
    assert.deepEqual(list.sort(), ['g1:3', 'g2:7']);
  } finally {
    if (savedLs) Object.defineProperty(globalThis, 'localStorage', savedLs);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

console.log(`\nTraining deck upgrade: ${passed} passed.\n`);
