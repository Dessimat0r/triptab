import { expect, test, type Page } from '@playwright/test';

// F-08: two people edit the same £20 dinner. The server's ledger is the
// fixture; the first save from the stale editor gets a revision conflict.
const dinner = {
  id: 'merge-dinner', title: 'Dinner', date: '2026-11-06', time: '20:00', timezone: 'Europe/London',
  currency: 'GBP', payer: 'merge-gary', tax: 0, tip: 0, discount: 0,
  items: [{ id: 'merge-meal', name: 'Dinner', amount: 2000, members: ['merge-gary', 'merge-sam'] }],
};
const trip = {
  id: 'merge-trip', ownerId: 'merge-owner', name: 'London', currency: 'GBP',
  members: [{ id: 'merge-gary', name: 'Gary' }, { id: 'merge-sam', name: 'Sam', userId: 'merge-owner' }],
  expenses: [dinner], payments: [], drafts: [],
};
type Ledger = { trips: typeof trip[] };

async function fixtures(page: Page) {
  const state = { posts: [] as Ledger[], current: structuredClone(trip), revision: 1, otherSaveAmount: 3000, otherSaved: false };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/ledger' && route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { data: Ledger; revision: number };
      if (!state.otherSaved) {
        // Gary saved a new amount just before Sam's save arrives.
        state.otherSaved = true;
        state.current.expenses[0].items[0].amount = state.otherSaveAmount; state.revision++;
        return route.fulfill({ status: 409, json: { error: 'CONFLICT' } });
      }
      if (body.revision !== state.revision) return route.fulfill({ status: 409, json: { error: 'CONFLICT' } });
      state.posts.push(body.data); state.current = body.data.trips[0]; state.revision++;
      return route.fulfill({ json: { data: body.data, revision: state.revision }, headers: { 'X-TripTab-Account': 'merge-owner' } });
    }
    const json = path === '/api/ledger' ? { data: { trips: [state.current] }, revision: state.revision }
      : path === '/api/profile' ? { id: 'merge-owner', displayName: 'Sam', email: 'sam@example.invalid', authMethod: 'password' }
      : path === '/api/trip-language' ? { accountId: 'merge-owner', tripId: trip.id, revision: 1, preferences: { readingLanguage: 'en', primaryVersion: 'reading', itemVersions: {} } }
      : path === '/api/receipt/ai-status' ? { configured: false, connected: false, provider: 'api', eligible: false, manageable: false, siwcAvailable: false }
      : { events: [], notifications: [], items: [] };
    return route.fulfill({ json, headers: path === '/api/ledger' ? { 'X-TripTab-Account': 'merge-owner' } : {} });
  });
  return state;
}
const save = (page: Page) => page.getByRole('button', { name: 'Save expense', exact: true });
async function openDinner(page: Page) {
  await page.goto('/expenses', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-entry-id="merge-dinner"] .expense-open').click();
  await expect(page.locator('.editor')).toBeVisible();
}

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test('a name edit made on an old copy keeps the other person\'s new amount', async ({ page }) => {
  const state = await fixtures(page);
  await openDinner(page);
  await page.getByRole('textbox', { name: 'Expense name', exact: true }).fill("Dinner at Rosa's");
  await save(page).click();
  expect(state.posts).toHaveLength(0);
  await expect(page.locator('.merge-notice')).toContainText('Price and sharing of Dinner');
  await expect(page.getByRole('textbox', { name: 'Expense name', exact: true })).toHaveValue("Dinner at Rosa's");
  await expect(page.getByRole('textbox', { name: 'Amount', exact: true })).toHaveValue('30.00');
  await expect(page.locator('.conflict-review')).toHaveCount(0);
  await save(page).click();
  await expect(page.locator('.editor')).toHaveCount(0);
  expect(state.posts).toHaveLength(1);
  const saved = state.posts[0].trips[0].expenses[0];
  expect(saved.title).toBe("Dinner at Rosa's");
  expect(saved.items[0].amount).toBe(3000);
});

test('when both change the amount, a keyboard user must choose before merging', async ({ page }) => {
  const state = await fixtures(page);
  await openDinner(page);
  await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('25');
  await save(page).click();
  const review = page.locator('.conflict-review');
  await expect(review).toBeVisible();
  const merge = review.getByRole('button', { name: 'Merge my changes', exact: true });
  await expect(merge).toBeDisabled();
  const group = review.getByRole('radiogroup', { name: 'Price and sharing of Dinner' });
  await expect(group).toContainText('£30.00'); await expect(group).toContainText('£25.00');
  await save(page).click(); expect(state.posts).toHaveLength(0);
  await group.getByRole('radio').first().focus();
  await page.keyboard.press('Space');
  await expect(merge).toBeEnabled();
  await merge.click();
  await expect(review).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Amount', exact: true })).toHaveValue('25.00');
  await save(page).click();
  await expect(page.locator('.editor')).toHaveCount(0);
  expect(state.posts[0].trips[0].expenses[0].items[0].amount).toBe(2500);
});
