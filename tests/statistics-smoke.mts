/** Focused statistics rules + real database integration, no network or engine. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { statisticsFixtures, STATISTICS_NOW } = require('./statistics-fixtures') as typeof import('./statistics-fixtures');
const { buildPerformanceOverview, gamePhase } = require('../src/utils/performanceStatistics') as typeof import('../src/utils/performanceStatistics');
const { DEFAULT_STATISTICS_FILTER: all, gamePlatform, matchesStatisticsFilter, normalizeStatisticsFilter } = require('../src/utils/statisticsFilter') as typeof import('../src/utils/statisticsFilter');
const { timeControlKind } = require('../src/utils/timeControl') as typeof import('../src/utils/timeControl');
const { buildTrainingCards } = require('../src/utils/trainingDeck') as typeof import('../src/utils/trainingDeck');
const { configureProfile } = require('../src/utils/profile') as typeof import('../src/utils/profile');
const { APP_SETTINGS_DEFAULTS } = require('../src/types/chess') as typeof import('../src/types/chess');
const { buildDeepDiagnostics } = require('../src/utils/deepDiagnostics') as typeof import('../src/utils/deepDiagnostics');
const games = statisticsFixtures();
const overview = buildPerformanceOverview(games, 'Alice', all, 12, STATISTICS_NOW);
assert.equal(overview.selectedGames, 8, 'Exclude foreign names, keep real metadata of partial analyses');
assert.equal(overview.analyzedGames, 7);
const rapid = overview.rows.find(row => row.platform === 'chesscom' && row.timeControl === 'rapid')!;
assert.equal(rapid.rating.latest, 1041, 'Own black rating, never white opponent rating');
assert.equal(rapid.rating.delta, 61);
assert.equal(rapid.games, 3);
assert.equal(rapid.wins, 3);
assert.equal(rapid.phases.opening.errors, 3);
assert.equal(rapid.phases.opening.decisions, 36);
assert.equal(rapid.brilliantMoves, 1);
assert.equal(rapid.missedChances, 1);
assert.equal(rapid.errors, 6, 'Missed chance is not also counted as a blunder');
assert.equal(rapid.errorsPerGame, 2);
assert.equal(overview.rows.find(row => row.platform === 'lichess')!.rating.latest, 1850);
assert.equal(overview.rows.find(row => row.platform === 'lichess')!.rating.delta, null, 'Single observations have no fake rating change');
assert.equal(overview.rows.find(row => row.timeControl === 'blitz')!.accuracy, 37.5, 'A genuine accuracy of zero is included');
const daily = overview.rows.find(row => row.timeControl === 'daily')!;
assert.equal(daily.rating.latest, 773);
assert.equal(daily.accuracy, null);
assert.equal(daily.errorsPerGame, null, 'An incomplete analysis is unknown rather than zero errors');
assert.equal(overview.rows.find(row => row.platform === 'other')!.rating.latest, null);
const ownWhite = buildPerformanceOverview([{ ...games[0], white: 'Alice', black: 'Opponent', whiteElo: '1300', blackElo: '2400', result: '*' }], 'Alice', all, 12, STATISTICS_NOW).rows[0];
assert.equal(ownWhite.rating.latest, 1300);
assert.equal(ownWhite.draws, 0, 'An unfinished game is not a draw');
assert.equal(ownWhite.winRate, null);
const filter = { days: 30 as const, platform: 'chesscom' as const, timeControl: 'rapid' as const };
const selected = buildPerformanceOverview(games, 'Alice', filter, 12, STATISTICS_NOW);
assert.equal(selected.selectedGames, 2);
assert.equal(selected.rows[0].rating.delta, 41);
assert.equal(buildPerformanceOverview(games, 'Alice', { ...all, days: 7 }, 12, STATISTICS_NOW).selectedGames, 4);
assert.equal(buildPerformanceOverview(games, 'Alice', { ...all, days: 7 }, 12, STATISTICS_NOW).excludedUndated, 1);
assert.equal(matchesStatisticsFilter(games.find(game => game.id === 'undated')!, { ...all, days: 90 }, STATISTICS_NOW), false, 'Never use import date as game date');
assert.equal(gamePlatform({ site: 'https://chess.com.fake.example' }), 'other');
assert.equal(timeControlKind('120+10'), 'rapid', 'Increment matters without API speed');
assert.equal(timeControlKind('120+10', 'bullet'), 'bullet', 'Provider time class takes precedence');
assert.equal(timeControlKind('1/86400'), 'daily');
assert.equal(timeControlKind('40/7200:3600'), 'unknown', 'Complex staged controls are not guessed');
assert.equal(timeControlKind('*'), 'unknown');
assert.deepEqual(normalizeStatisticsFilter({ days: 99, platform: 'bogus' } as any), all);
const actualNow = Date.now; Date.now = () => STATISTICS_NOW;
try {
  const cards = buildTrainingCards(games, 'Alice', { statisticsFilter: filter });
  assert.ok(cards.length > 0);
  assert.ok(cards.every(card => ['rapid-last', 'rapid-middle'].includes(card.game.id)), 'Training retains source statistics scope');
  assert.ok(buildTrainingCards(games, 'Alice', { statisticsFilter: all }).every(card => card.game.id !== 'partial-daily'), 'Filtered diagnosis training excludes incomplete games too');
} finally { Date.now = actualNow; }
const before = games[0].moves[24];
assert.equal(gamePhase({ ...before, moveNumber: 12 }, 12), 'opening');
assert.equal(gamePhase({ moveNumber: 20, fenBefore: '8/8/4k3/7p/P7/3K4/8/8 w - - 0 20' }, 12), 'endgame');
assert.equal(gamePhase({ moveNumber: 20, fenBefore: games[0].moves[0].fenBefore }, 12), 'middlegame');
const forced = { ...games[0], moves: games[0].moves.map(move => move.color === 'b' ? { ...move, isForced: true } : move) };
const forcedStats = buildPerformanceOverview([forced], 'Alice', all, 12, STATISTICS_NOW).rows[0];
assert.equal(forcedStats.phases.opening.accuracy, null, 'No decisions is not 100% accuracy');
assert.equal(forcedStats.errors, 0);
const tied = games.filter(game => game.id === 'rapid-last' || game.id === 'rapid-middle').map(game => ({ ...game, playedAt: '2026-10-24T00:00:00Z' }));
const tie = buildPerformanceOverview(tied, 'Alice', all, 12, STATISTICS_NOW).rows[0].rating;
assert.equal(tie.latest, null, 'Do not invent a latest rating when same-date metadata cannot order different ratings');
assert.equal(tie.delta, null);
configureProfile({ ...APP_SETTINGS_DEFAULTS, playerName: 'Profile', chessComUsername: 'Alice', lichessUsername: 'Alice', accountAliases: { chessCom: ['SecondAccount'], lichess: [] } });
const accounts = buildPerformanceOverview([games[0], { ...games[0], id: 'second-account', black: 'SecondAccount', blackElo: '1800' }], 'Profile', all, 12, STATISTICS_NOW);
assert.equal(accounts.rows.length, 2, 'Never combine ratings of linked accounts');
configureProfile(null);

// Exercise the actual Electron-side aggregation with an isolated in-memory DB.
const Module = (await import('node:module')).default as any, original = Module._load;
Module._load = function(request: string, from: unknown, main: boolean) { if (request === 'electron') return { app: { getPath: () => { throw Error('Test must not touch userData'); } } }; return original.call(this, request, from, main); };
const { ChessDatabase } = require('../electron/db');
Module._load = original;
const db = Object.create(ChessDatabase.prototype); db.data = { games };
Date.now = () => STATISTICS_NOW;
try {
  const stats = db.getPlayerStats('Alice', 12, filter);
  assert.equal(stats.totalGames, 2, 'Period/platform/speed apply to the entire diagnosis');
  assert.equal(stats.performance.selectedGames, 2);
  assert.equal(stats.openingPhaseStats.reduce((sum: number, row: any) => sum + row.games, 0), 2);
  assert.equal(stats.accuracyHistory.length, 2);
  assert.equal(stats.deepDiagnostics?.analyzedGames, 2);
  assert.equal(db.getPlayerStats('Alice', 12, { ...all, platform: 'lichess' }).totalGames, 1);

  const assertNoNaN = (value: unknown, path = 'diag'): void => {
    if (typeof value === 'number') assert.ok(Number.isFinite(value), `Non-finite number at ${path}: ${value}`);
    else if (Array.isArray(value)) value.forEach((item, index) => assertNoNaN(item, `${path}[${index}]`));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => assertNoNaN(v, `${path}.${k}`));
  };

  const emptyDiag = buildDeepDiagnostics([], 'Alice');
  assertNoNaN(emptyDiag, 'emptyDiag');
  assert.equal(emptyDiag.analyzedGames, 0);
  assert.equal(emptyDiag.totalDecisions, 0);
  assert.equal(emptyDiag.totalErrors, 0);
  assert.equal(emptyDiag.conversion.conversionRate, null);
  assert.equal(emptyDiag.conversion.resilienceRate, null);
  assert.equal(emptyDiag.turningPoints.length, 0);
  assert.equal(emptyDiag.recommendations.length, 0);
  assert.equal(emptyDiag.moveZones.length, 5);
  assert.ok(emptyDiag.moveZones.every(zone => zone.decisions === 0 && zone.avgAccuracy === null && zone.errorsPer100 === 0));

  const aliceDiag = buildDeepDiagnostics(games, 'Alice');
  assertNoNaN(aliceDiag, 'aliceDiag');
  assert.equal(aliceDiag.analyzedGames, 7, 'Partial and non-matching games are excluded from deep diagnostics');
  assert.equal(buildDeepDiagnostics(games, ['Alice', 'AliceOther']).analyzedGames, 8);
  assert.ok(aliceDiag.totalDecisions > 0);
  assert.equal(aliceDiag.moveQuality.totalDecisions, aliceDiag.totalDecisions);

  const baseDiagGame = structuredClone(games[0]);
  const diagConvertedForced = {
    ...structuredClone(baseDiagGame),
    id: 'diag-converted-forced',
    result: '0-1',
    whiteElo: '1500',
    blackElo: '1500',
    moves: baseDiagGame.moves.map(move => {
      if (move.color !== 'b') return { ...move };
      if (move.moveNumber === 11) return { ...move, isForced: true };
      if (move.moveNumber === 12) return { ...move, quality: 'blunder' as const, winChanceBefore: 90, winChanceAfter: 10, winChanceDrop: 80, isForced: true };
      if (move.moveNumber === 13) return { ...move, quality: 'blunder' as const, winChanceBefore: 80, winChanceAfter: 50, winChanceDrop: 30 };
      return { ...move };
    }),
  };
  const diagSquandered = {
    ...structuredClone(baseDiagGame),
    id: 'diag-squandered',
    result: '1-0',
    whiteElo: '1700',
    blackElo: '1500',
    moves: baseDiagGame.moves.map(move =>
      move.color === 'b' && move.moveNumber === 10
        ? { ...move, quality: 'blunder' as const, winChanceBefore: 82, winChanceAfter: 35, winChanceDrop: 47 }
        : { ...move },
    ),
  };
  const diagUnfinished = {
    ...structuredClone(baseDiagGame),
    id: 'diag-unfinished',
    result: '*',
    whiteElo: 'invalid',
    blackElo: '1500',
    moves: baseDiagGame.moves.map(move =>
      move.color === 'b' && move.moveNumber === 8
        ? { ...move, quality: 'best' as const, winChanceBefore: 85, winChanceAfter: 85, winChanceDrop: 0 }
        : { ...move },
    ),
  };
  const diagSuite = [diagConvertedForced, diagSquandered, diagUnfinished];
  const suiteDiag = buildDeepDiagnostics(diagSuite, 'Alice');
  assertNoNaN(suiteDiag, 'suiteDiag');
  assert.equal(suiteDiag.analyzedGames, 3);
  assert.equal(suiteDiag.totalDecisions, 46, 'Forced moves are excluded from decision counts');
  assert.equal(suiteDiag.conversion.winningGamesReached, 3);
  assert.equal(suiteDiag.conversion.winningGamesCompleted, 2, 'Unfinished (*) games do not dilute conversion denominator');
  assert.equal(suiteDiag.conversion.winningGamesConverted, 1);
  assert.equal(suiteDiag.conversion.squanderedLosses, 1);
  assert.equal(suiteDiag.conversion.conversionRate, 50);
  assert.equal(suiteDiag.turningPoints.length, 2, 'Forced blunders never become turning points');
  assert.equal(suiteDiag.turningPoints[0].gameId, 'diag-squandered');
  assert.equal(suiteDiag.turningPoints[0].winChanceDrop, 47);
  assert.equal(suiteDiag.turningPoints[1].gameId, 'diag-converted-forced');
  assert.equal(suiteDiag.turningPoints[1].winChanceDrop, 30);
  assert.equal(suiteDiag.opponentStrengthUnknownGames, 1);
  assert.equal(suiteDiag.opponentStrength.find(bucket => bucket.category === 'stronger')?.games, 1);
  assert.equal(suiteDiag.opponentStrength.find(bucket => bucket.category === 'equal')?.games, 1);

  const diagDb = Object.create(ChessDatabase.prototype);
  diagDb.data = { games: diagSuite };
  const diagStats = diagDb.getPlayerStats('Alice', 12, { ...all, timeRange: 'all' });
  assert.equal(diagStats.deepDiagnostics?.analyzedGames, 3);
  assert.equal(diagStats.timeControlStats.length, 1);
  assert.equal(diagStats.timeControlStats[0].games, 3);
  assert.equal(diagStats.timeControlStats[0].winRate, 50, 'DB winRate divides by completed games');
  assert.equal(diagStats.colorPerformance.black.winRate, 50);
  assert.equal(diagStats.deepDiagnostics?.moveQuality.counts.inaccuracy, 2, 'Move quality counts exclude isForced inaccuracies');
  assert.equal(diagStats.deepDiagnostics?.moveQuality.counts.blunder, 1, 'Move quality counts exclude isForced blunders');
  assert.equal(diagStats.deepDiagnostics?.moveQuality.counts.miss, 3, 'Missed opportunities classify as miss');
  assert.equal(diagStats.worstError?.winChanceDrop, 47, 'DB worstError excludes isForced blunder (80)');
  const totalDiagBlunders = diagStats.phaseDistribution.openingBlunders
    + diagStats.phaseDistribution.middlegameBlunders
    + diagStats.phaseDistribution.endgameBlunders;
  assert.equal(totalDiagBlunders, 1, 'DB phaseDistribution excludes isForced blunder');

  const forcedOnlyDb = Object.create(ChessDatabase.prototype);
  forcedOnlyDb.data = { games: [diagConvertedForced] };
  const forcedOnlyStats = forcedOnlyDb.getPlayerStats('Alice', 12, { ...all, timeRange: 'all' });
  assert.equal(forcedOnlyStats.worstError, null, 'DB worstError stays null when only blunder is forced');
} finally { Date.now = actualNow; }
console.log('Statistics smoke passed: filters, own ratings and pools, PGN time, partial data, zero accuracy, phases, exclusive errors, linked accounts, cards, deep diagnostics and real database aggregation.');
