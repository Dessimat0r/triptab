import { expect, test, type Page } from '@playwright/test';

const memberName = 'Alexandria'.repeat(5);
const originalName = 'Gedruckte Artikelbeschreibung '.repeat(6);
const translatedName = 'An English receipt item description '.repeat(5);
const trip = {
  id: 'layout-trip', ownerId: 'layout-owner', name: 'Layout fixture', currency: 'GBP', receiptLanguage: 'de',
  members: [{ id: 'layout-alex', name: memberName, userId: 'layout-owner' }, { id: 'layout-sam', name: 'Sam' }],
  expenses: [{
    id: 'layout-expense', title: 'Dinner by the harbour', date: '2026-10-05', time: '20:00', timezone: 'America/Argentina/Buenos_Aires',
    currency: 'EUR', payer: 'layout-alex', tax: 0, tip: 0, discount: 0,
    items: [
      { id: 'layout-expense-item', name: originalName, amount: 1250, members: ['layout-alex', 'layout-sam'] },
      { id: 'layout-expense-wine', name: 'Wein', amount: 2000, members: ['layout-alex'] },
    ],
  }], payments: [], drafts: [{
    id: 'layout-draft', receiptId: 'layout-photo', title: 'Receipt fixture', status: 'review',
    currency: 'EUR', date: '2026-10-05', time: '23:59', timezone: 'America/Argentina/Buenos_Aires',
    payer: 'layout-alex', tax: 0, tip: 0, discount: 0, detectedLanguage: 'de',
    items: [
      { id: 'layout-item', name: originalName, nameLanguage: 'de', amount: 1250, members: ['layout-alex', 'layout-sam'],
        translations: { en: { text: translatedName, sourceText: originalName, pairedText: translatedName, sourceLanguage: 'de', provenance: 'ai' } } },
      { id: 'layout-untranslated', name: originalName, nameLanguage: 'de', amount: 1250, members: ['layout-alex', 'layout-sam'] },
    ],
  }],
};

async function fixtures(page: Page) {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/receipt') return route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="900"><rect width="4000" height="900" fill="white"/></svg>',
    });
    const json = path === '/api/ledger' ? { data: { trips: [trip] }, revision: 1 }
      : path === '/api/profile' ? { id: 'layout-owner', displayName: 'Alex', email: 'layout@example.invalid', authMethod: 'password' }
      : path === '/api/trip-language' ? { accountId: 'layout-owner', tripId: 'layout-trip', revision: 1,
        preferences: { readingLanguage: 'en', primaryVersion: 'reading', itemVersions: {} } }
      : path === '/api/receipt/ai-status' ? { configured: false, connected: false, provider: 'api', eligible: false, manageable: false, siwcAvailable: false }
      : { events: [], notifications: [], items: [] };
    return route.fulfill({ json, headers: path === '/api/ledger' ? { 'X-TripTab-Account': 'layout-owner' } : {} });
  });
}

async function fits(page: Page) {
  const result = await page.locator('.editor').evaluate(editor => {
    const body = editor.querySelector<HTMLElement>('.editor-body')!;
    const bounds = body.getBoundingClientRect();
    const dialogBounds = editor.getBoundingClientRect();
    const overlay = editor.closest('.editor-overlay')!;
    const containers = [overlay, editor, body];
    const fields = Array.from(editor.querySelectorAll<HTMLElement>('.item-top input, .item-top select'))
      .filter(element => element.getClientRects().length);
    const itemRows = Array.from(editor.querySelectorAll<HTMLElement>('.item-top')).map(row =>
      new Set(Array.from(row.querySelectorAll<HTMLElement>('input, select'))
        .filter(element => element.getClientRects().length && fields.includes(element))
        .map(element => Math.round(element.getBoundingClientRect().right))).size);
    const outside = Array.from(body.querySelectorAll<HTMLElement>('input, select, textarea, button, img')).filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1);
    }).map(element => element.getAttribute('aria-label') || element.tagName);
    return {
      outside,
      overflow: body.scrollWidth - body.clientWidth,
      dialogOverflow: editor.scrollWidth - editor.clientWidth,
      width: dialogBounds.width,
      left: dialogBounds.left,
      right: dialogBounds.right,
      viewport: innerWidth,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      overlayScroll: overlay.scrollHeight - overlay.clientHeight,
      overlayScrollX: overlay.scrollWidth - overlay.clientWidth,
      itemRows,
      clipping: containers.map(element => getComputedStyle(element).overflowX),
      swipePolicy: containers.map(element => getComputedStyle(element).overscrollBehaviorX),
    };
  });
  expect(result.outside).toEqual([]);
  expect(result.overflow).toBeLessThanOrEqual(1);
  expect(result.dialogOverflow).toBeLessThanOrEqual(1);
  expect(result.width).toBeLessThanOrEqual(1060);
  expect(result.left).toBeGreaterThanOrEqual(-1);
  expect(result.right).toBeLessThanOrEqual(result.viewport + 1);
  expect(result.pageOverflow).toBeLessThanOrEqual(1);
  // Hidden labels must not stretch the overlay into blank space below the dialog.
  expect(result.overlayScroll).toBeLessThanOrEqual(1);
  expect(result.overlayScrollX).toBeLessThanOrEqual(1);
  // Each item's name, display and amount fields share one right edge on phones.
  if (result.viewport <= 480) for (const edges of result.itemRows) expect(edges).toBe(1);
  for (const overflow of result.clipping) expect(overflow).not.toMatch(/hidden|clip/);
  expect(result.swipePolicy).toEqual(['auto', 'auto', 'auto']);
}

const viewports = [
  { width: 320, height: 740, touch: true },
  { width: 390, height: 844, touch: true },
  { width: 480, height: 844, touch: false },
  { width: 481, height: 844, touch: false },
  { width: 768, height: 1024, touch: true },
  { width: 844, height: 390, touch: true },
  { width: 1024, height: 768, touch: false },
  { width: 1440, height: 900, touch: false },
];

for (const { width, height, touch } of viewports) {
  test.describe(`${width}×${height}${touch ? ' touch' : ''}`, () => {
    test.use({ viewport: { width, height }, hasTouch: touch, isMobile: touch });
    for (const mode of ['manual', 'edit', 'receipt'] as const) {
      const receipt = mode === 'receipt';
      test(`${receipt ? 'receipt' : mode === 'edit' ? 'edited expense' : 'manual expense'} fits without clipping`, async ({ page }) => {
        await fixtures(page);
        await page.goto(receipt ? '/expenses?receiptDraft=layout-draft&receiptTrip=layout-trip' : '/expenses');
        if (mode === 'manual') await page.getByRole('button', { name: 'Add expense', exact: true }).click();
        if (mode === 'edit') {
          await page.locator('.expense-open').first().click();
          await expect(page.getByRole('heading', { name: 'Edit expense', exact: true })).toBeVisible();
        }
        await expect(page.locator('.editor')).toBeVisible();
        await expect(page.getByRole('combobox', { name: 'Show first for item 1', exact: true })).toBeEnabled();
        if (receipt) {
          await expect(page.getByRole('textbox', { name: 'Item 1 English name', exact: true })).toHaveValue(translatedName);
          await expect(page.getByRole('button', { name: 'Translate item 2 English name', exact: true })).toBeEnabled();
        }
        await fits(page);
        if (touch) {
          expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(true);
          const smallControls = await page.locator('.editor input, .editor select, .editor textarea').evaluateAll(elements =>
            elements.filter(element => element.getClientRects().length && parseFloat(getComputedStyle(element).fontSize) < 16).length);
          expect(smallControls).toBe(0);
        }
        await page.getByRole('button', { name: 'One person', exact: true }).first().click();
        await fits(page);
        await page.getByRole('button', { name: 'Custom percentages', exact: true }).first().click();
        await fits(page);
        await page.getByRole('button', { name: 'Units', exact: true }).first().click();
        await fits(page);
        await page.locator('.receipt-split > label > select').selectOption('receipt');
        await fits(page);
        await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
        await fits(page);
      });
    }
  });
}

test.describe('320px amount field', () => {
  test.use({ viewport: { width: 320, height: 740 }, hasTouch: true, isMobile: true });
  test('shows the maximum supported amount without internal clipping', async ({ page }) => {
    await fixtures(page);
    await page.goto('/expenses');
    await page.getByRole('button', { name: 'Add expense', exact: true }).click();
    const amount = page.getByRole('textbox', { name: 'Item 1 total', exact: true });
    await amount.fill('1000000.00');
    await amount.blur();
    await expect(amount).toHaveValue('1000000.00');
    const sizes = await amount.evaluate(input => {
      const style = getComputedStyle(input);
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d')!;
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      return {
        available: input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        required: context.measureText((input as HTMLInputElement).value).width,
      };
    });
    expect(sizes.available).toBeGreaterThanOrEqual(sizes.required);
    await fits(page);
  });
});

test.describe('landscape payment', () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
  test('uses readable controls without focus zoom-sized text', async ({ page }) => {
    await fixtures(page);
    await page.goto('/balances');
    await page.getByRole('button', { name: 'Record payment', exact: true }).click();
    const smallControls = await page.locator('.payment-editor input, .payment-editor select, .payment-editor textarea').evaluateAll(elements =>
      elements.filter(element => element.getClientRects().length && parseFloat(getComputedStyle(element).fontSize) < 16).length);
    expect(smallControls).toBe(0);
  });
});
