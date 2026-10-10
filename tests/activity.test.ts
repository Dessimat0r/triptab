import { transpileWithSharedImports } from './helpers/transpile';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ModuleKind, ScriptTarget } from 'typescript';
import { hashToken } from '../lib/auth';
import { receiptActivityScope } from '../lib/activity-scope';
import type { ActivityEntity, ActivityEvent, ActivitySource } from '../lib/audit';
import type { Trip } from '../lib/model';

class SQLiteStatement {
  private values: (string | number | null)[] = [];
  constructor(private readonly database: SQLiteD1, readonly sql: string) {}
  bind(...values: (string | number | null)[]) { this.values = values; return this; }
  async first<T>() { this.database.read(this.sql, this.values); return (this.database.sqlite.prepare(this.sql).get(...this.values) || null) as T | null; }
  async all<T>() { this.database.read(this.sql, this.values); return { results: this.database.sqlite.prepare(this.sql).all(...this.values) as T[] }; }
  runSync() {
    this.database.read(this.sql, this.values);
    const statement = this.database.sqlite.prepare(this.sql);
    const results = statement.columns().length ? statement.all(...this.values) : (statement.run(...this.values), []);
    return { results, success: true, meta: { changes: Number(this.database.sqlite.prepare('SELECT changes() AS changes').get()?.changes || 0) } };
  }
  async run() { return this.runSync(); }
}
class SQLiteD1 {
  readonly sqlite = new DatabaseSync(':memory:');
  readonly queries: string[] = [];
  readonly reads: { sql: string; values: (string | number | null)[] }[] = [];
  beforeRead?: (sql: string) => void;
  read(sql: string, values: (string | number | null)[] = []) { this.queries.push(sql); this.reads.push({ sql, values: [...values] }); this.beforeRead?.(sql); }
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
const compile = (source: string) => transpileWithSharedImports(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText;
const storeUrl = dataUrl(compile(await readFile(new URL('../lib/store.ts', import.meta.url), 'utf8'))
  .replace("'cloudflare:workers'", JSON.stringify(envUrl))
  .replace("'zod'", JSON.stringify(import.meta.resolve('zod')))
  .replace("'./model'", JSON.stringify(new URL('../lib/model.ts', import.meta.url).href))
  .replace("'./auth'", JSON.stringify(new URL('../lib/auth.ts', import.meta.url).href))
  .replace("'./activity-scope'", JSON.stringify(new URL('../lib/activity-scope.ts', import.meta.url).href))
  .replace("'./receipt-lifecycle'", JSON.stringify(new URL('../lib/receipt-lifecycle.ts', import.meta.url).href))
  .replace("'./receipt-context'", JSON.stringify(new URL('../lib/receipt-context.ts', import.meta.url).href))
  .replace("'./receipt-memory-ownership'", JSON.stringify(new URL('../lib/receipt-memory-ownership.ts', import.meta.url).href))
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
async function storage(includeScopeIndexes = true) {
  const database = new SQLiteD1();
  for (const file of (await readdir(new URL('../drizzle/', import.meta.url))).filter(value => value.endsWith('.sql') && (includeScopeIndexes || Number(value.slice(0, 4)) < 8)).sort()) database.sqlite.exec(await readFile(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
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
  const family = { expenseIds: [id], draftIds: [], receiptIds: [], version: 1 };
  const scoped = receiptActivityScope('trip', { expenseId: id }, family);
  assert.equal(scoped.bindings.length, 1);
  assert.equal((scoped.prefix.match(/\?/g) || []).length, 1);
  assert.ok(!scoped.prefix.includes(id) && !scoped.condition.includes(id));
  assert.deepEqual(JSON.parse(scoped.bindings[0]), [{ tripId: 'trip', kind: 'expense', entryId: id, ...family }]);
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
  assert.deepEqual(ids(scoped), dinnerIds, 'a retry returns a consistent family without widening to unrelated activity');
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
  const oversized = await store.readActivity('joined', 'trip', { expenseId: 'dinner', limit: 1 });
  assert.equal(oversized.events[0].id, 'related-oversized');
  assert.equal(oversized.events[0].snapshotOmitted, true);
  assert.ok(oversized.nextCursor);
  assert.ok(database.queries.every(sql => !sql.includes('SELECT e.*')), 'an oversized scoped entry returns metadata without materializing its snapshot');
});

test('distinct source draft provenance retains every prelink event and old photo through posting and deletion', async () => {
  const database = await storage();
  event(database, 'source-draft-upload', 'draft', 'source-draft', null, { ...snapshot('source-draft', 'source-photo-old'), status: 'waiting' });
  event(database, 'source-draft-ai', 'draft', 'source-draft', { ...snapshot('source-draft', 'source-photo-old'), status: 'waiting' }, { ...snapshot('source-draft', 'source-photo-new'), status: 'review' }, 'chatgpt');
  event(database, 'source-old-photo', 'receipt', 'source-photo-old', null, { status: 'active' });
  event(database, 'source-new-photo', 'receipt', 'source-photo-new', null, { status: 'active' });
  const posted = { ...snapshot('different-posted-id', 'source-photo-new'), sourceDraftId: 'source-draft' };
  event(database, 'source-posted-expense', 'expense', 'different-posted-id', null, posted);
  event(database, 'source-draft-consumed', 'draft', 'source-draft', { ...snapshot('source-draft', 'source-photo-new'), status: 'review' }, null);
  const current = trip(); current.expenses.push(posted);
  // An unrelated expense can use the draft's raw ID. Explicit provenance
  // must resolve the differently named expense instead of that collision.
  current.expenses.push(snapshot('source-draft', 'unrelated-source-collision-photo'));
  database.sqlite.prepare('UPDATE trips SET data=? WHERE id=?').run(JSON.stringify(current), 'trip');
  event(database, 'unrelated-source-collision', 'expense', 'source-draft', null, snapshot('source-draft', 'unrelated-source-collision-photo'));
  event(database, 'unrelated-source-collision-photo', 'receipt', 'unrelated-source-collision-photo', null, { status: 'active' });
  const expected = new Set(['source-draft-upload', 'source-draft-ai', 'source-old-photo', 'source-new-photo', 'source-posted-expense', 'source-draft-consumed']);
  assert.deepEqual(ids(await page('tripId=trip&expenseId=different-posted-id&limit=50')), expected);
  assert.deepEqual(ids(await page('tripId=trip&draftId=source-draft&limit=50')), expected);
  assert.deepEqual(ids(await page('tripId=trip&expenseId=source-draft&limit=50')), new Set(['unrelated-source-collision', 'unrelated-source-collision-photo']));
  current.expenses = current.expenses.filter(value => value.id !== 'different-posted-id');
  database.sqlite.prepare('UPDATE trips SET data=? WHERE id=?').run(JSON.stringify(current), 'trip');
  event(database, 'source-expense-deleted', 'expense', 'different-posted-id', posted, null);
  expected.add('source-expense-deleted');
  assert.deepEqual(ids(await page('tripId=trip&expenseId=different-posted-id&limit=50')), expected);
  assert.deepEqual(ids(await page('tripId=trip&draftId=source-draft&limit=50')), expected, 'historical sourceDraftId is sufficient after both live records are gone');
});

test('parent link discovery includes earlier unlinked draft changes without admitting cross-collection collisions', async () => {
  const database = await storage();
  event(database, 'prelink-created', 'draft', 'later-linked', null, { ...snapshot('later-linked', 'prelink-photo'), status: 'waiting' });
  event(database, 'prelink-photo', 'receipt', 'prelink-photo', null, { status: 'active' });
  event(database, 'prelink-associated', 'draft', 'later-linked', { ...snapshot('later-linked', 'prelink-photo'), status: 'waiting' }, { ...snapshot('later-linked', 'prelink-photo'), expenseId: 'dinner', status: 'review' });
  const expected = new Set([...dinnerIds, 'prelink-created', 'prelink-photo', 'prelink-associated']);
  assert.deepEqual(ids(await page('tripId=trip&expenseId=dinner&limit=50')), expected);
  assert.deepEqual(ids(await page('tripId=trip&draftId=later-linked&limit=50')), expected);
  // The colliding draft belongs to breakfast even though an older event had
  // not yet established that link; dinner must not inherit its earlier photo.
  event(database, 'collision-before-link', 'draft', 'dinner', null, { ...snapshot('dinner', 'foreign-prelink-photo'), status: 'waiting' });
  event(database, 'collision-linked-other', 'draft', 'dinner', { ...snapshot('dinner', 'foreign-prelink-photo'), status: 'waiting' }, { ...snapshot('dinner', 'foreign-prelink-photo'), expenseId: 'breakfast', status: 'review' });
  event(database, 'foreign-prelink-photo', 'receipt', 'foreign-prelink-photo', null, { status: 'active' });
  assert.deepEqual(ids(await page('tripId=trip&expenseId=dinner&limit=50')), expected);
});

test('index migration bootstraps populated immutable history without rewriting old events', async () => {
  const database = await storage(false);
  const before = database.sqlite.prepare('SELECT * FROM activity_events ORDER BY sequence').all();
  const rawTrip = database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get('trip')!.data;
  database.sqlite.exec(await readFile(new URL('../drizzle/0008_receipt_activity_scope.sql', import.meta.url), 'utf8'));
  database.sqlite.exec(await readFile(new URL('../drizzle/0009_receipt_link_projections.sql', import.meta.url), 'utf8'));
  database.sqlite.exec(await readFile(new URL('../drizzle/0012_trip_lifecycle_email_recovery.sql', import.meta.url), 'utf8'));
  database.sqlite.exec(await readFile(new URL('../drizzle/0013_account_preferences.sql', import.meta.url), 'utf8'));
  assert.deepEqual(database.sqlite.prepare('SELECT * FROM activity_events ORDER BY sequence').all(), before);
  assert.equal(database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get('trip')!.data, rawTrip);
  assert.deepEqual(ids(await page('tripId=trip&draftId=historic-draft&limit=50')), dinnerIds);
  assert.throws(() => database.sqlite.prepare('UPDATE activity_events SET after_data=? WHERE id=?').run('{}', 'expense-created'), /append-only/);
  assert.throws(() => database.sqlite.prepare('DELETE FROM activity_events WHERE id=?').run('expense-created'), /append-only/);
  assert.throws(() => database.sqlite.prepare('INSERT OR REPLACE INTO activity_events SELECT * FROM activity_events WHERE id=?').run('expense-created'), /append-only/);
  event(database, 'indexed-new-event', 'draft', 'new-indexed-draft', null, { expenseId: 'dinner', receiptId: 'new-indexed-photo' });
  event(database, 'indexed-new-photo', 'receipt', 'new-indexed-photo', null, { status: 'active' });
  assert.deepEqual(ids(await page('tripId=trip&expenseId=dinner&limit=50')), new Set([...dinnerIds, 'indexed-new-event', 'indexed-new-photo']));
});

test('scoped query plans use metadata indexes and never parse unrelated current or historical payloads', async () => {
  const database = await storage();
  const marker = 'UNRELATED_LARGE_HISTORY_PAYLOAD';
  const payload = marker + 'x'.repeat(4096);
  database.sqlite.exec('BEGIN');
  for (let index = 0; index < 1500; index++) {
    event(database, 'large-unrelated-draft-' + index, 'draft', 'unrelated-draft-' + index, { expenseId: 'unrelated-expense-' + index, title: payload }, { expenseId: 'unrelated-expense-' + index, title: payload });
    event(database, 'large-unrelated-expense-' + index, 'expense', 'unrelated-expense-' + index, null, { sourceDraftId: 'unrelated-draft-' + index, title: payload, receiptId: 'unrelated-photo-' + index });
  }
  database.sqlite.exec('COMMIT; ANALYZE');
  const currentMarker = 'UNRELATED_LARGE_CURRENT_TRIP_PAYLOAD';
  const current = trip();
  for (let index = 0; index < 1000; index++) current.expenses.push({ ...snapshot('current-noise-' + index, 'current-noise-photo-' + index), title: currentMarker + 'x'.repeat(1000) });
  for (let index = 0; index < 100; index++) current.drafts.push({ ...snapshot('draft-noise-' + index, 'draft-noise-photo-' + index), expenseId: 'current-noise-' + index, status: 'review', title: currentMarker + 'x'.repeat(1000) });
  database.sqlite.prepare('UPDATE trips SET data=? WHERE id=?').run(JSON.stringify(current), 'trip');

  const native = new DatabaseSync(':memory:');
  const extract = native.prepare('SELECT json_extract(?,?) AS value');
  const type = native.prepare('SELECT json_type(?,?) AS value');
  let unrelatedParses = 0;
  database.sqlite.function('json_extract', { deterministic: true }, (value, path) => {
    if (typeof value === 'string' && (value.includes(marker) || value.includes(currentMarker))) unrelatedParses++;
    return extract.get(value, path)!.value as string | number | null;
  });
  database.sqlite.function('json_type', { deterministic: true }, (value, path) => {
    if (typeof value === 'string' && (value.includes(marker) || value.includes(currentMarker))) unrelatedParses++;
    return type.get(value, path)!.value as string | null;
  });
  for (const scope of [{ expenseId: 'dinner' }, { draftId: 'pending' }, { draftId: 'historic-draft' }]) {
    database.reads.length = 0;
    const result = await store.readActivity('joined', 'trip', { ...scope, limit: 3 });
    assert.ok(result.events.every(value => dinnerIds.has(value.id)));
    const candidate = database.reads.find(value => value.sql.includes('SELECT e.id, e.sequence'))!;
    const plan = database.sqlite.prepare('EXPLAIN QUERY PLAN ' + candidate.sql).all(...candidate.values).map(row => String(row.detail));
    assert.ok(plan.some(detail => /SEARCH e USING INTEGER PRIMARY KEY/.test(detail)), 'candidate rows must use receipt sequence primary-key probes');
    assert.ok(plan.some(detail => detail.includes('activity_events_trip_entity_idx')));
    assert.ok(plan.some(detail => detail.includes('receipt_history_links_snapshot_idx') && detail.includes('sequence=?')));
    for (const probe of database.reads.filter(read => /FROM (current_receipt_links|receipt_history_links) INDEXED BY/.test(read.sql))) {
      const lookup = database.sqlite.prepare('EXPLAIN QUERY PLAN ' + probe.sql).all(...probe.values).map(row => String(row.detail));
      assert.ok(lookup.every(detail => !/SCAN (?:current_receipt_links|receipt_history_links)\b/.test(detail)), lookup.join('; '));
      assert.ok(lookup.some(detail => /(?:current_receipt_links|receipt_history_links)_.*_idx/.test(detail) && /SEARCH/.test(detail)));
    }
    assert.ok(!plan.some(detail => /SCAN (?:h|e)\b/.test(detail)), 'history tables must not be scanned to discover receipt links: ' + plan.filter(detail => /SCAN (?:h|e)\b/.test(detail)).join('; '));
    const older = await store.readActivity('joined', 'trip', { ...scope, limit: 3, before: result.nextCursor! });
    assert.ok(older.events.every(value => dinnerIds.has(value.id)));
  }
  assert.equal(unrelatedParses, 0, 'neither first nor subsequent receipt pages may parse unrelated live entries or historical JSON');
  assert.ok(database.reads.every(read => !/json_each\(t\.data|SELECT (?:t\.)?data FROM trips/.test(read.sql)), 'activity never fetches/parses live trip data');
  native.close();
});

async function legacyReceipt(database: SQLiteD1, draftId = "legacy 'draft", expenseId = 'legacy-expense') {
  const before = { ...snapshot(draftId, 'legacy-photo-old'), status: 'waiting', conversation: [{ id: 'legacy-question', role: 'user', text: 'Who shared this older receipt?', createdAt: '2026-10-04T12:00:00Z' }] };
  const after = { ...before, receiptId: 'legacy-photo-posted', status: 'review' };
  const expense = snapshot(expenseId, 'legacy-photo-posted');
  event(database, 'legacy-old-upload', 'receipt', 'legacy-photo-old', null, { status: 'pending' });
  event(database, 'legacy-before-save-question', 'draft', draftId, null, before);
  event(database, 'legacy-processed', 'draft', draftId, before, after, 'chatgpt');
  event(database, 'legacy-final-upload', 'receipt', 'legacy-photo-posted', null, { status: 'active' });
  event(database, 'legacy-posted', 'expense', expenseId, null, expense);
  event(database, 'legacy-draft-consumed', 'draft', draftId, after, null);
  event(database, 'legacy-old-photo-purged', 'receipt', 'legacy-photo-old', { status: 'deleting' }, null, 'system');
  const current = trip(); current.expenses.push(expense);
  database.sqlite.prepare('UPDATE trips SET data=? WHERE id=?').run(JSON.stringify(current), 'trip');
  return { draftId, expenseId, expense, before, after, current,
    expected: new Set(['legacy-old-upload', 'legacy-before-save-question', 'legacy-processed', 'legacy-final-upload', 'legacy-posted', 'legacy-draft-consumed', 'legacy-old-photo-purged']) };
}

test('legacy distinct manual drafts recover questions, processing and replaced photos across deletion and pagination', async () => {
  const database = await storage();
  const fixture = await legacyReceipt(database);
  const original = database.sqlite.prepare('SELECT * FROM activity_events ORDER BY sequence').all();
  for (const scope of [{ expenseId: fixture.expenseId }, { draftId: fixture.draftId }]) {
    const first = await store.readActivity('joined', 'trip', { ...scope, limit: 3 });
    const second = await store.readActivity('joined', 'trip', { ...scope, limit: 50, before: first.nextCursor! });
    assert.deepEqual(new Set([...first.events, ...second.events].map(row => row.id)), fixture.expected);
    assert.equal(second.nextCursor, null);
  }
  assert.deepEqual(database.sqlite.prepare('SELECT * FROM activity_events ORDER BY sequence').all(), original, 'legacy recovery never rewrites an event or adds fabricated provenance');
  fixture.current.expenses = fixture.current.expenses.filter(row => row.id !== fixture.expenseId);
  database.sqlite.prepare('UPDATE trips SET data=? WHERE id=?').run(JSON.stringify(fixture.current), 'trip');
  event(database, 'legacy-expense-deleted', 'expense', fixture.expenseId, fixture.expense, null);
  fixture.expected.add('legacy-expense-deleted');
  assert.deepEqual(ids(await store.readActivity('joined', 'trip', { draftId: fixture.draftId, limit: 50 })), fixture.expected);
  event(database, 'legacy-expense-restored', 'expense', fixture.expenseId, null, fixture.expense);
  fixture.current.expenses.push(fixture.expense);
  database.sqlite.prepare('UPDATE trips SET data=? WHERE id=?').run(JSON.stringify(fixture.current), 'trip');
  fixture.expected.add('legacy-expense-restored');
  assert.deepEqual(ids(await store.readActivity('joined', 'trip', { expenseId: fixture.expenseId, limit: 50 })), fixture.expected);
});

test('inferred legacy roots inspect other photos and typed same-ID drafts before including sibling history', async () => {
  const database = await storage(); const fixture = await legacyReceipt(database);
  // E's old different photo safely resolves another unlinked manual draft X.
  event(database, 'legacy-expense-older-photo', 'expense', fixture.expenseId, snapshot(fixture.expenseId, 'legacy-sibling-photo'), fixture.expense);
  event(database, 'legacy-sibling', 'draft', 'legacy-sibling-draft', null, { ...snapshot('legacy-sibling-draft', 'legacy-sibling-photo'), status: 'review' });
  event(database, 'legacy-sibling-photo', 'receipt', 'legacy-sibling-photo', null, { status: 'active' });
  // Raw draft ID E belongs to breakfast. Its earlier unlinked history must not
  // be mistaken for original same-ID posting after D infers the parent E.
  event(database, 'unrelated-inferred-before-link', 'draft', fixture.expenseId, null, { receiptId: 'unrelated-inferred-photo', text: 'NEVER_INFER_THIS_FAMILY' });
  event(database, 'unrelated-inferred-linked', 'draft', fixture.expenseId, { receiptId: 'unrelated-inferred-photo' }, { receiptId: 'unrelated-inferred-photo', expenseId: 'breakfast' });
  event(database, 'unrelated-inferred-photo', 'receipt', 'unrelated-inferred-photo', null, { status: 'active' });
  const expected = new Set([...fixture.expected, 'legacy-expense-older-photo', 'legacy-sibling', 'legacy-sibling-photo']);
  for (const scope of [{ expenseId: fixture.expenseId }, { draftId: fixture.draftId }]) {
    const result = await store.readActivity('joined', 'trip', { ...scope, limit: 50 });
    assert.deepEqual(ids(result), expected);
    assert.doesNotMatch(JSON.stringify(result), /NEVER_INFER_THIS_FAMILY/);
  }
});

test('receipt matching never overrides any current or historical explicit target or source provenance', async () => {
  const database = await storage(); const fixture = await legacyReceipt(database);
  for (const [id, target] of [['once-linked', 'breakfast'], ['numeric-linked', 123], ['empty-linked', '']] as const) {
    event(database, id + '-created', 'draft', id, null, { receiptId: 'legacy-photo-posted', expenseId: target, text: 'EXPLICIT_FOREIGN_DRAFT' });
    event(database, id + '-cleared', 'draft', id, { receiptId: 'legacy-photo-posted', expenseId: target }, { receiptId: 'legacy-photo-posted', text: 'EXPLICIT_FOREIGN_DRAFT' });
  }
  fixture.current.drafts.push({ ...snapshot('current-malformed', 'legacy-photo-posted'), expenseId: 321 as unknown as string, status: 'review' });
  database.sqlite.prepare('UPDATE trips SET data=? WHERE id=?').run(JSON.stringify(fixture.current), 'trip');
  event(database, 'source-provenance-draft', 'draft', 'has-source-provenance', null, { receiptId: 'legacy-photo-posted', text: 'EXPLICIT_FOREIGN_DRAFT' });
  event(database, 'deleted-source-provenance', 'expense', 'foreign-source-expense', { sourceDraftId: 'has-source-provenance', receiptId: 'another-source-photo' }, null);
  assert.deepEqual(ids(await store.readActivity('joined', 'trip', { expenseId: fixture.expenseId, limit: 50 })), fixture.expected);
  assert.deepEqual(ids(await store.readActivity('joined', 'trip', { draftId: fixture.draftId, limit: 50 })), fixture.expected);
});

test('ambiguous deleted expenses or copied unlinked draft photos cannot infer receipt families', async context => {
  for (const variant of ['posted-photo-other-expense', 'old-photo-other-expense', 'posted-photo-copy', 'old-photo-copy']) await context.test(variant, async () => {
    const database = await storage(); const fixture = await legacyReceipt(database);
    const receiptId = variant.startsWith('old-photo') ? 'legacy-photo-old' : 'legacy-photo-posted';
    if (variant.endsWith('expense')) event(database, 'ambiguous-deleted-expense', 'expense', 'another-deleted-expense', { receiptId, text: 'AMBIGUOUS_COPY' }, null);
    else event(database, 'ambiguous-deleted-draft', 'draft', 'another-deleted-draft', { receiptId, text: 'AMBIGUOUS_COPY' }, null);
    const expensePage = await store.readActivity('joined', 'trip', { expenseId: fixture.expenseId, limit: 50 });
    assert.deepEqual(ids(expensePage), new Set(['legacy-final-upload', 'legacy-posted']));
    const draftPage = await store.readActivity('joined', 'trip', { draftId: fixture.draftId, limit: 50 });
    assert.ok(!ids(draftPage).has('legacy-posted') && !ids(draftPage).has('ambiguous-deleted-draft') && !ids(draftPage).has('ambiguous-deleted-expense'));
    assert.doesNotMatch(JSON.stringify(expensePage), /AMBIGUOUS_COPY/);
  });
});

test('typed metadata and literal IDs keep numeric photo IDs, snapshot IDs and foreign trips isolated', async () => {
  const database = await storage(); const fixture = await legacyReceipt(database, "draft' OR 1=1 --", "expense' OR 1=1 --");
  event(database, 'foreign-unlinked-copy', 'draft', fixture.draftId, null, { receiptId: 'legacy-photo-posted', text: 'NEVER_OTHER_TRIP' }, 'web', 'secret');
  event(database, 'foreign-photo-owner', 'expense', 'foreign-owner', null, { receiptId: 'legacy-photo-posted' }, 'web', 'secret');
  // $.id is advisory snapshot data; immutable entity_id is authoritative.
  event(database, 'mismatched-snapshot-id', 'draft', 'different-draft', null, { id: fixture.draftId, receiptId: 123, text: 'NEVER_NUMERIC_PHOTO' });
  event(database, 'typed-photo-expense', 'expense', 'typed-photo-expense', null, { receiptId: '123' });
  fixture.current.drafts.push({ ...snapshot('numeric-current', '123'), receiptId: 123 as unknown as string, status: 'review' });
  database.sqlite.prepare('UPDATE trips SET data=? WHERE id=?').run(JSON.stringify(fixture.current), 'trip');
  for (const scope of [{ expenseId: fixture.expenseId }, { draftId: fixture.draftId }]) assert.deepEqual(ids(await store.readActivity('joined', 'trip', { ...scope, limit: 50 })), fixture.expected);
  assert.deepEqual(ids(await store.readActivity('joined', 'trip', { expenseId: 'typed-photo-expense', limit: 50 })), new Set(['typed-photo-expense']));
  const currentRow = database.sqlite.prepare('SELECT receipt_id FROM current_receipt_links WHERE trip_id=? AND entity_type=? AND entity_id=?').get('trip', 'draft', 'numeric-current');
  assert.equal(currentRow!.receipt_id, null, 'numeric JSON IDs must not become text through column affinity');
});

test('a raw same-ID expense cannot replace a contradictory legacy photo association', async () => {
  const database = await storage(); const fixture = await legacyReceipt(database);
  event(database, 'same-id-unrelated-expense', 'expense', fixture.draftId, null, snapshot(fixture.draftId, 'same-id-other-photo'));
  event(database, 'same-id-other-photo', 'receipt', 'same-id-other-photo', null, { status: 'active' });
  assert.deepEqual(ids(await store.readActivity('joined', 'trip', { expenseId: fixture.expenseId, limit: 50 })), new Set(['legacy-final-upload', 'legacy-posted']));
  const directDraft = await store.readActivity('joined', 'trip', { draftId: fixture.draftId, limit: 50 });
  assert.ok(!ids(directDraft).has('same-id-unrelated-expense') && !ids(directDraft).has('same-id-other-photo') && !ids(directDraft).has('legacy-posted'));
});

test('staged receipt reads restart after link, image or candidate changes without returning false empty pages', async context => {
  for (const stage of ['metadata-link', 'image-discovery', 'candidate', 'snapshot']) await context.test(stage, async () => {
    const database = await storage(); let changed = false;
    database.beforeRead = sql => {
      const target = stage === 'metadata-link' ? sql.includes("AND entity_type = 'draft' AND receipt_id IN")
        : stage === 'image-discovery' ? sql.includes('WITH context AS MATERIALIZED')
        : stage === 'candidate' ? sql.includes('SELECT e.id, e.sequence') : sql.includes('SELECT e.*');
      if (!target || changed) return;
      changed = true; database.beforeRead = undefined;
      if (stage === 'metadata-link') {
        event(database, 'race-added-draft', 'draft', 'race-added-draft', null, { expenseId: 'dinner', receiptId: 'race-added-photo' });
        event(database, 'race-added-photo', 'receipt', 'race-added-photo', null, { status: 'active' });
      } else event(database, 'race-photo-lifecycle', 'receipt', 'photo-old', { status: 'detached' }, { status: 'purged' }, 'system');
    };
    const result = await store.readActivity('joined', 'trip', { expenseId: 'dinner', limit: 50 });
    assert.ok(changed && result.events.length > 0);
    assert.deepEqual(ids(result), new Set([...dinnerIds, ...(stage === 'metadata-link' ? ['race-added-draft', 'race-added-photo'] : ['race-photo-lifecycle'])]));
    assert.ok(database.reads.filter(read => read.sql.startsWith('SELECT receipt_link_version AS version')).length >= 4, 'changed metadata causes a fresh captured generation');
  });
});

test('three changing receipt snapshots return a retryable conflict, while unrelated trip changes do not restart', async () => {
  let database = await storage(); let counter = 0;
  database.beforeRead = sql => {
    if (sql.includes('SELECT e.id, e.sequence')) event(database, 'continuous-receipt-change-' + ++counter, 'receipt', 'photo-old', null, { status: 'active' }, 'system');
  };
  await assert.rejects(store.readActivity('joined', 'trip', { expenseId: 'dinner' }), error => error instanceof store.RequestError && error.status === 409);
  assert.equal(counter, 3, 'version churn has a finite retry budget');
  database = await storage(); let changed = false;
  database.beforeRead = sql => {
    if (sql.includes('SELECT e.id, e.sequence') && !changed) { changed = true; event(database, 'foreign-race', 'expense', 'dinner', null, snapshot('dinner', 'foreign-photo'), 'web', 'secret'); }
  };
  assert.deepEqual(ids(await store.readActivity('joined', 'trip', { expenseId: 'dinner', limit: 50 })), dinnerIds);
  assert.equal(database.reads.filter(read => read.sql.includes('SELECT e.id, e.sequence')).length, 1);
});

test('receipt scope rejects excessive Unicode ID bindings before issuing a D1 query', () => {
  const id = 'x';
  const longIds = Array.from({ length: 5000 }, (_, index) => String(index).padStart(5, '0') + '🧾'.repeat(47));
  const family = { expenseIds: longIds, draftIds: longIds, receiptIds: longIds, version: 1 };
  assert.throws(() => receiptActivityScope('trip', { expenseId: id }, family), /RECEIPT_SCOPE_TOO_LARGE/);
});

test('membership loss during indexed discovery returns forbidden instead of an empty receipt page', async () => {
  const database = await storage();
  database.beforeRead = sql => {
    if (sql.includes("AND entity_type = 'draft' AND receipt_id IN")) {
      database.beforeRead = undefined;
      database.sqlite.prepare('DELETE FROM memberships WHERE trip_id=? AND user_id=?').run('trip', 'joined');
    }
  };
  await assert.rejects(store.readActivity('joined', 'trip', { expenseId: 'dinner' }), error => error instanceof store.RequestError && error.status === 403);
  assert.ok(database.queries.every(sql => !sql.includes('SELECT e.*')), 'no snapshots materialize after access is lost');
});
