/** D1 owns receipt lifecycle; R2 object deletion is idempotent and retriable. */
export class ReceiptLifecycleError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

export const RECEIPT_LIMITS = { perUser: 500, perTrip: 200, sweepBatch: 20, orphanAgeMs: 24 * 60 * 60 * 1000 } as const;
type ReceiptRow = { id: string; owner: string; trip_id: string; created_at: string; state: 'pending' | 'active' | 'deleting' };
const key = (owner: string, id: string) => `${encodeURIComponent(owner)}/${id}`;
const access = `(r.owner = ? OR t.owner = ? OR EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = t.id AND m.user_id = ?))`;
const identity = `NOT EXISTS (SELECT 1 FROM auth_links WHERE oai_user_id = ? AND user_id <> ?)`;
const unreferenced = `NOT EXISTS (SELECT 1 FROM json_each(t.data, '$.expenses') e WHERE json_extract(e.value, '$.receiptId') = r.id)
  AND NOT EXISTS (SELECT 1 FROM json_each(t.data, '$.drafts') d WHERE json_extract(d.value, '$.receiptId') = r.id)`;

async function tripAllowed(database: D1Database, user: string, tripId: string) {
  return !!await database.prepare(`SELECT 1 FROM trips t WHERE t.id = ?
    AND (t.owner = ? OR EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = t.id AND m.user_id = ?))
    AND ${identity}`).bind(tripId, user, user, user, user).first();
}

/** Reserve a quota slot before writing image bytes; pending rows cannot attach. */
export async function reserveReceipt(database: D1Database, user: string, tripId: string, id: string, now = new Date().toISOString()) {
  const result = await database.prepare(`
    INSERT INTO receipts (id, owner, trip_id, created_at, state)
    SELECT ?, ?, t.id, ?, 'pending' FROM trips t WHERE t.id = ?
      AND (t.owner = ? OR EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = t.id AND m.user_id = ?))
      AND ${identity}
      AND (SELECT COUNT(*) FROM receipts WHERE owner = ?) < ?
      AND (SELECT COUNT(*) FROM receipts WHERE trip_id = t.id) < ?
  `).bind(id, user, now, tripId, user, user, user, user, user, RECEIPT_LIMITS.perUser, RECEIPT_LIMITS.perTrip).run();
  if (!result.meta.changes) {
    if (!await tripAllowed(database, user, tripId)) throw new ReceiptLifecycleError('You no longer have access to this trip.', 403);
    throw new ReceiptLifecycleError(`Receipt storage limit reached (${RECEIPT_LIMITS.perUser} per account, ${RECEIPT_LIMITS.perTrip} per holiday). Remove unused receipts and try again.`, 409);
  }
}

export async function activateReceipt(database: D1Database, user: string, tripId: string, id: string) {
  const result = await database.prepare(`UPDATE receipts SET state = 'active', created_at = ? WHERE id = ? AND owner = ? AND trip_id = ? AND state = 'pending'
    AND EXISTS (SELECT 1 FROM trips t WHERE t.id = receipts.trip_id
      AND (t.owner = ? OR EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = t.id AND m.user_id = ?)))
    AND ${identity}`).bind(new Date().toISOString(), id, user, tripId, user, user, user, user).run();
  if (!result.meta.changes) throw new ReceiptLifecycleError('The upload or your trip access changed. Try uploading again.', 409);
}

/** Mark only live, unreferenced rows; the financial CAS also checks this state. */
export async function markRemovedReceipts(database: D1Database, user: string, ids: string[]) {
  if (!ids.length) return 0;
  const result = await database.prepare(`UPDATE receipts AS r SET state = 'deleting'
    WHERE r.state = 'active' AND r.id IN (SELECT value FROM json_each(?))
      AND EXISTS (SELECT 1 FROM trips t WHERE t.id = r.trip_id AND ${access} AND ${unreferenced})
      AND ${identity}`).bind(JSON.stringify([...new Set(ids)]), user, user, user, user, user).run();
  return result.meta.changes;
}

/** Sweep confirmed uploads only; an in-flight R2 put must retain its reservation. */
export async function sweepReceiptOrphans(database: D1Database, user: string, now = Date.now()) {
  const cutoff = new Date(now - RECEIPT_LIMITS.orphanAgeMs).toISOString();
  const result = await database.prepare(`UPDATE receipts SET state = 'deleting'
    WHERE id IN (SELECT r.id FROM receipts r JOIN trips t ON t.id = r.trip_id
      WHERE r.state = 'active' AND r.created_at <> '' AND r.created_at <= ?
        AND ${access} AND ${unreferenced} AND ${identity}
      ORDER BY r.created_at, r.id LIMIT ?)`)
    .bind(cutoff, user, user, user, user, user, RECEIPT_LIMITS.sweepBatch).run();
  return result.meta.changes;
}

/** A tombstone blocks reattachment until R2 succeeds; failed deletions keep it. */
export async function purgeDeletingReceipts(database: D1Database, bucket: R2Bucket, user: string, limit: number = RECEIPT_LIMITS.sweepBatch) {
  const boundedLimit = Math.max(1, Math.min(RECEIPT_LIMITS.sweepBatch, Math.floor(limit)));
  const rows = await database.prepare(`SELECT r.* FROM receipts r JOIN trips t ON t.id = r.trip_id
    WHERE r.state = 'deleting' AND ${access} AND ${identity}
    ORDER BY r.created_at, r.id LIMIT ?`).bind(user, user, user, user, user, boundedLimit).all<ReceiptRow>();
  let deleted = 0, failed = 0;
  for (let offset = 0; offset < rows.results.length; offset += 4) {
    await Promise.all(rows.results.slice(offset, offset + 4).map(async row => {
      try {
        await bucket.delete(key(row.owner, row.id));
        const result = await database.prepare("DELETE FROM receipts WHERE id = ? AND state = 'deleting'").bind(row.id).run();
        deleted += result.meta.changes;
      } catch { failed++; }
    }));
  }
  return { deleted, failed };
}

export async function maintainReceipts(database: D1Database, bucket: R2Bucket, user: string) {
  const marked = await sweepReceiptOrphans(database, user);
  return { marked, ...await purgeDeletingReceipts(database, bucket, user) };
}

/** Upload failure retains a tombstone if R2 cleanup also fails. */
async function abandonUpload(database: D1Database, bucket: R2Bucket, user: string, tripId: string, id: string, now: string) {
  // Preserve a cleanup record for an ambiguous object write, including when a
  // storage failure left the original reservation unavailable.
  await database.prepare(`INSERT OR IGNORE INTO receipts (id,owner,trip_id,created_at,state)
    SELECT ?,?,?,?,'deleting' WHERE EXISTS (SELECT 1 FROM trips WHERE id = ?)`)
    .bind(id, user, tripId, now, tripId).run();
  await database.prepare(`UPDATE receipts AS r SET state = 'deleting' WHERE id = ? AND owner = ?
    AND state IN ('pending','active') AND EXISTS (SELECT 1 FROM trips t WHERE t.id = r.trip_id AND ${unreferenced})`).bind(id, user).run();
  await purgeDeletingReceipts(database, bucket, user);
}

export async function storeReceipt(database: D1Database, bucket: R2Bucket, user: string, tripId: string, id: string, bytes: Uint8Array<ArrayBuffer>, contentType: string) {
  const now = new Date().toISOString();
  await reserveReceipt(database, user, tripId, id, now);
  try {
    await bucket.put(key(user, id), bytes, { httpMetadata: { contentType } });
    await activateReceipt(database, user, tripId, id);
  } catch (error) {
    await abandonUpload(database, bucket, user, tripId, id, now).catch(() => {
      console.warn('TripTab receipt cleanup will retry on the next upload or deletion.');
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
  if (row.state === 'active' && !await markRemovedReceipts(database, user, [id])) {
    throw new ReceiptLifecycleError('This receipt is still attached to an expense or draft. Remove it from the receipt entry before deleting the image.', 409);
  }
  await purgeDeletingReceipts(database, bucket, user);
  const remaining = await database.prepare('SELECT state FROM receipts WHERE id = ?').bind(id).first<{ state: string }>();
  return { receiptId: id, deleted: !remaining, pending: !!remaining };
}
