import { expect, test, type Page } from '@playwright/test';
import type { Profile } from '../../components/account-panel';

const profile: Profile = {
  id: 'sidebar-owner', displayName: 'Alex', email: 'alex@example.invalid',
  authMethod: 'password', hasPassword: true, chatgptConnected: false,
};
const aiStatus = {
  configured: false, connected: false, provider: 'api' as 'api' | 'siwc',
  eligible: false, manageable: false, siwcAvailable: false,
};
const trip = {
  id: 'sidebar-trip', ownerId: profile.id, name: 'Vienna', currency: 'GBP',
  members: [{ id: 'sidebar-alex', name: 'Alex', userId: profile.id }, { id: 'sidebar-sam', name: 'Sam' }],
  expenses: [], payments: [], drafts: [{
    id: 'sidebar-draft', title: 'Coffee receipt', status: 'review', currency: 'GBP',
    date: '2026-10-05', payer: 'sidebar-alex', tax: 0, tip: 0, discount: 0,
    items: [{ id: 'sidebar-item', name: 'Coffee', amount: 400, members: ['sidebar-alex', 'sidebar-sam'] }],
  }],
};

// Mutable responses exercise the app's existing refresh and account-save paths.
async function fixtures(page: Page, options: { profile?: Profile; aiStatus?: typeof aiStatus; empty?: boolean } = {}) {
  const state = { profile: { ...(options.profile ?? profile) }, aiStatus: { ...(options.aiStatus ?? aiStatus) } };
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth' && route.request().method() === 'POST') {
      expect(route.request().postDataJSON().action).toBe('unlink_chatgpt');
      state.profile = { ...state.profile, chatgptConnected: false, authMethod: 'password' };
      return route.fulfill({ json: { profile: state.profile, hasPassword: true, chatgptLinked: false } });
    }
    const json = path === '/api/ledger' ? { data: { trips: [{ ...trip, drafts: options.empty ? [] : trip.drafts }] }, revision: 1 }
      : path === '/api/profile' ? state.profile
      : path === '/api/receipt/ai-status' ? state.aiStatus
      : path === '/api/trip-language' ? { accountId: profile.id, tripId: trip.id, revision: 1,
        preferences: { readingLanguage: 'en', primaryVersion: 'reading', itemVersions: {} } }
      : { events: [], notifications: [], items: [] };
    return route.fulfill({ json, headers: path === '/api/ledger' ? { 'X-TripTab-Account': profile.id } : {} });
  });
  return state;
}

async function openSidebar(page: Page) {
  await page.goto('/receipts');
  await expect(page.locator('.personal')).toContainText(profile.displayName);
  if (page.viewportSize()!.width <= 900) await page.getByRole('button', { name: 'Open holidays', exact: true }).click();
  await expect(page.locator('.sidebar')).toBeVisible();
}

async function fits(page: Page, connected: boolean) {
  await expect(page.locator('.personal')).toBeInViewport({ ratio: 1 });
  const layout = await page.locator('.sidebar').evaluate(sidebar => {
    const status = sidebar.querySelector<HTMLElement>('.assistant-status');
    const account = sidebar.querySelector<HTMLElement>('.personal')!;
    const bottom = sidebar.querySelector<HTMLElement>('.side-bottom')!;
    const tripnav = sidebar.querySelector<HTMLElement>('.tripnav')!;
    const sidebarStyle = getComputedStyle(sidebar);
    const bounds = sidebar.getBoundingClientRect();
    const strong = status?.querySelector('strong');
    return {
      pageOverflow: document.documentElement.scrollWidth - innerWidth,
      drawerOverflow: sidebar.scrollWidth - sidebar.clientWidth,
      drawerScroll: sidebar.scrollHeight - sidebar.clientHeight,
      accountBottom: account.getBoundingClientRect().bottom,
      expectedBottom: bounds.bottom - parseFloat(sidebarStyle.paddingBottom),
      tripBottom: tripnav.getBoundingClientRect().bottom,
      bottomTop: bottom.getBoundingClientRect().top,
      statusBackground: status && getComputedStyle(status).backgroundColor,
      raisedBackground: sidebarStyle.getPropertyValue('--surface-raised').trim(),
      dark: matchMedia('(prefers-color-scheme: dark)').matches,
      headingLines: strong && strong.getBoundingClientRect().height / parseFloat(getComputedStyle(strong).lineHeight),
    };
  });
  expect(layout.pageOverflow).toBeLessThanOrEqual(0);
  expect(layout.drawerOverflow).toBeLessThanOrEqual(0);
  expect(layout.drawerScroll).toBeLessThanOrEqual(0);
  expect(Math.abs(layout.accountBottom - layout.expectedBottom)).toBeLessThanOrEqual(1);
  expect(layout.tripBottom).toBeLessThanOrEqual(layout.bottomTop);
  if (connected) {
    // One heading line and one Help row, including in the 210px sidebar.
    expect(layout.headingLines).toBeLessThanOrEqual(1.01);
    if (layout.dark) {
      const expected = await page.evaluate(color => {
        const element = document.createElement('span');
        element.style.backgroundColor = color;
        document.body.appendChild(element);
        const result = getComputedStyle(element).backgroundColor;
        element.remove();
        return result;
      }, layout.raisedBackground);
      expect(layout.statusBackground).toBe(expected);
    }
    if (page.viewportSize()!.width <= 900) {
      const help = await page.locator('.assistant-status').getByRole('button', { name: 'Help', exact: true }).boundingBox();
      expect(help!.height).toBeGreaterThanOrEqual(44);
    }
  }
}

async function opensHelp(page: Page, connected: boolean) {
  await page.locator('.side-bottom').getByRole('button', { name: connected ? 'Help' : 'How to connect', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: connected ? 'How to use ChatGPT or Codex' : 'Connect ChatGPT or Codex', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Copy receipt-reading prompt', exact: true })).toBeVisible();
  await expect(dialog).toContainText('Enable TripTab tools');
}

for (const viewport of [
  { width: 360, height: 640 }, { width: 390, height: 844 }, { width: 900, height: 800 },
  { width: 1150, height: 800 }, { width: 1280, height: 800 },
]) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test.describe(`${viewport.width}×${viewport.height} ${colorScheme}`, () => {
      test.use({ viewport, colorScheme, hasTouch: viewport.width < 700, isMobile: viewport.width < 700 });
      for (const connected of [false, true]) {
        test(`${connected ? 'linked status' : 'original setup card'} keeps account and help accessible`, async ({ page }) => {
          await fixtures(page, { profile: { ...profile, chatgptConnected: connected } });
          await openSidebar(page);
          await expect(page.locator('.account-note')).toHaveCount(connected ? 0 : 1);
          await expect(page.locator('.assistant-status')).toHaveCount(connected ? 1 : 0);
          if (connected) await expect(page.locator('.assistant-status strong')).toHaveText('ChatGPT connected');
          else await expect(page.locator('.account-note')).toContainText('Your assistant, optionally.');
          await fits(page, connected);
          // There are drafts, so the sidebar is the route to this help dialog.
          await expect(page.locator('.empty')).toHaveCount(0);
          await opensHelp(page, connected);
        });
      }
    });
  }
}

test.use({ viewport: { width: 1280, height: 800 } });

test('a connected ChatGPT plan shows the status without an identity link', async ({ page }) => {
  await fixtures(page, { aiStatus: { ...aiStatus, provider: 'siwc', connected: true } });
  await openSidebar(page);
  await expect(page.locator('.assistant-status strong')).toHaveText('ChatGPT connected');
  await opensHelp(page, true);
});

test('a ChatGPT sign-in shows the status even without the linked-profile flag', async ({ page }) => {
  await fixtures(page, { profile: { ...profile, authMethod: 'chatgpt' } });
  await openSidebar(page);
  await expect(page.locator('.assistant-status')).toBeVisible();
});

test('shared API receipt AI does not imply a ChatGPT connection', async ({ page }) => {
  await fixtures(page, { aiStatus: { ...aiStatus, provider: 'api', configured: true, connected: true } });
  await openSidebar(page);
  await expect(page.locator('.account-note')).toBeVisible();
  await expect(page.locator('.assistant-status')).toHaveCount(0);
});

test('profile refresh and account unlink update the sidebar without navigation', async ({ page }) => {
  const state = await fixtures(page);
  await openSidebar(page);
  await expect(page.locator('.account-note')).toBeVisible();
  const navigations: string[] = [];
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  state.profile.chatgptConnected = true;
  await page.evaluate(accountId => window.dispatchEvent(new CustomEvent('triptab:live-refresh', { detail: { accountId } })), profile.id);
  await expect(page.locator('.assistant-status')).toBeVisible();
  await page.locator('.personal').click();
  await page.getByRole('button', { name: 'Unlink ChatGPT', exact: true }).click();
  await expect(page.locator('.account-note')).toBeVisible();
  await expect(page.locator('.assistant-status')).toHaveCount(0);
  await opensHelp(page, false);
  expect(navigations).toEqual([]);
});

test('receipt AI settings refresh updates plan connection and disconnection without navigation', async ({ page }) => {
  const state = await fixtures(page);
  await openSidebar(page);
  const navigations: string[] = [];
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  state.aiStatus = { ...aiStatus, provider: 'siwc', connected: true };
  await page.evaluate(() => window.dispatchEvent(new Event('triptab:receipt-ai-settings')));
  await expect(page.locator('.assistant-status')).toBeVisible();
  state.aiStatus.connected = false;
  await page.evaluate(() => window.dispatchEvent(new Event('triptab:receipt-ai-settings')));
  await expect(page.locator('.account-note')).toBeVisible();
  expect(navigations).toEqual([]);
});

for (const connected of [false, true]) {
  test(`receipts empty state offers ${connected ? 'usage help' : 'connection help'}`, async ({ page }) => {
    await fixtures(page, { profile: { ...profile, chatgptConnected: connected }, empty: true });
    await openSidebar(page);
    await page.locator('.empty').getByRole('button', {
      name: connected ? 'How to use ChatGPT or Codex' : 'Connect ChatGPT or Codex', exact: true,
    }).click();
    await expect(page.getByRole('dialog', { name: connected ? 'How to use ChatGPT or Codex' : 'Connect ChatGPT or Codex', exact: true })).toBeVisible();
  });
}
