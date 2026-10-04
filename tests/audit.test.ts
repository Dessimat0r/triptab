import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import { accountAuditStatement, activityStatements, readAccountActivity, type AccountAuditChange, type ActivityChange } from '../lib/audit';

class SQLiteStatement {
  private values: SQLInputValue[] = [];
  constructor(private readonly sqlite: DatabaseSync, readonly sql: string) {}
  bind(...values: SQLInputValue[]) { this.values = values; return this; }
  async all<T>() { return { results: this.sqlite.prepare(this.sql).all(...this.values) as T[] }; }
  runSync() {
    const statement = this.sqlite.prepare(this.sql);
    const results = statement.columns().length ? statement.all(...this.values) : (statement.run(...this.values), []);
    return { results, meta: { changes: Number(this.sqlite.prepare('SELECT changes() AS count').get()!.count) } };
  }
  async run() { return this.runSync(); }
}
class SQLiteD1 {
  readonly sqlite = new DatabaseSync(':memory:');
  prepare(sql: string) { return new SQLiteStatement(this.sqlite, sql); }
  async batch(statements: D1PreparedStatement[]) {
    this.sqlite.exec('BEGIN');
    try {
      const results = statements.map(statement => (statement as unknown as SQLiteStatement).runSync());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  asD1() { return this as unknown as D1Database; }
}
async function storage() {
  const database = new SQLiteD1();
  const migrations = (await readdir(new URL('../drizzle/', import.meta.url))).filter(name => name.endsWith('.sql')).sort();
  assert.ok(migrations.includes('0005_audit_coverage.sql'));
  for (const name of migrations) database.sqlite.exec(await readFile(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'));
  return database;
}
const always = { sql: '1', bindings: [] };
const account = (userId = 'alice', index = 0): AccountAuditChange => ({
  userId, actorName: userId === 'alice' ? 'Alice' : 'Bob', entityType: 'profile', entityId: userId, action: 'update',
  before: { displayName: `Name ${index}` }, after: { displayName: `Name ${index + 1}` },
});
const shared = (entityId = 'expense'): ActivityChange => ({
  tripId: 'holiday', entityType: 'expense', entityId, action: 'create', before: null,
  after: { id: entityId, title: 'Lunch', amount: 1234, currency: 'EUR' },
});
function count(database: SQLiteD1, table: 'activity_events' | 'account_activity_events') {
  return Number(database.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count);
}

test('private account cursors return only that owner, with bounded descending pages and no duplicate events', async () => {
  const database = await storage();
  const statements: D1PreparedStatement[] = [];
  for (let index = 0; index < 53; index++) {
    statements.push(accountAuditStatement(database.asD1(), account('alice', index), always));
    if (index % 2 === 0) statements.push(accountAuditStatement(database.asD1(), account('bob', index), always));
  }
  await database.batch(statements);
  const first = await readAccountActivity(database.asD1(), 'alice', { limit: 50 });
  assert.equal(first.events.length, 50);
  assert.equal(first.nextCursor, first.events.at(-1)!.sequence);
  const second = await readAccountActivity(database.asD1(), 'alice', { limit: 50, before: first.nextCursor! });
  assert.equal(second.events.length, 3);
  assert.equal(second.nextCursor, null);
  const events = [...first.events, ...second.events];
  assert.equal(new Set(events.map(event => event.id)).size, 53);
  assert.ok(events.every((event, index) => event.userId === 'alice' && event.actorName === 'Alice'
    && (index === 0 || event.sequence < events[index - 1].sequence)));
  assert.ok(events.every(event => event.source === 'web' && /^\d{4}-\d\d-\d\dT.*Z$/.test(event.createdAt)));
  assert.deepEqual(events[0].before, { displayName: 'Name 52' });
  assert.deepEqual(events[0].after, { displayName: 'Name 53' });
  const bob = await readAccountActivity(database.asD1(), 'bob', { limit: 50 });
  assert.equal(bob.events.length, 27);
  assert.ok(bob.events.every(event => event.userId === 'bob'));
  const borrowedCursor = await readAccountActivity(database.asD1(), 'alice', { before: bob.events[0].sequence });
  assert.ok(borrowedCursor.events.every(event => event.userId === 'alice' && event.sequence < bob.events[0].sequence));
  assert.equal((await readAccountActivity(database.asD1(), 'alice')).events.length, 20);
  assert.deepEqual(await readAccountActivity(database.asD1(), "alice' OR 1=1 --"), { events: [], nextCursor: null });
  assert.deepEqual(await readAccountActivity(database.asD1(), 'alice', { before: events.at(-1)!.sequence }), { events: [], nextCursor: null });
});

test('private history rejects invalid page sizes and unsafe cursors before issuing a read', async () => {
  const database = await storage();
  const invalid = [
    ...[0, -1, 51, 1.5, NaN, Infinity].map(limit => ({ limit })),
    ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(before => ({ before })),
  ];
  for (const options of invalid) await assert.rejects(readAccountActivity(database.asD1(), 'alice', options), /INVALID_ACCOUNT_ACTIVITY_PAGE/);
  assert.deepEqual(await readAccountActivity(database.asD1(), 'alice', { limit: 1, before: Number.MAX_SAFE_INTEGER }), { events: [], nextCursor: null });
  assert.equal(count(database, 'account_activity_events'), 0);
});

test('account helper refuses credentials, provider/device secrets and nested snapshot payloads on both sides', async () => {
  const database = await storage();
  const forbidden = [
    { password: 'secret' }, { currentPassword: 'secret' }, { password_hash: 'secret' }, { passwordSalt: 'secret' },
    { token: 'secret' }, { token_hash: 'secret' }, { cookie: 'secret' }, { endpoint: 'https://push.test/secret' },
    { oai_user_id: 'provider-secret' }, { providerId: 'provider-secret' }, { email: 'private@example.test' },
    { ip: '192.0.2.1' }, { url: 'https://private.test/secret' },
    { reason: { token: 'nested-secret' } }, { reason: ['nested-secret'] }, { reason: undefined },
  ];
  for (const snapshot of forbidden) {
    for (const side of ['before', 'after'] as const) {
      assert.throws(() => accountAuditStatement(database.asD1(), { ...account(), [side]: snapshot }, always), /safe state flags and descriptions only/);
    }
  }
  assert.equal(count(database, 'account_activity_events'), 0);
  await database.batch([accountAuditStatement(database.asD1(), { ...account(), source: 'system', before: null,
    after: { enabled: false, attempts: 1, service: 'fcm.googleapis.com', reason: 'provider_expired', previous: null } }, always)]);
  const event = (await readAccountActivity(database.asD1(), 'alice')).events[0];
  assert.equal(event.source, 'system');
  assert.equal(event.before, null);
  assert.deepEqual(event.after, { enabled: false, attempts: 1, service: 'fcm.googleapis.com', reason: 'provider_expired', previous: null });
});

test('private snapshot limits count UTF-8 bytes and accept the exact 4096-byte boundary', async () => {
  const database = await storage();
  const overhead = Buffer.byteLength(JSON.stringify({ displayName: '' }));
  const text = 'é'.repeat(Math.floor((4096 - overhead) / 2)) + 'a'.repeat((4096 - overhead) % 2);
  const snapshot = { displayName: text };
  assert.equal(Buffer.byteLength(JSON.stringify(snapshot)), 4096);
  assert.ok(JSON.stringify(snapshot).length < 4096);
  await database.batch([accountAuditStatement(database.asD1(), { ...account(), before: snapshot, after: snapshot }, always)]);
  const event = (await readAccountActivity(database.asD1(), 'alice')).events[0];
  assert.deepEqual(event.before, snapshot);
  assert.deepEqual(event.after, snapshot);
  const tooLarge = { displayName: text + 'é' };
  assert.ok(JSON.stringify(tooLarge).length < 4096, 'a character count would incorrectly accept this payload');
  for (const side of ['before', 'after'] as const) {
    assert.throws(() => accountAuditStatement(database.asD1(), { ...account(), [side]: tooLarge }, always), /snapshot is too large/);
  }
  assert.equal(count(database, 'account_activity_events'), 1);
});

test('private mutation guards record only committed changes and roll back a change if its event fails', async () => {
  const database = await storage();
  database.sqlite.prepare('INSERT INTO profiles (id,email,display_name,created_at) VALUES (?,?,?,?)')
    .run('alice', 'alice@example.test', 'Alice', '2026-10-04T00:00:00Z');
  const rename = async (before: string, after: string) => database.batch([
    database.prepare('UPDATE profiles SET display_name=? WHERE id=? AND display_name=? AND display_name<>?').bind(after, 'alice', before, after) as unknown as D1PreparedStatement,
    accountAuditStatement(database.asD1(), { ...account(), before: { displayName: before }, after: { displayName: after } }),
  ]);
  await rename('Alice', 'Alicia');
  await rename('Alicia', 'Alicia');
  await rename('Alice', 'Wrong stale name');
  await database.batch([accountAuditStatement(database.asD1(), account(), {
    sql: 'EXISTS (SELECT 1 FROM profiles WHERE id=? AND display_name=?)', bindings: ['alice', 'Wrong stale name'],
  })]);
  assert.equal(count(database, 'account_activity_events'), 1);
  database.sqlite.exec("CREATE TRIGGER refuse_private_event BEFORE INSERT ON account_activity_events BEGIN SELECT RAISE(ABORT, 'audit-write-failed'); END;");
  await assert.rejects(rename('Alicia', 'Unrecorded name'), /audit-write-failed/);
  assert.equal(database.sqlite.prepare('SELECT display_name FROM profiles WHERE id=?').get('alice')!.display_name, 'Alicia');
  assert.equal(count(database, 'account_activity_events'), 1);
  assert.deepEqual((await readAccountActivity(database.asD1(), 'alice')).events[0].after, { displayName: 'Alicia' });
});

test('a later batch failure rolls back the mutation and events in both audit streams', async () => {
  const database = await storage();
  database.sqlite.prepare('INSERT INTO profiles (id,email,display_name,created_at) VALUES (?,?,?,?)')
    .run('alice', 'alice@example.test', 'Alice', '2026-10-04T00:00:00Z');
  await assert.rejects(database.batch([
    database.prepare('UPDATE profiles SET display_name=? WHERE id=?').bind('Alicia', 'alice') as unknown as D1PreparedStatement,
    accountAuditStatement(database.asD1(), { ...account(), before: { displayName: 'Alice' }, after: { displayName: 'Alicia' } }),
    ...activityStatements(database.asD1(), [shared()], { id: 'alice', displayName: 'Alice' }, '', 1, 'web', always),
    database.prepare('INSERT INTO profiles (id,email,display_name,created_at) VALUES (?,?,?,?)')
      .bind('alice', 'duplicate@example.test', 'Duplicate', '2026-10-04T00:00:00Z') as unknown as D1PreparedStatement,
  ]), /UNIQUE constraint failed/);
  assert.equal(database.sqlite.prepare('SELECT display_name FROM profiles WHERE id=?').get('alice')!.display_name, 'Alice');
  assert.equal(count(database, 'account_activity_events'), 0);
  assert.equal(count(database, 'activity_events'), 0);
});

test('shared helper gates stale writes and retains every full multilingual snapshot across bounded chunks', async () => {
  const database = await storage();
  database.sqlite.prepare('INSERT INTO sync_state (id,revision,last_write) VALUES (1,?,?)').run(7, 'committed-write');
  const changes = [
    { ...shared('first'), after: { id: 'first', text: 'café🍫'.repeat(45_000) } },
    { ...shared('second'), after: { id: 'second', text: 'café🍫'.repeat(45_000) } },
    { ...shared('third'), after: { id: 'third', text: 'café🍫'.repeat(45_000) } },
    { ...shared('large'), action: 'delete' as const, before: { id: 'large', text: '🍫'.repeat(270_000) }, after: null },
  ];
  const actor = { id: 'alice', displayName: 'A'.repeat(100) };
  await database.batch(activityStatements(database.asD1(), changes, actor, 'stale-write', 8, 'chatgpt'));
  assert.equal(count(database, 'activity_events'), 0);
  const recorded = activityStatements(database.asD1(), changes, actor, 'committed-write', 8, 'chatgpt');
  assert.ok(recorded.length > 1, 'large snapshots must cross the single-statement branch');
  await database.batch(recorded);
  const events = database.sqlite.prepare('SELECT * FROM activity_events ORDER BY sequence').all();
  assert.equal(events.length, changes.length);
  for (const [index, event] of events.entries()) {
    assert.equal(event.entity_id, changes[index].entityId);
    assert.equal(event.actor_id, 'alice');
    assert.equal(event.actor_name, 'A'.repeat(80));
    assert.equal(event.revision, 8);
    assert.equal(event.source, 'chatgpt');
    assert.deepEqual(event.before_data === null ? null : JSON.parse(String(event.before_data)), changes[index].before);
    assert.deepEqual(event.after_data === null ? null : JSON.parse(String(event.after_data)), changes[index].after);
  }
  assert.equal(new Set(events.map(event => event.id)).size, changes.length);
});

test('current shared revisions are captured inside the batch in both compact and oversized audit paths', async () => {
  const database = await storage();
  database.sqlite.prepare('INSERT INTO sync_state (id,revision,last_write) VALUES (1,?,?)').run(7, 'old-financial-write');
  const changes = [shared('compact'), { ...shared('large'), after: { id: 'large', text: 'é'.repeat(510_000) } }];
  const statements = activityStatements(database.asD1(), changes, { id: 'alice', displayName: 'Alice' }, '', 'current', 'web', always);
  assert.equal(statements.length, 2, 'Both the compact JSON and oversized single-record SQL paths are covered');
  database.sqlite.prepare('UPDATE sync_state SET revision=?,last_write=? WHERE id=1').run(12, 'concurrent-financial-write');
  await database.batch(statements);
  const events = database.sqlite.prepare('SELECT entity_id,revision,source,after_data FROM activity_events ORDER BY sequence').all();
  assert.deepEqual(events.map(event => event.revision), [12, 12]);
  assert.deepEqual(events.map(event => event.entity_id), ['compact', 'large']);
  assert.deepEqual(events.map(event => JSON.parse(String(event.after_data))), changes.map(change => change.after));
  assert.ok(events.every(event => event.source === 'web'));
  assert.deepEqual({ ...database.sqlite.prepare('SELECT revision,last_write FROM sync_state WHERE id=1').get()! }, { revision: 12, last_write: 'concurrent-financial-write' });
  await database.batch(activityStatements(database.asD1(), [shared('blocked')], { id: 'alice', displayName: 'Alice' }, '', 'current', 'web', { sql: '0', bindings: [] }));
  assert.equal(count(database, 'activity_events'), 2, 'Current revision metadata does not weaken the mutation gate');
});

for (const table of ['activity_events', 'account_activity_events'] as const) {
  test(`${table} rejects UPDATE, DELETE and replacement by either identifier with recursive triggers disabled`, async () => {
    const database = await storage();
    database.sqlite.exec('PRAGMA recursive_triggers=0');
    assert.equal(database.sqlite.prepare('PRAGMA recursive_triggers').get()!.recursive_triggers, 0);
    if (table === 'activity_events') await database.batch(activityStatements(database.asD1(), [shared()], { id: 'alice', displayName: 'Alice' }, '', 1, 'web', always));
    else await database.batch([accountAuditStatement(database.asD1(), account(), always)]);
    const before = database.sqlite.prepare(`SELECT * FROM ${table}`).get()!;
    const columns = Object.keys(before);
    const insert = (row: Record<string, SQLInputValue>, includeSequence = true) => {
      const selected = includeSequence ? columns : columns.filter(column => column !== 'sequence');
      return database.sqlite.prepare(`INSERT OR REPLACE INTO ${table} (${selected.join(',')}) VALUES (${selected.map(() => '?').join(',')})`)
        .run(...selected.map(column => row[column]));
    };
    assert.throws(() => database.sqlite.prepare(`UPDATE ${table} SET actor_name=? WHERE id=?`).run('Forged actor', before.id), /append-only/);
    assert.throws(() => database.sqlite.prepare(`DELETE FROM ${table} WHERE id=?`).run(before.id), /append-only/);
    assert.throws(() => insert({ ...before, actor_name: 'Forged actor' }, false), /append-only/, 'a new sequence cannot replace an existing event ID');
    assert.throws(() => insert({ ...before, id: crypto.randomUUID(), actor_name: 'Forged actor' }), /append-only/, 'a new ID cannot replace an existing sequence');
    assert.throws(() => insert({ ...before, actor_name: 'Forged actor' }), /append-only/);
    assert.deepEqual(database.sqlite.prepare(`SELECT * FROM ${table}`).all(), [before]);
    // Protection must still allow a genuinely new append, not freeze the table.
    if (table === 'activity_events') await database.batch(activityStatements(database.asD1(), [shared('next')], { id: 'bob', displayName: 'Bob' }, '', 2, 'web', always));
    else await database.batch([accountAuditStatement(database.asD1(), account('bob'), always)]);
    assert.equal(count(database, table), 2);
    assert.deepEqual(database.sqlite.prepare(`SELECT * FROM ${table} WHERE id=?`).get(before.id), before);
  });
}
