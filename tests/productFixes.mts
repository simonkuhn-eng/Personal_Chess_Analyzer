import { createRequire } from 'node:module';
import Module from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import type { GameAnalysis, MoveAnalysis } from '../src/types/chess';
const require = createRequire(import.meta.url);
const { Chess } = require('chess.js') as typeof import('chess.js');
const { judgeTrainingAttempt } = require('../src/utils/trainingJudge') as typeof import('../src/utils/trainingJudge');
const insights = require('../src/utils/moveInsights') as typeof import('../src/utils/moveInsights');
const profile = require('../src/utils/profile') as typeof import('../src/utils/profile');
const reviews = require('../src/utils/reviews') as typeof import('../src/utils/reviews');
const deck = require('../src/utils/trainingDeck') as typeof import('../src/utils/trainingDeck');
const storage = require('../src/utils/learningStorage') as typeof import('../src/utils/learningStorage');
const { APP_SETTINGS_DEFAULTS } = require('../src/types/chess') as typeof import('../src/types/chess');
const { parsePgnMetadata, extractMovesFromPgn } = require('../src/utils/pgn') as typeof import('../src/utils/pgn');
const { parsePlayedAt, migrateGameTime } = require('../src/utils/gameTime') as typeof import('../src/utils/gameTime');
const { variationPosition, appendVariation } = require('../src/utils/reviewVariation') as typeof import('../src/utils/reviewVariation');
const { isReliableGame } = require('../src/utils/evaluationReliability') as typeof import('../src/utils/evaluationReliability');
const { encodeDataBundle, decodeDataBundle } = require('../electron/dataBundle') as typeof import('../electron/dataBundle');
let count = 0;
function check(name: string, value: unknown) { assert.ok(value, name); count++; console.log(`  OK ${name}`); }
const initial = new Chess().fen();
const before = { scoreCp: 0, bestMoveUci: 'e2e4', pv: ['e2e4'], depth: 14, actualDepth: 14, status: 'complete' as const };
check('BUG-01: unavailable exact best is uncertain', (await judgeTrainingAttempt(initial, 'e2e4', 'e2e4', { ...before, status: 'unavailable', actualDepth: 0 })).verdict.kind === 'uncertain');
for (const patch of [{ status: 'partial' as const }, { bound: 'lower' as const }, { actualDepth: 1 }]) {
  check('BUG-01: unreliable exact best is uncertain', (await judgeTrainingAttempt(initial, 'e2e4', 'e2e4', { ...before, ...patch })).verdict.kind === 'uncertain');
  check('BUG-01: unreliable alternative is uncertain', (await judgeTrainingAttempt(initial, 'd2d4', 'e2e4', before, { evaluateAfter: async () => ({ ...before, scoreCp: -1000, ...patch }) })).verdict.kind === 'uncertain');
}
const mate = new Chess(); for (const san of ['f3', 'e5', 'g4']) mate.move(san);
check('BUG-01: weaker complete search is not compared with deeper baseline', (await judgeTrainingAttempt(initial, 'd2d4', 'e2e4', before, { evaluateAfter: async () => ({ ...before, scoreCp: -1000, actualDepth: 12, depth: 12 }) })).verdict.kind === 'uncertain');
check('BUG-01: immediate legal mate works without engine', (await judgeTrainingAttempt(mate.fen(), 'd8h4', '', { ...before, status: 'unavailable', actualDepth: 0 })).verdict.kind === 'accepted');
check('BUG-02: opponent checkmate is no own opportunity', insights.classifyMissedIdea('8/8/8/8/8/5kq1/P7/7K w - - 0 1', 'a2a3', undefined, ['a2a3', 'g3g2'])?.idea !== 'mate');
check('BUG-03: queen exchange is no material opportunity', insights.classifyMissedIdea('3r2k1/8/8/3q4/8/8/8/3Q2K1 w - - 0 1', 'd1d5', undefined, ['d1d5', 'd8d5'])?.idea !== 'capture');
check('BUG-03: exchanged queens do not count as lost queen', insights.findEvidencedLostPiece('3q2k1/8/8/8/3Q4/8/8/3R2K1 b - - 0 1', ['d8d4', 'd1d4'], 'w') === null);
const tradeStart = '3r2k1/8/8/3q4/8/8/8/3Q2K1 w - - 0 1';
const tradeBoard = new Chess(tradeStart); tradeBoard.move('Qxd5+');
check('BUG-03: include capture already made by the actual game move', insights.findEvidencedLostPiece(tradeBoard.fen(), ['d8d5'], 'w', { fenBefore: tradeStart, uci: 'd1d5' }) === null);
const zero = { brilliant: 0, great: 0, best: 0, excellent: 0, good: 0, book: 0, inaccuracy: 0, mistake: 0, blunder: 0, miss: 0 };
const board = new Chess(); board.move('e4');
function game(id: string, date: string, createdAt: string): GameAnalysis {
  const move: MoveAnalysis = { ply: 1, moveNumber: 1, color: 'w', san: 'e4', uci: 'e2e4', from: 'e2', to: 'e4', piece: 'p', isCheck: false, isCheckmate: false, fenBefore: initial, fenAfter: board.fen(), evalBefore: before, evalAfter: { ...before, scoreCp: 20, bestMoveUci: 'e7e5', pv: ['e7e5'] }, quality: 'mistake', winChanceBefore: 50, winChanceAfter: 48, winChanceDrop: 2 };
  return { id, date, createdAt, white: 'Alice', black: 'Opponent', result: '1-0', pgn: '1. e4 *', moves: [move], accuracyWhite: 80, accuracyBlack: 80, summaryWhite: { ...zero, mistake: 1 }, summaryBlack: { ...zero }, analysisVersion: 2 };
}
const tempParent = path.join(process.cwd(), 'tmp'); fs.mkdirSync(tempParent, { recursive: true });
const temp = fs.mkdtempSync(path.join(tempParent, 'product-fixes-'));
const loader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = loader._load;
loader._load = function(request, parent, isMain) { if (request === 'electron') return { app: { getPath: () => temp, getAppPath: () => process.cwd() } }; return originalLoad.call(this, request, parent, isMain); };
const { ChessDatabase } = require('../electron/db') as typeof import('../electron/db'); loader._load = originalLoad;
try {
  const db = new ChessDatabase();
  db.saveGame(game('game_0000000000000001', '2024.01.01', '2026-10-21T00:00:00Z'));
  db.saveGame(game('game_0000000000000002', '2026.10.01', '2026-10-20T00:00:00Z'));
  check('BUG-04: chronology uses played date', db.getPlayerStats('Alice').accuracyHistory.map(x => x.date).join(',') === '2024.01.01,2026.10.01');
  check('BUG-04: unknown date does not become import time', !parsePlayedAt('????.??.??') && !parsePlayedAt('2026.02.30'));
  check('BUG-04: PGN UTC clock preserved', parsePgnMetadata('[Date "2026.10.20"]\n[UTCDate "2026.10.21"]\n[UTCTime "09:05:00"]\n\n1. e4 *').playedAt === '2026-10-21T09:05:00.000Z');
  check('BUG-04: legacy migration preserves actual date', migrateGameTime(game('legacy', '2024.01.01', '2026-01-01')).playedAt === '2024-01-01T00:00:00.000Z');
  const settings = { ...APP_SETTINGS_DEFAULTS, profileId: 'profile-test', playerName: 'Alice', playerAliases: ['OldAlice'], chessComUsername: 'AliceChessCom', lichessUsername: 'AliceLichess' };
  profile.configureProfile(settings);
  check('BUG-05: both accounts resolve to one profile', insights.resolvePlayerColor('AliceLichess', 'Other', 'Alice') === 'w' && insights.resolvePlayerColor('Other', 'AliceChessCom', 'Alice') === 'b');
  check('BUG-05: aliases do not match substrings', insights.resolvePlayerColor('AliceLichess2', 'Other', 'Alice') === null);
  check('BUG-05: same name on another platform is not automatically my account', insights.resolvePlayerColor('AliceLichess', 'Other', 'Alice', 'https://chess.com/game/live/1') === null && insights.resolvePlayerColor('AliceLichess', 'Other', 'Alice', 'https://lichess.org/abcdefgh') === 'w');
  check('BUG-05: ambiguous self-play has no assumed color', insights.resolvePlayerColor('AliceLichess', 'AliceChessCom', 'Alice') === null);
  const memory = new Map<string, string>();
  let fail = false;
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    get length() { return memory.size; }, key: (i: number) => [...memory.keys()][i] ?? null,
    getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { if (fail) throw new Error('QuotaExceededError'); memory.set(key, value); }, removeItem: (key: string) => memory.delete(key),
  };
  memory.set('personal-chess-analyzer-reviews-v1:oldalice', JSON.stringify({ version: 1, reviews: { test: { key: 'test', dueAt: 100, intervalIdx: 0, attempts: 1, correct: 0, lapses: 1, helps: 0 } } }));
  memory.set('personal-chess-analyzer-repertoires-v2:oldalice', '["course:caro-kann"]');
  profile.migrateProfileStorage(settings);
  check('BUG-05: old learning history migrates', reviews.loadReviews('Alice').reviews.test.lapses === 1);
  memory.set('personal-chess-analyzer-repertoires-v2:profile-test', '[]'); profile.migrateProfileStorage(settings);
  check('BUG-05: migration does not restore unfavorited old entries', memory.get('personal-chess-analyzer-repertoires-v2:profile-test') === '[]');
  profile.configureProfile({ ...settings, playerName: 'Renamed', playerAliases: ['Alice', 'OldAlice'] });
  check('BUG-05: rename preserves namespace', reviews.loadReviews('Renamed').reviews.test.lapses === 1);
  fail = true;
  const pendingStore = reviews.loadReviews('Renamed'); reviews.applyReview(pendingStore, 'quota-card', 'wrong', 1000);
  check('BUG-07: save failure is explicit', !reviews.saveReviews('Renamed', pendingStore) && storage.hasPendingStorageWrites());
  check('BUG-07: unmount/reload of store retains pending result', reviews.loadReviews('Renamed').reviews['quota-card'].lapses === 1);
  fail = false; check('BUG-07: retry persists result once', storage.retryLearningWrites() && reviews.loadReviews('Renamed').reviews['quota-card'].lapses === 1);
  const bundle = { format: 'personal-chess-analyzer' as const, version: 1 as const, createdAt: new Date().toISOString(), games: db.exportGames(), settings, learningStorage: storage.snapshotLearningStorage() };
  const exported = encodeDataBundle(bundle), restored = decodeDataBundle(exported);
  check('DATA-01: full backup roundtrip preserves cards and games', restored.games.length === 2 && Object.keys(restored.learningStorage).length > 0 && restored.settings.profileId === settings.profileId);
  assert.throws(() => decodeDataBundle(exported.replace('Alice', 'Alicf'))); count++;
  db.replaceGames([]); db.replaceGames(restored.games);
  check('DATA-01: archive restore is complete', db.getGames().length === 2);
  storage.replaceLearningStorage({}); storage.replaceLearningStorage(restored.learningStorage);
  check('DATA-01: learning restore is complete', reviews.loadReviews('Renamed').reviews['quota-card'].lapses === 1);
  profile.configureProfile(null);
  const queenFen = '6k1/8/8/3q4/8/8/8/3Q2K1 w - - 0 1', q = new Chess(queenFen); q.move('Kf1');
  const chance = { ...game('game_0000000000000003', '2026.10.21', '2026-10-21T01:00:00Z'), moves: [{ ...game('temp', '', '').moves[0], piece: 'k', san: 'Kf1', uci: 'g1f1', from: 'g1', to: 'f1', fenBefore: queenFen, fenAfter: q.fen(), quality: 'good' as const, evalBefore: { ...before, scoreCp: 800, bestMoveUci: 'd1d5', pv: ['d1d5', 'g8h8'] }, evalAfter: { ...before, scoreCp: 600, bestMoveUci: 'd5a5', pv: ['d5a5'] }, winChanceDrop: 3 }] };
  const ideasBefore = db.getPlayerStats('Alice').overlookedIdeas.total; db.saveGame(chance);
  check('BUG-10: tagged opportunity counted by diagnostics', db.getPlayerStats('Alice').overlookedIdeas.total === ideasBefore + 1);
  check('BUG-10: same opportunity reaches training without duplicate', deck.filterTrainingCards(deck.buildTrainingCards([chance], 'Alice'), ['miss', 'blunder']).length === 1);
  const previousErrorCount = Object.values(db.getPlayerStats('Alice').phaseDistribution).reduce((sum, count) => sum + count, 0);
  const exclusiveChance = { ...chance, id: 'game_0000000000000005', moves: chance.moves.map(move => ({ ...move, quality: 'mistake' as const })) };
  db.saveGame(exclusiveChance);
  check('Missed opportunity does not also increase error statistics', Object.values(db.getPlayerStats('Alice').phaseDistribution).reduce((sum, count) => sum + count, 0) === previousErrorCount);
  check('Archive and deck exclude opportunity from coarse-error category', db.getGames('Alice').find(game => game.id === exclusiveChance.id)?.mistakeCount === 0 && deck.filterTrainingCards(deck.buildTrainingCards([exclusiveChance], 'Alice'), ['mistake']).length === 0);
  const partial = game('game_0000000000000004', '2026.10.21', ''); partial.analysisPartial = true; partial.moves[0].evalBefore = { ...before, status: 'partial' };
  const total = db.getPlayerStats('Alice').totalGames; db.saveGame(partial);
  check('BUG-01: partial game excluded from diagnostic statistics', db.getPlayerStats('Alice').totalGames === total && !isReliableGame(partial));
  check('BUG-01: partial card excluded from training', deck.buildTrainingCards([partial], 'Alice').length === 0);
  const repetition = game('repetition', '2026.10.21', '');
  repetition.moves = extractMovesFromPgn('1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8 1/2-1/2').map((move, index, list) => ({ ...repetition.moves[0], ...move,
    evalBefore: { ...before, bestMoveUci: move.uci, pv: [move.uci] },
    evalAfter: index === list.length - 1 ? { ...before, depth: 0, actualDepth: 0, scoreCp: 0, bestMoveUci: '', pv: [] } : { ...before },
  }));
  check('Reliability: historical threefold draw is not mistaken for missing engine', isReliableGame(repetition));
  reviews.setReviewSchedule({ mode: 'custom', preset: 'normal', intervalsDays: [1] });
  const schedule = { version: 1 as const, reviews: {} };
  const helped = reviews.applyReview(schedule, 'help', 'help', 0);
  check('BUG-11: help cannot imply mastery with one interval', !reviews.isMastered(helped));
  const first = reviews.applyReview(schedule, 'recall', 'correct', 0); const firstDue = first.dueAt;
  for (let i = 1; i < 8; i++) reviews.applyReview(schedule, 'recall', 'correct', i);
  check('BUG-11: immediate repeats do not advance mastery or due date', !reviews.isMastered(schedule.reviews.recall) && schedule.reviews.recall.dueAt === firstDue);
  reviews.applyReview(schedule, 'recall', 'correct', firstDue); reviews.applyReview(schedule, 'recall', 'correct', firstDue * 2);
  check('BUG-11: spaced independent recalls can reach mastery', reviews.isMastered(schedule.reviews.recall));
  reviews.setReviewSchedule();
  const branch = { gameId: 'test', anchorPly: 0, line: ['e2e4', 'e7e5', 'g1f3'], cursor: 1, label: 'test' };
  const changed = appendVariation(initial, branch, 'c7c5');
  check('Review: branching trims only future variation', changed?.line.join(',') === 'e2e4,c7c5' && branch.line.length === 3);
  check('Review: backwards returns exact start FEN', variationPosition(initial, branch.line, 0).fen === initial);
  check('Review: invalid PV suffix is never played', variationPosition(initial, ['e2e4', 'a1a8']).steps.length === 1);
  check('Review: promotion suffix retained', variationPosition('8/P7/7k/8/8/8/8/7K w - - 0 1', ['a7a8n']).steps[0].san.includes('=N'));
  const oldFetch = globalThis.fetch;
  try {
    let url = '';
    globalThis.fetch = (async (input: unknown) => { url = String(input); return new Response(Array.from({ length: 350 }, (_, index) => JSON.stringify({ id: `game${index}`, pgn: '1. e4 *', lastMoveAt: Date.now(), status: 'resign' })).join('\n')); }) as typeof fetch;
    const { fetchLichessGames } = require('../electron/lichess') as typeof import('../electron/lichess');
    check('BUG-13: whole window includes more than 200 games', (await fetchLichessGames('Alice', Date.now() - 86400000)).length === 350 && !new URL(url).searchParams.has('max'));
  } finally { globalThis.fetch = oldFetch; }
  console.log(`Product fixes: ${count} checks passed.`);
} finally {
  profile.configureProfile(null); reviews.setReviewSchedule();
  if (path.dirname(temp) === tempParent) { fs.unlinkSync(path.join(temp, 'games_db.json')); fs.rmdirSync(temp); }
}
