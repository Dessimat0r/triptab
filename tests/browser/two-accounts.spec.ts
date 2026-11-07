import { expect, test, type Browser, type BrowserContext, type Page, type Route } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import type { Expense, Ledger, Trip } from '../../lib/model';
import { createReceiptFlowWorker } from '../helpers/receipt-flow-worker';
import { FINANCIAL_FORMAT, FINANCIAL_FORMAT_HEADER } from '../../lib/financial-format';

// Audit acceptance tests, in the audit's own form: two real accounts, each in
// its own browser, against the production routes (auth, ledger, trip, activity,
// notifications) in one isolated Worker with D1 and R2. Every page request is
// forwarded with that account's session; stored JSON is read back from D1.
// Gary is the native-flow owner ("Native Flow Owner", traveller `alice` on the
// holiday); Sam is a second account linked to the holiday's traveller `bob`.
type Flow = Awaited<ReturnType<typeof createReceiptFlowWorker>>;
type Gate = { closing: boolean; inflight: Set<Promise<unknown>> };
type Account = { token: string; context: BrowserContext; page: Page };

async function routed(gate: Gate, route: Route, handle: () => Promise<void>) {
  if (gate.closing) return route.abort('aborted'); // teardown has begun (R14 order)
  const task = handle();
  gate.inflight.add(task);
  try { await task; } finally { gate.inflight.delete(task); }
}
async function open(browser: Browser, flow: Flow, gate: Gate, token: string): Promise<Account> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
  await context.route('**/api/**', route => routed(gate, route, async () => {
    const request = route.request(), url = new URL(request.url());
    const headers: Record<string, string> = {};
    // Playwright cannot fulfil a 304, so validators are not forwarded (see cached-client.spec.ts).
    for (const [name, value] of Object.entries(request.headers())) if (!['host', 'content-length', 'cookie', 'if-none-match', 'if-modified-since'].includes(name)) headers[name] = value;
    headers.cookie = `tt_session=${token}`;
    if (headers.origin) headers.origin = flow.origin;
    const response = await flow.worker.dispatchFetch(flow.origin + url.pathname + url.search, {
      method: request.method(), headers, body: ['GET', 'HEAD'].includes(request.method()) ? undefined : request.postDataBuffer() ?? undefined } as never);
    if (response.status === 404 && (await response.clone().text()) === 'Not found') {
      // Routes outside this Worker answer as an empty account would.
      return route.fulfill({ json: { trips: [], events: [], notifications: [], people: [], bills: [], items: [], invitations: [], nextCursor: null } });
    }
    const responseHeaders = Object.fromEntries([...response.headers].filter(([name]) => !['content-encoding', 'content-length', 'set-cookie'].includes(name)));
    return route.fulfill({ status: response.status, headers: responseHeaders, body: Buffer.from(await response.arrayBuffer()) });
  }));
  return { token, context, page: await context.newPage() };
}
async function withTwoAccounts(browser: Browser, run: (flow: Flow, gary: Account, sam: Account) => Promise<void>) {
  const flow = await createReceiptFlowWorker();
  const gate: Gate = { closing: false, inflight: new Set() };
  const samToken = randomBytes(32).toString('base64url'), now = new Date().toISOString();
  await flow.database.batch([
    flow.database.prepare('INSERT INTO profiles(id,email,display_name,created_at) VALUES(?,?,?,?)').bind('sam-account', 'sam@example.test', 'Sam', now),
    flow.database.prepare('INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at,session_id) VALUES(?,?,?,?,?)')
      .bind(createHash('sha256').update(samToken).digest('hex'), 'sam-account', new Date(Date.now() + 60 * 60_000).toISOString(), now, 'sam-session'),
    flow.database.prepare('INSERT INTO memberships(trip_id,user_id,member_id) VALUES(?,?,?)').bind(flow.tripId, 'sam-account', 'bob'),
  ]);
  const accounts: Account[] = [];
  try {
    accounts.push(await open(browser, flow, gate, flow.sessionToken), await open(browser, flow, gate, samToken));
    await run(flow, accounts[0], accounts[1]);
  } finally {
    gate.closing = true;
    while (gate.inflight.size) await Promise.allSettled([...gate.inflight]);
    for (const account of accounts) await account.context.close();
    await flow.dispose();
  }
}
const expense = (id: string, title: string, payer: string, amount: number, members: string[]): Expense => ({ id, title, date: '2026-11-07', time: '19:00',
  timezone: 'Europe/London', currency: 'GBP', payer, tax: 0, tip: 0, discount: 0, items: [{ id: `${id}-item`, name: title, amount, members }] }) as Expense;
/** Gary's direct ledger write (setup only; the journeys themselves go through the pages). */
async function seed(flow: Flow, change: (data: Ledger) => void) {
  const snapshot = await flow.readLedger();
  change(snapshot.data);
  const response = await flow.browserRequest('/api/ledger', { method: 'POST', body: JSON.stringify(snapshot) });
  expect(response.status, await response.clone().text()).toBe(200);
}
const storedTrip = async (flow: Flow, tripId: string) => {
  const row = await flow.database.prepare('SELECT data FROM trips WHERE id = ?').bind(tripId).first<{ data: string }>();
  return row ? JSON.parse(row.data) as Trip : undefined;
};
const notifications = async (flow: Flow, user: string) => (await flow.database.prepare('SELECT title, body FROM notifications WHERE user_id = ? ORDER BY created_at')
  .bind(user).all<{ title: string; body: string }>()).results;
const row = (page: Page, id: string) => page.locator(`[data-entry-id="${id}"]`);
async function openActivity(page: Page) {
  await page.getByRole('button', { name: 'Open holidays', exact: true }).click();
  await page.getByRole('button', { name: 'Activity and people', exact: true }).click();
  return page.getByRole('dialog', { name: 'Activity and people' });
}

test('acceptance 7 and 8: a bill reaches Sam\'s account, shows his share, and an edit by Gary updates it for Sam; Gary\'s other bill stays private', async ({ browser }) => {
  await withTwoAccounts(browser, async (flow, gary, sam) => {
    await seed(flow, data => data.trips.push(
      { id: 'taxi-bill', kind: 'bill', name: 'Taxi', currency: 'GBP', members: [{ id: 't-gary', name: 'Gary' }, { id: 't-sam', name: 'Sam' }],
        expenses: [expense('taxi', 'Taxi', 't-gary', 3000, ['t-gary', 't-sam'])], drafts: [], payments: [] } as Trip,
      { id: 'private-bill', kind: 'bill', name: 'Private', currency: 'GBP', members: [{ id: 'p-gary', name: 'Gary' }, { id: 'p-other', name: 'Sam' }],
        expenses: [expense('gift', 'Secret gift', 'p-gary', 5000, ['p-gary', 'p-other'])], drafts: [], payments: [] } as Trip));
    // Gary adds Sam's account to the taxi bill (they already share the holiday).
    const added = await flow.browserRequest('/api/trip', { method: 'POST', body: JSON.stringify({ action: 'add-connected', tripId: 'taxi-bill', memberId: 't-sam', accountId: 'sam-account' }) });
    expect(added.status, await added.clone().text()).toBe(200);
    expect((await storedTrip(flow, 'taxi-bill'))!.members.find(member => member.id === 't-sam')?.userId).toBe('sam-account');
    await expect.poll(async () => (await notifications(flow, 'sam-account')).length).toBeGreaterThan(0);
    // Sam's own browser: the bill is in his list and Activity shows his share.
    await sam.page.goto('/expenses');
    let activity = await openActivity(sam.page);
    await expect(activity.locator('.activity-row', { hasText: 'Taxi' })).toContainText('Your share £15.00');
    await expect(activity).not.toContainText('Secret gift');
    // Privacy on the server, not just the screen: Sam's ledger has no private bill.
    // (A bare page fetch would be refused by the R01 money-format boundary, so read as the current bundle does.)
    const samLedger = await (await flow.worker.dispatchFetch(`${flow.origin}/api/ledger`, { headers: { cookie: `tt_session=${sam.token}`, [FINANCIAL_FORMAT_HEADER]: String(FINANCIAL_FORMAT) } } as never)).json() as { data: { trips: { id: string }[] } };
    expect(samLedger.data.trips.map(trip => trip.id).sort()).toEqual(['flow-trip', 'taxi-bill']);
    // Gary, in his browser, raises the taxi to £40.
    const toldBeforeEdit = (await notifications(flow, 'sam-account')).length;
    await gary.page.goto('/expenses');
    await gary.page.getByRole('button', { name: 'Open holidays', exact: true }).click();
    await gary.page.getByRole('button', { name: /^Taxi/ }).click();
    await row(gary.page, 'taxi').locator('.expense-open').click();
    await gary.page.getByRole('textbox', { name: 'Amount', exact: true }).fill('40');
    await gary.page.getByRole('button', { name: 'Save expense', exact: true }).click();
    await expect(gary.page.locator('.editor')).toHaveCount(0);
    await expect.poll(async () => (await storedTrip(flow, 'taxi-bill'))!.expenses[0].items[0].amount).toBe(4000);
    // Sam sees the new share after a refresh, and was told about the change.
    await sam.page.reload();
    activity = await openActivity(sam.page);
    await expect(activity.locator('.activity-row', { hasText: 'Taxi' })).toContainText('Your share £20.00');
    await expect.poll(async () => (await notifications(flow, 'sam-account')).length).toBe(toldBeforeEdit + 1);
    expect((await notifications(flow, 'sam-account')).at(-1)!.title + (await notifications(flow, 'sam-account')).at(-1)!.body).toMatch(/Taxi/);
  });
});

test('acceptance 4: Gary deletes a shared expense from its ⋯ menu; Sam is told and no longer sees it; Undo brings it back for both', async ({ browser }) => {
  await withTwoAccounts(browser, async (flow, gary, sam) => {
    await seed(flow, data => { data.trips.find(trip => trip.id === flow.tripId)!.expenses.push(expense('coffee', 'Coffee', 'alice', 1240, ['alice', 'bob'])); });
    await sam.page.goto('/expenses');
    await expect(row(sam.page, 'coffee')).toHaveCount(1);
    const told = (await notifications(flow, 'sam-account')).length;
    await gary.page.goto('/expenses');
    const menu = row(gary.page, 'coffee').getByRole('button', { name: 'Actions for Coffee' });
    await menu.focus(); await gary.page.keyboard.press('Enter');
    await gary.page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(row(gary.page, 'coffee')).toHaveCount(0);
    await expect.poll(async () => (await storedTrip(flow, flow.tripId))!.expenses.some(value => value.id === 'coffee')).toBe(false);
    // The stored delete event keeps the full before snapshot.
    const event = await flow.database.prepare("SELECT before_data FROM activity_events WHERE trip_id = ? AND entity_id = 'coffee' AND action = 'delete'").bind(flow.tripId).first<{ before_data: string }>();
    expect(JSON.parse(event!.before_data).items[0].amount).toBe(1240);
    await expect.poll(async () => (await notifications(flow, 'sam-account')).length).toBe(told + 1);
    await sam.page.reload();
    await expect(sam.page.locator('.expense-list')).toBeVisible();
    await expect(row(sam.page, 'coffee')).toHaveCount(0);
    // Undo, in Gary's browser.
    await gary.page.locator('.saved-banner').getByRole('button', { name: /Undo/ }).click();
    await expect.poll(async () => (await storedTrip(flow, flow.tripId))!.expenses.find(value => value.id === 'coffee')?.items[0].amount).toBe(1240);
    await sam.page.reload();
    await expect(row(sam.page, 'coffee')).toHaveCount(1);
  });
});

test('acceptance 9: Gary changes the amount while Sam renames the same expense on an old copy; Sam\'s save keeps both', async ({ browser }) => {
  await withTwoAccounts(browser, async (flow, gary, sam) => {
    await seed(flow, data => { data.trips.find(trip => trip.id === flow.tripId)!.expenses.push(expense('dinner', 'Dinner', 'alice', 2000, ['alice', 'bob'])); });
    // Both open the £20 dinner.
    for (const account of [gary, sam]) {
      await account.page.goto('/expenses');
      await row(account.page, 'dinner').locator('.expense-open').click();
      await expect(account.page.locator('.editor')).toBeVisible();
    }
    await gary.page.getByRole('textbox', { name: 'Amount', exact: true }).fill('30');
    await gary.page.getByRole('button', { name: 'Save expense', exact: true }).click();
    await expect(gary.page.locator('.editor')).toHaveCount(0);
    await expect.poll(async () => (await storedTrip(flow, flow.tripId))!.expenses.find(value => value.id === 'dinner')?.items[0].amount).toBe(3000);
    // Sam, still on the £20 copy, changes only the name.
    await sam.page.getByRole('textbox', { name: 'Expense name', exact: true }).fill("Dinner at Rosa's");
    await sam.page.getByRole('button', { name: 'Save expense', exact: true }).click();
    await expect(sam.page.locator('.merge-notice')).toBeVisible();
    await expect(sam.page.getByRole('textbox', { name: 'Amount', exact: true })).toHaveValue('30.00');
    await sam.page.getByRole('button', { name: 'Save expense', exact: true }).click();
    await expect(sam.page.locator('.editor')).toHaveCount(0);
    await expect.poll(async () => {
      const saved = (await storedTrip(flow, flow.tripId))!.expenses.find(value => value.id === 'dinner');
      return [saved?.title, saved?.items[0].amount];
    }).toEqual(["Dinner at Rosa's", 3000]);
  });
});
