import { expect, test, type Page } from '@playwright/test';
import type { Trip } from '../../lib/model';

// R08: People must not say "Nobody owes you" or present a partial total as
// complete while an included holiday or bill cannot be calculated.

const spend = (id: string, payer: string, amount: number, members: string[], currency: 'GBP' | 'EUR' = 'GBP') => ({ id, title: id, date: '2026-11-06', time: '12:00',
  timezone: 'Europe/London', currency, payer, tax: 0, tip: 0, discount: 0, items: [{ id: `${id}-i`, name: id, amount, members }] });
// Stored before a conversion was required: a EUR museum ticket on a GBP bill.
const paris = { id: 'paris', ownerId: 'gary', kind: 'bill', name: 'Paris', currency: 'GBP', members: [{ id: 'xg', name: 'Gary', userId: 'gary' }, { id: 'xs', name: 'Sam', userId: 'sam' }],
  expenses: [spend('Museum', 'xs', 4000, ['xg', 'xs'], 'EUR')], payments: [], drafts: [] } as Trip;
const taxi = { id: 'taxi', ownerId: 'gary', kind: 'bill', name: 'Taxi', currency: 'GBP', members: [{ id: 'tg', name: 'Gary', userId: 'gary' }, { id: 'ts', name: 'Sam', userId: 'sam' }],
  expenses: [spend('Cab', 'tg', 3000, ['tg', 'ts'])], payments: [], drafts: [] } as Trip;

async function fixtures(page: Page, trips: Trip[], archived: Trip[] = []) {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname, headers = { 'X-TripTab-Account': 'gary' };
    if (path === '/api/profile') return route.fulfill({ json: { id: 'gary', displayName: 'Gary', email: 'gary@example.invalid', authMethod: 'password' } });
    if (path === '/api/ledger') return route.fulfill({ json: { data: { trips }, revision: 1 }, headers });
    if (path === '/api/trip') return route.fulfill({ json: { trips: url.searchParams.get('mode') === 'archived-data' ? archived : [], people: [], bills: [] }, headers });
    if (path === '/api/trip-language') return route.fulfill({ json: { accountId: 'gary', tripId: url.searchParams.get('tripId'), revision: 1, preferences: { readingLanguage: 'en', primaryVersion: 'reading', itemVersions: {} } } });
    return route.fulfill({ json: { events: [], notifications: [], items: [], invitations: [], nextCursor: null, configured: false } });
  });
}
async function people(page: Page) {
  await page.goto('/expenses');
  await page.getByRole('button', { name: 'Open holidays', exact: true }).click();
  await page.getByRole('button', { name: 'Activity and people', exact: true }).click();
  const view = page.getByRole('dialog', { name: 'Activity and people' });
  await view.getByRole('tab', { name: 'People' }).click();
  return view;
}

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test('R08: an invalid-only ledger names the bill and draws no debt-free conclusion', async ({ page }) => {
  await fixtures(page, [paris]);
  const view = await people(page);
  await expect(view.getByRole('alert')).toContainText('Paris');
  await expect(view.getByRole('alert')).toContainText('No balance can be shown until they are fixed.');
  await expect(view).not.toContainText('Nobody owes you');
});

test('R08: a mixed open and archived ledger keeps valid totals but labels them incomplete', async ({ page }) => {
  await fixtures(page, [taxi], [paris]);
  const view = await people(page);
  await expect(view).toContainText('Owes you £15.00');
  await expect(view.getByRole('alert')).toContainText('Paris (archived)');
  await expect(view.getByRole('alert')).toContainText('The amounts below are incomplete.');
  await expect(view).not.toContainText('Nobody owes you');
});
