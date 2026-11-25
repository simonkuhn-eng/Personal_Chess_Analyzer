import type { AppSettings, GameAnalysis } from './chess';

export interface DataBundle {
  format: 'personal-chess-analyzer';
  version: 1;
  createdAt: string;
  games: GameAnalysis[];
  settings: AppSettings;
  learningStorage: Record<string, string>;
}
