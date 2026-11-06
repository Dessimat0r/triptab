import { canonicalJson, sha256Hex } from './data-utils';

/**
 * Durable claims for paid receipt processing (R06/R07).
 *
 * Every paid reading or assistant answer is one logical operation, keyed to
 * the authorized source it reads and the kind of work. A request claims the
 * operation in D1 before it spends anything:
 *
 * - no record: it inserts one ('running', with a lease) and does the work;
 * - 'running' within its lease: another request is already doing it, so this
 *   one returns without a provider call (202);
 * - 'stored': the proposal is already saved; return the ledger;
 * - 'failed', or 'running' past its lease (the attempt crashed, timed out or
 *   was cut off after a disconnect): a new request may take it over, which
 *   starts one new attempt. Nothing retries automatically.
 *
 * Only the attempt that currently holds the claim may commit, and the commit
 * still requires the unchanged draft, members and photo, so a superseded or
 * late attempt can never add a second proposal. A provider call that was
 * accepted by an attempt that then crashed is not refunded or deduplicated:
 * the person's next retry spends once more. That window is not exactly-once.
 */
export const OPERATION_LEASE_MS = 120_000;
/** Settled records are kept for a week so late duplicates still find them. */
export const OPERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type OperationSource = {
  tripId: string; draftId: string; draftHash: string;
  receiptId?: string; imageVersion?: string;
  questionId?: string; readPurchaseDetails?: boolean;
};
export type OperationStatus = 'running' | 'stored' | 'failed';
export type Claim = { owned: true; key: string; attemptId: string; attempts: number }
  | { owned: false; key: string; status: OperationStatus; attempts: number };

type Statement = { bind(...values: (string | number | null)[]): { first<T = Record<string, unknown>>(): Promise<T | null>; run(): Promise<unknown> } };
type Database = { prepare(sql: string): Statement };

export function operationKind(source: Pick<OperationSource, 'questionId' | 'readPurchaseDetails'>) {
  return source.questionId ? `question:${source.questionId}` : source.readPurchaseDetails ? 'read:purchase-details' : 'read';
}

/** The operation's identity: what is read and how, never who asked. */
export async function operationKey(source: OperationSource) {
  return sha256Hex(canonicalJson({ v: 1, kind: operationKind(source), tripId: source.tripId, draftId: source.draftId,
    draftHash: source.draftHash, receiptId: source.receiptId ?? null, imageVersion: source.imageVersion ?? null }));
}

export async function claimOperation(database: Database, source: OperationSource, userId: string, options: { now?: number; attemptId?: string } = {}): Promise<Claim> {
  const now = options.now ?? Date.now(), attemptId = options.attemptId ?? crypto.randomUUID();
  const key = await operationKey(source);
  // One statement decides the claim, so concurrent requests on separate
  // Worker instances cannot both win it.
  const row = await database.prepare(`INSERT INTO receipt_operations
      (operation_key, user_id, trip_id, draft_id, kind, status, attempt_id, attempts, lease_until, error_code, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'running', ?, 1, ?, NULL, ?, ?)
    ON CONFLICT(operation_key) DO UPDATE SET status = 'running', attempt_id = excluded.attempt_id, attempts = receipt_operations.attempts + 1,
      lease_until = excluded.lease_until, user_id = excluded.user_id, error_code = NULL, updated_at = excluded.updated_at
    WHERE receipt_operations.status = 'failed' OR (receipt_operations.status = 'running' AND receipt_operations.lease_until < excluded.updated_at)
    RETURNING attempt_id, attempts`)
    .bind(key, userId, source.tripId, source.draftId, operationKind(source), attemptId, now + OPERATION_LEASE_MS, now, now)
    .first<{ attempt_id: string; attempts: number }>();
  await database.prepare('DELETE FROM receipt_operations WHERE operation_key IN (SELECT operation_key FROM receipt_operations WHERE updated_at < ? AND status <> ? LIMIT 50)')
    .bind(now - OPERATION_RETENTION_MS, 'running').run();
  if (row?.attempt_id === attemptId) return { owned: true, key, attemptId, attempts: Number(row.attempts) };
  const existing = await database.prepare('SELECT status, attempts FROM receipt_operations WHERE operation_key = ?').bind(key).first<{ status: OperationStatus; attempts: number }>();
  if (!existing) throw new Error('Receipt operation claim was not recorded');
  return { owned: false, key, status: existing.status, attempts: Number(existing.attempts) };
}

/**
 * Whether this attempt still holds the claim, so its result may be committed.
 * A takeover replaces the attempt ID, so a slow attempt that nobody replaced
 * may still commit after its lease; a replaced one never can.
 */
export async function holdsOperation(database: Database, key: string, attemptId: string) {
  const row = await database.prepare("SELECT 1 AS held FROM receipt_operations WHERE operation_key = ? AND attempt_id = ? AND status = 'running'")
    .bind(key, attemptId).first<{ held: number }>();
  return !!row;
}

/** Record this attempt's outcome. A superseded attempt changes nothing. */
export async function finishOperation(database: Database, key: string, attemptId: string, status: 'stored' | 'failed', options: { errorCode?: string; now?: number } = {}) {
  const now = options.now ?? Date.now();
  const row = await database.prepare(`UPDATE receipt_operations SET status = ?, error_code = ?, updated_at = ?
    WHERE operation_key = ? AND attempt_id = ? AND status = 'running' RETURNING attempt_id`)
    .bind(status, status === 'failed' ? (options.errorCode ?? 'processing-failed').slice(0, 80) : null, now, key, attemptId).first<{ attempt_id: string }>();
  return !!row;
}
