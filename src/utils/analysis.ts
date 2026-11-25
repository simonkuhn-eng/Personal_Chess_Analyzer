import { MoveQuality, MoveAnalysis, EngineEvalResult } from '../types/chess';
import { Chess } from 'chess.js';

/** Pseudo-cp-Wert für Matt am Brett (T03): Endwert, nicht Engine-Aussage. */
export const MATED_SCORE_CP = 100000;
export const MOVE_CLASSIFICATION_VERSION = 1;

/**
 * Prüft, ob die Stellung terminale Spielausgänge erreicht (Matt/Remis) und
 * synthetisiert in dem Fall die Bewertung — statt die Engine auf eine tote
 * Position anzusetzen und `mate 0` als cp 0 fehlzudeuten (T03).
 * white-POV wie alle Engine-Evals. Exportiert für Regressionstests.
 */
export function terminalEval(chess: Chess): EngineEvalResult | null {
  if (chess.isCheckmate()) {
    // Seite am Zug ist matt → der Gegner hat mattgesetzt
    const winnerIsWhite = chess.turn() === 'b';
    // R10: Terminaltyp führen — mate 0 = „Matt am Brett“ (Konvention von
    // formatEval/EvalBar: Richtung über das scoreCp-Vorzeichen), damit die
    // Anzeige „#“/„−#“ statt ±1000.0 zeigt.
    return {
      scoreCp: winnerIsWhite ? MATED_SCORE_CP : -MATED_SCORE_CP,
      mate: 0,
      bestMoveUci: '',
      pv: [],
      depth: 0,
      actualDepth: 0,
      bound: 'exact',
      status: 'complete',
    };
  }
  if (chess.isStalemate() || chess.isInsufficientMaterial() || chess.isThreefoldRepetition() || chess.isDraw()) {
    return {
      scoreCp: 0,
      bestMoveUci: '',
      pv: [],
      depth: 0,
      actualDepth: 0,
      bound: 'exact',
      status: 'complete',
    };
  }
  return null;
}

// Standard Chess.com / Lichess winning chance function from Centipawns
export function calculateWinChance(scoreCp: number, mate?: number): number {
  if (mate !== undefined && mate !== 0) {
    // If mate for White (positive), win chance is near 100%
    if (mate > 0) {
      return Math.max(99.9, 100 - mate * 0.1);
    } else {
      return Math.min(0.1, 0 + Math.abs(mate) * 0.1);
    }
  }

  // Cap extreme centipawn evaluations
  const cappedCp = Math.max(-2000, Math.min(2000, scoreCp));
  // Standard sigmoidal formula: win % = 50 + 50 * (2 / (1 + exp(-0.00368208 * cp)) - 1)
  const winChance = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cappedCp)) - 1);
  return Math.max(0, Math.min(100, winChance));
}

// Convert win chance to the player's perspective
export function getPlayerWinChance(evalResult: EngineEvalResult, color: 'w' | 'b'): number {
  const whiteWinChance = calculateWinChance(evalResult.scoreCp, evalResult.mate);
  return color === 'w' ? whiteWinChance : 100 - whiteWinChance;
}

// CAPS accuracy approximation for a single move based on Win Chance drop
// HINWEIS (T04): Das ist eine LOKALE Näherung aus der Gewinnchancen-Differenz
// bei begrenzter Suchtiefe — kein exaktes Chess.com-CAPS.
export function calculateMoveAccuracy(winChanceDrop: number): number {
  if (winChanceDrop <= 0) return 100;
  // Apply a moderate strictness factor because local depth 12-18 analysis is
  // less stable than the deeper, platform-specific Chess.com analysis.
  const effectiveDrop = winChanceDrop * 1.35;
  const acc = 103.1668 * Math.exp(-0.04354 * effectiveDrop) - 3.1669;
  return Math.max(0, Math.min(100, acc));
}

export interface ClassifyMoveParams {
  color: 'w' | 'b';
  evalBefore: EngineEvalResult;
  evalAfter: EngineEvalResult;
  isPlayedMoveBest: boolean;
  isForced?: boolean;
  isCheckmate?: boolean;
  /**
   * Nur noch informativ — die Bewertung hängt NICHT mehr von der Zugnummer ab
   * (T04: die alte "frühe Bestzüge sind Buch"-Heuristik umging den
   * Out-of-book-Latch und wurde entfernt).
   */
  plyNumber?: number;
  /** Zug führt zu einer bekannten ECO-Buchstellung (Transpositionen inklusive). */
  isBookMove?: boolean;
  /** Optionaler ECO-Name der Buchstellung, für die openingAnnotation. */
  bookName?: string | null;
}

export interface MoveClassification {
  quality: MoveQuality;
  comment: string;
  winChanceDrop: number;
  /** Eröffnungstheorie-Name als ZUSATZINFO — unabhängig von quality (T04). */
  openingAnnotation?: string;
}

/** One user-facing category per move; the raw engine severity stays available. */
export function moveCategory(move: Pick<MoveAnalysis, 'quality' | 'missedOpportunity'>): MoveQuality {
  return move.quality === 'brilliant' ? 'brilliant' : move.missedOpportunity ? 'miss' : move.quality;
}

/** Buchhinweise ergänzen die Bewertung; belegte Highlights behalten ihr eigenes Symbol. */
export function reviewBadgeQuality(move: Pick<MoveAnalysis, 'quality' | 'openingAnnotation' | 'missedOpportunity'>): MoveQuality {
  const category = moveCategory(move);
  return category === 'brilliant' || category === 'miss' ? category : move.openingAnnotation ? 'book' : category;
}

/** Validate UCI in the supplied position; historical comparisons pass fenBefore. */
export function legalEngineArrow(fen: string, uci?: string): { from: string; to: string } | null {
  if (!uci || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return null;
  try {
    const move = new Chess(fen).moves({ verbose: true })
      .find(candidate => `${candidate.from}${candidate.to}${candidate.promotion ?? ''}` === uci);
    return move ? { from: move.from, to: move.to } : null;
  } catch {
    return null;
  }
}

export function classifyMove(params: ClassifyMoveParams): MoveClassification {
  const { color, evalBefore, evalAfter, isPlayedMoveBest } = params;

  // T04: Buchzugehörigkeit ist eine Zusatzinformation, KEIN Ersatz für die
  // Zugqualität. Auch Theoriezüge werden normal bewertet — ein Fehler in
  // bekannter Theorie bleibt ein Fehler (Narrenmatt-Weiß erhält keine
  // 100%-Genauigkeit, sondern die reale Bewertung).
  const openingAnnotation = params.isBookMove
    ? params.bookName
      ? `Buchzug (${params.bookName})`
      : 'Buchzug aus der Eröffnungstheorie'
    : undefined;

  const pWinBefore = getPlayerWinChance(evalBefore, color);
  const pWinAfter = getPlayerWinChance(evalAfter, color);
  const winChanceDrop = Math.max(0, pWinBefore - pWinAfter);

  if (params.isForced) {
    return { quality: 'best', comment: 'Erzwungener Zug: Es gab nur einen legalen Zug.', winChanceDrop: 0, openingAnnotation };
  }

  const ownMate = (value: EngineEvalResult) => value.mate !== undefined && Number.isFinite(value.mate) &&
    (value.mate === 0 ? (color === 'w' ? value.scoreCp > 0 : value.scoreCp < 0) : (color === 'w' ? value.mate > 0 : value.mate < 0));
  if (params.isCheckmate || (evalAfter.mate === 0 && ownMate(evalAfter))) {
    return { quality: 'best', comment: 'Der Zug setzt sofort Schachmatt.', winChanceDrop, openingAnnotation };
  }
  if (evalBefore.mate && evalAfter.mate && Number.isFinite(evalBefore.mate) && Number.isFinite(evalAfter.mate) &&
    Math.sign(evalBefore.mate) === Math.sign(evalAfter.mate)) {
    // Before our winning move M3 becomes M2 after it: one of our moves has
    // already been used. When defending, the opponent's move count stays M3.
    const winning = ownMate(evalBefore);
    const before = Math.abs(evalBefore.mate);
    const after = Math.abs(evalAfter.mate);
    const worse = winning ? after >= before : after < before;
    if (worse) return { quality: 'excellent', comment: winning
      ? 'Das Matt bleibt erzwungen, aber es gab eine kürzere Mattfolge.'
      : 'Weiterhin erzwungenes Matt gegen dich; eine andere Verteidigung hätte es länger hinausgezögert.', winChanceDrop, openingAnnotation };
    return { quality: 'best', comment: winning ? 'Kürzeste Mattfolge laut Engine erhalten.' : 'Längste Verteidigung gegen das Matt laut Engine.', winChanceDrop, openingAnnotation };
  }

  // T04: Bester Zug laut vorheriger Suche, ABER großer Bewertungsverlust —
  // das sind widersprüchliche Engine-Daten (Tiefe zu gering). Niemals
  // gleichzeitig "Bester Zug" und hohen Verlust speichern: ehrlich als
  // Ungenauigkeit mit Instabilitätshinweis kennzeichnen.
  if (isPlayedMoveBest && winChanceDrop >= 15) {
    return {
      quality: 'inaccuracy',
      comment: 'Bestzug laut vorheriger Suche, aber instabile Bewertung — Tiefe zu gering für ein eindeutiges Urteil.',
      winChanceDrop,
      openingAnnotation,
    };
  }

  if (isPlayedMoveBest && ownMate(evalBefore) && !ownMate(evalAfter)) {
    return { quality: 'inaccuracy', comment: 'Bestzug laut vorheriger Suche, aber der Mattnachweis wird nicht bestätigt. Für ein eindeutiges Urteil tiefer analysieren.', winChanceDrop, openingAnnotation };
  }

  // Best move
  if (isPlayedMoveBest) {
    return { quality: 'best', comment: 'Bester Zug laut Engine.', winChanceDrop, openingAnnotation };
  }

  // Standard thresholds based on win probability loss
  // (Genauigkeitsformel: lokale Nähegen-Abschätzung, siehe calculateMoveAccuracy)
  if (winChanceDrop < 3.0) {
    return { quality: 'excellent', comment: 'Exzellenter Zug, nahezu gleichwertig zum berechneten Bestzug.', winChanceDrop, openingAnnotation };
  }
  if (winChanceDrop < 7.0) {
    return { quality: 'good', comment: 'Guter, solider Zug.', winChanceDrop, openingAnnotation };
  }
  if (winChanceDrop < 15.0) {
    return { quality: 'inaccuracy', comment: 'Ungenauigkeit. Es gab eine präzisere Fortsetzung.', winChanceDrop, openingAnnotation };
  }
  if (winChanceDrop < 25.0) {
    return { quality: 'mistake', comment: 'Fehler. Verschlechtert die eigene Position spürbar.', winChanceDrop, openingAnnotation };
  }

  // Severe loss: Blunder
  return { quality: 'blunder', comment: 'Schwerer Patzer! Dreht die Partie oder gibt entscheidendes Material ab.', winChanceDrop, openingAnnotation };
}

// Format centipawns or mate into human readable string (+1.4, -0.8, M3, -M2)
// T03: mate 0 = Matt am Brett — Gewinner aus dem white-POV-scoreCp-Vorzeichen.
export function formatEval(scoreCp: number, mate?: number): string {
  if (mate !== undefined && mate === 0) {
    return scoreCp >= 0 ? '#' : '-#';
  }
  if (mate !== undefined && mate !== 0) {
    return mate > 0 ? `M${mate}` : `-M${Math.abs(mate)}`;
  }
  const evalScore = scoreCp / 100;
  return evalScore >= 0 ? `+${evalScore.toFixed(1)}` : evalScore.toFixed(1);
}
