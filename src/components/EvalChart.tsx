import React from 'react';
import { MoveAnalysis } from '../types/chess';
import { formatEval, moveCategory } from '../utils/analysis';
import { useI18n } from '../utils/i18n';

interface EvalChartProps {
  moves: MoveAnalysis[];
  currentPly: number;
  onSelectPly: (ply: number) => void;
  compact?: boolean;
}

export const EvalChart: React.FC<EvalChartProps> = ({ moves, currentPly, onSelectPly, compact = false }) => {
  const { tr } = useI18n();
  if (!moves || moves.length === 0) {
    return null;
  }

  const width = 430;
  const height = compact ? 42 : 90;
  const padding = compact ? 4 : 6;
  const midY = height / 2;

  // Map each move's eval onto a non-linear Y curve so realistic +0.5..+2.5 swings stay expressive while mates reach the bounds
  const getCoordinates = (index: number, scoreCp: number, mate?: number) => {
    const x = padding + (index / (moves.length - 1 || 1)) * (width - 2 * padding);
    let norm: number;
    if (mate !== undefined && mate !== 0) {
      norm = Math.sign(mate);
    } else {
      norm = Math.tanh(scoreCp / 350);
    }
    const y = midY - norm * (midY - padding);
    return { x, y };
  };

  // Build SVG path
  const points = moves.map((m, idx) => {
    const coords = getCoordinates(idx, m.evalAfter.scoreCp, m.evalAfter.mate);
    return `${coords.x},${coords.y}`;
  });

  const pathD = points.length > 0 ? `M ${points.join(' L ')}` : '';
  // Area path closing back to middle zero line
  const areaPathD =
    points.length > 0
      ? `M ${padding},${midY} L ${points.join(' L ')} L ${width - padding},${midY} Z`
      : '';

  // Current active move coordinate
  const activeCoord =
    currentPly > 0 && currentPly <= moves.length
      ? getCoordinates(currentPly - 1, moves[currentPly - 1].evalAfter.scoreCp, moves[currentPly - 1].evalAfter.mate)
      : null;

  return (
    <div
      className={`eval-chart-wrapper ${compact ? 'compact' : ''}`}
      style={{
        padding: compact ? '3px 8px 4px' : '6px 10px',
        background: '#1c1b18',
        borderRadius: '8px',
        border: '1px solid #2b2922',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: compact ? '2px' : '3px', fontSize: compact ? '0.67rem' : '0.72rem', lineHeight: 1.15, color: '#a8a6a0', fontWeight: 600 }}>
        <span>{tr('Vorteilsverlauf', 'Advantage Graph')}</span>
        {activeCoord && (
          <span style={{ color: '#ffffff' }}>
            {tr('Zug', 'Move')} {moves[currentPly - 1].moveNumber}
            {moves[currentPly - 1].color === 'w' ? '. ' : '... '}
            {moves[currentPly - 1].san} ({formatEval(moves[currentPly - 1].evalAfter.scoreCp, moves[currentPly - 1].evalAfter.mate)})
          </span>
        )}
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{
          width: '100%',
          height: compact ? '38px' : '82px',
          display: 'block',
          cursor: 'pointer',
          overflow: 'visible',
          background: compact ? '#141310' : 'transparent',
          borderRadius: compact ? '5px' : undefined,
        }}
        onClick={(e) => {
          // T21: echte SVG-Transformation statt CSS-Pixel-Annahme — viewBox
          // (430×90) wird in der CSS-Box (height 104px, fluid width)
          // letterboxed; getScreenCTM mappt exakt zurück in viewBox-Einheiten.
          const ctm = e.currentTarget.getScreenCTM();
          if (!ctm) return;
          const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
          const ratio = Math.max(0, Math.min(1, (p.x - padding) / (width - 2 * padding)));
          const targetIndex = Math.round(ratio * (moves.length - 1));
          onSelectPly(targetIndex + 1);
        }}
      >
        {/* Midline (Zero Advantage) */}
        <line x1={padding} y1={midY} x2={width - padding} y2={midY} stroke="#47443b" strokeDasharray="3 3" strokeWidth="1" />

        {/* Shaded Area under curve */}
        <path d={areaPathD} fill={compact ? 'rgba(129, 182, 76, 0.28)' : 'rgba(129, 182, 76, 0.18)'} />

        {/* Advantage Curve */}
        <path d={pathD} fill="none" stroke="#81b64c" strokeWidth={compact ? '2.2' : '2'} strokeLinecap="round" strokeLinejoin="round" />

        {/* Use the same exclusive categories as the review and training filters. */}
        {moves.map((m, idx) => {
          const category = moveCategory(m);
          if (['blunder', 'mistake', 'brilliant', 'miss'].includes(category)) {
            const coord = getCoordinates(idx, m.evalAfter.scoreCp, m.evalAfter.mate);
            return (
              <circle
                key={idx}
                data-quality={category}
                cx={coord.x}
                cy={coord.y}
                r={category === 'blunder' ? 3.5 : 2.5}
                fill={`var(--color-${category})`}
                stroke="#1c1b18"
                strokeWidth="1"
              />
            );
          }
          return null;
        })}

        {/* Active Move Indicator */}
        {activeCoord && (
          <g>
            <line x1={activeCoord.x} y1={padding} x2={activeCoord.x} y2={height - padding} stroke="#ffffff" strokeWidth="1.5" strokeDasharray="2 2" />
            <circle cx={activeCoord.x} cy={activeCoord.y} r="4.5" fill="#ffffff" stroke="#81b64c" strokeWidth="2" />
          </g>
        )}
      </svg>
    </div>
  );
};
