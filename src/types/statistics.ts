export type StatisticsPlatform = 'chesscom' | 'lichess' | 'other';
export type TimeControlKind = 'bullet' | 'blitz' | 'rapid' | 'classical' | 'daily' | 'unknown';
export interface StatisticsFilter {
  days: 0 | 7 | 30 | 90 | 365;
  platform: StatisticsPlatform | 'all';
  timeControl: TimeControlKind | 'all';
}
export type GamePhase = 'opening' | 'middlegame' | 'endgame';
export interface PhasePerformance {
  accuracy: number | null;
  decisions: number;
  games: number;
  errors: number;
}
export interface RatingObservation { at: string; rating: number; gameId: string }
export interface TimeControlPerformance {
  id: string;
  platform: StatisticsPlatform;
  account: string;
  timeControl: TimeControlKind;
  games: number;
  analyzedGames: number;
  wins: number;
  losses: number;
  draws: number;
  unfinished: number;
  winRate: number | null;
  accuracy: number | null;
  errors: number;
  errorsPerGame: number | null;
  missedChances: number;
  brilliantMoves: number;
  phases: Record<GamePhase, PhasePerformance>;
  rating: { latest: number | null; delta: number | null; samples: number; history: RatingObservation[]; ambiguous: boolean };
}
export interface PerformanceOverview {
  rows: TimeControlPerformance[];
  selectedGames: number;
  analyzedGames: number;
  excludedUndated: number;
  brilliantMoves: number;
  missedChances: number;
  brilliantExamples: Array<{ gameId: string; ply: number; moveNumber: number; san: string; opponent: string; platform: StatisticsPlatform }>;
}
