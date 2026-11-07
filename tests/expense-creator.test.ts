import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { FINANCIAL_FORMAT, FINANCIAL_FORMAT_HEADER } from '../lib/financial-format';
import type { Expense, Ledger } from '../lib/model';
import { createReceiptFlowWorker } from './helpers/receipt-flow-worker';

// D05: any member may edit or delete an expense, so TripTab names who added
// it. The creator comes from the trip's append-only history (the earliest
// "create" event), so no client can set or change it and nothing is added to
// the stored ledger. Production routes and storage on Miniflare D1, with two
// real accounts on one holiday and one outsider.
type Flow = Awaited<ReturnType<typeof createReceiptFlowWorker>>;
type Snapshot = { data: Ledger; revision: number };
type Requester = (path: string, init?: RequestInit & { body?: string }) => Promise<{ status: number; json(): Promise<unknown>; clone(): { text(): Promise<string> } }>;

async function account(flow: Flow, id: string, name: string, member?: string): Promise<Requester> {
  const token = randomBytes(32).toString('base64url'), now = new Date().toISOString();
  await flow.database.batch([
    flow.database.prepare('INSERT INTO profiles(id,email,display_name,created_at) VALUES(?,?,?,?)').bind(id, `${id}@example.test`, name, now),
    flow.database.prepare('INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at,session_id) VALUES(?,?,?,?,?)')
      .bind(createHash('sha256').update(token).digest('hex'), id, new Date(Date.now() + 30 * 60_000).toISOString(), now, `${id}-session`),
    ...(member ? [flow.database.prepare('INSERT INTO memberships(trip_id,user_id,member_id) VALUES(?,?,?)').bind(flow.tripId, id, member)] : []),
  ]);
  return (path, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cookie', `tt_session=${token}`); headers.set(FINANCIAL_FORMAT_HEADER, String(FINANCIAL_FORMAT));
    if (init.method && init.method !== 'GET') { headers.set('origin', flow.origin); headers.set('sec-fetch-site', 'same-origin'); headers.set('content-type', 'application/json'); }
    return flow.worker.dispatchFetch(new URL(path, flow.origin).href, { ...init, headers } as never) as never;
  };
}
const asOwner = (flow: Flow): Requester => flow.browserRequest as never;
async function read(request: Requester) {
  const response = await request('/api/ledger');
  assert.equal(response.status, 200);
  return response.json() as Promise<Snapshot>;
}
async function save(request: Requester, snapshot: Snapshot) {
  const response = await request('/api/ledger', { method: 'POST', body: JSON.stringify({ data: snapshot.data, revision: snapshot.revision }) });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json() as Promise<Snapshot>;
}
const expense = (id: string, payer: string, members: string[], extra: Record<string, unknown> = {}) => ({ id, title: `Expense ${id}`, date: '2026-11-07', time: '12:00',
  timezone: 'Europe/London', currency: 'GBP', payer, tax: 0, tip: 0, discount: 0, items: [{ id: `${id}-item`, name: 'Item', amount: 1200, members }], ...extra }) as Expense;
const tripOf = (snapshot: Snapshot, flow: Flow) => snapshot.data.trips.find(value => value.id === flow.tripId)!;
async function creator(request: Requester, flow: Flow, expenseId: string, tripId = flow.tripId) {
  const response = await request(`/api/expense-creator?${new URLSearchParams({ tripId, expenseId })}`);
  return { status: response.status, body: response.status === 200 ? await response.json() as { name: string | null; accountId: string } : null };
}

test('D05: the creator comes from history; edits by others and forged fields never change it, and nothing is stored on the expense', async () => {
  const flow = await createReceiptFlowWorker();
  try {
    const bob = await account(flow, 'bob-account', 'Bob', 'bob');
    let snapshot = await read(asOwner(flow));
    tripOf(snapshot, flow).expenses.push(expense('lunch', 'alice', ['alice', 'bob'], { createdBy: 'bob' }));
    await save(asOwner(flow), snapshot);
    snapshot = await read(bob);
    tripOf(snapshot, flow).expenses.push(expense('taxi', 'bob', ['bob']));
    await save(bob, snapshot);
    assert.equal((await creator(bob, flow, 'lunch')).body?.name, flow.owner.displayName);
    assert.equal((await creator(asOwner(flow), flow, 'taxi')).body?.name, 'Bob');
    assert.equal((await creator(bob, flow, 'lunch')).body?.accountId, 'bob-account', 'bound to the account that asked');
    // Bob edits Alice's lunch: still Alice's.
    snapshot = await read(bob);
    tripOf(snapshot, flow).expenses.find(value => value.id === 'lunch')!.items[0].amount = 1500;
    await save(bob, snapshot);
    assert.equal((await creator(bob, flow, 'lunch')).body?.name, flow.owner.displayName);
    // The forged field was never stored: no growth in the ledger JSON.
    const stored = (await read(asOwner(flow))).data.trips.find(value => value.id === flow.tripId)!.expenses;
    assert(stored.every(value => !('createdBy' in value)));
  } finally { await flow.dispose(); }
});

test('D05: an exactly restored expense keeps its original creator; a new expense is credited to whoever saves it', async () => {
  const flow = await createReceiptFlowWorker();
  try {
    const bob = await account(flow, 'bob-account', 'Bob', 'bob');
    let snapshot = await read(asOwner(flow));
    tripOf(snapshot, flow).expenses.push(expense('dinner', 'alice', ['alice', 'bob']));
    await save(asOwner(flow), snapshot);
    snapshot = await read(bob);
    tripOf(snapshot, flow).expenses = tripOf(snapshot, flow).expenses.filter(value => value.id !== 'dinner');
    await save(bob, snapshot);
    const deleted = await flow.database.prepare("SELECT before_data FROM activity_events WHERE trip_id = ? AND entity_id = 'dinner' AND action = 'delete'").bind(flow.tripId).first<{ before_data: string }>();
    snapshot = await read(bob);
    tripOf(snapshot, flow).expenses.push(JSON.parse(deleted!.before_data) as Expense);
    await save(bob, snapshot);
    assert.equal((await creator(bob, flow, 'dinner')).body?.name, flow.owner.displayName, 'Bob restored it; Alice added it');
    snapshot = await read(bob);
    tripOf(snapshot, flow).expenses.push(expense('coffee', 'bob', ['bob']));
    await save(bob, snapshot);
    assert.equal((await creator(asOwner(flow), flow, 'coffee')).body?.name, 'Bob');
  } finally { await flow.dispose(); }
});

test('D05: outsiders and guessed IDs learn nothing; an expense older than history has no creator', async () => {
  const flow = await createReceiptFlowWorker();
  try {
    const mallory = await account(flow, 'mallory-account', 'Mallory');
    let snapshot = await read(asOwner(flow));
    tripOf(snapshot, flow).expenses.push(expense('lunch', 'alice', ['alice', 'bob']));
    snapshot = await save(asOwner(flow), snapshot);
    assert.equal((await creator(mallory, flow, 'lunch')).status, 404);
    assert.equal((await creator(mallory, flow, 'lunch', 'no-such-trip')).status, 404);
    assert.equal((await creator(asOwner(flow), flow, 'lunch', 'no-such-trip')).status, 404);
    assert.deepEqual((await creator(asOwner(flow), flow, 'never-saved')).body?.name, null);
    // A pre-history expense: written straight into the stored trip, so it has no create event.
    const row = await flow.database.prepare('SELECT data FROM trips WHERE id = ?').bind(flow.tripId).first<{ data: string }>();
    const stored = JSON.parse(row!.data) as { expenses: Expense[] };
    stored.expenses.push(expense('ancient', 'alice', ['alice']));
    await flow.database.prepare('UPDATE trips SET data = ? WHERE id = ?').bind(JSON.stringify(stored), flow.tripId).run();
    assert(tripOf(await read(asOwner(flow)), flow).expenses.some(value => value.id === 'ancient'));
    assert.equal((await creator(asOwner(flow), flow, 'ancient')).body?.name, null);
    assert.equal((await creator(asOwner(flow), flow, 'lunch')).body?.name, flow.owner.displayName);
    for (const query of ['tripId=a', 'expenseId=b', 'tripId=a&tripId=b&expenseId=c', `tripId=${'x'.repeat(101)}&expenseId=c`, 'tripId=a&expenseId=b&extra=1']) {
      assert.equal((await asOwner(flow)(`/api/expense-creator?${query}`)).status, 400, query);
    }
  } finally { await flow.dispose(); }
});

test('D05: deleting an expense notifies whoever added it, even on "involved only" when they neither paid nor share it', async () => {
  const flow = await createReceiptFlowWorker();
  try {
    const bob = await account(flow, 'bob-account', 'Bob', 'bob');
    await flow.database.prepare("INSERT INTO notification_preferences(user_id,scope) VALUES (?,'involved')").bind(flow.owner.id).run();
    let snapshot = await read(asOwner(flow));
    tripOf(snapshot, flow).expenses.push(expense('bobs-hotel', 'bob', ['bob']));
    await save(asOwner(flow), snapshot);
    snapshot = await read(bob);
    tripOf(snapshot, flow).expenses.push(expense('bobs-own', 'bob', ['bob']));
    await save(bob, snapshot);
    const notifications = async () => Number((await flow.database.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?').bind(flow.owner.id).first<{ n: number }>())!.n);
    await new Promise(resolve => setTimeout(resolve, 300));
    const before = await notifications();
    // Control: Bob deletes his own expense, which Alice did not add, pay or share.
    snapshot = await read(bob);
    tripOf(snapshot, flow).expenses = tripOf(snapshot, flow).expenses.filter(value => value.id !== 'bobs-own');
    await save(bob, snapshot);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(await notifications(), before, 'involved-only still filters unrelated changes');
    // Bob deletes the expense Alice added.
    snapshot = await read(bob);
    tripOf(snapshot, flow).expenses = tripOf(snapshot, flow).expenses.filter(value => value.id !== 'bobs-hotel');
    await save(bob, snapshot);
    const started = Date.now();
    while (await notifications() !== before + 1) {
      if (Date.now() - started > 5000) assert.fail('the creator was not notified');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } finally { await flow.dispose(); }
});
