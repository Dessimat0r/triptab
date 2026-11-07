import { ensureProfile, expenseCreators, failure, RequestError, tripAccess } from '@/lib/store';

export const dynamic = 'force-dynamic';

/**
 * D05: who added one expense, for the editor's "Added by … · paid by …" line.
 * Read from the trip's append-only history (lib/store.ts expenseCreators), only
 * for a trip the signed-in account can open. Returns the display name recorded
 * on the history event, or null for an expense older than history. No money,
 * so the financial-format boundary does not apply.
 */
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => !['tripId', 'expenseId'].includes(key)) || params.getAll('tripId').length !== 1 || params.getAll('expenseId').length !== 1) {
      throw new RequestError('Choose an expense.');
    }
    const tripId = params.get('tripId')!, expenseId = params.get('expenseId')!;
    if (!tripId || tripId.length > 100 || !expenseId || expenseId.length > 100) throw new RequestError('Choose an expense.');
    const profile = await ensureProfile(request);
    // Unknown and inaccessible trips look the same.
    if (!await tripAccess(profile.id, tripId)) throw new RequestError('This expense is unavailable to your account.', 404);
    const creator = (await expenseCreators(tripId, [expenseId])).get(expenseId);
    return Response.json({ accountId: profile.id, tripId, expenseId, name: creator?.actorName ?? null },
      { headers: { 'Cache-Control': 'private, no-store', 'X-TripTab-Account': profile.id } });
  } catch (error) {
    return failure(error);
  }
}
