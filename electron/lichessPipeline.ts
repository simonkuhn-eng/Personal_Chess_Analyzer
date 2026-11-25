// Phase 6 (Welle 2): persistierte Lichess-Pipeline (Main-Prozess) —
// Spiegel von chesscomPipeline.ts mit eigener Datei (lichess_jobs.json),
// eigenem Abruf (EIN ndjson-Request statt Monatsloop) und der geteilten
// Status-Maschine (chesscomPipelineCore.ts + pipelineStore.ts).
// Ablauf wie chess.com: createLichessJob → claimNextLichessJob
// (Renderer-Driver) → Analyse + Save + markLichessJob → 'saved'.
import { app } from 'electron';
import path from 'node:path';
import { fetchLichessGames, isSupportedLichessGame, withinLichessWindow } from './lichess';
import {
  mergeDiscoveryIntoPipeline,
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

const pipelineFilePath = (): string => path.join(app.getPath('userData'), 'lichess_jobs.json');

export function readLichessPipeline(): PipelineData {
  return readPipelineFile(pipelineFilePath());
}

export async function createLichessJob(username: string, daysWindow: number): Promise<{ job: PipelineJob; created: boolean }> {
  const cleanName = username.trim();
  if (!cleanName) throw new Error('Kein Lichess-Benutzername angegeben.');
  const days = Math.max(1, Math.min(365, Math.floor(daysWindow) || 30));
  const nowMs = Date.now();
  const sinceMs = nowMs - days * 86_400_000;

  // R06-Analog: Discovery läuft OHNE Pipeline-Schreibzugriff (Netzwerk kann
  // lange dauern) — währenddessen bleiben Driver-Claims/Patches unangetastet.
  const knownAtStart = new Set(readLichessPipeline().knownIds);
  const fetched = await fetchLichessGames(cleanName, sinceMs);
  const discovered: PipelineJobGame[] = [];
  for (const summary of fetched) {
    if (!isSupportedLichessGame(summary)) continue;
    if (!withinLichessWindow(summary.endedAt, nowMs, days)) continue; // Grenzfälle — keine zu-alten Partien
    if (knownAtStart.has(summary.sourceId)) continue; // eindeutige Quell-ID VOR der teuren Analyse
    knownAtStart.add(summary.sourceId);
    discovered.push({ sourceId: summary.sourceId, pgn: summary.pgn, playedAt: new Date(summary.endedAt).toISOString() });
  }

  // R05/R06-Analog: Merge synchron/event-loop-atomar mit FRISCHEM Stand.
  const data = readLichessPipeline();
  const freshKnown = new Set(data.knownIds);
  const games = discovered.filter((game) => !freshKnown.has(game.sourceId));
  for (const game of games) {
    if (!data.knownIds.includes(game.sourceId)) data.knownIds.push(game.sourceId);
  }
  if (data.knownIds.length > KNOWN_IDS_CAP) {
    data.knownIds = data.knownIds.slice(data.knownIds.length - KNOWN_IDS_CAP);
  }
  const merged = mergeDiscoveryIntoPipeline(data, cleanName, games, nowMs);
  writePipelineFile(pipelineFilePath(), data);
  return { job: merged.job, created: merged.created };
}

/** Genau ein Job pro Claim — kein Doppel-Claim paralleler Driver-Läufe. */
export function claimNextLichessJob(): PipelineJob | null {
  return claimNextJobFrom(pipelineFilePath());
}

export function markLichessJob(id: string, patch: JobPatch): PipelineJob | null {
  return markJobIn(pipelineFilePath(), id, patch);
}

export function cancelLichessJob(id: string): PipelineJob | null {
  return cancelJobIn(pipelineFilePath(), id);
}

/** App-Start: hängengebliebene Analysen fortsetzen. */
export function resumeStaleLichessJobs(): void {
  resumeStaleJobsIn(pipelineFilePath());
}
