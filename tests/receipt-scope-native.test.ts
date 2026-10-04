import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Log, LogLevel, Miniflare } from 'miniflare';
import { receiptActivityScope, type ReceiptActivityScope } from '../lib/activity-scope';

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
  const query = receiptActivityScope(tripId, scope);
  const cursor = before === undefined ? '' : ' AND e.sequence < ?';
  const bindings = [...query.bindings, tripId, ...(before === undefined ? [] : [before]), limit];
  const result = await database.prepare(`${query.prefix}
    SELECT e.id,e.sequence FROM activity_events e
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
