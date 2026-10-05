import { encodeBase64url, sha256Hex } from '@/lib/data-utils';
import { activityStatements, db, ensureProfile, failure, MAX_STORED_TRIP_BYTES, readBoundedBody, RequestError, sameOrigin } from '@/lib/store';
import { notifyMembers } from '@/lib/notifications';
import { parseStoredTrip, travellerFinancialPreview, type Trip } from '@/lib/model';

export const dynamic = 'force-dynamic';
const PRIVATE_HEADERS = { 'Cache-Control': 'private, no-store' };
const INVITE_LIFETIME = 7 * 24 * 60 * 60 * 1000;

type Profile = Awaited<ReturnType<typeof ensureProfile>>;
type Member = Trip['members'][number];
type Invite = {
  token_hash: string; audit_id: string; trip_id: string; member_id: string; email: string | null;
  expires_at: string; used_by: string | null; created_by: string;
  owner: string; data: string;
};

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 100) {
    throw new RequestError(`Choose a valid ${label}.`);
  }
  return value;
}

function tokenValue(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new RequestError('This invitation link is invalid.', 404);
  }
  return value;
}

function targetEmail(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new RequestError('Enter a valid invitee email address.');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /[\u0000-\u001f\u007f]/.test(email)) {
    throw new RequestError('Enter a valid invitee email address.');
  }
  return email;
}

async function getInvite(hash: string): Promise<Invite> {
  const invite = await db().prepare(
    'SELECT i.*, t.owner, t.data FROM invites i JOIN trips t ON t.id = i.trip_id WHERE i.token_hash = ?',
  ).bind(hash).first<Invite>();
  if (!invite || invite.owner !== invite.created_by) {
    throw new RequestError('This invitation is no longer available. Ask the trip owner for a new link.', 404);
  }
  return invite;
}

function checkInvite(invite: Invite, profile: Profile, allowUsedBySelf = true) {
  if (invite.used_by) {
    if (allowUsedBySelf && invite.used_by === profile.id) return;
    throw new RequestError('This invitation has already been used. Ask the trip owner for a new link.', 409);
  }
  if (invite.expires_at <= new Date().toISOString()) {
    throw new RequestError('This invitation has expired. Ask the trip owner for a new link.', 410);
  }
  if (invite.email && invite.email.toLowerCase() !== profile.email.toLowerCase()) {
    throw new RequestError('Sign in to a TripTab account with the invited email address.', 403);
  }
}

async function membership(tripId: string, userId: string) {
  return db().prepare('SELECT member_id FROM memberships WHERE trip_id = ? AND user_id = ?')
    .bind(tripId, userId).first<{ member_id: string }>();
}

function inviteMember(invite: Invite): { trip: Trip; member: Member } {
  const trip = parseStoredTrip(JSON.parse(invite.data));
  const member = trip.members.find(value => value.id === invite.member_id);
  if (!member) throw new RequestError('This traveller is no longer on the trip. Ask for a new invitation.', 409);
  return { trip, member };
}

async function managementId(hash: string) {
  // The management reference is a separate digest. It cannot redeem the link
  // and never exposes the raw invitation token or its stored authentication hash.
  return `invite_${await sha256Hex(`triptab-invite-management:${hash}`)}`;
}

async function historySnapshot(invite: Invite) {
  return sha256Hex(`triptab-invite-history:${JSON.stringify([invite.token_hash, invite.trip_id, invite.member_id, invite.data])}`);
}

async function checkTripOwner(tripId: string, profile: Profile) {
  const row = await db().prepare('SELECT owner FROM trips WHERE id = ?')
    .bind(tripId).first<{ owner: string }>();
  if (!row || row.owner !== profile.id) throw new RequestError('Only the trip owner can manage invitations.', 403);
}

type TravellerSnapshot = { id: string; name: string; email: string | null };
function travellerSnapshot(id: string, name: unknown, email: unknown): TravellerSnapshot {
  // Invitation gates bind only this small identity, never the receipt/chat JSON.
  if (typeof name !== 'string' || !name || name.length > 50
    || (email !== null && (typeof email !== 'string' || email.length > 320))) {
    throw new RequestError('This traveller’s profile needs updating before managing invitations.', 409);
  }
  return { id, name, email: email as string | null };
}

async function ownerTraveller(tripId: string, memberId: string, profile: Profile) {
  const row = await db().prepare(`
    SELECT t.owner, json_extract(j.value, '$.id') AS member_id,
      json_extract(j.value, '$.name') AS member_name, json_extract(j.value, '$.email') AS member_email,
      json_extract(j.value, '$.userId') AS member_user_id
    FROM trips t LEFT JOIN json_each(t.data, '$.members') j ON json_extract(j.value, '$.id') = ?
    WHERE t.id = ?
  `).bind(memberId, tripId).first<{ owner: string; member_id: string | null; member_name: unknown; member_email: unknown; member_user_id: string | null }>();
  if (!row || row.owner !== profile.id) throw new RequestError('Only the trip owner can manage invitations.', 403);
  if (!row.member_id) throw new RequestError('Choose a traveller who is already on this trip.');
  if (row.member_user_id !== null) throw new RequestError('This traveller is already linked to an account.', 409);
  return travellerSnapshot(row.member_id, row.member_name, row.member_email);
}

type InvitationRow = { token_hash: string; audit_id: string; member_id: string; email: string | null; expires_at: string; member_name: string; member_email: string | null };
async function activeInvitations(tripId: string, profile: Profile) {
  const now = new Date().toISOString();
  return (await db().prepare(`
    SELECT i.token_hash, i.audit_id, i.member_id, i.email, i.expires_at,
      json_extract(j.value, '$.name') AS member_name, json_extract(j.value, '$.email') AS member_email
    FROM invites i JOIN trips t ON t.id = i.trip_id JOIN json_each(t.data, '$.members') j
    WHERE i.trip_id = ? AND t.owner = ? AND i.created_by = t.owner
      AND i.used_by IS NULL AND i.expires_at > ?
      AND json_extract(j.value, '$.id') = i.member_id AND json_extract(j.value, '$.userId') IS NULL
      AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = t.id AND m.member_id = i.member_id)
    ORDER BY i.expires_at DESC, i.token_hash LIMIT 201
  `).bind(tripId, profile.id, now).all<InvitationRow>()).results;
}

async function listInvitations(tripId: string, profile: Profile) {
  await checkTripOwner(tripId, profile);
  const rows = await activeInvitations(tripId, profile);
  const invitations = await Promise.all(rows.slice(0, 200).map(async row => ({
    id: await managementId(row.token_hash), memberId: row.member_id, memberName: row.member_name,
    email: row.email, expiresAt: row.expires_at,
  })));
  return Response.json({ invitations, hasMore: rows.length > 200 }, { headers: PRIVATE_HEADERS });
}

export async function GET(request: Request) {
  try {
    const profile = await ensureProfile(request);
    const params = new URL(request.url).searchParams;
    if (params.has('mode')) {
      if (params.getAll('mode').length !== 1 || params.get('mode') !== 'list' || params.getAll('tripId').length !== 1 || params.has('token')) {
        throw new RequestError('Choose a valid invitation list.');
      }
      return await listInvitations(identifier(params.get('tripId'), 'trip'), profile);
    }
    if (params.getAll('token').length !== 1) throw new RequestError('This invitation link is invalid.', 404);
    const invite = await getInvite(await sha256Hex(tokenValue(params.get('token'))));
    checkInvite(invite, profile);
    const { trip, member } = inviteMember(invite);
    if (member.userId && member.userId !== profile.id) {
      throw new RequestError('This traveller has already joined. Ask the trip owner for a new invitation.', 409);
    }
    const linked = await membership(invite.trip_id, profile.id);
    return Response.json({
      tripId: invite.trip_id, tripName: trip.name, memberName: member.name,
      alreadyMember: invite.owner === profile.id || Boolean(linked), expiresAt: invite.expires_at,
      history: travellerFinancialPreview(trip, member.id), historySnapshot: await historySnapshot(invite),
    }, { headers: PRIVATE_HEADERS });
  } catch (error) {
    return failure(error);
  }
}

async function invitationRevision(database: D1Database) {
  await database.prepare("INSERT OR IGNORE INTO sync_state (id, revision, last_write) VALUES (1, 0, '')").run();
  const state = await database.prepare('SELECT revision FROM sync_state WHERE id = 1').first<{ revision: number }>();
  if (!state) throw new RequestError('Trip storage is temporarily unavailable.', 503);
  return state;
}

async function invitationSnapshot(invite: Pick<Invite, 'audit_id' | 'token_hash' | 'member_id' | 'email' | 'expires_at'>, memberName: string, status: 'pending' | 'accepted' | 'expired') {
  // Old rows written during rollout may retain the migration's empty default.
  // The fallback is a separate, non-redeemable digest, never a token/hash.
  return {
    id: invite.audit_id || await managementId(invite.token_hash),
    memberId: invite.member_id, memberName, expiresAt: invite.expires_at,
    emailRestricted: Boolean(invite.email), status,
  };
}

async function createInvite(request: Request, profile: Profile, body: Record<string, unknown>) {
  const tripId = identifier(body.tripId, 'trip');
  const memberId = identifier(body.memberId, 'traveller');
  const email = targetEmail(body.email);
  const database = db();
  const member = await ownerTraveller(tripId, memberId, profile);
  const token = encodeBase64url(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await sha256Hex(token);
  const auditId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + INVITE_LIFETIME).toISOString();
  const previous = (await database.prepare(`
    SELECT token_hash, audit_id, member_id, email, expires_at, created_by FROM invites
    WHERE trip_id = ? AND member_id = ? AND used_by IS NULL ORDER BY token_hash
  `).bind(tripId, memberId).all<InvitationRow & { created_by: string }>()).results;
  const changes = await Promise.all(previous.map(async row => {
    const before = await invitationSnapshot(row, member.name, row.expires_at > new Date().toISOString() ? 'pending' : 'expired');
    return { tripId, entityType: 'invite' as const, entityId: before.id, action: 'update' as const, before, after: { ...before, status: 'revoked', reason: 'replaced' } };
  }));
  const after = { id: auditId, memberId, memberName: member.name, expiresAt, emailRestricted: Boolean(email), status: 'pending' };
  // Issuing a link does not change the financial ledger. Its own snapshots
  // guard the write, so unrelated expenses or chat cannot invalidate this action.
  const createdGate = { sql: 'EXISTS (SELECT 1 FROM invites WHERE token_hash = ? AND audit_id = ?)', bindings: [hash, auditId] };
  const results = await database.batch([
    database.prepare(`
      INSERT INTO invites (token_hash, audit_id, trip_id, member_id, email, expires_at, used_by, created_by)
      SELECT ?, ?, ?, ?, ?, ?, NULL, ? WHERE
        NOT EXISTS (SELECT 1 FROM auth_links WHERE oai_user_id = ? AND user_id <> ?)
        AND EXISTS (SELECT 1 FROM trips t WHERE t.id = ? AND t.owner = ?
          AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = t.id AND m.member_id = ?)
          AND EXISTS (SELECT 1 FROM json_each(t.data, '$.members') j
            WHERE json_extract(j.value, '$.id') = ? AND json_extract(j.value, '$.userId') IS NULL
              AND json_extract(j.value, '$.name') = ? AND json_extract(j.value, '$.email') IS ?))
        AND (SELECT json_group_array(json_array(i.token_hash, i.audit_id, i.email, i.expires_at, i.created_by))
          FROM (SELECT token_hash, audit_id, email, expires_at, created_by FROM invites
            WHERE trip_id = ? AND member_id = ? AND used_by IS NULL ORDER BY token_hash) i) = ?
    `).bind(hash, auditId, tripId, memberId, email, expiresAt, profile.id, profile.id, profile.id, tripId, profile.id, memberId, memberId, member.name, member.email, tripId, memberId,
      JSON.stringify(previous.map(row => [row.token_hash, row.audit_id, row.email, row.expires_at, row.created_by]))),
    database.prepare(`
      DELETE FROM invites WHERE trip_id = ? AND member_id = ? AND used_by IS NULL AND token_hash <> ?
        AND ${createdGate.sql}
    `).bind(tripId, memberId, hash, ...createdGate.bindings),
    ...activityStatements(database, [...changes, { tripId, entityType: 'invite', entityId: auditId, action: 'create', before: null, after }],
      { id: profile.id, displayName: profile.displayName }, '', 'current', 'web', createdGate),
    database.prepare('SELECT COALESCE((SELECT revision FROM sync_state WHERE id = 1), 0) AS revision'),
  ]);
  if (!results[0].meta.changes) throw new RequestError('This traveller changed or has already joined. Refresh the trip.', 409);
  const url = new URL('/', request.url);
  url.searchParams.set('invite', token);
  const revision = (results.at(-1)!.results[0] as { revision: number }).revision;
  return Response.json({ url: url.toString(), expiresAt, invitationId: await managementId(hash), revision }, { headers: PRIVATE_HEADERS });
}

async function revokeInvitation(profile: Profile, body: Record<string, unknown>) {
  const tripId = identifier(body.tripId, 'trip');
  const database = db();
  await checkTripOwner(tripId, profile);
  if (typeof body.invitationId !== 'string' || !/^invite_[a-f0-9]{64}$/.test(body.invitationId)) throw new RequestError('Choose a valid invitation.');
  const rows = await activeInvitations(tripId, profile);
  const references = await Promise.all(rows.map(async row => ({ row, id: await managementId(row.token_hash) })));
  const selected = references.find(value => value.id === body.invitationId)?.row;
  if (!selected) throw new RequestError('This invitation is no longer active. Refresh the invitations.', 409);
  const member = travellerSnapshot(selected.member_id, selected.member_name, selected.member_email);
  const before = await invitationSnapshot(selected, selected.member_name, 'pending');
  const results = await database.batch([
    database.prepare(`
      DELETE FROM invites WHERE token_hash = ? AND audit_id = ? AND trip_id = ? AND member_id = ? AND created_by = ?
        AND used_by IS NULL AND expires_at = ? AND expires_at > ? AND email IS ?
        AND NOT EXISTS (SELECT 1 FROM auth_links WHERE oai_user_id = ? AND user_id <> ?)
        AND EXISTS (SELECT 1 FROM trips t WHERE t.id = invites.trip_id AND t.owner = ?
          AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = t.id AND m.member_id = invites.member_id)
          AND EXISTS (SELECT 1 FROM json_each(t.data, '$.members') j
            WHERE json_extract(j.value, '$.id') = invites.member_id AND json_extract(j.value, '$.userId') IS NULL
              AND json_extract(j.value, '$.name') = ? AND json_extract(j.value, '$.email') IS ?))
    `).bind(selected.token_hash, selected.audit_id, tripId, selected.member_id, profile.id, selected.expires_at, new Date().toISOString(), selected.email,
      profile.id, profile.id, profile.id, member.name, member.email),
    // This single lifecycle event immediately follows the conditional delete.
    // Both statements roll back together if audit storage fails.
    ...activityStatements(database, [{ tripId, entityType: 'invite', entityId: before.id, action: 'update', before,
      after: { ...before, status: 'revoked', reason: 'owner' } }], { id: profile.id, displayName: profile.displayName }, '', 'current', 'web', { sql: 'changes() > 0', bindings: [] }),
    database.prepare('SELECT COALESCE((SELECT revision FROM sync_state WHERE id = 1), 0) AS revision'),
  ]);
  if (!results[0].meta.changes) throw new RequestError('This invitation changed or was already used. Refresh the invitations.', 409);
  const revision = (results.at(-1)!.results[0] as { revision: number }).revision;
  return Response.json({ revoked: true, revision }, { headers: PRIVATE_HEADERS });
}

async function acceptInvite(profile: Profile, body: Record<string, unknown>) {
  const hash = await sha256Hex(tokenValue(body.token));
  const invite = await getInvite(hash);
  checkInvite(invite, profile);
  const { member } = inviteMember(invite);
  const linked = await membership(invite.trip_id, profile.id);
  if (invite.used_by === profile.id) {
    if (!linked || linked.member_id !== invite.member_id || member.userId !== profile.id) {
      throw new RequestError('Your access to this trip changed. Ask its owner for a new invitation.', 409);
    }
    return Response.json({ tripId: invite.trip_id, memberId: invite.member_id, alreadyMember: true }, { headers: PRIVATE_HEADERS });
  }
  if (linked || invite.owner === profile.id) {
    throw new RequestError('Your account is already linked to a traveller on this trip.', 409);
  }
  if (member.userId) throw new RequestError('This traveller has already joined. Ask for a new invitation.', 409);
  if (body.acceptHistory !== true || typeof body.historySnapshot !== 'string' || body.historySnapshot !== await historySnapshot(invite)) {
    throw new RequestError('Review and confirm this traveller’s current financial history before joining.', 409);
  }

  const accountEmail = profile.email.trim().toLowerCase();
  // Preserve the stored financial representation; parsing for validation may
  // supply defaults that must not become an incidental invitation change.
  const nextTrip = JSON.parse(invite.data) as Trip;
  nextTrip.members = nextTrip.members.map(value => value.id === invite.member_id
    ? { ...value, userId: profile.id, email: accountEmail } : value);
  const nextData = JSON.stringify(nextTrip);
  if (new TextEncoder().encode(nextData).byteLength > MAX_STORED_TRIP_BYTES) {
    throw new RequestError('This holiday has too much stored receipt or payment content to link another account. Ask its owner to reduce that content before joining.', 413);
  }
  const database = db();
  const state = await invitationRevision(database);
  const marker = crypto.randomUUID();
  const now = new Date().toISOString();
  const before = await invitationSnapshot(invite, member.name, 'pending');
  // A compare-and-swap protects the trip JSON and invalidates any ledger loaded
  // before this join. Every subsequent statement is guarded by this batch marker.
  const results = await database.batch([
    database.prepare(`
      UPDATE sync_state SET revision = revision + 1, last_write = ?
      WHERE id = 1 AND revision = ? AND NOT EXISTS (SELECT 1 FROM auth_links WHERE oai_user_id = ? AND user_id <> ?) AND EXISTS (
        SELECT 1 FROM invites i JOIN trips t ON t.id = i.trip_id
        WHERE i.token_hash = ? AND i.audit_id = ? AND i.trip_id = ? AND i.member_id = ? AND i.created_by = ? AND i.email IS ?
          AND i.used_by IS NULL AND i.expires_at = ? AND i.expires_at > ?
          AND (i.email IS NULL OR lower(i.email) = ?)
          AND t.owner = i.created_by AND t.owner <> ?
          AND t.data = ?
          AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = t.id AND (m.user_id = ? OR m.member_id = i.member_id))
          AND EXISTS (SELECT 1 FROM json_each(t.data, '$.members') j
            WHERE json_extract(j.value, '$.id') = i.member_id AND json_extract(j.value, '$.userId') IS NULL)
      )
    `).bind(marker, state.revision, profile.id, profile.id, hash, invite.audit_id, invite.trip_id, invite.member_id, invite.created_by, invite.email,
      invite.expires_at, now, accountEmail, profile.id, invite.data, profile.id),
    database.prepare(`
      UPDATE invites SET used_by = ? WHERE token_hash = ? AND used_by IS NULL
        AND EXISTS (SELECT 1 FROM sync_state WHERE id = 1 AND last_write = ?)
    `).bind(profile.id, hash, marker),
    database.prepare(`
      INSERT INTO memberships (trip_id, user_id, member_id)
      SELECT trip_id, ?, member_id FROM invites WHERE token_hash = ? AND used_by = ?
        AND EXISTS (SELECT 1 FROM sync_state WHERE id = 1 AND last_write = ?)
    `).bind(profile.id, hash, profile.id, marker),
    database.prepare(`
      UPDATE trips SET data = ?
      WHERE id = ? AND EXISTS (SELECT 1 FROM sync_state WHERE id = 1 AND last_write = ?)
        AND EXISTS (SELECT 1 FROM invites WHERE token_hash = ? AND used_by = ? AND trip_id = trips.id)
    `).bind(nextData, invite.trip_id, marker, hash, profile.id),
    ...activityStatements(database, [
      { tripId: invite.trip_id, entityType: 'invite', entityId: before.id, action: 'update', before, after: { ...before, status: 'accepted' } },
      { tripId: invite.trip_id, entityType: 'member', entityId: invite.member_id, action: 'update', before: { ...member }, after: { ...member, userId: profile.id, email: accountEmail } },
    ], { id: profile.id, displayName: profile.displayName }, marker, state.revision + 1),
  ]);
  if (!results[0].meta.changes) {
    // Simultaneous clicks from the same account can safely return the first claim.
    const latest = await getInvite(hash);
    const current = await membership(invite.trip_id, profile.id);
    if (latest.used_by === profile.id && current?.member_id === invite.member_id) {
      return Response.json({ tripId: invite.trip_id, memberId: invite.member_id, alreadyMember: true }, { headers: PRIVATE_HEADERS });
    }
    throw new RequestError('The trip or invitation changed. Refresh before joining again.', 409);
  }
  await notifyMembers(invite.trip_id, profile.id, 'TripTab activity', `${profile.displayName} joined this holiday. Open TripTab to review the activity.`).catch(() => {
    console.warn('The traveller joined but its notification could not be queued.');
  });
  return Response.json({
    tripId: invite.trip_id, memberId: invite.member_id, alreadyMember: false, revision: state.revision + 1,
  }, { headers: PRIVATE_HEADERS });
}

export async function POST(request: Request) {
  try {
    try { sameOrigin(request); }
    catch { throw new RequestError('Invitation requests must come from TripTab.', 403); }
    const profile = await ensureProfile(request);
    if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw new RequestError('Send valid invitation details.', 415);
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 4096)));
    } catch (error) {
      if (error instanceof RequestError) throw error;
      throw new RequestError('Enter valid invitation details.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Enter valid invitation details.');
    const details = body as Record<string, unknown>;
    if (details.mode === 'create') return await createInvite(request, profile, details);
    if (details.mode === 'accept') return await acceptInvite(profile, details);
    if (details.mode === 'revoke') return await revokeInvitation(profile, details);
    throw new RequestError('Choose a valid invitation action.');
  } catch (error) {
    return failure(error);
  }
}
