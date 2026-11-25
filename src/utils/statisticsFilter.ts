import type { GameMetadata } from '../types/chess';
import type { StatisticsFilter, StatisticsPlatform } from '../types/statistics';
import { playedAt } from './gameTime';
import { timeControlKind, TIME_CONTROL_LABELS } from './timeControl';
import type { AppLanguage } from '../types/chess';

export const DEFAULT_STATISTICS_FILTER: StatisticsFilter = { days: 0, platform: 'all', timeControl: 'all' };
export const PLATFORM_LABELS: Record<StatisticsPlatform, string> = { chesscom: 'Chess.com', lichess: 'Lichess', other: 'Andere / PGN' };
const PLATFORM_LABELS_EN: Record<StatisticsPlatform, string> = { chesscom: 'Chess.com', lichess: 'Lichess', other: 'Other / PGN' };
const TIME_CONTROL_LABELS_EN: Record<string, string> = { bullet: 'Bullet', blitz: 'Blitz', rapid: 'Rapid', classical: 'Classical', daily: 'Daily', unknown: 'Other' };
export function normalizeStatisticsFilter(value?: Partial<StatisticsFilter> | null): StatisticsFilter {
  return { days: [0, 7, 30, 90, 365].includes(value?.days as number) ? value!.days! : 0,
    platform: ['all', 'chesscom', 'lichess', 'other'].includes(value?.platform || '') ? value!.platform! : 'all',
    timeControl: ['all', 'bullet', 'blitz', 'rapid', 'classical', 'daily', 'unknown'].includes(value?.timeControl || '') ? value!.timeControl! : 'all' };
}
export function gamePlatform(game: Pick<GameMetadata, 'site'>): StatisticsPlatform {
  if (/^(?:https?:\/\/)?(?:www\.)?chess\.com(?:[/:]|$)/i.test(game.site?.trim() || '')) return 'chesscom';
  if (/^(?:https?:\/\/)?(?:www\.)?lichess\.org(?:[/:]|$)/i.test(game.site?.trim() || '')) return 'lichess';
  return 'other';
}
export function matchesStatisticsFilter(game: GameMetadata, filter: StatisticsFilter, now = Date.now()): boolean {
  if (filter.platform !== 'all' && gamePlatform(game) !== filter.platform) return false;
  if (filter.timeControl !== 'all' && timeControlKind(game.timeControl, game.timeClass) !== filter.timeControl) return false;
  if (!filter.days) return true;
  const date = playedAt(game);
  return !!date && Date.parse(date) >= now - filter.days * 86400000 && Date.parse(date) <= now;
}
export function statisticsFilterLabel(filter: StatisticsFilter, lang: AppLanguage = 'de'): string {
  const isEn = lang === 'en';
  const platLabels = isEn ? PLATFORM_LABELS_EN : PLATFORM_LABELS;
  const tcLabels = isEn ? TIME_CONTROL_LABELS_EN : TIME_CONTROL_LABELS;
  return [
    filter.days ? (isEn ? `Last ${filter.days} days` : `Letzte ${filter.days} Tage`) : (isEn ? 'All Time' : 'Gesamter Zeitraum'),
    filter.platform !== 'all' ? platLabels[filter.platform] : '',
    filter.timeControl !== 'all' ? tcLabels[filter.timeControl] : '',
  ].filter(Boolean).join(' · ');
}
