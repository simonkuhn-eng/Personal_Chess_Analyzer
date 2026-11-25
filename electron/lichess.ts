// Phase 6 (Welle 2): Lichess-Abruf aus der öffentlichen Lichess-API
// (https://lichess.org/api/games/user/<user>). Läuft im Main-Prozess
// (kein CORS, korrekter User-Agent). EIN ndjson-Request enthält ALLE
// Partien seit `sinceMs` (max begrenzt) — kein Monatsloop nötig.
// Rate-Limit: 429 wird vom geteilten fetchJsonWithBackoff (chess.com) mit
// Backoff/Retry-After behandelt; dedizierte Lichess-Fehlermeldungen danach.
import { fetchJsonWithBackoff } from './chesscom';

export interface LichessGameSummary {
  /** Eindeutige Lichess-Partie-ID (Deduplizierung VOR der teuren Analyse). */
  sourceId: string;
  pgn: string;
  /** ms epoch (lastMoveAt, Fallback createdAt). */
  endedAt: number;
  variant: string;
  status: string;
  white: string;
  black: string;
}

interface LichessApiGame {
  id?: string;
  variant?: string;
  status?: string;
  createdAt?: number;
  lastMoveAt?: number;
  pgn?: string;
  players?: {
    white?: { user?: { name?: string } };
    black?: { user?: { name?: string } };
  };
}

const USER_AGENT = 'PersonalChessAnalyzer/1.0 (personal chess analysis tool)';

/** Abgeschlossene Partien (kein cheat/noStart/variantEnd/aborted/playing). */
const FINISHED_STATUSES = new Set([
  'mate',
  'resign',
  'outoftime',
  'draw',
  'stalemate',
  'fifty',
  'insufficient',
  'timeout',
  'unknownFinish',
]);

export function isSupportedLichessGame(summary: LichessGameSummary): boolean {
  if (summary.variant !== undefined && summary.variant !== 'standard') return false;
  if (!summary.pgn) return false;
  if (!summary.endedAt) return false;
  return FINISHED_STATUSES.has(summary.status);
}

/** R06-Analog: Fensterfilter — Grenz-Überschneidungen nicht einsammeln. */
export function withinLichessWindow(endedAt: number, nowMs: number, daysWindow: number): boolean {
  if (!endedAt) return false;
  return nowMs - endedAt <= (daysWindow + 1) * 86_400_000;
}

export async function fetchLichessGames(username: string, sinceMs: number, max?: number): Promise<LichessGameSummary[]> {
  const cleanName = username.trim();
  if (!cleanName) throw new Error('Kein Lichess-Benutzername angegeben.');
  // Omit max to download the complete selected window (official API contract).
  // https://github.com/lichess-org/api/blob/master/doc/specs/tags/games/api-games-user-username.yaml
  const maxQuery = max === undefined ? '' : `&max=${Math.max(1, Math.floor(max) || 100)}`;
  const url =
    `https://lichess.org/api/games/user/${encodeURIComponent(cleanName)}` +
    `?since=${Math.floor(sinceMs)}&until=${Date.now()}${maxQuery}&pgnInJson=true&opening=false&clocks=false&evals=false`;

  const response = await fetchJsonWithBackoff(url, 'application/x-ndjson');

  if (response.status === 404) {
    throw new Error(`Lichess-Account "${cleanName}" wurde nicht gefunden.`);
  }
  if (response.status === 429) {
    throw new Error('Lichess hat die Anfrage gedrosselt (429). Bitte später erneut versuchen.');
  }
  if (!response.ok) {
    throw new Error(`Lichess-Partieliste konnte nicht geladen werden (HTTP ${response.status}).`);
  }

  const text = await response.text();
  const summaries: LichessGameSummary[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let game: LichessApiGame;
    try {
      game = JSON.parse(trimmed) as LichessApiGame;
    } catch {
      throw new Error('Unvollständige Lichess-Antwort. Bitte Synchronisierung erneut starten; bisherige Partien bleiben erhalten.');
    }
    if (!game.id || !game.pgn) continue;
    summaries.push({
      sourceId: `lichess:${game.id}`,
      pgn: game.pgn,
      endedAt: game.lastMoveAt || game.createdAt || 0,
      variant: game.variant || 'standard',
      status: game.status || 'unknown',
      white: game.players?.white?.user?.name || 'White',
      black: game.players?.black?.user?.name || 'Black',
    });
  }
  // Neueste zuerst (wie chess.com — end_time absteigend)
  summaries.sort((a, b) => b.endedAt - a.endedAt);
  return summaries;
}
