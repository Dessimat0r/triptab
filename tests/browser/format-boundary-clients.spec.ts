import { expect, test, type Page } from '@playwright/test';
import type { Trip } from '../../lib/model';

/**
 * R01 on the clients: the export/audit downloads and the offline sync now declare the money format (their routes
 * refuse anything else), and a refused offline sync keeps the queued entry, shows the server's guidance and stops
 * retrying on focus or reconnect until the page is reloaded.
 */
const trip: Trip = {
  id: 'boundary-trip', ownerId: 'alice', name: 'Prague', currency: 'GBP', startDate: '2026-10-09', endDate: '2026-10-11',
  members: [{ id: 'a', name: 'Alice', userId: 'alice' }, { id: 'b', name: 'Bob', userId: 'bob' }],
  expenses: [{ id: 'meal', title: 'Dinner at the river', date: '2026-10-09', time: '20:30', timezone: 'Europe/Prague', currency: 'GBP', payer: 'a',
    items: [{ id: 'line', name: 'Dinner', amount: 2000, members: ['a', 'b'] }], tax: 0, tip: 0, discount: 0 }],
  payments: [], drafts: [],
};
const REFUSAL = 'TripTab has been updated. Reload this page to see current amounts. Nothing was saved.';
type Seen = { path: string; method: string; format: string | undefined };

async function fixtures(page: Page, offline: { mode: 'ok' | 'refuse' }) {
  const seen: Seen[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    seen.push({ path, method: request.method(), format: request.headers()['x-triptab-financial-format'] });
    let json: unknown = {};
    if (path === '/api/offline-expenses') {
      if (offline.mode === 'refuse') return route.fulfill({ status: 426, headers: { 'X-TripTab-Financial-Format-Required': '2', 'Cache-Control': 'private, no-store' }, json: { error: REFUSAL } });
      json = { saved: true };
    } else if (path === '/api/ledger') json = { data: { trips: [trip] }, revision: 1 };
    else if (path === '/api/profile') json = { id: 'alice', displayName: 'Alice', email: 'alice@example.test', authMethod: 'password', hasPassword: true, emailVerified: true, uiLanguage: 'en' };
    else if (path === '/api/account') json = { sessions: [] };
    else if (path === '/api/notification-preferences') json = { scope: 'all', delivery: 'immediate', reminders: true, receiptReady: false };
    else if (path === '/api/invite') json = { invitations: [], hasMore: false };
    else if (path === '/api/receipt/audit') return route.fulfill({ json: { findings: [] }, headers: { 'Content-Disposition': 'attachment; filename="receipt-discrepancies.json"' } });
    else if (path === '/api/trip-language') json = { accountId: 'alice', tripId: trip.id, revision: 1, preferences: { readingLanguage: 'en', primaryVersion: 'reading', itemVersions: {} } };
    else if (path === '/api/trip') json = { trips: [] };
    else json = { events: [], nextCursor: null, notifications: [], items: [] };
    await route.fulfill({ json, headers: path === '/api/ledger' ? { 'X-TripTab-Account': 'alice' } : {} });
  });
  return seen;
}

async function queueOneEntry(page: Page) {
  await page.goto('/travellers');
  await page.getByRole('button', { name: 'Enable on this device' }).click();
  await page.getByRole('link', { name: 'Open capture form' }).click();
  await page.locator('#capture-title').fill('Underground tickets');
  await page.locator('#capture-amount').fill('8.50');
  await page.getByRole('button', { name: 'Save on this device' }).click();
  await expect(page.locator('#capture-status')).toContainText('Saved on this device');
}
const queued = (page: Page) => page.evaluate(() => new Promise<number>((resolve, reject) => {
  const open = indexedDB.open('triptab-capture-v1', 1);
  open.onerror = () => reject(open.error);
  open.onsuccess = () => { const count = open.result.transaction('queue').objectStore('queue').count(); count.onsuccess = () => resolve(count.result); count.onerror = () => reject(count.error); };
}));

test('a refused (426) offline sync keeps the queued expense, shows the guidance, declares format 2 and does not retry on focus or reconnect; a reload then syncs it', async ({ page }) => {
  const offline = { mode: 'refuse' as 'ok' | 'refuse' };
  const seen = await fixtures(page, offline);
  await queueOneEntry(page);
  await page.goto('/expenses');
  await expect(page.getByText(REFUSAL, { exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'pending expenses for this account.' })).toContainText('1');
  expect(await queued(page)).toBe(1);
  const attempts = () => seen.filter(entry => entry.path === '/api/offline-expenses');
  expect(attempts().length).toBeGreaterThanOrEqual(1);
  expect(attempts().every(entry => entry.format === '2')).toBe(true);
  const afterFirst = attempts().length;
  for (let i = 0; i < 3; i++) await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); });
  await page.waitForTimeout(500);
  expect(attempts().length, 'focus and reconnect do not retry a refused bundle').toBe(afterFirst);
  expect(await queued(page), 'the entry is still queued').toBe(1);
  // The current bundle (a reload) is accepted, and the same entry syncs once.
  offline.mode = 'ok';
  await page.reload();
  await expect.poll(() => queued(page)).toBe(0);
  expect(attempts().filter(entry => entry.format === '2').length).toBeGreaterThan(afterFirst);
});

test('the receipt audit report and the trip history load and download with the declared format (a plain link could not send it)', async ({ page }) => {
  const seen = await fixtures(page, { mode: 'ok' });
  await page.goto('/history');
  await page.getByText('Historical receipt discrepancy report').click();
  await expect(page.getByText('No discrepancies found in the available evidence.', { exact: false })).toBeVisible();
  const audits = () => seen.filter(entry => entry.path === '/api/receipt/audit');
  expect(audits().length).toBeGreaterThanOrEqual(1);
  expect(audits().every(entry => entry.format === '2')).toBe(true);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download this report' }).click()]);
  expect(download.suggestedFilename()).toBe('receipt-discrepancies.json');
  expect(audits().length).toBeGreaterThanOrEqual(2);
  expect(audits().every(entry => entry.format === '2')).toBe(true);
});
