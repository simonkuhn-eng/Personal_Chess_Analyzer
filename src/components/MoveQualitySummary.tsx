import React, { useRef } from 'react';
import { X } from 'lucide-react';
import type { MoveAnalysis } from '../types/chess';
import { QUALITY_ORDER, qualityAppearance, reviewQualityCounts } from '../utils/moveQuality';
import { QualityBadge } from './QualityBadge';
import { useI18n } from '../utils/i18n';

export const MoveQualitySummary: React.FC<{ moves: MoveAnalysis[] }> = ({ moves }) => {
  const { tr } = useI18n();
  const counts = reviewQualityCounts(moves);
  const dialog = useRef<HTMLDialogElement>(null);
  return <div className="move-quality-summary">
    <button type="button" className="move-quality-summary-toggle" aria-haspopup="dialog" onClick={() => dialog.current?.showModal()}>{tr('Zugbewertungen', 'Move Quality')} <span>{tr('Weiß · Schwarz', 'White · Black')}</span></button>
    <dialog ref={dialog} className="move-quality-summary-dialog" aria-label={tr('Zugbewertungen', 'Move Quality')} onKeyDown={event => event.stopPropagation()} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
    <div className="move-quality-summary-heading"><strong>{tr('Zugbewertungen', 'Move Quality')}</strong><button className="btn-icon" type="button" aria-label={tr('Übersicht schließen', 'Close summary')} onClick={() => dialog.current?.close()}><X size={18} /></button></div>
    <div className="move-quality-summary-scroll"><table title={tr('Verpasste Chancen zählen ausschließlich unter Miss, nicht zusätzlich als Fehler oder Patzer. Fehlerhafte Buchzüge zählen unter ihrer Fehlerbewertung. Jeder Zug wird einmal gezählt.', 'Missed wins count only under Missed Win, not also as mistakes or blunders. Mistaken book moves count under their error rating. Each move is counted once.')}>
      <thead><tr><th scope="col">{tr('Zugtyp', 'Move Type')}</th><th scope="col">{tr('Weiß', 'White')}</th><th scope="col" aria-label={tr('Symbol', 'Symbol')} /><th scope="col">{tr('Schwarz', 'Black')}</th></tr></thead>
      <tbody>{QUALITY_ORDER.filter(quality => quality !== 'great' || counts.white.great + counts.black.great > 0).map(quality => {
        const appearance = qualityAppearance(quality);
        return <tr key={quality} data-quality-row={quality}><th scope="row">{appearance.label}</th><td style={{ color: appearance.color }}>{counts.white[quality]}</td><td><QualityBadge quality={quality} /></td><td style={{ color: appearance.color }}>{counts.black[quality]}</td></tr>;
      })}</tbody>
    </table></div>
    </dialog>
  </div>;
};
