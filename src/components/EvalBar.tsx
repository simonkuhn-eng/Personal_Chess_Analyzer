import React, { useEffect, useState } from 'react';
import { formatEval } from '../utils/analysis';

interface EvalBarProps {
  scoreCp: number;
  mate?: number;
  isFlipped?: boolean;
  unavailable?: boolean;
  orientation?: 'vertical' | 'horizontal';
  /** Hold values across positions, but never carry them into another game. */
  resetKey?: string;
}

export const EvalBar: React.FC<EvalBarProps> = ({ scoreCp, mate, isFlipped = false, unavailable = false, orientation = 'vertical', resetKey }) => {
  const available = !unavailable && Number.isFinite(scoreCp) && (mate === undefined || Number.isFinite(mate));
  const [lastKnown, setLastKnown] = useState<{ scoreCp: number; mate?: number; resetKey?: string } | null>(null);
  useEffect(() => {
    if (!available) return;
    setLastKnown(previous => previous && previous.resetKey === resetKey && previous.scoreCp === scoreCp && previous.mate === mate
      ? previous : { scoreCp, mate, resetKey });
  }, [available, scoreCp, mate, resetKey]);
  // A missing result is a pending search, not an evaluation of 0.0. Only the
  // bar holds the last value; move suggestions still belong to the new FEN.
  const displayed = available ? { scoreCp, mate } : lastKnown?.resetKey === resetKey ? lastKnown : null;
  const displayedScoreCp = displayed?.scoreCp ?? 0;
  const displayedMate = displayed?.mate;
  // Convert centipawns / mate into height percentage for White (0 - 100%)
  const getWhitePercentage = (): number => {
    if (displayedMate !== undefined && displayedMate === 0) {
      // Matt am Brett (T03): Gewinner aus dem white-POV-scoreCp-Vorzeichen
      return displayedScoreCp >= 0 ? 100 : 0;
    }
    if (displayedMate !== undefined && displayedMate !== 0) {
      return displayedMate > 0 ? 100 : 0;
    }
    // Sigmoidal percentage mapping centered at 50%
    const capped = Math.max(-1000, Math.min(1000, displayedScoreCp));
    const pct = 50 + 50 * (2 / (1 + Math.exp(-0.004 * capped)) - 1);
    return Math.max(5, Math.min(95, pct));
  };

  const whitePct = displayed ? getWhitePercentage() : 50;
  const blackPct = 100 - whitePct;

  // Format evaluation text
  const evalText = displayed ? formatEval(displayedScoreCp, displayedMate) : '…';
  const isWhiteWinning = displayedMate !== undefined && displayedMate !== 0 ? displayedMate > 0 : displayedScoreCp >= 0;

  const isHorizontal = orientation === 'horizontal';
  // Vertical: if flipped, White on top / Black bottom. Horizontal: standard = White left / Black right.
  const firstPct = isHorizontal ? (isFlipped ? blackPct : whitePct) : (isFlipped ? whitePct : blackPct);
  const secondPct = 100 - firstPct;
  const firstColor = isHorizontal ? (isFlipped ? '#161512' : '#ffffff') : (isFlipped ? '#ffffff' : '#161512');
  const secondColor = isHorizontal ? (isFlipped ? '#ffffff' : '#161512') : (isFlipped ? '#161512' : '#ffffff');
  const badgeOnFirst = isHorizontal ? (isWhiteWinning !== isFlipped) : (isWhiteWinning === isFlipped);
  const badgePositionClass = isHorizontal
    ? (badgeOnFirst ? 'left' : 'right')
    : (badgeOnFirst ? 'top' : 'bottom');

  return (
    <div
      className={`eval-bar-wrapper ${isHorizontal ? 'horizontal' : 'vertical'}`}
      data-evaluation-state={available ? 'available' : displayed ? 'pending' : 'unavailable'}
      title={!available && displayed ? 'Letzte Bewertung – die neue Stellung wird berechnet.' : undefined}
    >
      {/* Top / Left Section */}
      <div
        className="eval-bar-top"
        style={isHorizontal ? {
          width: `${firstPct}%`,
          height: '100%',
          backgroundColor: firstColor,
          transition: 'width 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
        } : {
          height: `${firstPct}%`,
          backgroundColor: firstColor,
          transition: 'height 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      />

      {/* Bottom / Right Section */}
      <div
        className="eval-bar-bottom"
        style={isHorizontal ? {
          width: `${secondPct}%`,
          height: '100%',
          backgroundColor: secondColor,
          transition: 'width 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
        } : {
          height: `${secondPct}%`,
          backgroundColor: secondColor,
          transition: 'height 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      />

      {/* Score indicator badge — sitzt immer auf der Flaeche der fuehrenden Seite */}
      <div
        className={`eval-badge ${badgePositionClass}`}
        style={{
          color: isWhiteWinning ? '#161512' : '#ffffff',
        }}
      >
        {evalText}
      </div>
    </div>
  );
};
