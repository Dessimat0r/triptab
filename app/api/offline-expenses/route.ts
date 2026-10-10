import {
  ensureProfile,
  failure,
  readBoundedBody,
  readLedger,
  RequestError,
  sameOrigin,
  writeLedger,
} from '@/lib/store';
import { canonicalJson } from '@/lib/data-utils';
import { expenseSchema } from '@/lib/model';
export const dynamic = 'force-dynamic';
const comparison = (value: unknown) => {
  const expense = { ...(value as Record<string, unknown>) };
  delete expense.receiptId;
  delete expense.adjustmentAllocation;
  return canonicalJson(expense);
};

/** Append one stable-ID entry to a fresh server snapshot, never a cached ledger. */
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const actor = await ensureProfile(request),
      body = JSON.parse(
        new TextDecoder().decode(await readBoundedBody(request, 128_000)),
      );
    if (body.accountId !== actor.id)
      throw new RequestError(
        'Sign in to the account that captured this expense before syncing it.',
        409,
      );
    const expense = expenseSchema.parse(body.expense);
    for (let attempt = 0; attempt < 3; attempt++) {
      const fresh = await readLedger(actor.id),
        trip = fresh.data.trips.find((trip) => trip.id === body.tripId);
      if (!trip)
        throw new RequestError(
          'This holiday is unavailable or archived. Restore it before syncing.',
          409,
        );
      const existing = trip.expenses.find((value) => value.id === expense.id);
      if (existing) {
        if (comparison(existing) !== comparison(expense))
          throw new RequestError(
            'This queued entry was already saved with different details. Review it before discarding the pending copy.',
            409,
          );
        return Response.json(
          { saved: true, receiptId: existing.receiptId },
          { headers: { 'Cache-Control': 'private, no-store' } },
        );
      }
      try {
        await writeLedger(
          actor.id,
          { trips: [{ ...trip, expenses: [expense, ...trip.expenses] }] },
          fresh.revision,
          { preserveCalculationRules: true },
        );
        return Response.json(
          { saved: true, receiptId: expense.receiptId },
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
      'The holiday keeps changing. Retry sync shortly.',
      409,
    );
  } catch (error) {
    return failure(error);
  }
}
