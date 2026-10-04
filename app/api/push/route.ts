import { z } from 'zod';
import { ensureProfile, failure, readBoundedBody, RequestError, sameOrigin } from '@/lib/store';
import { browserPushCookie, ownsSubscription, pushConfiguration, subscribe, subscriptionCount, unsubscribe } from '@/lib/notifications';

export const dynamic = 'force-dynamic';
const bodySchema = z.object({ mode: z.enum(['subscribe', 'unsubscribe', 'status']), endpoint: z.string().max(2048) }).strict();
const headers = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  try {
    const profile = await ensureProfile(request);
    return Response.json({ ...pushConfiguration(), subscriptions: await subscriptionCount(profile.id) }, { headers });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const profile = await ensureProfile(request);
    const bytes = await readBoundedBody(request, 8192);
    let json: unknown;
    try { json = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new RequestError('Invalid notification settings.'); }
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) throw new RequestError('Invalid notification settings.');
    if (parsed.data.mode === 'status') {
      const owned = await ownsSubscription(profile.id, parsed.data.endpoint);
      // Existing subscriptions from before browser binding cookies remain
      // enabled only for their owner, and gain the same logout protection.
      return Response.json({ ...pushConfiguration(), ownsSubscription: owned }, { headers: { ...headers, 'Set-Cookie': await browserPushCookie(request, owned ? parsed.data.endpoint : undefined) } });
    }
    if (parsed.data.mode === 'subscribe') await subscribe(profile.id, parsed.data.endpoint);
    else await unsubscribe(profile.id, parsed.data.endpoint);
    return Response.json({ ok: true, subscriptions: await subscriptionCount(profile.id) }, { headers: { ...headers, 'Set-Cookie': await browserPushCookie(request, parsed.data.mode === 'subscribe' ? parsed.data.endpoint : undefined) } });
  } catch (error) {
    return failure(error);
  }
}
