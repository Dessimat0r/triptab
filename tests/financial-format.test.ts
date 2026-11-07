import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { calculationHealth } from '../lib/calculation-health';
import { FINANCIAL_FORMAT, FINANCIAL_FORMAT_HEADER, FINANCIAL_FORMAT_REFUSAL, financialFormatRefusal, requestFinancialFormat } from '../lib/financial-format';
import { balances, expenseShares, NEWER_FORMAT_MESSAGE, settlements, total, type Expense, type Trip } from '../lib/model';
import { bogofExpense, bogofMembers } from './helpers/bogof';
import { createReceiptFlowWorker } from './helpers/receipt-flow-worker';

// R01 (P0): a bundle built before scoped discounts reads only line prices. Shown
// the BOGOF record it suggests Alice pays Bob 675 instead of 375. The server is
// the only part a release can change for a bundle already open in a browser,
// so these tests run the production routes (auth, D1, CAS) in an isolated Worker.

const declared = { [FINANCIAL_FORMAT_HEADER]: String(FINANCIAL_FORMAT) };

test('R01: the format a request declares is read strictly, and anything unreadable is the original format', () => {
  const request = (value?: string) => new Request('https://triptab.test/api/ledger', value === undefined ? {} : { headers: { [FINANCIAL_FORMAT_HEADER]: value } });
  assert.equal(requestFinancialFormat(request()), 1);
  assert.equal(requestFinancialFormat(request('2')), 2);
  assert.equal(requestFinancialFormat(request(' 3 ')), 3);
  for (const value of ['', '0', '-2', '2.0', 'two', '1e3', '99999']) assert.equal(requestFinancialFormat(request(value)), 1, value);
  assert.equal(financialFormatRefusal(request('2')), null);
  assert.equal(financialFormatRefusal(request('1'))?.status, 426);
});

test('R01-E: only the exact supported format is accepted. Missing, invalid, older and newer declarations are all refused with 426 and the same headers', async () => {
  const request = (value?: string, method = 'GET') => new Request('https://triptab.test/api/ledger', { method, ...(value === undefined ? {} : { headers: { [FINANCIAL_FORMAT_HEADER]: value } }) });
  assert.equal(financialFormatRefusal(request(String(FINANCIAL_FORMAT))), null, 'the supported format proceeds');
  assert.equal(financialFormatRefusal(request(` ${FINANCIAL_FORMAT} `)), null, 'surrounding spaces are tolerated, as before');
  for (const value of [undefined, '', 'x', '0', '1', '3', '4', '9999', '2.0', '-2']) {
    const refusal = financialFormatRefusal(request(value));
    assert.equal(refusal?.status, 426, `declaration ${JSON.stringify(value)}`);
    assert.equal(refusal?.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(refusal?.headers.get('X-TripTab-Financial-Format-Required'), String(FINANCIAL_FORMAT));
    assert.deepEqual(await refusal!.clone().json(), { error: FINANCIAL_FORMAT_REFUSAL });
  }
  const head = financialFormatRefusal(request('3', 'HEAD'));
  assert.equal(head?.status, 426);
  assert.equal(await head!.text(), '', 'a HEAD refusal has no body');
});

test('R01: an undeclared (cached) bundle receives no ledger money and cannot write, while a current bundle reads the scoped record', async () => {
  const flow = await createReceiptFlowWorker();
  try {
    const seeded = await flow.readLedger();
    const trip = seeded.data.trips.find(value => value.id === flow.tripId)!;
    assert.deepEqual(trip.members.map(member => member.id), bogofMembers.map(member => member.id));
    const saved = await flow.browserRequest('/api/ledger', { method: 'POST',
      body: JSON.stringify({ revision: seeded.revision, data: { trips: [{ ...trip, expenses: [bogofExpense()] }] } }) });
    assert.equal(saved.status, 200, await saved.clone().text());
    const stored = (await saved.json() as { data: { trips: Trip[] }; revision: number });
    const storedTrip = stored.data.trips.find(value => value.id === flow.tripId)!;
    // Raw stored financial data, not UI text: printed prices kept, discount separate.
    assert.deepEqual(storedTrip.expenses[0].items.map(item => item.amount), [300, 300, 150]);
    assert.equal(storedTrip.expenses[0].adjustmentAllocation, 'scoped-adjustments');
    assert.deepEqual(expenseShares(storedTrip.expenses[0], storedTrip.members, 'GBP'), [375, 75]);
    assert.deepEqual(settlements(storedTrip), [{ from: 'alice', to: 'bob', amount: 375 }]);

    const cookie = { cookie: `tt_session=${flow.sessionToken}` };
    const write = { origin: flow.origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
    const old = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
      flow.worker.dispatchFetch(flow.origin + path, { ...init, headers: { ...cookie, ...init.headers } } as never);
    for (const [label, headers] of [['undeclared', {}], ['format 1', { [FINANCIAL_FORMAT_HEADER]: '1' }], ['unreadable', { [FINANCIAL_FORMAT_HEADER]: 'scoped' }]] as const) {
      for (const response of [await old('/api/ledger', { headers }), await old('/api/ledger', { headers: { ...headers, 'If-None-Match': saved.headers.get('etag')! } }),
        await old(`/api/activity?tripId=${flow.tripId}`, { headers })]) {
        assert.equal(response.status, 426, label);
        assert.equal(response.headers.get('x-triptab-financial-format-required'), String(FINANCIAL_FORMAT));
        assert.equal(response.headers.get('cache-control'), 'private, no-store');
        assert.equal(response.headers.get('x-triptab-account'), null, 'a refusal reveals no account');
        const text = await response.text();
        assert.deepEqual(JSON.parse(text), { error: FINANCIAL_FORMAT_REFUSAL });
        assert.doesNotMatch(text, /Pringles|Tesco|alice|bob|300|375|675/i);
      }
      const head = await old('/api/ledger', { method: 'HEAD', headers });
      assert.equal(head.status, 426);
      assert.equal(head.headers.get('etag'), null);
      // The suggested payment a cached bundle would record (675) is never committed.
      const payment = { id: 'stale-suggestion', from: 'alice', to: 'bob', amount: 675, date: '2026-11-06' };
      const posted = await old('/api/ledger', { method: 'POST', headers: { ...headers, ...write },
        body: JSON.stringify({ revision: stored.revision, data: { trips: [{ ...storedTrip, payments: [payment] }] } }) });
      assert.equal(posted.status, 426);
      assert.deepEqual(await posted.json(), { error: FINANCIAL_FORMAT_REFUSAL });
    }
    // A signed-out cached bundle is refused the same way, before authentication.
    const anonymous = await flow.worker.dispatchFetch(flow.origin + '/api/ledger');
    assert.equal(anonymous.status, 426);
    const after = await flow.readLedger();
    assert.equal(after.revision, stored.revision, 'refused writes left the ledger untouched');
    assert.deepEqual(after.data.trips.find(value => value.id === flow.tripId)!.payments, []);
    // The current bundle still reads and settles correctly from the same server.
    const current = await flow.worker.dispatchFetch(flow.origin + '/api/ledger', { headers: { ...cookie, ...declared } });
    assert.equal(current.status, 200);
    const currentTrip = (await current.json() as { data: { trips: Trip[] } }).data.trips.find(value => value.id === flow.tripId)!;
    assert.deepEqual(settlements(currentTrip), [{ from: 'alice', to: 'bob', amount: 375 }]);
    const history = await flow.worker.dispatchFetch(flow.origin + `/api/activity?tripId=${flow.tripId}`, { headers: { ...cookie, ...declared } });
    assert.equal(history.status, 200);
  } finally { await flow.dispose(); }
});

test('R01: a reader refuses an entry saved under a calculation rule it does not know instead of falling back to gross prices', () => {
  const future = { ...bogofExpense('future'), adjustmentAllocation: 'per-person-vouchers' } as unknown as Expense;
  assert.throws(() => total(future), { message: NEWER_FORMAT_MESSAGE });
  assert.throws(() => expenseShares(future, bogofMembers, 'GBP'), { message: NEWER_FORMAT_MESSAGE });
  const trip: Trip = { id: 't', name: 'Groceries', currency: 'GBP', members: bogofMembers, expenses: [bogofExpense('known'), future], drafts: [], payments: [] };
  assert.throws(() => balances(trip), { message: NEWER_FORMAT_MESSAGE });
  assert.throws(() => settlements(trip), { message: NEWER_FORMAT_MESSAGE });
  // The app names the entry and shows only a labelled partial total (F-20).
  assert.deepEqual(calculationHealth(trip), { failing: [{ id: 'future', title: 'Tesco', message: NEWER_FORMAT_MESSAGE }], partialSpent: 450 });
  const malformed = { ...bogofExpense('malformed'), adjustments: { amount: 300 } } as unknown as Expense;
  assert.throws(() => total(malformed), { message: NEWER_FORMAT_MESSAGE });
});

test('R01: every client request that reads or writes ledger money declares the format', async () => {
  const gated = /["'`]\/api\/(?:ledger|activity\?|receipt\/process|trip\?mode=archived-data|export|import|offline-expenses|invite|receipt\/audit)/;
  const offenders: string[] = [];
  for (const folder of ['components', 'hooks', 'lib']) {
    for (const name of await readdir(new URL(`../${folder}/`, import.meta.url), { recursive: true })) {
      if (!/\.(tsx?|js)$/.test(name)) continue;
      const source = await readFile(new URL(`../${folder}/${name}`, import.meta.url), 'utf8');
      // Each fetch call up to its closing options, on one or two lines.
      for (const match of source.matchAll(/fetch\(([^;]*?)\)(?:;|\s*\.then|\s*\.catch)/g)) {
        if (gated.test(match[1]) && !match[1].includes('financialFormatHeaders(')) offenders.push(`${folder}/${name}: ${match[1].slice(0, 80)}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
  // Activity pages build their URL from the endpoint, so check that fetch directly.
  const activity = await readFile(new URL('../components/activity-panel.tsx', import.meta.url), 'utf8');
  assert.match(activity, /fetch\(url\.pathname \+ url\.search, \{[^}]*headers: financialFormatHeaders\(\)/);
});

test('R01: no client links straight to a money-bearing download, and the shared download helper declares the format', async () => {
  // A plain link cannot send the declaration, so the server would refuse it.
  const offenders: string[] = [];
  for (const folder of ['components', 'app']) {
    for (const name of await readdir(new URL(`../${folder}/`, import.meta.url), { recursive: true })) {
      if (!/\.(tsx?|jsx?)$/.test(name) || name.startsWith('api/') || name.includes('/api/')) continue;
      const source = await readFile(new URL(`../${folder}/${name}`, import.meta.url), 'utf8');
      if (/href=\{?\s*[`"']\/api\/(?:export|receipt\/audit)/.test(source)) offenders.push(`${folder}/${name}`);
    }
  }
  assert.deepEqual(offenders, []);
  const helper = await readFile(new URL('../components/download-button.tsx', import.meta.url), 'utf8');
  assert.match(helper, /headers: financialFormatHeaders\(\)/);
  const offline = await readFile(new URL('../components/offline-capture.tsx', import.meta.url), 'utf8');
  assert.match(offline, /refusedFinancialFormat\(response\)/);
});
