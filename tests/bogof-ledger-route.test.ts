import assert from 'node:assert/strict';
import test from 'node:test';
import { createReceiptOperationWorker } from './helpers/receipt-operation-worker';
import { bogofExpense } from './helpers/bogof';
import { expenseShares, settlements, parseStoredTrip } from '../lib/model';

/** The required BOGOF receipt through the production ledger route (stored shares and settlements), and payment edit/delete under logout. */
type Fixture = Awaited<ReturnType<typeof createReceiptOperationWorker>>;
const stored = async (f: Fixture) => parseStoredTrip(JSON.parse((await f.tripRow()).data));

for (const scenario of [
  { name: 'both Pringles to Alice, milk shared, Bob pays', payer: 'bob', p1: ['alice'], p2: ['alice'], milk: ['alice', 'bob'], shares: [375, 75], transfer: { from: 'alice', to: 'bob', amount: 375 } },
  { name: 'one Pringles to Alice, other Pringles and milk to Bob, Alice pays', payer: 'alice', p1: ['alice'], p2: ['bob'], milk: ['bob'], shares: [150, 300], transfer: { from: 'bob', to: 'alice', amount: 300 } },
]) test(`BOGOF route: BOGOF via /api/ledger: ${scenario.name}`, async () => {
  const f = await createReceiptOperationWorker();
  try {
    const snapshot = await f.readLedger();
    const trip = snapshot.data.trips.find(t => t.id === f.tripId)!;
    const e = bogofExpense('bogof'); e.payer = scenario.payer;
    e.items[0].members = scenario.p1; e.items[1].members = scenario.p2; e.items[2].members = scenario.milk;
    trip.expenses = [e];
    const saved = await f.request('/api/ledger', { method: 'POST', body: JSON.stringify(snapshot) });
    assert.equal(saved.status, 200, await saved.text());
    const persisted = await stored(f);
    const expense = persisted.expenses[0];
    assert.deepEqual(expenseShares(expense, persisted.members, 'GBP'), scenario.shares, 'stored shares');
    const total = scenario.shares[0] + scenario.shares[1];
    assert.equal(total, 450, 'total £4.50');
    assert.deepEqual(settlements(persisted), [scenario.transfer], 'settlement from the stored trip');
    // The same figures after a fresh read through the route (what the client sees).
    const reread = (await f.readLedger()).data.trips.find(t => t.id === f.tripId)!;
    assert.deepEqual(settlements(reread), [scenario.transfer]);
    assert.deepEqual(expense.adjustments?.map(a => [a.amount, a.scope?.type]), [[300, 'items']], 'discount scope retained');
  } finally { await f.dispose().catch(() => {}); }
});

for (const op of ['edit', 'delete'] as const) for (const mode of ['whole-ledger', 'per-trip'] as const) {
  const mutate = (trip: { payments: Array<{ id: string; amount: number }> }) => {
    if (op === 'edit') trip.payments[0].amount = 200; else trip.payments.splice(0, 1);
  };
  async function seeded() {
    const f = await createReceiptOperationWorker();
    const snapshot = await f.readLedger();
    const trip = snapshot.data.trips.find(t => t.id === f.tripId)!;
    trip.expenses = [bogofExpense('bogof')];
    trip.payments = [{ id: 'p0', from: 'alice', to: 'bob', amount: 100, date: '2026-11-07' }];
    assert.equal((await f.request('/api/ledger', { method: 'POST', body: JSON.stringify(snapshot) })).status, 200);
    return f;
  }
  async function body(f: Fixture) {
    const snapshot = await f.readLedger();
    const trip = snapshot.data.trips.find(t => t.id === f.tripId)!;
    mutate(trip);
    const revision = (await f.tripRow()).revision;
    return mode === 'whole-ledger' ? snapshot : { data: { trips: [trip] }, tripRevisions: { [f.tripId]: revision } };
  }
  test(`BOGOF route: payment ${op} (${mode}): legitimate edit/delete still works and settles correctly`, async () => {
    const f = await seeded();
    try {
      const r = await f.request('/api/ledger', { method: 'POST', body: JSON.stringify(await body(f)) });
      assert.equal(r.status, 200, await r.text());
      const trip = await stored(f);
      assert.deepEqual(settlements(trip), [{ from: 'alice', to: 'bob', amount: op === 'edit' ? 175 : 375 }]);
    } finally { await f.dispose().catch(() => {}); }
  });
  test(`BOGOF route: payment ${op} (${mode}): refused after logout while the commit is held; nothing changes`, async () => {
    const f = await seeded();
    try {
      const request = await body(f);
      await f.control('/__test/hooks', { pauseNextCommit: true });
      const pending = f.request('/api/ledger', { method: 'POST', body: JSON.stringify(request) });
      await f.waitFor(async () => (await f.control('/__test/hooks')).atCommit, 'held commit');
      assert.equal((await f.request('/api/auth', { method: 'POST', body: JSON.stringify({ action: 'logout' }) })).status, 200);
      const before = await f.tripRow(), history = await f.historyCount();
      const notes = Number((await f.database.prepare('SELECT COUNT(*) AS n FROM notifications').first<{ n: number }>())!.n);
      await f.control('/__test/hooks', { proceed: true });
      const r = await pending;
      assert.equal(r.status, 401, await r.text());
      assert.deepEqual(await f.tripRow(), before);
      assert.equal(await f.historyCount(), history);
      assert.equal(Number((await f.database.prepare('SELECT COUNT(*) AS n FROM notifications').first<{ n: number }>())!.n), notes);
      assert.deepEqual((await stored(f)).payments.map(p => [p.id, p.amount]), [['p0', 100]]);
    } finally { await f.dispose().catch(() => {}); }
  });
}
