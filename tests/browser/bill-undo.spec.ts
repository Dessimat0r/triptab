import { expect, test, type Page } from '@playwright/test';
import { validateLedger, type Trip } from '../../lib/model';

// F-14, owner decision A: deleting a bill offers Undo, and Archived holidays
// lists it under Recently deleted for 30 days. The server rules themselves are
// covered by tests/bill-soft-delete.test.ts; this stub mirrors them.
const members = [{ id: 'gary', name: 'Gary', userId: 'owner' }, { id: 'sam', name: 'Sam' }];
const dinner: Trip = { id: 'undo-bill', ownerId: 'owner', kind: 'bill', name: 'Dinner', currency: 'GBP', members, payments: [], drafts: [],
  expenses: [{ id: 'meal', title: 'Meal', date: '2026-11-06', time: '20:00', timezone: 'Europe/London', currency: 'GBP', payer: 'gary', tax: 0, tip: 0, discount: 0,
    items: [{ id: 'food', name: 'Food', amount: 4000, members: ['gary', 'sam'] }] }] };
const lisbon: Trip = { id: 'undo-holiday', ownerId: 'owner', name: 'Lisbon', currency: 'GBP', members, expenses: [], payments: [], drafts: [] };

async function fixtures(page: Page) {
  let trips = validateLedger({ trips: [lisbon, dinner] }).trips, revision = 1;
  const deleted = new Map<string, Trip>(), actions: Record<string, string>[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), pathname = url.pathname;
    if (pathname === '/api/trip' && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, string>;
      actions.push(body);
      const trip = trips.find(value => value.id === body.tripId);
      if (body.action === 'delete' && trip) {
        if (body.confirmName !== trip.name) return route.fulfill({ status: 400, json: { error: 'Type the bill name exactly to confirm deleting it.' } });
        deleted.set(trip.id, trip); trips = trips.filter(value => value.id !== trip.id); revision++;
        return route.fulfill({ json: { deleted: true, restorable: true } });
      }
      if (body.action === 'restore-deleted' && deleted.has(body.tripId)) {
        trips = [...trips, deleted.get(body.tripId)!]; deleted.delete(body.tripId); revision++;
        return route.fulfill({ json: { tripName: 'Dinner' } });
      }
      if (body.action === 'purge-deleted' && deleted.has(body.tripId)) { deleted.delete(body.tripId); return route.fulfill({ json: { deleted: true } }); }
      return route.fulfill({ status: 404, json: { error: 'This bill can no longer be restored.' } });
    }
    const json = pathname === '/api/ledger' ? { data: { trips }, revision }
      : pathname === '/api/trip' && url.searchParams.get('mode') === 'deleted'
        ? { bills: [...deleted.values()].map(trip => ({ id: trip.id, name: trip.name, deletedAt: '2026-11-06T20:00:00.000Z', restoreUntil: '2026-12-06T20:00:00.000Z' })) }
      : pathname === '/api/trip' ? { trips: [] }
      : pathname === '/api/profile' ? { id: 'owner', displayName: 'Gary', email: 'gary@example.invalid', authMethod: 'password' }
      : pathname === '/api/receipt/ai-status' ? { configured: false, connected: false, provider: 'api', eligible: false, manageable: false, siwcAvailable: false }
      : pathname === '/api/trip-language' ? { accountId: 'owner', tripId: url.searchParams.get('tripId'), revision: 1, preferences: { readingLanguage: 'en', primaryVersion: 'reading', itemVersions: {} } }
      : { events: [], notifications: [], items: [], invitations: [] };
    return route.fulfill({ json, headers: pathname === '/api/ledger' ? { 'X-TripTab-Account': 'owner' } : {} });
  });
  return { get trips() { return trips; }, deleted, actions };
}
async function deleteDinner(page: Page) {
  await page.goto('/expenses');
  await page.getByRole('button', { name: 'Open holidays', exact: true }).click();
  await page.getByRole('button', { name: /^Dinner/ }).click();
  await page.getByRole('button', { name: 'Bill options', exact: true }).click();
  await page.getByText('Delete bill', { exact: true }).first().click();
  await page.locator('.trip-controls').getByRole('button', { name: 'Delete bill' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete this bill?' });
  await expect(dialog).toContainText('You can restore it with its receipt photos for 30 days');
  await dialog.getByRole('button', { name: 'Delete bill' }).click();
}

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test('Undo right after deleting a bill puts the same bill back and opens it', async ({ page }) => {
  const state = await fixtures(page);
  await deleteDinner(page);
  const banner = page.locator('.saved-banner', { hasText: 'Deleted the bill “Dinner”' });
  await expect(banner).toBeVisible();
  expect(state.trips.map(trip => trip.id)).toEqual(['undo-holiday']);
  await banner.getByRole('button', { name: /Undo/ }).click();
  await expect.poll(() => state.trips.map(trip => trip.id)).toEqual(['undo-holiday', 'undo-bill']);
  await expect(page.locator('[data-entry-id="meal"]')).toBeVisible();
  expect(state.actions.map(value => value.action)).toEqual(['delete', 'restore-deleted']);
});

test('Archived holidays lists a deleted bill under Recently deleted, to restore or delete for good', async ({ page }) => {
  const state = await fixtures(page);
  await deleteDinner(page);
  await page.getByRole('button', { name: 'Open holidays', exact: true }).click();
  await page.getByRole('button', { name: 'More holiday options', exact: true }).click();
  await page.getByRole('button', { name: 'Archived holidays', exact: true }).click();
  const recent = page.locator('.recently-deleted');
  await expect(recent).toContainText('Dinner');
  await expect(recent).toContainText('can be restored until 2026-12-06');
  await recent.getByRole('button', { name: 'Delete for good' }).click();
  await page.getByRole('dialog', { name: 'Delete this bill for good?' }).getByRole('button', { name: 'Cancel' }).click();
  expect(state.deleted.has('undo-bill')).toBe(true);
  await recent.getByRole('button', { name: 'Restore bill' }).click();
  await expect(recent).toHaveCount(0);
  await expect.poll(() => state.trips.map(trip => trip.id)).toEqual(['undo-holiday', 'undo-bill']);
});
