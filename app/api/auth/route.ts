import { AuthError, authFailure, performAuthAction, readAuthState, resolveIdentity } from '@/lib/auth';
import { db, readBoundedBody, RequestError } from '@/lib/store';
import { browserPushCookie, revokeBrowserPush } from '@/lib/notifications';

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
    const details = body as Record<string, unknown>;
    let previousActor: string | undefined;
    if (['logout', 'login', 'register'].includes(String(details.action))) {
      try { previousActor = (await resolveIdentity(request, {}, db())).id; }
      catch (error) { if (!(error instanceof Error) || error.message !== 'UNAUTHORIZED') throw error; }
    }
    if (details.action === 'logout' && previousActor) await revokeBrowserPush(request, previousActor);
    const result = await performAuthAction(request, details, db());
    const nextActor = result.state.authenticated ? result.state.profile?.id : undefined;
    const switched = (details.action === 'login' || details.action === 'register') && previousActor && nextActor && previousActor !== nextActor;
    // Revoke only the old actor's hash-bound browser after the new credentials
    // succeed. Failed attempts and same-account logins preserve notifications.
    if (switched) await revokeBrowserPush(request, previousActor!);
    const headers = new Headers(PRIVATE_HEADERS);
    if (result.cookie) headers.append('Set-Cookie', result.cookie);
    for (const value of result.additionalCookies || []) headers.append('Set-Cookie', value);
    if (details.action === 'logout' || switched) headers.append('Set-Cookie', await browserPushCookie(request));
    return Response.json(result.state, { headers });
  } catch (error) { return authFailure(error); }
}
