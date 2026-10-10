import {
  ensureProfile,
  failure,
  readBoundedBody,
  readLedger,
  RequestError,
  sameOrigin,
  writeLedger,
} from '@/lib/store';
import { prepareImportedTrip } from '@/lib/import-ledger';
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const actor = await ensureProfile(request);
    const body = JSON.parse(
      new TextDecoder().decode(await readBoundedBody(request, 2_000_000)),
    );
    if (body.accountId !== actor.id)
      throw new RequestError('Sign in again before importing.', 409);
    const trip = prepareImportedTrip(body.trip, body.memberId);
    for (let attempt = 0; attempt < 3; attempt++) {
      const fresh = await readLedger(actor.id);
      if (fresh.data.trips.some((value) => value.id === trip.id))
        return Response.json(
          { tripId: trip.id },
          { headers: { 'Cache-Control': 'private, no-store' } },
        );
      if (fresh.data.trips.length >= 50)
        throw new RequestError('Archive a holiday before importing another.');
      try {
        await writeLedger(
          actor.id,
          { trips: [...fresh.data.trips, trip] },
          fresh.revision,
          {
            preserveCalculationRules: true,
            ownerMemberIds: { [trip.id]: body.memberId },
          },
        );
        return Response.json(
          { tripId: trip.id },
          { headers: { 'Cache-Control': 'private, no-store' } },
        );
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== 'CONFLICT' ||
          attempt === 2
        )
          throw error;
      }
    }
    throw new RequestError(
      'Your holidays keep changing. Retry import shortly.',
      409,
    );
  } catch (error) {
    return failure(error);
  }
}
