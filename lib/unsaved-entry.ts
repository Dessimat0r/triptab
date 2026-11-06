/**
 * Recovery of an unsaved manual expense after the app was closed or killed
 * (F-18). Stored per account and trip in this browser only; reading or
 * writing never throws, and a saved entry is never resumed as a second copy.
 */
const PREFIX = 'triptab:unsaved-entry:v1:';
type Stored<T> = { savedAt: string; entry: T };
const key = (accountId: string, tripId: string) => `${PREFIX}${accountId}:${tripId}`;

export function readUnsavedEntry<T extends { id: string }>(storage: Storage | undefined, accountId?: string, tripId?: string): Stored<T> | null {
  if (!storage || !accountId || !tripId) return null;
  try {
    const value = JSON.parse(storage.getItem(key(accountId, tripId)) ?? 'null') as Stored<T> | null;
    return value && typeof value.savedAt === 'string' && value.entry && typeof value.entry.id === 'string' ? value : null;
  } catch { return null; }
}
export function writeUnsavedEntry<T>(storage: Storage | undefined, accountId: string, tripId: string, entry: T, now = new Date()) {
  try { storage?.setItem(key(accountId, tripId), JSON.stringify({ savedAt: now.toISOString(), entry })); } catch { /* Private mode or full storage: recovery is a convenience. */ }
}
export function clearUnsavedEntry(storage: Storage | undefined, accountId?: string, tripId?: string) {
  if (!accountId || !tripId) return;
  try { storage?.removeItem(key(accountId, tripId)); } catch { /* Ignore unavailable storage. */ }
}
