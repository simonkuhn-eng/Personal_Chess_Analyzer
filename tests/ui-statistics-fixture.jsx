import React from 'react';
import { createRoot } from 'react-dom/client';
import { Chess } from 'chess.js';
import { App } from '../src/App';
import { APP_SETTINGS_DEFAULTS } from '../src/types/chess';
import { buildOpeningPhaseStats } from '../src/utils/openingPhase';
import { buildPerformanceOverview } from '../src/utils/performanceStatistics';
import { normalizeStatisticsFilter, matchesStatisticsFilter } from '../src/utils/statisticsFilter';
import { isReliableGame } from '../src/utils/evaluationReliability';
import { archiveItem } from '../src/utils/archive';
import { statisticsFixtures, STATISTICS_NOW } from './statistics-fixtures';
import '../src/index.css';

Date.now = () => STATISTICS_NOW;
const games = statisticsFixtures();
let settings = { ...APP_SETTINGS_DEFAULTS, playerName: 'Alice', profileId: 'statistics-fixture', soundEnabled: false };
window.__statistics = { requests: [], gameRequests: [], engineCalls: 0 };
function stats(requested) {
  const filter = normalizeStatisticsFilter(requested);
  const eligible = games.filter(game => game.black === 'Alice' && matchesStatisticsFilter(game, filter) && isReliableGame(game));
  const performance = buildPerformanceOverview(games, 'Alice', filter, settings.openingWindowMoves);
  const empty = { games: 0, wins: 0, losses: 0, draws: 0, avgAccuracy: 0, winRate: 0 };
  return { playerName: 'Alice', totalGames: eligible.length, winCount: eligible.length, lossCount: 0, drawCount: 0,
    avgAccuracy: eligible.length ? eligible.reduce((sum, game) => sum + game.accuracyBlack, 0) / eligible.length : 0,
    performance, openingWindowMoves: settings.openingWindowMoves, openingPhaseStats: buildOpeningPhaseStats(eligible, 'Alice', settings.openingWindowMoves),
    colorPerformance: { white: empty, black: { ...empty, games: eligible.length, wins: eligible.length } },
    phaseDistribution: { openingBlunders: 0, middlegameBlunders: 0, endgameBlunders: 0 },
    blunderedPieces: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 }, openingsStats: [], accuracyHistory: [], timeControlStats: [], avgErrorSeverity: 0,
    worstError: null, coachingInsights: [], overlookedIdeas: { total: 0, counts: { mate: 0, capture: 0, fork: 0, check: 0, quiet: 0 }, examples: [] },
    matePatterns: { total: 0, backRank: 0, smothered: 0, net: 0 }, variationStats: [] };
}
function evaluate(start, depth = 14, count = 1, history = [], current) {
  window.__statistics.engineCalls++;
  const board = new Chess(current || start), move = board.moves({ verbose: true })[0], uci = move ? move.from + move.to + (move.promotion || '') : '';
  return { scoreCp: 0, bestMoveUci: uci, pv: uci ? [uci] : [], depth, actualDepth: depth, status: 'complete', bound: 'exact', moves: uci ? [{ uci, scoreCp: 0, pv: [uci] }] : [] };
}
const jobs = { version: 1, jobs: [], knownIds: [] };
window.electronAPI = {
  db: { getGames: async () => games.map(game => archiveItem(game, 'Alice')), getGame: async id => { window.__statistics.gameRequests.push(id); return games.find(game => game.id === id); },
    getPlayerStats: async (name, filter) => { window.__statistics.requests.push({ name, filter }); return stats(filter); }, getReviewIdMap: async () => ({}), getStableGameIds: async () => [] },
  settings: { get: async () => settings, save: async partial => settings = { ...settings, ...partial } },
  engine: { getStatus: async () => ({ installed: true, ready: false, path: 'fixture', engineName: 'Fixture' }),
    evaluateFen: async (start, depth, history, current) => evaluate(start, depth, 1, history, current), evaluateFenMultiPv: async (...args) => evaluate(...args) },
  chesscom: { listJobs: async () => jobs, claimNextJob: async () => null }, lichess: { listJobs: async () => jobs, claimNextJob: async () => null },
};
createRoot(document.getElementById('root')).render(<App />);
