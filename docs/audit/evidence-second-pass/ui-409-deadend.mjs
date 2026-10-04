// Second-pass UI evidence against the LOCAL Worker (npm start). Clear auth_rate_limits first.
// Shows: an unrelated user's save while you edit makes your open expense form unsaveable, and no
// refresh control is reachable while the editor modal is open (F-03 x F-11).
// Run: node docs/audit/evidence-second-pass/ui-409-deadend.mjs
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
// Playwright is not a project dependency; resolve the globally installed copy.
const { chromium } = createRequire(execSync('npm root -g').toString().trim() + '/')('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const run = Date.now().toString(36);
const password = 'correct horse battery staple';
async function api(path, { method = 'GET', body, cookie } = {}) {
  const r = await fetch(BASE + path, { method, headers: { origin: BASE, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body && JSON.stringify(body) });
  const session = (r.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).find(c => /^tt_session=.+/.test(c));
  return { status: r.status, json: await r.json().catch(() => null), session };
}
const register = (name) => api('/api/auth', { method: 'POST', body: { action: 'register', email: `${name}-${run}@example.test`, password, displayName: name } });
const trip = (id, name, members) => ({ id, name, currency: 'GBP', members: members.map((n, i) => ({ id: `m${i}`, name: n })), expenses: [], drafts: [], payments: [] });

const a = await register('Alice');
const c = await register('Carol');
let ledger = await api('/api/ledger', { cookie: a.session });
await api('/api/ledger', { method: 'POST', cookie: a.session, body: { data: { trips: [trip(`a-${run}`, 'Lisbon', ['Alice', 'Bob'])] }, revision: ledger.json.revision } });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
await context.addCookies([{ name: 'tt_session', value: a.session.split('=')[1], url: BASE }]);
const page = await context.newPage();
await page.goto(BASE + '/');
await page.getByRole('button', { name: 'Add expense' }).first().click();
await page.getByPlaceholder('Dinner by the harbour').fill('Dinner');
await page.getByLabel('Item 1 name').fill('Paella');
await page.getByLabel('Item 1 total').fill('48.00');

// Meanwhile, an unrelated user saves an unrelated trip.
const cl = await api('/api/ledger', { cookie: c.session });
const unrelated = await api('/api/ledger', { method: 'POST', cookie: c.session, body: { data: { trips: [trip(`c-${run}`, 'Oslo', ['Carol'])] }, revision: cl.json.revision } });

const save = page.getByRole('button', { name: 'Save expense' });
const attempts = [];
for (let i = 0; i < 3; i++) {
  await save.click();
  await page.waitForTimeout(800);
  attempts.push(await page.locator('.editor-footer, .modal').getByRole('alert').first().textContent().catch(() => null));
}
let refreshReachable = true;
try { await page.getByRole('button', { name: 'Refresh ledger' }).first().click({ timeout: 2000 }); }
catch { refreshReachable = false; }
const inEditorRefresh = await (async () => {
  // The in-editor receipt refresh needs a receipt draft; without one it only shows guidance.
  const button = page.locator('.modal').getByRole('button', { name: /check|refresh/i }).first();
  if (!await button.count()) return 'none';
  await button.click().catch(() => {});
  await page.waitForTimeout(500);
  return await page.locator('.modal').getByRole('alert').first().textContent().catch(() => null);
})();
const after = await api('/api/ledger', { cookie: a.session });
console.log(JSON.stringify({
  unrelatedSave: unrelated.status,
  saveAttemptMessages: attempts,
  pageRefreshClickableWithEditorOpen: refreshReachable,
  inEditorRefresh,
  expensesStoredForAlice: after.json.data.trips[0].expenses.length,
}, null, 2));
await browser.close();
