import assert from 'node:assert/strict';
import test from 'node:test';
import { createReceiptOperationWorker } from './helpers/receipt-operation-worker';
import type { Trip } from '../lib/model';

/**
 * N02 verification (second independent pass), beyond the five size combinations
 * in import-limits-route.test.ts: archived records, restoring at a limit,
 * concurrent imports near a limit, and independence of the two limits. The
 * harness account starts with one open holiday.
 */
type Fixture = Awaited<ReturnType<typeof createReceiptOperationWorker>>;
const entry = (id: string, kind: 'holiday' | 'bill'): Trip => ({ id, kind, name: id, currency: 'GBP', members: [{ id: 'alice', name: 'Alice' }], expenses: [], drafts: [], payments: [] });
async function seed(f: Fixture, holidays: number, bills: number) {
  const snapshot = await f.readLedger();
  snapshot.data.trips.push(...Array.from({ length: holidays - 1 }, (_, i) => entry(`h${i}`, 'holiday')), ...Array.from({ length: bills }, (_, i) => entry(`b${i}`, 'bill')));
  await f.saveLedger(snapshot.data, snapshot.revision);
}
const importTrip = (f: Fixture, id: string, kind: 'holiday' | 'bill') =>
  f.request('/api/import', { method: 'POST', body: JSON.stringify({ accountId: f.owner.id, trip: entry(id, kind), memberId: 'alice' }) });
const open = async (f: Fixture) => { const trips = (await f.readLedger()).data.trips; return { holidays: trips.filter(t => (t.kind ?? 'holiday') === 'holiday').length, bills: trips.filter(t => t.kind === 'bill').length }; };
const lifecycle = (f: Fixture, action: 'archive' | 'restore', tripId: string) => f.request('/api/trip', { method: 'POST', body: JSON.stringify({ action, tripId }) });

test('N02: archived holidays do not consume the open-holiday allowance, and the limit still applies afterwards', async () => {
  const f = await createReceiptOperationWorker();
  try {
    await seed(f, 50, 0);
    assert.equal((await importTrip(f, 'refused-at-50', 'holiday')).status, 400);
    for (const id of ['h0', 'h1']) assert.equal((await lifecycle(f, 'archive', id)).status, 200);
    assert.deepEqual(await open(f), { holidays: 48, bills: 0 });
    assert.equal((await importTrip(f, 'new-1', 'holiday')).status, 200);
    assert.equal((await importTrip(f, 'new-2', 'holiday')).status, 200);
    const refused = await importTrip(f, 'new-3', 'holiday');
    assert.equal(refused.status, 400, await refused.text());
    assert.deepEqual(await open(f), { holidays: 50, bills: 0 });
    assert.equal(await f.database.prepare("SELECT 1 FROM trips WHERE id='new-3'").first(), null, 'a refused import writes nothing');
  } finally { await f.dispose().catch(() => {}); }
});

test('N02: restoring an archived holiday at the holiday limit is refused, while bills remain unaffected', async () => {
  const f = await createReceiptOperationWorker();
  try {
    await seed(f, 50, 100);
    assert.equal((await lifecycle(f, 'archive', 'h0')).status, 200);
    assert.equal((await importTrip(f, 'fills-the-slot', 'holiday')).status, 200);
    const restore = await lifecycle(f, 'restore', 'h0');
    const restored = await restore.text();
    assert.equal(restore.status, 409, restored);
    assert.match((JSON.parse(restored) as { error: string }).error, /holiday/i);
    assert.deepEqual(await open(f), { holidays: 50, bills: 100 });
    // A bill slot opens independently of the full holiday list.
    assert.equal((await lifecycle(f, 'archive', 'b0')).status, 200);
    assert.equal((await importTrip(f, 'new-bill', 'bill')).status, 200);
    assert.deepEqual(await open(f), { holidays: 50, bills: 100 });
  } finally { await f.dispose().catch(() => {}); }
});

test('N02: concurrent holiday imports near the limit admit exactly the free slots and never exceed 50', async () => {
  const f = await createReceiptOperationWorker();
  try {
    await seed(f, 48, 0);
    const results = await Promise.all(['c1', 'c2', 'c3'].map(id => importTrip(f, id, 'holiday')));
    const statuses = results.map(r => r.status).sort();
    assert.deepEqual(statuses, [200, 200, 400], JSON.stringify(await Promise.all(results.map(r => r.clone().text()))));
    assert.deepEqual(await open(f), { holidays: 50, bills: 0 });
  } finally { await f.dispose().catch(() => {}); }
});

test('N02: concurrent imports of different kinds draw on independent limits', async () => {
  const f = await createReceiptOperationWorker();
  try {
    await seed(f, 49, 99);
    const results = await Promise.all([importTrip(f, 'x-holiday', 'holiday'), importTrip(f, 'x-bill', 'bill')]);
    assert.deepEqual(results.map(r => r.status), [200, 200]);
    assert.deepEqual(await open(f), { holidays: 50, bills: 100 });
    // Both lists are now full: each kind is refused independently, with its own message.
    const holiday = await importTrip(f, 'y-holiday', 'holiday'), bill = await importTrip(f, 'y-bill', 'bill');
    assert.deepEqual([holiday.status, bill.status], [400, 400]);
    assert.match(((await holiday.json()) as { error: string }).error, /holiday/i);
    assert.match(((await bill.json()) as { error: string }).error, /bill/i);
  } finally { await f.dispose().catch(() => {}); }
});

test('N02: persistence enforces both limits even when the route pre-check is bypassed (normal ledger save)', async () => {
  const f = await createReceiptOperationWorker();
  try {
    await seed(f, 50, 100);
    const before = await f.readLedger();
    for (const kind of ['holiday', 'bill'] as const) {
      const snapshot = await f.readLedger();
      snapshot.data.trips.push(entry(`over-${kind}`, kind));
      const response = await f.request('/api/ledger', { method: 'POST', body: JSON.stringify(snapshot) });
      assert.equal(response.status, 400, await response.text());
    }
    assert.deepEqual(await f.readLedger(), before, 'neither over-limit save changed anything');
  } finally { await f.dispose().catch(() => {}); }
});
