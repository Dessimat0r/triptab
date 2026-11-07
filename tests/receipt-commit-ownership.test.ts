import assert from 'node:assert/strict';
import test from 'node:test';
import type { Draft, Ledger } from '../lib/model';
import { createReceiptOperationWorker } from './helpers/receipt-operation-worker';

// R12: only the attempt that holds a receipt operation may commit its result,
// and that ownership is decided in the same D1 transaction as the ledger write.
// These run the production process, ledger and upload routes on Miniflare's D1
// and R2 with every migration. The shim pauses the reading's commit batch at
// the instant before it runs (after every pre-write check), so another real
// request can take the operation over exactly there.
type Fixture = Awaited<ReturnType<typeof createReceiptOperationWorker>>;
const draftOf = (ledger: { data: Ledger }, fixture: Fixture) => ledger.data.trips.find(trip => trip.id === fixture.tripId)!.drafts.find(value => value.id === 'op-draft')!;
async function atCommit(fixture: Fixture, body: string) {
  await fixture.control('/__test/hooks', { pauseNextCommit: true });
  const response = fixture.process(body);
  await fixture.waitFor(async () => (await fixture.control('/__test/hooks')).atCommit, 'the reading to reach its commit');
  // Wrapped: an async function returning the bare promise would wait for it.
  return { response };
}
async function proceed(fixture: Fixture) { await fixture.control('/__test/hooks', { proceed: true }); }

test('R12: an attempt taken over after its checks but before its commit writes nothing; the new owner stores the only proposal', async () => {
  const fixture = await createReceiptOperationWorker();
  try {
    const body = await fixture.processBody();
    const before = await fixture.tripRow(), historyBefore = await fixture.historyCount();
    const { response: a } = await atCommit(fixture, body);
    const [claimedByA] = await fixture.operations();
    // A's lease runs out while it is paused; B, a real request for the same
    // unchanged source, takes the operation over. B's provider call is held so
    // that, exactly as reproduced, the trip has not changed when A resumes.
    await fixture.database.prepare('UPDATE receipt_operations SET lease_until = 0').run();
    await fixture.control('/__test/provider', { holdNext: 1, release: false });
    const b = fixture.process(body);
    await fixture.waitFor(async () => (await fixture.operations())[0].attempt_id !== claimedByA.attempt_id && (await fixture.control('/__test/provider')).held === 1, 'B to take over');
    await proceed(fixture);
    const lost = await a;
    assert.equal(lost.status, 409, 'the superseded attempt is refused, not 200');
    assert.match((await lost.json() as { error: string }).error, /took over/);
    // Nothing of A's reached the ledger, history or trip revision.
    assert.deepEqual(await fixture.tripRow(), before);
    assert.equal(await fixture.historyCount(), historyBefore);
    const [during] = await fixture.operations();
    assert.equal(during.status, 'running');
    assert.notEqual(during.attempt_id, claimedByA.attempt_id);
    // B, the owner, commits.
    await fixture.control('/__test/provider', { release: true });
    const won = await b;
    assert.equal(won.status, 200, await won.clone().text());
    const [settled] = await fixture.operations();
    assert.equal(settled.status, 'stored');
    assert.equal(settled.attempt_id, during.attempt_id);
    const stored = draftOf(await fixture.readLedger(), fixture);
    assert.equal(stored.status, 'review');
    assert.equal(stored.receiptScan?.attemptId, settled.attempt_id, 'the stored proposal is the owner\'s');
    assert.equal(await fixture.historyCount(), historyBefore + 1);
    assert.equal((await fixture.control('/__test/provider')).calls, 2, 'A and B each reached the provider (the documented takeover residual)');
  } finally { await fixture.dispose(); }
});

test('R12 control: the current owner, paused at the same point, commits its proposal and records completion atomically', async () => {
  const fixture = await createReceiptOperationWorker();
  try {
    const historyBefore = await fixture.historyCount();
    const { response } = await atCommit(fixture, await fixture.processBody());
    await proceed(fixture);
    assert.equal((await response).status, 200);
    const [row] = await fixture.operations();
    assert.equal(row.status, 'stored');
    const stored = draftOf(await fixture.readLedger(), fixture);
    assert.equal(stored.status, 'review');
    assert.equal(stored.items.length, 2);
    assert.equal(stored.receiptScan?.attemptId, row.attempt_id);
    assert.equal(stored.receiptScan?.processor, 'native-api', 'processing context reached the scoped save');
    assert.equal(await fixture.historyCount(), historyBefore + 1);
    assert.equal((await fixture.control('/__test/provider')).calls, 1);
  } finally { await fixture.dispose(); }
});

test('R12: a person editing the receipt before the commit wins; the reading writes nothing and its operation fails', async () => {
  const fixture = await createReceiptOperationWorker();
  try {
    const { response } = await atCommit(fixture, await fixture.processBody());
    const ledger = await fixture.readLedger();
    draftOf(ledger, fixture).title = 'Typed by a person meanwhile';
    await fixture.saveLedger(ledger.data, ledger.revision);
    const before = await fixture.tripRow(), historyBefore = await fixture.historyCount();
    await proceed(fixture);
    assert.equal((await response).status, 409);
    assert.deepEqual(await fixture.tripRow(), before);
    assert.equal(await fixture.historyCount(), historyBefore);
    const draft = draftOf(await fixture.readLedger(), fixture);
    assert.equal(draft.title, 'Typed by a person meanwhile');
    assert.equal(draft.status, 'waiting');
    assert.equal((await fixture.operations())[0].status, 'failed');
  } finally { await fixture.dispose(); }
});

test('R12: a commit that fails leaves no proposal and a failed operation; an explicit retry stores one proposal', async () => {
  const fixture = await createReceiptOperationWorker();
  try {
    const body = await fixture.processBody();
    const before = await fixture.tripRow(), historyBefore = await fixture.historyCount();
    await fixture.control('/__test/hooks', { failNextCommit: 'before' });
    const failed = await fixture.process(body);
    assert.notEqual(failed.status, 200);
    assert.deepEqual(await fixture.tripRow(), before);
    assert.equal(await fixture.historyCount(), historyBefore);
    assert.equal((await fixture.operations())[0].status, 'failed');
    const retried = await fixture.process(body);
    assert.equal(retried.status, 200, await retried.clone().text());
    const [row] = await fixture.operations();
    assert.deepEqual([row.status, row.attempts], ['stored', 2]);
    assert.equal(draftOf(await fixture.readLedger(), fixture).receiptScan?.attemptId, row.attempt_id);
    assert.equal(await fixture.historyCount(), historyBefore + 1);
  } finally { await fixture.dispose(); }
});

test('R12: if the Worker is lost right after the commit, the proposal and its completed operation agree, and a retry spends nothing', async () => {
  const fixture = await createReceiptOperationWorker();
  try {
    const body = await fixture.processBody();
    await fixture.control('/__test/hooks', { failNextCommit: 'after' });
    const lost = await fixture.process(body);
    assert.notEqual(lost.status, 200, 'the client never saw success');
    const [row] = await fixture.operations();
    const stored: Draft = draftOf(await fixture.readLedger(), fixture);
    assert.equal(stored.status, 'review');
    assert.equal(row.status, 'stored', 'completion was recorded in the same transaction as the proposal');
    assert.equal(stored.receiptScan?.attemptId, row.attempt_id);
    // The reconnecting client still holds the old fingerprint: refused before any claim or spend.
    assert.equal((await fixture.process(body)).status, 409);
    assert.equal((await fixture.control('/__test/provider')).calls, 1);
    // A fresh request for the stored receipt is a new operation for the person to start, not a rerun of this one.
    assert.equal((await fixture.operations()).length, 1);
  } finally { await fixture.dispose(); }
});

test('R12: overlapping identical requests still make one provider call and store one proposal', async () => {
  const fixture = await createReceiptOperationWorker();
  try {
    const body = await fixture.processBody();
    await fixture.control('/__test/provider', { holdNext: 1, release: false });
    const first = fixture.process(body);
    await fixture.waitFor(async () => (await fixture.control('/__test/provider')).held === 1, 'the first reading to reach the provider');
    const second = await fixture.process(body);
    assert.equal(second.status, 202);
    await fixture.control('/__test/provider', { release: true });
    assert.equal((await first).status, 200);
    assert.equal((await fixture.control('/__test/provider')).calls, 1);
    assert.deepEqual((await fixture.operations()).map(row => row.status), ['stored']);
  } finally { await fixture.dispose(); }
});

test('R12: the processing context is internal: a forged operation identity cannot reach a processing save', async () => {
  const fixture = await createReceiptOperationWorker();
  try {
    // Even the exact key and attempt of a real running operation, presented as data, is refused.
    const { response } = await atCommit(fixture, await fixture.processBody());
    const [row] = await fixture.operations();
    const before = await fixture.tripRow(), historyBefore = await fixture.historyCount();
    for (const operation of [{ key: row.operation_key, attemptId: row.attempt_id }, { key: 'x', attemptId: 'y' }, true, 'processing']) {
      const result = await fixture.forgedSave(operation);
      assert.equal(result.saved, false, JSON.stringify(operation));
      assert.match(result.error ?? '', /Invalid receipt operation save/);
    }
    assert.deepEqual(await fixture.tripRow(), before);
    assert.equal(await fixture.historyCount(), historyBefore);
    await proceed(fixture);
    assert.equal((await response).status, 200, 'the real owner is unaffected');
  } finally { await fixture.dispose(); }
});
