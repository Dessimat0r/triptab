import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

let sqlite: DatabaseSync;
let receiptBinding = true;
const binding = { db: () => ({ prepare: (sql: string) => {
  let values: (string | number | null)[] = [];
  return { bind(...bindings: (string | number | null)[]) { values = bindings; return this; }, all: async () => ({ results: sqlite.prepare(sql).all(...values) }) };
} }), bucket: () => { if (!receiptBinding) throw Error('Missing secret resource'); return { get() {}, put() {}, delete() {} }; } };
Object.defineProperty(globalThis, Symbol.for('triptab.health-test'), { value: binding, configurable: true });
const boundary = 'data:text/javascript;base64,' + Buffer.from("export const {db,bucket}=globalThis[Symbol.for('triptab.health-test')];").toString('base64');
const compiled = transpileModule(await readFile(new URL('../app/healthz/route.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText.replace("'@/lib/store'", JSON.stringify(boundary));
const { GET } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64')) as typeof import('../app/healthz/route');

test('readiness passes with the complete schema and receipt capability without exposing data', async () => {
  sqlite = new DatabaseSync(':memory:'); receiptBinding = true;
  for (const name of (await readdir(new URL('../drizzle/', import.meta.url))).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(await readFile(new URL('../drizzle/' + name, import.meta.url), 'utf8'));
  const response = await GET(); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 'ready' }); assert.equal(response.headers.get('cache-control'), 'no-store');
});
test('missing migration produces a generic unavailable status instead of a false healthy result', async () => {
  sqlite = new DatabaseSync(':memory:'); sqlite.exec('CREATE TABLE receipts(id TEXT); CREATE TABLE activity_events(sequence INTEGER);'); receiptBinding = true;
  const response = await GET(); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { status: 'unavailable' });
});
test('the previous receipt-cleanup schema cannot report ready without the message registry migration', async () => {
  sqlite = new DatabaseSync(':memory:'); receiptBinding = true;
  for (const name of (await readdir(new URL('../drizzle/', import.meta.url))).filter(name => name.endsWith('.sql') && Number(name.slice(0, 4)) <= 6).sort()) sqlite.exec(await readFile(new URL('../drizzle/' + name, import.meta.url), 'utf8'));
  const response = await GET(); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { status: 'unavailable' });
});
test('a partially applied registry migration without its unique lookup index cannot report ready', async () => {
  sqlite = new DatabaseSync(':memory:'); receiptBinding = true;
  for (const name of (await readdir(new URL('../drizzle/', import.meta.url))).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(await readFile(new URL('../drizzle/' + name, import.meta.url), 'utf8'));
  sqlite.exec('DROP INDEX receipt_messages_trip_message_idx');
  const response = await GET(); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { status: 'unavailable' });
});
test('receipt history cannot report ready before the scope index migration', async () => {
  sqlite = new DatabaseSync(':memory:'); receiptBinding = true;
  for (const name of (await readdir(new URL('../drizzle/', import.meta.url))).filter(name => name.endsWith('.sql') && Number(name.slice(0, 4)) <= 7).sort()) sqlite.exec(await readFile(new URL('../drizzle/' + name, import.meta.url), 'utf8'));
  const response = await GET(); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { status: 'unavailable' });
});
test('each missing receipt family index makes partial scope migration unavailable', async context => {
  for (const index of ['activity_events_trip_entity_idx', 'activity_events_draft_before_expense_idx', 'activity_events_draft_after_expense_idx', 'activity_events_expense_before_source_draft_idx', 'activity_events_expense_after_source_draft_idx']) await context.test(index, async () => {
    sqlite = new DatabaseSync(':memory:'); receiptBinding = true;
    for (const name of (await readdir(new URL('../drizzle/', import.meta.url))).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(await readFile(new URL('../drizzle/' + name, import.meta.url), 'utf8'));
    sqlite.exec(`DROP INDEX ${index}`);
    const response = await GET(); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { status: 'unavailable' });
  });
});
test('missing receipt binding also fails readiness without disclosing internal details', async () => {
  sqlite = new DatabaseSync(':memory:'); receiptBinding = false;
  for (const name of (await readdir(new URL('../drizzle/', import.meta.url))).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(await readFile(new URL('../drizzle/' + name, import.meta.url), 'utf8'));
  const response = await GET(); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { status: 'unavailable' });
});


test('receipt history cannot report ready without its current and historical link projections', async () => {
  sqlite = new DatabaseSync(':memory:'); receiptBinding = true;
  for (const name of (await readdir(new URL('../drizzle/', import.meta.url))).filter(name => name.endsWith('.sql') && Number(name.slice(0, 4)) <= 8).sort()) sqlite.exec(await readFile(new URL('../drizzle/' + name, import.meta.url), 'utf8'));
  const response = await GET(); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { status: 'unavailable' });
});
test('each missing metadata lookup index makes partial receipt projection migration unavailable', async context => {
  for (const index of ['current_receipt_links_entity_idx', 'current_receipt_links_expense_idx', 'current_receipt_links_source_idx', 'current_receipt_links_receipt_idx', 'receipt_history_links_snapshot_idx', 'receipt_history_links_entity_idx', 'receipt_history_links_expense_idx', 'receipt_history_links_source_idx', 'receipt_history_links_receipt_idx']) await context.test(index, async () => {
    sqlite = new DatabaseSync(':memory:'); receiptBinding = true;
    for (const name of (await readdir(new URL('../drizzle/', import.meta.url))).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(await readFile(new URL('../drizzle/' + name, import.meta.url), 'utf8'));
    sqlite.exec(`DROP INDEX ${index}`);
    const response = await GET(); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { status: 'unavailable' });
  });
});

test('receipt history cannot report ready without transactional projection and version maintenance', async context => {
  for (const trigger of ['current_receipt_links_insert', 'current_receipt_links_update', 'current_receipt_links_delete', 'receipt_history_links_insert', 'receipt_history_links_no_update', 'receipt_history_links_no_delete', 'receipt_history_links_no_replace']) await context.test(trigger, async () => {
    sqlite = new DatabaseSync(':memory:'); receiptBinding = true;
    for (const name of (await readdir(new URL('../drizzle/', import.meta.url))).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(await readFile(new URL('../drizzle/' + name, import.meta.url), 'utf8'));
    sqlite.exec(`DROP TRIGGER ${trigger}`);
    const response = await GET(); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { status: 'unavailable' });
  });
});

test('partial registry migrations cannot report ready without their indexed identity maintenance', async context => {
  for (const [type, name] of [['INDEX', 'receipt_messages_trip_message_idx'],
    ['TRIGGER', 'receipt_messages_from_activity'], ['TRIGGER', 'receipt_messages_no_update'],
    ['TRIGGER', 'receipt_messages_no_delete'], ['TRIGGER', 'receipt_messages_no_replace']]) await context.test(name, async () => {
    sqlite = new DatabaseSync(':memory:'); receiptBinding = true;
    for (const file of (await readdir(new URL('../drizzle/', import.meta.url))).filter(file => file.endsWith('.sql')).sort()) sqlite.exec(await readFile(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
    sqlite.exec(`DROP ${type} ${name}`);
    const response = await GET(); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { status: 'unavailable' });
  });
});

test('readiness rejects each missing 0005 history object and metadata column even with later migrations present', async context => {
  for (const [kind, name, table] of [
    ['TABLE', 'account_activity_events', ''],
    ['INDEX', 'account_activity_events_id_idx', ''], ['INDEX', 'account_activity_events_user_sequence_idx', ''],
    ['TRIGGER', 'activity_events_no_replace', ''], ['TRIGGER', 'account_activity_events_no_update', ''],
    ['TRIGGER', 'account_activity_events_no_delete', ''], ['TRIGGER', 'account_activity_events_no_replace', ''],
    ['COLUMN', 'audit_id', 'invites'], ['COLUMN', 'generation', 'push_subscriptions'],
    ['COLUMN', 'content_type', 'receipts'], ['COLUMN', 'size_bytes', 'receipts'], ['COLUMN', 'sha256', 'receipts'],
  ]) await context.test(`${table ? table + '.' : ''}${name}`, async () => {
    sqlite = new DatabaseSync(':memory:'); receiptBinding = true;
    for (const file of (await readdir(new URL('../drizzle/', import.meta.url))).filter(file => file.endsWith('.sql')).sort()) sqlite.exec(await readFile(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
    sqlite.exec(kind === 'COLUMN' ? `ALTER TABLE ${table} DROP COLUMN ${name}` : `DROP ${kind} ${name}`);
    const response = await GET(); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { status: 'unavailable' });
  });
});
