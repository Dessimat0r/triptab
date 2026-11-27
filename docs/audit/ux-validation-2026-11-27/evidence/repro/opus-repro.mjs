#!/usr/bin/env node
/*
 * Standalone reproductions for the independent TripTab UX validation (commit 963d7c8).
 *
 * Runs against a LOCAL production preview only (npm run build && npm start -- --port 8787),
 * creates fresh synthetic accounts, and reports for each scenario whether the defect is
 * present. It never contacts production. Run it before and after a fix:
 *
 *   node docs/audit/ux-validation-2026-11-27/evidence/repro/opus-repro.mjs [baseUrl] [outDir]
 *
 * Requires the `playwright` package and a Chromium build (any Playwright >= 1.50).
 * "defectPresent: true" means the behaviour described in the finding was observed.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const OUT = process.argv[3] || path.join(process.cwd(), 'opus-repro-output');
if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(BASE)) {
  console.error('Refusing to run: these reproductions write data and must target a local preview.');
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 };
const results = [];
const stamp = Date.now().toString(36);
const password = 'correct-horse-battery';

async function settle(page, ms = 1200) { await page.waitForTimeout(ms); }
function record(id, finding, defectPresent, details) {
  results.push({ id, finding, defectPresent, details });
  console.log(`${defectPresent ? 'DEFECT PRESENT' : 'not observed  '}  ${id}  ${finding}`);
}
async function discardOpenEditors(page) {
  for (let i = 0; i < 3; i++) {
    const confirm = page.getByRole('dialog', { name: 'Discard unsaved changes?' });
    if (await confirm.count()) { await confirm.getByRole('button', { name: 'Discard changes' }).click(); await settle(page, 300); continue; }
    const close = page.getByRole('button', { name: /^Close (editor|payment editor)$/ });
    if (await close.count()) { await close.first().click(); await settle(page, 300); continue; }
    break;
  }
}
async function signUp(page, name, email) {
  await page.goto(`${BASE}/`, { waitUntil: 'load' }); await settle(page, 1500);
  await page.getByLabel('Display name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('button', { name: 'Create your first holiday' }).waitFor({ timeout: 15000 });
}
async function createHoliday(page, name, travellers, opener) {
  await opener(); await settle(page, 700);
  const d = page.getByRole('dialog', { name: 'Create a holiday' });
  await d.getByLabel('Holiday name').fill(name);
  await d.getByRole('textbox', { name: /Travellers/ }).fill(travellers);
  await d.getByLabel('Settle in').selectOption('EUR');
  await d.getByRole('button', { name: 'Create holiday' }).click();
  await page.getByRole('heading', { level: 1, name }).waitFor({ timeout: 15000 });
}
async function addExpense(page, title, amount, before) {
  await page.getByRole('button', { name: 'Add expense', exact: true }).click(); await settle(page, 700);
  const ed = page.getByRole('dialog').first();
  await ed.getByLabel('Expense name').fill(title);
  await ed.getByLabel('Amount').fill(amount);
  if (before) await before(ed);
  return ed;
}
async function rowText(page, title) {
  const snap = await page.getByRole('group', { name: 'expenses' }).ariaSnapshot();
  return snap.split('\n').find(line => line.includes(title) && line.includes('paid')) || '';
}

(async () => {
  // Same variable as tests/browser/playwright.config.ts, for environments with a preinstalled Chromium.
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
  const ctx = await browser.newContext(PHONE);
  const page = await ctx.newPage();
  page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
  const email = `repro-${stamp}@example.test`;
  await signUp(page, 'Repro Owner', email);
  await createHoliday(page, 'Repro Trip', 'Owner, Bob, Cara', () => page.getByRole('button', { name: 'Create your first holiday' }).click());

  // TT-03: a valid, previewed discount that is not confirmed with "Add" is dropped by Save.
  try {
    const ed = await addExpense(page, 'Groceries', '60', async ed => {
      await ed.getByRole('button', { name: 'Tip, tax or discount' }).click(); await settle(page, 300);
      await ed.getByRole('button', { name: 'Add discount' }).click(); await settle(page, 300);
      const g = ed.getByRole('group', { name: 'Add discount' });
      await g.getByLabel('Discount amount').fill('6');
      await g.getByRole('radio', { name: 'Whole receipt' }).check(); await settle(page, 300);
    });
    const preview = (await ed.getByRole('group', { name: 'Add discount' }).getByRole('status').allTextContents()).join(' ');
    await page.screenshot({ path: path.join(OUT, 'TT-03-pending-preview.png') });
    await ed.getByRole('button', { name: 'Save expense' }).click(); await settle(page, 2000);
    const row = await rowText(page, 'Groceries');
    record('TT-03', 'Save drops a valid, unapplied discount preview', /Paid €60\.00/.test(row) && /New total €54\.00/.test(preview), { preview, savedRow: row.trim() });
  } catch (e) { record('TT-03', 'Save drops a valid, unapplied discount preview', null, { error: String(e).slice(0, 300) }); await discardOpenEditors(page); }

  // TT-03 variant: editing an existing discount and pressing Save keeps the old value.
  try {
    const ed = await addExpense(page, 'Museum', '45', async ed => {
      await ed.getByRole('button', { name: 'Tip, tax or discount' }).click(); await settle(page, 300);
      await ed.getByRole('button', { name: 'Add discount' }).click(); await settle(page, 300);
      const g = ed.getByRole('group', { name: 'Add discount' });
      await g.getByLabel('Label (optional)').fill('Student');
      await g.getByLabel('Discount amount').fill('6');
      await g.getByRole('radio', { name: 'Whole receipt' }).check();
      await g.getByRole('button', { name: 'Add', exact: true }).click(); await settle(page, 400);
    });
    await ed.getByRole('button', { name: 'Save expense' }).click(); await settle(page, 2000);
    await page.getByRole('button', { name: /^Museum .*paid/ }).click(); await settle(page, 1000);
    const edit = page.getByRole('dialog', { name: 'Edit expense' });
    await edit.getByRole('button', { name: 'Edit Student' }).click(); await settle(page, 400);
    const g = edit.getByRole('group', { name: /Edit discount or charge/ });
    await g.getByLabel('Discount amount').fill('9'); await settle(page, 400);
    const preview = (await g.getByRole('status').allTextContents()).join(' ');
    await edit.getByRole('button', { name: 'Save expense' }).click(); await settle(page, 2000);
    const row = await rowText(page, 'Museum');
    record('TT-03b', 'Save drops a pending edit to an existing discount', /Paid €39\.00/.test(row) && /€36\.00/.test(preview), { preview, savedRow: row.trim() });
  } catch (e) { record('TT-03b', 'Save drops a pending edit to an existing discount', null, { error: String(e).slice(0, 300) }); await discardOpenEditors(page); }

  // TT-02: closing the payment editor from its Review step records nothing and says nothing.
  try {
    await page.getByRole('link', { name: 'Balances' }).click(); await settle(page, 1200);
    const paymentsBefore = await page.getByRole('group', { name: 'payments' }).count();
    await page.getByRole('button', { name: 'Record paid' }).first().click(); await settle(page, 700);
    const d = page.getByRole('dialog').first();
    await d.getByLabel(/^Amount/).fill('10.00');
    await d.getByLabel('Note (optional)').fill('partial cash');
    await d.getByRole('button', { name: 'Review payment' }).click(); await settle(page, 500);
    const reviewHeading = (await page.getByRole('dialog').first().getByRole('heading', { level: 3 }).allTextContents()).join(' ');
    await page.getByRole('dialog').first().getByRole('button', { name: 'Close payment editor' }).click(); await settle(page, 800);
    const confirmShown = await page.getByRole('dialog', { name: /Discard/ }).count();
    const paymentsAfter = await page.getByRole('group', { name: 'payments' }).count();
    record('TT-02', 'Closing a dirty payment (even from Review) discards it without confirmation', confirmShown === 0 && paymentsBefore === paymentsAfter, { reviewHeading, confirmShown, paymentsBefore, paymentsAfter });
    await discardOpenEditors(page);
  } catch (e) { record('TT-02', 'Closing a dirty payment discards it without confirmation', null, { error: String(e).slice(0, 300) }); await discardOpenEditors(page); }

  // TT-07 (amended): edits to an existing expense are memory-only; a reopened tab offers no resume.
  try {
    await page.getByRole('link', { name: 'Expenses' }).click(); await settle(page, 1000);
    await page.getByRole('button', { name: /^Groceries .*paid/ }).click(); await settle(page, 900);
    const edit = page.getByRole('dialog', { name: 'Edit expense' });
    await edit.getByLabel('Expense name').fill('Groceries (unsaved edit)');
    await edit.getByLabel('Amount').fill('66'); await settle(page, 1200);
    const fresh = await ctx.newPage();
    await fresh.goto(`${BASE}/expenses`, { waitUntil: 'load' }); await settle(fresh, 2000);
    const resumeExisting = await fresh.getByRole('button', { name: /Resume/ }).count();
    await fresh.close();
    await discardOpenEditors(page);
    // Control: a NEW manual expense is offered for resume (F-18 persistence).
    await addExpense(page, 'New unsaved expense', '12'); await settle(page, 1200);
    const fresh2 = await ctx.newPage();
    await fresh2.goto(`${BASE}/expenses`, { waitUntil: 'load' }); await settle(fresh2, 2000);
    const resumeNew = await fresh2.getByRole('button', { name: /Resume/ }).count();
    await fresh2.getByRole('button', { name: 'Discard' }).first().click().catch(() => {});
    await fresh2.close();
    await discardOpenEditors(page);
    record('TT-07', 'Existing-expense edits are not persisted (no resume after reload/tab discard); new expenses are', resumeExisting === 0 && resumeNew > 0, { resumeExisting, resumeNewControl: resumeNew });
  } catch (e) { record('TT-07', 'Existing-expense edits are not persisted', null, { error: String(e).slice(0, 300) }); await discardOpenEditors(page); }

  // OP-02: the flat "Discount" field and a structured discount stack silently.
  try {
    await addExpense(page, 'Stacking', '60', async ed => {
      await ed.getByRole('button', { name: 'Tip, tax or discount' }).click(); await settle(page, 300);
      await ed.getByRole('textbox', { name: 'discount', exact: true }).fill('6'); await settle(page, 300);
      await ed.getByRole('button', { name: 'Add discount' }).click(); await settle(page, 300);
      const g = ed.getByRole('group', { name: 'Add discount' });
      await g.getByLabel('Discount amount').fill('6');
      await g.getByRole('radio', { name: 'Whole receipt' }).check();
      await g.getByRole('button', { name: 'Add', exact: true }).click(); await settle(page, 400);
    });
    const total = (await page.locator('.editor-footer-total').innerText()).replace(/\s+/g, ' ');
    await page.screenshot({ path: path.join(OUT, 'OP-02-stacked-discounts.png') });
    record('OP-02', 'Flat Discount field and structured discount stack without any combined summary or warning', /€48\.00/.test(total), { footerTotal: total });
    await discardOpenEditors(page);
  } catch (e) { record('OP-02', 'Discount paths stack silently', null, { error: String(e).slice(0, 300) }); await discardOpenEditors(page); }

  // OP-01: the active holiday is not persisted; a reload opens the first holiday.
  try {
    await createHoliday(page, 'Second Trip', 'Owner, Zed', async () => {
      await page.getByRole('button', { name: 'Open holidays' }).click(); await settle(page, 500);
      await page.getByRole('dialog', { name: 'Holidays' }).getByRole('button', { name: 'New holiday' }).click();
    });
    const before = await page.locator('h1').first().textContent();
    await page.reload({ waitUntil: 'load' }); await settle(page, 2000);
    const after = await page.locator('h1').first().textContent();
    await page.screenshot({ path: path.join(OUT, 'OP-01-after-reload.png') });
    record('OP-01', 'Reload/relaunch switches to the first holiday instead of the one in use', before !== after, { before, after, url: page.url() });
  } catch (e) { record('OP-01', 'Active holiday not persisted', null, { error: String(e).slice(0, 300) }); }

  // TT-01: in Profile & app settings, Tab moves focus below the visible modal while it never scrolls.
  try {
    await page.getByRole('button', { name: 'Profile and app settings' }).click(); await settle(page, 900);
    await page.getByLabel('Display name').focus();
    let worst = null;
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab'); await settle(page, 80);
      const m = await page.evaluate(() => { const a = document.activeElement; const r = a.getBoundingClientRect(); const modal = a.closest('section.modal'); return { name: (a.getAttribute('aria-label') || a.textContent || a.type || '').trim().slice(0, 40), top: Math.round(r.top), viewport: innerHeight, scrollTop: modal ? modal.scrollTop : null }; });
      if (m.top > m.viewport && (!worst || m.top > worst.top)) worst = m;
    }
    record('TT-01', 'Keyboard focus moves outside the visible settings modal (no scroll-into-view)', !!worst && worst.scrollTop === 0, { worst });
    await page.keyboard.press('Escape'); await settle(page, 400);
  } catch (e) { record('TT-01', 'Keyboard focus outside visible modal', null, { error: String(e).slice(0, 300) }); }

  // OP-03: a failed receipt upload shows raw "Failed to fetch", duplicated into the page banner with "Retry updates".
  try {
    await page.route(url => url.pathname.startsWith('/api/receipt'), route => route.request().method() === 'POST' ? route.abort('failed') : route.continue());
    await page.getByRole('button', { name: 'Add expense', exact: true }).click(); await settle(page, 700);
    const chooser = page.waitForEvent('filechooser', { timeout: 5000 });
    await page.getByRole('dialog').first().getByRole('button', { name: 'Choose image' }).click();
    const synthetic = path.join(scriptDir, '..', '..', '..', '..', '..', 'tests', 'fixtures', 'receipts', 'v1', 'images', 'cafe.png');
    await (await chooser).setFiles(synthetic); await settle(page, 3000);
    const alerts = await page.evaluate(() => [...document.querySelectorAll('[role=alert]')].filter(a => a.textContent.trim()).map(a => { const r = a.getBoundingClientRect(); return { text: a.textContent.trim().slice(0, 60), top: Math.round(r.top), inViewport: r.top >= 0 && r.bottom <= innerHeight }; }));
    const raw = alerts.some(a => /Failed to fetch/.test(a.text));
    const retryUpdates = alerts.some(a => /Retry updates/.test(a.text));
    record('OP-03', 'Upload failure: raw "Failed to fetch", page banner offers unrelated "Retry updates"', raw && retryUpdates, { alerts });
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await discardOpenEditors(page);
  } catch (e) { record('OP-03', 'Upload failure error routing', null, { error: String(e).slice(0, 300) }); await discardOpenEditors(page); }

  // TT-09: the service worker precaches a redirected /offline.html; offline navigation fails.
  try {
    await page.getByRole('link', { name: 'Travellers' }).click(); await settle(page, 1200);
    const enable = page.getByRole('button', { name: 'Enable on this device' });
    if (await enable.count()) { await enable.click(); await settle(page, 2000); }
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(() => {});
    const cached = await page.evaluate(async () => { const r = await caches.match('/offline.html'); return r ? { redirected: r.redirected, url: r.url, status: r.status } : null; });
    await ctx.setOffline(true);
    let navigation = 'loaded';
    try { await page.goto(`${BASE}/expenses`, { waitUntil: 'load', timeout: 15000 }); } catch (e) { navigation = String(e).split('\n')[0]; }
    await ctx.setOffline(false);
    record('TT-09', 'Offline navigation fails because the cached offline page is a redirected response', !!cached && cached.redirected && /ERR_FAILED/.test(navigation), { cached, navigation });
  } catch (e) { record('TT-09', 'Offline fallback', null, { error: String(e).slice(0, 300) }); await ctx.setOffline(false); }

  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ base: BASE, account: email, ranAt: new Date().toISOString(), results }, null, 2));
  console.log(`\nResults written to ${path.join(OUT, 'results.json')}`);
  await browser.close();
})().catch(error => { console.error(error); process.exit(1); });
