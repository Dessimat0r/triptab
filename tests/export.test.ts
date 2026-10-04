import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { hashToken } from '../lib/auth';
import type { Trip } from '../lib/model';
import type { ActivityEvent } from '../lib/store';

type Snapshot = { profile: Record<string, unknown>; data: { trips: Trip[] }; amountScale: number; exportedAt: string; receiptMetadata?: { id: string; tripId: string }[] };
type HistoryPage = { events: ActivityEvent[]; nextCursor: number | null };
async function json<T>(response: Response): Promise<T> { return await response.json() as T; }

class SQLiteStatement {
  private values: (string | number | null)[] = [];
  constructor(private readonly database: SQLiteD1, readonly sql: string) {}
  bind(...values: (string | number | null)[]) { this.values = values; return this; }
  async first<T>() { this.database.read(this.sql); return (this.database.sqlite.prepare(this.sql).get(...this.values) || null) as T | null; }
  async all<T>() { this.database.read(this.sql); return { results: this.database.sqlite.prepare(this.sql).all(...this.values) as T[] }; }
  runSync() {
    this.database.read(this.sql);
    const statement = this.database.sqlite.prepare(this.sql);
    const results = statement.columns().length ? statement.all(...this.values) : (statement.run(...this.values), []);
    return { results, success: true, meta: { changes: Number(this.database.sqlite.prepare('SELECT changes() AS changes').get()?.changes || 0) } };
  }
  async run() { return this.runSync(); }
}
class SQLiteD1 {
  readonly sqlite = new DatabaseSync(':memory:');
  readonly queries: string[] = [];
  beforeRead?: (sql: string) => void;
  read(sql: string) { this.queries.push(sql); this.beforeRead?.(sql); }
  prepare(sql: string) { return new SQLiteStatement(this, sql); }
  async batch(statements: SQLiteStatement[]) {
    this.sqlite.exec('BEGIN');
    try { const results = statements.map(statement => statement.runSync()); this.sqlite.exec('COMMIT'); return results; }
    catch (cause) { this.sqlite.exec('ROLLBACK'); throw cause; }
  }
  asD1() { return this as unknown as D1Database; }
}

// The route, session resolution and SQL are real; only Worker bindings and
// background notifications are replaced for Node's native SQLite harness.
const binding: { DB?: D1Database } = {};
Object.defineProperty(globalThis, Symbol.for('triptab.export-test-env'), { value: binding, configurable: true });
const envUrl = 'data:text/javascript;base64,' + Buffer.from("export const env=globalThis[Symbol.for('triptab.export-test-env')];").toString('base64');
const notificationUrl = 'data:text/javascript;base64,' + Buffer.from('export const activityNotification=()=>null; export const notifyMembers=async()=>{};').toString('base64');
const storeSource = await readFile(new URL('../lib/store.ts', import.meta.url), 'utf8');
const storeCompiled = transpileModule(storeSource, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText
  .replace("'cloudflare:workers'", JSON.stringify(envUrl))
  .replace("'zod'", JSON.stringify(import.meta.resolve('zod')))
  .replace("'./model'", JSON.stringify(new URL('../lib/model.ts', import.meta.url).href))
  .replace("'./auth'", JSON.stringify(new URL('../lib/auth.ts', import.meta.url).href))
  .replace("'./receipt-lifecycle'", JSON.stringify(new URL('../lib/receipt-lifecycle.ts', import.meta.url).href))
  .replace("'./receipt-context'", JSON.stringify(new URL('../lib/receipt-context.ts', import.meta.url).href))
  .replace("'./notifications'", JSON.stringify(notificationUrl));
const storeUrl = 'data:text/javascript;base64,' + Buffer.from(storeCompiled).toString('base64');
const store = await import(storeUrl) as typeof import('../lib/store');
const routeSource = await readFile(new URL('../app/api/export/route.ts', import.meta.url), 'utf8');
const routeCompiled = transpileModule(routeSource, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText
  .replace("'@/lib/store'", JSON.stringify(storeUrl))
  .replace("'@/lib/model'", JSON.stringify(new URL('../lib/model.ts', import.meta.url).href));
const route = await import('data:text/javascript;base64,' + Buffer.from(routeCompiled).toString('base64')) as { GET(request: Request): Promise<Response> };
const tokens = { owner: 'a'.repeat(43), joined: 'b'.repeat(43), outsider: 'c'.repeat(43) };

function holiday(id: string, owner: string): Trip {
  return {
    id, ownerId: owner, name: id === 'secret' ? 'NEVER_EXPORT_PRIVATE_TRIP' : `Holiday ${id}`, currency: 'GBP',
    members: [{ id: 'a', name: 'Alice', userId: owner }, { id: 'b', name: 'Bob' }],
    expenses: [{ id: 'expense', title: 'Dinner', date: '2026-10-04', time: '20:30', timezone: 'Europe/Lisbon', currency: 'EUR', bankAmount: 8700, payer: 'a', items: [{ id: 'food', name: 'Food', amount: 10000, members: ['a', 'b'] }], tax: 0, tip: 0, discount: 0, receiptId: `photo-${id}` }],
    payments: [{ id: 'payment', from: 'b', to: 'a', amount: 1000, date: '2026-10-04', time: '21:45', timezone: 'Europe/Lisbon', method: 'Cash', note: 'A partial payment' }],
    drafts: [],
  };
}
function seedEvent(database: SQLiteD1, tripId: string, text = 'Dinner', actorName = 'Alice') {
  database.sqlite.prepare('INSERT INTO activity_events (id,trip_id,actor_id,actor_name,created_at,entity_type,entity_id,action,before_data,after_data,revision,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(crypto.randomUUID(), tripId, 'owner', actorName, '2026-10-04T03:00:00+02:00', 'expense', 'expense', 'update', null, JSON.stringify({ title: text }), 1, 'web');
}
async function storage() {
  const database = new SQLiteD1();
  for (const file of (await readdir(new URL('../drizzle/', import.meta.url))).filter(file => file.endsWith('.sql')).sort()) database.sqlite.exec(await readFile(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'));
  for (const [actor, token] of Object.entries(tokens)) {
    database.sqlite.prepare('INSERT INTO profiles (id,email,display_name,created_at) VALUES (?,?,?,?)').run(actor, actor === 'outsider' ? 'NEVER_EXPORT_OTHER_PROFILE@example.com' : `${actor}@example.com`, actor, '2026-10-04T01:00:00+01:00');
    database.sqlite.prepare('INSERT INTO auth_sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)').run(await hashToken(token), actor, new Date(Date.now() + 3_600_000).toISOString(), new Date().toISOString());
  }
  for (const [id, actor] of [['mine', 'owner'], ['shared', 'outsider'], ['secret', 'outsider']]) {
    const trip = holiday(id, actor);
    if (id === 'shared') trip.members[1].userId = 'joined';
    database.sqlite.prepare('INSERT INTO trips (id,owner,data) VALUES (?,?,?)').run(id, actor, JSON.stringify(trip));
    database.sqlite.prepare('INSERT INTO receipts (id,owner,trip_id) VALUES (?,?,?)').run(`photo-${id}`, actor, id);
    seedEvent(database, id, id === 'secret' ? 'NEVER_EXPORT_PRIVATE_EVENT' : 'Dinner');
  }
  database.sqlite.prepare('INSERT INTO memberships (trip_id,user_id,member_id) VALUES (?,?,?)').run('shared', 'joined', 'b');
  database.sqlite.prepare('INSERT INTO auth_credentials (user_id,email,password_hash,password_salt,iterations,created_at) VALUES (?,?,?,?,?,?)').run('owner', 'owner@example.com', 'NEVER_EXPORT_PASSWORD_HASH', 'NEVER_EXPORT_PASSWORD_SALT', 100000, new Date().toISOString());
  database.sqlite.prepare('INSERT INTO auth_links (oai_user_id,user_id,created_at) VALUES (?,?,?)').run('NEVER_EXPORT_PROVIDER_LINK', 'owner', new Date().toISOString());
  database.sqlite.prepare('INSERT INTO invites (token_hash,trip_id,member_id,email,expires_at,used_by,created_by) VALUES (?,?,?,?,?,?,?)').run('NEVER_EXPORT_INVITE_TOKEN', 'mine', 'b', null, '2099-01-01T00:00:00Z', null, 'owner');
  binding.DB = database.asD1();
  return database;
}
function request(query = '', actor: keyof typeof tokens | null = 'owner', headers: Record<string, string> = {}) {
  return new Request(`https://triptab.test/api/export${query ? `?${query}` : ''}`, { headers: { ...(actor ? { cookie: `tt_session=${tokens[actor]}` } : {}), ...headers } });
}
function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (char === '"') {
      if (quoted && input[index + 1] === '"') { cell += '"'; index++; }
      else quoted = !quoted;
    } else if (!quoted && char === ',') { row.push(cell); cell = ''; }
    else if (!quoted && char === '\r' && input[index + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; index++; }
    else cell += char;
  }
  assert.equal(quoted, false);
  assert.equal(cell, '');
  return rows;
}

test('account JSON requires a real session and includes only own profile and currently accessible trips', async () => {
  const database = await storage();
  assert.equal((await route.GET(request('', null))).status, 401);
  const response = await route.GET(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-disposition')!, /^attachment; filename="triptab-account-\d{4}-\d{2}-\d{2}\.json"$/);
  const body = await json<Snapshot>(response);
  assert.deepEqual(body.profile, { id: 'owner', email: 'owner@example.com', displayName: 'owner', createdAt: '2026-10-04T00:00:00.000Z' });
  assert.deepEqual(body.data.trips.map((trip: Trip) => trip.id), ['mine']);
  assert.equal(body.amountScale, 100);
  assert.match(body.exportedAt, /Z$/);
  assert.doesNotMatch(JSON.stringify(body), /NEVER_EXPORT/);
  assert.ok(database.queries.every(sql => !/auth_credentials|auth_links|invites/.test(sql)), 'export must not inspect credential, provider or invite tables');
  const shared = await json<Snapshot>(await route.GET(request('', 'joined')));
  assert.deepEqual(shared.data.trips.map((trip: Trip) => trip.id), ['shared']);
  assert.equal(shared.profile.id, 'joined');
});

test('scoped trip exports reject foreign trips, SQL-like IDs and cross-origin browser requests', async () => {
  await storage();
  for (const query of ['scope=trip&tripId=secret', 'scope=activity&tripId=secret', 'scope=trip&tripId=mine%27%20OR%201%3D1--']) assert.equal((await route.GET(request(query))).status, 403, query);
  for (const headers of [{ origin: 'https://evil.test' }, { 'sec-fetch-site': 'cross-site' }] as Record<string, string>[]) assert.equal((await route.GET(request('', 'owner', headers))).status, 403);
  assert.equal((await route.GET(request('', 'owner', { origin: 'https://triptab.test' }))).status, 200);
});

test('trip receipt metadata includes attached authorized IDs, never raw storage or foreign references', async () => {
  const database = await storage();
  database.sqlite.prepare('INSERT INTO receipts (id,owner,trip_id) VALUES (?,?,?)').run('orphan-photo', 'owner', 'mine');
  let body = await json<Snapshot>(await route.GET(request('scope=trip&tripId=mine&receipts=1')));
  assert.deepEqual(body.receiptMetadata, [{ id: 'photo-mine', tripId: 'mine' }]);
  assert.equal(Object.keys(body.receiptMetadata![0]).includes('owner'), false);
  assert.equal('receipts' in body, false);
  const trip = holiday('mine', 'owner'); trip.expenses[0].receiptId = 'photo-secret';
  database.sqlite.prepare('UPDATE trips SET data=? WHERE id=?').run(JSON.stringify(trip), 'mine');
  body = await json<Snapshot>(await route.GET(request('scope=trip&tripId=mine&receipts=1')));
  assert.deepEqual(body.receiptMetadata, []);
  assert.ok(database.queries.every(sql => !/SELECT[\s\S]*\bowner\b[\s\S]*FROM receipts/i.test(sql)), 'receipt export contains only IDs');
});

test('financial CSV preserves amounts and RFC4180 notes while neutralizing formula cells and headers', async () => {
  const database = await storage();
  const trip = holiday('mine', 'owner');
  trip.members[0].name = ' +SUM(1,2)';
  trip.expenses[0].title = '=HYPERLINK("https://evil.test", "click")';
  trip.payments[0].note = '\t=cmd\r\nSecond line, with "quotes"';
  trip.payments[0].method = '@formula';
  database.sqlite.prepare('UPDATE trips SET data=? WHERE id=?').run(JSON.stringify(trip), 'mine');
  const response = await route.GET(request('scope=trip&tripId=mine&format=csv'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/csv; charset=utf-8');
  const rows = parseCsv(await response.text());
  assert.equal(rows.length, 3);
  assert.ok(rows.every(row => row.length === rows[0].length));
  const index = (name: string) => rows[0].indexOf(name);
  assert.equal(rows[1][index('title')], "'" + trip.expenses[0].title);
  assert.equal(rows[1][index('paid_by')], "'" + trip.members[0].name);
  assert.equal(rows[2][index('note')], "'" + trip.payments[0].note!.trim());
  assert.equal(rows[2][index('payment_method')], "'@formula");
  assert.ok(rows[0].some(header => header.startsWith("' +SUM")));
  assert.equal(rows[1][index('receipt_amount_hundredths')], '10000');
  assert.equal(rows[1][index('settlement_amount_hundredths')], '8700');
  assert.equal(rows[2][index('settlement_amount')], '10.00');
  assert.equal(rows[1][index('transaction_timezone')], 'Europe/Lisbon');
  const snapshot = await json<Snapshot>(await route.GET(request('scope=trip&tripId=mine')));
  assert.equal(snapshot.data.trips[0].expenses[0].title, trip.expenses[0].title, 'JSON keeps the literal stored value');
});

test('real saved receipt units, memory and item conversation survive authorized JSON and item-detail CSV exports', async () => {
  const database = await storage();
  const trip = holiday('mine', 'owner');
  const expense = trip.expenses[0];
  expense.currency = 'GBP';
  delete expense.bankAmount;
  expense.items = [{ id: 'chocolate', name: 'Chocolate, "dark"\nThree blocks', amount: 1001, members: ['a', 'b'], units: { total: 3, label: 'blocks', allocations: { a: 2.5, b: 0.5 } } }];
  expense.memory = { notes: 'Treat "blocks" as chocolate.\nKeep this context for later questions.', aliases: [{ name: 'blocks', itemId: 'chocolate' }, { name: 'me', memberId: 'b', scopeMemberId: 'b' }] };
  expense.conversation = [{ id: 'item-question', role: 'user', text: 'Which blocks are mine?', createdAt: '2026-10-04T12:00:00Z', itemId: 'chocolate', authorMemberId: 'b', authorName: 'Bob' }];
  // Preserve a historical authored thread, then change the receipt through the
  // actual validator/CAS/storage path rather than testing a constructed CSV.
  database.sqlite.prepare('UPDATE trips SET data=? WHERE id=?').run(JSON.stringify(trip), 'mine');
  database.sqlite.prepare('INSERT INTO memberships (trip_id,user_id,member_id) VALUES (?,?,?)').run('mine', 'owner', 'a');
  const edited = structuredClone(trip);
  edited.expenses[0].memory!.notes += '\nBob calls them pieces.';
  edited.drafts = [{ ...structuredClone(edited.expenses[0]), id: 'receipt-review', expenseId: expense.id, status: 'review' }];
  const saved = await store.writeLedger('owner', { trips: [edited] }, 0);

  for (const query of ['', 'scope=trip&tripId=mine']) {
    const response = await route.GET(request(query));
    assert.equal(response.status, 200);
    const exported = (await json<Snapshot>(response)).data.trips[0];
    assert.deepEqual(exported.expenses[0].items, saved.data.trips[0].expenses[0].items);
    assert.deepEqual(exported.expenses[0].memory, edited.expenses[0].memory);
    assert.deepEqual(exported.drafts[0].memory, edited.expenses[0].memory);
    assert.deepEqual(exported.expenses[0].conversation, expense.conversation);
    assert.deepEqual(exported.drafts[0].conversation, expense.conversation);
  }

  const financialRows = parseCsv(await (await route.GET(request('scope=trip&tripId=mine&format=csv'))).text());
  const header = financialRows[0];
  assert.equal(header.at(-1), 'item_details_json', 'new details append after all existing columns');
  assert.equal(header[8], 'receipt_amount');
  assert.equal(header[27], 'Alice_cost_share_hundredths');
  assert.ok(financialRows.every(row => row.length === header.length));
  assert.equal(financialRows[1][header.indexOf('receipt_amount_hundredths')], '1001', 'line amount is the full price, not a per-unit price');
  assert.equal(financialRows[1][header.indexOf('Alice_cost_share_hundredths')], '834');
  assert.equal(financialRows[1][header.indexOf('Bob_cost_share_hundredths')], '167');
  assert.deepEqual(JSON.parse(financialRows[1].at(-1)!), expense.items);
  assert.equal(financialRows[2].at(-1), '', 'payment rows have no item detail');
  const history = await json<HistoryPage>(await route.GET(request('scope=activity&tripId=mine')));
  const changed = history.events.find(event => event.entityType === 'expense' && event.entityId === expense.id && event.action === 'update');
  assert.deepEqual(changed?.after?.memory, edited.expenses[0].memory);
  assert.deepEqual(changed?.after?.items, expense.items);

  // A whole-receipt percentage split still controls financial totals while
  // the saved unit assignments remain available in the exported detail.
  const overridden = structuredClone(saved.data.trips[0]);
  overridden.expenses[0].percentages = { a: 25, b: 75 };
  await store.writeLedger('owner', { trips: [overridden] }, saved.revision);
  const overriddenRows = parseCsv(await (await route.GET(request('scope=trip&tripId=mine&format=csv'))).text());
  assert.equal(overriddenRows[1][header.indexOf('Alice_cost_share_hundredths')], '250');
  assert.equal(overriddenRows[1][header.indexOf('Bob_cost_share_hundredths')], '751');
  assert.deepEqual(JSON.parse(overriddenRows[1].at(-1)!), expense.items);
});

test('history pages are bounded, cursor-complete, UTC, scoped and safe as CSV', async () => {
  const database = await storage();
  for (let index = 0; index < 63; index++) seedEvent(database, 'shared', `Change ${index}`, '=FORMULA');
  const firstResponse = await route.GET(request('scope=activity&tripId=shared', 'joined'));
  const first = await json<HistoryPage>(firstResponse);
  assert.equal(first.events.length, 50);
  assert.ok(first.nextCursor! > 0);
  assert.equal(firstResponse.headers.get('x-export-next-cursor'), String(first.nextCursor));
  assert.ok(first.events.every((event: { tripId: string; createdAt: string }) => event.tripId === 'shared' && event.createdAt === '2026-10-04T01:00:00.000Z'));
  const second = await json<HistoryPage>(await route.GET(request(`scope=activity&tripId=shared&before=${first.nextCursor}`, 'joined')));
  assert.equal(second.events.length, 14);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.events, ...second.events].map(event => event.id)).size, 64);
  const rows = parseCsv(await (await route.GET(request('scope=activity&tripId=shared&format=csv', 'joined'))).text());
  assert.equal(rows[0][5], 'created_at_utc');
  assert.equal(rows[1][4], "'=FORMULA");
  assert.equal(rows[1][5], '2026-10-04T01:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(first), /NEVER_EXPORT_PRIVATE_EVENT/);
});

test('membership changes are rechecked in data queries and remove access to later exports', async () => {
  const database = await storage();
  database.beforeRead = sql => {
    if (/WITH candidates/.test(sql)) { database.beforeRead = undefined; database.sqlite.prepare('DELETE FROM memberships WHERE trip_id=? AND user_id=?').run('shared', 'joined'); }
  };
  const response = await route.GET(request('scope=activity&tripId=shared', 'joined'));
  if (response.status === 200) assert.deepEqual((await json<HistoryPage>(response)).events, []);
  else assert.equal(response.status, 403);
  assert.equal((await route.GET(request('scope=trip&tripId=shared', 'joined'))).status, 403);
  const account = await json<Snapshot>(await route.GET(request('', 'joined')));
  assert.deepEqual(account.data.trips, []);
});

test('history byte budgets return smaller complete pages and oversized account exports ask for one trip', async () => {
  const database = await storage();
  const large = 'x'.repeat(1_100_000);
  for (let index = 0; index < 5; index++) seedEvent(database, 'mine', large);
  const page = await json<HistoryPage>(await route.GET(request('scope=activity&tripId=mine')));
  assert.equal(page.events.length, 3);
  assert.ok(page.nextCursor! > 0);
  const remainder = await json<HistoryPage>(await route.GET(request(`scope=activity&tripId=mine&before=${page.nextCursor}`)));
  assert.equal(remainder.events.length, 3);
  assert.equal(remainder.nextCursor, null);
  const oversized = holiday('oversized', 'owner');
  database.sqlite.prepare('INSERT INTO trips (id,owner,data) VALUES (?,?,?)').run('oversized', 'owner', JSON.stringify({ ...oversized, name: 'x'.repeat(4_200_000) }));
  assert.equal((await route.GET(request())).status, 413);
  assert.equal((await route.GET(request('scope=trip&tripId=mine'))).status, 200);
});

test('malformed options and legacy calculation failures never discard saved records', async () => {
  const database = await storage();
  for (const query of ['scope=trip', 'format=csv', 'scope=trip&tripId=mine&tripId=secret', 'scope=activity&tripId=mine&before=0', 'scope=activity&tripId=mine&before=9007199254740992', 'scope=trip&tripId=mine&before=4', 'scope=account&receipts=1', 'scope=trip&tripId=mine&receipts=maybe', 'extra=1', 'scope=bad']) {
    const response = await route.GET(request(query));
    assert.equal(response.status, 400, query);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
  const trip = holiday('mine', 'owner'); trip.expenses[0].currency = 'GBP';
  database.sqlite.prepare('UPDATE trips SET data=? WHERE id=?').run(JSON.stringify(trip), 'mine');
  const response = await route.GET(request('scope=trip&tripId=mine&format=csv'));
  assert.equal(response.status, 200);
  const rows = parseCsv(await response.text());
  assert.match(rows[1][rows[0].indexOf('calculation_error')], /Remove the bank charge/);
  assert.equal(rows[1][rows[0].indexOf('bank_charge_hundredths')], '8700');
  assert.equal(rows[1][rows[0].indexOf('settlement_amount_hundredths')], '');
});
