import assert from 'node:assert/strict';
import test from 'node:test';
import { createReceiptOperationWorker } from './helpers/receipt-operation-worker';

/**
 * F1: accepting an invitation adds a trip to the account's open list, so the
 * separate limits (50 holidays, 100 standalone bills) apply, atomically, in the
 * statement that admits the join. A refusal is a 409 that changes nothing.
 */
type Fixture = Awaited<ReturnType<typeof createReceiptOperationWorker>>;
type Account = Awaited<ReturnType<Fixture['createAccount']>>;
const own = (count: number, kind: 'holiday' | 'bill') => Array.from({ length: count }, (_, i) => ({ id: `${kind}-${i}`, kind, name: `${kind} ${i}`, currency: 'GBP',
  members: [{ id: 'me', name: 'Bob' }], expenses: [], drafts: [], payments: [] }));
async function accountWith(f: Fixture, holidays: number, bills: number) {
  const bob = await f.createAccount({ id: 'limit-bob', name: 'Bob', email: 'limit-bob@example.test', session: true });
  const read = await (await f.requestAs(bob, '/api/ledger')).json() as { revision: number };
  const saved = await f.requestAs(bob, '/api/ledger', { method: 'POST', body: JSON.stringify({ revision: read.revision, data: { trips: [...own(holidays, 'holiday'), ...own(bills, 'bill')] } }) });
  assert.equal(saved.status, 200, await saved.text());
  return bob;
}
async function invitation(f: Fixture, bob: Account, tripId: string) {
  const created = await f.request('/api/invite', { method: 'POST', body: JSON.stringify({ mode: 'create', tripId, memberId: 'bob' }) });
  const text = await created.text();
  assert.equal(created.status, 200, text);
  const token = new URL((JSON.parse(text) as { url: string }).url).searchParams.get('invite')!;
  const preview = await (await f.requestAs(bob, `/api/invite?token=${token}`)).json() as { historySnapshot: string };
  return JSON.stringify({ mode: 'accept', token, acceptHistory: true, historySnapshot: preview.historySnapshot });
}
const accept = (f: Fixture, bob: Account, body: string) => f.requestAs(bob, '/api/invite', { method: 'POST', body });
async function snapshot(f: Fixture) {
  const one = async (sql: string) => (await f.database.prepare(sql).first<Record<string, unknown>>())!;
  return { trip: await one(`SELECT data, revision FROM trips WHERE id='${f.tripId}'`), ledger: await one('SELECT revision FROM sync_state WHERE id=1'),
    memberships: await one("SELECT COUNT(*) AS n FROM memberships WHERE user_id='limit-bob'"), usedInvites: await one('SELECT COUNT(*) AS n FROM invites WHERE used_by IS NOT NULL'),
    history: await one(`SELECT COUNT(*) AS n FROM activity_events WHERE trip_id='${f.tripId}'`) };
}
const open = async (f: Fixture, bob: Account) => { const trips = (await (await f.requestAs(bob, '/api/ledger')).json() as { data: { trips: Array<{ kind?: string }> } }).data.trips;
  return { holidays: trips.filter(t => (t.kind ?? 'holiday') === 'holiday').length, bills: trips.filter(t => t.kind === 'bill').length }; };

for (const scenario of [
  { name: 'holiday invitation, 49 open holidays: the 50th joins', kind: undefined, holidays: 49, bills: 0, accepted: true },
  { name: 'holiday invitation, 50 open holidays: refused', kind: undefined, holidays: 50, bills: 0, accepted: false },
  { name: 'holiday invitation, 100 open bills and 49 holidays: the 50th holiday joins (bills do not use the holiday allowance)', kind: undefined, holidays: 49, bills: 100, accepted: true },
  { name: 'bill invitation, 99 open bills: the 100th joins', kind: 'bill' as const, holidays: 0, bills: 99, accepted: true },
  { name: 'bill invitation, 100 open bills: refused', kind: 'bill' as const, holidays: 0, bills: 100, accepted: false },
  { name: 'bill invitation, 50 open holidays and 99 bills: the 100th bill joins (holidays do not use the bill allowance)', kind: 'bill' as const, holidays: 50, bills: 99, accepted: true },
]) test(`F1: ${scenario.name}`, async () => {
  const f = await createReceiptOperationWorker(scenario.kind ? { kind: scenario.kind } : {});
  try {
    const bob = await accountWith(f, scenario.holidays, scenario.bills);
    const body = await invitation(f, bob, f.tripId);
    const before = await snapshot(f), listBefore = await open(f, bob);
    const response = await accept(f, bob, body);
    const text = await response.text();
    if (scenario.accepted) {
      assert.equal(response.status, 200, text);
      const after = await open(f, bob);
      assert.equal(after.holidays + after.bills, listBefore.holidays + listBefore.bills + 1);
    } else {
      assert.equal(response.status, 409, text);
      assert.match((JSON.parse(text) as { error: string }).error, scenario.kind === 'bill' ? /100 open bills/ : /50 open holidays/);
      assert.deepEqual(await snapshot(f), before, 'a refused join changes nothing: no membership, invitation, trip, revision or history');
      assert.deepEqual(await open(f, bob), listBefore);
    }
  } finally { await f.dispose().catch(() => {}); }
});

test('F1: a refused invitation can be accepted once the account has room', async () => {
  const f = await createReceiptOperationWorker();
  try {
    const bob = await accountWith(f, 50, 0);
    const body = await invitation(f, bob, f.tripId);
    assert.equal((await accept(f, bob, body)).status, 409);
    assert.equal((await f.requestAs(bob, '/api/trip', { method: 'POST', body: JSON.stringify({ action: 'archive', tripId: 'holiday-0' }) })).status, 200);
    const retry = await accept(f, bob, body);
    assert.equal(retry.status, 200, await retry.text());
    assert.deepEqual(await open(f, bob), { holidays: 50, bills: 0 });
  } finally { await f.dispose().catch(() => {}); }
});

test('F1: two invitations accepted at the same moment with one slot left admit exactly one', async () => {
  const f = await createReceiptOperationWorker();
  try {
    const bob = await accountWith(f, 49, 0);
    const snap = await f.readLedger();
    snap.data.trips.push({ id: 'second-trip', name: 'Second holiday', currency: 'GBP', members: [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }], expenses: [], drafts: [], payments: [] } as never);
    await f.saveLedger(snap.data, snap.revision);
    const first = await invitation(f, bob, f.tripId), second = await invitation(f, bob, 'second-trip');
    const results = await Promise.all([accept(f, bob, first), accept(f, bob, second)]);
    const statuses = results.map(r => r.status).sort();
    assert.deepEqual(statuses, [200, 409], JSON.stringify(await Promise.all(results.map(r => r.clone().text()))));
    assert.deepEqual(await open(f, bob), { holidays: 50, bills: 0 }, 'never 51');
    const joined = Number((await f.database.prepare("SELECT COUNT(*) AS n FROM memberships WHERE user_id='limit-bob' AND trip_id IN (?, 'second-trip')").bind(f.tripId).first<{ n: number }>())!.n);
    assert.equal(joined, 1, 'only one of the two invited trips was joined');
  } finally { await f.dispose().catch(() => {}); }
});
