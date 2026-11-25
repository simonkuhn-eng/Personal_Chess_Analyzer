import { Chess } from 'chess.js';
import { GameMetadata } from '../types/chess';
import { detectOpeningFromSanHistory } from './openingBook';
import { parsePlayedAt } from './gameTime';

// Standard openings lookup table for common initial move sequences
const COMMON_OPENINGS: Record<string, { eco: string; name: string }> = {
  'e4': { eco: 'B00', name: "King's Pawn Opening" },
  'd4': { eco: 'A40', name: "Queen's Pawn Opening" },
  'c4': { eco: 'A10', name: 'English Opening' },
  'Nf3': { eco: 'A04', name: 'Reti Opening' },
  'e4 e5': { eco: 'C20', name: 'Open Game' },
  'e4 c5': { eco: 'B20', name: 'Sicilian Defense' },
  'e4 e6': { eco: 'C00', name: 'French Defense' },
  'e4 c6': { eco: 'B10', name: 'Caro-Kann Defense' },
  'e4 d5': { eco: 'B01', name: 'Scandinavian Defense' },
  'e4 d6': { eco: 'B07', name: 'Pirc Defense' },
  'd4 d5': { eco: 'D00', name: 'Closed Game' },
  'd4 Nf6': { eco: 'A45', name: 'Indian Defense' },
  'd4 d5 c4': { eco: 'D06', name: "Queen's Gambit" },
  'd4 d5 c4 e6': { eco: 'D30', name: "Queen's Gambit Declined" },
  'd4 d5 c4 dxc4': { eco: 'D20', name: "Queen's Gambit Accepted" },
  'd4 d5 Bf4': { eco: 'D00', name: 'London System' },
  'd4 Nf6 c4 g6': { eco: 'E60', name: "King's Indian Defense" },
  'd4 Nf6 c4 e6': { eco: 'E00', name: 'Nimzo / Bogo / Queen Indian' },
  'e4 e5 Nf3 Nc6 Bc4': { eco: 'C50', name: 'Italian Game' },
  'e4 e5 Nf3 Nc6 Bb5': { eco: 'C60', name: 'Ruy Lopez' },
  'e4 e5 Nf3 Nc6 d4': { eco: 'C44', name: 'Scotch Game' },
  'e4 e5 Nf3 Nf6': { eco: 'C42', name: 'Petrov Defense' },
  'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6': { eco: 'B90', name: 'Sicilian Najdorf' },
};

export function parsePgnMetadata(pgnText: string): GameMetadata {
  const chess = new Chess();
  try {
    chess.loadPgn(pgnText);
  } catch (err) {
    // Tolerant parse
  }

  const header = chess.header();

  const white = header['White'] || 'White';
  const black = header['Black'] || 'Black';
  const date = header['Date'] || new Date().toISOString().split('T')[0];
  const result = header['Result'] || '*';
  const event = header['Event'] || 'Casual Game';
  const site = header['Site'] || 'Local';
  const whiteElo = header['WhiteElo'] || undefined;
  const blackElo = header['BlackElo'] || undefined;
  const initialFen = header['FEN'] || undefined;
  let eco = header['ECO'];
  let openingName = header['Opening'];

  // T12: gemeinsame Eröffnungserkennung — längste passend erreichte benannte
  // Ankerstellung aus dem Buch (deckungsgleich mit Archiv/Statistik via
  // detectOpeningFromFens). SAN-Tabelle nur noch als generischer Fallback
  // für Partien, die keinen Anker erreichen.
  if (!openingName) {
    const bookHit = detectOpeningFromSanHistory(chess.history());
    if (bookHit) {
      eco = eco || bookHit.eco;
      openingName = bookHit.name;
    } else {
      const history = chess.history();
      for (let len = Math.min(10, history.length); len >= 1; len--) {
        const seq = history.slice(0, len).join(' ');
        if (COMMON_OPENINGS[seq]) {
          eco = eco || COMMON_OPENINGS[seq].eco;
          openingName = COMMON_OPENINGS[seq].name;
          break;
        }
      }
    }
  }

  // T06: Stabile Partie-ID aus Quellidentität — dieselbe PGN erhält bei
  // Reanalyse dieselbe ID statt einer neuen Zufalls-UUID (keine Duplikate).
  const uciMoves = chess.history({ verbose: true }).map((m) => m.from + m.to + (m.promotion || ''));
  const identityKey = gameIdentityKey({ white, black, date, site, result, timeControl: header['TimeControl'] ?? undefined, uciMoves, initialFen });

  return {
    id: stableGameId(identityKey),
    createdAt: new Date().toISOString(),
    playedAt: parsePlayedAt(header['UTCDate'] || header['Date'] || undefined, header['UTCTime'] || undefined),
    event,
    site,
    date,
    white,
    black,
    result,
    whiteElo,
    blackElo,
    // T12: fehlenden ECO NICHT als gesichertes A00 behaupten — leer bleibt
    // leer (UI zeigt dann kein ECO statt eines falschen Codes).
    eco: eco || '',
    openingName: openingName || 'Standard Opening',
    timeControl: header['TimeControl'] || undefined,
    timeClass: header['TimeClass'] || undefined,
  };
}

export function extractMovesFromPgn(pgnText: string): {
  fenBefore: string;
  fenAfter: string;
  san: string;
  uci: string;
  from: string;
  to: string;
  promotion?: string;
  piece: string;
  captured?: string;
  color: 'w' | 'b';
  isCheck: boolean;
  isCheckmate: boolean;
  ply: number;
  moveNumber: number;
}[] {
  const chess = new Chess();
  chess.loadPgn(pgnText);

  // Simulator mit derselben Ausgangsstellung wie die Partie starten —
  // SetUp/FEN-Partien hätten sonst falsche fenBefore/fenAfter (T17-Vorarbeit).
  const fenMatch = pgnText.match(/\[FEN\s+"([^"]+)"\]/);
  const simulator = fenMatch ? new Chess(fenMatch[1]) : new Chess();

  // T17: echte Zugnummern — SetUp-Partien starten nicht bei Zug 1 (FEN
  // "… w - - 0 42" → erster Zug ist 42). Standard: Zug 1, Weiß beginnt.
  const fenParts = (fenMatch ? fenMatch[1] : 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')
    .trim()
    .split(/\s+/);
  const startFullmove = Math.max(1, parseInt(fenParts[5], 10) || 1);
  const startColor = fenParts[1] === 'b' ? 'b' : 'w';

  const history = chess.history({ verbose: true });
  const moves = [];

  for (let i = 0; i < history.length; i++) {
    const fenBefore = simulator.fen();
    const move = history[i];
    const played = simulator.move({
      from: move.from,
      to: move.to,
      promotion: move.promotion,
    });
    const fenAfter = simulator.fen();

    moves.push({
      fenBefore,
      fenAfter,
      san: move.san,
      uci: move.from + move.to + (move.promotion || ''),
      from: move.from,
      to: move.to,
      promotion: move.promotion,
      piece: move.piece,
      captured: move.captured,
      color: move.color,
      isCheck: simulator.inCheck(),
      isCheckmate: simulator.isCheckmate(),
      ply: i + 1,
      moveNumber: startFullmove + Math.floor((i + (startColor === 'b' ? 1 : 0)) / 2),
    });
  }

  return moves;
}

/**
 * FNV-1a 32-bit (T06): dependency-freier, stabiler Hash für Partieidentität.
 * Zwei Seeds → 64 Bit Hashbreite, Kollisionsrisiko für private Datenbestände vernachlässigbar.
 */
function fnv1a(str: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function identityHash(key: string): string {
  return (
    fnv1a(key, 0x811c9dc5).toString(16).padStart(8, '0') +
    fnv1a(key, 0xdeadbeef).toString(16).padStart(8, '0')
  );
}

/** Stable-ID-Format: game_ + 16 Hexzeichen (vs. Legacy-Zufalls-IDs). */
export function isStableGameId(id: string | undefined): boolean {
  return typeof id === 'string' && /^game_[0-9a-f]{16}$/.test(id);
}

/**
 * Identitätsschlüssel einer Partie (T06):
 * - Chess.com-Partien: die Live-URL enthält die stabile Partie-ID.
 * - Manuelle PGNs: konservativer Fingerabdruck aus Spielern, Datum, Site,
 *   Result, Zeitkontrolle, Start-FEN und exakter Zugfolge.
 */
export function gameIdentityKey(input: {
  white: string;
  black: string;
  date?: string;
  site?: string;
  result?: string;
  timeControl?: string;
  uciMoves: string[];
  initialFen?: string;
}): string {
  const normalize = (value?: string) => (value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const siteNorm = normalize(input.site);
  const liveMatch = siteNorm.match(/chess\.com\/(?:game|games)\/(?:(?:live|daily)\/)?(\d+)/);
  if (liveMatch) {
    return `chesscom:${liveMatch[1]}`;
  }
  const moves = (input.uciMoves || []).join(',');
  return [
    'manual',
    normalize(input.white),
    normalize(input.black),
    normalize(input.date),
    siteNorm,
    normalize(input.result),
    normalize(input.timeControl),
    input.initialFen || 'start',
    moves,
  ].join('|');
}

export function stableGameId(identityKey: string): string {
  return 'game_' + identityHash(identityKey);
}

/**
 * Legacy-Fingerprint (Migration): "normalisiert weiß | schwarz | UCI-Zugfolge".
 * Wird weiterhin für den Dedup-Abgleich beim Import genutzt (Import-Modals,
 * db.getFingerprints) — die Partie-ID selbst kommt jetzt aus gameIdentityKey.
 * MUSS exakt der gameFingerprint-Formel aus electron/db.ts entsprechen.
 */
export function gameFingerprint(white: string, black: string, uciMoves: string[], pgn?: string): string {
  const normalize = (value: string | undefined) => (value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const moves = (uciMoves || []).join(',');
  return [normalize(white), normalize(black), moves || normalize(pgn)].join('|');
}

/**
 * R07: Bestätigen zwei Einträge dieselbe QUELLE? Der Legacy-Fingerabdruck
 * (Spieler + Zugfolge) allein verschmilzt Zwillingspartien (identische Züge
 * an verschiedenen Tagen). Deshalb: chess.com-Live-ID entscheidet allein;
 * sonst müssen sich vorhandene Metadaten widerspruchsfrei decken UND das
 * Datum bestätigen. Kein Beweis = unklar → false (erhalten statt verschmelzen).
 */
export function sameSourceIdentity(
  a: { date?: string; site?: string; result?: string; timeControl?: string },
  b: { date?: string; site?: string; result?: string; timeControl?: string }
): boolean {
  const normalize = (value?: string) => (value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const liveA = normalize(a.site).match(/chess\.com\/(?:game|games)\/(?:(?:live|daily)\/)?(\d+)/);
  const liveB = normalize(b.site).match(/chess\.com\/(?:game|games)\/(?:(?:live|daily)\/)?(\d+)/);
  if (liveA && liveB) return liveA[1] === liveB[1];
  let dateConfirmed = false;
  for (const field of ['date', 'site', 'result', 'timeControl'] as const) {
    const va = normalize(a[field]);
    const vb = normalize(b[field]);
    if (!va || !vb) continue; // einseitig vorhanden — kein Beweis, kein Widerspruch
    if (va !== vb) return false; // Widerspruch — verschiedene Quellen
    if (field === 'date') dateConfirmed = true;
  }
  return dateConfirmed;
}

/**
 * R07: Explizite ID-Zuordnung — beim Ersetzen eines Eintrags (Reanalyse oder
 * Legacy-Migration) die frühere ID als previousIds am neuen Eintrag
 * festhalten, damit Lernschlüssel `${alteId}:${ply}` migriert werden können.
 */
export function mergePreviousIds(
  previous: { id: string; previousIds?: string[] },
  next: { id: string; previousIds?: string[] }
): string[] | undefined {
  const merged = new Set<string>([...(previous.previousIds ?? []), ...(next.previousIds ?? [])]);
  if (previous.id !== next.id) merged.add(previous.id);
  merged.delete(next.id);
  return merged.size > 0 ? [...merged] : undefined;
}
