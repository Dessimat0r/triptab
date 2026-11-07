import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { createReceiptOperationWorker } from './helpers/receipt-operation-worker';

/**
 * N03 verification (second independent pass). Production handlers, an isolated
 * Miniflare D1 database, and the harness's paused final commit. Each case
 * prepares a payment while the credential is valid, withdraws the credential
 * while the commit is held, releases the commit and asserts nothing was written.
 */
type Fixture = Awaited<ReturnType<typeof createReceiptOperationWorker>>;
type Identity = { sessionToken?: string; provider?: { id: string; email?: string } };
type Mode = 'whole-ledger' | 'per-trip';
const MODES: Mode[] = ['whole-ledger', 'per-trip'];
const expense = { id: 'dinner', title: 'Dinner', date: '2026-11-07', time: '12:00', timezone: 'Europe/London', currency: 'GBP', payer: 'bob',
  tax: 0, tip: 0, discount: 0, items: [{ id: 'meal', name: 'Meal', amount: 1000, members: ['alice', 'bob'] }] };
const payment = { id: 'prepared-payment', from: 'alice', to: 'bob', amount: 500, date: '2026-11-07' };

async function seedTrip(f: Fixture, who: Identity, id: string) {
  const read = await f.requestAs(who, '/api/ledger');
  const text = await read.text();
  assert.equal(read.status, 200, text);
  const current = JSON.parse(text) as { data: { trips: unknown[] }; revision: number };
  const write = await f.requestAs(who, '/api/ledger', { method: 'POST', body: JSON.stringify({ revision: current.revision, data: { trips: [...current.data.trips,
    { id, name: `Trip ${id}`, currency: 'GBP', members: [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }], expenses: [expense], drafts: [], payments: [] }] } }) });
  assert.equal(write.status, 200, await write.text());
}

async function state(f: Fixture, tripId: string) {
  const one = async (sql: string, ...bind: unknown[]) => await f.database.prepare(sql).bind(...bind).first<Record<string, unknown>>();
  return {
    trip: await one('SELECT data, revision FROM trips WHERE id=?', tripId),
    ledgerRevision: (await one('SELECT revision FROM sync_state WHERE id=1'))!.revision,
    history: (await one('SELECT COUNT(*) AS n FROM activity_events WHERE trip_id=?', tripId))!.n,
    notifications: (await one('SELECT COUNT(*) AS n FROM notifications'))!.n,
  };
}

/** The payment is prepared against the live credential; the caller then holds the commit. */
async function prepared(f: Fixture, who: Identity, tripId: string, mode: Mode) {
  const read = await f.requestAs(who, '/api/ledger');
  assert.equal(read.status, 200);
  const snapshot = await read.json() as { data: { trips: Array<{ id: string; payments: unknown[] }> }; revision: number };
  snapshot.data.trips.find(trip => trip.id === tripId)!.payments.push(payment);
  const revision = (await f.database.prepare('SELECT revision FROM trips WHERE id=?').bind(tripId).first<{ revision: number }>())!.revision;
  const body = mode === 'whole-ledger' ? snapshot : { data: { trips: [snapshot.data.trips.find(trip => trip.id === tripId)] }, tripRevisions: { [tripId]: revision } };
  await f.control('/__test/hooks', { pauseNextCommit: true });
  const pending = f.requestAs(who, '/api/ledger', { method: 'POST', body: JSON.stringify(body) });
  await f.waitFor(async () => (await f.control('/__test/hooks')).atCommit, 'the prepared financial commit');
  // Wrapped: returning the promise itself from an async function would await the held commit.
  return { pending };
}

async function released(f: Fixture, held: { pending: Promise<Response> }) {
  const pending = held.pending;
  const batches = (await f.control('/__test/hooks')).commitBatches;
  await f.control('/__test/hooks', { proceed: true });
  const response = await pending;
  const body = await response.text();
  // A refused write is not retried: no further commit batch follows the held one.
  assert.equal((await f.control('/__test/hooks')).commitBatches, batches, 'no automatic retry of a refused write');
  return { status: response.status, body };
}

const withdrawals: Record<string, (f: Fixture, who: Identity) => Promise<void>> = {
  'explicit revocation from another browser': async f => {
    const other = randomBytes(32).toString('base64url');
    await f.database.prepare('INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at,session_id) VALUES(?,?,?,?,?)')
      .bind(createHash('sha256').update(other).digest('hex'), f.owner.id, new Date(Date.now() + 600_000).toISOString(), new Date().toISOString(), 'other-session-0001').run();
    const revoked = await f.requestAs({ sessionToken: other }, '/api/account', { method: 'POST', body: JSON.stringify({ sessionId: f.sessionId }) });
    assert.equal(revoked.status, 200, await revoked.text());
  },
  // The session row is deliberately left in place: the profile predicate must stand alone.
  'account deletion with its session row still present': async f => {
    await f.database.prepare("UPDATE profiles SET deleted_at=?,display_name='Deleted traveller' WHERE id=?").bind(new Date().toISOString(), f.owner.id).run();
  },
};

for (const mode of MODES) for (const [name, withdraw] of Object.entries(withdrawals)) test(`N03 gap: ${mode} commit refused after ${name}`, async () => {
  const f = await createReceiptOperationWorker();
  try {
    const alice = { sessionToken: f.sessionToken };
    await seedTrip(f, alice, 'n03-trip');
    const pending = await prepared(f, alice, 'n03-trip', mode);
    await withdraw(f, alice);
    assert.equal((await f.requestAs(alice, '/api/ledger')).status, 401, 'the same credential is refused by the normal route');
    const before = await state(f, 'n03-trip');
    const result = await released(f, pending);
    assert.equal(result.status, 401, result.body);
    assert.deepEqual(await state(f, 'n03-trip'), before, 'no data, revision, history or notification change');
  } finally { await f.dispose().catch(() => {}); }
});

for (const mode of MODES) for (const change of ['unlink', 'remap'] as const) test(`N03 gap: ${mode} provider-authenticated commit refused after ${change}`, async () => {
  const f = await createReceiptOperationWorker();
  try {
    const account = await f.createAccount({ id: 'linked-user', email: 'linked@example.test', name: 'Linked', password: true, link: { providerId: 'linked-provider' }, session: true });
    const provider: Identity = { provider: { id: 'linked-provider', email: 'linked@example.test' } };
    await seedTrip(f, provider, 'linked-trip');
    const pending = await prepared(f, provider, 'linked-trip', mode);
    if (change === 'unlink') {
      const unlinked = await f.requestAs(account, '/api/auth', { method: 'POST', body: JSON.stringify({ action: 'unlink_chatgpt' }) });
      assert.equal(unlinked.status, 200, await unlinked.text());
      // Designed legacy rule: an unlinked provider identity no longer reaches this account. It resolves to
      // its own empty legacy profile, so the trip is invisible to it and the held write must not land.
      const after = await (await f.requestAs(provider, '/api/ledger')).json() as { data: { trips: Array<{ id: string }> } };
      assert.equal(after.data.trips.some(trip => trip.id === 'linked-trip'), false, 'the unlinked provider identity no longer sees the account');
    } else {
      await f.createAccount({ id: 'mapped-elsewhere', email: 'elsewhere@example.test', name: 'Elsewhere' });
      await f.database.prepare('UPDATE auth_links SET user_id=? WHERE oai_user_id=?').bind('mapped-elsewhere', 'linked-provider').run();
    }
    const before = await state(f, 'linked-trip');
    const result = await released(f, pending);
    assert.equal(result.status, 401, result.body);
    assert.deepEqual(await state(f, 'linked-trip'), before);
  } finally { await f.dispose().catch(() => {}); }
});

for (const mode of MODES) test(`N03 gap: ${mode} commit by a member who has left the trip is refused`, async () => {
  const f = await createReceiptOperationWorker();
  try {
    const bob = await f.createAccount({ id: 'bob-user', email: 'bob@example.test', name: 'Bob', password: true, session: true });
    await seedTrip(f, { sessionToken: f.sessionToken }, 'shared-trip');
    await f.database.prepare('INSERT INTO memberships(trip_id,user_id,member_id) VALUES(?,?,?)').bind('shared-trip', 'bob-user', 'bob').run();
    const pending = await prepared(f, bob, 'shared-trip', mode);
    const left = await f.requestAs(bob, '/api/trip', { method: 'POST', body: JSON.stringify({ action: 'leave', tripId: 'shared-trip' }) });
    assert.equal(left.status, 200, await left.text());
    const before = await state(f, 'shared-trip');
    const result = await released(f, pending);
    assert.notEqual(result.status, 200, result.body);
    assert.deepEqual(await state(f, 'shared-trip'), before);
    assert.equal(JSON.parse((before.trip as { data: string }).data).payments.length, 0);
  } finally { await f.dispose().catch(() => {}); }
});

for (const mode of MODES) test(`N03 control: ${mode} commit with valid session and valid provider credentials succeeds exactly once`, async () => {
  const f = await createReceiptOperationWorker();
  try {
    await f.createAccount({ id: 'linked-user', email: 'linked@example.test', name: 'Linked', password: true, link: { providerId: 'linked-provider' }, session: true });
    for (const [who, tripId] of [[{ sessionToken: f.sessionToken }, 'valid-session-trip'], [{ provider: { id: 'linked-provider', email: 'linked@example.test' } }, 'valid-provider-trip']] as const) {
      await seedTrip(f, who, tripId);
      const before = await state(f, tripId);
      const result = await released(f, await prepared(f, who, tripId, mode));
      assert.equal(result.status, 200, result.body);
      const after = await state(f, tripId);
      assert.deepEqual(JSON.parse((after.trip as { data: string }).data).payments.map((value: { id: string }) => value.id), [payment.id]);
      assert.equal(Number(after.history), Number(before.history) + 1, 'one new history event');
      assert.equal(Number((after.trip as { revision: number }).revision), Number((before.trip as { revision: number }).revision) + 1);
    }
  } finally { await f.dispose().catch(() => {}); }
});

for (const mode of MODES) test(`N03 control: a genuine same-trip revision conflict is still a conflict (not an authorisation error) in ${mode} mode`, async () => {
  const f = await createReceiptOperationWorker();
  try {
    const alice = { sessionToken: f.sessionToken };
    await seedTrip(f, alice, 'conflict-trip');
    const pending = await prepared(f, alice, 'conflict-trip', mode);
    // A different writer changes the same trip while the first commit is held.
    const read = await (await f.requestAs(alice, '/api/ledger')).json() as { data: { trips: Array<{ id: string; payments: unknown[] }> }; revision: number };
    read.data.trips.find(trip => trip.id === 'conflict-trip')!.payments.push({ id: 'rival', from: 'alice', to: 'bob', amount: 100, date: '2026-11-07' });
    const rival = await f.requestAs(alice, '/api/ledger', { method: 'POST', body: JSON.stringify(read) });
    assert.equal(rival.status, 200, await rival.text());
    const before = await state(f, 'conflict-trip');
    const result = await released(f, pending);
    assert.equal(result.status, 409, result.body);
    assert.deepEqual(await state(f, 'conflict-trip'), before, 'only the rival write persists');
    assert.deepEqual(JSON.parse((before.trip as { data: string }).data).payments.map((value: { id: string }) => value.id), ['rival']);
  } finally { await f.dispose().catch(() => {}); }
});
