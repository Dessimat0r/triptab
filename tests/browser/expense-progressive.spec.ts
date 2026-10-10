import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

// One editor layout for every route: 1 Purchase, 2 Split, 3 Check & save.
// The fixture matches docs/audit/expense-progressive-audit-2026-10-08.md:
// four travellers, a GBP holiday and a seven-line EUR restaurant receipt.
const photo = path.resolve('tests/fixtures/receipts/v1/images/long-receipt.png');
const members = [
  { id: 'gary', name: 'Gary', userId: 'owner' }, { id: 'sam', name: 'Sam' },
  { id: 'priya', name: 'Priya' }, { id: 'tom', name: 'Tom' },
];
const lines = [
  ['i1', 'Bacalhau à Brás', 1650], ['i2', 'Polvo grelhado', 1890], ['i3', 'Arroz de marisco', 3200], ['i4', 'Vinho verde', 2200],
  ['i5', 'Água com gás', 450], ['i6', 'Pastel de nata', 600], ['i7', 'Café', 400],
] as const;
const draft = {
  id: 'audit-draft', receiptId: 'photo', title: 'Taberna da Rua', status: 'review', source: 'ai',
  date: '2026-10-07', time: '21:14', timezone: 'Europe/Lisbon', currency: 'EUR', payer: 'gary',
  tax: 0, tip: 600, discount: 0, detectedLanguage: 'pt',
  fieldSources: { title: 'ai', date: 'ai', time: 'ai', timezone: 'ai', currency: 'ai', tip: 'ai' },
  items: lines.map(([id, name, amount]) => ({ id, name, nameLanguage: 'pt', amount, members: [],
    scanSource: { observedText: name.toUpperCase(), confidence: id === 'i5' ? 'low' : 'high' } })),
  receiptScan: { version: 1, printedCurrency: 'EUR', printedTotal: 11030, status: 'needs-review', warnings: [{ code: 'low-confidence', itemId: 'i5' }] },
};
const trip = { id: 'audit-trip', ownerId: 'owner', name: 'Lisbon', currency: 'GBP', receiptLanguage: 'pt', members, expenses: [], payments: [], drafts: [draft] };

async function fixtures(page: Page, options: { ai?: boolean } = {}) {
  const ai = options.ai ?? true;
  await page.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (pathname === '/api/receipt' && request.method() === 'GET') return route.fulfill({ contentType: 'image/png', path: photo });
    if (pathname === '/api/fx') return route.fulfill({ json: { rate: 0.8612, asOf: '2026-10-07' } });
    if (pathname === '/api/ledger' && request.method() === 'POST') return route.fulfill({ status: 409, json: { error: 'fixture' } });
    const json = pathname === '/api/ledger' ? { data: { trips: [trip] }, revision: 1 }
      : pathname === '/api/profile' ? { id: 'owner', displayName: 'Gary', email: 'gary@example.invalid', authMethod: 'password' }
      : pathname === '/api/receipt/ai-status' ? { configured: ai, connected: ai, provider: 'api', eligible: ai, manageable: false, siwcAvailable: false }
      : pathname === '/api/trip-language' ? { accountId: 'owner', tripId: trip.id, revision: 1, preferences: { readingLanguage: 'en', primaryVersion: 'reading', itemVersions: {} } }
      : { events: [], notifications: [], items: [] };
    return route.fulfill({ json, headers: pathname === '/api/ledger' ? { 'X-TripTab-Account': 'owner' } : {} });
  });
}
async function openReceipt(page: Page) {
  await page.goto('/expenses?receiptDraft=audit-draft&receiptTrip=audit-trip', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.editor')).toBeVisible();
  await expect(page.locator('.rate-result')).toContainText('Daily reference rate');
}
async function openNew(page: Page) {
  await page.goto('/expenses', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Add expense', exact: true }).click();
  await expect(page.locator('.editor')).toBeVisible();
}
const steps = (page: Page) => page.locator('.expense-step-title').allInnerTexts();
async function purchaseHasPayerAndCurrency(page: Page) {
  const purchase = page.locator('.expense-step').first();
  await expect(purchase.getByRole('combobox', { name: 'Paid by' })).toBeVisible();
  await expect(purchase.getByRole('combobox', { name: 'Currency', exact: true })).toBeVisible();
}

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test('every route shows Purchase, Split and Check & save in that order, with payer and currency in Purchase', async ({ page }) => {
  await fixtures(page);
  await openNew(page);
  expect((await steps(page)).map(text => text.replace(/\s+/g, ' ').trim())).toEqual(['1 Purchase', '2 Split', '3 Check & save']);
  await purchaseHasPayerAndCurrency(page);
  await page.getByRole('textbox', { name: 'Expense name', exact: true }).fill('Dinner');
  await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('84');
  await page.getByRole('combobox', { name: 'Currency', exact: true }).selectOption('EUR');
  await expect(page.locator('.rate-result')).toContainText('≈ £72.34');
  await page.locator('.split-method > summary').click();
  await page.getByRole('button', { name: 'By percentage', exact: true }).click();
  await purchaseHasPayerAndCurrency(page);
  await page.getByRole('button', { name: 'By item', exact: true }).click();
  await expect(page.locator('.item')).toHaveCount(1);
  await purchaseHasPayerAndCurrency(page);
  expect(await steps(page)).toHaveLength(3);
  await page.getByRole('button', { name: 'Close editor', exact: true }).click();
  await page.getByRole('dialog', { name: 'Discard unsaved changes?' }).getByRole('button', { name: 'Discard changes', exact: true }).click();
  await openReceipt(page);
  await purchaseHasPayerAndCurrency(page);
  expect(await steps(page)).toHaveLength(3);
});

test('a seven-line receipt opens at the top with one compact row per line and each fact said once', async ({ page }) => {
  await fixtures(page);
  await openReceipt(page);
  const share = page.getByRole('button', { name: 'Share 7 remaining items equally', exact: true });
  await expect(share).toBeFocused();
  expect(await page.locator('.editor').evaluate(editor => editor.scrollTop)).toBe(0);
  const footerTop = (await page.locator('.editor-footer').boundingBox())!.y;
  const shareBox = (await share.boundingBox())!;
  expect(shareBox.y + shareBox.height).toBeLessThanOrEqual(footerTop);
  const rows = page.locator('.item');
  await expect(rows).toHaveCount(7);
  for (const box of await rows.evaluateAll(items => items.map(item => item.getBoundingClientRect().height))) expect(box).toBeLessThanOrEqual(120);
  await expect(rows.nth(4)).toContainText('Check');
  // Nobody is on any line yet: the bulk choice and the checklist say so; the lines do not repeat it.
  await expect(page.locator('.items')).not.toContainText(/Unassigned|at least one person|0% \/ 100%|needs people/);
  await expect(page.locator('.receipt-scan-review')).not.toContainText(/need people|owes this item/);
  await expect(page.getByRole('button', { name: 'View receipt photo', exact: true })).toHaveCount(1);
  // The converted total shows before anyone is assigned, read at a readable precision.
  await expect(page.locator('.rate-result')).toContainText('≈ £94.65');
  await expect(page.locator('.rate-result')).toContainText('1 EUR = 0.8612 GBP');
  await expect(page.locator('.editor')).not.toContainText(/Outside the supported amount range|0\.86120000|Look up historical rate/);
  await share.click();
  // The bulk action disappears once used; focus stays at the step it completed.
  await expect(page.getByRole('heading', { name: 'Split', exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  await expect(page.locator('.expense-shares')).toContainText('Gary £23.66');
  // A line opens to edit and closes again.
  await rows.first().locator('.item-edit > summary').click();
  await expect(page.getByRole('textbox', { name: 'Item 1 total', exact: true })).toHaveValue('16.50');
  await rows.first().locator('.item-edit > summary').click();
  await expect(page.getByRole('textbox', { name: 'Item 1 total', exact: true })).toBeHidden();
});

test('a line to check is reached from Check & save and opens itself', async ({ page }) => {
  await fixtures(page);
  await openReceipt(page);
  await page.getByRole('region', { name: 'Confirm when saving' }).getByRole('button', { name: 'Check Água com gás', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Item 5 name', exact: true })).toBeFocused();
  await expect(page.locator('.item').nth(4)).toHaveClass(/item--open/);
});

test('a typed expense without receipt AI offers no receipt conversation or language', async ({ page }) => {
  await fixtures(page, { ai: false });
  await openNew(page);
  await page.getByRole('textbox', { name: 'Expense name', exact: true }).fill('Groceries');
  await page.locator('.split-method > summary').click();
  await page.getByRole('button', { name: 'By item', exact: true }).click();
  await expect(page.locator('.editor')).not.toContainText('Discuss');
  await expect(page.locator('.expense-more-options > summary')).toHaveText(/More options\s*import/);
  await page.locator('.expense-more-options > summary').click();
  await expect(page.getByRole('combobox', { name: /Receipt language/ })).toHaveCount(0);
});

test('the inbox and the editor offer the same capture actions and wording', async ({ page }) => {
  await fixtures(page);
  await openNew(page);
  const capture = page.locator('.receipt-capture--compact');
  for (const label of ['Scan receipt', 'Choose image']) await expect(capture.getByText(label, { exact: true })).toBeVisible();
  await expect(capture).toContainText('camera metadata is removed');
  await page.getByRole('button', { name: 'Close editor', exact: true }).click();
  await page.goto('/receipts', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Add receipt', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a receipt' });
  for (const label of ['Scan receipt', 'Choose image']) await expect(dialog.getByText(label, { exact: true })).toBeVisible();
  await expect(dialog).toContainText('camera metadata is removed');
  await expect(dialog).not.toContainText('Take photo');
});

test.describe('wide screens', () => {
  test.use({ viewport: { width: 1440, height: 900 }, hasTouch: false, isMobile: false });
  test('the photo fills the left column and a form without one stays narrow', async ({ page }) => {
    await fixtures(page);
    await openReceipt(page);
    await expect(page.locator('.receipt-photo-column')).toBeVisible();
    await expect(page.locator('.receipt-photo-thumbnail')).toBeHidden();
    expect((await page.locator('.receipt-photo-panel img').boundingBox())!.width).toBeGreaterThanOrEqual(340);
    await expect(page.getByRole('button', { name: 'View receipt photo', exact: true })).toHaveCount(1);
    // The next correction shares the footer row with Total and Save.
    const footer = await page.locator('.editor-footer').boundingBox();
    expect(footer!.height).toBeLessThanOrEqual(100);
    expect(await page.locator('.editor').evaluate(editor => editor.scrollTop)).toBe(0);
    await openNew(page);
    expect((await page.locator('.editor').boundingBox())!.width).toBeLessThanOrEqual(680);
  });
});

test.describe('dark mode', () => {
  test.use({ colorScheme: 'dark' });
  test('receipt borders come from the theme, not a light fallback', async ({ page }) => {
    await fixtures(page);
    await openReceipt(page);
    const light = await page.locator('.editor').evaluate(editor => Array.from(editor.querySelectorAll('*'))
      .filter(element => ['Top', 'Right', 'Bottom', 'Left'].some(side => getComputedStyle(element)[`border${side}Color` as 'borderTopColor'] === 'rgb(208, 215, 222)'
        && parseFloat(getComputedStyle(element)[`border${side}Width` as 'borderTopWidth']) > 0))
      .map(element => element.className));
    expect(light).toEqual([]);
  });
});
