import assert from 'node:assert/strict';
import test from 'node:test';
import { createReceiptOperationWorker } from './helpers/receipt-operation-worker';

/**
 * Cross-path check for the N03 class of defect: a settlement reminder writes a
 * notification into another traveller's inbox on behalf of the person who asked
 * for it. Once that person's credential is withdrawn, or the recipient has
 * become ineligible, a request prepared earlier must not still deliver.
 */
type Fixture = Awaited<ReturnType<typeof createReceiptOperationWorker>>;
const expense = { id: 'dinner', title: 'Dinner', date: '2026-11-07', time: '12:00', timezone: 'Europe/London', currency: 'GBP', payer: 'alice',
  tax: 0, tip: 0, discount: 0, items: [{ id: 'meal', name: 'Meal', amount: 1000, members: ['alice', 'bob'] }] };

async function setup(f: Fixture) {
  const bob = await f.createAccount({ id: 'bob-user', email: 'bob@example.test', name: 'Bob', password: true, session: true });
  const current = await f.readLedger();
  await f.saveLedger({ trips: [...current.data.trips.filter(trip => trip.id !== 'rem-trip'), { id: 'rem-trip', name: 'Reminder trip', currency: 'GBP',
    members: [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }], expenses: [expense], drafts: [], payments: [] }] } as never, current.revision);
  await f.database.prepare('INSERT INTO memberships(trip_id,user_id,member_id) VALUES(?,?,?)').bind('rem-trip', 'bob-user', 'bob').run();
  return bob;
}
const counts = async (f: Fixture) => {
  const n = async (sql: string) => Number((await f.database.prepare(sql).first<{ n: number }>())!.n);
  return { notifications: await n("SELECT COUNT(*) AS n FROM notifications WHERE user_id='bob-user'"), reminders: await n('SELECT COUNT(*) AS n FROM settlement_reminders') };
};
const remind = (f: Fixture) => f.request('/api/remind', { method: 'POST', body: JSON.stringify({ tripId: 'rem-trip', from: 'bob', to: 'alice', amount: 500 }) });
async function held(f: Fixture, disrupt: () => Promise<void>) {
  await f.control('/__test/hooks', { pauseNextCommit: true });
  const pending = remind(f);
  await f.waitFor(async () => (await f.control('/__test/hooks')).atCommit, 'the reminder commit');
  await disrupt();
  const before = await counts(f);
  await f.control('/__test/hooks', { proceed: true });
  const response = await pending;
  return { status: response.status, body: await response.text(), before, after: await counts(f) };
}

test('reminder control: a live creditor reminds the connected traveller once', async () => {
  const f = await createReceiptOperationWorker();
  try {
    await setup(f);
    const result = await held(f, async () => {});
    assert.equal(result.status, 200, result.body);
    assert.deepEqual(result.after, { notifications: 1, reminders: 1 });
  } finally { await f.dispose().catch(() => {}); }
});

for (const [name, disrupt] of Object.entries({
  'the requester signs out': async (f: Fixture) => { assert.equal((await f.request('/api/auth', { method: 'POST', body: JSON.stringify({ action: 'logout' }) })).status, 200); },
  'the requester account is deleted (session row retained)': async (f: Fixture) => { await f.database.prepare("UPDATE profiles SET deleted_at=? WHERE id=?").bind(new Date().toISOString(), f.owner.id).run(); },
  'the recipient turns reminders off': async (f: Fixture) => { await f.database.prepare("INSERT INTO notification_preferences(user_id,reminders) VALUES('bob-user',0) ON CONFLICT(user_id) DO UPDATE SET reminders=0").run(); },
  'the recipient leaves the trip': async (f: Fixture) => { await f.database.prepare("DELETE FROM memberships WHERE trip_id='rem-trip' AND user_id='bob-user'").run(); },
  'the recipient account is deleted': async (f: Fixture) => { await f.database.prepare("UPDATE profiles SET deleted_at=? WHERE id='bob-user'").bind(new Date().toISOString()).run(); },
} as Record<string, (f: Fixture) => Promise<void>>)) test(`reminder refused when ${name} while it is being delivered`, async () => {
  const f = await createReceiptOperationWorker();
  try {
    await setup(f);
    const result = await held(f, () => disrupt(f));
    assert.notEqual(result.status, 200, result.body);
    assert.deepEqual(result.after, result.before, 'no reminder row and no notification is written');
    assert.deepEqual(result.after, { notifications: 0, reminders: 0 });
  } finally { await f.dispose().catch(() => {}); }
});
