import type { GameAnalysis, OpeningFocus, OpeningPhaseStats } from '../types/chess';
import { calculateMoveAccuracy, moveCategory } from './analysis';
import { epdOf, getBookOpening, isKnownBookPosition } from './openingBook';
import { isReliableGame, isReliableGameMove } from './evaluationReliability';
import { resolvePlayerColor } from './moveInsights';

const START_EPD = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
export const normalizeOpeningWindow = (value = 12) => [8, 10, 12, 15, 20].includes(value) ? value : 12;

/** Identity comes from the reached position and learner's color, never a PGN
 * label from the end of the game. Include the opponent's first book deviation,
 * but do not encode the learner's own first bad deviation as a required reply. */
export function openingFocusForGame(game: GameAnalysis, color: 'w' | 'b', windowMoves = 12): OpeningFocus | null {
  if (!game.moves.length || epdOf(game.moves[0].fenBefore) !== START_EPD) return null;
  const early = game.moves.filter(move => move.moveNumber <= normalizeOpeningWindow(windowMoves));
  if (!early.length) return null;
  let anchor = -1;
  let hit: { eco: string; name: string } | null = null;
  let deviation = false;
  for (let i = 0; i < early.length; i++) {
    const move = early[i];
    if (!isKnownBookPosition(move.fenAfter)) {
      anchor = move.color !== color ? i : i - 1;
      deviation = move.color !== color;
      break;
    }
    const named = getBookOpening(move.fenAfter);
    if (named) { hit = named; anchor = i; }
  }
  // If no naming position exists, retain the actual first opponent setup.
  if (anchor < 0 && !hit && early[0].color !== color) anchor = 0;
  const prefix = early.slice(0, anchor + 1);
  const fen = prefix.at(-1)?.fenAfter || game.moves[0].fenBefore;
  const name = hit?.name || (prefix.length ? 'Unbekannter Aufbau' : 'Startaufstellung');
  const tail = prefix.slice(-4).map(move => `${move.moveNumber}${move.color === 'w' ? '.' : '...'}${move.san}`).join(' ');
  return { id: `${color}:${epdOf(fen)}`, name, eco: hit?.eco, color, anchorFen: fen,
    prefixUci: prefix.map(move => move.uci), positionLabel: `${deviation ? 'Gegnerabweichung: ' : 'Nach '}${tail || 'Partiebeginn'}` };
}

export function matchesOpeningFocus(game: GameAnalysis, color: 'w' | 'b', focus: OpeningFocus, windowMoves = 12): boolean {
  return color === focus.color && openingFocusForGame(game, color, windowMoves)?.id === focus.id;
}

/** Only own, reliable opening decisions. Full-game errors and accuracy never
 * enter these aggregates. Keep zero-error groups as positive evidence too. */
export function buildOpeningPhaseStats(games: GameAnalysis[], player: string, windowMoves = 12): OpeningPhaseStats[] {
  const limit = normalizeOpeningWindow(windowMoves);
  const groups = new Map<string, OpeningPhaseStats & { accuracySum: number; accuracyGames: number; chanceSum: number }>();
  for (const game of games) {
    const color = resolvePlayerColor(game.white, game.black, player, game.site);
    if (!color || !isReliableGame(game)) continue;
    const focus = openingFocusForGame(game, color, limit);
    if (!focus) continue;
    let row = groups.get(focus.id);
    if (!row) {
      row = { ...focus, games: 0, gamesWithErrors: 0, errors: 0, inaccuracies: 0, mistakes: 0, blunders: 0, misses: 0,
        avgAccuracy: null, avgChanceLoss: 0, decisions: 0, examples: [], accuracySum: 0, accuracyGames: 0, chanceSum: 0 };
      groups.set(focus.id, row);
    }
    row.games++;
    let gameAccuracy = 0, decisions = 0, errors = 0;
    for (const move of game.moves) {
      if (move.color !== color || move.moveNumber > limit || move.isForced || !isReliableGameMove(game, move)) continue;
      decisions++;
      gameAccuracy += calculateMoveAccuracy(move.winChanceDrop);
      row.chanceSum += move.winChanceDrop;
      const category = moveCategory(move);
      if (!['inaccuracy', 'mistake', 'blunder', 'miss'].includes(category)) continue;
      errors++;
      if (category === 'inaccuracy') row.inaccuracies++;
      if (category === 'mistake') row.mistakes++;
      if (category === 'blunder') row.blunders++;
      if (category === 'miss') row.misses++;
      row.examples.push({ gameId: game.id, ply: move.ply, san: move.san, moveNumber: move.moveNumber, quality: category, winChanceDrop: move.winChanceDrop });
    }
    row.errors += errors;
    if (errors) row.gamesWithErrors++;
    row.decisions += decisions;
    if (decisions) { row.accuracySum += gameAccuracy / decisions; row.accuracyGames++; }
  }
  return [...groups.values()].map(({ accuracySum, accuracyGames, chanceSum, ...row }) => ({ ...row,
    avgAccuracy: accuracyGames ? Math.round(accuracySum / accuracyGames * 10) / 10 : null,
    avgChanceLoss: row.decisions ? Math.round(chanceSum / row.decisions * 10) / 10 : 0,
    examples: row.examples.sort((a, b) => b.winChanceDrop - a.winChanceDrop).slice(0, 5),
  })).sort((a, b) => b.games - a.games || b.gamesWithErrors - a.gamesWithErrors || a.name.localeCompare(b.name));
}
