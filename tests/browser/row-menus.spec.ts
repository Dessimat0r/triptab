import { expect, test, type Page, type Locator } from '@playwright/test';
import { validateLedger, type Expense, type Trip } from '../../lib/model';

// F-06 follow-up: payment rows, receipt-draft rows and the drawer's holiday and
// bill rows have the same ⋯ menu (and swipe, for list rows) as expense rows.
const members = [{ id: 'gary', name: 'Gary', userId: 'owner' }, { id: 'sam', name: 'Sam' }];
const expense = (id: string, title: string, amount: number, payer: string): Expense => ({ id, title, date: '2026-11-06', time: '12:00', timezone: 'Europe/London',
  currency: 'GBP', payer, tax: 0, tip: 0, discount: 0, items: [{ id: `${id}-item`, name: title, amount, members: ['gary', 'sam'] }] });
const bill = (id = 'menus-bill', name = 'Coffee'): Trip => ({ id, ownerId: 'owner', kind: 'bill', name, currency: 'GBP', members,
  expenses: [expense(`${id}-coffee`, 'Coffee', 1240, 'gary')],
  payments: [{ id: `${id}-paid`, from: 'sam', to: 'gary', amount: 620, date: '2026-11-06' }],
  drafts: [{ id: `${id}-draft`, title: 'Lunch receipt', status: 'review', currency: 'GBP', date: '2026-11-06', time: '13:00', timezone: 'Europe/London',
    payer: 'gary', tax: 0, tip: 0, discount: 0, items: [{ id: 'lunch-item', name: 'Lunch', amount: 900, members: ['gary', 'sam'] }] }] });
const holiday: Trip = { id: 'menus-holiday', ownerId: 'owner', name: 'Lisbon', currency: 'EUR', members, expenses: [], payments: [], drafts: [] };

async function fixtures(page: Page, initial: Trip[]) {
  let trips = validateLedger({ trips: initial }).trips, revision = 1;
  const posts: Trip[][] = [], tripActions: Record<string, string>[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (pathname === '/api/ledger' && request.method() === 'POST') {
      try { trips = validateLedger(request.postDataJSON().data, { source: 'web', previous: { trips } }).trips; }
      catch (error) { return route.fulfill({ status: 400, json: { error: String(error) } }); }
      posts.push(structuredClone(trips));
      return route.fulfill({ json: { data: { trips }, revision: ++revision }, headers: { 'X-TripTab-Account': 'owner' } });
    }
    if (pathname === '/api/trip' && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, string>;
      tripActions.push(body);
      if (body.action === 'archive' || body.action === 'delete' || body.action === 'discard') trips = trips.filter(trip => trip.id !== body.tripId);
      revision++;
      return route.fulfill({ json: { ok: true, deleted: true } });
    }
    const json = pathname === '/api/ledger' ? { data: { trips }, revision }
      : pathname === '/api/profile' ? { id: 'owner', displayName: 'Gary', email: 'gary@example.invalid', authMethod: 'password' }
      : pathname === '/api/receipt/ai-status' ? { configured: false, connected: false, provider: 'api', eligible: false, manageable: false, siwcAvailable: false }
      : pathname === '/api/trip-language' ? { accountId: 'owner', tripId: initial[0].id, revision: 1, preferences: { readingLanguage: 'en', primaryVersion: 'reading', itemVersions: {} } }
      : { events: [], notifications: [], items: [], invitations: [] };
    return route.fulfill({ json, headers: pathname === '/api/ledger' ? { 'X-TripTab-Account': 'owner' } : {} });
  });
  return { get trips() { return trips; }, posts, tripActions };
}
const row = (page: Page, id: string) => page.locator(`[data-entry-id="${id}"]`);
async function swipeLeft(target: Locator) {
  const box = (await target.boundingBox())!;
  const y = box.y + box.height / 2, start = box.x + box.width - 30;
  const event = (type: string, x: number) => target.dispatchEvent(type, { pointerType: 'touch', pointerId: 7, isPrimary: true, clientX: x, clientY: y, bubbles: true });
  await event('pointerdown', start);
  for (const step of [10, 30, 60, 90, 120]) await event('pointermove', start - step);
  await event('pointerup', start - 120);
}

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test('payment row: ⋯ → Delete payment asks first, then Undo restores the same payment', async ({ page }) => {
  const state = await fixtures(page, [bill()]);
  await page.goto('/balances');
  const payment = row(page, 'menus-bill-paid');
  await payment.getByRole('button', { name: 'Actions for Sam → Gary' }).click();
  await expect(page.getByRole('menuitem', { name: 'Edit' })).toBeFocused();
  await page.getByRole('menuitem', { name: 'Delete payment' }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove recorded payment?' });
  await expect(dialog).toContainText('Remove the recorded payment of £6.20 from Sam to Gary?');
  await dialog.getByRole('button', { name: 'Remove payment' }).click();
  await expect(payment).toHaveCount(0);
  expect(state.trips[0].payments).toEqual([]);
  await page.locator('.saved-banner').getByRole('button', { name: /Undo/ }).click();
  await expect(payment).toHaveCount(1);
  expect(state.trips[0].payments).toEqual([{ id: 'menus-bill-paid', from: 'sam', to: 'gary', amount: 620, date: '2026-11-06' }]);
});

test('payment row: swipe reveals Delete payment, which still asks before removing anything', async ({ page }) => {
  const state = await fixtures(page, [bill()]);
  await page.goto('/balances');
  await swipeLeft(row(page, 'menus-bill-paid'));
  const reveal = page.locator('.swipe-row--revealed .swipe-row-delete');
  await expect(reveal).toHaveText('Delete payment');
  await reveal.click();
  await page.getByRole('dialog', { name: 'Remove recorded payment?' }).getByRole('button', { name: 'Cancel' }).click();
  expect(state.posts).toHaveLength(0);
  await expect(row(page, 'menus-bill-paid')).toHaveCount(1);
});

test('draft row: ⋯ offers Review and Remove draft; swipe removes it at once with Undo', async ({ page }) => {
  const state = await fixtures(page, [bill()]);
  await page.goto('/expenses');
  const draft = row(page, 'menus-bill-draft');
  await draft.getByRole('button', { name: 'Actions for Lunch receipt' }).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Review', 'Remove draft']);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await swipeLeft(draft);
  await page.locator('.swipe-row--revealed .swipe-row-delete').click();
  await expect(draft).toHaveCount(0);
  expect(state.trips[0].drafts).toEqual([]);
  await page.locator('.saved-banner').getByRole('button', { name: /Undo/ }).click();
  await expect(draft).toHaveCount(1);
  expect(state.trips[0].drafts.map(value => value.id)).toEqual(['menus-bill-draft']);
});

test('drawer: a bill row\'s ⋯ removes it from my list in two taps, with the same server action', async ({ page }) => {
  const state = await fixtures(page, [holiday, bill()]);
  await page.goto('/expenses');
  await page.getByRole('button', { name: 'Open holidays' }).click();
  const drawer = page.locator('#holiday-sidebar');
  await drawer.getByRole('button', { name: 'Actions for Coffee' }).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Open', 'Bill options', 'Remove from my list', 'Delete bill']);
  // The menu stays inside the viewport at phone width.
  const box = (await page.getByRole('menu').boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await page.getByRole('menuitem', { name: 'Remove from my list' }).click();
  await expect.poll(() => state.tripActions).toEqual([{ action: 'archive', tripId: 'menus-bill', memberId: '', confirmName: '' }]);
});

test('drawer: Delete bill asks the same plain confirmation as Manage this bill', async ({ page }) => {
  const state = await fixtures(page, [holiday, bill()]);
  await page.goto('/expenses');
  await page.getByRole('button', { name: 'Open holidays' }).click();
  await page.locator('#holiday-sidebar').getByRole('button', { name: 'Actions for Coffee' }).click();
  await page.getByRole('menuitem', { name: 'Delete bill' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete this bill?' });
  await expect(dialog).toContainText('Delete “Coffee” with 1 expense and 1 payment?');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(state.tripActions).toEqual([]);
  await page.locator('#holiday-sidebar').getByRole('button', { name: 'Actions for Coffee' }).click();
  await page.getByRole('menuitem', { name: 'Delete bill' }).click();
  await page.getByRole('dialog', { name: 'Delete this bill?' }).getByRole('button', { name: 'Delete bill' }).click();
  await expect.poll(() => state.tripActions).toEqual([{ action: 'delete', tripId: 'menus-bill', memberId: '', confirmName: 'Coffee' }]);
});

test('drawer: a holiday row\'s ⋯ opens Holiday settings without deleting anything', async ({ page }) => {
  const state = await fixtures(page, [holiday, bill()]);
  await page.goto('/expenses');
  await page.getByRole('button', { name: 'Open holidays' }).click();
  await page.locator('#holiday-sidebar').getByRole('button', { name: 'Actions for Lisbon' }).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Open', 'Holiday settings', 'Archive for me']);
  await page.getByRole('menuitem', { name: 'Holiday settings' }).click();
  await expect(page).toHaveURL(/\/travellers$/);
  await expect(page.getByRole('heading', { name: 'Manage this holiday' })).toBeVisible();
  expect(state.tripActions).toEqual([]);
});
