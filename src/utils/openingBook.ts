/**
 * Eröffnungsbuch: positionsbasierte Buch-Erkennung aus der verifizierten
 * lichess-ECO-Quelle (generiert via scripts/generateOpeningBook.mts).
 *
 * Erkennung über EPD (Feldaufbau + Seite am Zug + Rochaderechte + e.p.-Feld)
 * statt über Zugfolgen — dadurch funktionieren auch Transpositionen
 * (z. B. London via 1.Sf3 d5 2.d4 Sf6 3.Lf4).
 */
import bookData from '../data/openingBook.json';
import { Chess } from 'chess.js';

const epdSet = new Set<string>(bookData.epds);
const nameMap = new Map<string, { eco: string; name: string }>(
  Object.entries(bookData.names).map(([epd, v]) => [epd, v])
);

export function epdOf(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

/** Steht diese Stellung irgendwo in einer bekannten ECO-Linie? */
export function isKnownBookPosition(fen: string): boolean {
  return epdSet.has(epdOf(fen));
}

/** ECO-Name der Endstellung, falls diese Position eine Eröffnung abschließt. */
export function getBookOpening(fen: string): { eco: string; name: string } | null {
  return nameMap.get(epdOf(fen)) ?? null;
}

export interface OpeningHit {
  eco: string;
  name: string;
}

/**
 * T12: Gemeinsame Eröffnungserkennung (Import, Archiv, Review, Statistik).
 * Wählt die LÄNGSTE passend erreichte benannte Stellung: die Erkennung läuft
 * die erreichten Stellungen in Zugreihenfolge durch und behält den jeweils
 * letzten Anker-Namen; die erste Stellung außerhalb des Buchs beendet die
 * Suche (verhindert absurde Namentreffer in tiefen Mittelspielen).
 * Transpositionen funktionieren durch positionsbasiertes Matching (EPD).
 */
export function detectOpeningFromFens(fensAfter: string[]): OpeningHit | null {
  let hit: OpeningHit | null = null;
  for (const fen of fensAfter) {
    if (!epdSet.has(epdOf(fen))) break;
    hit = nameMap.get(epdOf(fen)) ?? hit;
  }
  return hit;
}

/**
 * T12: SAN-Variante der gemeinsamen Erkennung für PGN-Imports — replays die
 * Züge und delegiert an detectOpeningFromFens. Illegale/unklare Züge brechen
 * die Suche ab (Ergebnis = längster bis dahin bestätigter Anker).
 */
export function detectOpeningFromSanHistory(sanMoves: string[], initialFen?: string): OpeningHit | null {
  let chess: Chess;
  try {
    chess = initialFen ? new Chess(initialFen) : new Chess();
  } catch {
    return null;
  }
  const fens: string[] = [];
  for (const san of sanMoves) {
    try {
      chess.move(san);
    } catch {
      break;
    }
    fens.push(chess.fen());
  }
  return detectOpeningFromFens(fens);
}
