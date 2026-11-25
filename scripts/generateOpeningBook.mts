/**
 * Generiert src/data/openingBook.json aus der verifizierten lichess-ECO-Quelle
 * (github.com/lichess-org/chess-openings, TSV: eco/name/pgn).
 *
 * T12-Regeln:
 *  - Membership-Set (epds) und Namensregister (names) sind getrennt.
 *  - Namen hängen NUR an fachlich definierten Ankerstellungen — der Endstellung
 *    jeder Eröffnungszeile (lichess: eine Zeile = eine erreichte Eröffnungs-
 *    position). Zwischenstellungen bleiben namenlos; die Erkennung wählt
 *    "längste passend erreichte benannte Stellung".
 *  - Transpositions-Kollisionen deterministisch: erste TSV-Zeile gewinnt
 *    (Dateireihenfolge = ECO aufsteigend).
 *  - Persönliches Repertoire (REP) läuft NACH der ECO-Quelle und füllt nur
 *    unbenannte Anker — spezifische ECO-Endnamen werden nicht verdrängt.
 *  - Quellen, Checksummen und Fehlzähler werden protokolliert (meta) und
 *    Fehler NICHT still übersprungen.
 *
 * TSVs liegen in scripts/eco-cache/ (gitignored) oder werden geladen.
 * Ausführen:  npx tsx scripts/generateOpeningBook.mts
 */
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { Chess } from 'chess.js';

// T12-Fehler-Log: Named-ESM-Import von repertoire.ts failt unter tsx (package.json
// ohne "type": "module" → .ts wird als CJS geladen, Export-Detection schlägt fehl;
// Schatten-Verzeichnis und absolute .ts-Importe wurden getestet und ausgeschlossen).
// Bewährtes Muster aus tests/regression.mts: createRequire + typeof-Import-Cast.
const require_ = createRequire(import.meta.url);
const { REPERTOIRE_LINES } = require_('../src/data/repertoire') as typeof import('../src/data/repertoire');

const LETTERS = ['a', 'b', 'c', 'd', 'e'];
const RAW_BASE = 'https://raw.githubusercontent.com/lichess-org/chess-openings/master';
const CACHE_DIR = resolve(import.meta.dirname!, 'eco-cache');
const OUT_PATH = resolve(import.meta.dirname!, '../src/data/openingBook.json');

interface TsvSource {
  letter: string;
  sha256: string;
  rows: number;
  origin: 'cache' | 'download';
}

async function loadTsv(letter: string): Promise<{ text: string; source: TsvSource }> {
  const local = resolve(CACHE_DIR, `${letter}.tsv`);
  if (existsSync(local)) {
    const text = readFileSync(local, 'utf-8');
    return {
      text,
      source: { letter, sha256: sha256(text), rows: countRows(text), origin: 'cache' },
    };
  }
  const url = `${RAW_BASE}/${letter}.tsv`;
  console.log(`  ${letter}.tsv: lade ${url} …`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} für ${url} — Download fehlgeschlagen (nicht still überspringen)`);
  const text = await res.text();
  return {
    text,
    source: { letter, sha256: sha256(text), rows: countRows(text), origin: 'download' },
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

function countRows(text: string): number {
  return text.split('\n').slice(1).filter((l) => l.trim().length > 0).length;
}

const epdSet = new Set<string>();
const ecoNames = new Map<string, { eco: string; name: string }>();
const repNames = new Map<string, { eco: string; name: string }>();

/**
 * Läuft eine UCI-Zugfolge: ALLE erreichten Stellungen gehen ins Membership-Set;
 * der Name wird AUSSCHLIESSLICH an der Endstellung (Anker) gesetzt — nur falls
 * diese Position dort noch unbenannt ist (first-write-wins pro Register).
 */
function anchorLine(target: Map<string, { eco: string; name: string }>, uciMoves: string[], label: { eco: string; name: string }): boolean {
  const chess = new Chess();
  const epd = () => chess.fen().split(' ').slice(0, 4).join(' ');
  epdSet.add(epd());
  for (const u of uciMoves) {
    chess.move({ from: u.slice(0, 2) as never, to: u.slice(2, 4) as never, promotion: u[4] as never });
    epdSet.add(epd());
  }
  const finalEpd = epd();
  if (!target.has(finalEpd)) target.set(finalEpd, label);
  return true;
}

function sanPgnToUci(pgn: string): string[] {
  const sans = pgn
    .replace(/\d+\.(\.\.)?/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const chess = new Chess();
  const uci: string[] = [];
  for (const san of sans) {
    const move = chess.move(san);
    if (!move) throw new Error(`Illegaler SAN: ${san} in "${pgn}"`);
    uci.push(`${move.from}${move.to}${move.promotion ?? ''}`);
  }
  return uci;
}

let parsed = 0;
const failedRows: string[] = [];
const sources: TsvSource[] = [];

// 1) ECO-Quelle (lichess): Membership für alle Positionen, Namen nur an Anker.
for (const letter of LETTERS) {
  const { text, source } = await loadTsv(letter);
  sources.push(source);
  const lines = text.split('\n').slice(1).filter((l) => l.trim().length > 0);
  for (const row of lines) {
    const tabIdx = row.indexOf('\t');
    const eco = row.slice(0, tabIdx);
    const rest = row.slice(tabIdx + 1);
    const nameEnd = rest.indexOf('\t');
    const name = nameEnd === -1 ? rest : rest.slice(0, nameEnd);
    const pgn = nameEnd === -1 ? '' : rest.slice(nameEnd + 1);

    try {
      const uci = sanPgnToUci(pgn);
      anchorLine(ecoNames, uci, { eco, name });
      parsed++;
    } catch (err) {
      // Nicht still: Zeile + Grund protokollieren (max. 10 Details im Log)
      failedRows.push(`${eco} ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// 2) Persönliches Repertoire NACH der ECO-Quelle: füllt nur unbenannte Anker.
//    Hauptlinien-Anker = Endstellung der Linie; Abweichungs-Anker = Endstellung
//    der Abweichungs-Fortsetzung im Hauptlinien-Kontext.
let repLines = 0;
let repSkipped = 0;
for (const line of REPERTOIRE_LINES) {
  try {
    const uciMoves = line.mainMoves;
    anchorLine(repNames, uciMoves, { eco: 'REP', name: line.name });
    repLines++;
  } catch (err) {
    repSkipped++;
    console.warn(`  Repertoire-Linie "${line.name}" nicht lauffähig: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const dev of line.deviations) {
    try {
      const chess = new Chess();
      for (let i = 0; i < dev.atPly; i++) {
        const u = line.mainMoves[i];
        chess.move({ from: u.slice(0, 2) as never, to: u.slice(2, 4) as never, promotion: u[4] as never });
      }
      const branch = [dev.uci, ...dev.continuation];
      for (const u of branch) {
        chess.move({ from: u.slice(0, 2) as never, to: u.slice(2, 4) as never, promotion: u[4] as never });
      }
      const finalUci: string[] = [
        ...line.mainMoves.slice(0, dev.atPly),
        ...branch,
      ];
      anchorLine(repNames, finalUci, { eco: 'REP', name: `${line.name} – ${dev.eco}` });
      repLines++;
    } catch {
      // Abweichung im Hauptlinien-Kontext illegal (tieferer Zweig) — gezählt, nicht still
      repSkipped++;
    }
  }
}

// 3) Merge: ECO-Anker zuerst, REP nur in Lücken (verdrängt keine ECO-Endnamen).
const nameMap = new Map<string, { eco: string; name: string }>();
for (const [epd, v] of ecoNames) nameMap.set(epd, v);
let repFilled = 0;
for (const [epd, v] of repNames) {
  if (!nameMap.has(epd)) {
    nameMap.set(epd, v);
    repFilled++;
  }
}

const epds = [...epdSet];
const names: Record<string, { eco: string; name: string }> = {};
for (const [epd, v] of nameMap) names[epd] = v;

const json = JSON.stringify({
  meta: {
    source: 'lichess-org/chess-openings@master (TSV a-e)',
    generatedAt: new Date().toISOString(),
    sources,
    counts: { parsed, failed: failedRows.length, repLines, repSkipped, repFilled },
  },
  epds,
  names,
});
writeFileSync(OUT_PATH, json, 'utf-8');

if (failedRows.length > 0) {
  console.warn(`\nFehlerhafte ECO-Zeilen (${failedRows.length}, nicht still übersprungen):`);
  for (const f of failedRows.slice(0, 10)) console.warn(`  - ${f}`);
  if (failedRows.length > 10) console.warn(`  … und ${failedRows.length - 10} weitere`);
}

console.log(`\nEröffnungen verarbeitet: ${parsed}, fehlerhaft: ${failedRows.length}`);
console.log(`Repertoire-Anker: ${repLines} (übersprungen: ${repSkipped}, Lücken gefüllt: ${repFilled})`);
console.log(`Eindeutige Buch-Positionen (EPD): ${epds.length}`);
console.log(`Benannte Ankerstellungen: ${Object.keys(names).length}`);
console.log(`Geschrieben: ${OUT_PATH} (${(json.length / 1024 / 1024).toFixed(2)} MB)`);
