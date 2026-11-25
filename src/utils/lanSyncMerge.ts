import type { AppSettings, GameAnalysis } from '../types/chess';
import { APP_SETTINGS_DEFAULTS, normalizeAppSettings } from '../types/chess';
import { migrateGameTime } from './gameTime';
import { annotateMissedOpportunities } from './missedOpportunities';
import type { OpeningRepertoire } from './openingTraining';
import { isStableGameId, mergePreviousIds, sameSourceIdentity } from './pgn';
import { normalizePlayerName } from './profile';
import type { ReviewEntry, ReviewStore } from './reviews';

export interface SyncPayload {
  format: 'personal-chess-analyzer-lan-sync';
  version: 1;
  sentAt: string;
  deviceName: string;
  games: GameAnalysis[];
  settings: AppSettings;
  learningStorage: Record<string, string>;
}

export interface SyncSummary {
  peerDeviceName: string;
  totalGames: number;
  gamesAdded: number;
  totalReviewCards: number;
  reviewCardsUpdated: number;
  repertoireKeysMerged: number;
  syncedAt: string;
}

const PREFIX_REVIEWS = 'personal-chess-analyzer-reviews-v1:';
const PREFIX_REPERTOIRES = 'personal-chess-analyzer-repertoires-v2:';
const PREFIX_OPENING_RESPONSES = 'personal-chess-analyzer-opening-responses-v1:';
const PREFIX_OPENINGS = 'personal-chess-analyzer-openings-v1:';
const PREFIX_TRAINING_QUALITIES = 'personal-chess-analyzer-training-qualities-v1:';
const PREFIX_TRAINING_IGNORED = 'personal-chess-analyzer-training-ignored-v1:';
const PREFIX_TRAINING_PREFS = 'personal-chess-analyzer-training-prefs-v1:';
const PREFIX_MIGRATED = 'personal-chess-analyzer-migrated:';
const LEGACY_SOLVED_KEY = 'personal-chess-analyzer-solved-training-cards';

function safeParseJson<T>(raw: string | undefined): T | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function isValidReviewEntry(entry: unknown): entry is ReviewEntry {
  if (!entry || typeof entry !== 'object') return false;
  const candidate = entry as Partial<ReviewEntry>;
  return typeof candidate.dueAt === 'number' && Number.isFinite(candidate.dueAt)
    && typeof candidate.intervalIdx === 'number' && Number.isFinite(candidate.intervalIdx);
}

function normalizeReviewEntry(key: string, entry: Partial<ReviewEntry>): ReviewEntry {
  return {
    key: typeof entry.key === 'string' && entry.key ? entry.key : key,
    dueAt: entry.dueAt!,
    intervalIdx: Math.max(0, Math.min(7, entry.intervalIdx!)),
    lapses: Math.max(0, Number(entry.lapses) || 0),
    helps: Math.max(0, Number(entry.helps) || 0),
    attempts: Math.max(0, Number(entry.attempts) || 0),
    correct: Math.max(0, Number(entry.correct) || 0),
    spacedCorrect: Math.max(0, Number(entry.spacedCorrect) || 0),
    lastResult: entry.lastResult,
    lastReviewedAt: typeof entry.lastReviewedAt === 'number' && Number.isFinite(entry.lastReviewedAt) ? entry.lastReviewedAt : undefined,
    lastDurationMs: typeof entry.lastDurationMs === 'number' && Number.isFinite(entry.lastDurationMs) ? entry.lastDurationMs : undefined,
    legacy: entry.legacy,
  };
}

function entryActivityRank(entry: ReviewEntry): [number, number, number, number] {
  return [
    entry.lastReviewedAt ?? 0,
    entry.attempts ?? 0,
    entry.intervalIdx ?? 0,
    entry.dueAt ?? 0,
  ];
}

function compareRank(a: [number, number, number, number], b: [number, number, number, number]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function reviewEntriesEqual(a: ReviewEntry | undefined, b: ReviewEntry): boolean {
  if (!a) return false;
  return (
    a.dueAt === b.dueAt &&
    a.intervalIdx === b.intervalIdx &&
    (a.lapses || 0) === (b.lapses || 0) &&
    (a.helps || 0) === (b.helps || 0) &&
    (a.attempts || 0) === (b.attempts || 0) &&
    (a.correct || 0) === (b.correct || 0) &&
    (a.spacedCorrect || 0) === (b.spacedCorrect || 0) &&
    a.lastResult === b.lastResult &&
    a.lastReviewedAt === b.lastReviewedAt
  );
}

/**
 * Bidirektionales Merge zweier ReviewStores:
 * - Jede gelernte Karte bleibt erhalten (Union aller Keys).
 * - Bei beidseitigen Reviews gewinnt der jüngste Review-Zeitpunkt (`lastReviewedAt`)
 *   für Fälligkeit und Intervallstufe, während Zähler (`attempts`, `correct`,
 *   `spacedCorrect`, `lapses`, `helps`) per Maximum zusammengeführt werden.
 */
export function mergeReviewStores(
  localStore: ReviewStore,
  remoteStore: ReviewStore,
): { store: ReviewStore; updatedCount: number } {
  const localReviews = localStore?.reviews || {};
  const remoteReviews = remoteStore?.reviews || {};
  const allKeys = new Set([...Object.keys(localReviews), ...Object.keys(remoteReviews)]);
  const merged: Record<string, ReviewEntry> = {};
  let updatedCount = 0;

  for (const key of allKeys) {
    const rawLocal = localReviews[key];
    const rawRemote = remoteReviews[key];
    const validLocal = isValidReviewEntry(rawLocal) ? normalizeReviewEntry(key, rawLocal) : undefined;
    const validRemote = isValidReviewEntry(rawRemote) ? normalizeReviewEntry(key, rawRemote) : undefined;

    if (!validLocal && !validRemote) continue;
    if (validLocal && !validRemote) {
      merged[key] = validLocal;
      continue;
    }
    if (!validLocal && validRemote) {
      merged[key] = validRemote;
      updatedCount++;
      continue;
    }

    const l = validLocal!;
    const r = validRemote!;
    const winner = compareRank(entryActivityRank(r), entryActivityRank(l)) > 0 ? r : l;
    const combined: ReviewEntry = {
      ...winner,
      key,
      attempts: Math.max(l.attempts, r.attempts),
      correct: Math.max(l.correct, r.correct),
      spacedCorrect: Math.max(l.spacedCorrect || 0, r.spacedCorrect || 0),
      lapses: Math.max(l.lapses, r.lapses),
      helps: Math.max(l.helps, r.helps),
      legacy: l.legacy && r.legacy ? true : winner.legacy,
    };
    merged[key] = combined;
    if (!reviewEntriesEqual(l, combined)) {
      updatedCount++;
    }
  }

  return {
    store: { version: 1, reviews: merged },
    updatedCount,
  };
}

function parseReviewStoreFromString(raw: string | undefined): ReviewStore {
  const parsed = safeParseJson<{ reviews?: Record<string, unknown> }>(raw);
  const reviews: Record<string, ReviewEntry> = {};
  if (parsed?.reviews && typeof parsed.reviews === 'object') {
    for (const [k, v] of Object.entries(parsed.reviews)) {
      if (isValidReviewEntry(v)) {
        reviews[k] = normalizeReviewEntry(k, v);
      }
    }
  }
  return { version: 1, reviews };
}

function sanitizeLearningStorage(raw: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k === 'string' && k.startsWith('personal-chess-analyzer-') && typeof v === 'string') {
      out[k] = v;
    }
  }
  return out;
}

function mergeStringArrayJson(aRaw: string | undefined, bRaw: string | undefined): string | null {
  const a = safeParseJson<unknown>(aRaw);
  const b = safeParseJson<unknown>(bRaw);
  const listA = Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
  const listB = Array.isArray(b) ? b.filter((x): x is string => typeof x === 'string') : [];
  if (!Array.isArray(a) && !Array.isArray(b)) return null;
  return JSON.stringify([...new Set([...listA, ...listB])]);
}

function mergeOpeningResponsesJson(aRaw: string | undefined, bRaw: string | undefined): string | null {
  const a = safeParseJson<unknown>(aRaw);
  const b = safeParseJson<unknown>(bRaw);
  const listA = Array.isArray(a) ? (a as OpeningRepertoire[]) : [];
  const listB = Array.isArray(b) ? (b as OpeningRepertoire[]) : [];
  if (!Array.isArray(a) && !Array.isArray(b)) return null;
  const byId = new Map<string, OpeningRepertoire>();
  for (const item of [...listA, ...listB]) {
    if (item && typeof item.id === 'string') {
      byId.set(item.id, item);
    }
  }
  return JSON.stringify([...byId.values()].slice(0, 100));
}

function mergeOpeningSelectionsJson(aRaw: string | undefined, bRaw: string | undefined): string | null {
  const a = safeParseJson<unknown>(aRaw);
  const b = safeParseJson<unknown>(bRaw);
  const listA = Array.isArray(a) ? (a as Array<{ id?: string }>) : [];
  const listB = Array.isArray(b) ? (b as Array<{ id?: string }>) : [];
  if (!Array.isArray(a) && !Array.isArray(b)) return null;
  const byId = new Map<string, unknown>();
  for (const item of [...listA, ...listB]) {
    if (item && typeof item === 'object' && typeof item.id === 'string') {
      byId.set(item.id, item);
    }
  }
  return JSON.stringify([...byId.values()]);
}

function canonicalizeNamespaceKey(key: string, targetNs: string, aliasNamespaces: Set<string>): string {
  if (!targetNs) return key;

  if (key.startsWith(PREFIX_REVIEWS)) {
    const ns = key.slice(PREFIX_REVIEWS.length);
    return aliasNamespaces.has(ns) ? `${PREFIX_REVIEWS}${targetNs}` : key;
  }

  if (key.startsWith(PREFIX_REPERTOIRES)) {
    const rest = key.slice(PREFIX_REPERTOIRES.length);
    const scopeIdx = rest.indexOf(':scope:');
    if (scopeIdx >= 0) {
      const ns = rest.slice(0, scopeIdx);
      const repSuffix = rest.slice(scopeIdx);
      return aliasNamespaces.has(ns) ? `${PREFIX_REPERTOIRES}${targetNs}${repSuffix}` : key;
    }
    return aliasNamespaces.has(rest) ? `${PREFIX_REPERTOIRES}${targetNs}` : key;
  }

  if (key.startsWith(PREFIX_OPENING_RESPONSES)) {
    const ns = key.slice(PREFIX_OPENING_RESPONSES.length);
    return aliasNamespaces.has(ns) ? `${PREFIX_OPENING_RESPONSES}${targetNs}` : key;
  }

  if (key.startsWith(PREFIX_OPENINGS)) {
    const ns = key.slice(PREFIX_OPENINGS.length);
    return aliasNamespaces.has(ns) ? `${PREFIX_OPENINGS}${targetNs}` : key;
  }

  if (key.startsWith(PREFIX_TRAINING_QUALITIES)) {
    const ns = key.slice(PREFIX_TRAINING_QUALITIES.length);
    return aliasNamespaces.has(ns) ? `${PREFIX_TRAINING_QUALITIES}${targetNs}` : key;
  }

  if (key.startsWith(PREFIX_TRAINING_IGNORED)) {
    const ns = key.slice(PREFIX_TRAINING_IGNORED.length);
    return aliasNamespaces.has(ns) ? `${PREFIX_TRAINING_IGNORED}${targetNs}` : key;
  }

  if (key.startsWith(PREFIX_TRAINING_PREFS)) {
    const ns = key.slice(PREFIX_TRAINING_PREFS.length);
    return aliasNamespaces.has(ns) ? `${PREFIX_TRAINING_PREFS}${targetNs}` : key;
  }

  return key;
}

export function mergeLearningStorage(
  localRawInput: Record<string, string>,
  remoteRawInput: Record<string, string>,
  options?: { targetNamespace?: string; aliasNamespaces?: Iterable<string> },
): {
  learningStorage: Record<string, string>;
  totalReviewCards: number;
  reviewCardsUpdated: number;
  repertoireKeysMerged: number;
} {
  const localRaw = sanitizeLearningStorage(localRawInput);
  const remoteRaw = sanitizeLearningStorage(remoteRawInput);
  const targetNs = (options?.targetNamespace || '').trim();
  const aliasNamespaces = new Set<string>(
    [targetNs, 'mein profil', ...(options?.aliasNamespaces || [])]
      .map((s) => s.trim())
      .filter(Boolean),
  );

  // Remap keys from both sides into canonical namespaces when known
  const bucketLocal = new Map<string, string[]>();
  const bucketRemote = new Map<string, string[]>();

  for (const [key, val] of Object.entries(localRaw)) {
    if (key.startsWith(PREFIX_MIGRATED)) continue;
    const canon = canonicalizeNamespaceKey(key, targetNs, aliasNamespaces);
    const list = bucketLocal.get(canon) || [];
    list.push(val);
    bucketLocal.set(canon, list);
  }
  for (const [key, val] of Object.entries(remoteRaw)) {
    if (key.startsWith(PREFIX_MIGRATED)) continue;
    const canon = canonicalizeNamespaceKey(key, targetNs, aliasNamespaces);
    const list = bucketRemote.get(canon) || [];
    list.push(val);
    bucketRemote.set(canon, list);
  }

  const allCanonKeys = new Set([...bucketLocal.keys(), ...bucketRemote.keys()]);
  const mergedStorage: Record<string, string> = {};
  let totalReviewCards = 0;
  let reviewCardsUpdated = 0;
  let repertoireKeysMerged = 0;

  for (const key of allCanonKeys) {
    const localVals = bucketLocal.get(key) || [];
    const remoteVals = bucketRemote.get(key) || [];

    if (key.startsWith(PREFIX_REVIEWS)) {
      let localAgg: ReviewStore = { version: 1, reviews: {} };
      for (const raw of localVals) {
        localAgg = mergeReviewStores(localAgg, parseReviewStoreFromString(raw)).store;
      }
      let remoteAgg: ReviewStore = { version: 1, reviews: {} };
      for (const raw of remoteVals) {
        remoteAgg = mergeReviewStores(remoteAgg, parseReviewStoreFromString(raw)).store;
      }
      const { store, updatedCount } = mergeReviewStores(localAgg, remoteAgg);
      mergedStorage[key] = JSON.stringify(store);
      totalReviewCards += Object.keys(store.reviews).length;
      reviewCardsUpdated += updatedCount;
      continue;
    }

    if (key.startsWith(PREFIX_REPERTOIRES) || key.startsWith(PREFIX_TRAINING_QUALITIES) || key.startsWith(PREFIX_TRAINING_IGNORED) || key === LEGACY_SOLVED_KEY) {
      let mergedJson: string | null = null;
      for (const raw of [...localVals, ...remoteVals]) {
        mergedJson = mergedJson === null ? mergeStringArrayJson(raw, undefined) : mergeStringArrayJson(mergedJson, raw);
      }
      if (mergedJson !== null) {
        mergedStorage[key] = mergedJson;
        if (key.startsWith(PREFIX_REPERTOIRES)) repertoireKeysMerged++;
        continue;
      }
    }

    if (key.startsWith(PREFIX_OPENING_RESPONSES)) {
      let mergedJson: string | null = null;
      for (const raw of [...localVals, ...remoteVals]) {
        mergedJson = mergedJson === null ? mergeOpeningResponsesJson(raw, undefined) : mergeOpeningResponsesJson(mergedJson, raw);
      }
      if (mergedJson !== null) {
        mergedStorage[key] = mergedJson;
        repertoireKeysMerged++;
        continue;
      }
    }

    if (key.startsWith(PREFIX_OPENINGS)) {
      let mergedJson: string | null = null;
      for (const raw of [...localVals, ...remoteVals]) {
        mergedJson = mergedJson === null ? mergeOpeningSelectionsJson(raw, undefined) : mergeOpeningSelectionsJson(mergedJson, raw);
      }
      if (mergedJson !== null) {
        mergedStorage[key] = mergedJson;
        repertoireKeysMerged++;
        continue;
      }
    }

    const fallback = localVals[0] ?? remoteVals[0];
    if (fallback !== undefined) {
      mergedStorage[key] = fallback;
    }
  }

  return {
    learningStorage: mergedStorage,
    totalReviewCards,
    reviewCardsUpdated,
    repertoireKeysMerged,
  };
}

function gameFingerprint(game: GameAnalysis): string {
  const norm = (value: string | undefined) => (value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const moves = (game.moves || []).map((m) => m.uci).join(',');
  return [norm(game.white), norm(game.black), moves || norm(game.pgn)].join('|');
}

function maxMoveDepth(game: GameAnalysis): number {
  let maxDepth = 0;
  for (const move of game.moves || []) {
    const depth = Number(move?.evalBefore?.depth) || 0;
    if (depth > maxDepth) maxDepth = depth;
  }
  return maxDepth;
}

function pickNewerGame(a: GameAnalysis, b: GameAnalysis): GameAnalysis {
  const partialA = Boolean(a.analysisPartial);
  const partialB = Boolean(b.analysisPartial);
  if (partialA !== partialB) return partialB ? a : b;
  const depthA = maxMoveDepth(a);
  const depthB = maxMoveDepth(b);
  if (depthB !== depthA) return depthB > depthA ? b : a;
  const createdA = Date.parse(a.createdAt || '') || 0;
  const createdB = Date.parse(b.createdAt || '') || 0;
  return createdB > createdA ? b : a;
}

export function mergeGamesList(
  localGames: GameAnalysis[],
  remoteGames: GameAnalysis[],
): { games: GameAnalysis[]; gamesAdded: number } {
  const result = (localGames || []).map((g) => annotateMissedOpportunities(migrateGameTime(g)));
  const idIndex = new Map<string, number>();
  const fpBuckets = new Map<string, number[]>();

  result.forEach((g, idx) => {
    idIndex.set(g.id, idx);
    const fp = gameFingerprint(g);
    const list = fpBuckets.get(fp) || [];
    list.push(idx);
    fpBuckets.set(fp, list);
  });

  let gamesAdded = 0;

  for (const rawRemote of remoteGames || []) {
    if (!rawRemote || typeof rawRemote.id !== 'string' || !rawRemote.id) continue;
    const remote = annotateMissedOpportunities(migrateGameTime(rawRemote));

    let matchIdx = idIndex.get(remote.id);
    if (matchIdx === undefined) {
      const fp = gameFingerprint(remote);
      const candidates = fpBuckets.get(fp) || [];
      matchIdx = candidates.find((idx) => {
        const existing = result[idx];
        if (isStableGameId(remote.id) && isStableGameId(existing.id)) return false;
        return sameSourceIdentity(existing, remote);
      });
    }

    if (matchIdx === undefined) {
      const insertIdx = result.length;
      result.push(remote);
      idIndex.set(remote.id, insertIdx);
      const fp = gameFingerprint(remote);
      const list = fpBuckets.get(fp) || [];
      list.push(insertIdx);
      fpBuckets.set(fp, list);
      gamesAdded++;
    } else {
      const existing = result[matchIdx];
      const winner = pickNewerGame(existing, remote);
      const loser = winner === existing ? remote : existing;
      result[matchIdx] = {
        ...winner,
        createdAt: existing.createdAt || remote.createdAt,
        playedAt: winner.playedAt || loser.playedAt,
        previousIds: mergePreviousIds(loser, winner),
      };
    }
  }

  result.sort((a, b) => {
    const da = (a.playedAt || a.date || a.createdAt || '');
    const db = (b.playedAt || b.date || b.createdAt || '');
    return db.localeCompare(da);
  });

  return { games: result, gamesAdded };
}

function pickPreferredPlayerName(localName: string | undefined, remoteName: string | undefined): string {
  const def = normalizePlayerName(APP_SETTINGS_DEFAULTS.playerName);
  const lTrim = (localName || '').trim();
  const rTrim = (remoteName || '').trim();
  if (lTrim && normalizePlayerName(lTrim) !== def) return lTrim;
  if (rTrim && normalizePlayerName(rTrim) !== def) return rTrim;
  return lTrim || rTrim || APP_SETTINGS_DEFAULTS.playerName;
}

export function mergeSyncPayloads(
  local: SyncPayload,
  remote: SyncPayload,
): { mergedPayload: SyncPayload; summary: SyncSummary } {
  const localSettings = normalizeAppSettings(local.settings);
  const remoteSettings = normalizeAppSettings(remote.settings);
  const effectivePlayerName = pickPreferredPlayerName(localSettings.playerName, remoteSettings.playerName);

  // Host (`local`) keeps its profileId so PC never loses its own identity;
  // peer adopts this unified profileId upon receiving `mergedPayload`.
  const targetProfileId = localSettings.profileId || remoteSettings.profileId;
  const aliasNamespaces = [
    localSettings.profileId,
    remoteSettings.profileId,
    normalizePlayerName(localSettings.playerName),
    normalizePlayerName(remoteSettings.playerName),
    normalizePlayerName(effectivePlayerName),
    ...localSettings.playerAliases.map(normalizePlayerName),
    ...remoteSettings.playerAliases.map(normalizePlayerName),
  ].filter(Boolean);

  const mergedSettings = normalizeAppSettings(
    {
      ...localSettings,
      profileId: targetProfileId,
      playerName: effectivePlayerName,
      chessComUsername: localSettings.chessComUsername.trim() || remoteSettings.chessComUsername.trim(),
      lichessUsername: localSettings.lichessUsername.trim() || remoteSettings.lichessUsername.trim(),
      playerAliases: [...new Set([
        ...localSettings.playerAliases,
        ...remoteSettings.playerAliases,
        localSettings.playerName,
        remoteSettings.playerName,
      ])].filter(Boolean),
      accountAliases: {
        chessCom: [...new Set([
          ...localSettings.accountAliases.chessCom,
          ...remoteSettings.accountAliases.chessCom,
          localSettings.chessComUsername,
          remoteSettings.chessComUsername,
        ])].filter(Boolean),
        lichess: [...new Set([
          ...localSettings.accountAliases.lichess,
          ...remoteSettings.accountAliases.lichess,
          localSettings.lichessUsername,
          remoteSettings.lichessUsername,
        ])].filter(Boolean),
      },
      stockfishPath: localSettings.stockfishPath,
    },
    localSettings.stockfishPath,
  );

  const { games, gamesAdded } = mergeGamesList(local.games || [], remote.games || []);
  const storageMerge = mergeLearningStorage(local.learningStorage || {}, remote.learningStorage || {}, {
    targetNamespace: targetProfileId,
    aliasNamespaces,
  });

  const syncedAt = new Date().toISOString();
  const mergedPayload: SyncPayload = {
    format: 'personal-chess-analyzer-lan-sync',
    version: 1,
    sentAt: syncedAt,
    deviceName: local.deviceName || 'Desktop PC',
    games,
    settings: mergedSettings,
    learningStorage: storageMerge.learningStorage,
  };

  const summary: SyncSummary = {
    peerDeviceName: remote.deviceName || 'Mobilgerät',
    totalGames: games.length,
    gamesAdded,
    totalReviewCards: storageMerge.totalReviewCards,
    reviewCardsUpdated: storageMerge.reviewCardsUpdated,
    repertoireKeysMerged: storageMerge.repertoireKeysMerged,
    syncedAt,
  };

  return { mergedPayload, summary };
}

export function isValidSyncPayload(raw: unknown): raw is SyncPayload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const candidate = raw as Partial<SyncPayload>;
  if (
    candidate.format !== 'personal-chess-analyzer-lan-sync' ||
    candidate.version !== 1 ||
    !Array.isArray(candidate.games) ||
    candidate.games.length > 20000 ||
    !candidate.settings ||
    typeof candidate.settings !== 'object' ||
    typeof candidate.learningStorage !== 'object' ||
    candidate.learningStorage === null ||
    Array.isArray(candidate.learningStorage)
  ) {
    return false;
  }
  for (const [k, v] of Object.entries(candidate.learningStorage)) {
    if (!k.startsWith('personal-chess-analyzer-') || typeof v !== 'string') {
      return false;
    }
  }
  for (const game of candidate.games) {
    if (
      !game ||
      typeof game !== 'object' ||
      typeof game.id !== 'string' ||
      !game.id ||
      typeof game.pgn !== 'string' ||
      typeof game.white !== 'string' ||
      typeof game.black !== 'string' ||
      !Array.isArray(game.moves) ||
      !game.summaryWhite ||
      !game.summaryBlack
    ) {
      return false;
    }
    for (const move of game.moves) {
      if (
        !move ||
        !move.evalBefore ||
        !move.evalAfter ||
        !Number.isFinite(move.ply) ||
        !Number.isFinite(move.evalBefore.scoreCp) ||
        !Number.isFinite(move.evalAfter.scoreCp) ||
        typeof move.san !== 'string' ||
        typeof move.uci !== 'string'
      ) {
        return false;
      }
    }
  }
  return true;
}
