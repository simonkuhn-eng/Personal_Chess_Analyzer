import type { TimeControlKind } from '../types/statistics';

export const TIME_CONTROL_LABELS: Record<TimeControlKind, string> = { bullet: 'Bullet', blitz: 'Blitz', rapid: 'Schnellschach', classical: 'Klassisch', daily: 'Täglich', unknown: 'Unbekannt' };
export const TIME_CONTROL_ORDER: TimeControlKind[] = ['rapid', 'blitz', 'bullet', 'classical', 'daily', 'unknown'];

/** API speed takes precedence. Without it, estimate total time including 40 increments.
 * Staged controls are only estimated when they describe a single stage. */
export function timeControlKind(timeControl?: string, timeClass?: string): TimeControlKind {
  const speed = timeClass?.trim().toLowerCase();
  if (speed && ['bullet', 'blitz', 'rapid', 'classical', 'daily'].includes(speed)) return speed as TimeControlKind;
  if (speed === 'correspondence') return 'daily';
  const value = timeControl?.trim() || '';
  const staged = value.match(/^(\d+)\/(\d+)$/);
  let estimate: number;
  if (staged) {
    const moves = Number(staged[1]), seconds = Number(staged[2]);
    if (!moves || !seconds) return 'unknown';
    if (seconds / moves >= 43200) return 'daily';
    estimate = seconds / moves * 40;
  } else {
    const normal = value.match(/^(\d+)(?:\+(\d+))?$/);
    if (!normal || Number(normal[1]) <= 0) return 'unknown';
    estimate = Number(normal[1]) + 40 * Number(normal[2] || 0);
  }
  if (!Number.isFinite(estimate)) return 'unknown';
  return estimate < 180 ? 'bullet' : estimate < 480 ? 'blitz' : estimate < 1500 ? 'rapid' : 'classical';
}

/** Backwards-compatible labels for existing diagnostic aggregates. */
export function classifyTimeControl(timeControl?: string, timeClass?: string): string {
  const kind = timeControlKind(timeControl, timeClass);
  return kind === 'daily' ? 'Daily' : TIME_CONTROL_LABELS[kind];
}
