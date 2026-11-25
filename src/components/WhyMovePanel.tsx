import React, { useEffect, useMemo, useState } from 'react';
import { HelpCircle, X, Play, RefreshCcw, MousePointer2 } from 'lucide-react';
import type { GameAnalysis } from '../types/chess';
import type { WhyLine, WhyReason, WhyResult } from '../types/why';
import { explainWhy, whyContext } from '../utils/whyComparison';
import { legalChoices } from '../utils/whyEvidence';
import { compareWhyLine, whyScore } from '../utils/whyTemplates';
import { principalVariationSan } from '../utils/reviewPresentation';

interface Props {
  game: GameAnalysis;
  ply: number;
  engineKey: string;
  choosing: boolean;
  onClose: () => void;
  onShowLine: (moves: string[], label: string, cursor?: number) => void;
  onPick: (receive: (uci: string) => void) => void;
  onCancelPick: () => void;
  onBusyChange: (busy: boolean) => void;
}
const evidenceLabel: Record<WhyReason['level'], string> = { board_fact: 'Am Brett geprüft', searched_line: 'In dieser Enginevariante', branch_checked: 'Gegnerantwort geprüft', positional_observation: 'Stellungsbeobachtung' };

export function WhyMovePanel({ game, ply, engineKey, choosing, onClose, onShowLine, onPick, onCancelPick, onBusyChange }: Props) {
  const move = game.moves[ply - 1];
  const [alternative, setAlternative] = useState('');
  const [reply, setReply] = useState('');
  const [thorough, setThorough] = useState(false);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<WhyResult | null>(null);
  const [busy, setBusy] = useState(true);
  const [progress, setProgress] = useState('Vergleich wird vorbereitet …');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  const choices = useMemo(() => { try { return legalChoices(whyContext(game, ply).anchorFen); } catch { return []; } }, [game, ply]);
  useEffect(() => {
    let cancelled = false;
    const engine = window.electronAPI?.engine, requestId = 'why-' + crypto.randomUUID();
    setBusy(true); setError(null); setResult(null);
    if (!engine) { setError('Diese Erklärung benötigt die Desktop-App mit Stockfish.'); setBusy(false); return; }
    void explainWhy(game, ply, engine, { alternative: alternative || undefined, reply: reply || undefined, thorough, engineKey, refresh: retry > 0 },
      { requestId, cancelled: () => cancelled, progress: text => { if (!cancelled) setProgress(text); } }).then(value => {
        if (!cancelled) setResult(value);
      }).catch(reason => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Die Erklärung konnte noch nicht berechnet werden.');
      }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; void engine.cancelRequest?.(requestId).catch(() => {}); };
  }, [game, ply, alternative, reply, thorough, engineKey, retry]);
  const chooseAlternative = (uci: string) => { setRetry(0); setReply(''); setAlternative(uci); };
  const lineMap = useMemo(() => new Map(result ? [result.best, ...result.alternatives, ...result.replies].map(line => [line.id, line]) : []), [result]);
  const uniqueReasons = result?.reasons.filter((reason, index, all) => all.findIndex(other => other.motif === reason.motif && other.text === reason.text) === index) || [];
  const important = [...uniqueReasons.filter(reason => reason.level !== 'positional_observation' && !(reason.motif === 'T17' && uniqueReasons.some(other => other.lineId === reason.lineId && ['T10', 'T12'].includes(other.motif)))).slice(0, 2), ...uniqueReasons.filter(reason => reason.motif === 'P01').slice(0, 1)];
  if (!important.length) important.push(...uniqueReasons.slice(0, 2));
  const more = uniqueReasons.filter(reason => !important.includes(reason));
  const showReason = (reason: WhyReason) => {
    const line = lineMap.get(reason.lineId);
    if (line) onShowLine(line.moves, reason.title, reason.decisivePly);
  };
  const renderReason = (reason: WhyReason) => <article className="why-reason" key={reason.motif + reason.text} data-motif={reason.motif}>
    <small>{evidenceLabel[reason.level]}</small><strong>{reason.title}</strong><p>{reason.text}</p>
    <button className="why-text-button" onClick={() => showReason(reason)}>Entscheidenden Moment zeigen</button>
  </article>;
  const renderLine = (line: WhyLine) => <details className="why-line" key={line.id} data-why-line={line.kind}>
    <summary><span>{line.label}: {line.kind === 'reply' ? '' : line.san}</span><strong>{result && whyScore(line, result.color)}</strong></summary>
    {result && line.kind !== 'best' && line.kind !== 'reply' && <p>{compareWhyLine(result.best, line, result.color)}</p>}
    <div className="why-pv">{principalVariationSan(move.fenBefore, line.moves).join(' · ')}</div>
    <p className="why-subtle">{line.kind === 'reply' ? 'Bewertung nach dieser ausdrücklich geprüften Gegnerantwort.' : 'Bewertung ab der gemeinsamen Ausgangsstellung.'}</p>
    <button className="btn-secondary" onClick={() => onShowLine(line.moves, line.label)}><Play size={13} /> Auf dem Brett durchspielen</button>
  </details>;
  return <section className="why-panel" aria-label="Warum dieser Zug?">
    <header><div><h2><HelpCircle size={19} /> Warum dieser Zug?</h2><p>{move.moveNumber}{move.color === 'b' ? '...' : '.'} {move.san} · Sicht von {move.color === 'w' ? 'Weiß' : 'Schwarz'}</p></div><button className="btn-icon" aria-label="Erklärung schließen" onClick={onClose}><X size={18} /></button></header>
    <div className="why-panel-body">
      <p className="why-subtle">Verglichen wird die Stellung vor diesem Zug. Positive Werte bedeuten Vorteil für die gerade ziehende Seite.</p>
      <label className="why-control">Welche Alternative möchtest du verstehen?
        <select aria-label="Zug für Warum-Vergleich" value={alternative} onChange={event => chooseAlternative(event.target.value)}><option value="">Partiezug und naheliegende Alternativen</option>{choices.map(choice => <option key={choice.uci} value={choice.uci}>{choice.label}</option>)}</select>
      </label>
      <button className="btn-secondary why-pick" onClick={() => choosing ? onCancelPick() : onPick(chooseAlternative)}><MousePointer2 size={14} /> {choosing ? 'Auswahl abbrechen' : 'Alternative auf dem Brett wählen'}</button>
      {choosing && <p className="why-picker-note" role="status">Das Brett zeigt die Stellung davor. Ziehe jetzt deine Alternative; die gespeicherte Partie bleibt erhalten.</p>}
      {busy && <div className="why-loading" role="status"><span className="spin-dot" /> {progress}<button className="why-text-button" onClick={onClose}>Abbrechen</button></div>}
      {error && <div className="why-error" role="alert"><p>{error}</p><button className="btn-secondary" onClick={() => setRetry(value => value + 1)}><RefreshCcw size={13} /> Erneut versuchen</button><button className="why-text-button" onClick={() => { setAlternative(''); setReply(''); setRetry(value => value + 1); }}>Auswahl zurücksetzen</button></div>}
      {result && <>
        <div className="why-summary"><strong>{result.forced ? 'Keine freie Entscheidung' : `Empfehlung: ${result.best.san}`}</strong><p>{result.summary}</p></div>
        <div className="why-reasons">{important.slice(0, 3).map(renderReason)}</div>
        {more.length > 0 && <details className="why-more"><summary>Weitere Beobachtungen ({more.length})</summary>{more.map(renderReason)}</details>}
        <div className="why-lines" aria-label="Vergleichsvarianten">{[result.best, ...result.alternatives, ...result.replies].map(renderLine)}</div>
        {!!result.replyChoices.length && <label className="why-control">Was, wenn der Gegner anders antwortet?
          <select aria-label="Gegnerantwort für Warum-Vergleich" value={reply} onChange={event => { setRetry(0); setReply(event.target.value); }}><option value="">Naheliegende Rückschläge prüfen</option>{result.replyChoices.map(choice => <option key={choice.uci} value={choice.uci}>{choice.label}</option>)}</select>
        </label>}
        {result.notes.map(note => <p className="why-note" key={note}>{note}</p>)}
        <p className="why-subtle">{result.depth ? `Vergleichsziel: Tiefe ${result.depth}. ` : ''}Konkrete Varianten und Stellungsbeobachtungen sind getrennt. Langfristige Pläne können offenbleiben.</p>
      </>}
      {!thorough || error || result?.limited ? <button className="btn-secondary why-thorough" disabled={busy && thorough} onClick={() => { if (thorough) setRetry(value => value + 1); else setThorough(true); }}><RefreshCcw size={14} /> Gründlicher prüfen</button> : null}
    </div>
  </section>;
}
