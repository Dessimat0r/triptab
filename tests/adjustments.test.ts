import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAdjustments, percentOf, type Adjustment } from '../lib/adjustments';
import { balances, expenseShares, settlements, total, validateLedger, type Expense, type Trip } from '../lib/model';

const members = [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }];
const bogof: Adjustment = { id: 'bogof', kind: 'discount', label: 'BOGOF', amount: 300, scope: { type: 'items', itemIds: ['p1', 'p2'] }, sourceLineIndex: 3, source: 'receipt' };
function receipt(overrides: Partial<Expense> = {}): Expense {
  return { id: 'shop', title: 'Supermarket', date: '2026-11-06', time: '12:00', timezone: 'Europe/London', currency: 'GBP', payer: 'bob',
    tax: 0, tip: 0, discount: 0,
    items: [{ id: 'p1', name: 'Pringles', amount: 300, members: ['alice'] }, { id: 'p2', name: 'Pringles', amount: 300, members: ['alice'] },
      { id: 'milk', name: 'Milk', amount: 150, members: ['alice', 'bob'] }],
    adjustments: [bogof], ...overrides };
}
function shop(expense: Expense, people: { id: string; name: string }[] = members): Trip {
  return { id: 'trip', name: 'Shop', currency: 'GBP', members: people, expenses: [expense], drafts: [], payments: [] };
}
const saved = (expense: Expense, people = members) => validateLedger({ trips: [shop(expense, people)] }).trips[0];

test('acceptance R1: both Pringles to Alice, milk shared, Bob paid', () => {
  const trip = saved(receipt());
  const expense = trip.expenses[0];
  assert.equal(expense.adjustmentAllocation, 'scoped-adjustments');
  assert.deepEqual(expense.items.map(item => item.amount), [300, 300, 150], 'printed prices preserved');
  assert.equal(total(expense), 450);
  assert.deepEqual(expenseShares(expense, members, 'GBP'), [375, 75]);
  assert.deepEqual(balances(trip), [-375, 375]);
  assert.deepEqual(settlements(trip), [{ from: 'alice', to: 'bob', amount: 375 }]);
});

test('acceptance R1: one Pringles each, milk to Bob — the BOGOF saving follows its items', () => {
  const expense = receipt({ payer: 'alice', items: [{ id: 'p1', name: 'Pringles', amount: 300, members: ['alice'] },
    { id: 'p2', name: 'Pringles', amount: 300, members: ['bob'] }, { id: 'milk', name: 'Milk', amount: 150, members: ['bob'] }] });
  const trip = saved(expense);
  assert.deepEqual(expenseShares(trip.expenses[0], members, 'GBP'), [150, 300]);
  assert.deepEqual(settlements(trip), [{ from: 'bob', to: 'alice', amount: 300 }]);
});

test('the old receipt-wide discount leaks the promotion; the scoped discount does not', () => {
  const legacy = receipt({ adjustments: undefined, discount: 300, adjustmentAllocation: 'native-minor-units' });
  assert.deepEqual(expenseShares(legacy, members, 'GBP'), [405, 45], 'the audited £0.30 leak under the receipt-wide rule');
  assert.deepEqual(expenseShares(saved(receipt()).expenses[0], members, 'GBP'), [375, 75]);
});

test('D01: equal prices share equally; unequal prices share in proportion; a manual split overrides', () => {
  assert.deepEqual(applyAdjustments([{ id: 'a', amount: 300 }, { id: 'b', amount: 300 }], [bogof].map(value => ({ ...value, scope: { type: 'items', itemIds: ['a', 'b'] } }))).applied[0].allocation, { a: 150, b: 150 });
  const unequal = applyAdjustments([{ id: 'a', amount: 200 }, { id: 'b', amount: 100 }], [{ id: 'x', kind: 'discount', amount: 100, scope: { type: 'items', itemIds: ['a', 'b'] } }]);
  assert.deepEqual(unequal.applied[0].allocation, { a: 67, b: 33 }); assert.deepEqual(unequal.net, [133, 67]);
  const manual = applyAdjustments([{ id: 'a', amount: 300 }, { id: 'b', amount: 300 }], [{ ...bogof, scope: { type: 'items', itemIds: ['a', 'b'] }, allocation: { a: 0, b: 300 } }]);
  assert.deepEqual(manual.net, [300, 0], 'give the whole saving to the free item');
  // Remainder pennies follow line order, deterministically.
  assert.deepEqual(applyAdjustments([{ id: 'a', amount: 100 }, { id: 'b', amount: 100 }, { id: 'c', amount: 100 }], [{ id: 'x', kind: 'discount', amount: 100, scope: { type: 'items', itemIds: ['a', 'b', 'c'] } }]).net, [66, 67, 67]);
});

test('percentages, receipt-wide discounts and charges', () => {
  assert.equal(percentOf(1999, 10), 200); assert.equal(percentOf(1995, 10), 200); assert.equal(percentOf(1994, 10), 199);
  const halfOff: Adjustment = { id: 'half', kind: 'discount', percent: 50, scope: { type: 'items', itemIds: ['p1', 'p2'] } };
  const viaPercent = saved(receipt({ adjustments: [halfOff] })).expenses[0];
  assert.equal(total(viaPercent), 450); assert.deepEqual(expenseShares(viaPercent, members, 'GBP'), [375, 75], 'test 2: 50% gives the same stored result');
  const wide: Adjustment = { id: 'loyalty', kind: 'discount', percent: 10, scope: { type: 'receipt' } };
  const service: Adjustment = { id: 'service', kind: 'charge', amount: 45, scope: { type: 'receipt' } };
  const both = saved(receipt({ adjustments: [bogof, wide, service] })).expenses[0];
  assert.equal(total(both), 450 - 45 + 45);
  const shares = expenseShares(both, members, 'GBP');
  assert.equal(shares[0] + shares[1], total(both));
});

test('validation: no double counting, no discount beyond its items, explicit references', () => {
  const twice = receipt({ adjustments: [bogof, { ...bogof, id: 'again' }] });
  assert.throws(() => saved(twice), /receipt line can only be applied once/);
  assert.throws(() => saved(receipt({ adjustments: [{ ...bogof, sourceLineIndex: undefined, amount: 601 }] })), /more than the items/);
  assert.throws(() => saved(receipt({ adjustments: [{ ...bogof, scope: { type: 'items', itemIds: ['missing'] } }] })), /not on this receipt/);
  assert.throws(() => saved(receipt({ adjustments: [{ id: 'all', kind: 'discount', amount: 751, scope: { type: 'receipt' } }] })), /more than the receipt total/);
  assert.throws(() => saved(receipt({ adjustments: [{ ...bogof, allocation: { p1: 100, p2: 100 } }] })), /add up/);
  assert.throws(() => saved(receipt({ adjustments: [{ ...bogof, percent: 10 } as Adjustment] })), /either an amount or a percentage/);
  assert.throws(() => saved(receipt({ adjustments: [{ id: 'x', kind: 'discount', percent: 12.345, scope: { type: 'receipt' } }] })), /two decimal/);
});

test('compatibility: entries without adjustments keep their rule and result; dropping discounts needs an explicit empty list', () => {
  const plain = receipt({ adjustments: undefined });
  const stored = saved(plain).expenses[0];
  assert.equal(stored.adjustmentAllocation, 'native-minor-units', 'no new rule without discount records');
  for (const rule of ['selected-participants', 'receipt-total', 'rotating-remainder', 'native-minor-units'] as const) {
    const legacy = { ...plain, discount: 30, adjustmentAllocation: rule };
    const before = expenseShares(legacy, members, 'GBP');
    const after = expenseShares({ ...legacy, adjustments: [] }, members, 'GBP');
    assert.deepEqual(after, before, `${rule} is unchanged by an empty adjustment list`);
  }
  const previous = validateLedger({ trips: [shop(receipt())] });
  const stripped = structuredClone(previous); delete stripped.trips[0].expenses[0].adjustments; stripped.trips[0].expenses[0].title = 'Renamed';
  assert.throws(() => validateLedger(stripped, { previous }), /cannot edit/);
  const removed = structuredClone(previous); removed.trips[0].expenses[0].adjustments = [];
  const result = validateLedger(removed, { previous }).trips[0].expenses[0];
  assert.equal(total(result), 750); assert.equal(result.adjustmentAllocation, 'native-minor-units');
  assert.throws(() => validateLedger({ trips: [shop({ ...receipt(), adjustmentAllocation: 'native-minor-units' })] }, { preserveCalculationRules: true }), /current calculation rule/);
});

test('property: shares always sum to the total and an item discount never changes people off that item', () => {
  let seed = 4242;
  const random = (limit: number) => Math.floor(((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * limit);
  const people = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];
  for (let run = 0; run < 400; run++) {
    const items = Array.from({ length: 2 + random(4) }, (_, index) => ({ id: `i${index}`, name: `I${index}`, amount: 1 + random(5000),
      members: people.filter(() => random(2)).map(person => person.id) }));
    items.forEach(item => { if (!item.members.length) item.members = ['a']; });
    const scope = items.filter(() => random(2)).map(item => item.id);
    if (!scope.length) scope.push(items[0].id);
    const eligible = items.filter(item => scope.includes(item.id)).reduce((sum, item) => sum + item.amount, 0);
    const everything = scope.length === items.length; // keep the total above zero
    const discount: Adjustment = random(2) ? { id: 'd', kind: 'discount', amount: 1 + random(everything ? eligible - 1 : eligible), scope: { type: 'items', itemIds: scope } }
      : { id: 'd', kind: 'discount', percent: 1 + random(everything ? 99 : 100), scope: { type: 'items', itemIds: scope } };
    const base: Expense = { id: `e${run}`, title: 'x', date: '2026-11-06', time: '12:00', timezone: 'Europe/London', currency: 'GBP', payer: 'a', tax: random(300), tip: 0, discount: 0, items };
    const withDiscount = saved({ ...base, adjustments: [discount] }, people).expenses[0];
    const shares = expenseShares(withDiscount, people, 'GBP');
    assert.equal(shares.reduce((sum, share) => sum + share, 0), total(withDiscount), `run ${run} sums`);
    assert(total(withDiscount) <= total(base), `run ${run} never increases`);
    const unaffected = people.filter(person => !items.some(item => scope.includes(item.id) && item.members.includes(person.id)));
    if (!base.tax) {
      const before = expenseShares(saved(base, people).expenses[0], people, 'GBP');
      for (const person of unaffected) {
        const index = people.indexOf(person);
        // Without receipt-wide amounts, people off the discounted lines keep their exact item cost (±1p rounding).
        assert(Math.abs(shares[index] - before[index]) <= 1, `run ${run}: ${person.id} ${before[index]} → ${shares[index]}`);
      }
    }
  }
});

test('acceptance F-01/F-02: a scanned BOGOF line applied as a scoped discount reconciles without any exception', async () => {
  const { RECEIPT_DIFFERENCE_ERROR, acknowledgeReceiptReview, receiptScanSaveError } = await import('../lib/receipt-scan');
  const scan = { version: 1 as const, printedTotal: 450, printedCurrency: 'GBP', status: 'needs-review' as const, warnings: [],
    sourceLines: [{ lineIndex: 3, observedText: 'BOGOF PRINGLES -3.00', amount: -300, kind: 'adjustment' as const, mappedTo: 'unmapped' as const }] };
  const stored = saved(receipt({ receiptScan: scan })).expenses[0];
  assert.equal(stored.receiptScan?.status, 'matched');
  assert.equal(stored.receiptScan?.calculatedTotal, 450);
  assert.equal(stored.receiptScan?.acknowledgement, undefined, 'no acknowledgement used');
  assert.deepEqual(stored.receiptScan?.warnings, []);
  // Negative case: without the discount the £3.00 difference blocks ordinary Save.
  const missing = acknowledgeReceiptReview(receipt({ adjustments: [], receiptScan: scan }));
  assert.equal(receiptScanSaveError(missing), RECEIPT_DIFFERENCE_ERROR);
  assert.throws(() => saved(missing), /do not match the printed receipt/);
});

test('a TripTab JSON backup with discount records imports with the same totals and shares', async () => {
  const { previewImport } = await import('../lib/import-ledger');
  const original = saved(receipt());
  const backup = JSON.stringify({ schemaVersion: 1, amountScale: 100, data: { trips: [original] } });
  const imported = previewImport(backup, 'triptab.json').trips[0];
  const expense = imported.expenses[0];
  assert.deepEqual(expense.adjustments, original.expenses[0].adjustments);
  assert.equal(expense.adjustmentAllocation, 'scoped-adjustments');
  const people = imported.members;
  assert.equal(total(expense), 450);
  assert.deepEqual(expenseShares(expense, people, 'GBP'), expenseShares(original.expenses[0], original.members, 'GBP'));
});
