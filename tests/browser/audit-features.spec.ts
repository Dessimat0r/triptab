import { expect, test, type Page } from '@playwright/test';
import type { Trip } from '../../lib/model';
const trip: Trip = {
  id: 'audit-new-trip',
  ownerId: 'alice',
  name: 'Prague',
  currency: 'GBP',
  startDate: '2026-10-09',
  endDate: '2026-10-11',
  budget: 10000,
  members: [
    {
      id: 'a',
      name: 'Alice',
      userId: 'alice',
      payTo: { monzo: 'alice', bank: 'IBAN example' },
    },
    { id: 'b', name: 'Bob', userId: 'bob' },
  ],
  expenses: [
    {
      id: 'meal',
      title: 'Dinner at the river',
      date: '2026-10-09',
      time: '20:30',
      timezone: 'Europe/Prague',
      currency: 'GBP',
      payer: 'a',
      icon: { symbol: 'Utensils', background: 'orange' },
      items: [
        { id: 'line', name: 'Dinner', amount: 2000, members: ['a', 'b'] },
      ],
      tax: 0,
      tip: 0,
      discount: 0,
    },
    {
      id: 'taxi',
      title: 'Airport taxi',
      date: '2026-10-10',
      time: '12:00',
      timezone: 'Europe/Prague',
      currency: 'EUR',
      fx: { rate: 1, asOf: '2026-10-10', source: 'manual' },
      payer: 'a',
      items: [
        { id: 'taxi-line', name: 'Taxi', amount: 1000, members: ['a', 'b'] },
      ],
      tax: 0,
      tip: 0,
      discount: 0,
    },
  ],
  payments: [],
  drafts: [],
};
async function fixtures(page: Page) {
  page.on('console', (message) => {
    if (message.type() === 'error') console.log(message.text());
  });
  let current = structuredClone(trip),
    revision = 1,
    language = 'en';
  const actions: { path: string; body: Record<string, unknown> }[] = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    let json: unknown = {};
    if (request.method() === 'POST') {
      const body = request.postDataJSON();
      actions.push({ path, body });
      if (path === '/api/offline-expenses') {
        current.expenses.unshift(body.expense);
        revision++;
        json = { saved: true };
      } else if (path === '/api/interface-language') {
        language = body.language;
        json = { language };
      } else if (path === '/api/ledger') {
        current = body.data.trips[0];
        revision++;
        json = { data: body.data, revision };
      } else if (path === '/api/remind') json = { message: 'Reminder sent.' };
      else if (path === '/api/import') json = { tripId: body.trip.id };
    } else if (path === '/api/ledger')
      json = { data: { trips: [current] }, revision };
    else if (path === '/api/profile')
      json = {
        id: 'alice',
        displayName: 'Alice',
        email: 'alice@example.test',
        authMethod: 'password',
        hasPassword: true,
        emailVerified: true,
        uiLanguage: language,
      };
    else if (path === '/api/account') json = { sessions: [] };
    else if (path === '/api/notification-preferences')
      json = { scope: 'all', delivery: 'immediate', reminders: true };
    else if (path === '/api/invite') json = { invitations: [], hasMore: false };
    else if (path === '/api/trip-language')
      json = {
        accountId: 'alice',
        tripId: trip.id,
        revision: 1,
        preferences: {
          readingLanguage: 'en',
          primaryVersion: 'reading',
          itemVersions: {},
        },
      };
    else if (path === '/api/trip') json = { trips: [] };
    else json = { events: [], nextCursor: null, notifications: [], items: [] };
    await route.fulfill({
      json,
      headers: path === '/api/ledger' ? { 'X-TripTab-Account': 'alice' } : {},
    });
  });
  return actions;
}

test('expense search, date and currency filters change rows and spending totals at 320px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 850 });
  await fixtures(page);
  await page.goto('/expenses');
  await expect(page.locator('.expense')).toHaveCount(2);
  await page
    .getByRole('searchbox', { name: 'Search expenses' })
    .fill('airport');
  await expect(page.locator('.expense')).toHaveCount(1);
  await expect(page.locator('.expense')).toContainText('Airport taxi');
  await page.getByRole('searchbox').fill('');
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Currency', exact: true })
    .selectOption('GBP');
  await expect(page.locator('.expense')).toHaveCount(1);
  await page.getByLabel('From date').fill('2026-10-10');
  await expect(page.locator('.expense')).toHaveCount(0);
  await page
    .getByRole('search', { name: 'Find expenses' })
    .getByRole('button', { name: 'Clear filters' })
    .click();
  await expect(page.locator('.expense')).toHaveCount(2);
  await page.locator('.spending-breakdown summary').click();
  await expect(page.locator('.spending-breakdown')).toContainText('£30.00');
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
});

test('settlement links, reminders, budget and trip summary expose the saved figures', async ({
  page,
}) => {
  const actions = await fixtures(page);
  await page.goto('/balances');
  await expect(page.getByRole('link', { name: /Monzo/ })).toHaveAttribute(
    'href',
    /https:\/\/monzo\.me\/alice/,
  );
  await page.getByRole('button', { name: 'Remind Bob', exact: true }).click();
  await expect(page.getByText('Reminder sent.', { exact: true })).toBeVisible();
  expect(
    actions.find((action) => action.path === '/api/remind')?.body.amount,
  ).toBe(1500);
  await page.getByRole('button', { name: 'Trip summary', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('£30.00');
  await expect(page.getByRole('dialog')).toContainText('£15.00');
});

test('offline capture stores a pending expense, then appends it once on reconnect', async ({
  page,
}) => {
  const actions = await fixtures(page);
  await page.goto('/travellers');
  await page.getByRole('button', { name: 'Enable on this device' }).click();
  await expect(
    page.getByRole('link', { name: 'Open capture form' }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Open capture form' }).click();
  await expect(page.locator('#offline-expense')).toBeVisible();
  await page.locator('#capture-title').fill('Underground tickets');
  await page.locator('#capture-amount').fill('8.50');
  await page.getByRole('button', { name: 'Save on this device' }).click();
  await expect(page.locator('#capture-status')).toContainText(
    'Saved on this device',
  );
  await page.goto('/expenses');
  await expect(page.locator('.expense')).toHaveCount(3);
  expect(
    actions.filter((action) => action.path === '/api/offline-expenses'),
  ).toHaveLength(1);
  expect(
    actions.filter((action) => action.path === '/api/ledger'),
  ).toHaveLength(0);
});

test('a staged shared image offers attachment without posting an expense automatically', async ({
  page,
}) => {
  const actions = await fixtures(page);
  await page.goto('/expenses');
  await page.addScriptTag({ url: '/offline-store.js' });
  await page.evaluate(async () => {
    const store = (
      window as unknown as {
        TripTabOffline: { receivePhoto: (photo: Blob) => Promise<void> };
      }
    ).TripTabOffline;
    await store.receivePhoto(
      new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }),
    );
  });
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'A photo was shared with TripTab' }),
  ).toBeVisible();
  await expect(page.locator('.shared-photo')).toContainText(
    'Choose its holiday',
  );
  expect(
    actions.filter(
      (action) =>
        action.path === '/api/ledger' || action.path === '/api/receipt',
    ),
  ).toHaveLength(0);
  await page.getByRole('button', { name: 'Discard photo' }).click();
  await expect(page.locator('.shared-photo')).toHaveCount(0);
});

for (const [language, add, travellers, close] of [
  ['es', 'Añadir gasto', 'Viajeros', 'Cerrar'],
  ['fr', 'Ajouter une dépense', 'Voyageurs', 'Fermer'],
  ['de', 'Ausgabe hinzufügen', 'Reisende', 'Schließen'],
]) {
  test(`${language} interface keeps traveller and expense names intact`, async ({
    page,
  }) => {
    await fixtures(page);
    await page.goto('/expenses');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: 'More holiday options' }).click();
    await page.getByLabel('Interface language').selectOption(language);
    await page.getByRole('button', { name: close, exact: true }).click();
    await expect(
      page.getByRole('button', { name: add, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: travellers, exact: true }),
    ).toBeVisible();
    await expect(page.locator('.expense').first()).toContainText(
      'Dinner at the river',
    );
    await expect(page.locator('html')).toHaveAttribute('lang', language);
    await page.reload();
    await expect(
      page.getByRole('button', { name: add, exact: true }),
    ).toBeVisible();
  });
}

for (const labels of [
  { code: 'es', close: 'Cerrar', summary: 'Resumen del viaje', person: 'Cada persona', closeSummary: 'Cerrar resumen', enable: 'Activar en este dispositivo', capture: 'Abrir formulario de captura', save: 'Guardar en este dispositivo', saved: 'Guardado en este dispositivo', account: 'Perfil y ajustes de la aplicación', recovery: 'Verifica tu correo en los ajustes de la cuenta para recuperarla si olvidas la contraseña.' },
  { code: 'fr', close: 'Fermer', summary: 'Bilan du voyage', person: 'Chaque personne', closeSummary: 'Fermer le résumé', enable: 'Activer sur cet appareil', capture: 'Ouvrir le formulaire de saisie', save: 'Enregistrer sur cet appareil', saved: 'Enregistré sur cet appareil', account: 'Profil et réglages de l’application', recovery: 'Vérifiez votre adresse e-mail dans les réglages pour récupérer votre compte si vous oubliez votre mot de passe.' },
  { code: 'de', close: 'Schließen', summary: 'Reiseübersicht', person: 'Jede Person', closeSummary: 'Zusammenfassung schließen', enable: 'Auf diesem Gerät aktivieren', capture: 'Erfassungsformular öffnen', save: 'Auf diesem Gerät speichern', saved: 'Auf diesem Gerät gespeichert', account: 'Profil und App-Einstellungen', recovery: 'Bestätige deine E-Mail in den Kontoeinstellungen, damit du dein Konto bei vergessenem Passwort wiederherstellen kannst.' },
]) {
  test(`${labels.code} settings, summaries and offline capture preserve transaction values`, async ({ page }) => {
    const actions = await fixtures(page);
    await page.goto('/expenses');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: 'More holiday options' }).click();
    await page.getByLabel('Interface language').selectOption(labels.code);
    await page.getByRole('button', { name: labels.close, exact: true }).click();
    await page.goto('/balances');
    const total = new Intl.NumberFormat(labels.code, { style: 'currency', currency: 'GBP' }).format(30);
    await expect(page.locator('.budget-card')).toContainText(total);
    await page.getByRole('button', { name: labels.summary, exact: true }).click();
    await expect(page.getByRole('heading', { name: labels.person })).toBeVisible();
    await expect(page.getByRole('dialog')).toContainText('Alice');
    await expect(page.getByRole('dialog')).toContainText(total);
    await page.getByRole('button', { name: labels.closeSummary }).click();
    await page.getByRole('button', { name: 'A Alice alice@example.test', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText(labels.recovery);
    await page.goto('/travellers');
    await page.getByRole('button', { name: labels.enable }).click();
    await page.getByRole('link', { name: labels.capture }).click();
    await expect(page.locator('#offline-expense')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', labels.code);
    await page.context().setOffline(true);
    await page.locator('#capture-title').fill('Underground tickets');
    await page.locator('#capture-amount').fill('8,50');
    await page.getByRole('button', { name: labels.save }).click();
    await expect(page.locator('#capture-status')).toContainText(labels.saved);
    const queued = await page.evaluate(async () => {
      const store = (window as unknown as { TripTabOffline: { operation: (store: string, method: string) => Promise<{ expense: { title: string; items: { amount: number }[] } }[]> } }).TripTabOffline;
      return (await store.operation('queue', 'getAll'))[0].expense;
    });
    expect(queued.title).toBe('Underground tickets');
    expect(queued.items[0].amount).toBe(850);
    await page.context().setOffline(false);
    await page.goto('/expenses');
    await expect(page.locator('.expense')).toHaveCount(3);
    expect(actions.filter(action => action.path === '/api/offline-expenses')).toHaveLength(1);
    expect(actions.filter(action => action.path === '/api/ledger')).toHaveLength(0);
  });
}
