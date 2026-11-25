/** Build a playable offline catalog from the same pinned lichess ECO TSV cache
 * used for openingBook.json. Run: npm exec -- tsx scripts/generateOpeningCatalog.mts
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Chess } from 'chess.js';

const root = resolve(import.meta.dirname!, '..');
const book = JSON.parse(readFileSync(resolve(root, 'src/data/openingBook.json'), 'utf8')) as {
  meta: { sources: Array<{ letter: string; sha256: string }> };
};
const entries: Array<{ id: string; eco: string; name: string; movesUci: string[] }> = [];
const ids = new Set<string>();

for (const letter of ['a', 'b', 'c', 'd', 'e']) {
  const cache = resolve(root, 'scripts/eco-cache', `${letter}.tsv`);
  const raw = existsSync(cache)
    ? readFileSync(cache, 'utf8')
    : await fetch(`https://raw.githubusercontent.com/lichess-org/chess-openings/master/${letter}.tsv`)
      .then(response => {
        if (!response.ok) throw new Error(`${letter}.tsv: HTTP ${response.status}`);
        return response.text();
      });
  const sha256 = createHash('sha256').update(raw).digest('hex');
  if (book.meta.sources.find(source => source.letter === letter)?.sha256 !== sha256) {
    throw new Error(`${letter}.tsv unterscheidet sich von der fixierten ECO-Quelle in openingBook.json`);
  }
  for (const row of raw.split(/\r?\n/).slice(1)) {
    if (!row.trim()) continue;
    const [eco, name, pgn] = row.split('\t');
    if (!eco || !name || !pgn) throw new Error(`Unvollständiger Katalogeintrag: ${row}`);
    const chess = new Chess();
    const movesUci: string[] = [];
    for (const token of pgn.replace(/\d+\.(?:\.\.)?/g, ' ').trim().split(/\s+/)) {
      const move = chess.move(token);
      movesUci.push(`${move.from}${move.to}${move.promotion ?? ''}`);
    }
    if (!movesUci.length) throw new Error(`Leere Zugfolge: ${eco} ${name}`);
    const id = `${eco.toLowerCase()}-${createHash('sha256').update(movesUci.join(' ')).digest('hex').slice(0, 16)}`;
    if (ids.has(id)) continue;
    ids.add(id);
    entries.push({ id, eco, name, movesUci });
  }
}

const output = {
  source: 'lichess-org/chess-openings',
  license: 'CC0-1.0',
  sourceSha256: Object.fromEntries(book.meta.sources.map(source => [source.letter, source.sha256])),
  entries,
};
writeFileSync(resolve(root, 'src/data/openingCatalog.json'), JSON.stringify(output));
console.log(`${entries.length} legale ECO-Zugfolgen in src/data/openingCatalog.json`);
