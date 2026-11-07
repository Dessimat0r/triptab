import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createReceiptOperationWorker } from './helpers/receipt-operation-worker';

/**
 * N05 (owner decision): "Receipt ready notifications" is optional and off by
 * default. When on, the person who started a reading gets one generic notice per
 * completed operation, decided from the operation's persisted `stored` state and
 * the person's current access and preferences. Never from the browser connection.
 */
type Fixture = Awaited<ReturnType<typeof createReceiptOperationWorker>>;
type Reply = { status: number; text(): Promise<string> };
const notices = async (f: Fixture, user = f.owner.id) => (await f.database.prepare('SELECT id,title,body FROM notifications WHERE user_id=? ORDER BY created_at').bind(user).all<{ id: string; title: string; body: string }>()).results;
const setPreference = (f: Fixture, columns: { receipt_ready?: number; scope?: string; delivery?: string }, user = f.owner.id) =>
  f.database.prepare(`INSERT INTO notification_preferences(user_id,scope,delivery,reminders,receipt_ready) VALUES(?,?,?,1,?)
    ON CONFLICT(user_id) DO UPDATE SET scope=excluded.scope,delivery=excluded.delivery,receipt_ready=excluded.receipt_ready`)
    .bind(user, columns.scope ?? 'all', columns.delivery ?? 'immediate', columns.receipt_ready ?? 1).run();
const settle = () => new Promise(resolve => setTimeout(resolve, 300));
const GENERIC = { title: 'Receipt ready to review', body: 'Open TripTab to review it.' };
async function cutOff(f: Fixture, start: (body: string) => Promise<Reply> = body => f.process(body)) {
  const body = await f.processBody();
  await f.control('/__test/provider', { holdNext: 1, release: false });
  const abandoned = start(body);
  await f.waitFor(async () => (await f.control('/__test/provider')).held === 1, 'the reading to reach the provider');
  await f.database.prepare('UPDATE receipt_operations SET lease_until = 0').run();
  return { body, abandoned };
}
const finish = async (f: Fixture, inline?: { abandoned: Promise<Reply> }) => { await f.control('/__test/provider', { release: true }).catch(() => {}); await inline?.abandoned.catch(() => {}); };

test('N05: off by default. A reading finished in the browser request or in the background notifies nobody', async () => {
  for (const withPreferenceRow of [false, true]) {
    const f = await createReceiptOperationWorker();
    try {
      if (withPreferenceRow) await f.database.prepare("INSERT INTO notification_preferences(user_id,scope,delivery,reminders) VALUES(?,'all','immediate',1)").bind(f.owner.id).run();
      assert.equal((await f.process(await f.processBody())).status, 200);
      await settle();
      assert.deepEqual(await notices(f), [], `browser request (preference row: ${withPreferenceRow})`);
    } finally { await f.dispose().catch(() => {}); }
  }
  const f = await createReceiptOperationWorker();
  try {
    const inline = await cutOff(f);
    await settle();
    assert.equal((await f.tick()).stored, 1);
    await finish(f, inline); await settle();
    assert.deepEqual(await notices(f), [], 'background completion');
  } finally { await f.dispose().catch(() => {}); }
});

test('N05: on, a connected browser request still produces exactly one generic notice (no dependence on the connection)', async () => {
  const f = await createReceiptOperationWorker();
  try {
    await setPreference(f, {});
    assert.equal((await f.process(await f.processBody())).status, 200);
    await settle();
    const [only, ...rest] = await notices(f);
    assert.equal(rest.length, 0);
    assert.equal(only.title, GENERIC.title);
    assert.equal(only.body, GENERIC.body);
    assert.doesNotMatch(only.title + only.body, /Operations holiday|Café|Coffee|Pastry|£|\d/, 'no receipt title, holiday, item or amount');
  } finally { await f.dispose().catch(() => {}); }
});

test('N05: on, a reading cut off and finished by the background runner notifies once across duplicate ticks, a stale retry and the late original', async () => {
  const f = await createReceiptOperationWorker();
  try {
    await setPreference(f, {});
    const inline = await cutOff(f);
    await settle();
    assert.equal((await f.tick()).stored, 1);
    await settle();
    assert.equal((await f.tick()).stored, 0, 'a repeated tick finds nothing to finish');
    const calls = (await f.control('/__test/provider')).calls;
    assert.ok([200, 202, 409].includes((await f.process(inline.body)).status));
    assert.equal((await f.control('/__test/provider')).calls, calls, 'a retry makes no further provider call');
    await finish(f, inline); await settle();
    const all = await notices(f);
    assert.equal(all.length, 1, 'exactly one completion notice');
    assert.equal(all[0].body, GENERIC.body);
  } finally { await f.dispose().catch(() => {}); }
});

test('N05: the preference is read at delivery. Turned off while the reading runs: nothing, and the result is still saved. Turned on while it runs: delivered', async () => {
  for (const turnOn of [false, true]) {
    const f = await createReceiptOperationWorker();
    try {
      await setPreference(f, { receipt_ready: turnOn ? 0 : 1 });
      await f.control('/__test/provider', { holdNext: 1, release: false });
      const pending = f.process(await f.processBody());
      await f.waitFor(async () => (await f.control('/__test/provider')).held === 1, 'the reading to reach the provider');
      await setPreference(f, { receipt_ready: turnOn ? 1 : 0 });
      await f.control('/__test/provider', { release: true });
      assert.equal((await pending).status, 200);
      await settle();
      assert.equal((await f.currentDraft()).status, 'review', 'the proposal is saved either way');
      assert.equal((await notices(f)).length, turnOn ? 1 : 0);
    } finally { await f.dispose().catch(() => {}); }
  }
});

test('N05: failed or refused readings never notify, even when the preference is on', async () => {
  const noCredential = await createReceiptOperationWorker();
  try {
    await setPreference(noCredential, {});
    await noCredential.database.prepare("UPDATE receipt_ai_settings SET api_key_encrypted=NULL,version=version+1 WHERE id='shared'").run();
    assert.notEqual((await noCredential.process(await noCredential.processBody())).status, 200);
    await settle();
    assert.deepEqual(await notices(noCredential), []);
  } finally { await noCredential.dispose().catch(() => {}); }
  const revoked = await createReceiptOperationWorker();
  try {
    await setPreference(revoked, {});
    await revoked.control('/__test/hooks', { pauseBeforeSpend: true, releaseSpend: false });
    const pending = revoked.process(await revoked.processBody());
    await revoked.waitFor(async () => (await revoked.control('/__test/hooks')).atSpend === true, 'quota preparation');
    assert.equal((await revoked.request('/api/auth', { method: 'POST', body: JSON.stringify({ action: 'logout' }) })).status, 200);
    await revoked.control('/__test/hooks', { releaseSpend: true });
    assert.notEqual((await pending).status, 200);
    await settle();
    assert.equal((await f2calls(revoked)), 0);
    assert.deepEqual(await notices(revoked), []);
  } finally { await revoked.control('/__test/hooks', { releaseSpend: true }).catch(() => {}); await revoked.dispose().catch(() => {}); }
});
const f2calls = async (f: Fixture) => (await f.control('/__test/provider')).calls;

test('N05: an account deleted, or a member who left, while the reading was cut off gets nothing and nothing is stored', async () => {
  for (const change of ['deleted', 'left'] as const) {
    const f = await createReceiptOperationWorker();
    try {
      const bob = await f.createAccount({ id: 'bob-reader', email: 'bob-reader@example.test', name: 'Bob', session: true });
      await f.database.prepare('INSERT INTO memberships(trip_id,user_id,member_id) VALUES(?,?,?)').bind(f.tripId, 'bob-reader', 'bob').run();
      await setPreference(f, {}, 'bob-reader');
      const inline = await cutOff(f, body => f.requestAs(bob, '/api/receipt/process', { method: 'POST', body }));
      await settle();
      if (change === 'deleted') await f.database.prepare('UPDATE profiles SET deleted_at=? WHERE id=?').bind(new Date().toISOString(), 'bob-reader').run();
      else assert.equal((await f.requestAs(bob, '/api/trip', { method: 'POST', body: JSON.stringify({ action: 'leave', tripId: f.tripId }) })).status, 200);
      const before = await f.tripRow(), history = await f.historyCount();
      assert.equal((await f.tick()).stored, 0);
      await finish(f, inline); await settle();
      assert.deepEqual(await f.tripRow(), before);
      assert.equal(await f.historyCount(), history);
      assert.deepEqual(await notices(f, 'bob-reader'), [], `${change}: no receipt notice reaches them`);
    } finally { await f.dispose().catch(() => {}); }
  }
});

test('N05: with the setting on, every delivery preference records one inbox notice; only trip scope "none" suppresses it', async () => {
  for (const [columns, expected] of [[{ scope: 'none' }, 0], [{ delivery: 'daily' }, 1], [{ delivery: 'none' }, 1], [{ delivery: 'immediate' }, 1], [{ scope: 'involved' }, 1]] as const) {
    const f = await createReceiptOperationWorker();
    try {
      await setPreference(f, columns);
      assert.equal((await f.process(await f.processBody())).status, 200);
      await settle();
      assert.equal((await notices(f)).length, expected, JSON.stringify(columns));
    } finally { await f.dispose().catch(() => {}); }
  }
});

test('N05: a failing notification never undoes the saved result', async () => {
  const f = await createReceiptOperationWorker();
  try {
    await setPreference(f, {});
    await f.database.prepare("CREATE TRIGGER fail_receipt_ready BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT, 'notification store unavailable'); END").run();
    const history = await f.historyCount();
    const response = await f.process(await f.processBody());
    assert.equal(response.status, 200, await response.text());
    assert.equal((await f.currentDraft()).status, 'review');
    assert.equal(await f.historyCount(), history + 1, 'the proposal and its history were committed');
    assert.equal((await f.operations())[0].status, 'stored');
    assert.deepEqual(await notices(f), []);
  } finally { await f.dispose().catch(() => {}); }
});

test('N05: the notice does not use the request or any disconnect signal', async () => {
  for (const file of ['app/api/receipt/process/route.ts', 'lib/receipt-background.ts', 'lib/receipt-operation-work.ts']) {
    const source = await readFile(new URL('../' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /notifyWhenStored/, file);
    assert.doesNotMatch(source, /request\.signal\.aborted/, file);
  }
  const work = await readFile(new URL('../lib/receipt-operation-work.ts', import.meta.url), 'utf8');
  assert.match(work, /notifyReceiptReady\(\{ userId, tripId: trip\.id, operationKey: fence\.key \}\)/);
});

test('N05 preference API: default off, persisted, an older client that omits it keeps the stored choice, and bad values are rejected', async () => {
  const f = await createReceiptOperationWorker();
  try {
    const read = async () => (await f.request('/api/notification-preferences')).json() as Promise<Record<string, unknown>>;
    assert.deepEqual(await read(), { scope: 'all', delivery: 'immediate', reminders: true, receiptReady: false });
    const post = (value: unknown) => f.request('/api/notification-preferences', { method: 'POST', body: JSON.stringify(value) });
    // An older cached client sends exactly the three original fields.
    assert.equal((await post({ scope: 'all', delivery: 'immediate', reminders: true })).status, 200);
    assert.equal((await read()).receiptReady, false, 'saving without the field does not turn it on');
    assert.equal((await post({ scope: 'all', delivery: 'immediate', reminders: true, receiptReady: true })).status, 200);
    assert.equal((await read()).receiptReady, true);
    assert.equal((await post({ scope: 'involved', delivery: 'none', reminders: false })).status, 200);
    assert.deepEqual(await read(), { scope: 'involved', delivery: 'none', reminders: false, receiptReady: true }, 'an older client does not switch it off either');
    assert.notEqual((await post({ scope: 'all', delivery: 'immediate', reminders: true, receiptReady: 'yes' })).status, 200);
    assert.notEqual((await post({ scope: 'all', delivery: 'immediate', reminders: true, receiptReady: true, extra: 1 })).status, 200);
    const audit = (await f.database.prepare("SELECT before_data,after_data FROM account_activity_events WHERE entity_type='notifications' ORDER BY sequence DESC LIMIT 1").first<{ before_data: string; after_data: string }>())!;
    assert.equal(JSON.parse(audit.after_data).receiptReady, true, 'the change is in the account history');
  } finally { await f.dispose().catch(() => {}); }
});
