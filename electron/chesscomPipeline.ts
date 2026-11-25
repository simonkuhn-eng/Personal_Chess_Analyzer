// T16: persistierte chess.com-Pipeline (Main-Prozess).
// - Discovery: Monatsarchive serial laden, neue Standardpartien extrahieren
// - Jobs in userData/chesscom_jobs.json (atomar via jsonStore; generische
//   Schicht pipelineStore.ts — Phase 6, plattformneutral)
// - App-Neustart: resumeStaleJobs setzt 'analyzing' → 'queued' (Cursor bleibt)
// - Ablauf: createJob → claimNextJob (Renderer-Driver) → pro Partie Analyse +
//   Save + markJob → 'saved'. Ein Analysefehler markiert 'failed' OHNE die
//   bereits gespeicherten Partien zu verlieren (Cursor bleibt für Retry).
import { app } from 'electron';
import path from 'node:path';
import { fetchMonthlyGames } from './chesscom';
import {
  applyJobPatch,
  emptyPipelineData,
  isSupportedGame,
  mergeDiscoveryIntoPipeline,
  monthsForWindow,
  nextQueuedJob,
  sourceIdOf,
  withinDiscoveryWindow,
  type JobPatch,
  type PipelineData,
  type PipelineJob,
  type PipelineJobGame,
} from './chesscomPipelineCore';
import {
  KNOWN_IDS_CAP,
  cancelJobIn,
  claimNextJobFrom,
  markJobIn,
  readPipelineFile,
  resumeStaleJobsIn,
  writePipelineFile,
} from './pipelineStore';

const pipelineFilePath = (): string => path.join(app.getPath('userData'), 'chesscom_jobs.json');

export function readPipeline(): PipelineData {
  return readPipelineFile(pipelineFilePath());
}

export function writePipeline(data: PipelineData): void {
  writePipelineFile(pipelineFilePath(), data);
}

export async function createJob(username: string, daysWindow: number): Promise<{ job: PipelineJob; created: boolean }> {
  const cleanName = username.trim();
  if (!cleanName) throw new Error('Kein chess.com-Benutzername angegeben.');
  const days = Math.max(1, Math.min(365, Math.floor(daysWindow) || 30));

  // R06: Discovery läuft OHNE Pipeline-Schreibzugriff (Netzwerk kann lange
  // dauern) — währenddessen bleiben Driver-Claims/Patches unangetastet.
  const months = monthsForWindow(Date.now(), days);
  const knownAtStart = new Set(readPipeline().knownIds);
  const discovered: PipelineJobGame[] = [];
  for (const { year, month } of months) {
    const summaries = await fetchMonthlyGames(cleanName, year, month);
    for (const summary of summaries) {
      if (!isSupportedGame(summary)) continue;
      if (!withinDiscoveryWindow(summary, Date.now(), days)) continue; // R06: Grenzmonate — keine zu-alten Partien
      const id = sourceIdOf(summary);
      if (knownAtStart.has(id)) continue; // eindeutige Quell-ID VOR der teuren Analyse
      knownAtStart.add(id);
      discovered.push({ sourceId: id, pgn: summary.pgn, playedAt: summary.endTime ? new Date(summary.endTime * 1000).toISOString() : undefined });
    }
  }

  // R05/R06: Merge mit FRISCHEM Stand — diese Sektion ist synchron und damit
  // event-loop-atomar (kein Lost-Update mehr gegen Driver-Claims/Patches,
  // die während der Discovery liefen). Fehlgeschlagene Jobs werden
  // wiederaufgenommen (Resume, cursor erhalten), nicht als Wrack stehen
  // gelassen und nicht durch eine Neuanlage ersetzt, die die verbliebenen
  // Partien wegen knownIds nie nachholen könnte.
  const data = readPipeline();
  const freshKnown = new Set(data.knownIds);
  const games = discovered.filter((game) => !freshKnown.has(game.sourceId));
  // Quell-IDs ab jetzt als bekannt markieren — auch wenn die Analyse später
  // abbricht (claimNextJob markierte bislang erst beim Claim).
  for (const game of games) {
    if (!data.knownIds.includes(game.sourceId)) data.knownIds.push(game.sourceId);
  }
  if (data.knownIds.length > KNOWN_IDS_CAP) {
    data.knownIds = data.knownIds.slice(data.knownIds.length - KNOWN_IDS_CAP);
  }
  const merged = mergeDiscoveryIntoPipeline(data, cleanName, games, Date.now());
  writePipeline(data);
  return { job: merged.job, created: merged.created };
}

/** Genau ein Job pro Claim — kein Doppel-Claim paralleler Driver-Läufe. */
export function claimNextJob(): PipelineJob | null {
  return claimNextJobFrom(pipelineFilePath());
}

export function markJob(id: string, patch: JobPatch): PipelineJob | null {
  return markJobIn(pipelineFilePath(), id, patch);
}

export function cancelJob(id: string): PipelineJob | null {
  return cancelJobIn(pipelineFilePath(), id);
}

/** App-Start: hängengebliebene Analysen fortsetzen. */
export function resumeStaleJobs(): void {
  resumeStaleJobsIn(pipelineFilePath());
}
