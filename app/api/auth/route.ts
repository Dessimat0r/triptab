import { env } from 'cloudflare:workers';
import { AuthError, authFailure, performAuthAction, readAuthState, resolveIdentity, signedOutAuthResult } from '@/lib/auth';
import { configuredMailer } from '@/lib/email';
import { db, readBoundedBody, RequestError } from '@/lib/store';
import { browserPushCookie, revokeBrowserPush } from '@/lib/notifications';

export const dynamic = 'force-dynamic';
const PRIVATE_HEADERS = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  try { return Response.json(await readAuthState(request, db()), { headers: PRIVATE_HEADERS }); }
  catch (error) { return authFailure(error); }
}
export async function POST(request: Request) {
  let logoutRequest = false;
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
    logoutRequest = details.action === 'logout';
    let previousActor: string | undefined;
    // Each of these can replace the browser's signed-in account.
    const signsIn = ['login', 'register', 'reset_password'].includes(String(details.action));
    if (logoutRequest || signsIn) {
      try { previousActor = (await resolveIdentity(request, {}, db())).id; }
      catch (error) {
        if (!logoutRequest && (!(error instanceof Error) || error.message !== 'UNAUTHORIZED')) throw error;
      }
    }
    if (logoutRequest && previousActor) {
      try { await revokeBrowserPush(request, previousActor); }
      catch { console.warn('TripTab could not revoke this browser’s notifications during logout.'); }
    }
    const result = await performAuthAction(request, details, db(), { mailer: configuredMailer(env as unknown as Record<string, string | undefined>, request) });
    const nextActor = result.state.authenticated ? result.state.profile?.id : undefined;
    const switched = signsIn && previousActor && nextActor && previousActor !== nextActor;
    // Revoke only the old actor's hash-bound browser after the new credentials
    // succeed. Failed attempts and same-account logins preserve notifications.
    if (switched) await revokeBrowserPush(request, previousActor!);
    const headers = new Headers(PRIVATE_HEADERS);
    if (result.cookie) headers.append('Set-Cookie', result.cookie);
    for (const value of result.additionalCookies || []) headers.append('Set-Cookie', value);
    if (details.action === 'logout' || switched) headers.append('Set-Cookie', await browserPushCookie(request));
    return Response.json(result.notice ? { ...result.state, notice: result.notice } : result.state, { headers });
  } catch (error) {
    const response = authFailure(error);
    if (logoutRequest) {
      // Preserve a failed revocation's error response while removing browser
      // credentials and disabling provider fallback on this device.
      const result = signedOutAuthResult(request);
      response.headers.append('Set-Cookie', result.cookie);
      for (const value of result.additionalCookies) response.headers.append('Set-Cookie', value);
      response.headers.append('Set-Cookie', await browserPushCookie(request));
    }
    return response;
  }
}
