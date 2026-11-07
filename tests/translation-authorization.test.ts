import assert from 'node:assert/strict';
import test from 'node:test';
import { createReceiptOperationWorker } from './helpers/receipt-operation-worker';

for (const cutoff of ['logout', 'logout-with-provider', 'expiry', 'leave', 'key-removed', 'unchanged'] as const) test(`N04: receipt translation respects ${cutoff} during quota preparation`, async () => {
  const f = await createReceiptOperationWorker();
  try {
    const reader = cutoff === 'leave' ? await f.createAccount({ id: 'translation-reader', name: 'Bob', email: 'reader@example.test', session: true })
      : { sessionToken: f.sessionToken, ...(cutoff === 'logout-with-provider' ? { provider: { id: f.owner.id, email: f.owner.email } } : {}) };
    if (cutoff === 'leave') await f.database.prepare('INSERT INTO memberships(trip_id,user_id,member_id) VALUES(?,?,?)').bind(f.tripId, 'translation-reader', 'bob').run();
    const deadline = Date.now() + 1_500;
    if (cutoff === 'expiry') await f.database.prepare('UPDATE auth_sessions SET expires_at=? WHERE session_id=?').bind(new Date(deadline).toISOString(), f.sessionId).run();
    await f.control('/__test/provider', { output: { rows: [{ id: 'translated', text: 'Milk', sourceLanguage: 'de' }] } });
    await f.control('/__test/hooks', { pauseBeforeSpend: true, releaseSpend: false });
    const pending = f.requestAs(reader, '/api/receipt/translate', { method: 'POST', body: JSON.stringify({
      purpose: 'items', accountId: cutoff === 'leave' ? 'translation-reader' : f.owner.id, tripId: f.tripId,
      rows: [{ id: 'translated', sourceText: 'Milch', sourceLanguage: 'de', targetLanguage: 'en' }],
    }) });
    await f.waitFor(async () => (await f.control('/__test/hooks')).atSpend === true, 'translation quota preparation');
    assert.equal((await f.control('/__test/provider')).calls, 0);
    if (cutoff === 'logout' || cutoff === 'logout-with-provider') assert.equal((await f.requestAs(reader, '/api/auth', { method: 'POST', body: JSON.stringify({ action: 'logout' }) })).status, 200);
    if (cutoff === 'expiry') await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now()) + 100));
    if (cutoff === 'leave') assert.equal((await f.requestAs(reader, '/api/trip', { method: 'POST', body: JSON.stringify({ action: 'leave', tripId: f.tripId }) })).status, 200);
    if (cutoff === 'key-removed') await f.database.prepare("UPDATE receipt_ai_settings SET api_key_encrypted=NULL,version=version+1 WHERE id='shared'").run();
    const before = await f.tripRow(), history = await f.historyCount();
    await f.control('/__test/hooks', { releaseSpend: true });
    const response = await pending;
    if (cutoff === 'unchanged') {
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual((await response.json() as { rows: unknown }).rows, [{ id: 'translated', text: 'Milk', sourceLanguage: 'de' }]);
    } else {
      assert.notEqual(response.status, 200);
    }
    assert.equal((await f.control('/__test/provider')).calls, cutoff === 'unchanged' ? 1 : 0, 'a revoked request cannot send private text to inference for the first time');
    assert.deepEqual(await f.tripRow(), before); assert.equal(await f.historyCount(), history);
  } finally { await f.dispose(); }
});
