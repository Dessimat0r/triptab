import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { performAuthAction } from '../lib/auth';
import type { Trip } from '../lib/model';

// Same native SQLite/D1 transaction harness as store.test.ts: only Worker
// bindings and external notification delivery are replaced. All auth, invite,
// snapshot, membership, JSON and activity SQL executes against the real tables.
class SQLiteStatement {
  private values: (string | number | null)[] = [];
  constructor(private readonly sqlite: DatabaseSync, readonly sql: string) {}
  bind(...values: (string | number | null)[]) { this.values = values; return this; }
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
  beforeInviteBatch?: () => void;
  private pending: Promise<unknown> = Promise.resolve();
  prepare(sql: string) { return new SQLiteStatement(this.sqlite, sql); }
  batch(statements: SQLiteStatement[]) {
    const operation = this.pending.then(() => {
      if (statements.some(statement => /^UPDATE sync_state/.test(statement.sql.trim()))) {
        const hook = this.beforeWriteBatch; this.beforeWriteBatch = undefined; hook?.();
      }
      if (statements.some(statement => /^INSERT INTO invites/.test(statement.sql.trim()))) {
        const hook = this.beforeInviteBatch; this.beforeInviteBatch = undefined; hook?.();
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
const notificationUrl = 'data:text/javascript;base64,' + Buffer.from("export const activityNotification=()=>null; export const notifyMembers=async(...args)=>{globalThis[Symbol.for('triptab.invite-test-notifications')].push(args);};").toString('base64');
const source = await readFile(new URL('../lib/store.ts', import.meta.url), 'utf8');
const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText
  .replace("'zod'", JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('zod').replace(/\.cjs$/, '.js')).href))
  .replace("'cloudflare:workers'", JSON.stringify(envUrl))
  .replace("'./model'", JSON.stringify(new URL('../lib/model.ts', import.meta.url).href))
  .replace("'./receipt-memory-ownership'", JSON.stringify(new URL('../lib/receipt-memory-ownership.ts', import.meta.url).href))
  .replace("'./receipt-context'", JSON.stringify(new URL('../lib/receipt-context.ts', import.meta.url).href))
  .replace("'./auth'", JSON.stringify(new URL('../lib/auth.ts', import.meta.url).href))
  .replace("'./receipt-lifecycle'", JSON.stringify(new URL('../lib/receipt-lifecycle.ts', import.meta.url).href))
  .replace("'./notifications'", JSON.stringify(notificationUrl));
const storeUrl = 'data:text/javascript;base64,' + Buffer.from(compiled).toString('base64');
const store = await import(storeUrl) as typeof import('../lib/store');
const routeSource = await readFile(new URL('../app/api/invite/route.ts', import.meta.url), 'utf8');
const routeCompiled = transpileModule(routeSource, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText
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
type Created = { url: string; expiresAt: string; invitationId: string };
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
  assert.equal(activityCount(database), before + 1);
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
  assert.equal(activityCount(database), before + 1);
});

test('simultaneous repeated join is idempotent and emits one membership/activity/notification', async () => {
  const database = await storage(true); const invitation = await create(); const info = await preview(invitation); const before = activityCount(database);
  const replies = await Promise.all([accept(invitation, info), accept(invitation, info)]);
  assert.deepEqual(replies.map(response => response.status), [200, 200]);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM memberships WHERE member_id='b'").get()?.n, 1);
  assert.equal(activityCount(database), before + 1); assert.equal(notifications.length, 1);
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
  assert.equal(activityCount(database), before + 1);
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
