import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import {
  activateReceipt, deleteReceipt, maintainReceipts, maintainSystemReceipts, markRemovedReceipts,
  purgeDeletingReceipts, RECEIPT_LIMITS, ReceiptLifecycleError, reserveReceipt,
  storeReceipt, sweepReceiptOrphans,
} from '../lib/receipt-lifecycle';
import type { Trip } from '../lib/model';
import { ledgerEtag } from '../lib/ledger-freshness';
import type { ActivityEvent } from '../lib/audit';

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
  beforeReceiptBatch?: () => Promise<unknown> | unknown;
  private pending: Promise<unknown> = Promise.resolve();
  prepare(sql: string) { return new SQLiteStatement(this.sqlite, sql); }
  async batch(statements: SQLiteStatement[]) {
    if (statements.some(statement => /^UPDATE sync_state/.test(statement.sql.trim())) && this.beforeWriteBatch) {
      const hook = this.beforeWriteBatch; this.beforeWriteBatch = undefined; await this.pending; await hook();
    }
    if (statements.some(statement => /^(INSERT(?: OR IGNORE)? INTO|UPDATE|DELETE FROM) receipts\b/.test(statement.sql.trim())) && this.beforeReceiptBatch) {
      const hook = this.beforeReceiptBatch; this.beforeReceiptBatch = undefined; await this.pending; await hook();
    }
    const operation = this.pending.then(() => {
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
  readonly putCalls: string[] = [];
  readonly deleteCalls: string[] = [];
  failPut = false;
  failDelete = false;
  beforePut?: (key: string) => Promise<void>;
  beforeDelete?: (key: string) => Promise<void>;
  async put(key: string, bytes: Uint8Array, options: { httpMetadata: { contentType: string } }) {
    this.putCalls.push(key);
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
  .replaceAll("'./audit'", JSON.stringify(new URL('../lib/audit.ts', import.meta.url).href))
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
function seedReceipt(database: SQLiteD1, id = crypto.randomUUID(), options: { state?: string; createdAt?: string; owner?: string; tripId?: string; legacyCleanupAfter?: string } = {}) {
  database.sqlite.prepare('INSERT INTO receipts (id,owner,trip_id,created_at,state,legacy_cleanup_after) VALUES (?,?,?,?,?,?)').run(id, options.owner || actor, options.tripId || 'trip-1', options.createdAt ?? new Date().toISOString(), options.state || 'active', options.legacyCleanupAfter || '');
  return id;
}
function count(database: SQLiteD1, table = 'receipts') { return database.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count as number; }
function receiptEvents(database: SQLiteD1, id?: string): ActivityEvent[] {
  const rows = database.sqlite.prepare(`SELECT * FROM activity_events WHERE entity_type='receipt' ${id ? 'AND entity_id=?' : ''} ORDER BY sequence`).all(...(id ? [id] : []));
  return rows.map(row => ({
    id: String(row.id), sequence: Number(row.sequence), tripId: String(row.trip_id), entityType: 'receipt', entityId: String(row.entity_id),
    actorId: String(row.actor_id), actorName: String(row.actor_name), createdAt: String(row.created_at), revision: Number(row.revision),
    action: row.action as ActivityEvent['action'], source: row.source as ActivityEvent['source'],
    before: row.before_data ? JSON.parse(String(row.before_data)) : null, after: row.after_data ? JSON.parse(String(row.after_data)) : null,
  }));
}
function failReceiptAudit(database: SQLiteD1, condition: string) {
  database.sqlite.exec(`CREATE TRIGGER reject_receipt_audit BEFORE INSERT ON activity_events
    WHEN NEW.entity_type='receipt' AND (${condition}) BEGIN SELECT RAISE(ABORT, 'receipt audit unavailable'); END`);
}
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

test('receipt migrations preserve unknown upload age and give legacy images a migration-anchored grace period', async () => {
  const database = new SQLiteD1();
  for (const name of ['0000_charming_zeigeist.sql', '0001_regular_maginty.sql', '0002_windy_cammi.sql', '0003_rainy_blazing_skull.sql']) database.sqlite.exec(await readFile(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'));
  addTrip(database);
  const id = crypto.randomUUID(); database.sqlite.prepare('INSERT INTO receipts (id,owner,trip_id) VALUES (?,?,?)').run(id, actor, 'trip-1');
  const before = database.sqlite.prepare('SELECT data FROM trips').get()?.data;
  database.sqlite.exec(await readFile(new URL('../drizzle/0004_hot_old_lace.sql', import.meta.url), 'utf8'));
  assert.deepEqual({ ...database.sqlite.prepare('SELECT owner,trip_id,created_at,state FROM receipts WHERE id=?').get(id) }, { owner: actor, trip_id: 'trip-1', created_at: '', state: 'active' });
  assert.equal(database.sqlite.prepare('SELECT data FROM trips').get()?.data, before);
  database.sqlite.exec(await readFile(new URL('../drizzle/0005_audit_coverage.sql', import.meta.url), 'utf8'));
  assert.deepEqual({ ...database.sqlite.prepare('SELECT content_type,size_bytes,sha256 FROM receipts WHERE id=?').get(id) }, { content_type: '', size_bytes: 0, sha256: '' });
  const pending = crypto.randomUUID(), known = crypto.randomUUID();
  database.sqlite.prepare("INSERT INTO receipts (id,owner,trip_id,created_at,state) VALUES (?,?,?,'','pending')").run(pending, actor, 'trip-1');
  database.sqlite.prepare("INSERT INTO receipts (id,owner,trip_id,created_at,state) VALUES (?,?,?,?,'active')").run(known, actor, 'trip-1', new Date(Date.now() + RECEIPT_LIMITS.orphanAgeMs).toISOString());
  const migrationStarted = Date.now();
  database.sqlite.exec(await readFile(new URL('../drizzle/0006_receipt_cleanup.sql', import.meta.url), 'utf8'));
  const migrationFinished = Date.now();
  const legacy = database.sqlite.prepare('SELECT created_at,legacy_cleanup_after FROM receipts WHERE id=?').get(id);
  assert.equal(legacy?.created_at, '', 'the migration does not invent an original upload timestamp');
  const deadline = Date.parse(String(legacy?.legacy_cleanup_after));
  assert.ok(deadline >= migrationStarted + RECEIPT_LIMITS.orphanAgeMs - 1 && deadline <= migrationFinished + RECEIPT_LIMITS.orphanAgeMs + 1);
  for (const untouched of [pending, known]) assert.equal(database.sqlite.prepare('SELECT legacy_cleanup_after FROM receipts WHERE id=?').get(untouched)?.legacy_cleanup_after, '');
  assert.equal(await sweepReceiptOrphans(database.asD1(), actor, deadline - 1), 0);
  const bucket = new MemoryR2(); bucket.objects.set(imageKey(id), { bytes: png, contentType: 'image/png' });
  const result = await maintainSystemReceipts(database.asD1(), bucket.asR2(), { now: deadline, sweepLimit: 1, purgeLimit: 1 });
  assert.deepEqual(result, { marked: 1, deleted: 1, failed: 0 });
  assert.equal(bucket.objects.size, 0);
  const events = receiptEvents(database, id);
  assert.equal(events.length, 2); assert.equal(events[0].before?.createdAt, ''); assert.equal(events[0].before?.legacyCleanupAfter, legacy?.legacy_cleanup_after);
  assert.equal(events[0].after?.reason, 'orphan-expired'); assert.equal(events[1].source, 'system');
});

test('native receipt route uploads valid image, stores active metadata and protects image reads', async () => {
  const { database, bucket } = await storage();
  const initialTag = await ledgerEtag(database.asD1(), actor);
  const response = await route.POST(request('POST', 'tripId=trip-1', { body: png }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const id = (await response.json() as { receiptId: string }).receiptId;
  assert.equal(count(database), 1); assert.ok(bucket.objects.has(imageKey(id)));
  const row = database.sqlite.prepare('SELECT state,created_at FROM receipts WHERE id=?').get(id);
  assert.equal(row?.state, 'active'); assert.ok(Number.isFinite(Date.parse(String(row?.created_at))));
  const events = receiptEvents(database, id);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(event => [event.action, event.before?.state, event.after?.state, event.after?.reason]), [
    ['create', undefined, 'pending', 'upload-started'], ['update', 'pending', 'active', 'upload-complete'],
  ]);
  for (const event of events) {
    assert.equal(event.actorId, actor); assert.equal(event.actorName, actor); assert.equal(event.source, 'web'); assert.equal(event.revision, 0);
    assert.ok(Number.isFinite(Date.parse(event.createdAt)));
    assert.equal(event.after?.uploaderId, actor); assert.equal(event.after?.initiatorId, actor);
    assert.equal(event.after?.sizeBytes, png.byteLength); assert.equal(event.after?.contentType, 'image/png');
    assert.equal(event.after?.sha256, createHash('sha256').update(png).digest('hex'));
    assert.deepEqual(Object.keys(event.after || {}).sort(), ['contentType', 'createdAt', 'id', 'initiatorId', 'initiatorName', 'reason', 'sha256', 'sizeBytes', 'state', 'uploaderId'].sort());
  }
  assert.equal((await store.readLedger(actor)).revision, 0, 'image metadata does not mutate the financial revision');
  assert.notEqual(await ledgerEtag(database.asD1(), actor), initialTag, 'receipt activity changes visible freshness');
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
  assert.equal(receiptEvents(database).length, 0); assert.equal(bucket.putCalls.length, 0);
});

test('atomic pending reservations enforce trip quota even when two uploads race for the final slot', async () => {
  const { database, bucket } = await storage();
  for (let index = 0; index < RECEIPT_LIMITS.perTrip - 1; index++) seedReceipt(database);
  const results = await Promise.allSettled([upload(database, bucket), upload(database, bucket)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const failure = (results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason;
  assert.ok(failure instanceof ReceiptLifecycleError && failure.status === 409);
  assert.equal(count(database), RECEIPT_LIMITS.perTrip); assert.equal(bucket.objects.size, 1);
  assert.equal(receiptEvents(database).length, 2, 'the rejected quota reservation creates no event');
});

test('account quota spans trips and rejects storage work before writing additional objects', async () => {
  const { database, bucket } = await storage(); addTrip(database, 'trip-2'); addTrip(database, 'trip-3');
  for (let index = 0; index < RECEIPT_LIMITS.perUser - 1; index++) seedReceipt(database, crypto.randomUUID(), { tripId: index < 200 ? 'trip-1' : index < 400 ? 'trip-2' : 'trip-3' });
  const results = await Promise.allSettled([upload(database, bucket, actor, 'trip-3'), upload(database, bucket, actor, 'trip-3')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(count(database), RECEIPT_LIMITS.perUser); assert.equal(bucket.objects.size, 1);
  assert.equal(receiptEvents(database).length, 2);
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
  assert.equal(count(database, 'activity_events'), 1, 'only the successful pending reservation is audited');
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
  await store.writeLedger(actor, state.data, state.revision, { source: 'chatgpt' });
  assert.equal(count(database), 0); assert.equal(bucket.objects.size, 0);
  const events = await store.readActivity(actor, 'trip-1');
  assert.ok(events.events.some(event => event.entityType === 'draft' && event.action === 'delete' && event.before?.receiptId === id));
  const receiptHistory = receiptEvents(database, id);
  assert.equal(receiptHistory[2].source, 'chatgpt'); assert.equal(receiptHistory[2].actorId, actor);
  assert.equal(receiptHistory[2].after?.reason, 'receipt-detached');
  assert.equal(receiptHistory[3].source, 'system'); assert.equal(receiptHistory[3].before?.initiatorId, actor);
});

test('receipt DELETE enforces auth/origin/membership/reference protection and returns private responses', async context => {
  context.mock.method(console, 'error', () => {});
  const { database, bucket } = await storage(); const id = await upload(database, bucket);
  assert.equal((await route.DELETE(request('DELETE', `id=${id}`, { user: null }))).status, 401);
  assert.equal((await route.DELETE(request('DELETE', `id=${id}`, { user: outsider }))).status, 404);
  assert.ok((await route.DELETE(request('DELETE', `id=${id}`, { origin: 'https://evil.test' }))).status >= 400);
  assert.equal((await route.DELETE(request('DELETE', `id=${id}&id=${id}`))).status, 400);
  assert.equal(receiptEvents(database, id).length, 2, 'rejected deletion requests leave audit unchanged');
  const response = await route.DELETE(request('DELETE', `id=${id}`, { user: member }));
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await response.json(), { receiptId: id, deleted: true, pending: false });
  assert.equal(count(database), 0); assert.equal(bucket.objects.size, 0);
  assert.equal((await route.GET(request('GET', `id=${id}`))).status, 404);
  const events = receiptEvents(database, id);
  assert.equal(events.length, 4);
  assert.equal(events[2].actorId, member); assert.equal(events[2].source, 'web');
  assert.equal(events[2].after?.reason, 'image-deletion'); assert.equal(events[2].after?.uploaderId, actor);
  assert.equal(events[3].actorId, 'system'); assert.equal(events[3].actorName, 'TripTab'); assert.equal(events[3].source, 'system');
  assert.equal(events[3].before?.initiatorId, member); assert.equal(events[3].before?.deletionReason, 'image-deletion');
  assert.equal(events[3].action, 'delete'); assert.equal(events[3].after, null);
});

test('R2 deletion failure retains an inaccessible tombstone and later DELETE retries successfully', async () => {
  const { database, bucket } = await storage(); const id = await upload(database, bucket); bucket.failDelete = true;
  const failed = await route.DELETE(request('DELETE', `id=${id}`, { user: member }));
  assert.equal(failed.status, 202);
  assert.deepEqual(await failed.json(), { receiptId: id, deleted: false, pending: true });
  assert.equal(database.sqlite.prepare('SELECT state FROM receipts WHERE id=?').get(id)?.state, 'deleting');
  assert.ok(bucket.objects.has(imageKey(id))); assert.equal((await route.GET(request('GET', `id=${id}`))).status, 404);
  assert.equal(receiptEvents(database, id).length, 3, 'storage failure records intent, never completion');
  bucket.failDelete = false;
  assert.equal((await route.DELETE(request('DELETE', `id=${id}`))).status, 200);
  assert.equal(count(database), 0); assert.equal(bucket.objects.size, 0);
  assert.equal(receiptEvents(database, id).length, 4);
  assert.equal(receiptEvents(database, id)[3].before?.initiatorId, member, 'another participant retry retains the original initiator');
  await maintainReceipts(database.asD1(), bucket.asR2(), actor);
  assert.equal(receiptEvents(database, id).length, 4, 'completed cleanup produces no repeated events');
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
  const initialAudit = count(database, 'activity_events');
  const state = await store.readLedger(actor); state.data.trips[0].expenses = [expense(id)];
  database.beforeWriteBatch = () => markRemovedReceipts(database.asD1(), actor, [id]);
  await assert.rejects(store.writeLedger(actor, state.data, state.revision), /CONFLICT/);
  assert.equal((await store.readLedger(actor)).data.trips[0].expenses.length, 0);
  assert.equal((await store.readLedger(actor)).revision, 0); assert.equal(count(database, 'activity_events'), initialAudit + 1, 'only the winning deletion intent is recorded');
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

test('reservation audit failure rolls back its quota slot before any R2 write', async context => {
  context.mock.method(console, 'error', () => {});
  const { database, bucket } = await storage();
  failReceiptAudit(database, "NEW.action='create'");
  const response = await route.POST(request('POST', 'tripId=trip-1', { body: png }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Unable to complete this request. Check your entries and try again.' });
  assert.equal(count(database), 0); assert.equal(receiptEvents(database).length, 0); assert.equal(bucket.putCalls.length, 0);
  database.sqlite.exec('DROP TRIGGER reject_receipt_audit');
  assert.equal((await route.POST(request('POST', 'tripId=trip-1', { body: png }))).status, 200);
  assert.equal(receiptEvents(database).length, 2);
});

test('activation audit failure cannot fabricate success and records failed-upload cleanup', async () => {
  const { database, bucket } = await storage(); const id = crypto.randomUUID();
  failReceiptAudit(database, "json_extract(NEW.after_data,'$.state')='active'");
  await assert.rejects(storeReceipt(database.asD1(), bucket.asR2(), actor, 'trip-1', id, png, 'image/png'), (error: unknown) => error instanceof ReceiptLifecycleError && error.status === 503);
  assert.equal(count(database), 0); assert.equal(bucket.objects.size, 0); assert.equal(bucket.putCalls.length, 1);
  const events = receiptEvents(database, id);
  assert.deepEqual(events.map(event => [event.action, event.after?.state, event.source]), [
    ['create', 'pending', 'web'], ['update', 'deleting', 'system'], ['delete', undefined, 'system'],
  ]);
  assert.equal(events[1].before?.state, 'pending'); assert.equal(events[1].after?.reason, 'upload-failed');
  assert.equal(events[1].actorId, 'system'); assert.equal(events[1].after?.initiatorId, actor);
  assert.equal(events[2].before?.deletionReason, 'upload-failed'); assert.equal(events[2].before?.initiatorId, actor);
});

test('deletion-intent audit failure rolls back the mark and prevents R2 deletion', async context => {
  context.mock.method(console, 'error', () => {});
  const { database, bucket } = await storage(); const id = await upload(database, bucket);
  failReceiptAudit(database, "json_extract(NEW.after_data,'$.state')='deleting'");
  const response = await route.DELETE(request('DELETE', `id=${id}`, { user: member }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Unable to complete this request. Check your entries and try again.' });
  assert.equal(database.sqlite.prepare('SELECT state FROM receipts WHERE id=?').get(id)?.state, 'active');
  assert.equal(bucket.deleteCalls.length, 0); assert.ok(bucket.objects.has(imageKey(id))); assert.equal(receiptEvents(database, id).length, 2);
  database.sqlite.exec('DROP TRIGGER reject_receipt_audit');
  assert.equal((await route.DELETE(request('DELETE', `id=${id}`, { user: member }))).status, 200);
  assert.equal(receiptEvents(database, id).length, 4);
});

test('completion audit failure retains metadata for an idempotent retry after R2 bytes are gone', async () => {
  const { database, bucket } = await storage(); const id = await upload(database, bucket);
  failReceiptAudit(database, "NEW.action='delete'");
  const response = await route.DELETE(request('DELETE', `id=${id}`, { user: member }));
  assert.equal(response.status, 202); assert.equal(bucket.objects.size, 0);
  assert.equal(database.sqlite.prepare('SELECT state FROM receipts WHERE id=?').get(id)?.state, 'deleting');
  assert.equal(receiptEvents(database, id).length, 3, 'metadata deletion and its completion event roll back together');
  database.sqlite.exec('DROP TRIGGER reject_receipt_audit');
  assert.equal((await route.DELETE(request('DELETE', `id=${id}`))).status, 200);
  const events = receiptEvents(database, id);
  assert.equal(events.length, 4); assert.equal(events[3].before?.initiatorId, member);
  assert.equal(bucket.deleteCalls.length, 2); assert.equal(count(database), 0);
});

test('two cleanup workers deleting the same tombstone append only one completion event', async () => {
  const { database, bucket } = await storage(); const id = await upload(database, bucket);
  assert.equal(await markRemovedReceipts(database.asD1(), member, [id]), 1);
  let entered = 0, release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  bucket.beforeDelete = async () => { entered++; if (entered === 2) release(); await ready; };
  const results = await Promise.all([
    purgeDeletingReceipts(database.asD1(), bucket.asR2(), actor),
    purgeDeletingReceipts(database.asD1(), bucket.asR2(), member),
  ]);
  assert.equal(results.reduce((sum, result) => sum + result.deleted, 0), 1);
  assert.equal(results.reduce((sum, result) => sum + result.failed, 0), 0);
  assert.equal(bucket.deleteCalls.length, 2); assert.equal(count(database), 0);
  const events = receiptEvents(database, id);
  assert.equal(events.length, 4); assert.equal(events.filter(event => event.action === 'delete').length, 1);
});

test('a financial attachment winning after deletion preselection creates no deletion intent', async () => {
  const { database, bucket } = await storage(); const id = await upload(database, bucket);
  database.beforeReceiptBatch = async () => {
    const state = await store.readLedger(actor); state.data.trips[0].expenses = [expense(id)];
    await store.writeLedger(actor, state.data, state.revision);
  };
  assert.equal(await markRemovedReceipts(database.asD1(), member, [id]), 0);
  assert.equal(database.sqlite.prepare('SELECT state FROM receipts WHERE id=?').get(id)?.state, 'active');
  assert.ok(bucket.objects.has(imageKey(id))); assert.equal(receiptEvents(database, id).length, 2);
  assert.equal((await store.readLedger(actor)).data.trips[0].expenses[0].receiptId, id);
});

test('membership revocation winning after deletion preselection creates no resource event', async () => {
  const { database, bucket } = await storage(); const id = await upload(database, bucket);
  database.beforeReceiptBatch = () => { database.sqlite.prepare('DELETE FROM memberships WHERE trip_id=? AND user_id=?').run('trip-1', member); };
  assert.equal(await markRemovedReceipts(database.asD1(), member, [id]), 0);
  assert.equal(database.sqlite.prepare('SELECT state FROM receipts WHERE id=?').get(id)?.state, 'active');
  assert.ok(bucket.objects.has(imageKey(id))); assert.equal(receiptEvents(database, id).length, 2);
});

test('orphan cleanup is attributed to maintenance and records the expiry cause', async () => {
  const { database, bucket } = await storage(); const id = await upload(database, bucket);
  const old = new Date(Date.now() - 2 * RECEIPT_LIMITS.orphanAgeMs).toISOString();
  database.sqlite.prepare('UPDATE receipts SET created_at=? WHERE id=?').run(old, id);
  const result = await maintainReceipts(database.asD1(), bucket.asR2(), member);
  assert.deepEqual(result, { marked: 1, deleted: 1, failed: 0 });
  const events = receiptEvents(database, id);
  assert.equal(events.length, 4); assert.equal(events[2].after?.reason, 'orphan-expired');
  assert.equal(events[2].before?.createdAt, old); assert.equal(events[3].before?.deletionReason, 'orphan-expired');
  for (const event of events.slice(2)) { assert.equal(event.actorId, 'system'); assert.equal(event.actorName, 'TripTab'); assert.equal(event.source, 'system'); }
});

test('a concurrent attachment protects an orphan selected by maintenance without a false cleanup event', async () => {
  const { database, bucket } = await storage(); const id = await upload(database, bucket);
  database.sqlite.prepare('UPDATE receipts SET created_at=? WHERE id=?').run(new Date(Date.now() - 2 * RECEIPT_LIMITS.orphanAgeMs).toISOString(), id);
  database.beforeReceiptBatch = async () => {
    const state = await store.readLedger(actor); state.data.trips[0].expenses = [expense(id)];
    await store.writeLedger(actor, state.data, state.revision);
  };
  assert.equal(await sweepReceiptOrphans(database.asD1(), member), 0);
  assert.equal(receiptEvents(database, id).length, 2); assert.ok(bucket.objects.has(imageKey(id)));
  assert.equal(database.sqlite.prepare('SELECT state FROM receipts WHERE id=?').get(id)?.state, 'active');
});

test('competing activation requests record only the successful state transition', async () => {
  const { database } = await storage(); const id = crypto.randomUUID();
  await reserveReceipt(database.asD1(), actor, 'trip-1', id);
  const results = await Promise.allSettled([
    activateReceipt(database.asD1(), actor, 'trip-1', id), activateReceipt(database.asD1(), actor, 'trip-1', id),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const failure = (results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason;
  assert.ok(failure instanceof ReceiptLifecycleError && failure.status === 409);
  assert.equal(receiptEvents(database, id).length, 2);
});

test('global maintenance cleans quiet trips across accounts with bounded mutation and object batches', async () => {
  const { database, bucket } = await storage(); addTrip(database, 'quiet-private-trip', outsider);
  const now = Date.now(), old = new Date(now - 2 * RECEIPT_LIMITS.orphanAgeMs).toISOString();
  const ids: string[] = [];
  for (let index = 0; index < RECEIPT_LIMITS.sweepBatch + 3; index++) {
    const owner = index % 2 ? outsider : actor;
    const id = seedReceipt(database, crypto.randomUUID(), { owner, tripId: owner === outsider ? 'quiet-private-trip' : 'trip-1', createdAt: old });
    ids.push(id); bucket.objects.set(imageKey(id, owner), { bytes: png, contentType: 'image/png' });
  }
  database.sqlite.prepare('DELETE FROM memberships').run();
  const revision = (await store.readLedger(actor)).revision;
  assert.deepEqual(await maintainSystemReceipts(database.asD1(), bucket.asR2(), { now }), { marked: 20, deleted: 20, failed: 0 });
  assert.equal(bucket.objects.size, 3); assert.equal(count(database), 3); assert.equal(bucket.deleteCalls.length, 20);
  assert.deepEqual(await maintainSystemReceipts(database.asD1(), bucket.asR2(), { now, sweepLimit: 1, purgeLimit: 1 }), { marked: 1, deleted: 1, failed: 0 });
  assert.equal(bucket.objects.size, 2); assert.equal(count(database), 2);
  const events = receiptEvents(database);
  assert.equal(events.length, 42); assert.equal(events.some(event => event.tripId === 'quiet-private-trip'), true);
  for (const event of events) { assert.equal(event.actorId, 'system'); assert.equal(event.source, 'system'); }
  assert.equal((await store.readLedger(actor)).revision, revision);
  assert.equal(ids.length, 23);
});

test('global maintenance protects pending uploads, recent images and all live expense/draft references', async () => {
  const { database, bucket } = await storage(); const now = Date.now(), old = new Date(now - 2 * RECEIPT_LIMITS.orphanAgeMs).toISOString();
  const expiredGrace = new Date(now - 1).toISOString();
  const pending = seedReceipt(database, crypto.randomUUID(), { state: 'pending', createdAt: old, legacyCleanupAfter: expiredGrace });
  const recent = seedReceipt(database), unknown = seedReceipt(database, crypto.randomUUID(), { createdAt: '' });
  const expenseImage = seedReceipt(database, crypto.randomUUID(), { createdAt: old });
  const draftImage = seedReceipt(database, crypto.randomUUID(), { createdAt: '', legacyCleanupAfter: expiredGrace });
  const holiday = trip(); holiday.expenses = [expense(expenseImage)]; holiday.drafts = [{ ...expense(draftImage), id: 'quiet-review', status: 'review' }];
  database.sqlite.prepare('UPDATE trips SET data=? WHERE id=?').run(JSON.stringify(holiday), 'trip-1');
  for (const id of [pending, recent, unknown, expenseImage, draftImage]) bucket.objects.set(imageKey(id), { bytes: png, contentType: 'image/png' });
  assert.deepEqual(await maintainSystemReceipts(database.asD1(), bucket.asR2(), { now }), { marked: 0, deleted: 0, failed: 0 });
  assert.equal(count(database), 5); assert.equal(bucket.objects.size, 5); assert.equal(receiptEvents(database).length, 0);
});

test('global cleanup retries a participant tombstone without access links and preserves the original initiator', async () => {
  const { database, bucket } = await storage(); const id = await upload(database, bucket);
  bucket.failDelete = true;
  assert.deepEqual(await deleteReceipt(database.asD1(), bucket.asR2(), member, id), { receiptId: id, deleted: false, pending: true });
  database.sqlite.prepare('DELETE FROM memberships').run();
  assert.deepEqual(await maintainSystemReceipts(database.asD1(), bucket.asR2()), { marked: 0, deleted: 0, failed: 1 });
  assert.equal(receiptEvents(database, id).length, 3);
  bucket.failDelete = false;
  assert.deepEqual(await maintainSystemReceipts(database.asD1(), bucket.asR2()), { marked: 0, deleted: 1, failed: 0 });
  const events = receiptEvents(database, id);
  assert.equal(events.length, 4); assert.equal(events[3].before?.initiatorId, member); assert.equal(events[3].before?.deletionReason, 'image-deletion');
  assert.equal(events[3].actorId, 'system'); assert.equal(events[3].source, 'system'); assert.equal(count(database), 0);
  assert.deepEqual(await maintainSystemReceipts(database.asD1(), bucket.asR2()), { marked: 0, deleted: 0, failed: 0 });
  assert.equal(receiptEvents(database, id).length, 4);
});

test('a competing financial attachment prevents global cleanup from auditing or deleting a selected image', async () => {
  const { database, bucket } = await storage(); const id = await upload(database, bucket);
  database.sqlite.prepare('UPDATE receipts SET created_at=? WHERE id=?').run(new Date(Date.now() - 2 * RECEIPT_LIMITS.orphanAgeMs).toISOString(), id);
  database.beforeReceiptBatch = async () => {
    const state = await store.readLedger(actor); state.data.trips[0].expenses = [expense(id)];
    await store.writeLedger(actor, state.data, state.revision);
  };
  assert.deepEqual(await maintainSystemReceipts(database.asD1(), bucket.asR2()), { marked: 0, deleted: 0, failed: 0 });
  assert.equal(receiptEvents(database, id).length, 2); assert.ok(bucket.objects.has(imageKey(id)));
  assert.equal(database.sqlite.prepare('SELECT state FROM receipts WHERE id=?').get(id)?.state, 'active');
});

test('legacy grace changes after global selection invalidate the exact deletion baseline', async () => {
  const { database, bucket } = await storage(); const now = Date.now();
  const id = seedReceipt(database, crypto.randomUUID(), { createdAt: '', legacyCleanupAfter: new Date(now - 1).toISOString() });
  bucket.objects.set(imageKey(id), { bytes: png, contentType: 'image/png' });
  const extended = new Date(now + RECEIPT_LIMITS.orphanAgeMs).toISOString();
  database.beforeReceiptBatch = () => { database.sqlite.prepare('UPDATE receipts SET legacy_cleanup_after=? WHERE id=?').run(extended, id); };
  assert.deepEqual(await maintainSystemReceipts(database.asD1(), bucket.asR2(), { now }), { marked: 0, deleted: 0, failed: 0 });
  assert.equal(receiptEvents(database, id).length, 0); assert.ok(bucket.objects.has(imageKey(id)));
  assert.equal(database.sqlite.prepare('SELECT legacy_cleanup_after FROM receipts WHERE id=?').get(id)?.legacy_cleanup_after, extended);
});

test('global maintenance validates strict bounds before doing any database or R2 work', async () => {
  const { database, bucket } = await storage();
  seedReceipt(database, crypto.randomUUID(), { createdAt: new Date(Date.now() - 2 * RECEIPT_LIMITS.orphanAgeMs).toISOString() });
  for (const options of [{ sweepLimit: 0 }, { sweepLimit: 21 }, { sweepLimit: 1.5 }, { purgeLimit: NaN }, { purgeLimit: Infinity }, { purgeLimit: -1 }, { now: NaN }, { now: -1 }, { now: 8_640_000_000_000_001 }]) {
    await assert.rejects(maintainSystemReceipts(database.asD1(), bucket.asR2(), options), /Invalid receipt maintenance/);
  }
  assert.equal(receiptEvents(database).length, 0); assert.equal(bucket.deleteCalls.length, 0); assert.equal(count(database), 1);
});

test('global sweep audit failure rolls back all selected marks before deleting any objects', async () => {
  const { database, bucket } = await storage(); const old = new Date(Date.now() - 2 * RECEIPT_LIMITS.orphanAgeMs).toISOString();
  for (let index = 0; index < 2; index++) {
    const id = seedReceipt(database, crypto.randomUUID(), { createdAt: old }); bucket.objects.set(imageKey(id), { bytes: png, contentType: 'image/png' });
  }
  failReceiptAudit(database, "json_extract(NEW.after_data,'$.state')='deleting'");
  await assert.rejects(maintainSystemReceipts(database.asD1(), bucket.asR2()), /receipt audit unavailable/);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM receipts WHERE state='active'").get()?.n, 2);
  assert.equal(receiptEvents(database).length, 0); assert.equal(bucket.deleteCalls.length, 0); assert.equal(bucket.objects.size, 2);
});

test('global sweep cannot race a slow pending object put', async () => {
  const { database, bucket } = await storage();
  bucket.beforePut = async () => {
    assert.deepEqual(await maintainSystemReceipts(database.asD1(), bucket.asR2(), { now: Date.now() + 3 * RECEIPT_LIMITS.orphanAgeMs }), { marked: 0, deleted: 0, failed: 0 });
    assert.equal(database.sqlite.prepare('SELECT state FROM receipts').get()?.state, 'pending');
  };
  const id = await upload(database, bucket);
  assert.equal(receiptEvents(database, id).length, 2); assert.ok(bucket.objects.has(imageKey(id)));
});
