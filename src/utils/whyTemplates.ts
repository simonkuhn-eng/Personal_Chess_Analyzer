import type { EngineEvalResult } from '../types/chess';
import type { WhyLine, WhyResult } from '../types/why';
import { formatEval } from './analysis';

export function ownValue(value: EngineEvalResult, color: 'w' | 'b'): number {
  const sign = color === 'w' ? 1 : -1;
  if (value.mate !== undefined && value.mate !== 0) {
    const mate = value.mate * sign;
    return mate > 0 ? 100000 - mate * 100 : -100000 - mate * 100;
  }
  return value.scoreCp * sign;
}

export function whyScore(line: WhyLine, color: 'w' | 'b') {
  if (!line.reliable) return 'Noch nicht belastbar';
  if (line.terminal && !line.evaluation) return line.terminal === 'win' ? 'Matt für dich' : line.terminal === 'loss' ? 'Matt gegen dich' : 'Remis';
  if (!line.evaluation) return '—';
  const sign = color === 'w' ? 1 : -1;
  return formatEval(line.evaluation.scoreCp * sign, line.evaluation.mate === undefined ? undefined : line.evaluation.mate * sign);
}

export function compareWhyLine(best: WhyLine, other: WhyLine, color: 'w' | 'b'): string {
  if (!other.reliable) return `${other.san} konnte im Zeitbudget noch nicht verlässlich verglichen werden.`;
  if (best.terminal === 'win' && best.moves.length === 1 && other.terminal !== 'win') return `${best.san} setzt sofort matt. ${other.san} beendet die Partie nicht sofort mit Matt.`;
  if (!best.evaluation || !other.evaluation) return `Die Varianten zeigen die unterschiedlichen Folgen von ${best.san} und ${other.san}.`;
  const a = ownValue(best.evaluation, color), b = ownValue(other.evaluation, color);
  if (a < b - 50) return `Die aktuelle Einzelprüfung von ${other.san} fällt günstiger aus. Die Rangfolge ist noch nicht stabil; ein eindeutiges „Warum nur dieser Zug?“ wäre hier voreilig.`;
  if (best.evaluation.mate !== undefined || other.evaluation.mate !== undefined) return `${best.san} ergibt aus deiner Sicht ${whyScore(best, color)}, ${other.san} dagegen ${whyScore(other, color)}. Die Mattangaben stammen aus den jeweiligen Suchvarianten.`;
  if (Math.abs(a - b) <= 50) return `${best.san} und ${other.san} liegen in dieser Suche nahe beieinander. ${other.san} wird hier nicht als klarer Fehler dargestellt.`;
  return `${best.san} wird aus deiner Sicht mit ${whyScore(best, color)} bewertet, ${other.san} mit ${whyScore(other, color)}. Das sind Stellungsbewertungen in Bauerneinheiten, keine zusätzlich gewonnenen Figuren.`;
}

export function makeWhySummary(result: WhyResult, played: string): string {
  const other = result.alternatives.find(line => line.uci === played && line.reliable) || result.alternatives.find(line => line.reliable);
  const comparison = other ? compareWhyLine(result.best, other, result.color) : `${result.best.san} ist die aktuell empfohlene Möglichkeit.`;
  const concrete = result.reasons.find(reason => ['T12', 'T17', 'T22', 'T09', 'T04', 'T08', 'T16', 'T01', 'T03', 'T02'].includes(reason.motif));
  return concrete ? `${comparison} ${concrete.text}` : `${comparison} Die Stellung hat keinen hier sicher erkannten einfachen taktischen Hauptgrund. Die berechneten Varianten und Strukturunterschiede helfen beim Vergleich.`;
}
