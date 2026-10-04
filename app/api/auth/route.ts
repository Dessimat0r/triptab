import { AuthError, authFailure, performAuthAction, readAuthState } from '@/lib/auth';
import { db, readBoundedBody, RequestError } from '@/lib/store';

export const dynamic = 'force-dynamic';
const PRIVATE_HEADERS = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  try { return Response.json(await readAuthState(request, db()), { headers: PRIVATE_HEADERS }); }
  catch (error) { return authFailure(error); }
}
export async function POST(request: Request) {
  try {
    if (request.headers.get('origin') !== new URL(request.url).origin) throw new AuthError('This account request must come from TripTab.', 403);
    if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw new AuthError('Send valid account details.', 415);
    let body: unknown;
    try { body = JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 4096))); }
    catch (error) {
      if (error instanceof RequestError) throw new AuthError(error.message, error.status);
      throw new AuthError('Send valid account details.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AuthError('Send valid account details.');
    const result = await performAuthAction(request, body as Record<string, unknown>, db());
    const headers = new Headers(PRIVATE_HEADERS);
    if (result.cookie) headers.append('Set-Cookie', result.cookie);
    for (const value of result.additionalCookies || []) headers.append('Set-Cookie', value);
    return Response.json(result.state, { headers });
  } catch (error) { return authFailure(error); }
}
