import test from 'node:test';
import assert from 'node:assert/strict';
import { createReceiptOperationWorker } from './helpers/receipt-operation-worker';
/** Structural: the harness returns Miniflare's Response, which differs from the DOM type. */
type Reply = { status: number; text(): Promise<string>; json(): Promise<unknown> };

/**
 * N05 verification: the parts of the receipt-ready notice that do not depend on
 * `request.signal`. The signal-dependent branch (a browser that disconnects
 * while the request runner is still inside waitUntil) could not be observed
 * locally and stays an open release gate; see docs/remediation/AUDIT-VERIFICATION-N01-N05.md.
 */
type Fixture = Awaited<ReturnType<typeof createReceiptOperationWorker>>;
const inbox = async (f: Fixture, user: string) => (await f.database.prepare('SELECT title,body FROM notifications WHERE user_id=? ORDER BY created_at').bind(user).all<{ title: string; body: string }>()).results;
const settle = () => new Promise(resolve => setTimeout(resolve, 300));
async function cutOff(f: Fixture, start: (body: string) => Promise<Reply>) {
  const body = await f.processBody();
  await f.control('/__test/provider', { holdNext: 1, release: false });
  const abandoned = start(body);
  await f.waitFor(async () => (await f.control('/__test/provider')).held === 1, 'the reading to reach the provider');
  await f.database.prepare('UPDATE receipt_operations SET lease_until = 0').run();
  return { body, abandoned };
}

test('N05: background completion notifies the starter exactly once across duplicate ticks and a reconnect', async () => {
  const f = await createReceiptOperationWorker();
  try {
    const inline = await cutOff(f, body => f.process(body));
    await settle();
    assert.equal((await f.tick()).stored, 1);
    await f.waitFor(async () => (await inbox(f, f.owner.id)).length === 1, 'the ready notice');
    // Duplicate completion events: more ticks, a retry of the same request, a late original.
    const again = await f.tick();
    assert.equal(again.stored, 0);
    const callsBefore = (await f.control('/__test/provider')).calls;
    const retry = await f.process(inline.body);
    assert.ok([200, 202, 409].includes(retry.status), `a retry with the original (now stale) body is answered, not re-run: ${retry.status}`);
    assert.equal((await f.control('/__test/provider')).calls, callsBefore, 'a retry after completion makes no further provider call');
    await f.control('/__test/provider', { release: true });
    await inline.abandoned;
    await settle();
    const notices = await inbox(f, f.owner.id);
    assert.equal(notices.length, 1, 'exactly one completion notice');
    assert.equal(notices[0].title, 'Receipt ready to review');
    assert.doesNotMatch(notices[0].body, /£|\d+\.\d\d|Coffee|Pastry/, 'no amounts or line items');
  } finally { await f.control('/__test/provider', { release: true }).catch(() => {}); await f.dispose().catch(() => {}); }
});

test('N05: an account deleted while the reading is cut off is not notified and nothing is stored', async () => {
  const f = await createReceiptOperationWorker();
  try {
    const inline = await cutOff(f, body => f.process(body));
    await settle();
    await f.database.prepare('UPDATE profiles SET deleted_at=? WHERE id=?').bind(new Date().toISOString(), f.owner.id).run();
    const before = await f.tripRow(), history = await f.historyCount(), notices = (await inbox(f, f.owner.id)).length;
    const tick = await f.tick();
    assert.equal(tick.stored, 0);
    await f.control('/__test/provider', { release: true });
    await inline.abandoned; await settle();
    assert.deepEqual(await f.tripRow(), before);
    assert.equal(await f.historyCount(), history);
    assert.equal((await inbox(f, f.owner.id)).length, notices);
  } finally { await f.control('/__test/provider', { release: true }).catch(() => {}); await f.dispose().catch(() => {}); }
});

test('N05: a member who left the bill while their reading was cut off is not notified and nothing is stored', async () => {
  const f = await createReceiptOperationWorker();
  try {
    const bob = await f.createAccount({ id: 'bob-reader', email: 'bob-reader@example.test', name: 'Bob', session: true });
    await f.database.prepare('INSERT INTO memberships(trip_id,user_id,member_id) VALUES(?,?,?)').bind(f.tripId, 'bob-reader', 'bob').run();
    const inline = await cutOff(f, body => f.requestAs(bob, '/api/receipt/process', { method: 'POST', body }));
    await settle();
    const left = await f.requestAs(bob, '/api/trip', { method: 'POST', body: JSON.stringify({ action: 'leave', tripId: f.tripId }) });
    assert.equal(left.status, 200, await left.text());
    const before = await f.tripRow(), history = await f.historyCount(), notices = (await inbox(f, 'bob-reader')).length;
    assert.equal((await f.tick()).stored, 0);
    await f.control('/__test/provider', { release: true });
    await inline.abandoned; await settle();
    assert.deepEqual(await f.tripRow(), before);
    assert.equal(await f.historyCount(), history);
    assert.equal((await inbox(f, 'bob-reader')).length, notices, 'no receipt label reaches someone who left');
  } finally { await f.control('/__test/provider', { release: true }).catch(() => {}); await f.dispose().catch(() => {}); }
});
