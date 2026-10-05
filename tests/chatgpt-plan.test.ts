import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  chatGPTPlanAccessToken, chatGPTPlanStatus, ChatGPTPlanError, disconnectChatGPTPlan,
  finishChatGPTPlanAuthorization, startChatGPTPlanAuthorization, verifyChatGPTPlanIdentity,
  type ChatGPTPlanEnvironment,
} from '../lib/chatgpt-plan';

class SQLiteStatement {
  private values: (string | number | null)[] = [];
  constructor(private readonly database: DatabaseSync, readonly sql: string) {}
  bind(...values: (string | number | null)[]) { this.values = values; return this; }
  async first<T>() { return (this.database.prepare(this.sql).get(...this.values) ?? null) as T | null; }
  async run() {
    const statement = this.database.prepare(this.sql);
    const results = statement.columns().length ? statement.all(...this.values) : (statement.run(...this.values), []);
    return { results, success: true, meta: { changes: Number(this.database.prepare('SELECT changes() AS n').get()?.n ?? 0) } };
  }
}
class SQLiteD1 {
  readonly sqlite = new DatabaseSync(':memory:');
  private pending: Promise<unknown> = Promise.resolve();
  prepare(sql: string) { return new SQLiteStatement(this.sqlite, sql); }
  batch(statements: SQLiteStatement[]) {
    const operation = this.pending.then(async () => {
      this.sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        this.sqlite.exec('COMMIT'); return results;
      } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
    });
    this.pending = operation.catch(() => {}); return operation;
  }
  asD1() { return this as unknown as D1Database; }
}
const owner = { id: 'plan-owner', displayName: 'Plan Owner' };
const other = { id: 'other-account', displayName: 'Other Account' };
const callback = 'https://triptab.test/api/chatgpt-plan/callback';
const clientId = 'oaiapp_plan_security_fixture';
const environment: ChatGPTPlanEnvironment = {
  CHATGPT_PLAN_ENABLED: 'true', CHATGPT_PLAN_CLIENT_ID: clientId,
  CHATGPT_PLAN_REDIRECT_URI: callback,
  CHATGPT_PLAN_TOKEN_KEY: Buffer.alloc(32, 19).toString('base64url'),
};
const grantedScope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const issuer = 'https://auth.openai.com';
const tokenEndpoint = issuer + '/api/accounts/oauth/token';
const jwksEndpoint = issuer + '/.well-known/jwks.json';
const revokeEndpoint = issuer + '/api/accounts/oauth/revoke';

async function storage() {
  const database = new SQLiteD1(); database.sqlite.exec('PRAGMA foreign_keys=ON');
  const journal = JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as { entries: { tag: string }[] };
  for (const entry of journal.entries) database.sqlite.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'));
  for (const person of [owner, other]) database.sqlite.prepare('INSERT INTO profiles(id,email,display_name,created_at) VALUES(?,?,?,?)')
    .run(person.id, person.id + '@example.test', person.displayName, new Date().toISOString());
  return database;
}
const signer = crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
async function signed(claims: Record<string, unknown> | string, header = { alg: 'RS256', kid: 'fixture-key' }) {
  const prefix = Buffer.from(JSON.stringify(header)).toString('base64url') + '.' + Buffer.from(typeof claims === 'string' ? claims : JSON.stringify(claims)).toString('base64url');
  return prefix + '.' + Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', (await signer).privateKey, new TextEncoder().encode(prefix))).toString('base64url');
}
function identity(nonce = 'test-nonce', extra: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return { iss: issuer, aud: clientId, sub: 'chatgpt-account', exp: now + 600, iat: now, nonce, email: 'owner@example.test', ...extra };
}
async function jwks() { return Response.json({ keys: [{ ...await crypto.subtle.exportKey('jwk', (await signer).publicKey), kid: 'fixture-key', alg: 'RS256', use: 'sig' }] }); }
async function begin(database: SQLiteD1, person = owner, returnTo = '/receipts?receiptDraft=saved-draft') {
  const result = await startChatGPTPlanAuthorization(database.asD1(), person.id, new Request('https://triptab.test/api/chatgpt-plan/start'), environment, returnTo);
  return { ...result, authorize: new URL(result.authorizationUrl) };
}
function returned(start: Awaited<ReturnType<typeof begin>>, query: Record<string, string> = { code: 'synthetic-code' }, cookie = start.cookie.split(';')[0]) {
  const url = new URL(callback); url.searchParams.set('state', start.authorize.searchParams.get('state')!);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return new Request(url, { headers: { cookie } });
}
async function grant(database: SQLiteD1, options: { expiresIn?: number; scope?: string; accessToken?: string; subject?: string } = {}) {
  const start = await begin(database);
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url) === jwksEndpoint) return jwks();
    assert.equal(String(url), tokenEndpoint); assert.equal(init?.redirect, 'error');
    const form = new URLSearchParams(String(init?.body));
    assert.equal(form.get('grant_type'), 'authorization_code'); assert.equal(form.get('code'), 'synthetic-code');
    assert.equal(form.get('redirect_uri'), callback);
    assert.equal(Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(form.get('code_verifier')!))).toString('base64url'), start.authorize.searchParams.get('code_challenge'));
    return Response.json({ access_token: options.accessToken ?? 'access-fixture-secret', refresh_token: 'refresh-fixture-secret', token_type: 'Bearer', expires_in: options.expiresIn ?? 3600,
      scope: options.scope ?? grantedScope, id_token: await signed(identity(start.authorize.searchParams.get('nonce')!, options.subject ? { sub: options.subject } : {})) });
  };
  const result = await finishChatGPTPlanAuthorization(database.asD1(), owner, returned(start), environment, fetcher);
  return { start, result, calls };
}
const code = (expected: string) => (error: unknown) => error instanceof ChatGPTPlanError && error.code === expected;
function heldFetch() {
  let release!: (response: Response) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const response = new Promise<Response>(resolve => { release = resolve; });
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++; assert.equal(String(url), tokenEndpoint); assert.equal(new URLSearchParams(String(init?.body)).get('grant_type'), 'refresh_token');
    entered(); return response;
  };
  return { fetcher, started, release, calls: () => calls };
}

test('plan access is disabled by default even with client credentials and makes no provider requests', async () => {
  const database = await storage(); await grant(database);
  let network = 0;
  const disabled = { ...environment, CHATGPT_PLAN_ENABLED: undefined };
  assert.deepEqual(await chatGPTPlanStatus(database.asD1(), owner.id, disabled), { configured: false, connected: false, reason: 'not_configured' });
  await assert.rejects(startChatGPTPlanAuthorization(database.asD1(), owner.id, new Request('https://triptab.test/api/chatgpt-plan/start'), disabled), code('not_configured'));
  await assert.rejects(chatGPTPlanAccessToken(database.asD1(), owner.id, disabled, { fetcher: async () => { network++; throw Error('No network allowed'); } }), code('not_configured'));
  assert.equal(network, 0);
});

test('approved plan authorization uses PKCE and nonce, stores encrypted tokens and records safe account history', async () => {
  const database = await storage(); const { start, result, calls } = await grant(database);
  assert.equal(start.authorize.origin, issuer); assert.equal(start.authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.match(start.authorize.searchParams.get('state')!, /^[A-Za-z0-9_-]{43}$/); assert.match(start.authorize.searchParams.get('nonce')!, /^[A-Za-z0-9_-]{43}$/);
  assert.match(start.cookie, /__Host-tt_plan_state=.*; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/);
  assert.deepEqual(result, { returnTo: '/receipts?receiptDraft=saved-draft', result: 'connected' }); assert.deepEqual(calls, [tokenEndpoint, jwksEndpoint]);
  const rows = JSON.stringify(database.sqlite.prepare('SELECT * FROM chatgpt_plan_connections').all());
  assert(!rows.includes('access-fixture-secret')); assert(!rows.includes('refresh-fixture-secret')); assert(!rows.includes('owner@example.test'));
  assert.deepEqual(await chatGPTPlanAccessToken(database.asD1(), owner.id, environment), { accessToken: 'access-fixture-secret', model: undefined });
  const audit = JSON.stringify(database.sqlite.prepare('SELECT * FROM account_activity_events').all());
  assert(audit.includes('planUsageEnabled')); assert(!audit.includes('fixture-secret')); assert(!audit.includes(start.authorize.searchParams.get('nonce')!));
});

test('callback state is browser- and account-bound, rejects duplicates and is consumed once', async () => {
  const database = await storage(); const start = await begin(database); let calls = 0;
  const never: typeof fetch = async () => { calls++; throw Error('Provider should not be called'); };
  await assert.rejects(finishChatGPTPlanAuthorization(database.asD1(), other, returned(start, { error: 'access_denied' }), environment, never), code('state_invalid'));
  await assert.rejects(finishChatGPTPlanAuthorization(database.asD1(), owner, returned(start, { error: 'access_denied' }, '__Host-tt_plan_state=' + 'x'.repeat(43)), environment, never), code('state_invalid'));
  await assert.rejects(finishChatGPTPlanAuthorization(database.asD1(), owner, returned(start, { error: 'access_denied' }, start.cookie.split(';')[0] + '; ' + start.cookie.split(';')[0]), environment, never), code('state_invalid'));
  const duplicated = new URL(returned(start).url); duplicated.searchParams.append('state', start.authorize.searchParams.get('state')!);
  await assert.rejects(finishChatGPTPlanAuthorization(database.asD1(), owner, new Request(duplicated, { headers: { cookie: start.cookie.split(';')[0] } }), environment, never), code('state_invalid'));
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS n FROM chatgpt_plan_transactions').get()?.n, 1);
  assert.equal((await finishChatGPTPlanAuthorization(database.asD1(), owner, returned(start, { error: 'access_denied' }), environment, never)).result, 'cancelled');
  await assert.rejects(finishChatGPTPlanAuthorization(database.asD1(), owner, returned(start), environment, never), code('state_invalid'));
  assert.equal(calls, 0); assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS n FROM chatgpt_plan_connections').get()?.n, 0);
});

test('expired or replaced authorization attempts cannot complete and callback return targets stay on this app', async () => {
  const database = await storage(); let providerCalls = 0; const never: typeof fetch = async () => { providerCalls++; throw Error(); };
  const first = await begin(database); await begin(database);
  await assert.rejects(finishChatGPTPlanAuthorization(database.asD1(), owner, returned(first), environment, never), code('state_invalid'));
  const expired = await begin(database); database.sqlite.exec('UPDATE chatgpt_plan_transactions SET expires_at=0');
  await assert.rejects(finishChatGPTPlanAuthorization(database.asD1(), owner, returned(expired), environment, never), code('state_invalid'));
  for (const target of ['https://attacker.invalid', '//attacker.invalid', '/\\attacker.invalid', '/api/receipt/process', '/signin-with-chatgpt']) {
    const start = await begin(database, owner, target);
    assert.deepEqual(await finishChatGPTPlanAuthorization(database.asD1(), owner, returned(start, { error: 'access_denied' }), environment, never), { returnTo: '/receipts', result: 'cancelled' });
  }
  assert.equal(providerCalls, 0);
});

test('identity validation rejects invalid nonce, audience, authorized party and non-finite dates even when correctly signed', async () => {
  const fetcher: typeof fetch = async url => { assert.equal(String(url), jwksEndpoint); return jwks(); };
  const base = identity(); assert.equal((await verifyChatGPTPlanIdentity(await signed(base), clientId, 'test-nonce', fetcher)).subject, 'chatgpt-account');
  const invalid: (Record<string, unknown> | string)[] = [
    { ...base, nonce: 'wrong' }, { ...base, iss: 'https://attacker.invalid' }, { ...base, aud: 'another-client' }, { ...base, exp: 0 },
    { ...base, aud: [clientId, 'another-client'] }, { ...base, aud: [clientId, 'another-client'], azp: 'another-client' }, { ...base, azp: 'another-client' },
    JSON.stringify(base).replace(/"exp":\d+/, '"exp":1e999'), JSON.stringify(base).replace(/"iat":\d+/, '"iat":-1e999'),
    JSON.stringify({ ...base, nbf: 1 }).replace('"nbf":1', '"nbf":-1e999'),
  ];
  for (const claims of invalid) await assert.rejects(verifyChatGPTPlanIdentity(await signed(claims), clientId, 'test-nonce', fetcher), code('identity_invalid'));
  assert.equal((await verifyChatGPTPlanIdentity(await signed({ ...base, aud: [clientId, 'another-client'], azp: clientId }), clientId, 'test-nonce', fetcher)).subject, 'chatgpt-account');
  await assert.rejects(verifyChatGPTPlanIdentity(await signed(base, { alg: 'HS256', kid: 'fixture-key' }), clientId, 'test-nonce', fetcher), code('identity_invalid'));
});

test('grants lacking explicit direct-plan permission never produce access tokens', async () => {
  const database = await storage(); const result = await grant(database, { scope: 'openid resource.invoke' });
  assert.equal(result.result.result, 'permission_required'); assert.equal((await chatGPTPlanStatus(database.asD1(), owner.id, environment)).connected, false);
  await assert.rejects(chatGPTPlanAccessToken(database.asD1(), owner.id, environment), code('permission_required'));
});

test('callback rejects a signed token from another authorization attempt before storing credentials', async () => {
  const database = await storage(); const start = await begin(database);
  await assert.rejects(finishChatGPTPlanAuthorization(database.asD1(), owner, returned(start), environment, async url => {
    if (String(url) === jwksEndpoint) return jwks();
    assert.equal(String(url), tokenEndpoint);
    return Response.json({ access_token: 'untrusted-access', refresh_token: 'untrusted-refresh', token_type: 'Bearer', expires_in: 3600,
      scope: grantedScope, id_token: await signed(identity('nonce-from-another-attempt')) });
  }), code('identity_invalid'));
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS n FROM chatgpt_plan_connections').get()?.n, 0);
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS n FROM account_activity_events').get()?.n, 0);
});

test('encrypted connection copied to another account cannot be decrypted or used', async () => {
  const database = await storage(); await grant(database);
  database.sqlite.prepare('INSERT INTO chatgpt_plan_connections(user_id,credentials,version,refresh_until) SELECT ?,credentials,version,refresh_until FROM chatgpt_plan_connections WHERE user_id=?').run(other.id, owner.id);
  assert.equal((await chatGPTPlanStatus(database.asD1(), other.id, environment)).connected, false);
  await assert.rejects(chatGPTPlanAccessToken(database.asD1(), other.id, environment), code('connection_invalid'));
  assert.equal((await chatGPTPlanStatus(database.asD1(), owner.id, environment)).connected, true);
});

test('refresh token rotation is serialized and the replacement token is stored atomically', async () => {
  const database = await storage(); await grant(database, { expiresIn: 1 }); const held = heldFetch();
  const first = chatGPTPlanAccessToken(database.asD1(), owner.id, environment, { fetcher: held.fetcher }); await held.started;
  await assert.rejects(chatGPTPlanAccessToken(database.asD1(), owner.id, environment, { fetcher: held.fetcher }), code('refresh_in_progress'));
  held.release(Response.json({ access_token: 'renewed-access', refresh_token: 'renewed-refresh', token_type: 'Bearer', expires_in: 3600, scope: grantedScope }));
  assert.equal((await first).accessToken, 'renewed-access'); assert.equal(held.calls(), 1);
  assert.equal((await chatGPTPlanAccessToken(database.asD1(), owner.id, environment)).accessToken, 'renewed-access');
  const row = database.sqlite.prepare('SELECT version,refresh_until,credentials FROM chatgpt_plan_connections').get()!;
  assert.equal(row.version, 2); assert.equal(row.refresh_until, 0); assert(!String(row.credentials).includes('renewed-'));
});

test('an incomplete token rotation cannot replace stored credentials or leave a renewal lease locked', async () => {
  const database = await storage(); await grant(database, { expiresIn: 1 });
  const before = database.sqlite.prepare('SELECT credentials FROM chatgpt_plan_connections').get()?.credentials;
  await assert.rejects(chatGPTPlanAccessToken(database.asD1(), owner.id, environment, { fetcher: async () => Response.json({
    access_token: 'incomplete-renewal-access', token_type: 'Bearer', expires_in: 3600, scope: grantedScope,
  }) }), /incomplete renewal credentials/);
  const row = database.sqlite.prepare('SELECT credentials,version,refresh_until FROM chatgpt_plan_connections').get()!;
  assert.equal(row.credentials, before); assert.equal(row.version, 1); assert.equal(row.refresh_until, 0);
});

test('a failed account-history append rolls back new plan credentials with the authorization write', async () => {
  const database = await storage();
  database.sqlite.exec("CREATE TRIGGER deny_plan_audit BEFORE INSERT ON account_activity_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
  await assert.rejects(grant(database), /audit unavailable/);
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS n FROM chatgpt_plan_connections').get()?.n, 0);
});

test('disconnect during renewal prevents a late refresh from recreating a revoked connection', async () => {
  const database = await storage(); await grant(database, { expiresIn: 1 }); const held = heldFetch();
  const renewal = chatGPTPlanAccessToken(database.asD1(), owner.id, environment, { fetcher: held.fetcher }); await held.started;
  let revoked = 0;
  await disconnectChatGPTPlan(database.asD1(), owner, environment, async (url, init) => {
    assert.equal(String(url), revokeEndpoint); assert.equal(new URLSearchParams(String(init?.body)).get('token'), 'refresh-fixture-secret'); revoked++; return new Response(null, { status: 200 });
  });
  held.release(Response.json({ access_token: 'late-access', refresh_token: 'late-refresh', token_type: 'Bearer', expires_in: 3600, scope: grantedScope }));
  await assert.rejects(renewal, code('connection_changed')); assert.equal(revoked, 1);
  assert.equal((await chatGPTPlanStatus(database.asD1(), owner.id, environment)).connected, false);
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS n FROM chatgpt_plan_connections').get()?.n, 0);
});

test('invalid grant from an older renewal cannot delete a freshly authorized connection', async () => {
  const database = await storage(); await grant(database, { expiresIn: 1 }); const held = heldFetch();
  const renewal = chatGPTPlanAccessToken(database.asD1(), owner.id, environment, { fetcher: held.fetcher }); await held.started;
  await grant(database, { accessToken: 'newly-authorized-access' });
  held.release(Response.json({ error: 'invalid_grant' }, { status: 400 }));
  await assert.rejects(renewal, code('not_connected'));
  assert.equal((await chatGPTPlanAccessToken(database.asD1(), owner.id, environment)).accessToken, 'newly-authorized-access');
  assert.equal((await chatGPTPlanStatus(database.asD1(), owner.id, environment)).connected, true);
});

test('failed remote revocation still removes local tokens and does not put credentials in audit history', async () => {
  const database = await storage(); await grant(database); const pending = await begin(database);
  const result = await disconnectChatGPTPlan(database.asD1(), owner, environment, async () => { throw Error('Synthetic network failure'); });
  assert.equal(result.connected, false); assert.equal(result.revoked, false); assert.match(result.error!, /remote revocation/);
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS n FROM chatgpt_plan_connections').get()?.n, 0);
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS n FROM chatgpt_plan_transactions').get()?.n, 0);
  await assert.rejects(finishChatGPTPlanAuthorization(database.asD1(), owner, returned(pending), environment), code('state_invalid'));
  const audit = JSON.stringify(database.sqlite.prepare('SELECT * FROM account_activity_events').all());
  assert(!audit.includes('fixture-secret')); assert(!audit.includes('synthetic-code'));
});

test('an explicitly requested reconnect can recover an unreadable old plan credential record', async () => {
  const db = await storage();
  await grant(db);
  db.sqlite.prepare('UPDATE chatgpt_plan_connections SET credentials=? WHERE user_id=?').run('v1.corrupt.record', owner.id);
  assert.equal((await chatGPTPlanStatus(db.asD1(), owner.id, environment)).connected, false);
  const original = db.sqlite.prepare('SELECT credentials FROM chatgpt_plan_connections WHERE user_id=?').get(owner.id)?.credentials;
  const start = await begin(db);
  assert.equal(start.authorize.hostname, 'auth.openai.com');
  assert.equal(db.sqlite.prepare('SELECT credentials FROM chatgpt_plan_connections WHERE user_id=?').get(owner.id)?.credentials, original);
});
