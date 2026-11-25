const pending = new Map<string, string>();
const eventName = 'pca-storage-status';
const announce = () => (globalThis as unknown as { window?: Partial<EventTarget> }).window?.dispatchEvent?.(new Event(eventName));
export function hasPendingStorageWrites(): boolean { return pending.size > 0; }
export function readLearningItem(key: string): string | null { return pending.get(key) ?? localStorage.getItem(key); }
export function writeLearningItem(key: string, value: string): boolean {
  try { localStorage.setItem(key, value); pending.delete(key); return true; }
  catch { pending.set(key, value); return false; }
  finally { announce(); }
}
export function retryLearningWrites(): boolean {
  for (const [key, value] of [...pending]) writeLearningItem(key, value);
  return pending.size === 0;
}
export function snapshotLearningStorage(): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith('personal-chess-analyzer-')) result[key] = localStorage.getItem(key)!;
  }
  for (const [key, value] of pending) result[key] = value;
  return result;
}
export function replaceLearningStorage(snapshot: Record<string, string>): void {
  const previous = snapshotLearningStorage();
  const write = (values: Record<string, string>) => {
    const existing = Object.keys(snapshotLearningStorage());
    // Write new values first so a quota error preserves the old profile.
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
    for (const key of existing) if (!(key in values)) localStorage.removeItem(key);
  };
  try { write(snapshot); pending.clear(); }
  catch (error) {
    try {
      for (const key of Object.keys(snapshotLearningStorage())) if (!(key in previous)) localStorage.removeItem(key);
      write(previous);
    } catch { for (const [key, value] of Object.entries(previous)) pending.set(key, value); }
    throw error;
  } finally { announce(); }
}
export { eventName as STORAGE_STATUS_EVENT };
