import { Chess, type Square } from 'chess.js';
import type { BrilliantEvidence, EngineEvalResult, GameAnalysis, MoveAnalysis } from '../types/chess';
import type { ElectronAPI, TopMoveResult } from '../types/electron';
import { classifyMove, getPlayerWinChance, terminalEval } from './analysis';

export const BRILLIANT_VERSION = 1;
const VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
type Engine = Pick<ElectronAPI['engine'], 'evaluateFen' | 'evaluateFenMultiPv'>;
export interface SacrificeCandidate {
  piece: string;
  square: string;
  acceptingMoveUci: string;
  acceptedFen: string;
  materialInvestment: number;
}

export class BrilliantScanCancelledError extends Error {}
export class BrilliantEngineUnavailableError extends Error {}

function material(board: Chess, color: 'w' | 'b'): number {
  return board.board().flat().reduce((sum, piece) => sum + (piece ? VALUES[piece.type] * (piece.color === color ? 1 : -1) : 0), 0);
}

function apply(board: Chess, uci: string) {
  return board.move({ from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion: uci[4] });
}

function rawSacrificeCandidates(board: Chess, playedUci: string): SacrificeCandidate[] {
  const color = board.turn();
  const beforeMaterial = material(board, color);
  const played = apply(board, playedUci);
  if (played.piece === 'p' || played.piece === 'k' || board.isGameOver()) return [];
  const result: SacrificeCandidate[] = [];
  for (const capture of board.moves({ verbose: true })) {
    if (!capture.captured || capture.to !== played.to) continue;
    const accepted = new Chess(board.fen());
    accepted.move(capture);
    if (accepted.isGameOver()) continue;
    let bestRecovery = material(accepted, color);
    for (const reply of accepted.moves({ verbose: true })) {
      if (!reply.captured || reply.to !== capture.to) continue;
      accepted.move(reply);
      bestRecovery = Math.max(bestRecovery, material(accepted, color));
      accepted.undo();
    }
    const investment = beforeMaterial - bestRecovery;
    if (investment < 2) continue;
    result.push({
      piece: played.piece, square: played.to,
      acceptingMoveUci: capture.from + capture.to + (capture.promotion || ''),
      acceptedFen: accepted.fen(), materialInvestment: investment,
    });
  }
  return result;
}

function isOriginUnderLosingAttack(fenBefore: string, originSquare: Square, color: 'w' | 'b'): boolean {
  try {
    const parts = fenBefore.split(' ');
    if (parts.length < 4) return false;
    parts[1] = color === 'w' ? 'b' : 'w';
    parts[3] = '-';
    const oppBoard = new Chess(parts.join(' '));
    const beforeMaterial = material(oppBoard, color);
    for (const capture of oppBoard.moves({ verbose: true })) {
      if (!capture.captured || capture.to !== originSquare) continue;
      const accepted = new Chess(oppBoard.fen());
      accepted.move(capture);
      if (accepted.isGameOver()) return true;
      let bestRecovery = material(accepted, color);
      for (const reply of accepted.moves({ verbose: true })) {
        if (!reply.captured || reply.to !== originSquare) continue;
        accepted.move(reply);
        bestRecovery = Math.max(bestRecovery, material(accepted, color));
        accepted.undo();
      }
      if (beforeMaterial - bestRecovery >= 2) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** A legal capture of the moved non-pawn must cost >=2 net material points,
 * even after the best immediate recapture. Merely attacked/pinned pieces,
 * pawn gambits, promotions, equal exchanges and trapped desperados (attacked
 * on origin with no safe escape square) are not sacrifice evidence.
 */
export function sacrificeCandidates(fenBefore: string, playedUci: string): SacrificeCandidate[] {
  try {
    const candidates = rawSacrificeCandidates(new Chess(fenBefore), playedUci);
    if (!candidates.length) return [];
    const originSquare = playedUci.slice(0, 2) as Square;
    const board = new Chess(fenBefore);
    const color = board.turn();
    if (isOriginUnderLosingAttack(fenBefore, originSquare, color)) {
      const legalFromOrigin = board.moves({ verbose: true }).filter((move) => move.from === originSquare);
      const hasSafeEscape = legalFromOrigin.some((move) => {
        const uci = move.from + move.to + (move.promotion || '');
        return rawSacrificeCandidates(new Chess(fenBefore), uci).length === 0;
      });
      if (!hasSafeEscape) return [];
    }
    return candidates;
  } catch {
    return [];
  }
}

function reliable(result: EngineEvalResult, depth: number): boolean {
  return result.status === 'complete' && (!result.bound || result.bound === 'exact') &&
    Number.isFinite(result.scoreCp) && (result.actualDepth ?? result.depth) >= depth;
}

function playerScore(result: Pick<EngineEvalResult, 'scoreCp' | 'mate'>, color: 'w' | 'b'): number {
  const sign = color === 'w' ? 1 : -1;
  if (result.mate !== undefined && result.mate !== 0) return Math.sign(result.mate) * sign * 100000;
  return result.scoreCp * sign;
}

function plausible(move: MoveAnalysis): boolean {
  return !move.isForced && ['best', 'excellent', 'good', 'brilliant'].includes(move.quality) &&
    move.evalBefore.status !== 'unavailable' && move.evalAfter.status !== 'unavailable' &&
    move.winChanceDrop <= 7 && playerScore(move.evalAfter, move.color) >= -50;
}

function topEval(move: TopMoveResult, depth: number): EngineEvalResult {
  return { ...move, bestMoveUci: move.uci, depth, actualDepth: depth, status: 'complete' };
}

export function needsBrilliantScan(game: Pick<GameAnalysis, 'brilliantScan'>, depth: number): boolean {
  return game.brilliantScan?.version !== BRILLIANT_VERSION || !game.brilliantScan.complete || game.brilliantScan.depth < Math.max(14, depth);
}

/** Local heuristic, deliberately not a claim to reproduce Chess.com's grading.
 * Expensive searches are limited to plausible legal sacrifice candidates.
 * MultiPV verifies move quality AND a non-sacrificing alternative. A separate
 * search verifies compensation if the opponent actually accepts the sacrifice.
 */
export async function scanBrilliantMoves(
  game: GameAnalysis,
  engine: Engine,
  requestedDepth: number,
  shouldCancel: () => boolean = () => false,
  onProgress?: (current: number, total: number) => void,
): Promise<GameAnalysis> {
  const depth = Math.max(14, Math.min(30, Math.round(requestedDepth)));
  const assertActive = () => { if (shouldCancel()) throw new BrilliantScanCancelledError('Prüfung abgebrochen.'); };
  assertActive();
  const candidates = game.moves.flatMap((move, index) => {
    const sacrifices = plausible(move) ? sacrificeCandidates(move.fenBefore, move.uci) : [];
    return sacrifices.length ? [{ move, index, sacrifices }] : [];
  });
  const evidence = new Map<number, BrilliantEvidence>();
  let complete = !game.analysisPartial;
  for (let n = 0; n < candidates.length; n++) {
    assertActive();
    onProgress?.(n + 1, candidates.length);
    const { move, index, sacrifices } = candidates[n];
    const position = new Chess(move.fenBefore);
    const legalCount = position.moves().length;
    if (legalCount < 2) continue;
    const startFen = game.moves[0].fenBefore;
    const history = game.moves.slice(0, index).map(previous => previous.uci);
    const root = await engine.evaluateFenMultiPv(startFen, depth, 5, history, move.fenBefore);
    assertActive();
    if (root.status === 'unavailable') throw new BrilliantEngineUnavailableError('Stockfish ist für die Prüfung nicht verfügbar.');
    if (!reliable(root, depth) || root.moves.length < Math.min(5, legalCount)) { complete = false; continue; }
    const played = root.moves.find(candidate => candidate.uci === move.uci);
    if (!played) continue;
    const best = root.moves.reduce((a, b) => playerScore(a, move.color) >= playerScore(b, move.color) ? a : b);
    const playedScore = playerScore(played, move.color);
    const bestScore = playerScore(best, move.color);
    if (playedScore < 0 || bestScore - playedScore > 50 ||
      getPlayerWinChance(topEval(best, depth), move.color) - getPlayerWinChance(topEval(played, depth), move.color) > 3) continue;
    // All top alternatives must be legal; inspect their sacrifice status.
    const alternatives = root.moves.filter(candidate => candidate.uci !== move.uci &&
      position.moves({ verbose: true }).some(legal => legal.from + legal.to + (legal.promotion || '') === candidate.uci) &&
      sacrificeCandidates(move.fenBefore, candidate.uci).length === 0);
    if (!alternatives.length) continue; // insufficient evidence, never invent a label
    const alternative = alternatives.reduce((a, b) => playerScore(a, move.color) >= playerScore(b, move.color) ? a : b);
    // A decisive non-sacrificing alternative means the game was already won
    // without this idea. Such easy conversions are not awarded brilliance.
    if (playerScore(alternative, move.color) >= 500) continue;
    let proof: BrilliantEvidence | undefined;
    let allAcceptedLinesSafe = true;
    for (const sacrifice of sacrifices) {
      assertActive();
      const acceptedBoard = new Chess(sacrifice.acceptedFen);
      const acceptedEval = terminalEval(acceptedBoard) ?? await engine.evaluateFen(startFen, depth,
        [...history, move.uci, sacrifice.acceptingMoveUci], sacrifice.acceptedFen);
      assertActive();
      if (acceptedEval.status === 'unavailable') throw new BrilliantEngineUnavailableError('Stockfish ist für die Prüfung nicht verfügbar.');
      if (!reliable(acceptedEval, depth)) { complete = false; allAcceptedLinesSafe = false; break; }
      if (playerScore(acceptedEval, move.color) < 0) { allAcceptedLinesSafe = false; break; }
      proof ??= {
        version: BRILLIANT_VERSION, piece: sacrifice.piece, square: sacrifice.square,
        materialInvestment: sacrifice.materialInvestment, acceptingMoveUci: sacrifice.acceptingMoveUci,
        acceptedEval, playedScoreCp: played.scoreCp, playedMate: played.mate,
        alternativeUci: alternative.uci, alternativeScoreCp: alternative.scoreCp, alternativeMate: alternative.mate, depth,
      };
    }
    if (allAcceptedLinesSafe && proof) evidence.set(move.ply, proof);
  }
  assertActive();
  const moves = game.moves.map(move => {
    const proof = evidence.get(move.ply);
    if (!proof) {
      if (move.quality !== 'brilliant' || !move.brilliantEvidence) return move;
      const original = classifyMove({ color: move.color, evalBefore: move.evalBefore, evalAfter: move.evalAfter,
        isPlayedMoveBest: move.evalBefore.bestMoveUci === move.uci, isForced: move.isForced, isCheckmate: move.isCheckmate });
      return { ...move, quality: original.quality, comment: original.comment, brilliantEvidence: undefined };
    }
    return { ...move, quality: 'brilliant' as const, brilliantEvidence: proof, missedOpportunity: undefined,
      comment: `Brillant: sehr gutes Figurenopfer. Auch nach Annahme des Opfers bestätigt die Engine ausreichende Kompensation (Tiefe ${depth}).` };
  });
  const summaryWhite = { ...game.summaryWhite };
  const summaryBlack = { ...game.summaryBlack };
  for (const summary of [summaryWhite, summaryBlack]) for (const quality of Object.keys(summary) as Array<keyof typeof summary>) summary[quality] = 0;
  for (const move of moves) (move.color === 'w' ? summaryWhite : summaryBlack)[move.quality]++;
  return { ...game, moves, summaryWhite, summaryBlack, missedOpportunityVersion: undefined, brilliantScan: { version: BRILLIANT_VERSION, depth, complete } };
}
