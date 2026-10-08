import { expect, test, type Page } from '@playwright/test';

const at = '2026-10-05T12:00:00.000Z';
const trip = {
  id: 'flow-trip', ownerId: 'flow-owner', name: 'Vienna', currency: 'GBP',
  members: [{ id: 'flow-gary', name: 'Gary', userId: 'flow-owner' }, { id: 'flow-sam', name: 'Sam' }],
  expenses: [], payments: [], drafts: [{
    id: 'flow-draft', receiptId: 'flow-photo', title: 'Café Central', status: 'review', currency: 'EUR',
    date: '2026-10-05', time: '13:42', timezone: 'Europe/Vienna', payer: 'flow-gary', tax: 0, tip: 0, discount: 0,
    fieldSources: { title: 'receipt', currency: 'receipt', date: 'receipt', time: 'receipt' },
    items: [
      { id: 'flow-coffee', name: 'Melange', amount: 520, members: [] },
      { id: 'flow-cake', name: 'Sachertorte', amount: 790, members: ['flow-sam'] },
    ],
    receiptScan: { version: 1, printedTotal: 1310, printedCurrency: 'EUR', status: 'matched', warnings: [] },
    conversation: [{ id: 'flow-summary', role: 'assistant', text: 'Read 2 items.', createdAt: at }],
  }],
};

// `holdRate` lets a test keep the rate lookup pending until it is ready;
// waiting on fixed delays races slower browsers.
async function fixtures(page: Page, holdRate?: () => Promise<void>) {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/ledger' && route.request().method() === 'POST') return route.fulfill({ status: 409, json: { error: 'Revision changed' } });
    if (path === '/api/receipt') return route.fulfill({ contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="900"><rect width="400" height="900" fill="white"/></svg>' });
    if (path === '/api/fx') {
      await holdRate?.();
      return route.fulfill({ json: { rate: 0.86, asOf: '2026-10-05' } });
    }
    const json = path === '/api/ledger' ? { data: { trips: [trip] }, revision: 1 }
      : path === '/api/profile' ? { id: 'flow-owner', displayName: 'Gary', email: 'flow@example.invalid', authMethod: 'password' }
      : path === '/api/trip-language' ? { accountId: 'flow-owner', tripId: 'flow-trip', revision: 1, preferences: { readingLanguage: 'en', primaryVersion: 'reading', itemVersions: {} } }
      : path === '/api/receipt/ai-status' ? { configured: false, connected: false, provider: 'api', eligible: false, manageable: false, siwcAvailable: false }
      : { events: [], notifications: [], items: [] };
    return route.fulfill({ json, headers: path === '/api/ledger' ? { 'X-TripTab-Account': 'flow-owner' } : {} });
  });
}

function reactErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
  return errors;
}

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
// In CI these can be the first pages a freshly launched WebKit opens in each
// worker; give that cold start room instead of failing at the 30s default.
test.slow(({ browserName }) => browserName === 'webkit', 'Cold WebKit start in CI');

// The tests need the editor, not the page's load event, which a slow first
// WebKit page could hold back indefinitely.
async function openDraft(page: Page) {
  await page.goto('/expenses?receiptDraft=flow-draft&receiptTrip=flow-trip', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.editor')).toBeVisible({ timeout: 30_000 });
}

test('a scanned foreign receipt fetches its rate, splits in one tap and stays tidy', async ({ page }) => {
  const errors = reactErrors(page);
  await fixtures(page);
  await openDraft(page);
  await expect(page.locator('.rate-result')).toContainText('Daily reference rate');
  await expect(page.locator('.expense-more-options')).not.toHaveAttribute('open', '');
  await expect(page.locator('.purchase-details')).toHaveCount(1);
  // Payer and currency are always visible in Purchase, whichever layout is shown.
  await expect(page.getByRole('combobox', { name: 'Paid by' })).toHaveValue('flow-gary');
  await expect(page.getByRole('combobox', { name: 'Currency', exact: true })).toHaveValue('EUR');
  await page.getByRole('button', { name: 'Share the remaining item equally' }).click();
  await expect(page.locator('.quick-split')).toHaveCount(0);
  await expect(page.locator('.expense-shares')).toContainText('Gary');
  await expect(page.locator('.expense-shares')).toContainText('Sam');
  await expect(page.locator('.receipt-proposal')).toHaveCount(0);
  await expect(page.locator('.save-checklist')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a rate typed while the automatic lookup is pending is kept', async ({ page }) => {
  const errors = reactErrors(page);
  let requested!: () => void, release!: () => void;
  const rateRequested = new Promise<void>(resolve => { requested = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  await fixtures(page, () => { requested(); return released; });
  await openDraft(page);
  await rateRequested;
  await expect(page.locator('.rate-result')).toContainText('Finding the EUR to GBP rate');
  await page.locator('.manual-rate summary').click();
  const manual = page.getByRole('spinbutton', { name: /1 EUR in GBP/ });
  await manual.fill('0.75');
  await expect(page.locator('.rate-result')).toContainText('Manual rate');
  // With a manual rate, the reference lookup is offered beside it and still pending.
  const lookupButton = page.locator('.manual-rate > button.quiet');
  await expect(lookupButton).toHaveText(/Finding rate/, { timeout: 1 });
  release();
  // The lookup has been answered and handled once the button is idle again.
  await expect(lookupButton).toHaveText('Use the daily reference rate');
  await expect(lookupButton).toBeEnabled();
  await expect(manual).toHaveValue('0.75');
  await expect(page.locator('.rate-result')).toContainText('Manual rate');
  await expect(page.locator('.purchase-details')).toHaveCount(1);
  expect(errors.filter(error => /same key|duplicate/i.test(error))).toEqual([]);
  expect(errors).toEqual([]);
});
