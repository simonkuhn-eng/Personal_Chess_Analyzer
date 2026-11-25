import { Chess, type Move, type Square } from 'chess.js';
import { isReliableEvaluation } from './evaluationReliability';
import { lineEvidence } from './lineEvidence';
import type { EngineEvalResult, GameAnalysis, MissedOpportunity, MoveAnalysis } from '../types/chess';
import { annotateForcedMoves } from './forcedMoves';
import { updateMoveClassifications } from './moveClassification';

export const MISSED_OPPORTUNITY_VERSION = 1;
const VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
function material(board: Chess, color: 'w' | 'b'): number {
  return board.board().flat().reduce((sum, piece) => sum + (piece ? VALUES[piece.type] * (piece.color === color ? 1 : -1) : 0), 0);
}
function ownMate(result: EngineEvalResult, color: 'w' | 'b'): boolean {
  return result.mate !== undefined && result.mate !== 0 && (color === 'w' ? result.mate > 0 : result.mate < 0);
}
function play(board: Chess, uci: string): Move {
  return board.move({ from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion: uci[4] });
}

/** Reject truncated/illegal variations and unresolved recaptures. A queen
 * capture followed by a queen recapture must not become a queen-win motif.
 */
function replay(fen: string, line: string[], color: 'w' | 'b') {
  return lineEvidence(fen, line, color);
}

export function detectMissedOpportunity(move: MoveAnalysis): MissedOpportunity | undefined {
  if (move.isForced || move.quality === 'brilliant' || move.isCheckmate || move.uci === move.evalBefore.bestMoveUci ||
    !isReliableEvaluation(move.evalBefore) || !isReliableEvaluation(move.evalAfter)) return undefined;
  const bestLine = move.evalBefore.pv;
  if (!bestLine.length || bestLine[0] !== move.evalBefore.bestMoveUci) return undefined;
  const sign = move.color === 'w' ? 1 : -1;
  const cpLoss = (move.evalBefore.scoreCp - move.evalAfter.scoreCp) * sign;
  if (!ownMate(move.evalBefore, move.color) && (cpLoss < 100 || move.evalBefore.mate !== undefined || move.evalAfter.mate !== undefined)) return undefined;
  try {
    const before = new Chess(move.fenBefore);
    if (before.turn() !== move.color) return undefined;
    const chosen = new Chess(move.fenBefore);
    play(chosen, move.uci);
    if (chosen.fen() !== move.fenAfter || chosen.isCheckmate()) return undefined;
    const best = replay(move.fenBefore, bestLine, move.color);
    if (!best || ownMate(move.evalAfter, move.color)) return undefined;
    const first = play(new Chess(move.fenBefore), bestLine[0]);
    const depth = Math.min(move.evalBefore.actualDepth ?? move.evalBefore.depth, move.evalAfter.actualDepth ?? move.evalAfter.depth);
    const base = { version: MISSED_OPPORTUNITY_VERSION, bestMoveUci: bestLine[0], bestSan: first.san, bestLine: [...bestLine], depth };
    // Engine mate score AND a legally replayed PV ending with our checkmate.
    // A different surviving forced mate is explicitly excluded above.
    if (ownMate(move.evalBefore, move.color) && best.board.isCheckmate() && best.board.turn() !== move.color) {
      return { ...base, kind: 'mate', description: `Matt verpasst: ${first.san} hätte ein erzwungenes Matt eingeleitet.` };
    }
    // Material evidence is deliberately short-range and net of both sides'
    // captures. Compare against the actually played move and its best reply.
    if (move.evalBefore.mate !== undefined || move.evalAfter.mate !== undefined) return undefined;
    const replyLine = move.evalAfter.pv;
    if (!replyLine.length || replyLine[0] !== move.evalAfter.bestMoveUci) return undefined;
    const horizon = Math.min(12, bestLine.length, replyLine.length + 1);
    const bestMaterial = replay(move.fenBefore, bestLine.slice(0, horizon), move.color);
    const played = replay(move.fenBefore, [move.uci, ...replyLine].slice(0, horizon), move.color);
    if (!bestMaterial || !bestMaterial.settled || !played || !played.settled || played.board.isGameOver() || bestMaterial.board.isGameOver()) return undefined;
    const gain = bestMaterial.material - material(before, move.color);
    const missedGain = bestMaterial.material - played.material;
    if (cpLoss < 100 || gain < 2 || missedGain < 2 || bestLine.length < 2 || replyLine.length < 1) return undefined;
    return { ...base, kind: 'material', materialGain: gain,
      description: `Materialgewinn verpasst: Die Engine-Variante mit ${first.san} gewinnt netto ${gain} Materialpunkte; dein Zug nutzt diese Möglichkeit nicht gleichwertig.` };
  } catch {
    return undefined;
  }
}

/** Enrich existing analyses without changing severity, accuracy or scheduling.
 * No new engine searches and no invented tactic when the old PV is incomplete.
 */
export function annotateMissedOpportunities(game: GameAnalysis): GameAnalysis {
  game = updateMoveClassifications(annotateForcedMoves(game));
  if (game.missedOpportunityVersion === MISSED_OPPORTUNITY_VERSION) return game;
  return { ...game, missedOpportunityVersion: MISSED_OPPORTUNITY_VERSION,
    moves: game.moves.map(move => ({ ...move, missedOpportunity: detectMissedOpportunity(move) })) };
}
