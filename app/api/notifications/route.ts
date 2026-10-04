import { ensureProfile, failure } from '@/lib/store';
import { latestNotifications } from '@/lib/notifications';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const profile = await ensureProfile(request);
    return Response.json({ notifications: await latestNotifications(profile.id) }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return failure(error);
  }
}
