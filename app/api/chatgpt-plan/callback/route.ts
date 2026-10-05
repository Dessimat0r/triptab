import { env } from 'cloudflare:workers';
import { db, ensureProfile } from '@/lib/store';
import { finishChatGPTPlanAuthorization, clearChatGPTPlanCookie, type ChatGPTPlanEnvironment } from '@/lib/chatgpt-plan';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  let returnTo = '/receipts', result = 'error';
  try {
    const saved = await finishChatGPTPlanAuthorization(db(), await ensureProfile(request), request, env as ChatGPTPlanEnvironment);
    returnTo = saved.returnTo; result = saved.result;
  } catch { /* Never expose OAuth codes, tokens or provider error bodies. */ }
  const url = new URL(returnTo, request.url);
  url.searchParams.set('chatgpt_plan', result);
  return new Response(null, { status: 303, headers: { Location: url.toString(), 'Set-Cookie': clearChatGPTPlanCookie, 'Cache-Control': 'private, no-store' } });
}
