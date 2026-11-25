import React, { useState } from 'react';
import { BarChart3, CalendarDays, ChevronDown, Globe2, Hourglass, Timer, Zap } from 'lucide-react';
import type { PerformanceOverview, StatisticsFilter, TimeControlPerformance } from '../types/statistics';
import { PLATFORM_LABELS } from '../utils/statisticsFilter';
import { TIME_CONTROL_LABELS, TIME_CONTROL_ORDER } from '../utils/timeControl';
import { AnalysisList } from './AnalysisList';
import { getActiveLanguage, useI18n } from '../utils/i18n';

export const StatisticsFilters: React.FC<{ filter: StatisticsFilter; busy?: boolean; onChange: (filter: StatisticsFilter) => void }> = ({ filter, busy, onChange }) => {
  const { tr } = useI18n();
  const timeLabels: Record<string, string> = {
    bullet: tr('Bullet', 'Bullet'),
    blitz: tr('Blitz', 'Blitz'),
    rapid: tr('Schnellschach', 'Rapid'),
    daily: tr('Tägliches Schach', 'Daily'),
    unknown: tr('Unbekannt', 'Unknown'),
  };
  return (
    <section className="statistics-toolbar" aria-label={tr('Statistikfilter', 'Statistics filter')} aria-busy={busy}>
      <h2><BarChart3 size={22} /> {tr('Statistik & Diagnose', 'Statistics & Diagnostics')}</h2>
      <div className="statistics-filter-controls">
        <label><CalendarDays size={16} /><span className="sr-only">{tr('Statistikzeitraum', 'Time range')}</span><select aria-label={tr('Statistikzeitraum', 'Time range')} value={filter.days} onChange={event => onChange({ ...filter, days: Number(event.target.value) as StatisticsFilter['days'] })}>
          <option value="0">{tr('Gesamter Zeitraum', 'All time')}</option>{[7, 30, 90, 365].map(days => <option key={days} value={days}>{tr(`Letzte ${days} Tage`, `Last ${days} days`)}</option>)}
        </select></label>
        <label><Globe2 size={16} /><span className="sr-only">{tr('Statistikplattform', 'Platform filter')}</span><select aria-label={tr('Statistikplattform', 'Platform filter')} value={filter.platform} onChange={event => onChange({ ...filter, platform: event.target.value as StatisticsFilter['platform'] })}>
          <option value="all">{tr('Alle Plattformen', 'All platforms')}</option>{Object.entries(PLATFORM_LABELS).map(([key, label]) => <option key={key} value={key}>{key === 'other' ? tr('Andere / PGN', 'Other / PGN') : label}</option>)}
        </select></label>
        <label><Timer size={16} /><span className="sr-only">{tr('Statistikbedenkzeit', 'Time control filter')}</span><select aria-label={tr('Statistikbedenkzeit', 'Time control filter')} value={filter.timeControl} onChange={event => onChange({ ...filter, timeControl: event.target.value as StatisticsFilter['timeControl'] })}>
          <option value="all">{tr('Alle Bedenkzeiten', 'All time controls')}</option>{TIME_CONTROL_ORDER.map(kind => <option key={kind} value={kind}>{timeLabels[kind] || TIME_CONTROL_LABELS[kind]}</option>)}
        </select></label>
      </div>
    </section>
  );
};

const percent = (value: number | null) => value === null ? '—' : `${value.toLocaleString(getActiveLanguage() === 'en' ? 'en-US' : 'de-DE')}${getActiveLanguage() === 'en' ? '%' : ' %'}`;
const dateLabel = (date: string) => new Date(date).toLocaleDateString(getActiveLanguage() === 'en' ? 'en-US' : 'de-DE');
function RatingChart({ row, onOpen }: { row: TimeControlPerformance; onOpen: (id: string, ply: number) => void }) {
  const { tr } = useI18n();
  const points = row.rating.history.slice(-120);
  if (!points.length) return <p className="statistics-note">{tr('Keine zeitlich zuordenbaren Ratingwerte aus dieser Quelle vorhanden.', 'No dated rating entries available from this source.')}</p>;
  const values = points.map(point => point.rating), min = Math.min(...values) - 15, max = Math.max(...values) + 15;
  const first = Date.parse(points[0].at), span = Date.parse(points.at(-1)!.at) - first;
  const x = (at: string) => span ? 45 + (Date.parse(at) - first) / span * 710 : 400;
  const y = (rating: number) => 130 - (rating - min) / (max - min) * 110;
  return <div className="statistics-rating-chart">
    <p><strong>{tr('Rating aus Partien', 'Rating from Games')}</strong> · {row.rating.samples} {tr('Beobachtungen', 'samples')}{row.rating.history.length > 120 ? tr(' · Verlauf der letzten 120 Werte', ' · latest 120 games') : ''}</p>
    <svg viewBox="0 0 800 160" role="img" aria-label={`Rating ${PLATFORM_LABELS[row.platform]} ${TIME_CONTROL_LABELS[row.timeControl]} ${row.account}`}>
      <title>{tr('Eigene PGN-Ratings vor der jeweiligen Partie. Punkte öffnen die Partie.', 'PGN ratings before each game. Click a point to open the game.')}</title>
      <text x="5" y="25">{max - 15}</text><text x="5" y="135">{min + 15}</text>
      <path d={points.map((point, index) => `${index ? 'L' : 'M'} ${x(point.at)} ${y(point.rating)}`).join(' ')} />
      {points.map(point => <a href="#" key={point.at} aria-label={`${dateLabel(point.at)}, Rating ${point.rating}`} onClick={event => { event.preventDefault(); onOpen(point.gameId, 0); }}>
        <circle cx={x(point.at)} cy={y(point.rating)} r="4"><title>{dateLabel(point.at)} · {point.rating}</title></circle>
      </a>)}
      <text x="45" y="156">{dateLabel(points[0].at)}</text><text x="755" y="156" textAnchor="end">{dateLabel(points.at(-1)!.at)}</text>
    </svg>
  </div>;
}

export const PerformanceStatistics: React.FC<{ overview: PerformanceOverview; openingWindow: number; onOpenGameAt: (id: string, ply: number) => void }> = ({ overview, openingWindow, onOpenGameAt }) => {
  const { tr, lang } = useI18n();
  const [expanded, setExpanded] = useState<string | null>(null);
  const tcLabel = (tc: string) => tc === 'rapid' ? tr('Schnellschach', 'Rapid') : tc === 'daily' ? tr('Tägliches Schach', 'Daily') : tc === 'unknown' ? tr('Unbekannt', 'Unknown') : TIME_CONTROL_LABELS[tc as keyof typeof TIME_CONTROL_LABELS] || tc;
  const platLabel = (p: string) => p === 'other' ? tr('Andere / PGN', 'Other / PGN') : PLATFORM_LABELS[p as keyof typeof PLATFORM_LABELS] || p;
  return <section className="performance-statistics" aria-label={tr('Leistung nach Bedenkzeit', 'Performance by time control')}>
    <AnalysisList title={tr('Deine Spielstatistik', 'Your Performance')} count={overview.rows.length} noun={tr('Bedenkzeiten / Konten', 'time controls / accounts')} description={<>{overview.selectedGames} {tr('gespeicherte Partien', 'saved games')} · {overview.analyzedGames} {tr('vollständig analysiert. Alle Filter gelten auch für die Diagnose darunter.', 'fully analyzed. Active filters also apply to the diagnostics below.')}</>}>
    {!!overview.excludedUndated && <p className="statistics-note">{overview.excludedUndated} {tr('Partien ohne verlässliches Spieldatum sind im gewählten Zeitraum ausgeblendet.', 'games without a reliable date are hidden for this period.')}</p>}
    {!overview.rows.length ? <p className="statistics-empty">{tr('Keine eigenen Partien für diese Auswahl. Wähle einen anderen Zeitraum oder eine andere Plattform.', 'No matching games for this filter. Try another date range or platform.')}</p> : <div className="statistics-table-wrap"><table>
      <thead><tr><th>{tr('Bedenkzeit / Konto', 'Time Control / Account')}</th><th>{tr('Partien & Ergebnisse', 'Games & Results')}</th><th>{tr('Rating aus Partien', 'Rating from Games')}</th><th>{tr('Genauigkeit', 'Accuracy')}</th><th>{tr('Fehler / Partie', 'Mistakes / Game')}</th><th><span className="sr-only">Details</span></th></tr></thead>
      <tbody>{overview.rows.map(row => {
        const open = expanded === row.id;
        const Icon = row.timeControl === 'bullet' || row.timeControl === 'blitz' ? Zap : row.timeControl === 'daily' ? CalendarDays : row.timeControl === 'unknown' ? Hourglass : Timer;
        return <React.Fragment key={row.id}><tr data-performance-row={row.id}>
          <td><div className={'statistics-speed statistics-speed-' + row.timeControl}><Icon size={23} /><div><strong>{tcLabel(row.timeControl)}</strong><small>{platLabel(row.platform)} · {row.account}</small></div></div></td>
          <td><strong>{row.games}</strong><small>{row.wins} {tr('S', 'W')} · {row.losses} {tr('N', 'L')} · {row.draws} {tr('R', 'D')}{row.unfinished ? ` · ${row.unfinished} ${tr('offen', 'unfinished')}` : ''}</small><small>{row.winRate === null ? tr('Keine abgeschlossenen Partien', 'No finished games') : `${percent(row.winRate)} ${tr('Siege', 'wins')}`}</small></td>
          <td><strong>{row.rating.latest ?? '—'}</strong><small className={row.rating.delta === null || !row.rating.delta ? '' : row.rating.delta > 0 ? 'statistics-up' : 'statistics-down'}>{row.rating.ambiguous ? tr('Reihenfolge unklar', 'Order unclear') : row.rating.delta === null ? tr('Kein vergleichbarer Verlauf', 'No comparable trend') : `${row.rating.delta > 0 ? '+' : ''}${row.rating.delta} ${tr('im Zeitraum', 'in period')}`}</small></td>
          <td><strong className={row.accuracy === null ? '' : 'statistics-accuracy'}>{percent(row.accuracy)}</strong><small>{row.analyzedGames} {tr('analysiert', 'analyzed')}</small></td>
          <td><strong>{row.errorsPerGame?.toLocaleString(lang === 'en' ? 'en-US' : 'de-DE') ?? '—'}</strong><small>{row.analyzedGames ? `${row.errors} ${tr('erkannte Fehler', 'detected errors')}` : tr('Noch nicht auswertbar', 'Not yet evaluated')}</small></td>
          <td><button className="statistics-expand" aria-label={`Details ${tcLabel(row.timeControl)} ${platLabel(row.platform)} ${row.account}`} aria-expanded={open} onClick={() => setExpanded(open ? null : row.id)}><ChevronDown size={19} /></button></td>
        </tr>{open && <tr className="statistics-expanded"><td colSpan={6}>
          <div className="statistics-detail-grid"><RatingChart row={row} onOpen={onOpenGameAt} /><div className="statistics-phases">
            {(['opening', 'middlegame', 'endgame'] as const).map(phase => <div key={phase}><span>{phase === 'opening' ? `${tr('Eröffnung · Züge', 'Opening · Moves')} 1–${openingWindow}` : phase === 'middlegame' ? tr('Mittelspiel', 'Middlegame') : tr('Endspiel', 'Endgame')}</span><strong>{percent(row.phases[phase].accuracy)}</strong><small>{row.phases[phase].decisions ? `${tr('Partien', 'Games')}: ${row.phases[phase].games} · ${tr('Entscheidungen', 'Decisions')}: ${row.phases[phase].decisions} · ${tr('Fehler', 'Errors')}: ${row.phases[phase].errors}` : tr('Keine auswertbaren Entscheidungen', 'No evaluable decisions')}</small></div>)}
          </div></div>
          <p className="statistics-note">{tr('Erkannte brillante Züge', 'Brilliant moves')}: {row.brilliantMoves} · {tr('Verpasste Chancen', 'Missed wins')}: {row.missedChances}. {tr('Phasenwerte zählen nur eigene, nicht erzwungene Entscheidungen.', 'Phase metrics count only non-forced personal decisions.')}</p>
        </td></tr>}</React.Fragment>;
      })}</tbody>
    </table></div>}
    <div className="statistics-footnotes"><p>{tr('Rating = eigener Wert vor der letzten zeitlich zuordenbaren Partie mit Ratingangabe; Veränderung = letzte minus erste Beobachtung im gewählten Zeitraum. Plattformen, Konten und Bedenkzeiten bleiben getrennt.', 'Rating = your pre-game PGN rating from the latest dated game; delta = latest minus earliest sample in range. Platforms, accounts, and time controls remain separate.')}</p><p>{tr('Genauigkeit und Fehler basieren nur auf vollständigen Analysen. Fehler umfassen Ungenauigkeiten, gröbere Fehler, Patzer und verpasste Chancen ohne Doppelzählung.', 'Accuracy and error rates rely only on complete analyses. Errors cover inaccuracies, mistakes, blunders, and missed wins without double counting.')}</p></div>
    </AnalysisList>
    <details className="statistics-highlights"><summary>{tr('Erkannte brillante Züge', 'Brilliant moves')} · {overview.brilliantMoves} <span>{tr('Verpasste Chancen', 'Missed wins')} · {overview.missedChances}</span></summary>
      <p className="statistics-note">{tr('Brillante Züge basieren auf bereits vorliegenden Opferprüfungen. Weitere Treffer können nach einer Prüfung im Archiv hinzukommen.', 'Brilliant moves are based on verified sacrifice scans. More can be scanned in the Archive tab.')}</p>
      {!overview.brilliantExamples.length ? <p className="statistics-note">{tr('Keine erkannten brillanten Züge in dieser Auswahl.', 'No brilliant moves found for this selection.')}</p> : <div className="statistics-example-list">{overview.brilliantExamples.map(example => <button className="btn-secondary" key={`${example.gameId}:${example.ply}`} onClick={() => onOpenGameAt(example.gameId, example.ply - 1)}>{example.moveNumber}. {example.san} · {tr('gegen', 'vs')} {example.opponent} · {platLabel(example.platform)}</button>)}</div>}
    </details>
  </section>;
};
