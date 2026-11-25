import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js';

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;
const CENTER_SQUARES = new Set<string>(['d4', 'd5', 'e4', 'e5']);
const PIECE_VALUES: Record<PieceSymbol, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
};
const PIECE_NAMES_DE: Record<PieceSymbol, string> = {
  p: 'Bauer',
  n: 'Springer',
  b: 'Läufer',
  r: 'Turm',
  q: 'Dame',
  k: 'König',
};

export interface SidePositionFacts {
  materialScore: number;
  pawnsByFile: Record<string, number>;
  doubledPawnFiles: string[];
  isolatedPawns: string[];
  passedPawns: string[];
  halfOpenFiles: string[];
  kingSquare: string;
  castlingRights: string[];
  pawnShieldCount: number;
  bishopPair: boolean;
  knightsOnRim: string[];
  centralPieces: string[];
  rooksOnOpenFiles: string[];
  rooksOnHalfOpenFiles: string[];
  rooksOnSeventhRank: string[];
  attackedByOpponent: Array<{ square: string; piece: string }>;
  undefendedAttacked: Array<{ square: string; piece: string }>;
}

export interface PositionFacts {
  fen: string;
  sideToMove: Color;
  inCheck: boolean;
  isCheckmate: boolean;
  isStalemate: boolean;
  legalMovesCount: number;
  sampleLegalMovesSan: string[];
  materialDiffWhiteMinusBlack: number;
  openFiles: string[];
  white: SidePositionFacts;
  black: SidePositionFacts;
}

export interface MoveSequenceResult {
  chess: Chess;
  appliedSan: string[];
  appliedUci: string[];
  fen: string;
}

const UCI_RE = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/;

function playSingleMove(chess: Chess, rawMove: string) {
  const token = rawMove.trim();
  if (!token) {
    throw new Error('Leerer Zug in Zugfolge.');
  }
  const uciMatch = token.match(UCI_RE);
  if (uciMatch) {
    try {
      return chess.move({
        from: uciMatch[1] as Square,
        to: uciMatch[2] as Square,
        promotion: uciMatch[3],
      });
    } catch {
      // Fallback: try as SAN in case someone passes something unusual
    }
  }
  try {
    return chess.move(token);
  } catch (err) {
    throw new Error(
      `Ungültiger Zug "${token}" in Stellung "${chess.fen()}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Validates a FEN string and optionally applies a sequence of SAN or UCI moves.
 */
export function applyMoveSequence(fen: string, moves?: string[]): MoveSequenceResult {
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch (err) {
    throw new Error(`Ungültige FEN "${fen}": ${err instanceof Error ? err.message : String(err)}`);
  }

  const appliedSan: string[] = [];
  const appliedUci: string[] = [];
  if (Array.isArray(moves)) {
    for (const rawMove of moves) {
      if (typeof rawMove !== 'string') {
        throw new Error('Jeder Zug in moves muss ein String sein.');
      }
      const moved = playSingleMove(chess, rawMove);
      appliedSan.push(moved.san);
      appliedUci.push(moved.from + moved.to + (moved.promotion || ''));
    }
  }

  return {
    chess,
    appliedSan,
    appliedUci,
    fen: chess.fen(),
  };
}

/**
 * Safely converts UCI principal variation moves to SAN, stopping cleanly on any invalid move.
 */
export function pvUciToSan(fen: string, pvUci: string[], maxPlies = 8): string[] {
  const sans: string[] = [];
  if (!Array.isArray(pvUci) || pvUci.length === 0 || maxPlies <= 0) return sans;
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return sans;
  }

  for (const uci of pvUci.slice(0, maxPlies)) {
    const match = typeof uci === 'string' ? uci.trim().match(UCI_RE) : null;
    if (!match) break;
    try {
      const moved = chess.move({
        from: match[1] as Square,
        to: match[2] as Square,
        promotion: match[3],
      });
      sans.push(moved.san);
    } catch {
      break;
    }
  }
  return sans;
}

function buildSideFacts(
  chess: Chess,
  color: Color,
  openFiles: Set<string>,
  allPawns: Record<Color, Array<{ square: Square; fileIdx: number; rankNum: number }>>,
  castlingField: string,
): SidePositionFacts {
  const enemy: Color = color === 'w' ? 'b' : 'w';
  const board = chess.board();
  const pawnsByFile: Record<string, number> = {};
  for (const file of FILES) pawnsByFile[file] = 0;

  let materialScore = 0;
  let bishopCount = 0;
  let kingSquare = '';
  const knightsOnRim: string[] = [];
  const centralPieces: string[] = [];
  const rooks: string[] = [];
  const attackedByOpponent: Array<{ square: string; piece: string }> = [];
  const undefendedAttacked: Array<{ square: string; piece: string }> = [];

  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const piece = board[r][f];
      if (!piece || piece.color !== color) continue;
      const sq = piece.square;
      const file = FILES[f];
      materialScore += PIECE_VALUES[piece.type];

      if (piece.type === 'p') {
        pawnsByFile[file] += 1;
      } else if (piece.type === 'b') {
        bishopCount += 1;
      } else if (piece.type === 'k') {
        kingSquare = sq;
      } else if (piece.type === 'n' && (file === 'a' || file === 'h')) {
        knightsOnRim.push(sq);
      } else if (piece.type === 'r') {
        rooks.push(sq);
      }

      if (CENTER_SQUARES.has(sq)) {
        centralPieces.push(`${PIECE_NAMES_DE[piece.type]} auf ${sq}`);
      }

      if (piece.type !== 'k') {
        const attackers = chess.attackers(sq, enemy);
        if (attackers.length > 0) {
          const item = { square: sq, piece: PIECE_NAMES_DE[piece.type] };
          attackedByOpponent.push(item);
          const defenders = chess.attackers(sq, color);
          if (defenders.length === 0) {
            undefendedAttacked.push(item);
          }
        }
      }
    }
  }

  const doubledPawnFiles = FILES.filter((f) => pawnsByFile[f] >= 2);
  const isolatedPawns: string[] = [];
  const passedPawns: string[] = [];

  const enemyPawnsByFile: Record<string, number> = {};
  for (const file of FILES) enemyPawnsByFile[file] = 0;
  for (const ep of allPawns[enemy]) {
    enemyPawnsByFile[FILES[ep.fileIdx]] += 1;
  }

  const halfOpenFiles = FILES.filter((f) => pawnsByFile[f] === 0 && enemyPawnsByFile[f] > 0);
  const halfOpenSet = new Set<string>(halfOpenFiles);

  for (const pawn of allPawns[color]) {
    const leftCount = pawn.fileIdx > 0 ? pawnsByFile[FILES[pawn.fileIdx - 1]] : 0;
    const rightCount = pawn.fileIdx < 7 ? pawnsByFile[FILES[pawn.fileIdx + 1]] : 0;
    if (leftCount === 0 && rightCount === 0) {
      isolatedPawns.push(pawn.square);
    }

    const hasBlockerAhead = allPawns[enemy].some((ep) => {
      if (Math.abs(ep.fileIdx - pawn.fileIdx) > 1) return false;
      return color === 'w' ? ep.rankNum > pawn.rankNum : ep.rankNum < pawn.rankNum;
    });
    if (!hasBlockerAhead) {
      passedPawns.push(pawn.square);
    }
  }

  let pawnShieldCount = 0;
  if (kingSquare) {
    const kingFileIdx = FILES.indexOf(kingSquare[0] as (typeof FILES)[number]);
    const kingRankNum = Number(kingSquare[1]);
    const dir = color === 'w' ? 1 : -1;
    for (const p of allPawns[color]) {
      if (Math.abs(p.fileIdx - kingFileIdx) <= 1) {
        const dr = p.rankNum - kingRankNum;
        if (dr === dir || dr === dir * 2) {
          pawnShieldCount += 1;
        }
      }
    }
  }

  const castlingRights: string[] = [];
  if (color === 'w') {
    if (castlingField.includes('K')) castlingRights.push('0-0');
    if (castlingField.includes('Q')) castlingRights.push('0-0-0');
  } else {
    if (castlingField.includes('k')) castlingRights.push('0-0');
    if (castlingField.includes('q')) castlingRights.push('0-0-0');
  }

  const seventhRankChar = color === 'w' ? '7' : '2';
  const rooksOnOpenFiles = rooks.filter((sq) => openFiles.has(sq[0]));
  const rooksOnHalfOpenFiles = rooks.filter((sq) => halfOpenSet.has(sq[0]));
  const rooksOnSeventhRank = rooks.filter((sq) => sq[1] === seventhRankChar);

  return {
    materialScore,
    pawnsByFile,
    doubledPawnFiles,
    isolatedPawns,
    passedPawns,
    halfOpenFiles,
    kingSquare,
    castlingRights,
    pawnShieldCount,
    bishopPair: bishopCount >= 2,
    knightsOnRim,
    centralPieces,
    rooksOnOpenFiles,
    rooksOnHalfOpenFiles,
    rooksOnSeventhRank,
    attackedByOpponent,
    undefendedAttacked,
  };
}

/**
 * Computes deterministic positional & tactical facts for a FEN position.
 */
export function analyzePositionFacts(fen: string): PositionFacts {
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch (err) {
    throw new Error(`Ungültige FEN "${fen}": ${err instanceof Error ? err.message : String(err)}`);
  }

  const board = chess.board();
  const allPawns: Record<Color, Array<{ square: Square; fileIdx: number; rankNum: number }>> = {
    w: [],
    b: [],
  };
  const fileHasAnyPawn = new Set<string>();

  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const piece = board[r][f];
      if (!piece || piece.type !== 'p') continue;
      const file = FILES[f];
      fileHasAnyPawn.add(file);
      allPawns[piece.color].push({
        square: piece.square,
        fileIdx: f,
        rankNum: 8 - r,
      });
    }
  }

  const openFiles = FILES.filter((f) => !fileHasAnyPawn.has(f));
  const openFilesSet = new Set<string>(openFiles);
  const fenParts = chess.fen().split(/\s+/);
  const castlingField = fenParts[2] || '-';

  const white = buildSideFacts(chess, 'w', openFilesSet, allPawns, castlingField);
  const black = buildSideFacts(chess, 'b', openFilesSet, allPawns, castlingField);
  const legalMoves = chess.moves();

  return {
    fen: chess.fen(),
    sideToMove: chess.turn(),
    inCheck: chess.inCheck(),
    isCheckmate: chess.isCheckmate(),
    isStalemate: chess.isStalemate(),
    legalMovesCount: legalMoves.length,
    sampleLegalMovesSan: legalMoves.slice(0, 40),
    materialDiffWhiteMinusBlack: white.materialScore - black.materialScore,
    openFiles,
    white,
    black,
  };
}

/**
 * Compares structural & tactical position facts before and after a single move.
 */
export function describeMoveStructuralDiff(
  fenBefore: string,
  moveUciOrSan: string,
): {
  san: string;
  uci: string;
  color: Color;
  fenAfter: string;
  observations: string[];
} {
  const before = analyzePositionFacts(fenBefore);
  const chess = new Chess(before.fen);
  const moved = playSingleMove(chess, moveUciOrSan);
  const fenAfter = chess.fen();
  const after = analyzePositionFacts(fenAfter);

  const color = moved.color;
  const sideLabel = color === 'w' ? 'Weiß' : 'Schwarz';
  const oppLabel = color === 'w' ? 'Schwarz' : 'Weiß';
  const myBefore = color === 'w' ? before.white : before.black;
  const myAfter = color === 'w' ? after.white : after.black;
  const oppBefore = color === 'w' ? before.black : before.white;
  const oppAfter = color === 'w' ? after.black : after.white;

  const observations: string[] = [];

  if (moved.captured) {
    const capturedName = PIECE_NAMES_DE[moved.captured];
    const moverName = PIECE_NAMES_DE[moved.piece];
    observations.push(`${sideLabel} schlägt mit ${moverName} einen gegnerischen ${capturedName} auf ${moved.to}.`);
  }

  if (moved.isKingsideCastle()) {
    observations.push(`${sideLabel} rochiert kurz und bringt den König in Sicherheit.`);
  } else if (moved.isQueensideCastle()) {
    observations.push(`${sideLabel} rochiert lang.`);
  }

  if (chess.isCheckmate()) {
    observations.push(`Der Zug setzt sofort Schachmatt.`);
  } else if (chess.inCheck()) {
    observations.push(`Der Zug gibt Schach.`);
  }

  // Doubled pawns created/resolved
  const newOppDoubled = oppAfter.doubledPawnFiles.filter((f) => !oppBefore.doubledPawnFiles.includes(f));
  if (newOppDoubled.length > 0) {
    observations.push(`${oppLabel} erhält einen Doppelbauern auf der ${newOppDoubled.join('/')}-Linie.`);
  }
  const newMyDoubled = myAfter.doubledPawnFiles.filter((f) => !myBefore.doubledPawnFiles.includes(f));
  if (newMyDoubled.length > 0) {
    observations.push(`${sideLabel} bekommt einen Doppelbauern auf der ${newMyDoubled.join('/')}-Linie.`);
  }
  const fixedMyDoubled = myBefore.doubledPawnFiles.filter((f) => !myAfter.doubledPawnFiles.includes(f));
  if (fixedMyDoubled.length > 0) {
    observations.push(`${sideLabel} löst den Doppelbauern auf der ${fixedMyDoubled.join('/')}-Linie auf.`);
  }

  // Isolated pawns
  const newOppIsolated = oppAfter.isolatedPawns.filter((sq) => !oppBefore.isolatedPawns.includes(sq));
  if (newOppIsolated.length > 0) {
    observations.push(`${oppLabel} bekommt einen isolierten Bauern (${newOppIsolated.join(', ')}).`);
  }
  const newMyIsolated = myAfter.isolatedPawns.filter((sq) => !myBefore.isolatedPawns.includes(sq));
  if (newMyIsolated.length > 0) {
    observations.push(`${sideLabel} erhält einen isolierten Bauern (${newMyIsolated.join(', ')}).`);
  }

  // Passed pawns
  const newMyPassed = myAfter.passedPawns.filter((sq) => !myBefore.passedPawns.includes(sq));
  if (newMyPassed.length > 0) {
    observations.push(`${sideLabel} schafft einen Freibauern (${newMyPassed.join(', ')}).`);
  }

  // Open & half-open files
  const newOpenFiles = after.openFiles.filter((f) => !before.openFiles.includes(f));
  if (newOpenFiles.length > 0) {
    observations.push(`Die ${newOpenFiles.join('/')}-Linie wird komplett geöffnet.`);
  }
  const newMyHalfOpen = myAfter.halfOpenFiles.filter(
    (f) => !myBefore.halfOpenFiles.includes(f) && !after.openFiles.includes(f),
  );
  if (newMyHalfOpen.length > 0) {
    observations.push(`${sideLabel} erhält eine halboffene ${newMyHalfOpen.join('/')}-Linie.`);
  }
  const newOppHalfOpen = oppAfter.halfOpenFiles.filter(
    (f) => !oppBefore.halfOpenFiles.includes(f) && !after.openFiles.includes(f),
  );
  if (newOppHalfOpen.length > 0) {
    observations.push(`${oppLabel} erhält eine halboffene ${newOppHalfOpen.join('/')}-Linie (gut für Türme/Druck).`);
  }

  // Bishop pair
  if (myBefore.bishopPair && !myAfter.bishopPair) {
    observations.push(`${sideLabel} gibt das Läuferpaar ab.`);
  }
  if (oppBefore.bishopPair && !oppAfter.bishopPair) {
    observations.push(`${oppLabel} verliert das Läuferpaar.`);
  }

  // Knights on rim
  const newRimKnights = myAfter.knightsOnRim.filter((sq) => !myBefore.knightsOnRim.includes(sq));
  if (newRimKnights.length > 0) {
    observations.push(`${sideLabel} stellt den Springer an den Brettrand (${newRimKnights.join(', ')}).`);
  }

  // Central presence gained/lost
  if (myAfter.centralPieces.length > myBefore.centralPieces.length) {
    observations.push(`${sideLabel} besetzt stärker das Zentrum (${myAfter.centralPieces.join(', ')}).`);
  }

  // Rooks on open / half-open / 7th rank
  const newOpenRooks = myAfter.rooksOnOpenFiles.filter((sq) => !myBefore.rooksOnOpenFiles.includes(sq));
  if (newOpenRooks.length > 0) {
    observations.push(`${sideLabel} stellt einen Turm auf eine offene Linie (${newOpenRooks.join(', ')}).`);
  }

  // Undefended attacked pieces after the move
  if (myAfter.undefendedAttacked.length > 0) {
    const newHanging = myAfter.undefendedAttacked.filter(
      (item) => !myBefore.undefendedAttacked.some((prev) => prev.square === item.square && prev.piece === item.piece),
    );
    if (newHanging.length > 0) {
      observations.push(
        `Achtung: Nach dem Zug hängt bei ${sideLabel} ungedeckt und angegriffen: ${newHanging.map((h) => `${h.piece} auf ${h.square}`).join(', ')}.`,
      );
    }
  }
  if (oppAfter.undefendedAttacked.length > oppBefore.undefendedAttacked.length) {
    const oppHanging = oppAfter.undefendedAttacked.filter(
      (item) => !oppBefore.undefendedAttacked.some((prev) => prev.square === item.square && prev.piece === item.piece),
    );
    if (oppHanging.length > 0) {
      observations.push(
        `Der Zug greift bei ${oppLabel} ungedeckte Figuren an: ${oppHanging.map((h) => `${h.piece} auf ${h.square}`).join(', ')}.`,
      );
    }
  }

  if (observations.length === 0) {
    observations.push(`Stiller Positionszug ohne direkte Bauernstruktur-Änderung (${moved.san}).`);
  }

  return {
    san: moved.san,
    uci: moved.from + moved.to + (moved.promotion || ''),
    color,
    fenAfter,
    observations,
  };
}
