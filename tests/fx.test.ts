import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

let authenticated = true;
Object.defineProperty(globalThis, Symbol.for('triptab.fx-test-owner'), {
  value: async () => {
    if (!authenticated) throw new Error('UNAUTHORIZED');
    return 'traveller';
  }, configurable: true,
});
const ownerUrl = 'data:text/javascript;base64,' + Buffer.from(`
export const owner = globalThis[Symbol.for('triptab.fx-test-owner')];
`).toString('base64');
// The route, date comparisons and provider validation are real; authentication
// and the external reference-rate service are the only substituted boundaries.
const source = await readFile(new URL('../app/api/fx/route.ts', import.meta.url), 'utf8');
const compiled = transpileModule(source, {
  compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
}).outputText
  .replace("'@/lib/store'", JSON.stringify(ownerUrl))
  .replace("'@/lib/dates'", JSON.stringify(new URL('../lib/dates.ts', import.meta.url).href))
  .replace("'@/lib/model'", JSON.stringify(new URL('../lib/model.ts', import.meta.url).href));
const { GET } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64')) as { GET(request: Request): Promise<Response> };

function request(overrides: Record<string, string> = {}, suffix = '') {
  const params = new URLSearchParams({
    from: 'EUR', to: 'GBP', date: '2026-10-04', time: '20:30', timezone: 'America/Los_Angeles', ...overrides,
  });
  return new Request(`https://triptab.test/api/fx?${params}${suffix}`);
}
const reference = { base: 'EUR', date: '2026-10-02', rates: { GBP: 0.85947 } };
const now = new Date('2026-10-05T03:30:00Z').getTime();

test('a local evening uses the recorded local date and accepts the latest earlier business-day rate', async context => {
  context.mock.timers.enable({ apis: ['Date'], now });
  authenticated = true;
  let providerCalls = 0;
  context.mock.method(globalThis, 'fetch', async (url: URL | string | Request, init?: RequestInit) => {
    providerCalls++;
    assert.equal(init?.redirect, 'manual');
    const parsed = new URL(String(url));
    assert.equal(parsed.pathname, '/v1/2026-10-04');
    assert.equal(parsed.searchParams.get('base'), 'EUR');
    assert.equal(parsed.searchParams.get('symbols'), 'GBP');
    return Response.json(reference);
  });
  const response = await GET(request());
  assert.equal(response.status, 200);
  const result = await response.json() as { rate: number; asOf: string; requestedAt: Record<string, string>; message: string };
  assert.equal(result.rate, reference.rates.GBP);
  assert.equal(result.asOf, '2026-10-02');
  assert.deepEqual(result.requestedAt, { date: '2026-10-04', time: '20:30', timezone: 'America/Los_Angeles' });
  assert.match(result.message, /does not offer intraday rates/);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(providerCalls, 1);
  const future = await GET(request({ date: '2026-10-05' }));
  assert.equal(future.status, 422);
  assert.equal(providerCalls, 1, 'future input must be rejected before contacting the provider');
});

test('identity conversion still requires sign-in and validates transaction inputs', async context => {
  context.mock.timers.enable({ apis: ['Date'], now });
  context.mock.method(globalThis, 'fetch', async () => { throw new Error('Identity conversion must not fetch'); });
  authenticated = false;
  assert.equal((await GET(request({ from: 'GBP' }))).status, 401);
  authenticated = true;
  const response = await GET(request({ from: 'GBP' }));
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { rate: number }).rate, 1);
  assert.equal((await GET(request({ date: '2026-02-30' }))).status, 400);
  assert.equal((await GET(request({ timezone: 'Imaginary/Zone' }))).status, 400);
  assert.equal((await GET(request({ time: '24:00' }))).status, 400);
  assert.equal((await GET(request({}, '&date=2026-10-03'))).status, 400);
});

test('rejects invalid provider base, calendar date and nonpositive or nonnumeric rates', async context => {
  context.mock.timers.enable({ apis: ['Date'], now });
  authenticated = true;
  let result: unknown;
  context.mock.method(globalThis, 'fetch', async () => Response.json(result));
  const malformed = [
    { ...reference, base: 'GBP' },
    { ...reference, date: '2026-10-05' },
    { ...reference, date: '2026-02-30' },
    { ...reference, date: '1998-12-31' },
    { ...reference, rates: { GBP: 0 } },
    { ...reference, rates: { GBP: -1 } },
    { ...reference, rates: { GBP: '0.85947' } },
    { ...reference, rates: { GBP: NaN } },
    { ...reference, rates: { GBP: Infinity } },
    { ...reference, rates: {} },
    null,
  ];
  for (result of malformed) {
    const response = await GET(request());
    assert.equal(response.status, 502);
    assert.match((await response.json() as { error: string }).error, /No valid daily reference rate/);
  }
});

test('provider failures retain the bank-charge and manual-rate fallback', async context => {
  context.mock.timers.enable({ apis: ['Date'], now });
  authenticated = true;
  let providerStatus = 404;
  let providerCalls = 0;
  context.mock.method(globalThis, 'fetch', async (_url: URL | string | Request, init?: RequestInit) => {
    providerCalls++; assert.equal(init?.redirect, 'manual');
    return new Response('', { status: providerStatus, headers: { Location: 'https://attacker.invalid' } });
  });
  for (const status of [301, 302, 307, 308, 404, 422, 503]) {
    providerStatus = status;
    const response = await GET(request());
    assert.equal(response.status, status === 404 || status === 422 ? 422 : 502);
    assert.match((await response.json() as { error: string }).error, /actual converted card charge or a manual exchange rate/);
  }
  assert.equal(providerCalls, 7, 'redirects do not trigger a request to the location header');
});
