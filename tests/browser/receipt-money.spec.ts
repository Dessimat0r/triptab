import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createReceiptOperationWorker } from '../helpers/receipt-operation-worker';
import { expenseShares, settlements, type Trip } from '../../lib/model';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
type Fixture = Awaited<ReturnType<typeof createReceiptOperationWorker>>;
type HttpCall = {
    method: string;
    path: string;
    status: number;
};
const httpCalls = new WeakMap<Fixture, HttpCall[]>();
const applicationURL = process.env.TRIPTAB_LAYOUT_URL || 'http://127.0.0.1:8787';
const line = (lineIndex: number, observedText: string, amount: number) => ({ lineIndex, observedText, amount, kind: 'adjustment', confidence: 'high', mappedTo: 'adjustment' });
const output = (missed = false) => ({ title: 'Merchant name', currency: 'GBP', date: '2026-11-07', time: '12:00', tax: 0, tip: 0, discount: 0, printedTotal: 450, summary: 'Synthetic BOGOF',
    items: [{ id: null, name: 'Pringles A', amount: 300, scanSource: { lineIndex: 0, observedText: 'Pringles 3.00', confidence: 'high' } }, { id: null, name: 'Pringles B', amount: 300, scanSource: { lineIndex: 1, observedText: 'Pringles 3.00', confidence: 'high' } }, { id: null, name: 'Milk', amount: 150, scanSource: { lineIndex: 2, observedText: 'Milk 1.50', confidence: 'high' } }],
    sourceLines: [{ ...line(3, 'BOGOF -3.00', -300), mappedTo: missed ? 'unmapped' : 'adjustment' }], warnings: missed ? [{ code: 'unmapped-adjustment', lineIndex: 3, observedText: 'BOGOF -3.00' }] : [],
    adjustments: missed ? [] : [{ kind: 'discount', label: 'BOGOF', amount: 300, percent: null, scope: 'items', itemIndexes: [0, 1], sourceLineIndex: 3, confidence: 'high' }] });
const photo = path.resolve('tests/fixtures/receipts/v1/images/long-receipt.png');
const stored = async (f: Fixture) => JSON.parse((await f.tripRow()).data) as Trip;
async function two(browser: Browser, run: (f: Fixture, a: Page, b: Page) => Promise<void>) {
    const f = await createReceiptOperationWorker();
    const contexts: BrowserContext[] = [];
    const inflight = new Set<Promise<unknown>>();
    let closing = false;
    const calls: HttpCall[] = [];
    httpCalls.set(f, calls);
    // Preserve binary upload bytes over real HTTP. Playwright WebKit's routed
    // postDataBuffer is a separate, fallible transport and is not the app server.
    const proxy = http.createServer((req, res) => {
        if (closing) {
            res.statusCode = 503;
            res.end('Test teardown');
            return;
        }
        const work = (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of req)
                chunks.push(Buffer.from(chunk));
            const path = req.url!, headers = new Headers();
            for (const [key, value] of Object.entries(req.headers))
                if (value && !['host', 'content-length', 'connection', 'accept-encoding'].includes(key))
                    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
            const api = path.startsWith('/api/');
            if (api && headers.has('origin'))
                headers.set('origin', f.origin);
            const init = { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method!) ? undefined : Buffer.concat(chunks) };
            const response = api ? await f.worker.dispatchFetch(f.origin + path, init as never) : await fetch(applicationURL + path, init);
            if (api)
                calls.push({ method: req.method!, path: path.split('?')[0], status: response.status });
            const notFound = api && response.status === 404 && (await response.clone().text()) === 'Not found';
            if (notFound) {
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({ events: [], notifications: [], items: [], trips: [], people: [], invitations: [], nextCursor: null }));
                return;
            }
            res.statusCode = response.status;
            for (const [key, value] of response.headers)
                if (!['content-length', 'transfer-encoding', 'content-encoding', 'connection'].includes(key))
                    res.setHeader(key, value);
            const bytes = Buffer.from(await response.arrayBuffer());
            if (!res.destroyed)
                res.end(bytes);
        })();
        inflight.add(work);
        void work.catch(error => { console.error('Test proxy failure', String(error)); if (!res.destroyed) {
            res.statusCode = 500;
            res.end('Test proxy failed');
        } }).finally(() => inflight.delete(work));
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    try {
        const b = await f.createAccount({ id: 'browser-bob', name: 'Bob', email: 'browser-bob@example.test', session: true });
        await f.database.prepare('INSERT INTO memberships(trip_id,user_id,member_id) VALUES(?,?,?)').bind(f.tripId, 'browser-bob', 'bob').run();
        for (const token of [f.sessionToken, b.sessionToken]) {
            const c = await browser.newContext({ baseURL: origin, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
            contexts.push(c);
            await c.addCookies([{ name: 'tt_session', value: token!, url: origin }]);
        }
        await run(f, await contexts[0].newPage(), await contexts[1].newPage());
    }
    finally {
        await f.control('/__test/provider', { release: true }).catch(() => { });
        await f.control('/__test/hooks', { proceed: true, releaseSpend: true }).catch(() => { });
        closing = true;
        for (const c of contexts)
            await c.close();
        while (inflight.size)
            await Promise.allSettled([...inflight]);
        await new Promise<void>(resolve => proxy.close(() => resolve()));
        await f.dispose();
    }
}
async function allocate(page: Page, second = false) {
    const choices = second ? [['Alice'], ['Bob'], ['Bob']] : [['Alice'], ['Alice'], ['Alice', 'Bob']];
    await expect(page.locator('.items > .item')).toHaveCount(3);
    for (let i = 0; i < 3; i++) {
        await page.locator('.items > .item').nth(i).locator('.item-edit > summary').click();
        for (const name of ['Alice', 'Bob']) {
            const chip = page.locator('.items > .item').nth(i).locator('.personchips').getByRole('button', { name, exact: true });
            const wanted = choices[i].includes(name);
            if ((await chip.getAttribute('aria-pressed') === 'true') !== wanted)
                await chip.click();
            await expect(chip).toHaveAttribute('aria-pressed', String(wanted));
        }
    }
    await page.getByRole('combobox', { name: 'Paid by', exact: true }).selectOption(second ? 'alice' : 'bob');
}
const save = (page: Page) => page.locator('.editor-footer').getByRole('button', { name: /^(Confirm & save expense|Save expense)$/ });
test('Safari dialog focus does not scroll the receipt under a click; a covered input is still revealed', async ({ browser }) => {
    await two(browser, async (f, page) => {
        await f.control('/__test/provider', { output: output() });
        expect((await f.process(await f.processBody())).status).toBe(200);
        await page.goto(`/expenses?receiptDraft=op-draft&receiptTrip=${f.tripId}`);
        const dialog = page.locator('.editor');
        await page.locator('.items > .item').first().locator('.item-edit > summary').click();
        const chip = page.locator('.items > .item').first().locator('.personchips').getByRole('button', { name: 'Alice', exact: true });
        await chip.scrollIntoViewIfNeeded();
        const before = await dialog.evaluate(element => {
            const scroll = element.scrollTop;
            (element as HTMLElement).focus({ preventScroll: true });
            return scroll;
        });
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        expect(await dialog.evaluate(element => element.scrollTop)).toBe(before);
        await chip.click();
        await expect(chip).toHaveAttribute('aria-pressed', 'false');

        // Retain the original accessibility behaviour for actual inputs.
        await page.locator('.items > .item').nth(2).locator('.item-edit > summary').click();
        const input = page.getByRole('textbox', { name: 'Item 3 total', exact: true });
        await input.evaluate(element => {
            element.closest('.editor')!.scrollTop = 0;
            (element as HTMLElement).focus({ preventScroll: true });
        });
        await expect.poll(async () => input.evaluate(element => element.getBoundingClientRect().bottom
            - element.closest('.editor')!.querySelector('.editor-footer')!.getBoundingClientRect().top)).toBeLessThanOrEqual(-11);
        expect(await dialog.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    });
});

test('footer focus reveal waits for pointer release before moving a covered input', async ({ browser }) => {
    await two(browser, async (f, page) => {
        await f.control('/__test/provider', { output: output() });
        expect((await f.process(await f.processBody())).status).toBe(200);
        await page.goto(`/expenses?receiptDraft=op-draft&receiptTrip=${f.tripId}`);
        await expect(page.locator('.items > .item')).toHaveCount(3);
        await page.locator('.item-edit').nth(2).evaluate(element => { (element as HTMLDetailsElement).open = true; });
        const input = page.getByRole('textbox', { name: 'Item 3 total', exact: true });
        await expect(input).toBeVisible();
        await page.locator('.items > .item').first().locator('.item-edit > summary').click();
        const chip = page.locator('.items > .item').first().locator('.personchips').getByRole('button', { name: 'Alice', exact: true });
        await chip.scrollIntoViewIfNeeded();
        const box = (await chip.boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        const before = await page.locator('.editor').evaluate(element => element.scrollTop);
        await input.evaluate(element => (element as HTMLElement).focus({ preventScroll: true }));
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        expect(await page.locator('.editor').evaluate(element => element.scrollTop)).toBe(before);
        await page.mouse.up();
        await expect.poll(async () => input.evaluate(element => element.getBoundingClientRect().bottom
            - element.closest('.editor')!.querySelector('.editor-footer')!.getBoundingClientRect().top)).toBeLessThanOrEqual(-11);
    });
});

test('Real-route acceptance 1/6/10: optional name, real upload/process, interrupted page, BOGOF allocation, two-account balances and one operation', async ({ browser }) => {
    await two(browser, async (f, a, b) => {
        const initial = await f.readLedger();
        initial.data.trips.find(t => t.id === f.tripId)!.drafts = [];
        await f.saveLedger(initial.data, initial.revision);
        await f.control('/__test/provider', { output: output(), holdNext: 1, release: false });
        await a.goto('/expenses');
        await a.getByRole('button', { name: 'Scan receipt', exact: true }).click();
        await a.getByRole('textbox', { name: 'Expense name', exact: true }).fill('Train snacks');
        const chooser = a.waitForEvent('filechooser');
        await a.locator('.editor .receipt-capture-action').filter({ hasText: 'Scan receipt' }).click();
        await (await chooser).setFiles(photo);
        await expect.poll(async () => (await f.control('/__test/provider')).calls, { timeout: 15000 }).toBe(1);
        const waiting = (await stored(f)).drafts[0];
        expect(waiting.title).toBe('Train snacks');
        expect(waiting.fieldSources?.title).toBe('user');
        await a.goto('/receipts');
        await expect(a.locator('.draft').first()).toContainText('Reading receipt');
        await f.control('/__test/provider', { release: true });
        await expect.poll(async () => (await stored(f)).drafts[0]?.status).toBe('review');
        await expect(a.locator('.draft').first()).toContainText('Ready to review', { timeout: 15000 });
        const draft = (await stored(f)).drafts[0];
        await a.goto(`/expenses?receiptDraft=${draft.id}&receiptTrip=${f.tripId}`);
        await expect(a.getByRole('textbox', { name: 'Expense name', exact: true })).toHaveValue('Train snacks');
        await allocate(a);
        await save(a).click();
        await expect(a.locator('.editor')).toHaveCount(0);
        const t = await stored(f);
        expect(t.expenses).toHaveLength(1);
        expect(t.expenses[0].items.map(i => i.amount)).toEqual([300, 300, 150]);
        expect(t.expenses[0].receiptScan?.status).toBe('matched');
        expect(expenseShares(t.expenses[0], t.members, 'GBP')).toEqual([375, 75]);
        expect(settlements(t)).toEqual([{ from: 'alice', to: 'bob', amount: 375 }]);
        await b.goto('/balances');
        await expect(b.locator('.settlement').first()).toContainText('£3.75');
        expect((await f.control('/__test/provider')).calls).toBe(1);
        expect(await f.operations()).toHaveLength(1);
        expect((await f.operations())[0].status).toBe('stored');
    });
});
test('Real-route acceptance 2/3: missed promotion corrected by a person, second allocation saved by Alice, Bob owes exactly £3', async ({ browser }) => {
    await two(browser, async (f, a, b) => {
        await f.control('/__test/provider', { output: output(true) });
        expect((await f.process(await f.processBody())).status).toBe(200);
        await a.goto(`/expenses?receiptDraft=op-draft&receiptTrip=${f.tripId}`);
        await allocate(a, true);
        await expect(a.locator('#expense-receipt-difference')).toContainText('£3.00 difference');
        await a.getByRole('button', { name: 'Apply as discount', exact: true }).click();
        const form = a.locator('.adjustment-form');
        for (const box of await form.locator('.adjustment-items').getByRole('checkbox').all()) {
            if ((await box.locator('xpath=..').textContent())?.includes('Pringles'))
                await box.check();
        }
        await form.getByRole('button', { name: 'Add', exact: true }).click();
        await save(a).click();
        await expect(a.locator('.editor')).toHaveCount(0);
        const t = await stored(f);
        expect(expenseShares(t.expenses[0], t.members, 'GBP')).toEqual([150, 300]);
        expect(t.expenses[0].payer).toBe('alice');
        expect(t.expenses[0].adjustments?.[0].source).toBe('user');
        expect(settlements(t)).toEqual([{ from: 'bob', to: 'alice', amount: 300 }]);
        await b.goto('/balances');
        await expect(b.locator('.settlement').first()).toContainText('£3.00');
    });
});
test('Real-route acceptance 5: actual deleted financial expense restored from History with its saved photo and amounts, visible to Bob', async ({ browser }) => {
    await two(browser, async (f, a, b) => {
        const snapshot = await f.readLedger(), trip = snapshot.data.trips.find(t => t.id === f.tripId)!;
        trip.drafts = [];
        trip.expenses = [{ id: 'restore-real', title: 'Restorable dinner', date: '2026-11-07', time: '12:00', timezone: 'Europe/London', currency: 'GBP', payer: 'alice', tax: 0, tip: 100, discount: 0, receiptId: f.receiptId, items: [{ id: 'meal', name: 'Meal', amount: 2000, members: ['alice', 'bob'] }] }];
        await f.saveLedger(snapshot.data, snapshot.revision);
        const original = (await stored(f)).expenses[0];
        const removal = await f.readLedger();
        removal.data.trips.find(t => t.id === f.tripId)!.expenses = [];
        await f.saveLedger(removal.data, removal.revision);
        await a.goto('/history');
        await a.getByRole('button', { name: 'Review expense to restore', exact: true }).click();
        await save(a).click();
        await expect(a.locator('.editor')).toHaveCount(0);
        const t = await stored(f);
        expect(t.expenses).toHaveLength(1);
        expect(t.expenses[0].items).toEqual(original.items);
        expect(t.expenses[0].receiptId).toBe(f.receiptId);
        expect(t.expenses[0].tip).toBe(100);
        await b.goto('/expenses');
        await expect(b.locator('main')).toContainText('Restorable dinner');
    });
});
test('Real-route payment: real BOGOF payment posts once, persists 375, clears settlements, increments one revision and records one exact history event', async ({ browser }) => {
    await two(browser, async (f, a, b) => {
        const snapshot = await f.readLedger(), t = snapshot.data.trips.find(t => t.id === f.tripId)!;
        t.drafts = [];
        t.expenses = [{ id: 'payment-bogof', title: 'Payment BOGOF', date: '2026-11-07', time: '12:00', timezone: 'Europe/London', currency: 'GBP', payer: 'bob', tax: 0, tip: 0, discount: 0, adjustmentAllocation: 'scoped-adjustments', adjustments: [{ id: 'offer', kind: 'discount', amount: 300, scope: { type: 'items', itemIds: ['one', 'two'] } }], items: [{ id: 'one', name: 'Pringles', amount: 300, members: ['alice'] }, { id: 'two', name: 'Pringles', amount: 300, members: ['alice'] }, { id: 'milk', name: 'Milk', amount: 150, members: ['alice', 'bob'] }] }];
        await f.saveLedger(snapshot.data, snapshot.revision);
        const original = structuredClone((await stored(f)).expenses);
        await a.goto('/balances');
        await expect(a.locator('.settlement').first()).toContainText('£3.75');
        const before = await f.readLedger(), postCount = httpCalls.get(f)!.filter(c => c.method === 'POST' && c.path === '/api/ledger').length;
        await a.locator('.settlement').first().getByRole('button', { name: 'Record paid', exact: true }).click();
        await a.getByRole('button', { name: 'Review payment', exact: true }).click();
        await a.getByRole('button', { name: 'Confirm payment', exact: true }).click();
        await expect.poll(async () => (await stored(f)).payments.length).toBe(1);
        await expect(a.locator('.settlement')).toHaveCount(0);
        const paid = await stored(f);
        expect(paid.payments.map(p => ({ from: p.from, to: p.to, amount: p.amount }))).toEqual([{ from: 'alice', to: 'bob', amount: 375 }]);
        expect(paid.expenses).toEqual(original);
        expect(settlements(paid)).toEqual([]);
        expect((await f.readLedger()).revision).toBe(before.revision + 1);
        expect(httpCalls.get(f)!.filter(c => c.method === 'POST' && c.path === '/api/ledger').slice(postCount).map(c => c.status)).toEqual([200]);
        const events = (await f.database.prepare("SELECT actor_id,action,after_data FROM activity_events WHERE trip_id=? AND entity_type='payment' AND entity_id=?").bind(f.tripId, paid.payments[0].id).all<{
            actor_id: string;
            action: string;
            after_data: string;
        }>()).results;
        expect(events).toHaveLength(1);
        expect(events[0].actor_id).toBe(f.owner.id);
        expect(events[0].action).toBe('create');
        expect(JSON.parse(events[0].after_data)).toEqual(paid.payments[0]);
        await b.goto('/balances');
        await expect(b.locator('.settlement')).toHaveCount(0);
    });
});
