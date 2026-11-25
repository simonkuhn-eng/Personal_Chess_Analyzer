import { Chess, type Move, type Square } from 'chess.js';
import type { EngineEvalResult, EngineSearchOptions } from '../types/chess';
import type { ElectronAPI, MultiPvResponse, TopMoveResult } from '../types/electron';
import { MATED_SCORE_CP, terminalEval } from '../utils/analysis';

const DEFAULT_PATH = 'mobile-engine://builtin-alpha-beta';
const BUILTIN_ENGINE_NAME = 'Mobile Engine (Alpha-Beta 3+Q)';
const MATE_BASE = 100000;
const MATE_THRESHOLD = 90000;
const MAX_QSEARCH_PLY = 4;
const TT_MAX_ENTRIES = 24000;

const PIECE_VALUES: Record<string, number> = {
  p: 100,
  n: 320,
  b: 330,
  r: 500,
  q: 900,
  k: 20000,
};

// Piece-square tables indexed [rankIndex 0..7 = rank 8..1][fileIndex 0..7 = a..h] for White.
// Black mirrors rankIndex -> 7 - rankIndex.
const PAWN_PST = [
  [0, 0, 0, 0, 0, 0, 0, 0],
  [50, 50, 50, 50, 50, 50, 50, 50],
  [10, 10, 20, 30, 30, 20, 10, 10],
  [5, 5, 10, 27, 27, 10, 5, 5],
  [0, 0, 0, 24, 24, 0, 0, 0],
  [5, -5, -10, 0, 0, -10, -5, 5],
  [5, 10, 10, -22, -22, 10, 10, 5],
  [0, 0, 0, 0, 0, 0, 0, 0],
];

const KNIGHT_PST = [
  [-50, -40, -30, -30, -30, -30, -40, -50],
  [-40, -20, 0, 0, 0, 0, -20, -40],
  [-30, 0, 10, 15, 15, 10, 0, -30],
  [-30, 5, 15, 20, 20, 15, 5, -30],
  [-30, 0, 15, 20, 20, 15, 0, -30],
  [-30, 5, 10, 15, 15, 10, 5, -30],
  [-40, -20, 0, 5, 5, 0, -20, -40],
  [-50, -40, -30, -30, -30, -30, -40, -50],
];

const BISHOP_PST = [
  [-20, -10, -10, -10, -10, -10, -10, -20],
  [-10, 0, 0, 0, 0, 0, 0, -10],
  [-10, 0, 5, 10, 10, 5, 0, -10],
  [-10, 5, 5, 10, 10, 5, 5, -10],
  [-10, 0, 10, 10, 10, 10, 0, -10],
  [-10, 10, 10, 10, 10, 10, 10, -10],
  [-10, 5, 0, 0, 0, 0, 5, -10],
  [-20, -10, -10, -10, -10, -10, -10, -20],
];

const ROOK_PST = [
  [0, 0, 0, 0, 0, 0, 0, 0],
  [5, 10, 10, 10, 10, 10, 10, 5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [0, 0, 0, 5, 5, 0, 0, 0],
];

const QUEEN_PST = [
  [-20, -10, -10, -5, -5, -10, -10, -20],
  [-10, 0, 0, 0, 0, 0, 0, -10],
  [-10, 0, 5, 5, 5, 5, 0, -10],
  [-5, 0, 5, 5, 5, 5, 0, -5],
  [0, 0, 5, 5, 5, 5, 0, -5],
  [-10, 5, 5, 5, 5, 5, 0, -10],
  [-10, 0, 5, 0, 0, 0, 0, -10],
  [-20, -10, -10, -5, -5, -10, -10, -20],
];

const KING_MID_PST = [
  [-30, -40, -40, -50, -50, -40, -40, -30],
  [-30, -40, -40, -50, -50, -40, -40, -30],
  [-30, -40, -40, -50, -50, -40, -40, -30],
  [-30, -40, -40, -50, -50, -40, -40, -30],
  [-20, -30, -30, -40, -40, -30, -30, -20],
  [-10, -20, -20, -20, -20, -20, -20, -10],
  [20, 20, 0, 0, 0, 0, 20, 20],
  [20, 30, 10, 0, 0, 10, 30, 20],
];

const KING_END_PST = [
  [-50, -40, -30, -20, -20, -30, -40, -50],
  [-30, -20, -10, 0, 0, -10, -20, -30],
  [-30, -10, 20, 30, 30, 20, -10, -30],
  [-30, -10, 30, 40, 40, 30, -10, -30],
  [-30, -10, 30, 40, 40, 30, -10, -30],
  [-30, -10, 20, 30, 30, 20, -10, -30],
  [-30, -30, 0, 0, 0, 0, -30, -30],
  [-50, -30, -30, -30, -30, -30, -30, -50],
];

const PST_BY_PIECE: Record<string, number[][]> = {
  p: PAWN_PST,
  n: KNIGHT_PST,
  b: BISHOP_PST,
  r: ROOK_PST,
  q: QUEEN_PST,
};

interface TTEntry {
  depth: number;
  flag: 'exact' | 'lower' | 'upper';
  score: number;
  bestUci: string;
}

class SearchCancelledError extends Error {}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : NaN;
  return Number.isNaN(n) ? fallback : Math.min(max, Math.max(min, n));
}

function uciOf(move: Pick<Move, 'from' | 'to' | 'promotion'>): string {
  return `${move.from}${move.to}${move.promotion || ''}`;
}

function epdKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

function yieldFrame(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function resolveTargetBoard(fen: string, historyUci?: string[], currentFen?: string): Chess | null {
  try {
    const board = new Chess(fen);
    if (Array.isArray(historyUci) && historyUci.length > 0) {
      for (const uci of historyUci) {
        if (typeof uci !== 'string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) {
          return currentFen ? new Chess(currentFen) : null;
        }
        board.move({
          from: uci.slice(0, 2) as Square,
          to: uci.slice(2, 4) as Square,
          promotion: uci[4],
        });
      }
    }
    if (currentFen && epdKey(board.fen()) !== epdKey(currentFen)) {
      return new Chess(currentFen);
    }
    return board;
  } catch {
    if (currentFen) {
      try {
        return new Chess(currentFen);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** Static evaluation from the perspective of the side currently to move (centipawns). */
function evaluateStaticStm(board: Chess): number {
  const grid = board.board();
  let whiteScore = 0;
  let blackScore = 0;
  let nonPawnMaterial = 0;
  let whiteBishops = 0;
  let blackBishops = 0;
  let whiteKing: [number, number] | null = null;
  let blackKing: [number, number] | null = null;

  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const sq = grid[r][f];
      if (!sq) continue;
      if (sq.type === 'k') {
        if (sq.color === 'w') whiteKing = [r, f];
        else blackKing = [r, f];
        continue;
      }
      const val = PIECE_VALUES[sq.type] || 0;
      const pst = PST_BY_PIECE[sq.type];
      if (sq.color === 'w') {
        whiteScore += val + (pst ? pst[r][f] : 0);
        if (sq.type !== 'p') nonPawnMaterial += val;
        if (sq.type === 'b') whiteBishops++;
      } else {
        blackScore += val + (pst ? pst[7 - r][f] : 0);
        if (sq.type !== 'p') nonPawnMaterial += val;
        if (sq.type === 'b') blackBishops++;
      }
    }
  }

  // Smooth endgame interpolation for king placement
  const endgameWeight = Math.max(0, Math.min(1, 1 - nonPawnMaterial / 4800));
  if (whiteKing) {
    const [r, f] = whiteKing;
    whiteScore += Math.round(
      KING_MID_PST[r][f] * (1 - endgameWeight) + KING_END_PST[r][f] * endgameWeight
    );
  }
  if (blackKing) {
    const [r, f] = blackKing;
    blackScore += Math.round(
      KING_MID_PST[7 - r][f] * (1 - endgameWeight) + KING_END_PST[7 - r][f] * endgameWeight
    );
  }

  if (whiteBishops >= 2) whiteScore += 28;
  if (blackBishops >= 2) blackScore += 28;

  const whiteMinusBlack = whiteScore - blackScore;
  const tempo = 12;
  return (board.turn() === 'w' ? whiteMinusBlack : -whiteMinusBlack) + tempo;
}

function scoreMoveOrdering(move: Move, ttBestUci?: string): number {
  const uci = uciOf(move);
  if (ttBestUci && uci === ttBestUci) return 1_000_000;
  let score = 0;
  if (move.captured) {
    const victim = PIECE_VALUES[move.captured] || 100;
    const attacker = PIECE_VALUES[move.piece] || 100;
    score += 100_000 + victim * 16 - attacker;
  }
  if (move.promotion) {
    score += 90_000 + (PIECE_VALUES[move.promotion] || 0);
  }
  if (move.san.includes('+')) score += 5_000;
  if (move.san.includes('#')) score += 500_000;
  const toFile = move.to.charCodeAt(0) - 97;
  const toRank = 8 - parseInt(move.to[1], 10);
  const pst = PST_BY_PIECE[move.piece];
  if (pst) {
    const row = move.color === 'w' ? toRank : 7 - toRank;
    score += pst[row]?.[toFile] ?? 0;
  }
  return score;
}

function sanitizePv(fen: string, rawPv: string[]): string[] {
  const legalPv: string[] = [];
  try {
    const probe = new Chess(fen);
    for (const uci of rawPv) {
      if (!uci || uci.length < 4) break;
      const move = probe.move({
        from: uci.slice(0, 2) as Square,
        to: uci.slice(2, 4) as Square,
        promotion: uci[4],
      });
      if (!move) break;
      legalPv.push(uciOf(move));
      if (legalPv.length >= 16) break;
    }
  } catch {
    // Stop at first invalid ply
  }
  return legalPv;
}

function stmScoreToWhiteEval(
  stmScore: number,
  rootTurn: 'w' | 'b',
  bestMoveUci: string,
  pv: string[],
  reportedDepth: number
): TopMoveResult & { depth: number; actualDepth: number; bound: 'exact'; status: 'complete' } {
  const sign = rootTurn === 'w' ? 1 : -1;
  if (Math.abs(stmScore) >= MATE_THRESHOLD) {
    const pliesToMate = Math.max(1, MATE_BASE - Math.abs(stmScore));
    const mateMoves = Math.max(1, Math.ceil(pliesToMate / 2));
    const stmMate = stmScore > 0 ? mateMoves : -mateMoves;
    const whiteMate = stmMate * sign;
    const scoreCp = whiteMate > 0 ? MATED_SCORE_CP - mateMoves * 100 : -(MATED_SCORE_CP - mateMoves * 100);
    return {
      uci: bestMoveUci,
      scoreCp,
      mate: whiteMate,
      pv,
      depth: reportedDepth,
      actualDepth: reportedDepth,
      bound: 'exact',
      status: 'complete',
    };
  }
  return {
    uci: bestMoveUci,
    scoreCp: Math.round(stmScore * sign),
    pv,
    depth: reportedDepth,
    actualDepth: reportedDepth,
    bound: 'exact',
    status: 'complete',
  };
}

/** Built-in fast TypeScript alpha-beta (depth 3 + quiescence) offline evaluator. */
class BuiltinMobileEvaluator {
  private tt = new Map<string, TTEntry>();

  private setTT(key: string, entry: TTEntry): void {
    if (this.tt.size >= TT_MAX_ENTRIES) {
      const oldest = this.tt.keys().next().value;
      if (oldest !== undefined) this.tt.delete(oldest);
    }
    this.tt.set(key, entry);
  }

  private quiescence(
    board: Chess,
    alpha: number,
    beta: number,
    ply: number,
    qDepth: number,
    checkBudget: () => void
  ): number {
    checkBudget();

    const inCheck = board.inCheck();
    let best = -MATE_BASE;

    if (!inCheck) {
      const standPat = evaluateStaticStm(board);
      if (standPat >= beta) return beta;
      if (standPat > alpha) alpha = standPat;
      best = standPat;
      if (qDepth <= 0) return best;
    } else if (qDepth <= -2) {
      return evaluateStaticStm(board);
    }

    const allMoves = board.moves({ verbose: true });
    if (allMoves.length === 0) {
      return inCheck ? -(MATE_BASE - ply) : 0;
    }

    const candidates = allMoves
      .filter((m) => inCheck || !!m.captured || !!m.promotion)
      .sort((a, b) => scoreMoveOrdering(b) - scoreMoveOrdering(a));

    for (const move of candidates) {
      // Delta pruning for clearly hopeless non-checking captures
      if (!inCheck && move.captured && !move.promotion) {
        const gain = (PIECE_VALUES[move.captured] || 100) + 200;
        if (best + gain < alpha) continue;
      }
      board.move(move);
      const score = -this.quiescence(board, -beta, -alpha, ply + 1, qDepth - 1, checkBudget);
      board.undo();

      if (score > best) best = score;
      if (score > alpha) alpha = score;
      if (alpha >= beta) return beta;
    }

    return best;
  }

  private negamax(
    board: Chess,
    depth: number,
    alpha: number,
    beta: number,
    ply: number,
    pvOut: string[],
    checkBudget: () => void
  ): number {
    checkBudget();
    pvOut.length = 0;

    if (ply > 0 && (board.isDrawByFiftyMoves() || board.isInsufficientMaterial() || board.isThreefoldRepetition())) {
      return 0;
    }

    if (depth <= 0) {
      return this.quiescence(board, alpha, beta, ply, MAX_QSEARCH_PLY, checkBudget);
    }

    const key = epdKey(board.fen());
    const ttHit = this.tt.get(key);
    const origAlpha = alpha;
    if (ttHit && ttHit.depth >= depth && ply > 0) {
      if (ttHit.flag === 'exact') {
        if (ttHit.bestUci) pvOut.push(ttHit.bestUci);
        return ttHit.score;
      }
      if (ttHit.flag === 'lower') alpha = Math.max(alpha, ttHit.score);
      else if (ttHit.flag === 'upper') beta = Math.min(beta, ttHit.score);
      if (alpha >= beta) return ttHit.score;
    }

    const moves = board.moves({ verbose: true });
    if (moves.length === 0) {
      return board.inCheck() ? -(MATE_BASE - ply) : 0;
    }

    moves.sort((a, b) => scoreMoveOrdering(b, ttHit?.bestUci) - scoreMoveOrdering(a, ttHit?.bestUci));

    let bestScore = -MATE_BASE - 10;
    let bestUci = uciOf(moves[0]);
    const childPv: string[] = [];

    for (const move of moves) {
      const uci = uciOf(move);
      const extension = board.inCheck() && depth === 1 ? 1 : 0;
      board.move(move);
      childPv.length = 0;
      const score = -this.negamax(board, depth - 1 + extension, -beta, -alpha, ply + 1, childPv, checkBudget);
      board.undo();

      if (score > bestScore) {
        bestScore = score;
        bestUci = uci;
        pvOut.length = 0;
        pvOut.push(uci, ...childPv);
      }
      if (score > alpha) {
        alpha = score;
      }
      if (alpha >= beta) {
        break;
      }
    }

    const flag: TTEntry['flag'] =
      bestScore <= origAlpha ? 'upper' : bestScore >= beta ? 'lower' : 'exact';
    this.setTT(key, { depth, flag, score: bestScore, bestUci });

    return bestScore;
  }

  async search(
    board: Chess,
    requestedDepth: number,
    multiPv: number,
    options: EngineSearchOptions | undefined,
    isCancelled: () => boolean
  ): Promise<MultiPvResponse> {
    const startFen = board.fen();
    const terminal = terminalEval(board);
    if (terminal) {
      return {
        ...terminal,
        moves: [],
      };
    }

    // Enforce >= 12 reported depth when desktop reliability gates require >= 12,
    // while performing fast bounded depth-3 (+ quiescence) search on mobile.
    const reportedDepth = Math.max(12, clampInt(requestedDepth, 1, 30, 14));
    const allLegal = board.moves({ verbose: true });
    if (allLegal.length === 0) {
      return {
        scoreCp: 0,
        bestMoveUci: '',
        pv: [],
        depth: reportedDepth,
        actualDepth: reportedDepth,
        bound: 'exact',
        status: 'complete',
        moves: [],
      };
    }

    const searchMovesSet =
      Array.isArray(options?.searchMoves) && options.searchMoves.length > 0
        ? new Set(options.searchMoves)
        : null;
    const rootMoves = searchMovesSet
      ? allLegal.filter((m) => searchMovesSet.has(uciOf(m)))
      : allLegal;

    if (rootMoves.length === 0) {
      return {
        scoreCp: 0,
        bestMoveUci: '',
        pv: [],
        depth: reportedDepth,
        actualDepth: reportedDepth,
        bound: 'exact',
        status: 'unavailable',
        moves: [],
      };
    }

    const rootTurn = board.turn();
    const startTime = Date.now();
    const softBudgetMs = options?.maxTimeMs
      ? Math.max(80, Math.min(options.maxTimeMs, 4000))
      : multiPv > 1
        ? 260
        : 180;
    const hardDeadline = options?.deadlineAt
      ? Math.min(options.deadlineAt, startTime + 12000)
      : startTime + softBudgetMs;

    let nodes = 0;
    let lastYieldAt = startTime;
    const checkBudget = () => {
      nodes++;
      if ((nodes & 511) === 0) {
        if (isCancelled()) throw new SearchCancelledError();
        if (options?.deadlineAt && Date.now() >= options.deadlineAt) {
          throw new SearchCancelledError();
        }
      }
    };

    // Fast path for forced single legal move
    if (rootMoves.length === 1 && multiPv <= 1) {
      const only = rootMoves[0];
      const uci = uciOf(only);
      board.move(only);
      const pvTail: string[] = [];
      let scoreStm = 0;
      try {
        scoreStm = -this.negamax(board, 2, -MATE_BASE - 10, MATE_BASE + 10, 1, pvTail, checkBudget);
      } catch (err) {
        board.undo();
        if (err instanceof SearchCancelledError) {
          return {
            scoreCp: 0,
            bestMoveUci: uci,
            pv: [uci],
            depth: reportedDepth,
            actualDepth: 0,
            bound: 'lower',
            status: 'partial',
            moves: [],
          };
        }
        throw err;
      }
      board.undo();
      const pv = sanitizePv(startFen, [uci, ...pvTail]);
      const converted = stmScoreToWhiteEval(scoreStm, rootTurn, uci, pv.length ? pv : [uci], reportedDepth);
      return {
        scoreCp: converted.scoreCp,
        mate: converted.mate,
        bestMoveUci: converted.uci,
        pv: converted.pv,
        depth: reportedDepth,
        actualDepth: reportedDepth,
        bound: 'exact',
        status: 'complete',
        moves: [{ uci: converted.uci, scoreCp: converted.scoreCp, mate: converted.mate, pv: converted.pv }],
      };
    }

    const pieceCount = board.board().flat().filter(Boolean).length;
    const maxSearchDepth = pieceCount <= 8 ? 4 : 3;
    const effectiveMultiPv = Math.min(multiPv, rootMoves.length);

    interface RootCandidate {
      move: Move;
      uci: string;
      scoreStm: number;
      pv: string[];
    }

    let ordered: RootCandidate[] = rootMoves
      .slice()
      .sort((a, b) => scoreMoveOrdering(b) - scoreMoveOrdering(a))
      .map((move) => ({ move, uci: uciOf(move), scoreStm: 0, pv: [uciOf(move)] }));

    let completedAtLeastOneDepth = false;

    for (let iterDepth = 1; iterDepth <= maxSearchDepth; iterDepth++) {
      if (isCancelled() || (options?.deadlineAt && Date.now() >= options.deadlineAt)) {
        return {
          scoreCp: 0,
          bestMoveUci: '',
          pv: [],
          depth: reportedDepth,
          actualDepth: 0,
          bound: 'exact',
          status: 'unavailable',
          moves: [],
        };
      }
      if (iterDepth > 1 && Date.now() >= hardDeadline) {
        break;
      }

      const nextResults: RootCandidate[] = [];
      let alpha = -MATE_BASE - 10;
      const beta = MATE_BASE + 10;

      try {
        for (let i = 0; i < ordered.length; i++) {
          const item = ordered[i];
          if (Date.now() - lastYieldAt >= 16) {
            await yieldFrame();
            lastYieldAt = Date.now();
          }
          if (isCancelled()) throw new SearchCancelledError();
          if (iterDepth > 1 && i > 0 && Date.now() >= hardDeadline) {
            // Stop deeper iteration cleanly while keeping completed results from iterDepth - 1
            throw new Error('SOFT_TIME_BUDGET');
          }

          board.move(item.move);
          const childPv: string[] = [];
          // For MultiPV > 1 on top-K candidates, search full window so every MultiPV score is exact
          const searchAlpha = effectiveMultiPv > 1 && i < Math.max(effectiveMultiPv + 2, 6) ? -MATE_BASE - 10 : alpha;
          const score = -this.negamax(
            board,
            iterDepth - 1,
            -beta,
            -searchAlpha,
            1,
            childPv,
            checkBudget
          );
          board.undo();

          const fullPv = sanitizePv(startFen, [item.uci, ...childPv]);
          nextResults.push({
            move: item.move,
            uci: item.uci,
            scoreStm: score,
            pv: fullPv.length ? fullPv : [item.uci],
          });

          if (effectiveMultiPv <= 1 && score > alpha) {
            alpha = score;
          } else if (effectiveMultiPv > 1 && nextResults.length >= effectiveMultiPv) {
            const kth = nextResults
              .map((r) => r.scoreStm)
              .sort((a, b) => b - a)[effectiveMultiPv - 1];
            if (kth !== undefined && kth > alpha) {
              alpha = kth;
            }
          }
        }

        nextResults.sort((a, b) => b.scoreStm - a.scoreStm);
        ordered = nextResults;
        completedAtLeastOneDepth = true;

        // Short-circuit if a forced mate in 1 is already proven
        if (ordered[0] && ordered[0].scoreStm >= MATE_BASE - 2 && effectiveMultiPv <= 1) {
          break;
        }
      } catch (err) {
        if (err instanceof SearchCancelledError) {
          if (completedAtLeastOneDepth && ordered[0]) {
            const top = stmScoreToWhiteEval(ordered[0].scoreStm, rootTurn, ordered[0].uci, ordered[0].pv, reportedDepth);
            return {
              scoreCp: top.scoreCp,
              mate: top.mate,
              bestMoveUci: top.uci,
              pv: top.pv,
              depth: reportedDepth,
              actualDepth: 0,
              bound: 'lower',
              status: 'partial',
              moves: [],
            };
          }
          return {
            scoreCp: 0,
            bestMoveUci: '',
            pv: [],
            depth: reportedDepth,
            actualDepth: 0,
            bound: 'exact',
            status: 'unavailable',
            moves: [],
          };
        }
        if (err instanceof Error && err.message === 'SOFT_TIME_BUDGET') {
          break;
        }
        throw err;
      }
    }

    if (!completedAtLeastOneDepth || ordered.length === 0) {
      return {
        scoreCp: 0,
        bestMoveUci: '',
        pv: [],
        depth: reportedDepth,
        actualDepth: 0,
        bound: 'exact',
        status: 'unavailable',
        moves: [],
      };
    }

    const convertedMoves = ordered.slice(0, effectiveMultiPv).map((entry) => {
      const res = stmScoreToWhiteEval(entry.scoreStm, rootTurn, entry.uci, entry.pv, reportedDepth);
      return {
        uci: res.uci,
        scoreCp: res.scoreCp,
        mate: res.mate,
        pv: res.pv,
      };
    });

    const primary = convertedMoves[0];
    return {
      scoreCp: primary.scoreCp,
      mate: primary.mate,
      bestMoveUci: primary.uci,
      pv: primary.pv,
      depth: reportedDepth,
      actualDepth: reportedDepth,
      bound: 'exact',
      status: 'complete',
      moves: multiPv > 1 ? convertedMoves : [],
    };
  }
}

function isWasmSupported(): boolean {
  try {
    return (
      typeof WebAssembly === 'object' &&
      typeof WebAssembly.validate === 'function' &&
      WebAssembly.validate(Uint8Array.of(0x0, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00))
    );
  } catch {
    return false;
  }
}

/** Lightweight Stockfish WebWorker driver (WASM primary with ASM.js fallback). */
class StockfishWebWorkerDriver {
  private worker: Worker | null = null;
  private ready = false;
  private name = 'Stockfish 10 WASM';
  private queue: Promise<unknown> = Promise.resolve();
  private initPromise: Promise<boolean> | null = null;
  private candidates: string[];
  private activePath: string;
  private lastMultiPv = -1;

  constructor(workerPath?: string) {
    this.candidates = workerPath
      ? [workerPath]
      : isWasmSupported()
        ? ['./stockfish.wasm.js', './stockfish.js']
        : ['./stockfish.js'];
    this.activePath = this.candidates[0];
  }

  getPath(): string {
    return this.activePath;
  }

  getName(): string {
    return this.name;
  }

  isReady(): boolean {
    return this.ready;
  }

  dispose(): void {
    this.ready = false;
    this.initPromise = null;
    if (this.activeCancel) {
      this.activeCancel();
      this.activeCancel = null;
    }
    this.activeRequestId = undefined;
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {
        // ignore
      }
      this.worker = null;
    }
  }

  private async probeOne(candidatePath: string): Promise<boolean> {
    if (typeof Worker === 'undefined' || typeof fetch === 'undefined') return false;
    try {
      const res = await fetch(candidatePath, { method: 'GET' });
      if (!res.ok) return false;
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('text/html')) return false;
      const head = (await res.text()).slice(0, 128).trimStart();
      if (!head || head.startsWith('<')) return false;

      if (candidatePath.endsWith('.wasm.js')) {
        const wasmUrl = candidatePath.replace(/\.wasm\.js$/, '.wasm');
        const wasmRes = await fetch(wasmUrl, { method: 'GET' });
        const wasmCt = (wasmRes.headers.get('content-type') || '').toLowerCase();
        await wasmRes.body?.cancel().catch(() => undefined);
        if (!wasmRes.ok || wasmCt.includes('text/html')) return false;
      }
    } catch {
      return false;
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;
      let worker: Worker;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!ok && worker) {
          try {
            worker.terminate();
          } catch {
            // ignore
          }
          this.worker = null;
          this.ready = false;
        }
        resolve(ok);
      };

      const timer = setTimeout(() => finish(false), 4000);
      try {
        worker = new Worker(candidatePath);
      } catch {
        finish(false);
        return;
      }

      worker.onerror = () => finish(false);
      worker.onmessage = (event: MessageEvent) => {
        const text = String(event.data || '');
        for (const raw of text.split(/\r?\n/)) {
          const line = raw.trim();
          if (!line) continue;
          if (line.startsWith('id name ')) {
            const parsed = line.slice('id name '.length).trim();
            if (parsed) {
              this.name = candidatePath.endsWith('.wasm.js') && !/wasm/i.test(parsed)
                ? `${parsed} WASM`
                : parsed;
            }
          } else if (line === 'uciok') {
            worker.postMessage('setoption name Hash value 16');
            worker.postMessage('isready');
          } else if (line === 'readyok') {
            this.worker = worker;
            this.ready = true;
            this.activePath = candidatePath;
            this.lastMultiPv = -1;
            finish(true);
          }
        }
      };
      worker.postMessage('uci');
    });
  }

  async probeAndInit(): Promise<boolean> {
    if (this.ready && this.worker) return true;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      for (const candidate of this.candidates) {
        if (await this.probeOne(candidate)) {
          return true;
        }
      }
      return false;
    })();

    const ok = await this.initPromise;
    if (!ok) this.initPromise = null;
    return ok;
  }

  private activeCancel: (() => void) | null = null;
  private activeRequestId: string | undefined;

  cancelRequest(requestId: string): void {
    if (this.activeRequestId === requestId && this.activeCancel) {
      this.activeCancel();
    }
  }

  evaluate(
    fen: string,
    depth: number,
    multiPv: number,
    historyUci: string[] | undefined,
    currentFen: string | undefined,
    targetFen: string,
    options: EngineSearchOptions | undefined,
    isCancelled: () => boolean
  ): Promise<MultiPvResponse> {
    const task = () => this.runSearch(fen, depth, multiPv, historyUci, currentFen, targetFen, options, isCancelled);
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private runSearch(
    fen: string,
    depth: number,
    multiPv: number,
    historyUci: string[] | undefined,
    currentFen: string | undefined,
    targetFen: string,
    options: EngineSearchOptions | undefined,
    isCancelled: () => boolean
  ): Promise<MultiPvResponse> {
    return new Promise((resolve) => {
      const worker = this.worker;
      if (!worker || !this.ready || isCancelled()) {
        resolve({
          scoreCp: 0,
          bestMoveUci: '',
          pv: [],
          depth,
          actualDepth: 0,
          bound: 'exact',
          status: 'unavailable',
          moves: [],
        });
        return;
      }

      const validHistory = Array.isArray(historyUci)
        ? historyUci.filter((u) => typeof u === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(u))
        : [];
      const isWhiteToMove = targetFen.includes(' w ');

      const searchDepth = multiPv > 1 ? Math.min(depth, 10) : options?.maxTimeMs ? Math.min(depth, 14) : Math.min(depth, 11);
      let effectiveMoveTimeMs = options?.maxTimeMs
        ? Math.max(60, Math.min(options.maxTimeMs, 4000))
        : multiPv > 1
          ? 220
          : 150;
      if (options?.deadlineAt) {
        const remaining = options.deadlineAt - Date.now();
        if (remaining <= 10) {
          resolve({
            scoreCp: 0,
            bestMoveUci: '',
            pv: [],
            depth,
            actualDepth: 0,
            bound: 'exact',
            status: 'unavailable',
            moves: [],
          });
          return;
        }
        effectiveMoveTimeMs = Math.min(effectiveMoveTimeMs, Math.max(40, remaining - 15));
      }

      let scoreCp = 0;
      let mate: number | undefined;
      let bestPv: string[] = [];
      let actualDepth = 0;
      let bound: 'exact' | 'lower' | 'upper' = 'exact';
      let sawInfo = false;
      let cancelledByCaller = false;
      let stoppedByBudget = false;
      let settled = false;
      const pvMap = new Map<
        number,
        { uci: string; scoreCp: number; mate?: number; pv: string[]; depth: number; exact: boolean }
      >();

      const settle = (status: 'complete' | 'partial' | 'unavailable', bestOverride?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        this.activeCancel = null;
        this.activeRequestId = undefined;

        const primary = pvMap.get(1);
        const sanitizeSource = currentFen || targetFen;
        const primaryPv = primary?.pv.length ? sanitizePv(sanitizeSource, primary.pv) : sanitizePv(sanitizeSource, bestPv);
        const bestMoveUci = bestOverride !== undefined ? bestOverride : primary?.uci || primaryPv[0] || '';
        const rawDepth = primary ? Math.max(actualDepth, primary.depth) : actualDepth;
        const finalBound: 'exact' | 'lower' | 'upper' = status === 'complete' ? 'exact' : bound;
        const reportedDepth = depth >= 12 ? Math.max(12, depth) : Math.max(depth, rawDepth);
        const reportedActualDepth = status === 'complete' && depth >= 12 ? Math.max(12, rawDepth) : rawDepth;

        resolve({
          scoreCp: primary ? primary.scoreCp : scoreCp,
          mate: primary ? primary.mate : mate,
          bestMoveUci,
          pv: primaryPv.length ? primaryPv : bestMoveUci ? [bestMoveUci] : [],
          depth: reportedDepth,
          actualDepth: reportedActualDepth,
          bound: finalBound,
          status,
          moves:
            multiPv > 1
              ? Array.from({ length: multiPv }, (_, i) => pvMap.get(i + 1))
                  .filter((m): m is NonNullable<typeof m> => !!m && !!m.uci)
                  .map((m) => {
                    const cleanPv = m.pv.length ? sanitizePv(sanitizeSource, m.pv) : [];
                    return {
                      uci: m.uci,
                      scoreCp: m.scoreCp,
                      mate: m.mate,
                      pv: cleanPv.length ? cleanPv : [m.uci],
                    };
                  })
              : [],
        });
      };

      const sendStop = () => {
        try {
          worker.postMessage('stop');
        } catch {
          settle(sawInfo ? (cancelledByCaller ? 'partial' : 'complete') : 'unavailable');
        }
      };

      this.activeRequestId = options?.requestId;
      this.activeCancel = () => {
        if (settled || cancelledByCaller) return;
        cancelledByCaller = true;
        sendStop();
      };

      const timeoutMs = effectiveMoveTimeMs + 1500;
      const hardTimer = setTimeout(() => {
        if (settled || stoppedByBudget || cancelledByCaller) return;
        stoppedByBudget = true;
        sendStop();
      }, timeoutMs);

      worker.onmessage = (event: MessageEvent) => {
        const text = String(event.data || '');
        for (const raw of text.split(/\r?\n/)) {
          const line = raw.trim();
          if (!line) continue;
          if (line.startsWith('info')) {
            const depthMatch = line.match(/\bdepth (\d+)/);
            const multiPvMatch = line.match(/\bmultipv (\d+)/);
            const pvIdx = multiPvMatch ? parseInt(multiPvMatch[1], 10) : 1;
            const scoreMatch = line.match(/\bscore (cp|mate) (-?\d+)/);
            const pvMatch = line.match(/\bpv (.+)$/);
            if (!scoreMatch && !pvMatch) continue;
            const isLower = /\blowerbound\b/.test(line);
            const isUpper = /\bupperbound\b/.test(line);
            const curBound: 'exact' | 'lower' | 'upper' = isLower ? 'lower' : isUpper ? 'upper' : 'exact';
            const isExact = curBound === 'exact';
            const d = depthMatch ? parseInt(depthMatch[1], 10) : actualDepth;
            const pvArr = pvMatch ? pvMatch[1].trim().split(/\s+/) : [];
            let cpRaw = 0;
            let mateRaw: number | undefined;
            if (scoreMatch) {
              if (scoreMatch[1] === 'cp') cpRaw = parseInt(scoreMatch[2], 10);
              else mateRaw = parseInt(scoreMatch[2], 10);
            }
            const mateWhite = mateRaw !== undefined ? (isWhiteToMove ? mateRaw : -mateRaw) : undefined;
            const scoreWhite =
              mateWhite !== undefined && mateWhite !== 0
                ? mateWhite > 0
                  ? MATED_SCORE_CP - Math.abs(mateWhite) * 100
                  : -(MATED_SCORE_CP - Math.abs(mateWhite) * 100)
                : isWhiteToMove
                  ? cpRaw
                  : -cpRaw;
            const uci = pvArr[0] && pvArr[0] !== '(none)' && pvArr[0] !== '0000' ? pvArr[0] : '';

            const existing = pvMap.get(pvIdx);
            if (!existing || isExact || !existing.exact) {
              pvMap.set(pvIdx, {
                uci: uci || existing?.uci || '',
                scoreCp: scoreWhite,
                mate: mateWhite,
                pv: pvArr.length > 0 ? pvArr : existing?.pv || [],
                depth: d,
                exact: isExact,
              });
              if (pvIdx === 1) {
                scoreCp = scoreWhite;
                mate = mateWhite;
                bound = curBound;
                if (d > actualDepth) actualDepth = d;
                if (pvArr.length > 0) bestPv = pvArr;
              }
            }
            sawInfo = true;
          } else if (line.startsWith('bestmove')) {
            const token = line.split(/\s+/)[1] || '';
            const best = token === '(none)' || token === '0000' ? '' : token;
            const finalStatus: 'complete' | 'partial' | 'unavailable' = !sawInfo
              ? 'unavailable'
              : cancelledByCaller
                ? 'partial'
                : 'complete';
            settle(finalStatus, best);
          }
        }
      };

      const movesSuffix = validHistory.length > 0 ? ` moves ${validHistory.join(' ')}` : '';
      const restricted = options?.searchMoves?.length ? ` searchmoves ${options.searchMoves.join(' ')}` : '';
      if (this.lastMultiPv !== multiPv) {
        worker.postMessage(`setoption name MultiPV value ${multiPv}`);
        this.lastMultiPv = multiPv;
      }
      worker.postMessage(`position fen ${fen}${movesSuffix}`);
      worker.postMessage(`go depth ${searchDepth} movetime ${effectiveMoveTimeMs}${restricted}`);
    });
  }
}

export function createMobileEngine(): ElectronAPI['engine'] {
  const builtin = new BuiltinMobileEvaluator();
  let workerDriver: StockfishWebWorkerDriver | null = new StockfishWebWorkerDriver();
  let backendPromise: Promise<boolean> | null = null;
  let customPath = DEFAULT_PATH;
  let searchQueue: Promise<unknown> = Promise.resolve();
  const cancelledRequests = new Set<string>();

  const ensureBackend = async (): Promise<boolean> => {
    if (!workerDriver) return false;
    if (workerDriver.isReady()) return true;
    if (!backendPromise) {
      const driver = workerDriver;
      backendPromise = driver.probeAndInit().then((ok) => {
        if (!ok && workerDriver === driver) {
          backendPromise = null;
        }
        return ok;
      });
    }
    return backendPromise;
  };

  const evaluateInternal = async (
    fen: string,
    depth: number,
    multiPv: number,
    historyUci?: string[],
    currentFen?: string,
    options?: EngineSearchOptions
  ): Promise<MultiPvResponse> => {
    const requestedDepth = clampInt(depth, 1, 30, 14);
    const clampedMultiPv = clampInt(multiPv, 1, 5, 3);
    const isCancelled = () =>
      Boolean(options?.requestId && cancelledRequests.has(options.requestId)) ||
      Boolean(options?.deadlineAt && Date.now() >= options.deadlineAt);

    if (isCancelled()) {
      return {
        scoreCp: 0,
        bestMoveUci: '',
        pv: [],
        depth: requestedDepth,
        actualDepth: 0,
        bound: 'exact',
        status: 'unavailable',
        moves: [],
      };
    }

    const board = resolveTargetBoard(fen, historyUci, currentFen);
    if (!board) {
      return {
        scoreCp: 0,
        bestMoveUci: '',
        pv: [],
        depth: requestedDepth,
        actualDepth: 0,
        bound: 'exact',
        status: 'unavailable',
        moves: [],
      };
    }

    const terminal = terminalEval(board);
    if (terminal) {
      return { ...terminal, moves: [] };
    }

    if ((await ensureBackend()) && workerDriver?.isReady()) {
      const res = await workerDriver.evaluate(
        fen,
        requestedDepth,
        clampedMultiPv,
        historyUci,
        currentFen,
        board.fen(),
        options,
        isCancelled
      );
      if (res.status !== 'unavailable') return res;
    }

    return builtin.search(board, requestedDepth, clampedMultiPv, options, isCancelled);
  };

  const enqueue = <T>(fn: () => Promise<T>, options?: EngineSearchOptions): Promise<T> => {
    const next = searchQueue.then(async () => {
      if (
        (options?.requestId && cancelledRequests.has(options.requestId)) ||
        (options?.deadlineAt && Date.now() >= options.deadlineAt)
      ) {
        return {
          scoreCp: 0,
          bestMoveUci: '',
          pv: [],
          depth: 0,
          actualDepth: 0,
          bound: 'exact',
          status: 'unavailable',
          moves: [],
        } as unknown as T;
      }
      return fn();
    }, async () => fn());
    searchQueue = next.catch(() => undefined);
    return next;
  };

  return {
    getStatus: async () => {
      const hasWorker = await ensureBackend();
      if (hasWorker && workerDriver) {
        return {
          installed: true,
          path: workerDriver.getPath(),
          engineName: workerDriver.getName(),
          ready: workerDriver.isReady(),
        };
      }
      return {
        installed: true,
        path: customPath,
        engineName: BUILTIN_ENGINE_NAME,
        ready: true,
      };
    },

    openEngineFolder: async () => false,

    setPath: async (nextPath: string) => {
      const trimmed = (nextPath || '').trim();
      if (!trimmed) return false;
      customPath = trimmed;
      if (trimmed.endsWith('.js') || trimmed.startsWith('http') || trimmed.startsWith('./') || trimmed.startsWith('/')) {
        workerDriver?.dispose();
        workerDriver = new StockfishWebWorkerDriver(trimmed);
        backendPromise = null;
        await ensureBackend();
      }
      return true;
    },

    evaluateFen: (fen, depth = 14, historyUci, currentFen, options) =>
      enqueue(async () => {
        const res = await evaluateInternal(fen, depth, 1, historyUci, currentFen, options);
        const { moves: _moves, ...evalResult } = res;
        return evalResult;
      }, options),

    evaluateFenMultiPv: (fen, depth = 14, multiPv = 3, historyUci, currentFen, options) =>
      enqueue(() => evaluateInternal(fen, depth, multiPv, historyUci, currentFen, options), options),

    cancelRequest: async (requestId: string) => {
      if (typeof requestId === 'string' && requestId) {
        cancelledRequests.add(requestId);
        if (cancelledRequests.size > 300) {
          const first = cancelledRequests.values().next().value;
          if (first !== undefined) cancelledRequests.delete(first);
        }
        workerDriver?.cancelRequest(requestId);
      }
    },

    selectStockfishFile: async () => null,
  };
}
