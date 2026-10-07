import assert from 'node:assert/strict';
import test from 'node:test';
import { collapseToQuick, hasItemSplitDetail, isManualSingleLine, quickEligible } from '../lib/quick-expense';
import type { ReceiptEditor } from '../lib/receipt-processing';

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
  const collapsed = collapseToQuick(entry);
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

test('a line named while the expense title was blank names the expense', () => {
  const collapsed = collapseToQuick({ ...entry, title: '' });
  assert.equal(collapsed.title, 'Other name');
  assert.equal(collapsed.items[0].name, 'Other name');
  assert(quickEligible(collapsed));
});

test('a missing amount becomes zero and collapsing never invents who shares the line', () => {
  const collapsed = collapseToQuick({ ...entry, items: [{ ...entry.items[0], amount: null, members: [] }] });
  assert.equal(collapsed.items[0].amount, 0);
  assert.deepEqual(collapsed.items[0].members, []);
  assert(!quickEligible(collapsed), 'an unassigned line stays out of the quick form');
});

test('a zero-priced line keeps its selected people and can collapse repeatedly', () => {
  const collapsed = collapseToQuick({ ...entry, items: [{ ...entry.items[0], amount: 0 }] });
  assert(quickEligible(collapsed));
  assert.equal(collapsed.items[0].amount, 0);
  assert.deepEqual(collapsed.items[0].members, ['sam']);
  assert.deepEqual(collapseToQuick(collapsed), collapsed);
});

test('split detail is reported only when collapsing would discard it', () => {
  assert(hasItemSplitDetail(entry));
  assert(hasItemSplitDetail({ ...entry, items: [{ ...entry.items[0], percentages: undefined, units: undefined, quantity: undefined, translations: undefined }] }), 'whole-bill percentages');
  assert(!hasItemSplitDetail(collapseToQuick(entry)));
});

test('only a hand-entered single line can collapse', () => {
  const plain = collapseToQuick(entry);
  assert(isManualSingleLine(plain));
  assert(!isManualSingleLine({ ...plain, receiptId: 'photo' }));
  assert(!isManualSingleLine({ ...plain, draftId: 'draft' }));
  assert(!isManualSingleLine({ ...plain, items: [plain.items[0], { ...plain.items[0], id: 'other' }] }));
});
