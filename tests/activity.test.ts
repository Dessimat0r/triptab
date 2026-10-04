import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { hashToken } from '../lib/auth';
import { receiptActivityScope } from '../lib/activity-scope';
import type { ActivityEntity, ActivityEvent, ActivitySource } from '../lib/audit';
import type { Trip } from '../lib/model';

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
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  asD1() { return this as unknown as D1Database; }
}

// Real SQLite migrations, session identity, receipt-family SQL and route. Only
// Worker bindings and background notification delivery are substituted.
const binding: { DB?: D1Database } = {};
Object.defineProperty(globalThis, Symbol.for('triptab.activity-test-env'), { value: binding, configurable: true });
const dataUrl = (source: string) => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const envUrl = dataUrl("export const env=globalThis[Symbol.for('triptab.activity-test-env')];");
const notificationUrl = dataUrl('export const activityNotification=()=>null; export const notifyMembers=async()=>{};');
const compile = (source: string) => transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText;
const storeUrl = dataUrl(compile(await readFile(new URL('../lib/store.ts', import.meta.url), 'utf8'))
  .replace("'cloudflare:workers'", JSON.stringify(envUrl))
  .replace("'zod'", JSON.stringify(import.meta.resolve('zod')))
  .replace("'./model'", JSON.stringify(new URL('../lib/model.ts', import.meta.url).href))
  .replace("'./auth'", JSON.stringify(new URL('../lib/auth.ts', import.meta.url).href))
  .replace("'./activity-scope'", JSON.stringify(new URL('../lib/activity-scope.ts', import.meta.url).href))
  .replace("'./receipt-lifecycle'", JSON.stringify(new URL('../lib/receipt-lifecycle.ts', import.meta.url).href))
  .replaceAll("'./audit'", JSON.stringify(new URL('../lib/audit.ts', import.meta.url).href))
  .replace("'./notifications'", JSON.stringify(notificationUrl)));
const store = await import(storeUrl) as typeof import('../lib/store');
const route = await import(dataUrl(compile(await readFile(new URL('../app/api/activity/route.ts', import.meta.url), 'utf8'))
  .replace("'@/lib/store'", JSON.stringify(storeUrl)))) as { GET(request: Request): Promise<Response> };
const tokens = { owner: 'a'.repeat(43), joined: 'b'.repeat(43), outsider: 'c'.repeat(43) };
type Page = { events: ActivityEvent[]; nextCursor: number | null };
const snapshot = (id: string, receiptId?: string) => ({ id, title: id, date: '2026-10-04', time: '12:00', timezone: 'Europe/London', currency: 'GBP' as const, payer: 'a', items: [{ id: 'item-' + id, name: id, amount: 100, members: ['a', 'b'] }], tax: 0, tip: 0, discount: 0, ...(receiptId ? { receiptId } : {}) });
function trip(): Trip {
  return { id: 'trip', name: 'Shared holiday', currency: 'GBP', members: [{ id: 'a', name: 'Owner', userId: 'owner', email: 'owner@example.com' }, { id: 'b', name: 'Joined', userId: 'joined', email: 'joined@example.com' }],
    expenses: [snapshot('dinner', 'photo-current'), snapshot('breakfast', 'photo-other'), snapshot('posted-draft', 'photo-posted'), snapshot('current-only', 'photo-current-only')], payments: [],
    drafts: [{ ...snapshot('pending', 'photo-pending'), expenseId: 'dinner', status: 'review' }, { ...snapshot('other-draft', 'photo-other'), expenseId: 'breakfast', status: 'waiting' }] };
}
function event(database: SQLiteD1, id: string, type: ActivityEntity, entityId: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null, source: ActivitySource = 'web', tripId = 'trip') {
  database.sqlite.prepare('INSERT INTO activity_events (id,trip_id,actor_id,actor_name,created_at,entity_type,entity_id,action,before_data,after_data,revision,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, tripId, source === 'system' ? 'system' : 'owner', source === 'system' ? 'TripTab' : 'Owner', '2026-10-04T12:00:00Z', type, entityId, before ? after ? 'update' : 'delete' : 'create', before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, 1, source);
}
async function storage() {
  const database = new SQLiteD1();
  for (const file of (await readdir(new URL('../drizzle/', import.meta.url))).filter(value => value.endsWith('.sql')).sort()) database.sqlite.exec(await readFile(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
  for (const [actor, token] of Object.entries(tokens)) {
    database.sqlite.prepare('INSERT INTO profiles (id,email,display_name,created_at) VALUES (?,?,?,?)').run(actor, actor + '@example.com', actor, '2026-10-04T00:00:00Z');
    database.sqlite.prepare('INSERT INTO auth_sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)').run(await hashToken(token), actor, '2099-01-01T00:00:00Z', '2026-10-04T00:00:00Z');
  }
  database.sqlite.prepare('INSERT INTO trips (id,owner,data) VALUES (?,?,?)').run('trip', 'owner', JSON.stringify(trip()));
  database.sqlite.prepare('INSERT INTO trips (id,owner,data) VALUES (?,?,?)').run('secret', 'outsider', JSON.stringify({ ...trip(), id: 'secret' }));
  database.sqlite.prepare('INSERT INTO memberships (trip_id,user_id,member_id) VALUES (?,?,?)').run('trip', 'joined', 'b');
  event(database, 'photo-old-created', 'receipt', 'photo-old', null, { status: 'active' });
  event(database, 'expense-created', 'expense', 'dinner', null, snapshot('dinner', 'photo-old'));
  event(database, 'expense-updated', 'expense', 'dinner', snapshot('dinner', 'photo-old'), snapshot('dinner', 'photo-current'));
  event(database, 'photo-current-created', 'receipt', 'photo-current', null, { status: 'active' });
  event(database, 'pending-created', 'draft', 'pending', null, { ...snapshot('pending', 'photo-pending'), expenseId: 'dinner', status: 'waiting' });
  event(database, 'pending-ai-review', 'draft', 'pending', { ...snapshot('pending', 'photo-pending'), expenseId: 'dinner', status: 'waiting' }, { ...snapshot('pending', 'photo-pending'), expenseId: 'dinner', status: 'review', memory: { notes: 'Saved AI context', aliases: [] } }, 'chatgpt');
  event(database, 'photo-pending-created', 'receipt', 'photo-pending', null, { status: 'active' });
  event(database, 'old-photo-purged', 'receipt', 'photo-old', { status: 'deleting' }, { status: 'purged' }, 'system');
  event(database, 'historic-draft-created', 'draft', 'historic-draft', null, { ...snapshot('historic-draft', 'photo-historic'), expenseId: 'dinner', status: 'review' }, 'chatgpt');
  event(database, 'historic-draft-deleted', 'draft', 'historic-draft', { ...snapshot('historic-draft', 'photo-historic'), expenseId: 'dinner', status: 'review' }, null);
  event(database, 'historic-photo-detached', 'receipt', 'photo-historic', { status: 'active' }, { status: 'detached' });
  event(database, 'posted-draft-created', 'draft', 'posted-draft', null, { ...snapshot('posted-draft', 'photo-posted'), status: 'review' }, 'chatgpt');
  event(database, 'posted-draft-deleted', 'draft', 'posted-draft', { ...snapshot('posted-draft', 'photo-posted'), status: 'review' }, null);
  event(database, 'posted-expense-created', 'expense', 'posted-draft', null, snapshot('posted-draft', 'photo-posted'));
  event(database, 'posted-image-created', 'receipt', 'photo-posted', null, { status: 'active' });
  event(database, 'current-only-image-created', 'receipt', 'photo-current-only', null, { status: 'active' });
  event(database, 'breakfast-created', 'expense', 'breakfast', null, snapshot('breakfast', 'photo-other'));
  event(database, 'other-draft-created', 'draft', 'other-draft', null, { ...snapshot('other-draft', 'photo-other'), expenseId: 'breakfast', status: 'waiting' });
  event(database, 'other-image-created', 'receipt', 'photo-other', null, { status: 'active' });
  for (const type of ['trip', 'member', 'payment', 'invite'] as const) event(database, 'unrelated-' + type, type, 'dinner', null, { name: 'UNRELATED_' + type });
  event(database, 'foreign-trip-event', 'expense', 'dinner', null, { title: 'NEVER_RETURN_OTHER_TRIP', receiptId: 'photo-current' }, 'web', 'secret');
  event(database, 'foreign-trip-photo', 'receipt', 'photo-current', null, { status: 'NEVER_RETURN_OTHER_TRIP' }, 'web', 'secret');
  binding.DB = database.asD1();
  return database;
}
const ids = (page: Page) => new Set(page.events.map(value => value.id));
const dinnerIds = new Set(['photo-old-created', 'expense-created', 'expense-updated', 'photo-current-created', 'pending-created', 'pending-ai-review', 'photo-pending-created', 'old-photo-purged', 'historic-draft-created', 'historic-draft-deleted', 'historic-photo-detached']);
const request = (query: string, actor: keyof typeof tokens | null = 'joined') => new Request('https://triptab.test/api/activity?' + query, { headers: actor ? { cookie: 'tt_session=' + tokens[actor] } : {} });
async function page(query: string, actor: keyof typeof tokens | null = 'joined') { const response = await route.GET(request(query, actor)); assert.equal(response.status, 200); return await response.json() as Page; }

test('receipt SQL binds one JSON context and validates internal scopes without interpolating IDs', () => {
  const id = "receipt' OR 1=1--";
  const scoped = receiptActivityScope('trip', { expenseId: id });
  assert.equal(scoped.bindings.length, 1);
  assert.equal((scoped.prefix.match(/\?/g) || []).length, 1);
  assert.ok(!scoped.prefix.includes(id) && !scoped.condition.includes(id));
  assert.deepEqual(JSON.parse(scoped.bindings[0]), [{ tripId: 'trip', kind: 'expense', entryId: id }]);
  assert.deepEqual(receiptActivityScope('trip'), { prefix: '', condition: '1', bindings: [] });
  for (const scope of [{ expenseId: '', draftId: undefined }, { draftId: 'x'.repeat(101) }, { expenseId: 'dinner', draftId: 'pending' }]) assert.throws(() => receiptActivityScope('trip', scope), /INVALID_RECEIPT_ACTIVITY_SCOPE/);
});

test('receipt history includes pending AI drafts and superseded image lifecycle while excluding unrelated activity', async () => {
  const database = await storage();
  const before = database.sqlite.prepare('SELECT * FROM activity_events ORDER BY sequence').all();
  const scoped = await page('tripId=trip&expenseId=dinner&limit=50');
  assert.deepEqual(ids(scoped), dinnerIds);
  assert.equal(scoped.nextCursor, null);
  assert.ok(scoped.events.every(value => value.tripId === 'trip' && ['expense', 'draft', 'receipt'].includes(value.entityType)));
  assert.equal(scoped.events.find(value => value.id === 'pending-ai-review')!.source, 'chatgpt');
  assert.equal(scoped.events.find(value => value.id === 'old-photo-purged')!.source, 'system');
  assert.deepEqual(scoped.events.find(value => value.id === 'pending-ai-review')!.after!.memory, { notes: 'Saved AI context', aliases: [] });
  assert.deepEqual(database.sqlite.prepare('SELECT * FROM activity_events ORDER BY sequence').all(), before, 'reading a scope cannot rewrite audit evidence');
  const full = await page('tripId=trip&limit=50');
  assert.ok(full.events.some(value => value.entityType === 'member') && full.events.some(value => value.entityType === 'payment'));
  assert.doesNotMatch(JSON.stringify(scoped), /UNRELATED_|NEVER_RETURN_OTHER_TRIP/);
});

test('current and deleted draft scopes resolve their expense family and preserve delete and restore history', async () => {
  const database = await storage();
  assert.deepEqual(ids(await page('tripId=trip&draftId=pending&limit=50')), dinnerIds);
  assert.deepEqual(ids(await page('tripId=trip&draftId=historic-draft&limit=50')), dinnerIds, 'a removed draft resolves its parent from immutable historical snapshots');
  database.sqlite.prepare('UPDATE trips SET data=? WHERE id=?').run(JSON.stringify({ ...trip(), expenses: trip().expenses.filter(value => value.id !== 'dinner'), drafts: [] }), 'trip');
  event(database, 'expense-deleted', 'expense', 'dinner', snapshot('dinner', 'photo-current'), null);
  event(database, 'expense-restored', 'expense', 'dinner', null, snapshot('dinner', 'photo-current'));
  const expected = new Set([...dinnerIds, 'expense-deleted', 'expense-restored']);
  assert.deepEqual(ids(await page('tripId=trip&expenseId=dinner&limit=50')), expected);
  assert.deepEqual(ids(await page('tripId=trip&draftId=pending&limit=50')), expected, 'the deleted current draft also resolves its parent from history');
});

test('original processing draft ID follows its posted expense and current-only photo references are scoped', async () => {
  await storage();
  const posted = new Set(['posted-draft-created', 'posted-draft-deleted', 'posted-expense-created', 'posted-image-created']);
  assert.deepEqual(ids(await page('tripId=trip&draftId=posted-draft&limit=50')), posted);
  assert.deepEqual(ids(await page('tripId=trip&expenseId=posted-draft&limit=50')), posted);
  assert.deepEqual(ids(await page('tripId=trip&expenseId=current-only&limit=50')), new Set(['current-only-image-created']));
  assert.deepEqual(await page('tripId=trip&expenseId=unknown'), { events: [], nextCursor: null });
  assert.deepEqual(await page('tripId=trip&draftId=unknown'), { events: [], nextCursor: null });
});

test('expense and draft ID collisions never include a different explicitly linked receipt family', async () => {
  const database = await storage();
  const changed = trip();
  changed.expenses.push(snapshot('pending', 'photo-id-collision-expense'), snapshot('historic-draft', 'photo-historic-collision'));
  changed.drafts.push({ ...snapshot('dinner', 'photo-id-collision-draft'), expenseId: 'breakfast', status: 'review' });
  database.sqlite.prepare('UPDATE trips SET data=? WHERE id=?').run(JSON.stringify(changed), 'trip');
  event(database, 'collision-expense-created', 'expense', 'pending', null, snapshot('pending', 'photo-id-collision-expense'));
  event(database, 'collision-expense-photo', 'receipt', 'photo-id-collision-expense', null, { status: 'active' });
  event(database, 'collision-historic-expense-created', 'expense', 'historic-draft', null, snapshot('historic-draft', 'photo-historic-collision'));
  event(database, 'collision-historic-photo', 'receipt', 'photo-historic-collision', null, { status: 'active' });
  event(database, 'collision-draft-created', 'draft', 'dinner', null, { ...snapshot('dinner', 'photo-id-collision-draft'), expenseId: 'breakfast', status: 'review' });
  event(database, 'collision-draft-photo', 'receipt', 'photo-id-collision-draft', null, { status: 'active' });
  assert.deepEqual(ids(await page('tripId=trip&expenseId=dinner&limit=50')), dinnerIds, 'expense scope must exclude same-ID draft explicitly linked to breakfast');
  assert.deepEqual(ids(await page('tripId=trip&draftId=pending&limit=50')), dinnerIds, 'linked draft scope must exclude unrelated same-ID posted expense');
  assert.deepEqual(ids(await page('tripId=trip&draftId=historic-draft&limit=50')), dinnerIds, 'historical explicit draft association overrides same-ID fallback');
  const breakfast = new Set(['breakfast-created', 'other-draft-created', 'other-image-created', 'collision-draft-created', 'collision-draft-photo']);
  assert.deepEqual(ids(await page('tripId=trip&draftId=dinner&limit=50')), breakfast, 'same-ID linked draft resolves breakfast rather than dinner expense');
  assert.deepEqual(ids(await page('tripId=trip&expenseId=pending&limit=50')), new Set(['collision-expense-created', 'collision-expense-photo']), 'expense scope excludes same-ID linked pending draft');
});

test('receipt pagination filters before the row limit and returns each related event exactly once', async () => {
  const database = await storage();
  for (let index = 0; index < 28; index++) {
    event(database, 'dinner-edit-' + index, 'expense', 'dinner', snapshot('dinner', 'photo-current'), { ...snapshot('dinner', 'photo-current'), title: 'Change ' + index });
    event(database, 'noise-edit-' + index, 'expense', 'breakfast', null, { title: 'NOISE ' + index });
  }
  const expected = new Set([...dinnerIds, ...Array.from({ length: 28 }, (_, index) => 'dinner-edit-' + index)]);
  const found: string[] = []; let cursor: number | null = null;
  do {
    const result = await page('tripId=trip&expenseId=dinner&limit=7' + (cursor === null ? '' : '&before=' + cursor));
    assert.ok(result.events.length <= 7 && result.events.every(value => expected.has(value.id)));
    if (cursor !== null) assert.ok(result.events.every(value => value.sequence < cursor!));
    found.push(...result.events.map(value => value.id));
    cursor = result.nextCursor;
  } while (cursor !== null);
  assert.equal(found.length, expected.size);
  assert.deepEqual(new Set(found), expected);
});

test('receipt activity route is authenticated, trip-authorized, private and rejects ambiguous or unbounded options', async () => {
  await storage();
  assert.equal((await route.GET(request('tripId=trip&expenseId=dinner', null))).status, 401);
  assert.equal((await route.GET(request('tripId=trip&expenseId=dinner', 'outsider'))).status, 403);
  assert.equal((await route.GET(request('tripId=secret&expenseId=dinner'))).status, 403);
  const response = await route.GET(request('tripId=trip&draftId=pending'));
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  for (const query of ['tripId=trip&expenseId=dinner&draftId=pending', 'tripId=trip&expenseId=', 'tripId=trip&draftId=', 'tripId=trip&expenseId=' + 'x'.repeat(101), 'tripId=trip&draftId=' + 'x'.repeat(101), 'tripId=trip&expenseId=dinner&expenseId=breakfast', 'tripId=trip&draftId=pending&draftId=other-draft', 'tripId=trip&tripId=secret', 'tripId=trip&unknown=1', 'tripId=trip&actorId=owner', 'tripId=trip&source=system', 'tripId=trip&before=9007199254740992', 'tripId=trip&limit=1&limit=2']) assert.equal((await route.GET(request(query))).status, 400, query);
  for (const scope of [{ expenseId: '', draftId: undefined }, { draftId: 'x'.repeat(101) }, { expenseId: 'dinner', draftId: 'pending' }]) await assert.rejects(store.readActivity('joined', 'trip', scope), error => error instanceof store.RequestError && error.status === 400);
  assert.deepEqual(await page('tripId=trip&expenseId=' + encodeURIComponent("' OR 1=1--")), { events: [], nextCursor: null });
  assert.deepEqual(ids(await page('tripId=trip&expenseId=dinner&limit=50', 'owner')), dinnerIds);
});

test('scoped history rechecks membership during immutable snapshot fetch and cannot widen after concurrent changes', async () => {
  let database = await storage();
  database.beforeRead = sql => {
    if (sql.includes('SELECT e.*')) { database.beforeRead = undefined; database.sqlite.prepare('DELETE FROM memberships WHERE trip_id=? AND user_id=?').run('trip', 'joined'); }
  };
  await assert.rejects(store.readActivity('joined', 'trip', { expenseId: 'dinner', limit: 50 }), error => error instanceof store.RequestError && error.status === 403);
  assert.equal((await route.GET(request('tripId=trip&expenseId=dinner'))).status, 403);
  database = await storage();
  database.beforeRead = sql => {
    if (sql.includes('SELECT e.*')) {
      database.beforeRead = undefined;
      event(database, 'concurrent-unrelated', 'expense', 'breakfast', null, { title: 'NEVER_WIDEN_THIS_PAGE' });
      const changed = trip(); changed.drafts[0].expenseId = 'breakfast';
      database.sqlite.prepare('UPDATE trips SET data=? WHERE id=?').run(JSON.stringify(changed), 'trip');
    }
  };
  const scoped = await store.readActivity('joined', 'trip', { expenseId: 'dinner', limit: 50 });
  assert.deepEqual(ids(scoped), dinnerIds, 'chosen immutable audit IDs do not change when live receipt context changes');
  assert.doesNotMatch(JSON.stringify(scoped), /NEVER_WIDEN_THIS_PAGE/);
});

test('receipt byte budgets exclude unrelated large snapshots and retain complete scoped cursors', async () => {
  const database = await storage();
  event(database, 'unrelated-oversized', 'expense', 'breakfast', null, { title: 'x'.repeat(store.MAX_ACTIVITY_BYTES) });
  assert.deepEqual(ids(await page('tripId=trip&expenseId=dinner&limit=50')), dinnerIds);
  const large = 'x'.repeat(1_500_000);
  for (let index = 0; index < 3; index++) event(database, 'large-related-' + index, 'expense', 'dinner', null, { title: large });
  const first = await store.readActivity('joined', 'trip', { expenseId: 'dinner', limit: 50 });
  assert.equal(first.events.length, 2);
  assert.ok(first.nextCursor && new TextEncoder().encode(JSON.stringify(first)).byteLength <= store.MAX_ACTIVITY_BYTES);
  const second = await store.readActivity('joined', 'trip', { expenseId: 'dinner', limit: 50, before: first.nextCursor! });
  assert.equal(second.events.length, dinnerIds.size + 1);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.events, ...second.events].map(value => value.id)).size, dinnerIds.size + 3);
  event(database, 'related-oversized', 'expense', 'dinner', null, { title: 'x'.repeat(store.MAX_ACTIVITY_BYTES) });
  database.queries.length = 0;
  await assert.rejects(store.readActivity('joined', 'trip', { expenseId: 'dinner' }), error => error instanceof store.RequestError && error.status === 413);
  assert.ok(database.queries.every(sql => !sql.includes('SELECT e.*')), 'an oversized scoped entry is rejected before materializing snapshots');
});
