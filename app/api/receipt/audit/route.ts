import { ensureProfile, failure, readReceiptAuditTrips, RequestError } from '@/lib/store';
import { auditHistoricalReceipts } from '@/lib/historical-receipt-audit';
import { financialFormatRefusal } from '@/lib/financial-format';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  // R01: the report carries stored and printed totals, so refuse before authentication or any read.
  const refused = financialFormatRefusal(request);
  if (refused) return refused;
  try {
    const profile = await ensureProfile(request);
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => !['after', 'tripId', 'limit'].includes(key) || params.getAll(key).length !== 1)
      || params.has('limit') && !/^[1-9]\d?$/.test(params.get('limit')!)) throw new RequestError('Choose a valid receipt audit page.');
    const page = await readReceiptAuditTrips(profile.id, { after: params.get('after') ?? undefined,
      tripId: params.get('tripId') ?? undefined, limit: params.has('limit') ? Number(params.get('limit')) : undefined });
    return Response.json({ findings: auditHistoricalReceipts({ trips: page.trips }), nextCursor: page.nextCursor,
      inspectedTrips: page.trips.length, readOnly: true }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return failure(error); }
}
