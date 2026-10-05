import { env } from 'cloudflare:workers';
import { db, ensureProfile, failure, readBoundedBody, sameOrigin, RequestError } from '@/lib/store';
import { startChatGPTPlanAuthorization, ChatGPTPlanError, type ChatGPTPlanEnvironment } from '@/lib/chatgpt-plan';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const profile = await ensureProfile(request);
    let body: { returnTo?: string };
    try { body = JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 2048))); }
    catch { throw new RequestError('Choose where to return after connecting ChatGPT.'); }
    const result = await startChatGPTPlanAuthorization(db(), profile.id, request, env as ChatGPTPlanEnvironment, body?.returnTo);
    return Response.json({ authorizationUrl: result.authorizationUrl }, { headers: { ...headers, 'Set-Cookie': result.cookie } });
  } catch (error) { return error instanceof ChatGPTPlanError ? Response.json({ error: error.message, code: error.code }, { status: error.status, headers }) : failure(error); }
}
