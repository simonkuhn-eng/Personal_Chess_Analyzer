import { Chess } from 'chess.js';
import type { EngineEvalResult, GameAnalysis } from '../types/chess';
import type { ElectronAPI } from '../types/electron';
import type { WhyLine, WhyReason, WhyResult } from '../types/why';
import { isReliableEvaluation } from './evaluationReliability';
import { legalChoices, pieceSubject, playUci, positionDifferences, replayWhy, tacticalReasons, uciOf, whyLine } from './whyEvidence';
import { makeWhySummary, ownValue } from './whyTemplates';

type Engine = Pick<ElectronAPI['engine'], 'evaluateFen' | 'cancelRequest'>;
export interface WhyOptions { alternative?: string; reply?: string; thorough?: boolean; engineKey?: string; refresh?: boolean }
export interface WhyControl { requestId: string; cancelled: () => boolean; progress?: (text: string) => void }
export const WHY_VERSION = 1;
const cache = new Map<string, WhyResult>();
const searchCache = new Map<string, EngineEvalResult>();

export function whyContext(game: GameAnalysis, selectedPly: number) {
  const move = game.moves[selectedPly - 1];
  if (!move || selectedPly < 1) throw Error('Wähle zuerst einen gespielten Zug aus.');
  const startFen = game.moves[0].fenBefore, history = game.moves.slice(0, selectedPly - 1).map(step => step.uci);
  const board = new Chess(startFen); history.forEach(uci => playUci(board, uci));
  if (board.fen() !== move.fenBefore || board.turn() !== move.color) throw Error('Die Stellung passt nicht zur gespeicherten Zuggeschichte. Bitte die Partie neu analysieren.');
  return { move, startFen, history, board, anchorFen: board.fen(), color: board.turn() };
}

/** Bound a question to a small set of relevant alternatives. A manually chosen
 * legal move always takes precedence; it need not be among the engine's Top 3. */
export function whyCandidates(anchor: string, best: string, played: string, chosen?: string): string[] {
  const board = new Chess(anchor), legal = board.moves({ verbose: true });
  const bestMove = legal.find(move => uciOf(move) === best);
  if (!bestMove) return [];
  if (chosen && !legal.some(move => uciOf(move) === chosen)) throw Error('Die ausgewählte Alternative ist hier nicht legal.');
  const sameTarget = legal.filter(move => move.captured && move.to === bestMove.to).sort((a, b) => Number(b.piece === 'p') - Number(a.piece === 'p'));
  const promotions = legal.filter(move => move.promotion && move.from === bestMove.from && move.to === bestMove.to);
  const enemy = board.turn() === 'w' ? 'b' : 'w';
  const retreats = legal.filter(move => [bestMove.from, played.slice(0, 2)].includes(move.from) && !move.captured && !move.promotion && board.isAttacked(move.from, enemy))
    .sort((a, b) => Number(board.isAttacked(a.to, enemy)) - Number(board.isAttacked(b.to, enemy)));
  return [...new Set([chosen, played, ...sameTarget.map(uciOf), ...promotions.map(uciOf), ...retreats.map(uciOf)].filter((value): value is string => !!value && value !== best && legal.some(move => uciOf(move) === value)))].slice(0, 4);
}

function branchReasons(anchor: string, best: WhyLine, reply: WhyLine): WhyReason[] {
  if (!reply.reliable) return [];
  const proof = replayWhy(anchor, [], reply.moves), beforeReply = new Chess(proof.steps[0].after), response = proof.steps[1]?.move;
  if (!response) return [];
  const reasons: WhyReason[] = [];
  const add = (motif: string, title: string, text: string, decisivePly: number, squares: string[]) => reasons.push({ motif, title, text, decisivePly, squares, level: 'branch_checked' as const, lineId: reply.id });
  if (response.captured) {
    const afterReply = new Chess(proof.steps[1].after);
    const decisive = proof.steps.slice(2).find((step, index) => index % 2 === 0 && (step.move.captured || step.move.san.endsWith('#')) &&
      beforeReply.attackers(step.move.to, response.color).includes(response.from) &&
      !afterReply.attackers(step.move.to, response.color).includes(response.to) &&
      !proof.steps.slice(2, index + 2).some(earlier => earlier.move.from === response.to || earlier.move.to === response.to) &&
      !new Chess(step.before).attackers(step.move.to, response.color).includes(response.to));
    if (decisive && (reply.terminal === 'win' || (reply.settled && reply.materialGain > best.materialGain)))
      add(new Chess(anchor).attackers(best.uci.slice(2, 4) as import('chess.js').Square, response.color).includes(response.from) ? 'T12' : 'T10', 'Rückschlag gibt eine Deckung auf', `Nach ${best.san} ist ${response.san} legal. Dabei zieht ${pieceSubject[response.piece]} von ${response.from} weg und gibt die Deckung von ${decisive.move.to} auf. In dieser berechneten Annahmevariante folgt ${decisive.move.san}${reply.terminal === 'win' ? ' mit einer Mattfolge' : ''}.`, proof.steps.indexOf(decisive) + 1, [response.from, response.to, decisive.move.to]);
    if (reply.terminal === 'win') add('T17', 'Die Annahme erlaubt Matt', `Der Gegner kann mit ${response.san} schlagen. In der geprüften Antwortlinie folgt jedoch Matt gegen ihn. Deshalb reicht die Möglichkeit des Rückschlags allein nicht, um ${best.san} zu widerlegen.`, reply.moves.length, [response.to]);
    else if (reply.evaluation && best.evaluation && ownValue(reply.evaluation, proof.color) > ownValue(best.evaluation, proof.color) + 100)
      add('T17', 'Die Annahme hilft dem Gegner nicht', `Der Schlag ${response.san} wurde eigens geprüft. Stockfish bewertet die anschließende Stellung für dich günstiger als seine stärkste Antwort auf ${best.san}. Die Annahme ist also keine Widerlegung.`, Math.min(reply.moves.length, 4), [response.to]);
  }
  return reasons;
}

/** Search only after an explicit user request. Never mutates game analysis or
 * starts a network request; every engine call preserves the complete history. */
export async function explainWhy(game: GameAnalysis, selectedPly: number, engine: Engine, options: WhyOptions, control: WhyControl): Promise<WhyResult> {
  const context = whyContext(game, selectedPly), { board, startFen, history, anchorFen, color, move } = context;
  const depth = options.thorough ? 18 : 14, totalMs = options.thorough ? 45000 : 22000;
  const deadline = Date.now() + totalMs, key = JSON.stringify([WHY_VERSION, startFen, history, move.uci, move.evalBefore.bestMoveUci, options.alternative, options.reply, depth, options.engineKey]);
  const active = () => { if (control.cancelled()) { const error = Error('Erklärung abgebrochen.'); error.name = 'AbortError'; throw error; } };
  active();
  const cached = cache.get(key); if (cached && !options.refresh) return cached;
  const notes: string[] = [];
  const legal = board.moves({ verbose: true });
  if (board.isGameOver() || !legal.length) throw Error('Diese Ausgangsstellung ist bereits beendet.');
  const choices = legalChoices(anchorFen);
  if (legal.length === 1) {
    const best = whyLine(startFen, history, [uciOf(legal[0])], null, 'best', 'Einziger legaler Zug', true);
    return { version: WHY_VERSION, anchorFen, color, best, alternatives: [], replies: [], choices, replyChoices: [], depth: 0, limited: false,
      forced: true, summary: 'Es gab in dieser Stellung genau einen legalen Zug. Du hattest keine andere Entscheidung; deshalb wird hier kein Vergleichsfehler behauptet.', notes: [],
      reasons: [{ motif: 'T25', title: 'Erzwungener Zug', text: 'Alle anderen Züge sind nach den Schachregeln ausgeschlossen.', level: 'board_fact', lineId: best.id, decisivePly: 1, squares: [best.uci.slice(0, 2), best.uci.slice(2, 4)] }] };
  }
  let limited = false;
  const search = async (prefix: string[], allowed?: string[]): Promise<EngineEvalResult | null> => {
    active();
    if (Date.now() >= deadline) { limited = true; return null; }
    const searchKey = JSON.stringify([WHY_VERSION, startFen, history, prefix, allowed, depth, options.engineKey]);
    const previous = searchCache.get(searchKey);
    if (previous && !options.refresh) return previous;
    const probe = new Chess(startFen); [...history, ...prefix].forEach(uci => playUci(probe, uci));
    if (probe.isGameOver()) return null;
    let result: EngineEvalResult | null;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      result = await Promise.race([
        engine.evaluateFen(startFen, depth, [...history, ...prefix], probe.fen(), {
          requestId: control.requestId, maxTimeMs: Math.min(options.thorough ? 6000 : 2500, Math.max(100, deadline - Date.now())), deadlineAt: deadline, searchMoves: allowed,
        }),
        // Queue waiting and engine initialization must also fit the UI budget.
        new Promise<null>(resolve => { deadlineTimer = setTimeout(() => {
          void engine.cancelRequest?.(control.requestId).catch(() => {});
          resolve(null);
        }, Math.max(1, deadline - Date.now())); }),
      ]);
    } catch { active(); limited = true; return null; }
    finally { clearTimeout(deadlineTimer); }
    active();
    if (!result || result.status !== 'complete' || result.bound !== 'exact' || !isReliableEvaluation(result, depth)) { limited = true; return null; }
    if (!result.bestMoveUci || (allowed && !allowed.includes(result.bestMoveUci)) || (result.pv.length && result.pv[0] !== result.bestMoveUci)) { limited = true; return null; }
    try {
      const line = result.pv.length ? result.pv.slice(0, 24) : [result.bestMoveUci];
      if (replayWhy(startFen, [...history, ...prefix], line).steps.length !== line.length) { limited = true; return null; }
    } catch { limited = true; return null; }
    if (searchCache.size >= 160) searchCache.delete(searchCache.keys().next().value!);
    searchCache.set(searchKey, result);
    return result;
  };
  const rootMate = legal.find(candidate => candidate.san.endsWith('#'));
  control.progress?.('Bestzug in der Ausgangsstellung prüfen …');
  const root = rootMate ? null : await search([]);
  if (!rootMate && !root) throw Error('Die Engine hat innerhalb des Zeitbudgets keine ausreichend tiefe, abgeschlossene Vergleichsanalyse geliefert. Prüfe Stockfish oder wähle „Gründlicher prüfen“.');
  const bestUci = rootMate ? uciOf(rootMate) : root!.bestMoveUci;
  if (!choices.some(candidate => candidate.uci === bestUci)) throw Error('Die Engineantwort passt nicht zur Ausgangsstellung.');
  const build = (uci: string, value: EngineEvalResult | null, kind: WhyLine['kind'], label: string) => {
    const moves = value?.pv.length ? value.pv.slice(0, 24) : [uci];
    return whyLine(startFen, history, moves, value, kind, label, !!value || replayWhy(startFen, history, moves).board.isGameOver());
  };
  const best = build(bestUci, root, 'best', 'Empfohlener Zug');
  if (move.evalBefore.bestMoveUci && move.evalBefore.bestMoveUci !== bestUci) notes.push(`Die aktuelle Prüfung bevorzugt ${best.san}. Sie kann von der gespeicherten Analyse und ihrem Pfeil abweichen; deine gespeicherte Zugbewertung wird dadurch nicht verändert.`);
  const candidateUci = whyCandidates(anchorFen, bestUci, move.uci, options.alternative);
  if (!candidateUci.length) {
    const other = legal.filter(candidate => uciOf(candidate) !== bestUci).sort((a, b) => Number(!!b.captured) - Number(!!a.captured) || Number(b.san.includes('+')) - Number(a.san.includes('+'))).slice(0, 12).map(uciOf);
    if (other.length) {
      const value = await search([], other);
      if (value) candidateUci.push(value.bestMoveUci);
    }
  }
  const alternatives: WhyLine[] = [];
  for (const uci of candidateUci) {
    active();
    const candidate = choices.find(choice => choice.uci === uci)!;
    control.progress?.(`${candidate.san} mit dem empfohlenen Zug vergleichen …`);
    const child = replayWhy(startFen, history, [uci]);
    const value = child.board.isGameOver() ? null : await search([], [uci]);
    try { alternatives.push(build(uci, value, uci === move.uci ? 'played' : 'alternative', uci === move.uci ? 'Dein Partiezug' : 'Verglichene Alternative')); }
    catch { limited = true; }
  }
  if (alternatives.some(line => line.reliable && line.evaluation && best.evaluation && ownValue(line.evaluation, color) > ownValue(best.evaluation, color) + 50))
    notes.push('Die Einzelprüfungen ergeben keine stabile Rangfolge. Die Erklärung zeigt deshalb die Unterschiede, ohne einen eindeutig überlegenen Zug zu behaupten.');
  const afterBest = replayWhy(startFen, history, [bestUci]).board;
  const replyChoices = afterBest.isGameOver() ? [] : legalChoices(afterBest.fen());
  if (options.reply && !replyChoices.some(candidate => candidate.uci === options.reply)) throw Error('Die gewählte Gegnerantwort ist auf den aktuell empfohlenen Zug nicht legal. Bitte eine andere Antwort wählen.');
  const recaptures = afterBest.isGameOver() ? [] : afterBest.moves({ verbose: true }).filter(candidate => candidate.captured && candidate.to === bestUci.slice(2, 4))
    .sort((a, b) => Number(b.piece === 'q') - Number(a.piece === 'q'));
  const replyUci = [...new Set([options.reply, ...recaptures.map(uciOf)].filter((uci): uci is string => !!uci))].slice(0, 2);
  const replies: WhyLine[] = [];
  for (const reply of replyUci) {
    active();
    const label = replyChoices.find(choice => choice.uci === reply)!.san;
    control.progress?.(`Einwand prüfen: Was passiert nach ${label}?`);
    const proof = replayWhy(startFen, history, [bestUci, reply]);
    const value = proof.board.isGameOver() ? null : await search([bestUci, reply]);
    try {
      const line = whyLine(startFen, history, [bestUci, reply, ...(value?.pv || []).slice(0, 20)], value, 'reply', `Falls der Gegner ${label} spielt`, !!value || proof.board.isGameOver(), `reply:${bestUci}:${reply}`);
      replies.push(line);
    } catch { limited = true; }
  }
  active();
  const reasons = [
    ...replies.flatMap(reply => branchReasons(anchorFen, best, reply)),
    ...tacticalReasons(anchorFen, best),
    ...alternatives.filter(line => line.reliable && line.terminal === 'loss').flatMap(line => tacticalReasons(anchorFen, line).filter(reason => reason.motif === 'T22')),
    ...alternatives.filter(line => line.reliable && line.materialGain < 0).flatMap(line => tacticalReasons(anchorFen, line).filter(reason => reason.motif === 'T01')),
    ...alternatives.filter(line => line.reliable).flatMap(line => positionDifferences(anchorFen, best, line)),
  ];
  // The source engine/root includes historical draw rights; structural detectors
  // use FEN only and must never manufacture repetition claims.
  if (limited) notes.push('Einige Vergleiche erreichten das Suchziel im Zeitbudget nicht. Dazu werden keine sicheren Unterschiede behauptet.');
  if (best.moves.length < 3 && !best.terminal) notes.push('Die verfügbare Hauptvariante ist kurz. Langfristige Gründe sind damit nicht abschließend erklärt.');
  const result: WhyResult = { version: WHY_VERSION, anchorFen, color, best, alternatives, replies, reasons, summary: '', notes,
    choices, replyChoices, forced: false, depth, limited };
  result.summary = makeWhySummary(result, options.alternative || move.uci);
  if (!limited && !notes.some(note => note.includes('Rangfolge'))) {
    if (cache.size >= 40) cache.delete(cache.keys().next().value!);
    cache.set(key, result);
  }
  return result;
}
