import { Chess } from 'chess.js';
import type { OpeningFocus } from '../types/chess';
import type { ElectronAPI, MultiPvResponse } from '../types/electron';
import { isReliableEvaluation } from './evaluationReliability';
import { MAX_RESPONSE_PLY, catalogResponsePackage, getOpeningRepertoire, openingOwnMoveCount, playOpeningMove, responsePackage, responseRepertoireId, type OpeningRepertoire } from './openingTraining';

type Engine = Pick<ElectronAPI['engine'], 'evaluateFenMultiPv'>;
const epd = (fen: string) => fen.split(' ').slice(0, 4).join(' ');

/** Prepare a fixed learner policy and vary only opponent replies. Stored/catalog
 * packages are immediate. Sparse naming positions get legal, searched full lines
 * instead of one-move drills. Every request carries the complete move history. */
export async function prepareOpeningResponse(focus: OpeningFocus, player: string, engine?: Engine, depth = 14, cancelled = () => false): Promise<OpeningRepertoire> {
  const active = () => { if (cancelled()) throw Error('Vorbereitung abgebrochen.'); };
  active();
  const cached = getOpeningRepertoire(responseRepertoireId(focus), player);
  if (cached) return cached;
  const board = new Chess();
  for (const uci of focus.prefixUci) playOpeningMove(board, uci);
  if (epd(board.fen()) !== epd(focus.anchorFen)) throw Error('Die Trainingsstellung passt nicht zur Zugfolge.');
  const catalog = catalogResponsePackage(focus);
  active();
  if (catalog) return catalog;
  if (!engine) throw Error('Für diesen Aufbau fehlen längere Katalogvarianten. Wähle eine Stockfish-Engine in den Einstellungen, um ein Antwortpaket vorzubereiten.');
  const maxPly = Math.min(MAX_RESPONSE_PLY, Math.max(20, focus.prefixUci.length + 12));
  const search = async (moves: string[], multiPv: number): Promise<MultiPvResponse> => {
    active();
    const position = new Chess();
    for (const uci of moves) playOpeningMove(position, uci);
    const value = await engine.evaluateFenMultiPv(new Chess().fen(), Math.max(12, depth), multiPv, moves, position.fen());
    active();
    if (!isReliableEvaluation(value)) throw Error('Die Engine konnte noch keine belastbaren Antwortvarianten berechnen. Bitte erneut versuchen.');
    return value;
  };
  const rootMoves = [...focus.prefixUci];
  if (board.turn() === focus.color && !board.isGameOver()) {
    const value = await search(rootMoves, 1);
    const uci = value.moves[0]?.uci || value.bestMoveUci;
    playOpeningMove(board, uci);
    rootMoves.push(uci);
  }
  if (board.isGameOver()) throw Error('Diese Stellung ist bereits beendet; hier hilft die konkrete Fehlerposition in der Partieanalyse.');
  const replies = await search(rootMoves, 3);
  const lines: Array<{ name: string; moves: string[] }> = [];
  const policy = new Map<string, string>();
  for (const candidate of replies.moves) {
    active();
    if (!candidate.pv.length || candidate.pv[0] !== candidate.uci) continue;
    const position = new Chess();
    const moves = [...rootMoves];
    for (const uci of rootMoves) playOpeningMove(position, uci);
    let name = '';
    try {
      const append = (pv: string[]) => {
        for (const uci of pv) {
          if (moves.length >= maxPly || position.isGameOver()) break;
          const played = playOpeningMove(position, uci);
          name ||= `Gegnerantwort ${played.san}`;
          moves.push(uci);
        }
      };
      append(candidate.pv);
      for (let extension = 0; extension < 2 && !position.isGameOver() && moves.length < maxPly && openingOwnMoveCount(moves, focus.color) - openingOwnMoveCount(focus.prefixUci, focus.color) < 3; extension++) {
        const extra = await search(moves, 1);
        append(extra.moves[0]?.pv || extra.pv);
      }
      if (!position.isGameOver() && (openingOwnMoveCount(moves, focus.color) < 4 || openingOwnMoveCount(moves, focus.color) - openingOwnMoveCount(focus.prefixUci, focus.color) < 3)) continue;
      const probe = new Chess(), additions = new Map<string, string>();
      for (const uci of moves) {
        if (probe.turn() === focus.color) {
          const key = epd(probe.fen());
          if ((policy.has(key) && policy.get(key) !== uci) || (additions.has(key) && additions.get(key) !== uci)) throw Error('Conflicting response');
          additions.set(key, uci);
        }
        playOpeningMove(probe, uci);
      }
      if (!lines.some(line => line.moves.join(' ') === moves.join(' '))) {
        lines.push({ name, moves });
        additions.forEach((uci, key) => policy.set(key, uci));
      }
    } catch (error) { active(); /* Discard illegal or contradictory search lines. */ }
  }
  if (!lines.length) throw Error('Noch keine vollständigen, konsistenten Antwortvarianten verfügbar. Bitte erneut vorbereiten oder die konkrete Fehlerposition ansehen.');
  return responsePackage(focus, lines, 'engine');
}
