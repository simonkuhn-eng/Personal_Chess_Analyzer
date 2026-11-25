/** T12-Abnahme-Probes: generische Präfixe korrekt, Anker erst an richtiger Stellung. */
import { Chess } from 'chess.js';
import bookData from '../src/data/openingBook.json';
const epdOf = (fen: string) => fen.split(' ').slice(0, 4).join(' ');
const nameOf = (fen: string) => (bookData.names as Record<string, { eco: string; name: string }>)[epdOf(fen)] ?? null;
const fenAfter = (sans: string[]): string => {
  const chess = new Chess();
  for (const s of sans) chess.move(s);
  return chess.fen();
};
const cases: [string, string[], string | null][] = [
  ['Startposition', [], null],
  ['1.e4', ['e4'], 'King'],
  ['1.e4 c6', ['e4', 'c6'], 'Caro-Kann'],
  ['1.d4 d5 2.c4', ['d4', 'd5', 'c4'], 'Queen'],
  ['1.d4 d5 2.c4 c6 (Slawisch-Anker)', ['d4', 'd5', 'c4', 'c6'], 'Slav'],
  ['1.Nf3', ['Nf3'], 'Zukertort'],
];
let ok = 0;
for (const [label, sans, expect] of cases) {
  const hit = nameOf(fenAfter(sans));
  const pass = expect === null ? hit === null : hit !== null && hit.name.includes(expect);
  if (pass) ok++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}: ${hit ? `${hit.eco} ${hit.name}` : 'UNBENANNT'}`);
}
console.log(`meta: parsed=${bookData.meta?.counts?.parsed ?? '?'} failed=${bookData.meta?.counts?.failed ?? '?'} repAnchors=${bookData.meta?.counts?.repLines ?? '?'} epds=${bookData.epds.length} names=${Object.keys(bookData.names).length}`);
console.log(`GESAMT: ${ok}/${cases.length} Probes bestanden`);
if (ok !== cases.length) process.exit(1);
