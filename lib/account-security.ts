import { accountAuditStatement, activityStatements } from './audit';
import {
  AuthError,
  consumeAuthRateLimit,
  hashToken,
  resolveIdentity,
  verifyPassword,
} from './auth';
import { parseStoredTrip } from './model';

async function currentHash(request: Request) {
  const cookie = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((value) => value.trim())
    .filter((value) => value.startsWith('tt_session='));
  return cookie.length === 1
    ? hashToken(cookie[0].slice('tt_session='.length))
    : null;
}
export async function accountSessions(
  database: D1Database,
  request: Request,
  userId: string,
) {
  const hash = await currentHash(request);
  const rows = await database
    .prepare(
      'SELECT session_id,user_agent,created_at,expires_at,token_hash FROM auth_sessions WHERE user_id=? AND expires_at>? ORDER BY created_at DESC LIMIT 100',
    )
    .bind(userId, new Date().toISOString())
    .all<{
      session_id: string;
      user_agent: string;
      created_at: string;
      expires_at: string;
      token_hash: string;
    }>();
  return rows.results.map((row) => ({
    id: row.session_id,
    device: row.user_agent || 'Browser',
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    current: row.token_hash === hash,
  }));
}
export async function revokeAccountSession(
  database: D1Database,
  request: Request,
  actor: { id: string; displayName: string },
  sessionId: string,
) {
  if (sessionId !== 'others' && !/^[A-Za-z0-9-]{16,60}$/.test(sessionId))
    throw new AuthError('Choose a browser session.');
  const hash = await currentHash(request);
  const mutation =
    sessionId === 'others'
      ? database
          .prepare(
            'DELETE FROM auth_sessions WHERE user_id=? AND token_hash IS NOT ?',
          )
          .bind(actor.id, hash)
      : database
          .prepare('DELETE FROM auth_sessions WHERE user_id=? AND session_id=?')
          .bind(actor.id, sessionId);
  await database.batch([
    mutation,
    accountAuditStatement(database, {
      userId: actor.id,
      actorName: actor.displayName,
      entityType: 'session',
      entityId: sessionId,
      action: 'delete',
      before: { active: true },
      after: { active: false },
    }),
  ]);
}

/** Delete private account state while preserving the group's financial records. */
export async function deleteAccount(
  database: D1Database,
  request: Request,
  actor: { id: string; email: string; displayName: string },
  body: { confirmation?: unknown; password?: unknown },
) {
  if (body.confirmation !== actor.email)
    throw new AuthError('Type your email address to confirm account deletion.');
  const identity = await resolveIdentity(request, {}, database);
  if (identity.id !== actor.id)
    throw new AuthError('Sign in again before deleting your account.', 401);
  await consumeAuthRateLimit(request, actor.email, database, 'delete_account');
  const credential = await database
    .prepare(
      'SELECT password_hash,password_salt,iterations FROM auth_credentials WHERE user_id=?',
    )
    .bind(actor.id)
    .first<{
      password_hash: string;
      password_salt: string;
      iterations: number;
    }>();
  if (
    credential
      ? !(await verifyPassword(body.password, {
          hash: credential.password_hash,
          salt: credential.password_salt,
          iterations: credential.iterations,
        }))
      : identity.kind !== 'chatgpt' || !identity.emailVerified
  )
    throw new AuthError(
      'Confirm your current password or use your verified ChatGPT sign-in.',
      401,
    );
  if (
    await database
      .prepare('SELECT 1 FROM trips WHERE owner=? LIMIT 1')
      .bind(actor.id)
      .first()
  )
    throw new AuthError(
      'Transfer or delete your owned holidays before deleting your account.',
    );
  if (
    await database
      .prepare('SELECT 1 FROM receipt_ai_settings WHERE user_id=?')
      .bind(actor.id)
      .first()
  )
    throw new AuthError(
      'The shared receipt AI account must be transferred by the app owner before deleting this account.',
    );
  const baseline = await database.batch([
    database
      .prepare(
        'SELECT t.id,t.data FROM trips t JOIN memberships m ON m.trip_id=t.id WHERE m.user_id=?',
      )
      .bind(actor.id),
    database.prepare(
      'SELECT COALESCE((SELECT revision FROM sync_state WHERE id=1),0) AS revision',
    ),
  ]);
  const revision = (baseline[1].results as { revision: number }[])[0].revision,
    marker = crypto.randomUUID(),
    now = new Date().toISOString();
  const gate = {
    sql: 'EXISTS(SELECT 1 FROM sync_state WHERE id=1 AND last_write=?)',
    bindings: [marker],
  };
  const statements = [
    database.prepare(
      "INSERT OR IGNORE INTO sync_state(id,revision,last_write) VALUES(1,0,'')",
    ),
    database
      .prepare(
        `UPDATE sync_state SET revision=revision+1,last_write=? WHERE id=1 AND revision=?
      AND EXISTS(SELECT 1 FROM profiles WHERE id=? AND email=? AND deleted_at='')
      AND NOT EXISTS(SELECT 1 FROM trips WHERE owner=?) AND NOT EXISTS(SELECT 1 FROM receipt_ai_settings WHERE user_id=?)
      AND NOT EXISTS(SELECT 1 FROM auth_links WHERE oai_user_id=? AND user_id<>?)
      ${credential ? 'AND EXISTS(SELECT 1 FROM auth_credentials WHERE user_id=? AND password_hash=?)' : ''}`,
      )
      .bind(
        marker,
        revision,
        actor.id,
        actor.email,
        actor.id,
        actor.id,
        actor.id,
        actor.id,
        ...(credential ? [actor.id, credential.password_hash] : []),
      ),
  ];
  for (const row of baseline[0].results as { id: string; data: string }[]) {
    const trip = parseStoredTrip(JSON.parse(row.data));
    // Membership is authoritative even when a legacy JSON snapshot omitted it.
    const linked = await database
      .prepare(
        'SELECT member_id FROM memberships WHERE trip_id=? AND user_id=?',
      )
      .bind(row.id, actor.id)
      .first<{ member_id: string }>();
    const target = trip.members.find((member) => member.id === linked?.member_id);
    if (target) {
      const before = { ...target };
      target.name = `Deleted traveller ${trip.members.indexOf(target) + 1}`;
      target.retired = true;
      delete target.userId;
      delete target.email;
      delete target.payTo;
      statements.push(
        database
          .prepare(`UPDATE trips SET data=? WHERE id=? AND ${gate.sql}`)
          .bind(JSON.stringify(trip), row.id, ...gate.bindings),
        ...activityStatements(
          database,
          [
            {
              tripId: row.id,
              entityType: 'member',
              entityId: target.id,
              action: 'update',
              before,
              after: target,
            },
          ],
          { id: actor.id, displayName: 'Deleted traveller' },
          marker,
          'current',
        ),
      );
    }
  }
  // Queue unattached uploads for durable R2 cleanup, including uploads still in
  // flight. Photos referenced by the group's financial entries remain available.
  const unreferenced = `NOT EXISTS(SELECT 1 FROM trips t,json_each(t.data,'$.expenses') e WHERE t.id=r.trip_id AND json_extract(e.value,'$.receiptId')=r.id)
    AND NOT EXISTS(SELECT 1 FROM trips t,json_each(t.data,'$.drafts') e WHERE t.id=r.trip_id AND json_extract(e.value,'$.receiptId')=r.id)`;
  statements.push(
    database
      .prepare(
        `INSERT OR IGNORE INTO receipt_object_purges(receipt_id,owner,created_at)
    SELECT r.id,r.owner,? FROM receipts r WHERE r.owner=? AND ${unreferenced} AND ${gate.sql}`,
      )
      .bind(now, actor.id, ...gate.bindings),
    database
      .prepare(
        `DELETE FROM receipts AS r WHERE r.owner=? AND ${unreferenced} AND ${gate.sql}`,
      )
      .bind(actor.id, ...gate.bindings),
  );
  statements.push(
    database
      .prepare(
        `UPDATE profiles SET email=?,display_name='Deleted traveller',ui_language='en',deleted_at=? WHERE id=? AND ${gate.sql}`,
      )
      .bind(
        `deleted-${crypto.randomUUID()}@invalid.local`,
        now,
        actor.id,
        ...gate.bindings,
      ),
  );
  for (const table of [
    'auth_credentials',
    'auth_sessions',
    'auth_email_tokens',
    'chatgpt_plan_connections',
    'chatgpt_plan_transactions',
    'notification_preferences',
    'notification_digests',
    'trip_archives',
    'trip_language_preferences',
    'push_subscriptions',
    'notifications',
    'memberships',
    'account_activity_events',
  ])
    statements.push(
      database
        .prepare(`DELETE FROM ${table} WHERE user_id=? AND ${gate.sql}`)
        .bind(actor.id, ...gate.bindings),
    );
  statements.push(
    database
      .prepare(`DELETE FROM invites WHERE created_by=? AND ${gate.sql}`)
      .bind(actor.id, ...gate.bindings),
  );
  const result = await database.batch(statements);
  if (!result[1].meta.changes)
    throw new AuthError(
      'Your account or holidays changed. Refresh before trying again.',
      409,
    );
}
