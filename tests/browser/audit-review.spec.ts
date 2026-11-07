import { expect, test, type Page } from '@playwright/test';
import type { Trip } from '../../lib/model';

// R09: historical audit review links must open archived receipts read-only,
// never silently unarchive, and reveal nothing for deleted, revoked or guessed targets.
const expense = { id: 'dinner', title: 'Harbour dinner', date: '2026-10-01', time: '20:00', timezone: 'Europe/Lisbon', currency: 'GBP' as const, payer: 'g',
  tax: 0, tip: 0, discount: 0, items: [{ id: 'fish', name: 'Grilled fish', amount: 4200, members: ['g', 's'] }],
  receiptScan: { version: 1 as const, printedTotal: 3900, printedCurrency: 'GBP', status: 'needs-review' as const, warnings: [],
    acknowledgement: { fingerprint: `scan-v1:${'a'.repeat(64)}`, reason: 'Service charge removed at the till' } } };
const archived: Trip = { id: 'lisbon', ownerId: 'gary', name: 'Lisbon 2026', currency: 'GBP', members: [{ id: 'g', name: 'Gary', userId: 'gary' }, { id: 's', name: 'Sam' }],
  expenses: [expense], payments: [], drafts: [] };
const open: Trip = { id: 'porto', ownerId: 'gary', name: 'Porto', currency: 'GBP', members: [{ id: 'g', name: 'Gary', userId: 'gary' }], expenses: [], payments: [], drafts: [] };

async function fixtures(page: Page, options: { archive?: Trip[] } = {}) {
  const state = { archive: options.archive ?? [archived], trips: [open], restores: [] as string[] };
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, headers = { 'X-TripTab-Account': 'gary' };
    if (path === '/api/profile') return route.fulfill({ json: { id: 'gary', displayName: 'Gary', email: 'gary@example.invalid', authMethod: 'password' } });
    if (path === '/api/ledger') return route.fulfill({ json: { data: { trips: state.trips }, revision: 1 }, headers });
    if (path === '/api/trip' && request.method() === 'GET') return route.fulfill({ json: { trips: url.searchParams.get('mode') === 'archived-data' ? state.archive : [], people: [], bills: [] }, headers });
    if (path === '/api/trip' && request.method() === 'POST') {
      const body = request.postDataJSON();
      state.restores.push(`${body.action}:${body.tripId}`);
      const restored = state.archive.find(trip => trip.id === body.tripId);
      if (body.action === 'restore' && restored) { state.trips = [...state.trips, restored]; state.archive = state.archive.filter(trip => trip !== restored); }
      return route.fulfill({ json: { archived: false }, headers });
    }
    if (path === '/api/trip-language') return route.fulfill({ json: { accountId: 'gary', tripId: url.searchParams.get('tripId'), revision: 1, preferences: { readingLanguage: 'en', primaryVersion: 'reading', itemVersions: {} } } });
    if (path === '/api/receipt/ai-status') return route.fulfill({ json: { configured: false, connected: false, provider: 'api', eligible: false, manageable: false, siwcAvailable: false } });
    return route.fulfill({ json: { events: [], notifications: [], items: [], invitations: [], nextCursor: null } });
  });
  return state;
}
const link = (tripId: string, expenseId: string) => `/expenses?receiptTrip=${tripId}&receiptExpense=${expenseId}`;

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test('R09: an audit link to an archived receipt opens it read-only and does not unarchive it', async ({ page }) => {
  const state = await fixtures(page);
  await page.goto(link('lisbon', 'dinner'));
  const review = page.getByRole('dialog', { name: 'Harbour dinner' });
  await expect(review).toContainText('Lisbon 2026 is archived, so this receipt is read-only.');
  await expect(review).toContainText('Grilled fish');
  await expect(review).toContainText('Saved total: £42.00');
  await expect(review).toContainText('Printed total: £39.00');
  await expect(review).toContainText('Saved reason: Service charge removed at the till');
  await expect(review.getByRole('textbox')).toHaveCount(0);
  await review.getByRole('button', { name: 'Close', exact: true }).last().click();
  expect(state.restores).toEqual([]);
  await expect(page.locator('.editor')).toHaveCount(0);
});

test('R09: Restore and review is explicit, then opens the receipt for editing', async ({ page }) => {
  const state = await fixtures(page);
  await page.goto(link('lisbon', 'dinner'));
  await page.getByRole('dialog', { name: 'Harbour dinner' }).getByRole('button', { name: 'Restore and review' }).click();
  await expect(page.locator('.editor')).toBeVisible();
  expect(state.restores).toEqual(['restore:lisbon']);
});

for (const [label, target, archive] of [
  ['a revoked or deleted archived holiday', ['lisbon', 'dinner'], []],
  ['a guessed trip ID', ['nope', 'dinner'], undefined],
  ['a guessed receipt ID in an archived holiday', ['lisbon', 'guess'], undefined],
  ['a deleted receipt in an open holiday', ['porto', 'gone'], undefined],
] as const) test(`R09: ${label} says the receipt isn’t available and reveals nothing`, async ({ page }) => {
  const state = await fixtures(page, { archive: archive as Trip[] | undefined });
  await page.goto(link(target[0], target[1]));
  await expect(page.getByRole('alert').filter({ hasText: 'This receipt isn’t available.' })).toBeVisible();
  await expect(page.getByRole('dialog').last()).not.toContainText('Grilled fish');
  await expect(page.getByRole('button', { name: 'Restore and review' })).toHaveCount(0);
  expect(state.restores).toEqual([]);
});
