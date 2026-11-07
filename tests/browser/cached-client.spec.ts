import { expect, test, type Page, type Route } from '@playwright/test';
import { FINANCIAL_FORMAT, FINANCIAL_FORMAT_HEADER, FINANCIAL_FORMAT_REFUSAL } from '../../lib/financial-format';
import { settlements, type Trip } from '../../lib/model';
import { bogofExpense } from '../helpers/bogof';
import { createReceiptFlowWorker } from '../helpers/receipt-flow-worker';

// R01 (P0): run real bundles against the real new server. Every /api request a
// page makes is forwarded, with its own headers, to the production routes in an
// isolated Worker (auth, D1, CAS). The previous bundle is main `01be219`, built
// separately and served at TRIPTAB_PREVIOUS_URL; without it those tests skip.
// The current bundle is this checkout's preview.

const previousURL = process.env.TRIPTAB_PREVIOUS_URL;
type Flow = Awaited<ReturnType<typeof createReceiptFlowWorker>>;
// Routes outside the isolated Worker answer as an empty account would.
const empty = { trips: [], events: [], notifications: [], people: [], bills: [], nextCursor: null };

async function seedBogof(flow: Flow) {
  const seeded = await flow.readLedger();
  const trip = seeded.data.trips.find(value => value.id === flow.tripId)!;
  const response = await flow.browserRequest('/api/ledger', { method: 'POST',
    body: JSON.stringify({ revision: seeded.revision, data: { trips: [{ ...trip, name: 'Groceries', expenses: [bogofExpense()] }] } }) });
  expect(response.status).toBe(200);
  return (await response.json() as { revision: number }).revision;
}

/**
 * R14: every request the page routes to the isolated Worker goes through this
 * gate, so teardown can stop the page's requests and drain their handlers
 * before the Worker is disposed. Disposing it first (as before) failed live
 * requests with ERR_DISPOSED after the assertions had passed.
 */
type Gate = { closing: boolean; inflight: Set<Promise<unknown>> };
async function routed(gate: Gate, route: Route, handle: () => Promise<void>) {
  // Teardown has begun and the page is about to close: stop this request
  // deliberately. Any other failure of a handler still fails the test.
  if (gate.closing) return route.abort('aborted');
  const task = handle();
  gate.inflight.add(task);
  try { await task; } finally { gate.inflight.delete(task); }
}
/** Run with an isolated production Worker and tear down in order: stop requests, drain, close the page, then dispose. */
async function withFlow(page: Page, run: (flow: Flow, gate: Gate) => Promise<void>) {
  const flow = await createReceiptFlowWorker();
  const gate: Gate = { closing: false, inflight: new Set() };
  try { await run(flow, gate); }
  finally {
    gate.closing = true;
    while (gate.inflight.size) await Promise.allSettled([...gate.inflight]);
    await page.close();
    await flow.dispose();
  }
}

/** Forward the page's API calls to the Worker. `declare` stands in for a server without the R01 boundary. */
async function forward(page: Page, flow: Flow, gate: Gate, options: { declare?: boolean } = {}) {
  const calls: { method: string; path: string; status: number }[] = [];
  await page.route('**/api/**', route => routed(gate, route, async () => {
    const request = route.request(), url = new URL(request.url());
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers())) if (!['host', 'content-length', 'cookie'].includes(name)) headers[name] = value;
    headers.cookie = `tt_session=${flow.sessionToken}`;
    if (headers.origin) headers.origin = flow.origin;
    if (options.declare) headers[FINANCIAL_FORMAT_HEADER.toLowerCase()] = String(FINANCIAL_FORMAT);
    const response = await flow.worker.dispatchFetch(flow.origin + url.pathname + url.search, {
      method: request.method(), headers, body: ['GET', 'HEAD'].includes(request.method()) ? undefined : request.postDataBuffer() ?? undefined,
    } as never);
    calls.push({ method: request.method(), path: url.pathname, status: response.status });
    if (response.status === 404 && (await response.clone().text()) === 'Not found') return route.fulfill({ json: empty });
    const responseHeaders = Object.fromEntries([...response.headers].filter(([name]) => !['content-encoding', 'content-length', 'set-cookie'].includes(name)));
    return route.fulfill({ status: response.status, headers: responseHeaders, body: Buffer.from(await response.arrayBuffer()) });
  }));
  return calls;
}

async function storedTrip(flow: Flow) {
  return (await flow.readLedger()).data.trips.find(value => value.id === flow.tripId)! as Trip;
}

test.describe('previous bundle (main 01be219) against the new server', () => {
  test.skip(!previousURL, 'Set TRIPTAB_PREVIOUS_URL to a preview of main 01be219.');
  test.use({ baseURL: previousURL });

  test('control: without the boundary the previous bundle settles the BOGOF receipt at gross prices (£6.75, not £3.75)', async ({ page }) => {
    await withFlow(page, async (flow, gate) => {
      await seedBogof(flow);
      await forward(page, flow, gate, { declare: true });
      await page.goto('/balances');
      // This is the R01 defect, reproduced on the shipped bundle so that the
      // absence of these amounts in the next test is meaningful.
      await expect(page.locator('main')).toContainText('Total trip spend £7.50');
      await expect(page.locator('.settlement').first()).toContainText('pays Bob£6.75');
      await expect(page.locator('.settlement')).not.toContainText('£3.75');
    });
  });

  test('the previous bundle shows no amounts or suggestions from the new server, and cannot record a payment', async ({ page }) => {
    await withFlow(page, async (flow, gate) => {
      const revision = await seedBogof(flow);
      const calls = await forward(page, flow, gate);
      for (const path of ['/balances', '/expenses']) {
        await page.goto(path);
        await expect(page.getByRole('alert')).toContainText(FINANCIAL_FORMAT_REFUSAL);
        for (const amount of ['£6.75', '£3.75', '£7.50', '£4.50', '£3.00', '£1.50']) await expect(page.locator('body')).not.toContainText(amount);
        await expect(page.locator('body')).not.toContainText('Pringles');
        await expect(page.getByRole('button', { name: /Record payment/ })).toHaveCount(0);
      }
      expect(calls.filter(call => call.path === '/api/ledger').every(call => call.status === 426)).toBe(true);
      expect(calls.some(call => call.path === '/api/ledger')).toBe(true);
      const after = await flow.readLedger();
      expect(after.revision).toBe(revision);
      expect((await storedTrip(flow)).payments).toEqual([]);
    });
  });

  test('a previous bundle opened before the release keeps only its pre-release amounts, labelled, and its payment is refused', async ({ page }) => {
    await withFlow(page, async (flow, gate) => {
      // Before the release: the old server, and a ledger without discount records.
      const seeded = await flow.readLedger();
      const trip = seeded.data.trips.find(value => value.id === flow.tripId)!;
      const before = { ...trip, name: 'Groceries', expenses: [{ ...bogofExpense('dinner'), title: 'Dinner', adjustments: undefined, adjustmentAllocation: undefined,
        items: [{ id: 'd1', name: 'Pasta', amount: 1000, members: ['alice', 'bob'] }] }] };
      const preRelease = await flow.browserRequest('/api/ledger', { method: 'POST', body: JSON.stringify({ revision: seeded.revision, data: { trips: [before] } }) });
      expect(preRelease.status).toBe(200);
      let released = false;
      await page.route('**/api/**', route => released ? route.fallback() : routed(gate, route, async () => {
        const request = route.request(), url = new URL(request.url());
        if (url.pathname !== '/api/ledger') return route.fulfill({ json: url.pathname === '/api/profile' ? { id: flow.owner.id, displayName: flow.owner.displayName, email: flow.owner.email, authMethod: 'password' } : empty });
        const snapshot = await flow.readLedger();
        return route.fulfill({ json: snapshot, headers: { 'X-TripTab-Account': flow.owner.id } });
      }));
      await page.goto('/balances');
      await expect(page.locator('main')).toContainText('£5.00');
      // The release: the server now holds the BOGOF record and the boundary.
      const latest = await flow.readLedger();
      const response = await flow.browserRequest('/api/ledger', { method: 'POST', body: JSON.stringify({ revision: latest.revision,
        data: { trips: [{ ...latest.data.trips.find(value => value.id === flow.tripId)!, expenses: [...latest.data.trips.find(value => value.id === flow.tripId)!.expenses, bogofExpense()] }] } }) });
      expect(response.status).toBe(200);
      const revision = (await response.json() as { revision: number }).revision;
      released = true;
      const calls = await forward(page, flow, gate);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(page.getByText('Refresh failed. Showing the last loaded amounts.')).toBeVisible();
      // It never received the discount record, so it cannot show a gross-price total for it.
      await expect(page.locator('body')).not.toContainText('£6.75');
      await expect(page.locator('body')).not.toContainText('Pringles');
      // Recording the stale suggestion is refused with the reload instruction.
      await expect(page.locator('.settlement').first()).toContainText('pays Bob£5.00');
      // main re-reads the ledger before opening the payment, and that read is
      // refused; if a build opened the editor anyway, its write is refused too.
      await page.locator('.settlement').first().getByRole('button', { name: 'Record paid' }).click();
      const review = page.getByRole('button', { name: 'Review payment' });
      if (await review.isVisible({ timeout: 3000 }).catch(() => false)) {
        await review.click();
        await page.getByRole('button', { name: 'Confirm payment' }).click();
        await expect(page.getByText(FINANCIAL_FORMAT_REFUSAL).first()).toBeVisible();
      } else await expect(page.getByRole('alert')).toContainText('This holiday is no longer available.');
      expect(calls.filter(call => call.path === '/api/ledger').every(call => call.status === 426)).toBe(true);
      expect((await flow.readLedger()).revision).toBe(revision);
      expect((await storedTrip(flow)).payments).toEqual([]);
    });
  });
});

test('the current bundle reads, totals and settles the BOGOF receipt from the new server, and records the correct payment', async ({ page }) => {
  await withFlow(page, async (flow, gate) => {
    await seedBogof(flow);
    const calls = await forward(page, flow, gate);
    await page.goto('/balances');
    await expect(page.locator('.settlement').first()).toContainText('pays Bob£3.75');
    await expect(page.locator('main')).not.toContainText('£6.75');
    expect(calls.filter(call => call.path === '/api/ledger').every(call => call.status === 200 || call.status === 304)).toBe(true);
    await page.goto('/expenses');
    await expect(page.locator('main')).toContainText('£4.50');
    await expect(page.locator('main')).not.toContainText('£7.50');
    const trip = await storedTrip(flow);
    expect(trip.expenses[0].items.map(item => item.amount)).toEqual([300, 300, 150]);
    expect(settlements(trip)).toEqual([{ from: 'alice', to: 'bob', amount: 375 }]);
    // R14: record the suggested payment through the real ledger route, and
    // check what was persisted, not only what the page shows.
    const before = await flow.readLedger();
    await page.goto('/balances');
    await page.locator('.settlement').first().getByRole('button', { name: 'Record paid' }).click();
    await page.getByRole('button', { name: 'Review payment' }).click();
    await page.getByRole('button', { name: 'Confirm payment' }).click();
    await expect.poll(async () => (await storedTrip(flow)).payments.length).toBe(1);
    const paid = await storedTrip(flow);
    expect(paid.payments.map(payment => ({ from: payment.from, to: payment.to, amount: payment.amount }))).toEqual([{ from: 'alice', to: 'bob', amount: 375 }]);
    expect(paid.expenses).toEqual(trip.expenses);
    expect(settlements(paid)).toEqual([]);
    expect((await flow.readLedger()).revision).toBe(before.revision + 1);
    expect(calls.filter(call => call.path === '/api/ledger' && call.method === 'POST').map(call => call.status)).toEqual([200]);
    await expect(page.locator('.settlement')).toHaveCount(0);
  });
});
