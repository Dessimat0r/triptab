import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { claimOperation, finishOperation, holdsOperation, operationKey, OPERATION_LEASE_MS, OPERATION_RETENTION_MS, type OperationSource } from '../lib/receipt-operations';
import { createReceiptFlowWorker } from './helpers/receipt-flow-worker';

// R06/R07: the claim lifecycle on its own. Separate connections to one database
// file stand in for separate Worker instances sharing D1; the last test runs
// the same statements on Miniflare's D1.
const source: OperationSource = { tripId: 'trip', draftId: 'draft', draftHash: 'a'.repeat(64), receiptId: 'photo', imageVersion: 'v1' };
const d1 = (sqlite: DatabaseSync) => ({ prepare: (sql: string) => ({ bind: (...values: (string | number | null)[]) => ({
  first: async () => sqlite.prepare(sql).get(...values) ?? null, run: async () => sqlite.prepare(sql).run(...values) }) }) }) as never;
async function shared() {
  const folder = await mkdtemp(path.join(tmpdir(), 'triptab-operations-'));
  const file = path.join(folder, 'd1.sqlite');
  const setup = new DatabaseSync(file);
  for (const migration of ['0016_receipt_operations.sql', '0017_receipt_operation_jobs.sql'])
    setup.exec((await readFile(new URL('../drizzle/' + migration, import.meta.url), 'utf8')).replaceAll('--> statement-breakpoint', ''));
  const instances = [new DatabaseSync(file), new DatabaseSync(file), new DatabaseSync(file)];
  return { setup, instances, close: async () => { for (const db of [setup, ...instances]) db.close(); await rm(folder, { recursive: true, force: true }); } };
}

test('R06: the key names the source and kind, never the person asking', async () => {
  const base = await operationKey(source);
  assert.equal(base, await operationKey({ ...source }));
  for (const changed of [{ draftHash: 'b'.repeat(64) }, { imageVersion: 'v2' }, { receiptId: 'other' }, { draftId: 'other' }, { tripId: 'other' },
    { readPurchaseDetails: true }, { questionId: 'q1' }]) assert.notEqual(await operationKey({ ...source, ...changed }), base, JSON.stringify(changed));
});

test('R06: concurrent claims from separate instances produce exactly one owner', async () => {
  const { instances, close } = await shared();
  try {
    const claims = await Promise.all(Array.from({ length: 30 }, (_, index) => claimOperation(d1(instances[index % 3]), source, index % 2 ? 'alice' : 'bob')));
    assert.equal(claims.filter(claim => claim.owned).length, 1);
    assert(claims.filter(claim => !claim.owned).every(claim => !claim.owned && claim.status === 'running'));
  } finally { await close(); }
});

test('R07: lease, takeover, outcome and supersession rules', async () => {
  const { instances: [one, two], close } = await shared();
  try {
    const now = 1_800_000_000_000;
    const first = await claimOperation(d1(one), source, 'alice', { now });
    assert(first.owned);
    // Within the lease nobody takes over.
    assert.deepEqual(await claimOperation(d1(two), source, 'bob', { now: now + OPERATION_LEASE_MS - 1 }), { owned: false, key: first.key, status: 'running', attempts: 1 });
    // After it, one new attempt does, and the old attempt can no longer commit or finish.
    const second = await claimOperation(d1(two), source, 'bob', { now: now + OPERATION_LEASE_MS + 1 });
    assert(second.owned && second.attempts === 2);
    assert.equal(await holdsOperation(d1(one), first.key, first.attemptId), false);
    assert.equal(await finishOperation(d1(one), first.key, first.attemptId, 'stored'), false);
    assert.equal(await holdsOperation(d1(one), second.key, second.attemptId), true);
    // A stored operation is never claimed again.
    assert.equal(await finishOperation(d1(two), second.key, second.attemptId, 'stored', { now: now + OPERATION_LEASE_MS + 2 }), true);
    assert.deepEqual(await claimOperation(d1(one), source, 'alice', { now: now + 10 * OPERATION_LEASE_MS }), { owned: false, key: first.key, status: 'stored', attempts: 2 });
    // A failed one may be claimed by the next request.
    const other = { ...source, draftHash: 'c'.repeat(64) };
    const failing = await claimOperation(d1(one), other, 'alice', { now });
    assert(failing.owned);
    assert.equal(await finishOperation(d1(one), failing.key, failing.attemptId, 'failed', { errorCode: 'timed-out', now: now + 1 }), true);
    const retry = await claimOperation(d1(two), other, 'alice', { now: now + 2 });
    assert(retry.owned && retry.attempts === 2);
  } finally { await close(); }
});

test('R07: settled records expire after the retention period, running ones never do', async () => {
  const { instances: [one], setup, close } = await shared();
  try {
    const now = 1_800_000_000_000;
    const settled = await claimOperation(d1(one), source, 'alice', { now });
    assert(settled.owned);
    await finishOperation(d1(one), settled.key, settled.attemptId, 'stored', { now });
    const running = await claimOperation(d1(one), { ...source, draftId: 'running' }, 'alice', { now });
    assert(running.owned);
    await claimOperation(d1(one), { ...source, draftId: 'later' }, 'alice', { now: now + OPERATION_RETENTION_MS + 1 });
    assert.deepEqual(setup.prepare('SELECT draft_id AS id FROM receipt_operations ORDER BY draft_id').all().map(row => row.id), ['later', 'running']);
  } finally { await close(); }
});

test('R06: the claim statements run on Miniflare D1 with every migration applied', async () => {
  const flow = await createReceiptFlowWorker({ seedTrip: false });
  try {
    const claims = await Promise.all([claimOperation(flow.db as never, source, 'alice'), claimOperation(flow.db as never, source, 'bob')]);
    assert.equal(claims.filter(claim => claim.owned).length, 1);
    const owner = claims.find(claim => claim.owned)!;
    assert(owner.owned);
    assert.equal(await holdsOperation(flow.db as never, owner.key, owner.attemptId), true);
    assert.equal(await finishOperation(flow.db as never, owner.key, owner.attemptId, 'stored'), true);
    assert.equal((await claimOperation(flow.db as never, source, 'carol')).owned, false);
  } finally { await flow.dispose(); }
});

test('R12: only a successful claim issues a commit fence; copies and data are not fences', async () => {
  const { instances: [one], close } = await shared();
  try {
    const { isOperationFence, operationCommitSql, operationFence } = await import('../lib/receipt-operations');
    const claim = await claimOperation(d1(one), source, 'alice');
    assert(claim.owned);
    assert.equal(isOperationFence(operationFence(claim)), true);
    for (const value of [{ key: claim.key, attemptId: claim.attemptId }, JSON.parse(JSON.stringify(claim.fence)), { ...claim.fence }, null, 'processing'])
      assert.equal(isOperationFence(value), false);
    assert.throws(() => operationCommitSql({ key: claim.key, attemptId: claim.attemptId }, 'alice'), /Untrusted receipt operation/);
    assert.throws(() => operationFence({ ...claim, fence: { key: claim.key, attemptId: claim.attemptId } }), /Not an owned receipt operation/);
  } finally { await close(); }
});
