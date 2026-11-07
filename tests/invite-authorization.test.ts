import assert from 'node:assert/strict';
import test from 'node:test';
import { createReceiptOperationWorker } from './helpers/receipt-operation-worker';

for (const mode of ['create', 'accept', 'revoke'] as const) test(`N03: prepared invitation ${mode} stops after its session is revoked`, async () => {
  const f = await createReceiptOperationWorker();
  try {
    const bob = await f.createAccount({ id: 'invited-bob', name: 'Bob', email: 'invited-bob@example.test', session: true });
    let body: Record<string, unknown> = { mode: 'create', tripId: f.tripId, memberId: 'bob' };
    if (mode !== 'create') {
      const created = await f.request('/api/invite', { method: 'POST', body: JSON.stringify(body) });
      assert.equal(created.status, 200, await created.clone().text());
      const invite = await created.json() as { url: string; invitationId: string };
      const token = new URL(invite.url).searchParams.get('invite')!;
      if (mode === 'accept') {
        const response = await f.requestAs(bob, `/api/invite?token=${token}`);
        assert.equal(response.status, 200);
        const preview = await response.json() as { historySnapshot: string };
        body = { mode: 'accept', token, acceptHistory: true, historySnapshot: preview.historySnapshot };
      } else body = { mode: 'revoke', tripId: f.tripId, invitationId: invite.invitationId };
    }
    await f.control('/__test/hooks', { pauseNextCommit: true });
    const request = mode === 'accept' ? f.requestAs.bind(null, bob) : f.request;
    const pending = request('/api/invite', { method: 'POST', body: JSON.stringify(body) });
    await f.waitFor(async () => (await f.control('/__test/hooks')).atCommit, 'invitation commit preparation');
    assert.equal((await request('/api/auth', { method: 'POST', body: JSON.stringify({ action: 'logout' }) })).status, 200);
    const before = await f.tripRow(), history = await f.historyCount();
    const links = (await f.database.prepare('SELECT * FROM memberships ORDER BY trip_id,user_id').all()).results;
    const invites = (await f.database.prepare('SELECT * FROM invites ORDER BY token_hash').all()).results;
    await f.control('/__test/hooks', { proceed: true });
    assert.equal((await pending).status, 401);
    assert.deepEqual(await f.tripRow(), before); assert.equal(await f.historyCount(), history);
    assert.deepEqual((await f.database.prepare('SELECT * FROM memberships ORDER BY trip_id,user_id').all()).results, links);
    assert.deepEqual((await f.database.prepare('SELECT * FROM invites ORDER BY token_hash').all()).results, invites);
  } finally { await f.dispose(); }
});

test('R16 extension: an invitation expiring during acceptance preparation cannot create membership or history', async () => {
  const f = await createReceiptOperationWorker();
  try {
    const bob = await f.createAccount({ id: 'expiry-bob', name: 'Bob', email: 'expiry-bob@example.test', session: true });
    const created = await f.request('/api/invite', { method: 'POST', body: JSON.stringify({ mode: 'create', tripId: f.tripId, memberId: 'bob' }) });
    assert.equal(created.status, 200);
    const token = new URL((await created.json() as { url: string }).url).searchParams.get('invite')!;
    const preview = await (await f.requestAs(bob, `/api/invite?token=${token}`)).json() as { historySnapshot: string };
    const deadline = Date.now() + 1_000;
    await f.database.prepare('UPDATE invites SET expires_at=?').bind(new Date(deadline).toISOString()).run();
    await f.control('/__test/hooks', { pauseNextCommit: true });
    const pending = f.requestAs(bob, '/api/invite', { method: 'POST', body: JSON.stringify({ mode: 'accept', token, acceptHistory: true, historySnapshot: preview.historySnapshot }) });
    await f.waitFor(async () => (await f.control('/__test/hooks')).atCommit, 'prepared acceptance');
    const before = await f.tripRow(), history = await f.historyCount();
    await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now()) + 100));
    await f.control('/__test/hooks', { proceed: true });
    assert.notEqual((await pending).status, 200);
    assert.equal(await f.database.prepare('SELECT 1 FROM memberships WHERE user_id=?').bind('expiry-bob').first(), null);
    assert.deepEqual(await f.tripRow(), before); assert.equal(await f.historyCount(), history);
  } finally { await f.dispose(); }
});
