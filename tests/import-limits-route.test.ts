import assert from 'node:assert/strict';
import test from 'node:test';
import { createReceiptOperationWorker } from './helpers/receipt-operation-worker';
import type { Trip } from '../lib/model';

for (const scenario of [
  { holidays: 1, bills: 50, kind: 'holiday', accepted: true },
  { holidays: 49, bills: 100, kind: 'holiday', accepted: true },
  { holidays: 50, bills: 1, kind: 'holiday', accepted: false },
  { holidays: 50, bills: 99, kind: 'bill', accepted: true },
  { holidays: 1, bills: 100, kind: 'bill', accepted: false },
] as const) test(`N02: import ${scenario.kind} with ${scenario.holidays} holidays and ${scenario.bills} bills`, async () => {
  const fixture = await createReceiptOperationWorker();
  try {
    const entry = (id: string, kind: 'holiday' | 'bill'): Trip => ({
      id, kind, name: id, currency: 'GBP', members: [{ id: 'alice', name: 'Alice' }], expenses: [], drafts: [], payments: [],
    });
    const snapshot = await fixture.readLedger();
    snapshot.data.trips.push(
      ...Array.from({ length: scenario.holidays - 1 }, (_, i) => entry(`holiday-${i}`, 'holiday')),
      ...Array.from({ length: scenario.bills }, (_, i) => entry(`bill-${i}`, 'bill')),
    );
    await fixture.saveLedger(snapshot.data, snapshot.revision);
    const before = await fixture.readLedger();
    const history = await fixture.database.prepare('SELECT COUNT(*) AS count FROM activity_events').first<{ count: number }>();
    const trip = entry('imported-trip', scenario.kind);
    const response = await fixture.request('/api/import', { method: 'POST', body: JSON.stringify({ accountId: fixture.owner.id, trip, memberId: 'alice' }) });
    const body = await response.json() as { tripId?: string; error?: string };
    assert.equal(response.status, scenario.accepted ? 200 : 400, JSON.stringify(body));
    const after = await fixture.readLedger();
    if (scenario.accepted) {
      assert.equal(body.tripId, trip.id);
      assert.equal(after.data.trips.find(value => value.id === trip.id)?.kind ?? 'holiday', scenario.kind);
      assert.equal(after.data.trips.length, before.data.trips.length + 1);
    } else {
      assert.match(body.error ?? '', scenario.kind === 'bill' ? /bill/i : /holiday/i);
      assert.deepEqual(after, before, 'a limit refusal must not change the ledger or its revision');
      assert.deepEqual(await fixture.database.prepare('SELECT COUNT(*) AS count FROM activity_events').first(), history);
    }
  } finally { await fixture.dispose(); }
});
