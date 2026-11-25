import type { MoveAnalysis, MoveQuality } from '../types/chess';
import { moveCategory, reviewBadgeQuality } from './analysis';
import { getActiveLanguage } from './i18n';

export const QUALITY_ORDER: MoveQuality[] = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'miss', 'blunder'];
const labelsDe: Record<MoveQuality, string> = { brilliant: 'Brillant', great: 'Großartig', best: 'Bester Zug', excellent: 'Exzellent', good: 'Gut', book: 'Buch', inaccuracy: 'Ungenauigkeit', mistake: 'Fehler', miss: 'Verpasste Chance', blunder: 'Patzer' };
const labelsEn: Record<MoveQuality, string> = { brilliant: 'Brilliant', great: 'Great', best: 'Best Move', excellent: 'Excellent', good: 'Good', book: 'Book', inaccuracy: 'Inaccuracy', mistake: 'Mistake', miss: 'Missed Win', blunder: 'Blunder' };
export function qualityAppearance(quality: MoveQuality) {
  const safe = QUALITY_ORDER.includes(quality) ? quality : 'good';
  const labels = getActiveLanguage() === 'en' ? labelsEn : labelsDe;
  return { quality: safe, label: labels[safe], color: 'var(--color-' + safe + ')', foreground: '#ffffff' };
}

/** Preserve errors on annotated book moves; count each played move exactly once. */
export function reviewQualityCounts(moves: MoveAnalysis[]) {
  const white = Object.fromEntries(QUALITY_ORDER.map(quality => [quality, 0])) as Record<MoveQuality, number>;
  const black = { ...white };
  for (const move of moves) {
    const category = moveCategory(move);
    const quality = ['brilliant', 'inaccuracy', 'mistake', 'miss', 'blunder'].includes(category) ? category : reviewBadgeQuality(move);
    if (quality in white) (move.color === 'w' ? white : black)[quality]++;
  }
  return { white, black };
}
