import { db, ensureProfile, failure, readBoundedBody, RequestError, sameOrigin } from '@/lib/store';
import { accountAuditStatement } from '@/lib/audit';

export const dynamic = 'force-dynamic';
const PRIVATE_HEADERS = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  try {
    return Response.json(await ensureProfile(request), { headers: PRIVATE_HEADERS });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    try { sameOrigin(request); }
    catch { throw new RequestError('This profile request must come from TripTab.', 403); }
    const profile = await ensureProfile(request);
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 4096)));
    } catch (error) {
      if (error instanceof RequestError) throw error;
      throw new RequestError('Enter a display name.');
    }
    const displayName = body && typeof body === 'object' && 'displayName' in body
      && typeof body.displayName === 'string' ? body.displayName.trim() : '';
    if (!displayName || displayName.length > 50 || /[\u0000-\u001f\u007f]/.test(displayName)) {
      throw new RequestError('Your display name must be between 1 and 50 characters.');
    }
    const previous = await db().prepare('SELECT display_name FROM profiles WHERE id = ?').bind(profile.id).first<{ display_name: string }>();
    if (!previous) throw new RequestError('Your profile is unavailable. Sign in again.', 401);
    if (previous.display_name === displayName) return Response.json({ ...profile, displayName }, { headers: PRIVATE_HEADERS });
    const results = await db().batch([
      db().prepare(`UPDATE profiles SET display_name = ? WHERE id = ? AND display_name = ?
        AND NOT EXISTS (SELECT 1 FROM auth_links WHERE oai_user_id = ? AND user_id <> ?)`)
        .bind(displayName, profile.id, previous.display_name, profile.id, profile.id),
      accountAuditStatement(db(), { userId: profile.id, actorName: previous.display_name, entityType: 'profile', entityId: profile.id,
        action: 'update', before: { displayName: previous.display_name }, after: { displayName } }, { sql: 'changes() > 0', bindings: [] }),
    ]);
    if (!results[0].meta.changes) throw new RequestError('Your profile changed while saving. Refresh it before trying again.', 409);
    return Response.json({ ...profile, displayName }, { headers: PRIVATE_HEADERS });
  } catch (error) {
    return failure(error);
  }
}
