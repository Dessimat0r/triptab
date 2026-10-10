import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { storage, type SQLiteD1 } from './helpers/sqlite-d1';
import { saveNotificationPreferences } from '../lib/notification-preferences';
import * as audit from '../lib/audit';
import * as data from '../lib/data-utils';
import * as model from '../lib/model';
import * as money from '../lib/money-format';
const require = createRequire(import.meta.url);
class RequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
async function notifications(database: SQLiteD1) {
  const loaded = { exports: {} as typeof import('../lib/notifications') };
  const source = transpileModule(
    await readFile(new URL('../lib/notifications.ts', import.meta.url), 'utf8'),
    {
      compilerOptions: {
        module: ModuleKind.CommonJS,
        target: ScriptTarget.ES2022,
      },
    },
  ).outputText;
  new Function('require', 'module', 'exports', source)(
    (name: string) => {
      if (name === 'cloudflare:workers')
        return {
          env: {},
          waitUntil() {
            throw Error('No worker scope');
          },
        };
      if (name === './store')
        return { db: () => database.asD1(), RequestError };
      if (name === './audit') return audit;
      if (name === './data-utils') return data;
      return require(name);
    },
    loaded,
    loaded.exports,
  );
  return loaded.exports;
}
async function reminder(database: SQLiteD1, actorId: string) {
  const loaded = {
    exports: {} as { POST(request: Request): Promise<Response> },
  };
  const source = transpileModule(
    await readFile(
      new URL('../app/api/remind/route.ts', import.meta.url),
      'utf8',
    ),
    {
      compilerOptions: {
        module: ModuleKind.CommonJS,
        target: ScriptTarget.ES2022,
      },
    },
  ).outputText;
  new Function('require', 'module', 'exports', source)(
    (name: string) => {
      if (name === '@/lib/store')
        return {
          db: () => database.asD1(),
          ensureProfile: async () => ({ id: actorId, displayName: actorId }),
          readBoundedBody: async (request: Request) =>
            new Uint8Array(await request.arrayBuffer()),
          RequestError,
          sameOrigin(request: Request) {
            if (request.headers.get('origin') !== new URL(request.url).origin)
              throw new RequestError('Origin', 403);
          },
          failure: (error: RequestError) =>
            Response.json(
              { error: error.message },
              { status: error.status || 400 },
            ),
        };
      if (name === '@/lib/model') return model;
      if (name === '@/lib/money-format') return money;
      if (name === '@/lib/notifications')
        return { notifyAccountPush: async () => {} };
      return require(name);
    },
    loaded,
    loaded.exports,
  );
  return loaded.exports;
}
async function fixture() {
  const database = await storage();
  for (const id of ['alice', 'bob', 'carol'])
    database.sqlite
      .prepare(
        'INSERT INTO profiles(id,email,display_name,created_at) VALUES(?,?,?,?)',
      )
      .run(id, `${id}@example.test`, id, '2026-10-10T00:00:00Z');
  const trip: model.Trip = {
    id: 'trip',
    ownerId: 'alice',
    name: 'Prague',
    currency: 'GBP',
    members: ['alice', 'bob', 'carol'].map((id) => ({
      id,
      name: id,
      userId: id,
    })),
    expenses: [
      {
        id: 'meal',
        title: 'Dinner',
        date: '2026-10-10',
        time: '20:30',
        timezone: 'Europe/Prague',
        currency: 'GBP',
        payer: 'alice',
        items: [
          {
            id: 'line',
            name: 'Dinner',
            amount: 2000,
            members: ['alice', 'bob'],
          },
        ],
        tax: 0,
        tip: 0,
        discount: 0,
      },
    ],
    payments: [],
    drafts: [],
  };
  database.sqlite
    .prepare('INSERT INTO trips(id,owner,data) VALUES(?,?,?)')
    .run(trip.id, 'alice', JSON.stringify(trip));
  for (const id of ['alice', 'bob', 'carol'])
    database.sqlite
      .prepare(
        'INSERT INTO memberships(trip_id,user_id,member_id) VALUES(?,?,?)',
      )
      .run(trip.id, id, id);
  return { database, trip };
}

test('involved-only updates filter recipients and a daily digest replaces immediate inbox entries', async () => {
  const { database } = await fixture();
  await saveNotificationPreferences(
    database.asD1(),
    { id: 'bob', displayName: 'Bob' },
    { scope: 'involved', delivery: 'daily', reminders: true },
  );
  await saveNotificationPreferences(
    database.asD1(),
    { id: 'carol', displayName: 'Carol' },
    { scope: 'involved', delivery: 'immediate', reminders: true },
  );
  const delivery = await notifications(database);
  await delivery.notifyMembers('trip', 'alice', 'Dinner saved', 'Updated', [
    'alice',
    'bob',
  ]);
  assert.equal(
    database.sqlite.prepare('SELECT COUNT(*) AS n FROM notifications').get()?.n,
    0,
  );
  assert.equal(
    database.sqlite.prepare('SELECT updates FROM notification_digests').get()
      ?.updates,
    1,
  );
  await delivery.notifyMembers('trip', 'alice', 'Dinner changed', 'Updated', [
    'alice',
    'bob',
  ]);
  assert.equal(
    database.sqlite.prepare('SELECT updates FROM notification_digests').get()
      ?.updates,
    2,
  );
  assert.equal(await delivery.flushNotificationDigests(database.asD1()), 0);
  database.sqlite
    .prepare(
      "UPDATE notification_digests SET created_at='2000-01-01T00:00:00Z'",
    )
    .run();
  assert.equal(await delivery.flushNotificationDigests(database.asD1()), 1);
  assert.equal(await delivery.flushNotificationDigests(database.asD1()), 0);
  assert.equal(
    database.sqlite.prepare('SELECT user_id FROM notifications').get()?.user_id,
    'bob',
  );
});
test('changing preferences clears pending digests and opted-out accounts receive no holiday updates', async () => {
  const { database } = await fixture();
  const delivery = await notifications(database);
  await saveNotificationPreferences(
    database.asD1(),
    { id: 'bob', displayName: 'Bob' },
    { scope: 'all', delivery: 'daily', reminders: true },
  );
  await delivery.notifyMembers('trip', 'alice', 'Update', 'Updated');
  await saveNotificationPreferences(
    database.asD1(),
    { id: 'bob', displayName: 'Bob' },
    { scope: 'none', delivery: 'none', reminders: false },
  );
  assert.equal(
    database.sqlite
      .prepare('SELECT COUNT(*) AS n FROM notification_digests')
      .get()?.n,
    0,
  );
  database.sqlite.exec('DELETE FROM notifications');
  await delivery.notifyMembers('trip', 'alice', 'Update', 'Updated');
  assert.deepEqual(
    database.sqlite
      .prepare('SELECT user_id FROM notifications')
      .all()
      .map((row) => row.user_id),
    ['carol'],
  );
});
test('settlement reminders require the exact current transfer, creditor access and a connected debtor, with daily throttling', async () => {
  const { database } = await fixture();
  const post = (amount = 1000, origin = 'https://triptab.test') =>
    new Request('https://triptab.test/api/remind', {
      method: 'POST',
      headers: { origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tripId: 'trip',
        from: 'bob',
        to: 'alice',
        amount,
      }),
    });
  const alice = await reminder(database, 'alice'),
    carol = await reminder(database, 'carol');
  assert.equal((await carol.POST(post())).status, 403);
  assert.equal((await alice.POST(post(999))).status, 409);
  assert.equal(
    (await alice.POST(post(1000, 'https://other.test'))).status,
    403,
  );
  assert.equal((await alice.POST(post())).status, 200);
  assert.equal((await alice.POST(post())).status, 429);
  assert.equal(
    database.sqlite.prepare('SELECT COUNT(*) AS n FROM notifications').get()?.n,
    1,
  );
  database.sqlite.exec('DELETE FROM settlement_reminders');
  await saveNotificationPreferences(
    database.asD1(),
    { id: 'bob', displayName: 'Bob' },
    { scope: 'all', delivery: 'immediate', reminders: false },
  );
  assert.equal((await alice.POST(post())).status, 400);
  assert.equal(
    database.sqlite.prepare('SELECT COUNT(*) AS n FROM notifications').get()?.n,
    1,
  );
});
