import { accountAuditStatement, activityStatements, type ActivityChange } from './audit';
import { isBill, MAX_OPEN_BILLS, MAX_OPEN_HOLIDAYS, type Trip } from './model';
import { AuthError, requestWriteAuthorizationSql, requestWriteAuthorized, type RequestWriteAuthorization } from './auth';

/** Holiday archive, leave, ownership transfer and deletion (audit F-23). */
export class TripLifecycleError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

/** Combined size guard; the per-kind limits below decide restores (F-17). */
export const MAX_OPEN_TRIPS = MAX_OPEN_HOLIDAYS + MAX_OPEN_BILLS;
/** A deleted bill can be restored for this long, then it is removed for good (F-14, owner decision A). */
export const BILL_RESTORE_DAYS = 30;
const RESTORE_MS = BILL_RESTORE_DAYS * 24 * 60 * 60 * 1000;
/**
 * A deleted bill's owner is replaced by this tombstone. Only bills nobody
 * else can open may be deleted, so the owner was the only person with
 * access; every owner-or-member access check in the app (ledger, history,
 * receipts, invites, reminders, exports, language settings, MCP) then fails
 * for it without any change to those readers.
 */
export const deletedOwner = (owner: string) => `deleted:${owner}`;
export type DeletedBill = { id: string; name: string; deletedAt: string; restoreUntil: string };
type Actor = { id: string; displayName: string; authorization?: RequestWriteAuthorization };
const actorWriteGuard = (actor: Actor) => actor.authorization
  ? requestWriteAuthorizationSql(actor.authorization, actor.id)
  : { condition: '1', bindings: [] };
async function explainActorRefusal(database: D1Database, actor: Actor) {
  if (actor.authorization && !await requestWriteAuthorized(database, actor.authorization, actor.id)) {
    throw new AuthError('Your sign-in changed before this action finished. Sign in again and review your changes.', 401);
  }
}

/** Holidays in an account's open list. Archived holidays stay accessible elsewhere. */
export const OPEN_TRIP_IDS = `SELECT id FROM trips WHERE owner = ? UNION SELECT trip_id FROM memberships WHERE user_id = ?
  EXCEPT SELECT trip_id FROM trip_archives WHERE user_id = ?`;
export const openTripBindings = (user: string) => [user, user, user];
/** Holidays and bills this account can still open but has archived for itself (F-05). */
const ARCHIVED_TRIP_IDS = `SELECT id FROM trips WHERE owner = ? UNION SELECT trip_id FROM memberships WHERE user_id = ?
  INTERSECT SELECT trip_id FROM trip_archives WHERE user_id = ?`;

const access = '(t.owner = ? OR EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = t.id AND m.user_id = ?))';
// A provider identity linked to a different account must never act as itself.
const identity = 'NOT EXISTS (SELECT 1 FROM auth_links WHERE oai_user_id = ? AND user_id <> ?)';
const marked = 'EXISTS (SELECT 1 FROM sync_state WHERE id = 1 AND last_write = ?)';

export function tripMessage(trip: Pick<Trip, 'kind'> | undefined, text: string) {
  // F-15: bills have people, not travellers.
  return trip && isBill(trip) ? text.replaceAll('holiday', 'bill').replaceAll('Holiday', 'Bill')
    .replaceAll('Other travellers', 'Other people').replaceAll('Another traveller', 'Another person') : text;
}

function tripId(value: unknown) {
  if (typeof value !== 'string' || !value || value.length > 100) throw new TripLifecycleError('Choose a valid holiday.');
  return value;
}
function summary(trip: Trip): Record<string, unknown> {
  const metadata: Record<string, unknown> = { ...trip };
  for (const key of ['members', 'expenses', 'payments', 'drafts']) delete metadata[key];
  return metadata;
}

export type ArchivedTrip = { id: string; name: string; currency: string; kind?: Trip['kind']; startDate?: string; endDate?: string; travellers: number; archivedAt: string; owner: boolean };
export async function listArchivedTrips(database: D1Database, user: string): Promise<ArchivedTrip[]> {
  const rows = await database.prepare(`SELECT t.id, t.owner, a.archived_at, json_extract(t.data, '$.name') AS name,
      json_extract(t.data, '$.kind') AS kind, json_extract(t.data, '$.currency') AS currency, json_extract(t.data, '$.startDate') AS start_date,
      json_extract(t.data, '$.endDate') AS end_date, json_array_length(t.data, '$.members') AS travellers
    FROM trip_archives a JOIN trips t ON t.id = a.trip_id WHERE a.user_id = ? AND ${access}
    ORDER BY a.archived_at DESC, t.id LIMIT 500`).bind(user, user, user)
    .all<{ id: string; owner: string; archived_at: string; name: string; currency: string; kind: Trip['kind'] | null; start_date: string | null; end_date: string | null; travellers: number }>();
  return rows.results.map(row => ({ id: row.id, name: String(row.name ?? ''), currency: String(row.currency ?? ''),
    ...(row.kind ? { kind: row.kind } : {}), ...(row.start_date ? { startDate: row.start_date } : {}), ...(row.end_date ? { endDate: row.end_date } : {}),
    travellers: Number(row.travellers) || 0, archivedAt: row.archived_at, owner: row.owner === user }));
}

/**
 * Read-only copies of the account's archived holidays and bills, for the
 * Activity and People views (F-05). Only trips the account can still open
 * (owned or joined) and has archived for itself. Account links come from
 * memberships, as in the ledger; emails are never included.
 */
export async function listArchivedTripData(database: D1Database, user: string, limit = 200): Promise<Trip[]> {
  const [trips, links] = await database.batch([
    database.prepare(`SELECT t.id, t.owner, t.data FROM trips t WHERE t.id IN (${ARCHIVED_TRIP_IDS}) ORDER BY t.id LIMIT ?`).bind(user, user, user, limit),
    database.prepare(`SELECT m.trip_id, m.user_id, m.member_id FROM memberships m WHERE m.trip_id IN (${ARCHIVED_TRIP_IDS})`).bind(user, user, user),
  ]);
  const linked = new Map((links.results as { trip_id: string; user_id: string; member_id: string }[]).map(row => [`${row.trip_id}\u0000${row.member_id}`, row.user_id]));
  return (trips.results as { id: string; owner: string; data: string }[]).map(row => {
    const trip = { ...JSON.parse(row.data), ownerId: row.owner } as Trip;
    trip.members = trip.members.map(member => {
      const next = { ...member };
      delete next.email;
      const account = linked.get(`${row.id}\u0000${member.id}`);
      if (account) next.userId = account; else if (next.userId !== row.owner) delete next.userId;
      return next;
    });
    for (const entry of [...trip.expenses, ...trip.drafts]) delete (entry as { conversation?: unknown }).conversation;
    return trip;
  });
}

/** Personal: other travellers keep seeing the holiday and notifications continue. */
export async function setTripArchived(database: D1Database, actor: Actor, rawTripId: unknown, archived: boolean) {
  const id = tripId(rawTripId);
  const trip = await database.prepare(`SELECT json_extract(t.data, '$.kind') AS kind, json_extract(t.data, '$.name') AS name, EXISTS (SELECT 1 FROM trip_archives a WHERE a.trip_id = t.id AND a.user_id = ?) AS archived
    FROM trips t WHERE t.id = ? AND ${access}`).bind(actor.id, id, actor.id, actor.id).first<{ name: string; kind?: Trip['kind']; archived: number }>();
  if (!trip) throw new TripLifecycleError('You do not have access to this holiday.', 403);
  if (!!trip.archived === archived) return { archived };
  const holidayName = String(trip.name ?? '').slice(0, 100);
  const audit = accountAuditStatement(database, { userId: actor.id, actorName: actor.displayName, entityType: 'trip', entityId: id,
    action: 'update', before: { archived: !archived, holidayName }, after: { archived, holidayName } });
  const authorization = actorWriteGuard(actor);
  if (archived) {
    const results = await database.batch([
      database.prepare(`INSERT INTO trip_archives (user_id, trip_id, archived_at) SELECT ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM trips t WHERE t.id = ? AND ${access}) AND ${identity} AND ${authorization.condition}
        ON CONFLICT(user_id, trip_id) DO NOTHING`).bind(actor.id, id, new Date().toISOString(), id, actor.id, actor.id, actor.id, actor.id, ...authorization.bindings),
      audit,
    ]);
    if (!results[0].meta.changes) await explainActorRefusal(database, actor);
    return { archived };
  }
  // Restoring keeps each kind within its own open-list limit (F-17).
  const bill = trip.kind === 'bill';
  const limit = bill ? MAX_OPEN_BILLS : MAX_OPEN_HOLIDAYS;
  const sameKind = `(SELECT COUNT(*) FROM trips o WHERE o.id IN (${OPEN_TRIP_IDS}) AND ${bill ? "json_extract(o.data, '$.kind') = 'bill'" : "COALESCE(json_extract(o.data, '$.kind'), 'holiday') <> 'bill'"})`;
  const results = await database.batch([
    database.prepare(`DELETE FROM trip_archives WHERE user_id = ? AND trip_id = ? AND ${identity}
      AND ${sameKind} < ? AND ${authorization.condition}`).bind(actor.id, id, actor.id, actor.id, ...openTripBindings(actor.id), limit, ...authorization.bindings),
    audit,
  ]);
  if (!results[0].meta.changes) await explainActorRefusal(database, actor);
  if (!results[0].meta.changes && await database.prepare('SELECT 1 FROM trip_archives WHERE user_id = ? AND trip_id = ?').bind(actor.id, id).first()) {
    throw new TripLifecycleError(bill ? `You already have ${MAX_OPEN_BILLS} open bills. Remove one from your list before restoring another.`
      : `You already have ${MAX_OPEN_HOLIDAYS} open holidays. Archive one before restoring another.`, 409);
  }
  return { archived };
}

/** Advance the shared save token so ledgers loaded before this change must refresh. */
function advanceRevision(database: D1Database, actor: Actor, marker: string, condition: string, bindings: unknown[]) {
  const authorization = actorWriteGuard(actor);
  return database.prepare(`UPDATE sync_state SET revision = revision + 1, last_write = ? WHERE id = 1 AND ${identity} AND ${condition} AND ${authorization.condition}`)
    .bind(marker, actor.id, actor.id, ...bindings, ...authorization.bindings);
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
  if (!row || (row.owner !== actor.id && !row.member_id)) throw new TripLifecycleError(tripMessage(row ? JSON.parse(row.data) : undefined, 'You are not a traveller on this holiday.'), 403);
  if (row.owner === actor.id) throw new TripLifecycleError(tripMessage(row ? JSON.parse(row.data) : undefined, 'As the owner, transfer this holiday to another traveller before leaving it. You can also archive or delete it.'), 409);
  const trip = JSON.parse(row.data) as Trip;
  const member = trip.members.find(value => value.id === row.member_id);
  if (!member) throw new TripLifecycleError(tripMessage(trip, 'Your traveller entry changed. Refresh the holiday and try again.'), 409);
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
  if (!results[0].meta.changes) {
    await explainActorRefusal(database, actor);
    throw new TripLifecycleError(tripMessage(trip, 'This holiday changed while you were leaving. Refresh and try again.'), 409);
  }
  return { tripName: trip.name, kind: trip.kind, memberName: member.name };
}

/** The new owner must already have joined with their own account. */
export async function transferTripOwnership(database: D1Database, actor: Actor, rawTripId: unknown, rawMemberId: unknown) {
  const id = tripId(rawTripId);
  if (typeof rawMemberId !== 'string' || !rawMemberId || rawMemberId.length > 100) throw new TripLifecycleError('Choose a traveller.');
  const row = await database.prepare('SELECT owner, data FROM trips WHERE id = ?').bind(id).first<{ owner: string; data: string }>();
  if (!row || row.owner !== actor.id) throw new TripLifecycleError(tripMessage(row ? JSON.parse(row.data) : undefined, 'Only the holiday owner can transfer it.'), 403);
  const target = await database.prepare('SELECT user_id FROM memberships WHERE trip_id = ? AND member_id = ?')
    .bind(id, rawMemberId).first<{ user_id: string }>();
  if (!target) throw new TripLifecycleError(tripMessage(row ? JSON.parse(row.data) : undefined, 'Choose a traveller who has joined this holiday with their own account.'), 409);
  if (target.user_id === actor.id) throw new TripLifecycleError(tripMessage(row ? JSON.parse(row.data) : undefined, 'You already own this holiday.'));
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
  if (!results[0].meta.changes) {
    await explainActorRefusal(database, actor);
    throw new TripLifecycleError(tripMessage(trip, 'This holiday or its travellers changed. Refresh and try again.'), 409);
  }
  return { tripName: trip.name, kind: trip.kind, ownerId: target.user_id, memberName: trip.members.find(member => member.id === rawMemberId)?.name || 'A traveller' };
}

/**
 * Only a holiday no other account can open may be deleted, so nobody loses
 * shared records they rely on. Append-only activity history is retained by
 * design; image objects are queued for retriable deletion in the same commit.
 */
export async function deleteTrip(database: D1Database, actor: Actor, rawTripId: unknown, confirmName: unknown) {
  return deleteTripRecord(database, actor, rawTripId, confirmName, false);
}

export async function discardEmptyBill(database: D1Database, actor: Actor, rawTripId: unknown) {
  return deleteTripRecord(database, actor, rawTripId, undefined, true);
}

async function deleteTripRecord(database: D1Database, actor: Actor, rawTripId: unknown, confirmName: unknown, discard: boolean) {
  const id = tripId(rawTripId);
  const row = await database.prepare('SELECT owner, data FROM trips WHERE id = ?').bind(id).first<{ owner: string; data: string }>();
  const discardError = 'This bill has entries. Delete it from its settings instead.';
  if (!row || row.owner !== actor.id) throw new TripLifecycleError(discard ? 'Only the bill owner can discard it.' : tripMessage(row ? JSON.parse(row.data) : undefined, 'Only the holiday owner can delete it.'), 403);
  const trip = JSON.parse(row.data) as Trip;
  if (discard && (!isBill(trip) || trip.expenses.length || trip.payments.length || trip.drafts.length)) throw new TripLifecycleError(discardError, 409);
  if (!discard && (typeof confirmName !== 'string' || confirmName.trim() !== trip.name.trim())) throw new TripLifecycleError(tripMessage(trip, 'Type the holiday name exactly to confirm deleting it.'));
  if (await database.prepare('SELECT 1 FROM memberships WHERE trip_id = ? AND user_id <> ? LIMIT 1').bind(id, actor.id).first()) {
    if (discard) throw new TripLifecycleError(discardError, 409);
    throw new TripLifecycleError(tripMessage(trip, 'Other travellers have joined this holiday with their accounts. Transfer it or archive it instead; only a holiday nobody else can open can be deleted.'), 409);
  }
  await ensureSyncState(database);
  const marker = crypto.randomUUID(), now = new Date().toISOString();
  const change: ActivityChange = { tripId: id, entityType: 'trip', entityId: id, action: 'delete',
    before: { ...summary(trip), travellerCount: trip.members.length, expenseCount: trip.expenses.length, paymentCount: trip.payments.length }, after: null };
  // A bill with entries is kept for BILL_RESTORE_DAYS so it can be restored
  // with its receipt photos; an empty bill and a holiday are removed now.
  if (!discard && isBill(trip)) {
    const links = await database.prepare('SELECT user_id, member_id FROM memberships WHERE trip_id = ? AND user_id = ?').bind(id, actor.id)
      .all<{ user_id: string; member_id: string }>();
    const deletion = { at: now, owner: actor.id, memberships: links.results ?? [] };
    const results = await database.batch([
      advanceRevision(database, actor, marker, `EXISTS (SELECT 1 FROM trips t WHERE t.id = ? AND t.owner = ? AND t.data = ?
        AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = t.id AND m.user_id <> ?))`, [id, actor.id, row.data, actor.id]),
      ...activityStatements(database, [change], actor, marker, 'current'),
      database.prepare(`DELETE FROM invites WHERE trip_id = ? AND ${marked}`).bind(id, marker),
      database.prepare(`DELETE FROM trip_archives WHERE trip_id = ? AND ${marked}`).bind(id, marker),
      database.prepare(`DELETE FROM notification_digests WHERE trip_id = ? AND ${marked}`).bind(id, marker),
      database.prepare(`DELETE FROM memberships WHERE trip_id = ? AND ${marked}`).bind(id, marker),
      database.prepare(`UPDATE trips SET owner = ?, data = json_set(data, '$.deletion', json(?)) WHERE id = ? AND ${marked}`)
        .bind(deletedOwner(actor.id), JSON.stringify(deletion), id, marker),
    ]);
    if (!results[0].meta.changes) {
      await explainActorRefusal(database, actor);
      throw new TripLifecycleError(tripMessage(trip, 'Another traveller joined or the holiday changed. Refresh and try again.'), 409);
    }
    return { tripName: trip.name, restorable: true };
  }
  const results = await database.batch([
    advanceRevision(database, actor, marker, `EXISTS (SELECT 1 FROM trips t WHERE t.id = ? AND t.owner = ? AND t.data = ?
      AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = t.id AND m.user_id <> ?))`, [id, actor.id, row.data, actor.id]),
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
  if (!results[0].meta.changes) {
    await explainActorRefusal(database, actor);
    throw new TripLifecycleError(discard ? discardError : tripMessage(trip, 'Another traveller joined or the holiday changed. Refresh and try again.'), 409);
  }
  return { tripName: trip.name, restorable: false };
}

type Deletion = { at: string; owner: string; memberships: { user_id: string; member_id: string }[] };
function deletionOf(data: string): Deletion | undefined {
  const value = (JSON.parse(data) as { deletion?: Deletion }).deletion;
  return value && typeof value.at === 'string' && typeof value.owner === 'string' && Array.isArray(value.memberships) ? value : undefined;
}

/** The account's deleted bills that can still be restored, newest first. */
export async function listDeletedBills(database: D1Database, user: string, now = Date.now()): Promise<DeletedBill[]> {
  const rows = await database.prepare(`SELECT id, json_extract(data, '$.name') AS name, json_extract(data, '$.deletion.at') AS deleted_at
    FROM trips WHERE owner = ? ORDER BY deleted_at DESC, id LIMIT 200`).bind(deletedOwner(user)).all<{ id: string; name: string; deleted_at: string | null }>();
  return (rows.results ?? []).flatMap(row => {
    const at = Date.parse(row.deleted_at ?? '');
    if (!Number.isFinite(at) || now - at > RESTORE_MS) return [];
    return [{ id: row.id, name: String(row.name ?? ''), deletedAt: row.deleted_at!, restoreUntil: new Date(at + RESTORE_MS).toISOString() }];
  });
}

/**
 * Put a deleted bill back exactly as it was: same entries, owner link and
 * receipt photos. Only its owner can, within BILL_RESTORE_DAYS, and only
 * while the open list has room.
 */
export async function restoreDeletedBill(database: D1Database, actor: Actor, rawTripId: unknown, now = Date.now()) {
  const id = tripId(rawTripId);
  const row = await database.prepare('SELECT data FROM trips WHERE id = ? AND owner = ?').bind(id, deletedOwner(actor.id)).first<{ data: string }>();
  const deletion = row && deletionOf(row.data);
  if (!row || !deletion || deletion.owner !== actor.id) throw new TripLifecycleError('This bill can no longer be restored.', 404);
  if (now - Date.parse(deletion.at) > RESTORE_MS) throw new TripLifecycleError(`Bills can be restored for ${BILL_RESTORE_DAYS} days after they are deleted.`, 410);
  const trip = JSON.parse(row.data) as Trip;
  await ensureSyncState(database);
  const marker = crypto.randomUUID();
  const memberships = deletion.memberships.filter(link => link.user_id === actor.id);
  const results = await database.batch([
    // A restored bill counts towards the open-bill limit (F-17).
    advanceRevision(database, actor, marker, `EXISTS (SELECT 1 FROM trips t WHERE t.id = ? AND t.owner = ? AND t.data = ?)
      AND (SELECT COUNT(*) FROM trips o WHERE o.id IN (${OPEN_TRIP_IDS}) AND json_extract(o.data, '$.kind') = 'bill') < ?`, [id, deletedOwner(actor.id), row.data, ...openTripBindings(actor.id), MAX_OPEN_BILLS]),
    database.prepare(`UPDATE trips SET owner = ?, data = json_remove(data, '$.deletion') WHERE id = ? AND ${marked}`).bind(actor.id, id, marker),
    database.prepare(`INSERT OR IGNORE INTO memberships (trip_id, user_id, member_id)
      SELECT ?, json_extract(value, '$.user_id'), json_extract(value, '$.member_id') FROM json_each(?) WHERE ${marked}`).bind(id, JSON.stringify(memberships), marker),
    ...activityStatements(database, [{ tripId: id, entityType: 'trip', entityId: id, action: 'create', before: null,
      after: { ...summary(trip), restored: true, travellerCount: trip.members.length, expenseCount: trip.expenses.length, paymentCount: trip.payments.length } }], actor, marker, 'current'),
  ]);
  if (!results[0].meta.changes) {
    await explainActorRefusal(database, actor);
    if (await database.prepare('SELECT 1 FROM trips WHERE id = ? AND owner = ?').bind(id, deletedOwner(actor.id)).first()) {
      throw new TripLifecycleError(`You already have ${MAX_OPEN_BILLS} open bills. Remove one from your list before restoring another.`, 409);
    }
    throw new TripLifecycleError('This bill changed. Refresh and try again.', 409);
  }
  return { tripName: trip.name };
}

/** Trips the account can open: owned or joined. */
const reachable = `SELECT id FROM trips WHERE owner = ? UNION SELECT trip_id FROM memberships WHERE user_id = ?`;

/**
 * Accounts that already share at least one holiday or bill with this account
 * (D03). Only display names are returned: no emails or contact details. The
 * relationship comes from ownership and memberships, never from names.
 */
export async function listConnections(database: D1Database, user: string): Promise<{ id: string; name: string }[]> {
  const rows = await database.prepare(`SELECT p.id, p.display_name FROM profiles p WHERE p.id <> ? AND p.id IN (
      SELECT m.user_id FROM memberships m WHERE m.trip_id IN (${reachable})
      UNION SELECT t.owner FROM trips t WHERE t.id IN (${reachable})
    ) ORDER BY p.display_name COLLATE NOCASE, p.id LIMIT 200`).bind(user, user, user, user, user).all<{ id: string; display_name: string }>();
  return (rows.results ?? []).map(row => ({ id: row.id, name: row.display_name.slice(0, 50) }));
}

/**
 * Link a connected account to an unlinked person on a bill (F-04, D03): the
 * bill then appears in their list. The server checks every condition again
 * in the same compare-and-swap commit: the actor can open the bill, the
 * person is still unlinked, the account is not already on it, and the two
 * accounts already share another holiday or bill. Only that one bill becomes
 * visible to them; nothing else of the actor's is reachable.
 */
export async function addConnectedMember(database: D1Database, actor: Actor, rawTripId: unknown, rawMemberId: unknown, rawAccountId: unknown) {
  const id = tripId(rawTripId);
  if (typeof rawMemberId !== 'string' || !rawMemberId || rawMemberId.length > 100) throw new TripLifecycleError('Choose a person on this bill.');
  if (typeof rawAccountId !== 'string' || !rawAccountId || rawAccountId.length > 512) throw new TripLifecycleError('Choose someone you already share a holiday or bill with.');
  if (rawAccountId === actor.id) throw new TripLifecycleError('You are already on this bill.');
  const row = await database.prepare(`SELECT t.owner, t.data FROM trips t WHERE t.id = ? AND ${access}`).bind(id, actor.id, actor.id)
    .first<{ owner: string; data: string }>();
  if (!row) throw new TripLifecycleError('Bill not found.', 404);
  const trip = JSON.parse(row.data) as Trip;
  if (!isBill(trip)) throw new TripLifecycleError('People can be added directly only to bills. Use an invitation for a holiday.');
  const member = trip.members.find(value => value.id === rawMemberId);
  if (!member) throw new TripLifecycleError('That person is no longer on this bill. Refresh and try again.', 409);
  const connected = `EXISTS (SELECT 1 FROM (${reachable}) mine JOIN (${reachable}) theirs ON theirs.id = mine.id WHERE mine.id <> ?)`;
  const connection = await database.prepare(`SELECT 1 AS ok WHERE ${connected}`).bind(actor.id, actor.id, rawAccountId, rawAccountId, id).first<{ ok: number }>();
  if (!connection) throw new TripLifecycleError('You can add someone directly only if you already share a holiday or bill with them. Send them an invitation instead.', 403);
  const profile = await database.prepare('SELECT display_name FROM profiles WHERE id = ?').bind(rawAccountId).first<{ display_name: string }>();
  if (!profile) throw new TripLifecycleError('That account is no longer available.', 404);
  const linked = { ...member, userId: rawAccountId };
  delete linked.email;
  const next = { ...trip, members: trip.members.map(value => value.id === member.id ? linked : value) };
  await ensureSyncState(database);
  const marker = crypto.randomUUID();
  const results = await database.batch([
    advanceRevision(database, actor, marker, `EXISTS (SELECT 1 FROM trips t WHERE t.id = ? AND t.data = ? AND ${access})
      AND NOT EXISTS (SELECT 1 FROM memberships WHERE trip_id = ? AND (user_id = ? OR member_id = ?))
      AND NOT EXISTS (SELECT 1 FROM trips WHERE id = ? AND owner = ?)
      AND ${connected}`, [id, row.data, actor.id, actor.id, id, rawAccountId, member.id, id, rawAccountId, actor.id, actor.id, rawAccountId, rawAccountId, id]),
    database.prepare(`INSERT INTO memberships (trip_id, user_id, member_id) SELECT ?, ?, ? WHERE ${marked}`).bind(id, rawAccountId, member.id, marker),
    database.prepare(`UPDATE trips SET data = ? WHERE id = ? AND ${marked}`).bind(JSON.stringify(next), id, marker),
    ...activityStatements(database, [{ tripId: id, entityType: 'member', entityId: member.id, action: 'update', before: { ...member }, after: linked }], actor, marker, 'current'),
  ]);
  if (!results[0].meta.changes) {
    await explainActorRefusal(database, actor);
    throw new TripLifecycleError('This bill or that person changed, or they are already on it. Refresh and try again.', 409);
  }
  return { tripName: trip.name, memberId: member.id, memberName: member.name, accountName: profile.display_name };
}

/** Remove deleted bills for good: one by its owner now, or every expired one (scheduled). */
function purgeStatements(database: D1Database, id: string, owner: string, data: string, now: string, actor?: Actor) {
  // A user-requested purge checks permission once at transaction admission,
  // then every side effect follows that marker. Expiry between statements
  // must never remove photos without removing the tombstone (or vice versa).
  const marker = crypto.randomUUID();
  const unchanged = 'EXISTS (SELECT 1 FROM trips WHERE id = ? AND owner = ? AND data = ?)';
  const still = actor ? marked : unchanged;
  const guard = actor ? [marker] : [id, owner, data];
  return [
    ...(actor ? [advanceRevision(database, actor, marker, unchanged, [id, owner, data])] : []),
    database.prepare(`INSERT OR IGNORE INTO receipt_object_purges (receipt_id, owner, created_at)
      SELECT id, owner, ? FROM receipts WHERE trip_id = ? AND ${still}`).bind(now, id, ...guard),
    database.prepare(`DELETE FROM receipts WHERE trip_id = ? AND ${still}`).bind(id, ...guard),
    database.prepare(`DELETE FROM trip_language_preferences WHERE trip_id = ? AND ${still}`).bind(id, ...guard),
    database.prepare(`DELETE FROM trips WHERE id = ? AND ${still}`).bind(id, ...guard),
  ];
}
export async function purgeDeletedBill(database: D1Database, actor: Actor, rawTripId: unknown) {
  const id = tripId(rawTripId), owner = deletedOwner(actor.id);
  const row = await database.prepare('SELECT data FROM trips WHERE id = ? AND owner = ?').bind(id, owner).first<{ data: string }>();
  if (!row) throw new TripLifecycleError('This bill was already removed.', 404);
  await ensureSyncState(database);
  const results = await database.batch(purgeStatements(database, id, owner, row.data, new Date().toISOString(), actor));
  if (!results.at(-1)!.meta.changes) {
    await explainActorRefusal(database, actor);
    throw new TripLifecycleError('This bill changed. Refresh and try again.', 409);
  }
  return { tripName: String((JSON.parse(row.data) as Trip).name ?? '') };
}
export async function purgeExpiredDeletedBills(database: D1Database, options: { now?: number; limit?: number } = {}) {
  const now = options.now ?? Date.now(), cutoff = new Date(now - RESTORE_MS).toISOString();
  const rows = await database.prepare(`SELECT id, owner, data FROM trips WHERE owner LIKE 'deleted:%'
    AND json_extract(data, '$.deletion.at') <= ? ORDER BY id LIMIT ?`).bind(cutoff, options.limit ?? 50).all<{ id: string; owner: string; data: string }>();
  let purged = 0;
  for (const row of rows.results ?? []) {
    const results = await database.batch(purgeStatements(database, row.id, row.owner, row.data, new Date(now).toISOString()));
    if (results[3].meta.changes) purged++;
  }
  return { purged };
}
