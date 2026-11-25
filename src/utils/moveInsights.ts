/**
 * Fehler-Insights: "Was war der bessere Plan?" und "Woran bin ich gestorben?".
 *
 * Pure Funktionen über chess.js - Stellungen werden aus den gespeicherten
 * FENs rekonstruiert, keine Engine-Aufrufe. Läuft im Main-Prozess (db.ts)
 * und im Renderer.
 */
import { Chess, type Move, type Square } from 'chess.js';
import type { MissedIdea, MoveAnalysis } from '../types/chess';
import { playerNames } from './profile';
import { lineEvidence, MATERIAL_VALUES } from './lineEvidence';

export const MISSED_IDEA_LABELS: Record<MissedIdea, string> = {
  mate: 'Matt übersehen',
  capture: 'Schlagzug übersehen',
  fork: 'Gabel/Doppelangriff',
  check: 'Schachzug übersehen',
  quiet: 'Anderer starker Zug',
};

const PIECE_VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };

/** UCI auf einem bestehenden Chess-Objekt ausführen; null bei illegalem Zug. */
function applyUci(chess: Chess, uci: string): Move | null {
  if (!uci || uci.length < 4) return null;
  try {
    return chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.slice(4, 5) || undefined,
    });
  } catch {
    return null;
  }
}

export interface MissedIdeaResult {
  idea: MissedIdea;
  bestSan: string;
  /** T14: true = Motiv nur geometrisch erkannt, Materialgewinn nicht belegt. */
  heuristic?: boolean;
}

/**
 * T13: Exakt normalisierter Spieler-Resolver — 'audit-user' matcht NICHT
 * 'audit-user-other'; ein leerer Suchname matcht niemanden; Partien ohne den
 * Zielspieler liefern null (unbekannt bleibt unbekannt — KEINE Weiß-Annahme
 * für fremde Partien).
 */
export function resolvePlayerColor(
  white: string | undefined,
  black: string | undefined,
  target: string,
  site?: string,
): 'w' | 'b' | null {
  const normalize = (value: string | undefined) =>
    (value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const targets = playerNames(target, site);
  if (!targets.length) return null;
  const w = normalize(white);
  const b = normalize(black);
  if (targets.includes(w) && targets.includes(b)) return null;
  if (targets.includes(w)) return 'w';
  if (targets.includes(b)) return 'b';
  return null;
}

/**
 * T13: Materialbasierte Endspiel-Heuristik mit dokumentierter Grenze.
 * Endspiel, wenn (a) keine Damen mehr auf dem Brett sind ODER (b) gesamt
 * maximal 13 Punkte Nicht-Bauern-Material (ohne Könige) übrig sind. Bewusste
 * Näherung — "Züge 31+" allein ist keine Endspieldefinition.
 */
export function isEndgamePosition(fen: string): boolean {
  try {
    const chess = new Chess(fen);
    let queens = 0;
    let minorMajor = 0;
    const board = chess.board();
    for (const row of board) {
      for (const sq of row) {
        if (!sq || sq.type === 'k' || sq.type === 'p') continue;
        if (sq.type === 'q') queens++;
        else minorMajor += PIECE_VALUES[sq.type] ?? 0;
      }
    }
    return queens === 0 || minorMajor <= 13;
  } catch {
    return false;
  }
}

/**
 * T13: Belegbarer Figurenverlust aus der Antwortlinie (evalAfter.pv = beste
 * Gegnerlinie nach dem Fehlerzug): die erste Eroberung eines eigenen Steins
 * in der Variante ist der belegte Verlust — statt blind die Bewegte Figur
 * zu zählen. null = kein belegbarer Verlust (positioneller Fehler,
 * Königskurzflucht, Angriff ohne sofortiges Material).
 */
export function findEvidencedLostPiece(
  fenAfter: string,
  replyPv: string[] | undefined,
  userColor: 'w' | 'b',
  playedMove?: Pick<MoveAnalysis, 'fenBefore' | 'uci'>,
): string | null {
  if (!replyPv?.length) return null;
  const evidence = playedMove
    ? lineEvidence(playedMove.fenBefore, [playedMove.uci, ...replyPv.slice(0, 12)], userColor)
    : lineEvidence(fenAfter, replyPv.slice(0, 12), userColor);
  if (!evidence?.settled || evidence.gain >= -0.5) return null;
  const lost = evidence.captures.filter(move => move.color !== userColor && move.captured);
  const won = evidence.captures.filter(move => move.color === userColor && move.captured);
  const remaining = lost.map(move => move.captured!);
  for (const move of won) {
    const index = remaining.indexOf(move.captured!);
    if (index >= 0) remaining.splice(index, 1);
  }
  return remaining.sort((a, b) => MATERIAL_VALUES[b] - MATERIAL_VALUES[a])[0] ?? null;
}

/**
 * Was hätte der Engine-Bestzug gebracht, das der gespielte (Fehler-)Zug verpasst hat?
 * Priorität: Matt > besserer Schlagzug > Gabel/Doppelangriff > Schach > positionell.
 *
 * @param fenBefore      Stellung vor dem Fehlerzug
 * @param bestUci        Engine-Bestzug (evalBefore.bestMoveUci)
 * @param playedCaptured piece-Code des vom Fehlerzug geschlagenen Steins (undefined = kein Schlagzug)
 * @param bestPv         Engine-Variante zum Bestzug (evalBefore.pv) — T14: belegt
 *                       auch Matt in mehreren Zügen statt nur 1-Zug-Erkennung
 */
export function classifyMissedIdea(
  fenBefore: string,
  bestUci: string,
  playedCaptured?: string,
  bestPv?: string[]
): MissedIdeaResult | null {
  let clone: Chess;
  try {
    clone = new Chess(fenBefore);
  } catch {
    return null;
  }
  const best = applyUci(clone, bestUci);
  if (!best) return null;

  // 1) Matt — direkt ODER laut Engine-Variante (T14: Matt in mehreren Zügen
  //    wird über die PV belegt, nicht nur der sofortige Mattzug erkannt).
  if (clone.isCheckmate()) return { idea: 'mate', bestSan: best.san };
  if (bestPv && bestPv.length > 0) {
    const pvMoves = bestPv[0] === bestUci ? bestPv.slice(1) : bestPv;
    const mateClone = new Chess(fenBefore);
    if (applyUci(mateClone, bestUci)) {
      for (const uci of pvMoves) {
        if (!applyUci(mateClone, uci)) break;
        if (mateClone.isCheckmate()) {
          if (mateClone.turn() !== best.color) return { idea: 'mate', bestSan: best.san };
          return { idea: 'quiet', bestSan: best.san };
        }
      }
    }
  }

  // 2) Besserer Schlagzug: schlägt der Bestzug mehr Material als der gespielte Zug
  const gain = lineEvidence(fenBefore, bestPv?.length ? (bestPv[0] === bestUci ? bestPv : [bestUci, ...bestPv]) : [bestUci], best.color);
  if (best.captured && gain?.settled && gain.gain > (playedCaptured ? PIECE_VALUES[playedCaptured] ?? 0 : 0)) {
    return { idea: 'capture', bestSan: best.san };
  }

  // 3) Gabel/Doppelangriff: der gezogene Stein greift >=2 wertvolle feindliche
  //    Steine an (oder 1 wertvollen Stein + Schach). Rein geometrische Erkennung
  //    ohne belegten Materialgewinn, daher immer als heuristisch markiert
  //    (UI hängt "(heuristisch)" an).
  const us = best.color;
  const enemy: 'w' | 'b' = us === 'w' ? 'b' : 'w';
  let valuableTargets = 0;
  const board = clone.board();
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const sq = board[r][f];
      if (!sq || sq.color !== enemy) continue;
      if (sq.type !== 'q' && sq.type !== 'r' && sq.type !== 'b' && sq.type !== 'n') continue;
      const square = 'abcdefgh'[f] + (8 - r);
      if (clone.attackers(square as Square, us).includes(best.to)) {
        valuableTargets++;
      }
    }
  }
  if (valuableTargets >= 2 || (valuableTargets >= 1 && clone.isCheck())) {
    return { idea: 'fork', bestSan: best.san, heuristic: true };
  }

  // 4) Schach (ohne Matt, ohne Materialgewinn)
  if (clone.isCheck()) return { idea: 'check', bestSan: best.san };

  // 5) Positionell besser
  return { idea: 'quiet', bestSan: best.san };
}

export type MatePattern = 'backRank' | 'smothered' | 'net';

/**
 * Mattmuster-Klassifizierung aus der Stellung VOR dem Mattzug + dem Mattzug.
 *
 * - 'backRank' (Grundlinienmatt): Küng auf Grundlinie, Turm/Dame liefert entlang
 *   der Grundlinie.
 * - 'smothered' (Ersticktes Matt): Springer matt, alle Nachbarn des Königs von
 *   eigenen Steinen besetzt.
 * - 'net' (Mattnetz): alles andere.
 */
export function classifyMatePattern(fenBefore: string, matingMoveUci: string): MatePattern | null {
  let clone: Chess;
  try {
    clone = new Chess(fenBefore);
  } catch {
    return null;
  }
  const mating = applyUci(clone, matingMoveUci);
  if (!mating || !clone.isCheckmate()) return null;

  // Nach dem Matt ist der Mattseite die Amazone am Zug.
  const matedColor = clone.turn();
  const board = clone.board();

  // Königsfeld der mattgesetzten Seite finden
  let kingFile = -1;
  let kingRank = -1;
  for (let r = 0; r < 8 && kingFile < 0; r++) {
    for (let f = 0; f < 8; f++) {
      const sq = board[r][f];
      if (sq && sq.type === 'k' && sq.color === matedColor) {
        kingFile = f;
        kingRank = 8 - r;
        break;
      }
    }
  }
  if (kingFile < 0) return null;

  // Ersticktes Matt: alle 8 Nachbarfelder besetzt (davon keine feindlichen)
  let allNeighborsOwnOrOff = true;
  let allOccupied = true;
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (df === 0 && dr === 0) continue;
      const f = kingFile + df;
      const r = kingRank + dr;
      if (f < 0 || f > 7 || r < 1 || r > 8) continue;
      const sq = board[8 - r][f];
      if (!sq) {
        allOccupied = false;
        allNeighborsOwnOrOff = false;
      } else if (sq.color !== matedColor) {
        allNeighborsOwnOrOff = false;
      }
    }
  }
  if (allOccupied && allNeighborsOwnOrOff && mating.piece === 'n') {
    return 'smothered';
  }

  // Grundlinienmatt: König auf Grundlinie, mattsetzender Turm/Dame (oder
  // umgewandelte Dame) auf derselben Grundlinie
  const backRank = matedColor === 'w' ? 1 : 8;
  const matingType = mating.promotion ?? mating.piece;
  const matingFile = mating.to.charCodeAt(0) - 97;
  const matingRank = parseInt(mating.to[1], 10);
  if (
    kingRank === backRank &&
    matingRank === backRank &&
    (matingType === 'r' || matingType === 'q')
  ) {
    // entlang der Grundlinie = gleiche Grundlinie genügt (Schach ist durch
    // isCheckmate gegeben; Diagonal-Attacken auf die Grundlinie sind praktisch
    // nicht von "Netz" zu trennen und selten - Heuristik bewusst einfach)
    void matingFile;
    return 'backRank';
  }

  return 'net';
}

/** Shared tag semantics for diagnostics and training filters. */
export function moveIdea(move: MoveAnalysis): MissedIdeaResult | null {
  if (move.missedOpportunity) return { idea: move.missedOpportunity.kind === 'mate' ? 'mate' : 'capture', bestSan: move.missedOpportunity.bestSan };
  const idea = classifyMissedIdea(move.fenBefore, move.evalBefore.bestMoveUci, move.captured, move.evalBefore.pv);
  return idea?.idea === 'mate' || idea?.idea === 'capture' ? { ...idea, heuristic: true } : idea;
}
