import { expect, test, type Page } from '@playwright/test';

test.use({ timezoneId: 'UTC' });
const members = [
  { id: 'm-alex', name: 'Alex', userId: 'audit-owner', email: 'alex@example.invalid' },
  { id: 'm-sam', name: 'Sam', userId: 'audit-sam', email: 'sam.longer-address@example.invalid' },
  { id: 'm-jordan', name: 'Jordan' },
  { id: 'm-max', name: 'Maximiliana Konstantinopoulou' },
  { id: 'm-priya', name: 'Priya' },
  { id: 'm-lee', name: 'Lee' },
];
const ids = members.map(m => m.id);
const titles = ['Dinner by the harbour', 'Taxi from the airport', 'Pastéis de Belém', 'Groceries for the flat',
  'Sintra day trip train tickets', 'Fado night', 'Sunscreen', 'Museum of Ancient Art (Museu Nacional de Arte Antiga) entry',
  'Coffee', 'Tram 28', 'Beach umbrellas', 'Seafood lunch at Cervejaria Ramiro', 'Wine shop', 'Boat tour', 'Pharmacy',
  'Ice cream', 'Breakfast', 'Cascais bus', 'Souvenirs', 'Late-night snacks', 'Laundry', 'Bike hire', 'Rooftop bar', 'Farewell dinner'];
const pad = (n: number) => String(n).padStart(2, '0');
const expenses = titles.map((title, i) => {
  const foreign = i % 4 === 1, share = ids.filter((_, j) => (i + j) % 3 !== 0);
  return {
    id: `e-${i}`, title, date: `2026-07-${pad(28 - i)}`, time: `${pad(9 + (i % 12))}:${pad((i * 7) % 60)}`,
    timezone: 'Europe/Lisbon', currency: foreign ? 'USD' : 'EUR', payer: ids[i % ids.length], tax: 0, tip: 0, discount: 0,
    ...(i % 5 === 0 ? { source: 'ai' } : {}),
    ...(foreign ? { fx: { rate: 0.92, asOf: '2026-07-20', source: i % 8 === 1 ? 'manual' : 'reference' } } : {}),
    items: i % 3 === 0
      ? [{ id: `e-${i}-a`, name: 'Main', amount: 1800 + i * 137, members: share },
         { id: `e-${i}-b`, name: 'Extra', amount: 600 + i * 31, members: [ids[0], ids[1]] }]
      : [{ id: `e-${i}-a`, name: title, amount: 950 + i * 411, members: share }],
  };
});
const payments = Array.from({ length: 9 }, (_, i) => {
  const from = ids[(i + 2) % ids.length];
  return { id: `p-${i}`, from, to: from === ids[0] ? ids[1] : ids[0], amount: 2500 + i * 730,
    date: `2026-07-${pad(10 + i)}`, method: i % 2 ? 'Bank transfer' : 'Revolut',
    ...(i === 3 ? { note: 'For the boat tour and the two dinners we split on Tuesday' } : {}) };
});
const drafts = ['Pingo Doce', 'Restaurante O Tasco do Chico — late supper', 'Continente', 'Farmácia', 'Uber', 'A Vida Portuguesa']
  .map((title, i) => ({ id: `d-${i}`, receiptId: `r-${i}`, title, status: i % 2 ? 'review' : 'pending', currency: 'EUR',
    date: '2026-07-20', time: '12:00', timezone: 'Europe/Lisbon', payer: 'm-alex', tax: 0, tip: 0, discount: 0,
    items: Array.from({ length: 2 + i }, (_, j) => ({ id: `d-${i}-${j}`, name: `Item ${j + 1}`, amount: 300 + j * 120, members: [] })) }));
const trip = { id: 'audit-trip', ownerId: 'audit-owner', name: 'A week in Lisbon', currency: 'EUR', receiptLanguage: 'pt',
  startDate: '2026-07-04', endDate: '2026-07-28', members, expenses, payments, drafts };

const activity = Array.from({ length: 40 }, (_, i) => ({
  id: `event-${i}`, sequence: 200 - i, tripId: trip.id, actorId: 'audit-owner', actorName: 'Alex',
  createdAt: new Date(Date.UTC(2026, 6, 28, 18 - i)).toISOString(), revision: 1, source: 'web',
  entityType: 'expense', entityId: expenses[i % expenses.length].id, action: 'create', before: null,
  after: expenses[i % expenses.length],
}));
async function fixtures(page: Page, value = trip) {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const json = path === '/api/ledger' ? { data: { trips: [value, { ...trip, id: 'empty-trip', name: 'Weekend in Porto', expenses: [] }] }, revision: 1 }
      : path === '/api/profile' ? { id: 'audit-owner', displayName: 'Alex', email: 'alex@example.invalid', authMethod: 'password' }
      : path === '/api/invite' ? { invitations: [{ id: 'inv-1', memberId: 'm-jordan', memberName: 'Jordan', email: 'jordan@example.invalid', createdAt: '2026-07-28T00:00:00Z', expiresAt: '2026-08-04T00:00:00Z', status: 'pending' }], hasMore: false }
      : path === '/api/activity' ? { events: new URL(route.request().url()).searchParams.has('before') ? activity.slice(20) : activity.slice(0, 20), nextCursor: new URL(route.request().url()).searchParams.has('before') ? null : 180 }
      : path === '/api/trip-language' ? { accountId: 'audit-owner', tripId: trip.id, revision: 1, preferences: { readingLanguage: 'en', primaryVersion: 'reading', itemVersions: {} } }
      : { events: [], nextCursor: null, notifications: [], items: [] };
    return route.fulfill({ json, headers: path === '/api/ledger' ? { 'X-TripTab-Account': 'audit-owner' } : {} });
  });
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
}
for (const width of [320, 375, 390, 430, 768, 820, 901, 1024, 1440]) {
  test(`main layout at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await fixtures(page);
    await page.goto('/expenses');
    await expect(page.locator('.expense')).toHaveCount(20);
    await noOverflow(page);
    if (width <= 700) {
      const boxes = await page.locator('.expense-entry-actions button').evaluateAll(buttons => buttons.map(button => {
        const box = button.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, right: box.right };
      }));
      expect(Math.abs(boxes[0].width - boxes[1].width)).toBeLessThanOrEqual(1);
      if (width < 360) expect(boxes[1].y).toBeGreaterThan(boxes[0].y);
      else expect(boxes[1].y).toBe(boxes[0].y);
      // Row height depends on the fallback font: CI's WebKit rows match DejaVu Sans, which wraps
      // more than Inter or Liberation Sans (320px average 151px, against 137-139px). So the row
      // layout is checked structurally, which holds in every font and fails on the old rows at
      // every phone width; only 320px keeps a height budget, between the fixed rows (at most
      // 152px) and the old ones (at least 171px).
      const rows = await page.locator('.expense').evaluateAll(rows => rows.map(row => {
        const title = row.querySelector('.expense-details b')!.getBoundingClientRect();
        const amount = row.querySelector('.expense-amount b')!.getBoundingClientRect();
        const hintShown = Array.from(row.querySelectorAll('.expense-amount small'))
          .some(small => small.textContent?.trim() === 'Edit split' && small.getClientRects().length > 0);
        return { height: row.getBoundingClientRect().height, titleWidth: title.width, sameLine: Math.abs(amount.top - title.top),
          foreign: /original/.test(row.querySelector('.expense-amount')!.textContent || ''), hintShown };
      }));
      for (const row of rows) {
        expect(row.sameLine).toBeLessThanOrEqual(2);
        expect(row.hintShown).toBe(false);
      }
      if (width === 320) {
        expect(Math.min(...rows.filter(row => !row.foreign).map(row => row.titleWidth))).toBeGreaterThanOrEqual(125);
        expect(rows.reduce((sum, row) => sum + row.height, 0) / rows.length).toBeLessThanOrEqual(160);
      }
    }
    for (const path of ['/balances', '/receipts', '/travellers', '/history']) {
      await page.goto(path);
      await expect(page.locator('.tabs')).toBeVisible();
      await noOverflow(page);
      if (path === '/balances') {
        const hideRail = width <= 815 || (width >= 901 && width <= 1015);
        if (hideRail) { await expect(page.locator('.right-rail')).toBeHidden(); await expect(page.locator('.balance-card--inline')).toBeVisible(); }
        else { await expect(page.locator('.right-rail')).toBeVisible(); await expect(page.locator('.balance-card--inline')).toBeHidden(); }
        await expect(page.locator('.payment')).toHaveCount(5);
        await expect(page.locator('.payment').first()).toHaveAttribute('data-entry-id', 'p-8');
      }
      if (path === '/receipts') {
        await expect(page.locator('.draft')).toHaveCount(6);
        if (width <= 480) expect(await page.locator('.draft > div:not(.draft-visual)').first().evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThanOrEqual(120);
      }
      if (path === '/travellers') {
        expect(await page.locator('.personal-language-settings').evaluate(el => parseFloat(getComputedStyle(el).paddingLeft))).toBeGreaterThanOrEqual(20);
        await expect(page.getByRole('button', { name: /^Save traveller/ })).toHaveCount(0);
      }
    }
  });
}
test('pagination preserves tab counts, resets holiday scope and focuses the new row', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await fixtures(page); await page.goto('/expenses');
  const more = page.getByRole('button', { name: 'Show 4 more' });
  await more.scrollIntoViewIfNeeded(); await more.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.expense')).toHaveCount(24);
  await expect(page.locator('[data-entry-id="e-20"] .expense-open')).toBeFocused();
  await page.getByRole('link', { name: 'Balances' }).click();
  await page.getByRole('link', { name: 'Expenses' }).click();
  await expect(page.locator('.expense')).toHaveCount(24);
  await page.getByRole('button', { name: 'Open holidays' }).click();
  await page.getByRole('button', { name: /Weekend in Porto/ }).click();
  await page.getByRole('button', { name: 'Open holidays' }).click();
  await page.getByRole('button', { name: /A week in Lisbon/ }).click();
  await expect(page.locator('.expense')).toHaveCount(20);
});
test('drawer traps focus, closes on Escape and restores the opener', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 }); await fixtures(page); await page.goto('/expenses');
  const open = page.getByRole('button', { name: 'Open holidays' }); await open.click();
  await expect(page.locator('.workspace')).toHaveAttribute('inert', '');
  for (let i = 0; i < 15; i++) { await page.keyboard.press('Tab'); expect(await page.locator('#holiday-sidebar').evaluate(el => el.contains(document.activeElement))).toBe(true); }
  await page.keyboard.press('Escape'); await expect(open).toBeFocused(); await expect(page.locator('.sidebar-backdrop')).toHaveCount(0);
});
for (const theme of ['light', 'dark'] as const) {
  test(`enlarged text stays within the page in ${theme} mode`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: theme }); await fixtures(page);
    for (const path of ['/expenses', '/receipts', '/balances', '/travellers', '/history']) {
      await page.goto(path); await page.locator('.tabs').waitFor();
      await page.addStyleTag({ content: 'html { font-size: 200%; }' }); await noOverflow(page);
    }
  });
}

for (const theme of ['light', 'dark'] as const) for (const viewport of [320, 1440]) {
  test(`readable words and text contrast across tabs in ${theme} at ${viewport}px`, async ({ page }) => {
    await page.setViewportSize({ width: viewport, height: 900 });
    await page.emulateMedia({ colorScheme: theme }); await fixtures(page);
    for (const path of ['/expenses', '/receipts', '/balances', '/travellers', '/history']) {
      await page.goto(path); await page.locator('.tabs').waitFor();
      if (path === '/history') await expect(page.locator('.activity-event')).toHaveCount(20);
      const splits = await page.locator('.expense-details b, .draft > div:not(.draft-visual), .member-identity b, .statement-link > span:first-child, .payment-summary, .payment-meta').evaluateAll(elements => {
        const failures: string[] = [];
        for (const element of elements) {
          if (!element.getClientRects().length) continue;
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          const width = box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            for (const match of node.textContent!.matchAll(/[^\s-]+/g)) {
              const range = document.createRange(); range.setStart(node, match.index!); range.setEnd(node, match.index! + match[0].length);
              const rects = [...range.getClientRects()].filter(rect => rect.width > 0);
              if (new Set(rects.map(rect => Math.round(rect.y))).size > 1 && rects.reduce((sum, rect) => sum + rect.width, 0) <= width) failures.push(match[0]);
            }
          }
        }
        return failures;
      });
      expect(splits, path).toEqual([]);
      const contrast = await page.locator('main *, .tabs *, .topbar *').evaluateAll(elements => {
        const rgba = (value: string) => (value.match(/[\d.]+/g) || []).map(Number);
        const luminance = (color: number[]) => color.slice(0, 3).map(value => { const v = value / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
        const failures: { text: string; ratio: number; selector: string }[] = [];
        for (const element of elements) {
          if (!element.getClientRects().length || element.closest(':disabled, [aria-hidden="true"], .sr-only') || getComputedStyle(element).visibility === 'hidden') continue;
          const text = [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim();
          if (!text) continue;
          const style = getComputedStyle(element), foreground = rgba(style.color);
          let background: number[] = [255, 255, 255];
          for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
            const color = rgba(getComputedStyle(ancestor).backgroundColor);
            if (color.length === 3 || color[3] === 1) { background = color; break; }
          }
          const light = luminance(foreground), dark = luminance(background), ratio = (Math.max(light, dark) + .05) / (Math.min(light, dark) + .05);
          const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
          if (ratio < (large ? 3 : 4.5) - .01) failures.push({ text: text.slice(0, 70), ratio, selector: element.className });
        }
        return failures;
      });
      expect(contrast, path).toEqual([]);
    }
  });
}

test('both traveller lists and the inline balance are bounded with 50 travellers', async ({ page }) => {
  const large = { ...trip, members: [...trip.members, ...Array.from({ length: 44 }, (_, i) => ({ id: `extra-${i}`, name: `Traveller ${i + 7}` }))] };
  await page.setViewportSize({ width: 390, height: 844 }); await fixtures(page, { ...large, payments: [], expenses: large.expenses.map(expense => ({ ...expense, items: expense.items.map(item => ({ ...item, members: large.members.map(member => member.id) })) })) }); await page.goto('/travellers');
  await expect(page.locator('.members .member')).toHaveCount(10);
  await expect(page.locator('.traveller-name-form')).toHaveCount(10);
  const more = page.locator('.trip-traveller-names').getByRole('button', { name: 'Show 10 more' });
  await more.click(); await expect(page.locator('.traveller-name-form')).toHaveCount(20);
  await expect(page.getByRole('textbox', { name: 'Traveller 11 name', exact: true })).toBeFocused();
  await page.getByRole('link', { name: 'Balances' }).click();
  await expect(page.locator('.balance-card--inline .balance-row')).toHaveCount(8);
  await expect(page.locator('.statement-link')).toHaveCount(10);
  await expect(page.locator('.settlement')).toHaveCount(10);
});
for (const width of [320, 390]) {
  test(`payment footer stays visible and statements page at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 568 }); await fixtures(page); await page.goto('/balances');
    await page.getByRole('button', { name: 'Record payment', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const action = dialog.getByRole('button', { name: 'Review payment', exact: true });
    const box = await action.boundingBox(); expect(box!.y + box!.height).toBeLessThanOrEqual(568);
    await page.getByRole('button', { name: 'Close payment editor' }).click();
    await page.locator('.statement-link').first().click();
    await expect(page.locator('.statement-section').first().locator('.statement-entry')).toHaveCount(10);
    await page.locator('.statement-section').first().getByRole('button', { name: /^Show \d+ more$/ }).click();
    expect(await page.locator('.statement-section').first().locator('.statement-entry').count()).toBeGreaterThan(10);
    expect(await page.locator('.statement-section').first().locator('.statement-entry').nth(10).evaluate(el => el === document.activeElement)).toBe(true);
  });
}

test('receipt text and card padding use the available phone width', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 }); await fixtures(page); await page.goto('/receipts');
  await expect(page.locator('.draft')).toHaveCount(6);
  expect(await page.locator('.draft > div:not(.draft-visual)').first().evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThanOrEqual(120);
  await page.getByRole('link', { name: 'Travellers' }).click();
  expect(await page.locator('.personal-language-settings').evaluate(el => parseFloat(getComputedStyle(el).paddingLeft))).toBe(20);
});

// Compare the tokenized rules with their exact literal expansions. Both are
// injected in the same cascade position, isolating token substitution from the
// intentional row and pagination changes above.
test('exact token substitutions preserve geometry in both themes and at 200% text', async ({ page }) => {
  test.setTimeout(120_000);
  const { readFile } = await import('node:fs/promises');
  const css = (await readFile(new URL('../../app/globals.css', import.meta.url), 'utf8')).replace(/^@import[^;]+;\s*/gm, '');
  const values: Record<string, string> = { '--space-1': '4px', '--space-2': '8px', '--space-3': '12px', '--space-4': '16px', '--space-5': '24px', '--space-6': '32px', '--radius-s': '8px', '--radius-m': '12px', '--text-xs': '0.8rem', '--text-s': '0.875rem', '--text-m': '1rem', '--text-l': '1.25rem', '--text-xl': '1.5rem' };
  const literal = css.replace(/var\((--(?:space-\d|radius-[sm]|text-(?:xs|s|m|l|xl)))\)/g, (match, name: string) => values[name] ?? match);
  await fixtures(page); await page.goto('/expenses'); await expect(page.locator('.expense')).toHaveCount(20);
  const snapshot = () => page.locator('.topbar, .page-heading, .stats, .tabs, .content-grid').evaluateAll(roots => roots.flatMap(root => [root, ...root.querySelectorAll('*')]).filter(el => el.getClientRects().length).map(el => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }));
  for (const width of [320, 390, 768, 1440]) for (const theme of ['light', 'dark'] as const) for (const scale of [100, 200]) {
    await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme: theme });
    const style = await page.addStyleTag({ content: literal + `\nhtml { font-size: ${scale}%; }` });
    const before = await snapshot();
    await style.evaluate((el, text) => { el.textContent = text; }, css + `\nhtml { font-size: ${scale}%; }`);
    const after = await snapshot();
    expect(after.length).toBe(before.length);
    const movement = Math.max(0, ...after.flatMap((box, index) => box.map((value, dimension) => Math.abs(value - before[index][dimension]))));
    expect(movement, `${width}px ${theme} ${scale}%`).toBeLessThanOrEqual(1);
    await style.evaluate(el => (el as HTMLStyleElement).remove());
  }
});

test('history groups local days and retains server pagination', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await fixtures(page); await page.goto('/history');
  await expect(page.locator('.activity-event')).toHaveCount(20);
  await expect(page.locator('.activity-day').first()).toHaveText('Tue, 28 Jul 2026');
  await expect(page.locator('.activity-event time').first()).toHaveText('18:00');
  await page.getByRole('button', { name: 'Load older changes' }).click();
  await expect(page.locator('.activity-event')).toHaveCount(40);
  await expect(page.getByRole('button', { name: 'Load older changes' })).toHaveCount(0);
});

test('editing a draft icon preserves saved ledger order while rendering recently added first', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await fixtures(page); await page.goto('/receipts');
  await expect(page.locator('.draft').first()).toHaveAttribute('data-entry-id', 'd-5');
  await page.locator('.draft').first().locator('.expense-icon-trigger').click();
  await page.getByRole('dialog', { name: 'Choose an icon', exact: true }).locator('.icon-color').first().click();
  const posted = page.waitForRequest(request => new URL(request.url()).pathname === '/api/ledger' && request.method() === 'POST');
  await page.getByRole('button', { name: 'Use icon', exact: true }).click();
  const body = (await posted).postDataJSON();
  expect(body.data.trips.find((entry: { id: string }) => entry.id === trip.id).drafts.map((entry: { id: string }) => entry.id)).toEqual(trip.drafts.map(entry => entry.id));
});

test('payment review and focused Note remain reachable above a simulated phone keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await fixtures(page); await page.goto('/balances');
  await page.getByRole('button', { name: 'Record payment', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Paid by', exact: true }).selectOption('m-jordan');
  await dialog.getByRole('combobox', { name: 'Paid to', exact: true }).selectOption('m-alex');
  await dialog.getByRole('textbox', { name: 'Amount (EUR)', exact: true }).fill('12.34');
  const note = dialog.getByRole('textbox', { name: 'Note (optional)', exact: true }); await note.fill('The airport taxi'); await note.focus();
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.defineProperty(viewport, 'height', { configurable: true, get: () => innerHeight - 396 });
    viewport.dispatchEvent(new Event('resize'));
  });
  await expect.poll(async () => note.evaluate(el => el.getBoundingClientRect().bottom <= el.closest('.payment-editor')!.querySelector('.payment-actions')!.getBoundingClientRect().top - 1)).toBe(true);
  await page.evaluate(() => { delete (window.visualViewport as unknown as Record<string, unknown>).height; window.visualViewport!.dispatchEvent(new Event('resize')); });
  await dialog.getByRole('button', { name: 'Review payment', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Review payment', exact: true })).toBeVisible();
  const confirm = await dialog.getByRole('button', { name: 'Confirm payment', exact: true }).boundingBox();
  expect(confirm!.y + confirm!.height).toBeLessThanOrEqual(844);
});

test('drawer starts on the current holiday and returns to its opener however it closes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await fixtures(page); await page.goto('/expenses');
  const open = page.getByRole('button', { name: 'Open holidays' });
  const current = page.locator('#holiday-sidebar .tripnav button.active');
  await open.click(); await expect(current).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  expect(await page.locator('#holiday-sidebar').evaluate(el => el.contains(document.activeElement))).toBe(true);
  await page.getByRole('button', { name: 'Close holiday menu' }).click(); await expect(open).toBeFocused();
  // Safari does not focus a tapped button, so open without focusing it: focus must still come back.
  await open.evaluate(button => { (document.activeElement as HTMLElement | null)?.blur(); (button as HTMLButtonElement).click(); });
  await expect(current).toBeFocused();
  await page.locator('.sidebar-backdrop').click({ position: { x: 370, y: 400 } }); await expect(open).toBeFocused();
});

test('paged rows keep their row borders and lists contain only list items', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await fixtures(page);
  await page.goto('/travellers');
  const names = page.locator('.trip-traveller-names .traveller-name-form');
  await expect(names).toHaveCount(6);
  expect(await names.evaluateAll(forms => forms.map(form => getComputedStyle(form).borderBottomWidth))).toEqual(['1px', '1px', '1px', '1px', '1px', '0px']);
  await page.goto('/balances');
  expect(await page.locator('.statement-link').last().evaluate(link => getComputedStyle(link).borderBottomWidth)).toBe('0px');
  // 5 of 9 payments show: the last row's border and the Show more footer's border are one line.
  expect(await page.locator('.payment').last().evaluate(row =>
    Math.round(row.closest('.paged-list')!.querySelector('.list-more')!.getBoundingClientRect().top - row.getBoundingClientRect().bottom))).toBe(-1);
  expect(await page.locator('.payment-meta').first().evaluate(meta => getComputedStyle(meta).marginTop)).toBe('0px');
  await page.locator('.statement-link').first().click();
  const roles = await page.getByRole('dialog').getByRole('list').first().evaluate(list => Array.from(list.children, child => child.getAttribute('role')));
  expect(roles.length).toBe(10);
  expect(new Set(roles)).toEqual(new Set(['listitem']));
  await page.keyboard.press('Escape');
  await page.goto('/history'); await expect(page.locator('.activity-event')).toHaveCount(20);
  await expect(page.locator('#panel-history').getByText(/updates automatically/i)).toHaveCount(1);
});

test('saving a traveller name keeps focus in its row', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await fixtures(page); await page.goto('/travellers');
  const input = page.getByRole('textbox', { name: 'Traveller 2 name', exact: true });
  await input.fill('Samuel');
  await page.getByRole('button', { name: 'Save traveller 2 name', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Save traveller 2 name', exact: true })).toHaveCount(0);
  await expect(input).toBeFocused();
});

test('closing a dialog with the phone keyboard open returns focus to its opener', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await fixtures(page); await page.goto('/expenses');
  const opener = page.getByRole('button', { name: 'Add expense', exact: true });
  await opener.click();
  await page.getByRole('textbox', { name: 'Expense name', exact: true }).focus();
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.defineProperty(viewport, 'height', { configurable: true, get: () => innerHeight - 396 });
    viewport.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('html')).toHaveAttribute('data-keyboard-open', '');
  // The page is hidden while the keyboard is open; it must be shown again before focus returns to it.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(opener).toBeFocused();
});
