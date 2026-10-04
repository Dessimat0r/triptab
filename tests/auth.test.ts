import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import {
  AuthError, hashPassword, hashToken, performAuthAction, readAuthState,
  resolveIdentity, sessionIdentity, verifyPassword, consumeAuthRateLimit, cleanupExpiredAuthData,
} from '../lib/auth';

class SQLiteStatement {
  private values: (string | number | null)[] = [];
  constructor(private readonly sqlite: DatabaseSync, private readonly sql: string) {}
  bind(...values: (string | number | null)[]) { this.values = values; return this; }
  async first<T>() { return (this.sqlite.prepare(this.sql).get(...this.values) || null) as T | null; }
  async all<T>() { return { results: this.sqlite.prepare(this.sql).all(...this.values) as T[] }; }
  async run() {
    const statement = this.sqlite.prepare(this.sql);
    let results: unknown[] = [];
    if (statement.columns().length) results = statement.all(...this.values);
    else statement.run(...this.values);
    const changes = Number(this.sqlite.prepare('SELECT changes() AS changes').get()?.changes || 0);
    return { results, meta: { changes }, success: true };
  }
}
class SQLiteD1 {
  readonly sqlite = new DatabaseSync(':memory:');
  prepare(sql: string) { return new SQLiteStatement(this.sqlite, sql); }
  async batch(statements: SQLiteStatement[]) {
    this.sqlite.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  asD1() { return this as unknown as D1Database; }
}
async function storage() {
  const database = new SQLiteD1();
  database.sqlite.exec(await readFile(new URL('../drizzle/0001_regular_maginty.sql', import.meta.url), 'utf8'));
  database.sqlite.exec(await readFile(new URL('../drizzle/0002_windy_cammi.sql', import.meta.url), 'utf8'));
  return database;
}
const password = 'suitcase coffee 2026';
function request(headers: Record<string, string> = {}, url = 'https://triptab.test/api/auth') {
  return new Request(url, { headers: { 'cf-connecting-ip': '203.0.113.9', ...headers } });
}
function sessionRequest(cookie: string, headers: Record<string, string> = {}) {
  return request({ cookie: cookie.split(';')[0], ...headers });
}
function provider(id = 'legacy-owner', email = 'owner@example.com') {
  return { 'oai-authenticated-user-id': id, 'oai-authenticated-user-email': email, 'oai-authenticated-user-full-name': 'Original%20Owner' };
}
async function register(database: SQLiteD1, email = 'traveller@example.com') {
  return performAuthAction(request(), { action: 'register', email, password, displayName: 'Traveller' }, database.asD1());
}

test('password hashing uses random 256-bit salts, PBKDF2 and every password character', async () => {
  const digest = await hashPassword(password);
  const other = await hashPassword(password);
  assert.equal(digest.iterations, 100_000);
  assert.equal(digest.salt.length, 43);
  assert.notEqual(digest.salt, other.salt);
  assert.equal(await verifyPassword(password, digest), true);
  assert.equal(await verifyPassword(`${password} `, digest), false);
  const long = 'a'.repeat(110) + 'correct-tail';
  assert.equal(await verifyPassword('a'.repeat(110) + 'wrong---tail', await hashPassword(long)), false);
  await assert.rejects(hashPassword('a'.repeat(11)), /between 12 and 128/);
  await assert.rejects(hashPassword('a'.repeat(129)), /between 12 and 128/);
});

test('registration requires no provider connection and never merges by email', async () => {
  const database = await storage();
  await readAuthState(request(provider('existing-provider', 'traveller@example.com')), database.asD1());
  const result = await register(database, ' Traveller@Example.com ');
  assert.equal(result.state.authenticated, true);
  assert.equal(result.state.hasPassword, true);
  assert.equal(result.state.chatgptLinked, false);
  assert.equal(result.state.emailVerified, false);
  assert.match(result.state.profile!.id, /^local_/);
  assert.notEqual(result.state.profile!.id, 'existing-provider');
  assert.equal(result.state.profile!.email, 'traveller@example.com');
  assert.match(result.cookie!, /HttpOnly; SameSite=Lax; Max-Age=2592000; Secure/);
  const rawToken = result.cookie!.split(';')[0].split('=')[1];
  const stored = database.sqlite.prepare('SELECT token_hash FROM auth_sessions').get();
  assert.equal(stored?.token_hash, await hashToken(rawToken));
  assert.notEqual(stored?.token_hash, rawToken);
  assert.equal((await resolveIdentity(sessionRequest(result.cookie!), {}, database.asD1())).id, result.state.profile!.id);
  await assert.rejects(register(database), (error: unknown) => error instanceof AuthError && error.status === 409);
});

test('login rotates opaque sessions, normalizes only email and clears only email attempt counts', async () => {
  const database = await storage();
  const original = await register(database);
  await assert.rejects(performAuthAction(request(), { action: 'login', email: 'traveller@example.com', password: `${password} ` }, database.asD1()), /email or password/);
  const loggedIn = await performAuthAction(sessionRequest(original.cookie!), { action: 'login', email: ' TRAVELLER@EXAMPLE.COM ', password }, database.asD1());
  assert.notEqual(loggedIn.cookie, original.cookie);
  assert.equal(await sessionIdentity(sessionRequest(original.cookie!), database.asD1()), null);
  assert.equal(loggedIn.state.profile!.id, original.state.profile!.id);
  const emailKey = await hashToken('auth:login:email:traveller@example.com');
  const ipKey = await hashToken('auth:login:ip:203.0.113.9');
  assert.equal(database.sqlite.prepare('SELECT attempts FROM auth_rate_limits WHERE key_hash = ?').get(emailKey), undefined);
  assert.equal(database.sqlite.prepare('SELECT attempts FROM auth_rate_limits WHERE key_hash = ?').get(ipKey)?.attempts, 2);
  const local = await performAuthAction(request({}, 'http://localhost:5173/api/auth'), { action: 'login', email: 'traveller@example.com', password }, database.asD1());
  assert.doesNotMatch(local.cookie!, /Secure/);
});

test('expired sessions and ambiguous cookies grant no access; logout also suppresses provider fallback', async () => {
  const database = await storage();
  const local = await register(database);
  const duplicate = request({ cookie: `${local.cookie!.split(';')[0]}; ${local.cookie!.split(';')[0]}` });
  assert.equal(await sessionIdentity(duplicate, database.asD1()), null);
  database.sqlite.exec("UPDATE auth_sessions SET expires_at = '2000-01-01T00:00:00.000Z'");
  assert.equal(await sessionIdentity(sessionRequest(local.cookie!), database.asD1()), null);
  const loggedIn = await performAuthAction(request(), { action: 'login', email: 'traveller@example.com', password }, database.asD1());
  const loggedOut = await performAuthAction(sessionRequest(loggedIn.cookie!, provider()), { action: 'logout' }, database.asD1());
  assert.match(loggedOut.cookie!, /Max-Age=0/);
  assert.match(loggedOut.additionalCookies![0], /tt_signed_out=1/);
  const signedOut = request({ ...provider(), cookie: 'tt_signed_out=1' });
  assert.equal((await readAuthState(signedOut, database.asD1())).authenticated, false);
  assert.equal((await resolveIdentity(signedOut, { allowSession: false }, database.asD1())).id, 'legacy-owner');
  const resumed = await performAuthAction(signedOut, { action: 'chatgpt_login' }, database.asD1());
  assert.equal(resumed.state.authenticated, true);
  assert.match(resumed.cookie!, /tt_signed_out=;.*Max-Age=0/);
});

test('rate limits are atomic, expire after fifteen minutes and store only hashed IP/email keys', async () => {
  const database = await storage();
  for (let index = 0; index < 8; index++) await consumeAuthRateLimit(request(), 'target@example.com', database.asD1());
  const rows = database.sqlite.prepare('SELECT * FROM auth_rate_limits').all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => /^[a-f0-9]{64}$/.test(String(row.key_hash)) && row.attempts === 8));
  await assert.rejects(consumeAuthRateLimit(request(), 'target@example.com', database.asD1()), (error: unknown) => error instanceof AuthError && error.status === 429 && !!error.retryAfter);
  database.sqlite.prepare('UPDATE auth_rate_limits SET window_start = ?').run(Date.now() - 16 * 60 * 1000);
  await consumeAuthRateLimit(request(), 'target@example.com', database.asD1());
  assert.ok(database.sqlite.prepare('SELECT attempts FROM auth_rate_limits').all().every(row => row.attempts === 1));
});

test('successful own-account logins cannot reset the IP budget for credential stuffing', async () => {
  const database = await storage();
  await register(database);
  const ipKey = await hashToken('auth:login:ip:203.0.113.9');
  for (let attempt = 0; attempt < 40; attempt++) {
    const ownLogin = attempt % 7 === 6;
    const action = performAuthAction(request(), {
      action: 'login', email: ownLogin ? 'traveller@example.com' : `victim-${attempt}@example.com`, password,
    }, database.asD1());
    if (ownLogin) assert.equal((await action).state.authenticated, true);
    else await assert.rejects(action, (error: unknown) => error instanceof AuthError && error.status === 401);
    assert.equal(database.sqlite.prepare('SELECT attempts FROM auth_rate_limits WHERE key_hash = ?').get(ipKey)?.attempts, attempt + 1);
  }
  await assert.rejects(performAuthAction(request(), { action: 'login', email: 'traveller@example.com', password }, database.asD1()),
    (error: unknown) => error instanceof AuthError && error.status === 429);
  assert.equal(database.sqlite.prepare('SELECT attempts FROM auth_rate_limits WHERE key_hash = ?').get(ipKey)?.attempts, 40);
});

test('registration, login and password setup have independent IP and email budgets', async () => {
  const database = await storage();
  const local = await register(database);
  for (let attempt = 0; attempt < 8; attempt++) await consumeAuthRateLimit(request(), 'owner@example.com', database.asD1(), 'register');
  await assert.rejects(consumeAuthRateLimit(request(), 'owner@example.com', database.asD1(), 'register'),
    (error: unknown) => error instanceof AuthError && error.status === 429);
  await consumeAuthRateLimit(request(), 'owner@example.com', database.asD1(), 'login');
  await consumeAuthRateLimit(request(), 'owner@example.com', database.asD1(), 'set_password');
  const updated = await performAuthAction(sessionRequest(local.cookie!), {
    action: 'set_password', currentPassword: password, password: 'replacement password',
  }, database.asD1());
  assert.equal(updated.state.authenticated, true);
  const setupIP = await hashToken('auth:set_password:ip:203.0.113.9');
  const setupEmail = await hashToken('auth:set_password:email:traveller@example.com');
  assert.equal(database.sqlite.prepare('SELECT attempts FROM auth_rate_limits WHERE key_hash = ?').get(setupIP)?.attempts, 2);
  assert.equal(database.sqlite.prepare('SELECT attempts FROM auth_rate_limits WHERE key_hash = ?').get(setupEmail), undefined);
  const registrationIP = await hashToken('auth:register:ip:203.0.113.9');
  assert.equal(database.sqlite.prepare('SELECT attempts FROM auth_rate_limits WHERE key_hash = ?').get(registrationIP)?.attempts, 10);
});

test('successful registrations keep the registration IP cap without exhausting login', async () => {
  const database = await storage();
  const ipKey = await hashToken('auth:register:ip:203.0.113.9');
  for (let index = 0; index < 24; index++) {
    await register(database, `traveller-${index}@example.com`);
    assert.equal(database.sqlite.prepare('SELECT attempts FROM auth_rate_limits WHERE key_hash = ?').get(ipKey)?.attempts, index + 1);
  }
  await assert.rejects(register(database, 'one-too-many@example.com'), (error: unknown) => error instanceof AuthError && error.status === 429);
  const loggedIn = await performAuthAction(request(), { action: 'login', email: 'traveller-0@example.com', password }, database.asD1());
  assert.equal(loggedIn.state.authenticated, true);
});

test('auth cleanup is bounded and preserves active sessions, live rate windows and all accounts', async () => {
  const database = await storage();
  await readAuthState(request(provider()), database.asD1());
  const now = Date.now();
  const insertSession = database.sqlite.prepare('INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)');
  const insertRate = database.sqlite.prepare('INSERT INTO auth_rate_limits (key_hash, window_start, attempts) VALUES (?, ?, ?)');
  for (let index = 0; index < 150; index++) {
    insertSession.run(`expired-${index}`, 'legacy-owner', new Date(now - 1).toISOString(), new Date(now - 1000).toISOString());
    insertRate.run(`old-${index}`, now - 16 * 60 * 1000, 8);
  }
  insertSession.run('live-session', 'legacy-owner', new Date(now + 1000).toISOString(), new Date(now).toISOString());
  insertRate.run('live-window', now, 8);
  await cleanupExpiredAuthData(database.asD1(), now);
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM auth_sessions').get()?.count, 51);
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM auth_rate_limits').get()?.count, 51);
  await cleanupExpiredAuthData(database.asD1(), now);
  assert.deepEqual(database.sqlite.prepare('SELECT token_hash FROM auth_sessions').all().map(row => row.token_hash), ['live-session']);
  assert.deepEqual(database.sqlite.prepare('SELECT key_hash FROM auth_rate_limits').all().map(row => row.key_hash), ['live-window']);
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM profiles').get()?.count, 1);
});

test('legacy users can add a password without changing any data owner or receipt path', async () => {
  const database = await storage();
  const initial = await readAuthState(request(provider()), database.asD1());
  database.sqlite.prepare('INSERT INTO trips (id, owner, data) VALUES (?, ?, ?)').run('holiday', 'legacy-owner', '{}');
  database.sqlite.prepare('INSERT INTO receipts (id, owner, trip_id) VALUES (?, ?, ?)').run('receipt', 'legacy-owner', 'holiday');
  const upgraded = await performAuthAction(request(provider()), { action: 'set_password', password }, database.asD1());
  assert.equal(upgraded.state.profile!.id, initial.profile!.id);
  assert.equal(upgraded.state.hasPassword, true);
  assert.equal(upgraded.state.chatgptLinked, true);
  assert.equal(database.sqlite.prepare('SELECT owner FROM receipts').get()?.owner, 'legacy-owner');
  const nativeLogin = await performAuthAction(request(), { action: 'login', email: 'owner@example.com', password }, database.asD1());
  assert.equal(nativeLogin.state.profile!.id, 'legacy-owner');
  const unlinked = await performAuthAction(sessionRequest(nativeLogin.cookie!, provider()), { action: 'unlink_chatgpt' }, database.asD1());
  assert.equal(unlinked.state.chatgptLinked, false);
  await assert.rejects(resolveIdentity(request(provider()), { allowSession: false }, database.asD1()), /UNAUTHORIZED/);
  assert.equal((await resolveIdentity(sessionRequest(nativeLogin.cookie!), {}, database.asD1())).id, 'legacy-owner');
  await performAuthAction(sessionRequest(nativeLogin.cookie!, provider()), { action: 'link_chatgpt' }, database.asD1());
  assert.equal((await resolveIdentity(request(provider()), { allowSession: false }, database.asD1())).id, 'legacy-owner');
});

test('an unverified email collision cannot claim or replace a legacy provider account', async () => {
  const database = await storage();
  const claimant = await register(database, 'owner@example.com');
  await readAuthState(request(provider()), database.asD1());
  database.sqlite.prepare('INSERT INTO trips (id, owner, data) VALUES (?, ?, ?)').run('legacy-trip', 'legacy-owner', '{}');
  database.sqlite.prepare('INSERT INTO receipts (id, owner, trip_id) VALUES (?, ?, ?)').run('legacy-receipt', 'legacy-owner', 'legacy-trip');
  await assert.rejects(performAuthAction(request(provider()), { action: 'set_password', password }, database.asD1()),
    (error: unknown) => error instanceof AuthError && error.status === 409);
  assert.equal(database.sqlite.prepare('SELECT user_id FROM auth_credentials WHERE email = ?').get('owner@example.com')?.user_id, claimant.state.profile!.id);
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM auth_links').get()?.count, 0);
  assert.equal(database.sqlite.prepare('SELECT owner FROM trips WHERE id = ?').get('legacy-trip')?.owner, 'legacy-owner');
  assert.equal(database.sqlite.prepare('SELECT owner FROM receipts WHERE id = ?').get('legacy-receipt')?.owner, 'legacy-owner');
  assert.equal((await resolveIdentity(request(provider()), { allowSession: false }, database.asD1())).id, 'legacy-owner');
});

test('provider linking requires both identities, rejects legacy data and preserves canonical local email', async () => {
  const database = await storage();
  const local = await register(database);
  await assert.rejects(performAuthAction(request(provider()), { action: 'link_chatgpt' }, database.asD1()), /password and ChatGPT/);
  await assert.rejects(performAuthAction(sessionRequest(local.cookie!), { action: 'link_chatgpt' }, database.asD1()), /password and ChatGPT/);
  await readAuthState(request(provider()), database.asD1());
  database.sqlite.prepare('INSERT INTO trips (id, owner, data) VALUES (?, ?, ?)').run('existing-trip', 'legacy-owner', '{}');
  await assert.rejects(performAuthAction(sessionRequest(local.cookie!, provider()), { action: 'link_chatgpt' }, database.asD1()), /already has TripTab data/);
  database.sqlite.prepare('DELETE FROM trips').run();
  const linked = await performAuthAction(sessionRequest(local.cookie!, provider()), { action: 'link_chatgpt' }, database.asD1());
  assert.equal(linked.state.chatgptLinked, true);
  assert.equal(linked.state.profile!.email, 'traveller@example.com');
  const canonical = await resolveIdentity(request(provider()), { allowSession: false }, database.asD1());
  assert.equal(canonical.id, local.state.profile!.id);
  assert.equal(canonical.email, 'traveller@example.com');
  assert.equal((await readAuthState(request(provider()), database.asD1())).emailVerified, false);
  const second = await register(database, 'other@example.com');
  await assert.rejects(performAuthAction(sessionRequest(second.cookie!, provider()), { action: 'link_chatgpt' }, database.asD1()), /already linked to another/);
});

test('browser sessions take precedence, while MCP ignores cookies and signed-out marker', async () => {
  const database = await storage();
  const local = await register(database);
  const mixed = sessionRequest(local.cookie!, provider());
  assert.equal((await resolveIdentity(mixed, {}, database.asD1())).id, local.state.profile!.id);
  assert.equal((await resolveIdentity(mixed, { allowSession: false }, database.asD1())).id, 'legacy-owner');
  assert.equal((await readAuthState(mixed, database.asD1(), { allowSession: false })).profile!.authMethod, 'chatgpt');
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM auth_links').get()?.count, 0);
  await assert.rejects(resolveIdentity(sessionRequest(local.cookie!), { allowSession: false }, database.asD1()), /UNAUTHORIZED/);
});

test('a concurrent provider link prevents stale password setup without touching either account', async () => {
  const database = await storage();
  const local = await register(database);
  await readAuthState(request(provider()), database.asD1());
  const batch = database.batch.bind(database);
  database.batch = async statements => {
    if (statements.length === 3) {
      database.sqlite.prepare('INSERT INTO auth_links (oai_user_id, user_id, created_at) VALUES (?, ?, ?)')
        .run('legacy-owner', local.state.profile!.id, new Date().toISOString());
    }
    return batch(statements);
  };
  await assert.rejects(performAuthAction(request(provider()), { action: 'set_password', password }, database.asD1()), (error: unknown) => error instanceof AuthError && error.status === 409);
  assert.equal(database.sqlite.prepare('SELECT 1 FROM auth_credentials WHERE user_id = ?').get('legacy-owner'), undefined);
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM auth_sessions').get()?.count, 1);
  assert.equal((await resolveIdentity(request(provider()), { allowSession: false }, database.asD1())).id, local.state.profile!.id);
});

test('legacy profile emails are verified only when matching the current trusted provider email', async () => {
  const database = await storage();
  assert.equal((await readAuthState(request(provider()), database.asD1())).emailVerified, true);
  const changed = await readAuthState(request(provider('legacy-owner', 'new-address@example.com')), database.asD1());
  assert.equal(changed.profile!.email, 'owner@example.com');
  assert.equal(changed.emailVerified, false);
});

test('adding or changing passwords requires identity proof and current password when already configured', async () => {
  const database = await storage();
  await assert.rejects(performAuthAction(request(), { action: 'set_password', password, email: 'other@example.com' }, database.asD1()), /UNAUTHORIZED/);
  const local = await register(database);
  const otherSession = await performAuthAction(request(), { action: 'login', email: 'traveller@example.com', password }, database.asD1());
  await assert.rejects(performAuthAction(sessionRequest(local.cookie!), { action: 'set_password', password: 'different password' }, database.asD1()), /current password/);
  const changed = await performAuthAction(sessionRequest(local.cookie!), { action: 'set_password', currentPassword: password, password: 'different password' }, database.asD1());
  assert.equal(await sessionIdentity(sessionRequest(local.cookie!), database.asD1()), null);
  assert.equal(await sessionIdentity(sessionRequest(otherSession.cookie!), database.asD1()), null);
  assert.equal((await sessionIdentity(sessionRequest(changed.cookie!), database.asD1()))!.id, local.state.profile!.id);
  await assert.rejects(performAuthAction(request(), { action: 'login', email: 'traveller@example.com', password }, database.asD1()), /email or password/);
  const loggedIn = await performAuthAction(request(), { action: 'login', email: 'traveller@example.com', password: 'different password' }, database.asD1());
  assert.equal(loggedIn.state.profile!.id, local.state.profile!.id);
});

test('HTTP auth endpoint enforces same origin, JSON, body bounds and private responses', async () => {
  const database = await storage();
  class RequestError extends Error { constructor(message: string, public status = 400) { super(message); } }
  const store = {
    db: () => database.asD1(), RequestError,
    async readBoundedBody(value: Request, max: number) {
      const bytes = new Uint8Array(await value.arrayBuffer());
      if (bytes.length > max) throw new RequestError('Too large.', 413);
      return bytes;
    },
  };
  Object.defineProperty(globalThis, Symbol.for('triptab.auth-test-store'), { value: store, configurable: true });
  const storeURL = 'data:text/javascript;base64,' + Buffer.from(`const store=globalThis[Symbol.for('triptab.auth-test-store')];${Object.keys(store).map(key => `export const ${key}=store.${key};`).join('\n')}`).toString('base64');
  const source = await readFile(new URL('../app/api/auth/route.ts', import.meta.url), 'utf8');
  const notificationsURL = 'data:text/javascript;base64,' + Buffer.from("export const browserPushCookie=async()=> 'tt_push=; Path=/; HttpOnly; Max-Age=0'; export const revokeBrowserPush=async()=>{};").toString('base64');
  const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText
    .replace("'@/lib/auth'", JSON.stringify(new URL('../lib/auth.ts', import.meta.url).href))
    .replace("'@/lib/notifications'", JSON.stringify(notificationsURL))
    .replace("'@/lib/store'", JSON.stringify(storeURL));
  const route = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64')) as { POST(value: Request): Promise<Response>; GET(value: Request): Promise<Response> };
  function post(origin: string, body: string, contentType = 'application/json') {
    return new Request('https://triptab.test/api/auth', { method: 'POST', headers: { origin, 'content-type': contentType }, body });
  }
  assert.equal((await route.POST(post('https://evil.test', '{}'))).status, 403);
  assert.equal((await route.POST(post('https://triptab.test', '{}', 'text/plain'))).status, 415);
  assert.equal((await route.POST(post('https://triptab.test', '{}', 'application/json-untrusted'))).status, 415);
  assert.equal((await route.POST(post('https://triptab.test', 'x'.repeat(4097)))).status, 413);
  const response = await route.POST(post('https://triptab.test', JSON.stringify({ action: 'register', email: 'native@example.com', password, displayName: 'Native' })));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.getSetCookie().length, 2);
  assert.equal((await response.json() as { chatgptLinked: boolean }).chatgptLinked, false);
  const anonymous = await route.GET(request());
  assert.equal((await anonymous.json() as { authenticated: boolean }).authenticated, false);
});
