import { activityStatements, type ActivityChange, type ActivitySource } from './audit';

/** D1 owns receipt lifecycle; R2 object deletion is idempotent and retriable. */
export class ReceiptLifecycleError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

export const RECEIPT_LIMITS = { perUser: 500, perTrip: 200, sweepBatch: 20, orphanAgeMs: 24 * 60 * 60 * 1000 } as const;
type ReceiptRow = { id: string; owner: string; trip_id: string; created_at: string; state: 'pending' | 'active' | 'deleting'; content_type: string; size_bytes: number; sha256: string };
type AuditActor = { id: string; displayName: string };
type ImageMetadata = { contentType: string; sizeBytes: number; sha256: string };
type ReceiptReason = 'upload-started' | 'upload-complete' | 'receipt-detached' | 'image-deletion' | 'orphan-expired' | 'upload-failed' | 'cleanup-retry' | 'image-deleted';
type ReceiptMutation = { statement: D1PreparedStatement; change: ActivityChange };
const systemActor: AuditActor = { id: 'system', displayName: 'TripTab' };
const key = (owner: string, id: string) => `${encodeURIComponent(owner)}/${id}`;
const access = `(r.owner = ? OR t.owner = ? OR EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = t.id AND m.user_id = ?))`;
const identity = `NOT EXISTS (SELECT 1 FROM auth_links WHERE oai_user_id = ? AND user_id <> ?)`;
const unreferenced = `NOT EXISTS (SELECT 1 FROM json_each(t.data, '$.expenses') e WHERE json_extract(e.value, '$.receiptId') = r.id)
  AND NOT EXISTS (SELECT 1 FROM json_each(t.data, '$.drafts') d WHERE json_extract(d.value, '$.receiptId') = r.id)`;
// Exact metadata guards keep the before snapshot truthful across competing calls.
const baseline = `r.id = ? AND r.owner = ? AND r.trip_id = ? AND r.created_at = ? AND r.state = ?
  AND r.content_type = ? AND r.size_bytes = ? AND r.sha256 = ?`;
const baselineValues = (row: ReceiptRow) => [row.id, row.owner, row.trip_id, row.created_at, row.state, row.content_type, row.size_bytes, row.sha256];

function snapshot(row: ReceiptRow, reason: ReceiptReason, initiator?: AuditActor) {
  return { id: row.id, uploaderId: row.owner, state: row.state, contentType: row.content_type, sizeBytes: row.size_bytes,
    sha256: row.sha256, createdAt: row.created_at, reason,
    ...(initiator ? { initiatorId: initiator.id, initiatorName: initiator.displayName.slice(0, 80) } : {}) };
}
function change(row: ReceiptRow, action: ActivityChange['action'], before: Record<string, unknown> | null, after: Record<string, unknown> | null): ActivityChange {
  return { tripId: row.trip_id, entityType: 'receipt', entityId: row.id, action, before, after };
}
async function auditContext(database: D1Database, user?: string) {
  const [profile, state] = await Promise.all([
    user ? database.prepare('SELECT display_name FROM profiles WHERE id = ?').bind(user).first<{ display_name: string }>() : null,
    database.prepare('SELECT COALESCE((SELECT revision FROM sync_state WHERE id = 1), 0) AS revision').first<{ revision: number }>(),
  ]);
  return { actor: user ? { id: user, displayName: profile?.display_name || 'Traveller' } : systemActor, revision: state?.revision || 0 };
}

/** Every guarded mutation is immediately followed by its one bounded audit row. */
async function commitReceiptChanges(database: D1Database, mutations: ReceiptMutation[], actor: AuditActor, revision: number, source: ActivitySource) {
  let changed = 0;
  for (let offset = 0; offset < mutations.length; offset += RECEIPT_LIMITS.sweepBatch) {
    const statements: D1PreparedStatement[] = [];
    const indexes: number[] = [];
    for (const mutation of mutations.slice(offset, offset + RECEIPT_LIMITS.sweepBatch)) {
      const events = activityStatements(database, [mutation.change], actor, '', revision, source, { sql: 'changes() > 0', bindings: [] });
      if (events.length !== 1) throw new Error('Receipt audit metadata exceeded its bound.');
      indexes.push(statements.length); statements.push(mutation.statement, events[0]);
    }
    const results = await database.batch(statements);
    changed += indexes.reduce((sum, index) => sum + results[index].meta.changes, 0);
  }
  return changed;
}

async function tripAllowed(database: D1Database, user: string, tripId: string) {
  return !!await database.prepare(`SELECT 1 FROM trips t WHERE t.id = ?
    AND (t.owner = ? OR EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = t.id AND m.user_id = ?))
    AND ${identity}`).bind(tripId, user, user, user, user).first();
}

/** Reserve a quota slot and its audit trail before writing image bytes. */
export async function reserveReceipt(database: D1Database, user: string, tripId: string, id: string, now = new Date().toISOString(), image: ImageMetadata = { contentType: '', sizeBytes: 0, sha256: '' }) {
  const { actor, revision } = await auditContext(database, user);
  const row: ReceiptRow = { id, owner: user, trip_id: tripId, created_at: now, state: 'pending', content_type: image.contentType, size_bytes: image.sizeBytes, sha256: image.sha256 };
  const statement = database.prepare(`
    INSERT INTO receipts (id, owner, trip_id, created_at, state, content_type, size_bytes, sha256)
    SELECT ?, ?, t.id, ?, 'pending', ?, ?, ? FROM trips t WHERE t.id = ?
      AND (t.owner = ? OR EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = t.id AND m.user_id = ?))
      AND ${identity}
      AND (SELECT COUNT(*) FROM receipts WHERE owner = ?) < ?
      AND (SELECT COUNT(*) FROM receipts WHERE trip_id = t.id) < ?
  `).bind(id, user, now, image.contentType, image.sizeBytes, image.sha256, tripId, user, user, user, user, user, RECEIPT_LIMITS.perUser, RECEIPT_LIMITS.perTrip);
  if (!await commitReceiptChanges(database, [{ statement, change: change(row, 'create', null, snapshot(row, 'upload-started', actor)) }], actor, revision, 'web')) {
    if (!await tripAllowed(database, user, tripId)) throw new ReceiptLifecycleError('You no longer have access to this trip.', 403);
    throw new ReceiptLifecycleError(`Receipt storage limit reached (${RECEIPT_LIMITS.perUser} per account, ${RECEIPT_LIMITS.perTrip} per holiday). Remove unused receipts and try again.`, 409);
  }
}

export async function activateReceipt(database: D1Database, user: string, tripId: string, id: string) {
  const row = await database.prepare("SELECT * FROM receipts WHERE id = ? AND owner = ? AND trip_id = ? AND state = 'pending'").bind(id, user, tripId).first<ReceiptRow>();
  if (!row) throw new ReceiptLifecycleError('The upload or your trip access changed. Try uploading again.', 409);
  const { actor, revision } = await auditContext(database, user);
  const next = { ...row, state: 'active' as const, created_at: new Date().toISOString() };
  const statement = database.prepare(`UPDATE receipts AS r SET state = 'active', created_at = ? WHERE ${baseline}
    AND EXISTS (SELECT 1 FROM trips t WHERE t.id = r.trip_id
      AND (t.owner = ? OR EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = t.id AND m.user_id = ?)))
    AND ${identity}`).bind(next.created_at, ...baselineValues(row), user, user, user, user);
  if (!await commitReceiptChanges(database, [{ statement, change: change(row, 'update', snapshot(row, 'upload-started', actor), snapshot(next, 'upload-complete', actor)) }], actor, revision, 'web')) {
    throw new ReceiptLifecycleError('The upload or your trip access changed. Try uploading again.', 409);
  }
}

/** Mark only live, unreferenced rows; the financial CAS also checks this state. */
export async function markRemovedReceipts(database: D1Database, user: string, ids: string[], options: { reason?: ReceiptReason; source?: ActivitySource } = {}) {
  if (!ids.length) return 0;
  const rows = await database.prepare(`SELECT r.* FROM receipts r JOIN trips t ON t.id = r.trip_id
    WHERE r.state = 'active' AND r.id IN (SELECT value FROM json_each(?)) AND ${access} AND ${unreferenced} AND ${identity}`)
    .bind(JSON.stringify([...new Set(ids)]), user, user, user, user, user).all<ReceiptRow>();
  if (!rows.results.length) return 0;
  const { actor, revision } = await auditContext(database, user);
  const reason = options.reason || 'receipt-detached';
  return commitReceiptChanges(database, rows.results.map(row => ({
    statement: database.prepare(`UPDATE receipts AS r SET state = 'deleting' WHERE ${baseline}
      AND EXISTS (SELECT 1 FROM trips t WHERE t.id = r.trip_id AND ${access} AND ${unreferenced}) AND ${identity}`)
      .bind(...baselineValues(row), user, user, user, user, user),
    change: change(row, 'update', snapshot(row, 'upload-complete'), snapshot({ ...row, state: 'deleting' }, reason, actor)),
  })), actor, revision, options.source || 'web');
}

/** Sweep confirmed uploads only; an in-flight R2 put must retain its reservation. */
export async function sweepReceiptOrphans(database: D1Database, user: string, now = Date.now()) {
  const cutoff = new Date(now - RECEIPT_LIMITS.orphanAgeMs).toISOString();
  const rows = await database.prepare(`SELECT r.* FROM receipts r JOIN trips t ON t.id = r.trip_id
    WHERE r.state = 'active' AND r.created_at <> '' AND r.created_at <= ? AND ${access} AND ${unreferenced} AND ${identity}
    ORDER BY r.created_at, r.id LIMIT ?`).bind(cutoff, user, user, user, user, user, RECEIPT_LIMITS.sweepBatch).all<ReceiptRow>();
  if (!rows.results.length) return 0;
  const { revision } = await auditContext(database);
  return commitReceiptChanges(database, rows.results.map(row => ({
    statement: database.prepare(`UPDATE receipts AS r SET state = 'deleting' WHERE ${baseline}
      AND EXISTS (SELECT 1 FROM trips t WHERE t.id = r.trip_id AND ${access} AND ${unreferenced}) AND ${identity}`)
      .bind(...baselineValues(row), user, user, user, user, user),
    change: change(row, 'update', snapshot(row, 'upload-complete'), snapshot({ ...row, state: 'deleting' }, 'orphan-expired', systemActor)),
  })), systemActor, revision, 'system');
}

async function deletionIntent(database: D1Database, row: ReceiptRow) {
  const event = await database.prepare(`SELECT actor_id, actor_name, after_data FROM activity_events
    WHERE trip_id = ? AND entity_type = 'receipt' AND entity_id = ? AND json_extract(after_data, '$.state') = 'deleting'
    ORDER BY sequence DESC LIMIT 1`).bind(row.trip_id, row.id).first<{ actor_id: string; actor_name: string; after_data: string }>();
  if (!event) return { reason: 'cleanup-retry' as ReceiptReason, initiator: undefined };
  const data = JSON.parse(event.after_data) as { reason: ReceiptReason; initiatorId?: string; initiatorName?: string };
  return { reason: data.reason, initiator: { id: data.initiatorId || event.actor_id, displayName: data.initiatorName || event.actor_name } };
}

/** Deletion completes only with an atomic metadata delete and audit record. */
export async function purgeDeletingReceipts(database: D1Database, bucket: R2Bucket, user: string, limit: number = RECEIPT_LIMITS.sweepBatch) {
  const boundedLimit = Math.max(1, Math.min(RECEIPT_LIMITS.sweepBatch, Math.floor(limit)));
  const rows = await database.prepare(`SELECT r.* FROM receipts r JOIN trips t ON t.id = r.trip_id
    WHERE r.state = 'deleting' AND ${access} AND ${identity}
    ORDER BY r.created_at, r.id LIMIT ?`).bind(user, user, user, user, user, boundedLimit).all<ReceiptRow>();
  const { revision } = await auditContext(database);
  let deleted = 0, failed = 0;
  for (let offset = 0; offset < rows.results.length; offset += 4) {
    await Promise.all(rows.results.slice(offset, offset + 4).map(async row => {
      try {
        const intent = await deletionIntent(database, row);
        await bucket.delete(key(row.owner, row.id));
        const before = { ...snapshot(row, 'image-deleted', intent.initiator), deletionReason: intent.reason };
        const removed = await commitReceiptChanges(database, [{
          statement: database.prepare(`DELETE FROM receipts AS r WHERE ${baseline}`).bind(...baselineValues(row)),
          change: change(row, 'delete', before, null),
        }], systemActor, revision, 'system');
        deleted += removed;
      } catch { failed++; }
    }));
  }
  return { deleted, failed };
}

export async function maintainReceipts(database: D1Database, bucket: R2Bucket, user: string) {
  const marked = await sweepReceiptOrphans(database, user);
  return { marked, ...await purgeDeletingReceipts(database, bucket, user) };
}

/** Upload failure retains a tombstone if object cleanup or completion auditing fails. */
async function abandonUpload(database: D1Database, bucket: R2Bucket, user: string, tripId: string, id: string, now: string, image: ImageMetadata) {
  const existing = await database.prepare('SELECT * FROM receipts WHERE id = ?').bind(id).first<ReceiptRow>();
  const { actor: initiator, revision } = await auditContext(database, user);
  if (!existing) {
    const row: ReceiptRow = { id, owner: user, trip_id: tripId, created_at: now, state: 'deleting', content_type: image.contentType, size_bytes: image.sizeBytes, sha256: image.sha256 };
    await commitReceiptChanges(database, [{
      statement: database.prepare(`INSERT OR IGNORE INTO receipts (id,owner,trip_id,created_at,state,content_type,size_bytes,sha256)
        SELECT ?,?,?,?,'deleting',?,?,? WHERE EXISTS (SELECT 1 FROM trips WHERE id = ?)`)
        .bind(id, user, tripId, now, image.contentType, image.sizeBytes, image.sha256, tripId),
      change: change(row, 'create', null, snapshot(row, 'upload-failed', initiator)),
    }], systemActor, revision, 'system');
  } else if (existing.owner === user && existing.trip_id === tripId && ['pending', 'active'].includes(existing.state)) {
    await commitReceiptChanges(database, [{
      statement: database.prepare(`UPDATE receipts AS r SET state = 'deleting' WHERE ${baseline}
        AND EXISTS (SELECT 1 FROM trips t WHERE t.id = r.trip_id AND ${unreferenced})`).bind(...baselineValues(existing)),
      change: change(existing, 'update', snapshot(existing, existing.state === 'pending' ? 'upload-started' : 'upload-complete'), snapshot({ ...existing, state: 'deleting' }, 'upload-failed', initiator)),
    }], systemActor, revision, 'system');
  }
  await purgeDeletingReceipts(database, bucket, user);
}

export async function storeReceipt(database: D1Database, bucket: R2Bucket, user: string, tripId: string, id: string, bytes: Uint8Array<ArrayBuffer>, contentType: string) {
  const now = new Date().toISOString();
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const image = { contentType, sizeBytes: bytes.byteLength, sha256: Array.from(hash, value => value.toString(16).padStart(2, '0')).join('') };
  await reserveReceipt(database, user, tripId, id, now, image);
  try {
    await bucket.put(key(user, id), bytes, { httpMetadata: { contentType } });
    await activateReceipt(database, user, tripId, id);
  } catch (error) {
    await abandonUpload(database, bucket, user, tripId, id, now, image).catch(() => {
      console.warn('TripTab receipt cleanup needs a retry.');
    });
    if (error instanceof ReceiptLifecycleError) throw error;
    throw new ReceiptLifecycleError('Receipt storage is temporarily unavailable. Try again.', 503);
  }
}

export async function deleteReceipt(database: D1Database, bucket: R2Bucket, user: string, id: string) {
  const row = await database.prepare(`SELECT r.* FROM receipts r JOIN trips t ON t.id = r.trip_id
    WHERE r.id = ? AND ${access} AND ${identity}`).bind(id, user, user, user, user, user).first<ReceiptRow>();
  if (!row) throw new ReceiptLifecycleError('This receipt is unavailable.', 404);
  if (row.state === 'pending') throw new ReceiptLifecycleError('This receipt is still uploading. Try again shortly.', 409);
  if (row.state === 'active' && !await markRemovedReceipts(database, user, [id], { reason: 'image-deletion' })) {
    throw new ReceiptLifecycleError('This receipt is still attached to an expense or draft. Remove it from the receipt entry before deleting the image.', 409);
  }
  await purgeDeletingReceipts(database, bucket, user);
  const remaining = await database.prepare('SELECT state FROM receipts WHERE id = ?').bind(id).first<{ state: string }>();
  return { receiptId: id, deleted: !remaining, pending: !!remaining };
}
