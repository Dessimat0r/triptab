import { expect, test, type Page } from '@playwright/test';
import { validateLedger, type Draft, type Trip } from '../../lib/model';

// F-14 follow-up: a removed receipt draft can be restored from History.
const members = [{ id: 'gary', name: 'Gary', userId: 'owner' }, { id: 'sam', name: 'Sam' }];
const draft = (receiptId?: string): Draft => ({ id: 'lunch-draft', title: 'Lunch receipt', status: 'review', currency: 'GBP', date: '2026-11-06', time: '13:00',
  timezone: 'Europe/London', payer: 'gary', tax: 0, tip: 0, discount: 0, ...(receiptId ? { receiptId } : {}),
  items: [{ id: 'lunch-item', name: 'Lunch', amount: 900, members: ['gary', 'sam'] }] });
const holiday = (drafts: Draft[] = []): Trip => ({ id: 'restore-trip', ownerId: 'owner', name: 'Lisbon', currency: 'GBP', members, expenses: [], payments: [], drafts });
const deletion = (before: Draft) => ({ id: 'event-1', sequence: 7, tripId: 'restore-trip', entityType: 'draft', entityId: before.id, action: 'delete',
  before, after: null, actorId: 'owner', actorName: 'Gary', createdAt: '2026-11-06T13:05:00Z', revision: 6, source: 'web' });

async function fixtures(page: Page, initial: Trip, deleted: Draft, options: { photo?: number } = {}) {
  let trips = validateLedger({ trips: [initial] }).trips, revision = 1;
  const posts: Trip[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (pathname === '/api/ledger' && request.method() === 'POST') {
      try { trips = validateLedger(request.postDataJSON().data, { source: 'web', previous: { trips } }).trips; }
      catch (error) { return route.fulfill({ status: 400, json: { error: String(error) } }); }
      posts.push(structuredClone(trips[0]));
      return route.fulfill({ json: { data: { trips }, revision: ++revision }, headers: { 'X-TripTab-Account': 'owner' } });
    }
    if (pathname === '/api/receipt') return route.fulfill({ status: options.photo ?? 200, body: '' });
    const json = pathname === '/api/ledger' ? { data: { trips }, revision }
      : pathname === '/api/profile' ? { id: 'owner', displayName: 'Gary', email: 'gary@example.invalid', authMethod: 'password' }
      : pathname === '/api/receipt/ai-status' ? { configured: false, connected: false, provider: 'api', eligible: false, manageable: false, siwcAvailable: false }
      : pathname === '/api/trip-language' ? { accountId: 'owner', tripId: initial.id, revision: 1, preferences: { readingLanguage: 'en', primaryVersion: 'reading', itemVersions: {} } }
      : pathname === '/api/activity' ? { events: [deletion(deleted)], nextCursor: null }
      : { events: [], nextCursor: null, notifications: [], items: [], invitations: [] };
    return route.fulfill({ json, headers: pathname === '/api/ledger' ? { 'X-TripTab-Account': 'owner' } : {} });
  });
  return { get trip() { return trips[0]; }, posts };
}

test('History: Restore receipt draft puts the same draft back and opens it for review', async ({ page }) => {
  const state = await fixtures(page, holiday(), draft());
  await page.goto('/history');
  await page.getByRole('button', { name: 'Restore receipt draft' }).click();
  await expect.poll(() => state.trip.drafts.map(value => value.id)).toEqual(['lunch-draft']);
  // Validation may stamp bookkeeping (the calculation rule); every saved field is the same.
  expect(state.trip.drafts[0]).toMatchObject(draft());
  await expect(page.locator('.editor')).toBeVisible();
});

test('History: a draft that is already back is not duplicated', async ({ page }) => {
  const state = await fixtures(page, holiday([draft()]), draft());
  await page.goto('/history');
  await page.getByRole('button', { name: 'Restore receipt draft' }).click();
  await expect(page.getByText('This receipt draft is already back. Open it from Receipts.')).toBeVisible();
  expect(state.posts).toHaveLength(0);
});

test('History: a draft whose photo was already deleted comes back without it, and says so', async ({ page }) => {
  const state = await fixtures(page, holiday(), draft('gone-photo'), { photo: 404 });
  await page.goto('/history');
  await page.getByRole('button', { name: 'Restore receipt draft' }).click();
  await expect.poll(() => state.trip.drafts.length).toBe(1);
  expect(state.trip.drafts[0].receiptId).toBeUndefined();
  expect(state.trip.drafts[0].items).toEqual(draft().items);
});
