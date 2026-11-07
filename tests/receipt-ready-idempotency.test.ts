import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { storage, type SQLiteD1 } from './helpers/sqlite-d1';
import { ModuleKind, ScriptTarget } from 'typescript';
import { transpileWithSharedImports } from './helpers/transpile';

/** N05: notifyReceiptReady decides from persisted operation state and current eligibility, and inserts at most once per operation. */
const asModule = (source: string) => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const fixture = { database: null as SQLiteD1 | null };
Object.assign(globalThis, { __triptabReceiptReady: fixture });
const envModule = asModule('export const env={}; export const waitUntil=p=>p;');
const storeModule = asModule('export const db=()=>globalThis.__triptabReceiptReady.database; export class RequestError extends Error{};');
const code = transpileWithSharedImports(await readFile(new URL('../lib/notifications.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 }, sharedImportOverrides: { 'cloudflare:workers': envModule, './store': storeModule } }).outputText;
const { notifyReceiptReady } = await import(asModule(code)) as typeof import('../lib/notifications');

async function seed(options: { preference?: number | null; status?: string; kind?: string } = {}) {
  const database = await storage(), now = new Date().toISOString();
  database.sqlite.prepare('INSERT INTO profiles(id,email,display_name,created_at) VALUES(?,?,?,?)').run('alice', 'alice@example.test', 'Alice', now);
  database.sqlite.prepare('INSERT INTO trips(id,owner,data) VALUES(?,?,?)').run('trip', 'alice', JSON.stringify({ id: 'trip', name: 'Private trip', currency: 'GBP', members: [], expenses: [], payments: [], drafts: [] }));
  database.sqlite.prepare('INSERT INTO memberships(trip_id,user_id,member_id) VALUES(?,?,?)').run('trip', 'alice', 'a');
  if (options.preference !== null) database.sqlite.prepare('INSERT INTO notification_preferences(user_id,receipt_ready) VALUES(?,?)').run('alice', options.preference ?? 1);
  fixture.database = database;
  const operation = (key: string, status = options.status ?? 'stored', createdAt = 1000, kind = options.kind ?? 'read') =>
    database.sqlite.prepare("INSERT INTO receipt_operations(operation_key,user_id,trip_id,draft_id,kind,status,attempt_id,attempts,lease_until,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,0,?,?)")
      .run(key, 'alice', 'trip', 'draft', kind, status, 'attempt', createdAt, createdAt);
  return { database, operation };
}
const rows = (database: SQLiteD1) => database.sqlite.prepare("SELECT id,title,body FROM notifications WHERE user_id='alice' ORDER BY id").all() as Array<{ id: string; title: string; body: string }>;
const send = (key: string) => notifyReceiptReady({ userId: 'alice', tripId: 'trip', operationKey: key });

test('N05: the same stored operation notifies once however many times it is reported', async () => {
  const { database, operation } = await seed(); operation('op-1');
  assert.equal(await send('op-1'), true);
  for (let i = 0; i < 4; i++) assert.equal(await send('op-1'), false, 'a retry, takeover, resume or repeated callback inserts nothing');
  assert.equal(rows(database).length, 1);
  assert.deepEqual([rows(database)[0].title, rows(database)[0].body], ['Receipt ready to review', 'Open TripTab to review it.']);
});

test('N05: a distinct operation, or the same key claimed again later, is its own notice', async () => {
  const { database, operation } = await seed(); operation('op-1', 'stored', 1000); operation('op-2', 'stored', 2000);
  assert.equal(await send('op-1'), true); assert.equal(await send('op-2'), true);
  database.sqlite.prepare("DELETE FROM receipt_operations WHERE operation_key='op-1'").run();
  operation('op-1', 'stored', 3000); // the same reading requested again after the old row was retired
  assert.equal(await send('op-1'), true);
  assert.equal(rows(database).length, 3);
});

test('N05: only a stored operation notifies. Running, failed or unknown operations never do', async () => {
  const { database, operation } = await seed(); operation('running', 'running'); operation('failed', 'failed');
  for (const key of ['running', 'failed', 'missing']) assert.equal(await send(key), false, key);
  assert.equal(rows(database).length, 0);
});

test('N05: a question operation gets its own fixed wording; still no receipt content', async () => {
  const { database, operation } = await seed(); operation('q-1', 'stored', 1000, 'question:abc');
  assert.equal(await send('q-1'), true);
  assert.deepEqual([rows(database)[0].title, rows(database)[0].body], ['Receipt reply ready', 'Open TripTab to read it.']);
});

test('N05: missing preference row, preference off, and every loss of eligibility fail safe (nothing is written)', async () => {
  for (const [name, options, change] of [
    ['no preference row', { preference: null }, ''],
    ['preference off', { preference: 0 }, ''],
    ['account deleted', {}, "UPDATE profiles SET deleted_at='2026-01-01T00:00:00Z' WHERE id='alice'"],
    ['trip deleted', {}, "UPDATE trips SET owner='deleted:alice' WHERE id='trip'"],
    ['left the trip and no longer owns it', {}, "UPDATE trips SET owner='bob' WHERE id='trip'; DELETE FROM memberships WHERE user_id='alice'"],
    ['trip scope none', {}, "UPDATE notification_preferences SET scope='none'"],
    ['daily summary', {}, "UPDATE notification_preferences SET delivery='daily'"],
  ] as Array<[string, { preference?: number | null }, string]>) {
    const { database, operation } = await seed(options); operation('op-1');
    if (change) database.sqlite.exec(change);
    assert.equal(await send('op-1'), false, name);
    assert.equal(rows(database).length, 0, name);
  }
});

test('N05: the inbox keeps its 100-entry cap when notices arrive', async () => {
  const { database, operation } = await seed();
  for (let i = 0; i < 100; i++) database.sqlite.prepare("INSERT INTO notifications(id,user_id,title,body,url,created_at) VALUES(?,?,?,?,?,?)").run(`old-${i}`, 'alice', 't', 'b', '/', `2020-01-01T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`);
  operation('op-1');
  assert.equal(await send('op-1'), true);
  assert.equal(rows(database).length, 100);
  assert.ok(rows(database).some(row => row.id.startsWith('receipt-ready:')), 'the newest notice is kept');
});
