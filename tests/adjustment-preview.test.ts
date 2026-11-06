import assert from 'node:assert/strict';
import test from 'node:test';
import { adjustmentCandidates, previewAdjustment } from '../lib/adjustment-preview';
import { applyAdjustments, type Adjustment } from '../lib/adjustments';
import { expenseShares, total, validateLedger, type Expense, type Trip } from '../lib/model';
import type { ReceiptEditor } from '../lib/receipt-processing';

// R03: the discount form previewed the edited adjustment appended to the end of
// the list while Save replaced it in place, so a fixed amount before a
// percentage previewed one total and stored another.

const members = [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }, { id: 'cara', name: 'Cara', weight: 2 }];
const fixed = (id: string, amount: number, itemIds?: string[]): Adjustment => ({ id, kind: 'discount', amount, scope: itemIds ? { type: 'items', itemIds } : { type: 'receipt' } });
const percent = (id: string, value: number, itemIds?: string[]): Adjustment => ({ id, kind: 'discount', percent: value, scope: itemIds ? { type: 'items', itemIds } : { type: 'receipt' } });
const charge = (id: string, amount: number): Adjustment => ({ id, kind: 'charge', amount, scope: { type: 'receipt' } });

function editor(items: [string, number, string[]][], adjustments: Adjustment[], rule?: Expense['adjustmentAllocation']): ReceiptEditor {
  return { id: 'entry', title: 'Lunch', date: '2026-11-06', time: '12:00', timezone: 'Europe/London', currency: 'GBP', payer: 'alice',
    tax: 0, tip: 0, discount: 0, items: items.map(([id, amount, people]) => ({ id, name: id, amount, members: people })), adjustments,
    ...(rule ? { adjustmentAllocation: rule } : {}) } as unknown as ReceiptEditor;
}

/** Save → server validation → stored entry, as a ledger write would store it. */
function persist(entry: ReceiptEditor, adjustments: Adjustment[]): Expense {
  const expense = { ...structuredClone(entry), adjustments } as unknown as Expense;
  const trip: Trip = { id: 'trip', name: 'Trip', currency: 'GBP', members, expenses: [expense], drafts: [], payments: [] };
  return validateLedger({ trips: [trip] }).trips[0].expenses[0];
}

test('R03: the reported case previews and stores £4.00, and the old append order would have shown £3.00', () => {
  const entry = editor([['a', 500, ['alice']], ['b', 500, ['bob']]], [fixed('one', 100), percent('half', 50)]);
  const edited = fixed('one', 200);
  const preview = previewAdjustment(entry, members, edited, 'one');
  assert.deepEqual(preview.list!.map(value => value.id), ['one', 'half']);
  assert.equal(preview.outcome!.total, 400);
  const stored = persist(entry, preview.list!);
  assert.equal(total(stored), 400);
  // The defect: appending the edited row after the percentage.
  const appended = applyAdjustments(entry.items, [percent('half', 50), edited]);
  assert.equal(appended.net.reduce<number>((sum, net) => sum + (net ?? 0), 0) + appended.receiptDelta, 300);
});

test('R03: an edited adjustment keeps its position; only a new one is appended', () => {
  const list = [fixed('a', 1), fixed('b', 2), fixed('c', 3)];
  assert.deepEqual(adjustmentCandidates(list, fixed('a', 9), 'a').map(value => [value.id, value.amount]), [['a', 9], ['b', 2], ['c', 3]]);
  assert.deepEqual(adjustmentCandidates(list, fixed('b', 9), 'b').map(value => [value.id, value.amount]), [['a', 1], ['b', 9], ['c', 3]]);
  assert.deepEqual(adjustmentCandidates(list, fixed('c', 9), 'c').map(value => [value.id, value.amount]), [['a', 1], ['b', 2], ['c', 9]]);
  assert.deepEqual(adjustmentCandidates(list, fixed('d', 9)).map(value => value.id), ['a', 'b', 'c', 'd']);
  // An unknown editing ID (the row was removed meanwhile) is a new row, never a silent drop.
  assert.deepEqual(adjustmentCandidates(list, fixed('z', 9), 'gone').map(value => value.id), ['a', 'b', 'c', 'z']);
});

test('R03: preview total and shares equal the stored payload and its persisted result for every position, kind, scope and odd penny', () => {
  const items: [string, number, string[]][] = [['p1', 333, ['alice']], ['p2', 501, ['bob', 'cara']], ['p3', 167, ['alice', 'bob', 'cara']]];
  const lists: Adjustment[][] = [
    [fixed('x', 101), percent('y', 33.33), fixed('z', 7, ['p2', 'p3'])],
    [percent('x', 12.5, ['p1', 'p3']), fixed('y', 99), percent('z', 50)],
    [fixed('x', 250, ['p1', 'p2']), charge('y', 45), percent('z', 10, ['p2'])],
  ];
  const replacements = (adjustment: Adjustment): Adjustment[] => [
    { ...adjustment, ...(adjustment.amount !== undefined ? { amount: adjustment.amount + 37 } : { percent: 25 }) },
    adjustment.percent !== undefined ? { ...adjustment, percent: undefined, amount: 61 } as Adjustment : { ...adjustment, amount: undefined, percent: 15 } as Adjustment,
    { ...adjustment, scope: adjustment.scope.type === 'receipt' ? { type: 'items', itemIds: ['p2', 'p3'] } : { type: 'receipt' } } as Adjustment,
  ];
  let checked = 0;
  for (const rule of [undefined, 'native-minor-units', 'scoped-adjustments'] as const) {
    for (const list of lists) {
      for (const [position, original] of list.entries()) {
        for (const replacement of replacements(original)) {
          if (replacement.kind === 'charge' && replacement.percent !== undefined) continue;
          const entry = editor(items, list, rule);
          const preview = previewAdjustment(entry, members, replacement, original.id);
          if (!preview.outcome) continue;
          assert.equal(preview.list![position].id, original.id, 'edited in place');
          const stored = persist(entry, preview.list!);
          assert.deepEqual(stored.adjustments, preview.list, 'payload is the previewed list');
          assert.equal(stored.adjustmentAllocation, 'scoped-adjustments');
          assert.equal(preview.outcome.total, total(stored), `total for ${original.id} at ${position}`);
          const before = previewAdjustment(entry, members, null, original.id).before;
          const baseline = persist(entry, list.filter(value => value.id !== original.id));
          const changes = expenseShares(stored, members, 'GBP').map((share, index) => share - expenseShares(baseline, members, 'GBP')[index]);
          assert.deepEqual(preview.outcome.changes, members.map((member, index) => ({ id: member.id, change: changes[index] })).filter(value => value.change));
          assert.deepEqual(before.net, applyAdjustments(entry.items, list.filter(value => value.id !== original.id)).net);
          checked++;
        }
      }
    }
  }
  assert.ok(checked >= 40, `checked ${checked} edits`);
});

test('R03: a preview of a legacy-rule entry uses the rule Save stamps, not the stale stored rule', () => {
  // Three equal people on 100 pence: per-item rounding (legacy) and receipt-total
  // rounding differ in who gets the odd penny once a discount is added.
  const entry = editor([['a', 100, ['alice', 'bob', 'cara']], ['b', 100, ['alice', 'bob', 'cara']]], [], 'selected-participants');
  const preview = previewAdjustment(entry, members, fixed('new', 1));
  const stored = persist(entry, preview.list!);
  assert.equal(stored.adjustmentAllocation, 'scoped-adjustments');
  const baseline = persist(entry, []);
  const changes = expenseShares(stored, members, 'GBP').map((share, index) => share - expenseShares(baseline, members, 'GBP')[index]);
  assert.deepEqual(preview.outcome!.changes, members.map((member, index) => ({ id: member.id, change: changes[index] })).filter(value => value.change));
});
