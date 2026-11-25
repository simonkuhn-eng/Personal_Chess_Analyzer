import { createHash } from 'node:crypto';
import type { AppSettings, GameAnalysis } from '../src/types/chess';
import { normalizeAppSettings } from '../src/types/chess';
import { Chess } from 'chess.js';
import type { DataBundle } from '../src/types/data';
export type { DataBundle } from '../src/types/data';

export function validateLearningStorage(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Ungültiger Lernspeicher.');
  const entries = Object.entries(raw);
  if (entries.some(([key, value]) => !key.startsWith('personal-chess-analyzer-') || typeof value !== 'string')) throw new Error('Ungültiger Lernspeichereintrag.');
  return Object.fromEntries(entries) as Record<string, string>;
}

export function validateDataBundle(raw: unknown): DataBundle {
  const value = raw as DataBundle;
  if (!value || value.format !== 'personal-chess-analyzer' || value.version !== 1 || !Array.isArray(value.games) || !value.settings || !Number.isFinite(Date.parse(value.createdAt))) throw new Error('Kein unterstütztes vollständiges App-Backup.');
  const ids = new Set<string>();
  for (const game of value.games) {
    if (!game || typeof game.id !== 'string' || !game.id || ids.has(game.id) || typeof game.pgn !== 'string' || typeof game.white !== 'string' || typeof game.black !== 'string' || !Array.isArray(game.moves) || !game.summaryWhite || !game.summaryBlack) throw new Error('Ungültige oder doppelte Partie im Backup.');
    ids.add(game.id);
    for (const move of game.moves) {
      if (!move || !move.evalBefore || !move.evalAfter || !Number.isFinite(move.ply) || !Number.isFinite(move.evalBefore.scoreCp) || !Number.isFinite(move.evalAfter.scoreCp) || typeof move.san !== 'string' || typeof move.uci !== 'string') throw new Error('Ungültige Analyse im Backup.');
      try { new Chess(move.fenBefore); new Chess(move.fenAfter); } catch { throw new Error('Ungültige Brettstellung im Backup.'); }
    }
  }
  return { ...value, settings: normalizeAppSettings(value.settings), learningStorage: validateLearningStorage(value.learningStorage) };
}

export function encodeDataBundle(bundle: DataBundle): string {
  const payload = JSON.stringify(validateDataBundle(bundle));
  return JSON.stringify({ checksum: createHash('sha256').update(payload).digest('hex'), payload });
}

export function decodeDataBundle(text: string): DataBundle {
  const wrapper = JSON.parse(text);
  if (typeof wrapper.payload !== 'string' || wrapper.checksum !== createHash('sha256').update(wrapper.payload).digest('hex')) throw new Error('Backup beschädigt: Prüfsumme stimmt nicht.');
  return validateDataBundle(JSON.parse(wrapper.payload));
}
