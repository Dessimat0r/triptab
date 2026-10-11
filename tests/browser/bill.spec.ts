import { formatMoney as money } from '../../lib/money-format';
import { expect, test, type Page } from '@playwright/test';
import { balances, travellerFinancialPreview, type Ledger, type Trip } from '../../lib/model';

const members = ['Alex', 'Sam', 'Jo', 'Kim'].map((name, i) => ({ id: `person-${i}`, name, ...(i === 0 ? { userId: 'bill-owner' } : {}) }));
const holiday: Trip = { id: 'holiday', ownerId: 'bill-owner', name: 'Lisbon holiday', currency: 'GBP', members, expenses: [], payments: [], drafts: [] };
export const bill: Trip & { kind: 'bill' } = { ...holiday, id: 'dinner', kind: 'bill', name: 'Dinner at Taberna Real', currency: 'EUR', expenses: [{ id: 'dinner-receipt', title: 'Dinner at Taberna Real', date: '2026-10-10', time: '19:00', timezone: 'Europe/Lisbon', currency: 'EUR', payer: members[0].id, items: [{ id: 'dinner-item', name: 'Dinner', amount: 12640, members: members.map(member => member.id) }], tax: 0, tip: 0, discount: 0 }] };
const archived = { ...bill, id: 'archived-bill', name: 'Settled lunch', payments: members.slice(1).map(member => ({ id: `paid-${member.id}`, from: member.id, to: members[0].id, amount: 3160, date: '2026-10-10' })) };

async function fixtures(page: Page) {
  let data: Ledger = structuredClone({ trips: [holiday, bill] }), revision = 1;
  const actions: string[] = [], archives: Trip[] = [archived];
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    let json: unknown = { events: [], notifications: [], items: [], invitations: [] };
    if (path === '/api/profile') json = { id: 'bill-owner', displayName: 'Alex', email: 'alex@example.invalid', authMethod: 'password' };
    if (path === '/api/ledger') {
      if (request.method() === 'POST') { data = request.postDataJSON().data; revision++; }
      json = { data, revision };
    }
    if (path === '/api/trip') {
      if (request.method() === 'POST') {
        const { action, tripId } = request.postDataJSON(); actions.push(action);
        const value = data.trips.find(trip => trip.id === tripId)!;
        if (action === 'archive') archives.push(value);
        if (action === 'archive' || action === 'discard') data = { trips: data.trips.filter(trip => trip.id !== tripId) };
        if (action === 'restore') data.trips.push(archives.splice(archives.findIndex(trip => trip.id === tripId), 1)[0]);
        revision++; json = { deleted: true, archived: action === 'archive' };
      } else json = { trips: archives.map(trip => ({ id: trip.id, name: trip.name, kind: (trip as Trip & { kind?: 'bill' }).kind, currency: trip.currency, travellers: trip.members.length, owner: true, archivedAt: '2026-10-10T21:00:00Z' })) };
    }
    if (path === '/api/trip-language') json = { accountId: 'bill-owner', tripId: url.searchParams.get('tripId'), revision: 1, preferences: { readingLanguage: 'en', primaryVersion: 'reading', itemVersions: {} } };
    if (path === '/api/receipt/ai-status') json = { configured: true, connected: true, provider: 'api', eligible: true, manageable: false, siwcAvailable: false };
    await route.fulfill({ json, headers: path === '/api/ledger' ? { 'X-TripTab-Account': 'bill-owner' } : {} });
  });
  return { ledger: () => data, actions, archives };
}
async function selectBill(page: Page) {
  await page.getByRole('button', { name: 'Open holidays', exact: true }).click();
  await page.getByRole('button', { name: /Dinner at Taberna Real/ }).click();
}
async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  for (const selector of ['.bill-start', '.bill-view', '.bill-people']) {
    const boxes = await page.locator(`${selector} input, ${selector} button`).evaluateAll(elements => elements.filter(el => el.getClientRects().length).map(el => el.getBoundingClientRect().toJSON()));
    for (const box of boxes) { expect(box.x).toBeGreaterThanOrEqual(-1); expect(box.right).toBeLessThanOrEqual(await page.evaluate(() => innerWidth) + 1); }
  }
}

test('[P0] holidays retain their existing navigation and panels', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await fixtures(page); await page.goto('/expenses');
  await expect(page.getByRole('heading', { name: holiday.name })).toBeVisible();
  await expect(page.locator('.tabs a')).toHaveCount(5);
  await expect(page.getByText('Total trip spend', { exact: true })).toBeVisible(); await fits(page);
});
for (const width of [320, 390]) {
  test.fixme(`[P2] start a manual bill, name suggestions and first-save defaults at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 }); const state = await fixtures(page); await page.goto('/expenses');
    await page.getByRole('button', { name: 'Open holidays', exact: true }).click(); await page.getByRole('button', { name: 'Split a bill', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Split a bill', exact: true });
    await sheet.getByRole('textbox', { name: "Who's splitting?", exact: true }).fill('S');
    await expect(sheet.getByRole('button', { name: 'Add Sam', exact: true })).toBeVisible();
    await sheet.getByRole('button', { name: 'Add Sam', exact: true }).click();
    await sheet.getByRole('textbox', { name: "Who's splitting?", exact: true }).fill('Jo,Kim'); await fits(page);
    await sheet.getByRole('button', { name: 'Enter amount', exact: true }).click();
    await page.getByRole('textbox', { name: 'Expense name', exact: true }).fill('Lunch');
    await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('48');
    await page.getByRole('button', { name: 'Save expense', exact: true }).click();
    const created = state.ledger().trips.find(trip => trip.name === 'Lunch')!;
    expect((created as Trip & { kind?: 'bill' }).kind).toBe('bill'); expect(created.members).toHaveLength(4); expect(created.expenses).toHaveLength(1);
    expect(balances(created)).toEqual([3600, -1200, -1200, -1200]); await fits(page);
  });
}
test.fixme('[P2] closing an empty new bill discards it and returns to the previous holiday', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); const state = await fixtures(page); await page.goto('/expenses');
  await page.getByRole('button', { name: 'Open holidays', exact: true }).click(); await page.getByRole('button', { name: 'Split a bill', exact: true }).click();
  await page.getByRole('button', { name: 'Enter amount', exact: true }).click(); await page.getByRole('button', { name: 'Close editor', exact: true }).click();
  await expect(page.getByRole('heading', { name: holiday.name })).toBeVisible(); expect(state.actions).toContain('discard'); expect(state.ledger().trips).toHaveLength(2);
});
test.fixme('[P2] first EUR receipt adopts its currency atomically without FX', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); const state = await fixtures(page); await page.goto('/expenses');
  await page.getByRole('button', { name: 'Open holidays', exact: true }).click(); await page.getByRole('button', { name: 'Split a bill', exact: true }).click();
  await page.getByRole('button', { name: 'Enter amount', exact: true }).click();
  await page.getByRole('textbox', { name: 'Expense name', exact: true }).fill('Euro dinner'); await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('24');
  await page.getByRole('combobox', { name: 'Currency', exact: true }).selectOption('EUR');
  await page.getByRole('button', { name: 'Save expense', exact: true }).click();
  const created = state.ledger().trips.find(trip => trip.name === 'Euro dinner')!; expect(created.currency).toBe('EUR'); expect(created.expenses[0].fx).toBeUndefined(); expect(created.expenses[0].bankAmount).toBeUndefined();
});
for (const path of ['/expenses', '/balances', '/receipts', '/travellers']) for (const width of [320, 390]) {
  test.fixme(`[P3] bill shares and reduced navigation on ${path} at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 }); await fixtures(page); await page.goto(path); await selectBill(page);
    // Navigate without reloading the client-selected trip.
    await page.evaluate(path => { history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate')); }, path);
    await expect(page.locator('.tabs a')).toHaveText(['Bill', 'History']);
    await expect(page.getByRole('heading', { name: 'Who owes what', exact: true })).toBeVisible();
    for (const member of bill.members) {
      const row = page.getByRole('button', { name: new RegExp(`View statement.*${member.name}`) });
      await expect(row).toContainText(money((travellerFinancialPreview(bill, member.id) as { costShare: number }).costShare, bill.currency));
    }
    await expect(page.getByText('Total trip spend', { exact: true })).toHaveCount(0); await fits(page);
  });
}
test.fixme('[P3] mark paid, archive and archived bill label', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); const state = await fixtures(page); await page.goto('/expenses'); await selectBill(page);
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: 'Mark paid', exact: true }).first().click();
    await page.getByRole('button', { name: 'Review payment', exact: true }).click(); await page.getByRole('button', { name: 'Confirm payment', exact: true }).click();
  }
  await expect(page.getByText('Everyone’s settled', { exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Archive bill', exact: true }).click();
  expect(state.actions).toContain('archive'); expect(state.archives.some(trip => trip.id === bill.id)).toBe(true);
  await page.getByRole('button', { name: 'Open holidays', exact: true }).click(); await page.getByRole('button', { name: 'More holiday options', exact: true }).click();
  await page.getByRole('button', { name: 'Archived holidays', exact: true }).click(); await expect(page.getByText('Bill', { exact: true }).first()).toBeVisible();
});
test.fixme('[P3] summary shares only names and amounts', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (value: string) => { (window as unknown as { copied: string }).copied = value; } } }); });
  await page.setViewportSize({ width: 390, height: 844 }); await fixtures(page); await page.goto('/expenses'); await selectBill(page);
  await page.getByRole('button', { name: 'Copy summary', exact: true }).click();
  const copied = await page.evaluate(() => (window as unknown as { copied: string }).copied);
  expect(copied).toBe('Dinner at Taberna Real — €126.40\nAlex paid. Sam owes Alex €31.60. Jo owes Alex €31.60. Kim owes Alex €31.60.'); expect(copied).not.toContain('@');
});
test.fixme('[P3] People sheet reuses names and safe removal without dates or weights', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 }); await fixtures(page); await page.goto('/expenses'); await selectBill(page);
  await page.getByRole('button', { name: 'Bill options', exact: true }).click(); await page.getByRole('button', { name: 'People', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'People', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Traveller 2 name', exact: true })).toBeVisible();
  await expect(page.getByText('Counts as', { exact: true })).toHaveCount(0); await expect(page.getByText('Joined on', { exact: true })).toHaveCount(0); await fits(page);
});
