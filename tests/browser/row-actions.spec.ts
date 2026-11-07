import { expect, test, type Page, type Locator } from '@playwright/test';
import { balances, validateLedger, type Expense, type Trip } from '../../lib/model';

// F-06 / F-13 / F-14 / F-15 on a two-person bill. Gary is the signed-in account.
const members = [{ id: 'gary', name: 'Gary', userId: 'owner' }, { id: 'sam', name: 'Sam' }];
const expense = (id: string, title: string, amount: number, payer: string): Expense => ({ id, title, date: '2026-11-06', time: '12:00', timezone: 'Europe/London',
  currency: 'GBP', payer, tax: 0, tip: 0, discount: 0, items: [{ id: `${id}-item`, name: title, amount, members: ['gary', 'sam'] }] });
function bill(options: { settled?: boolean } = {}): Trip {
  return { id: 'rows-bill', ownerId: 'owner', kind: 'bill', name: 'Coffee', currency: 'GBP', members,
    expenses: [expense('coffee', 'Coffee', 1240, 'gary'), expense('dinner', 'Dinner', 2000, 'sam')], drafts: [],
    // Settled: Gary owes Sam £3.80 net; he paid it.
    payments: options.settled ? [{ id: 'paid', from: 'gary', to: 'sam', amount: 380, date: '2026-11-06' }] : [] };
}
async function fixtures(page: Page, initial: Trip) {
  let current = validateLedger({ trips: [initial] }).trips[0], revision = 1;
  const posts: Trip[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (pathname === '/api/ledger' && request.method() === 'POST') {
      try { current = validateLedger(request.postDataJSON().data, { source: 'web', previous: { trips: [current] } }).trips[0]; }
      catch (error) { return route.fulfill({ status: 400, json: { error: String(error) } }); }
      posts.push(structuredClone(current));
      return route.fulfill({ json: { data: { trips: [current] }, revision: ++revision }, headers: { 'X-TripTab-Account': 'owner' } });
    }
    const json = pathname === '/api/ledger' ? { data: { trips: [current] }, revision }
      : pathname === '/api/profile' ? { id: 'owner', displayName: 'Gary', email: 'gary@example.invalid', authMethod: 'password' }
      : pathname === '/api/receipt/ai-status' ? { configured: false, connected: false, provider: 'api', eligible: false, manageable: false, siwcAvailable: false }
      : pathname === '/api/trip-language' ? { accountId: 'owner', tripId: initial.id, revision: 1, preferences: { readingLanguage: 'en', primaryVersion: 'reading', itemVersions: {} } }
      : { events: [], notifications: [], items: [], invitations: [] };
    return route.fulfill({ json, headers: pathname === '/api/ledger' ? { 'X-TripTab-Account': 'owner' } : {} });
  });
  return { get trip() { return current; }, posts };
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

test('keyboard: ⋯ → Delete removes my own unsettled expense at once, and Undo restores it exactly', async ({ page }) => {
  const state = await fixtures(page, bill());
  await page.goto('/expenses');
  const menu = row(page, 'coffee').getByRole('button', { name: 'Actions for Coffee' });
  await menu.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Edit' })).toBeFocused();
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(row(page, 'coffee')).toHaveCount(0);
  const banner = page.locator('.saved-banner');
  await expect(banner).toContainText('Deleted “Coffee” (£12.40).');
  await expect(banner).toContainText('Your balance changes by −£6.20.');
  expect(state.trip.expenses.map(value => value.id)).toEqual(['dinner']);
  await banner.getByRole('button', { name: /Undo/ }).click();
  await expect(row(page, 'coffee')).toHaveCount(1);
  const restored = state.trip.expenses.find(value => value.id === 'coffee')!;
  expect(restored.items[0].amount).toBe(1240);
});

test('swipe left reveals Delete; the gesture alone deletes nothing', async ({ page }) => {
  const state = await fixtures(page, bill());
  await page.goto('/expenses');
  const target = row(page, 'coffee');
  await swipeLeft(target);
  const reveal = page.locator('.swipe-row--revealed .swipe-row-delete');
  await expect(reveal).toBeVisible();
  expect(state.posts).toHaveLength(0);
  await reveal.click();
  await expect(row(page, 'coffee')).toHaveCount(0);
  expect(state.trip.expenses.map(value => value.id)).toEqual(['dinner']);
});

test('a fast swipe completed within one frame uses its final position without deleting anything', async ({ page }) => {
  const state = await fixtures(page, bill());
  await page.goto('/expenses');
  const target = row(page, 'coffee');
  await expect(target).toBeVisible();
  await target.evaluate(element => {
    const box = element.getBoundingClientRect();
    const x = box.right - 30, y = box.top + box.height / 2;
    // Continuous React updates may not paint before the discrete release.
    // Gesture recognition must not depend on an intervening render.
    for (const [type, clientX] of [['pointerdown', x], ['pointermove', x - 120], ['pointerup', x - 120]] as const) {
      element.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', pointerId: 7, clientX, clientY: y, bubbles: true }));
    }
  });
  await expect(page.locator('.swipe-row--revealed .swipe-row-delete')).toBeVisible();
  expect(state.posts).toHaveLength(0);
  expect(state.trip.expenses.map(value => value.id)).toEqual(['coffee', 'dinner']);
});

test('short, vertical and unrelated-pointer gestures do not reveal or delete an expense', async ({ page }) => {
  const state = await fixtures(page, bill());
  await page.goto('/expenses');
  const target = row(page, 'coffee');
  for (const gesture of ['short', 'vertical', 'other-pointer'] as const) {
    await target.evaluate((element, gesture) => {
      const box = element.getBoundingClientRect(), x = box.right - 30, y = box.top + box.height / 2;
      const send = (type: string, clientX: number, clientY: number, pointerId = 7) => element.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', pointerId, clientX, clientY, bubbles: true }));
      send('pointerdown', x, y);
      send('pointermove', x - (gesture === 'short' ? 20 : 120), y + (gesture === 'vertical' ? 200 : 0), gesture === 'other-pointer' ? 8 : 7);
      send('pointerup', x - 120, y);
    }, gesture);
    await expect(page.locator('.swipe-row--revealed')).toHaveCount(0);
    expect(state.posts).toHaveLength(0);
    expect(state.trip.expenses.map(value => value.id)).toEqual(['coffee', 'dinner']);
  }
});

test('F-13: deleting from a settled bill or someone else\'s expense asks first and states the result', async ({ page }) => {
  const state = await fixtures(page, bill({ settled: true }));
  expect(balances(state.trip)).toEqual([0, 0]);
  await page.goto('/expenses');
  await row(page, 'dinner').getByRole('button', { name: 'Actions for Dinner' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete expense?' });
  await expect(dialog).toContainText('This bill was settled. After this deletion, Sam pays Gary £10.00.');
  await expect(dialog).toContainText('Sam paid for it and will be notified.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(state.posts).toHaveLength(0);
});

test('F-13: changing a settled expense explains the new transfer before saving; payments stay as recorded', async ({ page }) => {
  const state = await fixtures(page, bill({ settled: true }));
  await page.goto('/expenses');
  await row(page, 'coffee').locator('.expense-open').click();
  await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('22.40');
  await page.getByRole('button', { name: 'Save expense', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Change a settled expense?' });
  await expect(dialog).toContainText('After this change, Sam pays Gary £5.00. Recorded payments are not changed.');
  await dialog.getByRole('button', { name: 'Save change' }).click();
  await expect(page.locator('.editor')).toHaveCount(0);
  expect(state.trip.payments).toEqual([{ id: 'paid', from: 'gary', to: 'sam', amount: 380, date: '2026-11-06' }]);
  expect(balances(state.trip)).toEqual([500, -500]);
});

test('F-14/F-15: Undo stays visible over an open form; payments are labelled Delete payment', async ({ page }) => {
  await fixtures(page, bill({ settled: true }));
  await page.goto('/expenses');
  await row(page, 'coffee').getByRole('button', { name: 'Actions for Coffee' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('dialog', { name: 'Delete expense?' }).getByRole('button', { name: 'Delete expense' }).click();
  await page.getByRole('button', { name: 'Add receipt', exact: true }).click();
  await expect(page.locator('.editor')).toBeVisible();
  await expect(page.locator('.saved-banner.undo-over-editor')).toBeVisible();
  await page.getByRole('button', { name: 'Close editor', exact: true }).click();
  await page.goto('/balances');
  await page.getByRole('button', { name: 'Actions for Gary → Sam' }).click();
  await expect(page.getByRole('menuitem', { name: 'Delete payment' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Undo recorded payment' })).toHaveCount(0);
});

test('F-06: Delete bill after the plain confirmation sends the name the server still requires', async ({ page }) => {
  await fixtures(page, bill());
  const actions: Record<string, string>[] = [];
  await page.route('**/api/trip', route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON() as Record<string, string>;
    actions.push(body);
    // As lib/trip-lifecycle deleteTrip: a bill with entries needs its exact name.
    return body.action === 'delete' && body.confirmName !== 'Coffee'
      ? route.fulfill({ status: 400, json: { error: 'Type the bill name exactly to confirm deleting it.' } })
      : route.fulfill({ json: { deleted: true } });
  });
  await page.goto('/expenses');
  await page.getByRole('button', { name: 'Bill options', exact: true }).click();
  await page.getByText('Delete bill', { exact: true }).first().click();
  await page.locator('.trip-controls').getByRole('button', { name: 'Delete bill' }).click();
  await page.getByRole('dialog', { name: 'Delete this bill?' }).getByRole('button', { name: 'Delete bill' }).click();
  await expect.poll(() => actions).toEqual([{ action: 'delete', tripId: 'rows-bill', memberId: '', confirmName: 'Coffee' }]);
  // Accepted: Bill options closes instead of showing the server's refusal.
  await expect(page.getByRole('dialog', { name: 'Bill options' })).toHaveCount(0);
});

test('a row menu near the bottom of a phone screen opens clear of the fixed section tabs', async ({ page }) => {
  await fixtures(page, bill({ settled: true }));
  await page.goto('/expenses');
  await row(page, 'dinner').getByRole('button', { name: 'Actions for Dinner' }).click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const [menuBox, tabsBox] = await Promise.all([menu.boundingBox(), page.locator('nav.tabs').boundingBox()]);
  const tabsFixed = await page.locator('nav.tabs').evaluate(element => getComputedStyle(element).position === 'fixed');
  if (tabsFixed) expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(tabsBox!.y);
  // Every item is reachable by pointer, not only by keyboard.
  await page.getByRole('menuitem', { name: 'Delete' }).click({ trial: true });
});
