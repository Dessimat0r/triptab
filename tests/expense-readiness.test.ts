import assert from 'node:assert/strict';
import test from 'node:test';
import { assignUnassignedItems, expenseSaveBlockers, unassignedItemIds } from '../lib/expense-readiness';
import { expenseSchema } from '../lib/model';
import type { ReceiptEditor } from '../lib/receipt-processing';
import { acknowledgeReceiptReview, carryReviewAcknowledgements, pendingReviewActions, receiptScanFingerprint, receiptScanSaveError } from '../lib/receipt-scan';

const trip = { currency: 'EUR' as const };
function receipt(overrides: Partial<ReceiptEditor> = {}): ReceiptEditor {
  return {
    id: 'receipt', draftId: 'draft', receiptId: 'photo', title: 'Lunch', date: '2026-10-05', time: '12:00', timezone: 'Europe/Vienna',
    payer: 'alice', currency: 'EUR', tax: 0, tip: 0, discount: 0,
    items: [
      { id: 'soup', name: 'Soup', amount: 600, members: [] },
      { id: 'pizza', name: 'Pizza', amount: 1200, members: [], quantity: { total: 2, label: 'slices' }, units: { total: 2, allocations: {}, label: 'slices' } },
      { id: 'beer', name: 'Beer', amount: 500, members: ['bob'] },
    ],
    receiptScan: { version: 1, printedTotal: 2300, printedCurrency: 'EUR', status: 'matched', warnings: [] },
    ...overrides,
  };
}

test('one choice assigns every unassigned line and keeps existing splits and printed quantities', () => {
  const entry = receipt();
  assert.deepEqual(unassignedItemIds(entry), ['soup', 'pizza']);
  const next = assignUnassignedItems(entry, ['alice', 'bob', 'alice']);
  assert.deepEqual(next.items.map(item => item.members), [['alice', 'bob'], ['alice', 'bob'], ['bob']]);
  assert.equal(next.items[1].units, undefined, 'pending consumption units are replaced by an equal split');
  assert.deepEqual(next.items[1].quantity, { total: 2, label: 'slices' }, 'printed quantity stays as evidence');
  assert.deepEqual(unassignedItemIds(next), []);
  assert.equal(expenseSchema.safeParse(next).success, true);
  assert.equal(assignUnassignedItems(next, ['alice']), next, 'nothing left to assign is a no-op');
  assert.equal(assignUnassignedItems(entry, []), entry);
});

test('a whole-receipt percentage split has no unassigned lines to choose for', () => {
  const entry = receipt({ percentages: { alice: 50, bob: 50 } });
  assert.deepEqual(unassignedItemIds(entry), []);
  assert.equal(assignUnassignedItems(entry, ['alice']), entry);
});

test('a reviewed difference stays acknowledged when only people are assigned, not when a price changes', () => {
  const mismatch = receipt({ receiptScan: { version: 1, printedTotal: 2301, printedCurrency: 'EUR', status: 'matched', warnings: [] } });
  const acknowledged = acknowledgeReceiptReview(mismatch);
  assert.equal(receiptScanSaveError(acknowledged), null);
  const assigned = assignUnassignedItems(acknowledged, ['alice']);
  assert.equal(receiptScanSaveError(assigned), null, 'assignment carries the acknowledgement');
  assert.notEqual(assigned.receiptScan!.acknowledgement!.fingerprint, acknowledged.receiptScan!.acknowledgement!.fingerprint);
  assert.equal(assigned.receiptScan!.acknowledgement!.fingerprint, receiptScanFingerprint(assigned));
  const repriced = { ...assigned, items: assigned.items.map(item => item.id === 'soup' ? { ...item, amount: 700 } : item) };
  assert.match(receiptScanSaveError(repriced)!, /do not match/, 'a price change still needs a new check');
});

test('a stale acknowledgement is never refreshed by an allocation change', () => {
  const stale = receiptScanFingerprint(receipt({ tax: 1 }));
  const mismatch = receipt({ receiptScan: { version: 1, printedTotal: 2301, printedCurrency: 'EUR', status: 'matched', warnings: [], acknowledgement: { fingerprint: stale } } });
  const next = carryReviewAcknowledgements(mismatch, { ...mismatch, items: mismatch.items.map(item => ({ ...item, members: ['alice'] })) });
  assert.equal(next.receiptScan!.acknowledgement!.fingerprint, stale);
  assert.match(receiptScanSaveError(next)!, /do not match/);
});

test('one review action confirms every checkable warning, a difference and a missing printed total together', () => {
  const entry = receipt({
    items: receipt().items.map(item => ({ ...item, members: ['alice'], scanSource: { confidence: 'low' as const } })),
    receiptScan: { version: 1, printedTotal: null, printedSubtotal: 2200, printedCurrency: 'EUR', status: 'incomplete', warnings: [
      { code: 'possible-duplicate', itemIds: ['soup', 'pizza'] }, { code: 'image-may-be-incomplete' },
    ] },
  });
  assert.equal(pendingReviewActions(entry), 3 + 1 + 1 + 1 + 1, 'three low-confidence lines, image, subtotal difference and missing total');
  assert(receiptScanSaveError(entry));
  const reviewed = acknowledgeReceiptReview(entry);
  assert.equal(pendingReviewActions(reviewed), 0);
  assert.equal(receiptScanSaveError(reviewed), null);
  assert.equal(reviewed.receiptScan!.printedTotal, null, 'no printed evidence is invented');
});

test('one review action cannot dismiss an unreadable price or a different printed currency', () => {
  const unreadable = acknowledgeReceiptReview(receipt({ items: [{ id: 'soup', name: 'Soup', amount: null, members: ['alice'] }] }));
  assert.match(receiptScanSaveError(unreadable)!, /Complete unreadable/);
  const currency = acknowledgeReceiptReview(receipt({ currency: 'GBP', items: receipt().items.map(item => ({ ...item, members: ['alice'] })) }));
  assert.match(receiptScanSaveError(currency)!, /resolve the receipt scan warnings/);
  assert(expenseSaveBlockers(currency, { currency: 'GBP' }).some(blocker => blocker.key === 'scan-currency'));
});

test('the save checklist names each remaining step and is empty once the expense can be saved', () => {
  const entry = receipt({ title: ' ', currency: 'CZK', receiptScan: { version: 1, printedTotal: 2300, printedCurrency: 'CZK', status: 'matched', warnings: [] } });
  const keys = expenseSaveBlockers(entry, trip).map(blocker => blocker.key);
  assert.deepEqual(keys, ['title', 'unassigned', 'fx']);
  assert.match(expenseSaveBlockers(entry, trip).find(blocker => blocker.key === 'unassigned')!.message, /2 items/);
  const ready = assignUnassignedItems({ ...entry, title: 'Lunch', fx: { rate: 0.04, asOf: '2026-10-05', source: 'reference' } }, ['alice', 'bob']);
  assert.deepEqual(expenseSaveBlockers(ready, trip), []);
  assert.equal(expenseSchema.safeParse(ready).success, true);
  assert.deepEqual(expenseSaveBlockers({ ...ready, bankAmount: 0 }, trip).map(blocker => blocker.key), ['bank']);
});

test('the save checklist reports unreadable prices, unfinished item splits and review points', () => {
  const entry = receipt({
    items: [{ id: 'soup', name: '', amount: null, members: ['alice'] }, { id: 'pizza', name: 'Pizza', amount: 1200, members: ['alice', 'bob'], percentages: { alice: 10, bob: 10 } }],
    receiptScan: { version: 1, printedTotal: null, printedCurrency: 'EUR', status: 'incomplete', warnings: [] },
  });
  assert.deepEqual(expenseSaveBlockers(entry, trip).map(blocker => blocker.key), ['prices', 'names', 'review', 'item-split']);
});
