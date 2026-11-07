import assert from 'node:assert/strict';
import test from 'node:test';
import { createReceiptOperationWorker } from './helpers/receipt-operation-worker';
import { storage } from './helpers/sqlite-d1';
import { resolveIdentity } from '../lib/auth';
import { providerAuthenticatesAsSql } from '../lib/receipt-operations';

// R15 and R16 (independent review of PR #78). A background execution grant
// must stop exactly when the person's sign-in stops: the same provider-link
// and legacy-disconnection rules as normal authentication (R15), and
// deadlines compared with the database's time inside the commit (R16).
// Production auth, ledger, upload and processing routes and the background
// runner on Miniflare D1/R2; the provider is mocked and never paid.
type Fixture = Awaited<ReturnType<typeof createReceiptOperationWorker>>;
type Reading = Awaited<ReturnType<Fixture['seedReading']>>;
const calls = async (fixture: Fixture) => (await fixture.control('/__test/provider')).calls;
const row = async (fixture: Fixture, tripId: string) =>
  (await fixture.database.prepare('SELECT * FROM receipt_operations WHERE trip_id = ?').bind(tripId).first<{ status: string; error_code: string | null; grant_kind: string; grant_ref: string; attempt_id: string }>())!;

/** A reading cut off at the provider after a disconnect: no outcome recorded, lease run out. */
async function cutOff(fixture: Fixture, reading: Reading, tripId: string) {
  await fixture.control('/__test/provider', { holdNext: 1, release: false });
  const before = (await fixture.control('/__test/provider')).held;
  const abandoned = reading.process();
  await fixture.waitFor(async () => (await fixture.control('/__test/provider')).held === before + 1, 'the reading to reach the provider');
  await fixture.database.prepare('UPDATE receipt_operations SET lease_until = 0 WHERE trip_id = ?').bind(tripId).run();
  // Wrapped: an async function returning the bare promise would wait for it.
  return { abandoned };
}
/** Resume in the background and require: no provider call, no write, refused, and never retried. */
async function expectRefused(fixture: Fixture, reading: Reading, tripId: string, abandoned: Promise<{ status: number }>, code = 'authorization-ended') {
  const spent = await calls(fixture), trip = await reading.trip(), history = await reading.history();
  const result = await fixture.tick();
  assert.deepEqual([result.resumed, result.stored, result.failed], [1, 0, 1]);
  assert.equal(await calls(fixture), spent, 'no further provider call');
  assert.deepEqual(await reading.trip(), trip, 'no proposal or revision change');
  assert.equal(await reading.history(), history, 'no history');
  assert.deepEqual([(await row(fixture, tripId)).status, (await row(fixture, tripId)).error_code], ['failed', code]);
  assert.equal((await fixture.tick()).resumed, 0, 'no background retry');
  await fixture.control('/__test/provider', { release: true });
  assert.notEqual((await abandoned).status, 200, 'the cut-off attempt cannot commit either');
  assert.deepEqual(await reading.trip(), trip);
}
async function expectStored(fixture: Fixture, reading: Reading, tripId: string, abandoned: Promise<{ status: number }>) {
  const history = await reading.history();
  const result = await fixture.tick();
  assert.deepEqual([result.resumed, result.stored], [1, 1]);
  assert.equal((await row(fixture, tripId)).status, 'stored');
  assert.equal(await reading.history(), history + 1);
  await fixture.control('/__test/provider', { release: true });
  assert.equal((await abandoned).status, 409);
}
const unlink = (fixture: Fixture, sessionToken: string) => fixture.requestAs({ sessionToken }, '/api/auth', { method: 'POST', body: JSON.stringify({ action: 'unlink_chatgpt' }) });

test('R15: unlinking ChatGPT on a legacy account (profile ID = provider ID, password, self-link) revokes its background grant before any spend', async () => {
  const fixture = await createReceiptOperationWorker();
  try {
    const { sessionToken } = await fixture.createAccount({ id: 'legacy-a', email: 'legacy-a@example.test', name: 'Legacy A', password: true, link: { providerId: 'legacy-a' }, session: true });
    const viaChatGPT = { provider: { id: 'legacy-a', email: 'legacy-a@example.test' } };
    const reading = await fixture.seedReading(viaChatGPT, 'legacy-a-trip');
    const { abandoned } = await cutOff(fixture, reading, 'legacy-a-trip');
    assert.deepEqual([(await row(fixture, 'legacy-a-trip')).grant_kind, (await row(fixture, 'legacy-a-trip')).grant_ref], ['chatgpt', 'legacy-a']);
    const unlinked = await unlink(fixture, sessionToken!);
    assert.equal(unlinked.status, 200, await unlinked.clone().text());
    assert.equal((await fixture.requestAs(viaChatGPT, '/api/ledger')).status, 401, 'normal authentication treats the old identity as disconnected');
    await expectRefused(fixture, reading, 'legacy-a-trip', abandoned);
  } finally { await fixture.dispose(); }
});

test('R15: unlinking while the browser\'s own reading is still at the provider means its result is not saved', async () => {
  const fixture = await createReceiptOperationWorker();
  try {
    const { sessionToken } = await fixture.createAccount({ id: 'legacy-e', email: 'legacy-e@example.test', name: 'Legacy E', password: true, link: { providerId: 'legacy-e' }, session: true });
    const viaChatGPT = { provider: { id: 'legacy-e', email: 'legacy-e@example.test' } };
    const reading = await fixture.seedReading(viaChatGPT, 'legacy-e-trip');
    await fixture.control('/__test/provider', { holdNext: 1, release: false });
    const pending = reading.process();
    await fixture.waitFor(async () => (await fixture.control('/__test/provider')).held === 1, 'the reading to reach the provider');
    const trip = await reading.trip(), history = await reading.history();
    assert.equal((await unlink(fixture, sessionToken!)).status, 200);
    await fixture.control('/__test/provider', { release: true });
    assert.notEqual((await pending).status, 200);
    assert.deepEqual(await reading.trip(), trip);
    assert.equal(await reading.history(), history);
    assert.equal((await row(fixture, 'legacy-e-trip')).status, 'failed');
  } finally { await fixture.dispose(); }
});

test('R15 control: separate profile and provider IDs, unlinked: refused the same way', async () => {
  const fixture = await createReceiptOperationWorker();
  try {
    const { sessionToken } = await fixture.createAccount({ id: 'acct-b', email: 'b@example.test', name: 'B', password: true, link: { providerId: 'prov-b' }, session: true });
    const viaChatGPT = { provider: { id: 'prov-b', email: 'b@example.test' } };
    const reading = await fixture.seedReading(viaChatGPT, 'b-trip');
    const { abandoned } = await cutOff(fixture, reading, 'b-trip');
    assert.equal((await unlink(fixture, sessionToken!)).status, 200);
    await expectRefused(fixture, reading, 'b-trip', abandoned);
  } finally { await fixture.dispose(); }
});

test('R15 positive controls: a legitimate unlinked legacy account and a self-linked legacy account still finish in the background', async () => {
  const fixture = await createReceiptOperationWorker();
  try {
    // Unlinked legacy fallback: profile ID = provider ID, no password, no link.
    await fixture.createAccount({ id: 'legacy-c', email: 'legacy-c@example.test', name: 'Legacy C' });
    const legacy = await fixture.seedReading({ provider: { id: 'legacy-c', email: 'legacy-c@example.test' } }, 'legacy-c-trip');
    let { abandoned } = await cutOff(fixture, legacy, 'legacy-c-trip');
    assert.equal((await row(fixture, 'legacy-c-trip')).grant_kind, 'chatgpt');
    await expectStored(fixture, legacy, 'legacy-c-trip', abandoned);
    // Self-linked legacy account with a password, still linked.
    await fixture.createAccount({ id: 'legacy-f', email: 'legacy-f@example.test', name: 'Legacy F', password: true, link: { providerId: 'legacy-f' } });
    const linked = await fixture.seedReading({ provider: { id: 'legacy-f', email: 'legacy-f@example.test' } }, 'legacy-f-trip');
    ({ abandoned } = await cutOff(fixture, linked, 'legacy-f-trip'));
    await expectStored(fixture, linked, 'legacy-f-trip', abandoned);
  } finally { await fixture.dispose(); }
});

test('R15: a live TripTab session takes precedence over provider headers when the grant is made', async () => {
  const fixture = await createReceiptOperationWorker();
  try {
    const { sessionToken } = await fixture.createAccount({ id: 'acct-g', email: 'g@example.test', name: 'G', password: true, link: { providerId: 'prov-g' }, session: true });
    const both = { sessionToken, provider: { id: 'prov-g', email: 'g@example.test' } };
    const reading = await fixture.seedReading(both, 'g-trip');
    const { abandoned } = await cutOff(fixture, reading, 'g-trip');
    assert.deepEqual([(await row(fixture, 'g-trip')).grant_kind, (await row(fixture, 'g-trip')).grant_ref], ['session', 'acct-g-session']);
    // Unlinking ChatGPT does not end the session the grant names.
    assert.equal((await unlink(fixture, sessionToken!)).status, 200);
    await expectStored(fixture, reading, 'g-trip', abandoned);
  } finally { await fixture.dispose(); }
});

test('R15: remapping the provider identity to another account, or deleting the account, revokes the grant', async () => {
  for (const change of ['remap', 'delete'] as const) {
    const fixture = await createReceiptOperationWorker();
    try {
      await fixture.createAccount({ id: 'legacy-d', email: 'legacy-d@example.test', name: 'Legacy D' });
      const reading = await fixture.seedReading({ provider: { id: 'legacy-d', email: 'legacy-d@example.test' } }, 'legacy-d-trip');
      const { abandoned } = await cutOff(fixture, reading, 'legacy-d-trip');
      if (change === 'remap') {
        await fixture.createAccount({ id: 'acct-x', email: 'x@example.test', name: 'X' });
        await fixture.database.prepare("INSERT INTO auth_links(oai_user_id,user_id,created_at) VALUES('legacy-d','acct-x',?)").bind(new Date().toISOString()).run();
      } else await fixture.database.prepare("UPDATE profiles SET deleted_at = ? WHERE id = 'legacy-d'").bind(new Date().toISOString()).run();
      await expectRefused(fixture, reading, 'legacy-d-trip', abandoned);
    } finally { await fixture.dispose(); }
  }
});

test('R15: the grant rule agrees with normal authentication for every provider link, password and deletion state', async () => {
  const states = [];
  for (const link of ['none', 'self', 'other'] as const) for (const password of [false, true]) for (const sameId of [true, false]) for (const deleted of [false, true]) states.push({ link, password, sameId, deleted });
  for (const state of states) {
    const database = await storage();
    const account = state.sameId ? 'p1' : 'acct', provider = 'p1', now = '2026-11-07T00:00:00.000Z';
    for (const id of [...new Set([account, 'acct-other'])]) database.sqlite.prepare("INSERT INTO profiles(id,email,display_name,created_at,deleted_at) VALUES(?,?,?,?,?)")
      .run(id, `${id}@example.test`, id, now, id === account && state.deleted ? now : '');
    if (state.password) database.sqlite.prepare("INSERT INTO auth_credentials(user_id,email,password_hash,password_salt,iterations,created_at) VALUES(?,?,?,?,1,?)").run(account, `${account}@example.test`, 'h', 's', now);
    if (state.link !== 'none') database.sqlite.prepare('INSERT INTO auth_links(oai_user_id,user_id,created_at) VALUES(?,?,?)').run(provider, state.link === 'self' ? account : 'acct-other', now);
    const request = new Request('https://triptab.test/', { headers: { 'oai-authenticated-user-id': provider, 'oai-authenticated-user-email': `${account}@example.test` } });
    const canonical = await resolveIdentity(request, { allowSession: false }, database.asD1()).then(identity => identity.id === account, () => false);
    const granted = !!database.sqlite.prepare(`SELECT ${providerAuthenticatesAsSql('x.provider', 'x.account')} AS ok FROM (SELECT ? AS provider, ? AS account) x`).get(provider, account)?.ok;
    assert.equal(granted, canonical, JSON.stringify(state));
  }
});

// R16: a deadline that passes after the save was prepared but before its
// batch runs must be expired when the batch runs.
async function atCommit(fixture: Fixture, body: string) {
  await fixture.control('/__test/hooks', { pauseNextCommit: true });
  const response = fixture.process(body);
  await fixture.waitFor(async () => (await fixture.control('/__test/hooks')).atCommit, 'the reading to reach its commit');
  return { response };
}
const sleepUntil = (deadline: number) => new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now()) + 300));

test('R16: a session that expires while the commit is pending is expired at the commit: 409 and nothing written', async () => {
  const fixture = await createReceiptOperationWorker();
  try {
    const deadline = Date.now() + 3000;
    await fixture.database.prepare('UPDATE auth_sessions SET expires_at = ? WHERE user_id = ?').bind(new Date(deadline).toISOString(), fixture.owner.id).run();
    const { response } = await atCommit(fixture, await fixture.processBody());
    assert(Date.now() < deadline, 'the save was prepared before the deadline');
    const trip = await fixture.tripRow(), history = await fixture.historyCount();
    await sleepUntil(deadline);
    assert.equal((await fixture.request('/api/ledger')).status, 401, 'normal authentication has expired the session');
    await fixture.control('/__test/hooks', { proceed: true });
    assert.equal((await response).status, 409);
    assert.deepEqual(await fixture.tripRow(), trip);
    assert.equal(await fixture.historyCount(), history);
    assert.equal((await fixture.operations())[0].status, 'failed');
  } finally { await fixture.dispose(); }
});

test('R16: a grant that expires after inference, while the commit is pending, is expired at the commit: 409 and nothing written', async () => {
  const fixture = await createReceiptOperationWorker();
  try {
    const body = await fixture.processBody();
    await fixture.control('/__test/provider', { holdNext: 1, release: false });
    const response = fixture.process(body);
    await fixture.waitFor(async () => (await fixture.control('/__test/provider')).held === 1, 'the reading to reach the provider');
    const deadline = Date.now() + 3000;
    await fixture.database.prepare('UPDATE receipt_operations SET grant_expires_at = ?').bind(deadline).run();
    await fixture.control('/__test/hooks', { pauseNextCommit: true });
    await fixture.control('/__test/provider', { release: true });
    await fixture.waitFor(async () => (await fixture.control('/__test/hooks')).atCommit, 'the reading to reach its commit');
    assert(Date.now() < deadline, 'the save was prepared before the deadline');
    const trip = await fixture.tripRow(), history = await fixture.historyCount();
    await sleepUntil(deadline);
    await fixture.control('/__test/hooks', { proceed: true });
    assert.equal((await response).status, 409);
    assert.deepEqual(await fixture.tripRow(), trip);
    assert.equal(await fixture.historyCount(), history);
    assert.equal((await fixture.operations())[0].status, 'failed');
  } finally { await fixture.dispose(); }
});

test('R16 controls at the same pause: an unexpired owner commits; a removed grant does not', async () => {
  for (const change of ['none', 'missing-grant'] as const) {
    const fixture = await createReceiptOperationWorker();
    try {
      const { response } = await atCommit(fixture, await fixture.processBody());
      const history = await fixture.historyCount();
      if (change === 'missing-grant') await fixture.database.prepare('UPDATE receipt_operations SET grant_kind = NULL, grant_ref = NULL').run();
      await fixture.control('/__test/hooks', { proceed: true });
      assert.equal((await response).status, change === 'none' ? 200 : 409, change);
      assert.equal(await fixture.historyCount(), change === 'none' ? history + 1 : history, change);
    } finally { await fixture.dispose(); }
  }
});
