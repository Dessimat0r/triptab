import assert from 'node:assert/strict';
import test from 'node:test';
import { isUiLanguage, setUiLanguage, t } from '../lib/ui-language';
import { SPANISH_UI } from '../lib/ui-spanish';
import { FRENCH_UI } from '../lib/ui-french';
import { GERMAN_UI } from '../lib/ui-german';
import { getUiCatalog, getUiLocale, translateUi } from '../lib/ui-language';
import copy from '../lib/ui-copy.json';
import { formatMoney } from '../lib/money-format';
import { formatCalendarDate, localTimestamp } from '../lib/dates';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('all three translated interfaces cover the same labels and preserve spacing and unknown names', (context) => {
  context.after(() => setUiLanguage('en'));
  for (const [language, catalog, expense] of [
    ['es', SPANISH_UI, 'Añadir gasto'],
    ['fr', FRENCH_UI, 'Ajouter une dépense'],
    ['de', GERMAN_UI, 'Ausgabe hinzufügen'],
  ] as const) {
    assert.deepEqual(
      Object.keys(catalog).sort(),
      Object.keys(SPANISH_UI).sort(),
    );
    setUiLanguage(language);
    assert.equal(t('Add expense'), expense);
    assert.equal(t(' Add expense '), ` ${expense} `);
    assert.equal(t('Dinner at the river'), 'Dinner at the river');
    assert.equal(t('Alice'), 'Alice');
  }
  assert.ok(isUiLanguage('fr'));
  assert.ok(isUiLanguage('de'));
  assert.equal(isUiLanguage('unsupported'), false);
});

test('translated templates keep names and literal placeholder text intact', () => {
  const name = 'Alice {count} $&';
  assert.equal(translateUi('{count} expenses waiting to sync for {name}.', 'fr', { count: 3, name }), `3 dépenses en attente de synchronisation pour ${name}.`);
  assert.equal(translateUi('  Add expense  ', 'de'), '  Ausgabe hinzufügen  ');
  assert.equal(translateUi('Dinner at the river', 'es'), 'Dinner at the river');
  assert.equal(translateUi('constructor', 'de'), 'constructor');
  assert.equal(translateUi('This holiday has room for 7 more expenses.', 'de'), 'Diese Reise bietet Platz für 7 weitere Ausgaben.');
});

test('every extended translation retains the same parameter slots as its source', () => {
  const slots = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  const seen = new Set<string>();
  for (const [source, ...translations] of copy) {
    assert(!seen.has(source), `Duplicate interface copy: ${source}`);
    seen.add(source);
    assert.equal(translations.length, 3);
    for (const translated of translations) {
      assert(translated.trim());
      assert.deepEqual(slots(translated), slots(source), source);
    }
  }
});

test('display formatting follows the interface language while transaction timestamps retain their saved form', context => {
  context.after(() => setUiLanguage('en'));
  for (const language of ['es', 'fr', 'de'] as const) {
    setUiLanguage(language);
    assert.equal(getUiLocale(), language);
    assert.equal(formatMoney(12345, 'EUR'), new Intl.NumberFormat(language, { style: 'currency', currency: 'EUR' }).format(123.45));
    assert.equal(formatCalendarDate('2026-10-09'), new Intl.DateTimeFormat(language, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date('2026-10-09T00:00:00Z')));
    assert.equal(localTimestamp(new Date('2026-10-09T12:34:00Z'), 'UTC'), '2026-10-09T12:34');
  }
});

test('the public offline form shares translations and preserves interpolated account names', () => {
  const script = readFileSync(new URL('../public/offline-language.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/offline.html', import.meta.url), 'utf8');
  for (const language of ['es', 'fr', 'de'] as const) {
    const elements = [...html.matchAll(/data-ui="([^"]+)"/g)].map(match => ({ dataset: { ui: match[1] }, textContent: '' }));
    const context = vm.createContext({ document: { documentElement: { lang: '' }, querySelectorAll: () => elements }, localStorage: { getItem: () => language } });
    vm.runInContext(script, context);
    const catalog = getUiCatalog(language);
    for (const element of elements) assert.equal(element.textContent, catalog[element.dataset.ui]);
    assert.equal(context.document.documentElement.lang, language);
    assert.equal(context.TripTabUi.t('{count} expenses waiting to sync for {name}.', { count: 2, name: 'Alice {count}' }), translateUi('{count} expenses waiting to sync for {name}.', language, { count: 2, name: 'Alice {count}' }));
  }
});
