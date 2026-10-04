import { createRequire } from 'node:module';
const require = createRequire('/opt/node22/lib/node_modules/');
let chromium; try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }
import { mkdirSync } from 'node:fs';
const S = '/tmp/claude-0/-home-user-triptab/ebdf1efa-b56e-5927-bcb2-661b41c89eb6/scratchpad/shots';
mkdirSync(S, { recursive: true });
const BASE = 'http://127.0.0.1:8787';
const out = (id, outcome, detail = '') => console.log(`[${outcome}] ${id} ${detail}`);
const run = Math.random().toString(16).slice(2, 8);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] }).catch(async () => chromium.launch({ args: ['--no-sandbox'] }));
const iphone = { viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' };
const ctx = await browser.newContext({ ...iphone, serviceWorkers: 'allow' });
const page = await ctx.newPage();
page.on('pageerror', e => out('pageerror', 'WARN', e.message.slice(0, 200)));
await page.goto(BASE);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${S}/01-landing-375.png`, fullPage: false });
const bodyText = await page.innerText('body');
out('landing-text', 'INFO', bodyText.replace(/\s+/g, ' ').slice(0, 200));

// register through UI
await page.fill('input[type=email]', `ui-${run}@example.com`).catch(() => {});
const nameField = page.locator('input[autocomplete=nickname]').first();
if (await nameField.count()) await nameField.fill('Uma');
await page.fill('input[type=password]', 'correct horse battery staple');
await page.click('button:has-text("Create account")');
await page.waitForTimeout(1500);
await page.screenshot({ path: `${S}/02-after-register-375.png` });
// create holiday
await page.click('button:has-text("Create your first holiday")').catch(async () => { await page.click('button:has-text("New holiday")'); });
await page.waitForTimeout(300);
await page.fill('input[name=name]', 'Rome');
await page.fill('textarea[name=members]', 'Uma, Vic, Wes');
await page.selectOption('select[name=currency]', 'GBP');
await page.screenshot({ path: `${S}/03-create-holiday-375.png` });
await page.click('button:has-text("Create holiday")');
await page.waitForTimeout(1200);
await page.screenshot({ path: `${S}/04-trip-375.png`, fullPage: true });

// Horizontal overflow check on main screens
const overflow = async name => { const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })); out(`overflow-${name}`, o.sw > o.cw ? 'OVERFLOW' : 'OK', JSON.stringify(o)); };
await overflow('trip');

// Touch target sizes for primary controls
const small = await page.evaluate(() => [...document.querySelectorAll('button, a, input, select, summary, [role=tab]')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44); }).map(e => `${e.tagName.toLowerCase()}:${(e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 24)}:${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`));
out('touch-targets<44px(trip screen)', small.length ? 'WARN' : 'OK', small.slice(0, 12).join(' | '));

// add expense
await page.click('button:has-text("Add expense")');
await page.waitForTimeout(500);
await page.screenshot({ path: `${S}/05-add-expense-375.png`, fullPage: false });
await page.fill('input[placeholder="Dinner by the harbour"]', 'Dinner');
await page.fill('input[aria-label="Item 1 name"]', 'Pizza');
await page.fill('input[aria-label="Item 1 total"]', '10.00');
await page.waitForTimeout(300);
const preview = await page.innerText('.split-preview');
out('split-preview-£10/3', 'INFO', preview.replace(/\s+/g, ' '));
await page.screenshot({ path: `${S}/06-expense-filled-375.png`, fullPage: false });
// scroll to footer: is Save visible without scrolling the page (sticky)?
const saveBox = await page.locator('button:has-text("Save expense")').boundingBox();
out('save-button-in-viewport', saveBox && saveBox.y + saveBox.height <= 667 ? 'VISIBLE' : 'BELOW FOLD', JSON.stringify(saveBox));
// manual FX rate typing bug check
await page.selectOption('select >> nth=1', 'EUR').catch(() => {});
const curSel = page.locator('label:has-text("Original currency") select');
await curSel.selectOption('EUR');
await page.waitForTimeout(300);
await page.locator('details.manual-rate summary').click();
const rateInput = page.locator('details.manual-rate input[type=number]');
await rateInput.click();
await page.keyboard.type('0.85', { delay: 80 });
const typed = await rateInput.inputValue();
out('manual-rate-type-0.85', typed === '0.85' ? 'OK' : 'BUG', `input value after typing "0.85" = "${typed}"`);
await rateInput.fill('');
await page.keyboard.type('.85', { delay: 80 });
out('manual-rate-type-.85', 'INFO', `value="${await rateInput.inputValue()}"`);
await rateInput.fill('0.85');
out('manual-rate-fill-0.85(paste-like)', 'INFO', `value="${await rateInput.inputValue()}"`);
await page.screenshot({ path: `${S}/07-fx-375.png`, fullPage: false });
// FX lookup offline provider failure (sandbox may block)
await page.click('button:has-text("Look up historical rate")');
await page.waitForTimeout(2500);
out('fx-lookup-result', 'INFO', (await page.locator('.fx-panel').innerText()).replace(/\s+/g, ' ').slice(0, 260));
await rateInput.fill('0.85');
await page.waitForTimeout(200);
await page.locator('button:has-text("Save expense")').click();
await page.waitForTimeout(1200);
await page.screenshot({ path: `${S}/08-expense-saved-375.png`, fullPage: true });
out('expense-row', 'INFO', (await page.locator('.expense').first().innerText()).replace(/\s+/g, ' '));

// Balances tab
await page.click('[role=tab]:has-text("Balances")');
await page.waitForTimeout(400);
await page.screenshot({ path: `${S}/09-balances-375.png`, fullPage: true });
out('balances-view', 'INFO', (await page.locator('section[role=tabpanel]').innerText()).replace(/\s+/g, ' ').slice(0, 300));
// Is there any way to record a custom/partial payment?
const hasManualPayment = await page.locator('section[role=tabpanel] input, section[role=tabpanel] select').count();
out('manual/partial-payment-control', hasManualPayment ? 'PRESENT' : 'ABSENT', '');
// Record paid -> check for confirmation dialog
let dialogSeen = false; page.on('dialog', d => { dialogSeen = true; d.dismiss(); });
await page.click('button:has-text("Record paid")');
await page.waitForTimeout(1000);
out('record-paid-confirmation', dialogSeen || (await page.locator('[role=alertdialog],[role=dialog]').count()) ? 'CONFIRMS' : 'NO CONFIRMATION (single tap writes payment)', '');
await page.screenshot({ path: `${S}/10-after-record-paid-375.png`, fullPage: true });
// Undo payment without confirmation
await page.click('button[aria-label="Undo recorded payment"]');
await page.waitForTimeout(800);
out('undo-payment-confirmation', dialogSeen || (await page.locator('[role=alertdialog]').count()) ? 'CONFIRMS' : 'NO CONFIRMATION', `payments remaining: ${await page.locator('.payment').count()}`);

// delete expense without confirm
await page.click('[role=tab]:has-text("Expenses")');
await page.locator('.expense').first().click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${S}/11-edit-expense-375.png`, fullPage: false });
await page.click('button:has-text("Delete")');
await page.waitForTimeout(900);
out('delete-expense-confirmation', (await page.locator('.expense').count()) === 0 ? 'NO CONFIRMATION (deleted immediately)' : 'CONFIRMS/not deleted', '');

// Member add + duplicate names + no remove
await page.click('[role=tab]:has-text("Travellers")');
await page.fill('input[aria-label="New traveller name"]', 'Uma');
await page.click('.add-member button');
await page.waitForTimeout(800);
out('duplicate-member-name', (await page.locator('.member').count()) === 4 ? 'ALLOWED (two "Uma")' : 'BLOCKED', '');
out('remove/rename-member-control', (await page.locator('text=/remove|rename|leave/i').count()) ? 'PRESENT' : 'ABSENT', '');
await page.screenshot({ path: `${S}/12-travellers-375.png`, fullPage: true });

// Offline behaviour
await ctx.setOffline(true);
await page.waitForTimeout(500);
out('offline-banner', (await page.locator('.connection-banner').count()) ? 'SHOWN' : 'NOT SHOWN', '');
await page.click('[role=tab]:has-text("Expenses")');
await page.click('button:has-text("Add expense")');
await page.fill('input[placeholder="Dinner by the harbour"]', 'Offline taxi');
await page.fill('input[aria-label="Item 1 name"]', 'Taxi');
await page.fill('input[aria-label="Item 1 total"]', '20.00');
await page.click('button:has-text("Save expense")');
await page.waitForTimeout(1500);
out('offline-save-feedback', 'INFO', (await page.locator('.error').first().innerText().catch(() => 'no error shown')).replace(/\s+/g, ' '));
out('editor-still-open-with-data', (await page.locator('input[placeholder="Dinner by the harbour"]').inputValue().catch(() => '')) === 'Offline taxi' ? 'YES (data kept)' : 'NO', '');
await page.screenshot({ path: `${S}/13-offline-save-375.png`, fullPage: false });
await ctx.setOffline(false);
await page.waitForTimeout(500);
await page.click('button:has-text("Save expense")');
await page.waitForTimeout(1500);
out('online-retry-save', (await page.locator('.expense').count()) === 1 ? 'SAVED' : 'NOT SAVED', '');

// Offline navigation (reload) -> offline page?
await ctx.setOffline(true);
const resp = await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' }).catch(e => ({ err: e.message }));
out('offline-reload', 'INFO', (await page.innerText('body').catch(() => 'n/a')).replace(/\s+/g, ' ').slice(0, 160));
await ctx.setOffline(false);

// Large phone + small phone screenshots
for (const [name, w, h] of [['small-320x568', 320, 568], ['large-430x932', 430, 932], ['landscape-667x375', 667, 375]]) {
  await page.setViewportSize({ width: w, height: h });
  await page.goto(BASE); await page.waitForTimeout(1200);
  await page.screenshot({ path: `${S}/20-${name}.png`, fullPage: true });
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  out(`overflow-${name}`, o.sw > o.cw ? 'OVERFLOW' : 'OK', JSON.stringify(o));
}
// open editor at small phone to see keyboard-less layout
await page.setViewportSize({ width: 320, height: 568 });
await page.click('button:has-text("Add expense")'); await page.waitForTimeout(500);
await page.screenshot({ path: `${S}/21-editor-320.png` });
const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, modal: (() => { const m = document.querySelector('.modal.editor'); const r = m?.getBoundingClientRect(); return r ? { w: Math.round(r.width), h: Math.round(r.height) } : null; })() }));
out('editor-320', 'INFO', JSON.stringify(o));
await browser.close();
