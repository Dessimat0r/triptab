import { expect, test, type Page } from '@playwright/test';
import { validateLedger, type Expense, type Trip } from '../../lib/model';

const members = [{ id: 'gary', name: 'Gary', userId: 'owner' }, { id: 'sam', name: 'Sam' }];
const pizza: Expense = { id: 'pizza', title: 'Pizza Express', date: '2026-11-06', time: '19:00', timezone: 'Europe/London', currency: 'GBP', payer: 'sam',
  tax: 0, tip: 0, discount: 0, items: [{ id: 'pizza-item', name: 'Pizza Express', amount: 4520, members: ['gary', 'sam'] }] };
const base: Trip = { id: 'res-trip', ownerId: 'owner', name: 'London', currency: 'GBP', members, expenses: [pizza], drafts: [], payments: [] };

async function fixtures(page: Page, trip: Trip = base, options: { raw?: boolean } = {}) {
  let current = options.raw ? structuredClone(trip) : validateLedger({ trips: [trip] }).trips[0], revision = 1, posts = 0;
  await page.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (pathname === '/api/ledger' && request.method() === 'POST') {
      try { current = validateLedger(request.postDataJSON().data, { source: 'web', previous: { trips: [current] } }).trips[0]; }
      catch (error) { return route.fulfill({ status: 400, json: { error: String(error) } }); }
      posts++;
      return route.fulfill({ json: { data: { trips: [current] }, revision: ++revision }, headers: { 'X-TripTab-Account': 'owner' } });
    }
    const json = pathname === '/api/ledger' ? { data: { trips: [current] }, revision }
      : pathname === '/api/profile' ? { id: 'owner', displayName: 'Gary', email: 'gary@example.invalid', authMethod: 'password' }
      : pathname === '/api/receipt/ai-status' ? { configured: false, connected: false, provider: 'api', eligible: false, manageable: false, siwcAvailable: false }
      : pathname === '/api/trip-language' ? { accountId: 'owner', tripId: trip.id, revision: 1, preferences: { readingLanguage: 'en', primaryVersion: 'reading', itemVersions: {} } }
      : { events: [], notifications: [], items: [] };
    return route.fulfill({ json, headers: pathname === '/api/ledger' ? { 'X-TripTab-Account': 'owner' } : {} });
  });
  return { get trip() { return current; }, get posts() { return posts; } };
}
async function enter(page: Page, name: string, amount: string) {
  await page.getByRole('button', { name: 'Add expense', exact: true }).click();
  await page.getByRole('textbox', { name: 'Expense name', exact: true }).fill(name);
  await page.getByRole('textbox', { name: 'Amount', exact: true }).fill(amount);
}

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test('F-09: entering the same restaurant bill again warns; Open existing saves nothing, Save anyway saves', async ({ page }) => {
  const state = await fixtures(page);
  await page.goto('/expenses');
  await enter(page, 'Pizza Express', '45.20');
  await page.getByRole('button', { name: 'Save expense', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Possible duplicate' });
  await expect(dialog).toContainText('“Pizza Express” for £45.20');
  await expect(dialog).toContainText('paid by Sam');
  await dialog.getByRole('button', { name: 'Open existing' }).click();
  expect(state.posts).toBe(0);
  await expect(page.getByRole('textbox', { name: 'Expense name', exact: true })).toHaveValue('Pizza Express');
  await page.getByRole('button', { name: 'Close editor', exact: true }).click();
  await enter(page, 'Pizza Express', '45.20');
  await page.getByRole('button', { name: 'Save expense', exact: true }).click();
  await page.getByRole('dialog', { name: 'Possible duplicate' }).getByRole('button', { name: 'Save anyway' }).click();
  await expect(page.locator('.editor')).toHaveCount(0);
  expect(state.trip.expenses).toHaveLength(2);
});

test('F-18: an unsaved expense survives a reload and can be resumed once', async ({ page }) => {
  const state = await fixtures(page);
  await page.goto('/expenses');
  await enter(page, 'Late taxi', '18.00');
  await page.waitForTimeout(600);
  await page.reload();
  const banner = page.locator('.unsaved-entry');
  await expect(banner).toContainText('Unsaved expense “Late taxi”');
  await banner.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByRole('textbox', { name: 'Expense name', exact: true })).toHaveValue('Late taxi');
  await expect(page.getByRole('textbox', { name: 'Amount', exact: true })).toHaveValue('18.00');
  await page.getByRole('button', { name: 'Save expense', exact: true }).click();
  await expect(page.locator('.editor')).toHaveCount(0);
  expect(state.trip.expenses.map(value => value.title)).toContain('Late taxi');
  await page.reload();
  await expect(page.locator('.unsaved-entry')).toHaveCount(0);
});

test('F-20: one invalid legacy expense is named with an Open button; settlement suggestions stay hidden', async ({ page }) => {
  const broken = { ...pizza, id: 'old', title: 'Old euro receipt', currency: 'EUR' as const, items: [{ ...pizza.items[0], id: 'old-item' }] };
  await fixtures(page, { ...base, expenses: [pizza, broken] }, { raw: true });
  await page.goto('/expenses');
  const alert = page.locator('.calculation-health');
  await expect(alert).toContainText('One expense can’t be calculated');
  await expect(alert).toContainText('Old euro receipt');
  await expect(alert).toContainText('Total of the other expenses: £45.20 (incomplete)');
  await alert.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('textbox', { name: 'Expense name', exact: true })).toHaveValue('Old euro receipt');
});
