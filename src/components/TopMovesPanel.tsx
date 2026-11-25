import React from 'react';
import { formatEval } from '../utils/analysis';
import { Chess } from 'chess.js';
import { Cpu } from 'lucide-react';
import { principalVariationSan } from '../utils/reviewPresentation';
import { useI18n } from '../utils/i18n';

interface TopMove {
  uci: string;
  scoreCp: number;
  mate?: number;
  pv: string[];
}

interface TopMovesProps {
  fen: string;
  topMoves: TopMove[];
  isLoading: boolean;
  depth: number;
  currentEvalCp: number;
  currentEvalMate?: number;
  onPlayLine?: (line: string[]) => void;
  provisional?: boolean;
  evaluationAvailable?: boolean;
}

/** Try converting UCI to SAN using a chess.js instance */
function uciToSan(fen: string, uci: string): string {
  if (!uci || uci.length < 4) return uci;
  try {
    const chess = new Chess(fen);
    const from = uci.substring(0, 2) as import('chess.js').Square;
    const to = uci.substring(2, 4) as import('chess.js').Square;
    const promotion = uci[4];
    const move = chess.move({ from, to, promotion });
    return move ? move.san : uci;
  } catch {
    return uci;
  }
}

export const TopMovesPanel: React.FC<TopMovesProps> = ({
  fen,
  topMoves,
  isLoading,
  depth,
  currentEvalCp,
  currentEvalMate,
  onPlayLine,
  provisional = false,
  evaluationAvailable = true,
}) => {
  const { tr } = useI18n();
  const evalText = formatEval(currentEvalCp, currentEvalMate);
  const isPositiveEval = (currentEvalMate && currentEvalMate > 0) || (!currentEvalMate && currentEvalCp >= 0);

  return (
    <div
      className="top-moves-panel"
      style={{
        background: '#1c1b18',
        border: '1px solid #2e2b24',
        borderRadius: '10px',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 14px',
          borderBottom: '1px solid #2b2922',
          background: '#24231e',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Cpu size={15} color="#81b64c" />
          <span style={{ fontSize: '0.82rem', fontWeight: 700, color: '#ffffff' }}>
            {tr('Stockfish Top 3 · nächste Züge', 'Stockfish Top 3 · next moves')}
          </span>
          <span style={{ fontSize: '0.7rem', color: '#7d7b74', fontWeight: 600 }}>
            {tr('Tiefe', 'Depth')} {depth || '—'}{provisional ? tr(' · vorläufig', ' · provisional') : ''}
          </span>
        </div>
        <div
          style={{
            fontWeight: 800,
            fontSize: '1rem',
            color: isPositiveEval ? '#ffffff' : '#ffffff',
            background: isPositiveEval ? '#2d4a1e' : '#4a1e1e',
            border: `1px solid ${isPositiveEval ? '#4a7a2e' : '#7a2e2e'}`,
            padding: '2px 10px',
            borderRadius: '6px',
            letterSpacing: '-0.3px',
          }}
        >
          {evaluationAvailable ? evalText : '…'}
        </div>
      </div>

      {/* Moves list */}
      <div style={{ padding: '6px 0' }}>
        {isLoading ? (
          <div style={{ padding: '12px 14px', color: '#7d7b74', fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div className="spin-dot" />
            {tr('Stockfish rechnet...', 'Stockfish calculating...')}
          </div>
        ) : topMoves.length === 0 ? (
          <div style={{ padding: '12px 14px', color: '#7d7b74', fontSize: '0.82rem' }}>
            {tr('Kein Zug verfügbar', 'No move available')}
          </div>
        ) : (
          topMoves.map((move, idx) => {
            const san = uciToSan(fen, move.uci);
            const evalStr = formatEval(move.scoreCp, move.mate);
            const isPositive = (move.mate && move.mate > 0) || (!move.mate && move.scoreCp >= 0);
            const isFirst = idx === 0;

            // Show next 2 moves from PV as continuation
            const continuation = principalVariationSan(fen, move.pv[0] === move.uci ? move.pv : [move.uci, ...move.pv])
              .slice(1, 4).join(' ');

            return (
              <div
                key={idx}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 14px',
                  borderBottom: idx < topMoves.length - 1 ? '1px solid #24231e' : 'none',
                  background: isFirst ? 'rgba(129, 182, 76, 0.06)' : 'transparent',
                }}
              >
                {/* Rank + Move */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, minWidth: 0 }}>
                  <span
                    style={{
                      width: '22px',
                      height: '22px',
                      borderRadius: '50%',
                      background: isFirst ? '#81b64c' : '#2b2922',
                      color: isFirst ? '#ffffff' : '#a8a6a0',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '0.72rem',
                      fontWeight: 800,
                      flexShrink: 0,
                    }}
                  >
                    {idx + 1}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: '0.95rem', color: '#ffffff' }}>
                      <button className="top-move-explore" onClick={() => onPlayLine?.(move.pv[0] === move.uci ? move.pv : [move.uci, ...move.pv])} disabled={!onPlayLine} title={tr('Diese Variante auf dem Brett ausprobieren', 'Try this line on the board')}>{san} <small>{tr('Variante ansehen', 'View line')}</small></button>
                    </div>
                    {continuation && (
                      <div className="top-move-continuation">
                        {continuation}
                      </div>
                    )}
                  </div>
                </div>

                {/* Eval */}
                <div
                  style={{
                    fontWeight: 800,
                    fontSize: '0.88rem',
                    color: isPositive ? '#b5d48a' : '#ff9e9e',
                    marginLeft: '8px',
                    flexShrink: 0,
                    minWidth: '44px',
                    textAlign: 'right',
                  }}
                >
                  {evalStr}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
