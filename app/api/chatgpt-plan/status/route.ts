import { env } from 'cloudflare:workers';
import { db, ensureProfile, failure, sameOrigin } from '@/lib/store';
import { chatGPTPlanStatus, disconnectChatGPTPlan, ChatGPTPlanError, type ChatGPTPlanEnvironment } from '@/lib/chatgpt-plan';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
export async function GET(request: Request) {
  try { return Response.json(await chatGPTPlanStatus(db(), (await ensureProfile(request)).id, env as ChatGPTPlanEnvironment), { headers }); }
  catch (error) { return failure(error); }
}
export async function DELETE(request: Request) {
  try {
    sameOrigin(request);
    return Response.json(await disconnectChatGPTPlan(db(), await ensureProfile(request), env as ChatGPTPlanEnvironment), { headers });
  } catch (error) { return error instanceof ChatGPTPlanError ? Response.json({ error: error.message, code: error.code }, { status: error.status, headers }) : failure(error); }
}
