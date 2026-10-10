import { accountAuditStatement, activityStatements, type ActivityChange } from './audit';
import type { Trip } from './model';

/** Holiday archive, leave, ownership transfer and deletion (audit F-23). */
export class TripLifecycleError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

export const MAX_OPEN_TRIPS = 50;
type Actor = { id: string; displayName: string };

/** Holidays in an account's open list. Archived holidays stay accessible elsewhere. */
export const OPEN_TRIP_IDS = `SELECT id FROM trips WHERE owner = ? UNION SELECT trip_id FROM memberships WHERE user_id = ?
  EXCEPT SELECT trip_id FROM trip_archives WHERE user_id = ?`;
export const openTripBindings = (user: string) => [user, user, user];

const access = '(t.owner = ? OR EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = t.id AND m.user_id = ?))';
// A provider identity linked to a different account must never act as itself.
const identity = 'NOT EXISTS (SELECT 1 FROM auth_links WHERE oai_user_id = ? AND user_id <> ?)';
const marked = 'EXISTS (SELECT 1 FROM sync_state WHERE id = 1 AND last_write = ?)';

function tripId(value: unknown) {
  if (typeof value !== 'string' || !value || value.length > 100) throw new TripLifecycleError('Choose a valid holiday.');
  return value;
}
function summary(trip: Trip): Record<string, unknown> {
  const metadata: Record<string, unknown> = { ...trip };
  for (const key of ['members', 'expenses', 'payments', 'drafts']) delete metadata[key];
  return metadata;
}

export type ArchivedTrip = { id: string; name: string; currency: string; startDate?: string; endDate?: string; travellers: number; archivedAt: string; owner: boolean };
export async function listArchivedTrips(database: D1Database, user: string): Promise<ArchivedTrip[]> {
  const rows = await database.prepare(`SELECT t.id, t.owner, a.archived_at, json_extract(t.data, '$.name') AS name,
      json_extract(t.data, '$.currency') AS currency, json_extract(t.data, '$.startDate') AS start_date,
      json_extract(t.data, '$.endDate') AS end_date, json_array_length(t.data, '$.members') AS travellers
    FROM trip_archives a JOIN trips t ON t.id = a.trip_id WHERE a.user_id = ? AND ${access}
    ORDER BY a.archived_at DESC, t.id LIMIT 500`).bind(user, user, user)
    .all<{ id: string; owner: string; archived_at: string; name: string; currency: string; start_date: string | null; end_date: string | null; travellers: number }>();
  return rows.results.map(row => ({ id: row.id, name: String(row.name ?? ''), currency: String(row.currency ?? ''),
    ...(row.start_date ? { startDate: row.start_date } : {}), ...(row.end_date ? { endDate: row.end_date } : {}),
    travellers: Number(row.travellers) || 0, archivedAt: row.archived_at, owner: row.owner === user }));
}

/** Personal: other travellers keep seeing the holiday and notifications continue. */
export async function setTripArchived(database: D1Database, actor: Actor, rawTripId: unknown, archived: boolean) {
  const id = tripId(rawTripId);
  const trip = await database.prepare(`SELECT json_extract(t.data, '$.name') AS name, EXISTS (SELECT 1 FROM trip_archives a WHERE a.trip_id = t.id AND a.user_id = ?) AS archived
    FROM trips t WHERE t.id = ? AND ${access}`).bind(actor.id, id, actor.id, actor.id).first<{ name: string; archived: number }>();
  if (!trip) throw new TripLifecycleError('You do not have access to this holiday.', 403);
  if (!!trip.archived === archived) return { archived };
  const holidayName = String(trip.name ?? '').slice(0, 100);
  const audit = accountAuditStatement(database, { userId: actor.id, actorName: actor.displayName, entityType: 'trip', entityId: id,
    action: 'update', before: { archived: !archived, holidayName }, after: { archived, holidayName } });
  if (archived) {
    await database.batch([
      database.prepare(`INSERT INTO trip_archives (user_id, trip_id, archived_at) SELECT ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM trips t WHERE t.id = ? AND ${access}) AND ${identity}
        ON CONFLICT(user_id, trip_id) DO NOTHING`).bind(actor.id, id, new Date().toISOString(), id, actor.id, actor.id, actor.id, actor.id),
      audit,
    ]);
    return { archived };
  }
  // Restoring must keep the open list within the full-ledger save limit.
  const results = await database.batch([
    database.prepare(`DELETE FROM trip_archives WHERE user_id = ? AND trip_id = ? AND ${identity}
      AND (SELECT COUNT(*) FROM (${OPEN_TRIP_IDS})) < ?`).bind(actor.id, id, actor.id, actor.id, ...openTripBindings(actor.id), MAX_OPEN_TRIPS),
    audit,
  ]);
  if (!results[0].meta.changes && await database.prepare('SELECT 1 FROM trip_archives WHERE user_id = ? AND trip_id = ?').bind(actor.id, id).first()) {
    throw new TripLifecycleError(`You already have ${MAX_OPEN_TRIPS} open holidays. Archive one before restoring another.`, 409);
  }
  return { archived };
}

/** Advance the shared save token so ledgers loaded before this change must refresh. */
function advanceRevision(database: D1Database, actor: Actor, marker: string, condition: string, bindings: unknown[]) {
  return database.prepare(`UPDATE sync_state SET revision = revision + 1, last_write = ? WHERE id = 1 AND ${identity} AND ${condition}`)
    .bind(marker, actor.id, actor.id, ...bindings);
}
async function ensureSyncState(database: D1Database) {
  await database.prepare("INSERT OR IGNORE INTO sync_state (id, revision, last_write) VALUES (1, 0, '')").run();
}

/**
 * The traveller stays on the holiday as an unlinked person, so every expense,
 * payment and balance that involves them is unchanged. Only the account link,
 * its contact email and the leaver's personal settings for the holiday go.
 */
export async function leaveTrip(database: D1Database, actor: Actor, rawTripId: unknown) {
  const id = tripId(rawTripId);
  const row = await database.prepare(`SELECT t.owner, t.data, m.member_id FROM trips t
    LEFT JOIN memberships m ON m.trip_id = t.id AND m.user_id = ? WHERE t.id = ?`).bind(actor.id, id)
    .first<{ owner: string; data: string; member_id: string | null }>();
  if (!row || (row.owner !== actor.id && !row.member_id)) throw new TripLifecycleError('You are not a traveller on this holiday.', 403);
  if (row.owner === actor.id) throw new TripLifecycleError('As the owner, transfer this holiday to another traveller before leaving it. You can also archive or delete it.', 409);
  const trip = JSON.parse(row.data) as Trip;
  const member = trip.members.find(value => value.id === row.member_id);
  if (!member) throw new TripLifecycleError('Your traveller entry changed. Refresh the holiday and try again.', 409);
  const unlinked = { ...member };
  delete unlinked.userId; delete unlinked.email;
  const next = { ...trip, members: trip.members.map(value => value.id === member.id ? unlinked : value) };
  await ensureSyncState(database);
  const marker = crypto.randomUUID();
  const results = await database.batch([
    advanceRevision(database, actor, marker, `EXISTS (SELECT 1 FROM trips t JOIN memberships m ON m.trip_id = t.id
      WHERE t.id = ? AND t.data = ? AND t.owner <> ? AND m.user_id = ? AND m.member_id = ?)`, [id, row.data, actor.id, actor.id, member.id]),
    database.prepare(`DELETE FROM memberships WHERE trip_id = ? AND user_id = ? AND ${marked}`).bind(id, actor.id, marker),
    database.prepare(`UPDATE trips SET data = ? WHERE id = ? AND ${marked}`).bind(JSON.stringify(next), id, marker),
    database.prepare(`DELETE FROM trip_archives WHERE trip_id = ? AND user_id = ? AND ${marked}`).bind(id, actor.id, marker),
    database.prepare(`DELETE FROM trip_language_preferences WHERE trip_id = ? AND user_id = ? AND ${marked}`).bind(id, actor.id, marker),
    ...activityStatements(database, [{ tripId: id, entityType: 'member', entityId: member.id, action: 'update',
      before: { ...member, userId: actor.id }, after: unlinked }], actor, marker, 'current'),
  ]);
  if (!results[0].meta.changes) throw new TripLifecycleError('This holiday changed while you were leaving. Refresh and try again.', 409);
  return { tripName: trip.name, memberName: member.name };
}

/** The new owner must already have joined with their own account. */
export async function transferTripOwnership(database: D1Database, actor: Actor, rawTripId: unknown, rawMemberId: unknown) {
  const id = tripId(rawTripId);
  if (typeof rawMemberId !== 'string' || !rawMemberId || rawMemberId.length > 100) throw new TripLifecycleError('Choose a traveller.');
  const row = await database.prepare('SELECT owner, data FROM trips WHERE id = ?').bind(id).first<{ owner: string; data: string }>();
  if (!row || row.owner !== actor.id) throw new TripLifecycleError('Only the holiday owner can transfer it.', 403);
  const target = await database.prepare('SELECT user_id FROM memberships WHERE trip_id = ? AND member_id = ?')
    .bind(id, rawMemberId).first<{ user_id: string }>();
  if (!target) throw new TripLifecycleError('Choose a traveller who has joined this holiday with their own account.', 409);
  if (target.user_id === actor.id) throw new TripLifecycleError('You already own this holiday.');
  const trip = JSON.parse(row.data) as Trip;
  const next = { ...trip, ownerId: target.user_id };
  await ensureSyncState(database);
  const marker = crypto.randomUUID();
  const results = await database.batch([
    advanceRevision(database, actor, marker, `EXISTS (SELECT 1 FROM trips WHERE id = ? AND owner = ? AND data = ?)
      AND EXISTS (SELECT 1 FROM memberships WHERE trip_id = ? AND member_id = ? AND user_id = ?)`, [id, actor.id, row.data, id, rawMemberId, target.user_id]),
    database.prepare(`UPDATE trips SET owner = ?, data = ? WHERE id = ? AND ${marked}`).bind(target.user_id, JSON.stringify(next), id, marker),
    ...activityStatements(database, [{ tripId: id, entityType: 'trip', entityId: id, action: 'update',
      before: { ...summary(trip), ownerId: actor.id }, after: summary(next) }], actor, marker, 'current'),
  ]);
  if (!results[0].meta.changes) throw new TripLifecycleError('This holiday or its travellers changed. Refresh and try again.', 409);
  return { tripName: trip.name, ownerId: target.user_id, memberName: trip.members.find(member => member.id === rawMemberId)?.name || 'A traveller' };
}

/**
 * Only a holiday no other account can open may be deleted, so nobody loses
 * shared records they rely on. Append-only activity history is retained by
 * design; image objects are queued for retriable deletion in the same commit.
 */
export async function deleteTrip(database: D1Database, actor: Actor, rawTripId: unknown, confirmName: unknown) {
  const id = tripId(rawTripId);
  const row = await database.prepare('SELECT owner, data FROM trips WHERE id = ?').bind(id).first<{ owner: string; data: string }>();
  if (!row || row.owner !== actor.id) throw new TripLifecycleError('Only the holiday owner can delete it.', 403);
  const trip = JSON.parse(row.data) as Trip;
  if (typeof confirmName !== 'string' || confirmName.trim() !== trip.name.trim()) throw new TripLifecycleError('Type the holiday name exactly to confirm deleting it.');
  if (await database.prepare('SELECT 1 FROM memberships WHERE trip_id = ? AND user_id <> ? LIMIT 1').bind(id, actor.id).first()) {
    throw new TripLifecycleError('Other travellers have joined this holiday with their accounts. Transfer it or archive it instead; only a holiday nobody else can open can be deleted.', 409);
  }
  await ensureSyncState(database);
  const marker = crypto.randomUUID(), now = new Date().toISOString();
  const change: ActivityChange = { tripId: id, entityType: 'trip', entityId: id, action: 'delete',
    before: { ...summary(trip), travellerCount: trip.members.length, expenseCount: trip.expenses.length, paymentCount: trip.payments.length }, after: null };
  const results = await database.batch([
    advanceRevision(database, actor, marker, `EXISTS (SELECT 1 FROM trips t WHERE t.id = ? AND t.owner = ?
      AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = t.id AND m.user_id <> ?))`, [id, actor.id, actor.id]),
    // Record the event while the holiday row still exists for its own history.
    ...activityStatements(database, [change], actor, marker, 'current'),
    database.prepare(`INSERT OR IGNORE INTO receipt_object_purges (receipt_id, owner, created_at)
      SELECT id, owner, ? FROM receipts WHERE trip_id = ? AND ${marked}`).bind(now, id, marker),
    database.prepare(`DELETE FROM receipts WHERE trip_id = ? AND ${marked}`).bind(id, marker),
    database.prepare(`DELETE FROM invites WHERE trip_id = ? AND ${marked}`).bind(id, marker),
    database.prepare(`DELETE FROM memberships WHERE trip_id = ? AND ${marked}`).bind(id, marker),
    database.prepare(`DELETE FROM trip_language_preferences WHERE trip_id = ? AND ${marked}`).bind(id, marker),
    database.prepare(`DELETE FROM trip_archives WHERE trip_id = ? AND ${marked}`).bind(id, marker),
    database.prepare(`DELETE FROM trips WHERE id = ? AND ${marked}`).bind(id, marker),
  ]);
  if (!results[0].meta.changes) throw new TripLifecycleError('Another traveller joined or the holiday changed. Refresh and try again.', 409);
  return { tripName: trip.name };
}
