import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { validateLedger, type Draft, type Trip } from '../../lib/model';
import { receiptScanFingerprint } from '../../lib/receipt-scan';

const photo = path.resolve('tests/fixtures/receipts/v1/images/long-receipt.png');
const base: Trip = { id: 'confirm-trip', ownerId: 'owner', name: 'Vienna', currency: 'EUR',
  members: [{ id: 'gary', name: 'Gary', userId: 'owner' }, { id: 'sam', name: 'Sam' }], expenses: [], drafts: [], payments: [] };
const proposal = (overrides: Partial<Draft> = {}): Draft => ({ id: 'confirm-draft', receiptId: 'photo', title: 'Coffee and cake',
  date: '2026-10-08', time: '12:00', timezone: 'Europe/Vienna', currency: 'EUR', payer: 'gary', source: 'ai', status: 'review',
  tax: 0, tip: 0, discount: 0, fieldSources: { title: 'ai', date: 'ai', time: 'ai', timezone: 'ai', currency: 'ai' },
  items: [{ id: 'coffee', name: 'Coffee', amount: 4210, members: [] }],
  receiptScan: { version: 1, printedCurrency: 'EUR', printedTotal: 4210, status: 'matched', warnings: [] }, ...overrides });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

async function fixtures(page: Page, options: { draft?: Draft; scan?: Partial<Draft>; holdScan?: Promise<void>; holdUpload?: (index: number) => Promise<void>; holdSave?: Promise<void>; rejectSave?: boolean; holdDraftSave?: Promise<void>; rejectDraftSave?: boolean } = {}) {
  let current = structuredClone(base), revision = 1, uploads = 0, scans = 0, posts = 0, draftPosts = 0;
  let rejectDraftSave = !!options.rejectDraftSave;
  if (options.draft) current.drafts.push(options.draft);
  await page.addInitScript(() => {
    const clicks: string[] = []; Object.defineProperty(window, '__expenseClicks', { value: clicks });
    document.addEventListener('click', event => {
      const target = event.target as HTMLElement;
      const action = target.closest('button, label.receipt-capture-action');
      if (action) clicks.push(action.textContent?.trim().replace(/\s+/g, ' ') || '');
    }, true);
  });
  await page.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (pathname === '/api/ledger' && request.method() === 'POST') {
      const body = request.postDataJSON();
      const posting = body.data.trips[0].expenses.length > current.expenses.length;
      if (posting) { posts++; await options.holdSave; }
      else if (body.data.trips[0].drafts.length > current.drafts.length) {
        draftPosts++; await options.holdDraftSave;
        if (rejectDraftSave) return route.fulfill({status:400,json:{error:'Unable to save the receipt draft.'}});
      }
      if (posting && options.rejectSave) return route.fulfill({ status: 400, json: { error: 'The server could not accept this expense.' } });
      try { current = validateLedger(body.data, { source: 'web', previous: { trips: [current] } }).trips[0]; }
      catch (error) { return route.fulfill({ status: 400, json: { error: String(error) } }); }
      return route.fulfill({ json: { data: { trips: [current] }, revision: ++revision }, headers: { 'X-TripTab-Account': 'owner' } });
    }
    if (pathname === '/api/receipt' && request.method() === 'POST') {
      const index = ++uploads; await options.holdUpload?.(index);
      return route.fulfill({ json: { receiptId: `photo-${index}` } }).catch(() => {});
    }
    if (pathname === '/api/receipt' && request.method() === 'GET') return route.fulfill({ contentType: 'image/png', path: photo });
    if (pathname === '/api/receipt/process') {
      scans++; await options.holdScan;
      const args = request.postDataJSON(), draft = current.drafts.find(value => value.id === args.draftId)!;
      Object.assign(draft, proposal(options.scan), { id: draft.id, receiptId: draft.receiptId });
      return route.fulfill({ json: { data: { trips: [current] }, revision: ++revision } });
    }
    if (pathname === '/api/fx') return route.fulfill({ json: { rate: 0.86, asOf: '2026-10-08' } });
    const json = pathname === '/api/ledger' ? { data: { trips: [current] }, revision }
      : pathname === '/api/profile' ? { id: 'owner', displayName: 'Gary', email: 'gary@example.invalid', authMethod: 'password' }
      : pathname === '/api/receipt/ai-status' ? { configured: true, connected: true, provider: 'api', eligible: true, manageable: false, siwcAvailable: false }
      : pathname === '/api/trip-language' ? { accountId: 'owner', tripId: base.id, revision: 1, preferences: { readingLanguage: 'en', primaryVersion: 'reading', itemVersions: {} } }
      : { events: [], notifications: [], items: [] };
    return route.fulfill({ json, headers: pathname === '/api/ledger' ? { 'X-TripTab-Account': 'owner' } : {} });
  });
  return { get trip() { return current; }, get uploads() { return uploads; }, get scans() { return scans; }, get posts() { return posts; }, get draftPosts() { return draftPosts; }, recoverDraftSave() { rejectDraftSave = false; } };
}
const clicks = (page: Page) => page.evaluate(() => (window as unknown as { __expenseClicks: string[] }).__expenseClicks);
async function openDraft(page: Page) { await page.goto('/expenses?receiptDraft=confirm-draft&receiptTrip=confirm-trip'); await expect(page.locator('.editor')).toBeVisible(); }
async function scan(page: Page) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Scan receipt', exact: true }).click();
  await (await chooser).setFiles(photo);
}
const save = (page: Page) => page.locator('.editor-footer').getByRole('button', { name: /^(Confirm & save expense|Save expense)$/ });

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test('manual entry has two presses and an untouched Save explains and focuses missing fields', async ({ page }) => {
  const state = await fixtures(page); await page.goto('/expenses');
  await page.getByRole('button', { name: 'Add expense', exact: true }).click();
  await expect(save(page)).toBeEnabled(); await expect(page.locator('.save-checklist')).toHaveCount(0); await save(page).click();
  const checklist = page.locator('.save-checklist');
  await expect(checklist).toHaveAttribute('role', 'group');
  await expect(page.locator('.expense-save-announcement')).toContainText('Add an expense name');
  await expect(checklist).toContainText('Add an expense name'); await expect(checklist).toContainText('Enter the amount');
  await expect(page.getByRole('textbox', { name: 'Expense name', exact: true })).toBeFocused();
  expect(state.posts).toBe(0);
  await page.evaluate(() => { (window as unknown as { __expenseClicks: string[] }).__expenseClicks.splice(1); });
  await page.getByRole('textbox', { name: 'Expense name', exact: true }).fill('Taxi');
  await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('12.50');
  await save(page).click(); await expect(page.locator('.editor')).toHaveCount(0);
  expect(await clicks(page)).toEqual(['Add expense', 'Save expense']); expect(state.posts).toBe(1);
});

test('Scan receipt starts reading and a clean scan needs only allocation and the footer Save', async ({ page }) => {
  const state = await fixtures(page); await page.goto('/expenses'); await scan(page);
  await expect(page.getByRole('textbox', { name: 'Item 1 name', exact: true })).toHaveValue('Coffee');
  await expect(page.getByRole('button', { name: 'Save expense now' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Share the remaining item equally', exact: true }).click();
  await expect(page.locator('.editor button[type=submit], .editor-footer .primary')).toHaveCount(1);
  await save(page).click(); await expect(page.locator('.editor')).toHaveCount(0);
  expect(await clicks(page)).toEqual(['Scan receipt', 'Share the remaining item equally', 'Save expense']);
  expect(state.uploads).toBe(1); expect(state.scans).toBe(1); expect(state.posts).toBe(1);
});

test('inbox upload starts on image selection and an allocated clean scan takes three presses', async ({ page }) => {
  const state = await fixtures(page, { scan: { items: [{ id: 'coffee', name: 'Coffee', amount: 4210, members: ['gary'] }] } });
  await page.goto('/receipts'); await page.getByRole('button', { name: 'Add receipt', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a receipt' });
  const chooser = page.waitForEvent('filechooser'); await dialog.getByText('Choose image', { exact: true }).click();
  await (await chooser).setFiles(photo); await expect(dialog).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Item 1 name', exact: true })).toHaveValue('Coffee');
  await save(page).click(); await expect(page.locator('.editor')).toHaveCount(0);
  expect(await clicks(page)).toEqual(['Add receipt', 'Choose image', 'Save expense']); expect(state.posts).toBe(1);
});

test('an allocated saved draft takes Review and Save', async ({ page }) => {
  const state = await fixtures(page, { draft: proposal({ items: [{ id: 'coffee', name: 'Coffee', amount: 4210, members: ['gary'] }] }) });
  await page.goto('/receipts'); await page.getByRole('button', { name: 'Review', exact: true }).click();
  await save(page).click(); await expect(page.locator('.editor')).toHaveCount(0);
  expect(await clicks(page)).toEqual(['Review', 'Save expense']); expect(state.posts).toBe(1);
});

for (const edits of [false, true]) test(`one confirmation covers ambiguous currency, missing total and uncertain lines${edits ? ' after edits' : ''}`, async ({ page }) => {
  const draft = proposal({ receiptScan: { version: 1, printedTotal: null, printedCurrency: 'EUR', status: 'incomplete', warnings: [{ code: 'ambiguous-currency' }] },
    items: [{ id: 'coffee', name: 'Coffee', amount: 4210, members: ['gary'], scanSource: { confidence: 'low', observedText: 'Coffee 42.10', lineIndex: 0 } }] });
  const state = await fixtures(page, { draft }); await openDraft(page);
  const summary = page.getByRole('region', { name: 'Confirm when saving' });
  await expect(summary).toContainText('Currency read as EUR'); await expect(summary).toContainText('Printed total not readable');
  await expect(page.getByRole('combobox', { name: 'Currency', exact: true })).toBeVisible();
  await expect(page.locator('.receipt-scan-review input[type=checkbox]')).toHaveCount(0);
  await expect(summary.getByRole('button', {name:/I checked|Confirm/})).toHaveCount(0);
  if (edits) {
    // A one-line receipt shows its line's price as the single amount.
    await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('43.10');
    await page.getByText('Check or correct printed totals', { exact: true }).click();
    await page.getByRole('textbox', { name: 'Printed subtotal (optional)', exact: true }).fill('43.11');
  }
  await expect(save(page)).toHaveText('Confirm & save expense');
  await save(page).click(); await expect(page.locator('.editor')).toHaveCount(0);
  const expense = state.trip.expenses[0]; expect(state.posts).toBe(1);
  expect(expense.receiptScan?.missingTotalAcknowledgement?.fingerprint).toBe(receiptScanFingerprint(expense));
  expect(expense.fieldSources?.currency).toBe('user'); expect(expense.receiptScan?.printedTotal).toBeNull();
  if (!edits) expect(await clicks(page)).toEqual(['Confirm & save expense']);
});

test('processing names only the ongoing read and cannot post incomplete incoming values', async ({ page }) => {
  const hold = deferred(); const state = await fixtures(page, { holdScan: hold.promise });
  await page.goto('/expenses'); await scan(page); await expect.poll(() => state.scans).toBe(1);
  await expect(page.locator('.save-checklist')).toHaveText(/^Reading the receipt…$/);
  await save(page).click(); await expect(page.locator('.save-checklist')).toHaveAttribute('role', 'group');
  await expect(page.locator('.expense-save-announcement')).toContainText('Reading the receipt…');
  await expect(page.locator('.save-checklist')).not.toContainText('Add at least one item');
  await expect(page.locator('.save-checklist')).not.toContainText('Choose the receipt currency'); expect(state.posts).toBe(0);
  hold.resolve(); await expect(page.getByRole('textbox', { name: 'Item 1 name', exact: true })).toHaveValue('Coffee');
});

test('all hard blockers are revealed together and never accepted by confirmation', async ({ page }) => {
  const state = await fixtures(page, { draft: proposal({ receiptScan: { version: 1, printedTotal: null, printedCurrency: 'GBP', status: 'incomplete', warnings: [{ code: 'ambiguous-currency' }] },
    items: [{ id: 'coffee', name: '', amount: null, members: [] }] }) });
  await openDraft(page); await save(page).click(); const list = page.locator('.save-checklist');
  for (const message of ['Enter 1 unreadable price', 'Name 1 item', 'Match the currency', 'Choose who shares 1 item']) await expect(list).toContainText(message);
  await expect(list).toHaveAttribute('role', 'group');
  await expect(page.locator('.expense-save-announcement')).toContainText('Enter 1 unreadable price'); await expect(page.getByRole('textbox', { name: 'Amount', exact: true })).toBeFocused();
  expect(state.posts).toBe(0); await expect(save(page)).toHaveText('Save expense');
  await list.getByRole('button', { name: /Match the currency/ }).click();
  await expect(page.getByRole('combobox', { name: 'Currency', exact: true })).toBeFocused();
  await list.getByRole('button', { name: /Name 1 item/ }).click();
  await expect(page.getByRole('textbox', { name: 'Item 1 name', exact: true })).toBeFocused();
});

test('rapid repeated confirmation posts once and success waits for server acceptance', async ({ page }) => {
  const hold = deferred(); const state = await fixtures(page, { holdSave: hold.promise, draft: proposal({ items: [{ id: 'coffee', name: 'Coffee', amount: 4210, members: ['gary'] }] }) });
  await openDraft(page); await save(page).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect.poll(() => state.posts).toBe(1); await expect(page.locator('.saved-banner')).toHaveCount(0);
  await expect(page.locator('.editor-footer .primary')).toBeDisabled(); hold.resolve();
  await expect(page.locator('.editor')).toHaveCount(0); await expect(page.locator('.saved-banner')).toContainText('Saved'); expect(state.posts).toBe(1);
});

test('server rejection retains the editor without a success notice', async ({ page }) => {
  const state = await fixtures(page, { rejectSave: true, draft: proposal({ items: [{ id: 'coffee', name: 'Coffee', amount: 4210, members: ['gary'] }] }) });
  await openDraft(page); await save(page).click(); await expect(page.locator('.editor .error')).toContainText('The server could not accept this expense');
  await expect(page.locator('.editor')).toBeVisible(); await expect(page.locator('.saved-banner')).toHaveCount(0); expect(state.posts).toBe(1); expect(state.trip.expenses).toHaveLength(0);
});

test('cancelled and replaced uploads cannot open their old photos or start extra scans', async ({ page }) => {
  const first = deferred(), second = deferred();
  const state = await fixtures(page, { holdUpload: index => index === 1 ? first.promise : index === 2 ? second.promise : Promise.resolve() });
  await page.goto('/receipts'); await page.getByRole('button', { name: 'Add receipt', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a receipt' }), input = dialog.locator('input[type=file]').last();
  await dialog.getByRole('textbox', { name: /Who bought what/ }).fill('Gary had the coffee');
  await input.setInputFiles(photo); await expect.poll(() => state.uploads).toBe(1);
  await dialog.getByRole('button', { name: 'Cancel upload', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: /Who bought what/ })).toHaveValue('Gary had the coffee');
  await input.setInputFiles(photo); await expect.poll(() => state.uploads).toBe(2);
  await input.setInputFiles(photo); await expect.poll(() => state.uploads).toBe(3);
  first.resolve(); second.resolve();
  await expect(dialog).toBeHidden(); await expect(page.getByRole('textbox', { name: 'Item 1 name', exact: true })).toHaveValue('Coffee');
  expect(state.scans).toBe(1); expect(state.posts).toBe(0); expect(state.trip.drafts).toHaveLength(1); expect(state.trip.drafts[0].receiptId).toBe('photo-3');
});

test('suspicious manual FX appears before Save and confirmation needs no modal', async ({ page }) => {
  const state = await fixtures(page); await page.goto('/expenses'); await page.getByRole('button', { name: 'Add expense', exact: true }).click();
  await page.getByRole('textbox', { name: 'Expense name', exact: true }).fill('Taxi'); await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('10');
  await page.getByRole('combobox', { name: 'Currency', exact: true }).selectOption('GBP');
  await expect(page.locator('.rate-result')).toContainText('Daily reference rate');
  await page.locator('.manual-rate summary').click(); await page.getByRole('spinbutton', { name: /1 GBP in EUR/ }).fill('0.98');
  await expect(page.locator('.fx-panel')).toContainText('Manual rate differs from reference by 14%');
  await expect(page.getByRole('region', { name: 'Confirm when saving' })).toContainText('Manual rate differs from reference by 14%');
  await page.locator('.manual-rate summary').click();
  const fxUrl=page.url(), fxHistory=await page.evaluate(()=>history.length);
  await page.getByRole('region',{name:'Confirm when saving'}).getByRole('button',{name:'Check rate',exact:true}).click();
  await expect(page.getByRole('spinbutton',{name:/1 GBP in EUR/})).toBeFocused();
  expect(page.url()).toBe(fxUrl); expect(await page.evaluate(()=>history.length)).toBe(fxHistory);
  await expect(save(page)).toHaveText('Confirm & save expense'); await save(page).click();
  await expect(page.locator('.editor')).toHaveCount(0); await expect(page.getByRole('dialog', { name: 'Check manual exchange rate' })).toHaveCount(0); expect(state.posts).toBe(1);
});


test('after the photo upload the draft save locks cancel, close, Escape and replacement', async ({ page }) => {
  const hold = deferred(), state = await fixtures(page, {holdDraftSave:hold.promise});
  await page.goto('/receipts'); await page.getByRole('button',{name:'Add receipt',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Add a receipt'}), input=dialog.locator('input[type=file]').last();
  await input.setInputFiles(photo); await expect.poll(()=>state.draftPosts).toBe(1);
  await expect(dialog.getByRole('status').filter({hasText:'Saving receipt…'})).toBeVisible();
  await expect(dialog.getByRole('button',{name:'Cancel upload',exact:true})).toHaveCount(0);
  await expect(dialog.getByRole('button',{name:'Close receipt upload',exact:true})).toBeDisabled();
  for(const fileInput of await dialog.locator('input[type=file]').all()) await expect(fileInput).toBeDisabled();
  await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
  // A picker result queued before the controls locked must also be ignored by the handler.
  await input.setInputFiles(photo);
  hold.resolve(); await expect(dialog).toBeHidden();
  await expect(page.getByRole('textbox',{name:'Item 1 name',exact:true})).toHaveValue('Coffee');
  expect(state.uploads).toBe(1); expect(state.draftPosts).toBe(1); expect(state.scans).toBe(1); expect(state.posts).toBe(0);
  expect(state.trip.drafts).toHaveLength(1); expect(state.trip.drafts[0].receiptId).toBe('photo-1');
});

test('a failed draft save unlocks the retained photo and notes for retry', async ({ page }) => {
  const state=await fixtures(page,{rejectDraftSave:true}); await page.goto('/receipts');
  await page.getByRole('button',{name:'Add receipt',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Add a receipt'}), input=dialog.locator('input[type=file]').last();
  await dialog.getByRole('textbox',{name:/Who bought what/}).fill('Gary had the coffee');
  await input.setInputFiles(photo); await expect(dialog.getByRole('button',{name:'Retry upload',exact:true})).toBeEnabled();
  await expect(dialog.getByRole('textbox',{name:/Who bought what/})).toHaveValue('Gary had the coffee');
  await expect(input).toBeEnabled(); await expect(dialog.getByRole('button',{name:'Close receipt upload',exact:true})).toBeEnabled();
  expect(state.trip.drafts).toHaveLength(0); expect(state.scans).toBe(0);
  state.recoverDraftSave(); await dialog.getByRole('button',{name:'Retry upload',exact:true}).click();
  await expect(dialog).toBeHidden(); await expect(page.getByRole('textbox',{name:'Item 1 name',exact:true})).toHaveValue('Coffee');
  expect(state.trip.drafts).toHaveLength(1); expect(state.scans).toBe(1); expect(state.posts).toBe(0);
  expect(state.trip.drafts[0].conversation?.[0].text).toBe('Gary had the coffee');
});

test('item evidence jumps focus the field without adding a history entry, and photo access is shared', async ({ page }) => {
  const state=await fixtures(page,{draft:proposal({receiptScan:{version:1,printedTotal:null,printedCurrency:'EUR',status:'incomplete',warnings:[{code:'ambiguous-currency'}]},items:[{id:'coffee',name:'Coffee',amount:4210,members:['gary'],scanSource:{confidence:'low'}}]})});
  await openDraft(page); const summary=page.getByRole('region',{name:'Confirm when saving'});
  // One photo affordance: the receipt's thumbnail opens the zoomable photo.
  await expect(page.getByRole('button',{name:'View receipt photo',exact:true})).toHaveCount(1);
  await expect(summary.getByRole('link')).toHaveCount(0);
  const before={url:page.url(),history:await page.evaluate(()=>history.length)};
  await summary.getByRole('button',{name:'Check Coffee',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Item 1 name',exact:true})).toBeFocused();
  expect(page.url()).toBe(before.url); expect(await page.evaluate(()=>history.length)).toBe(before.history); expect(state.posts).toBe(0);
});

test('a blocked Save announces once per press, while field edits leave the announcement untouched', async ({ page }) => {
  await fixtures(page); await page.goto('/expenses'); await page.getByRole('button',{name:'Add expense',exact:true}).click();
  await expect(page.locator('.save-checklist')).toHaveCount(0);
  await page.getByRole('textbox',{name:'Expense name',exact:true}).fill('T');
  await expect(page.locator('.save-checklist')).toHaveCount(0);
  await page.getByRole('textbox',{name:'Expense name',exact:true}).fill('');
  await save(page).click();
  const announcement=page.locator('.expense-save-announcement'); await expect(announcement).toContainText('Add an expense name');
  await page.evaluate(()=>{
    const root=document.querySelector('.expense-save-announcement')!;
    const changes:number[]=[]; Object.defineProperty(window,'__saveAnnouncements',{value:changes});
    new MutationObserver(()=>changes.push(changes.length+1)).observe(root,{subtree:true,childList:true,characterData:true});
  });
  await page.getByRole('textbox',{name:'Expense name',exact:true}).fill('Taxi');
  await expect(page.locator('.save-checklist')).not.toContainText('Add an expense name');
  await expect(page.locator('.save-checklist')).toHaveAttribute('role','group');
  expect(await page.evaluate(()=>(window as unknown as {__saveAnnouncements:number[]}).__saveAnnouncements.length)).toBe(0);
  await save(page).click(); await expect(announcement).toHaveText('Enter the amount');
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {__saveAnnouncements:number[]}).__saveAnnouncements.length)).toBe(1);
});

test('offline is explanatory text and a Save press leaves focus at Save', async ({ page }) => {
  const state=await fixtures(page); await page.goto('/expenses'); await page.getByRole('button',{name:'Add expense',exact:true}).click();
  await page.getByRole('textbox',{name:'Expense name',exact:true}).fill('Taxi'); await page.getByRole('textbox',{name:'Amount',exact:true}).fill('12');
  await page.context().setOffline(true);
  await expect(page.locator('.save-checklist')).toContainText('You’re offline. Reconnect to save');
  await expect(page.locator('.save-checklist').getByRole('button',{name:/offline/})).toHaveCount(0);
  await save(page).evaluate(button=>{(button as HTMLButtonElement).focus();(button as HTMLButtonElement).click();});
  await expect(save(page)).toBeFocused(); await expect(page.locator('.expense-save-announcement')).toContainText('You’re offline');
  expect(state.posts).toBe(0); await page.context().setOffline(false);
});
