import React from 'react';
import type { MoveQuality } from '../types/chess';
import { qualityAppearance } from '../utils/moveQuality';
import { QualityGlyph } from './QualityGlyph';

export const QualityBadge: React.FC<{ quality: MoveQuality; className?: string; title?: string }> = ({ quality, className = '', title }) => {
  const appearance = qualityAppearance(quality);
  return <span className={'quality-badge ' + className} title={title || appearance.label} aria-label={title || appearance.label} data-quality={appearance.quality}><QualityGlyph quality={appearance.quality} /></span>;
};
