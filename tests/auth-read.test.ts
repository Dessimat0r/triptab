import { transpileWithSharedImports } from './helpers/transpile';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Log, LogLevel, Miniflare } from 'miniflare';
import { ModuleKind, ScriptTarget } from 'typescript';
import { unstable_splitSqlQuery } from 'wrangler';
import { hashToken, readAuthState, sessionIdentity } from '../lib/auth';

class SQLiteStatement {
  values: (string | number | null)[] = [];
  constructor(readonly database: SQLiteD1, readonly sql: string) {}
  bind(...values: (string | number | null)[]) { this.values = values; return this; }
  async first<T>() { await this.database.read(this.sql, this.values); return (this.database.sqlite.prepare(this.sql).get(...this.values) ?? null) as T | null; }
  async all<T>() { await this.database.read(this.sql, this.values); return { results: this.database.sqlite.prepare(this.sql).all(...this.values) as T[] }; }
  runSync() {
    const statement = this.database.sqlite.prepare(this.sql);
    const results = statement.columns().length ? statement.all(...this.values) : (statement.run(...this.values), []);
    return { results, success: true, meta: { changes: Number(this.database.sqlite.prepare('SELECT changes() AS changes').get()?.changes ?? 0) } };
  }
  async run() { await this.database.read(this.sql, this.values); return this.runSync(); }
}
class SQLiteD1 {
  readonly sqlite = new DatabaseSync(':memory:');
  readonly calls: { kind: 'read' | 'batch'; sql: string[]; values: (string | number | null)[][] }[] = [];
  beforeRead?: (sql: string) => void;
  beforeBatch?: (statements: SQLiteStatement[]) => void;
  latency = 0;
  private pending = Promise.resolve();
  prepare(sql: string) { return new SQLiteStatement(this, sql); }
  async read(sql: string, values: (string | number | null)[]) {
    this.calls.push({ kind: 'read', sql: [sql], values: [[...values]] });
    if (this.latency) await new Promise(resolve => setTimeout(resolve, this.latency));
    this.beforeRead?.(sql);
  }
  batch(statements: SQLiteStatement[]) {
    const operation = this.pending.then(async () => {
      this.calls.push({ kind: 'batch', sql: statements.map(statement => statement.sql), values: statements.map(statement => [...statement.values]) });
      if (this.latency) await new Promise(resolve => setTimeout(resolve, this.latency));
      this.beforeBatch?.(statements);
      this.sqlite.exec('BEGIN');
      try { const results = statements.map(statement => statement.runSync()); this.sqlite.exec('COMMIT'); return results; }
      catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
    });
    this.pending = operation.then(() => {}, () => {});
    return operation;
  }
  asD1() { return this as unknown as D1Database; }
}
const binding: { DB?: D1Database } = {};
Object.defineProperty(globalThis, Symbol.for('triptab.auth-read-test'), { value: binding, configurable: true });
const dataUrl = (value: string) => 'data:text/javascript;base64,' + Buffer.from(value).toString('base64');
const envUrl = dataUrl("export const env=globalThis[Symbol.for('triptab.auth-read-test')];export const waitUntil=()=>{};");
const notificationsUrl = dataUrl('export const notifyMembers=async()=>{};export const activityNotification=()=>null;');
const compile = (value: string) => transpileWithSharedImports(value, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText;
let source = compile(await readFile(new URL('../lib/store.ts', import.meta.url), 'utf8'))
  .replace("'cloudflare:workers'", JSON.stringify(envUrl)).replace("'zod'", JSON.stringify(import.meta.resolve('zod')))
  .replace("'./notifications'", JSON.stringify(notificationsUrl));
for (const name of ['model', 'auth', 'activity-scope', 'receipt-lifecycle', 'audit', 'receipt-context', 'receipt-memory-ownership']) {
  source = source.replaceAll(`'./${name}'`, JSON.stringify(new URL(`../lib/${name}.ts`, import.meta.url).href));
}
const store = await import(dataUrl(source)) as typeof import('../lib/store');
const token = 'a'.repeat(43);
const tokenB = 'b'.repeat(43);
const providerHeaders = (id: string, email?: string) => ({ 'oai-authenticated-user-id': id, ...(email ? { 'oai-authenticated-user-email': email } : {}) });
const request = (headers: Record<string, string> = {}) => new Request('https://triptab.test/api/profile', { headers });
async function storage() {
  const database = new SQLiteD1();
  for (const name of (await readdir(new URL('../drizzle/', import.meta.url))).filter(name => name.endsWith('.sql')).sort()) database.sqlite.exec(await readFile(new URL('../drizzle/' + name, import.meta.url), 'utf8'));
  for (const [id, email, name] of [['local-a', 'a@example.com', 'Saved A'], ['local-b', 'b@example.com', 'Saved B'], ['legacy', 'legacy@example.com', 'Saved Legacy']]) {
    database.sqlite.prepare('INSERT INTO profiles(id,email,display_name,created_at) VALUES(?,?,?,?)').run(id, email, name, '2026-10-04T12:00:00Z');
  }
  for (const [id, email] of [['local-a', 'a@example.com'], ['local-b', 'b@example.com']]) database.sqlite.prepare('INSERT INTO auth_credentials(user_id,email,password_hash,password_salt,iterations,created_at) VALUES(?,?,?,?,?,?)').run(id, email, '0'.repeat(64), 'x'.repeat(43), 100_000, '2026-10-04T12:00:00Z');
  for (const [id, value] of [['local-a', token], ['local-b', tokenB]]) database.sqlite.prepare('INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(await hashToken(value), id, '2099-01-01T00:00:00Z', '2026-10-04T12:00:00Z');
  database.sqlite.prepare('INSERT INTO auth_links(oai_user_id,user_id,created_at) VALUES(?,?,?)').run('linked-provider', 'local-a', '2026-10-04T12:00:00Z');
  binding.DB = database.asD1();
  return database;
}

test('established authenticated profiles have bounded D1 round trips', async context => {
  const cases = [
    ['session', request({ cookie: 'tt_session=' + token }), 'local-a'],
    ['linked-provider', request(providerHeaders('linked-provider', 'a@example.com')), 'local-a'],
    ['legacy-provider', request(providerHeaders('legacy', 'legacy@example.com')), 'legacy'],
  ] as const;
  for (const [label, input, id] of cases) await context.test(label, async () => {
    const database = await storage(); database.latency = 20;
    const profile = await store.ensureProfile(input);
    assert.equal(profile.id, id);
    const statements = database.calls.reduce((total, call) => total + call.sql.length, 0);
    context.diagnostic(`${label}: ${database.calls.length} D1 round trips, ${statements} statements, ${database.calls.length * database.latency}ms simulated transport floor`);
    assert.equal(database.calls.length, 1);
    assert.equal(statements, 1);
    assert.ok(database.calls.every(call => call.kind === 'read' && /^SELECT/.test(call.sql[0].trim())), 'established profile reads never attempt writes');
    assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM account_activity_events').get()!.count, 0);
  });
});

test('auth status reads the canonical profile and flags in one read-only indexed snapshot', async () => {
  const database = await storage();
  for (let index = 0; index < 1000; index++) {
    database.sqlite.prepare('INSERT INTO profiles(id,email,display_name,created_at) VALUES(?,?,?,?)').run('noise-' + index, 'noise-' + index + '@example.com', 'Unrelated', '2026-10-04T12:00:00Z');
    database.sqlite.prepare('INSERT INTO auth_links(oai_user_id,user_id,created_at) VALUES(?,?,?)').run('noise-provider-' + index, 'noise-' + index, '2026-10-04T12:00:00Z');
  }
  for (const input of [request({ cookie: 'tt_session=' + token }), request(providerHeaders('linked-provider', 'a@example.com')), request(providerHeaders('legacy', 'legacy@example.com'))]) {
    database.calls.length = 0;
    const state = await readAuthState(input, database.asD1());
    assert.equal(state.authenticated, true); assert.equal(database.calls.length, 1);
    assert.ok(database.calls.every(call => call.kind === 'read'));
    const read = database.calls[0];
    const plan = database.sqlite.prepare('EXPLAIN QUERY PLAN ' + read.sql[0]).all(...read.values[0]).map(row => String(row.detail));
    assert.ok(!plan.some(detail => /SCAN (?:p|l|c|s|linked)\b/.test(detail)), plan.join('; '));
    assert.ok(plan.some(detail => /auth_links_user_idx/.test(detail)));
  }
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM account_activity_events').get()!.count, 0);
});

test('session identity authorization reads only its session and profile without account flags', async () => {
  const database = await storage();
  assert.deepEqual(await sessionIdentity(request({ cookie: 'tt_session=' + token }), database.asD1()), {
    id: 'local-a', email: 'a@example.com', displayName: 'Saved A', kind: 'session',
  });
  assert.equal(database.calls.length, 1);
  assert.equal(database.calls[0].kind, 'read');
  assert.doesNotMatch(database.calls[0].sql[0], /auth_credentials|auth_links|account_activity_events/);
  assert.equal(await sessionIdentity(request({ cookie: 'tt_session=' + token + '; tt_session=' + tokenB }), database.asD1()), null);
  assert.equal(database.calls.length, 1, 'ambiguous session cookies are rejected before database access');
});

test('fast auth preserves session precedence, signed-out suppression and provider-only cookie bypass', async () => {
  const database = await storage();
  const mixed = request({ cookie: 'tt_session=' + token + '; tt_signed_out=1', ...providerHeaders('legacy', 'legacy@example.com') });
  const session = await store.ensureProfile(mixed);
  assert.equal(session.id, 'local-a'); assert.equal(session.authMethod, 'password'); assert.equal(session.emailVerified, false);
  assert.equal(session.chatgptAvailable, true);
  const provider = await store.ensureProfile(mixed, { allowSession: false });
  assert.equal(provider.id, 'legacy'); assert.equal(provider.authMethod, 'chatgpt'); assert.equal(provider.emailVerified, true);
  assert.equal((await readAuthState(request({ cookie: 'tt_signed_out=1', ...providerHeaders('legacy', 'legacy@example.com') }), database.asD1())).authenticated, false);
  const duplicate = request({ cookie: 'tt_session=' + token + '; tt_session=' + tokenB, ...providerHeaders('legacy', 'legacy@example.com') });
  assert.equal((await store.ensureProfile(duplicate)).id, 'legacy');
});

test('stored canonical values and exact trusted email comparison remain authoritative without caching', async () => {
  const database = await storage();
  const mismatched = request({ ...providerHeaders('linked-provider', 'self-supplied@example.com'), 'oai-authenticated-user-full-name': 'Forged%20name' });
  let profile = await store.ensureProfile(mismatched);
  assert.equal(profile.email, 'a@example.com'); assert.equal(profile.displayName, 'Saved A'); assert.equal(profile.emailVerified, false);
  profile = await store.ensureProfile(request(providerHeaders('linked-provider', 'a@example.com')));
  assert.equal(profile.emailVerified, true);
  const missing = request(providerHeaders('legacy'));
  assert.equal((await readAuthState(missing, database.asD1())).authenticated, true, 'auth status can report an existing provider profile without email');
  await assert.rejects(store.ensureProfile(missing), /UNAUTHORIZED/, 'the application profile boundary still requires identity email');
  assert.equal((await store.ensureProfile(request(providerHeaders('linked-provider')))).emailVerified, false, 'a canonical link supplies stored email but does not verify missing provider email');
  database.sqlite.prepare('UPDATE profiles SET display_name=? WHERE id=?').run('Changed A', 'local-a');
  assert.equal((await store.ensureProfile(request({ cookie: 'tt_session=' + token }))).displayName, 'Changed A');
  assert.equal((await store.ensureProfile(request({ cookie: 'tt_session=' + tokenB }))).id, 'local-b');
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM account_activity_events').get()!.count, 0);
});

test('session deletion or expiry before the coherent snapshot selects matching identity and profile', async context => {
  for (const variant of ['delete-no-provider', 'expire-no-provider', 'delete-other-provider', 'delete-same-provider']) await context.test(variant, async () => {
    const database = await storage(); let reads = 0;
    database.beforeRead = sql => {
      if (!sql.includes('LEFT JOIN auth_sessions s') || ++reads !== 1) return;
      database.beforeRead = undefined;
      if (variant.startsWith('expire')) database.sqlite.prepare('UPDATE auth_sessions SET expires_at=? WHERE token_hash=?').run('2000-01-01T00:00:00Z', database.sqlite.prepare('SELECT token_hash FROM auth_sessions WHERE user_id=?').get('local-a')!.token_hash as string);
      else database.sqlite.prepare('DELETE FROM auth_sessions WHERE user_id=?').run('local-a');
    };
    const headers = variant.endsWith('other-provider') ? providerHeaders('legacy', 'legacy@example.com') : variant.endsWith('same-provider') ? providerHeaders('linked-provider', 'a@example.com') : {};
    const action = store.ensureProfile(request({ cookie: 'tt_session=' + token, ...headers }));
    if (variant.endsWith('same-provider')) assert.equal((await action).id, 'local-a', 'a still-authorized same account fallback preserves prior behavior');
    else if (variant.endsWith('other-provider')) { const current = await action; assert.equal(current.id, 'legacy'); assert.equal(current.authMethod, 'chatgpt'); }
    else await assert.rejects(action, /UNAUTHORIZED/);
    assert.equal(reads, 1); assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM account_activity_events').get()!.count, 0);
  });
});

test('a same-account session gaining precedence before the snapshot does not inherit verified provider email', async () => {
  const database = await storage(); let sessionReads = 0;
  const freshToken = 'c'.repeat(43); const freshHash = await hashToken(freshToken);
  database.beforeRead = sql => {
    if (!sql.includes('LEFT JOIN auth_sessions s') || ++sessionReads !== 1) return;
    database.beforeRead = undefined;
    database.sqlite.prepare('INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
      .run(freshHash, 'local-a', '2099-01-01T00:00:00Z', '2026-10-04T12:00:00Z');
  };
  const profile = await store.ensureProfile(request({ cookie: 'tt_session=' + freshToken, ...providerHeaders('linked-provider', 'a@example.com') }));
  assert.equal(sessionReads, 1); assert.equal(profile.id, 'local-a'); assert.equal(profile.authMethod, 'password');
  assert.equal(profile.emailVerified, false);
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM account_activity_events').get()!.count, 0);
});

test('provider creation guards canonical links, disconnected credentials and newly valid session precedence', async context => {
  for (const variant of ['link', 'credential', 'session']) await context.test(variant, async () => {
    const database = await storage(); const fresh = 'fresh-provider';
    const sessionHash = await hashToken('c'.repeat(43));
    database.beforeBatch = statements => {
      if (!statements.some(statement => statement.sql.trim().startsWith('INSERT INTO profiles'))) return;
      database.beforeBatch = undefined;
      if (variant === 'link') database.sqlite.prepare('INSERT INTO auth_links(oai_user_id,user_id,created_at) VALUES(?,?,?)').run(fresh, 'local-a', '2026-10-04T12:00:00Z');
      if (variant === 'credential') {
        // Orphan legacy credentials still block fallback; never trust a profile
        // join alone to decide whether provider authentication is disconnected.
        database.sqlite.exec('PRAGMA foreign_keys=OFF');
        database.sqlite.prepare('INSERT INTO auth_credentials(user_id,email,password_hash,password_salt,iterations,created_at) VALUES(?,?,?,?,?,?)').run(fresh, 'fresh@example.com', '0'.repeat(64), 'x'.repeat(43), 100_000, '2026-10-04T12:00:00Z');
        database.sqlite.exec('PRAGMA foreign_keys=ON');
      }
      if (variant === 'session') database.sqlite.prepare('INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(sessionHash, 'local-a', '2099-01-01T00:00:00Z', '2026-10-04T12:00:00Z');
    };
    await assert.rejects(store.ensureProfile(request({ cookie: 'tt_session=' + 'c'.repeat(43), ...providerHeaders(fresh, 'fresh@example.com') })), /UNAUTHORIZED/);
    assert.equal(database.sqlite.prepare('SELECT id FROM profiles WHERE id=?').get(fresh), undefined);
    assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM account_activity_events').get()!.count, 0);
  });
});

test('provider creation is once-only and profile/audit rollback remains atomic', async () => {
  const database = await storage(); const input = request(providerHeaders('fresh-provider', 'fresh@example.com'));
  const profiles = await Promise.all([store.ensureProfile(input), store.ensureProfile(input)]);
  assert.ok(profiles.every(profile => profile.id === 'fresh-provider'));
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM account_activity_events').get()!.count, 1);
  const event = database.sqlite.prepare('SELECT before_data,after_data,source FROM account_activity_events').get()!;
  assert.equal(event.before_data, null); assert.equal(event.after_data, '{"displayName":"fresh"}'); assert.equal(event.source, 'chatgpt');
  database.sqlite.exec("CREATE TRIGGER reject_new_private_event BEFORE INSERT ON account_activity_events BEGIN SELECT RAISE(ABORT,'private event unavailable'); END");
  await assert.rejects(store.ensureProfile(request(providerHeaders('another-provider', 'another@example.com'))), /private event unavailable/);
  assert.equal(database.sqlite.prepare('SELECT id FROM profiles WHERE id=?').get('another-provider'), undefined);
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM account_activity_events').get()!.count, 1);
});

test('application profile creation retains its email-name fallback without widening auth creation validation', async () => {
  const database = await storage(); const localPart = 'n'.repeat(90);
  const input = request(providerHeaders('long-email-provider', localPart + '@example.com'));
  await assert.rejects(readAuthState(input, database.asD1()), /display name must be between 1 and 50/);
  assert.equal(database.sqlite.prepare('SELECT id FROM profiles WHERE id=?').get('long-email-provider'), undefined);
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM account_activity_events').get()!.count, 0);
  assert.equal((await store.ensureProfile(input)).displayName, localPart.slice(0, 80));
  assert.equal((await readAuthState(input, database.asD1())).profile?.displayName, localPart.slice(0, 80));
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM account_activity_events').get()!.count, 1);
});

test('native D1 accepts joined auth reads and keeps guarded provider creation and its audit atomic', async () => {
  const worker = new Miniflare({
    modules: true, script: 'export default { fetch() { return new Response("Auth read test"); } };',
    compatibilityDate: '2026-05-15', d1Databases: { DB: 'auth-read-native' }, d1Persist: false,
    log: new Log(LogLevel.NONE),
  });
  try {
    const database = await worker.getD1Database('DB');
    for (const file of (await readdir(new URL('../drizzle/', import.meta.url))).filter(file => file.endsWith('.sql')).sort()) {
      const statements = unstable_splitSqlQuery(await readFile(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
      await database.batch(statements.map(statement => database.prepare(statement)));
    }
    binding.DB = database as unknown as D1Database;
    const fresh = request(providerHeaders('native-provider', 'native@example.com'));
    assert.equal((await store.ensureProfile(fresh)).id, 'native-provider');
    assert.equal((await store.ensureProfile(fresh)).displayName, 'native');
    assert.equal(await database.prepare('SELECT COUNT(*) AS count FROM account_activity_events').first('count'), 1);
    await database.batch([
      database.prepare('INSERT INTO auth_credentials(user_id,email,password_hash,password_salt,iterations,created_at) VALUES(?,?,?,?,?,?)')
        .bind('native-provider', 'native@example.com', '0'.repeat(64), 'x'.repeat(43), 100_000, '2026-10-04T12:00:00Z'),
      database.prepare('INSERT INTO auth_links(oai_user_id,user_id,created_at) VALUES(?,?,?)')
        .bind('native-linked-provider', 'native-provider', '2026-10-04T12:00:00Z'),
      database.prepare('INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
        .bind(await hashToken(token), 'native-provider', '2099-01-01T00:00:00Z', '2026-10-04T12:00:00Z'),
    ]);
    const linked = await store.ensureProfile(request(providerHeaders('native-linked-provider', 'native@example.com')));
    assert.equal(linked.id, 'native-provider'); assert.equal(linked.hasPassword, true); assert.equal(linked.chatgptConnected, true);
    const session = await store.ensureProfile(request({ cookie: 'tt_session=' + token }));
    assert.equal(session.id, 'native-provider'); assert.equal(session.authMethod, 'password'); assert.equal(session.emailVerified, false);
    await database.prepare("CREATE TRIGGER reject_private_event BEFORE INSERT ON account_activity_events BEGIN SELECT RAISE(ABORT,'private event unavailable'); END").run();
    await assert.rejects(store.ensureProfile(request(providerHeaders('native-other-provider', 'other@example.com'))), /private event unavailable/);
    assert.equal(await database.prepare('SELECT id FROM profiles WHERE id=?').bind('native-other-provider').first(), null);
    assert.equal(await database.prepare('SELECT COUNT(*) AS count FROM account_activity_events').first('count'), 1);
  } finally {
    delete binding.DB;
    await worker.dispose();
  }
});

test('stale and expired cookie provider fallbacks use one coherent indexed auth snapshot', async () => {
  for (const value of ['c'.repeat(43), token]) {
    const database = await storage();
    database.sqlite.prepare('UPDATE auth_sessions SET expires_at=? WHERE user_id=?').run('2000-01-01T00:00:00Z', 'local-a');
    const profile = await store.ensureProfile(request({ cookie: `tt_session=${value}`, ...providerHeaders('legacy', 'legacy@example.com') }));
    assert.equal(profile.id, 'legacy'); assert.equal(profile.authMethod, 'chatgpt');
    assert.equal(database.calls.length, 1); assert.equal(database.calls[0].kind, 'read');
  }
});

test('a provider link or session winning before the atomic snapshot cannot expose a stale canonical profile', async () => {
  const database = await storage();
  database.beforeRead = () => {
    database.beforeRead = undefined;
    database.sqlite.prepare('UPDATE auth_links SET user_id=? WHERE oai_user_id=?').run('local-b', 'linked-provider');
  };
  const profile = await store.ensureProfile(request({ cookie: 'tt_session=' + 'c'.repeat(43), ...providerHeaders('linked-provider', 'a@example.com') }));
  assert.equal(profile.id, 'local-b'); assert.equal(profile.email, 'b@example.com'); assert.equal(profile.emailVerified, false);
  assert.equal(database.calls.length, 1);
  database.sqlite.prepare('DELETE FROM auth_links WHERE oai_user_id=?').run('linked-provider');
  database.sqlite.prepare('INSERT INTO profiles(id,email,display_name,created_at) VALUES(?,?,?,?)').run('linked-provider', 'disconnected@example.test', 'Disconnected', '2026-10-04T12:00:00Z');
  database.sqlite.prepare('INSERT INTO auth_credentials(user_id,email,password_hash,password_salt,iterations,created_at) VALUES(?,?,?,?,?,?)')
    .run('linked-provider', 'disconnected@example.test', '0'.repeat(64), 'x'.repeat(43), 100_000, '2026-10-04T12:00:00Z');
  await assert.rejects(store.ensureProfile(request(providerHeaders('linked-provider', 'a@example.com'))), /UNAUTHORIZED/);
});

test('resolveIdentity shares the single coherent snapshot and falls back when a session has no profile', async () => {
  const { resolveIdentity } = await import('../lib/auth');
  const database = await storage();
  const withSession = request({ cookie: 'tt_session=' + token, ...providerHeaders('linked-provider', 'a@example.com') });
  database.calls.length = 0;
  const session = await resolveIdentity(withSession, {}, database.asD1());
  assert.equal(session.kind, 'session'); assert.equal(session.id, 'local-a');
  assert.equal(database.calls.length, 1, 'session precedence, link and profile resolve in one read');
  database.calls.length = 0;
  const provider = await resolveIdentity(withSession, { allowSession: false }, database.asD1());
  assert.equal(provider.kind, 'chatgpt'); assert.equal(provider.id, 'local-a'); assert.equal(database.calls.length, 1);
  assert.equal((await resolveIdentity(request({ cookie: 'tt_session=' + token + '; tt_signed_out=1' }), {}, database.asD1())).kind, 'session', 'a live session outranks the signed-out marker');
  await assert.rejects(resolveIdentity(request({ cookie: 'tt_signed_out=1', ...providerHeaders('linked-provider', 'a@example.com') }), {}, database.asD1()), /UNAUTHORIZED/);
  // A live session whose profile row is missing (FK cascade normally prevents it)
  // must not mask a valid provider identity or authenticate as nobody.
  database.sqlite.exec('PRAGMA foreign_keys=OFF');
  database.sqlite.prepare('DELETE FROM profiles WHERE id=?').run('local-b');
  database.sqlite.exec('PRAGMA foreign_keys=ON');
  const orphan = request({ cookie: 'tt_session=' + tokenB, ...providerHeaders('legacy', 'legacy@example.com') });
  const fallback = await resolveIdentity(orphan, {}, database.asD1());
  assert.equal(fallback.id, 'legacy'); assert.equal(fallback.kind, 'chatgpt');
  await assert.rejects(resolveIdentity(request({ cookie: 'tt_session=' + tokenB }), {}, database.asD1()), /UNAUTHORIZED/);
});
