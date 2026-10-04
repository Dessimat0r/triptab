import { db, ensureProfile, failure, readBoundedBody, RequestError, sameOrigin } from '@/lib/store';

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
    sameOrigin(request);
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
    await db().prepare('UPDATE profiles SET display_name = ? WHERE id = ?')
      .bind(displayName, profile.id).run();
    return Response.json({ ...profile, displayName }, { headers: PRIVATE_HEADERS });
  } catch (error) {
    return failure(error);
  }
}
