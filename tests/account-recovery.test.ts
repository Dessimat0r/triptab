import assert from 'node:assert/strict';
import test from 'node:test';
import { storage } from './helpers/sqlite-d1';
import {
  performAuthAction,
  readAuthState,
  hashToken,
  resolveIdentity,
} from '../lib/auth';
import {
  accountSessions,
  revokeAccountSession,
  deleteAccount,
} from '../lib/account-security';
import {
  setTripArchived,
  listArchivedTrips,
  leaveTrip,
  transferTripOwnership,
  deleteTrip,
} from '../lib/trip-lifecycle';
import {
  saveNotificationPreferences,
  readNotificationPreferences,
} from '../lib/notification-preferences';
import type { EmailMessage } from '../lib/email';
import type { Trip } from '../lib/model';
const password = 'suitcase coffee 2026';
const request = (cookie = '', extra: Record<string, string> = {}) =>
  new Request('https://triptab.test/api/auth', {
    headers: {
      'cf-connecting-ip': '203.0.113.99',
      ...(cookie ? { cookie: cookie.split(';')[0] } : {}),
      ...extra,
    },
  });
async function account(
  database: Awaited<ReturnType<typeof storage>>,
  email = 'alice@example.test',
  messages: EmailMessage[] = [],
) {
  return performAuthAction(
    request(),
    { action: 'register', email, password, displayName: email.split('@')[0] },
    database.asD1(),
    {
      mailer: async (message) => {
        messages.push(message);
      },
    },
  );
}
const token = (message: EmailMessage) =>
  new URL(message.text.match(/https:\/\/\S+/)![0]).hash.split('=')[1];

test('registration keeps the interface language selected before signing up', async () => {
  const database = await storage();
  for (const uiLanguage of ['es', 'fr', 'de']) {
    const created = await performAuthAction(request(), {
      action: 'register', email: `${uiLanguage}@example.test`, password, displayName: 'Alice', uiLanguage,
    }, database.asD1());
    assert.equal(created.state.profile?.uiLanguage, uiLanguage);
    const signedIn = await performAuthAction(request(), {
      action: 'login', email: `${uiLanguage}@example.test`, password,
    }, database.asD1());
    assert.equal(signedIn.state.profile?.uiLanguage, uiLanguage);
  }
  await assert.rejects(performAuthAction(request(), {
    action: 'register', email: 'unsupported@example.test', password, displayName: 'Alice', uiLanguage: 'unsupported',
  }, database.asD1()), /interface language/);
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM profiles').get()?.count, 3);
});

test('verification links are single-use, purpose-bound, hashed and excluded from private history', async () => {
  const database = await storage(),
    messages: EmailMessage[] = [],
    created = await account(database, undefined, messages);
  const secret = token(messages[0]);
  assert.equal(created.state.emailVerified, false);
  assert.equal(
    database.sqlite.prepare('SELECT token_hash FROM auth_email_tokens').get()
      ?.token_hash,
    await hashToken(secret),
  );
  await assert.rejects(
    performAuthAction(
      request(),
      { action: 'reset_password', token: secret, password },
      database.asD1(),
    ),
    /invalid|expired|used/i,
  );
  await performAuthAction(
    request(),
    { action: 'verify_email', token: secret },
    database.asD1(),
  );
  assert.equal(
    (await readAuthState(request(created.cookie), database.asD1()))
      .emailVerified,
    true,
  );
  await assert.rejects(
    performAuthAction(
      request(),
      { action: 'verify_email', token: secret },
      database.asD1(),
    ),
    /invalid|expired|used/i,
  );
  assert.ok(
    !JSON.stringify(
      database.sqlite.prepare('SELECT * FROM account_activity_events').all(),
    ).includes(secret),
  );
});

test('mailbox recovery signs out every old session and disconnects previously linked identities', async () => {
  const database = await storage(),
    messages: EmailMessage[] = [],
    created = await account(database, undefined, messages),
    id = created.state.profile!.id;
  await performAuthAction(
    request(created.cookie, {
      'oai-authenticated-user-id': 'linked-provider',
      'oai-authenticated-user-email': 'alice@example.test',
      'oai-authenticated-user-full-name': 'Alice',
    }),
    { action: 'link_chatgpt' },
    database.asD1(),
  );
  const known = await performAuthAction(
    request(),
    { action: 'request_password_reset', email: 'alice@example.test' },
    database.asD1(),
    {
      mailer: async (message) => {
        messages.push(message);
      },
    },
  );
  const unknown = await performAuthAction(
    request(),
    { action: 'request_password_reset', email: 'missing@example.test' },
    database.asD1(),
    {
      mailer: async (message) => {
        messages.push(message);
      },
    },
  );
  assert.equal(known.notice, unknown.notice);
  assert.equal(messages.length, 2);
  const reset = await performAuthAction(
    request(),
    {
      action: 'reset_password',
      token: token(messages[1]),
      password: 'new suitcase coffee 2026',
    },
    database.asD1(),
  );
  assert.equal(reset.state.profile!.id, id);
  assert.equal(reset.state.emailVerified, true);
  assert.equal(
    (await readAuthState(request(created.cookie), database.asD1()))
      .authenticated,
    false,
  );
  assert.equal(
    database.sqlite
      .prepare('SELECT COUNT(*) AS n FROM auth_links WHERE user_id=?')
      .get(id)?.n,
    0,
  );
  await assert.rejects(
    performAuthAction(
      request(),
      { action: 'reset_password', token: token(messages[1]), password },
      database.asD1(),
    ),
    /invalid|expired|used/i,
  );
  await assert.rejects(
    performAuthAction(
      request(),
      { action: 'login', email: 'alice@example.test', password },
      database.asD1(),
    ),
    /password|sign in/i,
  );
});

test('expired email links and links invalidated by a password change cannot change credentials', async () => {
  const database = await storage(),
    messages: EmailMessage[] = [],
    created = await account(database, undefined, messages);
  await performAuthAction(
    request(),
    { action: 'request_password_reset', email: 'alice@example.test' },
    database.asD1(),
    {
      mailer: async (message) => {
        messages.push(message);
      },
    },
  );
  database.sqlite
    .prepare(
      "UPDATE auth_email_tokens SET expires_at='2000-01-01T00:00:00Z' WHERE purpose='reset'",
    )
    .run();
  await assert.rejects(
    performAuthAction(
      request(),
      { action: 'reset_password', token: token(messages[1]), password },
      database.asD1(),
    ),
    /invalid|expired|used/i,
  );
  await performAuthAction(
    request(),
    { action: 'request_password_reset', email: 'alice@example.test' },
    database.asD1(),
    {
      mailer: async (message) => {
        messages.push(message);
      },
    },
  );
  await performAuthAction(
    request(created.cookie),
    {
      action: 'set_password',
      currentPassword: password,
      password: 'changed suitcase coffee',
    },
    database.asD1(),
  );
  await assert.rejects(
    performAuthAction(
      request(),
      { action: 'reset_password', token: token(messages[2]), password },
      database.asD1(),
    ),
    /invalid|expired|used/i,
  );
});

test('session lists expose public IDs only and revocation stays within the owning account', async () => {
  const database = await storage(),
    a = await account(database),
    b = await account(database, 'bob@example.test');
  const second = await performAuthAction(
    request('', { 'user-agent': 'Another browser' }),
    { action: 'login', email: 'alice@example.test', password },
    database.asD1(),
  );
  const actor = a.state.profile!,
    sessions = await accountSessions(
      database.asD1(),
      request(a.cookie),
      actor.id,
    );
  assert.equal(sessions.length, 2);
  assert.equal(sessions.filter((value) => value.current).length, 1);
  assert.ok(!JSON.stringify(sessions).includes('token_hash'));
  const foreign = (
    await accountSessions(
      database.asD1(),
      request(b.cookie),
      b.state.profile!.id,
    )
  )[0];
  await revokeAccountSession(
    database.asD1(),
    request(a.cookie),
    actor,
    foreign.id,
  );
  assert.equal(
    (await readAuthState(request(b.cookie), database.asD1())).authenticated,
    true,
  );
  await revokeAccountSession(
    database.asD1(),
    request(a.cookie),
    actor,
    'others',
  );
  assert.equal(
    (await readAuthState(request(second.cookie), database.asD1()))
      .authenticated,
    false,
  );
  assert.equal(
    (await readAuthState(request(a.cookie), database.asD1())).authenticated,
    true,
  );
});

function seedTrip(
  database: Awaited<ReturnType<typeof storage>>,
  owner: string,
  other: string,
): Trip {
  const trip: Trip = {
    id: 'holiday',
    ownerId: owner,
    name: 'Lisbon',
    currency: 'GBP',
    members: [
      { id: 'a', name: 'Alice', userId: owner },
      { id: 'b', name: 'Bob', userId: other, payTo: { paypal: 'bob' } },
    ],
    expenses: [
      {
        id: 'meal',
        title: 'Dinner',
        date: '2026-10-10',
        time: '20:30',
        timezone: 'Europe/London',
        currency: 'GBP',
        payer: 'a',
        items: [
          { id: 'line', name: 'Dinner', amount: 1001, members: ['a', 'b'] },
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
    .run(trip.id, owner, JSON.stringify(trip));
  for (const [user, member] of [
    [owner, 'a'],
    [other, 'b'],
  ])
    database.sqlite
      .prepare(
        'INSERT INTO memberships(trip_id,user_id,member_id) VALUES(?,?,?)',
      )
      .run(trip.id, user, member);
  return trip;
}

test('archives are personal, and leaving or transferring retains historical financial assignments', async () => {
  const database = await storage(),
    a = await account(database),
    b = await account(database, 'bob@example.test'),
    actor = a.state.profile!,
    other = b.state.profile!;
  seedTrip(database, actor.id, other.id);
  await setTripArchived(database.asD1(), actor, 'holiday', true);
  assert.equal((await listArchivedTrips(database.asD1(), actor.id)).length, 1);
  assert.equal((await listArchivedTrips(database.asD1(), other.id)).length, 0);
  await assert.rejects(
    leaveTrip(database.asD1(), actor, 'holiday'),
    /transfer/i,
  );
  await assert.rejects(
    deleteTrip(database.asD1(), actor, 'holiday', 'Lisbon'),
    /other|connected|shared/i,
  );
  await transferTripOwnership(database.asD1(), actor, 'holiday', 'b');
  await leaveTrip(database.asD1(), actor, 'holiday');
  const saved = JSON.parse(
    String(database.sqlite.prepare('SELECT data FROM trips').get()?.data),
  ) as Trip;
  assert.equal(saved.expenses[0].payer, 'a');
  assert.deepEqual(saved.expenses[0].items[0].members, ['a', 'b']);
  assert.equal(saved.members[0].userId, undefined);
  assert.equal(saved.ownerId, other.id);
});

test('account deletion preserves shared money, removes contact and sign-in state, and blocks provider resurrection', async () => {
  const database = await storage(),
    a = await account(database),
    b = await account(database, 'bob@example.test'),
    actor = b.state.profile!;
  const original = seedTrip(database, a.state.profile!.id, actor.id);
  database.sqlite.prepare("UPDATE profiles SET ui_language='fr' WHERE id=?").run(actor.id);
  await saveNotificationPreferences(database.asD1(), actor, {
    scope: 'involved',
    delivery: 'daily',
    reminders: false,
  });
  assert.equal(
    (await readNotificationPreferences(database.asD1(), actor.id)).reminders,
    false,
  );
  await assert.rejects(
    deleteAccount(database.asD1(), request(a.cookie), a.state.profile!, {
      confirmation: a.state.profile!.email,
      password,
    }),
    /Transfer|delete your owned/i,
  );
  await deleteAccount(database.asD1(), request(b.cookie), actor, {
    confirmation: actor.email,
    password,
  });
  assert.equal(database.sqlite.prepare('SELECT ui_language FROM profiles WHERE id=?').get(actor.id)?.ui_language, 'en');
  const saved = JSON.parse(
    String(database.sqlite.prepare('SELECT data FROM trips').get()?.data),
  ) as Trip;
  assert.deepEqual(saved.expenses, original.expenses);
  assert.equal(saved.members[1].payTo, undefined);
  assert.equal(saved.members[1].retired, true);
  assert.equal(
    (await readAuthState(request(b.cookie), database.asD1())).authenticated,
    false,
  );
  await assert.rejects(
    resolveIdentity(
      request('', {
        'oai-authenticated-user-id': actor.id,
        'oai-authenticated-user-email': actor.email,
      }),
      {},
      database.asD1(),
    ),
    /UNAUTHORIZED/,
  );
  assert.equal(
    database.sqlite
      .prepare(
        'SELECT COUNT(*) AS n FROM account_activity_events WHERE user_id=?',
      )
      .get(actor.id)?.n,
    0,
  );
  assert.equal(
    database.sqlite
      .prepare('SELECT COUNT(*) AS n FROM memberships WHERE user_id=?')
      .get(actor.id)?.n,
    0,
  );
});


test('account deletion follows authoritative membership when legacy JSON has a stale account stamp',async()=>{
  const database=await storage(),a=await account(database),b=await account(database,'bob@example.test');
  const original=seedTrip(database,a.state.profile!.id,b.state.profile!.id);
  original.members[0].userId=b.state.profile!.id;delete original.members[1].userId;
  database.sqlite.prepare('UPDATE trips SET data=?').run(JSON.stringify(original));
  await deleteAccount(database.asD1(),request(b.cookie),b.state.profile!,{confirmation:b.state.profile!.email,password});
  const saved=JSON.parse(String(database.sqlite.prepare('SELECT data FROM trips').get()?.data)) as Trip;
  assert.equal(saved.members[0].name,'Alice');assert.equal(saved.members[1].name,'Deleted traveller 2');assert.equal(saved.members[1].payTo,undefined);assert.deepEqual(saved.expenses,original.expenses);
});
