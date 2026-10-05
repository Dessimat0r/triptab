import { transpileWithSharedImports } from './helpers/transpile';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ModuleKind, ScriptTarget } from 'typescript';
import { readAccountActivity } from '../lib/audit';

class SQLiteStatement {
  private values: (string | number | null)[] = [];
  constructor(private readonly sqlite: DatabaseSync, readonly sql: string) {}
  bind(...values: (string | number | null)[]) { this.values = values; return this; }
  async first<T>() { return (this.sqlite.prepare(this.sql).get(...this.values) || null) as T | null; }
  async all<T>() { return { results: this.sqlite.prepare(this.sql).all(...this.values) as T[] }; }
  runSync() {
    const statement = this.sqlite.prepare(this.sql);
    const results = statement.columns().length ? statement.all(...this.values) : (statement.run(...this.values), []);
    return { results, meta: { changes: Number(this.sqlite.prepare('SELECT changes() AS changes').get()?.changes || 0) }, success: true };
  }
  async run() { return this.runSync(); }
}
class SQLiteD1 {
  readonly sqlite = new DatabaseSync(':memory:');
  beforeBatch?: (statements: SQLiteStatement[]) => void;
  private pending: Promise<unknown> = Promise.resolve();
  prepare(sql: string) { return new SQLiteStatement(this.sqlite, sql); }
  batch(statements: SQLiteStatement[]) {
    const operation = this.pending.then(() => {
      this.beforeBatch?.(statements);
      this.sqlite.exec('BEGIN');
      try { const results = statements.map(statement => statement.runSync()); this.sqlite.exec('COMMIT'); return results; }
      catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  asD1() { return this as unknown as D1Database; }
}
const binding: { DB?: D1Database } = {};
Object.defineProperty(globalThis, Symbol.for('triptab.profile-test-env'), { value: binding, configurable: true });
const dataURL = (text: string) => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
const envURL = dataURL("export const env=globalThis[Symbol.for('triptab.profile-test-env')];export const waitUntil=()=>{};");
const notificationURL = dataURL('export const notifyMembers=async()=>{};export const activityNotification=()=>({});');
const auditURL = new URL('../lib/audit.ts', import.meta.url).href;
const compiledStore = transpileWithSharedImports(await readFile(new URL('../lib/store.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText
  .replace("'zod'", JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('zod').replace(/\.cjs$/, '.js')).href))
  .replace("'cloudflare:workers'", JSON.stringify(envURL))
  .replace("'./model'", JSON.stringify(new URL('../lib/model.ts', import.meta.url).href))
  .replace("'./auth'", JSON.stringify(new URL('../lib/auth.ts', import.meta.url).href))
  .replace("'./activity-scope'", JSON.stringify(new URL('../lib/activity-scope.ts', import.meta.url).href))
  .replaceAll("'./audit'", JSON.stringify(auditURL))
  .replace("'./receipt-lifecycle'", JSON.stringify(new URL('../lib/receipt-lifecycle.ts', import.meta.url).href))
  .replace("'./receipt-context'", JSON.stringify(new URL('../lib/receipt-context.ts', import.meta.url).href))
  .replace("'./receipt-memory-ownership'", JSON.stringify(new URL('../lib/receipt-memory-ownership.ts', import.meta.url).href))
  .replace("'./notifications'", JSON.stringify(notificationURL));
const storeURL = dataURL(compiledStore);
const routeSource = transpileWithSharedImports(await readFile(new URL('../app/api/profile/route.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText
  .replace("'@/lib/store'", JSON.stringify(storeURL)).replace("'@/lib/audit'", JSON.stringify(auditURL));
const route = await import(dataURL(routeSource)) as typeof import('../app/api/profile/route');
const historySource = transpileWithSharedImports(await readFile(new URL('../app/api/account-activity/route.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText
  .replace("'@/lib/store'", JSON.stringify(storeURL)).replace("'@/lib/audit'", JSON.stringify(auditURL));
const historyRoute = await import(dataURL(historySource)) as typeof import('../app/api/account-activity/route');
const alice = 'profile-alice', bob = 'profile-bob';
async function storage() {
  const database = new SQLiteD1();
  for (const file of (await readdir(new URL('../drizzle/', import.meta.url))).filter(file => file.endsWith('.sql')).sort()) database.sqlite.exec(await readFile(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'));
  database.sqlite.prepare('INSERT INTO profiles (id,email,display_name,created_at) VALUES (?,?,?,?)').run(alice, 'alice-private@example.com', 'Alice', '2026-10-04T12:00:00Z');
  database.sqlite.prepare('INSERT INTO profiles (id,email,display_name,created_at) VALUES (?,?,?,?)').run(bob, 'bob-private@example.com', 'Bob', '2026-10-04T12:00:00Z');
  binding.DB = database.asD1();
  return database;
}
function request(actor: string, body?: unknown, origin = 'https://triptab.test', query = '') {
  return new Request('https://triptab.test/api/profile' + query, { method: body === undefined ? 'GET' : 'POST', headers: {
    'oai-authenticated-user-id': actor, 'oai-authenticated-user-email': actor === alice ? 'alice-private@example.com' : 'bob-private@example.com',
    origin, 'content-type': 'application/json',
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const name = (database: SQLiteD1, user = alice) => database.sqlite.prepare('SELECT display_name FROM profiles WHERE id = ?').get(user)?.display_name;
const count = (database: SQLiteD1) => Number(database.sqlite.prepare('SELECT COUNT(*) AS count FROM account_activity_events').get()?.count);

test('profile updates record trusted before and after names privately and no-op repeats add no event', async () => {
  const database = await storage();
  const response = await route.POST(request(alice, { displayName: 'Alice Updated', userId: bob, actorName: 'Forged actor', email: 'forged@example.com' }));
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const events = (await readAccountActivity(database.asD1(), alice)).events;
  assert.equal(events.length, 1); assert.equal(events[0].actorName, 'Alice'); assert.equal(events[0].userId, alice);
  assert.deepEqual(events[0].before, { displayName: 'Alice' }); assert.deepEqual(events[0].after, { displayName: 'Alice Updated' });
  assert.equal(name(database), 'Alice Updated'); assert.equal(name(database, bob), 'Bob');
  assert.equal((await readAccountActivity(database.asD1(), bob)).events.length, 0);
  assert.equal(Number(database.sqlite.prepare('SELECT COUNT(*) AS count FROM activity_events').get()?.count), 0);
  assert.ok(!JSON.stringify(events).includes('alice-private@example.com')); assert.ok(!JSON.stringify(events).includes('forged@example.com'));
  assert.equal((await route.POST(request(alice, { displayName: 'Alice Updated' }))).status, 200); assert.equal(count(database), 1);
});

test('a concurrent profile change fails its baseline CAS and records no false before/after event', async () => {
  const database = await storage();
  database.beforeBatch = statements => { if (statements.some(statement => /^UPDATE profiles/.test(statement.sql.trim()))) { database.beforeBatch = undefined; database.sqlite.prepare('UPDATE profiles SET display_name = ? WHERE id = ?').run('Changed elsewhere', alice); } };
  const response = await route.POST(request(alice, { displayName: 'My stale edit' }));
  assert.equal(response.status, 409); assert.equal(name(database), 'Changed elsewhere'); assert.equal(count(database), 0);
});

test('a canonical account link racing a provider profile update blocks the old identity', async () => {
  const database = await storage();
  database.beforeBatch = statements => { if (statements.some(statement => /^UPDATE profiles/.test(statement.sql.trim()))) { database.beforeBatch = undefined; database.sqlite.prepare('INSERT INTO auth_links (oai_user_id,user_id,created_at) VALUES (?,?,?)').run(alice, bob, '2026-10-04T12:00:00Z'); } };
  assert.equal((await route.POST(request(alice, { displayName: 'Wrong account edit' }))).status, 409);
  assert.equal(name(database), 'Alice'); assert.equal(name(database, bob), 'Bob'); assert.equal(count(database), 0);
});

test('profile and audit insertion roll back together when durable history is unavailable', async () => {
  const database = await storage();
  database.sqlite.exec("CREATE TRIGGER deny_audit BEFORE INSERT ON account_activity_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
  const response = await route.POST(request(alice, { displayName: 'Unsafely changed' }));
  assert.notEqual(response.status, 200); assert.equal(name(database), 'Alice'); assert.equal(count(database), 0);
});

test('private history HTTP scope uses the authenticated account and rejects user-selected subjects', async () => {
  const database = await storage();
  await route.POST(request(alice, { displayName: 'Alice Updated' }));
  await route.POST(request(bob, { displayName: 'Bob Updated' }));
  const response = await historyRoute.GET(request(alice, undefined, 'https://triptab.test'));
  assert.equal(response.status, 200); const value = await response.json() as { events: { userId: string }[] };
  assert.ok(value.events.every(event => event.userId === alice)); assert.equal(value.events.length, 1);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal((await historyRoute.GET(request(alice, undefined, 'https://triptab.test', '?userId=' + bob))).status, 400);
  assert.equal((await route.POST(request(alice, { displayName: 'Cross origin' }, 'https://evil.test'))).status, 403);
  assert.equal((await route.POST(request(alice, { displayName: '' }))).status, 400);
  assert.equal((await route.POST(new Request('https://triptab.test/api/profile', { method: 'POST', headers: { origin: 'https://triptab.test' }, body: '{}' }))).status, 401);
  assert.equal(count(database), 2);
});
