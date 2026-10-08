import { expect, test } from '@playwright/test';
import path from 'node:path';

for (const width of [320, 390, 1440]) {
  test.describe(`receipt upload at ${width}px`, () => {
    test.use({ viewport: { width, height: width === 1440 ? 900 : width === 320 ? 740 : 844 }, hasTouch: width < 1440, isMobile: width < 1440 });
    test('saves natural-language guidance before its single scan, with optional location and no horizontal overflow', async ({ page, browserName }) => {
      let current: Record<string, unknown> = { id: 'holiday', ownerId: 'owner', name: 'Holiday', currency: 'GBP',
        members: [{ id: 'you', name: 'Chris', userId: 'owner' }, { id: 'gary', name: 'Gary' }], expenses: [], drafts: [], payments: [] };
      let revision = 1, uploads = 0, reads = 0;
      await page.addInitScript(() => {
        Object.defineProperty(window, '__locationRequests', { value: 0, writable: true });
        Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition(_success: unknown, fail: (error: unknown) => void) {
          (window as unknown as { __locationRequests: number }).__locationRequests++;
          fail({ code: 1, message: 'Not shared' });
        } } });
      });
      await page.route('**/api/**', async route => {
        const request = route.request(), pathname = new URL(request.url()).pathname;
        if (pathname === '/api/ledger' && request.method() === 'POST') {
          const posted = request.postDataJSON();
          current = posted.data.trips[0];
          for (const draft of current.drafts as Record<string, unknown>[]) for (const message of (draft.conversation ?? []) as Record<string, unknown>[]) {
            if (message.role === 'user') { message.authorMemberId = 'you'; message.authorName = 'Chris'; }
          }
          return route.fulfill({ json: { data: { trips: [current] }, revision: ++revision } });
        }
        if (pathname === '/api/receipt' && request.method() === 'POST') {
          uploads++; return route.fulfill({ json: { receiptId: 'photo' } });
        }
        if (pathname === '/api/receipt/process') {
          reads++;
          const draft = (current.drafts as Record<string, unknown>[])[0];
          const message = (draft.conversation as Record<string, unknown>[])[0];
          expect(message.text).toBe('Gaz had a decaf, I had a cappuccino.');
          expect(message.authorMemberId).toBe('you');
          expect(draft.location).toEqual({ label: 'Bratislava', source: 'user' });
          draft.status = 'review'; draft.source = 'ai';
          draft.suggestedIcon = {symbol:'Utensils',background:'orange'};
          draft.receiptScan = {version:1,printedTotal:320,printedCurrency:'GBP',status:'matched',warnings:[]};
          draft.items = [{ id: 'coffee', name: 'Cappuccino', amount: 320, members: ['you'] }];
          draft.conversation = [message, { id: 'answer', role: 'assistant', text: 'Read the coffee and proposed your share.', replyTo: message.id, createdAt: new Date().toISOString() }];
          return route.fulfill({ json: { data: { trips: [current] }, revision: ++revision, draft } });
        }
        const json = pathname === '/api/ledger' ? { data: { trips: [current] }, revision }
          : pathname === '/api/profile' ? { id: 'owner', displayName: 'Chris', email: 'chris@example.invalid', authMethod: 'password' }
          : pathname === '/api/receipt/ai-status' ? { configured: true, connected: true, provider: 'api', eligible: true, manageable: false, siwcAvailable: false }
          : pathname === '/api/trip-language' ? { accountId: 'owner', tripId: 'holiday', revision: 1, preferences: { readingLanguage: 'en', primaryVersion: 'reading', itemVersions: {} } }
          : { events: [], notifications: [], items: [] };
        return route.fulfill({ json, headers: pathname === '/api/ledger' ? { 'X-TripTab-Account': 'owner' } : {} });
      });
      await page.goto('/receipts');
      await page.getByRole('button', { name: 'Add receipt', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Add a receipt', exact: true });
      await expect(dialog).toBeVisible();
      expect(await page.evaluate(() => (window as unknown as { __locationRequests: number }).__locationRequests)).toBe(0);
      await dialog.getByRole('textbox', { name: /Who bought what/ }).fill('Gaz had a decaf, I had a cappuccino.');
      await dialog.locator('summary').click();
      const locationLabelLayout = await dialog.locator('.receipt-place-fields > label').evaluate(label => {
        const text = label.firstChild;
        const optional = label.querySelector('small')!;
        if (!text) throw new Error('Receipt location label text is missing.');
        const range = document.createRange();
        range.selectNode(text);
        const heading = range.getBoundingClientRect();
        const helper = optional.getBoundingClientRect();
        return {
          overlaps: heading.left < helper.right && heading.right > helper.left && heading.top < helper.bottom && heading.bottom > helper.top,
          helperMarginTop: getComputedStyle(optional).marginTop,
        };
      });
      expect(locationLabelLayout).toEqual({ overlaps: false, helperMarginTop: '0px' });
      // The site's Permissions-Policy disables geolocation. Chromium reports
      // that, so the action is not offered; elsewhere it fails truthfully.
      const locate = dialog.getByRole('button', { name: 'Use current location', exact: true });
      if (browserName === 'chromium') await expect(locate).toHaveCount(0);
      else if (await locate.count()) {
        await locate.click();
        await expect(dialog.getByRole('status').last()).toContainText('Your position is unavailable');
      }
      await dialog.getByRole('textbox', { name: /Receipt location/ }).fill('Bratislava');
      expect(await dialog.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      await dialog.locator('input[type=file]').last().setInputFiles(path.resolve('tests/fixtures/receipts/v1/images/long-receipt.png'));
      await expect(dialog).toBeHidden();
      await expect(page.locator('.editor')).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Item 1 name', exact: true })).toHaveValue('Cappuccino');
      expect(uploads).toBe(1); expect(reads).toBe(1);
      expect(current.expenses).toEqual([]);
      await expect(page.getByText('Read the coffee and proposed your share.', { exact: true })).toBeVisible();
      const trigger = page.locator('.editor .expense-icon-trigger');
      await expect(trigger).toHaveAttribute('aria-label', /Automatic: Meals · Orange/);
      await trigger.click();
      const picker = page.getByRole('dialog', {name:'Choose an icon',exact:true});
      await expect(picker.getByText('Suggested from the receipt reading', {exact:true})).toBeVisible();
      const layout = await picker.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return {
          overflow: element.scrollWidth-element.clientWidth,
          pageOverflow: document.documentElement.scrollWidth-innerWidth,
          left: bounds.left, right: bounds.right,
          columns: getComputedStyle(element.querySelector('.icon-symbol-grid')!).gridTemplateColumns.split(' ').length,
          smallTargets: Array.from(element.querySelectorAll('button,input,select')).filter(control => {
            const rect=control.getBoundingClientRect();
            return rect.width > 0 && (rect.width < 44 || rect.height < 44);
          }).map(control=>control.getAttribute('aria-label') || control.textContent),
        };
      });
      expect(layout.overflow).toBeLessThanOrEqual(1);
      expect(layout.pageOverflow).toBeLessThanOrEqual(1);
      expect(layout.left).toBeGreaterThanOrEqual(0);
      expect(layout.right).toBeLessThanOrEqual(width);
      expect(layout.columns).toBe(width <= 360 ? 3 : width <= 480 ? 4 : 5);
      expect(layout.smallTargets).toEqual([]);
      await page.getByRole('button', {name:'Close icon picker',exact:true}).click();
      await page.getByRole('button', {name:'Close editor',exact:true}).click();
      await expect(page.locator('.draft-visual .expense-icon-trigger')).toHaveAttribute('aria-label', /Automatic: Meals · Orange/);
      await page.getByRole('button', {name:'Review',exact:true}).click();
      await page.getByRole('button', {name:'Save expense',exact:true}).click();
      await expect(page.locator('.editor')).toHaveCount(0);
      await page.goto('/expenses');
      await expect(page.locator('.expense .expense-icon-trigger')).toHaveAttribute('aria-label', /Automatic: Meals · Orange/);
      await page.locator('.expense-open').click();
      await expect(page.locator('.editor .expense-icon-trigger')).toHaveAttribute('aria-label', /Automatic: Meals · Orange/);
      await page.getByRole('textbox', {name:'Expense name',exact:true}).fill('Taxi home');
      await expect(page.locator('.editor .expense-icon-trigger')).toHaveAttribute('aria-label', /Automatic: Taxi & car · Blue/);
    });
  });
}
