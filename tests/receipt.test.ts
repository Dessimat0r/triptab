import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import {
  activateReceipt, deleteReceipt, maintainReceipts, markRemovedReceipts,
  purgeDeletingReceipts, RECEIPT_LIMITS, ReceiptLifecycleError, reserveReceipt,
  storeReceipt, sweepReceiptOrphans,
} from '../lib/receipt-lifecycle';
import type { Trip } from '../lib/model';

class SQLiteStatement {
  private values: (string | number | null)[] = [];
  constructor(private readonly sqlite: DatabaseSync, readonly sql: string) {}
  bind(...values: (string | number | null)[]) { this.values = values; return this; }
  async first<T>() { return (this.sqlite.prepare(this.sql).get(...this.values) || null) as T | null; }
  async all<T>() { return { results: this.sqlite.prepare(this.sql).all(...this.values) as T[] }; }
  runSync() {
    const statement = this.sqlite.prepare(this.sql);
    const results = statement.columns().length ? statement.all(...this.values) : [];
    if (!statement.columns().length) statement.run(...this.values);
    return { results, meta: { changes: Number(this.sqlite.prepare('SELECT changes() AS changes').get()?.changes || 0) }, success: true };
  }
  async run() { return this.runSync(); }
}
class SQLiteD1 {
  readonly sqlite = new DatabaseSync(':memory:');
  beforeWriteBatch?: () => Promise<unknown> | unknown;
  private pending: Promise<unknown> = Promise.resolve();
  prepare(sql: string) { return new SQLiteStatement(this.sqlite, sql); }
  batch(statements: SQLiteStatement[]) {
    const operation = this.pending.then(async () => {
      if (statements.some(statement => /^UPDATE sync_state/.test(statement.sql.trim()))) {
        const hook = this.beforeWriteBatch; this.beforeWriteBatch = undefined; await hook?.();
      }
      this.sqlite.exec('BEGIN');
      try { const results = statements.map(statement => statement.runSync()); this.sqlite.exec('COMMIT'); return results; }
      catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
    });
    this.pending = operation.catch(() => {}); return operation;
  }
  asD1() { return this as unknown as D1Database; }
}
class MemoryR2 {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  readonly deleteCalls: string[] = [];
  failPut = false;
  failDelete = false;
  beforePut?: (key: string) => Promise<void>;
  beforeDelete?: (key: string) => Promise<void>;
  async put(key: string, bytes: Uint8Array, options: { httpMetadata: { contentType: string } }) {
    await this.beforePut?.(key);
    this.objects.set(key, { bytes: new Uint8Array(bytes), contentType: options.httpMetadata.contentType });
    if (this.failPut) throw new Error('Simulated ambiguous R2 put failure');
  }
  async get(key: string) {
    const object = this.objects.get(key);
    return object ? { body: new Uint8Array(object.bytes), httpMetadata: { contentType: object.contentType } } : null;
  }
  async delete(key: string) {
    this.deleteCalls.push(key);
    await this.beforeDelete?.(key);
    if (this.failDelete) throw new Error('Simulated R2 outage');
    this.objects.delete(key);
  }
  asR2() { return this as unknown as R2Bucket; }
}

const binding: { DB?: D1Database; RECEIPTS?: R2Bucket } = {};
Object.defineProperty(globalThis, Symbol.for('triptab.receipt-test-env'), { value: binding, configurable: true });
const dataUrl = (source: string) => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const envUrl = dataUrl("export const env=globalThis[Symbol.for('triptab.receipt-test-env')];");
const lifecycleUrl = new URL('../lib/receipt-lifecycle.ts', import.meta.url).href;
const storeSource = await readFile(new URL('../lib/store.ts', import.meta.url), 'utf8');
const storeCompiled = transpileModule(storeSource, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText
  .replace("'zod'", JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('zod').replace(/\.cjs$/, '.js')).href))
  .replace("'cloudflare:workers'", JSON.stringify(envUrl))
  .replace("'./model'", JSON.stringify(new URL('../lib/model.ts', import.meta.url).href))
  .replace("'./receipt-memory-ownership'", JSON.stringify(new URL('../lib/receipt-memory-ownership.ts', import.meta.url).href))
  .replace("'./receipt-context'", JSON.stringify(new URL('../lib/receipt-context.ts', import.meta.url).href))
  .replace("'./auth'", JSON.stringify(new URL('../lib/auth.ts', import.meta.url).href))
  .replace("'./receipt-lifecycle'", JSON.stringify(lifecycleUrl))
  .replace("'./notifications'", JSON.stringify(dataUrl('export const activityNotification=()=>null; export const notifyMembers=async()=>{};')));
const storeUrl = dataUrl(storeCompiled);
const store = await import(storeUrl) as typeof import('../lib/store');
const routeSource = await readFile(new URL('../app/api/receipt/route.ts', import.meta.url), 'utf8');
const routeCompiled = transpileModule(routeSource, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText
  .replace("'@/lib/store'", JSON.stringify(storeUrl))
  .replace("'@/lib/receipt-lifecycle'", JSON.stringify(lifecycleUrl));
const route = await import(dataUrl(routeCompiled)) as typeof import('../app/api/receipt/route');

const actor = 'receipt-owner', member = 'receipt-member', outsider = 'receipt-outsider';
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1]);
const imageKey = (id: string, owner = actor) => `${encodeURIComponent(owner)}/${id}`;
function trip(id = 'trip-1', owner = actor): Trip {
  return { id, ownerId: owner, name: 'Holiday', currency: 'GBP', members: [{ id: 'a', name: 'Owner', userId: owner, email: `${owner}@example.com` }, { id: 'b', name: 'Bob' }], expenses: [], payments: [], drafts: [] };
}
function expense(receiptId: string) {
  return { id: 'expense-1', title: 'Dinner', currency: 'GBP' as const, payer: 'a', date: '2026-10-04', time: '20:30', timezone: 'Europe/Lisbon', items: [{ id: 'food', name: 'Dinner', amount: 5000, members: ['a', 'b'] }], tax: 0, tip: 0, discount: 0, receiptId };
}
async function storage() {
  const database = new SQLiteD1(), bucket = new MemoryR2();
  for (const name of (await readdir(new URL('../drizzle/', import.meta.url))).filter(file => file.endsWith('.sql')).sort()) database.sqlite.exec(await readFile(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'));
  for (const id of [actor, member, outsider]) database.sqlite.prepare('INSERT INTO profiles (id,email,display_name,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.com`, id, '2026-10-04T00:00:00Z');
  addTrip(database);
  database.sqlite.prepare('INSERT INTO memberships (trip_id,user_id,member_id) VALUES (?,?,?)').run('trip-1', member, 'b');
  binding.DB = database.asD1(); binding.RECEIPTS = bucket.asR2();
  return { database, bucket };
}
function addTrip(database: SQLiteD1, id = 'trip-1', owner = actor) {
  database.sqlite.prepare('INSERT INTO trips (id,owner,data) VALUES (?,?,?)').run(id, owner, JSON.stringify(trip(id, owner)));
  database.sqlite.prepare('INSERT INTO memberships (trip_id,user_id,member_id) VALUES (?,?,?)').run(id, owner, 'a');
}
function seedReceipt(database: SQLiteD1, id = crypto.randomUUID(), options: { state?: string; createdAt?: string; owner?: string; tripId?: string } = {}) {
  database.sqlite.prepare('INSERT INTO receipts (id,owner,trip_id,created_at,state) VALUES (?,?,?,?,?)').run(id, options.owner || actor, options.tripId || 'trip-1', options.createdAt ?? new Date().toISOString(), options.state || 'active');
  return id;
}
function count(database: SQLiteD1, table = 'receipts') { return database.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count as number; }
function provider(user = actor) { return { 'oai-authenticated-user-id': user, 'oai-authenticated-user-email': `${user}@example.com`, 'oai-authenticated-user-full-name': user }; }
function request(method: string, query: string, options: { user?: string | null; type?: string; body?: Uint8Array<ArrayBuffer>; origin?: string; length?: string } = {}) {
  const headers = { ...(options.user === null ? {} : provider(options.user || actor)), origin: options.origin || 'https://triptab.test', 'content-type': options.type || 'image/png', ...(options.length ? { 'content-length': options.length } : {}) };
  return new Request(`https://triptab.test/api/receipt?${query}`, { method, headers, ...(options.body ? { body: options.body } : {}) });
}
async function upload(database: SQLiteD1, bucket: MemoryR2, owner = actor, tripId = 'trip-1') {
  const id = crypto.randomUUID();
  await storeReceipt(database.asD1(), bucket.asR2(), owner, tripId, id, png, 'image/png');
  return id;
}

test('receipt migration preserves old metadata, treating age as unknown and images as active', async () => {
  const database = new SQLiteD1();
  for (const name of ['0000_charming_zeigeist.sql', '0001_regular_maginty.sql', '0002_windy_cammi.sql', '0003_rainy_blazing_skull.sql']) database.sqlite.exec(await readFile(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'));
  addTrip(database);
  const id = crypto.randomUUID(); database.sqlite.prepare('INSERT INTO receipts (id,owner,trip_id) VALUES (?,?,?)').run(id, actor, 'trip-1');
  const before = database.sqlite.prepare('SELECT data FROM trips').get()?.data;
  database.sqlite.exec(await readFile(new URL('../drizzle/0004_hot_old_lace.sql', import.meta.url), 'utf8'));
  assert.deepEqual({ ...database.sqlite.prepare('SELECT owner,trip_id,created_at,state FROM receipts WHERE id=?').get(id) }, { owner: actor, trip_id: 'trip-1', created_at: '', state: 'active' });
  assert.equal(database.sqlite.prepare('SELECT data FROM trips').get()?.data, before);
  assert.equal(await sweepReceiptOrphans(database.asD1(), actor, Date.now() + 10 * RECEIPT_LIMITS.orphanAgeMs), 0);
});

test('native receipt route uploads valid image, stores active metadata and protects image reads', async () => {
  const { database, bucket } = await storage();
  const response = await route.POST(request('POST', 'tripId=trip-1', { body: png }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const id = (await response.json() as { receiptId: string }).receiptId;
  assert.equal(count(database), 1); assert.ok(bucket.objects.has(imageKey(id)));
  const row = database.sqlite.prepare('SELECT state,created_at FROM receipts WHERE id=?').get(id);
  assert.equal(row?.state, 'active'); assert.ok(Number.isFinite(Date.parse(String(row?.created_at))));
  const image = await route.GET(request('GET', `id=${id}`));
  assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png'); assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), png);
  assert.equal((await route.GET(request('GET', `id=${id}`, { user: outsider }))).status, 404);
  assert.equal((await route.GET(request('GET', `id=${id}`, { user: null }))).status, 401);
});

test('upload endpoint rejects unauthorized, cross-origin, oversized and disguised files before reserving storage', async context => {
  context.mock.method(console, 'error', () => {});
  const { database, bucket } = await storage();
  assert.equal((await route.POST(request('POST', 'tripId=trip-1', { body: png, user: null }))).status, 401);
  assert.equal((await route.POST(request('POST', 'tripId=trip-1', { body: png, user: outsider }))).status, 403);
  assert.ok((await route.POST(request('POST', 'tripId=trip-1', { body: png, origin: 'https://evil.test' }))).status >= 400);
  assert.equal((await route.POST(request('POST', 'tripId=trip-1', { body: png, type: 'image/gif' }))).status, 400);
  assert.equal((await route.POST(request('POST', 'tripId=trip-1', { body: new Uint8Array([1, 2, 3, 4]) }))).status, 400);
  assert.equal((await route.POST(request('POST', 'tripId=trip-1', { body: png, length: String(6 * 1024 * 1024) }))).status, 413);
  assert.equal(count(database), 0); assert.equal(bucket.objects.size, 0);
});

test('atomic pending reservations enforce trip quota even when two uploads race for the final slot', async () => {
  const { database, bucket } = await storage();
  for (let index = 0; index < RECEIPT_LIMITS.perTrip - 1; index++) seedReceipt(database);
  const results = await Promise.allSettled([upload(database, bucket), upload(database, bucket)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const failure = (results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason;
  assert.ok(failure instanceof ReceiptLifecycleError && failure.status === 409);
  assert.equal(count(database), RECEIPT_LIMITS.perTrip); assert.equal(bucket.objects.size, 1);
});

test('account quota spans trips and rejects storage work before writing additional objects', async () => {
  const { database, bucket } = await storage(); addTrip(database, 'trip-2'); addTrip(database, 'trip-3');
  for (let index = 0; index < RECEIPT_LIMITS.perUser - 1; index++) seedReceipt(database, crypto.randomUUID(), { tripId: index < 200 ? 'trip-1' : index < 400 ? 'trip-2' : 'trip-3' });
  const results = await Promise.allSettled([upload(database, bucket, actor, 'trip-3'), upload(database, bucket, actor, 'trip-3')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(count(database), RECEIPT_LIMITS.perUser); assert.equal(bucket.objects.size, 1);
});

test('pending and deleting receipts cannot be read or attached to posted expenses or drafts', async () => {
  const { database } = await storage(); const id = crypto.randomUUID();
  await reserveReceipt(database.asD1(), actor, 'trip-1', id);
  assert.equal(await store.receiptAccess(actor, id), null);
  let state = await store.readLedger(actor); state.data.trips[0].expenses = [expense(id)];
  await assert.rejects(store.writeLedger(actor, state.data, state.revision), /does not belong/);
  state = await store.readLedger(actor); state.data.trips[0].drafts = [{ ...expense(id), id: 'draft-1', status: 'review' }];
  await assert.rejects(store.writeLedger(actor, state.data, state.revision), /does not belong/);
  database.sqlite.prepare("UPDATE receipts SET state='deleting' WHERE id=?").run(id);
  assert.equal(await store.receiptAccess(actor, id), null);
  await assert.rejects(activateReceipt(database.asD1(), actor, 'trip-1', id), /upload or your trip access changed/);
  assert.equal(count(database, 'activity_events'), 0);
});

test('shared image is retained until all expense/draft references are removed, then financial commit cleans it', async () => {
  const { database, bucket } = await storage(); const id = await upload(database, bucket);
  let state = await store.readLedger(actor);
  state.data.trips[0].expenses = [expense(id)]; state.data.trips[0].drafts = [{ ...expense(id), id: 'draft-1', status: 'review' }];
  state = await store.writeLedger(actor, state.data, state.revision);
  await assert.rejects(deleteReceipt(database.asD1(), bucket.asR2(), member, id), (error: unknown) => error instanceof ReceiptLifecycleError && error.status === 409);
  state.data.trips[0].expenses = [];
  state = await store.writeLedger(actor, state.data, state.revision);
  assert.equal(count(database), 1); assert.ok(bucket.objects.has(imageKey(id)));
  state.data.trips[0].drafts = [];
  await store.writeLedger(actor, state.data, state.revision);
  assert.equal(count(database), 0); assert.equal(bucket.objects.size, 0);
  const events = await store.readActivity(actor, 'trip-1');
  assert.ok(events.events.some(event => event.entityType === 'draft' && event.action === 'delete' && event.before?.receiptId === id));
});

test('receipt DELETE enforces auth/origin/membership/reference protection and returns private responses', async context => {
  context.mock.method(console, 'error', () => {});
  const { database, bucket } = await storage(); const id = await upload(database, bucket);
  assert.equal((await route.DELETE(request('DELETE', `id=${id}`, { user: null }))).status, 401);
  assert.equal((await route.DELETE(request('DELETE', `id=${id}`, { user: outsider }))).status, 404);
  assert.ok((await route.DELETE(request('DELETE', `id=${id}`, { origin: 'https://evil.test' }))).status >= 400);
  assert.equal((await route.DELETE(request('DELETE', `id=${id}&id=${id}`))).status, 400);
  const response = await route.DELETE(request('DELETE', `id=${id}`, { user: member }));
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await response.json(), { receiptId: id, deleted: true, pending: false });
  assert.equal(count(database), 0); assert.equal(bucket.objects.size, 0);
  assert.equal((await route.GET(request('GET', `id=${id}`))).status, 404);
});

test('R2 deletion failure retains an inaccessible tombstone and later DELETE retries successfully', async () => {
  const { database, bucket } = await storage(); const id = await upload(database, bucket); bucket.failDelete = true;
  const failed = await route.DELETE(request('DELETE', `id=${id}`));
  assert.equal(failed.status, 202);
  assert.deepEqual(await failed.json(), { receiptId: id, deleted: false, pending: true });
  assert.equal(database.sqlite.prepare('SELECT state FROM receipts WHERE id=?').get(id)?.state, 'deleting');
  assert.ok(bucket.objects.has(imageKey(id))); assert.equal((await route.GET(request('GET', `id=${id}`))).status, 404);
  bucket.failDelete = false;
  assert.equal((await route.DELETE(request('DELETE', `id=${id}`))).status, 200);
  assert.equal(count(database), 0); assert.equal(bucket.objects.size, 0);
});

test('ambiguous upload failure plus deletion outage keeps cleanup metadata until maintenance succeeds', async () => {
  const { database, bucket } = await storage(); bucket.failPut = true; bucket.failDelete = true;
  await assert.rejects(upload(database, bucket), (error: unknown) => error instanceof ReceiptLifecycleError && error.status === 503);
  assert.equal(count(database), 1); assert.equal(bucket.objects.size, 1);
  assert.equal(database.sqlite.prepare('SELECT state FROM receipts').get()?.state, 'deleting');
  bucket.failDelete = false;
  const result = await maintainReceipts(database.asD1(), bucket.asR2(), actor);
  assert.equal(result.deleted, 1); assert.equal(count(database), 0); assert.equal(bucket.objects.size, 0);
});

test('orphan sweep is bounded and protects references, recent uploads, unknown historical age and other trips', async () => {
  const { database, bucket } = await storage(); addTrip(database, 'private-trip', outsider);
  const old = new Date(Date.now() - 2 * RECEIPT_LIMITS.orphanAgeMs).toISOString();
  const unknown = seedReceipt(database, crypto.randomUUID(), { createdAt: '' });
  const recent = seedReceipt(database); const pending = seedReceipt(database, crypto.randomUUID(), { state: 'pending' });
  const stalledPending = seedReceipt(database, crypto.randomUUID(), { state: 'pending', createdAt: old });
  const linked = seedReceipt(database, crypto.randomUUID(), { createdAt: old });
  const foreign = seedReceipt(database, crypto.randomUUID(), { owner: outsider, tripId: 'private-trip', createdAt: old });
  const holiday = trip(); holiday.expenses = [expense(linked)]; database.sqlite.prepare('UPDATE trips SET data=? WHERE id=?').run(JSON.stringify(holiday), 'trip-1');
  for (let index = 0; index < RECEIPT_LIMITS.sweepBatch + 3; index++) {
    const id = seedReceipt(database, crypto.randomUUID(), { createdAt: old }); bucket.objects.set(imageKey(id), { bytes: png, contentType: 'image/png' });
  }
  assert.equal(await sweepReceiptOrphans(database.asD1(), actor), RECEIPT_LIMITS.sweepBatch);
  assert.equal((await purgeDeletingReceipts(database.asD1(), bucket.asR2(), actor)).deleted, RECEIPT_LIMITS.sweepBatch);
  assert.equal(bucket.objects.size, 3);
  assert.equal((await maintainReceipts(database.asD1(), bucket.asR2(), actor)).deleted, 3);
  assert.equal(count(database), 6);
  for (const id of [unknown, recent, pending, stalledPending, linked, foreign]) assert.ok(database.sqlite.prepare('SELECT id FROM receipts WHERE id=?').get(id));
});

test('deletion mark winning after financial prevalidation makes the actual CAS reject reattachment with no audit/money changes', async () => {
  const { database, bucket } = await storage(); const id = await upload(database, bucket);
  const state = await store.readLedger(actor); state.data.trips[0].expenses = [expense(id)];
  database.beforeWriteBatch = () => markRemovedReceipts(database.asD1(), actor, [id]);
  await assert.rejects(store.writeLedger(actor, state.data, state.revision), /CONFLICT/);
  assert.equal((await store.readLedger(actor)).data.trips[0].expenses.length, 0);
  assert.equal((await store.readLedger(actor)).revision, 0); assert.equal(count(database, 'activity_events'), 0);
  assert.equal(database.sqlite.prepare('SELECT state FROM receipts WHERE id=?').get(id)?.state, 'deleting');
  await purgeDeletingReceipts(database.asD1(), bucket.asR2(), actor);
  assert.equal(count(database), 0); assert.equal(bucket.objects.size, 0);
});

test('financial attachment winning first makes the later deletion mark a no-op', async () => {
  const { database, bucket } = await storage(); const id = await upload(database, bucket);
  const state = await store.readLedger(actor); state.data.trips[0].expenses = [expense(id)];
  await store.writeLedger(actor, state.data, state.revision);
  assert.equal(await markRemovedReceipts(database.asD1(), actor, [id]), 0);
  assert.equal((await purgeDeletingReceipts(database.asD1(), bucket.asR2(), actor)).deleted, 0);
  assert.equal(count(database), 1); assert.ok(bucket.objects.has(imageKey(id)));
});

test('failed object cleanup cannot undo a financial deletion or permit reattachment', async () => {
  const { database, bucket } = await storage(); const id = await upload(database, bucket);
  let state = await store.readLedger(actor); state.data.trips[0].expenses = [expense(id)]; state = await store.writeLedger(actor, state.data, state.revision);
  bucket.failDelete = true; state.data.trips[0].expenses = [];
  state = await store.writeLedger(actor, state.data, state.revision);
  assert.equal(state.data.trips[0].expenses.length, 0); assert.equal(state.revision, 2);
  assert.equal(database.sqlite.prepare('SELECT state FROM receipts WHERE id=?').get(id)?.state, 'deleting');
  state.data.trips[0].expenses = [expense(id)]; await assert.rejects(store.writeLedger(actor, state.data, state.revision), /does not belong/);
  bucket.failDelete = false; assert.equal((await maintainReceipts(database.asD1(), bucket.asR2(), actor)).deleted, 1);
});

test('upload access loss cleans reserved metadata and object even after uploader leaves trip membership', async () => {
  const { database, bucket } = await storage();
  bucket.beforePut = async () => { database.sqlite.prepare('DELETE FROM memberships WHERE user_id=?').run(member); };
  await assert.rejects(upload(database, bucket, member), (error: unknown) => error instanceof ReceiptLifecycleError && error.status === 409);
  assert.equal(count(database), 0); assert.equal(bucket.objects.size, 0);
});

test('orphan sweep cannot race a slow pending put; successful activation starts its full attachment window', async () => {
  const { database, bucket } = await storage();
  bucket.beforePut = async key => {
    const id = key.split('/').at(-1)!;
    database.sqlite.prepare('UPDATE receipts SET created_at=? WHERE id=?').run(new Date(Date.now() - 2 * RECEIPT_LIMITS.orphanAgeMs).toISOString(), id);
    const result = await maintainReceipts(database.asD1(), bucket.asR2(), actor);
    assert.equal(result.marked, 0); assert.equal(result.deleted, 0);
    assert.equal(count(database), 1);
    assert.equal(database.sqlite.prepare('SELECT state FROM receipts WHERE id=?').get(id)?.state, 'pending');
  };
  const id = await upload(database, bucket);
  assert.equal(count(database), 1); assert.equal(bucket.objects.size, 1);
  assert.equal(database.sqlite.prepare('SELECT state FROM receipts').get()?.state, 'active');
  assert.equal(await sweepReceiptOrphans(database.asD1(), actor), 0);
  await deleteReceipt(database.asD1(), bucket.asR2(), actor, id);
  assert.equal(count(database), 0); assert.equal(bucket.objects.size, 0);
});
