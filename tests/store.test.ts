import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { parseLedgerStructure, type Trip } from '../lib/model';
import type { ActivityEvent } from '../lib/store';
import { receiptMemorySchema } from '../lib/receipt-context';
import { ledgerEtag, ledgerEtagForSnapshot, readLedgerFreshness } from '../lib/ledger-freshness';
import { Log, LogLevel, Miniflare } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';

// Execute the real store SQL in SQLite. Only the Worker binding and background
// notification delivery are replaced; authorization, CAS, diffs and batches are real.
class SQLiteStatement {
  private values: (string | number | null)[] = [];
  constructor(private readonly sqlite: DatabaseSync, readonly sql: string) {}
  bind(...values: (string | number | null)[]) { this.values = values; return this; }
  get bindingBytes() { return this.values.map(value => typeof value === 'string' ? Buffer.byteLength(value) : 0); }
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
  beforeBatch?: (statements: SQLiteStatement[]) => void;
  private pending: Promise<unknown> = Promise.resolve();
  prepare(sql: string) { return new SQLiteStatement(this.sqlite, sql); }
  batch(statements: SQLiteStatement[]) {
    const operation = this.pending.then(() => {
      this.beforeBatch?.(statements);
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
const notificationSource = transpileModule(await readFile(new URL('../lib/notifications.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText.replaceAll("'./data-utils'", JSON.stringify(new URL('../lib/data-utils.ts', import.meta.url).href)).replaceAll("'./receipt-ai-config'", JSON.stringify(new URL('../lib/receipt-ai-config.ts', import.meta.url).href)).replaceAll("'@/lib/data-utils'", JSON.stringify(new URL('../lib/data-utils.ts', import.meta.url).href)).replaceAll("'@/lib/receipt-ai-config'", JSON.stringify(new URL('../lib/receipt-ai-config.ts', import.meta.url).href))
  .replace("'cloudflare:workers'", JSON.stringify(envUrl)).replace("'./store'", JSON.stringify(notificationStoreUrl))
  .replaceAll("'./audit'", JSON.stringify(new URL('../lib/audit.ts', import.meta.url).href));
const notificationFormatterUrl = 'data:text/javascript;base64,' + Buffer.from(notificationSource).toString('base64');
const notificationUrl = 'data:text/javascript;base64,' + Buffer.from(`export {activityNotification} from ${JSON.stringify(notificationFormatterUrl)}; export const notifyMembers=async(...args)=>{globalThis[Symbol.for('triptab.store-test-notifications')].push(args);};`).toString('base64');
const source = await readFile(new URL('../lib/store.ts', import.meta.url), 'utf8');
const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText.replaceAll("'./data-utils'", JSON.stringify(new URL('../lib/data-utils.ts', import.meta.url).href)).replaceAll("'./receipt-ai-config'", JSON.stringify(new URL('../lib/receipt-ai-config.ts', import.meta.url).href)).replaceAll("'@/lib/data-utils'", JSON.stringify(new URL('../lib/data-utils.ts', import.meta.url).href)).replaceAll("'@/lib/receipt-ai-config'", JSON.stringify(new URL('../lib/receipt-ai-config.ts', import.meta.url).href))
  .replace("'zod'", JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('zod').replace(/\.cjs$/, '.js')).href))
  .replace("'cloudflare:workers'", JSON.stringify(envUrl))
  .replace("'./model'", JSON.stringify(new URL('../lib/model.ts', import.meta.url).href))
  .replace("'./auth'", JSON.stringify(new URL('../lib/auth.ts', import.meta.url).href))
  .replace("'./activity-scope'", JSON.stringify(new URL('../lib/activity-scope.ts', import.meta.url).href))
  .replace("'./receipt-lifecycle'", JSON.stringify(new URL('../lib/receipt-lifecycle.ts', import.meta.url).href))
  .replaceAll("'./audit'", JSON.stringify(new URL('../lib/audit.ts', import.meta.url).href))
  .replace("'./receipt-context'", JSON.stringify(new URL('../lib/receipt-context.ts', import.meta.url).href))
  .replace("'./receipt-memory-ownership'", JSON.stringify(new URL('../lib/receipt-memory-ownership.ts', import.meta.url).href))
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
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
function nearContentLimit(bytes: number) {
  const expenses = Array.from({ length: 1000 }, (_, index) => ({
    id: `e${index}`, title: 'x', currency: 'GBP' as const, date: '2026-10-04', payer: 'a',
    items: [{ id: 'i', name: 'x', amount: 1, members: ['a'] }], tax: 0, tip: 0, discount: 0,
  }));
  const data = parseLedgerStructure({ trips: Array.from({ length: 7 }, (_, index) => ({ ...trip(`t${index}`),
    members: [{ id: 'a', name: 'Original Owner' }], expenses: structuredClone(expenses),
  })) });
  let remaining = bytes - jsonBytes(data);
  assert.ok(remaining >= 0);
  for (const expense of data.trips.flatMap(holiday => holiday.expenses)) {
    const chocolates = Math.min(98, Math.floor(remaining / 4));
    expense.title += '🍫'.repeat(chocolates); remaining -= chocolates * 4;
    if (remaining < 4) { expense.title += 'x'.repeat(remaining); remaining = 0; }
    if (!remaining) break;
  }
  assert.equal(remaining, 0); assert.equal(jsonBytes(data), bytes);
  return data;
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
  const routeCompiled = transpileModule(routeSource, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText.replaceAll("'./data-utils'", JSON.stringify(new URL('../lib/data-utils.ts', import.meta.url).href)).replaceAll("'./receipt-ai-config'", JSON.stringify(new URL('../lib/receipt-ai-config.ts', import.meta.url).href)).replaceAll("'@/lib/data-utils'", JSON.stringify(new URL('../lib/data-utils.ts', import.meta.url).href)).replaceAll("'@/lib/receipt-ai-config'", JSON.stringify(new URL('../lib/receipt-ai-config.ts', import.meta.url).href))
    .replace("'@/lib/store'", JSON.stringify(storeUrl))
    .replace("'@/lib/ledger-freshness'", JSON.stringify(new URL('../lib/ledger-freshness.ts', import.meta.url).href));
  return import('data:text/javascript;base64,' + Buffer.from(routeCompiled).toString('base64')) as Promise<{ GET(request: Request): Promise<Response>; HEAD(request: Request): Promise<Response>; POST(request: Request): Promise<Response> }>;
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

test('future ledger revisions are rejected before a competing write can make the token current', async () => {
  const database = await storage();
  const holiday = trip(); holiday.expenses = [dinner()];
  const baseline = await create(database, holiday);
  database.sqlite.prepare('INSERT INTO memberships (trip_id,user_id,member_id) VALUES (?,?,?)').run('trip-1', member, 'b');
  const proposed = structuredClone(baseline.data);
  proposed.trips[0].expenses[0].items[0].amount = 33333;
  const competing = structuredClone(baseline.data);
  competing.trips[0].expenses[0].items[0].amount = 22222;
  const originalBatch = database.batch.bind(database);
  let attemptedCommit = false;
  database.batch = async statements => {
    if (!attemptedCommit && statements.some(statement => /^UPDATE sync_state/.test(statement.sql.trim()))) {
      attemptedCommit = true;
      await store.writeLedger(member, competing, baseline.revision);
    }
    return originalBatch(statements);
  };
  const initialEvents = count(database);
  await assert.rejects(store.writeLedger(actor, proposed, baseline.revision + 1), /CONFLICT/);
  assert.equal(attemptedCommit, false, 'a future token must fail at the consistent baseline read');
  assert.equal(count(database), initialEvents);
  assert.equal((await store.readLedger(actor)).data.trips[0].expenses[0].items[0].amount, 12345);
  // A normal competing commit and fresh edit retain an exact predecessor chain.
  database.batch = originalBatch;
  const winner = await store.writeLedger(member, competing, baseline.revision);
  const saved = await store.writeLedger(actor, proposed, winner.revision);
  const events = (await history()).filter(event => event.entityType === 'expense');
  assert.equal((events[0].before?.items as { amount: number }[])[0].amount, 22222);
  assert.equal((events[0].after?.items as { amount: number }[])[0].amount, 33333);
  assert.deepEqual(events[0].before, events[1].after);
  assert.equal(saved.revision, winner.revision + 1);
});

test('ledger CAS verifies compact owner and existence guards without duplicating stored JSON', async context => {
  for (const mutation of ['owner', 'remove', 'new-id'] as const) await context.test(mutation, async () => {
    const database = await storage();
    const holiday = trip(); holiday.expenses = [dinner()];
    const state = await create(database, holiday);
    const proposed = structuredClone(state.data);
    proposed.trips[0].expenses[0].items[0].amount = 33333;
    if (mutation === 'new-id') proposed.trips.push(trip('new-trip'));
    const initialEvents = count(database);
    database.beforeWriteBatch = () => {
      if (mutation === 'owner') {
        database.sqlite.prepare('UPDATE trips SET owner=? WHERE id=?').run(member, 'trip-1');
      } else if (mutation === 'remove') {
        database.sqlite.prepare('DELETE FROM trips WHERE id=?').run('trip-1');
      } else {
        const collision = trip('new-trip'); collision.name = 'Previously committed holiday';
        database.sqlite.prepare('INSERT INTO trips (id,owner,data) VALUES (?,?,?)').run(collision.id, actor, JSON.stringify(collision));
      }
    };
    await assert.rejects(store.writeLedger(actor, proposed, state.revision), /CONFLICT/);
    assert.equal(database.sqlite.prepare('SELECT revision FROM sync_state WHERE id=1').get()?.revision, state.revision);
    assert.equal(count(database), initialEvents);
    if (mutation === 'owner') assert.equal(database.sqlite.prepare('SELECT owner FROM trips WHERE id=?').get('trip-1')?.owner, member);
    if (mutation === 'remove') assert.equal(database.sqlite.prepare('SELECT id FROM trips WHERE id=?').get('trip-1'), undefined);
    if (mutation === 'new-id') assert.equal((await store.readLedger(actor)).data.trips.find(value => value.id === 'new-trip')?.name, 'Previously committed holiday');
  });
});

test('an actual trip writer winning after the baseline makes CAS reject the stale before image', async () => {
  const database = await storage();
  const holiday = trip(); holiday.expenses = [dinner()];
  const baseline = await create(database, holiday);
  const competing = structuredClone(baseline.data), proposed = structuredClone(baseline.data);
  competing.trips[0].expenses[0].tip = 2; proposed.trips[0].expenses[0].tip = 1;
  const originalBatch = database.batch.bind(database); let raced = false;
  database.batch = async statements => {
    if (!raced && statements.some(statement => /^UPDATE sync_state/.test(statement.sql.trim()))) {
      raced = true; await store.writeLedger(actor, competing, baseline.revision);
    }
    return originalBatch(statements);
  };
  const initial = count(database);
  await assert.rejects(store.writeLedger(actor, proposed, baseline.revision), /CONFLICT/);
  assert.equal(count(database), initial + 1);
  const saved = await store.readLedger(actor);
  assert.equal(saved.data.trips[0].expenses[0].tip, 2);
  const event = lastEntity(await history(), 'expense', 'dinner');
  assert.equal(event.before?.tip, 0); assert.equal(event.after?.tip, 2);
});

test('fifty-trip saves keep exact before snapshots through the maximum ledger collection', async () => {
  await storage();
  const holidays = Array.from({ length: 50 }, (_, index) => trip(`trip-${index}`));
  let state = await store.writeLedger(actor, { trips: holidays }, 0);
  const previous = structuredClone(state.data);
  state.data.trips.forEach(holiday => { holiday.name += ' updated'; });
  state = await store.writeLedger(actor, state.data, state.revision);
  assert.equal(state.data.trips.length, 50);
  for (const holiday of state.data.trips) {
    const event = lastEntity(await history(actor, holiday.id), 'trip', holiday.id);
    assert.equal(event.before?.name, previous.trips.find(value => value.id === holiday.id)?.name);
    assert.equal(event.after?.name, holiday.name);
    assert.equal(event.revision, state.revision);
  }
});

test('participant reorder-only changes preserve every collection order in immutable history', async () => {
  const database = await storage();
  const holiday = trip();
  holiday.expenses = [dinner(), { ...dinner(), id: 'second-expense' }];
  holiday.payments = ['first-payment', 'second-payment'].map(id => ({ id, from: 'b', to: 'a', amount: 1000, date: '2026-10-04' }));
  holiday.drafts = ['first-draft', 'second-draft'].map(id => ({ ...dinner(), id, status: 'review' }));
  await create(database, holiday);
  database.sqlite.prepare('INSERT INTO memberships (trip_id,user_id,member_id) VALUES (?,?,?)').run('trip-1', member, 'b');
  let state = await store.readLedger(member);
  const baseline = structuredClone(state.data.trips[0]);
  const initialEvents = count(database);
  for (const collection of ['members', 'expenses', 'payments', 'drafts'] as const) state.data.trips[0][collection].reverse();
  state = await store.writeLedger(member, state.data, state.revision);
  assert.equal(count(database), initialEvents + 1, 'unchanged records need only the collection-order event');
  const event = lastEntity(await history(member), 'trip', 'trip-1');
  assert.equal(event.actorId, member); assert.equal(event.actorName, 'Bob');
  for (const [collection, field] of [['members', 'memberOrder'], ['expenses', 'expenseOrder'], ['payments', 'paymentOrder'], ['drafts', 'draftOrder']] as const) {
    assert.deepEqual(event.before?.[field], baseline[collection].map(entry => entry.id));
    assert.deepEqual(event.after?.[field], state.data.trips[0][collection].map(entry => entry.id));
  }
  await store.writeLedger(member, state.data, state.revision);
  assert.equal(count(database), initialEvents + 1, 'an unchanged order resave is not another edit');
});

test('receipt and payment insertion/removal events explain order unless retained entries are reordered', async () => {
  const database = await storage();
  const holiday = trip();
  holiday.expenses = ['e1', 'e2', 'e3'].map(id => ({ ...dinner(), id }));
  holiday.payments = ['p1', 'p2', 'p3'].map(id => ({ id, from: 'b', to: 'a', amount: 1, date: '2026-10-04' }));
  holiday.drafts = ['d1', 'd2', 'd3'].map(id => ({ ...dinner(), id, status: 'waiting' }));
  let state = await create(database, holiday);
  state.data.trips[0].expenses.shift(); state.data.trips[0].payments.shift(); state.data.trips[0].drafts.shift();
  state = await store.writeLedger(actor, state.data, state.revision);
  let events = (await history()).filter(event => event.revision === state.revision);
  assert.deepEqual(events.map(event => event.entityType).sort(), ['draft', 'expense', 'payment']);
  assert.ok(events.every(event => event.action === 'delete'));
  state.data.trips[0].expenses.unshift({ ...dinner(), id: 'new-expense' });
  state.data.trips[0].payments.push({ id: 'new-payment', from: 'b', to: 'a', amount: 1, date: '2026-10-04' });
  state.data.trips[0].drafts.splice(1, 0, { ...dinner(), id: 'new-draft', status: 'waiting' });
  state = await store.writeLedger(actor, state.data, state.revision);
  events = (await history()).filter(event => event.revision === state.revision);
  assert.deepEqual(events.map(event => event.entityType).sort(), ['draft', 'expense', 'payment']);
  assert.ok(events.every(event => event.action === 'create'));
  state.data.trips[0].expenses.shift(); state.data.trips[0].expenses.reverse();
  state = await store.writeLedger(actor, state.data, state.revision);
  events = (await history()).filter(event => event.revision === state.revision);
  assert.deepEqual(events.map(event => event.entityType).sort(), ['expense', 'trip']);
  const reorder = events.find(event => event.entityType === 'trip')!;
  assert.deepEqual(reorder.before?.expenseOrder, ['new-expense', 'e2', 'e3']);
  assert.deepEqual(reorder.after?.expenseOrder, ['e3', 'e2']);
  state.data.trips[0].members.splice(1, 0, { id: 'c', name: 'Carol' });
  state = await store.writeLedger(actor, state.data, state.revision);
  const placement = lastEntity(await history(), 'trip', 'trip-1');
  assert.deepEqual(placement.before?.memberOrder, ['a', 'b']);
  assert.deepEqual(placement.after?.memberOrder, ['a', 'c', 'b']);
});

test('one participant’s financial metadata, units, receipt override, memory and chat edits retain exact snapshots', async () => {
  const database = await storage();
  const holiday = trip(); holiday.expenses = [dinner()];
  holiday.payments = [{ id: 'payment', from: 'b', to: 'a', amount: 1000, date: '2026-10-04' }];
  holiday.drafts = [{ ...dinner(), id: 'draft', status: 'waiting' }];
  await create(database, holiday);
  database.sqlite.prepare('INSERT INTO memberships (trip_id,user_id,member_id) VALUES (?,?,?)').run('trip-1', member, 'b');
  let state = await store.readLedger(member);
  const before = structuredClone(state.data.trips[0]);
  const expense = state.data.trips[0].expenses[0];
  Object.assign(expense, { title: 'Chocolate', currency: 'EUR', payer: 'b', date: '2026-10-03', time: '11:15', timezone: 'Europe/Paris',
    bankAmount: 1100, fx: { rate: 0.85, asOf: '2026-10-02', source: 'manual' }, tax: 30, tip: 10, discount: 5, source: 'manual',
    percentages: { a: 25, b: 75 }, items: [{ id: 'food', name: 'Chocolate', amount: 1001, members: ['a', 'b'], units: { total: 3, allocations: { a: 2.5, b: 0.5 }, label: 'bars' } }],
    memory: { notes: 'Bars are the full line total.', aliases: [{ name: 'choc', itemId: 'food', scopeMemberId: 'b' }] },
    conversation: [{ id: 'question', role: 'user', text: 'Was this my chocolate?', itemId: 'food', createdAt: '2026-10-04T20:31:00Z' }],
  });
  Object.assign(state.data.trips[0].payments[0], { from: 'a', to: 'b', amount: 750, date: '2026-10-03', time: '11:30', timezone: 'Europe/Paris', method: 'Bank transfer', note: 'Part of the receipt' });
  Object.assign(state.data.trips[0].drafts[0], { ...expense, id: 'draft', expenseId: expense.id, status: 'review' });
  Object.assign(state.data.trips[0], { name: 'Paris', startDate: '2026-10-01', endDate: '2026-10-08' });
  state.data.trips[0].members[0].name = 'Alice';
  state = await store.writeLedger(member, state.data, state.revision, { source: 'web' });
  const events = (await history(member)).filter(event => event.revision === state.revision);
  assert.deepEqual(events.map(event => event.entityType).sort(), ['draft', 'expense', 'member', 'payment', 'trip']);
  for (const event of events) { assert.equal(event.actorId, member); assert.equal(event.actorName, 'Bob'); assert.equal(event.source, 'web'); }
  for (const [kind, entries] of [['expense', 'expenses'], ['payment', 'payments'], ['draft', 'drafts']] as const) {
    const event = events.find(event => event.entityType === kind)!;
    assert.deepEqual(event.before, before[entries][0]);
    assert.deepEqual(event.after, state.data.trips[0][entries][0]);
  }
  assert.equal(state.data.trips[0].expenses[0].conversation![0].authorMemberId, 'b');
  assert.equal(state.data.trips[0].expenses[0].conversation![0].authorName, 'Bob');
  assert.deepEqual(state.data.trips[0].expenses[0].items[0].units, { total: 3, allocations: { a: 2.5, b: 0.5 }, label: 'bars' });
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

test('a Unicode ledger near the content limit survives maximum receipt policy growth and round trips', async () => {
  const database = await storage();
  const data = nearContentLimit(store.MAX_LEDGER_CONTENT_BYTES - 10);
  assert.equal(store.ledgerContentBytes(data), store.MAX_LEDGER_CONTENT_BYTES - 10);
  database.sqlite.exec(`CREATE TRIGGER refuse_last_large_event BEFORE INSERT ON activity_events
    WHEN NEW.trip_id='t6' AND NEW.entity_id='e999' BEGIN SELECT RAISE(ABORT, 'simulated late audit failure'); END`);
  await assert.rejects(store.writeLedger(actor, data, 0), /simulated late audit failure/);
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM trips').get()?.count, 0);
  assert.equal(database.sqlite.prepare('SELECT revision FROM sync_state WHERE id=1').get(), undefined);
  assert.equal(count(database), 0, 'a late audit chunk failure rolls back all normalized trip writes');
  database.sqlite.exec('DROP TRIGGER refuse_last_large_event');
  let saved = await store.writeLedger(actor, data, 0);
  assert.equal(saved.data.trips.flatMap(holiday => holiday.expenses).length, 7000);
  assert.ok(jsonBytes(saved.data) > 1_800_000, '7000 new policy stamps require reserved storage headroom');
  assert.equal(count(database), 7014);
  assert.equal(store.ledgerContentBytes(saved.data), store.MAX_LEDGER_CONTENT_BYTES - 10);
  assert.ok(jsonBytes(saved.data) <= store.MAX_STORED_LEDGER_BYTES);
  for (const holiday of saved.data.trips) {
    assert.ok(holiday.expenses.every(expense => expense.adjustmentAllocation === 'selected-participants'));
    const stored = database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get(holiday.id)?.data as string;
    assert.ok(new TextEncoder().encode(stored).byteLength <= store.MAX_STORED_TRIP_BYTES);
    assert.deepEqual(JSON.parse(stored), holiday);
  }
  const response = await (await ledgerRoute()).POST(saveRequest(saved.data, saved.revision));
  assert.equal(response.status, 200, 'the HTTP body limit must allow a normalized ledger to round trip');
  saved = await response.json() as typeof saved;
  assert.equal(count(database), 7014, 'resaving server-normalized content must not add history');
  database.beforeBatch = statements => {
    const cas = statements.find(statement => /^UPDATE sync_state/.test(statement.sql.trim()));
    if (cas) assert.ok(cas.bindingBytes.every(bytes => bytes < 50_000), 'CAS must not bind the large stored trip JSON a second time');
  };
  saved.data.trips[0].expenses[0].tip = 1;
  saved = await store.writeLedger(actor, saved.data, saved.revision);
  assert.equal(count(database), 7015);
  const event = lastEntity(await history(actor, 't0'), 'expense', 'e0');
  assert.equal(event.before?.tip, 0); assert.equal(event.after?.tip, 1);
  assert.deepEqual(event.after, saved.data.trips[0].expenses[0]);
});

test('editable content uses UTF8 bytes and over-budget Unicode leaves live data and audit unchanged', async () => {
  const database = await storage();
  const data = nearContentLimit(store.MAX_LEDGER_CONTENT_BYTES + 1);
  assert.ok(JSON.stringify(data).length < store.MAX_LEDGER_CONTENT_BYTES, 'UTF16 character counts understate this receipt content');
  await assert.rejects(store.writeLedger(actor, data, 0), (error: unknown) => error instanceof store.RequestError
    && error.status === 413 && /too much receipt or payment content/.test(error.message));
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM trips').get()?.count, 0);
  assert.equal(database.sqlite.prepare('SELECT revision FROM sync_state WHERE id=1').get(), undefined);
  assert.equal(count(database), 0);
});

function authorGrowthLedger(withAuthors = false) {
  const memberId = 'm'.repeat(100), authorName = '🍫'.repeat(40);
  return parseLedgerStructure({ trips: Array.from({ length: 50 }, (_, index) => ({ ...trip(`authored-${index}`),
    members: [{ id: memberId, name: authorName.slice(0, 50) }],
    expenses: [{ ...dinner(), id: 'receipt', payer: memberId,
      items: [{ id: 'item', name: 'Chocolate', amount: 1, members: [memberId] }],
      conversation: Array.from({ length: 100 }, (_, message) => ({ id: `message-${message}`, role: 'user',
        text: '🍫'.repeat(15), createdAt: '2026-10-04T00:00:00Z',
        ...(withAuthors ? { authorMemberId: memberId, authorName } : {}),
      })),
    }],
  })) });
}

test('trusted speaker metadata exceeding reserved headroom is rejected before financial or audit writes', async () => {
  const database = await storage();
  database.sqlite.prepare('UPDATE profiles SET display_name=? WHERE id=?').run('🍫'.repeat(40), actor);
  const data = authorGrowthLedger();
  assert.ok(jsonBytes(data) < store.MAX_LEDGER_CONTENT_BYTES);
  assert.ok(jsonBytes(authorGrowthLedger(true)) > store.MAX_STORED_LEDGER_BYTES);
  await assert.rejects(store.writeLedger(actor, data, 0), (error: unknown) => error instanceof store.RequestError
    && error.status === 413 && /storage space for receipt metadata/.test(error.message));
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM trips').get()?.count, 0);
  assert.equal(database.sqlite.prepare('SELECT revision FROM sync_state WHERE id=1').get(), undefined);
  assert.equal(count(database), 0);
});

test('client-supplied author metadata cannot bypass the hard UTF8 storage ceiling', async () => {
  const database = await storage();
  const data = authorGrowthLedger(true);
  assert.ok(store.ledgerContentBytes(data) < store.MAX_LEDGER_CONTENT_BYTES);
  assert.ok(jsonBytes(data) > store.MAX_STORED_LEDGER_BYTES);
  let baselineReads = 0;
  database.beforeBatch = () => { baselineReads++; };
  await assert.rejects(store.writeLedger(actor, data, 0), (error: unknown) => error instanceof store.RequestError
    && error.status === 413 && /storage space for receipt metadata/.test(error.message));
  assert.equal(baselineReads, 0, 'oversized metadata is rejected before reading or preparing a mutation');
  assert.equal(count(database), 0);
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

test('history selects bounded metadata before snapshots and pages all large Unicode records without gaps', async () => {
  const database = await storage();
  await create(database);
  const snapshot = JSON.stringify({ title: '🥐'.repeat(180_000), details: '"\\\n'.repeat(1000) });
  for (let index = 0; index < 3; index++) database.sqlite.prepare(`
    INSERT INTO activity_events (id,trip_id,actor_id,actor_name,created_at,entity_type,entity_id,action,before_data,after_data,revision,source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(`large-${index}`, 'trip-1', actor, 'Original Owner', '2026-10-04T20:30:00Z', 'expense', 'dinner', 'update', snapshot, snapshot, index + 2, 'web');
  const materializedCounts: number[] = [];
  const originalPrepare = database.prepare.bind(database);
  database.prepare = sql => {
    const statement = originalPrepare(sql);
    if (/SELECT e\.\*/.test(sql)) {
      assert.match(sql, /e\.id IN \(SELECT value FROM json_each\(\?\)\)/, 'snapshot reads must be restricted to the budgeted immutable IDs');
      const originalAll = statement.all.bind(statement);
      statement.all = async <T>() => { const rows = await originalAll<T>(); materializedCounts.push(rows.results.length); return rows; };
    }
    return statement;
  };
  const first = await store.readActivity(actor, 'trip-1', { limit: 50 });
  assert.deepEqual(first.events.map(event => event.id), ['large-2', 'large-1']);
  assert.ok(first.nextCursor);
  assert.ok(new TextEncoder().encode(JSON.stringify(first)).byteLength <= store.MAX_ACTIVITY_BYTES);
  const second = await store.readActivity(actor, 'trip-1', { limit: 50, before: first.nextCursor! });
  assert.equal(second.events[0].id, 'large-0');
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.events, ...second.events].map(event => event.id)).size, count(database));
  assert.deepEqual(materializedCounts, [2, 4]);
  assert.equal(first.events[0].before?.title, '🥐'.repeat(180_000), 'whole snapshots survive byte paging');
});

test('an oversized history entry becomes explicit metadata and never blocks paging or materializes its snapshot', async () => {
  const database = await storage();
  await create(database);
  database.sqlite.prepare(`
    INSERT INTO activity_events (id,trip_id,actor_id,actor_name,created_at,entity_type,entity_id,action,before_data,after_data,revision,source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run('oversized', 'trip-1', actor, 'Original Owner', '2026-10-04T20:30:00Z', 'expense', 'dinner', 'update', null,
    JSON.stringify({ title: 'x'.repeat(store.MAX_ACTIVITY_BYTES) }), 2, 'web');
  const originalPrepare = database.prepare.bind(database);
  let summariesOnly = true;
  database.prepare = sql => {
    if (summariesOnly) assert.doesNotMatch(sql, /SELECT e\.\*/, 'the oversized event must not materialize its snapshot');
    return originalPrepare(sql);
  };
  const first = await store.readActivity(actor, 'trip-1', { limit: 1 });
  assert.equal(first.events[0].id, 'oversized');
  assert.equal(first.events[0].snapshotOmitted, true);
  assert.equal(first.events[0].after, null);
  assert.equal(first.events[0].snapshotDownload, '/api/activity-entry?tripId=trip-1&eventId=oversized');
  assert.ok(first.nextCursor);
  summariesOnly = false;
  const older = await store.readActivity(actor, 'trip-1', { before: first.nextCursor! });
  assert.equal(older.nextCursor, null);
  assert.equal(new Set([...first.events, ...older.events].map(event => event.id)).size, count(database));
});

test('legacy JSON numeric notation cannot expand an activity response above its byte limit', async () => {
  const database = await storage();
  await create(database);
  // Earlier SQL-written snapshots can use a compact numeric notation that
  // JSON.stringify expands. Apply the limit to the actual encoded response too.
  const snapshot = `{"amounts":[${Array.from({ length: 200_000 }, () => '1e20').join(',')}]}`;
  assert.ok(new TextEncoder().encode(snapshot).byteLength < store.MAX_ACTIVITY_BYTES);
  database.sqlite.prepare(`
    INSERT INTO activity_events (id,trip_id,actor_id,actor_name,created_at,entity_type,entity_id,action,before_data,after_data,revision,source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run('legacy-numbers', 'trip-1', actor, 'Original Owner', '2026-10-04T20:30:00Z', 'expense', 'dinner', 'update', null, snapshot, 2, 'web');
  const result = await store.readActivity(actor, 'trip-1');
  assert.equal(result.events[0].snapshotOmitted, true);
  assert.equal(result.events[0].id, 'legacy-numbers');
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).byteLength <= store.MAX_ACTIVITY_BYTES);
});

test('membership loss after selecting history metadata exposes neither snapshots nor a cursor', async () => {
  const database = await storage();
  await create(database);
  database.sqlite.prepare('INSERT INTO memberships (trip_id,user_id,member_id) VALUES (?,?,?)').run('trip-1', member, 'b');
  const originalPrepare = database.prepare.bind(database);
  database.prepare = sql => {
    const statement = originalPrepare(sql);
    if (/SELECT e\.id, e\.sequence/.test(sql)) {
      const originalAll = statement.all.bind(statement);
      statement.all = async <T>() => {
        const rows = await originalAll<T>();
        database.sqlite.prepare('DELETE FROM memberships WHERE trip_id=? AND user_id=?').run('trip-1', member);
        return rows;
      };
    }
    return statement;
  };
  await assert.rejects(store.readActivity(member, 'trip-1', { limit: 2 }), (error: unknown) => error instanceof store.RequestError && error.status === 403);
});

test('provider profile creation and its private audit commit atomically with no events on unchanged reads', async () => {
  const database = await storage();
  const providerRequest = new Request('https://triptab.test/api/profile', { headers: {
    'oai-authenticated-user-id': 'new-provider', 'oai-authenticated-user-email': 'new@example.com', 'oai-authenticated-user-full-name': 'New%20Traveller',
  } });
  const profiles = await Promise.all([store.ensureProfile(providerRequest), store.ensureProfile(providerRequest)]);
  assert.equal(profiles[0].displayName, 'New Traveller');
  assert.equal(profiles[1].id, 'new-provider');
  let events = database.sqlite.prepare('SELECT * FROM account_activity_events WHERE user_id=?').all('new-provider');
  assert.equal(events.length, 1);
  assert.equal(events[0].entity_type, 'profile'); assert.equal(events[0].action, 'create'); assert.equal(events[0].source, 'chatgpt');
  assert.equal(events[0].before_data, null);
  assert.deepEqual(JSON.parse(events[0].after_data as string), { displayName: 'New Traveller' });
  assert.doesNotMatch(JSON.stringify(events), /new@example\.com|token|password|cookie/);
  await store.ensureProfile(providerRequest);
  events = database.sqlite.prepare('SELECT * FROM account_activity_events WHERE user_id=?').all('new-provider');
  assert.equal(events.length, 1);
  assert.equal(count(database), 0, 'private profile history is not trip history');
});

test('a private audit insert failure rolls back provider profile creation', async () => {
  const database = await storage();
  database.sqlite.exec("CREATE TRIGGER refuse_account_audit BEFORE INSERT ON account_activity_events BEGIN SELECT RAISE(ABORT, 'simulated private history failure'); END;");
  const providerRequest = new Request('https://triptab.test/api/profile', { headers: {
    'oai-authenticated-user-id': 'new-provider', 'oai-authenticated-user-email': 'new@example.com', 'oai-authenticated-user-full-name': 'New%20Traveller',
  } });
  await assert.rejects(store.ensureProfile(providerRequest), /simulated private history failure/);
  assert.equal(database.sqlite.prepare('SELECT id FROM profiles WHERE id=?').get('new-provider'), undefined);
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM account_activity_events').get()?.count, 0);
  database.sqlite.exec('DROP TRIGGER refuse_account_audit');
  await store.ensureProfile(providerRequest);
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM account_activity_events').get()?.count, 1);
});

test('a provider link winning before profile creation leaves no orphan profile or private event', async () => {
  const database = await storage();
  const providerRequest = new Request('https://triptab.test/api/profile', { headers: {
    'oai-authenticated-user-id': 'new-provider', 'oai-authenticated-user-email': 'new@example.com',
  } });
  database.beforeBatch = statements => {
    if (!statements.some(statement => /^INSERT INTO profiles/.test(statement.sql.trim()))) return;
    database.beforeBatch = undefined;
    database.sqlite.prepare('INSERT INTO auth_links (oai_user_id,user_id,created_at) VALUES (?,?,?)')
      .run('new-provider', actor, '2026-10-04T00:00:00Z');
  };
  await assert.rejects(store.ensureProfile(providerRequest), /UNAUTHORIZED/);
  assert.equal(database.sqlite.prepare('SELECT id FROM profiles WHERE id=?').get('new-provider'), undefined);
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM account_activity_events').get()?.count, 0);
  const canonical = await store.ensureProfile(providerRequest);
  assert.equal(canonical.id, actor); assert.equal(canonical.displayName, 'Original Owner');
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM account_activity_events').get()?.count, 0);
});

test('profile reads use a single coherent provider snapshot and observe a link change on the next request', async () => {
  const database = await storage();
  database.sqlite.prepare('INSERT INTO profiles (id,email,display_name,created_at) VALUES (?,?,?,?)')
    .run('old-provider', 'old@example.com', 'Old Traveller', '2026-10-04T00:00:00Z');
  const providerRequest = new Request('https://triptab.test/api/profile', { headers: {
    'oai-authenticated-user-id': 'old-provider', 'oai-authenticated-user-email': 'old@example.com',
  } });
  const prepare = database.prepare.bind(database); let reads = 0;
  database.prepare = sql => {
    if (sql.includes('LEFT JOIN auth_links l ON') && ++reads === 2) {
      database.sqlite.prepare('INSERT INTO auth_links (oai_user_id,user_id,created_at) VALUES (?,?,?)')
        .run('old-provider', actor, '2026-10-04T00:00:00Z');
    }
    return prepare(sql);
  };
  assert.equal((await store.ensureProfile(providerRequest)).id, 'old-provider');
  assert.equal(reads, 1);
  assert.equal(database.sqlite.prepare('SELECT display_name FROM profiles WHERE id=?').get('old-provider')?.display_name, 'Old Traveller');
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM account_activity_events').get()?.count, 0);
  assert.equal((await store.ensureProfile(providerRequest)).id, actor);
});

test('each profile read observes its current canonical link without mixing another snapshot', async () => {
  const database = await storage();
  database.sqlite.prepare('INSERT INTO auth_links (oai_user_id,user_id,created_at) VALUES (?,?,?)')
    .run('linked-provider', actor, '2026-10-04T00:00:00Z');
  const providerRequest = new Request('https://triptab.test/api/profile', { headers: {
    'oai-authenticated-user-id': 'linked-provider', 'oai-authenticated-user-email': 'provider@example.com',
  } });
  const prepare = database.prepare.bind(database); let reads = 0;
  database.prepare = sql => {
    if (sql.includes('LEFT JOIN auth_links l ON') && ++reads === 2) {
      database.sqlite.prepare('UPDATE auth_links SET user_id=? WHERE oai_user_id=?').run(member, 'linked-provider');
    }
    return prepare(sql);
  };
  assert.equal((await store.ensureProfile(providerRequest)).id, actor);
  assert.equal(reads, 1);
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM account_activity_events').get()?.count, 0);
  assert.equal((await store.ensureProfile(providerRequest)).id, member);
});

test('activity endpoint requires auth/membership and validates bounded, unambiguous pagination', async context => {
  context.mock.method(console, 'error', () => {});
  const database = await storage();
  await create(database);
  const routeSource = await readFile(new URL('../app/api/activity/route.ts', import.meta.url), 'utf8');
  const routeCompiled = transpileModule(routeSource, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText.replaceAll("'./data-utils'", JSON.stringify(new URL('../lib/data-utils.ts', import.meta.url).href)).replaceAll("'./receipt-ai-config'", JSON.stringify(new URL('../lib/receipt-ai-config.ts', import.meta.url).href)).replaceAll("'@/lib/data-utils'", JSON.stringify(new URL('../lib/data-utils.ts', import.meta.url).href)).replaceAll("'@/lib/receipt-ai-config'", JSON.stringify(new URL('../lib/receipt-ai-config.ts', import.meta.url).href)).replace("'@/lib/store'", JSON.stringify(storeUrl));
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
  const routeCompiled = transpileModule(routeSource, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText.replaceAll("'./data-utils'", JSON.stringify(new URL('../lib/data-utils.ts', import.meta.url).href)).replaceAll("'./receipt-ai-config'", JSON.stringify(new URL('../lib/receipt-ai-config.ts', import.meta.url).href)).replaceAll("'@/lib/data-utils'", JSON.stringify(new URL('../lib/data-utils.ts', import.meta.url).href)).replaceAll("'@/lib/receipt-ai-config'", JSON.stringify(new URL('../lib/receipt-ai-config.ts', import.meta.url).href))
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

test('receipt memory validates bounded notes and exact alias targets while retaining historical references', () => {
  assert.deepEqual(receiptMemorySchema.parse({}), { notes: '', aliases: [] });
  const memory = receiptMemorySchema.parse({
    notes: 'n'.repeat(6000),
    aliases: Array.from({ length: 50 }, (_, index) => ({ name: `  ${'a'.repeat(60)}  `, itemId: `removed-item-${index}`, scopeMemberId: 'removed-person' })),
  });
  assert.equal(memory.notes.length, 6000);
  assert.equal(memory.aliases.length, 50);
  assert.equal(memory.aliases[0].name.length, 60);
  assert.equal(memory.aliases[0].itemId, 'removed-item-0');
  assert.deepEqual(receiptMemorySchema.parse({ aliases: [{ name: ' Dad ', memberId: 'former-traveller' }] }).aliases, [{ name: 'Dad', memberId: 'former-traveller' }]);
  for (const invalid of [
    { notes: 'n'.repeat(6001) },
    { aliases: Array.from({ length: 51 }, () => ({ name: 'meal', itemId: 'food' })) },
    { aliases: [{ name: '  ', itemId: 'food' }] },
    { aliases: [{ name: 'a'.repeat(61), itemId: 'food' }] },
    { aliases: [{ name: 'ambiguous' }] },
    { aliases: [{ name: 'ambiguous', itemId: 'food', memberId: 'a' }] },
    { aliases: [{ name: 'meal', itemId: '' }] },
    { aliases: [{ name: 'meal', itemId: 'x'.repeat(101) }] },
    { aliases: [{ name: 'meal', itemId: 'food', scopeMemberId: '' }] },
    { aliases: [{ name: 'meal', itemId: 'food', unsupported: 'value' }] },
    { unsupported: 'value' },
  ]) {
    const result = receiptMemorySchema.safeParse(invalid);
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.name, 'ZodError');
  }
});

test('new receipt messages stamp user speakers and never attribute assistant replies to a traveller', async () => {
  const database = await storage();
  const holiday = trip();
  holiday.expenses = [{ ...dinner(), conversation: [
    { id: 'question', role: 'user', text: 'Was this my meal?', createdAt: '2026-10-04T20:31:00Z', itemId: 'food', authorMemberId: 'b', authorName: 'Forged Bob' },
    { id: 'answer', role: 'assistant', text: 'Check the item assignment.', createdAt: '2026-10-04T20:32:00Z', replyTo: 'question', itemId: 'food', authorMemberId: 'b', authorName: 'Forged Bob' },
  ] }];
  const state = await create(database, holiday);
  const messages = state.data.trips[0].expenses[0].conversation!;
  assert.equal(messages[0].authorMemberId, 'a');
  assert.equal(messages[0].authorName, 'Original Owner');
  assert.equal(messages[1].authorMemberId, undefined);
  assert.equal(messages[1].authorName, undefined);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[0].itemId, 'food');
  assert.deepEqual(lastEntity(await history(), 'expense', 'dinner').after?.conversation, messages);
});

test('legacy assistant stamps are removed without changing words, historical evidence or unchanged invalid money', async () => {
  const database = await storage();
  const legacy = seedLegacy(database);
  const messages = [
    { id: 'legacy-user', role: 'user' as const, text: 'My meal?', createdAt: '2026-10-04T20:31:00Z', authorMemberId: 'b', authorName: 'Bob' },
    { id: 'legacy-ai', role: 'assistant' as const, text: 'Check the receipt.', createdAt: '2026-10-04T20:32:00Z', replyTo: 'legacy-user', authorMemberId: 'a', authorName: 'Wrong human' },
  ];
  legacy.expenses[0].conversation = messages;
  database.sqlite.prepare('UPDATE trips SET data=? WHERE id=?').run(JSON.stringify(legacy), legacy.id);
  let state = await store.readLedger(actor);
  assert.equal(state.data.trips[0].expenses[0].conversation![1].authorName, undefined);
  assert.equal(state.data.trips[0].expenses[0].conversation![1].authorMemberId, undefined);
  assert.equal(JSON.parse(database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get(legacy.id)?.data as string)
    .expenses[0].conversation[1].authorName, 'Wrong human', 'reading must not rewrite stored evidence');
  state = await store.writeLedger(actor, state.data, state.revision);
  const saved = state.data.trips[0].expenses[0];
  assert.equal(saved.bankAmount, 0); assert.equal(saved.adjustmentAllocation, undefined);
  assert.deepEqual(saved.conversation![0], messages[0]);
  assert.deepEqual(saved.conversation![1], { id: 'legacy-ai', role: 'assistant', text: 'Check the receipt.',
    createdAt: '2026-10-04T20:32:00Z', replyTo: 'legacy-user' });
  assert.equal(count(database), 0, 'a display-only repair must not be attributed to the participant');
  assert.equal(notifications.length, 0);
  const changed = structuredClone(state.data);
  changed.trips[0].expenses[0].conversation![1].text = 'Rewritten reply';
  await assert.rejects(store.writeLedger(actor, changed, state.revision), /Saved receipt messages cannot be edited/);
});

test('a draft-only question silently clears legacy assistant stamps without invented expense edits or pushes', async () => {
  const database = await storage();
  const holiday = trip();
  holiday.expenses = Array.from({ length: 12 }, (_, index) => ({ ...dinner(), id: `legacy-${index}`, conversation: [
    { id: `answer-${index}`, role: 'assistant' as const, text: 'Check the receipt.', createdAt: '2026-10-04T20:32:00Z' },
  ] }));
  const initial = await create(database, holiday);
  const raw = structuredClone(initial.data.trips[0]);
  for (const expense of raw.expenses) Object.assign(expense.conversation![0], { authorMemberId: 'a', authorName: 'Wrong human' });
  database.sqlite.prepare('UPDATE trips SET data=? WHERE id=?').run(JSON.stringify(raw), raw.id);
  database.sqlite.prepare('INSERT INTO memberships (trip_id,user_id,member_id) VALUES (?,?,?)').run(raw.id, member, 'b');
  const beforeEvents = count(database);
  const bob = await store.readLedger(member);
  bob.data.trips[0].drafts = [{ ...dinner(), id: 'question-draft', expenseId: 'legacy-0', status: 'waiting', conversation: [
    { id: 'bob-question', role: 'user', text: 'Was this my meal?', createdAt: '2026-10-04T20:35:00Z' },
  ] }];
  const saved = await store.writeLedger(member, bob.data, bob.revision);
  assert.equal(count(database), beforeEvents + 1);
  const added = (await history()).filter(event => event.revision === saved.revision);
  assert.deepEqual(added.map(event => [event.entityType, event.actorId]), [['draft', member]]);
  assert.equal(notifications.length, 0);
  const stored = JSON.parse(database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get(raw.id)?.data as string) as Trip;
  for (const expense of stored.expenses) {
    assert.equal(expense.conversation![0].authorName, undefined);
    assert.equal(expense.conversation![0].authorMemberId, undefined);
  }
});

test('a genuine financial edit keeps the raw legacy assistant before image and only notifies the actual edit', async () => {
  const database = await storage();
  const holiday = trip();
  holiday.expenses = [{ ...dinner(), conversation: [{ id: 'old-answer', role: 'assistant', text: 'Check this total.', createdAt: '2026-10-04T20:32:00Z' }] }];
  const initial = await create(database, holiday);
  const raw = structuredClone(initial.data.trips[0]);
  Object.assign(raw.expenses[0].conversation![0], { authorMemberId: 'a', authorName: 'Wrong human' });
  database.sqlite.prepare('UPDATE trips SET data=? WHERE id=?').run(JSON.stringify(raw), raw.id);
  const state = await store.readLedger(actor);
  state.data.trips[0].expenses[0].tip = 100;
  const saved = await store.writeLedger(actor, state.data, state.revision);
  const event = lastEntity(await history(), 'expense', 'dinner');
  assert.deepEqual(event.before?.conversation, raw.expenses[0].conversation);
  assert.deepEqual(event.after, saved.data.trips[0].expenses[0]);
  assert.equal(event.before?.tip, 0); assert.equal(event.after?.tip, 100);
  assert.equal(notifications.length, 1);
  assert.match(String(notifications[0][3]), /updated an expense/);
});

test('history preserves raw pre-existing assistant-attribution corrections instead of hiding their before/after difference', async () => {
  const database = await storage();
  await create(database);
  const before = { ...dinner(), conversation: [{ id: 'historic-assistant', role: 'assistant', text: 'Check the receipt.',
    createdAt: '2026-10-04T20:32:00Z', authorMemberId: 'b', authorName: 'Mistaken Bob' }] };
  const after = { ...before, conversation: before.conversation.map(({ id, role, text, createdAt }) => ({ id, role, text, createdAt })) };
  database.sqlite.prepare(`INSERT INTO activity_events
    (id,trip_id,actor_id,actor_name,created_at,entity_type,entity_id,action,before_data,after_data,revision,source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run('old-attribution-repair', 'trip-1', member, 'Bob', '2026-10-04T21:00:00Z',
      'expense', before.id, 'update', JSON.stringify(before), JSON.stringify(after), 1, 'web');
  const event = (await store.readActivity(actor, 'trip-1')).events.find(candidate => candidate.id === 'old-attribution-repair')!;
  assert.deepEqual(event.before, before);
  assert.deepEqual(event.after, after);
  assert.notDeepEqual(event.before, event.after, 'a historical correction must retain visible evidence');
  const evidence = database.sqlite.prepare('SELECT before_data,after_data FROM activity_events WHERE id=?').get(event.id) as { before_data: string; after_data: string };
  assert.deepEqual(event.before, JSON.parse(evidence.before_data));
  assert.deepEqual(event.after, JSON.parse(evidence.after_data));
  (event.before!.conversation as { text: string }[])[0].text = 'Changed in the browser';
  const fresh = (await store.readActivity(actor, 'trip-1')).events.find(candidate => candidate.id === event.id)!;
  assert.deepEqual(fresh.before, before, 'view mutations cannot alter immutable history');
  assert.deepEqual(database.sqlite.prepare('SELECT before_data,after_data FROM activity_events WHERE id=?').get(event.id), evidence);
});

test('known Bob messages keep their original speakers when Alice copies a receipt into review and submits a new reply', async () => {
  const database = await storage();
  const holiday = trip(); holiday.expenses = [dinner()];
  await create(database, holiday);
  database.sqlite.prepare('INSERT INTO memberships (trip_id,user_id,member_id) VALUES (?,?,?)').run('trip-1', member, 'b');
  let bob = await store.readLedger(member);
  bob.data.trips[0].expenses[0].conversation = [
    { id: 'bob-question', role: 'user', text: 'I had the dinner.', createdAt: '2026-10-04T20:31:00Z', itemId: 'food', authorMemberId: 'a', authorName: 'Forged Alice' },
  ];
  bob = await store.writeLedger(member, bob.data, bob.revision);
  const savedQuestion = structuredClone(bob.data.trips[0].expenses[0].conversation![0]);
  assert.equal(savedQuestion.authorMemberId, 'b');
  assert.equal(savedQuestion.authorName, 'Bob');
  database.sqlite.prepare('UPDATE profiles SET display_name=? WHERE id=?').run('New Bob', member);
  let alice = await store.readLedger(actor);
  const eventsBeforeForgery = count(database);
  alice.data.trips[0].expenses[0].conversation![0].authorMemberId = 'a';
  alice.data.trips[0].expenses[0].conversation![0].authorName = 'Forged Alice';
  alice = await store.writeLedger(actor, alice.data, alice.revision);
  assert.deepEqual(alice.data.trips[0].expenses[0].conversation![0], savedQuestion);
  assert.equal(count(database), eventsBeforeForgery, 'ignored author forgery must not create a false edit');
  const reviewed = structuredClone(alice.data.trips[0].expenses[0]);
  reviewed.conversation![0].authorMemberId = 'a';
  reviewed.conversation![0].authorName = 'Forged Alice';
  alice.data.trips[0].drafts = [{ ...reviewed, id: 'review-draft', status: 'review', expenseId: 'dinner', conversation: [
    ...reviewed.conversation!,
    { id: 'alice-answer', role: 'assistant', text: 'Your dinner is assigned to Bob.', createdAt: '2026-10-04T20:33:00Z', replyTo: 'bob-question', itemId: 'food', authorMemberId: 'b', authorName: 'Forged Bob' },
  ] }];
  alice = await store.writeLedger(actor, alice.data, alice.revision, { source: 'chatgpt' });
  assert.deepEqual(alice.data.trips[0].drafts[0].conversation![0], savedQuestion);
  assert.deepEqual(alice.data.trips[0].expenses[0].conversation![0], savedQuestion);
  const reply = alice.data.trips[0].drafts[0].conversation![1];
  assert.equal(reply.authorMemberId, undefined);
  assert.equal(reply.authorName, undefined);
  assert.equal(reply.replyTo, 'bob-question');
  assert.equal(lastEntity(await history(), 'draft', 'review-draft').source, 'chatgpt');
  // Posting the review may remove its container without dropping provenance.
  alice.data.trips[0].expenses[0].conversation = alice.data.trips[0].drafts[0].conversation;
  alice.data.trips[0].drafts = [];
  alice = await store.writeLedger(actor, alice.data, alice.revision);
  assert.deepEqual(alice.data.trips[0].expenses[0].conversation![0], savedQuestion);
  assert.equal(alice.data.trips[0].expenses[0].conversation![1].authorMemberId, undefined);
});

test('saved message IDs cannot be reused to rewrite another traveller’s words or item context', async context => {
  const database = await storage();
  const holiday = trip(); holiday.expenses = [dinner()];
  await create(database, holiday);
  database.sqlite.prepare('INSERT INTO memberships (trip_id,user_id,member_id) VALUES (?,?,?)').run('trip-1', member, 'b');
  const bob = await store.readLedger(member);
  bob.data.trips[0].expenses[0].conversation = [{ id: 'bob-question', role: 'user', text: 'My meal was the dinner.', createdAt: '2026-10-04T20:31:00Z', itemId: 'food' }];
  await store.writeLedger(member, bob.data, bob.revision);
  const alice = await store.readLedger(actor);
  const original = database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get('trip-1')?.data;
  const initialEvents = count(database);
  for (const [field, value] of [
    ['role', 'assistant'], ['text', 'Bob owes everything.'], ['createdAt', '2026-10-04T20:35:00Z'], ['replyTo', 'other-question'], ['itemId', 'other-item'],
  ] as const) await context.test(field, async () => {
    const changed = structuredClone(alice.data);
    Object.assign(changed.trips[0].expenses[0].conversation![0], { [field]: value });
    await assert.rejects(store.writeLedger(actor, changed, alice.revision), (error: unknown) => error instanceof store.RequestError && error.status === 400 && /Saved receipt messages cannot be edited/.test(error.message));
    assert.equal(database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get('trip-1')?.data, original);
    assert.equal(database.sqlite.prepare('SELECT revision FROM sync_state WHERE id=1').get()?.revision, alice.revision);
    assert.equal(count(database), initialEvents);
  });
});

test('historical speakers and unlabelled legacy messages survive removed travellers and receipt copies', async () => {
  const database = await storage();
  const holiday = trip(); holiday.members.push({ id: 'former', name: 'Former Traveller' }); holiday.expenses = [dinner()];
  let state = await create(database, holiday);
  state.data.trips[0].expenses[0].conversation = [
    { id: 'historical', role: 'user', text: 'I ordered this.', createdAt: '2026-10-03T20:31:00Z', itemId: 'removed-item', authorMemberId: 'former', authorName: 'Former Name' },
    { id: 'legacy', role: 'user', text: 'An older unlabelled question.', createdAt: '2026-10-02T20:31:00Z' },
  ];
  // Fixture represents messages saved before this account/session and old schema.
  database.sqlite.prepare('UPDATE trips SET data=? WHERE id=?').run(JSON.stringify(state.data.trips[0]), 'trip-1');
  state = await store.readLedger(actor);
  const originalMessages = structuredClone(state.data.trips[0].expenses[0].conversation!);
  state.data.trips[0].members = state.data.trips[0].members.filter(person => person.id !== 'former');
  const review = structuredClone(state.data.trips[0].expenses[0]);
  review.conversation!.forEach(message => { message.authorMemberId = 'a'; message.authorName = 'Forged Owner'; });
  state.data.trips[0].drafts = [{ ...review, id: 'review-history', status: 'review', expenseId: 'dinner' }];
  state = await store.writeLedger(actor, state.data, state.revision);
  assert.deepEqual(state.data.trips[0].expenses[0].conversation, originalMessages);
  assert.deepEqual(state.data.trips[0].drafts[0].conversation, originalMessages);
  assert.equal(state.data.trips[0].drafts[0].conversation![0].authorName, 'Former Name');
  assert.equal(state.data.trips[0].drafts[0].conversation![1].authorMemberId, undefined);
  assert.equal(state.data.trips[0].drafts[0].conversation![1].authorName, undefined);
});

test('membership reassignment during a chat save cannot commit a message under a stale linked traveller', async () => {
  const database = await storage();
  const holiday = trip(); holiday.members.push({ id: 'c', name: 'Carol' }); holiday.expenses = [dinner()];
  await create(database, holiday);
  database.sqlite.prepare('INSERT INTO memberships (trip_id,user_id,member_id) VALUES (?,?,?)').run('trip-1', member, 'b');
  const state = await store.readLedger(member);
  state.data.trips[0].expenses[0].conversation = [{ id: 'question', role: 'user', text: 'My share?', createdAt: '2026-10-04T20:31:00Z' }];
  const initialEvents = count(database);
  database.beforeWriteBatch = () => { database.sqlite.prepare('UPDATE memberships SET member_id=? WHERE trip_id=? AND user_id=?').run('c', 'trip-1', member); };
  await assert.rejects(store.writeLedger(member, state.data, state.revision), /CONFLICT/);
  assert.equal((await store.readLedger(actor)).data.trips[0].expenses[0].conversation, undefined);
  assert.equal(database.sqlite.prepare('SELECT revision FROM sync_state WHERE id=1').get()?.revision, state.revision);
  assert.equal(count(database), initialEvents);
});

test('receipt memory persists through financial saves and bounds failures cannot change ledger or history', async context => {
  const errors = context.mock.method(console, 'error', () => {});
  const database = await storage();
  const holiday = trip(); holiday.expenses = [{ ...dinner(), memory: {
    notes: 'Bill includes tax. Keep the original receipt currency.',
    aliases: [{ name: 'My dinner', itemId: 'food', scopeMemberId: 'a' }, { name: 'Dad', memberId: 'b' }],
  } }];
  const state = await create(database, holiday);
  const memory = state.data.trips[0].expenses[0].memory;
  assert.deepEqual(memory, holiday.expenses[0].memory);
  assert.deepEqual(lastEntity(await history(), 'expense', 'dinner').after?.memory, memory);
  const original = database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get('trip-1')?.data;
  const initialEvents = count(database);
  const route = await ledgerRoute();
  for (const [invalid, expected] of [
    [{ notes: 'n'.repeat(6001), aliases: [] }, /memory → notes.*6000/],
    [{ notes: '', aliases: Array.from({ length: 51 }, () => ({ name: 'meal', itemId: 'food' })) }, /memory → aliases.*50/],
    [{ notes: '', aliases: [{ name: 'conflict', itemId: 'food', memberId: 'a' }] }, /memory → aliases → 1.*exactly one item or traveller/],
    [{ notes: '', aliases: [{ name: 'meal', itemId: 'food', PRIVATE_FIELD_NAME: 'private' }] }, /Remove unsupported fields/],
  ] as const) {
    const changed = structuredClone(state.data);
    Object.assign(changed.trips[0].expenses[0], { memory: invalid });
    const response = await route.POST(saveRequest(changed, state.revision));
    assert.equal(response.status, 400);
    const message = (await response.json() as { error: string }).error;
    assert.match(message, expected);
    assert.doesNotMatch(message, /PRIVATE_FIELD_NAME/);
    assert.equal(database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get('trip-1')?.data, original);
    assert.equal(database.sqlite.prepare('SELECT revision FROM sync_state WHERE id=1').get()?.revision, state.revision);
    assert.equal(count(database), initialEvents);
  }
  assert.equal(errors.mock.callCount(), 0);
});

async function memoryHoliday(database: SQLiteD1) {
  const holiday = trip();
  holiday.expenses = [{ ...dinner(), memory: { notes: 'Receipt context', aliases: [
    { name: 'My dinner', itemId: 'food', scopeMemberId: 'a' },
    { name: 'Dinner', itemId: 'food' },
  ] } }];
  await create(database, holiday);
  database.sqlite.prepare('INSERT INTO memberships (trip_id,user_id,member_id) VALUES (?,?,?)').run(holiday.id, member, 'b');
  const bob = await store.readLedger(member);
  bob.data.trips[0].expenses[0].memory!.aliases.push({ name: 'My meal', itemId: 'food', scopeMemberId: 'b' });
  await store.writeLedger(member, bob.data, bob.revision);
  notifications.length = 0;
  return store.readLedger(actor);
}

test('ledger HTTP alias ownership rejects foreign removals, rewrites and claims atomically on expenses and drafts', async context => {
  const database = await storage();
  let state = await memoryHoliday(database);
  state.data.trips[0].drafts = [{ ...state.data.trips[0].expenses[0], id: 'memory-draft', expenseId: 'dinner', status: 'review' }];
  state = await store.writeLedger(actor, state.data, state.revision);
  const original = database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get('trip-1')?.data;
  const initialEvents = count(database);
  const route = await ledgerRoute();
  for (const kind of ['expenses', 'drafts'] as const) for (const mutation of ['remove', 'rewrite', 'new claim', 'duplicate claim', 'clear memory'] as const) {
    await context.test(`${kind}: ${mutation}`, async () => {
      const changed = structuredClone(state.data);
      const receipt = changed.trips[0][kind][0];
      const memory = receipt.memory!;
      if (mutation === 'remove') memory.aliases = memory.aliases.filter(alias => alias.scopeMemberId !== 'b');
      if (mutation === 'rewrite') memory.aliases.find(alias => alias.scopeMemberId === 'b')!.name = 'A different Bob alias';
      if (mutation === 'new claim') memory.aliases.push({ name: 'Bob means Alice', memberId: 'a', scopeMemberId: 'b' });
      if (mutation === 'duplicate claim') memory.aliases.push({ ...memory.aliases.find(alias => alias.scopeMemberId === 'b')! });
      if (mutation === 'clear memory') delete receipt.memory;
      const response = await route.POST(saveRequest(changed, state.revision));
      assert.equal(response.status, 400);
      assert.match((await response.json() as { error: string }).error, /speaker-scoped aliases/);
      assert.equal(database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get('trip-1')?.data, original);
      assert.equal(database.sqlite.prepare('SELECT revision FROM sync_state WHERE id=1').get()?.revision, state.revision);
      assert.equal(count(database), initialEvents);
      assert.equal(notifications.length, 0);
    });
  }
});

test('ledger writers may change their own and shared aliases and remove an inactive speaker alias', async () => {
  const database = await storage();
  let state = await memoryHoliday(database);
  const raw = structuredClone(state.data.trips[0]);
  raw.expenses[0].memory!.aliases.push({ name: 'Former meal', itemId: 'removed-item', scopeMemberId: 'removed-traveller' });
  database.sqlite.prepare('UPDATE trips SET data=? WHERE id=?').run(JSON.stringify(raw), raw.id);
  state = await store.readLedger(actor);
  const aliases = state.data.trips[0].expenses[0].memory!.aliases;
  aliases.find(alias => alias.scopeMemberId === 'a')!.name = 'My pudding';
  aliases.find(alias => alias.scopeMemberId === undefined)!.memberId = 'b';
  delete aliases.find(alias => alias.scopeMemberId === undefined)!.itemId;
  state.data.trips[0].expenses[0].memory!.aliases = aliases.filter(alias => alias.scopeMemberId !== 'removed-traveller');
  state.data.trips[0].expenses[0].memory!.notes = 'Everyone agrees on the terminology.';
  const saved = await store.writeLedger(actor, state.data, state.revision);
  assert.deepEqual(saved.data.trips[0].expenses[0].memory!.aliases, [
    { name: 'My pudding', itemId: 'food', scopeMemberId: 'a' },
    { name: 'Dinner', memberId: 'b' },
    { name: 'My meal', itemId: 'food', scopeMemberId: 'b' },
  ]);
  assert.equal(lastEntity(await history(), 'expense', 'dinner').actorId, actor);
});

test('posting a consumed proposal preserves foreign aliases from both the target expense and saved draft', async () => {
  const database = await storage();
  let state = await memoryHoliday(database);
  state.data.trips[0].drafts = [{ ...state.data.trips[0].expenses[0], id: 'memory-draft', expenseId: 'dinner', status: 'review' }];
  state = await store.writeLedger(actor, state.data, state.revision);
  const bob = await store.readLedger(member);
  bob.data.trips[0].drafts[0].memory!.aliases.push({ name: 'My starter', itemId: 'food', scopeMemberId: 'b' });
  await store.writeLedger(member, bob.data, bob.revision);
  state = await store.readLedger(actor);
  const proposalMemory = structuredClone(state.data.trips[0].drafts[0].memory);
  const invalid = structuredClone(state.data);
  invalid.trips[0].drafts = [];
  invalid.trips[0].expenses[0].memory = { ...proposalMemory!, aliases: proposalMemory!.aliases.filter(alias => alias.name !== 'My meal') };
  const beforeEvents = count(database);
  await assert.rejects(store.writeLedger(actor, invalid, state.revision), /Keep active other travellers/);
  assert.equal(count(database), beforeEvents);
  state.data.trips[0].drafts = [];
  state.data.trips[0].expenses[0].memory = proposalMemory;
  const saved = await store.writeLedger(actor, state.data, state.revision);
  assert.deepEqual(saved.data.trips[0].expenses[0].memory, proposalMemory);
  assert.equal(saved.data.trips[0].drafts.length, 0);
});

test('new expense IDs may inherit a saved draft’s foreign aliases via retained target or immutable conversation', async context => {
  for (const retained of [true, false]) await context.test(retained ? 'waiting draft gets the posted target ID' : 'consumed draft shares immutable conversation', async () => {
    const database = await storage();
    const holiday = trip();
    holiday.drafts = [{ ...dinner(), id: 'source-draft', status: 'review' }];
    await create(database, holiday);
    database.sqlite.prepare('INSERT INTO memberships (trip_id,user_id,member_id) VALUES (?,?,?)').run(holiday.id, member, 'b');
    const bob = await store.readLedger(member);
    bob.data.trips[0].drafts[0].memory = { notes: 'Bob established this alias.', aliases: [{ name: 'My dinner', itemId: 'food', scopeMemberId: 'b' }] };
    bob.data.trips[0].drafts[0].conversation = [{ id: 'bob-source-question', role: 'user', text: 'My dinner was this item.', createdAt: '2026-10-04T20:35:00Z' }];
    await store.writeLedger(member, bob.data, bob.revision);
    const alice = await store.readLedger(actor);
    const source = alice.data.trips[0].drafts[0];
    alice.data.trips[0].expenses = [{ ...dinner(), id: 'posted-from-draft', memory: source.memory, conversation: source.conversation }];
    alice.data.trips[0].drafts = retained ? [{ ...source, expenseId: 'posted-from-draft', status: 'waiting' }] : [];
    const saved = await store.writeLedger(actor, alice.data, alice.revision);
    assert.deepEqual(saved.data.trips[0].expenses[0].memory, source.memory);
    assert.equal(saved.data.trips[0].expenses[0].conversation![0].authorMemberId, 'b');
  });
});

test('whole receipt deletion is allowed and historic restores retain saved foreign alias ownership', async () => {
  const database = await storage();
  let state = await memoryHoliday(database);
  const receipt = structuredClone(state.data.trips[0].expenses[0]);
  state.data.trips[0].expenses = [];
  state = await store.writeLedger(actor, state.data, state.revision);
  assert.equal(state.data.trips[0].expenses.length, 0);
  const initialEvents = count(database);
  const missing = structuredClone(state.data);
  missing.trips[0].expenses = [{ ...receipt, memory: undefined }];
  await assert.rejects(store.writeLedger(actor, missing, state.revision), /Keep active other travellers/);
  assert.equal(count(database), initialEvents);
  state.data.trips[0].expenses = [receipt];
  const restored = await store.writeLedger(actor, state.data, state.revision);
  assert.deepEqual(restored.data.trips[0].expenses[0].memory, receipt.memory);
  const event = lastEntity(await history(), 'expense', receipt.id);
  assert.equal(event.action, 'create');
  assert.equal(event.actorId, actor);
});

test('alias edits reject future baselines and recheck the trusted actor’s membership before committing', async () => {
  const database = await storage();
  const state = await memoryHoliday(database);
  state.data.trips[0].expenses[0].memory!.aliases.find(alias => alias.scopeMemberId === 'a')!.name = 'My corrected dinner';
  const original = database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get('trip-1')?.data;
  const initialEvents = count(database);
  await assert.rejects(store.writeLedger(actor, state.data, state.revision + 1), /CONFLICT/);
  database.beforeWriteBatch = () => {
    database.sqlite.prepare('DELETE FROM memberships WHERE trip_id=? AND user_id=?').run('trip-1', actor);
  };
  await assert.rejects(store.writeLedger(actor, state.data, state.revision), /CONFLICT/);
  assert.equal(database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get('trip-1')?.data, original);
  assert.equal(database.sqlite.prepare('SELECT revision FROM sync_state WHERE id=1').get()?.revision, state.revision);
  assert.equal(count(database), initialEvents);
  assert.equal(notifications.length, 0);
});

test('Bob may approve Alice’s saved linked-draft alias retarget while preserving unrelated target aliases', async () => {
  const database = await storage();
  let state = await memoryHoliday(database);
  state.data.trips[0].drafts = [{ ...structuredClone(state.data.trips[0].expenses[0]), id: 'alice-proposal', expenseId: 'dinner', status: 'review' }];
  const correction = state.data.trips[0].drafts[0].memory!.aliases.find(alias => alias.scopeMemberId === 'a')!;
  delete correction.itemId; correction.memberId = 'b';
  await store.writeLedger(actor, state.data, state.revision);
  state = await store.readLedger(actor);
  state.data.trips[0].expenses[0].memory!.aliases.push({ name: 'My drink', itemId: 'food', scopeMemberId: 'a' });
  await store.writeLedger(actor, state.data, state.revision);
  const bob = await store.readLedger(member);
  const proposal = structuredClone(bob.data.trips[0].drafts[0].memory!);
  const invalid = structuredClone(bob.data);
  invalid.trips[0].drafts = [];
  invalid.trips[0].expenses[0].memory = proposal;
  await assert.rejects(store.writeLedger(member, invalid, bob.revision), /Keep active other travellers/);
  proposal.aliases.push(bob.data.trips[0].expenses[0].memory!.aliases.find(alias => alias.name === 'My drink')!);
  bob.data.trips[0].drafts = [];
  bob.data.trips[0].expenses[0].memory = proposal;
  const saved = await store.writeLedger(member, bob.data, bob.revision);
  assert.deepEqual(saved.data.trips[0].expenses[0].memory, proposal);
  assert.deepEqual(saved.data.trips[0].expenses[0].memory!.aliases.find(alias => alias.name === 'My dinner'),
    { name: 'My dinner', memberId: 'b', scopeMemberId: 'a' });
  assert.equal(lastEntity(await history(), 'expense', 'dinner').actorId, member);
});

test('a client-created draft link cannot authorize retargeting another speaker’s posted alias', async () => {
  const database = await storage();
  const state = await memoryHoliday(database);
  state.data.trips[0].drafts = [{ ...dinner(), id: 'unlinked-proposal', status: 'review', memory: { notes: '', aliases: [
    { name: 'My dinner', memberId: 'b', scopeMemberId: 'a' },
  ] } }];
  await store.writeLedger(actor, state.data, state.revision);
  const bob = await store.readLedger(member);
  bob.data.trips[0].drafts[0].expenseId = 'dinner';
  const aliases = bob.data.trips[0].expenses[0].memory!.aliases;
  bob.data.trips[0].expenses[0].memory = {
    notes: '', aliases: [...aliases.filter(alias => alias.scopeMemberId !== 'a'), ...bob.data.trips[0].drafts[0].memory!.aliases],
  };
  // Matching the new target's memory is a caller claim, not a saved proposal link.
  bob.data.trips[0].drafts[0].memory = bob.data.trips[0].expenses[0].memory;
  const beforeEvents = count(database);
  await assert.rejects(store.writeLedger(member, bob.data, bob.revision), /Keep active other travellers/);
  assert.equal(count(database), beforeEvents);
  assert.equal(database.sqlite.prepare('SELECT revision FROM sync_state WHERE id=1').get()?.revision, bob.revision);
});

test('restoration cannot bypass protected historical aliases by borrowing a current image or conversation', async context => {
  const database = await storage();
  let state = await memoryHoliday(database);
  const deleted = structuredClone(state.data.trips[0].expenses[0]);
  database.sqlite.prepare('INSERT INTO receipts (id,owner,trip_id,created_at,state) VALUES (?,?,?,?,?)')
    .run('current-image', actor, 'trip-1', '2026-10-04T00:00:00Z', 'active');
  state.data.trips[0].expenses.push({ ...dinner(), id: 'current-context', receiptId: 'current-image', memory: { notes: '', aliases: [
    { name: 'My current meal', itemId: 'food', scopeMemberId: 'a' },
  ] }, conversation: [{ id: 'current-question', role: 'user', text: 'This is my current meal.', createdAt: '2026-10-04T20:35:00Z' }] });
  state = await store.writeLedger(actor, state.data, state.revision);
  state.data.trips[0].expenses = state.data.trips[0].expenses.filter(expense => expense.id !== deleted.id);
  state = await store.writeLedger(actor, state.data, state.revision);
  const current = state.data.trips[0].expenses[0];
  const original = database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get('trip-1')?.data;
  const beforeEvents = count(database);
  for (const hint of ['image', 'conversation'] as const) await context.test(hint, async () => {
    const changed = structuredClone(state.data);
    const restored = { ...deleted, memory: structuredClone(current.memory), ...(hint === 'image' ? { receiptId: current.receiptId } : { conversation: current.conversation }) };
    changed.trips[0].expenses.push(restored);
    await assert.rejects(store.writeLedger(actor, changed, state.revision), /Keep active other travellers/);
    assert.equal(database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get('trip-1')?.data, original);
    assert.equal(database.sqlite.prepare('SELECT revision FROM sync_state WHERE id=1').get()?.revision, state.revision);
    assert.equal(count(database), beforeEvents);
  });
});

test('historical alias restoration selects latest metadata before extracting a bounded alias snapshot', async context => {
  const database = await storage();
  let state = await memoryHoliday(database);
  const receipt = structuredClone(state.data.trips[0].expenses[0]);
  for (let index = 0; index < 5; index++) database.sqlite.prepare(`INSERT INTO activity_events
    (id,trip_id,actor_id,actor_name,created_at,entity_type,entity_id,action,before_data,after_data,revision,source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(`large-old-${index}`, 'trip-1', actor, 'Owner', '2026-10-04T20:00:00Z',
      'expense', receipt.id, 'update', null, JSON.stringify({ padding: 'x'.repeat(1_800_000) }), state.revision, 'web');
  state.data.trips[0].expenses = [];
  state = await store.writeLedger(actor, state.data, state.revision);
  const queries: string[] = [];
  const prepare = database.prepare.bind(database);
  context.mock.method(database, 'prepare', (sql: string) => { queries.push(sql); return prepare(sql); });
  state.data.trips[0].expenses = [receipt];
  const restored = await store.writeLedger(actor, state.data, state.revision);
  assert.deepEqual(restored.data.trips[0].expenses[0].memory, receipt.memory);
  const lookup = queries.find(sql => /memory\.aliases/.test(sql))!;
  assert.ok(lookup);
  const metadata = lookup.slice(0, lookup.indexOf('SELECT latest.entity_id'));
  assert.match(metadata, /MAX\(sequence\)/);
  assert.doesNotMatch(metadata, /before_data|after_data|json_extract/);
  assert.match(lookup, /JOIN activity_events e ON e\.sequence = latest\.sequence/);
});

test('restoring a fully deleted receipt verifies Bob’s speaker from immutable history despite forged client authors', async context => {
  const database = await storage();
  const holiday = trip(); holiday.expenses = [dinner()];
  await create(database, holiday);
  database.sqlite.prepare('INSERT INTO memberships (trip_id,user_id,member_id) VALUES (?,?,?)').run('trip-1', member, 'b');
  const bob = await store.readLedger(member);
  bob.data.trips[0].expenses[0].conversation = [{ id: 'bob-question', role: 'user', text: 'I had the dinner.', createdAt: '2026-10-04T20:31:00Z', itemId: 'food' }];
  await store.writeLedger(member, bob.data, bob.revision);
  let alice = await store.readLedger(actor);
  alice.data.trips[0].expenses = [];
  alice = await store.writeLedger(actor, alice.data, alice.revision);
  const deleted = lastEntity(await history(), 'expense', 'dinner');
  assert.equal(deleted.action, 'delete');
  const snapshot = structuredClone(deleted.before!) as unknown as Trip['expenses'][number];
  assert.equal(snapshot.conversation![0].authorMemberId, 'b');
  assert.equal(snapshot.conversation![0].authorName, 'Bob');
  const initialEvents = count(database);
  for (const [field, value] of [
    ['role', 'assistant'], ['text', 'Bob owes the entire holiday.'], ['createdAt', '2026-10-04T21:00:00Z'], ['replyTo', 'fake-question'], ['itemId', 'other-item'],
  ] as const) await context.test(`historical ${field} cannot be changed even without author claims`, async () => {
    const changed = structuredClone(alice.data);
    const forged = structuredClone(snapshot);
    delete forged.conversation![0].authorMemberId;
    delete forged.conversation![0].authorName;
    Object.assign(forged.conversation![0], { [field]: value });
    changed.trips[0].expenses = [forged];
    await assert.rejects(store.writeLedger(actor, changed, alice.revision), (error: unknown) => error instanceof store.RequestError && /Saved receipt messages cannot be edited/.test(error.message));
    assert.equal((await store.readLedger(actor)).data.trips[0].expenses.length, 0);
    assert.equal(database.sqlite.prepare('SELECT revision FROM sync_state WHERE id=1').get()?.revision, alice.revision);
    assert.equal(count(database), initialEvents);
  });
  database.sqlite.prepare('UPDATE profiles SET display_name=? WHERE id=?').run('Renamed Bob', member);
  const restored = structuredClone(snapshot);
  restored.conversation![0].authorMemberId = 'a';
  restored.conversation![0].authorName = 'Forged Alice';
  alice.data.trips[0].expenses = [restored];
  alice = await store.writeLedger(actor, alice.data, alice.revision);
  assert.deepEqual(alice.data.trips[0].expenses[0].conversation, snapshot.conversation);
  const event = lastEntity(await history(), 'expense', 'dinner');
  assert.equal(event.action, 'create');
  assert.equal(event.actorId, actor);
  assert.equal((event.after?.conversation as typeof snapshot.conversation)![0].authorMemberId, 'b');
  assert.equal((event.after?.conversation as typeof snapshot.conversation)![0].authorName, 'Bob');
});

test('restoring a fully deleted unlabelled legacy conversation keeps historical I unknown', async () => {
  const database = await storage();
  const holiday = trip(); holiday.expenses = [dinner()];
  let state = await create(database, holiday);
  state.data.trips[0].expenses[0].conversation = [{ id: 'legacy-question', role: 'user', text: 'I ordered the dinner.', createdAt: '2026-10-02T20:31:00Z', itemId: 'food' }];
  database.sqlite.prepare('UPDATE trips SET data=? WHERE id=?').run(JSON.stringify(state.data.trips[0]), 'trip-1');
  state = await store.readLedger(actor);
  state.data.trips[0].expenses = [];
  state = await store.writeLedger(actor, state.data, state.revision);
  const snapshot = structuredClone(lastEntity(await history(), 'expense', 'dinner').before!) as unknown as Trip['expenses'][number];
  state.data.trips[0].expenses = [snapshot];
  state = await store.writeLedger(actor, state.data, state.revision);
  const message = state.data.trips[0].expenses[0].conversation![0];
  assert.equal(message.authorMemberId, undefined);
  assert.equal(message.authorName, undefined);
  assert.deepEqual(message, snapshot.conversation![0]);
  assert.deepEqual(lastEntity(await history(), 'expense', 'dinner').after?.conversation, snapshot.conversation);
});

test('another trip’s historical message cannot prove a forged speaker and fresh IDs use the current authenticated author', async () => {
  const database = await storage();
  const holiday = trip(); holiday.expenses = [dinner()];
  await create(database, holiday);
  database.sqlite.prepare('INSERT INTO memberships (trip_id,user_id,member_id) VALUES (?,?,?)').run('trip-1', member, 'b');
  const bob = await store.readLedger(member);
  bob.data.trips[0].expenses[0].conversation = [{ id: 'bob-question', role: 'user', text: 'My dinner.', createdAt: '2026-10-04T20:31:00Z' }];
  const saved = await store.writeLedger(member, bob.data, bob.revision);
  const question = structuredClone(saved.data.trips[0].expenses[0].conversation![0]);
  let alice = await store.readLedger(actor);
  alice.data.trips.push(trip('other-trip'));
  alice = await store.writeLedger(actor, alice.data, alice.revision);
  alice.data.trips.find(value => value.id === 'other-trip')!.expenses = [{ ...dinner(), conversation: [
    question,
    { id: 'fresh-question', role: 'user', text: 'A new question.', createdAt: '2026-10-04T20:32:00Z', authorMemberId: 'b', authorName: 'Forged Bob' },
  ] }];
  alice = await store.writeLedger(actor, alice.data, alice.revision);
  const messages = alice.data.trips.find(value => value.id === 'other-trip')!.expenses[0].conversation!;
  for (const message of messages) {
    assert.equal(message.authorMemberId, 'a');
    assert.equal(message.authorName, 'Original Owner');
  }
  assert.equal(alice.data.trips.find(value => value.id === 'trip-1')!.expenses[0].conversation![0].authorMemberId, 'b');
});

test('unfamiliar message registry lookup is bounded to one hundred IDs per trip', async () => {
  const database = await storage();
  const state = await create(database);
  const initialEvents = count(database);
  const messages = Array.from({ length: 100 }, (_, index) => ({ id: `message-${index}`, role: 'user' as const, text: 'Question', createdAt: '2026-10-04T20:31:00Z' }));
  state.data.trips[0].drafts = [
    { ...dinner(), id: 'first-draft', status: 'review', conversation: messages },
    { ...dinner(), id: 'second-draft', status: 'review', conversation: [{ ...messages[0], id: 'one-too-many' }] },
  ];
  await assert.rejects(store.writeLedger(actor, state.data, state.revision), (error: unknown) => error instanceof store.RequestError && error.status === 400 && /no more than 100 receipt messages/.test(error.message));
  assert.equal(count(database), initialEvents);
  assert.equal((await store.readLedger(actor)).data.trips[0].drafts.length, 0);
  assert.equal(database.sqlite.prepare('SELECT revision FROM sync_state WHERE id=1').get()?.revision, state.revision);
  state.data.trips[0].drafts.pop();
  const saved = await store.writeLedger(actor, state.data, state.revision);
  assert.equal(saved.data.trips[0].drafts[0].conversation?.length, 100);
  for (const message of saved.data.trips[0].drafts[0].conversation!) assert.equal(message.authorMemberId, 'a');
});

test('registry migration backfills latest immutable and unlabelled live legacy messages once', async () => {
  const database = new SQLiteD1();
  for (const file of (await readdir(new URL('../drizzle/', import.meta.url))).filter(file => file.endsWith('.sql') && file < '0007').sort()) {
    database.sqlite.exec(await readFile(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'));
  }
  const question = { id: 'old-question', role: 'user', text: 'Older words', createdAt: '2026-10-04T20:30:00Z', authorMemberId: 'b', authorName: 'Bob' };
  const latest = { ...question, text: 'Latest trusted words' };
  const assistant = { id: 'old-answer', role: 'assistant', text: 'A reply', createdAt: '2026-10-04T20:31:00Z', replyTo: question.id, authorMemberId: 'a', authorName: 'Wrong traveller' };
  const live = trip(); live.expenses = [{ ...dinner(), conversation: [{ id: 'live-legacy', role: 'user', text: 'No old author', createdAt: '2026-10-04T20:32:00Z' }] }];
  database.sqlite.prepare('INSERT INTO trips (id,owner,data) VALUES (?,?,?)').run(live.id, actor, JSON.stringify(live));
  const snapshot = database.sqlite.prepare(`INSERT INTO activity_events
    (id,trip_id,actor_id,actor_name,created_at,entity_type,entity_id,action,before_data,after_data,revision,source)
    VALUES (?,?,?,?,?,'expense','dinner','update',?,?,1,'web')`);
  snapshot.run('historic', live.id, actor, 'Alice', '2026-10-04T21:00:00Z', JSON.stringify({ conversation: [question] }), JSON.stringify({ conversation: [latest, assistant] }));
  // Wrangler tokenizes migrations before D1 executes them. Running the full SQL
  // text directly would miss a broken trigger split at an expression's END.
  const { unstable_splitSqlQuery } = await import('wrangler');
  const statements = unstable_splitSqlQuery(await readFile(new URL('../drizzle/0007_receipt_message_registry.sql', import.meta.url), 'utf8'));
  assert.equal(statements.length, 8); assert.ok(!statements.some(statement => statement.trim() === 'END'));
  for (const statement of statements) database.sqlite.exec(statement);
  const message = (id: string) => JSON.parse(database.sqlite.prepare('SELECT message_data FROM receipt_messages WHERE trip_id=? AND message_id=?').get(live.id, id)?.message_data as string);
  assert.deepEqual(message(question.id), latest);
  assert.deepEqual(message('live-legacy'), live.expenses[0].conversation![0]);
  assert.deepEqual(message(assistant.id), { id: assistant.id, role: assistant.role, text: assistant.text, createdAt: assistant.createdAt, replyTo: question.id });
  assert.ok((database.sqlite.prepare('SELECT after_data FROM activity_events WHERE id=?').get('historic')?.after_data as string).includes('Wrong traveller'));
  assert.throws(() => database.sqlite.exec('UPDATE receipt_messages SET message_data=\'{}\''), /immutable/);
  assert.throws(() => database.sqlite.exec('DELETE FROM receipt_messages'), /immutable/);
  assert.throws(() => database.sqlite.prepare('INSERT OR REPLACE INTO receipt_messages VALUES (?,?,?)').run(live.id, question.id, '{}'), /immutable/);
});

test('fresh messages use an indexed registry lookup without scanning old snapshots or trusting dates', async () => {
  const database = await storage();
  let state = await create(database);
  for (let index = 0; index < 12; index++) {
    const legacy = { padding: 'x'.repeat(100_000), conversation: Array.from({ length: 100 }, (_, message) => ({
      id: `unrelated-${index}-${message}`, role: 'user', text: 'Older discussion '.repeat(30), createdAt: '2020-01-01T12:00:00Z',
    })) };
    database.sqlite.prepare(`INSERT INTO activity_events
      (id,trip_id,actor_id,actor_name,created_at,entity_type,entity_id,action,before_data,after_data,revision,source)
      VALUES (?,?,?,?,?,'expense',?,'update',?,?,?,'web')`).run(`unrelated-${index}`, 'trip-1', actor, 'Owner', '2026-10-04T00:00:00Z',
        `old-receipt-${index}`, JSON.stringify(legacy), JSON.stringify(legacy), state.revision);
  }
  const queries: string[] = [], prepare = database.prepare.bind(database);
  database.prepare = sql => { queries.push(sql); return prepare(sql); };
  state.data.trips[0].expenses = [{ ...dinner(), conversation: [{ id: 'fresh', role: 'user', text: 'New question', createdAt: '2099-01-01T12:00:00Z' }] }];
  state = await store.writeLedger(actor, state.data, state.revision);
  const lookups = queries.filter(sql => /SELECT message_data AS message FROM receipt_messages/.test(sql));
  assert.equal(lookups.length, 1); assert.ok(!queries.some(sql => /json_each\(snapshots\.data/.test(sql)));
  const plan = database.sqlite.prepare('EXPLAIN QUERY PLAN SELECT message_data FROM receipt_messages WHERE trip_id=? AND message_id IN (SELECT value FROM json_each(?)) LIMIT 100')
    .all('trip-1', '["fresh"]');
  assert.ok(plan.some(row => /SEARCH receipt_messages USING INDEX receipt_messages_trip_message_idx/.test(String(row.detail))));
  assert.equal(state.data.trips[0].expenses[0].conversation![0].authorName, 'Original Owner');
  const receipt = structuredClone(state.data.trips[0].expenses[0]);
  state.data.trips[0].expenses = []; state = await store.writeLedger(actor, state.data, state.revision);
  receipt.conversation![0].createdAt = '2099-02-01T12:00:00Z';
  state.data.trips[0].expenses = [receipt];
  await assert.rejects(store.writeLedger(actor, state.data, state.revision), /Saved receipt messages cannot be edited/);
});

test('message registry insertion and failed audit projections roll back with the financial CAS', async () => {
  const database = await storage();
  const state = await create(database); const initial = count(database);
  state.data.trips[0].expenses = [{ ...dinner(), conversation: [{ id: 'new', role: 'user', text: 'My dinner?', createdAt: '2026-10-04T20:31:00Z' }] }];
  database.sqlite.exec("CREATE TRIGGER refuse_message BEFORE INSERT ON receipt_messages BEGIN SELECT RAISE(ABORT,'registry unavailable'); END");
  await assert.rejects(store.writeLedger(actor, state.data, state.revision), /registry unavailable/);
  assert.equal(count(database), initial);
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM receipt_messages').get()?.count, 0);
  assert.equal(database.sqlite.prepare('SELECT revision FROM sync_state WHERE id=1').get()?.revision, state.revision);
  assert.equal((await store.readLedger(actor)).data.trips[0].expenses.length, 0);
  database.sqlite.exec('DROP TRIGGER refuse_message');
  const saved = await store.writeLedger(actor, state.data, state.revision);
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM receipt_messages').get()?.count, 1);
  assert.equal(saved.data.trips[0].expenses[0].conversation![0].authorName, 'Original Owner');
});

function ledgerReadRequest(condition?: string, user = actor) {
  return new Request('https://triptab.test/api/ledger', { headers: {
    'oai-authenticated-user-id': user,
    'oai-authenticated-user-email': user === actor ? 'owner@example.com' : 'member@example.com',
    'oai-authenticated-user-full-name': user === actor ? 'Original%20Owner' : 'Bob',
    ...(condition ? { 'If-None-Match': condition } : {}),
  } });
}

test('ledger reads seek only indexed accessible trips and memberships, retaining legacy money and authoritative links', async () => {
  const database = await storage();
  const legacy = seedLegacy(database);
  const shared = trip('shared-trip');
  shared.ownerId = 'forged'; shared.members[0].userId = 'forged'; shared.members[0].email = 'forged@example.test';
  database.sqlite.prepare('INSERT INTO trips(id,owner,data) VALUES(?,?,?)').run(shared.id,member,JSON.stringify(shared));
  database.sqlite.prepare('INSERT INTO memberships(trip_id,user_id,member_id) VALUES(?,?,?)').run(shared.id,actor,'a');
  database.sqlite.exec('BEGIN');
  const addTrip = database.sqlite.prepare('INSERT INTO trips(id,owner,data) VALUES(?,?,?)');
  const addMember = database.sqlite.prepare('INSERT INTO memberships(trip_id,user_id,member_id) VALUES(?,?,?)');
  for(let index=0;index<3000;index++) {
    addTrip.run(`private-${index}`,member,'{}');
    addMember.run(`private-${index}`,member,'private');
  }
  database.sqlite.exec('COMMIT');
  const batches: SQLiteStatement[][] = [];
  database.beforeBatch = statements => { batches.push(statements); };
  const snapshot = await store.readLedgerSnapshot(actor);
  assert.equal(batches.length,1); assert.equal(batches[0].length,3);
  assert.deepEqual(snapshot.data.trips.map(value=>value.id),[legacy.id,shared.id]);
  assert.deepEqual(snapshot.data.trips[0].expenses,legacy.expenses,'legacy bank charges are preserved');
  assert.equal(snapshot.data.trips[1].ownerId,member);
  assert.equal(snapshot.data.trips[1].members[0].userId,actor);
  assert.equal(snapshot.data.trips[1].members[0].email,'owner@example.com');
  assert.deepEqual(Object.keys(await store.readLedger(actor)).sort(),['data','revision']);
  assert.equal(batches[1].length, 3, 'MCP-style body reads retain one coherent transaction');
  assert.ok(!batches[1].some(statement => /activity_events|receipt_link_version/.test(statement.sql)),
    'body-only readers do not compute freshness metadata they discard');
  for(const statement of batches[0].filter(value=>value.sql.includes('FROM trips WHERE owner'))) {
    const plan=database.sqlite.prepare('EXPLAIN QUERY PLAN '+statement.sql).all(actor,actor).map(row=>String(row.detail));
    assert.ok(plan.some(line=>line.includes('trips_owner_idx') && line.includes('SEARCH')),JSON.stringify(plan));
    assert.ok(plan.some(line=>line.includes('memberships_user_idx') && line.includes('SEARCH')),JSON.stringify(plan));
    assert.ok(!plan.some(line=>/^SCAN (t|m|e)\b/.test(line)),JSON.stringify(plan));
  }
});

test('full ledger GET body, authoritative email, revision and ETag share one database snapshot', async () => {
  const database = await storage(); await create(database);
  database.sqlite.prepare('UPDATE profiles SET email=? WHERE id=?').run('updated@example.test',actor);
  const batches: SQLiteStatement[][] = [];
  database.beforeBatch = statements => { batches.push(statements); };
  const route = await ledgerRoute();
  const response = await route.GET(ledgerReadRequest());
  assert.equal(response.status,200);
  const body=await response.json() as Awaited<ReturnType<typeof store.readLedger>>;
  assert.equal(body.data.trips[0].members[0].email,'updated@example.test');
  assert.equal(response.headers.get('x-ledger-revision'),String(body.revision));
  assert.equal(response.headers.get('etag'),await ledgerEtag(database.asD1(),actor));
  const bodyBatches=batches.filter(statements=>statements.some(statement=>statement.sql.includes('t.data')));
  assert.equal(bodyBatches.length,1); assert.equal(bodyBatches[0].length,3);
  assert.ok(bodyBatches[0].some(statement=>statement.sql.includes('FROM sync_state')));
  assert.ok(bodyBatches[0].some(statement=>statement.sql.includes('p.email')));
  assert.equal(batches.filter(statements=>statements[0].sql.includes('SELECT t.id,') && !statements[0].sql.includes('t.data')).length,1,'only the explicit verification reads freshness metadata');
});

test('real ledger POST returns its saved body/revision/tag from one response snapshot and the next refresh is conditional', async () => {
  const database = await storage(); const initial = await create(database);
  const changed = structuredClone(initial.data); changed.trips[0].expenses.push(dinner());
  const batches: SQLiteStatement[][] = [];
  database.beforeBatch = statements => { batches.push(statements); };
  const route = await ledgerRoute();
  const response = await route.POST(saveRequest(changed, initial.revision));
  assert.equal(response.status, 200);
  const body = await response.json() as Awaited<ReturnType<typeof store.readLedger>>;
  assert.equal(body.revision, 2); assert.deepEqual(body.data.trips[0].expenses,
    changed.trips[0].expenses.map(expense => ({ ...expense, adjustmentAllocation: 'selected-participants' })));
  assert.deepEqual(Object.keys(body).sort(), ['data', 'revision']);
  assert.equal(response.headers.get('x-ledger-revision'), String(body.revision));
  const tag = response.headers.get('etag'); assert(tag);
  const reads = batches.filter(statements => statements.some(statement => statement.sql.includes('t.data')));
  assert.equal(reads.length, 1, 'one returned snapshot, with existing preimage authorization checks retained');
  assert.ok(reads[0].some(statement => statement.sql.includes('activity_events')), 'the returned snapshot includes coherent freshness');
  assert.equal(tag, await ledgerEtag(database.asD1(), actor));
  batches.length = 0;
  const unchanged = await route.GET(ledgerReadRequest(tag));
  assert.equal(unchanged.status, 304);
  assert.ok(!batches.some(statements => statements.some(statement => statement.sql.includes('t.data'))), 'post-save polling does not reload financial JSON');
});

test('unchanged conditional ledger GET avoids receipt JSON and updates the unrelated global CAS revision', async () => {
  const database = await storage(); await create(database);
  const tag=await ledgerEtag(database.asD1(),actor);
  // Another holiday advanced the global optimistic-lock token; this actor's body
  // and tag are unchanged and can retain their existing data.
  database.sqlite.prepare('UPDATE sync_state SET revision=revision+1').run();
  const batches: SQLiteStatement[][]=[];
  database.beforeBatch=statements=>{
    batches.push(statements);
    assert.ok(!statements.some(statement=>statement.sql.includes('t.data')),'304 must not select receipt JSON');
  };
  const response=await (await ledgerRoute()).GET(ledgerReadRequest(tag));
  assert.equal(response.status,304); assert.equal(response.body,null);
  assert.equal(response.headers.get('etag'),tag); assert.equal(response.headers.get('x-ledger-revision'),'2');
  assert.equal(batches.filter(statements=>statements[0].sql.includes('SELECT t.id,')).length,1);
  assert.equal(count(database),3,'an unchanged read adds no audit events');
});

test('changed conditional GET derives its tag from the later complete snapshot when a writer races metadata', async () => {
  const database=await storage(); const saved=await create(database);
  const changed=structuredClone(saved.data.trips[0]); changed.name='Concurrent name';
  let bodyReads=0;
  database.beforeBatch=statements=>{
    if(!statements.some(statement=>statement.sql.includes('t.data'))) return;
    bodyReads++;
    database.sqlite.prepare('UPDATE trips SET data=? WHERE id=?').run(JSON.stringify(changed),changed.id);
    database.sqlite.prepare('UPDATE sync_state SET revision=revision+1').run();
    database.sqlite.prepare(`INSERT INTO activity_events(id,trip_id,revision,actor_id,actor_name,entity_type,entity_id,action,before_data,after_data,source,created_at)
      VALUES('concurrent-name-change',?,2,?,?,'trip',?,'update',?,?,'web',?)`).run(changed.id,actor,'Original Owner',changed.id,JSON.stringify({name:'Lisbon'}),JSON.stringify({name:changed.name}),'2026-10-04T12:00:00Z');
  };
  const response=await (await ledgerRoute()).GET(ledgerReadRequest('W/"stale"'));
  database.beforeBatch=undefined;
  const body=await response.json() as Awaited<ReturnType<typeof store.readLedger>>;
  assert.equal(bodyReads,1); assert.equal(body.data.trips[0].name,'Concurrent name'); assert.equal(body.revision,2);
  assert.equal(response.headers.get('x-ledger-revision'),'2');
  assert.equal(response.headers.get('etag'),await ledgerEtag(database.asD1(),actor));
});

test('a membership revoked between conditional metadata and full read never reveals the lost trip', async () => {
  const database=await storage(); await create(database);
  database.sqlite.prepare('INSERT INTO memberships(trip_id,user_id,member_id) VALUES(?,?,?)').run('trip-1',member,'b');
  database.beforeBatch=statements=>{
    if(statements.some(statement=>statement.sql.includes('t.data'))) {
      database.sqlite.prepare('DELETE FROM memberships WHERE trip_id=? AND user_id=?').run('trip-1',member);
      database.sqlite.prepare('UPDATE sync_state SET revision=revision+1').run();
    }
  };
  const response=await (await ledgerRoute()).GET(ledgerReadRequest('W/"stale"',member));
  database.beforeBatch=undefined;
  assert.equal(response.status,200);
  const body=await response.json() as Awaited<ReturnType<typeof store.readLedger>>;
  assert.deepEqual(body.data.trips,[]); assert.equal(body.revision,2);
  assert.equal(response.headers.get('etag'),await ledgerEtag(database.asD1(),member));
});

test('native D1 ledger snapshots and conditional freshness agree without rewriting stored legacy receipts', async () => {
  const worker=new Miniflare({ modules:true, script:'export default {fetch(){return new Response("Ledger read test")}}',
    compatibilityDate:'2026-05-15',d1Databases:{DB:'ledger-read-native'},d1Persist:false,log:new Log(LogLevel.NONE) });
  try {
    const database=await worker.getD1Database('DB');
    for(const file of (await readdir(new URL('../drizzle/',import.meta.url))).filter(file=>file.endsWith('.sql')).sort()) {
      const sql=unstable_splitSqlQuery(await readFile(new URL('../drizzle/'+file,import.meta.url),'utf8'));
      await database.batch(sql.map(statement=>database.prepare(statement)));
    }
    binding.DB=database as unknown as D1Database;
    const holiday=trip('native-shared'); holiday.ownerId='forged';
    holiday.expenses=[{...dinner(),bankAmount:0,conversation:[{id:'old-answer',role:'assistant',text:'Earlier reply',createdAt:'2026-10-04T20:31:00Z',authorMemberId:'a',authorName:'Wrong legacy attribution'}]}];
    const raw=JSON.stringify(holiday);
    await database.batch([
      database.prepare('INSERT INTO profiles(id,email,display_name,created_at) VALUES(?,?,?,?)').bind(actor,'owner@example.com','Original Owner','2026-10-04T00:00:00Z'),
      database.prepare('INSERT INTO profiles(id,email,display_name,created_at) VALUES(?,?,?,?)').bind(member,'member@example.com','Bob','2026-10-04T00:00:00Z'),
      database.prepare('INSERT INTO trips(id,owner,data) VALUES(?,?,?)').bind(holiday.id,actor,raw),
      database.prepare('INSERT INTO memberships(trip_id,user_id,member_id) VALUES(?,?,?)').bind(holiday.id,actor,'a'),
      database.prepare('INSERT INTO memberships(trip_id,user_id,member_id) VALUES(?,?,?)').bind(holiday.id,member,'b'),
      database.prepare('INSERT INTO sync_state(id,revision,last_write) VALUES(1,4,?)').bind('native-fixture'),
    ]);
    const initial=await store.readLedgerSnapshot(actor);
    const current=await readLedgerFreshness(database as unknown as D1Database,actor);
    assert.equal(await ledgerEtagForSnapshot(initial.freshness),current.etag);
    assert.equal(initial.revision,current.revision); assert.equal(initial.revision,4);
    assert.equal(initial.data.trips[0].ownerId,actor); assert.equal(initial.data.trips[0].expenses[0].bankAmount,0);
    assert.equal(initial.data.trips[0].expenses[0].conversation![0].authorName,undefined);
    await database.prepare('UPDATE profiles SET email=? WHERE id=?').bind('current@example.com',actor).run();
    const updated=await store.readLedgerSnapshot(actor);
    assert.equal(updated.data.trips[0].members[0].email,'current@example.com');
    assert.notEqual(await ledgerEtagForSnapshot(updated.freshness),current.etag);
    assert.equal(await ledgerEtagForSnapshot(updated.freshness),await ledgerEtag(database as unknown as D1Database,actor));
    assert.equal((await database.prepare('SELECT data FROM trips WHERE id=?').bind(holiday.id).first<{data:string}>())!.data,raw);
    assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM activity_events').first<{count:number}>())!.count,0);
    assert.equal((await store.readLedgerSnapshot(member)).data.trips.length,1);
    await database.prepare('DELETE FROM memberships WHERE trip_id=? AND user_id=?').bind(holiday.id,member).run();
    const outsider=await store.readLedgerSnapshot(member);
    assert.deepEqual(outsider.data.trips,[]);
    assert.equal(await ledgerEtagForSnapshot(outsider.freshness),await ledgerEtag(database as unknown as D1Database,member));
  } finally { binding.DB=undefined; await worker.dispose(); }
});

test('native conditional GET follows silent trip normalization without fabricating activity and keeps genuine no-op saves cached', async () => {
  const worker=new Miniflare({ modules:true, script:'export default {fetch(){return new Response("Ledger version test")}}',
    compatibilityDate:'2026-05-15',d1Databases:{DB:'ledger-body-version-native'},d1Persist:false,log:new Log(LogLevel.NONE) });
  try {
    const database=await worker.getD1Database('DB');
    for(const file of (await readdir(new URL('../drizzle/',import.meta.url))).filter(file=>file.endsWith('.sql')).sort()) {
      await database.batch(unstable_splitSqlQuery(await readFile(new URL('../drizzle/'+file,import.meta.url),'utf8')).map(sql=>database.prepare(sql)));
    }
    binding.DB=database as unknown as D1Database;
    const holiday=trip('native-normalization');
    // Pre-existing schemas accepted whitespace that current parsing trims. This
    // setup is isolated native D1, never a mutation of a shared/prod fixture.
    holiday.payments=[{id:'paid',from:'a',to:'b',amount:100,date:'2026-10-04',method:'  Cash  ',note:'  Earlier note  '}];
    await database.batch([
      database.prepare('INSERT INTO profiles(id,email,display_name,created_at) VALUES(?,?,?,?)').bind(actor,'owner@example.com','Original Owner','2026-10-04T00:00:00Z'),
      database.prepare('INSERT INTO trips(id,owner,data) VALUES(?,?,?)').bind(holiday.id,actor,JSON.stringify(holiday)),
      database.prepare('INSERT INTO memberships(trip_id,user_id,member_id) VALUES(?,?,?)').bind(holiday.id,actor,'a'),
      database.prepare('INSERT INTO sync_state(id,revision,last_write) VALUES(1,4,?)').bind('legacy-setup'),
    ]);
    const route=await ledgerRoute(),initial=await route.GET(ledgerReadRequest());
    const cached=await initial.json() as Awaited<ReturnType<typeof store.readLedger>>;
    const oldTag=initial.headers.get('etag')!;
    assert.equal(cached.data.trips[0].payments[0].method,'  Cash  ');
    const normalized=await store.writeLedger(actor,cached.data,cached.revision);
    assert.equal(normalized.data.trips[0].payments[0].method,'Cash');
    assert.equal(normalized.data.trips[0].payments[0].note,'Earlier note');
    assert.equal(normalized.data.trips[0].payments[0].amount,100);
    assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM activity_events').first<{count:number}>())!.count,0);
    const newTag=await ledgerEtag(database as unknown as D1Database,actor);
    assert.notEqual(newTag,oldTag,'A visible body normalization without participant activity must invalidate its cached representation');
    const refreshed=await route.GET(ledgerReadRequest(oldTag));
    assert.equal(refreshed.status,200,'Never attach the newer CAS revision to stale cached data after an unlogged body write');
    assert.deepEqual(await refreshed.json(),normalized);assert.equal(refreshed.headers.get('etag'),newTag);

    const unchanged=await store.writeLedger(actor,normalized.data,normalized.revision);
    assert.equal(unchanged.revision,normalized.revision+1);
    assert.deepEqual(unchanged.data,normalized.data);
    assert.equal(await ledgerEtag(database as unknown as D1Database,actor),newTag,'An unchanged body and activity can retain the same tag despite a newer global CAS revision');
    const noOp=await route.GET(ledgerReadRequest(newTag));
    assert.equal(noOp.status,304);assert.equal(noOp.headers.get('x-ledger-revision'),String(unchanged.revision));
    assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM activity_events').first<{count:number}>())!.count,0);
  } finally { binding.DB=undefined;await worker.dispose(); }
});

test('successful ledger POST returns the ETag of its exact response snapshot for conditional refresh', async () => {
  const database = await storage(); const initial = await create(database);
  const request = new Request('https://triptab.test/api/ledger', {method:'POST', headers:{'origin':'https://triptab.test','content-type':'application/json','oai-authenticated-user-id':actor,'oai-authenticated-user-email':'owner@example.com','oai-authenticated-user-full-name':'Original%20Owner'}, body:JSON.stringify(initial)});
  const route = await ledgerRoute(); const response = await route.POST(request);
  assert.equal(response.status, 200);
  const body = await response.json() as typeof initial;
  const tag = response.headers.get('etag'); assert.equal(tag, await ledgerEtag(database.asD1(), actor));
  assert.equal(response.headers.get('x-ledger-revision'), String(body.revision));
  assert.deepEqual(Object.keys(body).sort(), ['data','revision']);
  assert.equal((await route.GET(ledgerReadRequest(tag!))).status, 304);
});
