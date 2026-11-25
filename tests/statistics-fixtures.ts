import { fixtureGame, CARO_POLISH } from './opening-phase-fixtures';
import type { GameAnalysis } from '../src/types/chess';

export const STATISTICS_NOW = Date.UTC(2026, 9, 24, 12);
export function statisticsFixtures(): GameAnalysis[] {
  const game = (id: string, days: number, site: string | undefined, speed: string | undefined, rating: string, accuracy = 80) => ({
    ...fixtureGame(id, CARO_POLISH, 'b', { 11: 'inaccuracy', 13: 'blunder' }), site, timeClass: speed,
    playedAt: new Date(STATISTICS_NOW - days * 86400000).toISOString(), date: new Date(STATISTICS_NOW - days * 86400000).toISOString().slice(0, 10).replaceAll('-', '.'),
    result: '0-1', whiteElo: '2500', blackElo: rating, accuracyBlack: accuracy,
  });
  const rapidLast = game('rapid-last', 2, 'https://www.chess.com/game/live/300', 'rapid', '1041', 91);
  rapidLast.moves = rapidLast.moves.map(move => move.color === 'b' && move.moveNumber === 13 ? { ...move, missedOpportunity: {
    version: 1, kind: 'material' as const, bestMoveUci: move.evalBefore.bestMoveUci, bestSan: 'Nf6', bestLine: move.evalBefore.pv, materialGain: 5, description: 'Fixture chance', depth: 14,
  } } : move.color === 'b' && move.moveNumber === 4 ? { ...move, quality: 'brilliant' as const } : move);
  return [rapidLast, game('rapid-first', 70, 'https://www.chess.com/game/live/100', 'rapid', '980', 70), game('rapid-middle', 25, 'Chess.com', 'rapid', '1000', 80),
    game('lichess-rapid', 3, 'https://lichess.org/abcd1234', 'rapid', '1850', 89), game('blitz-last', 1, 'Chess.com', 'blitz', '658', 75), game('blitz-first', 20, 'Chess.com', 'blitz', '650', 0),
    { ...game('partial-daily', 1, 'Chess.com', 'daily', '773', 20), analysisPartial: true },
    { ...game('undated', 0, undefined, undefined, '9999'), playedAt: undefined, date: '????.??.??', createdAt: '2026-10-24T12:00:00Z' },
    { ...game('foreign', 1, 'Chess.com', 'rapid', '9999'), black: 'AliceOther' }];
}
