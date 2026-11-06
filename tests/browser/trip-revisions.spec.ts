import { expect, test, type Page } from '@playwright/test';
import { validateLedger, type Trip } from '../../lib/model';

// F-16: the app saves only the trip it changed, with that trip's revision, so
// another person's save to a different trip is not a conflict. The stub applies
// the server rule (lib/store.ts writeTrips); tests/store.test.ts covers the server.
const members = [{ id: 'gary', name: 'Gary', userId: 'owner' }, { id: 'sam', name: 'Sam' }];
const lisbon: Trip = { id: 'lisbon', ownerId: 'owner', name: 'Lisbon', currency: 'GBP', members, payments: [], drafts: [],
  expenses: [{ id: 'hotel', title: 'Hotel', date: '2026-11-06', time: '12:00', timezone: 'Europe/London', currency: 'GBP', payer: 'gary', tax: 0, tip: 0, discount: 0,
    items: [{ id: 'room', name: 'Room', amount: 10000, members: ['gary', 'sam'] }] }] };
const taxi: Trip = { id: 'taxi', ownerId: 'owner', kind: 'bill', name: 'Taxi', currency: 'GBP', members, expenses: [], payments: [], drafts: [] };

async function fixtures(page: Page) {
  let trips = validateLedger({ trips: [lisbon, taxi] }).trips, revision = 1;
  const revisions: Record<string, number> = { lisbon: 3, taxi: 7 };
  const posts: Record<string, unknown>[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (pathname === '/api/ledger' && request.method() === 'POST') {
      const body = request.postDataJSON() as { data: { trips: Trip[] }; revision: number; tripRevisions?: Record<string, number> };
      posts.push(body);
      if (!body.tripRevisions) return route.fulfill({ status: 400, json: { error: 'expected a per-trip save' } });
      for (const posted of body.data.trips) if (revisions[posted.id] !== undefined && revisions[posted.id] !== body.tripRevisions[posted.id]) return route.fulfill({ status: 409, json: { error: 'conflict' } });
      const merged = trips.map(value => body.data.trips.find(posted => posted.id === value.id) ?? value);
      trips = validateLedger({ trips: merged }, { source: 'web', previous: { trips } }).trips;
      for (const posted of body.data.trips) revisions[posted.id]++;
      return route.fulfill({ json: { data: { trips }, revision: ++revision, revisions }, headers: { 'X-TripTab-Account': 'owner' } });
    }
    const json = pathname === '/api/ledger' ? { data: { trips }, revision, revisions }
      : pathname === '/api/profile' ? { id: 'owner', displayName: 'Gary', email: 'gary@example.invalid', authMethod: 'password' }
      : pathname === '/api/receipt/ai-status' ? { configured: false, connected: false, provider: 'api', eligible: false, manageable: false, siwcAvailable: false }
      : pathname === '/api/trip-language' ? { accountId: 'owner', tripId: 'lisbon', revision: 1, preferences: { readingLanguage: 'en', primaryVersion: 'reading', itemVersions: {} } }
      : { events: [], notifications: [], items: [], invitations: [] };
    return route.fulfill({ json, headers: pathname === '/api/ledger' ? { 'X-TripTab-Account': 'owner' } : {} });
  });
  return {
    get trips() { return trips; }, posts, revisions,
    // Another device renames the taxi bill: the shared save token moves on.
    otherDeviceRenamesTaxi() { trips = trips.map(value => value.id === 'taxi' ? { ...value, name: 'Airport taxi' } : value); revisions.taxi++; revision++; },
  };
}

test('editing an expense sends only its holiday, and another device\'s change to a bill is not a conflict', async ({ page }) => {
  const state = await fixtures(page);
  await page.goto('/expenses');
  await page.locator('[data-entry-id="hotel"] .expense-open').click();
  state.otherDeviceRenamesTaxi();
  await page.getByRole('textbox', { name: 'Expense name', exact: true }).fill('Hotel and breakfast');
  await page.getByRole('button', { name: 'Save expense', exact: true }).click();
  await expect(page.locator('.editor')).toHaveCount(0);
  expect(state.posts).toHaveLength(1);
  const [post] = state.posts as { data: { trips: Trip[] }; tripRevisions: Record<string, number> }[];
  expect(post.data.trips.map(value => value.id)).toEqual(['lisbon']);
  expect(post.tripRevisions).toEqual({ lisbon: 3 });
  // Both changes are kept: the new name in Lisbon and the other device's rename.
  expect(state.trips.find(value => value.id === 'lisbon')!.expenses[0].title).toBe('Hotel and breakfast');
  expect(state.trips.find(value => value.id === 'taxi')!.name).toBe('Airport taxi');
  await expect(page.getByText('Your ledger changed')).toHaveCount(0);
});
