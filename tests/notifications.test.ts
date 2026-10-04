import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import vm from 'node:vm';
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { performAuthAction } from '../lib/auth';

class Statement {
  private values: (string | number | null)[] = [];
  constructor(private sqlite: DatabaseSync, private sql: string) {}
  bind(...values: (string | number | null)[]) { this.values = values; return this; }
  async first<T>() { return this.sqlite.prepare(this.sql).get(...this.values) as T | undefined ?? null; }
  async all<T>() { return { results: this.sqlite.prepare(this.sql).all(...this.values) as T[] }; }
  async run() {
    const prepared = this.sqlite.prepare(this.sql);
    const results = prepared.columns().length ? prepared.all(...this.values) : (prepared.run(...this.values), []);
    return { results, meta: { changes: Number(this.sqlite.prepare('SELECT changes() AS count').get()!.count) } };
  }
}
class SQLiteD1 {
  sqlite = new DatabaseSync(':memory:');
  prepare(sql: string) { return new Statement(this.sqlite, sql); }
  async batch(statements: Statement[]) {
    this.sqlite.exec('BEGIN');
    try { const results = []; for (const statement of statements) results.push(await statement.run()); this.sqlite.exec('COMMIT'); return results; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  asD1() { return this as unknown as D1Database; }
}
class RequestError extends Error { constructor(message: string, public status = 400) { super(message); } }
const environment: { database?: SQLiteD1; VAPID_PUBLIC_KEY: string; VAPID_PRIVATE_KEY: string } = { VAPID_PUBLIC_KEY: 'a'.repeat(87), VAPID_PRIVATE_KEY: 'unused-fixture-key' };
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
const envURL = 'data:text/javascript;base64,' + Buffer.from("export const env=globalThis[Symbol.for('triptab.notifications-test-env')]; export const waitUntil=()=>{};").toString('base64');
const storeURL = 'data:text/javascript;base64,' + Buffer.from(`const store=globalThis[Symbol.for('triptab.notifications-test-store')];${Object.keys(store).map(name => `export const ${name}=store.${name};`).join('\n')}`).toString('base64');
function compile(source: string) { return transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022, jsx: JsxEmit.ReactJSX } }).outputText; }
function dataURL(source: string) { return 'data:text/javascript;base64,' + Buffer.from(source).toString('base64'); }
const notificationURL = dataURL(compile(await readFile(new URL('../lib/notifications.ts', import.meta.url), 'utf8')).replace("'cloudflare:workers'", JSON.stringify(envURL)).replace("'./store'", JSON.stringify(storeURL)));
const notifications = await import(notificationURL) as typeof import('../lib/notifications');
const pushURL = dataURL(compile(await readFile(new URL('../app/api/push/route.ts', import.meta.url), 'utf8')).replace("'@/lib/store'", JSON.stringify(storeURL)).replace("'@/lib/notifications'", JSON.stringify(notificationURL)).replace("'zod'", JSON.stringify(import.meta.resolve('zod'))));
const pushRoute = await import(pushURL) as typeof import('../app/api/push/route');
const authURL = dataURL(compile(await readFile(new URL('../app/api/auth/route.ts', import.meta.url), 'utf8')).replace("'@/lib/store'", JSON.stringify(storeURL)).replace("'@/lib/notifications'", JSON.stringify(notificationURL)).replace("'@/lib/auth'", JSON.stringify(new URL('../lib/auth.ts', import.meta.url).href)));
const authRoute = await import(authURL) as typeof import('../app/api/auth/route');
const pwaURL = dataURL(compile(await readFile(new URL('../components/pwa-controls.tsx', import.meta.url), 'utf8'))
  .replace('"react"', JSON.stringify(import.meta.resolve('react'))).replace('"lucide-react"', JSON.stringify(import.meta.resolve('lucide-react')))
  .replace('"react/jsx-runtime"', JSON.stringify(import.meta.resolve('react/jsx-runtime'))));
const pwa = await import(pwaURL) as typeof import('../components/pwa-controls');

async function storage() {
  const database = new SQLiteD1();
  for (const name of ['0001_regular_maginty.sql', '0002_windy_cammi.sql']) database.sqlite.exec(await readFile(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'));
  environment.database = database;
  return database;
}
const endpoint = (name: string) => `https://fcm.googleapis.com/fcm/send/${name}`;
function pushRequest(user: string, mode: string, value = endpoint('browser-a')) {
  return new Request('https://triptab.test/api/push', { method: 'POST', headers: { origin: 'https://triptab.test', 'content-type': 'application/json', 'x-test-user': user }, body: JSON.stringify({ mode, endpoint: value }) });
}
function rows(database: SQLiteD1) { return database.sqlite.prepare('SELECT endpoint,user_id FROM push_subscriptions ORDER BY endpoint').all(); }

test('activity wording handles singular, plural and mixed edits without exposing holiday contents', () => {
  const examples = [
    { events: [{ entityType: 'expense', action: 'update' }], words: 'Bob updated an expense.' },
    { events: [{ entityType: 'payment', action: 'create' }], words: 'Bob added a payment.' },
    { events: [{ entityType: 'member', action: 'delete' }], words: 'Bob removed a traveller.' },
    { events: [{ entityType: 'expense', action: 'create' }, { entityType: 'expense', action: 'create' }], words: 'Bob added 2 expenses.' },
    { events: [{ entityType: 'payment', action: 'delete' }, { entityType: 'payment', action: 'delete' }], words: 'Bob removed 2 payments.' },
    { events: [{ entityType: 'member', action: 'update' }, { entityType: 'member', action: 'update' }], words: 'Bob updated 2 travellers.' },
    { events: [{ entityType: 'expense', action: 'create' }, { entityType: 'expense', action: 'delete' }], words: 'Bob changed 2 expenses.' },
    { events: [{ entityType: 'member', action: 'update' }, { entityType: 'expense', action: 'update' }, { entityType: 'payment', action: 'create' }], words: 'Bob updated this holiday.' },
    { events: [{ entityType: 'trip', action: 'update' }], words: 'Bob updated the holiday details.' },
  ] as const;
  for (const example of examples) {
    const changes = example.events.map(event => ({ ...event, before: { name: 'Secret holiday', title: 'Private receipt', amount: 12345 }, after: { name: 'Secret holiday', note: 'Private payment' } }));
    const message = notifications.activityNotification('Bob', changes)!;
    assert.equal(message.title, 'TripTab activity');
    assert.equal(message.body, `${example.words} Open TripTab to review the activity.`);
    assert.doesNotMatch(JSON.stringify(message), /Secret holiday|Private receipt|Private payment|12345/);
  }
});

test('activity wording suppresses draft-only changes and preserves complete copy at actor-name boundaries', () => {
  assert.equal(notifications.activityNotification('Bob', []), null);
  assert.equal(notifications.activityNotification('Bob', [{ entityType: 'draft', action: 'update' }]), null);
  const substantive = notifications.activityNotification('Bob', [{ entityType: 'draft', action: 'create' }, { entityType: 'expense', action: 'update' }])!;
  assert.match(substantive.body, /^Bob updated an expense\./);
  assert.match(notifications.activityNotification(' \n\t ', [{ entityType: 'expense', action: 'update' }])!.body, /^A traveller updated an expense\./);
  assert.match(notifications.activityNotification(' Bob\u0000\n Smith ', [{ entityType: 'payment', action: 'create' }])!.body, /^Bob Smith added a payment\./);
  const long = notifications.activityNotification('B'.repeat(300), [{ entityType: 'expense', action: 'update' }])!;
  assert.equal(long.body, `${'B'.repeat(80)} updated an expense. Open TripTab to review the activity.`);
  assert.ok(long.body.length <= 240);
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
