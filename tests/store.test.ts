import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import type { Trip } from '../lib/model';
import type { ActivityEvent } from '../lib/store';

// Execute the real store SQL in SQLite. Only the Worker binding and background
// notification delivery are replaced; authorization, CAS, diffs and batches are real.
class SQLiteStatement {
  private values: (string | number | null)[] = [];
  constructor(private readonly sqlite: DatabaseSync, readonly sql: string) {}
  bind(...values: (string | number | null)[]) { this.values = values; return this; }
  async first<T>() { return (this.sqlite.prepare(this.sql).get(...this.values) || null) as T | null; }
  async all<T>() { return { results: this.sqlite.prepare(this.sql).all(...this.values) as T[] }; }
  runSync() {
    const statement = this.sqlite.prepare(this.sql);
    let results: unknown[] = [];
    if (statement.columns().length) results = statement.all(...this.values);
    else statement.run(...this.values);
    return { results, meta: { changes: Number(this.sqlite.prepare('SELECT changes() AS changes').get()?.changes || 0) }, success: true };
  }
  async run() { return this.runSync(); }
}
class SQLiteD1 {
  readonly sqlite = new DatabaseSync(':memory:');
  beforeWriteBatch?: () => void;
  private pending: Promise<unknown> = Promise.resolve();
  prepare(sql: string) { return new SQLiteStatement(this.sqlite, sql); }
  batch(statements: SQLiteStatement[]) {
    const operation = this.pending.then(() => {
      if (statements.some(statement => /^UPDATE sync_state/.test(statement.sql.trim()))) {
        const hook = this.beforeWriteBatch;
        this.beforeWriteBatch = undefined;
        hook?.();
      }
      this.sqlite.exec('BEGIN');
      try {
        const results = statements.map(statement => statement.runSync());
        this.sqlite.exec('COMMIT');
        return results;
      } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  asD1() { return this as unknown as D1Database; }
}

const binding: { DB?: D1Database } = {};
const notifications: unknown[][] = [];
Object.defineProperty(globalThis, Symbol.for('triptab.store-test-env'), { value: binding, configurable: true });
Object.defineProperty(globalThis, Symbol.for('triptab.store-test-notifications'), { value: notifications, configurable: true });
const envUrl = 'data:text/javascript;base64,' + Buffer.from("export const env=globalThis[Symbol.for('triptab.store-test-env')]; export const waitUntil=()=>{};").toString('base64');
const notificationStoreUrl = 'data:text/javascript;base64,' + Buffer.from("export const db=()=>{throw new Error('Notification transport must be mocked');}; export class RequestError extends Error {}").toString('base64');
const notificationSource = transpileModule(await readFile(new URL('../lib/notifications.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText
  .replace("'cloudflare:workers'", JSON.stringify(envUrl)).replace("'./store'", JSON.stringify(notificationStoreUrl));
const notificationFormatterUrl = 'data:text/javascript;base64,' + Buffer.from(notificationSource).toString('base64');
const notificationUrl = 'data:text/javascript;base64,' + Buffer.from(`export {activityNotification} from ${JSON.stringify(notificationFormatterUrl)}; export const notifyMembers=async(...args)=>{globalThis[Symbol.for('triptab.store-test-notifications')].push(args);};`).toString('base64');
const source = await readFile(new URL('../lib/store.ts', import.meta.url), 'utf8');
const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText
  .replace("'zod'", JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('zod').replace(/\.cjs$/, '.js')).href))
  .replace("'cloudflare:workers'", JSON.stringify(envUrl))
  .replace("'./model'", JSON.stringify(new URL('../lib/model.ts', import.meta.url).href))
  .replace("'./auth'", JSON.stringify(new URL('../lib/auth.ts', import.meta.url).href))
  .replace("'./receipt-lifecycle'", JSON.stringify(new URL('../lib/receipt-lifecycle.ts', import.meta.url).href))
  .replace("'./notifications'", JSON.stringify(notificationUrl));
const storeUrl = 'data:text/javascript;base64,' + Buffer.from(compiled).toString('base64');
const store = await import(storeUrl) as typeof import('../lib/store');

const actor = 'owner-1';
const member = 'member-2';
function trip(id = 'trip-1'): Trip {
  return { id, name: 'Lisbon', currency: 'GBP', members: [{ id: 'a', name: 'Owner' }, { id: 'b', name: 'Bob' }], expenses: [], payments: [], drafts: [] };
}
function dinner() {
  return { id: 'dinner', title: 'Dinner', currency: 'GBP' as const, payer: 'a', date: '2026-10-04', time: '20:30', timezone: 'Europe/Lisbon', items: [{ id: 'food', name: 'Dinner', amount: 12345, members: ['a', 'b'] }], tax: 0, tip: 0, discount: 0 };
}
async function storage() {
  const database = new SQLiteD1();
  for (const file of (await readdir(new URL('../drizzle/', import.meta.url))).filter(file => file.endsWith('.sql')).sort()) {
    database.sqlite.exec(await readFile(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'));
  }
  database.sqlite.prepare('INSERT INTO profiles (id,email,display_name,created_at) VALUES (?,?,?,?)').run(actor, 'owner@example.com', 'Original Owner', '2026-10-04T00:00:00Z');
  database.sqlite.prepare('INSERT INTO profiles (id,email,display_name,created_at) VALUES (?,?,?,?)').run(member, 'member@example.com', 'Bob', '2026-10-04T00:00:00Z');
  binding.DB = database.asD1();
  notifications.length = 0;
  return database;
}
function count(database: SQLiteD1) { return database.sqlite.prepare('SELECT COUNT(*) AS count FROM activity_events').get()?.count as number; }
async function create(database: SQLiteD1, holiday = trip()) {
  await store.writeLedger(actor, { trips: [holiday] }, 0);
  assert.equal(database.sqlite.prepare('SELECT revision FROM sync_state WHERE id=1').get()?.revision, 1);
  return store.readLedger(actor);
}
async function history(user = actor, id = 'trip-1') { return (await store.readActivity(user, id, { limit: 50 })).events; }
function lastEntity(events: ActivityEvent[], type: string, id: string) { return events.find(event => event.entityType === type && event.entityId === id)!; }
async function ledgerRoute() {
  const routeSource = await readFile(new URL('../app/api/ledger/route.ts', import.meta.url), 'utf8');
  const routeCompiled = transpileModule(routeSource, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText
    .replace("'@/lib/store'", JSON.stringify(storeUrl))
    .replace("'@/lib/ledger-freshness'", JSON.stringify(new URL('../lib/ledger-freshness.ts', import.meta.url).href));
  return import('data:text/javascript;base64,' + Buffer.from(routeCompiled).toString('base64')) as Promise<{ POST(request: Request): Promise<Response> }>;
}
function saveRequest(data: unknown, revision: number) {
  return new Request('https://triptab.test/api/ledger', {
    method: 'POST',
    headers: { 'oai-authenticated-user-id': actor, 'oai-authenticated-user-email': 'owner@example.com', 'oai-authenticated-user-full-name': 'Original%20Owner', origin: 'https://triptab.test', 'content-type': 'application/json' },
    body: JSON.stringify({ data, revision }),
  });
}

function seedLegacy(database: SQLiteD1) {
  const holiday = trip('legacy-trip');
  holiday.ownerId = actor;
  holiday.members = [
    { id: 'a', name: 'Original Owner', userId: actor, email: 'owner@example.com' },
    { id: 'b', name: ' original owner ' },
  ];
  holiday.expenses = [
    { ...dinner(), id: 'legacy-zero', bankAmount: 0 },
    { ...dinner(), id: 'legacy-same-currency', bankAmount: 100 },
  ];
  holiday.drafts = [{ ...dinner(), id: 'legacy-draft', status: 'review', bankAmount: 0 }];
  database.sqlite.prepare('INSERT INTO trips (id,owner,data) VALUES (?,?,?)').run(holiday.id, actor, JSON.stringify(holiday));
  database.sqlite.prepare('INSERT INTO memberships (trip_id,user_id,member_id) VALUES (?,?,?)').run(holiday.id, actor, 'a');
  return holiday;
}

test('activity migration preserves populated ledgers, trips, memberships and receipt metadata', async () => {
  const database = new SQLiteD1();
  for (const name of ['0000_charming_zeigeist.sql', '0001_regular_maginty.sql', '0002_windy_cammi.sql']) database.sqlite.exec(await readFile(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'));
  database.sqlite.prepare('INSERT INTO ledgers (owner,revision,data) VALUES (?,?,?)').run(actor, 42, '{"legacy":true}');
  database.sqlite.prepare('INSERT INTO trips (id,owner,data) VALUES (?,?,?)').run('saved', actor, JSON.stringify(trip('saved')));
  database.sqlite.prepare('INSERT INTO memberships (trip_id,user_id,member_id) VALUES (?,?,?)').run('saved', actor, 'a');
  database.sqlite.prepare('INSERT INTO receipts (id,owner,trip_id) VALUES (?,?,?)').run('original-photo', actor, 'saved');
  database.sqlite.exec(await readFile(new URL('../drizzle/0003_rainy_blazing_skull.sql', import.meta.url), 'utf8'));
  assert.equal(database.sqlite.prepare('SELECT revision FROM ledgers').get()?.revision, 42);
  assert.equal(database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get('saved')?.data, JSON.stringify(trip('saved')));
  assert.equal(database.sqlite.prepare('SELECT member_id FROM memberships').get()?.member_id, 'a');
  assert.equal(database.sqlite.prepare('SELECT id FROM receipts').get()?.id, 'original-photo');
  assert.equal(count(database), 0, 'the migration must not invent prior authorship');
});

test('creating a trip logs server actor/time, sanitized ownership and one event per initial entity', async () => {
  const database = await storage();
  const holiday = trip();
  holiday.ownerId = 'forged-owner';
  holiday.members[0].userId = 'forged-user';
  holiday.members[0].email = 'forged@example.com';
  holiday.expenses.push(dinner());
  await create(database, holiday);
  const events = await history();
  assert.equal(events.length, 4);
  assert.deepEqual(events.map(event => event.entityType).sort(), ['expense', 'member', 'member', 'trip']);
  for (const event of events) {
    assert.equal(event.actorId, actor);
    assert.equal(event.actorName, 'Original Owner');
    assert.equal(event.source, 'web');
    assert.equal(event.revision, 1);
    assert.equal(event.action, 'create');
    assert.equal(event.before, null);
    assert.ok(Number.isFinite(Date.parse(event.createdAt)));
  }
  assert.equal(lastEntity(events, 'trip', holiday.id).after?.ownerId, actor);
  const ownerMember = lastEntity(events, 'member', 'a');
  assert.equal(ownerMember.after?.userId, actor);
  assert.equal(ownerMember.after?.email, 'owner@example.com');
  assert.equal(ownerMember.after?.name, 'Original Owner');
});

test('expense, payment and draft creation/edit/deletion each have precise before/after snapshots', async () => {
  const database = await storage();
  let state = await create(database);
  const initial = count(database);
  state.data.trips[0].expenses.push(dinner());
  state.data.trips[0].payments.push({ id: 'payment-1', from: 'b', to: 'a', amount: 1000, date: '2026-10-04' });
  state.data.trips[0].drafts.push({ ...dinner(), id: 'draft-1', status: 'review' });
  state = await store.writeLedger(actor, state.data, state.revision);
  assert.equal(count(database), initial + 3);
  const oldExpense = structuredClone(state.data.trips[0].expenses[0]);
  state.data.trips[0].expenses[0].items[0].amount = 15000;
  state.data.trips[0].payments[0].amount = 600;
  state.data.trips[0].drafts[0].title = 'Check the tip';
  state = await store.writeLedger(actor, state.data, state.revision, { source: 'chatgpt' });
  assert.equal(count(database), initial + 6);
  let events = await history();
  assert.deepEqual(lastEntity(events, 'expense', 'dinner').before, oldExpense);
  assert.equal((lastEntity(events, 'expense', 'dinner').after?.items as { amount: number }[])[0].amount, 15000);
  assert.equal(lastEntity(events, 'payment', 'payment-1').before?.amount, 1000);
  assert.equal(lastEntity(events, 'payment', 'payment-1').after?.amount, 600);
  assert.equal(lastEntity(events, 'draft', 'draft-1').source, 'chatgpt');
  state.data.trips[0].expenses = [];
  state.data.trips[0].payments = [];
  state.data.trips[0].drafts = [];
  await store.writeLedger(actor, state.data, state.revision);
  assert.equal(count(database), initial + 9);
  events = await history();
  for (const [type, id] of [['expense', 'dinner'], ['payment', 'payment-1'], ['draft', 'draft-1']]) {
    const event = lastEntity(events, type, id);
    assert.equal(event.action, 'delete');
    assert.ok(event.before);
    assert.equal(event.after, null);
  }
});

test('deleted record can be explicitly restored with original snapshot and both events remain', async () => {
  const database = await storage();
  const holiday = trip(); holiday.expenses = [dinner()];
  let state = await create(database, holiday);
  const original = state.data.trips[0].expenses[0];
  state.data.trips[0].expenses = [];
  state = await store.writeLedger(actor, state.data, state.revision);
  state.data.trips[0].expenses = [original];
  await store.writeLedger(actor, state.data, state.revision);
  const events = (await history()).filter(event => event.entityType === 'expense');
  assert.deepEqual(events.map(event => event.action), ['create', 'delete', 'create']);
  assert.deepEqual(events[0].after, events[1].before);
});

test('unchanged resaves and omitted trips create no false history', async () => {
  const database = await storage();
  let state = await create(database);
  const initial = count(database);
  state = await store.writeLedger(actor, structuredClone(state.data), state.revision);
  assert.equal(count(database), initial);
  await store.writeLedger(actor, { trips: [] }, state.revision);
  assert.equal(count(database), initial);
  assert.equal((await store.readLedger(actor)).data.trips.length, 1);
});

test('unauthorized actor, forged linked metadata and foreign receipts cannot create misleading events', async () => {
  const database = await storage();
  const state = await create(database);
  const initial = count(database);
  await assert.rejects(store.writeLedger('outsider', state.data, state.revision), (error: unknown) => error instanceof store.RequestError && error.status === 403);
  assert.equal(count(database), initial);
  state.data.trips[0].members[0].userId = 'spoofed';
  state.data.trips[0].members[0].email = 'spoofed@example.com';
  const saved = await store.writeLedger(actor, state.data, state.revision);
  assert.equal(count(database), initial);
  assert.equal(saved.data.trips[0].members[0].userId, actor);
  assert.equal(saved.data.trips[0].members[0].email, 'owner@example.com');
  saved.data.trips[0].expenses.push({ ...dinner(), receiptId: 'foreign-photo' });
  await assert.rejects(store.writeLedger(actor, saved.data, saved.revision), /does not belong/);
  assert.equal(count(database), initial);
});

test('stale or competing saves have exactly one winner and no loser events', async () => {
  const database = await storage();
  const state = await create(database);
  const initial = count(database);
  const first = structuredClone(state.data), second = structuredClone(state.data);
  first.trips[0].expenses.push(dinner());
  second.trips[0].payments.push({ id: 'p2', from: 'b', to: 'a', amount: 500, date: '2026-10-04' });
  const results = await Promise.allSettled([store.writeLedger(actor, first, state.revision), store.writeLedger(actor, second, state.revision)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.match(rejected.reason.message, /CONFLICT/);
  assert.equal(count(database), initial + 1);
  const current = await store.readLedger(actor);
  assert.equal(current.revision, 2);
  assert.equal(current.data.trips[0].expenses.length + current.data.trips[0].payments.length, 1);
  await assert.rejects(store.writeLedger(actor, first, state.revision), /CONFLICT/);
  assert.equal(count(database), initial + 1);
});

test('identity linking or membership removal between validation and CAS produces no records or events', async () => {
  const database = await storage();
  await create(database);
  database.sqlite.prepare('INSERT INTO memberships (trip_id,user_id,member_id) VALUES (?,?,?)').run('trip-1', member, 'b');
  const state = await store.readLedger(member);
  const initial = count(database);
  state.data.trips[0].expenses.push(dinner());
  database.beforeWriteBatch = () => { database.sqlite.prepare('DELETE FROM memberships WHERE user_id=?').run(member); };
  await assert.rejects(store.writeLedger(member, state.data, state.revision), /CONFLICT/);
  assert.equal(count(database), initial);
  assert.equal((await store.readLedger(actor)).data.trips[0].expenses.length, 0);
  database.beforeWriteBatch = () => { database.sqlite.prepare('INSERT INTO auth_links (oai_user_id,user_id,created_at) VALUES (?,?,?)').run(actor, member, new Date().toISOString()); };
  await assert.rejects(store.writeLedger(actor, state.data, state.revision), /CONFLICT/);
  assert.equal(count(database), initial);
});

test('activity insert failure rolls back live trip data and revision in the same transaction', async () => {
  const database = await storage();
  const state = await create(database);
  const before = database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get('trip-1')?.data;
  const initial = count(database);
  database.sqlite.exec("CREATE TRIGGER refuse_new_activity BEFORE INSERT ON activity_events BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;");
  state.data.trips[0].expenses.push(dinner());
  await assert.rejects(store.writeLedger(actor, state.data, state.revision), /simulated disk failure/);
  assert.equal(database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get('trip-1')?.data, before);
  assert.equal(database.sqlite.prepare('SELECT revision FROM sync_state WHERE id=1').get()?.revision, state.revision);
  assert.equal(count(database), initial);
});

test('large receipt edits and many creation events remain atomic with complete snapshots', async () => {
  const database = await storage();
  const holiday = trip();
  holiday.members = Array.from({ length: 50 }, (_, index) => ({ id: `traveller-${index}-${'x'.repeat(40)}`, name: `Traveller ${index}` }));
  const items = Array.from({ length: 200 }, (_, index) => ({ id: `item-${index}`, name: 'Dinner line', amount: 1000, members: holiday.members.map(person => person.id) }));
  holiday.expenses = ['large-1', 'large-2'].map(id => ({ ...dinner(), id, payer: holiday.members[0].id, items: structuredClone(items) }));
  let state = await create(database, holiday);
  assert.equal(count(database), 53);
  state.data.trips[0].expenses[0].tip = 1;
  state.data.trips[0].expenses[1].tip = 2;
  state = await store.writeLedger(actor, state.data, state.revision);
  assert.equal(count(database), 55);
  const updates = (await history()).filter(event => event.revision === state.revision);
  assert.equal(updates.length, 2);
  for (const update of updates) {
    assert.equal((update.before?.items as unknown[]).length, 200);
    assert.equal((update.after?.items as unknown[]).length, 200);
    assert.equal(update.before?.tip, 0);
    assert.deepEqual(update.after, state.data.trips[0].expenses.find(expense => expense.id === update.entityId));
  }
});

test('notifications describe committed actors/events and skip draft-only saves and failed writes', async () => {
  const database = await storage();
  let state = await create(database);
  state.data.trips[0].drafts.push({ ...dinner(), id: 'draft-1', status: 'review' });
  state = await store.writeLedger(actor, state.data, state.revision, { source: 'chatgpt' });
  assert.equal(notifications.length, 0);
  state.data.trips[0].expenses.push(dinner());
  state = await store.writeLedger(actor, state.data, state.revision);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0][2], 'TripTab activity');
  assert.match(String(notifications[0][3]), /Original Owner added an expense/);
  assert.doesNotMatch(String(notifications[0][2]), /Lisbon/);
  state.data.trips[0].expenses.push({ ...dinner(), id: 'second' }, { ...dinner(), id: 'third' });
  state = await store.writeLedger(actor, state.data, state.revision);
  assert.match(String(notifications[1][3]), /Original Owner added 2 expenses/);
  state.data.trips[0].expenses = state.data.trips[0].expenses.filter(expense => expense.id === 'dinner');
  state = await store.writeLedger(actor, state.data, state.revision);
  assert.match(String(notifications[2][3]), /Original Owner removed 2 expenses/);
  await assert.rejects(store.writeLedger(actor, state.data, state.revision - 1), /CONFLICT/);
  assert.equal(notifications.length, 3);
});

test('history is immutable in SQLite and paginated without duplication as newer events arrive', async () => {
  const database = await storage();
  let state = await create(database);
  assert.throws(() => database.sqlite.exec("UPDATE activity_events SET actor_id='forged'"), /append-only/);
  assert.throws(() => database.sqlite.exec('DELETE FROM activity_events'), /append-only/);
  const first = await store.readActivity(actor, 'trip-1', { limit: 2 });
  assert.equal(first.events.length, 2); assert.ok(first.nextCursor);
  state.data.trips[0].expenses.push(dinner());
  state = await store.writeLedger(actor, state.data, state.revision);
  const older = await store.readActivity(actor, 'trip-1', { limit: 2, before: first.nextCursor! });
  assert.equal(older.events.length, 1); assert.equal(older.nextCursor, null);
  assert.equal(new Set([...first.events, ...older.events].map(event => event.id)).size, 3);
  assert.equal((await history()).length, 4);
  await assert.rejects(store.readActivity('outsider', 'trip-1'), (error: unknown) => error instanceof store.RequestError && error.status === 403);
  for (const options of [{ limit: 0 }, { limit: 51 }, { before: -1 }, { before: Number.MAX_SAFE_INTEGER + 1 }]) await assert.rejects(store.readActivity(actor, 'trip-1', options));
  assert.equal(state.revision, 2);
});

test('activity endpoint requires auth/membership and validates bounded, unambiguous pagination', async context => {
  context.mock.method(console, 'error', () => {});
  const database = await storage();
  await create(database);
  const routeSource = await readFile(new URL('../app/api/activity/route.ts', import.meta.url), 'utf8');
  const routeCompiled = transpileModule(routeSource, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText.replace("'@/lib/store'", JSON.stringify(storeUrl));
  const route = await import('data:text/javascript;base64,' + Buffer.from(routeCompiled).toString('base64')) as { GET(request: Request): Promise<Response> };
  const headers = { 'oai-authenticated-user-id': actor, 'oai-authenticated-user-email': 'owner@example.com', 'oai-authenticated-user-full-name': 'Original%20Owner' };
  const request = (query: string, authenticated = true) => new Request(`https://triptab.test/api/activity?${query}`, { headers: authenticated ? headers : {} });
  assert.equal((await route.GET(request('tripId=trip-1', false))).status, 401);
  const response = await route.GET(request('tripId=trip-1&limit=2'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal((await response.json() as { events: unknown[] }).events.length, 2);
  for (const query of ['tripId=trip-1&limit=51', 'tripId=trip-1&limit=0', 'tripId=trip-1&before=1.5', 'tripId=trip-1&before=1&before=2', 'tripId=trip-1&tripId=other', 'tripId=trip-1&limit=1e2', '']) assert.equal((await route.GET(request(query))).status, 400, query);
  const outsider = new Request('https://triptab.test/api/activity?tripId=trip-1', { headers: { ...headers, 'oai-authenticated-user-id': 'outsider' } });
  assert.equal((await route.GET(outsider)).status, 403);
});

test('ledger HTTP saves log trusted actors and reject unauthenticated, cross-origin and stale writes', async context => {
  context.mock.method(console, 'error', () => {});
  const database = await storage();
  const routeSource = await readFile(new URL('../app/api/ledger/route.ts', import.meta.url), 'utf8');
  const routeCompiled = transpileModule(routeSource, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText
    .replace("'@/lib/store'", JSON.stringify(storeUrl))
    .replace("'@/lib/ledger-freshness'", JSON.stringify(new URL('../lib/ledger-freshness.ts', import.meta.url).href));
  const route = await import('data:text/javascript;base64,' + Buffer.from(routeCompiled).toString('base64')) as { POST(request: Request): Promise<Response> };
  const headers = { 'oai-authenticated-user-id': actor, 'oai-authenticated-user-email': 'owner@example.com', 'oai-authenticated-user-full-name': 'Original%20Owner' };
  const body = JSON.stringify({ data: { trips: [trip()] }, revision: 0, actorId: 'forged', actorName: 'Forged', source: 'chatgpt' });
  const request = (authenticated = true, origin = 'https://triptab.test') => new Request('https://triptab.test/api/ledger', { method: 'POST', headers: { ...(authenticated ? headers : {}), origin, 'content-type': 'application/json' }, body });
  assert.equal((await route.POST(request(false))).status, 401);
  assert.ok((await route.POST(request(true, 'https://evil.test'))).status >= 400);
  assert.equal(count(database), 0);
  const saved = await route.POST(request());
  assert.equal(saved.status, 200);
  assert.equal(saved.headers.get('cache-control'), 'private, no-store');
  const initial = count(database);
  for (const event of await history()) { assert.equal(event.actorId, actor); assert.equal(event.actorName, 'Original Owner'); assert.equal(event.source, 'web'); }
  assert.equal((await route.POST(request())).status, 409);
  assert.equal(count(database), initial);
});

test('ledger validation reports the first field and does not echo arbitrary enum values or log request bodies', async context => {
  const errors = context.mock.method(console, 'error', () => {});
  await storage();
  const holiday = { ...trip(), currency: 'SENSITIVE-INPUT-VALUE' };
  let error: unknown;
  try { await store.writeLedger(actor, { trips: [holiday] }, 0); } catch (caught) { error = caught; }
  const response = store.failure(error);
  assert.equal(response.status, 400);
  const body = await response.json() as { error: string };
  assert.match(body.error, /trips → 1 → currency/);
  assert.match(body.error, /supported value/);
  assert.doesNotMatch(body.error, /SENSITIVE-INPUT-VALUE/);
  assert.equal(errors.mock.callCount(), 0);
});

test('ledger HTTP business validation returns actionable errors without committing data or logging submitted values', async context => {
  const errors = context.mock.method(console, 'error', () => {});
  const route = await ledgerRoute();
  const cases: { name: string; change(holiday: Trip): void; message: RegExp }[] = [
    { name: 'same-currency bank charge', change: holiday => { holiday.expenses[0].bankAmount = 100; }, message: /Remove the bank charge.*currencies are the same/ },
    { name: 'zero receipt total', change: holiday => { holiday.expenses[0].discount = 12345; }, message: /Receipt total must be greater than zero/ },
    { name: 'missing foreign exchange', change: holiday => { holiday.expenses[0].currency = 'EUR'; }, message: /Add an exchange rate or the actual bank charge/ },
    { name: 'discount exceeds receipt', change: holiday => { holiday.expenses[0].discount = 12346; }, message: /Discount exceeds total/ },
    { name: 'absurd converted amount', change: holiday => {
      holiday.expenses[0].currency = 'EUR';
      holiday.expenses[0].fx = { rate: 1e20, asOf: '2026-10-04', source: 'manual' };
    }, message: /Converted amount is out of range.*Check the exchange rate/ },
    { name: 'converted amount above the supported money limit', change: holiday => {
      holiday.expenses[0].currency = 'EUR';
      holiday.expenses[0].fx = { rate: 10000, asOf: '2026-10-04', source: 'manual' };
    }, message: /Converted amount is out of range.*maximum 1,000,000 settlement currency units/ },
    { name: 'duplicate traveller name', change: holiday => { holiday.members[1].name = ' original owner '; }, message: /Traveller names must be unique.*surname or nickname/ },
  ];
  for (const scenario of cases) await context.test(scenario.name, async () => {
    const database = await storage();
    const state = await create(database);
    const initialEvents = count(database);
    const original = database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get('trip-1')?.data;
    state.data.trips[0].expenses.push(dinner());
    scenario.change(state.data.trips[0]);
    const response = await route.POST(saveRequest(state.data, state.revision));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.match((await response.json() as { error: string }).error, scenario.message);
    assert.equal(database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get('trip-1')?.data, original);
    assert.equal(database.sqlite.prepare('SELECT revision FROM sync_state WHERE id=1').get()?.revision, state.revision);
    assert.equal(count(database), initialEvents);
  });
  assert.equal(errors.mock.callCount(), 0);
});

test('ledger HTTP unexpected SQLite failure remains generic and rolls back all financial and audit effects', async context => {
  const errors = context.mock.method(console, 'error', () => {});
  const database = await storage();
  const state = await create(database);
  const initialEvents = count(database);
  const original = database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get('trip-1')?.data;
  database.sqlite.exec("CREATE TRIGGER refuse_trip_update BEFORE UPDATE ON trips BEGIN SELECT RAISE(ABORT, 'PRIVATE_DATABASE_CONFIGURATION'); END;");
  state.data.trips[0].expenses.push(dinner());
  const response = await (await ledgerRoute()).POST(saveRequest(state.data, state.revision));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Unable to complete this request. Check your entries and try again.' });
  assert.equal(errors.mock.callCount(), 1);
  assert.doesNotMatch(JSON.stringify(errors.mock.calls[0].arguments), /PRIVATE_DATABASE_CONFIGURATION/);
  assert.equal(database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get('trip-1')?.data, original);
  assert.equal(database.sqlite.prepare('SELECT revision FROM sync_state WHERE id=1').get()?.revision, state.revision);
  assert.equal(count(database), initialEvents);
});

test('unchanged historical invalid bank charges/names do not block unrelated trip saves or alter legacy money', async () => {
  const database = await storage();
  const legacy = seedLegacy(database);
  let state = await store.readLedger(actor);
  state.data.trips.push(trip('clean-trip'));
  state = await store.writeLedger(actor, state.data, state.revision);
  assert.deepEqual(state.data.trips.find(holiday => holiday.id === legacy.id), legacy);
  assert.equal((await history(actor, legacy.id)).length, 0, 'unchanged historical data must not acquire fake edits/authorship');
  assert.equal(count(database), 3);
  state.data.trips.find(holiday => holiday.id === 'clean-trip')!.expenses.push(dinner());
  state = await store.writeLedger(actor, state.data, state.revision);
  assert.deepEqual(state.data.trips.find(holiday => holiday.id === legacy.id), legacy);
  assert.equal(count(database), 4);
  assert.equal((await history(actor, legacy.id)).length, 0);
});

test('explicit legacy financial/name repairs validate new values and retain exact old audit snapshots', async () => {
  const database = await storage();
  const legacy = seedLegacy(database);
  const state = await store.readLedger(actor);
  const repair = state.data.trips[0];
  repair.members[1].name = 'Bob';
  repair.expenses.forEach(expense => { delete expense.bankAmount; });
  delete repair.drafts[0].bankAmount;
  const saved = await store.writeLedger(actor, state.data, state.revision);
  assert.equal(saved.data.trips[0].expenses[0].bankAmount, undefined);
  assert.equal(saved.data.trips[0].drafts[0].bankAmount, undefined);
  assert.equal(saved.data.trips[0].members[1].name, 'Bob');
  const events = await history(actor, legacy.id);
  assert.equal(events.length, 4);
  assert.equal(lastEntity(events, 'expense', 'legacy-zero').before?.bankAmount, 0);
  assert.equal(lastEntity(events, 'expense', 'legacy-same-currency').before?.bankAmount, 100);
  assert.equal(lastEntity(events, 'draft', 'legacy-draft').before?.bankAmount, 0);
  assert.equal(lastEntity(events, 'member', 'b').before?.name, ' original owner ');
  assert.equal(lastEntity(events, 'member', 'b').after?.name, 'Bob');
});

test('legacy compatibility cannot authorize changed, copied or newly introduced invalid financial entries', async () => {
  const database = await storage();
  const legacy = seedLegacy(database);
  const state = await store.readLedger(actor);
  const original = database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get(legacy.id)?.data;
  const changed = structuredClone(state.data);
  changed.trips[0].expenses[0].title = 'Changed invalid receipt';
  await assert.rejects(store.writeLedger(actor, changed, state.revision));
  const added = structuredClone(state.data);
  added.trips[0].expenses.push({ ...dinner(), id: 'new-invalid', bankAmount: 0 });
  await assert.rejects(store.writeLedger(actor, added, state.revision));
  const moved = structuredClone(state.data);
  const other = trip('other-trip');
  other.expenses = [structuredClone(legacy.expenses[0])];
  moved.trips.push(other);
  await assert.rejects(store.writeLedger(actor, moved, state.revision));
  assert.equal(database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get(legacy.id)?.data, original);
  assert.equal(count(database), 0);
  assert.equal((await store.readLedger(actor)).revision, 0);
});
