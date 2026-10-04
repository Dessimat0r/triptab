/** Audit records contain server-attributed state changes, never credentials. */
export type AuditGate = { sql: string; bindings: unknown[] };
export type ActivityEntity = 'trip' | 'member' | 'expense' | 'payment' | 'draft' | 'invite' | 'receipt';
export type ActivitySource = 'web' | 'chatgpt' | 'system';
export type ActivityChange = {
  tripId: string; entityType: ActivityEntity; entityId: string;
  action: 'create' | 'update' | 'delete';
  before: Record<string, unknown> | null; after: Record<string, unknown> | null;
};
export type ActivityEvent = ActivityChange & {
  id: string; sequence: number; actorId: string; actorName: string;
  createdAt: string; revision: number; source: ActivitySource;
};

/** Append within the mutation's D1 batch; a failed gate produces no events. */
export function activityStatements(database: D1Database, changes: ActivityChange[], actor: { id: string; displayName: string }, marker: string, revision: number | 'current', source: ActivitySource = 'web', gate?: AuditGate): D1PreparedStatement[] {
  const condition = gate ?? { sql: 'EXISTS (SELECT 1 FROM sync_state WHERE id = 1 AND last_write = ?)', bindings: [marker] };
  // Invitation-only mutations have their own snapshot gates. Record the ledger
  // version inside their transaction without changing or comparing that version.
  const revisionSql = revision === 'current' ? 'COALESCE((SELECT revision FROM sync_state WHERE id = 1), 0)' : '?';
  const revisionBindings = revision === 'current' ? [] : [revision];
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  let chunk: (ActivityChange & { id: string })[] = [];
  let size = 0;
  const flush = () => {
    if (!chunk.length) return;
    statements.push(database.prepare(`
      INSERT INTO activity_events (id, trip_id, actor_id, actor_name, created_at, entity_type, entity_id, action, before_data, after_data, revision, source)
      SELECT json_extract(j.value, '$.id'), json_extract(j.value, '$.tripId'), ?, ?, ?,
        json_extract(j.value, '$.entityType'), json_extract(j.value, '$.entityId'), json_extract(j.value, '$.action'),
        json_extract(j.value, '$.before'), json_extract(j.value, '$.after'), ${revisionSql}, ?
      FROM json_each(?) j WHERE ${condition.sql}
    `).bind(actor.id, actor.displayName.slice(0, 80), now, ...revisionBindings, source, JSON.stringify(chunk), ...condition.bindings));
    chunk = []; size = 0;
  };
  for (const change of changes) {
    const event = { ...change, id: crypto.randomUUID() };
    const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
    if (bytes > 1_000_000) {
      flush();
      statements.push(database.prepare(`
        INSERT INTO activity_events (id, trip_id, actor_id, actor_name, created_at, entity_type, entity_id, action, before_data, after_data, revision, source)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${revisionSql}, ? WHERE ${condition.sql}
      `).bind(event.id, event.tripId, actor.id, actor.displayName.slice(0, 80), now, event.entityType, event.entityId, event.action,
        event.before ? JSON.stringify(event.before) : null, event.after ? JSON.stringify(event.after) : null, ...revisionBindings, source, ...condition.bindings));
    } else {
      if (size + bytes > 1_000_000) flush();
      chunk.push(event); size += bytes + 1;
    }
  }
  flush();
  return statements;
}

export type AccountAuditEntity = 'profile' | 'password' | 'session' | 'chatgpt' | 'notifications';
export type AccountAuditChange = {
  userId: string; actorName: string; entityType: AccountAuditEntity; entityId: string;
  action: ActivityChange['action']; before: Record<string, unknown> | null; after: Record<string, unknown> | null;
  source?: ActivitySource;
};
export type AccountAuditEvent = Omit<AccountAuditChange, 'source'> & {
  id: string; sequence: number; createdAt: string; source: ActivitySource;
};
type AccountAuditRow = {
  id: string; sequence: number; user_id: string; actor_name: string; created_at: string;
  entity_type: AccountAuditEntity; entity_id: string; action: ActivityChange['action'];
  before_data: string | null; after_data: string | null; source: ActivitySource;
};

const forbiddenFields = new Set(['email', 'password', 'currentPassword', 'passwordHash', 'passwordSalt', 'password_hash', 'password_salt', 'token', 'tokenHash', 'token_hash', 'endpoint', 'cookie', 'providerId', 'oaiUserId', 'oai_user_id', 'ip', 'url']);
function privateSnapshot(value: Record<string, unknown> | null): string | null {
  if (value === null) return null;
  for (const [key, field] of Object.entries(value)) {
    if (forbiddenFields.has(key) || (field !== null && !['string', 'number', 'boolean'].includes(typeof field))) {
      throw new Error('Account audit snapshots must contain safe state flags and descriptions only.');
    }
  }
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).byteLength > 4096) throw new Error('Account audit snapshot is too large.');
  return json;
}

/** Use immediately after a mutation, or pass its exact SQL success guard. */
export function accountAuditStatement(database: D1Database, change: AccountAuditChange, gate: AuditGate = { sql: 'changes() > 0', bindings: [] }): D1PreparedStatement {
  return database.prepare(`
    INSERT INTO account_activity_events (id, user_id, actor_name, created_at, entity_type, entity_id, action, before_data, after_data, source)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${gate.sql}
  `).bind(crypto.randomUUID(), change.userId, change.actorName.slice(0, 80), new Date().toISOString(), change.entityType, change.entityId,
    change.action, privateSnapshot(change.before), privateSnapshot(change.after), change.source ?? 'web', ...gate.bindings);
}

export function accountEvent(row: AccountAuditRow): AccountAuditEvent {
  return { id: row.id, sequence: row.sequence, userId: row.user_id, actorName: row.actor_name, createdAt: row.created_at,
    entityType: row.entity_type, entityId: row.entity_id, action: row.action,
    before: row.before_data ? JSON.parse(row.before_data) : null, after: row.after_data ? JSON.parse(row.after_data) : null, source: row.source };
}

/** Account history is always scoped to the authenticated account, never a trip. */
export async function readAccountActivity(database: D1Database, userId: string, options: { before?: number; limit?: number } = {}) {
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || (options.before !== undefined && (!Number.isSafeInteger(options.before) || options.before < 1))) {
    throw new Error('INVALID_ACCOUNT_ACTIVITY_PAGE');
  }
  const result = await database.prepare(`
    SELECT * FROM account_activity_events WHERE user_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?
  `).bind(userId, options.before ?? Number.MAX_SAFE_INTEGER, limit + 1).all<AccountAuditRow>();
  const rows = result.results.slice(0, limit);
  return { events: rows.map(accountEvent), nextCursor: result.results.length > limit ? rows.at(-1)!.sequence : null };
}
