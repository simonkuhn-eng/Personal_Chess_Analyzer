import React from 'react';
import { PIECE_IMAGES } from './Chessboard';
import type { PieceType } from '../utils/boardPresentation';

interface CapturedPiecesProps {
  color: 'w' | 'b';
  pieces: PieceType[];
  lead: number;
}

export const CapturedPieces: React.FC<CapturedPiecesProps> = ({ color, pieces, lead }) => (
  <div className="captured-pieces" aria-label={`Geschlagene Figuren: ${pieces.length}${lead ? `, Materialvorsprung +${lead}` : ''}`}>
    {pieces.map((piece, index) => (
      <img
        key={`${piece}-${index}`}
        src={PIECE_IMAGES[`${color === 'w' ? 'b' : 'w'}${piece.toUpperCase()}`]}
        alt=""
        className="captured-piece"
        draggable={false}
      />
    ))}
    {lead > 0 && <span className="captured-lead">+{lead}</span>}
  </div>
);
