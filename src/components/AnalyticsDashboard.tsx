import React from 'react';
import { MissedIdea, OpeningFocus, PlayerStats } from '../types/chess';
import { OpeningPhasePanel } from './OpeningPhasePanel';
import { PerformanceStatistics } from './PerformanceStatistics';
import { DeepDiagnosticsPanel } from './DeepDiagnosticsPanel';
import { AnalysisList } from './AnalysisList';
import { Target, TrendingUp, AlertTriangle, ShieldCheck, BookOpen, Brain, Sparkles, LineChart, Gauge, Eye, Skull } from 'lucide-react';
import { MISSED_IDEA_LABELS } from '../utils/moveInsights';
import { useI18n } from '../utils/i18n';

const IDEA_LABELS: Record<string, string> = MISSED_IDEA_LABELS;
const IDEA_LABELS_EN: Record<string, string> = {
  mate: 'Missed mate',
  capture: 'Winning capture',
  fork: 'Missed fork',
  check: 'Strong check',
  quiet: 'Positional improvement',
};

interface AnalyticsDashboardProps {
  stats: PlayerStats | null;
  targetPlayer: string;
  /** T18: Diagnose → Beleg: Partie an der Position VOR dem Fehler öffnen. */
  onOpenGameAt: (gameId: string, ply: number) => void;
  /** T18: Diagnose → Training: gefiltertes Üben (Motiv/Eröffnung). */
  onTrainMotif: (idea: MissedIdea) => void;
  onOpeningErrors: (focus: OpeningFocus, windowMoves: number) => void;
  onOpeningResponses: (focus: OpeningFocus) => void;
  onOpeningWindowChange: (moves: number) => Promise<void> | void;
}

export const AnalyticsDashboard: React.FC<AnalyticsDashboardProps> = ({ stats, targetPlayer, onOpenGameAt, onTrainMotif, onOpeningErrors, onOpeningResponses, onOpeningWindowChange }) => {
  const { isEn, tr } = useI18n();
  const ideaLabel = (idea: string) => (isEn ? (IDEA_LABELS_EN[idea] || IDEA_LABELS[idea] || idea) : (IDEA_LABELS[idea] || idea));

  if (!stats || stats.totalGames === 0) {
    return (
      <div className="analytics-empty-state">
        {stats?.performance && <PerformanceStatistics overview={stats.performance} openingWindow={stats.openingWindowMoves || 12} onOpenGameAt={onOpenGameAt} />}
        <div className="analytics-empty-explanation">
        <Brain size={56} color="#81b64c" style={{ marginBottom: '16px' }} />
        <h2 style={{ color: '#ffffff', marginBottom: '8px' }}>{tr('Noch keine Analyse-Daten verfügbar', 'No analysis data available yet')}</h2>
        <p style={{ maxWidth: '450px', textAlign: 'center', lineHeight: '1.5' }}>
          {tr(
            'Für die Diagnose brauchst du eigene, vollständig analysierte Partien mit mindestens Tiefe 12. Prüfe deine Kontonamen in den Einstellungen; unvollständige Analysen kannst du im Partie-Review erneut berechnen lassen.',
            'Diagnostics require your own fully analyzed games at depth 12 or higher. Check your account names in Settings; incomplete analyses can be re-run in Game Review.',
          )}
        </p>
        </div>
      </div>
    );
  }

  const totalBlunders =
    stats.phaseDistribution.openingBlunders +
    stats.phaseDistribution.middlegameBlunders +
    stats.phaseDistribution.endgameBlunders;

  const openingPct = totalBlunders > 0 ? Math.round((stats.phaseDistribution.openingBlunders / totalBlunders) * 100) : 0;
  const midPct = totalBlunders > 0 ? Math.round((stats.phaseDistribution.middlegameBlunders / totalBlunders) * 100) : 0;
  const endPct = totalBlunders > 0 ? Math.round((stats.phaseDistribution.endgameBlunders / totalBlunders) * 100) : 0;

  const completedGames = stats.winCount + stats.lossCount + stats.drawCount;
  const winRate = completedGames > 0 ? Math.round((stats.winCount / completedGames) * 100) : 0;
  const blundersPerGame = stats.totalGames > 0 ? (totalBlunders / stats.totalGames).toFixed(1) : '0';
  const weakestOpening = (stats.openingPhaseStats || [])
    .filter(opening => opening.games >= 5 && opening.avgAccuracy !== null)
    .sort((a, b) => a.avgAccuracy! - b.avgAccuracy!)[0];

  const pieceNames: Record<string, { label: string; icon: string }> = {
    q: { label: tr('Dame', 'Queen'), icon: '♕' },
    r: { label: tr('Turm', 'Rook'), icon: '♖' },
    b: { label: tr('Läufer', 'Bishop'), icon: '♗' },
    n: { label: tr('Springer', 'Knight'), icon: '♘' },
    p: { label: tr('Bauer', 'Pawn'), icon: '♙' },
    k: { label: tr('König', 'King'), icon: '♔' },
  };

  // --- Fortschritts-Verlauf (Genauigkeit chronologisch) ---
  const history = stats.accuracyHistory;
  const recentCount = Math.min(5, history.length);
  const recentAvg = recentCount > 0 ? history.slice(-recentCount).reduce((s, h) => s + h.accuracy, 0) / recentCount : 0;
  const overallAvg = history.length > 0 ? history.reduce((s, h) => s + h.accuracy, 0) / history.length : 0;
  const formDelta = recentCount > 0 ? Math.round((recentAvg - overallAvg) * 10) / 10 : 0;
  // SVG-Koordinaten (y: 40..100 % Genauigkeit auf Plot-Höhe gemappt)
  const chartW = 720;
  const chartH = 150;
  const chartPad = 14;
  const plotH = chartH - 2 * chartPad;
  const accToY = (acc: number) => chartH - chartPad - ((Math.max(40, Math.min(100, acc)) - 40) / 60) * plotH;
  const accToX = (i: number) => chartPad + (history.length > 1 ? (i / (history.length - 1)) * (chartW - 2 * chartPad) : (chartW - 2 * chartPad) / 2);
  const trendPath = history.map((h, i) => `${i === 0 ? 'M' : 'L'} ${accToX(i).toFixed(1)} ${accToY(h.accuracy).toFixed(1)}`).join(' ');
  const avgY = accToY(overallAvg);

  return (
    <div className="analytics-dashboard-scroll">
      {stats.performance && <PerformanceStatistics overview={stats.performance} openingWindow={stats.openingWindowMoves || 12} onOpenGameAt={onOpenGameAt} />}
      {/* Overview Cards */}
      <div className="analytics-kpi-grid">
        {/* Total Games */}
        <div style={{ background: '#1c1b18', border: '1px solid #2e2b24', borderRadius: '10px', padding: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#a8a6a0', fontSize: '0.82rem', marginBottom: '6px' }}>
            <span>{tr('Analysierte Partien', 'Analyzed Games')}</span>
            <BookOpen size={16} color="#81b64c" />
          </div>
          <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#ffffff' }}>{stats.totalGames}</div>
          <div style={{ fontSize: '0.78rem', color: '#81b64c', marginTop: '4px' }}>
            {stats.winCount} {tr('Siege', 'Wins')} • {stats.lossCount} {tr('Niederlagen', 'Losses')} • {stats.drawCount} {tr('Remis', 'Draws')}
          </div>
        </div>

        {/* Win Rate */}
        <div style={{ background: '#1c1b18', border: '1px solid #2e2b24', borderRadius: '10px', padding: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#a8a6a0', fontSize: '0.82rem', marginBottom: '6px' }}>
            <span>{tr('Erfolgsquote', 'Win Rate')}</span>
            <TrendingUp size={16} color="#81b64c" />
          </div>
          <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#ffffff' }}>{completedGames > 0 ? `${winRate}%` : '—'}</div>
          <div style={{ fontSize: '0.78rem', color: '#a8a6a0', marginTop: '4px' }}>
            {completedGames > 0
              ? tr(`Gesamte Siegrate (${completedGames} beendet) für ${targetPlayer}`, `Overall win rate (${completedGames} finished) for ${targetPlayer}`)
              : tr(`Keine abgeschlossenen Partien für ${targetPlayer}`, `No completed games for ${targetPlayer}`)}
          </div>
        </div>

        {/* Avg Accuracy */}
        <div style={{ background: '#1c1b18', border: '1px solid #2e2b24', borderRadius: '10px', padding: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#a8a6a0', fontSize: '0.82rem', marginBottom: '6px' }}>
            <span>{tr('Durchschnittl. Genauigkeit', 'Avg. Accuracy')}</span>
            <Target size={16} color="#81b64c" />
          </div>
          <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#81b64c' }}>{stats.avgAccuracy}%</div>
          <div style={{ fontSize: '0.78rem', color: '#a8a6a0', marginTop: '4px' }}>
            {tr('Lokale Genauigkeit aus Stockfish-Bewertungen', 'Local accuracy from Stockfish evaluations')}
          </div>
        </div>

        {/* Blunders per game */}
        <div style={{ background: '#1c1b18', border: '1px solid #2e2b24', borderRadius: '10px', padding: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#a8a6a0', fontSize: '0.82rem', marginBottom: '6px' }}>
            <span>{tr('Fehler + Patzer pro Partie', 'Mistakes + Blunders / Game')}</span>
            <AlertTriangle size={16} color="#ca3431" />
          </div>
          <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#ff7b78' }}>{blundersPerGame}</div>
          <div style={{ fontSize: '0.78rem', color: '#a8a6a0', marginTop: '4px' }}>
            {tr('Beide Schweregrade gemeinsam', 'Combined error rate')}
          </div>
        </div>
      </div>

      {/* Color and opening pressure points */}
      <details className="diag-accordion">
        <summary className="diag-accordion-summary">
          <span className="diag-accordion-title">
            <LineChart size={17} color="#81b64c" />
            <span>{tr('Farb-Bilanz, Genauigkeits-Verlauf & Eröffnungsfokus', 'Color Balance, Accuracy Trend & Opening Focus')}</span>
          </span>
          <span className="diag-accordion-meta">
            ♔ {stats.colorPerformance.white.avgAccuracy}% · ♚ {stats.colorPerformance.black.avgAccuracy}%
          </span>
        </summary>
        <div className="diag-accordion-body">
      <div className="analytics-three-grid">
        {(['white', 'black'] as const).map((color) => {
          const performance = stats.colorPerformance[color];
          const label = color === 'white' ? tr('Als Weiß', 'As White') : tr('Als Schwarz', 'As Black');
          const icon = color === 'white' ? '♔' : '♚';
          return (
            <div key={color} style={{ background: '#1c1b18', border: '1px solid #2e2b24', borderRadius: '10px', padding: '16px' }}>
              <div style={{ color: '#a8a6a0', fontSize: '0.82rem', marginBottom: '8px' }}>{icon} {label}</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                <strong style={{ color: '#81b64c', fontSize: '1.55rem' }}>{performance.avgAccuracy}%</strong>
                <span style={{ color: '#a8a6a0', fontSize: '0.78rem' }}>{tr('Genauigkeit', 'Accuracy')}</span>
              </div>
              <div style={{ color: '#cbc9c4', fontSize: '0.8rem', marginTop: '6px' }}>
                {performance.winRate}% {tr('Siege', 'Win')} • {performance.games} {tr('Partien', 'games')}
              </div>
              <div style={{ color: '#7d7b74', fontSize: '0.75rem', marginTop: '3px' }}>
                {performance.wins} {tr('S', 'W')} • {performance.losses} {tr('N', 'L')} • {performance.draws} {tr('R', 'D')}
              </div>
            </div>
          );
        })}
        <div style={{ background: '#28231d', border: '1px solid #5b4932', borderRadius: '10px', padding: '16px' }}>
          <div style={{ color: '#d5a450', fontSize: '0.82rem', marginBottom: '8px' }}>{tr(`Niedrigste Eröffnungsgenauigkeit · Züge 1–${stats.openingWindowMoves || 12}`, `Lowest Opening Accuracy · Moves 1–${stats.openingWindowMoves || 12}`)}</div>
          {weakestOpening ? (
            <>
              <strong style={{ color: '#ffffff', fontSize: '1rem' }}>{weakestOpening.name}</strong>
              <div style={{ color: '#e69d00', fontSize: '0.86rem', fontWeight: 700, marginTop: '6px' }}>{weakestOpening.avgAccuracy}% {tr('Genauigkeit', 'Accuracy')}</div>
              <div style={{ color: '#a8a6a0', fontSize: '0.75rem', marginTop: '3px' }}>
                {tr('Mit', 'With')} {weakestOpening.color === 'w' ? tr('Weiß', 'White') : tr('Schwarz', 'Black')} · {tr('Basis', 'Sample')}: {weakestOpening.games} {tr('Partien', 'games')}
              </div>
            </>
          ) : (
            <div style={{ color: '#a8a6a0', fontSize: '0.8rem', lineHeight: '1.4' }}>
              {tr(
                'Mindestens fünf eigene Partien desselben Aufbaus mit derselben Farbe sammeln, bevor eine Schwachstelle hervorgehoben wird.',
                'Play at least 5 games in the same opening with the same color before highlighting a recurring weakness.',
              )}
            </div>
          )}
        </div>
      </div>

      {/* Fortschritts-Verlauf */}
      {history.length >= 2 && (
        <div style={{ background: '#1c1b18', border: '1px solid #2e2b24', borderRadius: '12px', padding: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '14px' }}>
            <h3 style={{ fontSize: '1rem', fontWeight: 700, color: '#ffffff', display: 'flex', alignItems: 'center', gap: '8px', margin: 0 }}>
              <LineChart size={18} color="#81b64c" />
              <span>{tr(`Entwicklung der Genauigkeit (${history.length} Partien)`, `Accuracy Trend (${history.length} games)`)}</span>
            </h3>
            {recentCount > 0 && (
              <div style={{ fontSize: '0.84rem', fontWeight: 700, color: formDelta >= 0 ? '#81b64c' : '#ff7b78' }}>
                {formDelta >= 0 ? '▲' : '▼'} {Math.abs(formDelta)} % {tr(`Punkte: letzte ${recentCount} vs. Gesamt-Ø`, `pts: last ${recentCount} vs. overall avg`)}
              </div>
            )}
          </div>
          <svg viewBox={`0 0 ${chartW} ${chartH}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
            {/* Ø-Linie */}
            <line x1={chartPad} y1={avgY} x2={chartW - chartPad} y2={avgY} stroke="#3a372f" strokeWidth={1} strokeDasharray="4 4" />
            <text x={chartW - chartPad} y={avgY - 4} textAnchor="end" fontSize={10} fill="#7d7b74">
              {tr('Ø', 'Avg')} {overallAvg.toFixed(1)}%
            </text>
            <path d={trendPath} fill="none" stroke="#81b64c" strokeWidth={2} strokeLinejoin="round" />
            {history.map((h, i) => (
              <circle
                key={i}
                cx={accToX(i)}
                cy={accToY(h.accuracy)}
                r={i >= history.length - 5 ? 4 : 2.5}
                fill={h.win ? '#81b64c' : h.draw ? '#d5a450' : '#ca3431'}
                opacity={i >= history.length - 5 ? 1 : 0.75}
              />
            ))}
          </svg>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', marginTop: '8px', fontSize: '0.75rem', color: '#7d7b74' }}>
            <span><span style={{ color: '#81b64c' }}>●</span> {tr('Sieg', 'Win')}</span>
            <span><span style={{ color: '#d5a450' }}>●</span> {tr('Remis', 'Draw')}</span>
            <span><span style={{ color: '#ca3431' }}>●</span> {tr('Niederlage', 'Loss')}</span>
            <span style={{ marginLeft: 'auto' }}>{history[0]?.date || ''} → {history[history.length - 1]?.date || ''}</span>
          </div>
        </div>
      )}
        </div>
      </details>

      {stats.deepDiagnostics && (
        <DeepDiagnosticsPanel
          diagnostics={stats.deepDiagnostics}
          onOpenGameAt={onOpenGameAt}
          onTrainMotif={onTrainMotif}
        />
      )}

      {/* Error severity & coaching */}
      <details className="diag-accordion">
        <summary className="diag-accordion-summary">
          <span className="diag-accordion-title">
            <Gauge size={17} color="#81b64c" />
            <span>{tr('Fehlerschwere & Coaching-Hinweise', 'Error Severity & Coaching Insights')}</span>
          </span>
          <span className="diag-accordion-meta">
            {tr('Ø', 'Avg')} {stats.avgErrorSeverity.toFixed(1)}% {tr('Verlust', 'loss')} · {stats.coachingInsights.length} {tr('Hinweise', 'notes')}
          </span>
        </summary>
        <div className="diag-accordion-body">
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '20px' }}>
        <div style={{ background: '#1c1b18', border: '1px solid #2e2b24', borderRadius: '12px', padding: '20px' }}>
          <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '16px', color: '#ffffff', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Gauge size={18} color="#81b64c" />
            <span>{tr('Fehlerschwere (mistake + blunder)', 'Error Severity (Mistakes + Blunders)')}</span>
          </h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '24px', marginBottom: '16px' }}>
            <div>
              <div style={{ fontSize: '1.6rem', fontWeight: 800, color: '#ffffff' }}>{stats.avgErrorSeverity.toFixed(1)}</div>
              <div style={{ fontSize: '0.78rem', color: '#a8a6a0' }}>{tr('Ø %-Punkte Gewinnchance pro Fehler', 'Avg win-% drop per error')}</div>
            </div>
            {stats.worstError && (
              <div
                onClick={() => {
                  if (stats.worstError?.gameId && stats.worstError.ply !== undefined) onOpenGameAt(stats.worstError.gameId, stats.worstError.ply - 1);
                }}
                style={{ cursor: stats.worstError.gameId ? 'pointer' : 'default' }}
                title={stats.worstError.gameId ? tr('Beleg öffnen — Partie an der Position vor diesem Fehler', 'Open game right before this error') : undefined}
              >
                <div style={{ fontSize: '1.6rem', fontWeight: 800, color: '#ff7b78' }}>
                  {stats.worstError.san} <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>({Math.round(stats.worstError.winChanceDrop)}%)</span>
                </div>
                <div style={{ fontSize: '0.78rem', color: '#a8a6a0' }}>
                  {tr('Teuerster Fehler: Zug', 'Costliest error: Move')} {stats.worstError.moveNumber}
                  {stats.worstError.openingName ? ` • ${stats.worstError.openingName}` : ''}
                  {stats.worstError.date ? ` • ${stats.worstError.date}` : ''}
                </div>
              </div>
            )}
          </div>
          <div style={{ fontSize: '0.78rem', color: '#7d7b74', lineHeight: '1.5' }}>
            {tr(
              'Misst, wie stark deine Fehler die Gewinnchance kappen. Hoher Wert = seltene, aber brutale Fehler (Taktik übersehen!); niedriger Wert = viele kleine Positionsschwächen.',
              'Measures how severely your errors cut winning chances. High values indicate missed tactics; lower values point to small positional slips.',
            )}
          </div>
        </div>

      </div>

      {/* AI Coaching & Weakness Diagnosis */}
      <div style={{ background: 'linear-gradient(135deg, #24221d 0%, #1c1b18 100%)', border: '1px solid #3a372f', borderRadius: '12px', padding: '20px' }}>
        <AnalysisList title={<><Sparkles size={20} color="#81b64c" /><span>{tr('Diagnose & Trainings-Empfehlungen ("Woran soll ich arbeiten?")', 'Diagnosis & Training Priorities ("What should I work on?")')}</span></>} count={stats.coachingInsights.length} noun={tr('Hinweise', 'insights')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {stats.coachingInsights.map((insight, idx) => (
            <div
              key={idx}
              style={{
                background: '#24231e',
                padding: '12px 16px',
                borderRadius: '8px',
                border: '1px solid #3a372f',
                fontSize: '0.88rem',
                lineHeight: '1.5',
                color: '#e0dfdb',
              }}
            >
              {insight.split(/\*\*(.+?)\*\*/g).map((part, i) =>
                i % 2 === 1 ? <strong key={i} style={{ color: '#ffffff' }}>{part}</strong> : part
              )}
            </div>
          ))}
        </div>
        </AnalysisList>
      </div>
        </div>
      </details>

      {/* Phase Clustering & Piece Vulnerability Grids */}
      <details className="diag-accordion">
        <summary className="diag-accordion-summary">
          <span className="diag-accordion-title">
            <Brain size={17} color="#81b64c" />
            <span>{tr('Fehler nach Partiephasen & verlorene Figuren', 'Errors by Phase & Lost Pieces')}</span>
          </span>
          <span className="diag-accordion-meta">
            {tr('Erö', 'Open')} {openingPct}% · {tr('Mit', 'Mid')} {midPct}% · {tr('End', 'End')} {endPct}%
          </span>
        </summary>
        <div className="diag-accordion-body">
      <div className="analytics-two-grid">
        {/* Phase Breakdown */}
        <div style={{ background: '#1c1b18', border: '1px solid #2e2b24', borderRadius: '12px', padding: '20px' }}>
          <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '16px', color: '#ffffff', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Brain size={18} color="#81b64c" />
            <span>{tr('Fehler nach Partiephasen (Clustering)', 'Errors by Game Phase')}</span>
          </h3>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {/* Opening */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.84rem', marginBottom: '4px' }}>
                <span style={{ color: '#cbc9c4' }}>{tr(`Eröffnungsphase (Züge 1–${stats.openingWindowMoves || 12})`, `Opening (Moves 1–${stats.openingWindowMoves || 12})`)}</span>
                <span style={{ fontWeight: 700, color: '#ffffff' }}>
                  {stats.phaseDistribution.openingBlunders} ({openingPct}%)
                </span>
              </div>
              <div style={{ width: '100%', height: '8px', background: '#24231e', borderRadius: '4px', overflow: 'hidden' }}>
                <div style={{ height: '100%', background: '#d5a450', width: `${openingPct}%` }} />
              </div>
            </div>

            {/* Middlegame */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.84rem', marginBottom: '4px' }}>
                <span style={{ color: '#cbc9c4' }}>{tr('Mittelspiel', 'Middlegame')}</span>
                <span style={{ fontWeight: 700, color: '#ffffff' }}>
                  {stats.phaseDistribution.middlegameBlunders} ({midPct}%)
                </span>
              </div>
              <div style={{ width: '100%', height: '8px', background: '#24231e', borderRadius: '4px', overflow: 'hidden' }}>
                <div style={{ height: '100%', background: '#ca3431', width: `${midPct}%` }} />
              </div>
            </div>

            {/* Endgame */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.84rem', marginBottom: '4px' }}>
                <span style={{ color: '#cbc9c4' }}>{tr('Endspiel (Materialheuristik)', 'Endgame (Material Heuristic)')}</span>
                <span style={{ fontWeight: 700, color: '#ffffff' }}>
                  {stats.phaseDistribution.endgameBlunders} ({endPct}%)
                </span>
              </div>
              <div style={{ width: '100%', height: '8px', background: '#24231e', borderRadius: '4px', overflow: 'hidden' }}>
                <div style={{ height: '100%', background: '#5c8bb0', width: `${endPct}%` }} />
              </div>
            </div>
          </div>
        </div>

        {/* Piece Blunders */}
        <div style={{ background: '#1c1b18', border: '1px solid #2e2b24', borderRadius: '12px', padding: '20px' }}>
          <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '16px', color: '#ffffff', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <ShieldCheck size={18} color="#81b64c" />
            <span>{tr('Belegbar verlorene/eingestellte Figuren', 'Pieces Blundered / Dropped')}</span>
          </h3>

          <div className="analytics-pieces-grid">
            {(['q', 'r', 'b', 'n', 'p', 'k'] as const).map((p) => {
              const count = stats.blunderedPieces[p] || 0;
              return (
                <div
                  key={p}
                  style={{
                    background: '#24231e',
                    border: '1px solid #2e2b24',
                    borderRadius: '8px',
                    padding: '12px 8px',
                    textAlign: 'center',
                  }}
                >
                  <div style={{ fontSize: '1.8rem', marginBottom: '4px' }}>{pieceNames[p].icon}</div>
                  <div style={{ fontSize: '0.78rem', color: '#a8a6a0' }}>{pieceNames[p].label}</div>
                  <div style={{ fontSize: '1.2rem', fontWeight: 800, color: count > 0 ? '#ff7b78' : '#81b64c', marginTop: '4px' }}>
                    {count}x
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
        </div>
      </details>

      {/* Übersehene Züge & Mattmuster */}
      <details className="diag-accordion">
        <summary className="diag-accordion-summary">
          <span className="diag-accordion-title">
            <Eye size={17} color="#81b64c" />
            <span>{tr('Übersehene Motive & Mattmuster', 'Missed Motifs & Mate Patterns')}</span>
          </span>
          <span className="diag-accordion-meta">
            {stats.overlookedIdeas.total} {tr('Motive', 'motifs')} · {stats.matePatterns.total} {tr('Matts', 'mates')}
          </span>
        </summary>
        <div className="diag-accordion-body">
      <div className="analytics-two-grid">
        <div style={{ background: '#1c1b18', border: '1px solid #2e2b24', borderRadius: '12px', padding: '20px' }}>
          <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '4px', color: '#ffffff', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Eye size={18} color="#81b64c" />
            <span>{tr('Übersehene Züge & Ideen', 'Missed Moves & Ideas')}</span>
          </h3>
          <div style={{ fontSize: '0.78rem', color: '#7d7b74', marginBottom: '14px' }}>
            {tr('Was der Engine-Bestzug in deinen Fehlerpositionen gebracht hätte', 'What the engine best move would have achieved in your mistake positions')}
          </div>

          {stats.overlookedIdeas.total === 0 ? (
            <div style={{ color: '#a8a6a0', fontSize: '0.84rem' }}>{tr('Noch keine Fehlerzüge analysiert.', 'No mistakes analyzed yet.')}</div>
          ) : (
            <>
              <div style={{ fontSize: '0.78rem', color: '#7d7b74', marginBottom: '10px' }}>
                {tr(
                  `Stichprobe: ${stats.overlookedIdeas.total} Fehlerzüge aus ${stats.totalGames} Partien — Klick auf ein Motiv übt gezielt, Klick auf ein Beispiel öffnet die Partie vor dem Fehler.`,
                  `Sample: ${stats.overlookedIdeas.total} mistakes across ${stats.totalGames} games — click a motif to drill it, or click an example to inspect the position.`,
                )}
              </div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '14px' }}>
                {(['mate', 'capture', 'fork', 'check', 'quiet'] as const).map((idea) => {
                  const count = stats.overlookedIdeas.counts[idea];
                  if (count === 0) return null;
                  const isTop = idea === (Object.entries(stats.overlookedIdeas.counts).sort((a, b) => b[1] - a[1])[0]?.[0]);
                  return (
                    <div
                      key={idea}
                      onClick={() => onTrainMotif(idea)}
                      style={{
                        background: '#24231e',
                        border: `1px solid ${isTop ? '#81b64c' : '#2e2b24'}`,
                        borderRadius: '8px',
                        padding: '8px 12px',
                        fontSize: '0.8rem',
                        color: '#e0dfdb',
                        cursor: 'pointer',
                      }}
                      title={tr('Diese Fehler üben — gefiltertes Training', 'Practice these mistakes — filtered training')}
                    >
                      <strong style={{ color: isTop ? '#81b64c' : '#ffffff' }}>{count}x</strong> {ideaLabel(idea)}
                    </div>
                  );
                })}
              </div>
              {stats.overlookedIdeas.total > 0 && (() => {
                const topIdea = Object.entries(stats.overlookedIdeas.counts).sort((a, b) => b[1] - a[1])[0]?.[0] as MissedIdea | undefined;
                return topIdea ? (
                  <button className="btn-secondary" onClick={() => onTrainMotif(topIdea)} style={{ marginBottom: '12px', padding: '8px 14px' }}>
                    <Target size={16} />
                    <span>{tr('Diese Fehler üben', 'Train these errors')} ({ideaLabel(topIdea)})</span>
                  </button>
                ) : null;
              })()}
              <AnalysisList title={tr('Konkrete Beispielzüge', 'Concrete Examples')} count={stats.overlookedIdeas.examples.length} noun={tr('Beispiele', 'examples')}>
              {stats.overlookedIdeas.examples.map((ex, idx) => (
                <div
                  key={idx}
                  onClick={() => {
                    if (ex.gameId && ex.ply !== undefined) onOpenGameAt(ex.gameId, ex.ply - 1);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: '10px',
                    padding: '8px 10px',
                    borderRadius: '6px',
                    background: '#24231e',
                    border: '1px solid #2e2b24',
                    marginBottom: '6px',
                    fontSize: '0.82rem',
                    cursor: ex.gameId ? 'pointer' : 'default',
                  }}
                  title={ex.gameId ? tr('Beleg öffnen — Partie an der Position vor diesem Fehler', 'Open game right before this error') : undefined}
                >
                  <span style={{ color: '#7d7b74', minWidth: '58px' }}>{tr('Zug', 'Move')} {ex.moveNumber}</span>
                  <span style={{ color: '#ff7b78', fontWeight: 700 }}>{ex.san}</span>
                  <span style={{ color: '#7d7b74' }}>→</span>
                  <span style={{ color: '#81b64c', fontWeight: 700 }}>{ex.bestSan}</span>
                  <span style={{ color: '#a8a6a0', marginLeft: 'auto' }}>
                    {ideaLabel(ex.idea)}
                    {ex.heuristic && (
                      <span
                        style={{ color: '#7d7b74', marginLeft: '6px', fontSize: '0.72rem' }}
                        title={tr('Gabel nur geometrisch erkannt, ohne belegten Materialgewinn', 'Geometrically detected fork without confirmed material gain')}
                      >
                        ({tr('Heuristik', 'Heuristic')})
                      </span>
                    )}
                  </span>
                </div>
              ))}
              </AnalysisList>
            </>
          )}
        </div>

        <div style={{ background: '#1c1b18', border: '1px solid #2e2b24', borderRadius: '12px', padding: '20px' }}>
          <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '4px', color: '#ffffff', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Skull size={18} color="#ca3431" />
            <span>{tr('Mattmuster (verlorene Partien)', 'Checkmate Patterns (Lost Games)')}</span>
          </h3>
          <div style={{ fontSize: '0.78rem', color: '#7d7b74', marginBottom: '14px' }}>
            {tr(`Wie du mattgesetzt wurdest - ${stats.matePatterns.total}x insgesamt`, `How you were checkmated — ${stats.matePatterns.total}x total`)}
          </div>

          {stats.matePatterns.total === 0 ? (
            <div style={{ color: '#81b64c', fontSize: '0.84rem' }}>
              {tr('Keine Mattniederlagen in den analysierten Partien. Weiter so!', 'No checkmate losses in the analyzed games. Keep it up!')}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {([
                { key: 'backRank', label: tr('Grundlinienmatt', 'Back-rank mate'), hint: tr('König auf der Grundlinie eingesperrt', 'King trapped on back rank') },
                { key: 'smothered', label: tr('Ersticktes Matt', 'Smothered mate'), hint: tr('König von eigenen Steinen umstellt', 'King boxed in by own pieces') },
                { key: 'net', label: tr('Mattnetz', 'Mating net'), hint: tr('König schlicht überlaufen', 'King caught in an open-board mating net') },
              ] as const).map(({ key, label, hint }) => {
                const count = stats.matePatterns[key];
                const pct = stats.matePatterns.total > 0 ? Math.round((count / stats.matePatterns.total) * 100) : 0;
                return (
                  <div key={key}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.84rem', marginBottom: '4px' }}>
                      <span style={{ color: '#cbc9c4' }}>
                        {label} <span style={{ color: '#7d7b74', fontSize: '0.76rem' }}>· {hint}</span>
                      </span>
                      <span style={{ fontWeight: 700, color: count > 0 ? '#ff7b78' : '#7d7b74' }}>
                        {count}x ({pct}%)
                      </span>
                    </div>
                    <div style={{ width: '100%', height: '8px', background: '#24231e', borderRadius: '4px', overflow: 'hidden' }}>
                      <div style={{ height: '100%', background: '#ca3431', width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
        </div>
      </details>

      <OpeningPhasePanel rows={stats.openingPhaseStats || []} windowMoves={stats.openingWindowMoves || 12}
        onWindowChange={onOpeningWindowChange} onErrors={onOpeningErrors} onResponses={onOpeningResponses} onOpenGameAt={onOpenGameAt} />

      {/* Full-game results remain separate from opening decisions. */}
      <details className="diag-accordion">
        <summary className="diag-accordion-summary">
          <span className="diag-accordion-title">
            <BookOpen size={17} color="#81b64c" />
            <span>{tr('Alle Eröffnungen · Gesamte Partie', 'All Openings · Full Game')}</span>
          </span>
          <span className="diag-accordion-meta">{stats.openingsStats.length} {tr('Eröffnungen', 'openings')}</span>
        </summary>
        <div className="diag-accordion-body">
      <div style={{ background: '#1c1b18', border: '1px solid #2e2b24', borderRadius: '12px', padding: '20px' }}>
        <AnalysisList title={tr('Partieergebnisse nach Eröffnung · gesamte Partie', 'Full-Game Results by Opening')} count={stats.openingsStats.length} noun={tr('Eröffnungen', 'openings')}>
        <div className="opening-phase-table-wrap">
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #2b2922', color: '#a8a6a0', fontSize: '0.76rem', textTransform: 'uppercase' }}>
              <th style={{ padding: '8px 12px' }}>{tr('Eröffnung', 'Opening')}</th>
              <th style={{ padding: '8px 12px' }}>ECO</th>
              <th style={{ padding: '8px 12px' }}>{tr('Partien', 'Games')}</th>
              <th style={{ padding: '8px 12px' }}>{tr('Bilanz gesamt', 'Overall W-L-D')}</th>
              <th style={{ padding: '8px 12px' }}>{tr('Weiß', 'White')}</th>
              <th style={{ padding: '8px 12px' }}>{tr('Schwarz', 'Black')}</th>
              <th style={{ padding: '8px 12px' }}>{tr('Genauigkeit', 'Accuracy')}</th>
              <th style={{ padding: '8px 12px' }}>{tr('Fehler + Patzer', 'Mistakes + Blunders')}</th>
            </tr>
          </thead>
          <tbody>
            {stats.openingsStats.map((op, idx) => (
              <tr key={idx} style={{ borderBottom: '1px solid #24231e' }}>
                <td style={{ padding: '10px 12px', fontWeight: 600, color: '#ffffff' }}>{op.name}</td>
                <td style={{ padding: '10px 12px', color: '#81b64c' }}>{op.eco}</td>
                <td style={{ padding: '10px 12px', color: '#cbc9c4' }}>{op.games}</td>
                <td style={{ padding: '10px 12px', color: '#cbc9c4' }}>
                  {op.wins}-{op.losses}-{op.draws}
                </td>
                <td style={{ padding: '10px 12px', color: '#cbc9c4' }}>
                  {op.whiteGames > 0 ? `${op.whiteWins}/${op.whiteGames}` : '–'}
                </td>
                <td style={{ padding: '10px 12px', color: '#cbc9c4' }}>
                  {op.blackGames > 0 ? `${op.blackWins}/${op.blackGames}` : '–'}
                </td>
                <td style={{ padding: '10px 12px', fontWeight: 700, color: '#81b64c' }}>{op.avgAccuracy}%</td>
                <td style={{ padding: '10px 12px', color: op.blunders > 0 ? '#ff7b78' : '#81b64c', fontWeight: 700 }}>
                  {op.blunders}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        </AnalysisList>
      </div>
        </div>
      </details>

    </div>
  );
};
