import React from 'react';
import { createRoot } from 'react-dom/client';
import { Chess } from 'chess.js';
import { App } from '../src/App';
import { APP_SETTINGS_DEFAULTS } from '../src/types/chess';
import { buildOpeningPhaseStats } from '../src/utils/openingPhase';
import { archiveItem } from '../src/utils/archive';
import { fixtureGame, CARO_POLISH, POLISH } from './opening-phase-fixtures';
import '../src/index.css';

const games = [fixtureGame('caro-early', CARO_POLISH, 'b', { 11: 'inaccuracy', 13: 'blunder' }), fixtureGame('polish-late', POLISH, 'b', { 13: 'blunder', 15: 'mistake' })];
let settings = { ...APP_SETTINGS_DEFAULTS, playerName: 'Alice', profileId: 'opening-ui-fixture', soundEnabled: false };
window.__opening = { games, statsCalls: 0, contexts: [], getSettings: () => settings };
const emptyPerformance = { games: 0, wins: 0, losses: 0, draws: 0, avgAccuracy: 0, winRate: 0 };
const stats = () => ({ playerName: 'Alice', totalGames: games.length, winCount: 0, lossCount: 0, drawCount: games.length, avgAccuracy: 67,
  openingWindowMoves: settings.openingWindowMoves, openingPhaseStats: buildOpeningPhaseStats(games, 'Alice', settings.openingWindowMoves),
  colorPerformance: { white: emptyPerformance, black: { ...emptyPerformance, games: games.length, avgAccuracy: 67 } },
  phaseDistribution: { openingBlunders: 0, middlegameBlunders: 4, endgameBlunders: 0 },
  blunderedPieces: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 }, openingsStats: [], accuracyHistory: [], timeControlStats: [], avgErrorSeverity: 0,
  worstError: null, coachingInsights: [], overlookedIdeas: { total: 0, counts: { mate: 0, capture: 0, fork: 0, check: 0, quiet: 0 }, examples: [] },
  matePatterns: { total: 0, backRank: 0, smothered: 0, net: 0 }, variationStats: [] });
function evaluate(start, depth, count, history = [], current) {
  const board = new Chess(start);
  history.forEach(uci => board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }));
  if (current && board.fen() !== current) throw Error('History and current position mismatch');
  window.__opening.contexts.push({ start, history, current });
  const candidates = board.moves({ verbose: true }).slice(0, count);
  const lines = candidates.map(first => {
    const probe = new Chess(board.fen()), pv = [];
    let next = first;
    for (let i = 0; i < 14 && next && !probe.isGameOver(); i++) {
      pv.push(next.from + next.to + (next.promotion || '')); probe.move(next);
      next = probe.moves({ verbose: true })[0];
    }
    return { uci: pv[0], scoreCp: 0, bestMoveUci: pv[0], pv, depth, actualDepth: depth, status: 'complete', bound: 'exact' };
  });
  return { scoreCp: 0, bestMoveUci: lines[0]?.uci || '', pv: lines[0]?.pv || [], depth, actualDepth: depth, status: 'complete', bound: 'exact', moves: lines };
}
const jobs = { version: 1, jobs: [], knownIds: [] };
window.electronAPI = {
  db: { getGames: async () => games.map(game => archiveItem(game, 'Alice')), getGame: async id => games.find(game => game.id === id),
    getPlayerStats: async () => { window.__opening.statsCalls++; return stats(); }, getReviewIdMap: async () => ({}), getStableGameIds: async () => [] },
  settings: { get: async () => settings, save: async partial => settings = { ...settings, ...partial } },
  engine: { getStatus: async () => ({ installed: true, ready: false, path: 'fixture', engineName: 'Fixture' }),
    evaluateFen: async (start, depth, history, current) => evaluate(start, depth, 1, history, current), evaluateFenMultiPv: async (...args) => evaluate(...args) },
  chesscom: { listJobs: async () => jobs, claimNextJob: async () => null }, lichess: { listJobs: async () => jobs, claimNextJob: async () => null },
};
createRoot(document.getElementById('root')).render(<App />);
