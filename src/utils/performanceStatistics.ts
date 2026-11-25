import type { GameAnalysis, MoveAnalysis } from '../types/chess';
import type { GamePhase, PerformanceOverview, PhasePerformance, RatingObservation, StatisticsFilter, TimeControlPerformance } from '../types/statistics';
import { calculateMoveAccuracy, moveCategory } from './analysis';
import { isReliableGame } from './evaluationReliability';
import { playedAt } from './gameTime';
import { resolvePlayerColor } from './moveInsights';
import { gamePlatform, matchesStatisticsFilter } from './statisticsFilter';
import { timeControlKind, TIME_CONTROL_ORDER } from './timeControl';

const round = (value: number) => Math.round(value * 10) / 10;
const phases: GamePhase[] = ['opening', 'middlegame', 'endgame'];
export function gamePhase(move: Pick<MoveAnalysis, 'moveNumber' | 'fenBefore'>, openingWindow: number): GamePhase {
  if (move.moveNumber <= openingWindow) return 'opening';
  // Same documented material heuristic as diagnosis, without constructing a
  // chess board for every decision. Classify the position BEFORE the move.
  const pieces = move.fenBefore.split(' ')[0];
  const queens = (pieces.match(/[qQ]/g) || []).length;
  const material = [...pieces].reduce((sum, piece) => sum + (/[nb]/i.test(piece) ? 3 : /r/i.test(piece) ? 5 : 0), 0);
  return queens === 0 || material <= 13 ? 'endgame' : 'middlegame';
}

function ratingSummary(observations: RatingObservation[]): TimeControlPerformance['rating'] {
  const buckets = new Map<string, RatingObservation[]>();
  for (const observation of observations) {
    const values = buckets.get(observation.at);
    if (values) values.push(observation); else buckets.set(observation.at, [observation]);
  }
  const entries = [...buckets].sort(([a], [b]) => a.localeCompare(b));
  const unique = (values: RatingObservation[]) => new Set(values.map(value => value.rating)).size === 1 ? values[0] : null;
  const first = entries.length ? unique(entries[0][1]) : null;
  const last = entries.length ? unique(entries.at(-1)![1]) : null;
  return { latest: last?.rating ?? null, delta: entries.length >= 2 && first && last ? last.rating - first.rating : null,
    samples: observations.length, history: entries.flatMap(([, values]) => { const point = unique(values); return point ? [point] : []; }),
    ambiguous: !!entries.length && !last };
}

/** Descriptive local statistics. Ratings are pre-game PGN observations, never
 * live account ratings. Separate platform + account + speed rating pools. */
export function buildPerformanceOverview(games: GameAnalysis[], player: string, filter: StatisticsFilter, openingWindow = 12, now = Date.now()): PerformanceOverview {
  type Bucket = TimeControlPerformance & { acc: number[]; phaseAcc: Record<GamePhase, number[]>; observations: RatingObservation[] };
  const groups = new Map<string, Bucket>();
  const result: PerformanceOverview = { rows: [], selectedGames: 0, analyzedGames: 0, excludedUndated: 0, brilliantMoves: 0, missedChances: 0, brilliantExamples: [] };
  for (const game of games) {
    const color = resolvePlayerColor(game.white, game.black, player, game.site);
    if (!color) continue;
    if (filter.days && !playedAt(game) && matchesStatisticsFilter(game, { ...filter, days: 0 }, now)) result.excludedUndated++;
    if (!matchesStatisticsFilter(game, filter, now)) continue;
    result.selectedGames++;
    const platform = gamePlatform(game), account = color === 'w' ? game.white : game.black;
    const timeControl = timeControlKind(game.timeControl, game.timeClass);
    const id = `${platform}:${account.trim().toLowerCase()}:${timeControl}`;
    let row = groups.get(id);
    if (!row) {
      const empty = (): PhasePerformance => ({ accuracy: null, decisions: 0, games: 0, errors: 0 });
      row = { id, platform, account, timeControl, games: 0, analyzedGames: 0, wins: 0, losses: 0, draws: 0, unfinished: 0, winRate: null,
        accuracy: null, errors: 0, errorsPerGame: null, missedChances: 0, brilliantMoves: 0,
        phases: { opening: empty(), middlegame: empty(), endgame: empty() }, rating: { latest: null, delta: null, samples: 0, history: [], ambiguous: false },
        acc: [], phaseAcc: { opening: [], middlegame: [], endgame: [] }, observations: [] };
      groups.set(id, row);
    }
    row.games++;
    if (game.result === '1/2-1/2') row.draws++;
    else if ((game.result === '1-0' && color === 'w') || (game.result === '0-1' && color === 'b')) row.wins++;
    else if (game.result === '1-0' || game.result === '0-1') row.losses++;
    else row.unfinished++;
    const elo = color === 'w' ? game.whiteElo : game.blackElo, date = playedAt(game);
    if (platform !== 'other' && elo && /^\d{1,5}$/.test(elo) && Number(elo) > 0 && Number(elo) <= 10000 && date && Date.parse(date) <= now)
      row.observations.push({ at: date, rating: Number(elo), gameId: game.id });
    if (!isReliableGame(game)) continue;
    row.analyzedGames++; result.analyzedGames++;
    const accuracy = color === 'w' ? game.accuracyWhite : game.accuracyBlack;
    if (Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= 100) row.acc.push(accuracy);
    const gameAcc: Record<GamePhase, number[]> = { opening: [], middlegame: [], endgame: [] };
    for (const move of game.moves) {
      if (move.color !== color || move.isForced) continue;
      const phase = gamePhase(move, openingWindow), category = moveCategory(move);
      const error = ['inaccuracy', 'mistake', 'blunder', 'miss'].includes(category);
      row.phases[phase].decisions++;
      gameAcc[phase].push(calculateMoveAccuracy(move.winChanceDrop));
      if (error) { row.errors++; row.phases[phase].errors++; }
      if (category === 'miss') { row.missedChances++; result.missedChances++; }
      if (category === 'brilliant') {
        row.brilliantMoves++; result.brilliantMoves++;
        if (result.brilliantExamples.length < 8) result.brilliantExamples.push({ gameId: game.id, ply: move.ply, moveNumber: move.moveNumber, san: move.san, opponent: color === 'w' ? game.black : game.white, platform });
      }
    }
    for (const phase of phases) if (gameAcc[phase].length) {
      row.phases[phase].games++;
      row.phaseAcc[phase].push(gameAcc[phase].reduce((sum, value) => sum + value, 0) / gameAcc[phase].length);
    }
  }
  result.rows = [...groups.values()].map(({ acc, phaseAcc, observations, ...row }) => {
    row.rating = ratingSummary(observations);
    row.accuracy = acc.length ? round(acc.reduce((sum, value) => sum + value, 0) / acc.length) : null;
    row.errorsPerGame = row.analyzedGames ? round(row.errors / row.analyzedGames) : null;
    const completed = row.wins + row.losses + row.draws;
    row.winRate = completed ? round(row.wins / completed * 100) : null;
    for (const phase of phases) row.phases[phase].accuracy = phaseAcc[phase].length ? round(phaseAcc[phase].reduce((sum, value) => sum + value, 0) / phaseAcc[phase].length) : null;
    return row;
  }).sort((a, b) => TIME_CONTROL_ORDER.indexOf(a.timeControl) - TIME_CONTROL_ORDER.indexOf(b.timeControl) || a.platform.localeCompare(b.platform) || a.account.localeCompare(b.account));
  return result;
}
