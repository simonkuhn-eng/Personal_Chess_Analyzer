import { Chess, type Move, type Square } from 'chess.js';
import type { EngineEvalResult } from '../types/chess';
import type { WhyChoice, WhyLine, WhyReason } from '../types/why';
import { materialBalance, MATERIAL_VALUES } from './lineEvidence';

export const pieceName: Record<string, string> = { p: 'Bauer', n: 'Springer', b: 'Läufer', r: 'Turm', q: 'Dame', k: 'König' };
export const pieceSubject: Record<string, string> = { p: 'der Bauer', n: 'der Springer', b: 'der Läufer', r: 'der Turm', q: 'die Dame', k: 'der König' };
const pieceObject: Record<string, string> = { p: 'den Bauern', n: 'den Springer', b: 'den Läufer', r: 'den Turm', q: 'die Dame', k: 'den König' };
export const uciOf = (move: Move) => move.from + move.to + (move.promotion || '');
export const playUci = (board: Chess, uci: string) => board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
export const epd = (fen: string) => fen.split(' ').slice(0, 4).join(' ');

export function replayWhy(startFen: string, history: readonly string[], line: readonly string[]) {
  const board = new Chess(startFen);
  for (const uci of history) playUci(board, uci);
  const anchorFen = board.fen(), initialMaterial = materialBalance(board, board.turn()), color = board.turn();
  const steps: Array<{ move: Move; before: string; after: string }> = [];
  for (const uci of line) {
    if (board.isGameOver()) break;
    const before = board.fen(), move = playUci(board, uci);
    steps.push({ move, before, after: board.fen() });
  }
  return { board, anchorFen, color, steps, gain: materialBalance(board, color) - initialMaterial };
}

/** Any legal capture or check at the endpoint leaves the continuation unresolved.
 * This conservative flag is only a presentation qualifier, not a game proof. */
export function quietEndpoint(board: Chess): boolean {
  return board.isGameOver() || (!board.isCheck() && !board.moves({ verbose: true }).some(move => move.captured || move.promotion || /[+#]/.test(move.san)));
}

export function whyLine(startFen: string, history: string[], moves: string[], evaluation: EngineEvalResult | null,
  kind: WhyLine['kind'], label: string, reliable: boolean, id = moves.join('.')): WhyLine {
  const proof = replayWhy(startFen, history, moves), first = proof.steps[0]?.move;
  if (!first || proof.steps.length !== moves.length) throw Error('Die Enginevariante ist nicht vollständig legal.');
  return { id, uci: uciOf(first), san: first.san, kind, label, moves, evaluation, reliable,
    materialGain: proof.gain, settled: quietEndpoint(proof.board), terminal: proof.board.isCheckmate() ? proof.board.turn() === proof.color ? 'loss' : 'win' : proof.board.isDraw() ? 'draw' : null,
    endFen: proof.board.fen() };
}

export function legalChoices(fen: string): WhyChoice[] {
  return new Chess(fen).moves({ verbose: true }).map(move => ({ uci: uciOf(move), san: move.san,
    label: `${move.san} · ${pieceName[move.piece]} ${move.from}${move.captured ? ' schlägt ' : ' nach '}${move.to}${move.promotion ? ` → ${pieceName[move.promotion]}` : ''}` }));
}

function rays(square: string) {
  const file = square.charCodeAt(0) - 97, rank = Number(square[1]) - 1;
  return [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]].map(([dx, dy]) => {
    const result: Square[] = [];
    for (let x = file + dx, y = rank + dy; x >= 0 && x < 8 && y >= 0 && y < 8; x += dx, y += dy) result.push((String.fromCharCode(97 + x) + (y + 1)) as Square);
    return result;
  });
}

export function sliderPins(board: Chess, color: 'w' | 'b') {
  const result: Array<{ attacker: string; pinned: string; behind: string; absolute: boolean }> = [];
  for (const square of board.board().flat()) {
    if (!square || square.color !== color || !['b', 'r', 'q'].includes(square.type)) continue;
    for (const ray of rays(square.square)) {
      const diagonal = ray[0] && ray[0][0] !== square.square[0] && ray[0][1] !== square.square[1];
      if ((diagonal && square.type === 'r') || (!diagonal && square.type === 'b')) continue;
      const occupied = ray.filter(target => board.get(target));
      if (occupied.length < 2) continue;
      const a = board.get(occupied[0])!, b = board.get(occupied[1])!;
      if (a.color === color || b.color === color) continue;
      if (b.type === 'k' || MATERIAL_VALUES[b.type] > MATERIAL_VALUES[a.type]) result.push({ attacker: square.square, pinned: occupied[0], behind: occupied[1], absolute: b.type === 'k' });
    }
  }
  return result;
}

export function tacticalReasons(anchor: string, line: WhyLine): WhyReason[] {
  const proof = replayWhy(anchor, [], line.moves), { steps, color } = proof;
  const before = new Chess(anchor), after = new Chess(steps[0].after), first = steps[0].move;
  const enemy = color === 'w' ? 'b' : 'w', reasons: WhyReason[] = [];
  const add = (motif: string, title: string, text: string, decisivePly = 1, squares: string[] = [], level: WhyReason['level'] = 'board_fact') =>
    reasons.push({ motif, title, text, decisivePly, squares, level, lineId: line.id });
  if (line.terminal === 'win') add('T22', 'Mattfolge', `Die gezeigte Fortsetzung endet nach ${steps.length} Halbzügen mit Matt für den Gegner.`, steps.length, [proof.steps.at(-1)!.move.to], 'searched_line');
  if (line.terminal === 'draw') add('T24', 'Remisressource', proof.board.isStalemate() ? 'Die gezeigte Fortsetzung endet mit Patt: Der Gegner hat keinen legalen Zug und steht nicht im Schach.' : 'Die gezeigte Fortsetzung erreicht eine regelbedingte Remisstellung.', steps.length, [], 'searched_line');
  if (line.terminal === 'loss') add('T22', 'Matt gegen dich', `Nach ${first.san} endet diese berechnete Fortsetzung mit Matt gegen die gerade ziehende Seite.`, steps.length, [], 'searched_line');
  if (line.materialGain && line.moves.length > 1) add('T01', 'Bilanz der Abwicklung', `Nach ${first.san} beträgt die Materialveränderung bis zum Ende dieser ${steps.length} Halbzüge aus deiner Sicht ${line.materialGain > 0 ? '+' : ''}${line.materialGain} Punkte.${line.settled ? '' : ' Weitere taktische Fortsetzungen sind möglich; das ist eine Zwischenbilanz.'}`, steps.length, [], 'searched_line');
  const targets = after.board().flat().filter(piece => piece && piece.color === enemy && piece.type !== 'p' &&
    (piece.type === 'k' || MATERIAL_VALUES[piece.type] >= MATERIAL_VALUES[first.piece]) && after.attackers(piece.square, color).includes(first.to));
  if (targets.length >= 2) add('T04', 'Doppelangriff', `${pieceName[first.piece]} auf ${first.to} greift zugleich ${targets.map(piece => `${pieceName[piece!.type]} auf ${piece!.square}`).join(' und ')} an. Ob daraus Material entsteht, zeigt die Fortsetzung.`, 1, targets.map(piece => piece!.square));
  const enemyKing = after.board().flat().find(piece => piece?.color === enemy && piece.type === 'k');
  if (enemyKing) {
    const checkers = after.attackers(enemyKing.square, color);
    if (checkers.length >= 2) add('T07', 'Doppelschach', `Der König auf ${enemyKing.square} steht durch ${checkers.join(' und ')} gleichzeitig im Schach. Nur ein Königszug kann dieses Doppelschach beantworten.`, 1, checkers);
    else if (checkers.length && !checkers.includes(first.to) && before.get(checkers[0])?.color === color && before.get(checkers[0])?.type === after.get(checkers[0])?.type) add('T07', 'Abzugsschach', `Der Zug räumt ${first.from}; dadurch gibt die Figur auf ${checkers[0]} Schach.`, 1, [first.from, checkers[0]]);
  }
  const attacked = before.board().flat().filter(piece => piece && piece.color === enemy && piece.type !== 'k' &&
    after.get(piece.square)?.type === piece.type && after.get(piece.square)?.color === enemy && after.attackers(piece.square, color).some(attacker => attacker !== first.to && before.get(attacker)?.color === color && before.get(attacker)?.type === after.get(attacker)?.type && !before.attackers(piece.square, color).includes(attacker)));
  if (attacked.length) add('T07', 'Neue Angriffslinie', `Nach dem Räumen von ${first.from} erreicht eine andere eigene Figur ${attacked.map(piece => `${pieceName[piece!.type]} auf ${piece!.square}`).join(', ')}.`, 1, [first.from, ...attacked.map(piece => piece!.square)]);
  for (const pin of sliderPins(after, color).filter(pin => !sliderPins(before, color).some(old => old.attacker === pin.attacker && old.pinned === pin.pinned)).slice(0, 1))
    add('T05', pin.absolute ? 'Fesselung an den König' : 'Relative Fesselung', `Die Figur auf ${pin.pinned} steht zwischen ${pieceName[after.get(pin.attacker as Square)!.type]} auf ${pin.attacker} und ${pieceName[after.get(pin.behind as Square)!.type]} auf ${pin.behind}.${pin.absolute ? ' Sie darf den König durch einen Zug nicht ins Schach stellen.' : ' Sie darf wegziehen; der mögliche Verlust dahinter muss konkret berechnet werden.'}`, 1, [pin.attacker, pin.pinned, pin.behind]);
  if (before.isAttacked(first.from, enemy) && (first.captured || first.san.includes('+')))
    add('T16', 'Aktive Antwort auf den Angriff', `Dein${first.piece === 'q' ? 'e' : ''} ${pieceName[first.piece]} auf ${first.from} war angegriffen. ${first.san} beantwortet das aktiv${first.captured ? ` durch Schlagen auf ${first.to}` : ' mit Schach'}; die Vergleichsvariante zeigt den Unterschied zum Rückzug.`, 1, [first.from, first.to]);
  const recaptures = before.moves({ verbose: true }).filter(move => move.captured);
  if (!first.captured && first.san.includes('+') && recaptures.length && steps.slice(2).some((step, index) => index % 2 === 0 && step.move.captured))
    add('T08', 'Schach vor dem Schlagen', `Statt sofort zu schlagen, schiebt ${first.san} ein Schach ein. In der gezeigten Fortsetzung folgt der eigene Schlag erst später.`, 1, [first.to], 'searched_line');
  if (first.captured) {
    const nextGain = steps.slice(2).find((step, index) => index % 2 === 0 && step.move.captured &&
      before.get(step.move.to)?.color === enemy && !steps.slice(0, index + 2).some(earlier => earlier.move.from === step.move.to || earlier.move.to === step.move.to) &&
      before.attackers(step.move.to, enemy).includes(first.to));
    if (nextGain) add('T09', 'Verteidiger entfernt', `${first.san} entfernt ${pieceObject[first.captured]} auf ${first.to}. Diese Figur deckte zuvor ${nextGain.move.to}; in dieser Fortsetzung wird anschließend dort geschlagen.`, steps.indexOf(nextGain) + 1, [first.to, nextGain.move.to], 'searched_line');
  }
  const replies = after.moves({ verbose: true });
  const recapture = replies.find(move => move.captured && move.to === first.to);
  if (first.captured) {
    const pin = sliderPins(after, color).find(pin => pin.absolute && after.attackers(first.to, enemy).includes(pin.pinned as Square) && !replies.some(move => move.from === pin.pinned && move.to === first.to));
    if (pin) add('T02', 'Rückschlag durch Königsschutz begrenzt', `Die Figur auf ${pin.pinned} greift ${first.to} geometrisch an, steht aber vor dem König auf ${pin.behind}. Ihr Rückschlag ist in dieser Stellung nicht legal.`, 1, [pin.pinned, first.to, pin.behind]);
    if (!recapture && !after.isCheckmate()) add('T03', 'Kein unmittelbarer Rückschlag', `Nach ${first.san} gibt es keinen legalen gegnerischen Schlag auf ${first.to}. Andere Gegenaktionen bleiben möglich und werden in der Fortsetzung sichtbar.`, 1, [first.to]);
  }
  const chased = targets.find(piece => piece!.type === 'q');
  if (chased && steps[1]?.move.from === chased.square) add('T15', 'Damenangriff mit Antwort', `${first.san} greift die Dame auf ${chased.square} an. In der berechneten Fortsetzung verwendet der Gegner seinen nächsten Zug für ${steps[1].move.san}.`, 2, [first.to, chased.square], 'searched_line');
  if (first.promotion) add('T23', 'Umwandlung', `${first.san} wandelt den Bauern in ${first.promotion === 'q' ? 'eine' : 'einen'} ${pieceName[first.promotion]} um. Andere Umwandlungsfiguren sind eigene Kandidaten und können ein anderes Ergebnis haben.`, 1, [first.to]);
  // A later own move uses the original vacated square: a literal clearance fact.
  let originalSquare: string | null = first.to;
  const usesSquare = steps.slice(1).find(step => {
    const isOriginal = step.move.color === color && step.move.from === originalSquare;
    if (step.move.captured && step.move.to === originalSquare) originalSquare = null;
    if (isOriginal) originalSquare = step.move.to;
    return step.move.color === color && !isOriginal && step.move.to === first.from;
  });
  if (usesSquare) add('T13', 'Platz für eine andere Figur', `${first.san} macht ${first.from} frei. In der gezeigten Linie nutzt anschließend ${usesSquare.move.san} dieses Feld.`, steps.indexOf(usesSquare) + 1, [first.from], 'searched_line');
  if (!first.captured) {
    const cut = steps.slice(2).find((step, index) => index % 2 === 0 && step.move.captured && before.get(step.move.to)?.color === enemy &&
      before.attackers(step.move.to, enemy).some(defender => {
        const piece = before.get(defender);
        return piece && ['r', 'b', 'q'].includes(piece.type) && after.get(defender)?.type === piece.type &&
          !after.attackers(step.move.to, enemy).includes(defender) && after.attackers(step.move.to, color).includes(first.to) === false;
      }) && !steps.slice(0, index + 2).some(earlier => earlier.move.from === step.move.to || earlier.move.to === step.move.to));
    if (cut) add('T14', 'Verteidigungslinie unterbrochen', `${first.san} unterbricht eine zuvor bestehende Deckung von ${cut.move.to}. In der gezeigten Fortsetzung folgt dort ${cut.move.san}.`, steps.indexOf(cut) + 1, [first.to, cut.move.to], 'searched_line');
  }
  return reasons;
}

type Features = { doubled: number; isolated: number; passers: string[]; files: Set<string>; bishops: Map<string, number>; control: Set<string>; shield: Set<string>; bishopPair: boolean; developed: Set<string> };
function features(board: Chess, color: 'w' | 'b'): Features {
  const own = board.board().flat().filter(piece => piece?.color === color), pawns = own.filter(piece => piece!.type === 'p');
  const enemyPawns = board.board().flat().filter(piece => piece && piece.color !== color && piece.type === 'p');
  const fileCounts = new Map<string, number>(); pawns.forEach(piece => fileCounts.set(piece!.square[0], (fileCounts.get(piece!.square[0]) || 0) + 1));
  const passers = pawns.filter(piece => !enemyPawns.some(enemy => Math.abs(enemy!.square.charCodeAt(0) - piece!.square.charCodeAt(0)) <= 1 && (color === 'w' ? enemy!.square[1] > piece!.square[1] : enemy!.square[1] < piece!.square[1]))).map(piece => piece!.square);
  const isolated = pawns.filter(piece => ![String.fromCharCode(piece!.square.charCodeAt(0) - 1), String.fromCharCode(piece!.square.charCodeAt(0) + 1)].some(file => fileCounts.has(file))).length;
  const bishops = new Map<string, number>();
  own.filter(piece => piece!.type === 'b').forEach(piece => {
    let reach = 0;
    for (const ray of rays(piece!.square).filter(ray => ray[0] && ray[0][0] !== piece!.square[0] && ray[0][1] !== piece!.square[1])) {
      for (const target of ray) { const occupant = board.get(target); if (occupant?.color === color) break; reach++; if (occupant) break; }
    }
    bishops.set(piece!.square, reach);
  });
  const king = own.find(piece => piece!.type === 'k'), shield = new Set<string>();
  if (king) pawns.filter(piece => Math.abs(piece!.square.charCodeAt(0) - king.square.charCodeAt(0)) <= 1 &&
    (Number(piece!.square[1]) - Number(king.square[1])) * (color === 'w' ? 1 : -1) >= 1 &&
    (Number(piece!.square[1]) - Number(king.square[1])) * (color === 'w' ? 1 : -1) <= 2).forEach(piece => shield.add(piece!.square));
  const control = new Set<string>();
  pawns.forEach(piece => {
    const rank = Number(piece!.square[1]) + (color === 'w' ? 1 : -1);
    for (const delta of [-1, 1]) { const file = piece!.square.charCodeAt(0) + delta; if (file >= 97 && file <= 104 && rank >= 1 && rank <= 8) control.add(String.fromCharCode(file) + rank); }
  });
  const developed = new Set(own.filter(piece => ['n', 'b'].includes(piece!.type) && piece!.square[1] !== (color === 'w' ? '1' : '8')).map(piece => piece!.square));
  return { doubled: [...fileCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0), isolated, passers,
    files: new Set('abcdefgh'.split('').filter(file => !fileCounts.has(file))), bishops, control, shield,
    bishopPair: new Set(own.filter(piece => piece!.type === 'b').map(piece => (piece!.square.charCodeAt(0) + Number(piece!.square[1])) % 2)).size === 2, developed };
}

/** Compare literal structural changes after the two first moves. Descriptive
 * observations carry no invented centipawn attribution or universal rule. */
export function positionDifferences(anchor: string, best: WhyLine, other: WhyLine): WhyReason[] {
  const root = new Chess(anchor), a = new Chess(anchor), b = new Chess(anchor), color = root.turn();
  const first = playUci(a, best.uci), alternative = playUci(b, other.uci), af = features(a, color), bf = features(b, color);
  const result: WhyReason[] = [];
  const add = (motif: string, title: string, text: string, squares: string[] = []) => result.push({ motif, title, text, squares, level: 'positional_observation' as const, lineId: best.id, decisivePly: 1 });
  if (first.piece === 'p' && alternative.piece === 'p' && first.to === alternative.to && first.from !== alternative.from) add('P01', 'Unterschied der Bauernschläge', `${first.san} verwendet den Bauern von ${first.from}; ${alternative.san} den von ${alternative.from}. Dadurch bleiben unterschiedliche Deckungen und Linien erhalten.`, [first.from, alternative.from, first.to]);
  const onlyA = [...af.control].filter(square => !bf.control.has(square)), onlyB = [...bf.control].filter(square => !af.control.has(square));
  if (onlyA.length || onlyB.length) add('P07', 'Andere Bauernkontrolle', `${first.san} erhält gegenüber ${alternative.san} Bauernkontrolle über ${onlyA.slice(0, 3).join(', ') || 'keine zusätzlichen Felder'}; bei ${alternative.san} sind stattdessen ${onlyB.slice(0, 3).join(', ') || 'keine zusätzlichen Felder'} gedeckt. Das beschreibt die Stellung, noch keinen Gewinn.`, [...onlyA, ...onlyB].slice(0, 6));
  const openA = [...af.files].filter(file => !bf.files.has(file)), openB = [...bf.files].filter(file => !af.files.has(file));
  if (openA.length || openB.length) add('P03', 'Offene oder halboffene Linien', `${openA.length ? `Nach ${first.san} fehlt auf ${openA.join(', ')} ein eigener Bauer. ` : ''}${openB.length ? `Nach ${alternative.san} gilt das stattdessen auf ${openB.join(', ')}. ` : ''}Ob eigene oder gegnerische Schwerfiguren die Linie nutzen können, hängt von der Fortsetzung ab.`);
  if (af.doubled !== bf.doubled || af.isolated !== bf.isolated) add('P04', 'Andere Bauernstruktur', `${first.san}: ${af.doubled} zusätzliche Bauern auf bereits besetzten Linien, ${af.isolated} isolierte Bauern. ${alternative.san}: ${bf.doubled} bzw. ${bf.isolated}. Diese Strukturmerkmale sind nicht automatisch gut oder schlecht.`);
  if (af.passers.length !== bf.passers.length) add('P05', 'Freibauer', `Nach ${first.san} hast du ${af.passers.length} Freibauern${af.passers.length ? ` (${af.passers.join(', ')})` : ''}, nach ${alternative.san} ${bf.passers.length}. Ihre Umwandlung ist dadurch noch nicht gesichert.`, af.passers);
  if (af.shield.size !== bf.shield.size) add('P06', 'Bauern vor dem König', `Nach ${first.san} stehen ${af.shield.size} eigene Bauern in den beiden Reihen vor dem König auf seiner oder einer Nachbarlinie; nach ${alternative.san} ${bf.shield.size}. Das ist ein Unterschied im Bauernschutz, keine alleinige Erklärung der Gesamtbewertung.`);
  for (const [square, reach] of af.bishops) if (bf.bishops.has(square) && Math.abs(reach - bf.bishops.get(square)!) >= 2) {
    add('P08', 'Raum für den Läufer', `Der Läufer auf ${square} erreicht entlang seiner Diagonalen nach ${first.san} ${reach} Felder, nach ${alternative.san} ${bf.bishops.get(square)}. Das zählt freie Wege, nicht die Sicherheit aller dieser Felder.`, [square]); break;
  }
  if (af.bishopPair !== bf.bishopPair) add('P10', 'Läuferpaar', `${af.bishopPair ? first.san : alternative.san} erhält zwei Läufer auf unterschiedlichen Feldfarben. Ihr Wert hängt davon ab, wie die Stellung und ihre Diagonalen sich entwickeln.`);
  if (af.developed.size !== bf.developed.size) add('P11', 'Entwickelte Leichtfiguren', `Nach ${first.san} stehen ${af.developed.size} eigene Springer/Läufer außerhalb der Grundreihe, nach ${alternative.san} ${bf.developed.size}. Entscheidend bleiben ihre Aufgaben und die konkreten Drohungen.`);
  if (first.captured && first.captured !== 'p') add('P09', 'Figur abgetauscht', `${first.san} entfernt ${pieceObject[first.captured]} des Gegners auf ${first.to}. Die Varianten zeigen, ob die Beseitigung dieser Figur wichtiger ist als das Erhalten der eigenen Figur.`, [first.to]);
  const tension = (position: Chess) => position.board().flat().filter(piece => piece?.color === color && piece.type === 'p').reduce((sum, piece) => sum + position.board().flat().filter(target => target && target.color !== color && target.type === 'p' && position.attackers(target.square, color).includes(piece!.square)).length, 0);
  if (!first.captured && alternative.piece === 'p' && alternative.captured === 'p' && tension(a) > tension(b)) add('P02', 'Bauernspannung erhalten', `${first.san} lässt mehr direkte Bauernkontakte bestehen als ${alternative.san}. Das hält weitere Schlagmöglichkeiten offen; der spätere Nutzen ist von den Antworten abhängig.`);
  const enemy = color === 'w' ? 'b' : 'w', ae = features(a, enemy), be = features(b, enemy);
  for (const [square, reach] of ae.bishops) if (be.bishops.has(square) && be.bishops.get(square)! - reach >= 2) {
    add('P12', 'Auch die gegnerische Figur verbessert sich', `Nach ${alternative.san} hat der gegnerische Läufer auf ${square} ${be.bishops.get(square)! - reach} zusätzliche Felder entlang seiner Diagonalen gegenüber ${first.san}. Der Tausch verändert also auch seine Aktivität.`, [square]); break;
  }
  return result;
}
