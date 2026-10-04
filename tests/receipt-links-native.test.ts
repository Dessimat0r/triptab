import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { Log, LogLevel, Miniflare } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';

type NativeDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>;
type Snapshot = Record<string, unknown>;
type CurrentLink = {
  trip_id: string; entity_type: string; entity_id: string; expense_id: string | null;
  source_draft_id: string | null; receipt_id: string | null; has_expense_link: number;
};
type HistoryLink = CurrentLink & { sequence: number; snapshot_order: number };
const tripId = 'projection-holiday';
const projectionFile = new URL('../drizzle/0009_receipt_link_projections.sql', import.meta.url);

async function nativeDatabase(run: (database: NativeDatabase, migration: string[]) => Promise<void>) {
  // Use workerd's real D1 engine and the locked Wrangler tokenizer. These
  // ephemeral databases never touch shared Wrangler state or hosted data.
  const worker = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("Receipt link migration test"); } };',
    compatibilityDate: '2026-05-15',
    d1Databases: { DB: 'receipt-links-native' },
    d1Persist: false,
    log: new Log(LogLevel.NONE),
  });
  try {
    const database = await worker.getD1Database('DB');
    const files = (await readdir(new URL('../drizzle/', import.meta.url)))
      .filter(file => /^000[0-8]_.*\.sql$/.test(file)).sort();
    assert.equal(files.length, 9, 'exercise the complete pre-0009 schema');
    for (const file of files) {
      const statements = unstable_splitSqlQuery(await readFile(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
      await database.batch(statements.map(statement => database.prepare(statement)));
    }
    const migration = unstable_splitSqlQuery(await readFile(projectionFile, 'utf8'));
    assert.equal(migration.length, 21);
    assert.ok(!migration.some(statement => statement.trim() === 'END'));
    await run(database, migration);
  } finally {
    await worker.dispose();
  }
}

async function apply(database: NativeDatabase, statements: string[]) {
  await database.batch(statements.map(statement => database.prepare(statement)));
}
async function insertTrip(database: NativeDatabase, id: string, data: Snapshot) {
  await database.prepare('INSERT INTO trips (id,owner,data) VALUES (?,?,?)').bind(id, 'owner', JSON.stringify(data)).run();
}
async function activity(database: NativeDatabase, id: string, type: string, entityId: string,
  before: Snapshot | null, after: Snapshot | null, holiday = tripId) {
  await activityStatement(database, id, type, entityId, before, after, holiday).run();
}
function activityStatement(database: NativeDatabase, id: string, type: string, entityId: string,
  before: Snapshot | null, after: Snapshot | null, holiday = tripId) {
  return database.prepare(`INSERT INTO activity_events
    (id,trip_id,actor_id,actor_name,created_at,entity_type,entity_id,action,before_data,after_data,revision,source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, holiday, 'owner', 'Fixture traveller', '2026-10-04T00:00:00Z',
      type, entityId, before === null ? 'create' : after === null ? 'delete' : 'update',
      before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after), 1, 'web');
}
async function version(database: NativeDatabase, id = tripId) {
  return (await database.prepare('SELECT receipt_link_version AS version FROM trips WHERE id=?').bind(id).first<{ version: number }>())!.version;
}
async function currentLinks(database: NativeDatabase, id = tripId) {
  return (await database.prepare('SELECT * FROM current_receipt_links WHERE trip_id=? ORDER BY entity_type,entity_id').bind(id).all<CurrentLink>()).results;
}
async function historyLinks(database: NativeDatabase, id = tripId) {
  return (await database.prepare('SELECT * FROM receipt_history_links WHERE trip_id=? ORDER BY sequence,snapshot_order').bind(id).all<HistoryLink>()).results;
}
async function sourceBytes(database: NativeDatabase) {
  const trips = (await database.prepare('SELECT id,owner,data,length(CAST(data AS BLOB)) AS bytes FROM trips ORDER BY id').all()).results;
  const events = (await database.prepare(`SELECT *,length(CAST(COALESCE(before_data,'') AS BLOB))
    +length(CAST(COALESCE(after_data,'') AS BLOB)) AS bytes FROM activity_events ORDER BY sequence`).all()).results;
  return { trips, events, digest: createHash('sha256').update(JSON.stringify({ trips, events })).digest('hex') };
}
async function populated(database: NativeDatabase) {
  const oldDraft = { id: 'source-draft', receiptId: 'old-photo', status: 'waiting', notes: 'Previously saved words.' };
  const draft = { ...oldDraft, receiptId: 'new-photo', expenseId: 'posted-expense', status: 'review' };
  const expense = { id: 'posted-expense', sourceDraftId: oldDraft.id, receiptId: 'new-photo', amount: 1001,
    title: 'Paid in euros; historical pence are unchanged.', items: [{ amount: 1001, units: { total: 3, allocations: { alice: 2.5, bob: 0.5 } } }] };
  const data = { name: 'Fixture holiday', expenses: [expense], drafts: [draft], payments: [{ id: 'transfer', amount: 167 }] };
  await insertTrip(database, tripId, data);
  await activity(database, 'draft-before-posting', 'draft', oldDraft.id, oldDraft, draft);
  await activity(database, 'expense-posted', 'expense', expense.id, null, expense);
  await activity(database, 'photo-created', 'receipt', 'new-photo', null, { state: 'active', sha256: 'image metadata' });
  return { oldDraft, draft, expense, data };
}

test('native D1 applies tokenized 0009 to populated 0008 without rewriting financial or activity bytes', async () => {
  await nativeDatabase(async (database, migration) => {
    const fixture = await populated(database);
    const before = await sourceBytes(database);
    await apply(database, migration);
    assert.deepEqual(await sourceBytes(database), before);
    assert.equal(await version(database), 0, 'backfill must not invent participant activity');
    const links = await currentLinks(database);
    assert.deepEqual(links, [
      { trip_id: tripId, entity_type: 'draft', entity_id: fixture.draft.id, expense_id: fixture.expense.id,
        source_draft_id: null, receipt_id: 'new-photo', has_expense_link: 1 },
      { trip_id: tripId, entity_type: 'expense', entity_id: fixture.expense.id, expense_id: null,
        source_draft_id: fixture.draft.id, receipt_id: 'new-photo', has_expense_link: 0 },
    ]);
    const history = await historyLinks(database);
    assert.equal(history.length, 3);
    assert.deepEqual(history.map(row => [row.entity_type, row.entity_id, row.snapshot_order, row.receipt_id]), [
      ['draft', fixture.draft.id, 0, 'old-photo'], ['draft', fixture.draft.id, 1, 'new-photo'], ['expense', fixture.expense.id, 1, 'new-photo'],
    ]);
  });
});

test('native current projections follow insert, updates, receipt removal and restore without retaining stale links', async () => {
  await nativeDatabase(async (database, migration) => {
    await apply(database, migration);
    const expense = { id: 'expense', sourceDraftId: 'draft', receiptId: 'photo' };
    const draft = { id: 'draft', expenseId: expense.id, receiptId: 'photo' };
    const data = { expenses: [expense], drafts: [draft] };
    await insertTrip(database, tripId, data);
    assert.equal(await version(database), 1);
    assert.equal((await currentLinks(database)).length, 2);
    await database.prepare('UPDATE trips SET data=data WHERE id=?').bind(tripId).run();
    assert.equal(await version(database), 1, 'an identical snapshot is not a link change');
    const replacement = { expenses: [{ ...expense, sourceDraftId: 'other-source', receiptId: 'other-photo' }], drafts: [] };
    await database.prepare('UPDATE trips SET data=? WHERE id=?').bind(JSON.stringify(replacement), tripId).run();
    assert.equal(await version(database), 2);
    assert.deepEqual(await currentLinks(database), [{ trip_id: tripId, entity_type: 'expense', entity_id: expense.id,
      expense_id: null, source_draft_id: 'other-source', receipt_id: 'other-photo', has_expense_link: 0 }]);
    await activity(database, 'expense-deleted', 'expense', expense.id, replacement.expenses[0], null);
    await database.prepare('UPDATE trips SET data=? WHERE id=?').bind(JSON.stringify({ expenses: [], drafts: [] }), tripId).run();
    assert.deepEqual(await currentLinks(database), []);
    const beforeRestore = await version(database);
    await database.prepare('UPDATE trips SET data=? WHERE id=?').bind(JSON.stringify(data), tripId).run();
    assert.equal(await version(database), beforeRestore + 1);
    assert.equal((await currentLinks(database)).length, 2);
    const history = await historyLinks(database);
    await database.prepare('DELETE FROM trips WHERE id=?').bind(tripId).run();
    assert.deepEqual(await currentLinks(database), []);
    assert.deepEqual(await historyLinks(database), history, 'trip deletion cannot cascade into immutable historical links');
    await insertTrip(database, tripId, data);
    assert.equal((await currentLinks(database)).length, 2);
    assert.deepEqual(await historyLinks(database), history);
  });
});

test('native D1 ledger batches roll projection and counter back with a final audit failure', async () => {
  await nativeDatabase(async (database, migration) => {
    const fixture = await populated(database);
    await apply(database, migration);
    await database.prepare("INSERT INTO sync_state(id,revision,last_write) VALUES (1,1,'initial')").run();
    const before = await sourceBytes(database), current = await currentLinks(database), history = await historyLinks(database);
    const next = { ...fixture.data, expenses: [{ ...fixture.expense, receiptId: 'corrected-photo', amount: 1201 }] };
    const statements = () => [
      database.prepare("UPDATE sync_state SET revision=revision+1,last_write='accepted' WHERE id=1 AND revision=1"),
      database.prepare("UPDATE trips SET data=? WHERE id=? AND EXISTS(SELECT 1 FROM sync_state WHERE last_write='accepted')").bind(JSON.stringify(next), tripId),
      activityStatement(database, 'expense-updated', 'expense', fixture.expense.id, fixture.expense, next.expenses[0]),
    ];
    await assert.rejects(database.batch([...statements(), activityStatement(database, 'expense-posted', 'expense', fixture.expense.id, null, fixture.expense)]), /append-only/i);
    assert.deepEqual(await sourceBytes(database), before);
    assert.deepEqual(await currentLinks(database), current);
    assert.deepEqual(await historyLinks(database), history);
    assert.equal(await version(database), 0);
    assert.deepEqual(await database.prepare('SELECT revision,last_write FROM sync_state WHERE id=1').first(), { revision: 1, last_write: 'initial' });
    await database.batch(statements());
    assert.equal(await version(database), 2, 'accepted trip and expense activity advance their metadata version atomically');
    assert.equal((await currentLinks(database)).find(row => row.entity_type === 'expense')!.receipt_id, 'corrected-photo');
    assert.equal((await historyLinks(database)).length, history.length + 2);
    assert.deepEqual(await database.prepare('SELECT revision,last_write FROM sync_state WHERE id=1').first(), { revision: 2, last_write: 'accepted' });
  });
});

test('native receipt activity invalidates its holiday counter without copying image or unrelated event content', async () => {
  await nativeDatabase(async (database, migration) => {
    await populated(database);
    await insertTrip(database, 'other-holiday', { expenses: [], drafts: [] });
    await apply(database, migration);
    const links = await historyLinks(database);
    await activity(database, 'receipt-purged', 'receipt', 'new-photo', { state: 'deleting' }, null);
    assert.equal(await version(database), 1);
    assert.deepEqual(await historyLinks(database), links);
    for (const type of ['payment', 'member', 'invite', 'trip']) await activity(database, `unrelated-${type}`, type, 'unrelated', null, { private: 'Not receipt metadata' });
    assert.equal(await version(database), 1);
    await activity(database, 'other-photo-created', 'receipt', 'other-photo', null, { state: 'active' }, 'other-holiday');
    assert.equal(await version(database), 1);
    assert.equal(await version(database, 'other-holiday'), 1);
    await activity(database, 'draft-chat-appended', 'draft', 'source-draft', null, { id: 'source-draft', receiptId: 'new-photo', conversation: [{ text: 'Only the version changes.' }] });
    assert.equal(await version(database), 2);
    assert.equal((await historyLinks(database)).length, links.length + 1);
  });
});

test('native projections store typed bounded link metadata rather than financial, chat or image snapshots', async () => {
  await nativeDatabase(async (database, migration) => {
    const marker = 'PRIVATE_FINANCIAL_CHAT_PAYLOAD';
    const payload = marker + '£'.repeat(150_000);
    const expenses = [
      { id: 'typed-expense', receiptId: 123, sourceDraftId: true, title: payload, amount: 1001 },
      { id: 123, receiptId: 'ignored-numeric-id' },
      { id: 'x'.repeat(100), receiptId: 'r'.repeat(100), sourceDraftId: 'd'.repeat(100), title: payload },
    ];
    const drafts = [
      { id: 'malformed-target', expenseId: 42, receiptId: false, conversation: [{ text: payload }] },
      { id: 'unlinked', expenseId: null, receiptId: 'photo', memory: { notes: payload } },
    ];
    await insertTrip(database, tripId, { expenses, drafts, payments: [{ id: 'payment', receiptId: 'never-projected', note: payload }] });
    await activity(database, 'typed-history', 'draft', 'malformed-target', drafts[0], drafts[1]);
    await apply(database, migration);
    const current = await currentLinks(database), history = await historyLinks(database);
    assert.equal(current.length, 4);
    assert.deepEqual(current.find(row => row.entity_id === 'typed-expense'), { trip_id: tripId, entity_type: 'expense',
      entity_id: 'typed-expense', expense_id: null, source_draft_id: null, receipt_id: null, has_expense_link: 0 });
    assert.equal(current.find(row => row.entity_id === 'malformed-target')!.has_expense_link, 1, 'a malformed target must never become a legacy unlinked draft');
    assert.equal(current.find(row => row.entity_id === 'malformed-target')!.expense_id, null);
    assert.equal(current.find(row => row.entity_id === 'unlinked')!.has_expense_link, 0);
    assert.equal(history[0].has_expense_link, 1); assert.equal(history[0].expense_id, null);
    const encoded = JSON.stringify({ current, history });
    assert.ok(!encoded.includes(marker)); assert.ok(!encoded.includes('never-projected'));
    assert.ok(new TextEncoder().encode(encoded).byteLength < 3_000);
    const columns = (await database.prepare('PRAGMA table_info(receipt_history_links)').all<{ name: string }>()).results.map(row => row.name);
    assert.deepEqual(columns, ['trip_id', 'entity_type', 'entity_id', 'sequence', 'snapshot_order', 'expense_id', 'source_draft_id', 'receipt_id', 'has_expense_link']);
  });
});

test('native trigger-before-backfill interleaving keeps newly accepted projections and snapshots once', async () => {
  await nativeDatabase(async (database, migration) => {
    const fixture = await populated(database);
    const firstBackfill = migration.findIndex(statement => /INSERT OR IGNORE INTO current_receipt_links/.test(statement));
    assert.ok(firstBackfill > migration.findIndex(statement => /CREATE TRIGGER receipt_history_links_insert/.test(statement)));
    await apply(database, migration.slice(0, firstBackfill));
    const changed = { ...fixture.data, expenses: [{ ...fixture.expense, receiptId: 'accepted-before-backfill' }], drafts: [] };
    await database.prepare('UPDATE trips SET data=? WHERE id=?').bind(JSON.stringify(changed), tripId).run();
    await activity(database, 'interleaved-expense', 'expense', fixture.expense.id, fixture.expense, changed.expenses[0]);
    await insertTrip(database, 'interleaved-new-trip', { expenses: [{ id: 'new-expense', receiptId: 'new-photo' }], drafts: [] });
    await activity(database, 'interleaved-created', 'expense', 'new-expense', null, { id: 'new-expense', receiptId: 'new-photo' }, 'interleaved-new-trip');
    const before = await sourceBytes(database);
    await apply(database, migration.slice(firstBackfill));
    assert.deepEqual(await sourceBytes(database), before);
    assert.equal(await version(database), 2);
    assert.equal(await version(database, 'interleaved-new-trip'), 2);
    assert.deepEqual((await currentLinks(database)).map(row => [row.entity_type, row.entity_id, row.receipt_id]),
      [['expense', fixture.expense.id, 'accepted-before-backfill']]);
    assert.equal((await currentLinks(database, 'interleaved-new-trip')).length, 1);
    assert.equal((await historyLinks(database)).length, 5);
    assert.equal((await historyLinks(database, 'interleaved-new-trip')).length, 1);
    assert.deepEqual((await database.prepare(`SELECT sequence,snapshot_order,COUNT(*) AS count FROM receipt_history_links
      GROUP BY sequence,snapshot_order HAVING COUNT(*) <> 1`).all()).results, []);
  });
});
