import { readLearningItem, writeLearningItem } from './learningStorage';
import { profileNamespace } from './profile';
import catalogData from '../data/openingCatalog.json';
import { Chess, type Square } from 'chess.js';
import { type RepertoireLine, REPERTOIRE_LINES } from '../data/repertoire';

export interface OpeningCatalogEntry {
  id: string;
  eco: string;
  name: string;
  movesUci: string[];
}

export interface OpeningCatalogGroup {
  key: string;
  eco: string;
  name: string;
  entries: OpeningCatalogEntry[];
}

export type TrainingColor = 'w' | 'b';
export interface OpeningSelection {
  id: string;
  color: TrainingColor;
}

export const OPENING_CATALOG: OpeningCatalogEntry[] = catalogData.entries;
const catalogById = new Map(OPENING_CATALOG.map(entry => [entry.id, entry]));
const courseById = new Map(REPERTOIRE_LINES.map(line => [line.id, line]));

export function selectionKey(selection: OpeningSelection): string {
  return `${selection.id}:${selection.color}`;
}

export function getOpeningCatalogEntry(id: string): OpeningCatalogEntry | undefined {
  return catalogById.get(id);
}

export function hasTrainingMove(entry: OpeningCatalogEntry, color: TrainingColor): boolean {
  return color === 'w' ? entry.movesUci.length >= 1 : entry.movesUci.length >= 2;
}

export function openingMovePreview(entry: OpeningCatalogEntry, maxPly = 8): string {
  const chess = new Chess();
  const sans: string[] = [];
  for (const [index, uci] of entry.movesUci.slice(0, maxPly).entries()) {
    const move = chess.move({ from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion: uci[4] });
    sans.push(`${index % 2 === 0 ? `${Math.floor(index / 2) + 1}.` : ''}${move.san}`);
  }
  return `${sans.join(' ')}${entry.movesUci.length > maxPly ? ' …' : ''}`;
}

export function openingTrainingMovePreview(entry: OpeningCatalogEntry, color: TrainingColor, maxMoves = 4): string {
  const chess = new Chess();
  const ownMoves: string[] = [];
  for (const [index, uci] of entry.movesUci.entries()) {
    const move = chess.move({ from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion: uci[4] });
    if (index % 2 !== (color === 'w' ? 0 : 1)) continue;
    ownMoves.push(`${Math.floor(index / 2) + 1}${color === 'w' ? '.' : '...'}${move.san}`);
    if (ownMoves.length >= maxMoves) break;
  }
  const totalOwnMoves = color === 'w' ? Math.ceil(entry.movesUci.length / 2) : Math.floor(entry.movesUci.length / 2);
  return `${ownMoves.join(' ')}${totalOwnMoves > ownMoves.length ? ' …' : ''}`;
}

export function catalogEntryToLine(entry: OpeningCatalogEntry, color: TrainingColor): RepertoireLine {
  return {
    id: `eco:${entry.id}:${color}`,
    name: entry.name,
    color,
    ecoBase: entry.eco,
    description: `ECO ${entry.eco} · ${Math.ceil(entry.movesUci.length / 2)} Züge · Zugfolgedrill`,
    mainMoves: entry.movesUci,
    deviations: [],
    plan: [],
    tabiya: 'Zugfolge abgeschlossen. Dieser Katalogeintrag enthält keine kommentierten Pläne oder gegnerischen Abweichungen.',
  };
}

export function selectedOpeningLine(selection: OpeningSelection): RepertoireLine | null {
  if (selection.id.startsWith('course:')) {
    const course = courseById.get(selection.id.slice(7));
    return course?.color === selection.color ? course : null;
  }
  const entry = catalogById.get(selection.id);
  return entry && hasTrainingMove(entry, selection.color) ? catalogEntryToLine(entry, selection.color) : null;
}

/** Katalog-Favorit behält seine Zugfolge; die andere Perspektive hat eigene Lernschlüssel. */
export function changeOpeningSelectionColor(
  selections: OpeningSelection[], selection: OpeningSelection, color: TrainingColor,
): OpeningSelection[] {
  const entry = getOpeningCatalogEntry(selection.id);
  if (!entry || !hasTrainingMove(entry, color)) return selections;
  const previousKey = selectionKey(selection);
  const seen = new Set<string>();
  return selections.map(item => selectionKey(item) === previousKey ? { ...item, color } : item)
    .filter(item => {
      const key = selectionKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function openingSelectionStorageKey(playerName: string): string {
  return `personal-chess-analyzer-openings-v1:${profileNamespace(playerName)}`;
}

export function defaultOpeningSelections(): OpeningSelection[] {
  return REPERTOIRE_LINES.map(line => ({ id: `course:${line.id}`, color: line.color }));
}

export function loadOpeningSelections(playerName: string): OpeningSelection[] {
  try {
    const raw = readLearningItem(openingSelectionStorageKey(playerName));
    if (raw === null) return defaultOpeningSelections();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaultOpeningSelections();
    const seen = new Set<string>();
    return parsed.filter((item): item is OpeningSelection => {
      if (!item || typeof item !== 'object') return false;
      const selected = item as Partial<OpeningSelection>;
      if (typeof selected.id !== 'string' || (selected.color !== 'w' && selected.color !== 'b')) return false;
      const key = selectionKey(selected as OpeningSelection);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } catch {
    return defaultOpeningSelections();
  }
}

export function saveOpeningSelections(playerName: string, selections: OpeningSelection[]): boolean {
  try {
    return writeLearningItem(openingSelectionStorageKey(playerName), JSON.stringify(selections));
  } catch {
    return false;
  }
}

export function normalizedOpeningSearch(value: string): string {
  return value.toLocaleLowerCase('de').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Gleicher ECO-Code und Name können mehrere echte, separat trainierbare Zugfolgen haben. */
export function groupOpeningCatalogEntries(entries: OpeningCatalogEntry[]): OpeningCatalogGroup[] {
  const groups = new Map<string, OpeningCatalogGroup>();
  for (const entry of entries) {
    const key = `${entry.eco}:${normalizedOpeningSearch(entry.name)}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, eco: entry.eco, name: entry.name, entries: [] };
      groups.set(key, group);
    }
    group.entries.push(entry);
  }
  return [...groups.values()];
}

const aliases: Record<string, string> = {
  sicilian: 'sizilianisch',
  slav: 'slawisch',
  french: 'franzosisch',
  spanish: 'spanisch',
  italian: 'italienisch',
  'king s indian': 'konigsindisch',
  'queen s gambit': 'damengambit',
};

export function searchOpeningCatalog(query: string): OpeningCatalogEntry[] {
  const needle = normalizedOpeningSearch(query);
  if (!needle) return OPENING_CATALOG;
  const tokens = needle.split(/\s+/);
  const matches = OPENING_CATALOG.filter(entry => {
    const name = normalizedOpeningSearch(`${entry.eco} ${entry.name}`);
    const translated = Object.entries(aliases).reduce((text, [english, german]) => text.replaceAll(english, german), name);
    return tokens.every(token => name.includes(token) || translated.includes(token));
  });
  // Grundformen und explizit benannte Hauptvarianten zuerst; keine Aussage über Spielhäufigkeit.
  const priority = (entry: OpeningCatalogEntry): number => {
    const root = normalizedOpeningSearch(entry.name.split(':')[0]);
    const translatedRoot = Object.entries(aliases).reduce((text, [english, german]) => text.replaceAll(english, german), root);
    const matchesRoot = root.startsWith(tokens[0]) || translatedRoot.startsWith(tokens[0]);
    if (!matchesRoot) return 3;
    if (!entry.name.includes(':')) return 0;
    if (/main line|normal variation|classical variation|standard variation|orthodox variation|open variation|closed variation/i.test(entry.name)) return 1;
    return 2;
  };
  return matches.sort((a, b) => priority(a) - priority(b) || a.name.length - b.name.length);
}
