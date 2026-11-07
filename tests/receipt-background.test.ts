import assert from 'node:assert/strict';
import test from 'node:test';
import type { Ledger } from '../lib/model';
import { createReceiptOperationWorker } from './helpers/receipt-operation-worker';

// R07: a reading cut off after the browser went away finishes in the
// background runner (the scheduled handler's receipt dispatch), with no
// browser request, under the person's execution grant, through the same
// fenced commit (R12). Production routes and runner on Miniflare D1/R2; the
// provider is mocked (tests/helpers/workers-shim.ts) and never paid.
//
// The platform's cut-off is modelled exactly as the runtime leaves it: the
// browser's attempt is stuck at the provider (never released here until the
// end, when its late completion must be refused), no outcome is recorded, and
// its lease has run out.
type Fixture = Awaited<ReturnType<typeof createReceiptOperationWorker>>;
const draftOf = (ledger: { data: Ledger }, fixture: Fixture) => ledger.data.trips.find(trip => trip.id === fixture.tripId)?.drafts.find(value => value.id === 'op-draft');

async function cutOff(fixture: Fixture) {
  const body = await fixture.processBody();
  await fixture.control('/__test/provider', { holdNext: 1, release: false });
  const abandoned = fixture.process(body); // the phone locked: nobody reads this response
  await fixture.waitFor(async () => (await fixture.control('/__test/provider')).held === 1, 'the browser reading to reach the provider');
  const [row] = await fixture.operations();
  assert.equal(row.status, 'running');
  assert.equal(row.provider, 'api', 'the credential kind is recorded before the call');
  await fixture.database.prepare('UPDATE receipt_operations SET lease_until = 0').run();
  return { body, abandoned, attemptId: row.attempt_id };
}
const calls = async (fixture: Fixture) => (await fixture.control('/__test/provider')).calls;

test('R07: a reading cut off after a disconnect completes in the background with no browser request; a reconnect reuses it; the late attempt writes nothing', async () => {
  const fixture = await createReceiptOperationWorker();
  try {
    const historyBefore = await fixture.historyCount();
    const inline = await cutOff(fixture);
    // The background attempt's own (mocked) inference is long too: held until released.
    await fixture.control('/__test/provider', { holdNext: 1 });
    const tick = fixture.tick();
    await fixture.waitFor(async () => (await fixture.control('/__test/provider')).held === 2, 'the background reading to reach the provider');
    const [running] = await fixture.operations();
    assert.equal(running.status, 'running');
    assert.notEqual(running.attempt_id, inline.attemptId);
    assert.equal(running.auto_resumes, 1);
    // The person reopens the app meanwhile: told it is reading, nothing spent.
    const reconnect = await fixture.process(inline.body);
    assert.equal(reconnect.status, 202);
    assert.equal((await reconnect.json() as { reading?: boolean }).reading, true);
    assert.equal(await calls(fixture), 2);
    await fixture.control('/__test/provider', { release: true });
    assert.deepEqual(await tick, { resumed: 1, skipped: 0, stored: 1, failed: 0, disabled: false });
    const late = await inline.abandoned;
    assert.equal(late.status, 409, 'the cut-off attempt, if it ever resumes, cannot commit');
    const [stored] = await fixture.operations();
    assert.deepEqual([stored.status, stored.attempts, stored.auto_resumes], ['stored', 2, 1]);
    const draft = draftOf(await fixture.readLedger(), fixture)!;
    assert.equal(draft.status, 'review');
    assert.equal(draft.items.length, 2);
    assert.equal(draft.receiptScan?.attemptId, running.attempt_id);
    assert.equal(await fixture.historyCount(), historyBefore + 1, 'one proposal, one history event');
    assert.equal(await calls(fixture), 2, 'documented: the cut-off call cannot be retrieved, so the resume calls once more');
    // Nothing left to resume, and a stale reconnect spends nothing.
    assert.deepEqual(await fixture.tick(), { resumed: 0, skipped: 0, stored: 0, failed: 0, disabled: false });
    assert.equal((await fixture.process(inline.body)).status, 409);
    assert.equal(await calls(fixture), 2);
  } finally { await fixture.dispose(); }
});

test('R07: duplicate runner deliveries and a person\'s concurrent retry produce one resume, one provider call and one proposal', async () => {
  const fixture = await createReceiptOperationWorker();
  try {
    const historyBefore = await fixture.historyCount();
    const inline = await cutOff(fixture);
    await fixture.control('/__test/provider', { holdNext: 1 });
    const [first, second, retry] = [fixture.tick(), fixture.tick(), fixture.process(inline.body)];
    await fixture.waitFor(async () => (await fixture.control('/__test/provider')).held === 2, 'one resumed attempt at the provider');
    await fixture.control('/__test/provider', { release: true });
    const ticks = await Promise.all([first, second]);
    const response = await retry;
    const resumedByRunner = ticks.reduce((sum, value) => sum + value.resumed, 0);
    assert.equal(resumedByRunner + (response.status === 200 ? 1 : 0), 1, `exactly one owner (runner ${resumedByRunner}, request ${response.status})`);
    if (response.status !== 200) assert.equal(response.status, 202);
    await inline.abandoned;
    assert.equal(await calls(fixture), 2, 'the cut-off call plus exactly one resume');
    assert.equal(await fixture.historyCount(), historyBefore + 1);
    const [row] = await fixture.operations();
    assert.equal(row.status, 'stored');
    assert.equal(draftOf(await fixture.readLedger(), fixture)!.receiptScan?.attemptId, row.attempt_id);
  } finally { await fixture.dispose(); }
});

const revocations: { name: string; code: string; kind?: 'bill'; change(fixture: Fixture): Promise<void> }[] = [
  { name: 'sign-out (the session is revoked)', code: 'authorization-ended', change: async fixture => { await fixture.database.prepare('DELETE FROM auth_sessions').run(); } },
  { name: 'session expiry', code: 'authorization-ended', change: async fixture => { await fixture.database.prepare("UPDATE auth_sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run(); } },
  { name: 'account deleted', code: 'authorization-ended', change: async fixture => { await fixture.database.prepare("UPDATE profiles SET deleted_at = '2026-11-07T00:00:00.000Z'").run(); } },
  { name: 'grant expired', code: 'authorization-expired', change: async fixture => { await fixture.database.prepare('UPDATE receipt_operations SET grant_expires_at = 1').run(); } },
  { name: 'holiday archived', code: 'source-unavailable', change: async fixture => {
    const response = await fixture.request('/api/trip', { method: 'POST', body: JSON.stringify({ action: 'archive', tripId: fixture.tripId }) });
    assert.equal(response.status, 200, await response.clone().text());
  } },
  { name: 'holiday deleted', code: 'source-unavailable', change: async fixture => {
    const response = await fixture.request('/api/trip', { method: 'POST', body: JSON.stringify({ action: 'delete', tripId: fixture.tripId, confirmName: 'Operations holiday' }) });
    assert.equal(response.status, 200, await response.clone().text());
  } },
  { name: 'bill deleted (restorable for 30 days)', code: 'source-unavailable', kind: 'bill', change: async fixture => {
    const response = await fixture.request('/api/trip', { method: 'POST', body: JSON.stringify({ action: 'delete', tripId: fixture.tripId, confirmName: 'Operations holiday' }) });
    assert.equal(response.status, 200, await response.clone().text());
  } },
  { name: 'draft edited by a person', code: 'ledger-changed', change: async fixture => {
    const ledger = await fixture.readLedger();
    draftOf(ledger, fixture)!.title = 'Typed meanwhile';
    await fixture.saveLedger(ledger.data, ledger.revision);
  } },
  { name: 'shared key removed', code: 'not_connected', change: async fixture => { await fixture.database.prepare('UPDATE receipt_ai_settings SET api_key_encrypted = NULL').run(); } },
  { name: 'processing switched to a plan that is not enabled', code: 'siwc_disabled', change: async fixture => { await fixture.database.prepare("UPDATE receipt_ai_settings SET provider = 'siwc'").run(); } },
  { name: 'a different credential kind than the person started with', code: 'credentials_changed', change: async fixture => { await fixture.database.prepare("UPDATE receipt_operations SET provider = 'siwc'").run(); } },
];

for (const revocation of revocations) test(`R07: ${revocation.name} before the background attempt: it spends nothing, writes nothing and is not retried`, async () => {
  const fixture = await createReceiptOperationWorker({ kind: revocation.kind });
  try {
    const inline = await cutOff(fixture);
    await revocation.change(fixture);
    const before = await fixture.database.prepare('SELECT data FROM trips WHERE id = ?').bind(fixture.tripId).first<{ data: string }>();
    const historyBefore = await fixture.historyCount();
    const result = await fixture.tick();
    assert.equal(result.stored, 0);
    assert.equal(await calls(fixture), 1, 'no provider call beyond the cut-off one');
    const [row] = await fixture.operations();
    assert.deepEqual([row.status, row.error_code], ['failed', revocation.code]);
    assert.deepEqual(await fixture.database.prepare('SELECT data FROM trips WHERE id = ?').bind(fixture.tripId).first<{ data: string }>(), before);
    assert.equal(await fixture.historyCount(), historyBefore);
    assert.deepEqual(await fixture.tick(), { resumed: 0, skipped: 0, stored: 0, failed: 0, disabled: false }, 'a failed operation is never resumed automatically');
    // The abandoned attempt finishing late cannot commit either.
    await fixture.control('/__test/provider', { release: true });
    assert.notEqual((await inline.abandoned).status, 200);
    assert.equal(await fixture.historyCount(), historyBefore);
  } finally { await fixture.dispose(); }
});

for (const revocation of revocations.filter(value => ['sign-out (the session is revoked)', 'account deleted', 'draft edited by a person', 'holiday archived'].includes(value.name)))
  test(`R07: ${revocation.name} while the background attempt is reading: its result is not committed and no paid retry follows`, async () => {
    const fixture = await createReceiptOperationWorker();
    try {
      await cutOff(fixture);
      await fixture.control('/__test/provider', { holdNext: 1 });
      const tick = fixture.tick();
      await fixture.waitFor(async () => (await fixture.control('/__test/provider')).held === 2, 'the background reading to reach the provider');
      await revocation.change(fixture);
      const before = await fixture.database.prepare('SELECT data FROM trips WHERE id = ?').bind(fixture.tripId).first<{ data: string }>();
      const historyBefore = await fixture.historyCount();
      await fixture.control('/__test/provider', { release: true });
      const result = await tick;
      assert.deepEqual([result.resumed, result.stored, result.failed], [1, 0, 1]);
      const [row] = await fixture.operations();
      assert.equal(row.status, 'failed');
      // A source that disappears or changes mid-reading is caught by the commit's
      // fresh read ("this receipt changed"); a sign-in that ended, by the grant.
      assert.equal(row.error_code, ['source-unavailable', 'ledger-changed'].includes(revocation.code) ? 'ledger-changed' : 'authorization-ended');
      assert.deepEqual(await fixture.database.prepare('SELECT data FROM trips WHERE id = ?').bind(fixture.tripId).first<{ data: string }>(), before);
      assert.equal(await fixture.historyCount(), historyBefore);
      assert.equal(await calls(fixture), 2);
      assert.deepEqual(await fixture.tick(), { resumed: 0, skipped: 0, stored: 0, failed: 0, disabled: false });
      assert.equal(await calls(fixture), 2, 'no automatic paid retry after a refused commit');
    } finally { await fixture.dispose(); }
  });

test('R07: a reading that failed (provider error) is left for the person to retry; the runner never retries it', async () => {
  const fixture = await createReceiptOperationWorker();
  try {
    await fixture.control('/__test/provider', { fail: 1 });
    const failed = await fixture.process(await fixture.processBody());
    assert.notEqual(failed.status, 200);
    assert.equal((await fixture.operations())[0].status, 'failed');
    await fixture.database.prepare('UPDATE receipt_operations SET lease_until = 0').run();
    assert.deepEqual(await fixture.tick(), { resumed: 0, skipped: 0, stored: 0, failed: 0, disabled: false });
    assert.equal(await calls(fixture), 1);
  } finally { await fixture.dispose(); }
});

test('R07: a resumed attempt that is itself cut off is not resumed again; the operation ends as interrupted', async () => {
  const fixture = await createReceiptOperationWorker();
  try {
    await cutOff(fixture);
    await fixture.control('/__test/provider', { holdNext: 1 });
    void fixture.tick(); // this background attempt is cut off too
    await fixture.waitFor(async () => (await fixture.control('/__test/provider')).held === 2, 'the background reading to reach the provider');
    await fixture.database.prepare('UPDATE receipt_operations SET lease_until = 0').run();
    assert.deepEqual(await fixture.tick(), { resumed: 0, skipped: 0, stored: 0, failed: 0, disabled: false });
    const [row] = await fixture.operations();
    assert.deepEqual([row.status, row.error_code, row.auto_resumes], ['failed', 'interrupted', 1]);
    assert.equal(await calls(fixture), 2, 'bounded: no third call');
    // The person may read again explicitly: a new attempt under their own request.
    await fixture.control('/__test/provider', { release: true, holdNext: 0 });
    const retry = await fixture.process(await fixture.processBody());
    assert.equal(retry.status, 200, await retry.clone().text());
    assert.equal((await fixture.operations())[0].status, 'stored');
  } finally { await fixture.dispose(); }
});

test('R07: a connected reading needs no runner, and a running lease is never resumed early', async () => {
  const fixture = await createReceiptOperationWorker();
  try {
    await fixture.control('/__test/provider', { holdNext: 1, release: false });
    const response = fixture.process(await fixture.processBody());
    await fixture.waitFor(async () => (await fixture.control('/__test/provider')).held === 1, 'the reading to reach the provider');
    assert.deepEqual(await fixture.tick(), { resumed: 0, skipped: 0, stored: 0, failed: 0, disabled: false }, 'within its lease the request owns it');
    await fixture.control('/__test/provider', { release: true });
    assert.equal((await response).status, 200);
    const [row] = await fixture.operations();
    assert.deepEqual([row.status, row.auto_resumes], ['stored', 0]);
    assert.equal(await calls(fixture), 1);
  } finally { await fixture.dispose(); }
});

test('R07 kill switch: RECEIPT_BACKGROUND_RESUME off stops the runner; nothing is read, spent or written, and a person can still read again', async () => {
  for (const value of ['off', 'OFF', 'false', '0', 'disabled']) {
    const fixture = await createReceiptOperationWorker({ bindings: { RECEIPT_BACKGROUND_RESUME: value } });
    try {
      const inline = await cutOff(fixture);
      const before = await fixture.tripRow(), historyBefore = await fixture.historyCount();
      assert.deepEqual(await fixture.tick(), { resumed: 0, skipped: 0, stored: 0, failed: 0, disabled: true }, value);
      const [row] = await fixture.operations();
      assert.deepEqual([row.status, row.auto_resumes, row.attempt_id], ['running', 0, inline.attemptId], 'the operation is left exactly as the platform left it');
      assert.equal(await calls(fixture), 1);
      assert.deepEqual(await fixture.tripRow(), before);
      assert.equal(await fixture.historyCount(), historyBefore);
      // As before R07: the person's own retry takes the interrupted operation over and stores one proposal.
      await fixture.control('/__test/provider', { holdNext: 0 });
      const retry = await fixture.process(inline.body);
      assert.equal(retry.status, 200, await retry.clone().text());
      assert.equal((await fixture.operations())[0].status, 'stored');
      assert.equal(await calls(fixture), 2);
      // The cut-off attempt, if it ever finishes, cannot commit.
      await fixture.control('/__test/provider', { release: true });
      assert.equal((await inline.abandoned).status, 409);
    } finally { await fixture.dispose(); }
  }
});

test('R07 kill switch: unset, empty or "on" keeps the runner on', async () => {
  const { backgroundResumeEnabled } = await import('../lib/receipt-operations');
  for (const value of [undefined, '', ' ', 'on', 'ON', ' on ']) assert.equal(backgroundResumeEnabled({ RECEIPT_BACKGROUND_RESUME: value }), true, String(value));
  for (const value of ['off', 'false', '0', 'no', 'of', 'onn']) assert.equal(backgroundResumeEnabled({ RECEIPT_BACKGROUND_RESUME: value }), false, value);
  const fixture = await createReceiptOperationWorker({ bindings: { RECEIPT_BACKGROUND_RESUME: 'on' } });
  try {
    const inline = await cutOff(fixture);
    const result = await fixture.tick();
    assert.deepEqual([result.resumed, result.stored, result.disabled], [1, 1, false]);
    await fixture.control('/__test/provider', { release: true });
    assert.equal((await inline.abandoned).status, 409);
  } finally { await fixture.dispose(); }
});
