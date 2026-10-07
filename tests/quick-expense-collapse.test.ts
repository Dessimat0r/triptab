import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createSourceFile, isFunctionDeclaration, ModuleKind, ScriptKind, ScriptTarget, transpileModule } from 'typescript';
import type { ReceiptEditor } from '../lib/receipt-processing';

// Exercise the production helpers, following the receipt-editor test harness.
const source = await readFile(new URL('../components/trip-app.tsx', import.meta.url), 'utf8');
const syntax = createSourceFile('trip-app.tsx', source, ScriptTarget.Latest, true, ScriptKind.TSX);
const helpers = ['quickEligible', 'withQuickName', 'collapseToQuick'].map(name => {
  const declaration = syntax.statements.find(node => isFunctionDeclaration(node) && node.name?.text === name);
  assert(declaration, `Missing production helper: ${name}`);
  return declaration.getText(syntax);
}).join('\n');
const compiled = transpileModule(helpers, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
const { quickEligible, collapseToQuick } = new Function(`${compiled}; return { quickEligible, collapseToQuick };`)() as {
  quickEligible(entry: ReceiptEditor): boolean;
  collapseToQuick(entry: ReceiptEditor, memberIds: string[]): ReceiptEditor;
};

const entry: ReceiptEditor = {
  id: 'expense', title: 'Dinner', payer: 'sam', currency: 'EUR',
  date: '2026-10-07', time: '19:30', timezone: 'Europe/Vienna',
  tax: 100, tip: 200, discount: 50, bankAmount: 1800,
  fx: { rate: 0.86, source: 'manual', asOf: '2026-10-07' },
  percentages: { gary: 75, sam: 25 },
  items: [{
    id: 'line', name: 'Other name', amount: 2000, members: ['sam'],
    percentages: { sam: 100 }, units: { total: 2, allocations: { sam: 2 } },
    quantity: { total: 2, label: 'meals' },
    translations: { en: { text: 'Meal', sourceText: 'Other name', pairedText: 'Meal', provenance: 'user' } },
    scanSource: { observedText: 'Meal', confidence: 'high' },
    fieldSources: { name: 'receipt', amount: 'user' },
  }],
};

test('collapse preserves the line and expense details while clearing item split data', () => {
  const before = structuredClone(entry);
  const collapsed = collapseToQuick(entry, ['gary', 'sam']);
  assert(quickEligible(collapsed));
  assert.equal(collapsed.percentages, undefined);
  assert.deepEqual(collapsed.items[0], {
    id: 'line', name: 'Dinner', amount: 2000, members: ['sam'],
    percentages: undefined, units: undefined, quantity: undefined,
    translations: undefined, scanSource: undefined,
    fieldSources: { name: 'user', amount: 'user' },
  });
  assert.deepEqual({ ...collapsed, items: entry.items, percentages: entry.percentages }, entry);
  assert.deepEqual(entry, before, 'collapsing must not mutate the previous editor');
});

test('missing amount becomes zero and an unassigned line uses every trip member', () => {
  const collapsed = collapseToQuick({ ...entry, items: [{ ...entry.items[0], amount: null, members: [] }] }, ['gary', 'sam']);
  assert(quickEligible(collapsed));
  assert.equal(collapsed.items[0].amount, 0);
  assert.deepEqual(collapsed.items[0].members, ['gary', 'sam']);
});

test('a zero-priced line keeps its selected people and can collapse repeatedly', () => {
  const collapsed = collapseToQuick({ ...entry, items: [{ ...entry.items[0], amount: 0 }] }, ['gary', 'sam']);
  assert(quickEligible(collapsed));
  assert.equal(collapsed.items[0].amount, 0);
  assert.deepEqual(collapsed.items[0].members, ['sam']);
  assert.deepEqual(collapseToQuick(collapsed, ['gary', 'sam']), collapsed);
});
