import React, { useEffect, useRef, useState } from 'react';
import { GameAnalysis, MoveAnalysis, MoveQuality } from '../types/chess';
import { formatEval, moveCategory, reviewBadgeQuality } from '../utils/analysis';
import { QualityBadge } from './QualityBadge';
import { qualityAppearance } from '../utils/moveQuality';
import { MoveQualitySummary } from './MoveQualitySummary';
import { reviewMoveRows } from '../utils/reviewPresentation';
import { resolvePlayerColor } from '../utils/moveInsights';
import { isReliableGame, isReliableGameMove } from '../utils/evaluationReliability';
import { useI18n } from '../utils/i18n';
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Play,
  Pause,
  RotateCcw,
  RefreshCcw,
  Sparkles,
  Dumbbell,
  Cpu,
  List,
  BarChart3,
  X,
} from 'lucide-react';

interface ReviewPanelProps {
  game: GameAnalysis;
  targetPlayer: string;
  currentPly: number;
  onSelectPly: (ply: number) => void;
  onFlipBoard: () => void;
  onStartTraining: () => void;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onReanalyze: () => void;
  onExplore: (anchorPly: number, line: string[], label: string, autoplay?: boolean) => void;
  onAskAiCoach?: () => void;
  onToggleAiCoach?: () => void;
  isAiCoachOpen?: boolean;
  topMovesNode?: React.ReactNode;
  evalChartNode?: React.ReactNode;
  isCompactLayout?: boolean;
}

const QualityPill: React.FC<{ quality: MoveQuality }> = ({ quality }) => {
  return (
    <span className="quality-pill">
      <QualityBadge quality={quality} />
      <span>{qualityAppearance(quality).label}</span>
    </span>
  );
};

const MoveQualityMark: React.FC<{ quality: MoveQuality; title?: string }> = ({ quality, title }) => {
  return <QualityBadge quality={quality} className="move-quality-mark" title={title} />;
};

type MobileSheetTab = 'engine' | 'moves' | 'info' | null;

export const ReviewPanel: React.FC<ReviewPanelProps> = ({
  game,
  targetPlayer,
  currentPly,
  onSelectPly,
  onFlipBoard,
  onStartTraining,
  isPlaying,
  onTogglePlay,
  onReanalyze,
  onExplore,
  onAskAiCoach,
  onToggleAiCoach,
  isAiCoachOpen = false,
  topMovesNode,
  evalChartNode,
  isCompactLayout = false,
}) => {
  const { tr } = useI18n();
  const [mobileSheet, setMobileSheet] = useState<MobileSheetTab>(null);
  const ribbonRef = useRef<HTMLDivElement>(null);

  const currentMove: MoveAnalysis | undefined = currentPly > 0 ? game.moves[currentPly - 1] : undefined;
  const reliable = isReliableGame(game);

  const playerColor = resolvePlayerColor(game.white, game.black, targetPlayer, game.site);
  const playerMistakes = game.moves.filter(
    (m) => isReliableGameMove(game, m) && ['mistake', 'blunder', 'miss'].includes(moveCategory(m)) && playerColor && m.color === playerColor
  );
  const moveRows = reviewMoveRows(game.moves);

  // Horizontal move ribbon auto-centering without scrolling outer layout containers
  useEffect(() => {
    const ribbon = ribbonRef.current;
    if (!ribbon) return;
    const active = ribbon.querySelector<HTMLElement>('[data-ribbon-active="true"]');
    if (!active) return;
    const targetLeft = active.offsetLeft - ribbon.clientWidth / 2 + active.offsetWidth / 2;
    ribbon.scrollTo({ left: Math.max(0, targetLeft), behavior: 'smooth' });
  }, [currentPly, game.id]);

  // Close sheet when switching games
  useEffect(() => {
    setMobileSheet(null);
  }, [game.id]);

  const toggleMobileSheet = (tab: Exclude<MobileSheetTab, null>) => {
    setMobileSheet((prev) => (prev === tab ? null : tab));
  };

  const renderMoveTable = (closeSheetOnPick = false) => (
    <div style={{ display: 'grid', gridTemplateColumns: '34px 1fr 1fr', gap: closeSheetOnPick ? '4px' : '2px 4px', fontSize: closeSheetOnPick ? '0.85rem' : '0.8rem' }}>
      {moveRows.map((row, moveIdx) => {
        const whiteMove = row.white?.move;
        const blackMove = row.black?.move;
        const isWhiteActive = currentPly === row.white?.ply;
        const isBlackActive = currentPly === row.black?.ply;

        return (
          <React.Fragment key={moveIdx}>
            <div style={{ color: '#7d7b74', fontWeight: 600, padding: closeSheetOnPick ? '4px 0' : '2px 0' }}>
              {row.number}.
            </div>

            <div
              style={{
                padding: closeSheetOnPick ? '4px 8px' : '2px 6px',
                borderRadius: '5px',
                cursor: 'pointer',
                background: isWhiteActive ? '#3a372f' : 'transparent',
                color: isWhiteActive ? '#ffffff' : '#e3e1dc',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontWeight: isWhiteActive ? 700 : 500,
              }}
              onClick={() => {
                if (row.white) {
                  onSelectPly(row.white.ply);
                  if (closeSheetOnPick) setMobileSheet(null);
                }
              }}
            >
              <span className="review-move-san">{whiteMove?.san}</span>
              {whiteMove && isReliableGameMove(game, whiteMove) && (
                <span className="move-quality-marks">
                  <MoveQualityMark quality={reviewBadgeQuality(whiteMove)} title={whiteMove.openingAnnotation} />
                  {moveCategory(whiteMove) !== 'miss' && whiteMove.openingAnnotation && (whiteMove.quality === 'mistake' || whiteMove.quality === 'blunder')
                    ? <MoveQualityMark quality={whiteMove.quality} /> : null}
                </span>
              )}
            </div>

            <div
              style={{
                padding: closeSheetOnPick ? '4px 8px' : '2px 6px',
                borderRadius: '5px',
                cursor: blackMove ? 'pointer' : 'default',
                background: isBlackActive ? '#3a372f' : 'transparent',
                color: isBlackActive ? '#ffffff' : '#e3e1dc',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontWeight: isBlackActive ? 700 : 500,
              }}
              onClick={() => {
                if (row.black) {
                  onSelectPly(row.black.ply);
                  if (closeSheetOnPick) setMobileSheet(null);
                }
              }}
            >
              <span className="review-move-san">{blackMove?.san}</span>
              {blackMove && isReliableGameMove(game, blackMove) && (
                <span className="move-quality-marks">
                  <MoveQualityMark quality={reviewBadgeQuality(blackMove)} title={blackMove.openingAnnotation} />
                  {moveCategory(blackMove) !== 'miss' && blackMove.openingAnnotation && (blackMove.quality === 'mistake' || blackMove.quality === 'blunder')
                    ? <MoveQualityMark quality={blackMove.quality} /> : null}
                </span>
              )}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );

  const renderPlayersAndActions = () => (
    <>
      <div className="review-players-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        <div style={{ background: '#161512', padding: '8px 10px', borderRadius: '8px', border: '1px solid #3a372f' }}>
          <div style={{ fontSize: '0.76rem', color: '#a8a6a0', display: 'flex', justifyContent: 'space-between' }}>
            <span>♔ {tr('Weiß', 'White')}</span>
            {game.whiteElo && <span>{game.whiteElo}</span>}
          </div>
          <div style={{ fontWeight: 700, fontSize: '0.9rem', color: '#ffffff', margin: '2px 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {game.white}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '1.05rem', fontWeight: 800, color: '#81b64c' }}>
              {reliable ? `${game.accuracyWhite}%` : '—'}
            </span>
            <span style={{ fontSize: '0.7rem', color: '#a8a6a0' }}>{tr('Genauigkeit', 'Accuracy')}</span>
          </div>
        </div>

        <div style={{ background: '#161512', padding: '8px 10px', borderRadius: '8px', border: '1px solid #3a372f' }}>
          <div style={{ fontSize: '0.76rem', color: '#a8a6a0', display: 'flex', justifyContent: 'space-between' }}>
            <span>♚ {tr('Schwarz', 'Black')}</span>
            {game.blackElo && <span>{game.blackElo}</span>}
          </div>
          <div style={{ fontWeight: 700, fontSize: '0.9rem', color: '#ffffff', margin: '2px 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {game.black}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '1.05rem', fontWeight: 800, color: '#81b64c' }}>
              {reliable ? `${game.accuracyBlack}%` : '—'}
            </span>
            <span style={{ fontSize: '0.7rem', color: '#a8a6a0' }}>{tr('Genauigkeit', 'Accuracy')}</span>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
        <button
          className="btn-secondary"
          onClick={onReanalyze}
          style={{ flex: '1 1 160px', padding: '7px 10px', fontSize: '0.8rem' }}
        >
          <RefreshCcw size={14} />
          <span>{tr('Mit Stockfish neu analysieren', 'Re-analyze with Stockfish')}</span>
        </button>

        {playerMistakes.length > 0 && (
          <button
            className="btn-primary"
            style={{ flex: '1 1 160px', padding: '7px 12px', fontSize: '0.82rem' }}
            onClick={() => { setMobileSheet(null); onStartTraining(); }}
          >
            <Dumbbell size={15} />
            {tr('Fehler und Chancen trainieren', 'Train mistakes & chances')} ({playerMistakes.length})
          </button>
        )}
      </div>
    </>
  );

  const renderCurrentMoveBox = (insideSheet = false) => (
    <div className="review-current-move">
      {currentMove ? (
        <div>
          <div className="review-current-move-top">
            <div className="review-current-move-badges">
              {isReliableGameMove(game, currentMove) ? <QualityPill quality={reviewBadgeQuality(currentMove)} /> : <span>{tr('Bewertung unsicher', 'Uncertain eval')}</span>}
              {isReliableGameMove(game, currentMove) && moveCategory(currentMove) !== 'miss' && currentMove.openingAnnotation && (currentMove.quality === 'mistake' || currentMove.quality === 'blunder' || currentMove.quality === 'inaccuracy') && (
                <QualityPill quality={currentMove.quality} />
              )}
              <span className="review-current-san">
                {currentMove.moveNumber}.{currentMove.color === 'w' ? '' : '..'}{' '}
                {currentMove.san}
              </span>
            </div>
            <span className="review-current-eval">
              {isReliableGameMove(game, currentMove) ? formatEval(currentMove.evalAfter.scoreCp, currentMove.evalAfter.mate) : tr('Vorläufig', 'Provisional')}
            </span>
          </div>

          {currentMove.openingAnnotation && (
            <div className="review-current-note">{currentMove.openingAnnotation}</div>
          )}

          <div className="review-compare-actions">
            {currentMove.evalAfter.pv.length > 0 && (
              <button
                className="btn-secondary"
                onClick={() => {
                  if (insideSheet) setMobileSheet(null);
                  onExplore(currentPly - 1, [currentMove.uci, ...currentMove.evalAfter.pv], tr('Partiezug + Gegnerantwort', 'Game move + reply'), true);
                }}
              >
                {tr('Partiezug und Antwort prüfen', 'Check move & reply')}
              </button>
            )}
            {currentMove.evalBefore.pv.length > 0 && currentMove.evalBefore.bestMoveUci !== currentMove.uci && (
              <button
                className="btn-secondary"
                onClick={() => {
                  if (insideSheet) setMobileSheet(null);
                  onExplore(currentPly - 1, currentMove.evalBefore.pv, tr('Enginealternative', 'Engine alternative'), true);
                }}
              >
                {tr('Alternative vergleichen', 'Compare alternative')}
              </button>
            )}
            {!isCompactLayout && !insideSheet && onAskAiCoach && (
              <button
                type="button"
                className="btn-ai-coach"
                onClick={onAskAiCoach}
                title={tr('Zug mit Antigravity KI (Hydrogen/Neon) in einfachen Schachregeln erklären lassen', 'Explain this move with Antigravity AI using simple chess principles')}
              >
                <Sparkles size={13} />
                <span>{tr('Zug erklären (KI)', 'Explain Move (AI)')}</span>
              </button>
            )}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', color: '#a8a6a0', fontSize: '0.82rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
            <Sparkles size={16} color="#81b64c" style={{ flexShrink: 0 }} />
            <span>{tr('Wähle einen Zug in der Liste oder ziehe direkt am Brett.', 'Select a move in the list or play directly on the board.')}</span>
          </div>
          {!isCompactLayout && !insideSheet && onAskAiCoach && (
            <button
              type="button"
              className="btn-ai-coach"
              onClick={onAskAiCoach}
              title={tr('Stellung mit Antigravity KI (Hydrogen/Neon) erklären lassen', 'Explain position with Antigravity AI')}
            >
              <Sparkles size={13} />
              <span>{tr('KI-Erklärung', 'AI Explain')}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );

  const atEnd = currentPly >= game.moves.length;

  return (
    <div className="analysis-panel">
      {/* Compact Chess.com-style Inline Move Ribbon Directly Under Board on Mobile */}
      <div className="review-move-ribbon-row">
        <div className="review-move-ribbon" ref={ribbonRef} aria-label="Schnelle Zugleiste">
          <button
            type="button"
            className={`review-ribbon-chip ${currentPly === 0 ? 'active' : ''}`}
            data-ribbon-active={currentPly === 0 ? 'true' : undefined}
            onClick={() => onSelectPly(0)}
          >
            Start
          </button>
          {game.moves.map((m) => {
            const isActive = currentPly === m.ply;
            return (
              <button
                type="button"
                key={m.ply}
                className={`review-ribbon-chip ${isActive ? 'active' : ''}`}
                data-ribbon-active={isActive ? 'true' : undefined}
                onClick={() => onSelectPly(m.ply)}
              >
                {m.color === 'w' && <span className="review-ribbon-num">{m.moveNumber}.</span>}
                <span>{m.san}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Desktop Header (Permanent Accuracy & Actions) */}
      <div className="review-panel-header">
        {!reliable && (
          <p className="analysis-warning" role="status" style={{ marginBottom: '6px' }}>
            {tr('Analyse unvollständig oder zu flach für belastbare Lernurteile. Bitte mit mindestens Tiefe 12 neu analysieren.', 'Analysis incomplete or too shallow for reliable verdicts. Please re-analyze at depth 12 or higher.')}
          </p>
        )}
        <div className="review-header-summary-row">
          <div className="review-header-meta">
            <span className="review-header-opening" title={`${game.openingName || game.eco} • ${game.date}`}>
              {game.openingName || game.eco} • {game.date}
            </span>
            <span className="review-header-result">{game.result}</span>
          </div>
          <div className="review-header-actions-mini">
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={onReanalyze}
              title={tr('Mit Stockfish neu analysieren', 'Re-analyze with Stockfish')}
            >
              <RefreshCcw size={13} />
              <span>{tr('Neu', 'Re-run')}</span>
            </button>
            {!isCompactLayout && (onToggleAiCoach || onAskAiCoach) && (
              <button
                type="button"
                className={`btn-secondary btn-sm btn-ai-coach-mini ${isAiCoachOpen ? 'active' : ''}`}
                onClick={onToggleAiCoach || onAskAiCoach}
                title={tr('KI-Zugerklärung öffnen/schließen (nur Desktop)', 'Toggle AI move explanation (Desktop only)')}
              >
                <Sparkles size={13} />
                <span>{tr('KI', 'AI')}</span>
              </button>
            )}
            {playerMistakes.length > 0 && (
              <button
                type="button"
                className="btn-primary btn-sm"
                onClick={onStartTraining}
                title={`${tr('Fehler trainieren', 'Train mistakes')} (${playerMistakes.length})`}
              >
                <Dumbbell size={14} />
                <span>{tr('Trainieren', 'Train')} ({playerMistakes.length})</span>
              </button>
            )}
          </div>
        </div>

        <div className="review-desktop-accuracy-strip">
          <div className="review-accuracy-mini-card">
            <span className="review-accuracy-name">♔ {game.white}</span>
            <strong className="review-accuracy-pct">{reliable ? `${game.accuracyWhite}%` : '—'}</strong>
          </div>
          <div className="review-accuracy-mini-card">
            <span className="review-accuracy-name">♚ {game.black}</span>
            <strong className="review-accuracy-pct">{reliable ? `${game.accuracyBlack}%` : '—'}</strong>
          </div>
        </div>

        <div style={{ marginTop: '6px', borderRadius: '7px', overflow: 'hidden', border: '1px solid #2b2922' }}>
          <MoveQualitySummary moves={game.moves.filter(move => isReliableGameMove(game, move))} />
        </div>
      </div>

      {/* Move Quality Review Box (Desktop only — Mobile matches clean screenshot without card above board) */}
      {!isCompactLayout && renderCurrentMoveBox(false)}

      {/* Desktop Inline Scrollable Move List */}
      <div className="review-move-list review-move-list-desktop">
        {renderMoveTable(false)}
      </div>

      {/* Navigation Controls Toolbar (Desktop) OR Spaced Mobile Controls (Large Prev/Next + Tool Row) */}
      {isCompactLayout ? (
        <div className="review-mobile-actions" aria-label="Analyse-Aktionen">
          <div className="review-mobile-nav-pair">
            <button
              type="button"
              className="btn-secondary review-mobile-step-btn"
              onClick={() => onSelectPly(Math.max(0, currentPly - 1))}
              disabled={currentPly === 0}
              aria-label={tr('Zurück', 'Back')}
            >
              <ChevronLeft size={20} />
              <span>{tr('Zurück', 'Back')}</span>
            </button>
            <button
              type="button"
              className="btn-secondary review-mobile-step-btn"
              onClick={() => onSelectPly(Math.min(game.moves.length, currentPly + 1))}
              disabled={atEnd}
              aria-label={tr('Vor', 'Next')}
            >
              <span>{tr('Vor', 'Next')}</span>
              <ChevronRight size={20} />
            </button>
          </div>
          <div className="review-mobile-tools-row">
            <button
              type="button"
              className={`review-mobile-action-btn ${mobileSheet === 'engine' ? 'active' : ''}`}
              aria-expanded={mobileSheet === 'engine'}
              onClick={() => toggleMobileSheet('engine')}
            >
              <Cpu size={17} />
              <span>Engine</span>
            </button>
            <button
              type="button"
              className={`review-mobile-action-btn ${mobileSheet === 'moves' ? 'active' : ''}`}
              aria-expanded={mobileSheet === 'moves'}
              onClick={() => toggleMobileSheet('moves')}
            >
              <List size={17} />
              <span>{tr('Züge', 'Moves')}</span>
            </button>
            <button
              type="button"
              className={`review-mobile-action-btn ${mobileSheet === 'info' ? 'active' : ''}`}
              aria-expanded={mobileSheet === 'info'}
              onClick={() => toggleMobileSheet('info')}
            >
              <BarChart3 size={17} />
              <span>{tr('Partie', 'Game')}</span>
            </button>
            <button
              type="button"
              className="review-mobile-action-btn"
              onClick={onFlipBoard}
            >
              <RotateCcw size={17} />
              <span>{tr('Drehen', 'Flip')}</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="review-nav-toolbar">
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              className="btn-icon"
              onClick={() => onSelectPly(0)}
              disabled={currentPly === 0}
              title="Zum Anfang"
            >
              <ChevronsLeft size={18} />
            </button>
            <button
              className="btn-icon"
              onClick={() => onSelectPly(Math.max(0, currentPly - 1))}
              disabled={currentPly === 0}
              title="Vorheriger Zug (Pfeil Links)"
            >
              <ChevronLeft size={18} />
            </button>
            <button
              className="btn-icon"
              onClick={onTogglePlay}
              title={isPlaying ? 'Pause' : 'Autoplay'}
            >
              {isPlaying ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <button
              className="btn-icon"
              onClick={() => onSelectPly(Math.min(game.moves.length, currentPly + 1))}
              disabled={currentPly === game.moves.length}
              title="Nächster Zug (Pfeil Rechts)"
            >
              <ChevronRight size={18} />
            </button>
            <button
              className="btn-icon"
              onClick={() => onSelectPly(game.moves.length)}
              disabled={currentPly === game.moves.length}
              title="Zum Ende"
            >
              <ChevronsRight size={18} />
            </button>
          </div>

          <button className="btn-secondary" onClick={onFlipBoard} title={tr('Brett drehen', 'Flip board')}>
            <RotateCcw size={16} />
            <span>{tr('Drehen', 'Flip')}</span>
          </button>
        </div>
      )}

      {/* Collapsible Mobile/Tablet Bottom Sheet Overlay */}
      {mobileSheet && (
        <div className="collapsible-sheet-backdrop" onClick={() => setMobileSheet(null)}>
          <div
            className="collapsible-sheet"
            role="dialog"
            aria-label={mobileSheet === 'engine' ? 'Engine Top 3' : mobileSheet === 'moves' ? 'Zugliste' : 'Partie & Verlauf'}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="collapsible-sheet-header">
              <strong>
                {mobileSheet === 'engine' && 'Stockfish Top 3'}
                {mobileSheet === 'moves' && 'Züge & Variantenprüfung'}
                {mobileSheet === 'info' && `${game.openingName || game.eco} · ${game.result}`}
              </strong>
              <button
                type="button"
                className="btn-icon"
                aria-label="Bereich schließen"
                onClick={() => setMobileSheet(null)}
              >
                <X size={18} />
              </button>
            </div>
            <div className="collapsible-sheet-body">
              {mobileSheet === 'engine' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {topMovesNode}
                  {renderCurrentMoveBox(true)}
                </div>
              )}
              {mobileSheet === 'moves' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button type="button" className="btn-secondary btn-sm" onClick={() => { onSelectPly(0); setMobileSheet(null); }} disabled={currentPly === 0}>
                      <ChevronsLeft size={14} /> <span>Anfang</span>
                    </button>
                    <button type="button" className="btn-secondary btn-sm" onClick={onTogglePlay}>
                      {isPlaying ? <Pause size={14} /> : <Play size={14} />} <span>{isPlaying ? 'Pause' : 'Autoplay'}</span>
                    </button>
                    <button type="button" className="btn-secondary btn-sm" onClick={() => { onSelectPly(game.moves.length); setMobileSheet(null); }} disabled={atEnd}>
                      <ChevronsRight size={14} /> <span>Ende</span>
                    </button>
                  </div>
                  {renderCurrentMoveBox(true)}
                  <div className="review-move-list-sheet">
                    {renderMoveTable(true)}
                  </div>
                </div>
              )}
              {mobileSheet === 'info' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {!isCompactLayout && evalChartNode}
                  {renderPlayersAndActions()}
                  <div style={{ borderRadius: '8px', overflow: 'hidden', border: '1px solid #2b2922' }}>
                    <MoveQualitySummary moves={game.moves.filter(move => isReliableGameMove(game, move))} />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
