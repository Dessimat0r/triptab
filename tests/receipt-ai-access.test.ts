import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { hashToken } from '../lib/auth';
import { getReceiptAIAccess, receiptAIStatus, saveReceiptAISettings, removeReceiptAIKey, ReceiptAIAccessError, type ReceiptAIEnvironment } from '../lib/receipt-ai-access';

class Statement {
  private values: (string | number | null)[] = [];
  constructor(private readonly db: DatabaseSync, private readonly sql: string) {}
  bind(...values: (string | number | null)[]) { this.values = values; return this; }
  async first<T>() { return this.db.prepare(this.sql).get(...this.values) as T || null; }
  async run() {
    const statement = this.db.prepare(this.sql);
    const results = statement.columns().length ? statement.all(...this.values) : (statement.run(...this.values), []);
    return { results, meta: { changes: Number(this.db.prepare('SELECT changes() AS count').get()?.count || 0) } };
  }
}
class D1 {
  sqlite = new DatabaseSync(':memory:');
  beforeBatch?: () => void;
  prepare(sql: string) { return new Statement(this.sqlite, sql); }
  async batch(statements: Statement[]) {
    const hook = this.beforeBatch; this.beforeBatch = undefined; hook?.();
    this.sqlite.exec('BEGIN');
    try { const results = []; for (const statement of statements) results.push(await statement.run()); this.sqlite.exec('COMMIT'); return results; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  get database() { return this as unknown as D1Database; }
}
const owner = { id: 'owner', email: 'dessimat0r@gmail.com', displayName: 'Owner' };
const impostor = { id: 'impostor', email: owner.email, displayName: 'Unverified' };
const other = { id: 'other', email: 'other@example.test', displayName: 'Other' };
const key = 'sk-test-' + 'A'.repeat(60), replacement = 'sk-test-' + 'B'.repeat(60);
const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const config: ReceiptAIEnvironment = { RECEIPT_AI_TOKEN_KEY: secret };
const provider = { 'oai-authenticated-user-id': 'owner-provider', 'oai-authenticated-user-email': owner.email };
const sessionTokens = { owner: 'O'.repeat(43), impostor: 'I'.repeat(43), other: 'T'.repeat(43) };
function request(account: keyof typeof sessionTokens = 'owner', linked = false) {
  return new Request('https://triptab.test/api/receipt/ai-settings', { headers: { cookie: `tt_session=${sessionTokens[account]}`, ...(linked ? provider : {}) } });
}
async function storage() {
  const db = new D1();
  for (const file of (await readdir(new URL('../drizzle/', import.meta.url))).filter(file => file.endsWith('.sql')).sort()) db.sqlite.exec(await readFile(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
  for (const profile of [owner, impostor, other]) {
    db.sqlite.prepare('INSERT INTO profiles (id,email,display_name,created_at) VALUES (?,?,?,?)').run(profile.id, profile.email, profile.displayName, new Date().toISOString());
    db.sqlite.prepare('INSERT INTO auth_sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)').run(await hashToken(sessionTokens[profile.id as keyof typeof sessionTokens]), profile.id, new Date(Date.now() + 60_000).toISOString(), new Date().toISOString());
  }
  db.sqlite.prepare('INSERT INTO auth_links (oai_user_id,user_id,created_at) VALUES (?,?,?)').run('owner-provider', owner.id, new Date().toISOString());
  return db;
}
function keyCheck(expected = key, status = 200): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), 'https://api.openai.com/v1/models');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${expected}`);
    assert.equal(init?.redirect, 'error');
    return Response.json(status === 200 ? { data: [] } : { error: { code: 'invalid_api_key' } }, { status });
  }) as typeof fetch;
}
const forbiddenFetch = (async () => { throw Error('No provider request was expected'); }) as typeof fetch;
function row(db: D1) { return db.sqlite.prepare("SELECT * FROM receipt_ai_settings WHERE id='shared'").get(); }

test('unconfigured server reports processing availability separately from owner-only key management', async () => {
  const db = await storage();
  const state = await receiptAIStatus(request('owner', true), owner, db.database, {});
  assert.equal(state.configured, false); assert.equal(state.connected, false);
  await assert.rejects(saveReceiptAISettings(request('owner', true), owner, db.database, {}, { apiKey: key }, forbiddenFetch), { code: 'not_configured' });
  const denied = await receiptAIStatus(request('other'), other, db.database, config);
  assert.equal(denied.eligible, true); assert.equal(denied.manageable, false); assert.equal(denied.apiConnected, false);
  assert.equal(denied.reason, 'not_connected'); assert.equal(denied.managementReason, 'account_restricted');
  await assert.rejects(saveReceiptAISettings(request('other'), other, db.database, config, { apiKey: key }, forbiddenFetch), { status: 403 });
  assert.equal(row(db), undefined);
});

test('settings mutations atomically reject a session revoked, expired or rebound after the final identity check', async () => {
  for (const action of ['save', 'remove'] as const) for (const race of ['revoked', 'expired', 'rebound'] as const) {
    const db = await storage();
    await saveReceiptAISettings(request('owner', true), owner, db.database, config, { apiKey: key }, keyCheck());
    const before = row(db), history = db.sqlite.prepare('SELECT * FROM account_activity_events').all();
    db.beforeBatch = () => {
      if (race === 'revoked') db.sqlite.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(owner.id);
      else if (race === 'expired') db.sqlite.prepare('UPDATE auth_sessions SET expires_at=? WHERE user_id=?').run(new Date(Date.now() - 1000).toISOString(), owner.id);
      else db.sqlite.prepare('UPDATE auth_sessions SET user_id=? WHERE user_id=?').run(impostor.id, owner.id);
    };
    await assert.rejects(action === 'save'
      ? saveReceiptAISettings(request(), owner, db.database, config, { apiKey: replacement }, keyCheck(replacement))
      : removeReceiptAIKey(request(), owner, db.database, config), { code: 'settings_changed' });
    assert.deepEqual(row(db), before, `${action}/${race} must preserve the shared credential`);
    assert.deepEqual(db.sqlite.prepare('SELECT * FROM account_activity_events').all(), history);
  }
});

test('first shared setup and first tombstone pin the verified provider association inside their mutation batch', async () => {
  for (const action of ['save', 'remove'] as const) for (const race of ['reparented', 'disconnected'] as const) {
    const db = await storage();
    db.beforeBatch = () => {
      if (race === 'reparented') db.sqlite.prepare('UPDATE auth_links SET user_id=? WHERE oai_user_id=?').run(impostor.id, 'owner-provider');
      else db.sqlite.prepare('DELETE FROM auth_links WHERE oai_user_id=?').run('owner-provider');
    };
    await assert.rejects(action === 'save'
      ? saveReceiptAISettings(request('owner', true), owner, db.database, config, { apiKey: key }, keyCheck())
      : removeReceiptAIKey(request('owner', true), owner, db.database, config), { code: 'settings_changed' });
    assert.equal(row(db), undefined);
    assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM account_activity_events').get()?.n, 0);
  }
});

test('provider-authenticated management refuses a reparented provider and a newly active foreign cookie at commit time', async () => {
  for (const race of ['provider', 'foreign-session'] as const) {
    const db = await storage();
    await saveReceiptAISettings(request('owner', true), owner, db.database, config, { apiKey: key }, keyCheck());
    const before = row(db), history = db.sqlite.prepare('SELECT * FROM account_activity_events').all();
    db.sqlite.prepare('UPDATE auth_sessions SET expires_at=? WHERE user_id=?').run(new Date(Date.now() - 1000).toISOString(), owner.id);
    db.beforeBatch = () => {
      if (race === 'provider') db.sqlite.prepare('UPDATE auth_links SET user_id=? WHERE oai_user_id=?').run(impostor.id, 'owner-provider');
      else db.sqlite.prepare('UPDATE auth_sessions SET user_id=?,expires_at=? WHERE user_id=?').run(impostor.id, new Date(Date.now() + 60_000).toISOString(), owner.id);
    };
    await assert.rejects(removeReceiptAIKey(request('owner', true), owner, db.database, config), { code: 'settings_changed' });
    assert.deepEqual(row(db), before);
    assert.deepEqual(db.sqlite.prepare('SELECT * FROM account_activity_events').all(), history);
  }
});

test('an unverified password account claiming the owner email cannot configure the shared key', async () => {
  const db = await storage();
  const status = await receiptAIStatus(request('impostor'), impostor, db.database, config);
  assert.equal(status.eligible, true); assert.equal(status.manageable, false);
  assert.equal(status.managementReason, 'verification_required'); assert.equal(status.reason, 'not_connected');
  await assert.rejects(saveReceiptAISettings(request('impostor'), impostor, db.database, config, { apiKey: key }, forbiddenFetch), { status: 403 });
  // Even the real provider identity alongside a different browser account is denied.
  await assert.rejects(saveReceiptAISettings(request('impostor', true), impostor, db.database, config, { apiKey: key }, forbiddenFetch), { status: 403 });
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM receipt_ai_settings').get()?.n, 0);
});

test('verified owner saves a validated encrypted key, then uses it with its own password session', async () => {
  const db = await storage();
  const result = await saveReceiptAISettings(request('owner', true), owner, db.database, config, { apiKey: key }, keyCheck());
  assert.equal(result.connected, true); assert.equal(result.provider, 'api'); assert.equal(result.siwcAvailable, false);
  assert.equal(result.manageable, true);
  assert.equal(row(db)?.id, 'shared'); assert.equal(row(db)?.user_id, owner.id);
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.equal(String(row(db)?.api_key_encrypted).includes(key), false);
  assert.equal(String(row(db)?.api_key_encrypted).startsWith('v1.'), true);
  const access = await getReceiptAIAccess(request(), owner, db.database, config);
  assert.deepEqual(access, { accessToken: key, model: 'gpt-4.1-mini', provider: 'api' });
  assert.equal((await receiptAIStatus(request(), owner, db.database, config)).connected, true);
  const audit = db.sqlite.prepare('SELECT after_data FROM account_activity_events WHERE entity_id=?').get('receipt-processing');
  assert.deepEqual(JSON.parse(String(audit?.after_data)), { keyConfigured: true, provider: 'api' });
  assert.equal(JSON.stringify(db.sqlite.prepare('SELECT * FROM account_activity_events').all()).includes(key), false);
});

test('all authenticated participants use the same server-only API key while only its canonical owner manages it', async () => {
  const db = await storage();
  await saveReceiptAISettings(request('owner', true), owner, db.database, config, { apiKey: key }, keyCheck());
  const before = row(db);
  for (const [account, profile] of [['other', other], ['impostor', impostor]] as const) {
    const status = await receiptAIStatus(request(account), profile, db.database, config);
    assert.equal(status.eligible, true); assert.equal(status.connected, true); assert.equal(status.apiConnected, true);
    assert.equal(status.manageable, false); assert.equal(status.managementReason, 'account_restricted');
    assert.equal(status.reason, undefined);
    assert.doesNotMatch(JSON.stringify(status), /sk-test-|api_key_encrypted|owner-provider/);
    assert.deepEqual(await getReceiptAIAccess(request(account), profile, db.database, config), { accessToken: key, model: 'gpt-4.1-mini', provider: 'api' });
    for (const body of [{ apiKey: replacement }, { provider: 'api' }, { provider: 'siwc' }]) {
      await assert.rejects(saveReceiptAISettings(request(account), profile, db.database, config, body, forbiddenFetch), { status: 403 });
    }
    await assert.rejects(removeReceiptAIKey(request(account), profile, db.database, config), { status: 403 });
  }
  assert.deepEqual(row(db), before);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM account_activity_events WHERE entity_id=?').get('receipt-processing')?.n, 1);
  await saveReceiptAISettings(request(), owner, db.database, config, { apiKey: replacement }, keyCheck(replacement));
  assert.equal((await getReceiptAIAccess(request('other'), other, db.database, config)).accessToken, replacement);
  await removeReceiptAIKey(request(), owner, db.database, config);
  assert.equal((await receiptAIStatus(request('other'), other, db.database, config)).connected, false);
  await assert.rejects(getReceiptAIAccess(request('other'), other, db.database, config), { status: 503, code: 'not_connected' });
});

test('API keys remain bound to their canonical account and encryption key', async () => {
  const db = await storage();
  await saveReceiptAISettings(request('owner', true), owner, db.database, config, { apiKey: key }, keyCheck());
  const encrypted = String(row(db)?.api_key_encrypted);
  assert.throws(() => db.sqlite.prepare('INSERT INTO receipt_ai_settings(user_id,api_key_encrypted,provider,version) VALUES(?,?,?,1)').run(impostor.id, encrypted, 'api'), /UNIQUE/);
  assert.throws(() => db.sqlite.prepare('INSERT INTO receipt_ai_settings(id,user_id,provider,version) VALUES(?,?,?,1)').run('foreign-settings', impostor.id, 'api'), /CHECK/);
  db.sqlite.prepare("UPDATE receipt_ai_settings SET user_id=? WHERE id='shared'").run(impostor.id);
  await assert.rejects(getReceiptAIAccess(request('other'), other, db.database, config), { code: 'key_unavailable' });
  db.sqlite.prepare("UPDATE receipt_ai_settings SET user_id=? WHERE id='shared'").run(owner.id);
  const changed = { RECEIPT_AI_TOKEN_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url') };
  assert.equal((await receiptAIStatus(request(), owner, db.database, changed)).connected, false);
  await assert.rejects(getReceiptAIAccess(request(), owner, db.database, changed), { code: 'key_unavailable' });
  await saveReceiptAISettings(request(), owner, db.database, changed, { apiKey: replacement }, keyCheck(replacement));
  assert.equal((await getReceiptAIAccess(request(), owner, db.database, changed)).accessToken, replacement);
});

test('a signed-out or switched account cannot obtain shared processing credentials or an owner management status', async () => {
  const db = await storage();
  await saveReceiptAISettings(request('owner', true), owner, db.database, config, { apiKey: key }, keyCheck());
  await assert.rejects(getReceiptAIAccess(request('other'), owner, db.database, config), { code: 'account_changed' });
  await assert.rejects(receiptAIStatus(request('other'), owner, db.database, config), { code: 'account_changed' });
  db.sqlite.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(other.id);
  await assert.rejects(getReceiptAIAccess(request('other'), other, db.database, config));
  await assert.rejects(receiptAIStatus(request('other'), other, db.database, config));
  assert.equal(row(db)?.user_id, owner.id);
});

test('invalid provider keys and transient verification failures preserve the saved key', async () => {
  const db = await storage();
  await saveReceiptAISettings(request('owner', true), owner, db.database, config, { apiKey: key }, keyCheck());
  const before = row(db);
  await assert.rejects(saveReceiptAISettings(request(), owner, db.database, config, { apiKey: replacement }, keyCheck(replacement, 401)), { code: 'key_check_failed' });
  await assert.rejects(saveReceiptAISettings(request(), owner, db.database, config, { apiKey: replacement }, (async () => { throw Error('network'); }) as typeof fetch), { code: 'key_check_unavailable' });
  assert.deepEqual(row(db), before);
  assert.equal((await getReceiptAIAccess(request(), owner, db.database, config)).accessToken, key);
});

test('SIWC defaults off and cannot be selected through forged settings', async () => {
  const db = await storage();
  await saveReceiptAISettings(request('owner', true), owner, db.database, config, { apiKey: key }, keyCheck());
  await assert.rejects(saveReceiptAISettings(request(), owner, db.database, config, { provider: 'siwc' }, forbiddenFetch), { code: 'siwc_disabled' });
  assert.equal(row(db)?.provider, 'api');
  for (const body of [{ apiKey: key, userId: other.id }, { provider: 'other' }, {}, null, { apiKey: 'oauth-not-a-key' }]) {
    await assert.rejects(saveReceiptAISettings(request(), owner, db.database, config, body, forbiddenFetch), ReceiptAIAccessError);
  }
  db.sqlite.prepare('UPDATE receipt_ai_settings SET provider=? WHERE user_id=?').run('siwc', owner.id);
  await assert.rejects(getReceiptAIAccess(request(), owner, db.database, config), { code: 'siwc_disabled' });
});

test('revoked or switched canonical sessions cannot save or use the owner key', async () => {
  const db = await storage();
  await saveReceiptAISettings(request('owner', true), owner, db.database, config, { apiKey: key }, keyCheck());
  await assert.rejects(getReceiptAIAccess(request('other'), owner, db.database, config), { code: 'account_changed' });
  const before = row(db);
  await assert.rejects(saveReceiptAISettings(request(), owner, db.database, config, { apiKey: replacement }, (async () => {
    db.sqlite.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(owner.id);
    return Response.json({ data: [] });
  }) as typeof fetch));
  assert.deepEqual(row(db), before);
});

test('a newer key or mode saved during key validation is not overwritten', async () => {
  const db = await storage();
  await saveReceiptAISettings(request('owner', true), owner, db.database, config, { apiKey: key }, keyCheck());
  const before = row(db);
  await assert.rejects(saveReceiptAISettings(request(), owner, db.database, config, { apiKey: replacement }, (async () => {
    db.sqlite.prepare('UPDATE receipt_ai_settings SET version=version+1 WHERE user_id=?').run(owner.id);
    return Response.json({ data: [] });
  }) as typeof fetch), { code: 'settings_changed' });
  assert.equal(row(db)?.api_key_encrypted, before?.api_key_encrypted);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM account_activity_events WHERE entity_id=?').get('receipt-processing')?.n, 1);
});

test('removing the API key stops requests and records safe account history', async () => {
  const db = await storage();
  await saveReceiptAISettings(request('owner', true), owner, db.database, config, { apiKey: key }, keyCheck());
  await assert.rejects(removeReceiptAIKey(request('other'), other, db.database, config), { status: 403 });
  const removed = await removeReceiptAIKey(request(), owner, db.database, config);
  assert.equal(removed.apiConnected, false); assert.equal(removed.connected, false); assert.equal(row(db)?.api_key_encrypted, null);
  await assert.rejects(getReceiptAIAccess(request(), owner, db.database, config), { code: 'not_connected' });
  const events = db.sqlite.prepare('SELECT after_data FROM account_activity_events WHERE entity_id=? ORDER BY sequence').all('receipt-processing');
  assert.equal(events.length, 2); assert.equal(JSON.parse(String(events[1].after_data)).keyConfigured, false);
});

test('API-key verification requests are bounded per account', async () => {
  const db = await storage();
  let calls = 0;
  const fetcher = (async () => { calls++; return new Response(null, { status: 401 }); }) as typeof fetch;
  for (let i = 0; i < 6; i++) await assert.rejects(saveReceiptAISettings(request('owner', true), owner, db.database, config, { apiKey: key }, fetcher), { code: 'key_check_failed' });
  await assert.rejects(saveReceiptAISettings(request('owner', true), owner, db.database, config, { apiKey: key }, fetcher), { code: 'rate_limited' });
  assert.equal(calls, 6);
});

test('removal fences first-time and no-key setup requests still validating remotely', async () => {
  for (const existingNoKeyRow of [false, true]) {
    const db = await storage();
    if (existingNoKeyRow) await removeReceiptAIKey(request('owner', true), owner, db.database, config);
    let release!: () => void, started!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    const pending = saveReceiptAISettings(request('owner', true), owner, db.database, config, { apiKey: key }, (async () => {
      started(); await new Promise<void>(resolve => { release = resolve; }); return Response.json({ data: [] });
    }) as typeof fetch);
    await begun;
    await removeReceiptAIKey(request('owner', true), owner, db.database, config);
    release();
    await assert.rejects(pending, { code: 'settings_changed' });
    assert.equal(row(db)?.api_key_encrypted, null);
    assert.equal((await receiptAIStatus(request('owner', true), owner, db.database, config)).apiConnected, false);
  }
});
