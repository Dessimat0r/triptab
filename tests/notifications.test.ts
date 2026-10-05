import { transpileWithSharedImports } from './helpers/transpile';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import vm from 'node:vm';
import { JsxEmit, ModuleKind, ScriptTarget } from 'typescript';
import { performAuthAction } from '../lib/auth';
import { readAccountActivity } from '../lib/audit';

class Statement {
  private values: (string | number | null)[] = [];
  constructor(private sqlite: DatabaseSync, readonly sql: string) {}
  bind(...values: (string | number | null)[]) { this.values = values; return this; }
  async first<T>() { return this.sqlite.prepare(this.sql).get(...this.values) as T | undefined ?? null; }
  async all<T>() { return { results: this.sqlite.prepare(this.sql).all(...this.values) as T[] }; }
  runSync() {
    const prepared = this.sqlite.prepare(this.sql);
    const results = prepared.columns().length ? prepared.all(...this.values) : (prepared.run(...this.values), []);
    return { results, meta: { changes: Number(this.sqlite.prepare('SELECT changes() AS count').get()!.count) } };
  }
  async run() { return this.runSync(); }
}
class SQLiteD1 {
  sqlite = new DatabaseSync(':memory:');
  beforeBatch?: (statements: Statement[]) => void;
  private pending: Promise<unknown> = Promise.resolve();
  prepare(sql: string) { return new Statement(this.sqlite, sql); }
  batch(statements: Statement[]) {
    const operation = this.pending.then(() => {
      const hook = this.beforeBatch; this.beforeBatch = undefined; hook?.(statements);
      this.sqlite.exec('BEGIN');
      try { const results = statements.map(statement => statement.runSync()); this.sqlite.exec('COMMIT'); return results; }
      catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  asD1() { return this as unknown as D1Database; }
}
class RequestError extends Error { constructor(message: string, public status = 400) { super(message); } }
const environment: { database?: SQLiteD1; VAPID_PUBLIC_KEY: string; VAPID_PRIVATE_KEY: string; pending: Promise<unknown>[] } = { VAPID_PUBLIC_KEY: 'a'.repeat(87), VAPID_PRIVATE_KEY: 'unused-fixture-key', pending: [] };
const store = {
  db: () => environment.database!.asD1(), RequestError,
  async ensureProfile(request: Request) {
    const id = request.headers.get('x-test-user');
    if (!id) throw new Error('UNAUTHORIZED');
    return { id };
  },
  sameOrigin(request: Request) { if (request.headers.get('origin') !== new URL(request.url).origin) throw new RequestError('Invalid origin', 403); },
  async readBoundedBody(request: Request, maximum: number) { const bytes = new Uint8Array(await request.arrayBuffer()); if (bytes.length > maximum) throw new RequestError('Too large', 413); return bytes; },
  failure(error: unknown) { return Response.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: error instanceof RequestError ? error.status : 401 }); },
};
Object.defineProperty(globalThis, Symbol.for('triptab.notifications-test-env'), { value: environment, configurable: true });
Object.defineProperty(globalThis, Symbol.for('triptab.notifications-test-store'), { value: store, configurable: true });
const envURL = 'data:text/javascript;base64,' + Buffer.from("export const env=globalThis[Symbol.for('triptab.notifications-test-env')]; export const waitUntil=task=>env.pending.push(task);").toString('base64');
const storeURL = 'data:text/javascript;base64,' + Buffer.from(`const store=globalThis[Symbol.for('triptab.notifications-test-store')];${Object.keys(store).map(name => `export const ${name}=store.${name};`).join('\n')}`).toString('base64');
function compile(source: string) { return transpileWithSharedImports(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022, jsx: JsxEmit.ReactJSX } }).outputText; }
function dataURL(source: string) { return 'data:text/javascript;base64,' + Buffer.from(source).toString('base64'); }
const notificationURL = dataURL(compile(await readFile(new URL('../lib/notifications.ts', import.meta.url), 'utf8')).replace("'cloudflare:workers'", JSON.stringify(envURL)).replace("'./store'", JSON.stringify(storeURL)));
const notifications = await import(notificationURL) as typeof import('../lib/notifications');
const pushURL = dataURL(compile(await readFile(new URL('../app/api/push/route.ts', import.meta.url), 'utf8')).replace("'@/lib/store'", JSON.stringify(storeURL)).replace("'@/lib/notifications'", JSON.stringify(notificationURL)).replace("'zod'", JSON.stringify(import.meta.resolve('zod'))));
const pushRoute = await import(pushURL) as typeof import('../app/api/push/route');
const authURL = dataURL(compile(await readFile(new URL('../app/api/auth/route.ts', import.meta.url), 'utf8')).replace("'@/lib/store'", JSON.stringify(storeURL)).replace("'@/lib/notifications'", JSON.stringify(notificationURL)).replace("'@/lib/auth'", JSON.stringify(new URL('../lib/auth.ts', import.meta.url).href)));
const authRoute = await import(authURL) as typeof import('../app/api/auth/route');
const pwaURL = dataURL(compile(await readFile(new URL('../components/pwa-controls.tsx', import.meta.url), 'utf8'))
  .replace('"@/components/use-live-refresh"', JSON.stringify(new URL('../components/use-live-refresh.ts', import.meta.url).href))
  .replace('"lucide-react"', JSON.stringify(import.meta.resolve('lucide-react'))));
const pwa = await import(pwaURL) as typeof import('../components/pwa-controls');

async function storage() {
  const database = new SQLiteD1();
  for (const name of (await readdir(new URL('../drizzle/', import.meta.url))).filter(name => name.endsWith('.sql')).sort()) database.sqlite.exec(await readFile(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'));
  for (const [id, name] of [['alice', 'Alice'], ['bob', 'Bob']]) database.sqlite.prepare('INSERT INTO profiles (id,email,display_name,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.test`, name, '2026-10-04T00:00:00Z');
  environment.database = database;
  environment.pending = [];
  return database;
}
const endpoint = (name: string) => `https://fcm.googleapis.com/fcm/send/${name}`;
function pushRequest(user: string, mode: string, value = endpoint('browser-a')) {
  return new Request('https://triptab.test/api/push', { method: 'POST', headers: { origin: 'https://triptab.test', 'content-type': 'application/json', 'x-test-user': user }, body: JSON.stringify({ mode, endpoint: value }) });
}
function rows(database: SQLiteD1) { return database.sqlite.prepare('SELECT endpoint,user_id FROM push_subscriptions ORDER BY endpoint').all(); }
async function deviceEvents(database: SQLiteD1, user: string) { return (await readAccountActivity(database.asD1(), user, { limit: 50 })).events.filter(event => event.entityType === 'notifications'); }

test('generic fallback wording handles singular, plural and mixed edits without exposing financial values', () => {
  const examples = [
    { events: [{ entityType: 'expense', action: 'update' }], title: 'Expense updated', words: 'Bob updated an expense.' },
    { events: [{ entityType: 'payment', action: 'create' }], title: 'Payment recorded', words: 'Bob recorded a payment.' },
    { events: [{ entityType: 'member', action: 'delete' }], title: 'Traveller removed', words: 'Bob removed a traveller.' },
    { events: [{ entityType: 'expense', action: 'create' }, { entityType: 'expense', action: 'create' }], title: 'Expenses added', words: 'Bob added 2 expenses.' },
    { events: [{ entityType: 'payment', action: 'delete' }, { entityType: 'payment', action: 'delete' }], title: 'Payments removed', words: 'Bob removed 2 payments.' },
    { events: [{ entityType: 'member', action: 'update' }, { entityType: 'member', action: 'update' }], title: 'Travellers updated', words: 'Bob updated 2 travellers.' },
    { events: [{ entityType: 'expense', action: 'create' }, { entityType: 'expense', action: 'delete' }], title: 'Expenses updated', words: 'Bob changed 2 expenses.' },
    { events: [{ entityType: 'member', action: 'update' }, { entityType: 'expense', action: 'update' }, { entityType: 'payment', action: 'create' }], title: 'Holiday activity', words: 'Bob updated an expense and recorded a payment, plus 1 other update.' },
    { events: [{ entityType: 'trip', action: 'update' }], title: 'Holiday details changed', words: 'Bob updated the holiday details.' },
  ] as const;
  for (const example of examples) {
    const privateSnapshot = { note: 'Private payment', amount: 12345 };
    const changes = example.events.map(event => ({ ...event, before: privateSnapshot, after: privateSnapshot }));
    const message = notifications.activityNotification('Bob', changes)!;
    assert.equal(message.title, example.title);
    assert.equal(message.body, example.words);
    assert.doesNotMatch(JSON.stringify(message), /Secret holiday|Private receipt|Private payment|12345/);
  }
});

test('notification copy sanitizes and bounds actor names without dropping the action', () => {
  assert.equal(notifications.activityNotification('Bob', []), null);
  assert.equal(notifications.activityNotification('Bob', [{ entityType: 'draft', action: 'update' }]), null);
  const substantive = notifications.activityNotification('Bob', [{ entityType: 'draft', action: 'create' }, { entityType: 'expense', action: 'update' }])!;
  assert.equal(substantive.body, 'Bob updated an expense.');
  assert.equal(notifications.activityNotification(' \n\t ', [{ entityType: 'expense', action: 'update' }])!.body, 'A traveller updated an expense.');
  assert.equal(notifications.activityNotification(' Bob\u0000\n\u202e Smith ', [{ entityType: 'payment', action: 'create' }])!.body, 'Bob Smith recorded a payment.');
  const long = notifications.activityNotification('B'.repeat(300), [{ entityType: 'expense', action: 'update' }])!;
  assert.equal(long.body, `${'B'.repeat(47)}… updated an expense.`);
  const unicode = notifications.activityNotification('😀'.repeat(100), [{ entityType: 'payment', action: 'create' }])!;
  assert.equal(unicode.body, `${'😀'.repeat(47)}… recorded a payment.`);
  assert.ok(Array.from(long.body).length <= 160);
  assert.ok(Array.from(unicode.body).length <= 160);
});

test('deliberate collection reorders describe display order without inventing additions', () => {
  const trip = { entityType: 'trip', action: 'update', before: { expenseOrder: ['a', 'b'] }, after: { expenseOrder: ['b', 'a'] } } as const;
  assert.equal(notifications.activityNotification('Alice', [trip])!.body, 'Alice changed the display order.');
  assert.equal(notifications.activityNotification('Alice', [trip, { entityType: 'expense', entityId: 'a', action: 'update' }])!.body, 'Alice updated an expense and updated the holiday details.');
  assert.equal(notifications.activityNotification('Alice', [{ ...trip, before: { memberOrder: ['a', 'b'] }, after: { memberOrder: ['a', 'c', 'b'] } }, { entityType: 'member', entityId: 'c', action: 'create' }])!.body, 'Alice added a traveller and updated the holiday details.');
});

test('device preference audit is private, secret-free and unchanged by repeated or foreign requests', async () => {
  const database = await storage();
  assert.equal((await pushRoute.POST(pushRequest('alice', 'subscribe'))).status, 200);
  const original = database.sqlite.prepare('SELECT created_at,generation FROM push_subscriptions WHERE user_id=?').get('alice');
  assert.equal((await pushRoute.POST(pushRequest('alice', 'subscribe'))).status, 200);
  const refreshed = database.sqlite.prepare('SELECT created_at,generation FROM push_subscriptions WHERE user_id=?').get('alice')!;
  assert.equal(refreshed.generation, original!.generation);
  assert.ok(String(refreshed.created_at) > String(original!.created_at), 'explicit re-enable refreshes dispatch recency without another opt-in');
  assert.equal((await pushRoute.POST(pushRequest('alice', 'status'))).status, 200);
  assert.equal((await pushRoute.POST(pushRequest('bob', 'subscribe'))).status, 409);
  assert.equal((await pushRoute.POST(pushRequest('bob', 'unsubscribe'))).status, 200);
  let events = await deviceEvents(database, 'alice');
  assert.equal(events.length, 1);
  assert.equal(events[0].actorName, 'Alice');
  assert.equal(events[0].action, 'create');
  assert.equal(events[0].source, 'web');
  assert.equal(events[0].before, null);
  assert.deepEqual(events[0].after, { enabled: true, service: 'fcm.googleapis.com', reason: 'enabled_on_device' });
  assert.match(events[0].entityId, /^[a-f0-9]{64}$/);
  assert.deepEqual(await deviceEvents(database, 'bob'), []);
  assert.equal((await pushRoute.POST(pushRequest('alice', 'unsubscribe'))).status, 200);
  assert.equal((await pushRoute.POST(pushRequest('alice', 'unsubscribe'))).status, 200);
  events = await deviceEvents(database, 'alice');
  assert.equal(events.length, 2);
  assert.equal(events[0].entityId, events[1].entityId);
  assert.deepEqual(events[0].before, { enabled: true, service: 'fcm.googleapis.com' });
  assert.deepEqual(events[0].after, { enabled: false, service: 'fcm.googleapis.com', reason: 'disabled_on_device' });
  assert.doesNotMatch(JSON.stringify(events), /https:|browser-a|unused-fixture-key|endpoint|token|providerId|cookie/);
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM activity_events').get()!.count, 0, 'device changes do not enter shared holiday history');
});

test('re-enabling an older device refreshes recency without changing ownership, generation or its audit', async () => {
  const database = await storage();
  await notifications.subscribe('alice', endpoint('old-device'));
  database.sqlite.prepare('UPDATE push_subscriptions SET created_at=? WHERE endpoint=?').run('2020-01-01T00:00:00.000Z', endpoint('old-device'));
  const original = database.sqlite.prepare('SELECT generation FROM push_subscriptions WHERE endpoint=?').get(endpoint('old-device'))!;
  await notifications.subscribe('alice', endpoint('old-device'));
  const refreshed = database.sqlite.prepare('SELECT user_id,created_at,generation FROM push_subscriptions WHERE endpoint=?').get(endpoint('old-device'))!;
  assert.equal(refreshed.user_id, 'alice');
  assert.equal(refreshed.generation, original.generation);
  assert.ok(String(refreshed.created_at) > '2020-01-01T00:00:00.000Z');
  assert.equal((await deviceEvents(database, 'alice')).length, 1);
  await assert.rejects(notifications.subscribe('bob', endpoint('old-device')), /belongs to another account/);
  assert.deepEqual(database.sqlite.prepare('SELECT user_id,created_at,generation FROM push_subscriptions WHERE endpoint=?').get(endpoint('old-device')), refreshed);
});

test('a stale re-enable cannot refresh a browser binding transferred to another account', async context => {
  const database = await storage();
  const value = endpoint('device');
  await notifications.subscribe('alice', value);
  const prepare = database.prepare.bind(database);
  context.mock.method(database, 'prepare', (sql: string) => {
    const statement = prepare(sql);
    if (sql.startsWith('UPDATE push_subscriptions SET created_at = MAX')) {
      const run = statement.run.bind(statement);
      statement.run = async () => {
        database.sqlite.prepare('UPDATE push_subscriptions SET user_id=?,generation=?,created_at=? WHERE endpoint=?')
          .run('bob', 'new-account-generation', '2099-01-01T00:00:00.000Z', value);
        return run();
      };
    }
    return statement;
  });
  await assert.rejects(notifications.subscribe('alice', value), /settings changed/);
  const current = database.sqlite.prepare('SELECT user_id,generation,created_at FROM push_subscriptions WHERE endpoint=?').get(value)!;
  assert.equal(current.user_id, 'bob'); assert.equal(current.generation, 'new-account-generation');
  assert.equal(current.created_at, '2099-01-01T00:00:00.000Z');
  assert.equal((await deviceEvents(database, 'alice')).length, 1);
  assert.deepEqual(await deviceEvents(database, 'bob'), []);
});

test('receipt reply notifications reach their author even when the assistant uses that account', async context => {
  const database = await storage();
  database.sqlite.prepare('INSERT INTO trips (id,owner,data) VALUES (?,?,?)').run('reply-trip', 'alice', '{}');
  for (const [user, member] of [['alice', 'author-a'], ['bob', 'author-b']]) {
    database.sqlite.prepare('INSERT INTO memberships (trip_id,user_id,member_id) VALUES (?,?,?)').run('reply-trip', user, member);
    await notifications.subscribe(user, endpoint(user));
  }
  const oldKey = environment.VAPID_PRIVATE_KEY;
  environment.VAPID_PRIVATE_KEY = await realVapidKey();
  const delivered: string[] = [];
  context.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    delivered.push(String(url));
    assert.equal(init?.body, '', 'push remains a content-free wake-up signal');
    return new Response(null, { status: 201 });
  });
  try {
    await notifications.notifyReceiptReply('reply-trip', 'alice', 'author-a');
    await Promise.all(environment.pending);
    assert.deepEqual(delivered, [endpoint('alice')]);
    const inbox = await notifications.latestNotifications('alice');
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].title, 'Receipt chat reply ready');
    assert.equal(inbox[0].body, 'ChatGPT or Codex answered your receipt question.');
    assert.deepEqual(await notifications.latestNotifications('bob'), []);
    await notifications.notifyReceiptReply('reply-trip', 'bob', 'author-a', 'item');
    await Promise.all(environment.pending);
    assert.equal((await notifications.latestNotifications('alice'))[0].title, 'Item chat reply ready');
    assert.equal((await notifications.latestNotifications('alice'))[0].body, 'ChatGPT or Codex answered your question about a receipt item.');
    assert.equal(delivered.length, 1, 'the existing thirty-second throttle covers assistant replies');
    assert.equal((await notifications.latestNotifications('alice')).length, 2, 'throttling never drops an inbox entry');
    await notifications.notifyMembers('reply-trip', 'alice', 'TripTab activity', 'Alice updated an expense.');
    await Promise.all(environment.pending);
    assert.deepEqual(delivered, [endpoint('alice'), endpoint('bob')], 'normal holiday activity still excludes its actor');
    assert.equal((await notifications.latestNotifications('alice')).length, 2);
  } finally { environment.VAPID_PRIVATE_KEY = oldKey; }
});

test('receipt replies target only a currently linked author and do not substitute another account', async () => {
  const database = await storage();
  database.sqlite.prepare('INSERT INTO trips (id,owner,data) VALUES (?,?,?)').run('reply-trip', 'bob', '{}');
  database.sqlite.prepare('INSERT INTO memberships (trip_id,user_id,member_id) VALUES (?,?,?)').run('reply-trip', 'alice', 'author-a');
  database.sqlite.prepare('INSERT INTO memberships (trip_id,user_id,member_id) VALUES (?,?,?)').run('reply-trip', 'bob', 'caller-b');
  await notifications.notifyReceiptReply('reply-trip', 'bob', 'author-a');
  await Promise.all(environment.pending);
  assert.equal((await notifications.latestNotifications('alice')).length, 1);
  assert.deepEqual(await notifications.latestNotifications('bob'), []);
  database.sqlite.prepare('DELETE FROM memberships WHERE trip_id=? AND user_id=?').run('reply-trip', 'alice');
  await notifications.notifyReceiptReply('reply-trip', 'bob', 'author-a');
  await notifications.notifyReceiptReply('reply-trip', 'bob', 'unknown-author');
  await Promise.all(environment.pending);
  assert.equal((await notifications.latestNotifications('alice')).length, 1, 'a departed author receives no further update');
  assert.deepEqual(await notifications.latestNotifications('bob'), [], 'an unknown author is never redirected to the caller');
});

test('legacy receipt questions without author IDs can notify only their caller with current holiday access', async () => {
  const database = await storage();
  database.sqlite.prepare('INSERT INTO trips (id,owner,data) VALUES (?,?,?)').run('reply-trip', 'bob', '{}');
  database.sqlite.prepare('INSERT INTO memberships (trip_id,user_id,member_id) VALUES (?,?,?)').run('reply-trip', 'alice', 'caller-a');
  await notifications.notifyReceiptReply('reply-trip', 'alice');
  await Promise.all(environment.pending);
  assert.equal((await notifications.latestNotifications('alice')).length, 1);
  assert.deepEqual(await notifications.latestNotifications('bob'), []);
  database.sqlite.prepare('DELETE FROM memberships WHERE trip_id=? AND user_id=?').run('reply-trip', 'alice');
  await notifications.notifyReceiptReply('reply-trip', 'alice');
  await notifications.notifyReceiptReply('missing-trip', 'bob');
  await Promise.all(environment.pending);
  assert.equal((await notifications.latestNotifications('alice')).length, 1);
  assert.deepEqual(await notifications.latestNotifications('bob'), []);
});

async function notificationGroup(database: SQLiteD1, travellers: number, devices: number) {
  database.sqlite.prepare('INSERT INTO trips (id,owner,data) VALUES (?,?,?)').run('group-trip', 'bob', '{}');
  const endpoints = new Map<string, string[]>();
  for (let userIndex = 0; userIndex < travellers; userIndex++) {
    const user = `traveller-${String(userIndex).padStart(2, '0')}`;
    database.sqlite.prepare('INSERT INTO profiles (id,email,display_name,created_at) VALUES (?,?,?,?)').run(user, `${user}@example.test`, user, '2020-01-01T00:00:00.000Z');
    database.sqlite.prepare('INSERT INTO memberships (trip_id,user_id,member_id) VALUES (?,?,?)').run('group-trip', user, user);
    endpoints.set(user, []);
    for (let device = 0; device < devices; device++) {
      const value = endpoint(`${user}-device-${device}`);
      endpoints.get(user)!.push(value);
      database.sqlite.prepare('INSERT INTO push_subscriptions (endpoint,user_id,created_at,generation) VALUES (?,?,?,?)')
        .run(value, user, new Date(Date.UTC(2020, 0, userIndex + 1, 0, 0, device)).toISOString(), `${user}-${device}-generation`);
    }
  }
  return endpoints;
}

async function realVapidKey() {
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return JSON.stringify(await crypto.subtle.exportKey('jwk', key.privateKey));
}

test('bounded push gives each traveller a device before extras and never exceeds six concurrent sends', async context => {
  const database = await storage();
  const devices = await notificationGroup(database, 20, 5);
  const oldKey = environment.VAPID_PRIVATE_KEY;
  environment.VAPID_PRIVATE_KEY = await realVapidKey();
  const delivered: string[] = [];
  let active = 0, peak = 0;
  context.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    delivered.push(String(url)); active++; peak = Math.max(peak, active);
    assert.equal(init?.redirect, 'manual'); assert.ok(init?.signal);
    await new Promise<void>(resolve => setImmediate(resolve));
    active--; return new Response(null, { status: 201 });
  });
  try {
    await notifications.notifyMembers('group-trip', 'bob', 'TripTab activity', 'Bob updated an expense.');
    await Promise.all(environment.pending);
    assert.equal(delivered.length, 40);
    assert.ok(peak <= 6); assert.ok(peak > 1);
    for (const endpoints of devices.values()) {
      assert.equal(endpoints.filter(value => delivered.includes(value)).length, 2, 'a traveller cannot consume the budget before others get one device');
    }
    assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM notifications').get()!.count, 20);
    assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM account_activity_events').get()!.count, 0, 'dispatch bookkeeping is not a preference change');
    const before = database.sqlite.prepare('SELECT endpoint,created_at FROM push_subscriptions ORDER BY endpoint').all();
    await notifications.notifyMembers('group-trip', 'bob', 'TripTab activity', 'Bob updated another expense.');
    await Promise.all(environment.pending);
    assert.equal(delivered.length, 40, 'the existing thirty-second throttle still suppresses duplicate pushes');
    assert.deepEqual(database.sqlite.prepare('SELECT endpoint,created_at FROM push_subscriptions ORDER BY endpoint').all(), before);
    assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM notifications').get()!.count, 40, 'throttling does not suppress inbox entries');
  } finally { environment.VAPID_PRIVATE_KEY = oldKey; }
});

test('fifty travellers with five devices rotate through every endpoint instead of starving old registrations', async context => {
  const database = await storage();
  const devices = await notificationGroup(database, 50, 5);
  const userForEndpoint = new Map([...devices].flatMap(([user, values]) => values.map(value => [value, user] as const)));
  const oldKey = environment.VAPID_PRIVATE_KEY;
  environment.VAPID_PRIVATE_KEY = await realVapidKey();
  context.mock.method(Date, 'now', () => Date.parse('2026-10-05T12:00:00.000Z'));
  const allDelivered = new Set<string>();
  let delivered: string[] = [];
  context.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    delivered.push(String(url)); allDelivered.add(String(url)); return new Response(null, { status: 201 });
  });
  try {
    const firstUsers = new Set<string>();
    for (let round = 0; round < 7; round++) {
      database.sqlite.exec("UPDATE notifications SET created_at='2020-01-01T00:00:00.000Z'");
      environment.pending = []; delivered = [];
      await notifications.notifyMembers('group-trip', 'bob', 'TripTab activity', `Bob updated an expense ${round}.`);
      await Promise.all(environment.pending);
      assert.equal(delivered.length, 40);
      const users = new Set(delivered.map(value => userForEndpoint.get(value)!));
      assert.equal(users.size, 40, 'one device per traveller before extras in a large group');
      if (round === 0) for (const user of users) firstUsers.add(user);
      if (round === 1) for (const user of devices.keys()) {
        if (!firstUsers.has(user)) assert.ok(users.has(user), 'travellers omitted by the first budget get priority next time');
      }
      assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM notifications').get()!.count, 50 * (round + 1), 'every traveller receives every inbox update');
    }
    assert.equal(allDelivered.size, 250, 'all active devices receive an attempt within seven unthrottled updates');
    assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM push_subscriptions').get()!.count, 250);
  } finally { environment.VAPID_PRIVATE_KEY = oldKey; }
});

test('push dispatch stops at its overall deadline while preserving every traveller inbox update', async context => {
  const database = await storage();
  await notificationGroup(database, 50, 1);
  const oldKey = environment.VAPID_PRIVATE_KEY;
  environment.VAPID_PRIVATE_KEY = await realVapidKey();
  let now = Date.parse('2026-10-05T12:00:00.000Z'), calls = 0;
  context.mock.method(Date, 'now', () => now);
  context.mock.method(globalThis, 'fetch', async () => {
    calls++; now += 24001; return new Response(null, { status: 201 });
  });
  try {
    await notifications.notifyMembers('group-trip', 'bob', 'TripTab activity', 'Bob updated an expense.');
    await Promise.all(environment.pending);
    assert.equal(calls, 6, 'no further group of requests starts after the background budget');
    assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM notifications').get()!.count, 50);
    assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM push_subscriptions').get()!.count, 50);
  } finally { environment.VAPID_PRIVATE_KEY = oldKey; }
});

test('stale delivery reservations cannot target a replacement binding or override its recency', async context => {
  const database = await storage();
  await notificationGroup(database, 1, 1);
  const value = endpoint('traveller-00-device-0');
  let calls = 0;
  database.beforeBatch = statements => {
    if (!statements.some(statement => statement.sql.startsWith('UPDATE push_subscriptions SET created_at'))) {
      database.beforeBatch = () => database.sqlite.prepare('UPDATE push_subscriptions SET generation=?,created_at=? WHERE endpoint=?')
        .run('replacement-generation', '2099-01-01T00:00:00.000Z', value);
    }
  };
  context.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(null, { status: 410 }); });
  await notifications.notifyMembers('group-trip', 'bob', 'TripTab activity', 'Bob updated an expense.');
  await Promise.all(environment.pending);
  assert.equal(calls, 0);
  const current = database.sqlite.prepare('SELECT generation,created_at FROM push_subscriptions WHERE endpoint=?').get(value)!;
  assert.equal(current.generation, 'replacement-generation');
  assert.equal(current.created_at, '2099-01-01T00:00:00.000Z');
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM account_activity_events').get()!.count, 0);
});

test('concurrent enable and quota races produce events only for committed device changes', async () => {
  const database = await storage();
  await Promise.all([notifications.subscribe('alice', endpoint('same-device')), notifications.subscribe('alice', endpoint('same-device'))]);
  assert.equal(rows(database).length, 1);
  assert.equal((await deviceEvents(database, 'alice')).length, 1);
  for (let index = 0; index < 3; index++) await notifications.subscribe('alice', endpoint(`existing-${index}`));
  const results = await Promise.allSettled([notifications.subscribe('alice', endpoint('racing-1')), notifications.subscribe('alice', endpoint('racing-2'))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(rows(database).length, 5);
  assert.equal((await deviceEvents(database, 'alice')).length, 5);
  await assert.rejects(notifications.subscribe('bob', endpoint('same-device')), /belongs to another account/);
  assert.equal((await deviceEvents(database, 'bob')).length, 0);
});

test('audit or device-storage failure rolls back both the preference and its history', async () => {
  const database = await storage();
  database.sqlite.exec("CREATE TRIGGER refuse_device_insert BEFORE INSERT ON push_subscriptions BEGIN SELECT RAISE(ABORT, 'device-storage-failed'); END;");
  await assert.rejects(notifications.subscribe('alice', endpoint('device')), /device-storage-failed/);
  assert.equal(rows(database).length, 0);
  assert.equal((await deviceEvents(database, 'alice')).length, 0);
  database.sqlite.exec('DROP TRIGGER refuse_device_insert');
  await notifications.subscribe('alice', endpoint('device'));
  database.sqlite.exec("CREATE TRIGGER refuse_device_audit BEFORE INSERT ON account_activity_events WHEN NEW.entity_type='notifications' BEGIN SELECT RAISE(ABORT, 'device-audit-failed'); END;");
  await assert.rejects(notifications.unsubscribe('alice', endpoint('device')), /device-audit-failed/);
  assert.equal(rows(database).length, 1);
  assert.equal((await deviceEvents(database, 'alice')).length, 1);
  await assert.rejects(notifications.subscribe('bob', endpoint('other-device')), /device-audit-failed/);
  assert.equal(await notifications.ownsSubscription('bob', endpoint('other-device')), false);
  database.sqlite.exec('DROP TRIGGER refuse_device_audit');
  database.sqlite.exec("CREATE TRIGGER refuse_device_delete BEFORE DELETE ON push_subscriptions BEGIN SELECT RAISE(ABORT, 'device-delete-failed'); END;");
  await assert.rejects(notifications.unsubscribe('alice', endpoint('device')), /device-delete-failed/);
  assert.equal(rows(database).length, 1);
  assert.equal((await deviceEvents(database, 'alice')).length, 1);
});

test('a recreated binding defeats an older deletion generation even when its timestamp is unchanged', async () => {
  const database = await storage();
  await notifications.subscribe('alice', endpoint('device'));
  const original = database.sqlite.prepare('SELECT created_at,generation FROM push_subscriptions WHERE endpoint=?').get(endpoint('device'))!;
  database.beforeBatch = () => database.sqlite.prepare('UPDATE push_subscriptions SET generation=? WHERE endpoint=?').run('new-generation-same-timestamp', endpoint('device'));
  await assert.rejects(notifications.unsubscribe('alice', endpoint('device')), /settings changed/);
  const current = database.sqlite.prepare('SELECT created_at,generation FROM push_subscriptions WHERE endpoint=?').get(endpoint('device'))!;
  assert.equal(current.created_at, original.created_at);
  assert.notEqual(current.generation, original.generation);
  assert.equal((await deviceEvents(database, 'alice')).length, 1);
  assert.equal(await notifications.ownsSubscription('alice', endpoint('device')), true);
});

test('provider expiry records a private system removal while stale expiry preserves a replacement binding', async () => {
  const database = await storage();
  database.sqlite.prepare('INSERT INTO trips (id,owner,data) VALUES (?,?,?)').run('push-trip', 'bob', '{}');
  database.sqlite.prepare('INSERT INTO memberships (trip_id,user_id,member_id) VALUES (?,?,?)').run('push-trip', 'alice', 'traveller-a');
  await notifications.subscribe('alice', endpoint('expired'));
  const originalFetch = globalThis.fetch;
  const originalKey = environment.VAPID_PRIVATE_KEY;
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  environment.VAPID_PRIVATE_KEY = JSON.stringify(await crypto.subtle.exportKey('jwk', key.privateKey));
  try {
    globalThis.fetch = async () => new Response(null, { status: 410 });
    await notifications.notifyMembers('push-trip', 'bob', 'TripTab activity', 'Bob updated an expense.');
    await Promise.all(environment.pending);
    let events = await deviceEvents(database, 'alice');
    assert.equal(events.length, 2);
    assert.equal(events[0].source, 'system');
    assert.equal(events[0].actorName, 'TripTab system');
    assert.equal(events[0].after?.reason, 'provider_expired');
    assert.equal(rows(database).length, 0);

    await notifications.subscribe('alice', endpoint('replacement'));
    // Inbox timestamps otherwise throttle the second outbound push.
    database.sqlite.exec("UPDATE notifications SET created_at='2026-01-01T00:00:00Z'");
    environment.pending = [];
    globalThis.fetch = async () => {
      const row = database.sqlite.prepare('SELECT created_at FROM push_subscriptions WHERE endpoint=?').get(endpoint('replacement'))!;
      database.sqlite.prepare('UPDATE push_subscriptions SET generation=?,created_at=? WHERE endpoint=?').run('replacement-generation', row.created_at, endpoint('replacement'));
      return new Response(null, { status: 404 });
    };
    await notifications.notifyMembers('push-trip', 'bob', 'TripTab activity', 'Bob updated another expense.');
    await Promise.all(environment.pending);
    assert.equal(await notifications.ownsSubscription('alice', endpoint('replacement')), true);
    events = await deviceEvents(database, 'alice');
    assert.equal(events.length, 3, 'no false disable event for the replacement generation');
    assert.equal(events.filter(event => event.source === 'system').length, 1);
    assert.doesNotMatch(JSON.stringify(events), /replacement-generation|fcm\/send|https:\/\/|"endpoint"|"cookie"/i);
  } finally { globalThis.fetch = originalFetch; environment.VAPID_PRIVATE_KEY = originalKey; }
});

test('push redirects are not followed and do not expire the browser subscription', async context => {
  const database = await storage();
  database.sqlite.prepare('INSERT INTO trips (id,owner,data) VALUES (?,?,?)').run('push-trip', 'bob', '{}');
  database.sqlite.prepare('INSERT INTO memberships (trip_id,user_id,member_id) VALUES (?,?,?)').run('push-trip', 'alice', 'traveller-a');
  await notifications.subscribe('alice', endpoint('redirect'));
  const originalKey = environment.VAPID_PRIVATE_KEY;
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  environment.VAPID_PRIVATE_KEY = JSON.stringify(await crypto.subtle.exportKey('jwk', key.privateKey));
  let calls = 0, cancelled = false;
  context.mock.method(console, 'warn', () => {});
  context.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    calls++; assert.equal(String(url), endpoint('redirect')); assert.equal(init?.redirect, 'manual');
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 307, headers: { Location: 'https://attacker.invalid' } });
  });
  try {
    await notifications.notifyMembers('push-trip', 'bob', 'TripTab activity', 'Bob updated an expense.');
    await Promise.all(environment.pending);
    assert.equal(calls, 1); assert.equal(cancelled, true);
    assert.equal(await notifications.ownsSubscription('alice', endpoint('redirect')), true);
    assert.equal((await deviceEvents(database, 'alice')).length, 1, 'only the original opt-in is recorded');
  } finally { environment.VAPID_PRIVATE_KEY = originalKey; }
});

test('push ownership stays account-scoped and subscription cookies contain a hash, not an endpoint', async () => {
  const database = await storage();
  const subscribed = await pushRoute.POST(pushRequest('alice', 'subscribe'));
  assert.equal(subscribed.status, 200);
  const cookie = subscribed.headers.get('set-cookie')!;
  assert.match(cookie, /^tt_push=[a-f0-9]{64};/); assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.doesNotMatch(cookie, /fcm|browser-a/);
  const own = await pushRoute.POST(pushRequest('alice', 'status'));
  assert.equal((await own.json() as { ownsSubscription: boolean }).ownsSubscription, true);
  assert.match(own.headers.get('set-cookie')!, /^tt_push=[a-f0-9]{64};/, 'existing subscriptions gain a browser binding without opting a different account in');
  const foreign = await pushRoute.POST(pushRequest('bob', 'status'));
  const foreignData = await foreign.json() as Record<string, unknown>;
  assert.equal(foreignData.ownsSubscription, false); assert.equal(foreignData.userId, undefined); assert.equal(foreignData.owner, undefined);
  assert.match(foreign.headers.get('set-cookie')!, /^tt_push=;/);
  assert.equal((await pushRoute.POST(pushRequest('bob', 'subscribe'))).status, 409);
  assert.equal((await pushRoute.POST(pushRequest('bob', 'unsubscribe'))).status, 200);
  assert.equal(await notifications.ownsSubscription('alice', endpoint('browser-a')), true);
  assert.equal(rows(database).length, 1);
  assert.doesNotMatch(await notifications.browserPushCookie(new Request('http://127.0.0.1/api/push'), endpoint('browser-a')), /Secure/);
});

test('logout revokes only this browser endpoint before clearing its session and push cookie', async () => {
  const database = await storage();
  const account = await performAuthAction(new Request('https://triptab.test/api/auth'), { action: 'register', email: 'alice@example.test', displayName: 'Alice', password: 'valid testing password' }, database.asD1());
  const user = account.state.profile!.id;
  await notifications.subscribe(user, endpoint('browser-a'));
  await notifications.subscribe(user, endpoint('other-alice-device'));
  await notifications.subscribe('bob', endpoint('bob-device'));
  const cookie = `${account.cookie!.split(';')[0]}; ${(await notifications.browserPushCookie(new Request('https://triptab.test/api/push'), endpoint('browser-a'))).split(';')[0]}`;
  const response = await authRoute.POST(new Request('https://triptab.test/api/auth', { method: 'POST', headers: { origin: 'https://triptab.test', 'content-type': 'application/json', cookie }, body: JSON.stringify({ action: 'logout' }) }));
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { authenticated: boolean }).authenticated, false);
  assert.ok(response.headers.getSetCookie().some(value => /^tt_push=;/.test(value) && /Max-Age=0/.test(value)));
  assert.equal(await notifications.ownsSubscription(user, endpoint('browser-a')), false);
  assert.equal(await notifications.ownsSubscription(user, endpoint('other-alice-device')), true);
  assert.equal(await notifications.ownsSubscription('bob', endpoint('bob-device')), true);
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM auth_sessions').get()!.count, 0);
  const events = await deviceEvents(database, user);
  assert.equal(events.length, 3);
  assert.equal(events[0].after?.reason, 'logout_or_account_switch');
});

test('forged or duplicated push-binding cookies cannot revoke another account or every device', async () => {
  const database = await storage();
  await notifications.subscribe('alice', endpoint('alice-device'));
  await notifications.subscribe('bob', endpoint('bob-device'));
  const bobCookie = (await notifications.browserPushCookie(new Request('https://triptab.test/'), endpoint('bob-device'))).split(';')[0];
  await notifications.revokeBrowserPush(new Request('https://triptab.test/', { headers: { cookie: bobCookie } }), 'alice');
  assert.equal(rows(database).length, 2);
  const aliceCookie = (await notifications.browserPushCookie(new Request('https://triptab.test/'), endpoint('alice-device'))).split(';')[0];
  await notifications.revokeBrowserPush(new Request('https://triptab.test/', { headers: { cookie: `${aliceCookie}; ${aliceCookie}` } }), 'alice');
  assert.equal(rows(database).length, 2);
});

test('successful account switch revokes only the previous actor browser while a failed login preserves it', async () => {
  const database = await storage();
  const accountRequest = new Request('https://triptab.test/api/auth');
  const password = 'valid testing password';
  const alice = await performAuthAction(accountRequest, { action: 'register', email: 'alice@example.test', displayName: 'Alice', password }, database.asD1());
  const bob = await performAuthAction(accountRequest, { action: 'register', email: 'bob@example.test', displayName: 'Bob', password }, database.asD1());
  const aliceId = alice.state.profile!.id, bobId = bob.state.profile!.id;
  await notifications.subscribe(aliceId, endpoint('alice-current-browser'));
  await notifications.subscribe(aliceId, endpoint('other-alice-device'));
  await notifications.subscribe(bobId, endpoint('bob-own-browser'));
  const cookie = `${alice.cookie!.split(';')[0]}; ${(await notifications.browserPushCookie(accountRequest, endpoint('alice-current-browser'))).split(';')[0]}`;
  const login = (attempt: string) => new Request('https://triptab.test/api/auth', { method: 'POST', headers: { origin: 'https://triptab.test', 'content-type': 'application/json', cookie }, body: JSON.stringify({ action: 'login', email: 'bob@example.test', password: attempt }) });
  const failed = await authRoute.POST(login('incorrect testing password'));
  assert.equal(failed.status, 401);
  assert.equal(await notifications.ownsSubscription(aliceId, endpoint('alice-current-browser')), true);
  assert.equal(failed.headers.getSetCookie().length, 0);
  const succeeded = await authRoute.POST(login(password));
  assert.equal(succeeded.status, 200);
  assert.equal((await succeeded.json() as { profile: { id: string } }).profile.id, bobId);
  assert.ok(succeeded.headers.getSetCookie().some(value => /^tt_push=;/.test(value)));
  assert.equal(await notifications.ownsSubscription(aliceId, endpoint('alice-current-browser')), false);
  assert.equal(await notifications.ownsSubscription(aliceId, endpoint('other-alice-device')), true);
  assert.equal(await notifications.ownsSubscription(bobId, endpoint('bob-own-browser')), true);
  assert.equal((await deviceEvents(database, aliceId)).filter(event => event.action === 'delete').length, 1);
  assert.equal((await deviceEvents(database, aliceId))[0].after?.reason, 'logout_or_account_switch');
  assert.equal((await deviceEvents(database, bobId)).filter(event => event.action === 'delete').length, 0);
});

async function serviceWorkerPush(ownership: boolean | number | Error) {
  const handlers = new Map<string, (event: { waitUntil(value: Promise<unknown>): void }) => void>();
  const shown: unknown[][] = []; const fetched: string[] = [];
  let unsubscribed = 0; let closed = 0; let task: Promise<unknown> | undefined;
  const subscription = { endpoint: endpoint('browser-a'), async unsubscribe() { unsubscribed++; } };
  const registration = { pushManager: { async getSubscription() { return subscription; } }, async getNotifications() { return [{ close() { closed++; } }]; }, async showNotification(...args: unknown[]) { shown.push(args); } };
  const context = vm.createContext({ URL, Request, Response, AbortController, setTimeout, clearTimeout, self: { location: { origin: 'https://triptab.test' }, registration, addEventListener(name: string, fn: typeof handlers extends Map<string, infer F> ? F : never) { handlers.set(name, fn); } }, fetch: async (url: string) => {
    fetched.push(url);
    if (url === '/api/push') {
      if (ownership instanceof Error) throw ownership;
      return Response.json({ ownsSubscription: ownership === true }, { status: typeof ownership === 'number' ? ownership : 200 });
    }
    return Response.json({ notifications: [{ id: 'current-account-note', title: 'Current account update', body: 'Current account details', url: 'https://evil.test/' }] });
  } });
  vm.runInContext(await readFile(new URL('../public/sw.js', import.meta.url), 'utf8'), context);
  handlers.get('push')!({ waitUntil(value) { task = value; } });
  await task;
  return { shown, fetched, unsubscribed, closed };
}

test('service worker never fetches private notification text for a foreign or logged-out subscription', async () => {
  for (const ownership of [false, 401, new Error('offline')]) {
    const result = await serviceWorkerPush(ownership);
    assert.deepEqual(result.fetched, ['/api/push']); assert.equal(result.shown.length, 0);
    if (!(ownership instanceof Error)) { assert.equal(result.unsubscribed, 1); assert.equal(result.closed, 1); }
  }
  const own = await serviceWorkerPush(true);
  assert.deepEqual(own.fetched, ['/api/push', '/api/notifications']); assert.equal(own.shown.length, 1);
  assert.equal(own.shown[0][0], 'Current account update'); assert.equal((own.shown[0][1] as { data: { url: string } }).data.url, '/');
});

test('account-switch reconciliation resets a foreign native subscription and never opts in automatically', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalFetch = globalThis.fetch;
  let unsubscribed = 0; let closed = 0; let subscribed = 0;
  const registration = { pushManager: { async getSubscription() { return { endpoint: endpoint('previous-account'), async unsubscribe() { unsubscribed++; } }; }, async subscribe() { subscribed++; } }, async getNotifications() { return [{ close() { closed++; } }]; } };
  Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker: { async getRegistration() { return registration; } } }, configurable: true });
  globalThis.fetch = async () => Response.json({ ownsSubscription: false, publicKey: 'configured-key' });
  try {
    const result = await pwa.reconcileBrowserNotifications();
    assert.equal(result.owned, false); assert.equal(result.reset, true); assert.equal(unsubscribed, 1); assert.equal(closed, 1); assert.equal(subscribed, 0);
  } finally { globalThis.fetch = originalFetch; if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator); else Reflect.deleteProperty(globalThis, 'navigator'); }
});

test('a late ownership response cannot unsubscribe a newly approved account subscription', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalFetch = globalThis.fetch;
  let oldUnsubscribed = 0; let newUnsubscribed = 0;
  const previous = { endpoint: endpoint('previous-account'), async unsubscribe() { oldUnsubscribed++; } };
  const current = { endpoint: endpoint('current-account'), async unsubscribe() { newUnsubscribed++; } };
  let active = previous;
  const registration = { pushManager: { async getSubscription() { return active; } }, async getNotifications() { return []; } };
  Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker: { async getRegistration() { return registration; } } }, configurable: true });
  globalThis.fetch = async () => { active = current; return Response.json({ ownsSubscription: false }); };
  try {
    await pwa.reconcileBrowserNotifications();
    assert.equal(oldUnsubscribed, 1); assert.equal(newUnsubscribed, 0);
  } finally { globalThis.fetch = originalFetch; if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator); else Reflect.deleteProperty(globalThis, 'navigator'); }
});

test('expense notifications describe allocation edits with item names but no financial values', () => {
  const before = { items: [{ id: 'i', name: 'Secret restaurant', amount: 12345, members: ['a'], percentages: { a: 100 } }], percentages: { a: 100 } };
  const after = { items: [{ ...before.items[0], members: ['a', 'b'], percentages: { a: 50, b: 50 } }], percentages: { a: 50, b: 50 } };
  const message = notifications.activityNotification('Chris', [{ entityType: 'expense', action: 'update', before, after }])!;
  assert.equal(message.title, 'Expense split changed');
  assert.equal(message.body, 'Chris changed item splits and the receipt split · Secret restaurant.');
  assert.doesNotMatch(JSON.stringify(message), /12345|50|100/);
  const unchanged = notifications.activityNotification('Chris', [{ entityType: 'expense', action: 'update', before,
    after: { percentages: { a: 100 }, items: [{ percentages: { a: 100 }, members: ['a'], amount: 12345, name: 'Secret restaurant', id: 'i' }] } }])!;
  assert.equal(unchanged.body, 'Chris updated an expense.', 'key insertion order must not invent a split edit');
});

test('receipt additions and removals report item labels and counts without prices', () => {
  const before = { items: [{ id: 'old', name: 'Private coffee', amount: 875, members: ['a'] }] };
  const after = { items: Array.from({ length: 3 }, (_, index) => ({ id: `new-${index}`, name: 'Private food', amount: 725, members: ['a'] })) };
  const message = notifications.activityNotification('Chris', [{ entityType: 'expense', action: 'update', before, after }])!;
  assert.equal(message.title, 'Receipt items updated');
  assert.equal(message.body, 'Chris added 3 items and removed 1 item · Private food +3 items.');
  assert.doesNotMatch(JSON.stringify(message), /875|725/);
});

test('notification descriptions distinguish card conversions, payment timing and holiday dates', () => {
  const cases = [
    { entityType: 'expense', before: { bankAmount: 12345, fx: { rate: 0.86 } }, after: { bankAmount: 22222, fx: { rate: 0.87 } }, title: 'Conversion details updated', body: 'Chris changed conversion details on an expense.' },
    { entityType: 'payment', before: { amount: 12345, date: '2026-10-01', note: 'Private payment note' }, after: { amount: 22222, date: '2026-10-02', note: 'Private payment note' }, title: 'Payment updated', body: 'Chris changed the amount and the date on a payment.' },
    { entityType: 'trip', before: { startDate: '2026-10-01' }, after: { startDate: '2026-10-02' }, title: 'Holiday dates changed', body: 'Chris changed the holiday dates.' },
  ] as const;
  for (const example of cases) {
    const message = notifications.activityNotification('Chris', [{ entityType: example.entityType, action: 'update', before: example.before, after: example.after }])!;
    assert.equal(message.title, example.title);
    assert.equal(message.body, example.body);
    assert.doesNotMatch(JSON.stringify(message), /12345|22222|0\.8[67]|2026-10|Private/);
  }
});

test('chat notifications distinguish new item messages from existing-message edits and reorder', () => {
  const before = { conversation: [{ id: 'q', role: 'user', itemId: 'private-item', text: 'Secret question' }] };
  const message = notifications.activityNotification('Chris', [{ entityType: 'expense', action: 'update', before,
    after: { conversation: [...before.conversation, { id: 'r', role: 'assistant', itemId: 'private-item', text: 'Secret answer' }] } }])!;
  assert.equal(message.title, 'Item chat updated');
  assert.equal(message.body, 'Chris added a message to an item chat.');
  assert.doesNotMatch(JSON.stringify(message), /Secret|private-item/);
  const edited = notifications.activityNotification('Chris', [{ entityType: 'expense', action: 'update', before,
    after: { conversation: [{ ...before.conversation[0], text: 'Edited secret' }] } }])!;
  assert.equal(edited.body, 'Chris updated an item chat.');
  const reordered = notifications.activityNotification('Chris', [{ entityType: 'expense', action: 'update', before: { conversation: [{ id: 'a' }, { id: 'b' }] }, after: { conversation: [{ id: 'b' }, { id: 'a' }] } }])!;
  assert.equal(reordered.body, 'Chris updated a receipt chat.');
});

test('notifications for broad edits stay compact and retain the action after a long actor name', () => {
  const before = { items: [{ id: 'i', name: 'Secret', amount: 20, members: ['a'] }], payer: 'a', bankAmount: 20, tax: 0, title: 'Private', date: '2026-10-01' };
  const after = { items: [{ id: 'i', name: 'Other secret', amount: 30, members: ['b'] }], payer: 'b', bankAmount: 30, tax: 10, title: 'Other private', date: '2026-10-02' };
  const message = notifications.activityNotification('C'.repeat(500), [{ entityType: 'expense', action: 'update', before, after }])!;
  assert.equal(message.title, 'Other private');
  assert.match(message.body, /changed item splits and item prices and other details · Other secret\.$/);
  assert.ok(Array.from(message.title).length <= 50);
  assert.ok(Array.from(message.body).length <= 160);
});

test('joining notifications are concise, sanitized and do not imply an executed payment', () => {
  assert.deepEqual(notifications.joinedNotification('Chris'), { title: 'Traveller joined', body: 'Chris joined the holiday.' });
  assert.equal(notifications.joinedNotification(' \n\u202e ').body, 'A traveller joined the holiday.');
  assert.equal(notifications.joinedNotification('😀'.repeat(100)).body, `${'😀'.repeat(47)}… joined the holiday.`);
  assert.equal(notifications.activityNotification('Chris', [{ entityType: 'payment', action: 'create' }])!.body, 'Chris recorded a payment.');
});

test('cash-currency edits and unit-label edits do not claim a card conversion or a cost-share change', () => {
  const currency = notifications.activityNotification('Chris', [{ entityType: 'expense', action: 'update', before: { currency: 'EUR' }, after: { currency: 'GBP' } }])!;
  assert.deepEqual(currency, { title: 'Expense currency changed', body: 'Chris changed the expense currency on an expense.' });
  const item = { id: 'i', name: 'Secret drink', amount: 1200, members: ['a', 'b'], units: { total: 2, allocations: { a: 1, b: 1 }, label: 'glasses' } };
  const units = notifications.activityNotification('Chris', [{ entityType: 'expense', action: 'update', before: { items: [item] }, after: { items: [{ ...item, units: { ...item.units, label: 'bottles' } }] } }])!;
  assert.equal(units.title, 'Receipt quantities updated');
  assert.equal(units.body, 'Chris changed item quantity details · Secret drink.');
  assert.doesNotMatch(JSON.stringify(units), /split|glasses|bottles|1200/);
});

test('messages in different item threads report multiple chats without revealing context', () => {
  const message = notifications.activityNotification('Chris', [{ entityType: 'expense', action: 'update', before: { conversation: [] }, after: { conversation: [{ id: 'a', itemId: 'private-a', text: 'Private first question' }, { id: 'b', itemId: 'private-b', text: 'Private second question' }] } }])!;
  assert.equal(message.body, 'Chris added 2 messages to 2 item chats.');
  assert.doesNotMatch(JSON.stringify(message), /Private|private-[ab]/);
});

test('legacy assistant attribution cleanup does not invent a chat edit during a financial update', () => {
  const assistant = { id: 'r', role: 'assistant', text: 'Private answer', authorMemberId: 'a', authorName: 'Original owner' };
  const message = notifications.activityNotification('Chris', [{ entityType: 'expense', action: 'update', before: { tip: 0, conversation: [assistant] }, after: { tip: 100, conversation: [{ id: assistant.id, role: assistant.role, text: assistant.text }] } }])!;
  assert.deepEqual(message, { title: 'Receipt tip updated', body: 'Chris changed the tip on an expense.' });
});

test('named notifications retain holiday, receipt, affected item, editor and action', () => {
  const item = { id: 'i', name: 'Apfelstrudel', amount: 1600, members: ['a'], percentages: { a: 100 } };
  const message = notifications.activityNotification('Chris', [{ entityType: 'expense', action: 'update', before: { title: 'Café Mozart', items: [item] }, after: { title: 'Café Mozart', items: [{ ...item, members: ['a', 'b'], percentages: { a: 50, b: 50 } }] } }], { tripName: 'Austria weekend' })!;
  assert.deepEqual(message, { title: 'Austria weekend · Café Mozart', body: 'Chris changed item splits · Apfelstrudel.' });
  assert.doesNotMatch(JSON.stringify(message), /1600|100|50/);
});

test('renamed and removed items keep the correct saved name in notification context', () => {
  const item = { id: 'i', name: 'Old label', amount: 900, members: ['a'] };
  const renamed = notifications.activityNotification('Chris', [{ entityType: 'expense', action: 'update', before: { title: 'Lunch', items: [item] }, after: { title: 'Lunch', items: [{ ...item, name: 'New label' }] } }], { tripName: 'Vienna' })!;
  assert.equal(renamed.title, 'Vienna · Lunch');
  assert.equal(renamed.body, 'Chris changed item descriptions · New label.');
  const removed = notifications.activityNotification('Chris', [{ entityType: 'expense', action: 'update', before: { title: 'Lunch', items: [item] }, after: { title: 'Lunch', items: [] } }], { tripName: 'Vienna' })!;
  assert.equal(removed.body, 'Chris removed 1 item · Old label.');
  const receipt = notifications.activityNotification('Chris', [{ entityType: 'expense', action: 'delete', before: { title: 'Lunch', items: [item] }, after: null }], { tripName: 'Vienna' })!;
  assert.deepEqual(receipt, { title: 'Vienna · Lunch', body: 'Chris removed an expense · Old label.' });
});

test('receipt-wide changes and item reorders never name an unrelated item', () => {
  const items = [{ id: 'a', name: 'Strudel', amount: 100, members: ['a'] }, { id: 'b', name: 'Coffee', amount: 200, members: ['a'] }];
  const tip = notifications.activityNotification('Chris', [{ entityType: 'expense', action: 'update', before: { title: 'Lunch', tip: 0, items }, after: { title: 'Lunch', tip: 100, items } }], { tripName: 'Vienna' })!;
  assert.deepEqual(tip, { title: 'Vienna · Lunch', body: 'Chris changed the tip.' });
  const reordered = notifications.activityNotification('Chris', [{ entityType: 'expense', action: 'update', before: { title: 'Lunch', items }, after: { title: 'Lunch', items: [...items].reverse() } }], { tripName: 'Vienna' })!;
  assert.equal(reordered.body, 'Chris changed receipt items.');
  assert.doesNotMatch(JSON.stringify(tip) + JSON.stringify(reordered), /Strudel|Coffee/);
});

test('multiple items and receipts retain one representative label and truthful counts', () => {
  const items = [{ id: 'a', name: 'Strudel', amount: 100, members: ['a'] }, { id: 'b', name: 'Coffee', amount: 200, members: ['a'] }];
  const first = { entityType: 'expense' as const, action: 'update' as const, before: { title: 'Lunch', items }, after: { title: 'Lunch', items: items.map(item => ({ ...item, amount: item.amount + 100 })) } };
  const single = notifications.activityNotification('Chris', [first], { tripName: 'Vienna' })!;
  assert.equal(single.body, 'Chris changed item prices · Strudel +1 item.');
  const batch = notifications.activityNotification('Chris', [{ entityType: 'trip', action: 'update' }, first, { entityType: 'expense', action: 'update', before: { title: 'Dinner' }, after: { title: 'Dinner' } }], { tripName: 'Vienna' })!;
  assert.equal(batch.title, 'Vienna · Lunch +1 receipt');
  assert.match(batch.body, /^Chris updated 2 expenses and updated the holiday details · Strudel \+1 item\.$/);
});

test('item-chat edits resolve the affected item by ID and never include message text', () => {
  const items = [{ id: 'a', name: 'Strudel', amount: 100, members: ['a'] }, { id: 'b', name: 'Coffee', amount: 200, members: ['a'] }];
  const oldMessage = { id: 'q', role: 'user', itemId: 'b', text: 'Private question' };
  const message = notifications.activityNotification('Chris', [{ entityType: 'expense', action: 'update', before: { title: 'Lunch', items, conversation: [oldMessage] }, after: { title: 'Lunch', items, conversation: [{ ...oldMessage, text: 'Private correction' }] } }], { tripName: 'Vienna' })!;
  assert.equal(message.body, 'Chris updated an item chat · Coffee.');
  assert.doesNotMatch(JSON.stringify(message), /Private|Strudel|itemId/);
});

test('long context labels are independently shortened without hiding the editor, action or item', () => {
  const item = { id: 'i', name: 'I'.repeat(200), amount: 100, members: ['a'] };
  const message = notifications.activityNotification(`\u202eE${'d'.repeat(200)}\n`, [{ entityType: 'expense', action: 'update', before: { title: 'R'.repeat(200), items: [item] }, after: { title: 'R'.repeat(200), items: [{ ...item, amount: 200 }] } }], { tripName: 'T'.repeat(200) })!;
  assert.equal(message.title, `${'T'.repeat(21)}… · ${'R'.repeat(24)}…`);
  assert.match(message.body, /^Ed+… changed item prices · I+…\.$/);
  assert.ok(Array.from(message.title).length <= 50);
  assert.ok(Array.from(message.body).length <= 160);
  assert.doesNotMatch(message.body, /[\n\u202e]/);
  const emoji = notifications.activityNotification('😀'.repeat(100), [{ entityType: 'expense', action: 'update', before: { title: '🍽'.repeat(100), items: [item] }, after: { title: '🍽'.repeat(100), items: [{ ...item, name: '🍫'.repeat(100) }] } }], { tripName: '🌍'.repeat(100) })!;
  assert.ok(Array.from(emoji.title).length <= 50); assert.ok(Array.from(emoji.body).length <= 160);
  assert.ok(emoji.title.length <= 100); assert.ok(emoji.body.length <= 240);
  assert.match(emoji.body, /changed item descriptions/);
});

test('named receipt replies retain saved author routing and identify the actual assistant', async () => {
  const database = await storage();
  database.sqlite.prepare('INSERT INTO trips (id,owner,data) VALUES (?,?,?)').run('named-trip', 'bob', '{}');
  database.sqlite.prepare('INSERT INTO memberships (trip_id,user_id,member_id) VALUES (?,?,?)').run('named-trip', 'alice', 'author-a');
  database.sqlite.prepare('INSERT INTO memberships (trip_id,user_id,member_id) VALUES (?,?,?)').run('named-trip', 'bob', 'caller-b');
  await notifications.notifyReceiptReply('named-trip', 'bob', 'author-a', 'item', { tripName: 'Vienna', receiptName: 'Café Mozart', itemName: 'Apfelstrudel' });
  await Promise.all(environment.pending);
  const inbox = await notifications.latestNotifications('alice');
  assert.equal(inbox[0].title, 'Vienna · Café Mozart');
  assert.equal(inbox[0].body, 'ChatGPT or Codex replied in item chat · Apfelstrudel.');
  assert.deepEqual(await notifications.latestNotifications('bob'), []);
  assert.deepEqual(notifications.joinedNotification('Chris', 'Vienna'), { title: 'Vienna', body: 'Chris joined the holiday.' });
});

test('a batch chooses an available affected item with its own receipt rather than an unrelated receipt', () => {
  const item = { id: 'i', name: 'Strudel', amount: 100, members: ['a'] };
  const message = notifications.activityNotification('Chris', [
    { entityType: 'expense', action: 'update', before: { title: 'Breakfast', tip: 0, items: [item] }, after: { title: 'Breakfast', tip: 100, items: [item] } },
    { entityType: 'expense', action: 'update', before: { title: 'Dessert', items: [item] }, after: { title: 'Dessert', items: [{ ...item, amount: 200 }] } },
  ], { tripName: 'Vienna' })!;
  assert.deepEqual(message, { title: 'Vienna · Dessert +1 receipt', body: 'Chris updated 2 expenses · Strudel.' });
});
