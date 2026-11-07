import { canonicalJson, sha256Hex } from './data-utils';

/**
 * Durable receipt operations for paid receipt processing (R06/R07/R12).
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
 *   starts one new attempt.
 *
 * R07: the claim also stores the operation as a job (its validated request and
 * the claimant's execution grant), so the background runner can finish an
 * attempt that the platform cut off after the browser went away, without any
 * browser request. It resumes an interrupted attempt at most
 * MAX_AUTO_RESUMES times and never retries a failed one, a persistence
 * conflict, or a lost commit.
 *
 * Only the attempt that currently holds the claim may commit, and only while
 * its grant is live (R12: decided in the commit's own D1 transaction, see
 * operationCommitSql). The commit still requires the unchanged draft, members
 * and photo, so a superseded or late attempt can never add a second proposal.
 *
 * Spending limitation: the provider request is not stored (`store: false`),
 * so a call that the provider accepted for an attempt that was then cut off
 * cannot be retrieved. Resuming it calls the provider again. An interruption
 * after the provider call started can therefore cost one more call (at most
 * MAX_AUTO_RESUMES automatic ones, and one per explicit retry by a person).
 */
/** A browser request's attempt: its 90 s limit plus the commit. */
export const OPERATION_LEASE_MS = 120_000;
/** A background attempt: BACKGROUND_TIMEOUT_MS plus the commit. */
export const BACKGROUND_TIMEOUT_MS = 300_000;
export const BACKGROUND_LEASE_MS = 360_000;
/** How long the person's request authorizes work done on their behalf. */
export const GRANT_MS = 30 * 60_000;
export const MAX_AUTO_RESUMES = 1;
/** Settled records are kept for a week so late duplicates still find them. */
export const OPERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type OperationSource = {
  tripId: string; draftId: string; draftHash: string;
  receiptId?: string; imageVersion?: string;
  questionId?: string; readPurchaseDetails?: boolean;
};
/** Who authorized the work: a server-side session ID or a trusted ChatGPT identity. Never a cookie or token. */
export type ExecutionGrant = { kind: 'session' | 'chatgpt'; ref: string };
export type OperationProvider = 'api' | 'siwc';
export type OperationStatus = 'running' | 'stored' | 'failed';
export type Claim = { owned: true; key: string; attemptId: string; attempts: number; fence: OperationFence }
  | { owned: false; key: string; status: OperationStatus; attempts: number };

type Statement = { bind(...values: (string | number | null)[]): { first<T = Record<string, unknown>>(): Promise<T | null>; run(): Promise<unknown>; all?<T = Record<string, unknown>>(): Promise<{ results: T[] }> } };
type Database = { prepare(sql: string): Statement };

export function operationKind(source: Pick<OperationSource, 'questionId' | 'readPurchaseDetails'>) {
  return source.questionId ? `question:${source.questionId}` : source.readPurchaseDetails ? 'read:purchase-details' : 'read';
}

/** The operation's identity: what is read and how, never who asked. */
export async function operationKey(source: OperationSource) {
  return sha256Hex(canonicalJson({ v: 1, kind: operationKind(source), tripId: source.tripId, draftId: source.draftId,
    draftHash: source.draftHash, receiptId: source.receiptId ?? null, imageVersion: source.imageVersion ?? null }));
}

/** The stored job request: identifiers of the authorized source only. */
export function operationRequest(source: OperationSource): OperationSource {
  return { tripId: source.tripId, draftId: source.draftId, draftHash: source.draftHash,
    ...(source.receiptId ? { receiptId: source.receiptId } : {}), ...(source.imageVersion ? { imageVersion: source.imageVersion } : {}),
    ...(source.questionId ? { questionId: source.questionId } : {}), ...(source.readPurchaseDetails ? { readPurchaseDetails: true } : {}) };
}

export async function claimOperation(database: Database, source: OperationSource, userId: string,
  options: { now?: number; attemptId?: string; grant?: ExecutionGrant } = {}): Promise<Claim> {
  const now = options.now ?? Date.now(), attemptId = options.attemptId ?? crypto.randomUUID();
  const key = await operationKey(source);
  const grant = options.grant;
  // One statement decides the claim, so concurrent requests on separate
  // Worker instances cannot both win it. A takeover belongs to the request
  // that made it: its grant replaces the previous one, and its provider is
  // chosen afresh. Background resumes are a separate, bounded path.
  const row = await database.prepare(`INSERT INTO receipt_operations
      (operation_key, user_id, trip_id, draft_id, kind, status, attempt_id, attempts, lease_until, error_code, created_at, updated_at,
        request_json, grant_kind, grant_ref, grant_expires_at, provider, provider_started_at, auto_resumes)
    VALUES (?, ?, ?, ?, ?, 'running', ?, 1, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, 0)
    ON CONFLICT(operation_key) DO UPDATE SET status = 'running', attempt_id = excluded.attempt_id, attempts = receipt_operations.attempts + 1,
      lease_until = excluded.lease_until, user_id = excluded.user_id, error_code = NULL, updated_at = excluded.updated_at,
      request_json = excluded.request_json, grant_kind = excluded.grant_kind, grant_ref = excluded.grant_ref,
      grant_expires_at = excluded.grant_expires_at, provider = NULL, provider_started_at = NULL
    WHERE receipt_operations.status = 'failed' OR (receipt_operations.status = 'running' AND receipt_operations.lease_until < excluded.updated_at)
    RETURNING attempt_id, attempts`)
    .bind(key, userId, source.tripId, source.draftId, operationKind(source), attemptId, now + OPERATION_LEASE_MS, now, now,
      grant ? canonicalJson(operationRequest(source)) : null, grant?.kind ?? null, grant?.ref ?? null, grant ? now + GRANT_MS : null)
    .first<{ attempt_id: string; attempts: number }>();
  await database.prepare('DELETE FROM receipt_operations WHERE operation_key IN (SELECT operation_key FROM receipt_operations WHERE updated_at < ? AND status <> ? LIMIT 50)')
    .bind(now - OPERATION_RETENTION_MS, 'running').run();
  if (row?.attempt_id === attemptId) return { owned: true, key, attemptId, attempts: Number(row.attempts), fence: issue(key, attemptId) };
  const existing = await database.prepare('SELECT status, attempts FROM receipt_operations WHERE operation_key = ?').bind(key).first<{ status: OperationStatus; attempts: number }>();
  if (!existing) throw new Error('Receipt operation claim was not recorded');
  return { owned: false, key, status: existing.status, attempts: Number(existing.attempts) };
}

/**
 * R12: the trusted identity of the attempt that may commit an operation's
 * result. Only a successful claim creates one, and writeLedger accepts only
 * fences issued here, so no request body, MCP argument or other caller can
 * present itself as a reading's own write.
 */
export type OperationFence = { readonly key: string; readonly attemptId: string };
const issuedFences = new WeakSet<object>();
function issue(key: string, attemptId: string): OperationFence {
  const fence = Object.freeze({ key, attemptId });
  issuedFences.add(fence);
  return fence;
}
export function isOperationFence(value: unknown): value is OperationFence {
  return typeof value === 'object' && value !== null && issuedFences.has(value);
}
export function operationFence(claim: Extract<Claim, { owned: true }>): OperationFence {
  if (!claim.owned || !issuedFences.has(claim.fence)) throw new Error('Not an owned receipt operation');
  return claim.fence;
}

/**
 * R16: the database's own current time, evaluated inside the statement that
 * uses it. Deadlines are never compared with a time the Worker captured
 * earlier, so a session or grant that expires while a save is being prepared
 * is expired when the commit runs. SQLite keeps 'now' fixed within one step.
 */
export const DB_NOW_MS = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
export const DB_NOW_ISO = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/**
 * R15: whether a trusted ChatGPT identity still authenticates as an account,
 * using exactly the rules of lib/auth.ts authSnapshot/providerIdentity for a
 * request without a live TripTab session:
 * - a link from the provider identity to the account; or
 * - the legacy fallback, where the account ID is the provider ID, no link for
 *   that provider exists (so it was not remapped), and the account has no
 *   password (a legacy account with a password and no link was disconnected).
 * The account must exist and not be deleted. `provider` and `account` are SQL
 * expressions (columns), so this can sit inside a guarded commit statement.
 */
export function providerAuthenticatesAsSql(provider: string, account: string) {
  return `(EXISTS (SELECT 1 FROM profiles grant_profile WHERE grant_profile.id = ${account} AND grant_profile.deleted_at = '')
    AND (EXISTS (SELECT 1 FROM auth_links grant_link WHERE grant_link.oai_user_id = ${provider} AND grant_link.user_id = ${account})
      OR (${provider} = ${account}
        AND NOT EXISTS (SELECT 1 FROM auth_links any_link WHERE any_link.oai_user_id = ${provider})
        AND NOT EXISTS (SELECT 1 FROM auth_credentials grant_password WHERE grant_password.user_id = ${account}))))`;
}

/**
 * The condition under which an attempt may act for its operation: it holds
 * the claim, the writer is the person whose grant it carries, the grant has
 * not expired, the account exists, and the grant's server-side session is
 * still live (or its ChatGPT identity still authenticates as the account, R15).
 * Sign-out, session expiry or revocation, unlinking ChatGPT, remapping the
 * provider identity, account deletion and a takeover all make it false. Every
 * deadline is compared with the database's time inside the statement (R16).
 */
const OWNER_CONDITION = `EXISTS (SELECT 1 FROM receipt_operations o JOIN profiles p ON p.id = o.user_id AND p.deleted_at = ''
  WHERE o.operation_key = ? AND o.attempt_id = ? AND o.status = 'running' AND o.user_id = ? AND o.grant_expires_at > ${DB_NOW_MS}
    AND ((o.grant_kind = 'session' AND EXISTS (SELECT 1 FROM auth_sessions s WHERE s.session_id = o.grant_ref AND s.session_id <> ''
          AND s.user_id = o.user_id AND s.expires_at > ${DB_NOW_ISO}))
      OR (o.grant_kind = 'chatgpt' AND ${providerAuthenticatesAsSql('o.grant_ref', 'o.user_id')})))`;
const ownerBindings = (fence: OperationFence, userId: string) => [fence.key, fence.attemptId, userId];

/**
 * R12: SQL for writeLedger's commit transaction. `gate` is a condition the
 * commit's guarded UPDATE must satisfy, so ownership and authorization are
 * decided by the same statement that admits the ledger write; `complete`
 * records the outcome in the same batch, conditional on that write having
 * been admitted. A takeover, sign-out or expiry that lands at any moment
 * before the batch makes the gate false, and the whole write (ledger,
 * history, completion) does not happen.
 */
export function operationCommitSql(fence: OperationFence, userId: string, now = Date.now()) {
  if (!isOperationFence(fence)) throw new Error('Untrusted receipt operation');
  return {
    gate: OWNER_CONDITION,
    gateBindings: ownerBindings(fence, userId) as (string | number)[],
    complete: `UPDATE receipt_operations SET status = 'stored', error_code = NULL, updated_at = ?
      WHERE operation_key = ? AND attempt_id = ? AND status = 'running' AND EXISTS (SELECT 1 FROM sync_state WHERE id = 1 AND last_write = ?)`,
    completeBindings: (marker: string) => [now, fence.key, fence.attemptId, marker] as (string | number)[],
  };
}

/** Whether the attempt may still act (advisory: the commit decides again inside its transaction). */
export async function operationAuthorized(database: Database, fence: OperationFence, userId: string) {
  return !!await database.prepare(`SELECT ${OWNER_CONDITION} AS ok`).bind(...ownerBindings(fence, userId)).first<{ ok: number }>()
    .then(row => row?.ok);
}

/**
 * Record, just before the provider call, which credential kind this attempt
 * spends with. Refused (so nothing is spent) when the attempt no longer owns
 * the operation, its grant ended, or a resumed attempt would switch to a
 * different credential kind than the person's request started with.
 */
export async function startProviderCall(database: Database, fence: OperationFence, userId: string, provider: OperationProvider, now = Date.now()) {
  const row = await database.prepare(`UPDATE receipt_operations SET provider = ?, provider_started_at = ?, updated_at = ?
    WHERE operation_key = ? AND attempt_id = ? AND (provider IS NULL OR provider = ?) AND ${OWNER_CONDITION} RETURNING attempt_id`)
    .bind(provider, now, now, fence.key, fence.attemptId, provider, ...ownerBindings(fence, userId)).first<{ attempt_id: string }>();
  return !!row;
}

/**
 * Whether this attempt still holds the claim. This is advisory only (it lets a
 * superseded attempt stop early, or names why a fenced commit was refused):
 * the commit itself is fenced inside writeLedger's transaction.
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

/**
 * Owner kill switch. Background resumes run only when RECEIPT_BACKGROUND_RESUME
 * is unset, empty or "on". Any other value ("off", "false", "0", a typo) stops
 * them: this check fails safe. While it is off, the runner reads and writes
 * nothing and spends nothing. Interrupted readings behave as before R07: they
 * stay as they are until the person reads the receipt again, which takes the
 * operation over as one new attempt. Turning it back on resumes operations
 * whose grant has not expired.
 */
export function backgroundResumeEnabled(environment: { RECEIPT_BACKGROUND_RESUME?: string }) {
  const value = environment.RECEIPT_BACKGROUND_RESUME?.trim().toLowerCase();
  return !value || value === 'on';
}

export type ResumableOperation = { key: string; userId: string; request: OperationSource; provider: OperationProvider | null };

/**
 * R07: settle interrupted operations that may not be resumed, and list those
 * that may. An interruption is a 'running' attempt whose lease ran out without
 * an outcome (the platform ended it). Failed operations are never listed.
 */
export async function interruptedOperations(database: Database, now = Date.now(), limit = 5): Promise<ResumableOperation[]> {
  // Expired grants and exhausted (or pre-R07, request-less) interruptions end
  // as failed, so they show as "didn't finish" and a person may retry.
  await database.prepare(`UPDATE receipt_operations SET status = 'failed', updated_at = ?,
      error_code = CASE WHEN request_json IS NULL OR auto_resumes >= ? THEN 'interrupted' ELSE 'authorization-expired' END
    WHERE operation_key IN (SELECT operation_key FROM receipt_operations WHERE status = 'running' AND lease_until < ?
      AND (request_json IS NULL OR auto_resumes >= ? OR grant_expires_at IS NULL OR grant_expires_at <= ?) LIMIT 50)`)
    .bind(now, MAX_AUTO_RESUMES, now, MAX_AUTO_RESUMES, now).run();
  const statement = database.prepare(`SELECT operation_key, user_id, request_json, provider FROM receipt_operations
    WHERE status = 'running' AND lease_until < ? AND request_json IS NOT NULL AND auto_resumes < ? AND grant_expires_at > ?
    ORDER BY lease_until LIMIT ?`).bind(now, MAX_AUTO_RESUMES, now, limit);
  const rows = statement.all ? (await statement.all<{ operation_key: string; user_id: string; request_json: string; provider: OperationProvider | null }>()).results : [];
  return rows.flatMap(row => {
    try { return [{ key: row.operation_key, userId: row.user_id, request: JSON.parse(row.request_json) as OperationSource, provider: row.provider }]; }
    catch { return []; }
  });
}

/**
 * R07: take over an interrupted operation for one background attempt. One
 * statement decides it, so overlapping or duplicate runner invocations (and
 * a person's request racing the runner) produce one owner. The grant is kept:
 * the runner acts only for the person whose request started the work.
 */
export async function claimResume(database: Database, key: string, options: { now?: number; attemptId?: string } = {}): Promise<Claim> {
  const now = options.now ?? Date.now(), attemptId = options.attemptId ?? crypto.randomUUID();
  const row = await database.prepare(`UPDATE receipt_operations SET attempt_id = ?, attempts = attempts + 1, auto_resumes = auto_resumes + 1,
      lease_until = ?, updated_at = ?, error_code = NULL, provider_started_at = NULL
    WHERE operation_key = ? AND status = 'running' AND lease_until < ? AND request_json IS NOT NULL AND auto_resumes < ? AND grant_expires_at > ?
    RETURNING attempt_id, attempts`)
    .bind(attemptId, now + BACKGROUND_LEASE_MS, now, key, now, MAX_AUTO_RESUMES, now).first<{ attempt_id: string; attempts: number }>();
  if (row?.attempt_id === attemptId) return { owned: true, key, attemptId, attempts: Number(row.attempts), fence: issue(key, attemptId) };
  const existing = await database.prepare('SELECT status, attempts FROM receipt_operations WHERE operation_key = ?').bind(key).first<{ status: OperationStatus; attempts: number }>();
  return { owned: false, key, status: existing?.status ?? 'failed', attempts: Number(existing?.attempts ?? 0) };
}
