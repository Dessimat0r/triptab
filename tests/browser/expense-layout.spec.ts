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

async function fixtures(page: Page, ledger: () => unknown = () => trip) {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/ledger' && route.request().method() === 'POST') return route.fulfill({ status: 409, json: { error: 'Revision changed' } });
    if (path === '/api/receipt') return route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="900"><rect width="4000" height="900" fill="white"/></svg>',
    });
    const json = path === '/api/ledger' ? { data: { trips: [ledger()] }, revision: 1 }
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
      // Only one of the overlay, dialog and body may scroll vertically.
      scrollers: [overlay, editor, body].filter(element =>
        /auto|scroll/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight + 1).length,
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
  expect(result.scrollers).toBeLessThanOrEqual(1);
  expect(result.overlayScrollX).toBeLessThanOrEqual(1);
  // Each item's name, display and amount fields share one right edge on phones.
  if (result.viewport <= 480) for (const edges of result.itemRows) expect(edges).toBe(1);
  // The overlay and dialog never pan sideways; the body itself never clips, and
  // the bounds checks above prove no control relies on that clipping.
  expect(result.clipping.slice(0, 2)).toEqual(['hidden', 'hidden']);
  expect(result.clipping[2]).not.toMatch(/hidden|clip/);
  expect(result.swipePolicy).toEqual(['auto', 'auto', 'auto']);
}

async function hasComfortableMobileItemSpacing(page: Page) {
  const gaps = await page.locator('.item').first().evaluate(item => {
    const controls = Array.from(item.querySelectorAll<HTMLElement>('.item-bilingual-names input, .item-bilingual-names select, .moneyinput input'))
      .filter(element => element.getClientRects().length)
      .map(element => element.getBoundingClientRect())
      .sort((left, right) => left.top - right.top);
    return controls.slice(1).map((control, index) => control.top - controls[index]!.bottom);
  });
  expect(gaps.length).toBeGreaterThan(0);
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(10);
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
        const header = page.locator('.editor .modalheading');
        const title = header.getByRole('textbox', { name: 'Expense name', exact: true });
        await expect(title).toHaveCount(1);
        await title.fill('A'.repeat(200));
        await title.blur();
        for (const control of [header.locator('.expense-icon-trigger'), header.getByRole('button', { name: 'Close editor', exact: true })]) {
          const box = (await control.boundingBox())!;
          expect(box.width).toBeGreaterThanOrEqual(44);
          expect(box.height).toBeGreaterThanOrEqual(44);
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
        }
        if (width === 390) expect((await header.boundingBox())!.height).toBeLessThanOrEqual(88);
        if (mode === 'manual') {
          // A new expense opens as the quick form; it must fit too before itemising.
          await expect(page.getByRole('textbox', { name: 'Amount', exact: true })).toBeVisible();
          await fits(page);
          await page.locator('.split-method > summary').click();
          await fits(page);
          await page.getByRole('button', { name: 'By item', exact: true }).click();
          await page.getByRole('button', { name: 'Add item', exact: true }).click();
        } else {
          // Lines open to edit; the first two hold the name, translation and display controls.
          for (const row of [0, 1]) await page.locator('.item-edit > summary').nth(row).click();
        }
        if (receipt) await expect(page.getByRole('combobox', { name: 'Show first for item 1', exact: true })).toBeEnabled();
        // Typed lines with no language evidence keep one canonical name field.
        else await expect(page.locator('.item').first().locator('.item-bilingual-names input')).toHaveCount(1);
        if (receipt) {
          await expect(page.getByRole('textbox', { name: 'Item 1 English name', exact: true })).toHaveValue(translatedName);
          await expect(page.getByRole('button', { name: 'Translate item 2 English name', exact: true })).toBeEnabled();
        }
        await fits(page);
        if (width <= 480) await hasComfortableMobileItemSpacing(page);
        if (touch) {
          expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(true);
          const smallControls = await page.locator('.editor input, .editor select, .editor textarea').evaluateAll(elements =>
            elements.filter(element => element.getClientRects().length && parseFloat(getComputedStyle(element).fontSize) < 16).length);
          expect(smallControls).toBe(0);
        }
        // Collapsed lines are one row each; every split method of an open line fits too.
        await page.locator('.item .split-method > summary').first().click();
        await page.getByRole('button', { name: 'By percentage', exact: true }).first().click();
        await fits(page);
        await page.getByRole('button', { name: 'By quantity', exact: true }).first().click();
        await fits(page);
        await page.getByRole('button', { name: 'Whole bill', exact: true }).click();
        await fits(page);
        await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
        await fits(page);
      });
    }
  });
}

test.describe('same-language receipt item', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('uses one canonical name field when the detected and reading languages match', async ({ page }) => {
    const sameLanguageTrip = structuredClone(trip);
    sameLanguageTrip.drafts[0].detectedLanguage = 'en';
    sameLanguageTrip.drafts[0].items[0].nameLanguage = 'en';
    sameLanguageTrip.drafts[0].items[0].translations = { en: {
      text: originalName, sourceText: originalName, pairedText: originalName, sourceLanguage: 'en', provenance: 'ai',
    } };
    await fixtures(page, () => sameLanguageTrip);
    await page.goto('/expenses?receiptDraft=layout-draft&receiptTrip=layout-trip');
    const firstItem = page.locator('.item').first();
    await firstItem.locator('.item-edit > summary').click();
    await expect(firstItem.getByRole('textbox', { name: 'Item 1 name', exact: true })).toHaveValue(originalName);
    await expect(firstItem.locator('.item-bilingual-names input')).toHaveCount(1);
    await expect(page.getByRole('combobox', { name: 'Show first for item 1', exact: true })).toHaveCount(0);
    await fits(page);
    await hasComfortableMobileItemSpacing(page);
  });
});

// Conflict and error notices sit between the body and footer; they must share
// the dialog's single scroll area instead of squeezing the body.
for (const { width, height } of [{ width: 390, height: 844 }, { width: 320, height: 740 }]) {
  test.describe(`${width}×${height} conflict`, () => {
    test.use({ viewport: { width, height }, hasTouch: true, isMobile: true });
    test('edited expense conflict keeps one scroll area', async ({ page }) => {
      // A holiday-currency expense needs no exchange rate before saving.
      const base = { ...trip, expenses: trip.expenses.map(expense => ({ ...expense, currency: 'GBP' })) };
      let current = base;
      await fixtures(page, () => current);
      await page.goto('/expenses');
      await page.locator('.expense-open').first().click();
      await expect(page.getByRole('heading', { name: 'Edit expense', exact: true })).toBeVisible();
      current = { ...base, expenses: base.expenses.map(expense => ({ ...expense, title: 'Harbour dinner', items: expense.items.map(item => ({ ...item, amount: item.amount + 100 })) })) };
      await page.getByRole('textbox', { name: 'Expense name', exact: true }).fill('Dinner by the harbour, changed');
      await page.getByRole('button', { name: 'Save expense', exact: true }).click();
      await expect(page.locator('.conflict-review')).toBeVisible();
      await fits(page);
      await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
      await fits(page);
    });
  });
}

test.describe('320px amount field', () => {
  test.use({ viewport: { width: 320, height: 740 }, hasTouch: true, isMobile: true });
  test('shows the maximum supported amount without internal clipping', async ({ page }) => {
    await fixtures(page);
    await page.goto('/expenses');
    await page.getByRole('button', { name: 'Add expense', exact: true }).click();
    const amount = page.getByRole('textbox', { name: 'Amount', exact: true });
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

for (const [width,columns] of [[360,3],[361,4],[480,4],[481,5]] as const) {
  test.describe(`icon picker breakpoint at ${width}px`, () => {
    test.use({viewport:{width,height:844}});
    test('keeps the existing symbol columns and fits without horizontal scroll', async ({page}) => {
      await fixtures(page);
      await page.goto('/expenses?receiptDraft=layout-draft&receiptTrip=layout-trip');
      await page.locator('.editor .expense-more-options > summary').click();
      const trigger=page.locator('.editor .expense-icon-trigger');
      await trigger.focus();
      await trigger.press('Enter');
      const picker=page.getByRole('dialog',{name:'Choose an icon',exact:true});
      await expect(picker).toBeVisible();
      const layout=await picker.evaluate(element=>({
        columns:getComputedStyle(element.querySelector('.icon-symbol-grid')!).gridTemplateColumns.split(' ').length,
        overflow:element.scrollWidth-element.clientWidth,
        pageOverflow:document.documentElement.scrollWidth-innerWidth,
      }));
      expect(layout).toEqual({columns,overflow:0,pageOverflow:0});
    });
  });
}

/**
 * iOS opens the keyboard by shrinking the visual viewport and panning it down,
 * which carries a fixed overlay up the screen. No desktop engine shows that
 * keyboard, so this reports the same viewport geometry iOS does. Layout
 * coordinates here are screen coordinates shifted by the pan.
 */
async function setKeyboard(page: Page, keyboard: { height: number; pan: number } | null) {
  await page.evaluate(keyboard => {
    const viewport = window.visualViewport!;
    if (keyboard) {
      Object.defineProperty(viewport, 'height', { configurable: true, get: () => innerHeight - keyboard.height });
      Object.defineProperty(viewport, 'offsetTop', { configurable: true, get: () => keyboard.pan });
    } else {
      delete (viewport as unknown as Record<string, unknown>).height;
      delete (viewport as unknown as Record<string, unknown>).offsetTop;
    }
    viewport.dispatchEvent(new Event('resize'));
  }, keyboard);
}

test.describe('phone keyboard', () => {
  // An iPhone 16/17 Pro; 396 px is its keyboard with the AutoFill bar.
  const screen = { width: 402, height: 874 };
  const keyboard = 396;
  test.use({ viewport: screen, hasTouch: true, isMobile: true });
  for (const pan of [keyboard, 0]) {
    test(`keeps the editor above the keyboard and covers the page behind it${pan ? ' when iOS pans the viewport' : ''}`, async ({ page }) => {
      await fixtures(page);
      await page.goto('/expenses');
      await page.locator('.expense-open').first().click();
      await expect(page.locator('.editor')).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Expense name', exact: true })).toBeFocused();
      await page.locator('.item-edit > summary').first().click();
      // A field on screen where the keyboard will appear, the case that makes iOS pan.
      const found = await page.locator('.editor').evaluate((editor, target) => {
        const field = Array.from(editor.querySelectorAll<HTMLElement>('.editor-body :is(input:not([type=checkbox], [type=radio], [type=file]), textarea)'))
          .find(element => element.checkVisibility() && element.getBoundingClientRect().top + editor.scrollTop >= target);
        if (field) editor.scrollTop = field.getBoundingClientRect().top + editor.scrollTop - target;
        field?.setAttribute('data-keyboard-field', '');
        return !!field;
      }, screen.height - keyboard + 40);
      expect(found).toBe(true);
      const field = page.locator('[data-keyboard-field]');
      await field.focus();
      await expect(field).toBeFocused();
      expect((await field.boundingBox())!.y).toBeGreaterThan(screen.height - keyboard);
      await setKeyboard(page, { height: keyboard, pan });
      const visibleBottom = pan + screen.height - keyboard;
      // With a pan, the old full-height bottom equals the resized bottom.
      // Wait for both coordinates so a pending animation frame cannot pass.
      await expect.poll(() => page.locator('.editor').evaluate(editor => {
        const box=editor.getBoundingClientRect();return [Math.round(box.top),Math.round(box.bottom)];
      })).toEqual([pan,visibleBottom]);
      const geometry = await page.locator('.editor').evaluate(editor => {
        const overlay = editor.closest<HTMLElement>('.editor-overlay')!;
        const footer = editor.querySelector('.editor-footer')!.getBoundingClientRect();
        const focused = document.activeElement!.getBoundingClientRect();
        const style = getComputedStyle(overlay);
        return {
          overlay: [overlay.getBoundingClientRect().top, overlay.getBoundingClientRect().bottom].map(Math.round),
          editorTop: Math.round(editor.getBoundingClientRect().top),
          footerBottom: Math.round(footer.bottom),
          focusedVisible: focused.top >= editor.getBoundingClientRect().top && focused.bottom <= footer.top,
          keyboardInset: style.borderBottomWidth,
          opaque: !/rgba\(.*, 0(\.\d+)?\)/.test(style.backgroundColor),
          overlayScroll: overlay.scrollHeight - overlay.clientHeight,
        };
      });
      // The overlay spans the whole screen, keyboard included, so no page shows.
      expect(geometry.overlay).toEqual([pan, pan + screen.height]);
      expect(geometry.opaque).toBe(true);
      expect(geometry.keyboardInset).toBe(`${keyboard}px`);
      expect(geometry.overlayScroll).toBeLessThanOrEqual(1);
      // The editor fills the visible area, with Save directly above the keyboard.
      expect(geometry.editorTop).toBe(pan);
      expect(geometry.footerBottom).toBe(visibleBottom);
      expect(geometry.focusedVisible).toBe(true);
      // WebKit may not paint the overlay below the layout viewport, so the page
      // hides itself; only the editor and a matching background can show there.
      const page_ = await page.evaluate(() => ({
        shell: getComputedStyle(document.querySelector('.shell')!).visibility,
        overlay: getComputedStyle(document.querySelector('.editor-overlay')!).visibility,
        background: getComputedStyle(document.body).backgroundColor,
        surface: getComputedStyle(document.querySelector('.editor')!).backgroundColor,
        keyboard: document.documentElement.hasAttribute('data-keyboard-open'),
      }));
      expect(page_).toEqual({ shell: 'hidden', overlay: 'visible', background: page_.surface, surface: page_.surface, keyboard: true });

      // Closing the keyboard restores the full-screen editor with no leftover offset.
      await setKeyboard(page, null);
      await expect.poll(() => page.locator('.editor').evaluate(editor => {
        const bounds = editor.getBoundingClientRect();
        return [Math.round(bounds.top), Math.round(bounds.bottom)];
      })).toEqual([0, screen.height]);
      expect(await page.locator('.editor-overlay').evaluate(overlay => getComputedStyle(overlay).borderBottomWidth)).toBe('0px');
      expect(await page.evaluate(() => document.documentElement.hasAttribute('data-keyboard-open'))).toBe(false);
      // The page comes back once the editor closes.
      await page.getByRole('button', { name: 'Close editor', exact: true }).click();
      await expect(page.locator('.editor')).toHaveCount(0);
      await expect(page.locator('.expense-open').first()).toBeVisible();
    });
  }

  test('shows the viewport readout only when asked', async ({ page }) => {
    await fixtures(page);
    await page.goto('/balances');
    await page.getByRole('button', { name: 'Record payment', exact: true }).click();
    await expect(page.locator('.payment-editor')).toBeVisible();
    await expect(page.locator('.viewport-debug')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.goto('/balances?viewport-debug');
    await page.getByRole('button', { name: 'Record payment', exact: true }).click();
    await setKeyboard(page, { height: keyboard, pan: keyboard });
    await expect(page.locator('.viewport-debug')).toContainText(`visual ${screen.height - keyboard} @ ${keyboard}`);
  });

  test('keeps a centred dialog above the keyboard', async ({ page }) => {
    await fixtures(page);
    await page.goto('/balances');
    await page.getByRole('button', { name: 'Record payment', exact: true }).click();
    const dialog = page.locator('.payment-editor');
    await expect(dialog).toBeVisible();
    await dialog.locator('textarea').focus();
    await setKeyboard(page, { height: keyboard, pan: keyboard });
    // The dialog moves with the pan and fits between the top of the screen and the keyboard.
    await expect.poll(() => dialog.evaluate((element, [top, bottom]) => {
      const bounds = element.getBoundingClientRect();
      return bounds.top >= top && bounds.bottom <= bottom;
    }, [keyboard, screen.height])).toBe(true);
    // The page behind the keyboard is hidden while typing and returns after.
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.shell')!).visibility)).toBe('hidden');
    await setKeyboard(page, null);
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.shell')!).visibility)).toBe('visible');
    await expect(dialog).toBeVisible();
  });
});
