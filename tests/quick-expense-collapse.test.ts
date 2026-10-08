import assert from 'node:assert/strict';
import test from 'node:test';
import { collapseToQuick, hasItemSplitDetail, isManualSingleLine, quickEligible, singleReceiptLineEligible } from '../lib/quick-expense';
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

test('collapse keeps the line, its people and shares, and clears what one amount cannot show', () => {
  const before = structuredClone(entry);
  const collapsed = collapseToQuick(entry);
  assert(quickEligible(collapsed));
  assert.equal(collapsed.percentages, undefined, 'whole-bill percentages do not apply to one amount');
  assert.deepEqual(collapsed.items[0], {
    id: 'line', name: 'Dinner', amount: 2000, members: ['sam'],
    percentages: { sam: 100 }, units: { total: 2, allocations: { sam: 2 } }, quantity: undefined,
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
  assert(!hasItemSplitDetail({ ...entry, percentages: undefined, items: [{ ...entry.items[0], quantity: undefined, translations: undefined }] }), 'line shares survive collapsing');
  assert(!hasItemSplitDetail(collapseToQuick(entry)));
});

test('a single receipt line uses the single-amount layout without being renamed', () => {
  const line = { ...entry, percentages: undefined, receiptId: 'photo' };
  assert(singleReceiptLineEligible(line));
  assert(!quickEligible(line), 'the manual quick form is for typed expenses only');
  assert.equal(line.items[0].name, 'Other name');
  assert(singleReceiptLineEligible({ ...line, items: [{ ...line.items[0], name: '', amount: null, members: [] }] }), 'unread lines still use it; their name and price are corrected beside the amount');
  assert(!singleReceiptLineEligible({ ...line, items: [line.items[0], { ...line.items[0], id: 'other' }] }));
  assert(!singleReceiptLineEligible({ ...line, percentages: { gary: 50, sam: 50 } }), 'a whole-bill split keeps the item list');
  assert(!singleReceiptLineEligible(collapseToQuick(entry)), 'a typed expense is never a receipt line');
});

test('only a hand-entered single line can collapse', () => {
  const plain = collapseToQuick(entry);
  assert(isManualSingleLine(plain));
  assert(!isManualSingleLine({ ...plain, receiptId: 'photo' }));
  assert(!isManualSingleLine({ ...plain, draftId: 'draft' }));
  assert(!isManualSingleLine({ ...plain, items: [plain.items[0], { ...plain.items[0], id: 'other' }] }));
});
