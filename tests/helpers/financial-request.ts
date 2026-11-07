import { FINANCIAL_FORMAT, FINANCIAL_FORMAT_HEADER } from '../../lib/financial-format';

/** A request from a current TripTab bundle, which declares the money format it reads (R01). */
export function declaredRequest(url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set(FINANCIAL_FORMAT_HEADER, String(FINANCIAL_FORMAT));
  return new Request(url, { ...init, headers });
}
