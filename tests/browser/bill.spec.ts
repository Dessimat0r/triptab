import path from 'node:path';
import { formatMoney as money } from '../../lib/money-format';
import { expect, test, type Page } from '@playwright/test';
import { validateLedger, balances, travellerFinancialPreview, type Ledger, type Trip } from '../../lib/model';

const pathPhoto = path.resolve('tests/fixtures/receipts/v1/images/long-receipt.png');
const members = ['Alex', 'Sam', 'Jo', 'Kim'].map((name, i) => ({ id: `person-${i}`, name, ...(i === 0 ? { userId: 'bill-owner' } : {}) }));
const holiday: Trip = { id: 'holiday', ownerId: 'bill-owner', name: 'Lisbon holiday', currency: 'GBP', members, expenses: [], payments: [], drafts: [] };
export const bill: Trip & { kind: 'bill' } = { ...holiday, id: 'dinner', kind: 'bill', name: 'Dinner at Taberna Real', currency: 'EUR', expenses: [{ id: 'dinner-receipt', title: 'Dinner at Taberna Real', date: '2026-10-10', time: '19:00', timezone: 'Europe/Lisbon', currency: 'EUR', payer: members[0].id, items: [{ id: 'dinner-item', name: 'Dinner', amount: 12640, members: members.map(member => member.id) }], tax: 0, tip: 0, discount: 0 }] };
const archived = { ...bill, id: 'archived-bill', name: 'Settled lunch', payments: members.slice(1).map(member => ({ id: `paid-${member.id}`, from: member.id, to: members[0].id, amount: 3160, date: '2026-10-10' })) };

async function fixtures(page: Page) {
  await page.addInitScript(() => {
    const clicks: string[] = [];
    Object.defineProperty(window, '__billClicks', { value: clicks });
    document.addEventListener('click', event => { const button = (event.target as Element).closest('button'); if (button) clicks.push(button.getAttribute('aria-label') || button.textContent?.trim() || ''); }, true);
  });
  let data: Ledger = structuredClone({ trips: [holiday, bill] }), revision = 1;
  const actions: string[] = [], archives: Trip[] = [archived];
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    let json: unknown = { events: [], notifications: [], items: [], invitations: [] };
    if (path === '/api/profile') json = { id: 'bill-owner', displayName: 'Alex', email: 'alex@example.invalid', authMethod: 'password' };
    if (path === '/api/ledger') {
      if (request.method() === 'POST') { const next = request.postDataJSON().data as Ledger; for (const trip of next.trips) { if (!data.trips.some(old => old.id === trip.id)) { trip.ownerId = 'bill-owner'; trip.members[0].userId = 'bill-owner'; } } data = validateLedger(next, { previous: data }); revision++; }
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
    if (path === '/api/receipt' && request.method() === 'POST') json = { receiptId: 'bill-photo' };
    if (path === '/api/receipt' && request.method() === 'GET') return route.fulfill({ contentType: 'image/png', path: pathPhoto });
    if (path === '/api/receipt/process') {
      const { tripId, draftId } = request.postDataJSON(); const current = data.trips.find(trip => trip.id === tripId)!; const draft = current.drafts.find(draft => draft.id === draftId)!;
      Object.assign(draft, { title: 'Scanned euro dinner', currency: 'EUR', status: 'review', date: '2026-10-10', time: '19:00', timezone: 'Europe/Lisbon', source: 'ai', items: [{ id: 'scan-line', name: 'Food', amount: 4800, members: current.members.map(member => member.id) }], receiptScan: { version: 1, printedCurrency: 'EUR', printedTotal: 4800, status: 'matched', warnings: [] } });
      json = { data, revision: ++revision };
    }
    if (path === '/api/fx') json = { rate: 0.85, asOf: '2026-10-10' };
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
  const brokenWords = await page.locator('.bill-share b, .bill-share span, .bill-share strong').evaluateAll(elements => {
    const failures: string[] = [];
    for (const element of elements) {
      const width = element.getBoundingClientRect().width;
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) for (const match of node.textContent!.matchAll(/[^\s-]+/g)) {
        const range = document.createRange(); range.setStart(node, match.index!); range.setEnd(node, match.index! + match[0].length);
        const rects = [...range.getClientRects()].filter(rect => rect.width > 0);
        if (new Set(rects.map(rect => Math.round(rect.y))).size > 1 && rects.reduce((sum, rect) => sum + rect.width, 0) <= width) failures.push(match[0]);
      }
    }
    return failures;
  });
  expect(brokenWords).toEqual([]);
  if (await page.locator('.bill-view').count()) {
    const actions = await page.locator('.expense-entry-actions button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().toJSON()));
    expect(Math.abs(actions[0].width - actions[1].width)).toBeLessThanOrEqual(1);
  }
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
  test(`[P2] start a manual bill, name suggestions and first-save defaults at ${width}px`, async ({ page }) => {
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
    await expect(page.locator('.editor')).toHaveCount(0);
    expect((await page.evaluate(() => (window as unknown as { __billClicks: string[] }).__billClicks)).length).toBeLessThanOrEqual(5);
    const created = state.ledger().trips.find(trip => trip.name === 'Lunch')!;
    expect((created as Trip & { kind?: 'bill' }).kind).toBe('bill'); expect(created.members).toHaveLength(4); expect(created.expenses).toHaveLength(1);
    expect(balances(created)).toEqual([3600, -1200, -1200, -1200]); await fits(page);
  });
}
test('[P2] closing an empty new bill discards it and returns to the previous holiday', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); const state = await fixtures(page); await page.goto('/expenses');
  await page.getByRole('button', { name: 'Open holidays', exact: true }).click(); await page.getByRole('button', { name: 'Split a bill', exact: true }).click();
  await page.getByRole('button', { name: 'Enter amount', exact: true }).click(); await page.getByRole('button', { name: 'Close editor', exact: true }).click();
  await expect(page.getByRole('heading', { name: holiday.name })).toBeVisible(); expect(state.actions).toContain('discard'); expect(state.ledger().trips).toHaveLength(2);
});
test('[P2] first EUR scan adopts its currency atomically without FX', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); const state = await fixtures(page);
  state.ledger().trips.push({ ...holiday, id: 'recent-holiday', name: 'Recent holiday' }); await page.goto('/expenses');
  await page.getByRole('button', { name: 'Open holidays', exact: true }).click(); await page.getByRole('button', { name: 'Split a bill', exact: true }).click();
  const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: 'Scan receipt', exact: true }).last().click(); await (await chooser).setFiles(pathPhoto);
  await expect(page.getByRole('textbox', { name: 'Expense name', exact: true })).toHaveValue('Scanned euro dinner');
  await page.getByRole('button', { name: /^(Confirm & save expense|Save expense)$/ }).click();
  await expect(page.locator('.editor')).toHaveCount(0);
  const created = state.ledger().trips.find(trip => trip.name === 'Scanned euro dinner')!; expect(created.currency).toBe('EUR'); expect(created.expenses[0].fx).toBeUndefined(); expect(created.expenses[0].bankAmount).toBeUndefined();
});
for (const path of ['/expenses', '/balances', '/receipts', '/travellers']) for (const width of [320, 390]) {
  test(`[P3] bill shares and reduced navigation on ${path} at ${width}px`, async ({ page }) => {
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
test('[P3] mark paid, archive and archived bill label', async ({ page }) => {
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
test('[P3] summary shares only names and amounts', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (value: string) => { (window as unknown as { copied: string }).copied = value; } } }); });
  await page.setViewportSize({ width: 390, height: 844 }); await fixtures(page); await page.goto('/expenses'); await selectBill(page);
  await page.getByRole('button', { name: 'Copy summary', exact: true }).click();
  const copied = await page.evaluate(() => (window as unknown as { copied: string }).copied);
  expect(copied).toBe('Dinner at Taberna Real — €126.40\nAlex paid. Sam owes Alex €31.60. Jo owes Alex €31.60. Kim owes Alex €31.60.'); expect(copied).not.toContain('@');
});
test('[P3] People sheet reuses names and safe removal without dates or weights', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 }); await fixtures(page); await page.goto('/expenses'); await selectBill(page);
  await page.getByRole('button', { name: 'Bill options', exact: true }).click(); await page.getByRole('button', { name: 'People', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'People', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Traveller 2 name', exact: true })).toBeVisible();
  await expect(page.getByText('Counts as', { exact: true })).toHaveCount(0); await expect(page.getByText('Joined on', { exact: true })).toHaveCount(0); await fits(page);
});

test('[P4] explicit name and settlement currency survive the first foreign-currency scan', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); const state = await fixtures(page); await page.goto('/expenses');
  await page.getByRole('button', { name: 'Open holidays', exact: true }).click(); await page.getByRole('button', { name: 'Split a bill', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Split a bill', exact: true });
  await sheet.getByText('More options', { exact: true }).click();
  await sheet.getByRole('textbox', { name: 'Name', exact: true }).fill('Birthday dinner');
  await sheet.getByRole('combobox', { name: 'Currency', exact: true }).selectOption('GBP');
  const chooser = page.waitForEvent('filechooser'); await sheet.getByRole('button', { name: 'Scan receipt', exact: true }).click(); await (await chooser).setFiles(pathPhoto);
  await expect(page.getByRole('textbox', { name: 'Expense name', exact: true })).toHaveValue('Scanned euro dinner');
  await expect(page.getByText(/1 EUR = 0\.85 GBP · Daily reference rate/)).toBeVisible();
  await page.getByRole('button', { name: /^(Confirm & save expense|Save expense)$/ }).click();
  await expect(page.locator('.editor')).toHaveCount(0);
  const created = state.ledger().trips.find(trip => trip.name === 'Birthday dinner')!;
  expect(created.currency).toBe('GBP'); expect(created.expenses[0].currency).toBe('EUR'); expect(created.expenses[0].fx?.rate).toBe(0.85);
});

test('[P4] a saved receipt draft prevents empty-bill discard', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); const state = await fixtures(page); await page.goto('/expenses');
  await page.getByRole('button', { name: 'Open holidays', exact: true }).click(); await page.getByRole('button', { name: 'Split a bill', exact: true }).click();
  const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: 'Scan receipt', exact: true }).last().click(); await (await chooser).setFiles(pathPhoto);
  await expect(page.getByRole('textbox', { name: 'Expense name', exact: true })).toHaveValue('Scanned euro dinner');
  await page.getByRole('button', { name: 'Close editor', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Discard unsaved changes?', exact: true });
  if (await confirmation.isVisible()) await confirmation.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(page.locator('.editor')).toHaveCount(0);
  expect(state.actions).not.toContain('discard');
  expect(state.ledger().trips.find(trip => trip.id !== bill.id && trip.kind === 'bill')?.drafts).toHaveLength(1);
});

test('[P4] invalid conversion data hides settlement suggestions', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 }); const state = await fixtures(page);
  state.ledger().trips.find(trip => trip.id === bill.id)!.expenses[0].currency = 'GBP';
  await page.goto('/expenses'); await selectBill(page);
  await expect(page.getByText('Review the flagged receipts before using settlement suggestions.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark paid', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Copy summary', exact: true })).toHaveCount(0);
});
