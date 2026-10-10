import {
  db,
  ensureProfile,
  failure,
  readBoundedBody,
  sameOrigin,
} from '@/lib/store';
import {
  accountSessions,
  deleteAccount,
  revokeAccountSession,
} from '@/lib/account-security';
import { signedOutAuthResult } from '@/lib/auth';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
export async function GET(request: Request) {
  try {
    const profile = await ensureProfile(request);
    return Response.json(
      { sessions: await accountSessions(db(), request, profile.id) },
      { headers },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const profile = await ensureProfile(request),
      body = JSON.parse(
        new TextDecoder().decode(await readBoundedBody(request, 4096)),
      );
    if (body.action === 'delete') {
      await deleteAccount(db(), request, profile, body);
      const result = signedOutAuthResult(request),
        responseHeaders = new Headers(headers);
      responseHeaders.append('Set-Cookie', result.cookie);
      for (const cookie of result.additionalCookies)
        responseHeaders.append('Set-Cookie', cookie);
      return Response.json(result.state, { headers: responseHeaders });
    }
    await revokeAccountSession(db(), request, profile, body.sessionId);
    return Response.json(
      { sessions: await accountSessions(db(), request, profile.id) },
      { headers },
    );
  } catch (error) {
    return failure(error);
  }
}
