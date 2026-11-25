/**
 * Erklärungen für Fehlversuche auf Fehlerkarten (TrainingDeckView/TrainingModal).
 *
 * Basis: zwei Stockfish-Auswertungen (via IPC-Queue):
 *  1. Stellung NACH dem Fehlversuch -> Verschlechterung + bester Gegenzug
 *     (Widerlegung) samt Variante (PV).
 *  2. Stellung NACH dem Erwartungszug -> was der richtige Zug erhält.
 *
 * Daraus werden knappe deutsche Begründungen abgeleitet (Stellungs-Kippung,
 * Matt, verlorene Figur, Materialverlust in der Variante).
 */
import { Chess, Square } from 'chess.js';
import { EngineEvalResult } from '../types/chess';
import { formatEval } from './analysis';
import { isReliableEvaluation } from './evaluationReliability';
import { lineEvidence } from './lineEvidence';

export interface MoveExplanation {
  playedSan: string;
  bestSan: string;
  /** Bester Gegenzug auf den Fehlversuch (SAN), falls vorhanden. */
  refutationSan: string | null;
  evalBeforeText: string;
  evalWrongText: string;
  evalBestText: string;
  wrongReasons: string[];
  bestReasons: string[];
  /** Kurze Variante nach dem Erwartungszug (SAN, Gegner beginnt). */
  bestLineSan: string[];
  /** Widerlegungs-Linie auf den Fehlversuch (UCI, max. 3 Halbzüge, Gegner beginnt) für die Brettabspielung. */
  refutationLineUci: string[];
  /** Dasselbe in SAN für die Textanzeige. */
  refutationLineSan: string[];
}

const PIECE_VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const EXPLANATION_DEPTH = 12;
const CACHE_MAX = 60;

// Cache: Deck requeued fehlgeschlagene Karten — Erklärung nicht doppelt rechnen.
const cache = new Map<string, MoveExplanation>();

function sanFromUci(fen: string, uci: string): string {
  if (!uci || uci.length < 4) return uci;
  try {
    const chess = new Chess(fen);
    const move = chess.move({
      from: uci.substring(0, 2) as Square,
      to: uci.substring(2, 4) as Square,
      promotion: uci[4] as never,
    });
    return move ? move.san : uci;
  } catch {
    return uci;
  }
}

function pvToMoves(fen: string, pv: string[], maxPlies: number): { san: string; uci: string }[] {
  const chess = new Chess(fen);
  const moves: { san: string; uci: string }[] = [];
  for (const uci of pv.slice(0, maxPlies)) {
    if (!uci || uci.length < 4) break;
    try {
      const move = chess.move({
        from: uci.substring(0, 2) as Square,
        to: uci.substring(2, 4) as Square,
        promotion: uci[4] as never,
      });
      if (!move) break;
      moves.push({ san: move.san, uci });
    } catch {
      break;
    }
  }
  return moves;
}

function pvToSans(fen: string, pv: string[], maxPlies: number): string[] {
  const chess = new Chess(fen);
  const sans: string[] = [];
  for (const uci of pv.slice(0, maxPlies)) {
    if (!uci || uci.length < 4) break;
    try {
      const move = chess.move({
        from: uci.substring(0, 2) as Square,
        to: uci.substring(2, 4) as Square,
        promotion: uci[4] as never,
      });
      if (!move) break;
      sans.push(move.san);
    } catch {
      break;
    }
  }
  return sans;
}

/**
 * Stellung nach den ersten `maxPlies` PV-Halbzügen (T14): tatsächlich
 * erreichbare Folgestellung statt Summe über Teilauszüge.
 */
function fenAfterPv(fen: string, pv: string[], maxPlies: number): string {
  const chess = new Chess(fen);
  for (const uci of pv.slice(0, maxPlies)) {
    if (!uci || uci.length < 4) break;
    try {
      chess.move({
        from: uci.substring(0, 2) as Square,
        to: uci.substring(2, 4) as Square,
        promotion: uci[4] as never,
      });
    } catch {
      break;
    }
  }
  return chess.fen();
}

/**
 * Materialbilanz-Differenz aus Nutzersicht zwischen zwei STELLUNGEN (T14):
 * Zählt die Figuren auf dem Brett statt PV-Partialsummen. Ein normaler
 * Tausch (beide schlagen je eine Figur) ergibt 0; die eigene Schlagzug-
 * Ausbeute vor dem Betrachtungszeitraum ist bereits in beiden Stellungen
 * enthalten. Promotionen naturally über den Brettwert erfasst.
 */
function materialBalanceDiff(fenA: string, fenB: string, userColor: 'w' | 'b'): number {
  const materialFor = (fen: string, color: 'w' | 'b'): number => {
    const chess = new Chess(fen);
    let sum = 0;
    const board = chess.board();
    for (const row of board) {
      for (const sq of row) {
        if (sq && sq.color === color) sum += PIECE_VALUES[sq.type] ?? 0;
      }
    }
    return sum;
  };
  const opp: 'w' | 'b' = userColor === 'w' ? 'b' : 'w';
  return (
    materialFor(fenB, userColor) - materialFor(fenA, userColor) -
    (materialFor(fenB, opp) - materialFor(fenA, opp))
  );
}

export async function explainWrongMove(
  fenBefore: string,
  playedUci: string,
  bestUci: string,
  evalBefore: EngineEvalResult
): Promise<MoveExplanation | null> {
  const api = window.electronAPI;
  if (!api?.engine?.evaluateFen || !isReliableEvaluation(evalBefore)) return null;
  const comparisonDepth = Math.max(EXPLANATION_DEPTH, evalBefore.actualDepth ?? evalBefore.depth);

  // T09: Cache-Key berücksichtigt BESTZUG und Tiefe — ein anderer Erwartungszug
  // (z. B. nach Re-Analyse) oder eine andere Tiefe darf nicht den gecachten
  // Text einer alten Konstellation liefern.
  const cacheKey = `${fenBefore}|${playedUci}|${bestUci}|d${comparisonDepth}|${evalBefore.scoreCp}|${evalBefore.mate}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // Fehlversuch + Erwartungszug in SAN auflösen
  let playedSan = playedUci;
  let fenAfterWrong: string | null = null;
  try {
    const chess = new Chess(fenBefore);
    const played = chess.move({
      from: playedUci.substring(0, 2) as Square,
      to: playedUci.substring(2, 4) as Square,
      promotion: playedUci[4] as never,
    });
    if (played) {
      playedSan = played.san;
      fenAfterWrong = chess.fen();
    }
  } catch {
    return null;
  }
  if (!fenAfterWrong) return null;

  const bestSan = sanFromUci(fenBefore, bestUci);
  let fenAfterBest: string | null = null;
  try {
    const chess = new Chess(fenBefore);
    const best = chess.move({
      from: bestUci.substring(0, 2) as Square,
      to: bestUci.substring(2, 4) as Square,
      promotion: bestUci[4] as never,
    });
    if (best) fenAfterBest = chess.fen();
  } catch {
    fenAfterBest = null;
  }

  const userColor: 'w' | 'b' = new Chess(fenBefore).turn();
  const evalBeforeText = formatEval(evalBefore.scoreCp, evalBefore.mate);

  // Sonderfall: Fehlversuch beendet die Partie sofort (Matt/Patt gesetzt) —
  // die Engine kann solche Stellungen nicht sinnvoll bewerten.
  const afterWrong = new Chess(fenAfterWrong);
  if (afterWrong.isCheckmate()) return null; // A legal immediate mate is always successful.
  if (afterWrong.isGameOver()) {
    const explanation: MoveExplanation = {
      playedSan,
      bestSan,
      refutationSan: null,
      evalBeforeText,
      evalWrongText: afterWrong.isCheckmate() ? 'Matt' : 'Remis',
      evalBestText: '—',
      wrongReasons: [
        afterWrong.isCheckmate()
          ? 'Dein Zug setzt zwar matt, aber die Engine kennt einen noch schnelleren Weg.'
          : 'Dein Zug erzwingt sofort Remis, obwohl die Stellung noch mehr hergegeben hätte.',
      ],
      bestReasons: [`Die Engine empfiehlt ${bestSan} als stärksten Zug.`],
      bestLineSan: [],
      refutationLineUci: [],
      refutationLineSan: [],
    };
    cache.set(cacheKey, explanation);
    return explanation;
  }

  // Stellung nach Fehlversuch: Widerlegung + Verschlechterung
  const evalWrong = await api.engine.evaluateFen(fenAfterWrong, comparisonDepth);
  if (!isReliableEvaluation(evalWrong, comparisonDepth)) return null;
  const evalWrongText = formatEval(evalWrong.scoreCp, evalWrong.mate);

  const wrongReasons: string[] = [];

  // Nutzerperspektive für den Schweregrad (Anzeige bleibt Weiß-Sicht wie überall).
  // HINWEIS (T14): evalBefore stammt aus der Partieanalyse (andere Tiefe),
  // evalWrong aus der Kurzprüfung — die Schwellen (150cp / ±50cp) sind bewusst
  // hoch, damit Tiefenunterschiede keine vorgetäuschten Verschlechterungen
  // behaupten.
  const userBefore = userColor === 'w' ? evalBefore.scoreCp : -evalBefore.scoreCp;
  const userAfter = userColor === 'w' ? evalWrong.scoreCp : -evalWrong.scoreCp;
  const swing = userBefore - userAfter;
  if (userBefore >= 50 && userAfter <= -50) {
    wrongReasons.push(`Die Stellung kippt von ${evalBeforeText} auf ${evalWrongText} — aus Vorteil wird Nachteil.`);
  } else if (swing >= 150) {
    wrongReasons.push(`Die Bewertung fällt von ${evalBeforeText} auf ${evalWrongText}.`);
  }

  // Matt droht gegen den Nutzer?
  if (evalWrong.mate !== undefined && evalWrong.mate !== 0) {
    const mateForWhite = evalWrong.mate > 0;
    if ((userColor === 'w' && !mateForWhite) || (userColor === 'b' && mateForWhite)) {
      wrongReasons.push(`Dein Zug erlaubt Matt in ${Math.abs(evalWrong.mate)}.`);
    }
  }

  // Widerlegung: bester Gegenzug auf den Fehlversuch + kurze Linie fürs Brett
  const refutationUci = evalWrong.bestMoveUci;
  const refutationSan = refutationUci && refutationUci.length >= 4 ? sanFromUci(fenAfterWrong, refutationUci) : null;
  const refutationMoves = pvToMoves(fenAfterWrong, evalWrong.pv, 3);
  const refutationLineUci = refutationMoves.map((m) => m.uci);
  const refutationLineSan = refutationMoves.map((m) => m.san);
  if (refutationSan && evalWrong.pv.length > 0) {
    wrongReasons.push(`Der Gegner antwortet am stärksten mit ${refutationSan}.`);
  }

  // Wird die gerade gezogene Figur direkt geschlagen?
  const materialProof = lineEvidence(fenBefore, [playedUci, ...evalWrong.pv].slice(0, 12), userColor);
  if (materialProof?.settled && materialProof.gain <= -2) {
    wrongReasons.push(`Die belegte Variante verliert netto ${-materialProof.gain} Materialpunkte.`);
  }

  // Fallback, falls die Eval-Schwelle nicht greift (z. B. positioneller Verlust)
  if (wrongReasons.length === 0) {
    wrongReasons.push(`Die Stellung verschlechtert sich von ${evalBeforeText} auf ${evalWrongText} — die Engine sieht deutlich bessere Züge.`);
  }

  // Stellung nach Erwartungszug
  const bestReasons: string[] = [];
  let bestLineSan: string[] = [];
  let evalBestText = '—';
  if (fenAfterBest) {
    const evalBest = await api.engine.evaluateFen(fenAfterBest, comparisonDepth);
    if (!isReliableEvaluation(evalBest, comparisonDepth)) return null;
    evalBestText = formatEval(evalBest.scoreCp, evalBest.mate);
    bestReasons.push(`Mit ${bestSan} bleibt die Stellung bei ${evalBestText} — statt ${evalWrongText} nach deinem Versuch.`);
    bestLineSan = pvToSans(fenAfterBest, evalBest.pv, 4);
  } else {
    bestReasons.push(`${bestSan} ist der stärkste Zug laut Engine.`);
  }

  const explanation: MoveExplanation = {
    playedSan,
    bestSan,
    refutationSan,
    evalBeforeText,
    evalWrongText,
    evalBestText,
    wrongReasons,
    bestReasons,
    bestLineSan,
    refutationLineUci,
    refutationLineSan,
  };

  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(cacheKey, explanation);
  return explanation;
}
