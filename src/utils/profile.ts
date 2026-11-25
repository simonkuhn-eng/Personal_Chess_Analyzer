import type { AppSettings } from '../types/chess';
import { readLearningItem, writeLearningItem } from './learningStorage';

let active: Pick<AppSettings, 'profileId' | 'playerName' | 'chessComUsername' | 'lichessUsername' | 'playerAliases' | 'accountAliases'> | null = null;
export const normalizePlayerName = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

export function configureProfile(settings: typeof active): void { active = settings; }

export function playerNames(target: string, site?: string): string[] {
  const name = normalizePlayerName(target);
  if (active && (name === normalizePlayerName(active.playerName) || name === active.profileId)) {
    const platform = /chess\.com/i.test(site || '') ? 'chessCom' : /lichess\.org/i.test(site || '') ? 'lichess' : null;
    if (platform) {
      const account = platform === 'chessCom' ? active.chessComUsername : active.lichessUsername;
      const linked = [account, ...active.accountAliases[platform]].map(normalizePlayerName).filter(Boolean);
      return linked.length ? [...new Set(linked)] : [active.playerName, ...active.playerAliases].map(normalizePlayerName).filter(Boolean);
    }
    return [...new Set([active.playerName, active.chessComUsername, active.lichessUsername, ...active.playerAliases].map(normalizePlayerName).filter(Boolean))];
  }
  return name ? [name] : [];
}

export function profileNamespace(target: string): string {
  return active && normalizePlayerName(target) === normalizePlayerName(active.playerName) ? active.profileId : normalizePlayerName(target);
}

/** Copy legacy namespaces, never delete originals. Latest review wins conflicts;
 * favorites are unioned, explicit current preferences win. Retryable on quota. */
export function migrateProfileStorage(settings: NonNullable<typeof active>): void {
  const aliases = [...new Set([settings.playerName, ...settings.playerAliases].map(normalizePlayerName).filter(Boolean))];
  const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter((key): key is string => !!key && key.startsWith('personal-chess-analyzer-') && !key.startsWith('personal-chess-analyzer-migrated:'));
  for (const key of keys) {
    const marker = `personal-chess-analyzer-migrated:${settings.profileId}:${key}`;
    if (localStorage.getItem(marker) === '1') continue;
    const alias = aliases.find(name => key.endsWith(':' + name) || key.includes(':' + name + ':scope:'));
    if (!alias) continue;
    const offset = key.indexOf(':' + alias);
    const destination = key.slice(0, offset + 1) + settings.profileId + key.slice(offset + alias.length + 1);
    if (destination === key) continue;
    const raw = localStorage.getItem(key);
    if (raw === null) continue;
    const existing = readLearningItem(destination);
    if (existing === null) { if (writeLearningItem(destination, raw)) writeLearningItem(marker, '1'); continue; }
    let next: unknown;
    try {
      const old = JSON.parse(raw), current = JSON.parse(existing);
      if (key.includes('-reviews-v1:') && old.reviews && current.reviews) {
        const reviews = { ...old.reviews, ...current.reviews };
        for (const [id, entry] of Object.entries(old.reviews) as [string, { lastReviewedAt?: number }][]) {
          if ((entry.lastReviewedAt ?? 0) > (current.reviews[id]?.lastReviewedAt ?? 0)) reviews[id] = entry;
        }
        next = { version: 1, reviews };
      } else if ((key.includes('-repertoires-v2:') && !key.includes(':scope:') || key.includes('-training-ignored-v1:')) && Array.isArray(old) && Array.isArray(current)) next = [...new Set([...current, ...old])];
      else { writeLearningItem(marker, '1'); continue; }
    } catch { continue; }
    if (writeLearningItem(destination, JSON.stringify(next))) writeLearningItem(marker, '1');
  }
}
