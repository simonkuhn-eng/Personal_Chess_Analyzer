import { Chess, type Square } from 'chess.js';

export interface AiCoachMovePreview {
  label: string;
  fenBefore: string;
  fenAfter: string;
  from: string;
  to: string;
  san: string;
  uci: string;
}

export interface CoachMoveResolutionContext {
  currentFen: string;
  anchorFenBefore?: string;
  anchorFenAfter?: string;
  anchorMoveNumber?: number;
  anchorColor?: 'w' | 'b';
}

export type CoachTextSegment =
  | { type: 'text'; text: string }
  | { type: 'move'; text: string; preview: AiCoachMovePreview };

const MOVE_TOKEN_REGEX =
  /(?:(?<![A-Za-z0-9_])(\d{1,3})\s*(\.{2,3}|…|\.)\s*)?(?<![A-Za-z0-9_])(O-O-O|O-O|0-0-0|0-0|[KQRBNDTLS][a-h]?[1-8]?[x:]?[a-h][1-8](?:=[QRBNDTLS])?|[a-h](?:[x:][a-h][1-8]|[1-8])(?:=[QRBNDTLS])?)([!?+#]*)(?![A-Za-z0-9_])/g;

const BARE_SQUARE_PREFIX_RE = /\b(?:on|at|square|squares|auf|feld|feldern)\s+$/i;
const BARE_SQUARE_TOKEN_RE = /^[a-h][1-8][!?+#]*$/;
const GERMAN_PIECE_PREFIX: Record<string, string> = {
  D: 'Q',
  T: 'R',
  L: 'B',
  S: 'N',
};

export function normalizeCoachMoveSan(rawMove: string): string {
  let clean = rawMove.trim().replace(/[!?+#]+$/g, '').replace(/:/g, 'x');
  if (!clean) return '';
  if (clean === '0-0-0') return 'O-O-O';
  if (clean === '0-0') return 'O-O';

  const first = clean[0];
  if (GERMAN_PIECE_PREFIX[first]) {
    clean = GERMAN_PIECE_PREFIX[first] + clean.slice(1);
  }
  clean = clean.replace(/=([DTLS])$/, (_m, p: string) => `=${GERMAN_PIECE_PREFIX[p] || p}`);
  return clean;
}

function getFenTurn(fen: string): 'w' | 'b' | null {
  const parts = fen.trim().split(/\s+/);
  if (parts[1] === 'w' || parts[1] === 'b') return parts[1];
  return null;
}

function tryPlaySanOnFen(
  candidateFen: string,
  normalizedSan: string,
  expectedTurn: 'w' | 'b' | null,
  rawLabel: string,
): AiCoachMovePreview | null {
  if (!candidateFen || !normalizedSan) return null;
  if (expectedTurn && getFenTurn(candidateFen) !== expectedTurn) return null;

  try {
    const chess = new Chess(candidateFen);
    const strippedTarget = normalizedSan.replace(/[+#]+$/g, '');
    const legalMoves = chess.moves({ verbose: true });
    const matched =
      legalMoves.find((mv) => mv.san === normalizedSan) ||
      legalMoves.find((mv) => mv.san.replace(/[+#]+$/g, '') === strippedTarget);
    if (!matched) return null;

    const played = chess.move({
      from: matched.from as Square,
      to: matched.to as Square,
      promotion: matched.promotion,
    });
    if (!played) return null;

    return {
      label: rawLabel.trim(),
      fenBefore: candidateFen,
      fenAfter: chess.fen(),
      from: played.from,
      to: played.to,
      san: played.san,
      uci: `${played.from}${played.to}${played.promotion || ''}`,
    };
  } catch {
    return null;
  }
}

function buildCandidateFens(
  context: CoachMoveResolutionContext,
  chainFen: string | null,
  moveNumStr: string | undefined,
  dotsStr: string | undefined,
): { fens: string[]; expectedTurn: 'w' | 'b' | null } {
  const ordered: string[] = [];
  const pushUnique = (fen?: string | null) => {
    if (fen && !ordered.includes(fen)) ordered.push(fen);
  };

  let expectedTurn: 'w' | 'b' | null = null;
  if (moveNumStr && dotsStr) {
    expectedTurn = dotsStr.length > 1 || dotsStr === '…' ? 'b' : 'w';
  }

  pushUnique(chainFen);

  if (moveNumStr && context.anchorMoveNumber !== undefined && context.anchorColor) {
    const moveNum = Number.parseInt(moveNumStr, 10);
    if (moveNum === context.anchorMoveNumber && expectedTurn === context.anchorColor) {
      pushUnique(context.anchorFenBefore);
    } else if (
      (context.anchorColor === 'w' && moveNum === context.anchorMoveNumber && expectedTurn === 'b') ||
      (context.anchorColor === 'b' && moveNum === context.anchorMoveNumber + 1 && expectedTurn === 'w')
    ) {
      pushUnique(context.anchorFenAfter);
    }
  }

  pushUnique(context.currentFen);
  pushUnique(context.anchorFenAfter);
  pushUnique(context.anchorFenBefore);

  return { fens: ordered, expectedTurn };
}

function shouldKeepChain(betweenText: string): boolean {
  if (!betweenText) return true;
  if (betweenText.length > 24) return false;
  if (/[.!?](?:\s|$)/.test(betweenText)) return false;
  return true;
}

export function parseCoachMoveSegments(
  text: string,
  context: CoachMoveResolutionContext,
  initialChainFen: string | null = null,
  initialPrecedingText = '',
): { segments: CoachTextSegment[]; endChainFen: string | null } {
  const segments: CoachTextSegment[] = [];
  let chainFen: string | null = initialChainFen;
  let lastIndex = 0;

  const regex = new RegExp(MOVE_TOKEN_REGEX.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const rawToken = match[0];
    const moveNumStr = match[1];
    const dotsStr = match[2];
    const moveBody = match[3];
    const annotation = match[4] || '';

    const betweenText = text.slice(lastIndex, match.index);
    if (betweenText && !shouldKeepChain(betweenText)) {
      chainFen = null;
    }

    const prefixWindow = (initialPrecedingText + text.slice(0, match.index)).slice(-24);
    const isBareSquare = !moveNumStr && BARE_SQUARE_TOKEN_RE.test(moveBody + annotation);
    if (isBareSquare && BARE_SQUARE_PREFIX_RE.test(prefixWindow)) {
      continue;
    }

    const normalizedSan = normalizeCoachMoveSan(`${moveBody}${annotation}`);
    if (!normalizedSan) continue;

    const { fens, expectedTurn } = buildCandidateFens(context, chainFen, moveNumStr, dotsStr);
    let resolved: AiCoachMovePreview | null = null;
    for (const candidateFen of fens) {
      resolved = tryPlaySanOnFen(candidateFen, normalizedSan, expectedTurn, rawToken);
      if (resolved) break;
    }

    if (!resolved) {
      continue;
    }

    if (match.index > lastIndex) {
      segments.push({ type: 'text', text: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: 'move', text: rawToken, preview: resolved });
    chainFen = resolved.fenAfter;
    lastIndex = regex.lastIndex;
  }

  const tail = text.slice(lastIndex);
  if (tail) {
    if (!shouldKeepChain(tail)) chainFen = null;
    segments.push({ type: 'text', text: tail });
  }

  return { segments, endChainFen: chainFen };
}
