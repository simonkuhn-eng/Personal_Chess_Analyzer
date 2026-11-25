import { profileNamespace } from './profile';
import { readLearningItem, writeLearningItem } from './learningStorage';
/**
 * T15: Gemeinsame, lokale Review-Persistenz für ALLE Trainingsformate
 * (Fehlerkarten-Deck, Partie-Training, Repertoire-Abweichungen).
 *
 * Deterministisches, einfaches Wiederholungsmodell:
 * - faellige richtige Antwort      → nächstes Intervall (1/3/7/14/30 Tage)
 * - verpasste/unterstützte Antwort (Hinweis, Lösung gezeigt) → kurze
 *   Wiederholung (10 Minuten), ohne das Intervall zu verlängern
 * - unabhängiger Fehlversuch       → zurück auf kurze Wiederholung, Lapse
 * - Engine-/Technikfehler          → zählt NICHT (Aufrufer ruft applyReview
 *   dafür schlicht nicht auf)
 *
 * Die Zeit ist injizierbar (nowMs), damit Tests reproduzierbar sind.
 * Persistenz pro Profil (localStorage-Namespace mit Spielername) — niemals
 * global, damit Profilwechsel den Fortschritt nicht mischen.
 */

import type { ReviewScheduleConfig } from '../types/chess';

export type ReviewOutcome = 'correct' | 'help' | 'wrong';

export interface ReviewEntry {
  /** Stabile Karten-ID — z. B. `${stableGameId}:${ply}` oder Repertoire-Zweig-Key. */
  key: string;
  /** Nächste Fälligkeit (ms epoch). */
  dueAt: number;
  /** Index in INTERVALS_MS (0 = kurze Wiederholung). */
  intervalIdx: number;
  lapses: number;
  /** Nutzungen von Hinweis/Lösung (unterstützte Antworten). */
  helps: number;
  /** Unabhängige Antworten (ohne Reveal/Hilfe). */
  attempts: number;
  /** Unabhängige richtige Antworten. */
  correct: number;
  /** Successful recalls when actually due, not repeated clicks in one session. */
  spacedCorrect?: number;
  lastResult?: ReviewOutcome;
  lastReviewedAt?: number;
  lastDurationMs?: number;
  /** Aus Legacy-Storage (solvedKeys / Meisterschaftszähler) migriert — ohne erfundene Historie. */
  legacy?: boolean;
}

export interface ReviewStore {
  version: 1;
  reviews: Record<string, ReviewEntry>;
}

/** Kurze Wiederholung + Intervalltreppe (deterministisch, wie im Audit vorgegeben). */
export const INTERVALS_MS = [
  10 * 60 * 1000, // 10 Minuten — kurze Wiederholung
  1 * 24 * 60 * 60 * 1000,
  3 * 24 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
  14 * 24 * 60 * 60 * 1000,
  30 * 24 * 60 * 60 * 1000,
];

// ── Phase 6: konfigurierbare Wiederholungsabstände (Brief-Punkt 6) ──
const DAY_MS = 24 * 60 * 60 * 1000;
/** Minimale Stufe = 10 Minuten (konsistent mit normalizeTrainingSchedule). */
const MIN_INTERVAL_MS = 10 * 60 * 1000;
/** Preset-Leitern in Tagen — normal = bestehende INTERVALS_MS (Vertrag). */
export const REVIEW_PRESET_DAYS = {
  frequent: [10 / 1440, 1, 2, 4, 7, 14],
  normal: [10 / 1440, 1, 3, 7, 14, 30],
  relaxed: [10 / 1440, 2, 5, 10, 21, 45],
} as const;

/** Pure Leiter-Berechnung aus einer Schedule (UI-Vorschau + Persistenz). */
export function scheduleIntervalsMs(schedule?: ReviewScheduleConfig | null): number[] {
  if (schedule?.mode === 'custom' && schedule.intervalsDays?.length) {
    return schedule.intervalsDays.map((d) => Math.max(MIN_INTERVAL_MS, Math.round(d * DAY_MS)));
  }
  const preset = schedule?.preset ?? 'normal';
  return REVIEW_PRESET_DAYS[preset].map((d) => Math.round(d * DAY_MS));
}

let activeIntervalsMs = INTERVALS_MS;

/** App setzt die aktive Leiter bei Settings-Load/Save (alle Trainingsformate). */
export function setReviewSchedule(schedule?: ReviewScheduleConfig | null): void {
  activeIntervalsMs = scheduleIntervalsMs(schedule);
}

export function getActiveIntervalsMs(): number[] {
  return activeIntervalsMs;
}

/**
 * Explizite Neuberechnung (Brief: Preset-Wechsel ändert bestehende Fälligkeiten
 * NICHT von selbst): dueAt = lastReviewedAt + aktive Stufe des jeweiligen
 * Eintrags (Stufe-Index wird auf die aktive Leiter geklemmt). Rückgabe: Anzahl.
 */
export function recalculateDueAts(store: ReviewStore, schedule?: ReviewScheduleConfig | null, nowMs: number = Date.now()): number {
  const intervals = scheduleIntervalsMs(schedule);
  let changed = 0;
  for (const entry of Object.values(store.reviews)) {
    const idx = Math.max(0, Math.min(intervals.length - 1, entry.intervalIdx));
    const base = typeof entry.lastReviewedAt === 'number' ? entry.lastReviewedAt : nowMs;
    const nextDue = base + (entry.lastResult === 'help' || entry.lastResult === 'wrong' ? MIN_INTERVAL_MS : intervals[idx]);
    if (entry.dueAt !== nextDue || entry.intervalIdx !== idx) {
      entry.dueAt = nextDue;
      entry.intervalIdx = idx;
      changed++;
    }
  }
  return changed;
}

export function reviewsStorageKey(playerName: string): string {
  return `personal-chess-analyzer-reviews-v1:${profileNamespace(playerName)}`;
}

function emptyStore(): ReviewStore {
  return { version: 1, reviews: {} };
}

export function loadReviews(playerName: string): ReviewStore {
  try {
    const raw = JSON.parse(readLearningItem(reviewsStorageKey(playerName)) || '');
    if (!raw || typeof raw !== 'object' || !raw.reviews || typeof raw.reviews !== 'object') return emptyStore();
    const reviews: Record<string, ReviewEntry> = {};
    for (const [key, value] of Object.entries(raw.reviews as Record<string, unknown>)) {
      const entry = value as Partial<ReviewEntry>;
      if (typeof entry?.dueAt !== 'number' || typeof entry?.intervalIdx !== 'number') continue;
      reviews[key] = {
        key,
        dueAt: entry.dueAt,
        intervalIdx: Math.max(0, Math.min(7, entry.intervalIdx)), // max 8 Stufen (custom), kein Fortschritts-Verlust
        lapses: entry.lapses || 0,
        helps: entry.helps || 0,
        attempts: entry.attempts || 0,
        correct: entry.correct || 0,
        spacedCorrect: entry.spacedCorrect || 0,
        lastResult: entry.lastResult,
        lastReviewedAt: entry.lastReviewedAt,
        lastDurationMs: entry.lastDurationMs,
        legacy: entry.legacy,
      };
    }
    return { version: 1, reviews };
  } catch {
    return emptyStore();
  }
}

export function saveReviews(playerName: string, store: ReviewStore): boolean {
  return writeLearningItem(reviewsStorageKey(playerName), JSON.stringify(store));
}

export function getReview(store: ReviewStore, key: string): ReviewEntry | undefined {
  return store.reviews[key];
}

/**
 * Deterministisch: Review-Ergebnis anwenden und zurückgeben.
 * - correct: Intervall +1 (max. 30 Tage), attempts/correct++
 * - help:    Beherrschung zuruecksetzen, kurze Wiederholung, helps++
 * - wrong:   zurück auf kurze Wiederholung, Lapse, attempts++
 */
export function applyReview(
  store: ReviewStore,
  key: string,
  outcome: ReviewOutcome,
  nowMs: number = Date.now(),
  durationMs?: number
): ReviewEntry {
  const existing = store.reviews[key];
  const intervals = getActiveIntervalsMs();
  const entry: ReviewEntry = existing
    ? { ...existing }
    : { key, dueAt: nowMs, intervalIdx: 0, lapses: 0, helps: 0, attempts: 0, correct: 0 };

  entry.lastResult = outcome;
  entry.lastReviewedAt = nowMs;
  if (durationMs !== undefined) entry.lastDurationMs = durationMs;

  if (outcome === 'correct') {
    entry.attempts += 1;
    entry.correct += 1;
    if (!existing || existing.dueAt <= nowMs) {
      entry.spacedCorrect = (entry.spacedCorrect || 0) + 1;
      entry.intervalIdx = Math.min(intervals.length - 1, entry.intervalIdx + 1);
      entry.dueAt = nowMs + intervals[entry.intervalIdx];
    }
  } else if (outcome === 'help') {
    entry.helps += 1;
    entry.spacedCorrect = 0;
    entry.intervalIdx = 0;
    entry.dueAt = nowMs + MIN_INTERVAL_MS;
  } else {
    entry.attempts += 1;
    entry.lapses += 1;
    entry.spacedCorrect = 0;
    entry.intervalIdx = 0;
    entry.dueAt = nowMs + MIN_INTERVAL_MS;
  }

  store.reviews[key] = entry;
  return entry;
}

/**
 * Migration: bestehende "gelöst"-Keys werden als Legacy-Reviews mit dem
 * Intervall "7 Tage" übernommen — bewusst OHNE drei beherrschte Wiederholungen
 * zu erfinden (attempts/correct bleiben 0, Historie leer). Rückgabe: Anzahl.
 */
export function migrateLegacySolved(store: ReviewStore, keys: readonly string[], nowMs: number = Date.now()): number {
  let migrated = 0;
  for (const key of keys) {
    if (!key || store.reviews[key]) continue;
    store.reviews[key] = {
      key,
      dueAt: nowMs + INTERVALS_MS[3],
      intervalIdx: 3,
      lapses: 0,
      helps: 0,
      attempts: 0,
      correct: 0,
      legacy: true,
    };
    migrated++;
  }
  return migrated;
}

/**
 * R07: Review-Keys an migrierte Partie-IDs anpassen. Ein Schlüssel
 * `${legacyId}:${ply}` wird über die explizite ID-Zuordnung (previousIds)
 * unter der aktuellen Partie-ID gespeichert — Werte bleiben unverändert.
 * Legacy-Keys bleiben bestehen (nichts wird gelöscht → nichts zu verlieren);
 * idempotent, Rückgabe: Anzahl übernommener Einträge.
 */
export function migrateGameIdKeys(store: ReviewStore, idMap: Record<string, string>): number {
  let migrated = 0;
  for (const entry of Object.values(store.reviews)) {
    const sep = entry.key.lastIndexOf(':');
    if (sep <= 0) continue;
    const gameId = entry.key.slice(0, sep);
    const currentId = idMap[gameId];
    if (!currentId || currentId === gameId) continue;
    const newKey = `${currentId}${entry.key.slice(sep)}`;
    if (!store.reviews[newKey]) {
      store.reviews[newKey] = { ...entry, key: newKey };
      migrated++;
    }
  }
  return migrated;
}

/** Fällig (inkl. überfällig)? Neue Karten (ohne Eintrag) sind immer fällig. */
export function isDue(entry: ReviewEntry | undefined, nowMs: number = Date.now()): boolean {
  if (!entry) return true;
  return entry.dueAt <= nowMs;
}

/** Mastery requires independent spaced recalls and the final interval. */
export function isMastered(entry: ReviewEntry | undefined): boolean {
  return !!entry && entry.lastResult === 'correct' && (entry.spacedCorrect || 0) >= Math.max(3, getActiveIntervalsMs().length - 1) &&
    entry.intervalIdx >= getActiveIntervalsMs().length - 1;
}

/** Menschenlesbare Fälligkeit ("in 3 Tagen", "heute", "überfällig"). */
export function formatDueIn(entry: ReviewEntry | undefined, nowMs: number = Date.now()): string {
  if (!entry) return 'neu';
  const diff = entry.dueAt - nowMs;
  if (diff <= 0) return 'jetzt fällig';
  const minutes = Math.round(diff / 60000);
  if (minutes < 60) return `in ${minutes} Min.`;
  const days = Math.round(diff / 86400000);
  if (days < 1) return `in ${Math.round(diff / 3600000)} Std.`;
  return `in ${days} Tag${days === 1 ? '' : 'en'}`;
}

/** Legacy-Storage (gelöste Karten des Decks) lesen — für die Migration. */
export function readLegacySolvedKeys(storageKey: string): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) || '[]');
    return Array.isArray(stored) ? stored.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}
