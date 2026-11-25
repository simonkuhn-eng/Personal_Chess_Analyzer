import React, { useEffect, useState, useMemo, useRef } from 'react';
import { Chess, Square, Move } from 'chess.js';
import { sounds } from '../utils/sound';
import { MoveQuality } from '../types/chess';
import { QualityBadge } from './QualityBadge';
import { boardArrowGeometry, displayBoardArrows } from '../utils/boardArrows';

import wpImg from '../assets/pieces/wp.png';
import wnImg from '../assets/pieces/wn.png';
import wbImg from '../assets/pieces/wb.png';
import wrImg from '../assets/pieces/wr.png';
import wqImg from '../assets/pieces/wq.png';
import wkImg from '../assets/pieces/wk.png';
import bpImg from '../assets/pieces/bp.png';
import bnImg from '../assets/pieces/bn.png';
import bbImg from '../assets/pieces/bb.png';
import brImg from '../assets/pieces/br.png';
import bqImg from '../assets/pieces/bq.png';
import bkImg from '../assets/pieces/bk.png';

export const PIECE_IMAGES: Record<string, string> = {
  wP: wpImg, wN: wnImg, wB: wbImg, wR: wrImg, wQ: wqImg, wK: wkImg,
  bP: bpImg, bN: bnImg, bB: bbImg, bR: brImg, bQ: bqImg, bK: bkImg,
};

interface ChessboardProps {
  fen: string;
  isFlipped?: boolean;
  lastMove?: { from: string; to: string; quality?: MoveQuality; engineQuality?: MoveQuality } | null;
  bestMoveArrow?: { from: string; to: string } | null;
  threatArrows?: Array<{ from: string; to: string }>;
  mistakeMoveArrow?: { from: string; to: string } | null;
  hintSquare?: string | null;
  /** Zweites Hinweisfeld (Ziel) für "Korrekten Zug zeigen" */
  hintTargetSquare?: string | null;
  onMove?: (move: { from: string; to: string; promotion?: string }) => void;
  interactive?: boolean;
  /** Size in pixels (optional, defaults to responsive CSS) */
  size?: number;
}

export const Chessboard: React.FC<ChessboardProps> = ({
  fen,
  isFlipped = false,
  lastMove,
  bestMoveArrow,
  threatArrows = [],
  mistakeMoveArrow,
  hintSquare,
  hintTargetSquare,
  onMove,
  interactive = true,
  size,
}) => {
  const [selectedSquare, setSelectedSquare] = useState<Square | null>(null);
  const [draggedSquare, setDraggedSquare] = useState<Square | null>(null);
  const [touchHoverSquare, setTouchHoverSquare] = useState<Square | null>(null);
  const dragContext = useRef<{ from: Square; fen: string } | null>(null);
  const touchDragContext = useRef<{
    from: Square;
    fen: string;
    startX: number;
    startY: number;
    dragged: boolean;
  } | null>(null);
  // T08: Umwandlungen werden explizit gewählt (D/T/L/S) — Klick, Drag und
  // (später) Tastatur teilen denselben Zustand statt heimlich q/n zu nehmen.
  const [pendingPromotion, setPendingPromotion] = useState<{ from: Square; to: Square; moves: Move[] } | null>(null);

  // T08: Ungültige FEN sichtbar melden statt still die Startstellung zu zeigen.
  const fenState = useMemo(() => {
    try {
      return { chess: new Chess(fen), valid: true };
    } catch {
      return { chess: new Chess(), valid: false };
    }
  }, [fen]);
  const chess = fenState.chess;

  // T08: Auswahl/Promotion zurücksetzen, wenn sich die Stellung extern ändert
  // (Kartenwechsel, Playback, Analyse-Navigation) — kein alter Auswahlmarker.
  useEffect(() => {
    dragContext.current = null;
    touchDragContext.current = null;
    setSelectedSquare(null);
    setDraggedSquare(null);
    setTouchHoverSquare(null);
    setPendingPromotion(null);
  }, [fen, interactive, isFlipped]);

  // Hinweise auch WAHREND des Draggens zeigen (nicht erst nach Drop)
  const activeSquare = draggedSquare || selectedSquare;

  const legalMovesForActive = useMemo(() => {
    if (!activeSquare || !interactive) return [];
    try { return chess.moves({ square: activeSquare, verbose: true }); } catch { return []; }
  }, [chess, activeSquare, interactive]);

  // T08: ALLE Zugkandidaten pro Zielfeld merken — bei Umwandlungen gibt es
  // vier Kandidaten mit gleichem von/nach; die Auswahl trifft der Dialog.
  const legalTargetsMap = useMemo(() => {
    const map = new Map<string, Move[]>();
    for (const m of legalMovesForActive) {
      const list = map.get(m.to);
      if (list) list.push(m);
      else map.set(m.to, [m]);
    }
    return map;
  }, [legalMovesForActive]);

  const inCheckSquare = useMemo(() => {
    if (!chess.inCheck()) return null;
    const board = chess.board();
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = board[r][c];
        if (p && p.type === 'k' && p.color === chess.turn()) return p.square;
      }
    }
    return null;
  }, [chess]);

  // T08: Ein einziger Commit-Pfad für Klick UND Drag — der Move trägt die
  // tatsächlich gewählte Umwandlungsfigur; Sound/Callback/Bewertung nutzen
  // denselben Zug.
  const commitMove = (move: Move) => {
    if (!interactive || !onMove || !fenState.valid) return;

    const isCapture = !!move.captured;
    const testChess = new Chess(fen);
    try {
      testChess.move({ from: move.from, to: move.to, promotion: move.promotion });
    } catch {
      return;
    }
    if (testChess.inCheck()) sounds.playCheck();
    else if (isCapture) sounds.playCapture();
    else sounds.playMove();

    onMove({
      from: move.from,
      to: move.to,
      promotion: move.promotion || undefined,
    });
    dragContext.current = null;
    touchDragContext.current = null;
    setSelectedSquare(null);
    setDraggedSquare(null);
    setTouchHoverSquare(null);
    setPendingPromotion(null);
  };

  /** T08: Zielfeld angewählt — mehrere Kandidaten → Umwandlungsdialog. */
  const resolveTarget = (from: Square, to: Square): boolean => {
    // Resolve from the actual input source, never a previous click selection.
    // Drag start/drop may also occur before React has rendered the drag state.
    const legalMoves = chess.moves({ square: from, verbose: true });
    const piece = chess.get(from);
    const target = chess.get(to);
    const kingOntoRook = piece?.type === 'k' && target?.type === 'r' && target.color === piece.color;
    const candidates = legalMoves.filter(move => kingOntoRook
      ? (move.isKingsideCastle() && to === `h${from[1]}`) || (move.isQueensideCastle() && to === `a${from[1]}`)
      : move.to === to);
    if (candidates.length === 0) return false;
    if (candidates.length === 1) {
      commitMove(candidates[0]);
      return true;
    }
    setPendingPromotion({ from, to, moves: candidates });
    return true;
  };

  const handleSquareClick = (square: Square) => {
    if (!interactive || !onMove || !fenState.valid) return;

    // Umwandlungsdialog offen: Klick auf Figur wählt, Klick daneben bricht ab.
    if (pendingPromotion) {
      return;
    }

    sounds.unlock();

    // Erneuter Klick auf dieselbe Figur hebt die Auswahl auf
    if (selectedSquare === square) {
      setSelectedSquare(null);
      return;
    }

    if (selectedSquare) {
      if (resolveTarget(selectedSquare, square)) return;
    }

    const piece = chess.get(square);
    if (piece && piece.color === chess.turn()) {
      setSelectedSquare(square);
    } else {
      setSelectedSquare(null);
    }
  };

  const handlePieceDragStart = (event: React.DragEvent<HTMLImageElement>, square: Square) => {
    if (!interactive || !onMove || !fenState.valid || pendingPromotion) {
      event.preventDefault();
      return;
    }

    const piece = chess.get(square);
    if (!piece || piece.color !== chess.turn()) {
      event.preventDefault();
      return;
    }

    sounds.unlock();
    dragContext.current = { from: square, fen };
    setSelectedSquare(null);
    setDraggedSquare(square);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', square);
  };

  const handleSquareDrop = (event: React.DragEvent<HTMLDivElement>, square: Square) => {
    event.preventDefault();
    const context = dragContext.current;
    dragContext.current = null;
    setDraggedSquare(null);
    if (!interactive || !onMove || pendingPromotion || !context || context.fen !== fen) return;

    // T08: denselben resolveTarget-Pfad wie beim Klick — Umwandlung über
    // Dialog statt heimliche Erst-/Letztwahl.
    resolveTarget(context.from, square);
  };

  const squareAtPoint = (clientX: number, clientY: number): Square | null => {
    const el = document.elementFromPoint(clientX, clientY);
    const sqEl = el?.closest('[data-square]');
    const sq = sqEl?.getAttribute('data-square');
    return sq ? (sq as Square) : null;
  };

  const handlePieceTouchStart = (event: React.TouchEvent<HTMLDivElement>, square: Square) => {
    if (!interactive || !onMove || !fenState.valid || pendingPromotion || event.touches.length !== 1) return;
    const piece = chess.get(square);
    if (!piece || piece.color !== chess.turn()) return;
    sounds.unlock();
    const touch = event.touches[0];
    touchDragContext.current = {
      from: square,
      fen,
      startX: touch.clientX,
      startY: touch.clientY,
      dragged: false,
    };
  };

  const handleBoardTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
    const ctx = touchDragContext.current;
    if (!ctx || ctx.fen !== fen || event.touches.length !== 1) return;
    const touch = event.touches[0];
    if (!ctx.dragged) {
      const dist = Math.hypot(touch.clientX - ctx.startX, touch.clientY - ctx.startY);
      if (dist < 10) return;
      ctx.dragged = true;
      setSelectedSquare(null);
      setDraggedSquare(ctx.from);
    }
    if (event.cancelable) event.preventDefault();
    const hovered = squareAtPoint(touch.clientX, touch.clientY);
    setTouchHoverSquare((prev) => (prev === hovered ? prev : hovered));
  };

  const handleBoardTouchEnd = (event: React.TouchEvent<HTMLDivElement>) => {
    const ctx = touchDragContext.current;
    touchDragContext.current = null;
    setTouchHoverSquare(null);
    if (!ctx) return;
    setDraggedSquare(null);
    if (!ctx.dragged || !interactive || !onMove || pendingPromotion || ctx.fen !== fen) return;
    if (event.cancelable) event.preventDefault();
    const touch = event.changedTouches[0];
    if (!touch) return;
    const targetSquare = squareAtPoint(touch.clientX, touch.clientY);
    if (targetSquare && targetSquare !== ctx.from) {
      resolveTarget(ctx.from, targetSquare);
    }
  };

  const handleBoardTouchCancel = () => {
    touchDragContext.current = null;
    setDraggedSquare(null);
    setTouchHoverSquare(null);
  };

  // Rochade: Der König ist der EINZIGE Stein, der 2 Felder weit ziehen darf.
  // Der Turm gleitet dann mit — ohne das wurde er bei der Rochade teleportiert.
  const castleRookMove = useMemo(() => {
    if (!lastMove) return null;
    const fileFrom = lastMove.from.charCodeAt(0);
    const fileTo = lastMove.to.charCodeAt(0);
    if (Math.abs(fileFrom - fileTo) !== 2) return null;
    const king = chess.get(lastMove.to as Square);
    if (!king || king.type !== 'k') return null;
    const rank = lastMove.to[1];
    return fileTo > fileFrom
      ? { from: `h${rank}`, to: `f${rank}` }
      : { from: `a${rank}`, to: `d${rank}` };
  }, [lastMove, chess]);

  // T08: Position des Umwandlungsdialogs — am Zielfeld, wächst Richtung Brettmite.
  const promotionDialogStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (!pendingPromotion) return undefined;
    const file = pendingPromotion.to.charCodeAt(0) - 'a'.charCodeAt(0);
    const rank = parseInt(pendingPromotion.to[1], 10);
    const col = isFlipped ? 7 - file : file;
    const atTopRow = (isFlipped ? rank - 1 : 8 - rank) === 0;
    return {
      left: `${col * 12.5}%`,
      ...(atTopRow
        ? { top: 0, flexDirection: 'column' as const }
        : { bottom: 0, flexDirection: 'column-reverse' as const }),
    };
  }, [pendingPromotion, isFlipped]);

  const ranks = isFlipped ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
  const files = isFlipped
    ? ['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a']
    : ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

  const boardStyle: React.CSSProperties = size
    ? { width: size, height: size }
    : {};

  return (
    <div
      className={`board-container${interactive ? '' : ' non-interactive'}`}
      style={boardStyle}
      onTouchMove={handleBoardTouchMove}
      onTouchEnd={handleBoardTouchEnd}
      onTouchCancel={handleBoardTouchCancel}
      onContextMenu={(event) => event.preventDefault()}
    >
      {ranks.map((rank, rIdx) =>
        files.map((file, fIdx) => {
          const square = `${file}${rank}` as Square;
          const isLight = (fIdx + rIdx) % 2 === 0;
          const piece = chess.get(square);
          const isHighlighted = lastMove && (lastMove.from === square || lastMove.to === square);
          const isHinted = hintSquare === square || hintTargetSquare === square;
          const isSelected = selectedSquare === square;
          const isInCheck = inCheckSquare === square;
          const isLegalTarget = legalTargetsMap.has(square);
          const isLegalCapture = isLegalTarget && legalTargetsMap.get(square)!.some((m) => !!m.captured);

          const pieceKey = piece ? `${piece.color}${piece.type.toUpperCase()}` : null;
          const pieceImg = pieceKey ? PIECE_IMAGES[pieceKey] : null;

          // Schlagsignal: weicher Schatten um die Figur-Kontur (kein Ring-Div,
          // das die Figur optisch verdraengt).
          const captureGlow = isLegalCapture
            ? 'drop-shadow(0 0 4px rgba(201, 49, 18, 0.55)) drop-shadow(0 0 12px rgba(201, 49, 18, 0.4))'
            : null;
          const baseGlow = pieceImg
            ? 'drop-shadow(0 2px 4px rgba(0, 0, 0, 0.25))'
            : null;
          const pieceFilter = [baseGlow, captureGlow].filter(Boolean).join(' ') || undefined;

          const isCastleRookArriving = Boolean(castleRookMove && castleRookMove.to === square);
          const isArrivingPiece = Boolean(pieceImg && lastMove && (lastMove.to === square || isCastleRookArriving));
          const animSource = isCastleRookArriving && castleRookMove
            ? castleRookMove.from
            : lastMove
              ? lastMove.from
              : square;
          const sourceFile = animSource.charCodeAt(0) - 'a'.charCodeAt(0);
          const sourceRank = parseInt(animSource[1], 10) - 1;
          const destinationFile = square.charCodeAt(0) - 'a'.charCodeAt(0);
          const destinationRank = rank - 1;
          const sourceColumn = isFlipped ? 7 - sourceFile : sourceFile;
          const sourceRow = isFlipped ? sourceRank : 7 - sourceRank;
          const destinationColumn = isFlipped ? 7 - destinationFile : destinationFile;
          const destinationRow = isFlipped ? destinationRank : 7 - destinationRank;
          const animationStyle = isArrivingPiece
            ? ({
                '--piece-dx': sourceColumn - destinationColumn,
                '--piece-dy': sourceRow - destinationRow,
              } as React.CSSProperties)
            : undefined;

          // Wechselnder Key fuer die ziehende Figur: erzwingt ein Remount und
          // damit zuverlaessig die Slide-Animation — auch bei Rueckschlaegen
          // auf dasselbe Feld (z. B. Sxc6 gefolgt von Lxc6), wo die CSS-Klasse
          // sonst bestehen bliebe und die Figur teleportieren wuerde.
          const pieceKeyProp = isArrivingPiece ? `${square}-from-${animSource}` : square;

          const isLastDst = lastMove && lastMove.to === square;
          const moveQuality = isLastDst ? lastMove?.quality : undefined;
          const isMovable = interactive && fenState.valid && piece?.color === chess.turn() && !pendingPromotion;
          const isTouchHovered = touchHoverSquare === square && draggedSquare !== square;

          return (
            <div
              key={square}
              data-square={square}
              className={`board-square ${isLight ? 'light' : 'dark'}${isHighlighted ? ' highlighted' : ''}${isSelected ? ' selected' : ''}${isInCheck ? ' in-check' : ''}${isHinted ? ' hinted' : ''}${isTouchHovered ? ' touch-hover' : ''}`}
              onClick={() => handleSquareClick(square)}
              onTouchStart={(event) => handlePieceTouchStart(event, square)}
              onDragOver={(event) => {
                if (interactive && dragContext.current?.fen === fen && !pendingPromotion) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                }
              }}
              onDrop={(event) => handleSquareDrop(event, square)}
            >
              {fIdx === 0 && <span className="square-coord rank">{rank}</span>}
              {rIdx === 7 && <span className="square-coord file">{file}</span>}

              {pieceImg && (
                <img
                  key={pieceKeyProp}
                  src={pieceImg}
                  alt={pieceKey || ''}
                  className={`piece-svg${isMovable ? ' touch-movable' : ''}${isArrivingPiece ? ' piece-arriving' : ''}${draggedSquare === square ? ' piece-dragging' : ''}`}
                  draggable={isMovable}
                  onDragStart={(event) => handlePieceDragStart(event, square)}
                  onDragEnd={() => { dragContext.current = null; setDraggedSquare(null); }}
                  style={pieceFilter ? { ...animationStyle, filter: pieceFilter } : animationStyle}
                />
              )}

              {isLegalTarget && !isLegalCapture && <div className="legal-move-dot" />}

              {moveQuality && <QualityBadge quality={moveQuality} className="square-quality-badge" />}
            </div>
          );
        })
      )}

      {/* SVG arrows layer */}
      <svg className="arrows-overlay" viewBox="0 0 100 100" aria-label="Analyse-Pfeile">
        {displayBoardArrows(bestMoveArrow, threatArrows, mistakeMoveArrow).map(arrow => {
          const geometry = boardArrowGeometry(arrow.from, arrow.to, isFlipped);
          return geometry ? <path key={arrow.from + arrow.to} d={geometry.path} className={'board-arrow board-arrow-' + arrow.kind}
            data-arrow-kind={arrow.kind} data-from={arrow.from} data-to={arrow.to}>
            <title>{arrow.kind === 'best' ? 'Bester Zug' : arrow.kind === 'threat' ? 'Gegnerische Bedrohung' : 'Gespielter Fehler'}: {arrow.from}–{arrow.to}</title>
          </path> : null;
        })}
      </svg>

      {/* T08: Umwandlungsdialog — einheitlich für Klick UND Drag */}
      {pendingPromotion && interactive && (
        <div
          className="promotion-overlay"
          onClick={(event) => {
            event.stopPropagation();
            setPendingPromotion(null);
            setSelectedSquare(null);
          }}
        >
          <div className="promotion-dialog" style={promotionDialogStyle}>
            {['q', 'n', 'r', 'b'].map((promo) => {
              const move = pendingPromotion.moves.find((m) => m.promotion === promo);
              if (!move) return null;
              const img = PIECE_IMAGES[`${chess.turn() === 'w' ? 'w' : 'b'}${promo.toUpperCase()}`];
              return (
                <button
                  key={promo}
                  type="button"
                  className="promotion-piece-btn"
                  title={promo === 'q' ? 'Dame' : promo === 'r' ? 'Turm' : promo === 'b' ? 'Läufer' : 'Springer'}
                  onClick={(event) => {
                    event.stopPropagation();
                    commitMove(move);
                  }}
                >
                  <img src={img} alt={promo} draggable={false} />
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* T08: Ungültige FEN sichtbar melden statt still Startstellung zeigen */}
      {!fenState.valid && (
        <div className="board-fen-error">⚠ Ungültige Stellung (FEN) — es wird die Startstellung angezeigt.</div>
      )}
    </div>
  );
};
