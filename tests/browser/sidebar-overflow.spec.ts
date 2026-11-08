import { expect, test, type Page } from '@playwright/test';

const ownerId = 'drawer-owner';
const members = [
  { id: 'drawer-alex', name: 'Alex', userId: ownerId },
  { id: 'drawer-sam', name: 'Sam' },
];

async function fixtures(page: Page, holidays = 3) {
  const trips = [
    ...Array.from({ length: holidays }, (_, index) => ({
      id: `holiday-${index + 1}`, ownerId, name: `Holiday ${index + 1}`,
      currency: 'GBP', members, expenses: [], payments: [], drafts: [],
    })),
    ...Array.from({ length: 6 }, (_, index) => ({
      id: `bill-${index + 1}`, ownerId, kind: 'bill', name: `Bill ${index + 1}`,
      currency: 'GBP', members, expenses: [], payments: [], drafts: [],
    })),
  ];
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const json = path === '/api/ledger' ? { data: { trips }, revision: 1 }
      : path === '/api/profile' ? { id: ownerId, displayName: 'Alex', email: 'alex@example.invalid', authMethod: 'password' }
      : path === '/api/receipt/ai-status' ? { configured: false, connected: false, provider: 'api', eligible: false, manageable: false, siwcAvailable: false }
      : path === '/api/trip-language' ? { accountId: ownerId, tripId: trips[0].id, revision: 1,
        preferences: { readingLanguage: 'en', primaryVersion: 'reading', itemVersions: {} } }
      : { events: [], notifications: [], items: [] };
    return route.fulfill({ json, headers: path === '/api/ledger' ? { 'X-TripTab-Account': ownerId } : {} });
  });
}

async function checkRows(page: Page, count: number) {
  const sidebar = page.locator('#holiday-sidebar');
  // Navigation rows only: a row may also carry a ⋯ actions button (F-06).
  const rows = sidebar.locator('.tripnav-row > button');
  await expect(rows).toHaveCount(count);
  const geometry = await sidebar.evaluate(element => ({
    drawerHeight: element.clientHeight,
    drawerScrollHeight: element.scrollHeight,
    listOverflow: [...element.querySelectorAll('.tripnav')].map(list => getComputedStyle(list).overflowY),
    rowHeights: [...element.querySelectorAll('.tripnav-row > button')].map(button => button.getBoundingClientRect().height),
  }));
  expect(geometry.drawerScrollHeight).toBeGreaterThan(geometry.drawerHeight);
  expect(geometry.listOverflow).toEqual(['visible', 'visible']);
  for (const height of geometry.rowHeights) expect(height).toBeGreaterThanOrEqual(44);
  for (const row of await rows.all()) {
    await row.scrollIntoViewIfNeeded();
    const visible = await row.evaluate(button => {
      const drawer = button.closest('#holiday-sidebar')!.getBoundingClientRect();
      const box = button.getBoundingClientRect();
      return box.top >= drawer.top - 1 && box.bottom <= drawer.bottom + 1;
    });
    expect(visible).toBe(true);
  }
  await sidebar.evaluate(element => { element.scrollTop = element.scrollHeight; });
  expect(await sidebar.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect(sidebar.locator('.personal')).toBeInViewport({ ratio: 1 });
}

for (const viewport of [
  { width: 375, height: 667 }, { width: 390, height: 844 }, { width: 1366, height: 768 },
]) {
  test(`drawer scrolls to every full-height navigation row at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await fixtures(page);
    await page.goto('/expenses');
    if (viewport.width <= 900) await page.getByRole('button', { name: 'Open holidays', exact: true }).click();
    const sidebar = page.locator('#holiday-sidebar');
    await expect(sidebar).toBeVisible();
    await checkRows(page, 8);

    const showAll = sidebar.getByRole('button', { name: 'Show all bills', exact: true });
    await expect(showAll).toBeVisible();
    expect((await showAll.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await sidebar.locator('.bill-nav button').last().focus();
    await page.keyboard.press('Tab');
    await expect(showAll).toBeFocused();
    await expect(showAll).toBeInViewport({ ratio: 1 });
    await page.keyboard.press('Enter');
    await expect(showAll).toHaveCount(0);
    const billRows = sidebar.locator('.bill-nav .tripnav-row > button');
    await expect(billRows).toHaveCount(6);
    await checkRows(page, 9);

    await billRows.last().scrollIntoViewIfNeeded();
    await expect(billRows.last()).toBeInViewport({ ratio: 1 });
    await billRows.last().click();
    await expect(page.getByRole('heading', { name: 'Bill 1', exact: true })).toBeVisible();
  });
}

test('bills alone omit the empty holidays heading', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixtures(page, 0);
  await page.goto('/expenses');
  await page.getByRole('button', { name: 'Open holidays', exact: true }).click();
  await expect(page.locator('#holiday-sidebar .side-label')).toHaveText('BILLS');
});
