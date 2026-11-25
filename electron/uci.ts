/**
 * Pure UCI-Utilities — ohne Electron-Abhängigkeit (T02).
 * Ausgelagert aus stockfish.ts, damit sie auch in Regressionstests
 * importierbar sind, ohne den Electron-Modulgraphen zu laden.
 */
import { Chess } from 'chess.js';

/**
 * UCI-Zeilengrenzen: behandelt beliebige Transport-Chunks, CRLF und Teilzeilen.
 * Exportiert für Regressionstests (T02-Kerndefekt: geteilte Zeilen an Chunk-Grenzen).
 */
export class LineAssembler {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    for (;;) {
      const m = /\r?\n/.exec(this.buffer);
      if (!m) break;
      lines.push(this.buffer.slice(0, m.index));
      this.buffer = this.buffer.slice(m.index + m[0].length);
    }
    return lines;
  }
}

/** FEN an der IPC-Grenze validieren (T02/T22): kein freier Text an die Engine. */
export function isValidFen(fen: unknown): fen is string {
  if (typeof fen !== 'string' || fen.length === 0 || fen.length > 120) return false;
  try {
    new Chess(fen);
    return true;
  } catch {
    return false;
  }
}
