import type { GameMetadata } from '../types/chess';

/** Validate calendar dates, never fall back to the import timestamp. */
export function parsePlayedAt(date?: string, time?: string): string | undefined {
  if (!date || !/^\d{4}[.-]\d{2}[.-]\d{2}$/.test(date)) return undefined;
  const day = date.replaceAll('.', '-');
  const clock = time && /^\d{2}:\d{2}:\d{2}$/.test(time) ? time : '00:00:00';
  const parsed = new Date(`${day}T${clock}Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(day) ? parsed.toISOString() : undefined;
}

export function playedAt(game: Pick<GameMetadata, 'playedAt' | 'date'>): string | undefined {
  return (game.playedAt && Number.isFinite(Date.parse(game.playedAt)) ? new Date(game.playedAt).toISOString() : undefined) ?? parsePlayedAt(game.date);
}

export function migrateGameTime<T extends GameMetadata & { pgn?: string }>(game: T): T {
  const header = (key: string) => game.pgn?.match(new RegExp(`\\[${key}\\s+"([^"]+)"\\]`))?.[1];
  const timestamp = playedAt(game) ?? parsePlayedAt(header('UTCDate'), header('UTCTime'));
  // Prefer explicit UTC PGN time over date-only legacy values.
  const actual = (game.playedAt && Number.isFinite(Date.parse(game.playedAt)) ? new Date(game.playedAt).toISOString() : undefined) || parsePlayedAt(header('UTCDate') || header('Date'), header('UTCTime')) || timestamp;
  return actual && actual !== game.playedAt ? { ...game, playedAt: actual } : game;
}
