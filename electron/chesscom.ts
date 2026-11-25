// Lädt alle Partien eines Spielers für einen Monat aus dem öffentlichen
// chess.com-Publikations-API (JSON-Endpunkt). Läuft im Main-Prozess, damit
// kein CORS-Problem entsteht und ein korrekter User-Agent gesendet wird
// (chess.com verlangt einen aussagekräftigen UA).

export interface ChessComGameSummary {
  pgn: string;
  url?: string;
  uuid?: string;
  rules?: string;
  timeClass?: string;
  timeControl?: string;
  endTime?: number;
  white: string;
  black: string;
  result: string;
  date?: string;
}

interface ChessComPlayerInfo {
  username: string;
  result: string;
  rating?: number;
}

interface ChessComApiGame {
  url?: string;
  uuid?: string;
  rules?: string;
  pgn?: string;
  time_control?: string | number;
  time_class?: string;
  time_increment?: number;
  end_time?: number;
  rated?: boolean;
  white?: ChessComPlayerInfo;
  black?: ChessComPlayerInfo;
}

const USER_AGENT = 'PersonalChessAnalyzer/1.0 (personal chess analysis tool)';

function parseTag(pgn: string, tag: string): string | undefined {
  const match = pgn.match(new RegExp(`\\[${tag} "([^"]*)"\\]`));
  return match && match[1] ? match[1] : undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * T17: Fetch mit begrenztem Backoff — 429 (chess.com drosselt parallele
 * Requests) wird bis zu 2× wiederholt, Retry-After wird respektiert;
 * andere Netzwerkfehler werden einmalig wiederholt. Timeouts bleiben terminal.
 */
export async function fetchJsonWithBackoff(url: string, accept: string = 'application/json'): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: accept,
        },
        signal: controller.signal,
      });
      if (response.status === 429 && attempt < 2) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const delay =
          Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 10000) : (attempt + 1) * 1500;
        await sleep(delay);
        lastError = new Error('Chess.com hat die Anfrage gedrosselt (429).');
        continue;
      }
      return response;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('Timeout beim Laden der chess.com-Daten.');
      }
      lastError = err;
      if (attempt < 2) {
        await sleep((attempt + 1) * 1000);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Chess.com-Anfrage fehlgeschlagen.');
}

/** T17: Profil-Existenz-Check — 404 des Monatsarchivs ≠ „alles bereits geladen“. */
export async function fetchUserProfile(username: string): Promise<{ exists: boolean; name?: string }> {
  const cleanName = username.trim();
  if (!cleanName) {
    return { exists: false };
  }
  const url = `https://api.chess.com/pub/player/${encodeURIComponent(cleanName)}`;
  try {
    const response = await fetchJsonWithBackoff(url);
    if (response.status === 404) {
      return { exists: false };
    }
    if (!response.ok) {
      throw new Error(`Chess.com-Profil konnte nicht geprüft werden (HTTP ${response.status}).`);
    }
    const payload = (await response.json()) as { username?: string };
    return { exists: true, name: payload.username };
  } catch {
    // Profil-Check ist best-effort: bei Netzwerkprobleen nicht fälschlich
    // behaupten, der Nutzer existiere nicht — der eigentliche Abruf meldet
    // den Fehler dann ohnehin.
    return { exists: true };
  }
}

export async function fetchMonthlyGames(username: string, year: number, month: number): Promise<ChessComGameSummary[]> {
  const cleanName = username.trim();
  if (!cleanName) {
    throw new Error('Kein chess.com-Benutzername angegeben.');
  }

  const url = `https://api.chess.com/pub/player/${encodeURIComponent(cleanName)}/games/${year}/${String(month).padStart(2, '0')}`;

  const response = await fetchJsonWithBackoff(url);

  if (response.status === 404) {
    return []; // Kein Archiv für diesen Monat = keine Partien
  }
  if (response.status === 403) {
    throw new Error('Chess.com hat die Anfrage abgelehnt (403). Bitte später erneut versuchen.');
  }
  if (!response.ok) {
    throw new Error(`Chess.com-Monatsarchiv konnte nicht geladen werden (HTTP ${response.status}).`);
  }

    const payload = (await response.json()) as { games?: ChessComApiGame[] };
    const games = Array.isArray(payload.games) ? payload.games : [];

    const summaries: ChessComGameSummary[] = [];
    for (const game of games) {
      if (!game.pgn) continue;
      const white = game.white?.username || parseTag(game.pgn, 'White') || 'White';
      const black = game.black?.username || parseTag(game.pgn, 'Black') || 'Black';
      const result = parseTag(game.pgn, 'Result') || '*';
      summaries.push({
        pgn: game.pgn,
        url: game.url,
        uuid: game.uuid,
        rules: game.rules,
        timeClass: game.time_class,
        timeControl: typeof game.time_control === 'string' ? game.time_control : undefined,
        endTime: game.end_time,
        white,
        black,
        result,
        date: parseTag(game.pgn, 'Date'),
      });
    }

  // Neueste zuerst (end_time absteigend)
  summaries.sort((a, b) => (b.endTime || 0) - (a.endTime || 0));
  return summaries;
}

/** Find the latest completed standard game, including accounts inactive for
 * more than a month. Fetch serially and stop as soon as a matching game exists.
 * API: https://www.chess.com/news/view/published-data-api#pubapi-endpoint-games-archive-list
 */
export async function fetchLatestGame(username: string): Promise<ChessComGameSummary | null> {
  const name = username.trim();
  if (!/^[A-Za-z0-9_-]{1,30}$/.test(name)) {
    throw new Error('Bitte hinterlege einen gültigen Chess.com-Benutzernamen in den Einstellungen.');
  }
  const response = await fetchJsonWithBackoff(`https://api.chess.com/pub/player/${encodeURIComponent(name)}/games/archives`);
  if (response.status === 404) throw new Error(`Chess.com-Benutzer "${name}" wurde nicht gefunden.`);
  if (!response.ok) throw new Error(`Chess.com-Archive konnten nicht geladen werden (HTTP ${response.status}).`);
  const payload = await response.json() as { archives?: unknown };
  if (!Array.isArray(payload.archives)) throw new Error('Chess.com hat keine gültige Archivliste zurückgegeben.');
  const months = [...new Set(payload.archives.flatMap(value => {
    const match = typeof value === 'string' ? value.match(/\/games\/(\d{4})\/(\d{2})$/) : null;
    return match && Number(match[2]) >= 1 && Number(match[2]) <= 12 ? [`${match[1]}/${match[2]}`] : [];
  }))].sort().reverse();
  for (const month of months) {
    const [year, number] = month.split('/').map(Number);
    const games = await fetchMonthlyGames(name, year, number);
    const latest = games.find(game => (!game.rules || game.rules === 'chess') && ['1-0', '0-1', '1/2-1/2'].includes(game.result));
    if (latest) return latest;
  }
  return null;
}
