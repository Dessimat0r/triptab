import assert from 'node:assert/strict';
import test from 'node:test';
import { isUiLanguage, setUiLanguage, t } from '../lib/ui-language';
import { SPANISH_UI } from '../lib/ui-spanish';
import { FRENCH_UI } from '../lib/ui-french';
import { GERMAN_UI } from '../lib/ui-german';

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
