// Audit evidence for docs/audit/expense-progressive-audit-2026-10-08.md.
// Usage (from the repo root, with `npm start -- --port 8787` running):
//   node docs/audit/expense-progressive-2026-10-08/measure.mjs <output-dir>
// Captures each expense-entry route at 390 × 844 and 1440 × 900 against local
// API fixtures and writes metrics.json with height, control and box counts.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] || 'expense-audit-shots';
fs.mkdirSync(out, { recursive: true });
const base = process.env.TRIPTAB_LAYOUT_URL || 'http://127.0.0.1:8787';
const photo = path.resolve('tests/fixtures/receipts/v1/images/long-receipt.png');

const members = [
  { id: 'gary', name: 'Gary', userId: 'owner' }, { id: 'sam', name: 'Sam' },
  { id: 'priya', name: 'Priya' }, { id: 'tom', name: 'Tom' },
];
const draft = {
  id: 'audit-draft', receiptId: 'photo', title: 'Taberna da Rua', status: 'review', source: 'ai',
  date: '2026-10-07', time: '21:14', timezone: 'Europe/Lisbon', currency: 'EUR', payer: 'gary',
  tax: 0, tip: 600, discount: 0, detectedLanguage: 'pt',
  fieldSources: { title: 'ai', date: 'ai', time: 'ai', timezone: 'ai', currency: 'ai', tip: 'ai' },
  items: [
    { id: 'i1', name: 'Bacalhau à Brás', nameLanguage: 'pt', amount: 1650, members: [], scanSource: { observedText: 'BACALHAU A BRAS 16,50', confidence: 'high' } },
    { id: 'i2', name: 'Polvo grelhado', nameLanguage: 'pt', amount: 1890, members: [], scanSource: { observedText: 'POLVO GRELH 18,90', confidence: 'high' } },
    { id: 'i3', name: 'Arroz de marisco', nameLanguage: 'pt', amount: 3200, members: [], scanSource: { observedText: 'ARROZ MARISCO 2P 32,00', confidence: 'high' } },
    { id: 'i4', name: 'Vinho verde', nameLanguage: 'pt', amount: 2200, members: [], scanSource: { observedText: 'VINHO VERDE GAR 22,00', confidence: 'high' } },
    { id: 'i5', name: 'Água com gás', nameLanguage: 'pt', amount: 450, members: [], scanSource: { observedText: 'AGUA C/GAS 4,50', confidence: 'low' } },
    { id: 'i6', name: 'Pastel de nata', nameLanguage: 'pt', amount: 600, members: [], quantity: { total: 4, label: 'pastéis', sourceText: '4 X 1,50' }, scanSource: { observedText: '4 X PASTEL NATA 6,00', confidence: 'high' } },
    { id: 'i7', name: 'Café', nameLanguage: 'pt', amount: 400, members: [], scanSource: { observedText: 'CAFE 4X 4,00', confidence: 'high' } },
  ],
  receiptScan: { version: 1, printedCurrency: 'EUR', printedTotal: 11030, status: 'needs-review',
    warnings: [{ code: 'low-confidence', itemId: 'i5' }] },
};
const trip = {
  id: 'audit-trip', ownerId: 'owner', name: 'Lisbon', currency: 'GBP', receiptLanguage: 'pt', members,
  expenses: [{ id: 'e1', title: 'Airport taxi', date: '2026-10-06', time: '14:00', timezone: 'Europe/Lisbon', currency: 'EUR', payer: 'sam',
    tax: 0, tip: 0, discount: 0, fx: { rate: 0.86, asOf: '2026-10-06', source: 'reference' },
    items: [{ id: 'e1i', name: 'Airport taxi', amount: 3400, members: ['gary', 'sam', 'priya', 'tom'] }] }],
  payments: [], drafts: [draft],
};

async function fixtures(page) {
  let current = structuredClone(trip);
  await page.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (pathname === '/api/receipt' && request.method() === 'GET') return route.fulfill({ contentType: 'image/png', path: photo });
    if (pathname === '/api/fx') return route.fulfill({ json: { rate: 0.8612, asOf: '2026-10-07' } });
    if (pathname === '/api/ledger' && request.method() === 'POST') return route.fulfill({ status: 409, json: { error: 'fixture' } });
    const json = pathname === '/api/ledger' ? { data: { trips: [current] }, revision: 1 }
      : pathname === '/api/profile' ? { id: 'owner', displayName: 'Gary', email: 'gary@example.invalid', authMethod: 'password' }
      : pathname === '/api/receipt/ai-status' ? { configured: true, connected: true, provider: 'api', eligible: true, manageable: false, siwcAvailable: false }
      : pathname === '/api/trip-language' ? { accountId: 'owner', tripId: trip.id, revision: 1, preferences: { readingLanguage: 'en', primaryVersion: 'reading', itemVersions: {} } }
      : { events: [], notifications: [], items: [] };
    return route.fulfill({ json, headers: pathname === '/api/ledger' ? { 'X-TripTab-Account': 'owner' } : {} });
  });
}

// Visual-density metrics for the editor's scrollable content.
async function measure(page) {
  return page.evaluate(() => {
    const editor = document.querySelector('.editor') || document.querySelector('.modal');
    if (!editor) return null;
    const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden'; };
    const all = Array.from(editor.querySelectorAll('*')).filter(visible);
    const controls = all.filter(el => el.matches('button, input:not([type=hidden]):not([type=file]), select, textarea, summary, a[href], label.receipt-capture-action'));
    const boxed = all.filter(el => {
      if (el.matches('button, input, select, textarea, summary, a, label.receipt-capture-action, img, svg, span, .chipavatar')) return false;
      const s = getComputedStyle(el);
      const bordered = ['Top', 'Right', 'Bottom', 'Left'].every(side => parseFloat(s[`border${side}Width`]) > 0);
      const filled = s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent' && el !== editor;
      return bordered || (filled && parseFloat(s.borderRadius) > 0);
    });
    const depth = el => { let d = 0; for (let p = el.parentElement; p && p !== editor; p = p.parentElement) if (boxed.includes(p)) d++; return d; };
    const headings = all.filter(el => el.matches('h2, h3, h4, legend, .save-checklist-title'));
    const fontSizes = new Set(all.filter(el => el.childNodes.length && Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim())).map(el => getComputedStyle(el).fontSize));
    const radii = new Set(boxed.concat(controls).map(el => getComputedStyle(el).borderTopLeftRadius).filter(v => v !== '0px'));
    const text = editor.innerText.replace(/\s+/g, ' ').trim();
    return {
      scrollHeight: editor.scrollHeight, clientHeight: editor.clientHeight,
      controls: controls.length, primaryButtons: controls.filter(el => el.classList.contains('primary')).length,
      boxes: boxed.length, maxBoxDepth: Math.max(0, ...boxed.map(depth)),
      headings: headings.map(h => h.innerText.trim()).filter(Boolean),
      fontSizes: [...fontSizes].sort(), radii: [...radii].sort(),
      words: text.split(' ').length,
      controlLabels: controls.map(el => (el.getAttribute('aria-label') || el.innerText || el.value || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 60)),
    };
  });
}

const results = {};
async function shot(page, name, { tall = false } = {}) {
  const m = await measure(page);
  results[name] = m;
  if (tall && m) {
    const vp = page.viewportSize();
    await page.setViewportSize({ width: vp.width, height: Math.min(Math.max(m.scrollHeight + 120, vp.height), 9000) });
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(out, `${name}-full.png`) });
    await page.setViewportSize(vp);
    await page.waitForTimeout(150);
  } else {
    await page.screenshot({ path: path.join(out, `${name}.png`) });
  }
}

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
async function run(viewport, prefix, mobile) {
  const context = await browser.newContext({ viewport, hasTouch: mobile, isMobile: mobile, serviceWorkers: 'block', deviceScaleFactor: 1 });
  const page = await context.newPage();
  await fixtures(page);

  // A. Expense list entry points
  await page.goto(base + '/expenses');
  await page.getByRole('button', { name: 'Add expense', exact: true }).waitFor();
  await page.screenshot({ path: path.join(out, `${prefix}-a-list.png`) });

  // B. New manual expense, untouched
  await page.getByRole('button', { name: 'Add expense', exact: true }).click();
  await page.locator('.editor').waitFor();
  await page.waitForTimeout(300);
  await shot(page, `${prefix}-b-new`);
  await shot(page, `${prefix}-b-new`, { tall: true });

  // I. Save pressed on untouched form
  await page.locator('.editor-footer .primary').click();
  await page.waitForTimeout(250);
  await shot(page, `${prefix}-i-save-untouched`);

  // C. Typed name/amount + foreign currency
  await page.getByRole('textbox', { name: 'Expense name', exact: true }).fill('Dinner');
  await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('84.00');
  await page.getByLabel('Original currency').selectOption('EUR');
  await page.waitForTimeout(1200);
  await shot(page, `${prefix}-c-foreign`);
  await shot(page, `${prefix}-c-foreign`, { tall: true });

  // D. Custom split -> itemised editor
  await page.getByRole('button', { name: 'Custom split', exact: true }).click();
  await page.waitForTimeout(300);
  await shot(page, `${prefix}-d-custom-split`);
  await shot(page, `${prefix}-d-custom-split`, { tall: true });

  // E. Split by item with three lines (fresh editor)
  await page.locator('.editor .modalheading .iconbutton[aria-label="Close editor"]').click();
  const discard = page.getByRole('button', { name: 'Discard changes' });
  if (await discard.count()) await discard.click();
  await page.locator('.editor').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Add expense', exact: true }).click();
  await page.locator('.editor').waitFor();
  await page.getByRole('textbox', { name: 'Expense name', exact: true }).fill('Groceries');
  await page.getByRole('button', { name: 'Split by item' }).click();
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: 'Add item' }).click();
  await page.getByRole('button', { name: 'Add item' }).click();
  await page.waitForTimeout(200);
  await shot(page, `${prefix}-e-itemised`, { tall: true });
  await page.locator('.editor .modalheading .iconbutton[aria-label="Close editor"]').click();
  if (await discard.count()) await discard.click();
  await page.locator('.editor').waitFor({ state: 'detached' });

  // F. Scanned receipt draft review
  await page.goto(base + '/expenses?receiptDraft=audit-draft&receiptTrip=audit-trip');
  await page.locator('.editor').waitFor();
  await page.waitForTimeout(1500);
  await shot(page, `${prefix}-f-receipt`);
  await shot(page, `${prefix}-f-receipt`, { tall: true });

  // G. After bulk allocation
  const share = page.getByRole('button', { name: /Share 7 remaining items equally/ });
  if (await share.count()) { await share.click(); await page.waitForTimeout(1200); }
  await shot(page, `${prefix}-g-receipt-allocated`);
  await shot(page, `${prefix}-g-receipt-allocated`, { tall: true });
  await page.locator('.editor .modalheading .iconbutton[aria-label="Close editor"]').click();
  if (await discard.count()) await discard.click();

  // H. Inbox upload dialog
  await page.goto(base + '/receipts');
  await page.getByRole('button', { name: 'Add receipt', exact: true }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, `${prefix}-h-upload.png`) });
  results[`${prefix}-h-upload`] = await measure(page);

  // J. Existing expense edit
  await page.goto(base + '/expenses');
  await page.locator('.expense-open').first().click();
  await page.locator('.editor').waitFor();
  await page.waitForTimeout(800);
  await shot(page, `${prefix}-j-edit`, { tall: true });
  await context.close();
}

await run({ width: 390, height: 844 }, 'p390', true);
await run({ width: 1440, height: 900 }, 'd1440', false);
await browser.close();
fs.writeFileSync(path.join(out, 'metrics.json'), JSON.stringify(results, null, 2));
console.log('done');
