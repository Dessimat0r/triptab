import { owner } from '@/lib/store';

export const dynamic = 'force-dynamic';

const CURRENCIES = new Set([
  'AUD', 'CAD', 'CHF', 'CZK', 'DKK', 'EUR', 'GBP', 'HUF',
  'ISK', 'NOK', 'PLN', 'RON', 'SEK', 'TRY', 'USD',
]);
const PRIVATE_HEADERS = { 'Cache-Control': 'private, no-store' };
const BANK_FALLBACK = 'Enter the actual converted card charge or a manual exchange rate instead.';

class FxError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function localTimestamp(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

function validDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

export async function GET(request: Request) {
  try {
    // The hosting edge supplies this trusted identity. Authenticate even identity conversions.
    owner(request);
    const params = new URL(request.url).searchParams;
    const values = Object.fromEntries(['from', 'to', 'date', 'time', 'timezone'].map(key => {
      const all = params.getAll(key);
      if (all.length !== 1 || !all[0]) throw new FxError(`Provide one ${key} value.`, 400);
      return [key, all[0]];
    }));
    const from = values.from.toUpperCase();
    const to = values.to.toUpperCase();
    const { date, time, timezone } = values;
    if (!CURRENCIES.has(from) || !CURRENCIES.has(to)) {
      throw new FxError(`Reference rates are unavailable for this currency. ${BANK_FALLBACK}`, 422);
    }
    if (!validDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      throw new FxError('Use a valid transaction date (YYYY-MM-DD) and time (HH:mm).', 400);
    }
    if (timezone.length > 80 || !/^[A-Za-z0-9_+\-/]+$/.test(timezone)) {
      throw new FxError('Use a valid IANA timezone, such as Europe/London.', 400);
    }
    let nowLocal: string;
    try {
      nowLocal = localTimestamp(new Date(), timezone);
    } catch {
      throw new FxError('Use a valid IANA timezone, such as Europe/London.', 400);
    }
    if (`${date}T${time}` > nowLocal) {
      throw new FxError(`Reference rates cannot be requested for a future transaction. ${BANK_FALLBACK}`, 422);
    }
    const requestedAt = { date, time, timezone };
    if (from === to) {
      return Response.json({
        from, to, rate: 1, asOf: date, source: 'reference', requestedAt,
        provider: 'Identity conversion',
        message: 'Both amounts use the same currency, so no exchange conversion is needed.',
      }, { headers: PRIVATE_HEADERS });
    }
    if (date < '1999-01-04') {
      throw new FxError(`Daily reference rates begin on 4 January 1999. ${BANK_FALLBACK}`, 422);
    }

    const providerUrl = new URL(`https://api.frankfurter.dev/v1/${date}`);
    providerUrl.searchParams.set('base', from);
    providerUrl.searchParams.set('symbols', to);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let result: { base?: unknown; date?: unknown; rates?: Record<string, unknown> };
    try {
      const response = await fetch(providerUrl, {
        signal: controller.signal,
        cache: 'no-store',
        redirect: 'error',
        headers: { Accept: 'application/json' },
      });
      if (response.status === 404 || response.status === 422) {
        throw new FxError(`No daily reference rate is available for this currency and date. ${BANK_FALLBACK}`, 422);
      }
      if (!response.ok) {
        throw new FxError(`The exchange-rate provider is unavailable. ${BANK_FALLBACK}`, 502);
      }
      result = await response.json() as typeof result;
    } catch (error) {
      if (error instanceof FxError) throw error;
      if (controller.signal.aborted) {
        throw new FxError(`The exchange-rate provider timed out. ${BANK_FALLBACK}`, 504);
      }
      throw new FxError(`Unable to retrieve the daily reference rate. ${BANK_FALLBACK}`, 502);
    } finally {
      clearTimeout(timeout);
    }
    const rate = result?.rates?.[to];
    if (result?.base !== from || typeof result.date !== 'string' ||
        !validDate(result.date) || result.date > date ||
        typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      throw new FxError(`No valid daily reference rate is available for this currency and date. ${BANK_FALLBACK}`, 502);
    }
    return Response.json({
      from, to, rate, asOf: result.date, source: 'reference', requestedAt,
      provider: 'Frankfurter / ECB reference',
      message: `Daily reference rate dated ${result.date}; weekends and holidays use the latest available business day. The transaction time is recorded, but this provider does not offer intraday rates. Your bank may use a different rate, processing date, or fees. ${BANK_FALLBACK}`,
    }, { headers: PRIVATE_HEADERS });
  } catch (error) {
    const unauthorized = error instanceof Error && error.message === 'UNAUTHORIZED';
    return Response.json({
      error: unauthorized ? 'Sign in with ChatGPT to request exchange rates.'
        : error instanceof FxError ? error.message : 'Unable to process this exchange-rate request.',
    }, {
      status: unauthorized ? 401 : error instanceof FxError ? error.status : 500,
      headers: PRIVATE_HEADERS,
    });
  }
}
