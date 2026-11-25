import { ChevronLeft, ChevronRight, Play, Pause, Undo2 } from 'lucide-react';
import type { ReviewVariation } from '../utils/reviewVariation';
import { variationPosition } from '../utils/reviewVariation';
import { useI18n } from '../utils/i18n';

interface Props {
  variation: ReviewVariation | null;
  anchorFen: string;
  onCursor: (cursor: number) => void;
  onReturn: () => void;
  playing: boolean;
  onTogglePlay: () => void;
}

export function ReviewVariationPanel({ variation, anchorFen, onCursor, onReturn, playing, onTogglePlay }: Props) {
  const { tr } = useI18n();
  if (!variation) return null;
  const position = variationPosition(anchorFen, variation.line, variation.cursor);
  return <section className="review-variation-panel" aria-label={tr('Variantenanalyse', 'Variation Analysis')}>
    <div className="variation-heading"><strong>{variation.label}</strong><button className="btn-secondary" onClick={onReturn}><Undo2 size={14} /> {tr('Zur Partie zurück', 'Back to game')}</button></div>
    <div className="variation-moves"><button className={position.cursor === 0 ? 'active' : ''} onClick={() => onCursor(0)}>{tr('Ausgangsstellung', 'Starting position')}</button>
      {position.steps.map((step, index) => <button key={index} className={position.cursor === index + 1 ? 'active' : ''} onClick={() => onCursor(index + 1)} aria-label={`${tr('Variante Halbzug', 'Variation ply')} ${index + 1}: ${step.san}`}>{step.number}{step.color === 'b' ? '…' : '.'} {step.san}</button>)}
    </div>
    <div className="variation-controls">
      <button className="btn-icon" aria-label={tr('Variante zurück', 'Variation back')} disabled={position.cursor === 0} onClick={() => onCursor(position.cursor - 1)}><ChevronLeft size={18} /></button>
      <button className="btn-icon" aria-label={playing ? tr('Variante pausieren', 'Pause variation') : tr('Variante abspielen', 'Play variation')} disabled={!position.steps.length} onClick={onTogglePlay}>{playing ? <Pause size={17} /> : <Play size={17} />}</button>
      <button className="btn-icon" aria-label={tr('Variante weiter', 'Variation forward')} disabled={position.cursor === position.steps.length} onClick={() => onCursor(position.cursor + 1)}><ChevronRight size={18} /></button>
      <small>{position.cursor}/{position.steps.length} {tr('Halbzüge · Pfeiltasten navigieren · eigene Abzweigung jederzeit möglich', 'plies · arrow keys navigate · branch anytime')}</small>
    </div>
  </section>;
}
