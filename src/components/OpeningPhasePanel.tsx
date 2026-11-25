import React, { useState } from 'react';
import type { OpeningFocus, OpeningPhaseStats } from '../types/chess';
import { AnalysisList } from './AnalysisList';
import { useI18n } from '../utils/i18n';

interface Props {
  rows: OpeningPhaseStats[];
  windowMoves: number;
  onWindowChange: (moves: number) => Promise<void> | void;
  onErrors: (focus: OpeningFocus, moves: number) => void;
  onResponses: (focus: OpeningFocus) => void;
  onOpenGameAt: (gameId: string, ply: number) => void;
}

export const OpeningPhasePanel: React.FC<Props> = ({ rows, windowMoves, onWindowChange, onErrors, onResponses, onOpenGameAt }) => {
  const { tr } = useI18n();
  const [query, setQuery] = useState('');
  const [color, setColor] = useState('all');
  const [order, setOrder] = useState('frequent');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filtered = rows.filter(row => (color === 'all' || row.color === color) && `${row.name} ${row.eco || ''} ${row.positionLabel}`.toLowerCase().includes(query.toLowerCase()));
  const visible = [...filtered].sort((a, b) => order === 'frequent' ? b.games - a.games || b.gamesWithErrors - a.gamesWithErrors :
    Number(b.games >= 5) - Number(a.games >= 5) || (a.games >= 5 && b.games >= 5 ? b.gamesWithErrors / b.games - a.gamesWithErrors / a.games : b.games - a.games) || b.games - a.games);
  const changeWindow = async (value: number) => {
    setSaving(true); setError(null);
    try { await onWindowChange(value); }
    catch { setError('Das Auswertungsfenster konnte nicht gespeichert werden.'); }
    finally { setSaving(false); }
  };
  return <section className="opening-phase-panel" aria-label={tr('Eröffnungsqualität', 'Opening quality')}>
    <div className="opening-phase-heading"><div><h3>{tr('Deine Eröffnungsphase', 'Your Opening Phase')}</h3><p>{tr(`Nur deine eigenen Züge 1–${windowMoves}. Spätere Fehler und die Gesamtgenauigkeit der Partie zählen hier nicht.`, `Counts only your own moves 1–${windowMoves}. Later mistakes and full-game accuracy are tracked separately.`)}</p></div>
      <label>{tr('Auswerten bis Zug', 'Analyze up to move')} <select aria-label={tr('Eröffnungsphase bis Zug', 'Opening phase move window')} value={windowMoves} disabled={saving} onChange={event => void changeWindow(Number(event.target.value))}>
        {[8, 10, 12, 15, 20].map(value => <option key={value} value={value}>{value}</option>)}
      </select></label></div>
    <AnalysisList title={tr('Aufbauten und Varianten', 'Openings & Variations')} count={rows.length} noun={tr('Aufbauten', 'openings')}>
    <p className="opening-phase-note">{tr('Das Zugfenster ist eine praktische Grenze. Das Verlassen des Eröffnungsbuchs allein ist kein Fehler. Fehlerquote umfasst Ungenauigkeiten, gröbere Fehler, Patzer und verpasste Chancen; erzwungene Züge werden ausgelassen.', 'Leaving book alone is not treated as an error. Error rate covers inaccuracies, mistakes, blunders, and missed wins while skipping forced moves.')}</p>
    <div className="opening-phase-controls">
      <input aria-label={tr('Eröffnungsaufbau suchen', 'Search opening')} placeholder={tr('Aufbau oder Variante suchen', 'Search opening or variation')} value={query} onChange={event => setQuery(event.target.value)} />
      <select aria-label={tr('Spielseite filtern', 'Filter side')} value={color} onChange={event => setColor(event.target.value)}><option value="all">{tr('Beide Spielseiten', 'Both colors')}</option><option value="w">{tr('Mit Weiß', 'As White')}</option><option value="b">{tr('Mit Schwarz', 'As Black')}</option></select>
      <select aria-label={tr('Eröffnungsstatistik sortieren', 'Sort opening stats')} value={order} onChange={event => setOrder(event.target.value)}><option value="frequent">{tr('Häufigste zuerst', 'Most frequent first')}</option><option value="errors">{tr('Fehlerquote · ab 5 Partien', 'Error rate · 5+ games')}</option></select>
    </div>
    {error && <p role="alert">{error}</p>}
    {!visible.length ? <p className="opening-phase-note">{tr('Keine passenden eigenen Eröffnungsdaten. Benötigt werden vollständig analysierte Standardpartien aus der Grundstellung.', 'No matching opening data yet. Requires completely analyzed standard games from the starting position.')}</p> : <div className="opening-phase-table-wrap"><table>
      <thead><tr><th>{tr('Aufbau / Variante', 'Opening / Variation')}</th><th>{tr('Du spielst', 'Color')}</th><th>{tr('Partien', 'Games')}</th><th>{tr('Mit Eröffnungsfehlern', 'Games with Errors')}</th><th>{tr('Eröffnungsgenauigkeit', 'Opening Accuracy')}</th><th>{tr('Gezielt üben', 'Practice')}</th></tr></thead>
      <tbody>{visible.map(row => <tr key={row.id} data-opening-focus={row.id}>
        <td><strong>{row.name}</strong><small>{row.positionLabel}</small>
          <small className="opening-phase-confidence">{row.games === 1 ? tr('Einzelbeobachtung', 'Single game') : row.games < 5 ? tr('Wenige Partien · noch keine gesicherte Schwachstelle', 'Small sample · not enough games yet') : `${tr('Basis:', 'Sample:')} ${row.games} ${tr('Partien', 'games')}`}</small>
          {!!row.examples.length && <details><summary>{tr('Beispielzüge ansehen', 'View sample moves')}</summary>{row.examples.map(example => <button className="opening-phase-example" key={`${example.gameId}:${example.ply}`} onClick={() => onOpenGameAt(example.gameId, example.ply - 1)}>{example.moveNumber}. {example.san} · {tr('Stellung davor öffnen', 'Open position')}</button>)}</details>}
        </td>
        <td>{row.color === 'w' ? tr('Weiß', 'White') : tr('Schwarz', 'Black')}</td><td>{row.games}</td>
        <td title={`${row.inaccuracies} / ${row.mistakes} / ${row.blunders} / ${row.misses}`}><strong>{row.gamesWithErrors}/{row.games} · {Math.round(row.gamesWithErrors / row.games * 100)} %</strong><small>{row.errors} {tr('Fehler im Zugfenster', 'errors in window')}</small></td>
        <td>{row.avgAccuracy === null ? '—' : `${row.avgAccuracy} %`}<small>{row.decisions} {tr('eigene Entscheidungen', 'player decisions')}</small></td>
        <td><div className="opening-phase-actions"><button className="btn-secondary" disabled={!row.errors} onClick={() => onErrors(row, windowMoves)}>{tr('Eröffnungsfehler ansehen', 'Review opening errors')}</button><button className="btn-primary" onClick={() => onResponses(row)}>{tr('Antworten trainieren', 'Train responses')}</button></div></td>
      </tr>)}</tbody>
    </table></div>}
    </AnalysisList>
  </section>;
};
