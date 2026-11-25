// T16: reine Kernlogik der chess.com-Pipeline — bewusst OHNE Electron-Imports,
// damit die Regressionstests (tsx/Node) das Modul direkt laden können.
// Job-Zustände: discovered → queued → analyzing → saved | failed | cancelled.
import type { ChessComGameSummary } from './chesscom';

export type PipelineJobStatus = 'queued' | 'analyzing' | 'saved' | 'failed' | 'cancelled';

export interface PipelineJobGame {
  playedAt?: string;
  /** Eindeutige Quell-ID (uuid/url/Fallback) — Dedup VOR der teuren Analyse. */
  sourceId: string;
  pgn: string;
}

export interface PipelineJob {
  id: string;
  username: string;
  status: PipelineJobStatus;
  games: PipelineJobGame[];
  /** Nächste zu analysierende Partie — Fortsetzung nach Fehler/Neustart. */
  cursor: number;
  savedCount: number;
  failedCount: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PipelineLastSync {
  username: string;
  at: number;
  savedCount: number;
  failedCount: number;
  newCount: number;
}

export interface PipelineData {
  version: 1;
  knownIds: string[];
  lastSync?: PipelineLastSync;
  jobs: PipelineJob[];
}

/** Renderer-Patch: Zähler als Deltas, Cursor absolut, Requeue guarded. */
export interface JobPatch {
  savedDelta?: number;
  failedDelta?: number;
  cursorSet?: number;
  status?: PipelineJobStatus;
  lastError?: string;
}

export function emptyPipelineData(): PipelineData {
  return { version: 1, knownIds: [], jobs: [] };
}

/**
 * Patch anwenden (pur). Requeue ('queued') ist NUR aus 'analyzing' erlaubt —
 * fertige/fehlgeschlagene/abgebrochene Jobs können vom Renderer nicht
 * versehentlich neu gestartet werden.
 */
export function applyJobPatch(job: PipelineJob, patch: JobPatch, nowMs: number): void {
  if (patch.savedDelta) job.savedCount += patch.savedDelta;
  if (patch.failedDelta) job.failedCount += patch.failedDelta;
  if (patch.cursorSet !== undefined) job.cursor = Math.max(0, Math.min(job.games.length, patch.cursorSet));
  if (patch.status) {
    // T22: unbekannte Status-Werte ignorieren — Renderer-Typen sind keine
    // Laufzeitvalidierung, die jobs-Datei bleibt schema-konform.
    const validStatuses: PipelineJobStatus[] = ['queued', 'analyzing', 'saved', 'failed', 'cancelled'];
    if (!validStatuses.includes(patch.status)) return;
    if (patch.status === 'queued' && job.status !== 'analyzing' && job.status !== 'failed') {
      // Requeue abgelehnt (queued/saved/cancelled bleiben) — Status bleibt.
      // R05: Nur aus 'analyzing' (Driver-Restart) UND 'failed' (expliziter
      // Retry) darf ein Job zurück in die Warteschlange.
    } else {
      job.status = patch.status;
    }
  }
  if (patch.lastError !== undefined) job.lastError = patch.lastError;
  job.updatedAt = nowMs;
}

/**
 * Monate, die das Zeitfenster [now - days, now] schneidet — überlappend und
 * idempotent (T16): Monatsgrenzen werden doppelt geladen, Dedup passiert
 * über die Quell-ID.
 */
export function monthsForWindow(nowMs: number, daysWindow: number): { year: number; month: number }[] {
  const days = Math.max(1, Math.floor(daysWindow));
  const start = new Date(nowMs - days * 86_400_000);
  const end = new Date(nowMs);
  const months: { year: number; month: number }[] = [];
  let year = start.getFullYear();
  let month = start.getMonth() + 1;
  while (year < end.getFullYear() || (year === end.getFullYear() && month <= end.getMonth() + 1)) {
    months.push({ year, month });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

/** Nur abgeschlossene, unterstützte Standardpartien — Varianten/in-progress ausnehmen. */
export function isSupportedGame(summary: ChessComGameSummary): boolean {
  if (summary.rules !== undefined && summary.rules !== 'chess') return false;
  if (!summary.pgn) return false;
  if (!summary.endTime) return false; // in-progress hat keine end_time
  return true;
}

/**
 * R06: Discovery-Fensterfilter — Partien aus überlappenden Grenzmonaten, die
 * ÄLTER als das gewünschte Zeitfenster sind, werden nicht eingesammelt.
 * 1 Tag Puffer für Zeitzonen-/Monatsgrenz-Sonderfälle.
 */
export function withinDiscoveryWindow(summary: ChessComGameSummary, nowMs: number, daysWindow: number): boolean {
  if (!summary.endTime) return false; // isSupportedGame filtert das bereits — defensiv
  // Chess.com API liefert end_time in Unix-Sekunden (< 1e12), Test-/Alt-Inputs teils in ms.
  const endTimeMs = summary.endTime < 1e12 ? summary.endTime * 1000 : summary.endTime;
  return nowMs - endTimeMs <= (daysWindow + 1) * 86_400_000;
}

/**
 * R05/R06: Discovery-Ergebnis in den AKTUELLEN Pipeline-Stand mergen (pur,
 * testbar) — statt einen veralteten Snapshot zurückzuschreiben:
 * - aktiver ODER fehlgeschlagener Job desselben Spielers wird WIEDERAUFGENOMMEN
 *   (failed→queued, lastError gelöscht, cursor erhalten, neue Spiele hinten
 *   angehängt) — die im failed-Job verbliebenen Partien gehen nicht verloren;
 * - nur abgeschlossene Jobs (saved/cancelled) desselben Spielers führen zu
 *   einer Neuanlage;
 * - discovered-Games sind vom Aufrufer bereits gegen den frischen knownIds-
 *   Stand dedupliziert.
 */
export function mergeDiscoveryIntoPipeline(
  data: PipelineData,
  cleanName: string,
  discoveredGames: PipelineJobGame[],
  nowMs: number,
): { job: PipelineJob; created: boolean } {
  const byName = (j: PipelineJob) => j.username.toLowerCase() === cleanName.toLowerCase();
  const resumable = data.jobs.find(
    (j) => byName(j) && (j.status === 'queued' || j.status === 'analyzing' || j.status === 'failed'),
  );
  if (resumable) {
    resumable.status = 'queued';
    resumable.lastError = undefined;
    const known = new Set(resumable.games.map((g) => g.sourceId));
    for (const g of discoveredGames) {
      if (!known.has(g.sourceId)) {
        resumable.games.push(g);
        known.add(g.sourceId);
      }
    }
    resumable.updatedAt = nowMs;
    return { job: resumable, created: false };
  }
  const job: PipelineJob = {
    id: `job_${nowMs.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    username: cleanName,
    status: 'queued',
    games: [...discoveredGames],
    cursor: 0,
    savedCount: 0,
    failedCount: 0,
    createdAt: nowMs,
    updatedAt: nowMs,
  };
  data.jobs.push(job);
  return { job, created: true };
}

/** Eindeutige Quell-ID VOR der teuren Analyse: uuid → url → Fallback-Hash. */
export function sourceIdOf(summary: ChessComGameSummary): string {
  if (summary.uuid) return `uuid:${summary.uuid}`;
  if (summary.url) return `url:${summary.url}`;
  return `hash:${summary.white}|${summary.black}|${summary.endTime}|${summary.pgn.length}`;
}

/** Ältester queued-Job (atomar per Claim im Main-Prozess). */
export function nextQueuedJob(jobs: PipelineJob[]): PipelineJob | null {
  const queued = jobs.filter((job) => job.status === 'queued').sort((a, b) => a.createdAt - b.createdAt);
  return queued[0] || null;
}
