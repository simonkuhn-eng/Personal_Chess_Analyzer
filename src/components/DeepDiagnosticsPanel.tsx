import React from 'react';
import {
  Activity,
  AlertOctagon,
  ArrowRight,
  Compass,
  Flame,
  Shield,
  Sparkles,
  Swords,
  Target,
  TrendingDown,
  TrendingUp,
  Trophy,
} from 'lucide-react';
import type {
  CoreMoveQuality,
  DeepDiagnostics,
  MissedIdea,
  MoveQuality,
  TrainingRecommendation,
} from '../types/chess';
import { MISSED_IDEA_LABELS } from '../utils/moveInsights';
import { AnalysisList } from './AnalysisList';
import { useI18n } from '../utils/i18n';

interface DeepDiagnosticsPanelProps {
  diagnostics: DeepDiagnostics;
  onOpenGameAt: (gameId: string, ply: number) => void;
  onTrainMotif: (idea: MissedIdea) => void;
}

const QUALITY_META: Array<{ key: CoreMoveQuality; label: string; labelEn: string; color: string }> = [
  { key: 'brilliant', label: 'Brillant', labelEn: 'Brilliant', color: '#1fbfa6' },
  { key: 'best', label: 'Bestzug', labelEn: 'Best', color: '#81b64c' },
  { key: 'excellent', label: 'Exzellent', labelEn: 'Excellent', color: '#9ec970' },
  { key: 'good', label: 'Gut', labelEn: 'Good', color: '#789862' },
  { key: 'inaccuracy', label: 'Ungenauigkeit', labelEn: 'Inaccuracy', color: '#f7c631' },
  { key: 'mistake', label: 'Fehler', labelEn: 'Mistake', color: '#ffa34e' },
  { key: 'blunder', label: 'Patzer', labelEn: 'Blunder', color: '#f13f35' },
  { key: 'miss', label: 'Verpasste Chance', labelEn: 'Miss', color: '#ff7767' },
];

const CLASSIFICATION_LABELS: Partial<Record<MoveQuality, { label: string; labelEn: string; color: string }>> = {
  blunder: { label: 'Patzer', labelEn: 'Blunder', color: '#f13f35' },
  mistake: { label: 'Fehler', labelEn: 'Mistake', color: '#ffa34e' },
  miss: { label: 'Verpasste Chance', labelEn: 'Miss', color: '#ff7767' },
  inaccuracy: { label: 'Ungenauigkeit', labelEn: 'Inaccuracy', color: '#f7c631' },
};

const PHASE_LABELS: Record<NonNullable<TrainingRecommendation['targetPhase']>, { de: string; en: string }> = {
  opening: { de: 'Eröffnung', en: 'Opening' },
  middlegame: { de: 'Mittelspiel', en: 'Middlegame' },
  endgame: { de: 'Endspiel', en: 'Endgame' },
};

const PRIORITY_STYLES: Record<TrainingRecommendation['priority'], { label: string; labelEn: string; className: string }> = {
  high: { label: 'Priorität Hoch', labelEn: 'High Priority', className: 'is-high' },
  medium: { label: 'Fokus', labelEn: 'Focus', className: 'is-medium' },
  low: { label: 'Hinweis', labelEn: 'Note', className: 'is-low' },
};

const IDEA_LABELS_EN: Record<string, string> = {
  mate: 'Missed mate',
  capture: 'Winning capture',
  fork: 'Missed fork',
  check: 'Strong check',
  quiet: 'Positional improvement',
};

const BUCKET_LABELS_EN: Record<string, string> = {
  stronger: 'Stronger (+100+)',
  equal: 'Even (±99)',
  weaker: 'Lower-rated (-100+)',
};

const formatNum = (val: number | null, suffix = '', isEn = false): string =>
  val === null ? '—' : `${val.toLocaleString(isEn ? 'en-US' : 'de-DE')}${suffix}`;

export const DeepDiagnosticsPanel: React.FC<DeepDiagnosticsPanelProps> = ({
  diagnostics,
  onOpenGameAt,
  onTrainMotif,
}) => {
  const { isEn, tr } = useI18n();
  const locale = isEn ? 'en-US' : 'de-DE';
  const ideaLabel = (idea: MissedIdea) => (isEn ? (IDEA_LABELS_EN[idea] || MISSED_IDEA_LABELS[idea]) : MISSED_IDEA_LABELS[idea]);
  const zoneLabel = (raw: string) => (isEn ? raw.replace(/^Züge\s+/i, 'Moves ').replace(/Züge/g, 'Moves') : raw);
  const {
    analyzedGames,
    totalDecisions,
    moveZones,
    conversion,
    turningPoints,
    moveQuality,
    pressureProfile,
    opponentStrength,
    opponentStrengthUnknownGames,
    formComparison,
    recommendations,
  } = diagnostics;

  const peakZone = [...moveZones]
    .filter((z) => z.decisions > 0 && z.errors > 0)
    .sort((a, b) => b.errorsPer100 - a.errorsPer100 || b.errors - a.errors)[0];
  const maxZoneErrorsPer100 = Math.max(1, ...moveZones.map((z) => z.errorsPer100));

  const hasAnyEloBucket = opponentStrength.some((b) => b.games > 0);
  const accDeltaPositive = formComparison.accuracyDelta >= 0;
  const errDeltaPositive = formComparison.errorsPer100Delta <= 0;

  return (
    <section className="deep-diagnostics-section" aria-label={tr('Tiefen-Diagnostik', 'Deep Diagnostics')}>
      {/* 1. Konkrete Trainings-Schwerpunkte */}
      <div className="deep-diag-card deep-diag-rec-card">
        <div className="deep-diag-header">
          <div>
            <h3>
              <Sparkles size={18} color="#d5a450" />
              <span>{tr('Priorisierte Trainings-Empfehlungen', 'Prioritized Training Focus')}</span>
            </h3>
            <p>{tr(
              `Konkrete Hebel aus ${analyzedGames} analysierten Partien (${totalDecisions} eigene Entscheidungen)`,
              `Actionable patterns across ${analyzedGames} analyzed games (${totalDecisions} player decisions)`,
            )}</p>
          </div>
        </div>
        {recommendations.length === 0 ? (
          <p className="deep-diag-empty">
            {tr(
              'Noch keine klaren Fehler-Schwerpunkte erkannt. Analysiere weitere Partien, um datenbasierte Trainingsziele zu erhalten.',
              'No clear recurring patterns yet. Analyze more games to unlock data-driven training priorities.',
            )}
          </p>
        ) : (
          <div className="deep-diag-rec-grid">
            {recommendations.map((rec) => {
              const prio = PRIORITY_STYLES[rec.priority];
              const canOpenSample = Boolean(rec.sampleGameId && rec.samplePly !== undefined);
              const canTrainMotif = Boolean(rec.targetMotif);
              return (
                <article key={rec.id} className="deep-diag-rec-item">
                  <div className="deep-diag-rec-badges">
                    <span className={`deep-diag-badge ${prio.className}`}>{isEn ? prio.labelEn : prio.label}</span>
                    {rec.targetPhase && (
                      <span className="deep-diag-badge is-neutral">
                        {isEn ? PHASE_LABELS[rec.targetPhase].en : PHASE_LABELS[rec.targetPhase].de}
                      </span>
                    )}
                    {rec.targetMotif && <span className="deep-diag-badge is-motif">{ideaLabel(rec.targetMotif)}</span>}
                  </div>
                  <h4>{rec.title}</h4>
                  <p className="deep-diag-rec-summary">{rec.summary}</p>
                  <div className="deep-diag-rec-evidence">{rec.evidence}</div>
                  {(canOpenSample || canTrainMotif) && (
                    <div className="deep-diag-rec-actions">
                      {canOpenSample && rec.sampleGameId && rec.samplePly !== undefined && (
                        <button
                          type="button"
                          className="btn-secondary btn-sm"
                          onClick={() => onOpenGameAt(rec.sampleGameId!, rec.samplePly! - 1)}
                        >
                          <span>{rec.actionLabel}</span>
                          <ArrowRight size={14} />
                        </button>
                      )}
                      {canTrainMotif && rec.targetMotif && (
                        <button
                          type="button"
                          className="btn-primary btn-sm"
                          onClick={() => onTrainMotif(rec.targetMotif!)}
                        >
                          <Target size={14} />
                          <span>{canOpenSample ? tr(`${ideaLabel(rec.targetMotif)} üben`, `Train ${ideaLabel(rec.targetMotif)}`) : rec.actionLabel}</span>
                        </button>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>

      {/* 2. Formvergleich & Zugqualitäts-Verteilung */}
      <details className="diag-accordion">
        <summary className="diag-accordion-summary">
          <span className="diag-accordion-title">
            <Activity size={17} color="#81b64c" />
            <span>{tr('Formvergleich & Zugqualität', 'Form Comparison & Move Quality')}</span>
          </span>
          <span className="diag-accordion-meta">
            {tr('Ø', 'Avg')} {formComparison.recentAccuracy}% · {moveQuality.totalDecisions} {tr('Züge', 'moves')}
          </span>
        </summary>
        <div className="diag-accordion-body">
      <div className="deep-diag-two-grid">
        <div className="deep-diag-card">
          <div className="deep-diag-header">
            <div>
              <h3>
                {accDeltaPositive ? <TrendingUp size={18} color="#81b64c" /> : <TrendingDown size={18} color="#ff7767" />}
                <span>{tr(`Formvergleich · Letzte ${formComparison.recentGames} vs. Gesamtpool`, `Recent Form · Last ${formComparison.recentGames} vs. Overall`)}</span>
              </h3>
              <p>
                {formComparison.overallGames <= 10
                  ? tr(
                      `Aktuell umfasst dein Pool ${formComparison.overallGames} Partien (ab > 10 Partien trennen sich Form und Gesamt-Ø).`,
                      `Your pool currently has ${formComparison.overallGames} games (recent form splits cleanly above 10 games).`,
                    )
                  : tr(
                      `Letzte ${formComparison.recentGames} Partien chronologisch gegen alle ${formComparison.overallGames} Partien`,
                      `Last ${formComparison.recentGames} chronological games vs. all ${formComparison.overallGames} games`,
                    )}
              </p>
            </div>
          </div>

          <div className="deep-diag-form-grid">
            <div className="deep-diag-metric-box">
              <span className="deep-diag-metric-label">{tr('Siegrate (beendet)', 'Win Rate (finished)')}</span>
              <div className="deep-diag-metric-pair">
                <strong>{formComparison.recentCompletedGames > 0 ? `${formComparison.recentWinRate} %` : '—'}</strong>
                <small>
                  {tr('Gesamt', 'Overall')}: {formComparison.overallCompletedGames > 0 ? `${formComparison.overallWinRate} %` : '—'}
                </small>
              </div>
            </div>

            <div className="deep-diag-metric-box">
              <span className="deep-diag-metric-label">{tr('Ø Genauigkeit', 'Avg Accuracy')}</span>
              <div className="deep-diag-metric-pair">
                <strong>{formComparison.recentGames > 0 ? `${formComparison.recentAccuracy} %` : '—'}</strong>
                <small>{tr('Gesamt', 'Overall')}: {formComparison.overallGames > 0 ? `${formComparison.overallAccuracy} %` : '—'}</small>
              </div>
              <span className={`deep-diag-delta ${accDeltaPositive ? 'is-good' : 'is-bad'}`}>
                {formComparison.accuracyDelta > 0 ? `+${formComparison.accuracyDelta}` : formComparison.accuracyDelta} {tr('%-Pkt.', 'pts')}
              </span>
            </div>

            <div className="deep-diag-metric-box">
              <span className="deep-diag-metric-label">{tr('Fehler / 100 Züge', 'Errors / 100 Moves')}</span>
              <div className="deep-diag-metric-pair">
                <strong>{formComparison.recentErrorsPer100.toLocaleString(locale)}</strong>
                <small>{tr('Gesamt', 'Overall')}: {formComparison.overallErrorsPer100.toLocaleString(locale)}</small>
              </div>
              <span className={`deep-diag-delta ${errDeltaPositive ? 'is-good' : 'is-bad'}`}>
                {formComparison.errorsPer100Delta > 0 ? `+${formComparison.errorsPer100Delta}` : formComparison.errorsPer100Delta} / 100
              </span>
            </div>
          </div>
        </div>

        <div className="deep-diag-card">
          <div className="deep-diag-header">
            <div>
              <h3>
                <Activity size={18} color="#81b64c" />
                <span>{tr('Zugqualitäts-Verteilung', 'Move Quality Distribution')}</span>
              </h3>
              <p>{tr(`${moveQuality.totalDecisions} eigene, nicht erzwungene Entscheidungen`, `${moveQuality.totalDecisions} non-forced player decisions`)}</p>
            </div>
          </div>

          {moveQuality.totalDecisions === 0 ? (
            <p className="deep-diag-empty">{tr('Keine auswertbaren Entscheidungen vorhanden.', 'No evaluable decisions available.')}</p>
          ) : (
            <>
              <div className="deep-diag-quality-bar" aria-label={tr('Verteilung der Zugqualität', 'Move quality distribution')}>
                {QUALITY_META.map(({ key, label, labelEn, color }) => {
                  const pct = (moveQuality.counts[key] / moveQuality.totalDecisions) * 100;
                  if (pct <= 0) return null;
                  const qLabel = isEn ? labelEn : label;
                  return (
                    <div
                      key={key}
                      style={{ width: `${pct}%`, background: color }}
                      title={tr(`${qLabel}: ${moveQuality.counts[key]} (${moveQuality.per100[key]} je 100 Züge)`, `${qLabel}: ${moveQuality.counts[key]} (${moveQuality.per100[key]} per 100 moves)`)}
                    />
                  );
                })}
              </div>

              <div className="deep-diag-quality-grid">
                {QUALITY_META.map(({ key, label, labelEn, color }) => (
                  <div key={key} className="deep-diag-quality-chip">
                    <span className="deep-diag-quality-dot" style={{ background: color }} />
                    <div className="deep-diag-quality-info">
                      <span className="deep-diag-quality-name">{isEn ? labelEn : label}</span>
                      <strong>
                        {moveQuality.counts[key]} <small>({moveQuality.per100[key]} / 100)</small>
                      </strong>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
        </div>
      </details>

      {/* 3. Fehlerdichte nach Zugbereich */}
      <details className="diag-accordion">
        <summary className="diag-accordion-summary">
          <span className="diag-accordion-title">
            <Compass size={17} color="#d5a450" />
            <span>{tr('Fehlerdichte nach Zugzonen', 'Error Density by Move Window')}</span>
          </span>
          <span className="diag-accordion-meta">
            {peakZone ? `${tr('Spitze', 'Peak')}: ${zoneLabel(peakZone.label)} (${peakZone.errorsPer100}/100)` : tr('Zugbereich-Analyse', 'Move-window analysis')}
          </span>
        </summary>
        <div className="diag-accordion-body">
      <div className="deep-diag-card">
        <div className="deep-diag-header">
          <div>
            <h3>
              <Compass size={18} color="#d5a450" />
              <span>{tr('Fehlerdichte nach Zugbereich (10er-Zugzonen)', 'Error Density by 10-Move Windows')}</span>
            </h3>
            <p>{tr('Wo deine Entscheidungen am stärksten streuen — normiert auf Fehler pro 100 eigene Züge', 'Where accuracy dips most, normalized to errors per 100 player moves')}</p>
          </div>
        </div>

        <div className="deep-diag-table-wrap">
          <table className="deep-diag-table">
            <thead>
              <tr>
                <th>{tr('Zugzone', 'Move Window')}</th>
                <th>{tr('Entscheidungen', 'Decisions')}</th>
                <th>{tr('Fehler / 100 Züge', 'Errors / 100 Moves')}</th>
                <th>{tr('Fehler-Aufteilung (U · F · P · V)', 'Breakdown (I · M · B · X)')}</th>
                <th>{tr('Ø Genauigkeit', 'Avg Accuracy')}</th>
              </tr>
            </thead>
            <tbody>
              {moveZones.map((zone) => {
                const isPeak = peakZone?.zone === zone.zone && zone.errors > 0;
                const barWidth = zone.decisions > 0 ? Math.min(100, (zone.errorsPer100 / maxZoneErrorsPer100) * 100) : 0;
                return (
                  <tr key={zone.zone} className={isPeak ? 'is-peak' : undefined}>
                    <td>
                      <strong>{zoneLabel(zone.label)}</strong>
                      {isPeak && <span className="deep-diag-peak-tag">{tr('Höchste Dichte', 'Highest Density')}</span>}
                    </td>
                    <td>{zone.decisions}</td>
                    <td>
                      <div className="deep-diag-bar-cell">
                        <span className="deep-diag-rate-value">{zone.decisions > 0 ? zone.errorsPer100.toLocaleString(locale) : '—'}</span>
                        <div className="deep-diag-mini-track">
                          <div
                            className="deep-diag-mini-fill"
                            style={{
                              width: `${barWidth}%`,
                              background: isPeak ? '#ffa34e' : '#81b64c',
                            }}
                          />
                        </div>
                      </div>
                    </td>
                    <td className="deep-diag-breakdown">
                      {zone.decisions === 0 ? (
                        '—'
                      ) : (
                        <>
                          <span title={tr('Ungenauigkeiten', 'Inaccuracies')} style={{ color: '#f7c631' }}>{zone.inaccuracies}{tr('U', 'I')}</span>
                          <span>·</span>
                          <span title={tr('Gröbere Fehler', 'Mistakes')} style={{ color: '#ffa34e' }}>{zone.mistakes}{tr('F', 'M')}</span>
                          <span>·</span>
                          <span title={tr('Patzer', 'Blunders')} style={{ color: '#f13f35' }}>{zone.blunders}{tr('P', 'B')}</span>
                          <span>·</span>
                          <span title={tr('Verpasste Chancen', 'Misses')} style={{ color: '#ff7767' }}>{zone.misses}{tr('V', 'X')}</span>
                        </>
                      )}
                    </td>
                    <td>
                      <strong className={zone.avgAccuracy !== null ? 'statistics-accuracy' : undefined}>
                        {formatNum(zone.avgAccuracy, ' %', isEn)}
                      </strong>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
        </div>
      </details>

      {/* 4. Verwertung & Widerstandskraft + Teuerste Wendepunkte */}
      <details className="diag-accordion">
        <summary className="diag-accordion-summary">
          <span className="diag-accordion-title">
            <Trophy size={17} color="#d5a450" />
            <span>{tr('Vorteile verwerten & Wendepunkte', 'Conversion & Turning Points')}</span>
          </span>
          <span className="diag-accordion-meta">
            {tr('Verwertung', 'Conversion')} {formatNum(conversion.conversionRate, '%', isEn)} · {turningPoints.length} {tr('Wendepunkte', 'turning points')}
          </span>
        </summary>
        <div className="diag-accordion-body">
      <div className="deep-diag-two-grid">
        <div className="deep-diag-card">
          <div className="deep-diag-header">
            <div>
              <h3>
                <Trophy size={18} color="#d5a450" />
                <span>{tr('Verwertung & Widerstandskraft', 'Conversion & Defensive Resilience')}</span>
              </h3>
              <p>{tr('Wie oft du klare Vorteile nach Hause bringst — und wie oft du aus schlechten Stellungen zurückkommst', 'How often you convert clear advantages and how often you save tough positions')}</p>
            </div>
          </div>

          <div className="deep-diag-resilience-stack">
            <div className="deep-diag-resilience-box">
              <div className="deep-diag-resilience-top">
                <span>{tr('Gewinnstellungen verwertet (≥ 75 % oder ≥ +2,0)', 'Winning positions converted (≥ 75% or ≥ +2.0)')}</span>
                <strong style={{ color: '#81b64c' }}>{formatNum(conversion.conversionRate, ' %', isEn)}</strong>
              </div>
              <div className="deep-diag-progress-track">
                <div
                  className="deep-diag-progress-fill is-win"
                  style={{ width: `${conversion.conversionRate ?? 0}%` }}
                />
              </div>
              <div className="deep-diag-resilience-meta">
                <span>{conversion.winningGamesReached} {tr('erreicht', 'reached')}</span>
                <span>{conversion.winningGamesConverted} {tr('gewonnen', 'won')}</span>
                <span className={conversion.winningGamesSquandered > 0 ? 'is-warn' : undefined}>
                  {conversion.winningGamesSquandered} {tr('verschenkt', 'dropped')} ({conversion.squanderedLosses} {tr('N', 'L')} · {conversion.squanderedDraws} {tr('R', 'D')})
                </span>
              </div>
            </div>

            <div className="deep-diag-resilience-box">
              <div className="deep-diag-resilience-top">
                <span>{tr('Widerstandskraft (≤ 25 % oder ≤ −2,0)', 'Defensive saves (≤ 25% or ≤ -2.0)')}</span>
                <strong style={{ color: '#d5a450' }}>{formatNum(conversion.resilienceRate, ' %', isEn)}</strong>
              </div>
              <div className="deep-diag-progress-track">
                <div
                  className="deep-diag-progress-fill is-save"
                  style={{ width: `${conversion.resilienceRate ?? 0}%` }}
                />
              </div>
              <div className="deep-diag-resilience-meta">
                <span>{conversion.defensiveGamesFaced} {tr('gedrückte Partien', 'tough games')}</span>
                <span>{conversion.defensiveGamesSaved} {tr('gerettet (Sieg/Remis)', 'saved (W/D)')}</span>
                <span>{conversion.defensiveGamesLost} {tr('verloren', 'lost')}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="deep-diag-card">
          <AnalysisList
            title={
              <>
                <AlertOctagon size={18} color="#ff7767" />
                <span>{tr('Kritische Wendepunkte (ab ≥ 55 % mit ≥ 22 % Verlust)', 'Critical Turning Points (≥ 55% dropping ≥ 22%)')}</span>
              </>
            }
            count={turningPoints.length}
            noun={tr('Züge', 'moves')}
          >
            {turningPoints.length === 0 ? (
              <p className="deep-diag-empty">{tr('Keine schweren Kipppunkte aus aussichtsreicher Stellung gefunden.', 'No major collapses from favorable positions found.')}</p>
            ) : (
              <div className="deep-diag-turning-list">
                {turningPoints.map((tp) => {
                  const cls = CLASSIFICATION_LABELS[tp.classification] || { label: tp.classification, labelEn: tp.classification, color: '#ffa34e' };
                  const moveLabel = `${tp.moveNumber}${tp.userColor === 'w' ? '.' : '...'} ${tp.san}`;
                  return (
                    <button
                      type="button"
                      key={`${tp.gameId}:${tp.ply}`}
                      className="deep-diag-turning-row"
                      onClick={() => onOpenGameAt(tp.gameId, tp.ply - 1)}
                      title={tr('Stellung direkt vor diesem Wendepunkt im Review öffnen', 'Open position right before this turning point')}
                    >
                      <div className="deep-diag-turning-main">
                        <span className="deep-diag-turning-moves">
                          <strong style={{ color: '#ff7b78' }}>{moveLabel}</strong>
                          <span className="deep-diag-arrow">→</span>
                          <strong style={{ color: '#81b64c' }}>{tp.bestMoveSan}</strong>
                        </span>
                        <span className="deep-diag-turning-swing">
                          {tp.winChanceBefore} % → {tp.winChanceAfter} %{' '}
                          <strong style={{ color: cls.color }}>(−{tp.winChanceDrop} %)</strong>
                        </span>
                      </div>
                      <div className="deep-diag-turning-sub">
                        <span style={{ color: cls.color }}>{isEn ? cls.labelEn : cls.label}</span>
                        <span>{tr('gegen', 'vs.')} {tp.opponent || tr('Unbekannt', 'Unknown')}</span>
                        <span>{tp.result}</span>
                        {tp.date && <span>{tp.date}</span>}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </AnalysisList>
        </div>
      </div>
        </div>
      </details>

      {/* 5. Druckprofil & Gegnerstärke */}
      <details className="diag-accordion">
        <summary className="diag-accordion-summary">
          <span className="diag-accordion-title">
            <Flame size={17} color="#ffa34e" />
            <span>{tr('Druckprofil & Gegnerstärke', 'Pressure Profile & Opponent Rating')}</span>
          </span>
          <span className="diag-accordion-meta">
            {tr('Im Schach', 'In check')} {formatNum(pressureProfile.checkAvgAccuracy, '%', isEn)} · {tr('Elo-Vergleich', 'Rating breakdown')}
          </span>
        </summary>
        <div className="diag-accordion-body">
      <div className="deep-diag-two-grid">
        <div className="deep-diag-card">
          <div className="deep-diag-header">
            <div>
              <h3>
                <Flame size={18} color="#ffa34e" />
                <span>{tr('Druckprofil (Schach & Stellungsspannung)', 'Pressure Profile (Checks & Tension)')}</span>
              </h3>
              <p>{tr('Vergleich deiner Präzision unter direktem Schachdruck sowie in ausgeglichenen vs. entschiedenen Stellungen', 'Compares precision when in check and in sharp vs. decided positions')}</p>
            </div>
          </div>

          <div className="deep-diag-pressure-grid">
            <div className="deep-diag-pressure-box">
              <div className="deep-diag-pressure-title">
                <Shield size={15} color="#ff7767" />
                <span>{tr('Im Schach', 'In Check')}</span>
              </div>
              <div className="deep-diag-pressure-stats">
                <div>
                  <small>{tr('Züge', 'Moves')}</small>
                  <strong>{pressureProfile.checkDecisions}</strong>
                </div>
                <div>
                  <small>{tr('Fehler / 100', 'Errors / 100')}</small>
                  <strong>{pressureProfile.checkDecisions > 0 ? pressureProfile.checkErrorsPer100 : '—'}</strong>
                </div>
                <div>
                  <small>{tr('Genauigkeit', 'Accuracy')}</small>
                  <strong>{formatNum(pressureProfile.checkAvgAccuracy, ' %', isEn)}</strong>
                </div>
              </div>
            </div>

            <div className="deep-diag-pressure-box">
              <div className="deep-diag-pressure-title">
                <Shield size={15} color="#81b64c" />
                <span>{tr('Ruhige Züge (ohne Schach)', 'Quiet Moves (Not in Check)')}</span>
              </div>
              <div className="deep-diag-pressure-stats">
                <div>
                  <small>{tr('Züge', 'Moves')}</small>
                  <strong>{pressureProfile.normalDecisions}</strong>
                </div>
                <div>
                  <small>{tr('Fehler / 100', 'Errors / 100')}</small>
                  <strong>{pressureProfile.normalDecisions > 0 ? pressureProfile.normalErrorsPer100 : '—'}</strong>
                </div>
                <div>
                  <small>{tr('Genauigkeit', 'Accuracy')}</small>
                  <strong>{formatNum(pressureProfile.normalAvgAccuracy, ' %', isEn)}</strong>
                </div>
              </div>
            </div>

            <div className="deep-diag-pressure-box">
              <div className="deep-diag-pressure-title">
                <Swords size={15} color="#d5a450" />
                <span>{tr('Scharfe Balance (|Eval| ≤ 3,0)', 'Sharp Balance (|Eval| ≤ 3.0)')}</span>
              </div>
              <div className="deep-diag-pressure-stats">
                <div>
                  <small>{tr('Züge', 'Moves')}</small>
                  <strong>{pressureProfile.sharpDecisions}</strong>
                </div>
                <div>
                  <small>{tr('Fehler / 100', 'Errors / 100')}</small>
                  <strong>{pressureProfile.sharpDecisions > 0 ? pressureProfile.sharpErrorsPer100 : '—'}</strong>
                </div>
                <div>
                  <small>{tr('Genauigkeit', 'Accuracy')}</small>
                  <strong>{formatNum(pressureProfile.sharpAvgAccuracy, ' %', isEn)}</strong>
                </div>
              </div>
            </div>

            <div className="deep-diag-pressure-box">
              <div className="deep-diag-pressure-title">
                <Compass size={15} color="#739fbd" />
                <span>{tr('Klare Stellung (|Eval| > 3,0)', 'Decided Position (|Eval| > 3.0)')}</span>
              </div>
              <div className="deep-diag-pressure-stats">
                <div>
                  <small>{tr('Züge', 'Moves')}</small>
                  <strong>{pressureProfile.quietDecisions}</strong>
                </div>
                <div>
                  <small>{tr('Fehler / 100', 'Errors / 100')}</small>
                  <strong>{pressureProfile.quietDecisions > 0 ? pressureProfile.quietErrorsPer100 : '—'}</strong>
                </div>
                <div>
                  <small>{tr('Genauigkeit', 'Accuracy')}</small>
                  <strong>{formatNum(pressureProfile.quietAvgAccuracy, ' %', isEn)}</strong>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="deep-diag-card">
          <div className="deep-diag-header">
            <div>
              <h3>
                <Swords size={18} color="#d5a450" />
                <span>{tr('Leistung nach Gegnerstärke (Elo-Differenz)', 'Performance by Opponent Rating')}</span>
              </h3>
              <p>{tr('Vergleich gegen stärkere, gleichstarke und schwächere Gegner laut PGN-Ratings', 'Comparison against higher-rated, even, and lower-rated opponents by PGN ratings')}</p>
            </div>
          </div>

          {!hasAnyEloBucket ? (
            <p className="deep-diag-empty">
              {tr('Für diesen Zeitraum liegen keine Partien mit beiden Elo-Werten (Weiß & Schwarz) vor.', 'No games with both White & Black PGN ratings found for this filter.')}
            </p>
          ) : (
            <>
              <div className="deep-diag-table-wrap">
                <table className="deep-diag-table">
                  <thead>
                    <tr>
                      <th>{tr('Gegner-Gruppe', 'Rating Tier')}</th>
                      <th>{tr('Partien', 'Games')}</th>
                      <th>{tr('Bilanz', 'W-L-D')}</th>
                      <th>{tr('Siegrate', 'Win Rate')}</th>
                      <th>{tr('Ø Genauigkeit', 'Avg Accuracy')}</th>
                      <th>{tr('Fehler / 100', 'Errors / 100')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {opponentStrength.map((bucket) => (
                      <tr key={bucket.category}>
                        <td><strong>{isEn ? (BUCKET_LABELS_EN[bucket.category] || bucket.label) : bucket.label}</strong></td>
                        <td>{bucket.games}</td>
                        <td>{bucket.games > 0 ? `${bucket.wins}-${bucket.losses}-${bucket.draws}` : '—'}</td>
                        <td>{formatNum(bucket.winRate, ' %', isEn)}</td>
                        <td>{formatNum(bucket.avgAccuracy, ' %', isEn)}</td>
                        <td>{bucket.decisions > 0 ? bucket.errorsPer100.toLocaleString(locale) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {opponentStrengthUnknownGames > 0 && (
                <p className="deep-diag-footnote">
                  {tr(
                    `${opponentStrengthUnknownGames} Partie${opponentStrengthUnknownGames === 1 ? '' : 'n'} ohne vollständige Elo-Angaben für beide Spieler ausgeblendet.`,
                    `${opponentStrengthUnknownGames} game${opponentStrengthUnknownGames === 1 ? '' : 's'} omitted without both player ratings.`,
                  )}
                </p>
              )}
            </>
          )}
        </div>
      </div>
        </div>
      </details>
    </section>
  );
};
