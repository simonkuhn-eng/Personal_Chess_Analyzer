import React from 'react';
import type { MoveQuality } from '../types/chess';
import brilliant from '../assets/move-quality/brilliant.png';
import great from '../assets/move-quality/great.png';
import best from '../assets/move-quality/best.png';
import excellent from '../assets/move-quality/excellent.png';
import good from '../assets/move-quality/good.png';
import book from '../assets/move-quality/book.png';
import inaccuracy from '../assets/move-quality/inaccuracy.png';
import mistake from '../assets/move-quality/mistake.png';
import miss from '../assets/move-quality/miss.png';
import blunder from '../assets/move-quality/blunder.png';

const images: Record<MoveQuality, string> = {
  brilliant, great, best, excellent, good, book, inaccuracy, mistake, miss, blunder,
};

/** Complete circular badges cropped from the supplied screenshots, with alpha. */
export const QualityGlyph: React.FC<{ quality: MoveQuality }> = ({ quality }) => (
  <span className={'quality-glyph quality-glyph-' + quality} aria-hidden="true">
    <img src={images[quality]} alt="" width={128} height={128} draggable={false} />
  </span>
);
