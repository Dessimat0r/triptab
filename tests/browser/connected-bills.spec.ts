import { expect, test, type Page } from '@playwright/test';
import { validateLedger, type Ledger, type Trip } from '../../lib/model';

// F-04 / F-05: Gary already shares a holiday with Sam's account.
const holiday: Trip = { id: 'shared-holiday', ownerId: 'gary', name: 'Lisbon', currency: 'GBP',
  members: [{ id: 'h-gary', name: 'Gary', userId: 'gary' }, { id: 'h-sam', name: 'Sam', userId: 'sam' }],
  expenses: [{ id: 'hotel', title: 'Hotel', date: '2026-11-01', time: '12:00', timezone: 'Europe/Lisbon', currency: 'GBP', payer: 'h-sam', tax: 0, tip: 0, discount: 0,
    items: [{ id: 'room', name: 'Room', amount: 10000, members: ['h-gary', 'h-sam'] }] }], payments: [], drafts: [] };

async function fixtures(page: Page, options: { trips?: Trip[]; archived?: Trip[] } = {}) {
  let data: Ledger = { trips: options.trips ?? [holiday] }, revision = 1;
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
    if (path === '/api/trip' && request.method() === 'GET') json = url.searchParams.get('mode') === 'connections' ? { people: [{ id: 'sam', name: 'Sam' }] }
      : url.searchParams.get('mode') === 'archived-data' ? { trips: options.archived ?? [] } : { trips: [] };
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

// A bill that already exists: Gary and Pat, plus an unlinked "Sam" in the second case.
const dinner = (members: Trip['members']): Trip => ({ id: 'dinner', kind: 'bill', ownerId: 'gary', name: 'Dinner', currency: 'GBP', members,
  expenses: [], payments: [], drafts: [] });
async function openPeople(page: Page) {
  await page.goto('/expenses');
  await page.getByRole('button', { name: 'Open holidays', exact: true }).click();
  await page.getByRole('button', { name: /^Dinner/ }).click();
  await page.getByRole('button', { name: 'Bill options', exact: true }).click();
  await page.getByRole('button', { name: 'People', exact: true }).click();
  return page.getByRole('dialog', { name: 'People', exact: true });
}

test('F-04: Sam can be added from People after the bill was created; only his account is linked', async ({ page }) => {
  const state = await fixtures(page, { trips: [holiday, dinner([{ id: 'd-gary', name: 'Gary', userId: 'gary' }, { id: 'd-pat', name: 'Pat' }])] });
  const sheet = await openPeople(page);
  await sheet.getByRole('button', { name: 'Add Sam (on TripTab)' }).click();
  await expect(sheet.getByText('Sam was added and can now see this bill.')).toHaveAttribute('role', 'status');
  const bill = state.data.trips.find(trip => trip.id === 'dinner')!;
  const sam = bill.members.find(member => member.name === 'Sam')!;
  expect(state.links).toEqual([{ tripId: 'dinner', memberId: sam.id, accountId: 'sam' }]);
  expect(bill.members.find(member => member.name === 'Pat')!.userId).toBeUndefined();
  // Once linked, Sam is no longer offered.
  await expect(sheet.getByRole('button', { name: 'Add Sam (on TripTab)' })).toHaveCount(0);
});

test('F-04: a person already named Sam is linked only after saying it is the same person', async ({ page }) => {
  const state = await fixtures(page, { trips: [holiday, dinner([{ id: 'd-gary', name: 'Gary', userId: 'gary' }, { id: 'd-sam', name: 'Sam' }])] });
  const sheet = await openPeople(page);
  await sheet.getByRole('button', { name: 'Add Sam (on TripTab)' }).click();
  const ask = page.getByRole('dialog', { name: 'Is Sam the same person?' });
  await ask.getByRole('button', { name: 'Cancel' }).click();
  expect(state.links).toEqual([]);
  expect(state.data.trips.find(trip => trip.id === 'dinner')!.members).toHaveLength(2);
  await sheet.getByRole('button', { name: 'Add Sam (on TripTab)' }).click();
  await page.getByRole('dialog', { name: 'Is Sam the same person?' }).getByRole('button', { name: 'Link Sam' }).click();
  await expect.poll(() => state.links).toEqual([{ tripId: 'dinner', memberId: 'd-sam', accountId: 'sam' }]);
  expect(state.data.trips.find(trip => trip.id === 'dinner')!.members).toHaveLength(2);
});

test('F-05: Activity and People include archived trips, read-only, and can leave them out', async ({ page }) => {
  const porto: Trip = { id: 'porto', ownerId: 'gary', name: 'Porto', currency: 'EUR',
    members: [{ id: 'o-gary', name: 'Gary', userId: 'gary' }, { id: 'o-sam', name: 'Sam', userId: 'sam' }], payments: [], drafts: [],
    expenses: [{ id: 'wine', title: 'Wine tasting', date: '2026-06-01', time: '18:00', timezone: 'Europe/Lisbon', currency: 'EUR', payer: 'o-gary', tax: 0, tip: 0, discount: 0,
      items: [{ id: 'glass', name: 'Tasting', amount: 4000, members: ['o-gary', 'o-sam'] }] }] };
  await fixtures(page, { archived: [porto] });
  await page.goto('/expenses');
  await page.getByRole('button', { name: 'Open holidays', exact: true }).click();
  await page.getByRole('button', { name: 'Activity and people', exact: true }).click();
  const view = page.getByRole('dialog', { name: 'Activity and people' });
  await expect(view.locator('.activity-row')).toHaveCount(2);
  const archived = view.locator('.activity-row', { hasText: 'Wine tasting' });
  await expect(archived).toContainText('Porto · Holiday · Archived');
  await expect(archived).toBeDisabled();
  await view.getByRole('tab', { name: 'People' }).click();
  // Sam owes €20 in archived Porto and is owed £50 in Lisbon; the two are never combined.
  await expect(view.locator('.people-list')).toContainText('Owes you €20.00');
  await expect(view.locator('.people-list')).toContainText('You owe £50.00');
  await expect(view.locator('.people-list')).toContainText('Porto is archived. Restore it to settle up.');
  await expect(view.getByRole('button', { name: 'Settle up in Porto' })).toHaveCount(0);
  await view.getByRole('tab', { name: 'Activity' }).click();
  await view.getByRole('checkbox', { name: 'Include archived holidays and bills' }).uncheck();
  await expect(view.locator('.activity-row')).toHaveCount(1);
  await expect(view.locator('.activity-row')).toContainText('Hotel');
});
