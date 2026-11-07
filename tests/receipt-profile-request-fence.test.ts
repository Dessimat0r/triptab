import assert from 'node:assert/strict';
import test from 'node:test';
import { createReceiptOperationWorker } from './helpers/receipt-operation-worker';
import { receiptFlowImage } from './helpers/receipt-flow-worker';
import { storage } from './helpers/sqlite-d1';
import { hashToken, identityWriteAuthorization, resolveIdentity, AuthError } from '../lib/auth';
import { activateReceipt, reserveReceipt } from '../lib/receipt-lifecycle';

/**
 * F2: receipt upload, receipt deletion and display-name change carry the request
 * credential in the statement that admits the write. A request still in flight
 * when its sign-in is withdrawn writes nothing and gets a 401. Membership was
 * already enforced at admission and still is.
 */
type Fixture = Awaited<ReturnType<typeof createReceiptOperationWorker>>;
type Init = NonNullable<Parameters<Fixture['requestAs']>[2]>;
const count = async (f: Fixture, sql: string, ...bind: unknown[]) => Number((await f.database.prepare(sql).bind(...bind).first<{ n: number }>())!.n);
const upload: Init = { method: 'POST', headers: { 'content-type': 'image/png' }, body: receiptFlowImage };
async function held(f: Fixture, who: object, path: string, init: Init, disrupt: () => Promise<void>) {
  await f.control('/__test/hooks', { pauseNextCommit: true });
  const pending = f.requestAs(who, path, init);
  await f.waitFor(async () => (await f.control('/__test/hooks')).atCommit, 'the held write');
  await disrupt();
  await f.control('/__test/hooks', { proceed: true });
  const response = await pending;
  return { status: response.status, body: await response.text() };
}
const logout = (f: Fixture, who: object) => async () => { assert.equal((await f.requestAs(who, '/api/auth', { method: 'POST', body: JSON.stringify({ action: 'logout' }) })).status, 200); };
const owner = (f: Fixture) => ({ sessionToken: f.sessionToken });

test('F2 upload: a request held while the requester signs out stores nothing and is a 401', async () => {
  const f = await createReceiptOperationWorker();
  try {
    const before = await count(f, "SELECT COUNT(*) AS n FROM receipts WHERE owner=?", f.owner.id);
    const r = await held(f, owner(f), `/api/receipt?tripId=${f.tripId}`, upload, logout(f, owner(f)));
    assert.equal(r.status, 401, r.body);
    assert.equal(await count(f, "SELECT COUNT(*) AS n FROM receipts WHERE owner=?", f.owner.id), before, 'no receipt row');
    const bucket = await f.worker.getR2Bucket('RECEIPTS');
    assert.equal((await bucket.list()).objects.length, before, 'no image object beyond the seeded photo');
  } finally { await f.dispose().catch(() => {}); }
});

test('F2 upload: a member who leaves while the upload is held still cannot add a photo (membership is unchanged)', async () => {
  const f = await createReceiptOperationWorker();
  try {
    const bob = await f.createAccount({ id: 'bob-user', email: 'bob@example.test', name: 'Bob', session: true });
    await f.database.prepare('INSERT INTO memberships(trip_id,user_id,member_id) VALUES(?,?,?)').bind(f.tripId, 'bob-user', 'bob').run();
    const r = await held(f, bob, `/api/receipt?tripId=${f.tripId}`, upload, async () => {
      assert.equal((await f.requestAs(bob, '/api/trip', { method: 'POST', body: JSON.stringify({ action: 'leave', tripId: f.tripId }) })).status, 200);
    });
    assert.equal(r.status, 403, r.body);
    assert.equal(await count(f, "SELECT COUNT(*) AS n FROM receipts WHERE owner='bob-user'"), 0);
  } finally { await f.dispose().catch(() => {}); }
});

test('F2 upload and delete: with a live sign-in both still work', async () => {
  const f = await createReceiptOperationWorker();
  try {
    const up = await f.request(`/api/receipt?tripId=${f.tripId}`, upload);
    assert.equal(up.status, 200, await up.clone().text());
    const { receiptId } = await up.json() as { receiptId: string };
    assert.equal(await count(f, "SELECT COUNT(*) AS n FROM receipts WHERE id=? AND state='active'", receiptId), 1);
    const del = await f.request(`/api/receipt?id=${receiptId}`, { method: 'DELETE' });
    assert.equal(del.status, 200, await del.text());
    assert.equal(await count(f, 'SELECT COUNT(*) AS n FROM receipts WHERE id=?', receiptId), 0);
  } finally { await f.dispose().catch(() => {}); }
});

test('F2 delete: a request held while the requester signs out removes nothing and is a 401', async () => {
  const f = await createReceiptOperationWorker();
  try {
    const up = await f.request(`/api/receipt?tripId=${f.tripId}`, upload);
    const { receiptId } = await up.json() as { receiptId: string };
    const r = await held(f, owner(f), `/api/receipt?id=${receiptId}`, { method: 'DELETE' }, logout(f, owner(f)));
    assert.equal(r.status, 401, r.body);
    assert.equal(await count(f, "SELECT COUNT(*) AS n FROM receipts WHERE id=? AND state='active'", receiptId), 1, 'still active, not marked for deletion');
    const bucket = await f.worker.getR2Bucket('RECEIPTS');
    assert.ok(await bucket.head(`${encodeURIComponent(f.owner.id)}/${receiptId}`), 'the image is still stored');
  } finally { await f.dispose().catch(() => {}); }
});

test('F2 display name: a change held while the requester signs out is not applied (401); a live change is', async () => {
  const f = await createReceiptOperationWorker();
  try {
    const name = async () => (await f.database.prepare('SELECT display_name FROM profiles WHERE id=?').bind(f.owner.id).first<{ display_name: string }>())!.display_name;
    const events = () => count(f, "SELECT COUNT(*) AS n FROM account_activity_events WHERE entity_type='profile' AND user_id=?", f.owner.id);
    const rename = (displayName: string): Init => ({ method: 'POST', body: JSON.stringify({ displayName }) });
    const live = await f.request('/api/profile', rename('Alice B'));
    assert.equal(live.status, 200, await live.text());
    assert.equal(await name(), 'Alice B');
    const eventsBefore = await events();
    const r = await held(f, owner(f), '/api/profile', rename('Renamed after logout'), logout(f, owner(f)));
    assert.equal(r.status, 401, r.body);
    assert.equal(await name(), 'Alice B');
    assert.equal(await events(), eventsBefore, 'no history entry either');
  } finally { await f.dispose().catch(() => {}); }
});

test('F2 activation: if the sign-in is withdrawn between reserving and activating an upload, activation is refused with a 401 and activates nothing', async () => {
  const database = await storage(), now = new Date().toISOString(), token = 'u'.repeat(43);
  database.sqlite.prepare('INSERT INTO profiles(id,email,display_name,created_at) VALUES(?,?,?,?)').run('uploader', 'uploader@example.test', 'Uploader', now);
  database.sqlite.prepare('INSERT INTO trips(id,owner,data) VALUES(?,?,?)').run('trip', 'uploader', JSON.stringify({ id: 'trip', name: 'T', currency: 'GBP', members: [], expenses: [], payments: [], drafts: [] }));
  database.sqlite.prepare('INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at,session_id) VALUES(?,?,?,?,?)').run(await hashToken(token), 'uploader', '2999-01-01T00:00:00.000Z', now, 'session-uploader');
  const identity = await resolveIdentity(new Request('https://triptab.test', { headers: { cookie: `tt_session=${token}` } }), {}, database.asD1());
  const fence = identityWriteAuthorization(identity);
  await reserveReceipt(database.asD1(), 'uploader', 'trip', 'receipt-1', now, { contentType: 'image/png', sizeBytes: 1, sha256: 'x' }, fence);
  database.sqlite.prepare('DELETE FROM auth_sessions').run();
  await assert.rejects(() => activateReceipt(database.asD1(), 'uploader', 'trip', 'receipt-1', fence), error => error instanceof AuthError && error.status === 401);
  assert.equal((database.sqlite.prepare("SELECT state FROM receipts WHERE id='receipt-1'").get() as { state: string }).state, 'pending');
  await assert.rejects(() => reserveReceipt(database.asD1(), 'uploader', 'trip', 'receipt-2', now, { contentType: 'image/png', sizeBytes: 1, sha256: 'y' }, fence), error => error instanceof AuthError && error.status === 401);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM receipts WHERE id='receipt-2'").get()!.n, 0);
});
