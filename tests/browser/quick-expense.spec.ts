import { expect, test, type Page } from '@playwright/test';

// A plain shared purchase uses the quick form: name, amount, payer, people.
const trip = {
  id: 'quick-trip', ownerId: 'quick-owner', name: 'Vienna', currency: 'GBP', receiptLanguage: 'de',
  members: [{ id: 'quick-gary', name: 'Gary', userId: 'quick-owner' }, { id: 'quick-sam', name: 'Sam' }],
  expenses: [{
    id: 'quick-earlier', title: 'Earlier coffee', date: '2026-10-04', time: '09:00', timezone: 'Europe/Vienna',
    currency: 'GBP', payer: 'quick-gary', tax: 0, tip: 0, discount: 0,
    items: [{ id: 'quick-earlier-item', name: 'Earlier coffee', amount: 400, members: ['quick-gary', 'quick-sam'] }],
  }],
  payments: [], drafts: [],
};

type Posted = { data: { trips: typeof trip[] } };

async function fixtures(page: Page, options: { holdRate?: () => Promise<void> } = {}) {
  const posted: Posted[] = [];
  let revision = 1;
  let current = structuredClone(trip);
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/ledger' && route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Posted;
      posted.push(body);
      current = body.data.trips[0];
      return route.fulfill({ json: { data: body.data, revision: ++revision }, headers: { 'X-TripTab-Account': 'quick-owner' } });
    }
    if (path === '/api/fx') {
      await options.holdRate?.();
      return route.fulfill({ json: { rate: 0.86, asOf: '2026-10-05' } });
    }
    const json = path === '/api/ledger' ? { data: { trips: [current] }, revision }
      : path === '/api/profile' ? { id: 'quick-owner', displayName: 'Gary', email: 'quick@example.invalid', authMethod: 'password' }
      : path === '/api/trip-language' ? { accountId: 'quick-owner', tripId: 'quick-trip', revision: 1, preferences: { readingLanguage: 'en', primaryVersion: 'reading', itemVersions: {} } }
      : path === '/api/receipt/ai-status' ? { configured: false, connected: false, provider: 'api', eligible: false, manageable: false, siwcAvailable: false }
      : { events: [], notifications: [], items: [] };
    return route.fulfill({ json, headers: path === '/api/ledger' ? { 'X-TripTab-Account': 'quick-owner' } : {} });
  });
  return posted;
}

async function openNew(page: Page) {
  await page.goto('/expenses', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Add expense', exact: true }).click();
  await expect(page.locator('.editor')).toBeVisible();
}

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test('a shared taxi needs a name, an amount and Save', async ({ page }) => {
  const posted = await fixtures(page);
  await openNew(page);
  const name = page.getByRole('textbox', { name: 'Expense name', exact: true });
  await expect(name).toBeFocused();
  // Everything the common case needs is on the opening screen.
  for (const control of [name, page.getByRole('textbox', { name: 'Amount', exact: true }), page.getByRole('combobox', { name: 'Original currency' }),
    page.getByRole('combobox', { name: 'Paid by' }), page.getByRole('button', { name: 'Sam', exact: true }), page.getByRole('button', { name: 'Save expense', exact: true })]) {
    await expect(control).toBeInViewport({ ratio: 1 });
  }
  await expect(page.locator('.receipt-view-switch')).toHaveCount(0);
  await expect(page.locator('.item')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: /Who bought what/ })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Save expense', exact: true })).toBeDisabled();
  await name.fill('Taxi');
  const amount = page.getByRole('textbox', { name: 'Amount', exact: true });
  await amount.pressSequentially('12,50');
  await expect(page.locator('.quick-shares')).toContainText('Gary £6.25 · Sam £6.25');
  await page.getByRole('button', { name: 'Save expense', exact: true }).click();
  await expect(page.locator('.editor')).toHaveCount(0);
  await expect(page.locator('.saved-banner')).toContainText('Saved “Taxi”');
  const saved = posted.at(-1)!.data.trips[0].expenses[0];
  expect(saved.title).toBe('Taxi');
  expect(saved.items).toHaveLength(1);
  expect(saved.items[0]).toMatchObject({ name: 'Taxi', amount: 1250, members: ['quick-gary', 'quick-sam'] });
  expect(saved.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(saved.timezone).toBe('Europe/Vienna');
});

test('a decimal comma, a paste and a rejected format keep exact hundredths', async ({ page }) => {
  await fixtures(page);
  await openNew(page);
  const amount = page.getByRole('textbox', { name: 'Amount', exact: true });
  await amount.fill('12,50');
  await amount.blur();
  await expect(amount).toHaveValue('12.50');
  await amount.fill('');
  await amount.pressSequentially('1,234.56');
  // "1,23" was accepted; "4" would be a third decimal and is refused, never 1234.56 or 123456.
  await expect(amount).toHaveValue('1,23');
  await amount.blur();
  await expect(amount).toHaveValue('1.23');
});

test('the people choice, custom split and itemising keep one canonical name', async ({ page }) => {
  const posted = await fixtures(page);
  await openNew(page);
  await page.getByRole('textbox', { name: 'Expense name', exact: true }).fill('Groceries');
  await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('30');
  await page.getByRole('button', { name: 'Sam', exact: true }).click();
  await expect(page.locator('.quick-shares')).toContainText('Gary £30.00');
  // The last selected person cannot be removed.
  await page.getByRole('button', { name: 'Gary', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Gary', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Split by item', exact: true }).click();
  const itemName = page.getByRole('textbox', { name: 'Item 1 name', exact: true });
  await expect(itemName).toHaveValue('Groceries');
  await expect(itemName).toBeFocused();
  // A manual line with no language evidence has one name field, even on a holiday with a receipt-language hint.
  await expect(page.locator('.item').first().locator('.item-bilingual-names input')).toHaveCount(1);
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  // A new line starts with the previous line's people.
  await expect(page.getByRole('combobox', { name: 'Person for item 2', exact: true })).toHaveValue('quick-gary');
  await page.getByRole('textbox', { name: 'Item 2 name', exact: true }).fill('Wine');
  await page.getByRole('textbox', { name: 'Item 2 total', exact: true }).fill('10');
  await page.getByRole('button', { name: 'Save expense', exact: true }).click();
  await expect(page.locator('.editor')).toHaveCount(0);
  const saved = posted.at(-1)!.data.trips[0].expenses[0];
  expect(saved.title).toBe('Groceries');
  expect(saved.items.map(item => [item.name, item.amount, item.members])).toEqual([['Groceries', 3000, ['quick-gary']], ['Wine', 1000, ['quick-gary']]]);
});

test('closing or pressing Escape with unsaved work asks first', async ({ page }) => {
  await fixtures(page);
  await openNew(page);
  // An untouched form closes at once.
  await page.getByRole('button', { name: 'Close editor', exact: true }).click();
  await expect(page.locator('.editor')).toHaveCount(0);
  await page.getByRole('button', { name: 'Add expense', exact: true }).click();
  await page.getByRole('textbox', { name: 'Expense name', exact: true }).fill('Taxi');
  await page.keyboard.press('Escape');
  const dialog = page.getByRole('dialog', { name: 'Discard unsaved changes?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Expense name', exact: true })).toHaveValue('Taxi');
  await page.getByRole('button', { name: 'Close editor', exact: true }).click();
  await page.getByRole('dialog', { name: 'Discard unsaved changes?' }).getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(page.locator('.editor')).toHaveCount(0);
});

test('a pending rate lookup never blocks a manual rate or the next expense', async ({ page }) => {
  let release!: () => void, requested!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const rateRequested = new Promise<void>(resolve => { requested = resolve; });
  const posted = await fixtures(page, { holdRate: () => { requested(); return released; } });
  await openNew(page);
  await page.getByRole('textbox', { name: 'Expense name', exact: true }).fill('Museum');
  await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('20');
  await page.getByRole('combobox', { name: 'Original currency' }).selectOption('EUR');
  await rateRequested;
  await page.locator('.manual-rate summary').click();
  await page.getByRole('spinbutton', { name: /1 EUR in GBP/ }).fill('0.85');
  await expect(page.getByRole('button', { name: 'Save expense', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Close editor', exact: true }).click();
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await page.getByRole('button', { name: 'Add expense', exact: true }).click();
  await page.getByRole('textbox', { name: 'Expense name', exact: true }).fill('Taxi');
  await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('12');
  await expect(page.getByRole('button', { name: 'Save expense', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Save expense', exact: true }).click();
  await expect(page.locator('.editor')).toHaveCount(0);
  expect(posted.at(-1)!.data.trips[0].expenses[0].title).toBe('Taxi');
  release();
});

test('the checklist and Save agree, and a blocker focuses its field', async ({ page }) => {
  await fixtures(page);
  await openNew(page);
  await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('5');
  const save = page.getByRole('button', { name: 'Save expense', exact: true });
  await expect(save).toBeDisabled();
  const checklist = page.locator('.save-checklist');
  await expect(checklist).toContainText('Add an expense name');
  await expect(checklist).not.toContainText('Name 1 item');
  await checklist.getByRole('button', { name: /Add an expense name/ }).click();
  await expect(page.getByRole('textbox', { name: 'Expense name', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Split by item', exact: true }).click();
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  await page.getByRole('textbox', { name: 'Expense name', exact: true }).fill('Lunch');
  await expect(save).toBeDisabled();
  // The first line still follows the expense name; only the new line needs one.
  await expect(page.getByRole('textbox', { name: 'Item 1 name', exact: true })).toHaveValue('Lunch');
  await checklist.getByRole('button', { name: /Name 1 item/ }).click();
  await expect(page.getByRole('textbox', { name: 'Item 2 name', exact: true })).toBeFocused();
});

test('a focused field is never left behind the pinned footer', async ({ page }) => {
  await fixtures(page);
  await openNew(page);
  await page.getByRole('button', { name: 'Split by item', exact: true }).click();
  for (let index = 0; index < 3; index++) await page.getByRole('button', { name: 'Add item', exact: true }).click();
  const footerTop = async () => (await page.locator('.editor-footer').boundingBox())!.y;
  for (const field of ['Item 2 name', 'Item 2 total', 'Item 3 name', 'Item 3 total', 'Item 4 name', 'Item 4 total']) {
    await page.getByRole('textbox', { name: field, exact: true }).focus();
    await page.waitForTimeout(50);
    const box = (await page.getByRole('textbox', { name: field, exact: true }).boundingBox())!;
    expect(box.y + box.height, field).toBeLessThanOrEqual(await footerTop() + 1);
  }
});

test('tip, tax and discount stay one tap away until used', async ({ page }) => {
  await fixtures(page);
  await openNew(page);
  await expect(page.getByRole('textbox', { name: 'tip', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Tip, tax or discount', exact: true }).click();
  await page.getByRole('textbox', { name: 'tip', exact: true }).fill('2');
  await expect(page.getByRole('button', { name: 'Tip, tax or discount', exact: true })).toHaveCount(0);
});

test('purchase details open and close again', async ({ page }) => {
  await fixtures(page);
  await openNew(page);
  await expect(page.locator('.purchase-details-summary')).toContainText('Europe/Vienna');
  await page.locator('.purchase-details-summary').getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByLabel('Transaction time zone')).toHaveValue('Europe/Vienna');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('.purchase-details-summary')).toBeVisible();
});

test('an existing single-line expense reopens in the quick form', async ({ page }) => {
  await fixtures(page);
  await page.goto('/expenses', { waitUntil: 'domcontentloaded' });
  await page.locator('.expense-open').first().click();
  await expect(page.getByRole('heading', { name: 'Edit expense', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Amount', exact: true })).toHaveValue('4.00');
  await expect(page.locator('.receipt-view-switch')).toHaveCount(1);
});
