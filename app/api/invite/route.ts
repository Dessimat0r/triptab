import { activityStatements, db, ensureProfile, failure, readBoundedBody, RequestError, sameOrigin } from '@/lib/store';
import { notifyMembers } from '@/lib/notifications';

export const dynamic = 'force-dynamic';
const PRIVATE_HEADERS = { 'Cache-Control': 'private, no-store' };
const INVITE_LIFETIME = 7 * 24 * 60 * 60 * 1000;

type Profile = Awaited<ReturnType<typeof ensureProfile>>;
type Member = { id: string; name: string; userId?: string; email?: string };
type TripData = { name: string; members: Member[] };
type Invite = {
  token_hash: string; trip_id: string; member_id: string; email: string | null;
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

async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function targetEmail(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new RequestError('Enter a valid invitee email address.');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
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

function inviteMember(invite: Invite): { trip: TripData; member: Member } {
  const trip = JSON.parse(invite.data) as TripData;
  const member = trip.members.find(value => value.id === invite.member_id);
  if (!member) throw new RequestError('This traveller is no longer on the trip. Ask for a new invitation.', 409);
  return { trip, member };
}

export async function GET(request: Request) {
  try {
    const profile = await ensureProfile(request);
    const params = new URL(request.url).searchParams;
    if (params.getAll('token').length !== 1) throw new RequestError('This invitation link is invalid.', 404);
    const invite = await getInvite(await tokenHash(tokenValue(params.get('token'))));
    checkInvite(invite, profile);
    const { trip, member } = inviteMember(invite);
    if (member.userId && member.userId !== profile.id) {
      throw new RequestError('This traveller has already joined. Ask the trip owner for a new invitation.', 409);
    }
    const linked = await membership(invite.trip_id, profile.id);
    return Response.json({
      tripId: invite.trip_id, tripName: trip.name, memberName: member.name,
      alreadyMember: invite.owner === profile.id || Boolean(linked), expiresAt: invite.expires_at,
    }, { headers: PRIVATE_HEADERS });
  } catch (error) {
    return failure(error);
  }
}

async function createInvite(request: Request, profile: Profile, body: Record<string, unknown>) {
  const tripId = identifier(body.tripId, 'trip');
  const memberId = identifier(body.memberId, 'traveller');
  const email = targetEmail(body.email);
  const row = await db().prepare('SELECT owner, data FROM trips WHERE id = ?')
    .bind(tripId).first<{ owner: string; data: string }>();
  if (!row || row.owner !== profile.id) throw new RequestError('Only the trip owner can invite travellers.', 403);
  const trip = JSON.parse(row.data) as TripData;
  const member = trip.members.find(value => value.id === memberId);
  if (!member) throw new RequestError('Choose a traveller who is already on this trip.');
  if (member.userId) throw new RequestError('This traveller is already linked to an account.', 409);
  const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const hash = await tokenHash(token);
  const expiresAt = new Date(Date.now() + INVITE_LIFETIME).toISOString();
  const result = await db().prepare(`
    INSERT INTO invites (token_hash, trip_id, member_id, email, expires_at, used_by, created_by)
    SELECT ?, t.id, ?, ?, ?, NULL, ? FROM trips t
    WHERE t.id = ? AND t.owner = ?
      AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = t.id AND m.member_id = ?)
      AND EXISTS (SELECT 1 FROM json_each(t.data, '$.members') j
        WHERE json_extract(j.value, '$.id') = ? AND json_extract(j.value, '$.userId') IS NULL)
  `).bind(hash, memberId, email, expiresAt, profile.id, tripId, profile.id, memberId, memberId).run();
  if (!result.meta.changes) throw new RequestError('This traveller changed or has already joined. Refresh the trip.', 409);
  const url = new URL('/', request.url);
  url.searchParams.set('invite', token);
  return Response.json({ url: url.toString(), expiresAt }, { headers: PRIVATE_HEADERS });
}

async function acceptInvite(profile: Profile, body: Record<string, unknown>) {
  const hash = await tokenHash(tokenValue(body.token));
  const invite = await getInvite(hash);
  checkInvite(invite, profile);
  const { trip, member } = inviteMember(invite);
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

  const database = db();
  await database.prepare("INSERT OR IGNORE INTO sync_state (id, revision, last_write) VALUES (1, 0, '')").run();
  const state = await database.prepare('SELECT revision FROM sync_state WHERE id = 1').first<{ revision: number }>();
  if (!state) throw new RequestError('Trip storage is temporarily unavailable.', 503);
  const marker = crypto.randomUUID();
  const now = new Date().toISOString();
  const verifiedEmail = profile.email.trim().toLowerCase();
  // A compare-and-swap protects the trip JSON and invalidates any ledger loaded
  // before this join. Every subsequent statement is guarded by this batch marker.
  const results = await database.batch([
    database.prepare(`
      UPDATE sync_state SET revision = revision + 1, last_write = ?
      WHERE id = 1 AND revision = ? AND NOT EXISTS (SELECT 1 FROM auth_links WHERE oai_user_id = ? AND user_id <> ?) AND EXISTS (
        SELECT 1 FROM invites i JOIN trips t ON t.id = i.trip_id
        WHERE i.token_hash = ? AND i.used_by IS NULL AND i.expires_at > ?
          AND (i.email IS NULL OR lower(i.email) = ?)
          AND t.owner = i.created_by AND t.owner <> ?
          AND t.data = ?
          AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = t.id AND (m.user_id = ? OR m.member_id = i.member_id))
          AND EXISTS (SELECT 1 FROM json_each(t.data, '$.members') j
            WHERE json_extract(j.value, '$.id') = i.member_id AND json_extract(j.value, '$.userId') IS NULL)
      )
    `).bind(marker, state.revision, profile.id, profile.id, hash, now, verifiedEmail, profile.id, invite.data, profile.id),
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
      UPDATE trips SET data = json_set(data,
        '$.members[' || (SELECT key FROM json_each(trips.data, '$.members') WHERE json_extract(value, '$.id') = ?) || '].userId', ?,
        '$.members[' || (SELECT key FROM json_each(trips.data, '$.members') WHERE json_extract(value, '$.id') = ?) || '].email', ?)
      WHERE id = ? AND EXISTS (SELECT 1 FROM sync_state WHERE id = 1 AND last_write = ?)
        AND EXISTS (SELECT 1 FROM invites WHERE token_hash = ? AND used_by = ? AND trip_id = trips.id)
    `).bind(invite.member_id, profile.id, invite.member_id, verifiedEmail, invite.trip_id, marker, hash, profile.id),
    ...activityStatements(database, [{ tripId: invite.trip_id, entityType: 'member', entityId: invite.member_id, action: 'update', before: { ...member }, after: { ...member, userId: profile.id, email: verifiedEmail } }], { id: profile.id, displayName: profile.displayName }, marker, state.revision + 1),
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
  await notifyMembers(invite.trip_id, profile.id, 'Traveller joined', `${profile.displayName} joined ${trip.name}`).catch(() => {
    console.warn('The traveller joined but its notification could not be queued.');
  });
  return Response.json({
    tripId: invite.trip_id, memberId: invite.member_id, alreadyMember: false, revision: state.revision + 1,
  }, { headers: PRIVATE_HEADERS });
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const profile = await ensureProfile(request);
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
    throw new RequestError('Choose whether to create or accept an invitation.');
  } catch (error) {
    return failure(error);
  }
}
