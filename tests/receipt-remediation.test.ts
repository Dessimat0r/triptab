import assert from 'node:assert/strict';
import test from 'node:test';
import { auditHistoricalReceipts } from '../lib/historical-receipt-audit';
import { acknowledgeReceiptDifference, acknowledgeReceiptReview, receiptScanFingerprint, receiptScanSaveError, reconcileReceiptScan } from '../lib/receipt-scan';
import { expenseShares, total, validateLedger, type Expense, type Ledger } from '../lib/model';

function receipt(): Expense {
  return { id: 'bogof', title: 'Supermarket', date: '2026-11-06', time: '12:00', timezone: 'Europe/London',
    currency: 'GBP', payer: 'bob', tax: 0, tip: 0, discount: 0, receiptId: 'photo',
    items: [{ id: 'p1', name: 'Pringles', amount: 300, members: ['alice'] }, { id: 'p2', name: 'Pringles', amount: 300, members: ['alice'] }, { id: 'milk', name: 'Milk', amount: 150, members: ['alice', 'bob'] }],
    receiptScan: { version: 1, printedTotal: 450, printedCurrency: 'GBP', status: 'matched', warnings: [],
      sourceLines: [{ lineIndex: 3, observedText: 'BOGOF -3.00', amount: -300, kind: 'adjustment', mappedTo: 'unmapped' }] } };
}
function ledger(expense = receipt()): Ledger { return { trips: [{ id: 'shopping', name: 'Shopping', currency: 'GBP', members: [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }], expenses: [expense], drafts: [], payments: [] }] }; }

test('F-01 BOGOF 750 versus printed 450 cannot pass ordinary Save or a legacy reasonless acknowledgement', () => {
  const ordinary = acknowledgeReceiptReview(receipt());
  assert.equal(total(ordinary), 750);
  assert.match(receiptScanSaveError(ordinary)!, /written reason/);
  assert.throws(() => validateLedger(ledger(ordinary)), /written reason/);
  const reasonless = { ...ordinary, receiptScan: { ...ordinary.receiptScan!, acknowledgement: { fingerprint: receiptScanFingerprint(ordinary) } } };
  assert.throws(() => validateLedger(ledger(reasonless)), /written reason/);
});

test('F-01 explicit exception stores a trimmed reason and remains unreconciled; MCP cannot create it', () => {
  for (const invalid of ['', '  ', 'x'.repeat(501)]) assert.throws(() => acknowledgeReceiptDifference(receipt(), invalid));
  const exception = acknowledgeReceiptDifference(receipt(), '  Missing qualifying items need investigation.  ');
  const saved = validateLedger(ledger(exception));
  assert.equal(saved.trips[0].expenses[0].receiptScan!.acknowledgement!.reason, 'Missing qualifying items need investigation.');
  assert.equal(saved.trips[0].expenses[0].receiptScan!.status, 'needs-review');
  assert.throws(() => validateLedger(ledger(exception), { source: 'mcp' }), /person/);
  const changed = { ...exception, items: exception.items.map(item => ({ ...item, amount: item.amount! + 1 })) };
  assert.match(receiptScanSaveError(changed)!, /written reason/);
});

test('F-01 saved scan evidence cannot be discarded on editing or draft promotion', () => {
  const previous = ledger(acknowledgeReceiptDifference(receipt(), 'Reviewed the difference.'));
  const stripped = structuredClone(previous); delete stripped.trips[0].expenses[0].receiptScan;
  assert.throws(() => validateLedger(stripped, { previous }), /Keep the saved receipt evidence/);
  const draft = { ...receipt(), id: 'draft', status: 'review' as const };
  const before: Ledger = { trips: [{ ...previous.trips[0], expenses: [], drafts: [draft] }] };
  assert.throws(() => validateLedger(ledger({ ...receipt(), id: 'new', sourceDraftId: 'draft', receiptScan: undefined }), { previous: before }), /Keep the saved receipt evidence/);
  assert.throws(() => validateLedger(ledger({ ...receipt(), id: 'new', receiptScan: undefined }), { previous: before }), /Keep the saved receipt evidence/);
});

test('F-01 integer reconciliation property: every nonzero total difference requires a current written exception', () => {
  for (let difference = -200; difference <= 200; difference++) {
    const entry = { ...receipt(), receiptScan: { ...receipt().receiptScan!, printedTotal: 750 + difference, sourceLines: [] } };
    const ordinary = acknowledgeReceiptReview(entry);
    assert.equal(receiptScanSaveError(ordinary) === null, difference === 0);
    if (difference) assert.equal(receiptScanSaveError(acknowledgeReceiptDifference(entry, `Verified difference ${difference}.`)), null);
  }
});

test('historical report classifies evidence without modifying any financial result or its input', () => {
  const original = ledger();
  const known = receipt(); known.id = 'known';
  const acknowledged = acknowledgeReceiptDifference(receipt(), 'Old agreed exception.'); acknowledged.id = 'acknowledged';
  const potential = receipt(); potential.id = 'potential'; potential.receiptScan!.printedTotal = 750;
  const unknown = receipt(); unknown.id = 'unknown'; unknown.receiptScan!.printedTotal = null;
  const refund = receipt(); refund.id = 'refund'; refund.receiptScan!.printedTotal = 750;
  refund.receiptScan!.sourceLines = [{ observedText: 'RETURN -3.00', amount: -300, kind: 'other', mappedTo: 'included' }];
  original.trips[0].expenses = [known, acknowledged, potential, unknown, refund];
  const before = JSON.stringify(original);
  const balancesBefore = original.trips[0].expenses.map(entry => expenseShares(entry, original.trips[0].members, 'GBP'));
  const report = auditHistoricalReceipts(original);
  assert.equal(report.find(value => value.expenseId === 'known')!.classification, 'confirmed-discrepancy');
  assert.equal(report.find(value => value.expenseId === 'known')!.difference, 300);
  assert.equal(report.find(value => value.expenseId === 'acknowledged')!.classification, 'explicitly-acknowledged-discrepancy');
  assert.equal(report.find(value => value.expenseId === 'potential')!.classification, 'potential-missing-discount');
  assert.equal(report.find(value => value.expenseId === 'unknown')!.classification, 'potential-missing-discount');
  assert.equal(report.some(value => value.expenseId === 'refund'), false);
  assert.equal(JSON.stringify(original), before);
  assert.deepEqual(original.trips[0].expenses.map(entry => expenseShares(entry, original.trips[0].members, 'GBP')), balancesBefore);
  assert.equal(reconcileReceiptScan(original.trips[0].expenses[0])!.calculatedTotal, 750);
});

test('historical report treats a promotion applied as a scoped discount as accounted for', () => {
  const fixed: Expense = { ...receipt(), id: 'fixed', adjustments: [{ id: 'bogof', kind: 'discount', amount: 300, scope: { type: 'items', itemIds: ['p1', 'p2'] }, sourceLineIndex: 3, source: 'user' }] };
  const report = auditHistoricalReceipts({ trips: [{ ...ledger().trips[0], expenses: [validateLedger(ledger(fixed)).trips[0].expenses[0]] }] });
  assert.equal(report.length, 0, 'a reconciled, discount-applied receipt is clean');
});
