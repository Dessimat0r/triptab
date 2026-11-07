import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { storage, type SQLiteD1, type SQLiteStatement } from './helpers/sqlite-d1';
import { ModuleKind, ScriptTarget } from 'typescript';
import { transpileWithSharedImports } from './helpers/transpile';

/**
 * N01 verification, second pass: the push and daily-digest boundaries. #79
 * guards the inbox and digest writes; the brief warns that fixing the inbox
 * insert does not by itself fix every delivery channel. Here the recipient is
 * eligible when the inbox row is committed and becomes ineligible before the
 * wake-up push is sent. Push stays content-free; it must not be sent at all.
 */
const asModule = (source: string) => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const fixture = { database: null as SQLiteD1 | null, pending: [] as Promise<unknown>[], env: {} as Record<string, string>, afterInbox: null as null | (() => void) };
Object.assign(globalThis, { __triptabN01Push: fixture });
const envModule = asModule('const f=globalThis.__triptabN01Push; export const env=f.env; export const waitUntil=p=>f.pending.push(p);');
const storeModule = asModule('export const db=()=>globalThis.__triptabN01Push.database; export class RequestError extends Error{};');
const code = transpileWithSharedImports(await readFile(new URL('../lib/notifications.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 }, sharedImportOverrides: { 'cloudflare:workers': envModule, './store': storeModule } }).outputText;
const notifications = await import(asModule(code)) as typeof import('../lib/notifications');
const endpoint = 'https://fcm.googleapis.com/fcm/send/bob-device';

async function seed(preferences?: { delivery?: string }) {
  const database = await storage(), now = new Date().toISOString();
  for (const [id, name] of [['alice', 'Alice'], ['bob', 'Bob']]) database.sqlite.prepare('INSERT INTO profiles(id,email,display_name,created_at) VALUES(?,?,?,?)').run(id, `${id}@example.test`, name, now);
  const trip = { id: 'secret', name: 'Secret treatment visit', currency: 'GBP', members: [{ id: 'a', name: 'Alice' }, { id: 'b', name: 'Bob' }], expenses: [], payments: [], drafts: [] };
  database.sqlite.prepare('INSERT INTO trips(id,owner,data) VALUES(?,?,?)').run(trip.id, 'alice', JSON.stringify(trip));
  database.sqlite.prepare('INSERT INTO memberships(trip_id,user_id,member_id) VALUES(?,?,?)').run(trip.id, 'alice', 'a');
  database.sqlite.prepare('INSERT INTO memberships(trip_id,user_id,member_id) VALUES(?,?,?)').run(trip.id, 'bob', 'b');
  database.sqlite.prepare('INSERT INTO push_subscriptions(endpoint,user_id,created_at,generation) VALUES(?,?,?,?)').run(endpoint, 'bob', now, 1);
  if (preferences) database.sqlite.prepare('INSERT INTO notification_preferences(user_id,delivery) VALUES(?,?)').run('bob', preferences.delivery);
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  fixture.env.VAPID_PUBLIC_KEY = 'a'.repeat(87);
  fixture.env.VAPID_PRIVATE_KEY = JSON.stringify(await crypto.subtle.exportKey('jwk', key.privateKey));
  fixture.pending = []; fixture.afterInbox = null;
  fixture.database = new Proxy(database, { get(target, property) {
    if (property === 'batch') return async (statements: SQLiteStatement[]) => {
      const result = await target.batch(statements);
      // The inbox/digest write has committed; the wake-up push has not yet been admitted.
      if (statements.some(statement => /INSERT INTO (notifications|notification_digests)/.test(statement.sql)) && fixture.afterInbox) { const run = fixture.afterInbox; fixture.afterInbox = null; run(); }
      return result;
    };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return database;
}

/** The digest flush receives its own D1 handle; run the same after-write hook on it. */
function hookedD1(database: SQLiteD1) {
  const d1 = database.asD1();
  return new Proxy(d1, { get(target, property) {
    if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
      const result = await target.batch(statements);
      if (fixture.afterInbox) { const run = fixture.afterInbox; fixture.afterInbox = null; run(); }
      return result;
    };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
}

const disruptions: Record<string, (d: SQLiteD1) => void> = {
  'the recipient leaves the trip': d => d.sqlite.prepare("DELETE FROM memberships WHERE trip_id='secret' AND user_id='bob'").run(),
  'the recipient account is deleted': d => d.sqlite.prepare("UPDATE profiles SET deleted_at=? WHERE id='bob'").run(new Date().toISOString()),
  'the recipient turns trip notifications off': d => d.sqlite.prepare("INSERT INTO notification_preferences(user_id,scope) VALUES('bob','none') ON CONFLICT(user_id) DO UPDATE SET scope='none'").run(),
  'the recipient turns delivery off': d => d.sqlite.prepare("INSERT INTO notification_preferences(user_id,delivery) VALUES('bob','none') ON CONFLICT(user_id) DO UPDATE SET delivery='none'").run(),
  'the recipient switches to a daily summary': d => d.sqlite.prepare("INSERT INTO notification_preferences(user_id,delivery) VALUES('bob','daily') ON CONFLICT(user_id) DO UPDATE SET delivery='daily'").run(),
  'the trip is deleted': d => d.sqlite.prepare("UPDATE trips SET owner='deleted:alice' WHERE id='secret'").run(),
};

async function immediate(context: { mock: { method: (...args: never[]) => unknown } }, disrupt?: (d: SQLiteD1) => void) {
  const database = await seed();
  const sent: string[] = [];
  (context.mock.method as unknown as (o: object, n: string, f: (url: string | URL | Request, init?: RequestInit) => Promise<Response>) => void)(globalThis, 'fetch', async (url, init) => {
    sent.push(String(url)); assert.equal(init?.body, '', 'push is a content-free wake-up'); return new Response(null, { status: 201 });
  });
  if (disrupt) fixture.afterInbox = () => disrupt(database);
  await notifications.notifyMembers('secret', 'alice', 'Secret treatment visit', 'Alice added private receipt Oncology consultation in Secret treatment visit.');
  await Promise.all(fixture.pending);
  const inbox = database.sqlite.prepare("SELECT title,body FROM notifications WHERE user_id='bob'").all() as Array<{ title: string; body: string }>;
  return { sent, inbox, database };
}

test('N01 push control: an eligible recipient gets one inbox entry and one content-free push', async context => {
  const result = await immediate(context as never);
  assert.deepEqual(result.sent, [endpoint]);
  assert.equal(result.inbox.length, 1);
});

for (const [name, disrupt] of Object.entries(disruptions)) test(`N01 push boundary: no push is sent when ${name} after the inbox write`, async context => {
  const result = await immediate(context as never, disrupt);
  assert.deepEqual(result.sent, [], 'ineligible at dispatch: nothing leaves the server');
});

test('N01 digest push: an eligible daily recipient is summarised once with one content-free push', async context => {
  const database = await seed({ delivery: 'daily' });
  database.sqlite.prepare("INSERT INTO notification_digests(user_id,trip_id,updates,created_at) VALUES('bob','secret',3,?)").run('2020-01-01T00:00:00.000Z');
  const sent: string[] = [];
  (context.mock.method as unknown as (o: object, n: string, f: () => Promise<Response>) => void)(globalThis, 'fetch', async () => { sent.push('push'); return new Response(null, { status: 201 }); });
  assert.equal(await notifications.flushNotificationDigests(hookedD1(database), Date.now()), 1);
  assert.deepEqual(sent, ['push']);
  assert.equal((database.sqlite.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id='bob'").get() as { n: number }).n, 1);
  assert.equal(await notifications.flushNotificationDigests(hookedD1(database), Date.now()), 0, 'a delivered digest is not repeated');
});

for (const name of ['the recipient leaves the trip', 'the recipient account is deleted', 'the recipient turns delivery off'] as const) test(`N01 digest push boundary: no push when ${name} after the summary is stored`, async context => {
  const database = await seed({ delivery: 'daily' });
  database.sqlite.prepare("INSERT INTO notification_digests(user_id,trip_id,updates,created_at) VALUES('bob','secret',3,?)").run('2020-01-01T00:00:00.000Z');
  const sent: string[] = [];
  (context.mock.method as unknown as (o: object, n: string, f: () => Promise<Response>) => void)(globalThis, 'fetch', async () => { sent.push('push'); return new Response(null, { status: 201 }); });
  fixture.afterInbox = () => disruptions[name](database);
  await notifications.flushNotificationDigests(hookedD1(database), Date.now());
  assert.equal((database.sqlite.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id='bob'").get() as { n: number }).n, 1, 'the summary was committed while the recipient was eligible');
  assert.deepEqual(sent, [], 'ineligible at dispatch: no wake-up push');
});
