import { bucket, db, ensureProfile, failure, readBoundedBody, RequestError, sameOrigin } from '@/lib/store';
import { notifyMembers } from '@/lib/notifications';
import { purgeDeletedTripReceipts } from '@/lib/receipt-lifecycle';
import { deleteTrip, leaveTrip, listArchivedTrips, setTripArchived, transferTripOwnership } from '@/lib/trip-lifecycle';

export const dynamic = 'force-dynamic';
const PRIVATE_HEADERS = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  try {
    const profile = await ensureProfile(request);
    const params = new URL(request.url).searchParams;
    if (params.get('mode') !== 'archived' || [...params.keys()].length !== 1) throw new RequestError('Choose a valid holiday list.');
    return Response.json({ trips: await listArchivedTrips(db(), profile.id) }, { headers: PRIVATE_HEADERS });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    try { sameOrigin(request); }
    catch { throw new RequestError('Holiday requests must come from TripTab.', 403); }
    if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw new RequestError('Send valid holiday details.', 415);
    const profile = await ensureProfile(request);
    let body: unknown;
    try { body = JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 4096))); }
    catch (error) {
      if (error instanceof RequestError) throw error;
      throw new RequestError('Send valid holiday details.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Send valid holiday details.');
    const details = body as Record<string, unknown>;
    const actor = { id: profile.id, displayName: profile.displayName };
    const respond = (value: Record<string, unknown>) => Response.json(value, { headers: PRIVATE_HEADERS });
    switch (details.action) {
      case 'archive':
      case 'restore':
        return respond(await setTripArchived(db(), actor, details.tripId, details.action === 'archive'));
      case 'leave': {
        const result = await leaveTrip(db(), actor, details.tripId);
        await notifyMembers(String(details.tripId), profile.id, result.tripName,
          `${profile.displayName} left the holiday. ${result.memberName}’s expenses and balance stay on it.`).catch(() => {
          console.warn('TripTab could not queue a holiday update notification.');
        });
        return respond({ left: true });
      }
      case 'transfer': {
        const result = await transferTripOwnership(db(), actor, details.tripId, details.memberId);
        await notifyMembers(String(details.tripId), profile.id, result.tripName,
          `${profile.displayName} made ${result.memberName} the holiday owner.`).catch(() => {
          console.warn('TripTab could not queue a holiday update notification.');
        });
        return respond({ ownerId: result.ownerId });
      }
      case 'delete': {
        await deleteTrip(db(), actor, details.tripId, details.confirmName);
        // The deletion is committed; image cleanup that fails here is retried
        // by scheduled maintenance from the durable purge records.
        await Promise.resolve().then(() => purgeDeletedTripReceipts(db(), bucket(), { limit: 200 })).catch(() => {
          console.warn('TripTab deleted the holiday; receipt image cleanup will retry.');
        });
        return respond({ deleted: true });
      }
      default: throw new RequestError('Choose a valid holiday action.');
    }
  } catch (error) {
    return failure(error);
  }
}
