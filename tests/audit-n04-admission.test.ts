import test from 'node:test';
import assert from 'node:assert/strict';
import { createReceiptOperationWorker } from './helpers/receipt-operation-worker';
import { sha256Hex } from '../lib/data-utils';

/**
 * N04 verification, second pass. #79's tests cover six cutoffs during quota
 * preparation, leaving the bill and the model-discovery gap. These add the rest
 * of the brief's list: provider remapping, receipt deletion/replacement, loss of
 * operation ownership, quota refusal, failure before invocation, competing
 * attempts, and a live-grant control. Mocked provider only: no paid inference.
 */
type Fixture = Awaited<ReturnType<typeof createReceiptOperationWorker>>;
const notifications = async (f: Fixture) => Number((await f.database.prepare('SELECT COUNT(*) AS n FROM notifications').first<{ n: number }>())!.n);
const calls = async (f: Fixture) => (await f.control('/__test/provider')).calls;
async function refusedAt(f: Fixture, disrupt: () => Promise<void>, start: () => Promise<Response>, options: { claimTaken?: boolean } = {}) {
  await f.control('/__test/hooks', { pauseBeforeSpend: true, releaseSpend: false });
  const pending = start();
  await f.waitFor(async () => (await f.control('/__test/hooks')).atSpend === true, 'the quota step before the provider call');
  assert.equal(await calls(f), 0, 'nothing has been sent yet');
  await disrupt();
  const before = await f.tripRow(), history = await f.historyCount();
  await f.control('/__test/hooks', { releaseSpend: true });
  const response = await pending;
  assert.equal(await calls(f), 0, 'the first provider call is never admitted');
  assert.deepEqual(await f.tripRow(), before, 'no proposal is stored');
  assert.equal(await f.historyCount(), history);
  assert.equal(await notifications(f), 0, 'no notification for a refused operation');
  // When another attempt now holds the claim, recovery resuming *that* attempt is by design;
  // the refused attempt itself must not be retried, which the zero provider calls above show.
  if (!options.claimTaken) assert.equal((await f.tick(Date.now() + 1_000_000)).resumed, 0, 'a terminal refusal is never an automatic paid retry');
  return response;
}

test('N04: provider identity remapped during quota preparation prevents the first provider call', async () => {
  const f = await createReceiptOperationWorker();
  try {
    await f.createAccount({ id: 'linked-user', email: 'linked@example.test', name: 'Linked', password: true, link: { providerId: 'linked-provider' }, session: true });
    await f.createAccount({ id: 'mapped-elsewhere', email: 'elsewhere@example.test', name: 'Elsewhere' });
    const identity = { provider: { id: 'linked-provider', email: 'linked@example.test' } };
    const reading = await f.seedReading(identity, 'remap-trip');
    await f.control('/__test/hooks', { pauseBeforeSpend: true, releaseSpend: false });
    const pending = reading.process();
    await f.waitFor(async () => (await f.control('/__test/hooks')).atSpend === true, 'quota step');
    await f.database.prepare('UPDATE auth_links SET user_id=? WHERE oai_user_id=?').bind('mapped-elsewhere', 'linked-provider').run();
    const before = await reading.trip(), history = await reading.history();
    await f.control('/__test/hooks', { releaseSpend: true });
    await pending;
    assert.equal(await calls(f), 0);
    assert.deepEqual(await reading.trip(), before);
    assert.equal(await reading.history(), history);
    assert.equal(await notifications(f), 0);
    assert.equal((await f.tick(Date.now() + 1_000_000)).resumed, 0);
  } finally { await f.control('/__test/hooks', { releaseSpend: true }).catch(() => {}); await f.dispose().catch(() => {}); }
});

for (const change of ['deleted', 'replaced'] as const) test(`N04: the receipt photo is ${change} during quota preparation: nothing is sent to the provider`, async () => {
  const f = await createReceiptOperationWorker();
  try {
    const bucket = await f.worker.getR2Bucket('RECEIPTS');
    const key = `${encodeURIComponent(f.owner.id)}/${f.receiptId}`;
    const response = await refusedAt(f, async () => {
      if (change === 'deleted') await bucket.delete(key);
      else await bucket.put(key, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 9, 9]), { httpMetadata: { contentType: 'image/png' } });
    }, async () => f.process(await f.processBody()));
    assert.notEqual(response.status, 200);
  } finally { await f.control('/__test/hooks', { releaseSpend: true }).catch(() => {}); await f.dispose().catch(() => {}); }
});

test('N04: losing the operation claim during quota preparation prevents the first provider call', async () => {
  const f = await createReceiptOperationWorker();
  try {
    const response = await refusedAt(f, async () => {
      await f.database.prepare("UPDATE receipt_operations SET attempt_id='another-attempt'").run();
    }, async () => f.process(await f.processBody()), { claimTaken: true });
    assert.notEqual(response.status, 200);
  } finally { await f.control('/__test/hooks', { releaseSpend: true }).catch(() => {}); await f.dispose().catch(() => {}); }
});

test('N04: a quota refusal never reaches the provider and stores nothing', async () => {
  const f = await createReceiptOperationWorker();
  try {
    const window = Math.floor(Date.now() / 60_000) * 60_000;
    await f.database.prepare('INSERT INTO auth_rate_limits(key_hash,window_start,attempts) VALUES(?,?,6)').bind(await sha256Hex(`triptab:receipt-process:${f.owner.id}:${window}`), window).run();
    const before = await f.tripRow(), history = await f.historyCount();
    const response = await f.process(await f.processBody());
    assert.equal(response.status, 429, await response.text());
    assert.equal(await calls(f), 0);
    assert.deepEqual(await f.tripRow(), before);
    assert.equal(await f.historyCount(), history);
    assert.equal(await notifications(f), 0);
  } finally { await f.dispose().catch(() => {}); }
});

test('N04: a failure before invocation (no provider credential) sends nothing and stores nothing', async () => {
  const f = await createReceiptOperationWorker();
  try {
    await f.database.prepare("UPDATE receipt_ai_settings SET api_key_encrypted=NULL,version=version+1 WHERE id='shared'").run();
    const before = await f.tripRow(), history = await f.historyCount();
    const response = await f.process(await f.processBody());
    assert.notEqual(response.status, 200);
    assert.equal(await calls(f), 0);
    assert.deepEqual(await f.tripRow(), before);
    assert.equal(await f.historyCount(), history);
    assert.equal(await notifications(f), 0);
    assert.equal((await f.tick(Date.now() + 1_000_000)).resumed, 0);
  } finally { await f.dispose().catch(() => {}); }
});

test('N04 control: a live grant reads the receipt with exactly one provider call and one stored proposal', async () => {
  const f = await createReceiptOperationWorker();
  try {
    const history = await f.historyCount();
    const response = await f.process(await f.processBody());
    assert.equal(response.status, 200, await response.text());
    assert.equal(await calls(f), 1);
    assert.equal(await f.historyCount(), history + 1);
    assert.equal((await f.currentDraft()).status, 'review', 'the proposal awaits the person\'s review');
  } finally { await f.dispose().catch(() => {}); }
});

test('N04 control: competing attempts on one draft make at most one provider call and store one proposal', async () => {
  const f = await createReceiptOperationWorker();
  try {
    const history = await f.historyCount();
    const body = await f.processBody();
    const results = await Promise.all([f.process(body), f.process(body)]);
    const statuses = results.map(r => r.status);
    assert.ok(statuses.includes(200), JSON.stringify(statuses));
    assert.equal(await calls(f), 1, `statuses ${JSON.stringify(statuses)}`);
    assert.equal(await f.historyCount(), history + 1, 'one stored proposal');
  } finally { await f.dispose().catch(() => {}); }
});
