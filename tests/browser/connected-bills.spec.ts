import { expect, test, type Page } from '@playwright/test';
import { validateLedger, type Ledger, type Trip } from '../../lib/model';

// F-04 / F-05: Gary already shares a holiday with Sam's account.
const holiday: Trip = { id: 'shared-holiday', ownerId: 'gary', name: 'Lisbon', currency: 'GBP',
  members: [{ id: 'h-gary', name: 'Gary', userId: 'gary' }, { id: 'h-sam', name: 'Sam', userId: 'sam' }],
  expenses: [{ id: 'hotel', title: 'Hotel', date: '2026-11-01', time: '12:00', timezone: 'Europe/Lisbon', currency: 'GBP', payer: 'h-sam', tax: 0, tip: 0, discount: 0,
    items: [{ id: 'room', name: 'Room', amount: 10000, members: ['h-gary', 'h-sam'] }] }], payments: [], drafts: [] };

async function fixtures(page: Page) {
  let data: Ledger = { trips: [holiday] }, revision = 1;
  const links: { tripId: string; memberId: string; accountId: string }[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    let json: unknown = { events: [], notifications: [], items: [], invitations: [] };
    if (path === '/api/profile') json = { id: 'gary', displayName: 'Gary', email: 'gary@example.invalid', authMethod: 'password' };
    if (path === '/api/ledger') {
      if (request.method() === 'POST') {
        const next = request.postDataJSON().data as Ledger;
        for (const trip of next.trips) if (!data.trips.some(old => old.id === trip.id)) { trip.ownerId = 'gary'; trip.members[0].userId = 'gary'; }
        data = validateLedger(next); revision++;
      }
      json = { data, revision };
    }
    if (path === '/api/trip' && request.method() === 'GET') json = url.searchParams.get('mode') === 'connections' ? { people: [{ id: 'sam', name: 'Sam' }] } : { trips: [] };
    if (path === '/api/trip' && request.method() === 'POST') {
      const body = request.postDataJSON();
      if (body.action === 'add-connected') {
        links.push({ tripId: body.tripId, memberId: body.memberId, accountId: body.accountId });
        const trip = data.trips.find(value => value.id === body.tripId)!;
        trip.members = trip.members.map(member => member.id === body.memberId ? { ...member, userId: body.accountId } : member);
        revision++; json = { added: true, memberId: body.memberId };
      }
    }
    if (path === '/api/trip-language') json = { accountId: 'gary', tripId: url.searchParams.get('tripId'), revision: 1, preferences: { readingLanguage: 'en', primaryVersion: 'reading', itemVersions: {} } };
    if (path === '/api/receipt/ai-status') json = { configured: false, connected: false, provider: 'api', eligible: false, manageable: false, siwcAvailable: false };
    return route.fulfill({ json, headers: path === '/api/ledger' ? { 'X-TripTab-Account': 'gary' } : {} });
  });
  return { get data() { return data; }, links };
}

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test('F-04: choosing Sam "on TripTab" adds his account to the new bill only; a typed name is never linked', async ({ page }) => {
  const state = await fixtures(page);
  await page.goto('/expenses');
  await page.getByRole('button', { name: 'Open holidays', exact: true }).click();
  await page.getByRole('button', { name: 'Split a bill', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Split a bill', exact: true });
  await sheet.getByRole('button', { name: 'Add Sam (on TripTab)' }).click();
  await sheet.getByRole('textbox', { name: "Who's splitting?" }).fill('Pat');
  await sheet.getByRole('textbox', { name: "Who's splitting?" }).press('Enter');
  await sheet.getByRole('button', { name: 'Enter amount', exact: true }).click();
  await expect(page.locator('.editor')).toBeVisible();
  const bill = state.data.trips.find(trip => trip.kind === 'bill')!;
  const sam = bill.members.find(member => member.name === 'Sam')!, pat = bill.members.find(member => member.name === 'Pat')!;
  expect(state.links).toEqual([{ tripId: bill.id, memberId: sam.id, accountId: 'sam' }]);
  expect(pat.userId).toBeUndefined();
});

test('F-05: Activity lists entries across trips and People keeps bills apart', async ({ page }) => {
  await fixtures(page);
  await page.goto('/expenses');
  await page.getByRole('button', { name: 'Open holidays', exact: true }).click();
  await page.getByRole('button', { name: 'Activity and people', exact: true }).click();
  const view = page.getByRole('dialog', { name: 'Activity and people' });
  await expect(view.locator('.activity-row')).toHaveCount(1);
  await expect(view.locator('.activity-row')).toContainText('Hotel');
  await expect(view.locator('.activity-row')).toContainText('Sam paid');
  await expect(view.locator('.activity-row')).toContainText('Your share £50.00');
  await view.getByRole('combobox', { name: 'Owed or owing' }).selectOption('owed-to-me');
  await expect(view.locator('.activity-row')).toHaveCount(0);
  await view.getByRole('tab', { name: 'People' }).click();
  await expect(view.locator('.people-list')).toContainText('You owe £50.00');
  await expect(view.locator('.people-list')).toContainText('Sam · on TripTab');
  await view.getByRole('button', { name: 'Settle up in Lisbon' }).click();
  await expect(view).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Lisbon' })).toBeVisible();
});
