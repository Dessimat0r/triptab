import {
  db,
  ensureProfile,
  failure,
  readBoundedBody,
  sameOrigin,
} from '@/lib/store';
import {
  readNotificationPreferences,
  saveNotificationPreferences,
} from '@/lib/notification-preferences';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
export async function GET(request: Request) {
  try {
    const profile = await ensureProfile(request);
    return Response.json(await readNotificationPreferences(db(), profile.id), {
      headers,
    });
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
    return Response.json(
      await saveNotificationPreferences(db(), profile, body),
      { headers },
    );
  } catch (error) {
    return failure(error);
  }
}
