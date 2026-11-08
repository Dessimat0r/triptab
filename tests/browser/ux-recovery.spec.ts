import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { applyReceiptTranscription } from '../../lib/receipt-ai';
import { shares, validateLedger, type Ledger, type Trip } from '../../lib/model';
import { createReceiptFlowWorker, receiptFlowImage } from '../helpers/receipt-flow-worker';

const image = path.resolve('tests/fixtures/receipts/v1/images/long-receipt.png');
const members = ['Alex', 'Sam', 'Jo'].map((name, index) => ({ id: `ux-p${index}`, name, ...(index === 0 ? { userId: 'ux-owner' } : {}) }));
const empty: Trip = { id: 'ux-holiday', ownerId: 'ux-owner', name: 'Weekend', currency: 'GBP', members, expenses: [], payments: [], drafts: [] };

for (const width of [320, 390, 1440]) test(`checkout without merchant/date: ten items split automatically at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
  let data: Ledger = { trips: [structuredClone(empty)] }, revision = 1;
  let scans = 0;
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.pathname === '/api/receipt' && req.method() === 'GET') return route.fulfill({ path: image, contentType: 'image/png' });
    if (url.pathname === '/api/receipt' && req.method() === 'POST') return route.fulfill({ json: { receiptId: 'ux-checkout-image' } });
    if (url.pathname === '/api/ledger' && req.method() === 'POST') {
      const next = req.postDataJSON().data as Ledger;
      for (const value of next.trips) { value.ownerId = 'ux-owner'; value.members[0].userId = 'ux-owner'; }
      data = validateLedger(next, { previous: data }); revision++;
    }
    if (url.pathname === '/api/receipt/process') {
      scans++;
      const { tripId, draftId } = req.postDataJSON(), value = data.trips.find(trip => trip.id === tripId)!;
      const draft = value.drafts.find(draft => draft.id === draftId)!;
      expect(draft.conversation?.[0].text).toBe('Split equally. This is a checkout screenshot.');
      const result = applyReceiptTranscription(value, draft, { title: null, date: null, time: null, currency: 'GBP', tax: 0, tip: 0, discount: 0, printedTotal: 10010,
        summary: 'Ten checkout items; merchant and purchase date are not shown.',
        items: Array.from({ length: 10 }, (_, index) => ({ id: null, name: `Checkout item ${index + 1}`, amount: 1001 })) });
      value.drafts = [result]; revision++;
    }
    const json = url.pathname === '/api/ledger' || url.pathname === '/api/receipt/process' ? { data, revision }
      : url.pathname === '/api/profile' ? { id: 'ux-owner', displayName: 'Alex', email: 'ux@example.invalid', authMethod: 'password' }
      : url.pathname === '/api/receipt/ai-status' ? { configured: true, connected: true, provider: 'api', eligible: true, manageable: false, siwcAvailable: false }
      : url.pathname === '/api/trip-language' ? { accountId: 'ux-owner', tripId: url.searchParams.get('tripId'), revision: 1, preferences: { readingLanguage: 'en', primaryVersion: 'reading', itemVersions: {} } }
      : { events: [], notifications: [], people: [], items: [], invitations: [] };
    await route.fulfill({ json, headers: url.pathname === '/api/ledger' ? { 'X-TripTab-Account': 'ux-owner' } : {} });
  });
  await page.goto('/expenses');
  if (width < 901) await page.getByRole('button', { name: 'Open holidays', exact: true }).click();
  await page.getByRole('button', { name: 'Split a bill', exact: true }).click();
  const start = page.getByRole('dialog', { name: 'Split a bill', exact: true });
  await start.getByRole('textbox', { name: "Who's splitting?" }).fill('Sam,Jo');
  await page.screenshot({ path: info.outputPath(`add-bill-${width}.png`) });
  await start.getByText('Add a note for the split', { exact: true }).click();
  await start.getByRole('textbox', { name: 'Split notes' }).fill('Split equally. This is a checkout screenshot.');
  const chooser = page.waitForEvent('filechooser'); await start.getByRole('button', { name: 'Scan receipt', exact: true }).click(); await (await chooser).setFiles(image);
  await expect(page.locator('.editor .items .item')).toHaveCount(10);
  await expect(page.locator('.quick-split')).toHaveCount(0);
  await expect(page.locator('.save-checklist')).toHaveCount(0);
  await expect(page.locator('.purchase-details')).not.toHaveAttribute('open', '');
  await expect(page.locator('.expense-shares')).toContainText('Alex');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.locator('.editor').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: info.outputPath(`split-bill-${width}.png`) });
  await page.getByRole('button', { name: 'Save expense', exact: true }).click();
  await expect(page.locator('.editor')).toHaveCount(0);
  const bill = data.trips.find(trip => trip.kind === 'bill')!;
  expect(bill.expenses[0].items).toHaveLength(10);
  expect(bill.expenses[0].items.every(item => item.members.length === 3)).toBe(true);
  expect(shares(bill.expenses[0], bill.members).reduce((sum, amount) => sum + amount)).toBe(10010);
  expect(scans).toBe(1);
  if (width === 390) {
    await page.locator('.expense-open').click();
    const row = page.locator('.item').first();
    await row.locator('.item-edit > summary').click();
    await row.getByRole('button', { name: 'Alex', exact: true }).click();
    await row.getByRole('button', { name: 'Jo', exact: true }).click();
    await page.getByRole('group', { name: 'Split equally between', exact: true }).getByRole('button', { name: 'Jo', exact: true }).click();
    await expect(row.getByRole('button', { name: 'Sam', exact: true })).toHaveAttribute('aria-pressed','true');
    await expect(row.getByRole('button', { name: 'Alex', exact: true })).toHaveAttribute('aria-pressed','false');
    await page.getByRole('button', { name: 'Save expense', exact: true }).click();
    await expect(page.locator('.editor')).toHaveCount(0);
    const current = data.trips.find(value => value.id === bill.id)!;
    expect(current.expenses[0].items[0].members).toEqual([current.members[1].id]);
    expect(current.expenses[0].items.slice(1).every(item => item.members.length === 2)).toBe(true);
    await page.getByRole('button', { name: 'Bill options', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Bill options', exact: true }).click();
    await page.getByRole('dialog', { name: 'Bill options' }).getByRole('button', { name: 'People', exact: true }).click();
    await page.getByRole('textbox', { name: 'New person name' }).fill('Kim');
    await page.getByRole('dialog', { name: 'People', exact: true }).getByRole('button', { name: 'Add', exact: true }).click();
    await expect.poll(() => data.trips.find(value => value.id === bill.id)!.members.length).toBe(4);
    const expanded = data.trips.find(value => value.id === bill.id)!;
    expect(expanded.expenses[0].items[0].members).toEqual([current.members[1].id]);
    expect(expanded.expenses[0].items.slice(1).every(item => item.members.includes(expanded.members[3].id))).toBe(true);
    await page.getByRole('button', { name: 'Close people' }).click();
    await page.locator('.expense-open').click();
    await page.getByRole('button', { name: 'Split all equally', exact: true }).click();
    await page.getByRole('dialog', { name: 'Split all equally?' }).getByRole('button', { name: 'Split all equally', exact: true }).click();
    await page.getByRole('button', { name: 'Save expense', exact: true }).click();
    await expect(page.locator('.editor')).toHaveCount(0);
    expect(data.trips.find(value => value.id === bill.id)!.expenses[0].items.every(item => item.members.length === 3 && item.splitMode === 'default')).toBe(true);
  }
});

type Flow = Awaited<ReturnType<typeof createReceiptFlowWorker>>;
type Gate = { closing: boolean; inflight: Set<Promise<unknown>> };
async function routeWorker(page: Page, flow: Flow) {
  const gate: Gate = { closing: false, inflight: new Set() };
  await page.route('**/api/**', async route => {
    if (gate.closing) return route.abort('aborted');
    const work = (async () => {
    const req = route.request(), url = new URL(req.url());
    const headers = Object.fromEntries(Object.entries(req.headers()).filter(([key]) => !['host','cookie','content-length','if-none-match','if-modified-since'].includes(key)));
    headers.cookie = `tt_session=${flow.sessionToken}`; if (headers.origin) headers.origin = flow.origin;
    const response = await flow.worker.dispatchFetch(flow.origin + url.pathname + url.search, { method: req.method(), headers,
      body: ['GET','HEAD'].includes(req.method()) ? undefined : req.postDataBuffer() ?? undefined } as never);
    if (response.status === 404 && (await response.clone().text()) === 'Not found') return route.fulfill({ json: { events: [], notifications: [], people: [], items: [], invitations: [], trips: [] } });
    await route.fulfill({ status: response.status, headers: Object.fromEntries([...response.headers].filter(([key]) => !['content-encoding','content-length','set-cookie'].includes(key))), body: Buffer.from(await response.arrayBuffer()) });
    })();
    gate.inflight.add(work);
    try { await work; } finally { gate.inflight.delete(work); }
  });
  return gate;
}
async function closeWorker(page: Page, flow: Flow, gate?: Gate) {
  if (gate) {
    gate.closing = true;
    while (gate.inflight.size) await Promise.allSettled([...gate.inflight]);
  }
  // Close the page before disposing the Worker, without unrouting a live
  // fallback chain. This is the repository's established R14 teardown order.
  await page.close();
  await flow.dispose();
}

test.describe('bill deletion against production API, SQL, revision and audit code', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('real touch swipe and keyboard menu both delete the right bill, persist after refresh, and Undo restores', async ({ page, browserName }, info) => {
    const flow = await createReceiptFlowWorker();
    let gate: Gate | undefined;
    try {
      const snapshot = await flow.readLedger(), base = snapshot.data.trips[0];
      const bills: Trip[] = ['swipe','menu','photo'].map(id => ({ ...base, id: `ux-${id}`, kind: 'bill', name: `UX ${id}`, drafts: [], payments: [], expenses: [] }));
      const saved = await flow.browserRequest('/api/ledger', { method: 'POST', body: JSON.stringify({ ...snapshot, data: { trips: [...snapshot.data.trips, ...bills] } }) });
      expect(saved.status).toBe(200);
      const upload = await flow.browserRequest('/api/receipt?tripId=ux-photo', { method: 'POST', headers: { 'content-type': 'image/png' }, body: receiptFlowImage as never });
      const { receiptId } = await upload.json() as { receiptId: string };
      const before = await flow.readLedger(); before.data.trips.find(trip => trip.id === 'ux-photo')!.billPhotoId = receiptId;
      expect((await flow.browserRequest('/api/ledger', { method: 'POST', body: JSON.stringify(before) })).status).toBe(200);
      gate = await routeWorker(page, flow); await page.goto('/expenses');
      await page.getByRole('button', { name: 'Open holidays', exact: true }).click();
      const row = page.locator('.bill-drawer-row').filter({ has: page.locator('[data-bill-id="ux-swipe"]') });
      const box = (await row.boundingBox())!, x = box.x + box.width - 35, y = box.y + box.height / 2;
      if (browserName === 'chromium') {
        const touch = await page.context().newCDPSession(page);
        await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        for (const distance of [15,35,65,100,125]) await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x-distance, y }] });
        await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await touch.detach();
      } else {
        for (const [type, distance] of [['pointerdown',0],['pointermove',15],['pointermove',65],['pointermove',125],['pointerup',125]] as const) await row.dispatchEvent(type, { pointerType: 'touch', pointerId: 7, clientX: x-distance, clientY: y, bubbles: true });
      }
      await expect(row.getByRole('button', { name: 'Delete bill', exact: true })).toBeVisible();
      expect((await flow.readLedger()).data.trips.some(trip => trip.id === 'ux-swipe')).toBe(true);
      await page.screenshot({ path: info.outputPath('drawer-swipe-delete.png') });
      await row.getByRole('button', { name: 'Delete bill', exact: true }).click();
      await page.getByRole('dialog', { name: 'Delete this bill?' }).getByRole('button', { name: 'Delete bill', exact: true }).click();
      await expect.poll(async () => (await flow.readLedger()).data.trips.some(trip => trip.id === 'ux-swipe')).toBe(false);
      await page.reload(); await page.getByRole('button', { name: 'Open holidays', exact: true }).click();
      await expect(page.locator('[data-bill-id="ux-swipe"]')).toHaveCount(0);
      await page.getByRole('button', { name: 'Actions for UX menu', exact: true }).press('Enter');
      await page.getByRole('menuitem', { name: 'Delete bill', exact: true }).press('Enter');
      await page.getByRole('dialog', { name: 'Delete this bill?' }).getByRole('button', { name: 'Delete bill', exact: true }).click();
      await expect.poll(async () => (await flow.readLedger()).data.trips.some(trip => trip.id === 'ux-menu')).toBe(false);
      await page.locator('.saved-banner').getByRole('button', { name: 'Undo', exact: true }).click();
      await expect.poll(async () => (await flow.readLedger()).data.trips.some(trip => trip.id === 'ux-menu')).toBe(true);
      await page.getByRole('button', { name: 'Open holidays', exact: true }).click();
      await page.getByRole('button', { name: 'Actions for UX photo', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Delete bill', exact: true }).click();
      await page.getByRole('dialog', { name: 'Delete this bill?' }).getByRole('button', { name: 'Delete bill', exact: true }).click();
      await expect.poll(async () => (await flow.readLedger()).data.trips.some(trip => trip.id === 'ux-photo')).toBe(false);
      const history = await flow.database.prepare("SELECT trip_id FROM activity_events WHERE action='delete' AND entity_type='trip' ORDER BY sequence").all<{ trip_id: string }>();
      expect(history.results.map(event => event.trip_id)).toEqual(['ux-swipe','ux-menu','ux-photo']);
      expect((await flow.readLedger()).data.trips.some(trip => trip.id === base.id)).toBe(true);
      expect(await flow.database.prepare('SELECT id FROM receipts WHERE id=?').bind(receiptId).first()).toBeTruthy();
    } finally { await closeWorker(page, flow, gate); }
  });
  test('shared bill offers archive directly; a rejected delete keeps the bill and shows no success', async ({ page }) => {
    const flow = await createReceiptFlowWorker();
    let gate: Gate | undefined;
    try {
      const snapshot = await flow.readLedger(), base = snapshot.data.trips[0];
      const shared: Trip = { ...base, id: 'ux-shared', kind: 'bill', name: 'UX shared' };
      const failed: Trip = { ...base, id: 'ux-failed', kind: 'bill', name: 'UX failed' };
      expect((await flow.browserRequest('/api/ledger', { method: 'POST', body: JSON.stringify({ ...snapshot, data: { trips: [...snapshot.data.trips, shared, failed] } }) })).status).toBe(200);
      await flow.database.batch([
        flow.database.prepare('INSERT INTO profiles(id,email,display_name,created_at) VALUES(?,?,?,?)').bind('ux-sam','ux-sam@example.test','Sam',new Date().toISOString()),
        flow.database.prepare('INSERT INTO memberships(trip_id,user_id,member_id) VALUES(?,?,?)').bind(shared.id,'ux-sam','bob'),
      ]);
      gate = await routeWorker(page, flow);
      // Simulate an authoritative refusal, then a malformed success response.
      // Neither may remove a row or report a successful deletion.
      let malformed = false;
      await page.route('**/api/trip', async route => {
        if (route.request().method() !== 'POST' || route.request().postDataJSON().tripId !== failed.id) return route.fallback();
        await route.fulfill(malformed ? { json: { ok: true } } : { status: 403, json: { error: 'You no longer have permission to delete this bill.' } });
      });
      await page.goto('/expenses');
      for (const message of ['You no longer have permission', 'Deletion was not confirmed']) {
        await page.getByRole('button', { name: 'Open holidays', exact: true }).click();
        await page.getByRole('button', { name: 'Actions for UX failed', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Delete bill', exact: true }).click();
        await page.getByRole('dialog', { name: 'Delete this bill?' }).getByRole('button', { name: 'Delete bill', exact: true }).click();
        await expect(page.getByText(new RegExp(message))).toBeVisible();
        await expect(page.locator('[data-bill-id="ux-failed"]')).toHaveCount(1);
        await expect(page.locator('.saved-banner')).toHaveCount(0);
        expect((await flow.readLedger()).data.trips.some(trip => trip.id === failed.id)).toBe(true);
        await page.getByRole('button', { name: 'Close holiday menu' }).click();
        malformed = true;
      }
      await page.getByRole('button', { name: 'Open holidays', exact: true }).click();
      await page.getByRole('button', { name: 'Actions for UX shared', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Delete bill', exact: true }).click();
      const policy = page.getByRole('dialog', { name: 'Keep the shared bill’s records' });
      await expect(policy).toContainText('does not settle or change anyone’s balance');
      await policy.getByRole('button', { name: 'Remove from my list', exact: true }).click();
      await expect.poll(async () => (await flow.readLedger()).data.trips.some(trip => trip.id === shared.id)).toBe(false);
      const stored = await flow.database.prepare('SELECT owner FROM trips WHERE id=?').bind(shared.id).first<{ owner: string }>();
      expect(stored?.owner).toBe(flow.owner.id);
      expect(await flow.database.prepare('SELECT user_id FROM memberships WHERE trip_id=? AND user_id=?').bind(shared.id,'ux-sam').first()).toBeTruthy();
      await expect(page.locator('.saved-banner')).toHaveCount(0);
    } finally { await closeWorker(page, flow, gate); }
  });
});
