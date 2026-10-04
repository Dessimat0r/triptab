import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Log, LogLevel, Miniflare } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import { receiptActivityScope, resolveReceiptActivityFamily, type ReceiptActivityScope } from '../lib/activity-scope';

type NativeDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>;
type Snapshot = Record<string, unknown>;
type ScopeRow = { id: string; sequence: number };
const tripId = 'native-holiday';

async function nativeDatabase(run: (database: NativeDatabase) => Promise<void>) {
  // This is workerd's native D1 engine, not the Node SQLite shim. Nothing is
  // persisted to the shared Wrangler state or sent to a hosted database.
  const worker = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("Native D1 test"); } };',
    compatibilityDate: '2026-05-15',
    d1Databases: { DB: 'receipt-scope-native' },
    d1Persist: false,
    log: new Log(LogLevel.NONE),
  });
  try {
    const database = await worker.getD1Database('DB');
    // Minimal functional schema keeps this regression focused on the actual
    // family SQL and its real indexes; route identity tests live separately.
    await database.prepare('CREATE TABLE trips (id TEXT PRIMARY KEY, data TEXT NOT NULL)').run();
    await database.prepare(`CREATE TABLE activity_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE, trip_id TEXT NOT NULL,
      entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      before_data TEXT, after_data TEXT
    )`).run();
    const indexes = await readFile(new URL('../drizzle/0008_receipt_activity_scope.sql', import.meta.url), 'utf8');
    // The real migration has explicit statement separators and no triggers.
    for (const statement of indexes.split('--> statement-breakpoint').map(value => value.trim()).filter(Boolean)) {
      await database.prepare(statement).run();
    }
    const projection = await readFile(new URL('../drizzle/0009_receipt_link_projections.sql', import.meta.url), 'utf8');
    const statements = unstable_splitSqlQuery(projection);
    assert.equal(statements.length, 21);
    assert.ok(!statements.some(statement => statement.trim() === 'END'));
    for (const statement of statements) await database.prepare(statement).run();
    await run(database);
  } finally {
    await worker.dispose();
  }
}

async function activity(database: NativeDatabase, id: string, type: string, entityId: string,
  before: Snapshot | null, after: Snapshot | null, holiday = tripId) {
  await database.prepare(`INSERT INTO activity_events
    (id,trip_id,entity_type,entity_id,before_data,after_data) VALUES (?,?,?,?,?,?)`)
    .bind(id, holiday, type, entityId, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after)).run();
}

async function scoped(database: NativeDatabase, scope: ReceiptActivityScope, before?: number, limit = 50) {
  const family = await resolveReceiptActivityFamily(database as unknown as D1Database, tripId, scope);
  const query = receiptActivityScope(tripId, scope, family);
  const cursor = before === undefined ? '' : ' AND e.sequence < ?';
  const bindings = [...query.bindings, tripId, ...(before === undefined ? [] : [before]), limit];
  const result = await database.prepare(`${query.prefix}
    SELECT e.id,e.sequence FROM activity_events e JOIN trips t ON t.id = e.trip_id
    WHERE e.trip_id = ? AND (${query.condition})${cursor}
    ORDER BY e.sequence DESC LIMIT ?`).bind(...bindings).all<ScopeRow>();
  return result.results;
}

async function fixture(database: NativeDatabase, draftId = 'source-draft') {
  const original = { id: draftId, receiptId: 'old-photo', status: 'waiting' };
  const proposed = { ...original, receiptId: 'new-photo', status: 'review' };
  const posted = { id: 'posted-expense', sourceDraftId: draftId, receiptId: 'new-photo' };
  const collision = { id: draftId, receiptId: 'unrelated-photo' };
  await database.prepare('INSERT INTO trips (id,data) VALUES (?,?)')
    .bind(tripId, JSON.stringify({ expenses: [posted, collision], drafts: [] })).run();
  await activity(database, 'old-photo-created', 'receipt', 'old-photo', null, { state: 'active' });
  await activity(database, 'draft-created-before-link', 'draft', draftId, null, original);
  await activity(database, 'draft-itemised-before-link', 'draft', draftId, original, proposed);
  await activity(database, 'new-photo-created', 'receipt', 'new-photo', null, { state: 'active' });
  await activity(database, 'expense-posted', 'expense', posted.id, null, posted);
  await activity(database, 'draft-consumed', 'draft', draftId, proposed, null);
  await activity(database, 'old-photo-purged', 'receipt', 'old-photo', { state: 'deleting' }, null);
  await activity(database, 'unrelated-id-collision', 'expense', draftId, null, collision);
  await activity(database, 'unrelated-photo-created', 'receipt', 'unrelated-photo', null, { state: 'active' });
  await activity(database, 'unrelated-payment', 'payment', posted.id, null, { amount: 100 });
  await activity(database, 'foreign-photo', 'receipt', 'new-photo', null, { state: 'active' }, 'other-holiday');
  await activity(database, 'foreign-expense', 'expense', posted.id, null, posted, 'other-holiday');
  return {
    posted, collision, draftId,
    expected: new Set(['old-photo-created', 'draft-created-before-link', 'draft-itemised-before-link',
      'new-photo-created', 'expense-posted', 'draft-consumed', 'old-photo-purged']),
  };
}

test('native D1 enforces the five-term compound SELECT limit hidden by the Node SQLite shim', async () => {
  await nativeDatabase(async database => {
    const five = Array.from({ length: 5 }, (_, index) => `SELECT ${index} AS value`).join(' UNION ');
    const accepted = await database.prepare(`WITH terms AS MATERIALIZED (${five}) SELECT value FROM terms`).all<{ value: number }>();
    assert.deepEqual(accepted.results.map(row => row.value), [0, 1, 2, 3, 4]);
    await assert.rejects(database.prepare(`WITH terms AS MATERIALIZED (${five} UNION SELECT 5) SELECT value FROM terms`).all(),
      /too many terms in compound SELECT/i);
  });
});

test('native D1 resolves a consumed distinct source draft, pre-save changes, photos and older pages', async () => {
  await nativeDatabase(async database => {
    const data = await fixture(database);
    for (const scope of [{ expenseId: data.posted.id }, { draftId: data.draftId }]) {
      const all = await scoped(database, scope);
      assert.deepEqual(new Set(all.map(row => row.id)), data.expected);
      const first = await scoped(database, scope, undefined, 3);
      const older = await scoped(database, scope, first.at(-1)!.sequence, 50);
      assert.deepEqual([...first, ...older], all);
    }
    assert.deepEqual(new Set((await scoped(database, { expenseId: data.draftId })).map(row => row.id)),
      new Set(['unrelated-id-collision', 'unrelated-photo-created']));
  });
});

test('native D1 retains deleted/restored typed receipt links and binds quoted IDs literally', async () => {
  await nativeDatabase(async database => {
    const data = await fixture(database, "source-draft' OR 1=1 --");
    await activity(database, 'expense-deleted', 'expense', data.posted.id, data.posted, null);
    await database.prepare('UPDATE trips SET data=? WHERE id=?')
      .bind(JSON.stringify({ expenses: [data.collision], drafts: [] }), tripId).run();
    data.expected.add('expense-deleted');
    for (const scope of [{ expenseId: data.posted.id }, { draftId: data.draftId }]) {
      assert.deepEqual(new Set((await scoped(database, scope)).map(row => row.id)), data.expected);
    }
    await activity(database, 'expense-restored', 'expense', data.posted.id, null, data.posted);
    await database.prepare('UPDATE trips SET data=? WHERE id=?')
      .bind(JSON.stringify({ expenses: [data.posted, data.collision], drafts: [] }), tripId).run();
    data.expected.add('expense-restored');
    assert.deepEqual(new Set((await scoped(database, { draftId: data.draftId })).map(row => row.id)), data.expected);
    assert.deepEqual(await scoped(database, { draftId: 'unknown-draft' }), []);
  });
});

test('native D1 recovers legacy manual draft history without provenance through photo replacement and deletion', async () => {
  await nativeDatabase(async database => {
    const draftId = "legacy' draft", expenseId = "posted' expense";
    const original = { id: draftId, receiptId: 'legacy-old-photo', status: 'waiting', conversation: [{ id: 'old-question', text: 'Before save' }] };
    const processed = { ...original, receiptId: 'legacy-final-photo', status: 'review' };
    const posted = { id: expenseId, receiptId: 'legacy-final-photo' };
    await database.prepare('INSERT INTO trips(id,data) VALUES (?,?)').bind(tripId, JSON.stringify({ expenses: [posted], drafts: [] })).run();
    await activity(database, 'legacy-photo-upload', 'receipt', 'legacy-old-photo', null, { status: 'pending' });
    await activity(database, 'legacy-question', 'draft', draftId, null, original);
    await activity(database, 'legacy-ai-itemisation', 'draft', draftId, original, processed);
    await activity(database, 'legacy-final-photo', 'receipt', 'legacy-final-photo', null, { status: 'active' });
    await activity(database, 'legacy-posting', 'expense', expenseId, null, posted);
    await activity(database, 'legacy-consumed', 'draft', draftId, processed, null);
    await activity(database, 'legacy-old-purged', 'receipt', 'legacy-old-photo', { status: 'deleting' }, null);
    // A matching photo in another holiday or once-explicit draft is not a copy
    // competitor and cannot insert its financial/message history here.
    await activity(database, 'foreign-photo-owner', 'expense', 'foreign-expense', null, posted, 'another-holiday');
    await activity(database, 'once-explicit', 'draft', 'other-draft', { receiptId: 'legacy-final-photo', expenseId: 'different-expense' }, { receiptId: 'legacy-final-photo' });
    const expected = new Set(['legacy-photo-upload', 'legacy-question', 'legacy-ai-itemisation', 'legacy-final-photo', 'legacy-posting', 'legacy-consumed', 'legacy-old-purged']);
    for (const scope of [{ expenseId }, { draftId }]) {
      const all = await scoped(database, scope);
      assert.deepEqual(new Set(all.map(row => row.id)), expected);
      const first = await scoped(database, scope, undefined, 3);
      assert.deepEqual([...first, ...await scoped(database, scope, first.at(-1)!.sequence)], all);
    }
    await activity(database, 'legacy-deletion', 'expense', expenseId, posted, null);
    await database.prepare('UPDATE trips SET data=? WHERE id=?').bind('{"expenses":[],"drafts":[]}', tripId).run();
    expected.add('legacy-deletion');
    assert.deepEqual(new Set((await scoped(database, { draftId })).map(row => row.id)), expected);
  });
});

test('native D1 excludes ambiguous legacy receipt reuse and typed cross-collection collisions', async () => {
  await nativeDatabase(async database => {
    const posted = { id: 'legacy-target', receiptId: 'legacy-photo' };
    await database.prepare('INSERT INTO trips(id,data) VALUES (?,?)').bind(tripId, JSON.stringify({ expenses: [posted], drafts: [] })).run();
    await activity(database, 'target-photo', 'receipt', 'legacy-photo', null, { status: 'active' });
    await activity(database, 'target-posted', 'expense', posted.id, null, posted);
    await activity(database, 'candidate-draft', 'draft', 'legacy-source', null, { receiptId: 'legacy-photo' });
    assert.deepEqual(new Set((await scoped(database, { expenseId: posted.id })).map(row => row.id)), new Set(['target-photo', 'target-posted', 'candidate-draft']));
    await activity(database, 'deleted-unlinked-copy', 'draft', 'deleted-copy', { receiptId: 'legacy-photo' }, null);
    assert.deepEqual(new Set((await scoped(database, { expenseId: posted.id })).map(row => row.id)), new Set(['target-photo', 'target-posted']));
    assert.ok(!(await scoped(database, { draftId: 'legacy-source' })).some(row => row.id === 'target-posted'));
    // Typed IDs alone cannot turn numeric receipt identifiers into string links.
    await activity(database, 'numeric-photo-draft', 'draft', 'numeric-photo-draft', null, { receiptId: 123 });
    await activity(database, 'string-photo-expense', 'expense', 'string-photo-expense', null, { receiptId: '123' });
    assert.deepEqual(new Set((await scoped(database, { expenseId: 'string-photo-expense' })).map(row => row.id)), new Set(['string-photo-expense']));
  });
});
