import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { expenseShares, settlements, validateLedger, type Draft, type Trip } from '../../lib/model';

// Audit fixture R1: two £3.00 Pringles, £1.50 milk, "BOGOF PRINGLES -3.00", total £4.50.
const photo = path.resolve('tests/fixtures/receipts/v1/images/long-receipt.png');
const members = [{ id: 'alice', name: 'Alice', userId: 'owner' }, { id: 'bob', name: 'Bob' }];
const base: Trip = { id: 'r1-trip', ownerId: 'owner', name: 'Groceries', currency: 'GBP', members, expenses: [], drafts: [], payments: [] };
const r1 = (): Draft => ({ id: 'r1-draft', receiptId: 'photo', title: 'Tesco', date: '2026-11-06', time: '12:00', timezone: 'Europe/London',
  currency: 'GBP', payer: 'bob', source: 'ai', status: 'review', tax: 0, tip: 0, discount: 0,
  fieldSources: { title: 'ai', currency: 'ai' },
  items: [{ id: 'p1', name: 'Pringles', amount: 300, members: ['alice'] }, { id: 'p2', name: 'Pringles', amount: 300, members: ['alice'] },
    { id: 'milk', name: 'Milk', amount: 150, members: ['alice', 'bob'] }],
  receiptScan: { version: 1, printedCurrency: 'GBP', printedTotal: 450, status: 'needs-review', warnings: [],
    sourceLines: [{ lineIndex: 3, observedText: 'BOGOF PRINGLES -3.00', amount: -300, kind: 'adjustment', mappedTo: 'unmapped' }] } });

async function fixtures(page: Page, start: Trip = { ...structuredClone(base), drafts: [r1()] }) {
  let current: Trip = start, revision = 1, posts = 0;
  await page.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (pathname === '/api/ledger' && request.method() === 'POST') {
      const body = request.postDataJSON();
      try { current = validateLedger(body.data, { source: 'web', previous: { trips: [current] } }).trips[0]; }
      catch (error) { return route.fulfill({ status: 400, json: { error: String(error) } }); }
      posts++;
      return route.fulfill({ json: { data: { trips: [current] }, revision: ++revision }, headers: { 'X-TripTab-Account': 'owner' } });
    }
    if (pathname === '/api/receipt' && request.method() === 'GET') return route.fulfill({ contentType: 'image/png', path: photo });
    const json = pathname === '/api/ledger' ? { data: { trips: [current] }, revision }
      : pathname === '/api/profile' ? { id: 'owner', displayName: 'Alice', email: 'alice@example.invalid', authMethod: 'password' }
      : pathname === '/api/receipt/ai-status' ? { configured: true, connected: true, provider: 'api', eligible: true, manageable: false, siwcAvailable: false }
      : pathname === '/api/trip-language' ? { accountId: 'owner', tripId: base.id, revision: 1, preferences: { readingLanguage: 'en', primaryVersion: 'reading', itemVersions: {} } }
      : { events: [], notifications: [], items: [] };
    return route.fulfill({ json, headers: pathname === '/api/ledger' ? { 'X-TripTab-Account': 'owner' } : {} });
  });
  return { get trip() { return current; }, get posts() { return posts; } };
}
const save = (page: Page) => page.locator('.editor-footer').getByRole('button', { name: /^(Confirm & save expense|Save expense)$/ });
async function open(page: Page) {
  await page.goto('/expenses?receiptDraft=r1-draft&receiptTrip=r1-trip');
  await expect(page.locator('.editor')).toBeVisible();
}
const discounts = (page: Page) => page.locator('#expense-discounts');

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test('scan R1: the BOGOF line becomes a discount on both Pringles, reconciles, and stores the correct shares', async ({ page }) => {
  const state = await fixtures(page);
  await open(page);
  await expect(page.locator('#expense-receipt-difference')).toContainText('£3.00 difference to explain');
  await page.getByRole('button', { name: 'Apply as discount', exact: true }).click();
  const form = discounts(page).locator('.adjustment-form');
  await expect(form).toBeVisible();
  await expect(form.getByRole('textbox', { name: 'Discount amount' })).toHaveValue('3.00');
  const add = form.getByRole('button', { name: 'Add', exact: true });
  await expect(add).toBeDisabled();
  await expect(form).toContainText('Choose the items it applies to');
  for (const box of await form.locator('.adjustment-items').getByRole('checkbox').all()) {
    if ((await box.locator('xpath=..').textContent())?.includes('Pringles')) await box.check();
  }
  await expect(form).toContainText('Pringles £1.50, Pringles £1.50');
  await expect(form.locator('.adjustment-preview')).toContainText('New total £4.50');
  await expect(form.locator('.adjustment-preview')).toContainText('Alice −£3.00');
  await add.click();
  await expect(discounts(page).locator('.adjustment-row')).toContainText('−£3.00');
  await expect(discounts(page)).toContainText('Pringles £3.00 → £1.50');
  await expect(page.locator('#expense-receipt-difference')).toHaveCount(0);
  await expect(page.locator('.receipt-scan-totals')).toContainText('£4.50');
  await save(page).click();
  await expect(page.locator('.editor')).toHaveCount(0);
  const expense = state.trip.expenses[0];
  expect(expense.items.map(item => item.amount)).toEqual([300, 300, 150]);
  expect(expense.adjustments).toEqual([expect.objectContaining({ kind: 'discount', amount: 300, sourceLineIndex: 3, source: 'receipt',
    scope: { type: 'items', itemIds: ['p1', 'p2'] } })]);
  expect(expense.adjustmentAllocation).toBe('scoped-adjustments');
  expect(expense.receiptScan?.status).toBe('matched');
  expect(expense.receiptScan?.acknowledgement).toBeUndefined();
  expect(expenseShares(expense, members, 'GBP')).toEqual([375, 75]);
  expect(settlements(state.trip)).toEqual([{ from: 'alice', to: 'bob', amount: 375 }]);
});

test('a missed discount added by hand as 50% of the Pringles, then removed, blocks Save again', async ({ page }) => {
  const state = await fixtures(page);
  await open(page);
  await page.locator('#expense-receipt-difference').getByRole('button', { name: 'Add or correct a discount', exact: true }).click();
  const form = discounts(page).locator('.adjustment-form');
  await form.getByRole('radio', { name: 'Percent' }).check();
  await form.getByRole('textbox', { name: 'Discount percent' }).fill('50');
  for (const box of await form.locator('.adjustment-items').getByRole('checkbox').all()) {
    if ((await box.locator('xpath=..').textContent())?.includes('Pringles')) await box.check();
  }
  await form.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('#expense-receipt-difference')).toHaveCount(0);
  await discounts(page).getByRole('button', { name: /^Remove / }).click();
  await expect(page.locator('#expense-receipt-difference')).toContainText('£3.00 difference to explain');
  await save(page).click();
  expect(state.posts).toBe(0);
  // Add it again with a manual split giving the whole saving to the second bag.
  await page.locator('#expense-receipt-difference').getByRole('button', { name: 'Add or correct a discount', exact: true }).click();
  for (const box of await form.locator('.adjustment-items').getByRole('checkbox').all()) {
    if ((await box.locator('xpath=..').textContent())?.includes('Pringles')) await box.check();
  }
  await form.getByRole('checkbox', { name: 'Split between items manually' }).check();
  const parts = form.locator('.adjustment-split input[inputmode=decimal]');
  await parts.nth(0).fill('0.00'); await parts.nth(1).fill('3.00');
  await form.getByRole('button', { name: 'Add', exact: true }).click();
  await save(page).click();
  await expect(page.locator('.editor')).toHaveCount(0);
  expect(state.trip.expenses[0].adjustments?.[0].allocation).toEqual({ p1: 0, p2: 300 });
  expect(expenseShares(state.trip.expenses[0], members, 'GBP')).toEqual([375, 75]);
});

test('R03: editing the first of two discounts previews, saves and stores the same total', async ({ page }) => {
  // Two £5 lines; a £1 coupon then 50% off. Editing the coupon to £2 keeps it
  // first: £10 − £2 = £8, then 50% → £4.00. Appending it would show £3.00.
  const coupon = { id: 'coupon', kind: 'discount' as const, label: 'Coupon', amount: 100, scope: { type: 'receipt' as const }, source: 'user' as const };
  const half = { id: 'half', kind: 'discount' as const, label: 'Half price', percent: 50, scope: { type: 'receipt' as const }, source: 'user' as const };
  const draft: Draft = { id: 'r3-draft', title: 'Lunch', date: '2026-11-06', time: '12:00', timezone: 'Europe/London', currency: 'GBP', payer: 'bob',
    status: 'review', tax: 0, tip: 0, discount: 0, adjustments: [coupon, half],
    items: [{ id: 'a', name: 'Soup', amount: 500, members: ['alice'] }, { id: 'b', name: 'Salad', amount: 500, members: ['bob'] }] };
  const state = await fixtures(page, { ...structuredClone(base), drafts: [draft] });
  await page.goto('/expenses?receiptDraft=r3-draft&receiptTrip=r1-trip');
  await expect(page.locator('.editor')).toBeVisible();
  await discounts(page).getByRole('button', { name: 'Edit Coupon' }).click();
  const form = discounts(page).locator('.adjustment-form');
  await form.getByRole('textbox', { name: 'Discount amount' }).fill('2.00');
  await expect(form.locator('.adjustment-preview')).toContainText('New total £4.00');
  await form.getByRole('button', { name: 'Save changes' }).click();
  await expect(discounts(page).locator('.adjustment-row').first()).toContainText('Coupon');
  await save(page).click();
  await expect(page.locator('.editor')).toHaveCount(0);
  const expense = state.trip.expenses[0];
  expect(expense.adjustments?.map(value => [value.id, value.amount ?? value.percent])).toEqual([['coupon', 200], ['half', 50]]);
  expect(expense.adjustmentAllocation).toBe('scoped-adjustments');
  expect(expenseShares(expense, members, 'GBP').reduce((sum, share) => sum + share, 0)).toBe(400);
});

test('R04: a change to discounts alone is unsaved work on Close, Escape and unload', async ({ page }) => {
  const coupon = { id: 'coupon', kind: 'discount' as const, label: 'Coupon', amount: 100, scope: { type: 'receipt' as const }, source: 'user' as const };
  const draft: Draft = { id: 'r4-draft', title: 'Lunch', date: '2026-11-06', time: '12:00', timezone: 'Europe/London', currency: 'GBP', payer: 'bob',
    status: 'review', tax: 0, tip: 0, discount: 0, adjustments: [coupon],
    items: [{ id: 'a', name: 'Soup', amount: 500, members: ['alice'] }, { id: 'b', name: 'Salad', amount: 500, members: ['bob'] }] };
  const state = await fixtures(page, { ...structuredClone(base), drafts: [draft] });
  await page.goto('/expenses?receiptDraft=r4-draft&receiptTrip=r1-trip');
  await expect(page.locator('.editor')).toBeVisible();
  const discard = page.getByRole('dialog').filter({ hasText: 'Discard unsaved changes?' });
  // Opening alone is not a change.
  await page.getByRole('button', { name: 'Close editor' }).click();
  await expect(page.locator('.editor')).toHaveCount(0);
  await page.goto('/expenses?receiptDraft=r4-draft&receiptTrip=r1-trip');
  for (const change of ['edit', 'remove', 'add'] as const) {
    if (change === 'edit') {
      await discounts(page).getByRole('button', { name: 'Edit Coupon' }).click();
      await discounts(page).locator('.adjustment-form').getByRole('textbox', { name: 'Discount amount' }).fill('2.00');
      await discounts(page).locator('.adjustment-form').getByRole('button', { name: 'Save changes' }).click();
    } else if (change === 'remove') {
      await discounts(page).getByRole('button', { name: 'Remove Coupon' }).click();
    } else {
      await discounts(page).getByRole('button', { name: 'Add discount' }).click();
      const form = discounts(page).locator('.adjustment-form');
      await form.getByRole('radio', { name: 'Whole receipt' }).check();
      await form.getByRole('textbox', { name: 'Discount amount' }).fill('1.00');
      await form.getByRole('button', { name: 'Add', exact: true }).click();
    }
    await page.getByRole('button', { name: 'Close editor' }).click();
    await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: 'Keep editing' }).click();
    await page.keyboard.press('Escape');
    await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: 'Keep editing' }).click();
    await expect(page.locator('.editor')).toBeVisible();
  }
  // Leaving the page asks first, and nothing was saved behind the person's back.
  let unloadPrompt = '';
  page.on('dialog', dialog => { unloadPrompt = dialog.type(); void dialog.dismiss(); });
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => unloadPrompt).toBe('beforeunload');
  expect(state.posts).toBe(0);
});
