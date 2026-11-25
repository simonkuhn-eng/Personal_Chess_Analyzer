/**
 * Schachliche Bewertung von Trainingsantworten (T07).
 *
 * Vorher galt GENAU der gespeicherte Bestzug als richtig (und auch nur bis auf
 * die Umwandlungsfigur) — gleichwertige Alternativen wurden fälschlich als
 * Fehler erklärt. Diese Utility bewertet stattdessen:
 *
 *  1. Legalität des Versuchs (vollständige UCI inklusive Promotion).
 *  2. Terminales Ergebnis zuerst: Jeder sofort mattsetzende Zug gewinnt.
 *     Ein rettendes Remis (Patt) in verlorener/ausgeglichener Stellung ist
 *     kein Fehler; Patt in klar gewonnener Stellung verspielt den Gewinn.
 *  3. Erzwungenes Matt halten: Wenn die Ausgangsstellung Matt für den Spieler
 *     bot, akzeptieren wir nur Züge, die das Matt erhalten (streng — Matt in
 *     mehr Zügen ist okay, Verlust des Matts nicht).
 *  4. Sonst: Engine-Bewertung der Stellung NACH dem Versuch relativ zur
 *     Ausgangsbewertung, mit dokumentierter Toleranz (Gewinnchancen-Verlust
 *     ≤ 5 Prozentpunkte ODER cp-Verlust ≤ 50 aus Nutzersicht).
 *  5. Ohne verfügbare Engine-Bewertung NIEMALS ein rotes Fehlerurteil —
 *     der Versuch wird ehrlich toleriert.
 *
 * Die Bewertung ist bewusst ASYNCHRON: Für nicht-terminale Alternativen wird
 * die Folgestellung per Engine bewertet (gleiches Verfahren wie die
 * Partieanalyse, über die IPC-Queue serialisiert).
 */
import { Chess, Square } from 'chess.js';
import { isReliableEvaluation } from './evaluationReliability';
import { EngineEvalResult } from '../types/chess';
import { formatEval, getPlayerWinChance, MATED_SCORE_CP } from './analysis';

export type TrainingVerdict =
  /** Exakt der gespeicherte Bestzug. */
  | { kind: 'best' }
  /** Gleichwertige Alternative — als Erfolg werten. */
  | { kind: 'accepted'; reason: string }
  /** Solider, aber nicht optimaler Zug (5–7% Gewinnchancenverlust) — straffreier Neuversuch. */
  | { kind: 'solid'; reason: string }
  /** Echter schachlicher Fehler. */
  | { kind: 'wrong'; reason: string }
  /** R03: Technikproblem (unbelastbare Bewertung) — weder Erfolg noch Fehler;
   * darf Mastery/Scheduler NICHT verändern. */
  | { kind: 'uncertain'; reason: string };

export interface TrainingJudgement {
  /** false = Zug in der Stellung gar nicht legal (defensiv; UI sendet nur legale). */
  legal: boolean;
  playedSan: string;
  /** Stellung nach dem Versuch (null bei illegalem Zug). */
  fenAfter: string | null;
  /** true, wenn der Versuch die Partie sofort beendet (Matt/Patt/Remis). */
  isTerminal: boolean;
  /** Bewertete Folgestellung (falls über die Engine bestimmt). */
  evalAfter?: EngineEvalResult | null;
  /** Legale Hauptvariante des Gegners auf den Versuch (UCI ab fenAfter). */
  refutationPv?: string[];
  /** Erster starker Antwortzug des Gegners auf den Versuch (SAN). */
  refutationSan?: string;
  verdict: TrainingVerdict;
}

export interface JudgeDeps {
  /** Beim Training konkreter Materialchancen keine Sättigung der Gewinnchance nutzen. */
  preserveMaterialOpportunity?: boolean;
  /**
   * Bewertung der Stellung nach dem Versuch (z. B. IPC `evaluateFen`).
   * Liefert null / fehlt → kein Fehlerurteil möglich (Toleranz-Akzeptanz).
   */
  evaluateAfter?: (fen: string) => Promise<EngineEvalResult | null>;
  /** Suchtiefe für evaluateAfter (default 12, wie die Erklärungsanalyse). */
  depth?: number;
  /** Explizite Mindesttiefe für belastbare Antwortbewertungen (z. B. 12 auf Mobile WASM). */
  minReliableDepth?: number;
}

/** Gewinnchancen-Toleranz in Prozentpunkten (dokumentiert, siehe Header). */
export const WIN_CHANCE_TOLERANCE_PCT = 5;
/** Obergrenze für noch solide, straffrei wiederholbare Züge (Option A). */
export const SOLID_WIN_CHANCE_MAX_PCT = 7.0;
/** cp-Toleranz aus Nutzersicht (dokumentiert, siehe Header). */
export const CP_TOLERANCE = 50;
/** Großzügigere cp-Toleranz für klar gewonnene Stellungen bei Materialchancen. */
export const MATERIAL_CP_TOLERANCE = 85;
/** Ab dieser Gewinnchance gilt eine Patt-/Remissetzung als verspielter Gewinn. */
export const CLEARLY_WINNING_PCT = 90;
/** Maximale Prüftiefe für Trainingszüge, damit tiefe PC-Partien auch mobil zügig prüfbar bleiben. */
export const MAX_TRAINING_JUDGE_DEPTH = 14;

export function judgeTargetDepth(evalBefore: EngineEvalResult): number {
  return Math.min(MAX_TRAINING_JUDGE_DEPTH, Math.max(12, evalBefore.actualDepth ?? evalBefore.depth ?? 12));
}

function extractLegalPv(fen: string, pv: readonly string[] | undefined, maxPlies = 6): { uci: string[]; firstSan?: string } {
  if (!pv?.length) return { uci: [] };
  const uciList: string[] = [];
  let firstSan: string | undefined;
  try {
    const board = new Chess(fen);
    for (const raw of pv.slice(0, maxPlies)) {
      const uci = normalizeUci(raw);
      if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) break;
      try {
        const played = board.move({
          from: uci.slice(0, 2) as Square,
          to: uci.slice(2, 4) as Square,
          promotion: (uci[4] || undefined) as never,
        });
        if (!played) break;
        uciList.push(uci);
        if (!firstSan) firstSan = played.san;
      } catch {
        break;
      }
    }
  } catch {
    return { uci: [] };
  }
  return { uci: uciList, firstSan };
}

function mateIsForPlayer(mate: number | undefined, color: 'w' | 'b'): boolean {
  if (mate === undefined || mate === 0) return false;
  return (mate > 0 && color === 'w') || (mate < 0 && color === 'b');
}

function mateIsAgainstPlayer(mate: number | undefined, color: 'w' | 'b'): boolean {
  if (mate === undefined || mate === 0) return false;
  return !mateIsForPlayer(mate, color);
}

function normalizeUci(uci: string): string {
  return (uci || '').trim().toLowerCase();
}

/**
 * Bewertet einen Trainingsversuch schachlich. Siehe Datei-Header für die
 * genaue Reihenfolge der Prüfschritte.
 */
export async function judgeTrainingAttempt(
  fenBefore: string,
  playedUciRaw: string,
  bestUciRaw: string,
  evalBefore: EngineEvalResult,
  deps: JudgeDeps = {}
): Promise<TrainingJudgement> {
  const playedUci = normalizeUci(playedUciRaw);
  const bestUci = normalizeUci(bestUciRaw);
  const baselineDepth = judgeTargetDepth(evalBefore);
  const requiredDepth =
    deps.minReliableDepth !== undefined
      ? Math.max(12, deps.minReliableDepth)
      : Math.max(12, deps.depth ?? baselineDepth, baselineDepth);
  const comparisonDeps = { ...deps, depth: requiredDepth };
  const userColor: 'w' | 'b' = new Chess(fenBefore).turn();

  const illegal: TrainingJudgement = {
    legal: false,
    playedSan: playedUci,
    fenAfter: null,
    isTerminal: false,
    verdict: { kind: 'wrong', reason: 'Der Zug ist in dieser Stellung nicht legal.' },
  };

  // 1) Legalität — vollständige UCI inklusive Promotion wird verglichen.
  let fenAfter: string;
  let playedSan: string;
  try {
    const chess = new Chess(fenBefore);
    const played = chess.move({
      from: playedUci.substring(0, 2) as Square,
      to: playedUci.substring(2, 4) as Square,
      promotion: playedUci[4] as never,
    });
    if (!played) return illegal;
    fenAfter = chess.fen();
    playedSan = played.san;
  } catch {
    return illegal;
  }

  const post = new Chess(fenAfter);
  // Legal checkmate is proven even when the engine is unavailable.
  if (post.isCheckmate()) return { legal: true, playedSan, fenAfter, isTerminal: true,
    verdict: { kind: 'accepted', reason: 'Dein Zug setzt sofort Matt.' } };
  if (!isUsableEval(evalBefore)) return tolerateWithoutEngine(playedSan, fenAfter);
  if (playedUci === bestUci) return { legal: true, playedSan, fenAfter, isTerminal: post.isGameOver(), verdict: { kind: 'best' } };
  const beforeWinChance = getPlayerWinChance(evalBefore, userColor);
  const clearlyWinning = mateIsForPlayer(evalBefore.mate, userColor) || beforeWinChance >= CLEARLY_WINNING_PCT;

  if (post.isStalemate() || post.isInsufficientMaterial() || post.isDraw()) {
    // R03: Remis relativ zum belegten Besten — wenn der belegte Bestzug
    // SOFORT mattsetzt (legal, chess.js-nachweisbar), ist Remis eine
    // Gewinnverspielung, unabhängig von der 90%-Schwelle (Probe: +5.0,
    // Patt ≈ 86% Gewinnaussicht).
    if (bestMoveWinsByMate(fenBefore, bestUci, userColor)) {
      return {
        legal: true,
        playedSan,
        fenAfter,
        isTerminal: true,
        verdict: {
          kind: 'wrong',
          reason: 'Dein Zug erzwingt sofort Remis, aber es gab einen sofortigen Mattzug — der Gewinn war da.',
        },
      };
    }
    if (clearlyWinning) {
      const what = post.isStalemate() ? 'Patt gesetzt' : 'Remis durch Materialmangel/Regelwerk';
      return {
        legal: true,
        playedSan,
        fenAfter,
        isTerminal: true,
        verdict: {
          kind: 'wrong',
          reason: `Du hast ${what} und damit den Gewinn verspielt. Es gab einen Gewinnweg.`,
        },
      };
    }
    // Verlorene/ausgeglichene Stellung gerettet — KEIN Fehler (T07).
    return {
      legal: true,
      playedSan,
      fenAfter,
      isTerminal: true,
      verdict: {
        kind: 'accepted',
        reason: post.isStalemate()
          ? 'Dein Zug erzwingt sofort Remis durch Patt — in dieser Stellung eine Rettung, kein Fehler.'
          : 'Dein Zug erzwingt sofort Remis — in dieser Stellung eine Rettung, kein Fehler.',
      },
    };
  }

  // 3) Erzwungenes Matt halten (strenge Prüfung in Mattstellungen).
  if (mateIsForPlayer(evalBefore.mate, userColor)) {
    const evalAfter = await evaluate(comparisonDeps, fenAfter);
    if (!evalAfter) return tolerateWithoutEngine(playedSan, fenAfter);
    if (mateIsForPlayer(evalAfter.mate, userColor)) {
      return {
        legal: true,
        playedSan,
        fenAfter,
        isTerminal: false,
        verdict: {
          kind: 'accepted',
          reason: `Dein Zug erhält das erzwungene Matt (Matt in ${Math.abs(evalAfter.mate!)}).`,
        },
      };
    }
    const refutation = extractLegalPv(fenAfter, evalAfter.pv);
    const replyHint = refutation.firstSan ? ` (Gegner antwortet mit ${refutation.firstSan})` : '';
    return {
      legal: true,
      playedSan,
      fenAfter,
      isTerminal: false,
      evalAfter,
      refutationPv: refutation.uci,
      refutationSan: refutation.firstSan,
      verdict: {
        kind: 'wrong',
        reason: `Der Bestzug ${bestUciToSanHint(fenBefore, bestUci)} erzwang Matt, dein Zug verliert das Matt (jetzt ${formatEval(evalAfter.scoreCp, evalAfter.mate)})${replyHint}.`,
      },
    };
  }

  // 4) Kein Terminalergebnis: Engine relativ zum Bestzug bewerten.
  const evalAfter = await evaluate(comparisonDeps, fenAfter);
  if (!evalAfter) return tolerateWithoutEngine(playedSan, fenAfter);

  // Matt gegen den Spieler erlaubt? Immer falsch — außer man war selbst schon
  // verloren (dann gilt die "verschärft nicht"-Toleranz unten).
  if (mateIsAgainstPlayer(evalAfter.mate, userColor)) {
    const refutation = extractLegalPv(fenAfter, evalAfter.pv);
    const replyHint = refutation.firstSan ? ` (Gegner startet mit ${refutation.firstSan})` : '';
    if (mateIsAgainstPlayer(evalBefore.mate, userColor)) {
      const beforeDist = Math.abs(evalBefore.mate!);
      const afterDist = Math.abs(evalAfter.mate!);
      if (afterDist > beforeDist) {
        return {
          legal: true,
          playedSan,
          fenAfter,
          isTerminal: false,
          evalAfter,
          verdict: {
            kind: 'accepted',
            reason: `Die Stellung war bereits verloren; dein Zug kauft Zeit (Matt in ${afterDist} statt ${beforeDist}) — kein Fehler.`,
          },
        };
      }
      if (afterDist === beforeDist) {
        return {
          legal: true,
          playedSan,
          fenAfter,
          isTerminal: false,
          evalAfter,
          verdict: {
            kind: 'accepted',
            reason: `Die Stellung war bereits verloren (Matt in ${afterDist}); dein Zug verschärft die Lage nicht.`,
          },
        };
      }
      return {
        legal: true,
        playedSan,
        fenAfter,
        isTerminal: false,
        evalAfter,
        refutationPv: refutation.uci,
        refutationSan: refutation.firstSan,
        verdict: {
          kind: 'wrong',
          reason: `Dein Zug erlaubt Matt in ${afterDist} — schneller als nötig (Matt in ${beforeDist} war haltbar)${replyHint}.`,
        },
      };
    }
    return {
      legal: true,
      playedSan,
      fenAfter,
      isTerminal: false,
      evalAfter,
      refutationPv: refutation.uci,
      refutationSan: refutation.firstSan,
      verdict: {
        kind: 'wrong',
        reason: `Dein Zug erlaubt Matt in ${Math.abs(evalAfter.mate!)} (${formatEval(evalBefore.scoreCp, evalBefore.mate)} → ${formatEval(evalAfter.scoreCp, evalAfter.mate)})${replyHint}.`,
      },
    };
  }

  const beforeCp = userColor === 'w' ? evalBefore.scoreCp : -evalBefore.scoreCp;
  const afterCp = userColor === 'w' ? evalAfter.scoreCp : -evalAfter.scoreCp;
  const cpLoss = beforeCp - afterCp;
  const winChanceDrop = Math.max(0, beforeWinChance - getPlayerWinChance(evalAfter, userColor));
  const materialWithinTolerance = Boolean(deps?.preserveMaterialOpportunity) && afterCp >= 200 && cpLoss <= MATERIAL_CP_TOLERANCE;

  if (cpLoss <= CP_TOLERANCE || materialWithinTolerance || (!deps?.preserveMaterialOpportunity && winChanceDrop <= WIN_CHANCE_TOLERANCE_PCT)) {
    const parts: string[] = [];
    if (winChanceDrop > 0.05) parts.push(`${winChanceDrop.toFixed(1)}% Gewinnchancenverlust`);
    if (cpLoss > 5) parts.push(`Bewertung ${formatEval(evalBefore.scoreCp, evalBefore.mate)} → ${formatEval(evalAfter.scoreCp, evalAfter.mate)}`);
    return {
      legal: true,
      playedSan,
      fenAfter,
      isTerminal: false,
      evalAfter,
      verdict: {
        kind: 'accepted',
        reason: parts.length > 0
          ? `Gleichwertige Alternative${materialWithinTolerance ? ' (klarer Gewinn bleibt erhalten)' : ` (Toleranz ${WIN_CHANCE_TOLERANCE_PCT}%)`}: ${parts.join(', ')}.`
          : 'Gleichwertige Alternative — dein Zug hält die Bewertung.',
      },
    };
  }

  if (!deps?.preserveMaterialOpportunity && winChanceDrop <= SOLID_WIN_CHANCE_MAX_PCT) {
    return {
      legal: true,
      playedSan,
      fenAfter,
      isTerminal: false,
      evalAfter,
      verdict: {
        kind: 'solid',
        reason: `${playedSan} ist ein solider Zug (${formatEval(evalBefore.scoreCp, evalBefore.mate)} → ${formatEval(evalAfter.scoreCp, evalAfter.mate)}), aber es gibt eine noch stärkere Fortsetzung. Probier es nochmal — der Versuch zählt nicht.`,
      },
    };
  }

  const refutation = extractLegalPv(fenAfter, evalAfter.pv);
  const replyHint = refutation.firstSan ? ` — der Gegner antwortet stark mit ${refutation.firstSan}` : '';
  return {
    legal: true,
    playedSan,
    fenAfter,
    isTerminal: false,
    evalAfter,
    refutationPv: refutation.uci,
    refutationSan: refutation.firstSan,
    verdict: {
      kind: 'wrong',
      reason: `${playedSan} verliert ${winChanceDrop.toFixed(1)}% Gewinnchancen (${formatEval(evalBefore.scoreCp, evalBefore.mate)} → ${formatEval(evalAfter.scoreCp, evalAfter.mate)})${replyHint}.`,
    },
  };
}

function bestUciToSanHint(fen: string, bestUci: string): string {
  try {
    const chess = new Chess(fen);
    return chess.move({
      from: bestUci.substring(0, 2) as Square,
      to: bestUci.substring(2, 4) as Square,
      promotion: bestUci[4] as never,
    }).san;
  } catch {
    return bestUci;
  }
}

async function evaluate(deps: JudgeDeps, fen: string): Promise<EngineEvalResult | null> {
  if (!deps.evaluateAfter) return null;
  try {
    const res = await deps.evaluateAfter(fen);
    // R03: unbelastbare Ergebnisse (unavailable/Platzhalter ohne Tiefe und
    // Matt) filtern — sonst fließen 0-cp-Garbage in den cp-Vergleich.
    if (!res || !isReliableEvaluation(res, Math.max(12, deps.depth ?? 12))) return null;
    return res;
  } catch {
    return null;
  }
}

/** R03: Belastbare Bewertung? Unavailable oder Platzhalter (Tiefe 0, kein Matt) → nein. */
function isUsableEval(e: EngineEvalResult): boolean {
  return isReliableEvaluation(e);
}

/**
 * Ohne belastbare Engine-Bewertung kein Urteil (T07/R03): weder als Fehler
 * werten (falsche Lapse) noch pauschal als Erfolg akzeptieren —
 * Technikprobleme dürfen Mastery und Scheduler nicht verändern.
 */
function tolerateWithoutEngine(playedSan: string, fenAfter: string): TrainingJudgement {
  return {
    legal: true,
    playedSan,
    fenAfter,
    isTerminal: false,
    verdict: {
      kind: 'uncertain',
      reason: 'Engine-Bewertung nicht verfügbar — der Versuch wird weder als Erfolg noch als Fehler gewertet.',
    },
  };
}

/** R03: Setzt der belegte Bestzug in fenBefore SOFORT matt (legal nachweisbar)? */
function bestMoveWinsByMate(fen: string, bestUci: string, color: 'w' | 'b'): boolean {
  if (!bestUci) return false;
  try {
    const chess = new Chess(fen);
    if (chess.turn() !== color) return false;
    chess.move({
      from: bestUci.substring(0, 2) as Square,
      to: bestUci.substring(2, 4) as Square,
      promotion: bestUci[4] as never,
    });
    return chess.isCheckmate();
  } catch {
    return false;
  }
}

// MATED_SCORE_CP wird hier nicht direkt genutzt, aber als Kontrakt exportiert
// (Stellungen mit |scoreCp| >= MATED_SCORE_CP sind synthetische Terminal-Evals
// aus terminalEval — der Judge behandelt sie über die mate-Felder, nicht cp).
export { MATED_SCORE_CP };
