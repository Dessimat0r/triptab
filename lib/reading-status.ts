import type { Draft } from './model';

/**
 * Per-draft receipt reading status (F-11 follow-up). A reading keeps going on
 * the server after the phone locks or the page reloads, but the page that
 * started it forgets. This remembers, per account and draft, that a reading
 * started and what the draft looked like then. The draft changes when the
 * server stores the proposal, so an unchanged draft past the server's time
 * limit means the reading did not finish.
 *
 * Browser storage is a convenience only: if it is unavailable the row simply
 * shows its saved status, as before.
 */
export const READING_LIMIT_MS = 120_000; // the server stops at 90 s; allow for the final save
const PREFIX = 'triptab:reading:';

type Entry = { tripId: string; startedAt: number; fingerprint: string };
export type ReadingState = 'reading' | 'stalled' | undefined;
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** A small, stable fingerprint of a draft's saved content. */
export function draftFingerprint(draft: Draft) {
  const text = JSON.stringify(draft, Object.keys(flatten(draft)).sort());
  let hash = 5381;
  for (let index = 0; index < text.length; index++) hash = (hash * 33 + text.charCodeAt(index)) >>> 0;
  return `${text.length}:${hash.toString(36)}`;
}
function flatten(value: unknown, keys: Record<string, true> = {}): Record<string, true> {
  if (value && typeof value === 'object') for (const [key, inner] of Object.entries(value)) { keys[key] = true; flatten(inner, keys); }
  return keys;
}

function storage(): Store | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; }
}
function readAll(accountId: string, store = storage()): Record<string, Entry> {
  try {
    const value = JSON.parse(store?.getItem(PREFIX + accountId) || '{}') as Record<string, Entry>;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
function writeAll(accountId: string, entries: Record<string, Entry>, store = storage()) {
  try {
    if (Object.keys(entries).length) store?.setItem(PREFIX + accountId, JSON.stringify(entries));
    else store?.removeItem(PREFIX + accountId);
  } catch { /* storage full or blocked: status falls back to the saved draft */ }
}

export function markReading(accountId: string, tripId: string, draft: Draft, now = Date.now(), store = storage()) {
  if (!accountId) return;
  const entries = readAll(accountId, store);
  // Old entries are dropped so storage never grows without bound.
  for (const [id, entry] of Object.entries(entries)) if (now - entry.startedAt > READING_LIMIT_MS * 10) delete entries[id];
  entries[draft.id] = { tripId, startedAt: now, fingerprint: draftFingerprint(draft) };
  writeAll(accountId, entries, store);
}

export function clearReading(accountId: string, draftId: string, store = storage()) {
  if (!accountId) return;
  const entries = readAll(accountId, store);
  if (!(draftId in entries)) return;
  delete entries[draftId];
  writeAll(accountId, entries, store);
}

/**
 * 'reading' while the server may still be reading this draft; 'stalled' when
 * the time limit passed and the draft never changed; undefined otherwise
 * (no reading, or the proposal arrived and changed the draft).
 */
export function readingState(accountId: string | undefined, tripId: string, draft: Draft, now = Date.now(), store = storage()): ReadingState {
  if (!accountId) return undefined;
  const entry = readAll(accountId, store)[draft.id];
  if (!entry || entry.tripId !== tripId) return undefined;
  if (entry.fingerprint !== draftFingerprint(draft)) return undefined;
  return now - entry.startedAt <= READING_LIMIT_MS ? 'reading' : 'stalled';
}
