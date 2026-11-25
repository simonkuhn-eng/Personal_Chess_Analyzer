import { readLearningItem, writeLearningItem } from './learningStorage';
import { profileNamespace } from './profile';
import { Chess, type Square } from 'chess.js';
import { REPERTOIRE_LINES, type RepertoireLine } from '../data/repertoire';
import { OPENING_CATALOG, getOpeningCatalogEntry, loadOpeningSelections, normalizedOpeningSearch, type OpeningCatalogEntry } from './openingCatalog';
import { isDue, type ReviewStore } from './reviews';
import type { OpeningFocus } from '../types/chess';

export interface OpeningBranch {
  id: string;
  name: string;
  moves: string[];
  /** Variant name is disclosed only after this many moves have appeared. */
  revealPly: number;
  note: string;
  reviewKey: string;
}

export interface OpeningRepertoire {
  id: string;
  name: string;
  color: 'w' | 'b';
  description: string;
  plan: string[];
  branches: OpeningBranch[];
  entryIds: string[];
  searchText: string;
  curated: boolean;
  source?: 'catalog' | 'engine';
  focus?: OpeningFocus;
}

const MAX_CATALOG_PLY = 20;
const MIN_OWN_MOVES = 4;
const MAX_CATALOG_BRANCHES = 12;
export const MAX_RESPONSE_PLY = 64;

export function playOpeningMove(chess: Chess, uci: string) {
  return chess.move({ from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion: uci[4] });
}

export function openingOwnMoveCount(moves: string[], color: 'w' | 'b'): number {
  return color === 'w' ? Math.ceil(moves.length / 2) : Math.floor(moves.length / 2);
}

function courseBranches(course: RepertoireLine): OpeningBranch[] {
  const branches: OpeningBranch[] = [
    { id: `${course.id}:main`, name: course.id === 'caro-kann' ? 'Klassisch mit 3.Sc3' : 'Hauptvariante', moves: course.mainMoves, revealPly: 5,
      note: course.tabiya, reviewKey: `opening:${course.id}:main` },
    ...course.deviations.map(dev => ({
      id: `${course.id}:${dev.atPly}:${dev.uci}`, name: dev.eco.replace(/^\S+\s*[—–-]\s*/, ''),
      moves: [...course.mainMoves.slice(0, dev.atPly), dev.uci, ...dev.continuation],
      revealPly: dev.atPly + 1, note: dev.note, reviewKey: `${course.id}:${dev.atPly}:${dev.uci}`,
    })),
  ];
  if (course.id === 'caro-kann') {
    branches.push({ id: 'caro-kann:panov', name: 'Panov-Angriff', revealPly: 7,
      moves: 'e2e4 c7c6 d2d4 d7d5 e4d5 c6d5 c2c4 b8c6 b1c3 g8f6 g1f3 e7e6 c4d5 e6d5 f1b5 f8d6 c1g5 e8g8'.split(' '),
      note: 'Weiß greift mit c4 das Zentrum an. Entwickle Druck gegen d4 mit ...Sc6 und ...Sf6. Nach dem zentralen Abtausch entwickeln beide Seiten ihre Figuren und sichern den König; achte auf die isolierten Zentrumsbauern.',
      reviewKey: 'opening:caro-kann:panov' });
  }
  return branches;
}

interface TreeNode {
  children: Map<string, TreeNode>;
  count: number;
  entry?: OpeningCatalogEntry;
}

/** A fixed response policy for the learner; only the opponent's replies vary.
 * Short ECO labels are prefixes, never separate one-move exercises.
 */
function catalogBranches(entries: OpeningCatalogEntry[], color: 'w' | 'b', maxPly = MAX_CATALOG_PLY): OpeningBranch[] {
  const root: TreeNode = { children: new Map(), count: 0 };
  for (const entry of entries) {
    const moves = entry.movesUci.slice(0, maxPly);
    if (openingOwnMoveCount(moves, color) < MIN_OWN_MOVES) continue;
    let node = root;
    node.count++;
    for (const move of moves) {
      let child = node.children.get(move);
      if (!child) { child = { children: new Map(), count: 0 }; node.children.set(move, child); }
      child.count++;
      node = child;
    }
    node.entry = entry;
  }
  const candidates: OpeningBranch[] = [];
  function visit(node: TreeNode, moves: string[], source?: OpeningCatalogEntry) {
    const entry = node.entry || source;
    if (node.children.size === 0) {
      if (entry && openingOwnMoveCount(moves, color) >= MIN_OWN_MOVES) {
        candidates.push({ id: entry.id, name: entry.name.split(':').slice(1).join(':').trim() || 'Hauptvariante',
          moves, revealPly: Math.min(moves.length, 5), note: '', reviewKey: `opening:eco:${entry.id}:${color}` });
      }
      return;
    }
    const ownTurn = moves.length % 2 === (color === 'w' ? 0 : 1);
    const children = [...node.children.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
    for (const [uci, child] of ownTurn ? children.slice(0, 1) : children) visit(child, [...moves, uci], entry);
  }
  visit(root, []);
  // Greedy opponent-edge coverage avoids filling the package with near-identical deep sublines.
  const selected: OpeningBranch[] = [];
  const seen = new Set<string>();
  while (candidates.length && selected.length < MAX_CATALOG_BRANCHES) {
    const score = (branch: OpeningBranch) => branch.moves.reduce((total, _, i) =>
      total + (i % 2 !== (color === 'w' ? 0 : 1) && !seen.has(branch.moves.slice(0, i + 1).join(' ')) ? 1 : 0), 0);
    candidates.sort((a, b) => score(b) - score(a) || b.moves.length - a.moves.length);
    const branch = candidates.shift()!;
    selected.push(branch);
    branch.moves.forEach((_, i) => seen.add(branch.moves.slice(0, i + 1).join(' ')));
  }
  return selected;
}

function matchesCourse(entry: OpeningCatalogEntry, course: RepertoireLine): boolean {
  if (course.id === 'caro-kann') return entry.name.startsWith('Caro-Kann Defense');
  if (course.id === 'slav') return entry.name.startsWith('Slav Defense');
  return course.id === 'london-system' && entry.name.includes('London System');
}

function buildRepertoires(): OpeningRepertoire[] {
  const assigned = new Set<string>();
  const result: OpeningRepertoire[] = REPERTOIRE_LINES.map(course => {
    const entries = OPENING_CATALOG.filter(entry => matchesCourse(entry, course));
    entries.forEach(entry => assigned.add(entry.id));
    return { id: `course:${course.id}`, name: course.name, color: course.color,
      description: course.description, plan: course.plan, branches: courseBranches(course),
      entryIds: entries.map(entry => entry.id), searchText: normalizedOpeningSearch(`${course.name} ${course.ecoBase} ${entries.map(entry => `${entry.eco} ${entry.name}`).join(' ')}`), curated: true };
  });
  const groups = new Map<string, OpeningCatalogEntry[]>();
  for (const entry of OPENING_CATALOG) {
    if (assigned.has(entry.id)) continue;
    const name = entry.name.split(':')[0].trim();
    const list = groups.get(name) || [];
    list.push(entry);
    groups.set(name, list);
  }
  for (const [name, entries] of groups) {
    // The shortest naming position establishes the repertoire's perspective.
    // Curated courses above explicitly declare their side and take precedence.
    const base = [...entries].sort((a, b) => a.movesUci.length - b.movesUci.length || a.name.length - b.name.length)[0];
    const color = base.movesUci.length % 2 === 0 ? 'b' : 'w';
    result.push({ id: `family:${normalizedOpeningSearch(name).replaceAll(' ', '-')}`, name, color,
      description: `Zusammenhängende Varianten mit ${color === 'w' ? 'Weiß' : 'Schwarz'}.`, plan: [],
      branches: catalogBranches(entries, color), entryIds: entries.map(entry => entry.id),
      searchText: normalizedOpeningSearch(entries.map(entry => `${entry.eco} ${entry.name}`).join(' ')), curated: false });
  }
  return result;
}

export const OPENING_REPERTOIRES = buildRepertoires();
const repertoireById = new Map(OPENING_REPERTOIRES.map(repertoire => [repertoire.id, repertoire]));
const repertoireByEntry = new Map(OPENING_REPERTOIRES.flatMap(repertoire => repertoire.entryIds.map(id => [id, repertoire] as const)));

export function getOpeningRepertoire(id: string, player?: string): OpeningRepertoire | undefined {
  return repertoireById.get(id) || (player ? loadResponseRepertoires(player).find(item => item.id === id) : undefined);
}

export function searchOpeningRepertoires(query: string, player?: string): OpeningRepertoire[] {
  const normalized = normalizedOpeningSearch(query).replaceAll('slawisch', 'slav').replaceAll('sizilianisch', 'sicilian').replaceAll('franzosisch', 'french').replaceAll('italienisch', 'italian').replaceAll('spanisch', 'spanish').replaceAll('konigsindisch', 'king s indian').replaceAll('damengambit', 'queen s gambit');
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const starters = ['Sicilian Defense', 'French Defense', 'Italian Game', 'Ruy Lopez', "Queen's Gambit", "Queen's Gambit Declined", "King's Indian Defense", 'Scandinavian Defense', 'Scotch Game', 'English Opening', 'Pirc Defense', "Petrov's Defense"];
  const priority = (item: OpeningRepertoire) => {
    const index = starters.indexOf(item.name);
    return index < 0 ? starters.length : index;
  };
  return [...OPENING_REPERTOIRES, ...(player ? loadResponseRepertoires(player) : [])].filter(item => tokens.every(token => item.searchText.includes(token)))
    .sort((a, b) => Number(b.curated) - Number(a.curated) || Number(b.branches.length > 0) - Number(a.branches.length > 0) || priority(a) - priority(b) || a.name.localeCompare(b.name));
}

function storageKey(player: string) { return `personal-chess-analyzer-repertoires-v2:${profileNamespace(player)}`; }

export function loadRepertoireFavorites(player: string): string[] {
  try {
    const raw = readLearningItem(storageKey(player));
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return [...new Set(parsed.filter((id): id is string => typeof id === 'string' && Boolean(getOpeningRepertoire(id, player)?.branches.length)))];
    }
  } catch { /* Fall back to previous favorites without overwriting them. */ }
  // A saved single ECO line becomes its family, including accidentally white Caro-Kann favorites.
  return [...new Set(loadOpeningSelections(player).flatMap(selection => {
    const repertoire = repertoireById.get(selection.id) || (getOpeningCatalogEntry(selection.id) ? repertoireByEntry.get(selection.id) : undefined);
    return repertoire?.branches.length ? [repertoire.id] : [];
  }))];
}

export function saveRepertoireFavorites(player: string, ids: string[]): boolean {
  try { return writeLearningItem(storageKey(player), JSON.stringify(ids)); }
  catch { return false; }
}

export function loadOpeningScope(player: string, repertoire: OpeningRepertoire): string[] {
  const all = repertoire.branches.map(branch => branch.id);
  try {
    const raw = readLearningItem(storageKey(player) + ':scope:' + repertoire.id);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return all.filter(id => parsed.includes(id));
    }
  } catch { /* New or invalid preferences enable the complete package. */ }
  return all;
}

export function saveOpeningScope(player: string, repertoireId: string, ids: string[]): void {
  try { writeLearningItem(storageKey(player) + ':scope:' + repertoireId, JSON.stringify(ids)); }
  catch { /* The current session still uses the chosen scope. */ }
}

export function chooseOpeningBranch(
  branches: OpeningBranch[], reviews: ReviewStore, seenIds: readonly string[], random = Math.random,
): OpeningBranch | undefined {
  if (!branches.length) return undefined;
  let pool = branches.filter(branch => !seenIds.includes(branch.id));
  if (!pool.length) pool = branches.filter(branch => branch.id !== seenIds[seenIds.length - 1]);
  if (!pool.length) pool = branches;
  const now = Date.now();
  const weights = pool.map(branch => {
    const review = reviews.reviews[branch.reviewKey];
    return !review ? 2 : isDue(review, now) ? 3 : 1;
  });
  let point = Math.max(0, Math.min(0.999999, random())) * weights.reduce((sum, value) => sum + value, 0);
  return pool.find((_, i) => (point -= weights[i]) < 0) || pool[pool.length - 1];
}

/** Automatically play only the opponent's part of a complete, preselected branch. */
export function advanceOpeningOpponent(chess: Chess, moves: string[], color: 'w' | 'b', ply: number): number {
  let next = ply;
  while (next < moves.length && chess.turn() !== color) {
    playOpeningMove(chess, moves[next]);
    next++;
  }
  return next;
}

const responseCache = new Map<string, { raw: string | null; values: OpeningRepertoire[] }>();
const responseStorageKey = (player: string) => `personal-chess-analyzer-opening-responses-v1:${profileNamespace(player)}`;
export const responseRepertoireId = (focus: OpeningFocus) => `response:${focus.id}`;

/** Bounded, validated local packages; cached by storage content, scoped to profile. */
export function loadResponseRepertoires(player: string): OpeningRepertoire[] {
  const key = responseStorageKey(player), raw = readLearningItem(key);
  const cached = responseCache.get(key);
  if (cached?.raw === raw) return cached.values;
  const values: OpeningRepertoire[] = [];
  try {
    const parsed: unknown = JSON.parse(raw || '[]');
    if (Array.isArray(parsed)) for (const candidate of parsed.slice(0, 100)) {
      const item = candidate as OpeningRepertoire;
      if (!item || typeof item.id !== 'string' || !item.id.startsWith('response:') || typeof item.name !== 'string' ||
        !['w', 'b'].includes(item.color) || !Array.isArray(item.branches) || !item.branches.length || item.branches.length > 12 ||
        !Array.isArray(item.plan) || !Array.isArray(item.entryIds) || typeof item.searchText !== 'string') continue;
      const policy = new Map<string, string>();
      try {
        for (const branch of item.branches) {
          if (typeof branch.id !== 'string' || typeof branch.reviewKey !== 'string' || typeof branch.name !== 'string' ||
            !Array.isArray(branch.moves) || !branch.moves.length || branch.moves.length > MAX_RESPONSE_PLY) throw Error('Invalid branch');
          const board = new Chess();
          for (const uci of branch.moves) {
            if (typeof uci !== 'string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) throw Error('Invalid move');
            if (board.turn() === item.color) {
              const position = board.fen().split(' ').slice(0, 4).join(' ');
              if (policy.has(position) && policy.get(position) !== uci) throw Error('Conflicting learner response');
              policy.set(position, uci);
            }
            playOpeningMove(board, uci);
          }
        }
        values.push(item);
      } catch { /* Invalid imported packages never become playable. */ }
    }
  } catch { /* No saved response packages yet. */ }
  responseCache.set(key, { raw, values });
  return values;
}

export function saveResponseRepertoire(player: string, item: OpeningRepertoire): boolean {
  const existing = loadResponseRepertoires(player);
  if (existing.length >= 100 && !existing.some(value => value.id === item.id)) throw Error('Bereits 100 Antwortpakete gespeichert.');
  return writeLearningItem(responseStorageKey(player), JSON.stringify([...existing.filter(value => value.id !== item.id), item]));
}

export function responsePackage(focus: OpeningFocus, lines: Array<{ name: string; moves: string[] }>, source: 'catalog' | 'engine'): OpeningRepertoire {
  const id = responseRepertoireId(focus);
  const policy = new Map<string, string>();
  const seen = new Set<string>();
  const coherent = lines.filter(line => {
    const key = line.moves.join(' ');
    if (seen.has(key) || !line.moves.length || line.moves.length > MAX_RESPONSE_PLY ||
      focus.prefixUci.some((uci, index) => line.moves[index] !== uci)) return false;
    const board = new Chess(), additions = new Map<string, string>();
    try {
      for (const uci of line.moves) {
        if (board.turn() === focus.color) {
          const position = board.fen().split(' ').slice(0, 4).join(' ');
          if ((policy.has(position) && policy.get(position) !== uci) ||
            (additions.has(position) && additions.get(position) !== uci)) return false;
          additions.set(position, uci);
        }
        playOpeningMove(board, uci);
      }
    } catch { return false; }
    additions.forEach((uci, position) => policy.set(position, uci));
    seen.add(key);
    return true;
  }).slice(0, MAX_CATALOG_BRANCHES);
  if (!coherent.length) throw Error('Keine konsistenten Antwortvarianten vorhanden.');
  return { id, name: `Antworten: ${focus.name}`, color: focus.color, focus, source,
    description: focus.positionLabel, curated: false, entryIds: [],
    searchText: normalizedOpeningSearch(`${focus.name} ${focus.eco || ''} antworten gegen`),
    plan: [focus.positionLabel, source === 'engine' ? 'Übe die vorbereiteten Antworten gegen unterschiedliche gute Gegnerfortsetzungen.' : 'Übe die Katalogfortsetzungen dieses konkreten gegnerischen Aufbaus.'],
    branches: coherent.map(line => ({ id: `${id}:${line.moves.join('.')}`, name: line.name, moves: line.moves,
      revealPly: focus.prefixUci.length, note: source === 'engine' ? 'Enginegestützte Fortsetzung. Vergleiche bei Bedarf alternative Züge in der Partieanalyse.' : 'Fortsetzung aus dem Eröffnungskatalog.',
      reviewKey: `${id}:${line.moves.join('.')}` })) };
}

/** Re-anchor transposed catalog paths at the actual game position. A short ECO
 * naming prefix is not a complete exercise: require three later own decisions. */
export function catalogResponsePackage(focus: OpeningFocus): OpeningRepertoire | null {
  const epd = (fen: string) => fen.split(' ').slice(0, 4).join(' ');
  const target = epd(focus.anchorFen);
  const maxPly = Math.min(MAX_RESPONSE_PLY, Math.max(20, focus.prefixUci.length + 10));
  const family = focus.name.split(':')[0].split(',')[0];
  const entries: OpeningCatalogEntry[] = [];
  for (const entry of OPENING_CATALOG) {
    if (!focus.prefixUci.length || !(entry.name.startsWith(family) || (focus.eco && entry.eco === focus.eco))) continue;
    const board = new Chess();
    try {
      for (let i = 0; i < entry.movesUci.length; i++) {
        playOpeningMove(board, entry.movesUci[i]);
        if (epd(board.fen()) !== target) continue;
        const movesUci = [...focus.prefixUci, ...entry.movesUci.slice(i + 1)].slice(0, maxPly);
        if (openingOwnMoveCount(movesUci, focus.color) >= 4 && openingOwnMoveCount(movesUci, focus.color) - openingOwnMoveCount(focus.prefixUci, focus.color) >= 3)
          entries.push({ ...entry, movesUci });
        break;
      }
    } catch { /* Do not train an illegal catalog path. */ }
  }
  const branches = catalogBranches(entries, focus.color, maxPly);
  return branches.length ? responsePackage(focus, branches.map(branch => ({ name: branch.name, moves: branch.moves })), 'catalog') : null;
}
