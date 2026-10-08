import { expect, test, type Page, type Locator } from '@playwright/test';

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

async function fixtures(page: Page, options: { holdRate?: () => Promise<void>; trip?: typeof trip } = {}) {
  const posted: Posted[] = [];
  let revision = 1;
  let current = structuredClone(options.trip ?? trip);
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/ledger' && route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Posted;
      posted.push(body);
      current = body.data.trips[0];
      return route.fulfill({ json: { data: body.data, revision: ++revision }, headers: { 'X-TripTab-Account': 'quick-owner' } });
    }
    if (path === '/api/receipt') return route.fulfill({ contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="900"><rect width="400" height="900" fill="white"/></svg>' });
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
  await expect(page.getByRole('textbox', { name: 'Expense name', exact: true })).toBeFocused();
}

// The split method opens in place under the people chips.
async function chooseSplit(page: Page, method: 'Equally' | 'By percentage' | 'By quantity' | 'By item') {
  const button = page.getByRole('button', { name: method, exact: true }).first();
  if (!await button.isVisible()) await page.locator('.split-method > summary').first().click();
  await button.click();
}

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test('a shared taxi needs a name, an amount and Save', async ({ page }) => {
  const posted = await fixtures(page);
  await openNew(page);
  const name = page.getByRole('textbox', { name: 'Expense name', exact: true });
  await expect(name).toBeFocused();
  await expect(page.locator('.editor .modalheading').getByRole('textbox', { name: 'Expense name', exact: true })).toHaveCount(1);
  expect((await name.boundingBox())!.y).toBeLessThan((await page.getByRole('textbox', { name: 'Amount', exact: true }).boundingBox())!.y);
  // Everything the common case needs is on the opening screen.
  for (const control of [name, page.getByRole('textbox', { name: 'Amount', exact: true }), page.getByRole('combobox', { name: 'Currency', exact: true }),
    page.getByRole('combobox', { name: 'Paid by' }), page.getByRole('button', { name: 'Sam', exact: true }), page.getByRole('button', { name: 'Save expense', exact: true })]) {
    await expect(control).toBeInViewport({ ratio: 1 });
  }
  await expect(page.locator('.receipt-view-switch')).toHaveCount(0);
  await expect(page.locator('.item')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: /Who bought what/ })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Save expense', exact: true })).toBeEnabled();
  await name.fill('Taxi');
  const amount = page.getByRole('textbox', { name: 'Amount', exact: true });
  await amount.pressSequentially('12,50');
  await expect(page.locator('.expense-shares')).toContainText('Gary £6.25 · Sam £6.25');
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
  await expect(page.locator('.expense-shares')).toContainText('Gary £30.00');
  // The last selected person cannot be removed.
  await page.getByRole('button', { name: 'Gary', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Gary', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await chooseSplit(page, 'By item');
  const itemName = page.getByRole('textbox', { name: 'Item 1 name', exact: true });
  await expect(itemName).toHaveValue('Groceries');
  await expect(itemName).toBeFocused();
  // A manual line with no language evidence has one name field, even on a holiday with a receipt-language hint.
  await expect(page.locator('.item').first().locator('.item-bilingual-names input')).toHaveCount(1);
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  // A new line starts with the previous line's people.
  const second = page.locator('.item').nth(1);
  await expect(second.getByRole('button', { name: 'Gary', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(second.getByRole('button', { name: 'Sam', exact: true })).toHaveAttribute('aria-pressed', 'false');
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
  await page.getByRole('combobox', { name: 'Currency', exact: true }).selectOption('EUR');
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

test('Save stays available to explain blockers, and a blocker focuses its field', async ({ page }) => {
  await fixtures(page);
  await openNew(page);
  await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('5');
  const save = page.getByRole('button', { name: 'Save expense', exact: true });
  await expect(save).toBeEnabled();
  await expect(page.locator('.save-checklist')).toHaveCount(0);
  await save.click();
  const checklist = page.locator('.save-checklist');
  await expect(checklist).toContainText('Add an expense name');
  await expect(checklist).not.toContainText('Name 1 item');
  await checklist.getByRole('button', { name: /Add an expense name/ }).click();
  const name = page.locator('.editor .modalheading').getByRole('textbox', { name: 'Expense name', exact: true });
  await expect(name).toBeFocused();
  await expect(name).toBeInViewport({ ratio: 1 });
  await chooseSplit(page, 'By item');
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  await page.getByRole('textbox', { name: 'Expense name', exact: true }).fill('Lunch');
  await expect(save).toBeEnabled();
  // The first line still follows the expense name; only the new line needs one.
  await expect(page.getByRole('textbox', { name: 'Item 1 name', exact: true })).toHaveValue('Lunch');
  await checklist.getByRole('button', { name: /Name 1 item/ }).click();
  await expect(page.getByRole('textbox', { name: 'Item 2 name', exact: true })).toBeFocused();
});

test('a focused field is never left behind the pinned footer', async ({ page }) => {
  await fixtures(page);
  await openNew(page);
  await chooseSplit(page, 'By item');
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
  await page.locator('.purchase-details-summary').getByRole('button', { name: 'Change' }).click();
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

// Unsaved-work detection must follow what the person changed, not which
// photo or draft the editor happens to point at.
const receiptExpense = {
  id: 'quick-receipt', title: 'Café Central', date: '2026-10-05', time: '13:42', timezone: 'Europe/Vienna',
  currency: 'GBP', payer: 'quick-gary', tax: 0, tip: 0, discount: 0, receiptId: 'quick-photo',
  items: [{ id: 'quick-melange', name: 'Melange', amount: 520, members: ['quick-gary', 'quick-sam'] }],
};

async function expectDiscardPrompt(page: Page) {
  await page.getByRole('button', { name: 'Close editor', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Discard unsaved changes?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page.locator('.editor')).toBeVisible();
}

test('removing a photo keeps earlier unsaved edits guarded', async ({ page }) => {
  await fixtures(page, { trip: { ...trip, expenses: [receiptExpense, ...trip.expenses] } });
  await page.goto('/expenses', { waitUntil: 'domcontentloaded' });
  await page.locator('.expense-open').first().click();
  await expect(page.getByRole('heading', { name: 'Edit expense', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Expense name', exact: true }).fill('Café Central, corrected');
  await page.locator('.expense-more-options > summary').click();
  await page.getByRole('button', { name: 'Remove receipt image' }).click();
  await page.getByRole('dialog', { name: 'Remove receipt image?' }).getByRole('button', { name: 'Remove image', exact: true }).click();
  await expectDiscardPrompt(page);
  await expect(page.getByRole('textbox', { name: 'Expense name', exact: true })).toHaveValue('Café Central, corrected');
});

test('removing a photo on its own counts as an unsaved change', async ({ page }) => {
  await fixtures(page, { trip: { ...trip, expenses: [receiptExpense, ...trip.expenses] } });
  await page.goto('/expenses', { waitUntil: 'domcontentloaded' });
  await page.locator('.expense-open').first().click();
  await page.locator('.expense-more-options > summary').click();
  await page.getByRole('button', { name: 'Remove receipt image' }).click();
  await page.getByRole('dialog', { name: 'Remove receipt image?' }).getByRole('button', { name: 'Remove image', exact: true }).click();
  await expectDiscardPrompt(page);
});

test('changing printed receipt evidence counts as an unsaved change', async ({ page }) => {
  const scanned = { ...trip, drafts: [{
    id: 'quick-draft', receiptId: 'quick-photo', title: 'Café Central', status: 'review', currency: 'EUR',
    date: '2026-10-05', time: '13:42', timezone: 'Europe/Vienna', payer: 'quick-gary', tax: 0, tip: 0, discount: 0,
    fieldSources: { title: 'receipt', currency: 'receipt', date: 'receipt', time: 'receipt' },
    items: [{ id: 'quick-melange', name: 'Melange', amount: 520, members: ['quick-gary'] }],
    receiptScan: { version: 1, printedTotal: 520, printedCurrency: 'EUR', status: 'matched', warnings: [] },
  }] };
  await fixtures(page, { trip: scanned as unknown as typeof trip });
  await page.goto('/expenses?receiptDraft=quick-draft&receiptTrip=quick-trip', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.editor')).toBeVisible();
  // Opening the receipt alone is not unsaved work.
  await page.getByRole('button', { name: 'Close editor', exact: true }).click();
  await expect(page.locator('.editor')).toHaveCount(0);
  await page.goto('/expenses?receiptDraft=quick-draft&receiptTrip=quick-trip', { waitUntil: 'domcontentloaded' });
  await page.getByText('Check or correct printed totals').click();
  await page.getByRole('textbox', { name: 'Printed grand total', exact: true }).fill('6.20');
  await expectDiscardPrompt(page);
});

test('clearing the only adjustment keeps its field open and focused', async ({ page }) => {
  const tipped = { ...trip, expenses: [{ ...trip.expenses[0], tip: 200 }] };
  await fixtures(page, { trip: tipped });
  await page.goto('/expenses', { waitUntil: 'domcontentloaded' });
  await page.locator('.expense-open').first().click();
  const tip = page.getByRole('textbox', { name: 'tip', exact: true });
  await expect(tip).toHaveValue('2.00');
  await tip.fill('');
  await expect(tip).toBeVisible();
  await expect(tip).toBeFocused();
  await tip.pressSequentially('1.50');
  await expect(tip).toHaveValue('1.50');
});

for (const mobile of [true, false]) test.describe(`cancel item splitting on ${mobile ? 'mobile' : 'desktop'}`, () => {
  // Focus moves scroll the editor; use reduced motion so later pointer actions
  // cannot race an in-progress smooth scroll in WebKit.
  test.use({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, hasTouch: mobile, isMobile: mobile, contextOptions: { reducedMotion: 'reduce' } });

  const activate = (control: Locator) => mobile ? control.tap() : control.press('Enter');

  const confirmUseOneAmount = async (page: Page) => {
    const dialog = page.getByRole('dialog', { name: 'Use one amount?' });
    await expect(dialog).toBeVisible();
    await activate(dialog.getByRole('button', { name: 'Use one amount', exact: true }));
    await expect(dialog).toHaveCount(0);
  };

  test('Use one amount returns to Amount and saves the same line', async ({ page }) => {
    const posted = await fixtures(page);
    await page.goto('/expenses', { waitUntil: 'domcontentloaded' });
    await page.locator('.expense-open').first().click();
    await page.getByRole('combobox', { name: 'Paid by' }).selectOption('quick-sam');
    await activate(page.getByRole('button', { name: 'Sam', exact: true }));
    await expect(page.getByRole('button', { name: 'Sam', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await activate(page.getByRole('button', { name: 'Tip, tax or discount', exact: true }));
    await page.getByRole('textbox', { name: 'tip', exact: true }).fill('2');
    await page.getByRole('textbox', { name: 'tax', exact: true }).fill('1');
    await page.getByRole('textbox', { name: 'discount', exact: true }).fill('0.50');
    await activate(page.locator('.split-method > summary'));
    await activate(page.getByRole('button', { name: 'By item', exact: true }));
    await page.getByRole('textbox', { name: 'Item 1 name', exact: true }).fill('Changed line name');
    const control = page.getByRole('button', { name: 'Use one amount', exact: true });
    await expect(page.getByRole('button', { name: 'Remove item 1', exact: true })).toBeDisabled();
    await expect(control).toBeEnabled();
    await control.scrollIntoViewIfNeeded();
    const box = (await control.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    if (mobile) await control.tap();
    else { await control.focus(); await control.press('Enter'); }
    const amount = page.getByRole('textbox', { name: 'Amount', exact: true });
    await expect(amount).toBeFocused();
    await expect(amount).toHaveValue('4.00');
    await expect(amount).toBeInViewport({ ratio: 1 });
    await expect(page.locator('.item')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Use one amount', exact: true })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'tip', exact: true })).toHaveValue('2.00');
    await expect(page.getByRole('combobox', { name: 'Paid by' })).toHaveValue('quick-sam');
    await activate(page.getByRole('button', { name: 'Save expense', exact: true }));
    await expect(page.locator('.editor')).toHaveCount(0);
    const saved = posted.at(-1)!.data.trips[0].expenses.find(expense => expense.id === 'quick-earlier')!;
    expect(saved).toMatchObject({ date: '2026-10-04', time: '09:00', timezone: 'Europe/Vienna', currency: 'GBP', payer: 'quick-sam', tax: 100, tip: 200, discount: 50 });
    expect(saved.items).toHaveLength(1);
    expect(saved.items[0]).toMatchObject({ id: 'quick-earlier-item', name: 'Earlier coffee', amount: 400, members: ['quick-gary'], fieldSources: { name: 'user' } });
  });

  test('percentage and quantity shares stay with the single amount through itemising and back', async ({ page }) => {
    const posted = await fixtures(page);
    await openNew(page);
    await page.getByRole('textbox', { name: 'Expense name', exact: true }).fill('Lunch');
    await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('20');
    // A custom split opens in place: the amount, currency and payer stay where they are.
    // Position within the scrolling dialog, independent of how far it has scrolled.
    const amountTop = () => page.getByRole('textbox', { name: 'Amount', exact: true }).evaluate(input => {
      const editor = input.closest('.editor')!;
      return input.getBoundingClientRect().top - editor.getBoundingClientRect().top + editor.scrollTop;
    });
    const before = await amountTop();
    await activate(page.locator('.split-method > summary'));
    await activate(page.getByRole('button', { name: 'By percentage', exact: true }));
    await page.getByRole('textbox', { name: 'Gary percentage for the expense', exact: true }).fill('75');
    await page.getByRole('textbox', { name: 'Sam percentage for the expense', exact: true }).fill('25');
    await expect(page.locator('.expense-shares')).toContainText('Gary £15.00 · Sam £5.00');
    expect(await amountTop()).toBe(before);
    await expect(page.getByRole('combobox', { name: 'Paid by' })).toBeVisible();
    await activate(page.getByRole('button', { name: 'By item', exact: true }));
    await expect(page.locator('.item')).toHaveCount(1);
    await expect(page.getByRole('textbox', { name: 'Gary percentage for item 1', exact: true })).toHaveValue('75');
    // Returning keeps the line's shares; nothing is lost, so nothing is asked.
    await activate(page.getByRole('button', { name: 'Use one amount', exact: true }));
    await expect(page.getByRole('dialog', { name: 'Use one amount?' })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Amount', exact: true })).toBeFocused();
    await expect(page.getByRole('textbox', { name: 'Gary percentage for the expense', exact: true })).toHaveValue('75');
    await activate(page.getByRole('button', { name: 'By quantity', exact: true }));
    await expect(page.getByRole('textbox', { name: 'Total units for the expense', exact: true })).toBeVisible();
    await activate(page.getByRole('button', { name: 'Equally', exact: true }));
    await expect(page.locator('.expense-shares')).toContainText('Gary £10.00 · Sam £10.00');
    await activate(page.getByRole('button', { name: 'Save expense', exact: true }));
    await expect(page.locator('.editor')).toHaveCount(0);
    const saved = posted.at(-1)!.data.trips[0].expenses[0];
    expect(saved.items[0]).toMatchObject({ name: 'Lunch', amount: 2000, members: ['quick-gary', 'quick-sam'] });
    for (const field of ['percentages', 'units', 'quantity', 'translations']) expect(saved.items[0]).not.toHaveProperty(field);
    expect(saved).not.toHaveProperty('percentages');
  });

  test('returning to one amount asks first only when whole-bill shares would be lost', async ({ page }) => {
    await fixtures(page);
    await openNew(page);
    await page.getByRole('textbox', { name: 'Expense name', exact: true }).fill('Lunch');
    await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('20');
    await activate(page.locator('.split-method > summary'));
    await activate(page.getByRole('button', { name: 'By item', exact: true }));
    await activate(page.getByRole('button', { name: 'Add item', exact: true }));
    await activate(page.getByRole('button', { name: 'Whole bill', exact: true }));
    await activate(page.getByRole('button', { name: 'Remove item 2', exact: true }));
    await activate(page.getByRole('button', { name: 'Use one amount', exact: true }));
    await activate(page.getByRole('dialog', { name: 'Use one amount?' }).getByRole('button', { name: 'Keep splitting', exact: true }));
    await expect(page.locator('.item')).toHaveCount(1);
    await activate(page.getByRole('button', { name: 'Use one amount', exact: true }));
    await confirmUseOneAmount(page);
    await expect(page.getByRole('textbox', { name: 'Amount', exact: true })).toBeFocused();
    await expect(page.locator('.expense-shares')).toContainText('Gary £10.00 · Sam £10.00');
  });

  test('a missing amount returns to a blocked quick form and nobody selected cannot collapse', async ({ page }) => {
    await fixtures(page);
    await openNew(page);
    await page.getByRole('textbox', { name: 'Expense name', exact: true }).fill('Lunch');
    await activate(page.locator('.split-method > summary'));
    await activate(page.getByRole('button', { name: 'By item', exact: true }));
    await page.getByRole('textbox', { name: 'Item 1 total', exact: true }).fill('');
    await activate(page.getByRole('button', { name: 'Gary', exact: true }));
    await activate(page.getByRole('button', { name: 'Sam', exact: true }));
    // Choosing nobody stays a save blocker; collapsing must not clear it by selecting everyone.
    await expect(page.getByRole('button', { name: 'Use one amount', exact: true })).toBeDisabled();
    await activate(page.getByRole('button', { name: 'Gary', exact: true }));
    await activate(page.getByRole('button', { name: 'Use one amount', exact: true }));
    await expect(page.getByRole('textbox', { name: 'Amount', exact: true })).toBeFocused();
    await expect(page.getByRole('textbox', { name: 'Amount', exact: true })).toHaveValue('');
    await page.getByRole('button', {name:'Save expense',exact:true}).click();
    await expect(page.locator('.save-checklist')).toContainText('Enter the amount');
    await expect(page.getByRole('button', { name: 'Save expense', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Gary', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Sam', exact: true })).toHaveAttribute('aria-pressed', 'false');
  });

  test('extra lines remove normally and only the remaining line can collapse', async ({ page }) => {
    const posted = await fixtures(page);
    await openNew(page);
    await page.getByRole('textbox', { name: 'Expense name', exact: true }).fill('Groceries');
    await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('30');
    await activate(page.locator('.split-method > summary'));
    await activate(page.getByRole('button', { name: 'By item', exact: true }));
    await activate(page.getByRole('button', { name: 'Add item', exact: true }));
    await page.getByRole('textbox', { name: 'Item 2 name', exact: true }).fill('Wine');
    await page.getByRole('textbox', { name: 'Item 2 total', exact: true }).fill('10');
    await expect(page.getByRole('button', { name: 'Use one amount', exact: true })).toHaveCount(0);
    await activate(page.getByRole('button', { name: 'Remove item 1', exact: true }));
    await expect(page.locator('.item')).toHaveCount(1);
    await expect(page.getByRole('textbox', { name: 'Item 1 total', exact: true })).toHaveValue('10.00');
    await expect(page.getByRole('button', { name: 'Remove item 1', exact: true })).toBeDisabled();
    await activate(page.getByRole('button', { name: 'Use one amount', exact: true }));
    await expect(page.getByRole('textbox', { name: 'Amount', exact: true })).toHaveValue('10.00');
    await activate(page.getByRole('button', { name: 'Save expense', exact: true }));
    await expect(page.locator('.editor')).toHaveCount(0);
    expect(posted.at(-1)!.data.trips[0].expenses[0].items).toMatchObject([{ name: 'Groceries', amount: 1000 }]);
  });

  for (const kind of ['photo', 'scan', 'draft']) test(`a ${kind} line uses the single amount without renaming what was read`, async ({ page }) => {
    const receiptScan = { version: 1, printedTotal: 520, printedCurrency: 'GBP', status: 'matched', warnings: [] };
    const protectedTrip = kind === 'draft'
      ? { ...trip, drafts: [{ ...receiptExpense, id: 'protected-draft', receiptId: undefined, status: 'review' }] }
      : { ...trip, expenses: [{ ...receiptExpense, receiptId: kind === 'photo' ? 'quick-photo' : undefined, receiptScan: kind === 'scan' ? receiptScan : undefined }] };
    const posted = await fixtures(page, { trip: protectedTrip as unknown as typeof trip });
    await page.goto(kind === 'draft' ? '/expenses?receiptDraft=protected-draft&receiptTrip=quick-trip' : '/expenses', { waitUntil: 'domcontentloaded' });
    if (kind !== 'draft') await page.locator('.expense-open').first().click();
    await expect(page.locator('.editor')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Amount', exact: true })).toHaveValue('5.20');
    await expect(page.getByRole('textbox', { name: 'Item 1 name', exact: true })).toHaveValue('Melange');
    await expect(page.locator('.item')).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Expense name', exact: true }).fill('Coffee break');
    await expect(page.getByRole('textbox', { name: 'Item 1 name', exact: true })).toHaveValue('Melange');
    await activate(page.locator('.split-method > summary'));
    await activate(page.getByRole('button', { name: 'By item', exact: true }));
    await expect(page.getByRole('button', { name: 'Remove item 1', exact: true })).toBeDisabled();
    await activate(page.getByRole('button', { name: 'Use one amount', exact: true }));
    await expect(page.getByRole('dialog', { name: 'Use one amount?' })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Item 1 name', exact: true })).toHaveValue('Melange');
    await activate(page.getByRole('button', { name: 'Save expense', exact: true }));
    await expect(page.locator('.editor')).toHaveCount(0);
    const saved = posted.at(-1)!.data.trips[0].expenses[0];
    expect(saved).toMatchObject({ title: 'Coffee break' });
    expect(saved.items).toMatchObject([{ id: 'quick-melange', name: 'Melange', amount: 520 }]);
  });
});

test('the header tab order is icon, name, close, then body', async ({ page, browserName }) => {
  // macOS WebKit uses Option-Tab to include buttons in keyboard navigation.
  const tab = browserName === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab';
  const backTab = browserName === 'webkit' && process.platform === 'darwin' ? 'Alt+Shift+Tab' : 'Shift+Tab';
  await fixtures(page);
  await openNew(page);
  const header = page.locator('.editor .modalheading');
  const name = header.getByRole('textbox', { name: 'Expense name', exact: true });
  await expect(name).toBeFocused();
  await page.keyboard.press(backTab);
  await expect(header.getByRole('button', { name: /Choose icon for/ })).toBeFocused();
  await page.keyboard.press(tab);
  await expect(name).toBeFocused();
  await page.keyboard.press(tab);
  await expect(header.getByRole('button', { name: 'Close editor', exact: true })).toBeFocused();
  // Purchase opens with the receipt option, before the amount it would fill.
  await page.keyboard.press(tab);
  await expect(page.locator('.receipt-capture--compact summary')).toBeFocused();
  for (let index = 0; index < 4 && !await page.getByRole('textbox', { name: 'Amount', exact: true }).evaluate(element => element === document.activeElement); index++) await page.keyboard.press(tab);
  await expect(page.getByRole('textbox', { name: 'Amount', exact: true })).toBeFocused();
});

test('the header icon changes the badge, guards unsaved work and saves the choice', async ({ page }) => {
  const posted = await fixtures(page);
  await openNew(page);
  const icon = page.locator('.editor .modalheading .expense-icon-trigger');
  await expect(icon).toHaveAttribute('aria-label', /Automatic:/);
  await icon.tap();
  const picker = page.getByRole('dialog', { name: 'Choose an icon', exact: true });
  await expect(picker).toBeVisible();
  await picker.getByRole('textbox', { name: 'Search symbols', exact: true }).fill('Coffee');
  await picker.getByRole('button', { name: 'Coffee', exact: true }).click();
  await picker.getByRole('button', { name: 'Blue background', exact: true }).click();
  await picker.getByRole('button', { name: 'Use icon', exact: true }).click();
  await expect(picker).toHaveCount(0);
  await expect(icon).toHaveAttribute('aria-label', /Selected: Coffee/);
  await expect(icon.locator('svg')).toHaveClass(/lucide-coffee/);
  await expect(icon.locator('.expense-symbol')).toHaveCSS('background-color', 'rgb(37, 99, 235)');
  await expect(page.locator('.editor .expense-icon-trigger')).toHaveCount(1);
  await expectDiscardPrompt(page);
  await page.getByRole('textbox', { name: 'Expense name', exact: true }).fill('Coffee');
  await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('5');
  await page.getByRole('button', { name: 'Save expense', exact: true }).click();
  await expect(page.locator('.editor')).toHaveCount(0);
  expect(posted.at(-1)!.data.trips[0].expenses[0]).toMatchObject({ icon: { symbol: 'Coffee', background: 'blue' } });
});

test('a processed receipt focuses QuickSplit and keeps its name above both views', async ({ page }) => {
  const scanned = { ...trip, drafts: [{
    id: 'quick-draft', receiptId: 'quick-photo', title: 'Café Central', status: 'review', currency: 'GBP',
    date: '2026-10-05', time: '13:42', timezone: 'Europe/Vienna', payer: 'quick-gary', tax: 0, tip: 0, discount: 0,
    fieldSources: { title: 'default' },
    items: [{ id: 'quick-melange', name: 'Melange', amount: 520, members: [] }],
    receiptScan: { version: 1, printedTotal: 520, printedCurrency: 'GBP', status: 'matched', warnings: [] },
  }] };
  await fixtures(page, { trip: scanned as unknown as typeof trip });
  await page.goto('/expenses?receiptDraft=quick-draft&receiptTrip=quick-trip', { waitUntil: 'domcontentloaded' });
  const name = page.locator('.editor .modalheading').getByRole('textbox', { name: 'Expense name', exact: true });
  await expect(page.getByRole('button', { name: 'Share the remaining item equally', exact: true })).toBeFocused();
  await expect(name).not.toBeFocused();
  await expect(name).not.toHaveAttribute('autofocus');
  const suggestion = page.locator('.expense-title-suggestion');
  await expect(suggestion).toHaveText('Suggested name. Receipt reading may replace it; editing confirms your choice.');
  expect((await suggestion.boundingBox())!.y).toBeGreaterThan((await name.boundingBox())!.y);
  expect((await suggestion.boundingBox())!.y).toBeLessThan((await page.locator('.expense-step').first().boundingBox())!.y);
  await page.getByRole('button', { name: 'Receipt history', exact: true }).click();
  await expect(name).toBeVisible();
  await expect(page.locator('.editor .modalheading .expense-icon-trigger')).toBeVisible();
  await page.getByRole('button', { name: 'Back to details & split', exact: true }).click();
  await page.getByRole('button', { name: 'Share the remaining item equally', exact: true }).click();
  // The bulk action is gone once used; focus stays at the step it completed.
  await expect(page.getByRole('heading', { name: 'Split', exact: true })).toBeFocused();
  await name.fill('Melange at Café Central');
  await expect(suggestion).toHaveCount(0);
  await expect(page.locator('.expense-shares')).toContainText('Gary £2.60 · Sam £2.60');
  // The footer's blocker must return to the header from deep inside a receipt.
  await name.fill('');
  await page.locator('.editor').evaluate(editor => { editor.scrollTop = editor.scrollHeight; });
  await page.locator('.save-checklist').getByRole('button', { name: /Add an expense name/ }).click();
  await expect(name).toBeFocused();
  await expect(name).toBeInViewport({ ratio: 1 });
});

test.describe('split mode focus timing', () => {
  test.use({viewport:{width:1440,height:900},hasTouch:false,isMobile:false});
  test('delayed callbacks cannot turn the next split-button Enter into an expense save', async ({page}) => {
    const posted=await fixtures(page); await openNew(page);
    await page.getByRole('textbox',{name:'Expense name',exact:true}).fill('Lunch');
    await page.getByRole('textbox',{name:'Amount',exact:true}).fill('20');
    await chooseSplit(page,'By percentage');
    await page.getByRole('textbox',{name:'Gary percentage for the expense',exact:true}).fill('75');
    await page.getByRole('textbox',{name:'Sam percentage for the expense',exact:true}).fill('25');
    await page.getByRole('button',{name:'By item',exact:true}).click();
    await expect(page.getByRole('textbox',{name:'Item 1 name',exact:true})).toBeFocused();
    // Hold zero-delay callbacks to reproduce CI's pause between DOM commit and the next keypress.
    await page.evaluate(()=>{
      const original=window.setTimeout.bind(window), pending:{id:number;run:()=>void}[]=[];
      window.setTimeout=((handler:TimerHandler,delay=0,...args:unknown[])=>{
        if(delay===0 && typeof handler==='function') {
          const id=original(()=>{},60_000);
          pending.push({id,run:()=>Reflect.apply(handler,window,args)}); return id;
        }
        return original(handler,delay,...args);
      }) as typeof window.setTimeout;
      Object.defineProperty(window,'__releaseModeTimers',{value:()=>{
        window.setTimeout=original;
        for(const timer of pending.splice(0)) {clearTimeout(timer.id);timer.run();}
      }});
    });
    await page.getByRole('button',{name:'Use one amount',exact:true}).click();
    await expect(page.getByRole('textbox',{name:'Amount',exact:true})).toBeFocused();
    await expect(page.locator('.expense-shares')).toContainText('Gary £15.00 · Sam £5.00');
    await page.getByRole('button',{name:'By item',exact:true}).focus();
    await page.evaluate(()=>(window as unknown as {__releaseModeTimers:()=>void}).__releaseModeTimers());
    await page.keyboard.press('Enter');
    await expect(page.getByRole('textbox',{name:'Item 1 name',exact:true})).toBeFocused();
    await expect(page.getByRole('button',{name:'By quantity',exact:true})).toBeVisible();
    expect(posted).toHaveLength(0); await expect(page.locator('.saved-banner')).toHaveCount(0);
  });
});
