/**
 * Financial-format compatibility boundary (R01).
 *
 * Format 1 is every TripTab bundle up to and including main `01be219`: it
 * reads only line prices, tax, tip and the receipt-wide discount. Format 2
 * adds the `scoped-adjustments` calculation rule and its `adjustments` records
 * (F-02). A format-1 reader shown a format-2 entry computes the gross price
 * and suggests the wrong settlement (R01: £6.75 instead of £3.75), and nothing
 * shipped in that bundle can be changed after the fact.
 *
 * The boundary is therefore enforced by the server. Every request whose
 * response carries ledger money, or which writes it, must declare the format
 * its bundle understands. A request that declares none, or an older one, is
 * refused before the server reads, writes or runs paid inference, with a 426
 * response whose message the format-1 bundle already displays. Its in-memory
 * ledger can only be the pre-release ledger, which contains no format-2
 * entries, so it never computes a gross-price suggestion, and it cannot
 * commit one either.
 *
 * Raising FINANCIAL_FORMAT for a later money format refuses this bundle the
 * same way, and this bundle clears its amounts when refused (fail closed).
 */
export const FINANCIAL_FORMAT = 2;
export const FINANCIAL_FORMAT_HEADER = 'X-TripTab-Financial-Format';
export const FINANCIAL_FORMAT_REQUIRED_HEADER = 'X-TripTab-Financial-Format-Required';
export const FINANCIAL_FORMAT_STATUS = 426;
export const FINANCIAL_FORMAT_REFUSAL = 'TripTab has been updated. Reload this page to see current amounts. Nothing was saved.';

/** The format a request declares; 1 (the original format) when it declares none or an unreadable value. */
export function requestFinancialFormat(request: Request): number {
  const value = request.headers.get(FINANCIAL_FORMAT_HEADER);
  return value && /^[1-9]\d{0,3}$/.test(value.trim()) ? Number(value.trim()) : 1;
}

/**
 * A 426 refusal for a client that cannot read the current money format, or
 * null when the request may proceed. Call it before authentication, storage
 * reads or inference so a refused client learns nothing and spends nothing.
 */
export function financialFormatRefusal(request: Request): Response | null {
  if (requestFinancialFormat(request) >= FINANCIAL_FORMAT) return null;
  const headers = { 'Cache-Control': 'private, no-store', [FINANCIAL_FORMAT_REQUIRED_HEADER]: String(FINANCIAL_FORMAT) };
  if (request.method === 'HEAD') return new Response(null, { status: FINANCIAL_FORMAT_STATUS, headers });
  return Response.json({ error: FINANCIAL_FORMAT_REFUSAL }, { status: FINANCIAL_FORMAT_STATUS, headers });
}

/** Whether a response refused this bundle's money format, so its amounts must not be shown. */
export function refusedFinancialFormat(response: Pick<Response, 'status'>): boolean {
  return response.status === FINANCIAL_FORMAT_STATUS;
}

/** Request headers declaring this bundle's money format, merged with any given. */
export function financialFormatHeaders(headers: Record<string, string> = {}): Record<string, string> {
  return { ...headers, [FINANCIAL_FORMAT_HEADER]: String(FINANCIAL_FORMAT) };
}
