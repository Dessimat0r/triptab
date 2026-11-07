import { expect, test, type Page, type Route } from '@playwright/test';
import type { Trip } from '../../lib/model';

// R02: private, account-bound panels across a session switch. Alice has an
// archived bill with amounts and people; Bob, signed in afterwards in the
// same browser (another tab changed the session), must see none of it.

const expense = (id: string, title: string, payer: string, people: string[], amount: number) => ({ id, title, date: '2026-11-01', time: '12:00', timezone: 'Europe/London',
  currency: 'GBP' as const, payer, tax: 0, tip: 0, discount: 0, items: [{ id: `${id}-line`, name: title, amount, members: people }] });
const aliceTrip: Trip = { id: 'alice-trip', ownerId: 'alice', name: 'Alice weekend', currency: 'GBP', kind: 'bill',
  members: [{ id: 'a-alice', name: 'Alice', userId: 'alice' }, { id: 'a-dana', name: 'Dana' }], expenses: [expense('a1', 'Taxi', 'a-alice', ['a-alice', 'a-dana'], 2000)], payments: [], drafts: [] };
const aliceArchive: Trip = { id: 'alice-archive', ownerId: 'alice', name: 'Secret spa', currency: 'GBP', kind: 'bill',
  members: [{ id: 's-alice', name: 'Alice', userId: 'alice' }, { id: 's-erin', name: 'Erin Private' }], expenses: [expense('s1', 'Massage', 's-alice', ['s-alice', 's-erin'], 9876)], payments: [], drafts: [] };
const bobTrip: Trip = { id: 'bob-trip', ownerId: 'bob', name: 'Bob lunch', currency: 'GBP', kind: 'bill',
  members: [{ id: 'b-bob', name: 'Bob', userId: 'bob' }, { id: 'b-finn', name: 'Finn' }], expenses: [expense('b1', 'Lunch', 'b-bob', ['b-bob', 'b-finn'], 1200)], payments: [], drafts: [] };

type Account = 'alice' | 'bob';
async function fixtures(page: Page) {
  const state = { account: 'alice' as Account, archives: { alice: [aliceArchive], bob: [] as Trip[] }, hold: null as null | ((release: () => void) => void),
    ledgers: { alice: [aliceTrip], bob: [bobTrip] }, archiveReads: [] as Account[] };
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, account = state.account;
    const headers = { 'X-TripTab-Account': account };
    if (path === '/api/profile') return route.fulfill({ json: { id: account, displayName: account === 'alice' ? 'Alice' : 'Bob', email: `${account}@example.invalid`, authMethod: 'password' } });
    if (path === '/api/ledger') {
      if (request.method() === 'POST') {
        state.ledgers[account] = (request.postDataJSON().data as { trips: Trip[] }).trips;
      }
      return route.fulfill({ json: { data: { trips: state.ledgers[account] }, revision: 2 }, headers });
    }
    if (path === '/api/trip' && request.method() === 'GET') {
      const mode = url.searchParams.get('mode');
      if (mode === 'archived-data') {
        state.archiveReads.push(account);
        const body = { trips: state.archives[account] };
        // A delayed answer for the account that asked, released by the test.
        if (state.hold) { const hold = state.hold; state.hold = null; await new Promise<void>(resolve => hold(resolve)); }
        return route.fulfill({ json: body, headers });
      }
      if (mode === 'connections') return route.fulfill({ json: { people: account === 'alice' ? [{ id: 'carol', name: 'Carol Alicefriend' }] : [{ id: 'gus', name: 'Gus' }] }, headers });
      return route.fulfill({ json: { trips: [], bills: [] }, headers });
    }
    if (path === '/api/trip-language') return route.fulfill({ json: { accountId: account, tripId: url.searchParams.get('tripId'), revision: 1, preferences: { readingLanguage: 'en', primaryVersion: 'reading', itemVersions: {} } } });
    if (path === '/api/receipt/ai-status') return route.fulfill({ json: { configured: false, connected: false, provider: 'api', eligible: false, manageable: false, siwcAvailable: false } });
    return route.fulfill({ json: { events: [], notifications: [], items: [], invitations: [], nextCursor: null } });
  });
  return state;
}
/** Another tab signs in as Bob; this tab notices on its next ledger check. */
async function switchToBob(page: Page, state: { account: Account }) {
  state.account = 'bob';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('main')).toContainText('Bob lunch');
}
const aliceSecrets = ['Secret spa', 'Massage', 'Erin Private', '£98.76', '£49.38', 'Carol Alicefriend', 'Alice weekend', 'Taxi'];

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function openActivity(page: Page) {
  await page.getByRole('button', { name: 'Open holidays', exact: true }).click();
  await page.getByRole('button', { name: 'Activity and people', exact: true }).click();
  return page.getByRole('dialog', { name: 'Activity and people' });
}

test('R02: after a session switch the open Activity panel shows none of the previous account\'s archive, amounts or people', async ({ page }) => {
  const state = await fixtures(page);
  await page.goto('/expenses');
  const view = await openActivity(page);
  await expect(view).toContainText('Massage');
  await view.getByRole('tab', { name: 'People' }).click();
  await expect(view).toContainText('Erin Private');
  await switchToBob(page, state);
  for (const text of aliceSecrets) await expect(page.locator('body')).not.toContainText(text);
  // The panel now holds Bob's own data only.
  const current = page.getByRole('dialog', { name: 'Activity and people' });
  if (await current.count()) {
    await current.getByRole('tab', { name: 'Activity' }).click();
    await expect(current).toContainText('Lunch');
  }
});

test('R02: a delayed archive response for the previous account never appears after the switch', async ({ page }) => {
  const state = await fixtures(page);
  let release: () => void = () => {};
  state.hold = resolve => { release = resolve; };
  await page.goto('/expenses');
  const view = await openActivity(page);
  await expect.poll(() => state.archiveReads.length).toBeGreaterThan(0);
  await expect(view).not.toContainText('Massage');
  await switchToBob(page, state);
  release();
  await page.waitForTimeout(500);
  for (const text of aliceSecrets) await expect(page.locator('body')).not.toContainText(text);
});

test('R02: an archive whose membership is revoked while the panel is open disappears from it', async ({ page }) => {
  const state = await fixtures(page);
  await page.goto('/expenses');
  const view = await openActivity(page);
  await expect(view).toContainText('Massage');
  state.archives.alice = [];
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(view).not.toContainText('Massage');
  await view.getByRole('tab', { name: 'People' }).click();
  await expect(view).not.toContainText('Erin Private');
});

test('R02: on a bill both accounts share, the Undo notice and open connection suggestions belong to the account that saw them', async ({ page }) => {
  const state = await fixtures(page);
  // Bob is also on Alice's bill.
  const shared: Trip = { ...aliceTrip, members: [...aliceTrip.members, { id: 'a-bob', name: 'Bob', userId: 'bob' }] };
  state.ledgers.alice = [shared];
  await page.goto('/expenses');
  await expect(page.locator('main')).toContainText('Taxi');
  await page.locator('[data-entry-id="a1"]').first().getByRole('button', { name: /actions/i }).click();
  await page.getByRole('menuitem', { name: /Delete/ }).click();
  const confirm = page.getByRole('dialog').filter({ hasText: 'Delete expense?' });
  if (await confirm.isVisible({ timeout: 1000 }).catch(() => false)) await confirm.getByRole('button', { name: 'Delete expense' }).click();
  await expect(page.getByText('Deleted “Taxi”')).toBeVisible();
  await page.getByRole('button', { name: /Bill options/ }).first().click();
  await page.getByRole('dialog', { name: 'Bill options' }).getByRole('button', { name: 'People', exact: true }).click();
  await expect(page.locator('body')).toContainText('Carol Alicefriend');
  // Bob signs in elsewhere; the shared bill is still selected for him.
  state.ledgers.bob = [...state.ledgers.alice, bobTrip];
  state.account = 'bob';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('body')).toContainText('Bob lunch');
  await expect(page.locator('body')).not.toContainText('Carol Alicefriend');
  await expect(page.getByText('Deleted “Taxi”')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Undo/ })).toHaveCount(0);
  expect(state.ledgers.bob.find(trip => trip.id === 'alice-trip')!.expenses).toEqual([]);
});
