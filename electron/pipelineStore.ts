// Phase 6 (Welle 2): generische Persistenz-Schicht für die Plattform-Pipelines
// (chess.com + Lichess). Status-Maschine und Job-Datei-Handhabung sind
// plattformneutral — nur der Speicherpfad unterscheidet sich. Jede Plattform
// bekommt ihre eigene jobs.json (kein geteilter Zustand).
// - Jobs in userData/<plattform>_jobs.json (atomar via jsonStore)
// - App-Neustart: resumeStaleJobsIn setzt 'analyzing' → 'queued' (Cursor bleibt)
// - Ablauf: createJob → claimNextJobFrom (Renderer-Driver) → pro Partie
//   Analyse + Save + markJobIn → 'saved'. Ein Analysefehler markiert 'failed'
//   OHNE die bereits gespeicherten Partien zu verlieren (Cursor bleibt).
import fs from 'node:fs';
import { writeJsonFileAtomic } from './jsonStore';
import {
  applyJobPatch,
  emptyPipelineData,
  nextQueuedJob,
  type JobPatch,
  type PipelineData,
  type PipelineJob,
} from './chesscomPipelineCore';

/** knownIds wachsen mit — hartes Limit gegen unbegrenzte Datei. */
export const KNOWN_IDS_CAP = 5000;

export function readPipelineFile(filePath: string): PipelineData {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.jobs)) return emptyPipelineData();
    return {
      version: 1,
      knownIds: Array.isArray(raw.knownIds)
        ? raw.knownIds.filter((id: unknown): id is string => typeof id === 'string')
        : [],
      lastSync: raw.lastSync,
      jobs: raw.jobs.filter((job: unknown): job is PipelineJob => !!job && typeof (job as PipelineJob).id === 'string'),
    };
  } catch {
    // Fehlende/kaputte Jobs-Datei: Pipeline leer — games_db.json bleibt unberührt.
    return emptyPipelineData();
  }
}

export function writePipelineFile(filePath: string, data: PipelineData): void {
  writeJsonFileAtomic(filePath, data);
}

function pushKnownIds(data: PipelineData, ids: string[]): void {
  for (const id of ids) {
    if (!data.knownIds.includes(id)) data.knownIds.push(id);
  }
  if (data.knownIds.length > KNOWN_IDS_CAP) {
    data.knownIds = data.knownIds.slice(data.knownIds.length - KNOWN_IDS_CAP);
  }
}

/** Genau ein Job pro Claim — kein Doppel-Claim paralleler Driver-Läufe. */
export function claimNextJobFrom(filePath: string): PipelineJob | null {
  const data = readPipelineFile(filePath);
  const job = nextQueuedJob(data.jobs);
  if (!job) return null;
  job.status = 'analyzing';
  job.updatedAt = Date.now();
  // Quell-IDs ab Claim als bekannt markieren — selbst wenn die Analyse
  // später abbricht (Resume macht dort weiter, kein Doppel-Claim).
  pushKnownIds(data, job.games.map((game) => game.sourceId));
  writePipelineFile(filePath, data);
  return job;
}

export function markJobIn(filePath: string, id: string, patch: JobPatch): PipelineJob | null {
  const data = readPipelineFile(filePath);
  const job = data.jobs.find((entry) => entry.id === id);
  if (!job) return null;
  applyJobPatch(job, patch, Date.now());
  if (job.status === 'saved') {
    data.lastSync = {
      username: job.username,
      at: job.updatedAt,
      savedCount: job.savedCount,
      failedCount: job.failedCount,
      newCount: job.savedCount,
    };
  }
  writePipelineFile(filePath, data);
  return job;
}

export function cancelJobIn(filePath: string, id: string): PipelineJob | null {
  const data = readPipelineFile(filePath);
  const job = data.jobs.find((entry) => entry.id === id);
  if (!job) return null;
  if (job.status === 'queued' || job.status === 'failed') {
    applyJobPatch(job, { status: 'cancelled' }, Date.now());
    writePipelineFile(filePath, data);
  }
  // 'analyzing' bricht der Renderer über shouldCancel ab und markiert selbst.
  return job;
}

/** App-Start: hängengebliebene Analysen fortsetzen. */
export function resumeStaleJobsIn(filePath: string): void {
  const data = readPipelineFile(filePath);
  let changed = false;
  for (const job of data.jobs) {
    if (job.status === 'analyzing') {
      job.status = 'queued';
      job.updatedAt = Date.now();
      changed = true;
    }
  }
  if (changed) writePipelineFile(filePath, data);
}
