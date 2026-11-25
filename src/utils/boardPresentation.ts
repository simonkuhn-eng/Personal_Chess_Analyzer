import { materialBalance } from './lineEvidence';
import { Chess, type Color, type Square } from 'chess.js';
import type { MoveAnalysis } from '../types/chess';

export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q';
export const PIECE_VALUES: Record<PieceType, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };
export type BoardArrow = { from: string; to: string };

/** Legal potential captures against the side to move, plus actual checks.
 * A warning is not a claim that the capture is forced or tactically winning.
 */
export function threatenedPieceArrows(fen: string, limit = 2): BoardArrow[] {
  let chess: Chess;
  try { chess = new Chess(fen); } catch { return []; }
  const us = chess.turn();
  const opponent: Color = us === 'w' ? 'b' : 'w';
  const candidates: Array<BoardArrow & { priority: number }> = [];

  if (chess.inCheck()) {
    const king = chess.board().flat().find(piece => piece?.color === us && piece.type === 'k');
    if (king) for (const from of chess.attackers(king.square, opponent)) candidates.push({ from, to: king.square, priority: 1000 });
  }

  // A geometric attacker may be pinned. Generate legal moves from the
  // opponent's perspective, then test whether a recapture is actually legal.
  const fields = fen.split(/\s+/);
  fields[1] = opponent;
  fields[3] = '-'; // En passant rights belong to the actual side to move.
  const probe = new Chess(fields.join(' '));
  const byVictim = new Map<string, typeof candidates[number]>();
  for (const capture of probe.moves({ verbose: true })) {
    const victim = chess.get(capture.to);
    if (!capture.captured || !victim || victim.color !== us || victim.type === 'k') continue;
    const victimValue = PIECE_VALUES[victim.type as PieceType];
    const attackerValue = PIECE_VALUES[capture.piece as PieceType] ?? 100;
    probe.move(capture);
    const defended = probe.moves({ verbose: true }).some(reply => reply.to === capture.to && Boolean(reply.captured));
    probe.undo();
    if (defended && attackerValue >= victimValue) continue;
    const candidate = { from: capture.from, to: capture.to, priority: victimValue * 10 + (defended ? 0 : 5) - attackerValue };
    const previous = byVictim.get(capture.to);
    if (!previous || candidate.priority > previous.priority) byVictim.set(capture.to, candidate);
  }
  candidates.push(...byVictim.values());

  return candidates.sort((a, b) => b.priority - a.priority).slice(0, Math.max(0, limit))
    .map(({ from, to }) => ({ from, to }));
}

export interface CapturedMaterial {
  byWhite: PieceType[];
  byBlack: PieceType[];
  whiteLead: number;
  blackLead: number;
}

/** Captures shown beside each player; promotion gains count toward the lead. */
export function capturedMaterial(moves: MoveAnalysis[], ply: number): CapturedMaterial {
  const byWhite: PieceType[] = [];
  const byBlack: PieceType[] = [];
  let initial = 0;
  try { if (moves[0]) initial = materialBalance(new Chess(moves[0].fenBefore), 'w'); } catch { /* Invalid positions have no inferred balance. */ }
  let whiteGain = Math.max(0, initial);
  let blackGain = Math.max(0, -initial);
  for (const move of moves.slice(0, Math.max(0, ply))) {
    const captures = move.color === 'w' ? byWhite : byBlack;
    if (move.captured && move.captured in PIECE_VALUES) {
      const type = move.captured as PieceType;
      captures.push(type);
      if (move.color === 'w') whiteGain += PIECE_VALUES[type];
      else blackGain += PIECE_VALUES[type];
    }
    const promotion = move.uci?.[4] as PieceType | undefined;
    if (promotion && promotion in PIECE_VALUES) {
      const gain = PIECE_VALUES[promotion] - PIECE_VALUES.p;
      if (move.color === 'w') whiteGain += gain;
      else blackGain += gain;
    }
  }
  const order: PieceType[] = ['q', 'r', 'b', 'n', 'p'];
  byWhite.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  byBlack.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return { byWhite, byBlack, whiteLead: Math.max(0, whiteGain - blackGain), blackLead: Math.max(0, blackGain - whiteGain) };
}

/** Material after a training variation branching from an analyzed position. */
export function capturedMaterialAfterLine(moves: MoveAnalysis[], ply: number, fen: string, lineUci: string[]): CapturedMaterial {
  const base = capturedMaterial(moves, ply);
  const byWhite = [...base.byWhite];
  const byBlack = [...base.byBlack];
  let advantage = base.whiteLead - base.blackLead;
  let chess: Chess;
  try { chess = new Chess(fen); } catch { return base; }
  if (!moves.length) advantage = materialBalance(chess, 'w');

  for (const uci of lineUci) {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) break;
    try {
      const played = chess.move({
        from: uci.slice(0, 2) as Square,
        to: uci.slice(2, 4) as Square,
        promotion: uci[4],
      });
      if (!played) break;
      const side = played.color === 'w' ? 1 : -1;
      if (played.captured && played.captured in PIECE_VALUES) {
        const piece = played.captured as PieceType;
        (played.color === 'w' ? byWhite : byBlack).push(piece);
        advantage += side * PIECE_VALUES[piece];
      }
      if (played.promotion && played.promotion in PIECE_VALUES) {
        advantage += side * (PIECE_VALUES[played.promotion as PieceType] - PIECE_VALUES.p);
      }
    } catch {
      break;
    }
  }

  const order: PieceType[] = ['q', 'r', 'b', 'n', 'p'];
  byWhite.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  byBlack.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return { byWhite, byBlack, whiteLead: Math.max(0, advantage), blackLead: Math.max(0, -advantage) };
}
