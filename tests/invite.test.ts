import { transpileWithSharedImports } from './helpers/transpile';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { ModuleKind, ScriptTarget } from 'typescript';
import { performAuthAction } from '../lib/auth';
import type { Trip } from '../lib/model';

// Same native SQLite/D1 transaction harness as store.test.ts: only Worker
// bindings and external notification delivery are replaced. All auth, invite,
// snapshot, membership, JSON and activity SQL executes against the real tables.
class SQLiteStatement {
  private values: (string | number | null)[] = [];
  constructor(private readonly sqlite: DatabaseSync, readonly sql: string) {}
  bind(...values: (string | number | null)[]) { this.values = values; return this; }
  boundValues() { return this.values; }
  async first<T>() { return (this.sqlite.prepare(this.sql).get(...this.values) || null) as T | null; }
  async all<T>() { return { results: this.sqlite.prepare(this.sql).all(...this.values) as T[] }; }
  runSync() {
    const statement = this.sqlite.prepare(this.sql);
    const results = statement.columns().length ? statement.all(...this.values) : (statement.run(...this.values), []);
    return { results, meta: { changes: Number(this.sqlite.prepare('SELECT changes() AS changes').get()?.changes || 0) }, success: true };
  }
  async run() { return this.runSync(); }
}
class SQLiteD1 {
  readonly sqlite = new DatabaseSync(':memory:');
  beforeWriteBatch?: () => void;
  beforeInviteBatch?: () => void | Promise<void>;
  readonly invitationBatches: SQLiteStatement[][] = [];
  private pending: Promise<unknown> = Promise.resolve();
  prepare(sql: string) { return new SQLiteStatement(this.sqlite, sql); }
  batch(statements: SQLiteStatement[]): Promise<ReturnType<SQLiteStatement['runSync']>[]> {
    if (statements.some(statement => /^(?:INSERT INTO|DELETE FROM) invites/.test(statement.sql.trim()))) {
      this.invitationBatches.push(statements);
      const hook = this.beforeInviteBatch; this.beforeInviteBatch = undefined;
      // Run before queuing this transaction, allowing a real competing ledger
      // save to complete after the invite pre-read without a synthetic SQL save.
      if (hook) return Promise.resolve(hook()).then(() => this.batch(statements));
    }
    const operation = this.pending.then(() => {
      if (statements.some(statement => /^UPDATE sync_state/.test(statement.sql.trim()))) {
        const hook = this.beforeWriteBatch; this.beforeWriteBatch = undefined; hook?.();
      }
      this.sqlite.exec('BEGIN');
      try { const results = statements.map(statement => statement.runSync()); this.sqlite.exec('COMMIT'); return results; }
      catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
    });
    this.pending = operation.catch(() => {}); return operation;
  }
  asD1() { return this as unknown as D1Database; }
}

const binding: { DB?: D1Database } = {};
const notifications: unknown[][] = [];
Object.defineProperty(globalThis, Symbol.for('triptab.invite-test-env'), { value: binding, configurable: true });
Object.defineProperty(globalThis, Symbol.for('triptab.invite-test-notifications'), { value: notifications, configurable: true });
const envUrl = 'data:text/javascript;base64,' + Buffer.from("export const env=globalThis[Symbol.for('triptab.invite-test-env')];").toString('base64');
const notificationUrl = 'data:text/javascript;base64,' + Buffer.from("export const activityNotification=()=>null; export const joinedNotification=name=>({title:'Traveller joined',body:name+' joined the holiday.'}); export const notifyMembers=async(...args)=>{globalThis[Symbol.for('triptab.invite-test-notifications')].push(args);};").toString('base64');
const source = await readFile(new URL('../lib/store.ts', import.meta.url), 'utf8');
const compiled = transpileWithSharedImports(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText
  .replace("'zod'", JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('zod').replace(/\.cjs$/, '.js')).href))
  .replace("'cloudflare:workers'", JSON.stringify(envUrl))
  .replace("'./model'", JSON.stringify(new URL('../lib/model.ts', import.meta.url).href))
  .replace("'./receipt-memory-ownership'", JSON.stringify(new URL('../lib/receipt-memory-ownership.ts', import.meta.url).href))
  .replace("'./receipt-context'", JSON.stringify(new URL('../lib/receipt-context.ts', import.meta.url).href))
  .replace("'./auth'", JSON.stringify(new URL('../lib/auth.ts', import.meta.url).href))
  .replace("'./activity-scope'", JSON.stringify(new URL('../lib/activity-scope.ts', import.meta.url).href))
  .replace("'./receipt-lifecycle'", JSON.stringify(new URL('../lib/receipt-lifecycle.ts', import.meta.url).href))
  .replace("'./notifications'", JSON.stringify(notificationUrl));
const storeUrl = 'data:text/javascript;base64,' + Buffer.from(compiled).toString('base64');
const store = await import(storeUrl) as typeof import('../lib/store');
const routeSource = await readFile(new URL('../app/api/invite/route.ts', import.meta.url), 'utf8');
const routeCompiled = transpileWithSharedImports(routeSource, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText
  .replace("'@/lib/store'", JSON.stringify(storeUrl))
  .replace("'@/lib/model'", JSON.stringify(new URL('../lib/model.ts', import.meta.url).href))
  .replace("'@/lib/notifications'", JSON.stringify(notificationUrl));
const route = await import('data:text/javascript;base64,' + Buffer.from(routeCompiled).toString('base64')) as typeof import('../app/api/invite/route');

const users = { owner: 'owner-1', bob: 'bob-account', outsider: 'outsider-account' };
function provider(user: keyof typeof users) {
  return { 'oai-authenticated-user-id': users[user], 'oai-authenticated-user-email': `${user}@example.com` };
}
function get(query: string, user: keyof typeof users | null = 'bob') {
  return route.GET(new Request(`https://triptab.test/api/invite?${query}`, { headers: user ? provider(user) : {} }));
}
function post(body: Record<string, unknown>, user: keyof typeof users | null = 'owner', extra: Record<string, string> = {}) {
  return route.POST(new Request('https://triptab.test/api/invite', { method: 'POST', headers: { ...(user ? provider(user) : {}), origin: 'https://triptab.test', 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) }));
}
async function json<T = Record<string, unknown>>(response: Response) { return await response.json() as T; }
type Created = { url: string; expiresAt: string; invitationId: string; revision: number };
type Preview = { tripId: string; memberName: string; historySnapshot: string; history: { available: boolean; currency: string; costShare?: number; paidUpfront?: number; paymentsSent?: number; paymentsReceived?: number; netBalance?: number; expenseCount: number; paymentCount: number } };
function token(invitation: Created) { return new URL(invitation.url).searchParams.get('invite')!; }
function holiday(id = 'trip-1'): Trip {
  return { id, name: 'Lisbon invitation', currency: 'GBP', members: [{ id: 'a', name: 'Owner' }, { id: 'b', name: 'Traveller Bob' }, { id: 'c', name: 'Carol' }], expenses: [], payments: [], drafts: [] };
}
async function storage(history = false) {
  const database = new SQLiteD1();
  for (const file of (await readdir(new URL('../drizzle/', import.meta.url))).filter(file => file.endsWith('.sql')).sort()) database.sqlite.exec(await readFile(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'));
  for (const [name, id] of Object.entries(users)) database.sqlite.prepare('INSERT INTO profiles (id,email,display_name,created_at) VALUES (?,?,?,?)').run(id, `${name}@example.com`, `${name} profile name`, '2026-10-04T00:00:00Z');
  binding.DB = database.asD1(); notifications.length = 0;
  const trip = holiday();
  if (history) {
    const base = { date: '2026-10-04', time: '12:00', timezone: 'Europe/Lisbon', tax: 0, tip: 0, discount: 0 };
    trip.expenses = [
      { ...base, id: 'dinner', title: 'Shared dinner', currency: 'GBP', payer: 'a', items: [{ id: 'food', name: 'Dinner', amount: 2000, members: ['a', 'b'] }] },
      { ...base, id: 'bank', title: 'Euro bank receipt', currency: 'EUR', payer: 'a', bankAmount: 4000, percentages: { a: 25, b: 75 }, items: [{ id: 'hotel', name: 'Hotel', amount: 5000, members: ['a', 'b'] }] },
      { ...base, id: 'bob-paid', title: 'Bob lunch', currency: 'GBP', payer: 'b', items: [{ id: 'lunch', name: 'Lunch', amount: 600, members: ['a', 'b'] }] },
    ];
    trip.payments = [{ id: 'sent', from: 'b', to: 'a', amount: 1500, date: '2026-10-04' }, { id: 'received', from: 'a', to: 'b', amount: 200, date: '2026-10-04' }];
  }
  await store.writeLedger(users.owner, { trips: [trip] }, 0);
  notifications.length = 0;
  return database;
}
async function create(memberId = 'b', email?: string) {
  const response = await post({ mode: 'create', tripId: 'trip-1', memberId, email });
  assert.equal(response.status, 200); return json<Created>(response);
}
async function preview(invitation: Created, user: keyof typeof users = 'bob') {
  const response = await get('token=' + token(invitation), user); assert.equal(response.status, 200); return json<Preview>(response);
}
function accept(invitation: Created, info: Preview, user: keyof typeof users = 'bob') {
  return post({ mode: 'accept', token: token(invitation), acceptHistory: true, historySnapshot: info.historySnapshot }, user);
}
function activityCount(database: SQLiteD1) { return database.sqlite.prepare('SELECT COUNT(*) AS n FROM activity_events').get()?.n as number; }
function revision(database: SQLiteD1) { return database.sqlite.prepare('SELECT revision FROM sync_state WHERE id=1').get()?.revision as number; }
function inviteEvents(database: SQLiteD1) {
  return database.sqlite.prepare("SELECT * FROM activity_events WHERE entity_type='invite' ORDER BY sequence").all().map(row => ({
    id: String(row.entity_id), actorId: String(row.actor_id), actorName: String(row.actor_name),
    source: String(row.source), action: String(row.action), revision: Number(row.revision),
    before: row.before_data ? JSON.parse(String(row.before_data)) : null,
    after: row.after_data ? JSON.parse(String(row.after_data)) : null,
  }));
}

test('only the owner can list/revoke invitations; responses omit tokens and stored hashes', async () => {
  const database = await storage(); const invitation = await create();
  assert.equal((await get('mode=list&tripId=trip-1', null)).status, 401);
  assert.equal((await get('mode=list&tripId=trip-1', 'bob')).status, 403);
  assert.equal((await get('mode=list&tripId=trip-1', 'outsider')).status, 403);
  const response = await get('mode=list&tripId=trip-1', 'owner');
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const listed = await json<{ invitations: { id: string; memberName: string }[] }>(response);
  assert.equal(listed.invitations.length, 1); assert.equal(listed.invitations[0].id, invitation.invitationId);
  const body = JSON.stringify(listed);
  assert.ok(!body.includes(token(invitation))); assert.ok(!body.includes(String(database.sqlite.prepare('SELECT token_hash FROM invites').get()?.token_hash)));
  assert.equal((await get('token=' + invitation.invitationId)).status, 404, 'management ID cannot redeem invitation');
  assert.equal((await post({ mode: 'revoke', tripId: 'trip-1', invitationId: invitation.invitationId }, 'bob')).status, 403);
  assert.equal((await post({ mode: 'revoke', tripId: 'trip-1', invitationId: invitation.invitationId }, 'outsider')).status, 403);
  assert.equal((await post({ mode: 'revoke', tripId: 'trip-1', invitationId: invitation.invitationId })).status, 200);
  assert.equal((await get('token=' + token(invitation))).status, 404);
  assert.equal((await post({ mode: 'revoke', tripId: 'trip-1', invitationId: invitation.invitationId })).status, 409);
});

test('regenerating a traveller invitation atomically invalidates every earlier unused link for only that traveller', async () => {
  const database = await storage(); const old = await create(); const carol = await create('c');
  const fresh = await create('b', 'bob@example.com');
  assert.notEqual(token(fresh), token(old)); assert.notEqual(fresh.invitationId, old.invitationId);
  assert.equal((await get('token=' + token(old))).status, 404);
  assert.equal((await get('token=' + token(carol))).status, 200);
  assert.equal((await get('token=' + token(fresh))).status, 200);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM invites WHERE member_id='b' AND used_by IS NULL").get()?.n, 1);
  assert.equal((await post({ mode: 'accept', token: token(old), acceptHistory: true, historySnapshot: '0'.repeat(64) }, 'bob')).status, 404);
  const list = await json<{ invitations: { id: string }[] }>(await get('mode=list&tripId=trip-1', 'owner'));
  assert.deepEqual(list.invitations.map(value => value.id).sort(), [carol.invitationId, fresh.invitationId].sort());
});

test('invitation create, replacement, revoke and accept use stable safe identities and trusted lifecycle snapshots', async () => {
  const database = await storage();
  const baseline = revision(database);
  const first = await create('b', 'bob@example.com');
  const firstStored = database.sqlite.prepare("SELECT token_hash, audit_id FROM invites WHERE member_id='b'").get()!;
  assert.match(String(firstStored.audit_id), /^[a-f0-9-]{36}$/);
  const firstEvent = inviteEvents(database)[0];
  assert.equal(firstEvent.id, firstStored.audit_id);
  assert.notEqual(firstEvent.id, token(first));
  assert.notEqual(firstEvent.id, firstStored.token_hash);
  assert.equal(first.revision, baseline);
  assert.deepEqual(firstEvent.after, { id: firstStored.audit_id, memberId: 'b', memberName: 'Traveller Bob', expiresAt: first.expiresAt, emailRestricted: true, status: 'pending' });
  assert.equal(firstEvent.before, null);
  const second = await create('b');
  const secondStored = database.sqlite.prepare("SELECT audit_id FROM invites WHERE member_id='b'").get()!;
  let events = inviteEvents(database);
  assert.equal(events.length, 3);
  assert.equal(events[1].id, firstEvent.id);
  assert.deepEqual(events[1].before, firstEvent.after);
  assert.deepEqual(events[1].after, { ...firstEvent.after, status: 'revoked', reason: 'replaced' });
  assert.equal(events[2].id, secondStored.audit_id);
  assert.equal(events[2].after.emailRestricted, false);
  assert.equal(events[1].revision, second.revision);
  assert.equal(events[2].revision, second.revision);
  const revoked = await post({ mode: 'revoke', tripId: 'trip-1', invitationId: second.invitationId, actorId: users.outsider, source: 'chatgpt' });
  assert.equal(revoked.status, 200);
  events = inviteEvents(database);
  assert.equal(events.length, 4);
  assert.deepEqual(events[3].after, { ...events[2].after, status: 'revoked', reason: 'owner' });
  assert.equal((await json<{ revision: number }>(revoked)).revision, baseline);
  const third = await create('b', 'bob@example.com');
  const accepted = await accept(third, await preview(third));
  assert.equal(accepted.status, 200);
  events = inviteEvents(database);
  assert.equal(events.length, 6);
  assert.equal(events[5].id, events[4].id);
  assert.deepEqual(events[5].before, events[4].after);
  assert.deepEqual(events[5].after, { ...events[4].after, status: 'accepted' });
  assert.equal(events[5].actorId, users.bob);
  assert.equal(events[5].actorName, 'bob profile name');
  assert.equal(events[5].revision, baseline + 1);
  for (const event of events.slice(0, 5)) {
    assert.equal(event.actorId, users.owner);
    assert.equal(event.actorName, 'owner profile name');
  }
  assert.ok(events.every(event => event.source === 'web'));
  const serialized = JSON.stringify(events);
  for (const value of [token(first), token(second), token(third), String(firstStored.token_hash), 'bob@example.com', first.url, second.url, third.url]) assert.equal(serialized.includes(value), false);
  await assert.rejects(store.readActivity(users.outsider, 'trip-1'), /access/);
  const bobHistory = await store.readActivity(users.bob, 'trip-1', { limit: 50 });
  assert.equal(bobHistory.events.filter(event => event.entityType === 'invite').length, 6);
});

test('empty legacy audit IDs use a stable non-redeemable fallback when accepted', async () => {
  const database = await storage(); const invitation = await create();
  database.sqlite.exec("UPDATE invites SET audit_id='' WHERE member_id='b'");
  const count = activityCount(database);
  assert.equal((await accept(invitation, await preview(invitation))).status, 200);
  const event = inviteEvents(database).at(-1)!;
  assert.equal(event.id, invitation.invitationId);
  assert.notEqual(event.id, token(invitation));
  assert.equal((await get('token=' + event.id)).status, 404);
  assert.equal((await post({ mode: 'accept', token: token(invitation) }, 'bob')).status, 200);
  assert.equal(activityCount(database), count + 2);
});

test('replacement audits every earlier unused link including expired rollout rows and preserves other travellers', async () => {
  const database = await storage();
  await create('b'); const carol = await create('c');
  database.sqlite.prepare(`INSERT INTO invites (token_hash,audit_id,trip_id,member_id,email,expires_at,used_by,created_by)
    VALUES (?,?,?,?,?,?,NULL,?)`).run('7'.repeat(64), 'legacy-expired-audit-id', 'trip-1', 'b', 'private-pending@example.com', '2000-01-01T00:00:00Z', users.owner);
  const before = activityCount(database);
  const inviteCountBefore = inviteEvents(database).length;
  const fresh = await create('b');
  assert.equal(activityCount(database), before + 3);
  const events = inviteEvents(database).slice(inviteCountBefore);
  assert.equal(events.length, 3);
  assert.ok(events.every(event => event.revision === fresh.revision));
  assert.equal(events.filter(event => event.after?.reason === 'replaced').length, 2);
  const expired = events.find(event => event.id === 'legacy-expired-audit-id')!;
  assert.equal(expired.before.status, 'expired');
  assert.equal(expired.after.status, 'revoked');
  assert.equal(expired.after.emailRestricted, true);
  assert.equal(JSON.stringify(events).includes('private-pending@example.com'), false);
  assert.equal(JSON.stringify(events).includes('7'.repeat(64)), false);
  assert.equal((await get('token=' + token(carol))).status, 200);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM invites WHERE member_id='b'").get()?.n, 1);
});

test('activity insert failures roll back create, replacement, revoke and acceptance completely', async context => {
  for (const operation of ['create', 'replace', 'revoke', 'accept'] as const) await context.test(operation, async () => {
    const database = await storage(true);
    const invitation = operation === 'create' ? undefined : await create('b', 'bob@example.com');
    const info = operation === 'accept' ? await preview(invitation!) : undefined;
    const invitationsBefore = database.sqlite.prepare('SELECT * FROM invites ORDER BY token_hash').all();
    const tripsBefore = database.sqlite.prepare('SELECT * FROM trips ORDER BY id').all();
    const membersBefore = database.sqlite.prepare('SELECT * FROM memberships ORDER BY trip_id,user_id').all();
    const revisionBefore = revision(database);
    const eventsBefore = activityCount(database);
    database.sqlite.exec("CREATE TRIGGER fail_invite_audit BEFORE INSERT ON activity_events WHEN NEW.entity_type='invite' BEGIN SELECT RAISE(ABORT,'simulated invitation audit failure'); END;");
    const response = operation === 'revoke'
      ? await post({ mode: 'revoke', tripId: 'trip-1', invitationId: invitation!.invitationId })
      : operation === 'accept' ? await accept(invitation!, info!) : await post({ mode: 'create', tripId: 'trip-1', memberId: 'b' });
    assert.ok(response.status >= 400, 'Audit storage failures must not report a successful mutation');
    assert.doesNotMatch(JSON.stringify(await response.json()), /simulated invitation audit failure|token_hash|bob@example.com/);
    assert.deepEqual(database.sqlite.prepare('SELECT * FROM invites ORDER BY token_hash').all(), invitationsBefore);
    assert.deepEqual(database.sqlite.prepare('SELECT * FROM trips ORDER BY id').all(), tripsBefore);
    assert.deepEqual(database.sqlite.prepare('SELECT * FROM memberships ORDER BY trip_id,user_id').all(), membersBefore);
    assert.equal(revision(database), revisionBefore);
    assert.equal(activityCount(database), eventsBefore);
    assert.equal(notifications.length, 0);
  });
});

test('unauthorized, invalid and duplicate revoke requests cannot fabricate lifecycle events or revisions', async () => {
  const database = await storage(); const invitation = await create();
  const before = activityCount(database); const version = revision(database);
  for (const [user, body] of [
    ['bob', { mode: 'create', tripId: 'trip-1', memberId: 'c' }],
    ['outsider', { mode: 'revoke', tripId: 'trip-1', invitationId: invitation.invitationId }],
    ['owner', { mode: 'revoke', tripId: 'trip-1', invitationId: 'invite_' + '0'.repeat(64) }],
    ['owner', { mode: 'create', tripId: 'trip-1', memberId: 'a' }],
  ] as const) assert.ok((await post(body, user)).status >= 400);
  assert.equal(activityCount(database), before);
  assert.equal(revision(database), version);
  const replies = await Promise.all([
    post({ mode: 'revoke', tripId: 'trip-1', invitationId: invitation.invitationId }),
    post({ mode: 'revoke', tripId: 'trip-1', invitationId: invitation.invitationId }),
  ]);
  assert.deepEqual(replies.map(response => response.status).sort(), [200, 409]);
  assert.equal(activityCount(database), before + 1);
  assert.equal(revision(database), version);
});

test('competing regeneration records only the committed winner and exactly its prior-link revocation', async () => {
  const database = await storage(); const invitation = await create();
  const previous = inviteEvents(database).at(-1)!;
  const before = activityCount(database); const version = revision(database);
  let release!: () => void; let reached!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const atMutation = new Promise<void>(resolve => { reached = resolve; });
  database.beforeInviteBatch = () => { reached(); return held; };
  const first = post({ mode: 'create', tripId: 'trip-1', memberId: 'b' });
  await atMutation;
  const second = await post({ mode: 'create', tripId: 'trip-1', memberId: 'b' });
  release();
  const responses = [await first, second];
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  assert.equal(activityCount(database), before + 2);
  assert.equal(revision(database), version);
  assert.equal(inviteEvents(database).at(-2)!.id, previous.id);
  assert.equal(inviteEvents(database).at(-2)!.after.reason, 'replaced');
  assert.equal((await get('token=' + token(invitation))).status, 404);
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS n FROM invites').get()?.n, 1);
});

test('creating, replacing and revoking links do not invalidate an already loaded financial ledger', async () => {
  const database = await storage();
  const loaded = await store.readLedger(users.owner);
  const stateBefore = database.sqlite.prepare('SELECT * FROM sync_state').get();
  const first = await create(); const replacement = await create();
  assert.equal(first.revision, loaded.revision);
  assert.equal(replacement.revision, loaded.revision);
  const revoked = await post({ mode: 'revoke', tripId: 'trip-1', invitationId: replacement.invitationId });
  assert.equal(revoked.status, 200);
  assert.equal((await json<{ revision: number }>(revoked)).revision, loaded.revision);
  assert.deepEqual(database.sqlite.prepare('SELECT * FROM sync_state').get(), stateBefore);
  assert.ok(inviteEvents(database).every(event => event.revision === loaded.revision));
  loaded.data.trips[0].name = 'Saved after managing invitations';
  const saved = await store.writeLedger(users.owner, loaded.data, loaded.revision);
  assert.equal(saved.revision, loaded.revision + 1);
  assert.equal(saved.data.trips[0].name, 'Saved after managing invitations');
});

test('unrelated holiday saves between invitation snapshots and writes allow create, replacement and revoke', async context => {
  for (const operation of ['create', 'replace', 'revoke'] as const) await context.test(operation, async () => {
    const database = await storage();
    const original = await store.readLedger(users.owner);
    await store.writeLedger(users.owner, { trips: [...original.data.trips, holiday('other-trip')] }, original.revision);
    const prior = operation === 'create' ? undefined : await create();
    const tripBefore = database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get('trip-1')?.data;
    const revisionBefore = revision(database);
    database.beforeInviteBatch = async () => {
      const concurrent = await store.readLedger(users.owner);
      concurrent.data.trips.find(trip => trip.id === 'other-trip')!.name = 'An unrelated holiday edit';
      await store.writeLedger(users.owner, concurrent.data, concurrent.revision);
      assert.equal(database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get('trip-1')?.data, tripBefore);
    };
    const response = operation === 'revoke'
      ? await post({ mode: 'revoke', tripId: 'trip-1', invitationId: prior!.invitationId })
      : await post({ mode: 'create', tripId: 'trip-1', memberId: 'b' });
    assert.equal(response.status, 200);
    assert.equal((await json<{ revision: number }>(response)).revision, revisionBefore + 1);
    assert.equal(revision(database), revisionBefore + 1, 'Only the concurrent financial save advances the ledger');
    assert.equal(database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get('trip-1')?.data, tripBefore);
    const last = inviteEvents(database).at(-1)!;
    assert.equal(last.revision, revisionBefore + 1, 'Audit captures the revision inside the invitation transaction');
    assert.equal(last.after.status, operation === 'revoke' ? 'revoked' : 'pending');
  });
});

test('same-holiday expense and receipt-chat saves do not invalidate invitation snapshots', async context => {
  for (const operation of ['create', 'replace', 'revoke'] as const) {
    for (const edit of ['expense', 'receipt chat'] as const) await context.test(`${operation}: ${edit}`, async () => {
      const database = await storage(true);
      const prior = operation === 'create' ? undefined : await create();
      const eventCount = inviteEvents(database).length;
      const beforeRevision = revision(database);
      let concurrentData: unknown; let concurrentState: unknown;
      database.beforeInviteBatch = async () => {
        const concurrent = await store.readLedger(users.owner);
        const expense = concurrent.data.trips[0].expenses[0];
        if (edit === 'expense') expense.items[0].amount += 123;
        else expense.conversation = [{ id: 'concurrent-question', role: 'user', text: 'Was the service charge included?', createdAt: '2026-10-04T12:30:00Z' }];
        await store.writeLedger(users.owner, concurrent.data, concurrent.revision);
        concurrentData = database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get('trip-1')?.data;
        concurrentState = database.sqlite.prepare('SELECT * FROM sync_state').get();
      };
      const response = operation === 'revoke'
        ? await post({ mode: 'revoke', tripId: 'trip-1', invitationId: prior!.invitationId })
        : await post({ mode: 'create', tripId: 'trip-1', memberId: 'b' });
      assert.equal(response.status, 200);
      assert.equal((await json<{ revision: number }>(response)).revision, beforeRevision + 1);
      assert.equal(database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get('trip-1')?.data, concurrentData);
      assert.deepEqual(database.sqlite.prepare('SELECT * FROM sync_state').get(), concurrentState);
      const events = inviteEvents(database).slice(eventCount);
      assert.equal(events.length, operation === 'replace' ? 2 : 1);
      assert.ok(events.every(event => event.revision === beforeRevision + 1));
      assert.equal(events.at(-1)!.after.status, operation === 'revoke' ? 'revoked' : 'pending');
    });
  }
});

test('invitation management binds only a bounded traveller identity even when receipt history is large', async () => {
  const database = await storage(true);
  const loaded = await store.readLedger(users.owner);
  loaded.data.trips[0].expenses[0].conversation = Array.from({ length: 50 }, (_, index) => ({
    id: `large-chat-${index}`, role: 'user', text: 'é'.repeat(3900), createdAt: '2026-10-04T12:30:00Z',
  }));
  await store.writeLedger(users.owner, loaded.data, loaded.revision);
  const fullTrip = String(database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get('trip-1')?.data);
  assert.ok(Buffer.byteLength(fullTrip) > 390_000);
  const assertSmallBindings = () => {
    const values = database.invitationBatches.flatMap(batch => batch.flatMap(statement => statement.boundValues()));
    assert.ok(values.length > 0);
    const stringValues = values.filter((value): value is string => typeof value === 'string');
    assert.ok(stringValues.every(value => Buffer.byteLength(value) < 4096));
    assert.equal(stringValues.includes(fullTrip), false);
  };
  database.invitationBatches.length = 0;
  const invitation = await create(); assertSmallBindings();
  database.invitationBatches.length = 0;
  const replacement = await create(); assertSmallBindings();
  assert.equal((await get('token=' + token(invitation))).status, 404);
  database.invitationBatches.length = 0;
  assert.equal((await post({ mode: 'revoke', tripId: 'trip-1', invitationId: replacement.invitationId })).status, 200);
  assertSmallBindings();
});

test('traveller rename, removal, email, join and owner races still reject create and revoke without stale audit', async context => {
  for (const operation of ['create', 'revoke'] as const) {
    for (const change of ['rename', 'remove', 'email', 'join', 'owner'] as const) await context.test(`${operation}: ${change}`, async () => {
      const database = await storage();
      const invitation = await create();
      const info = change === 'join' ? await preview(invitation) : undefined;
      let eventCount = inviteEvents(database).length;
      let revisionAfterRace = revision(database);
      let invitationsAfterRace: unknown;
      database.beforeInviteBatch = async () => {
        if (change === 'rename' || change === 'remove') {
          const concurrent = await store.readLedger(users.owner);
          if (change === 'rename') concurrent.data.trips[0].members.find(member => member.id === 'b')!.name = 'Renamed traveller';
          else concurrent.data.trips[0].members = concurrent.data.trips[0].members.filter(member => member.id !== 'b');
          await store.writeLedger(users.owner, concurrent.data, concurrent.revision);
        } else if (change === 'email') {
          // Unlinked email metadata is server-owned: an independent trusted
          // update must be detected even if it does not advance the ledger.
          database.sqlite.exec("UPDATE trips SET data=json_set(data,'$.members[1].email','new-invitee@example.com') WHERE id='trip-1'");
        } else if (change === 'join') {
          assert.equal((await accept(invitation, info!)).status, 200);
        } else database.sqlite.prepare('UPDATE trips SET owner=? WHERE id=?').run(users.outsider, 'trip-1');
        eventCount = inviteEvents(database).length;
        revisionAfterRace = revision(database);
        invitationsAfterRace = database.sqlite.prepare('SELECT * FROM invites ORDER BY token_hash').all();
      };
      const response = operation === 'revoke'
        ? await post({ mode: 'revoke', tripId: 'trip-1', invitationId: invitation.invitationId })
        : await post({ mode: 'create', tripId: 'trip-1', memberId: 'b' });
      assert.equal(response.status, 409);
      assert.equal(inviteEvents(database).length, eventCount);
      assert.equal(revision(database), revisionAfterRace);
      assert.deepEqual(database.sqlite.prepare('SELECT * FROM invites ORDER BY token_hash').all(), invitationsAfterRace);
    });
  }
});

test('actual revoke or replacement winning after an invitation pre-read leaves only the winner’s audit', async context => {
  for (const operation of ['create', 'revoke'] as const) await context.test(operation, async () => {
    const database = await storage(); const invitation = await create();
    const eventCount = inviteEvents(database).length; const version = revision(database);
    let invitationsAfterWinner: unknown;
    database.beforeInviteBatch = async () => {
      const winner = operation === 'create'
        ? await post({ mode: 'revoke', tripId: 'trip-1', invitationId: invitation.invitationId })
        : await post({ mode: 'create', tripId: 'trip-1', memberId: 'b' });
      assert.equal(winner.status, 200);
      invitationsAfterWinner = database.sqlite.prepare('SELECT * FROM invites ORDER BY token_hash').all();
    };
    const response = operation === 'create'
      ? await post({ mode: 'create', tripId: 'trip-1', memberId: 'b' })
      : await post({ mode: 'revoke', tripId: 'trip-1', invitationId: invitation.invitationId });
    assert.equal(response.status, 409);
    assert.deepEqual(database.sqlite.prepare('SELECT * FROM invites ORDER BY token_hash').all(), invitationsAfterWinner);
    assert.equal(inviteEvents(database).length, eventCount + (operation === 'create' ? 1 : 2));
    assert.equal(revision(database), version);
  });
});

test('revoke snapshot guards reject invitation and membership races without emitting stale activity', async context => {
  for (const change of ['member', 'audit', 'claimed', 'membership'] as const) await context.test(change, async () => {
    const database = await storage(); const invitation = await create();
    const before = activityCount(database); const version = revision(database);
    database.beforeInviteBatch = () => {
      if (change === 'member') database.sqlite.exec("UPDATE invites SET member_id='c'");
      if (change === 'audit') database.sqlite.exec("UPDATE invites SET audit_id='changed-audit'");
      if (change === 'claimed') database.sqlite.prepare('UPDATE invites SET used_by=?').run(users.bob);
      if (change === 'membership') database.sqlite.prepare('INSERT INTO memberships (trip_id,user_id,member_id) VALUES (?,?,?)').run('trip-1', users.bob, 'b');
    };
    const response = await post({ mode: 'revoke', tripId: 'trip-1', invitationId: invitation.invitationId });
    assert.equal(response.status, 409);
    assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS n FROM invites').get()?.n, 1);
    assert.equal(activityCount(database), before);
    assert.equal(revision(database), version);
  });
});

test('regeneration snapshot guard rejects an unversioned link replacement without logging stale revocations', async () => {
  const database = await storage(); await create();
  const before = activityCount(database); const version = revision(database);
  database.beforeInviteBatch = () => database.sqlite.exec("UPDATE invites SET audit_id='concurrently-changed-audit-id'");
  const response = await post({ mode: 'create', tripId: 'trip-1', memberId: 'b' });
  assert.equal(response.status, 409);
  assert.equal(activityCount(database), before);
  assert.equal(revision(database), version);
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS n FROM invites').get()?.n, 1);
});

test('join preview contains exact inherited expense/payment totals and no unrelated trip or record details', async () => {
  const database = await storage(true);
  const state = await store.readLedger(users.owner); const other = holiday('private-trip');
  other.name = 'PRIVATE_OTHER_TRIP'; other.members = [{ id: 'a', name: 'Owner' }];
  other.expenses = [{ ...state.data.trips[0].expenses[0], id: 'private-expense', title: 'PRIVATE_GIFT_DETAIL', items: [{ id: 'private-line', name: 'PRIVATE_ITEM_DETAIL', amount: 8000, members: ['a'] }] }];
  await store.writeLedger(users.owner, { trips: [...state.data.trips, other] }, state.revision);
  const invitation = await create(); const info = await preview(invitation);
  assert.deepEqual(info.history, { available: true, currency: 'GBP', expenseCount: 3, paymentCount: 2, costShare: 4300, paidUpfront: 600, paymentsSent: 1500, paymentsReceived: 200, netBalance: -2400 });
  assert.match(info.historySnapshot, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(info), /PRIVATE_|Euro bank receipt|bob@example.com|owner@example.com|password|token_hash/);
  const before = activityCount(database);
  assert.equal((await post({ mode: 'accept', token: token(invitation) }, 'bob')).status, 409);
  assert.equal((await post({ mode: 'accept', token: token(invitation), acceptHistory: false, historySnapshot: info.historySnapshot }, 'bob')).status, 409);
  assert.equal(activityCount(database), before);
});

test('a stale financial preview cannot be accepted; refreshed confirmation preserves existing money and account profile', async () => {
  const database = await storage(true); const invitation = await create(); const old = await preview(invitation);
  const state = await store.readLedger(users.owner); state.data.trips[0].expenses[0].items[0].amount += 1000;
  await store.writeLedger(users.owner, state.data, state.revision);
  const before = activityCount(database);
  assert.equal((await accept(invitation, old)).status, 409); assert.equal(activityCount(database), before);
  const fresh = await preview(invitation); assert.notEqual(fresh.historySnapshot, old.historySnapshot);
  const financialBefore = (await store.readLedger(users.owner)).data.trips[0];
  assert.equal((await accept(invitation, fresh)).status, 200);
  const after = (await store.readLedger(users.bob)).data.trips[0];
  assert.deepEqual(after.expenses, financialBefore.expenses); assert.deepEqual(after.payments, financialBefore.payments);
  assert.equal(after.members.find(member => member.id === 'b')?.name, 'Traveller Bob');
  assert.equal(database.sqlite.prepare('SELECT display_name FROM profiles WHERE id=?').get(users.bob)?.display_name, 'bob profile name');
  assert.equal(activityCount(database), before + 2);
});

test('invitation account association enforces the stored UTF8 trip limit before any guarded writes', async context => {
  for (const boundary of ['over limit', 'exact limit'] as const) await context.test(boundary, async () => {
    const database = await storage(true);
    const invitation = await create();
    const accountId = 'p'.repeat(320);
    const accountEmail = 'long-account@example.com';
    database.sqlite.prepare('INSERT INTO profiles (id,email,display_name,created_at) VALUES (?,?,?,?)')
      .run(accountId, accountEmail, 'Long account name', '2026-10-04T00:00:00Z');
    const trip = JSON.parse(String(database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get('trip-1')?.data)) as Trip;
    // Existing records can omit fields whose read schema supplies defaults.
    // Linking an account must preserve their saved financial representation.
    delete (trip.expenses[0] as Partial<Trip['expenses'][number]>).time;
    delete (trip.expenses[0] as Partial<Trip['expenses'][number]>).timezone;
    for (const [expenseIndex, expense] of trip.expenses.entries()) {
      expense.conversation = Array.from({ length: 100 }, (_, messageIndex) => ({
        id: `cap-${expenseIndex}-${messageIndex}`, role: 'user', text: 'é', createdAt: '2026-10-04T00:00:00Z',
      }));
    }
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    const joined = { ...trip, members: trip.members.map(member => member.id === 'b'
      ? { ...member, userId: accountId, email: accountEmail } : member) };
    const associationGrowth = bytes(joined) - bytes(trip);
    const target = boundary === 'over limit' ? store.MAX_STORED_TRIP_BYTES - 1 : store.MAX_STORED_TRIP_BYTES - associationGrowth;
    let remaining = target - bytes(trip);
    for (const message of trip.expenses.flatMap(expense => expense.conversation!)) {
      const addition = Math.min(remaining, 7998);
      message.text += 'é'.repeat(Math.floor(addition / 2)) + (addition % 2 ? 'a' : '');
      remaining -= addition;
    }
    assert.equal(remaining, 0);
    assert.equal(bytes(trip), target);
    assert.ok(JSON.stringify(trip).length < store.MAX_STORED_TRIP_BYTES - associationGrowth,
      'UTF16 character counts would wrongly permit this Unicode account association');
    // Model-valid historical content, already bearing server policy metadata,
    // is placed near the hard storage cap without inventing a new client write.
    database.sqlite.prepare('UPDATE trips SET data=? WHERE id=?').run(JSON.stringify(trip), 'trip-1');
    const headers = { 'oai-authenticated-user-id': accountId, 'oai-authenticated-user-email': accountEmail };
    const info = await json<Preview>(await route.GET(new Request('https://triptab.test/api/invite?token=' + token(invitation), { headers })));
    assert.match(info.historySnapshot, /^[a-f0-9]{64}$/);
    const before = {
      trip: database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get('trip-1')?.data,
      invites: database.sqlite.prepare('SELECT * FROM invites ORDER BY token_hash').all(),
      memberships: database.sqlite.prepare('SELECT * FROM memberships ORDER BY trip_id,user_id').all(),
      activity: database.sqlite.prepare('SELECT * FROM activity_events ORDER BY sequence').all(),
      state: database.sqlite.prepare('SELECT * FROM sync_state').all(),
    };
    const response = await post({ mode: 'accept', token: token(invitation), acceptHistory: true, historySnapshot: info.historySnapshot }, 'bob', headers);
    if (boundary === 'over limit') {
      assert.equal(response.status, 413);
      assert.match(String((await json(response)).error), /too much stored receipt or payment content to link another account/);
      assert.equal(database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get('trip-1')?.data, before.trip);
      assert.deepEqual(database.sqlite.prepare('SELECT * FROM invites ORDER BY token_hash').all(), before.invites);
      assert.deepEqual(database.sqlite.prepare('SELECT * FROM memberships ORDER BY trip_id,user_id').all(), before.memberships);
      assert.deepEqual(database.sqlite.prepare('SELECT * FROM activity_events ORDER BY sequence').all(), before.activity);
      assert.deepEqual(database.sqlite.prepare('SELECT * FROM sync_state').all(), before.state);
      assert.equal(notifications.length, 0);
    } else {
      assert.equal(response.status, 200);
      const stored = String(database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get('trip-1')?.data);
      assert.equal(new TextEncoder().encode(stored).byteLength, store.MAX_STORED_TRIP_BYTES);
      const after = JSON.parse(stored) as Trip;
      assert.deepEqual(after.expenses, trip.expenses);
      assert.deepEqual(after.payments, trip.payments);
      assert.deepEqual(after.drafts, trip.drafts);
      assert.deepEqual(after.members.find(member => member.id === 'b'), { ...trip.members[1], userId: accountId, email: accountEmail });
      assert.equal(activityCount(database), before.activity.length + 2);
      const events = database.sqlite.prepare('SELECT actor_id,actor_name,source,revision FROM activity_events ORDER BY sequence DESC LIMIT 2').all();
      for (const event of events) assert.deepEqual({ ...event }, { actor_id: accountId, actor_name: 'Long account name', source: 'web', revision: revision(database) });
      assert.equal(notifications.length, 1);
    }
  });
});

test('consent for one traveller cannot claim another invitation in the same unchanged holiday', async () => {
  const database = await storage(true);
  const bobInvitation = await create('b');
  const carolInvitation = await create('c');
  const bobPreview = await preview(bobInvitation);
  const carolPreview = await preview(carolInvitation);
  assert.equal(bobPreview.tripId, carolPreview.tripId);
  assert.notEqual(bobPreview.memberName, carolPreview.memberName);
  assert.notEqual(bobPreview.historySnapshot, carolPreview.historySnapshot);
  const originalTrip = database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get('trip-1')?.data;
  const before = activityCount(database);
  const rejected = await accept(carolInvitation, bobPreview);
  assert.equal(rejected.status, 409);
  assert.equal(database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get('trip-1')?.data, originalTrip);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM memberships WHERE member_id IN ('b','c')").get()?.n, 0);
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS n FROM invites WHERE used_by IS NOT NULL').get()?.n, 0);
  assert.equal(activityCount(database), before);
  assert.equal(notifications.length, 0);
  assert.equal((await accept(carolInvitation, carolPreview)).status, 200);
  const joined = (await store.readLedger(users.bob)).data.trips[0];
  assert.equal(joined.members.find(member => member.id === 'c')?.userId, users.bob);
  assert.equal(joined.members.find(member => member.id === 'b')?.userId, undefined);
  const financialBefore = JSON.parse(String(originalTrip)) as Trip;
  assert.deepEqual(joined.expenses, financialBefore.expenses);
  assert.deepEqual(joined.payments, financialBefore.payments);
  assert.equal(activityCount(database), before + 2);
});

test('simultaneous repeated join is idempotent and emits one membership/activity/notification', async () => {
  const database = await storage(true); const invitation = await create(); const info = await preview(invitation); const before = activityCount(database);
  const replies = await Promise.all([accept(invitation, info), accept(invitation, info)]);
  assert.deepEqual(replies.map(response => response.status), [200, 200]);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM memberships WHERE member_id='b'").get()?.n, 1);
  assert.equal(activityCount(database), before + 2); assert.equal(notifications.length, 1);
  const event = database.sqlite.prepare("SELECT actor_id, before_data, after_data FROM activity_events WHERE entity_type='member' AND entity_id='b' AND action='update'").get();
  assert.equal(event?.actor_id, users.bob); assert.equal(JSON.parse(String(event?.before_data)).userId, undefined); assert.equal(JSON.parse(String(event?.after_data)).userId, users.bob);
  assert.equal((await post({ mode: 'accept', token: token(invitation) }, 'bob')).status, 200, 'self replay remains idempotent without a fresh confirmation');
  const listed = await json<{ invitations: unknown[] }>(await get('mode=list&tripId=trip-1', 'owner')); assert.equal(listed.invitations.length, 0);
});

test('two different accounts cannot claim the same traveller even with the same confirmed preview', async () => {
  const database = await storage(); const invitation = await create(); const info = await preview(invitation); const before = activityCount(database);
  const replies = await Promise.all([accept(invitation, info, 'bob'), accept(invitation, info, 'outsider')]);
  assert.deepEqual(replies.map(response => response.status).sort(), [200, 409]);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM memberships WHERE member_id='b'").get()?.n, 1);
  assert.equal(activityCount(database), before + 2);
});

test('trip changes after preview validation still fail the in-batch CAS/snapshot check', async () => {
  const database = await storage(true); const invitation = await create(); const info = await preview(invitation); const before = activityCount(database);
  database.beforeWriteBatch = () => {
    const row = database.sqlite.prepare('SELECT data FROM trips WHERE id=?').get('trip-1'); const trip = JSON.parse(String(row?.data));
    trip.expenses[0].items[0].amount += 1000;
    database.sqlite.prepare('UPDATE trips SET data=? WHERE id=?').run(JSON.stringify(trip), 'trip-1');
    database.sqlite.exec('UPDATE sync_state SET revision=revision+1 WHERE id=1');
  };
  assert.equal((await accept(invitation, info)).status, 409);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM memberships WHERE member_id='b'").get()?.n, 0); assert.equal(activityCount(database), before);
  assert.equal(database.sqlite.prepare('SELECT used_by FROM invites').get()?.used_by, null);
});

test('acceptance pins every captured invitation reference even when independent row changes omit revision updates', async context => {
  for (const [field, value] of [
    ['member_id', 'c'], ['trip_id', 'other-trip'], ['created_by', users.outsider], ['email', 'bob@example.com'],
  ] as const) await context.test(field, async () => {
    const database = await storage(true);
    const existing = await store.readLedger(users.owner);
    await store.writeLedger(users.owner, { trips: [...existing.data.trips, holiday('other-trip')] }, existing.revision);
    const invitation = await create('b'); const info = await preview(invitation);
    const tripBefore = database.sqlite.prepare('SELECT id,data FROM trips ORDER BY id').all();
    const membersBefore = database.sqlite.prepare('SELECT * FROM memberships ORDER BY trip_id,user_id').all();
    const countBefore = activityCount(database); const revisionBefore = revision(database);
    database.beforeWriteBatch = () => {
      database.sqlite.prepare(`UPDATE invites SET ${field}=? WHERE member_id='b'`).run(value);
    };
    const response = await accept(invitation, info);
    assert.ok(response.status >= 400, `Changed ${field} must prevent acceptance`);
    assert.deepEqual(database.sqlite.prepare('SELECT id,data FROM trips ORDER BY id').all(), tripBefore);
    assert.deepEqual(database.sqlite.prepare('SELECT * FROM memberships ORDER BY trip_id,user_id').all(), membersBefore);
    assert.equal(database.sqlite.prepare('SELECT used_by FROM invites').get()?.used_by, null);
    assert.equal(revision(database), revisionBefore);
    assert.equal(activityCount(database), countBefore);
    assert.equal(notifications.length, 0);
  });
});

test('revoking after an accept pre-read prevents the join and leaves no activity', async () => {
  const database = await storage(); const invitation = await create(); const info = await preview(invitation); const before = activityCount(database);
  database.beforeWriteBatch = () => database.sqlite.exec('DELETE FROM invites');
  assert.equal((await accept(invitation, info)).status, 404);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM memberships WHERE member_id='b'").get()?.n, 0); assert.equal(activityCount(database), before);
});

test('failed concurrent regeneration never deletes the prior unused link', async () => {
  const database = await storage(); await create(); const prior = database.sqlite.prepare('SELECT token_hash FROM invites').get()?.token_hash;
  database.beforeInviteBatch = () => {
    database.sqlite.prepare('INSERT INTO memberships (trip_id,user_id,member_id) VALUES (?,?,?)').run('trip-1', users.outsider, 'b');
    database.sqlite.exec("UPDATE trips SET data=json_set(data,'$.members[1].userId','outsider-account') WHERE id='trip-1'; UPDATE sync_state SET revision=revision+1 WHERE id=1");
  };
  const response = await post({ mode: 'create', tripId: 'trip-1', memberId: 'b' }); assert.equal(response.status, 409);
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS n FROM invites').get()?.n, 1); assert.equal(database.sqlite.prepare('SELECT token_hash FROM invites').get()?.token_hash, prior);
});

test('expired invitations are excluded from active list and cannot preview or join', async () => {
  const database = await storage(); const invitation = await create(); const info = await preview(invitation);
  database.sqlite.exec("UPDATE invites SET expires_at='2000-01-01T00:00:00Z'");
  assert.equal((await get('token=' + token(invitation))).status, 410); assert.equal((await accept(invitation, info)).status, 410);
  assert.deepEqual((await json<{ invitations: unknown[] }>(await get('mode=list&tripId=trip-1', 'owner'))).invitations, []);
});

test('standalone email/password accounts can confirm and join without any ChatGPT identity', async () => {
  const database = await storage(true);
  const authRequest = new Request('https://triptab.test/api/auth', { headers: { 'cf-connecting-ip': '203.0.113.2' } });
  const account = await performAuthAction(authRequest, { action: 'register', email: 'native@example.com', password: 'native suitcase 2026', displayName: 'My own profile' }, database.asD1());
  const cookie = account.cookie!.split(';')[0]; const invitation = await create('b', 'native@example.com');
  const nativeGet = await route.GET(new Request('https://triptab.test/api/invite?token=' + token(invitation), { headers: { cookie } }));
  assert.equal(nativeGet.status, 200); const info = await json<Preview>(nativeGet);
  const accepted = await route.POST(new Request('https://triptab.test/api/invite', { method: 'POST', headers: { cookie, origin: 'https://triptab.test', 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'accept', token: token(invitation), acceptHistory: true, historySnapshot: info.historySnapshot }) }));
  assert.equal(accepted.status, 200); assert.equal(account.state.emailVerified, false);
  assert.equal(database.sqlite.prepare("SELECT user_id FROM memberships WHERE member_id='b'").get()?.user_id, account.state.profile!.id);
  assert.equal(database.sqlite.prepare('SELECT display_name FROM profiles WHERE id=?').get(account.state.profile!.id)?.display_name, 'My own profile');
});

test('invitation routes reject ambiguous queries, invalid bodies and cross-origin mutations', async () => {
  await storage();
  for (const query of ['mode=list&mode=list&tripId=trip-1', 'mode=list&tripId=trip-1&tripId=other', 'mode=list&tripId=trip-1&token=x', 'mode=other&tripId=trip-1']) assert.equal((await get(query, 'owner')).status, 400);
  assert.equal((await get('token=x&token=y')).status, 404);
  assert.ok((await post({ mode: 'create', tripId: 'trip-1', memberId: 'b' }, 'owner', { origin: 'https://evil.test' })).status >= 400);
  assert.equal((await post({ mode: 'create', tripId: 'trip-1', memberId: 'b' }, 'owner', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post({ mode: 'create', tripId: 'trip-1', memberId: 'b', padding: 'x'.repeat(4096) })).status, 413);
});
