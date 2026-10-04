import { env } from 'cloudflare:workers';
import { validateLedger, tripSchema, type Ledger, type Trip } from './model';
import { notifyMembers } from './notifications';

export class RequestError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

export function owner(request: Request) {
  const id = request.headers.get('oai-authenticated-user-id');
  if (!id || id.length > 512) throw new Error('UNAUTHORIZED');
  return id;
}

export function receiptKey(user: string, id: string) {
  return `${encodeURIComponent(user)}/${id}`;
}

// Enforce the limit during reading, including requests without Content-Length.
export async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    throw new RequestError('This upload is too large.', 413);
  }
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new RequestError('This upload is too large.', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function db() {
  const e = env as unknown as { DB: D1Database };
  if (!e.DB) throw new Error('Storage unavailable');
  return e.DB;
}

export function bucket() {
  const e = env as unknown as { RECEIPTS: R2Bucket };
  if (!e.RECEIPTS) throw new Error('Receipt storage unavailable');
  return e.RECEIPTS;
}

type ProfileRow = { id: string; email: string; display_name: string; created_at: string };
export type Profile = { id: string; email: string; displayName: string; createdAt: string };
type StoredTrip = { id: string; owner: string; data: string };
type MembershipRow = { trip_id: string; user_id: string; member_id: string; email: string | null };

export async function ensureProfile(request: Request): Promise<Profile> {
  const id = owner(request);
  const email = request.headers.get('oai-authenticated-user-email')?.trim().toLowerCase();
  if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('UNAUTHORIZED');
  let name = email.split('@')[0];
  const fullName = request.headers.get('oai-authenticated-user-full-name');
  if (fullName) {
    try { name = decodeURIComponent(fullName).trim() || name; } catch { /* Fall back to verified email. */ }
  }
  const createdAt = new Date().toISOString();
  await db().prepare('INSERT INTO profiles (id, email, display_name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET email = excluded.email').bind(id, email, name.slice(0, 80), createdAt).run();
  const profile = await db().prepare('SELECT id, email, display_name, created_at FROM profiles WHERE id = ?').bind(id).first<ProfileRow>();
  if (!profile) throw new Error('Storage unavailable');
  return { id: profile.id, email: profile.email, displayName: profile.display_name, createdAt: profile.created_at };
}

export async function readLedger(id: string): Promise<{ data: Ledger; revision: number }> {
  const results = await db().batch([
    db().prepare('SELECT t.id, t.owner, t.data FROM trips t WHERE t.owner = ? OR EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = t.id AND m.user_id = ?) ORDER BY t.id').bind(id, id),
    db().prepare('SELECT COALESCE((SELECT revision FROM sync_state WHERE id = 1), 0) AS revision'),
    db().prepare('SELECT m.trip_id, m.user_id, m.member_id, p.email FROM memberships m LEFT JOIN profiles p ON p.id = m.user_id JOIN trips t ON t.id = m.trip_id WHERE t.owner = ? OR EXISTS (SELECT 1 FROM memberships access WHERE access.trip_id = t.id AND access.user_id = ?)').bind(id, id),
  ]);
  const links = results[2].results as MembershipRow[];
  const trips = (results[0].results as StoredTrip[]).map(row => {
    const trip = { ...JSON.parse(row.data), ownerId: row.owner } as Trip;
    for (const member of trip.members) {
      const link = links.find(value => value.trip_id === trip.id && value.member_id === member.id);
      if (link) { member.userId = link.user_id; member.email = link.email || member.email; }
    }
    return trip;
  });
  const revision = (results[1].results as { revision: number }[])[0]?.revision || 0;
  return { data: { trips }, revision };
}

export async function tripAccess(user: string, tripId: string): Promise<boolean> {
  const row = await db().prepare('SELECT 1 AS allowed FROM trips t WHERE t.id = ? AND (t.owner = ? OR EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = t.id AND m.user_id = ?))').bind(tripId, user, user).first();
  return !!row;
}

export async function receiptAccess(user: string, id: string): Promise<{ owner: string; tripId: string } | null> {
  const row = await db().prepare('SELECT r.owner, r.trip_id FROM receipts r JOIN trips t ON t.id = r.trip_id WHERE r.id = ? AND (t.owner = ? OR EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = t.id AND m.user_id = ?))').bind(id, user, user).first<{ owner: string; trip_id: string }>();
  return row ? { owner: row.owner, tripId: row.trip_id } : null;
}

export async function writeLedger(id: string, data: unknown, revision: unknown) {
  const ledger = validateLedger(data);
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid revision');
  if (new TextEncoder().encode(JSON.stringify(ledger)).byteLength > 1_500_000) throw new RequestError('Your ledger is too large.', 413);
  const tripIds = ledger.trips.map(trip => trip.id);
  const placeholders = tripIds.map(() => '?').join(',');
  const existingRows = tripIds.length ? await db().prepare(`SELECT id, owner, data FROM trips WHERE id IN (${placeholders})`).bind(...tripIds).all<StoredTrip>() : { results: [] as StoredTrip[] };
  const linkedRows = tripIds.length ? await db().prepare(`SELECT m.trip_id, m.user_id, m.member_id, p.email FROM memberships m LEFT JOIN profiles p ON p.id = m.user_id WHERE m.trip_id IN (${placeholders})`).bind(...tripIds).all<MembershipRow>() : { results: [] as MembershipRow[] };
  const receiptRows = tripIds.length ? await db().prepare(`SELECT id, trip_id FROM receipts WHERE trip_id IN (${placeholders})`).bind(...tripIds).all<{ id: string; trip_id: string }>() : { results: [] as { id: string; trip_id: string }[] };
  const profile = await db().prepare('SELECT id, email, display_name, created_at FROM profiles WHERE id = ?').bind(id).first<ProfileRow>();
  const existing = new Map(existingRows.results.map(row => [row.id, row]));
  const newTrips: Trip[] = [];
  const changedTrips: Trip[] = [];

  for (const trip of ledger.trips) {
    const stored = existing.get(trip.id);
    const links = linkedRows.results.filter(row => row.trip_id === trip.id);
    if (stored) {
      if (stored.owner !== id && !links.some(link => link.user_id === id)) throw new RequestError('You do not have access to this trip.', 403);
      const previous = tripSchema.parse(JSON.parse(stored.data));
      if (trip.currency !== previous.currency) throw new RequestError('A saved trip’s settlement currency cannot be changed.');
      if (links.some(link => !trip.members.some(member => member.id === link.member_id))) throw new RequestError('An account-linked traveller cannot be removed.');
      trip.ownerId = stored.owner;
      for (const member of trip.members) {
        const old = previous.members.find(value => value.id === member.id);
        const link = links.find(value => value.member_id === member.id);
        if (link) {
          member.userId = link.user_id;
          member.email = link.email || old?.email;
        } else {
          delete member.userId;
          member.email = old?.email;
        }
      }
      if (JSON.stringify(trip) !== JSON.stringify({ ...previous, ownerId: stored.owner })) changedTrips.push(trip);
    } else {
      trip.ownerId = id;
      for (const member of trip.members) { delete member.userId; delete member.email; }
      const firstMember = trip.members[0];
      firstMember.userId = id;
      if (profile) {
        firstMember.email = profile.email;
        firstMember.name = profile.display_name.slice(0, 50);
      }
      newTrips.push(trip);
    }
    for (const entry of [...trip.expenses, ...trip.drafts]) {
      if (entry.receiptId && !receiptRows.results.some(receipt => receipt.id === entry.receiptId && receipt.trip_id === trip.id)) {
        throw new RequestError('This receipt does not belong to the trip.');
      }
    }
  }

  validateLedger(ledger);
  if (new TextEncoder().encode(JSON.stringify(ledger)).byteLength > 1_500_000) throw new RequestError('Your ledger is too large.', 413);
  const marker = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    db().prepare("INSERT OR IGNORE INTO sync_state (id, revision, last_write) VALUES (1, 0, '')"),
    db().prepare('UPDATE sync_state SET revision = revision + 1, last_write = ? WHERE id = 1 AND revision = ?').bind(marker, revision),
  ];
  for (const trip of ledger.trips) {
    statements.push(db().prepare('INSERT INTO trips (id, owner, data) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM sync_state WHERE id = 1 AND last_write = ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data WHERE EXISTS (SELECT 1 FROM sync_state WHERE id = 1 AND last_write = ?) AND (trips.owner = ? OR EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = trips.id AND m.user_id = ?))').bind(trip.id, trip.ownerId!, JSON.stringify(trip), marker, marker, id, id));
  }
  for (const trip of newTrips) {
    statements.push(db().prepare('INSERT INTO memberships (trip_id, user_id, member_id) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM sync_state WHERE id = 1 AND last_write = ?)').bind(trip.id, id, trip.members[0].id, marker));
  }
  const results = await db().batch(statements);
  if (!results[1].meta.changes) throw new Error('CONFLICT');
  for (const trip of changedTrips) {
    await notifyMembers(trip.id, id, `${trip.name} updated`, 'Someone updated your shared holiday. Open TripTab to review expenses and balances.').catch(() => {
      console.warn('TripTab could not queue a holiday update notification.');
    });
  }
  // Omitted trips remain available: ledger saves never delete shared records.
  return readLedger(id);
}

export function failure(e: unknown) {
  console.error('TripTab request failed', e);
  const m = e instanceof Error ? e.message : '';
  const error = e instanceof RequestError ? e.message
    : m === 'UNAUTHORIZED' ? 'Sign in with ChatGPT to open your ledger.'
    : m === 'CONFLICT' ? 'Your ledger changed in another tab or in ChatGPT. Refresh before saving again.'
    : 'Unable to complete this request. Check your entries and try again.';
  const status = e instanceof RequestError ? e.status : m === 'UNAUTHORIZED' ? 401 : m === 'CONFLICT' ? 409 : 400;
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

export function sameOrigin(r: Request) {
  if (r.headers.get('origin') !== new URL(r.url).origin) throw new Error('Invalid origin');
}
