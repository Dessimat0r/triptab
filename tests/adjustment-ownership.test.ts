import assert from 'node:assert/strict';
import test from 'node:test';
import { claimEditedProposals, personControlled, type Adjustment } from '../lib/adjustments';
import { applyReceiptTranscription, type ReceiptTranscription } from '../lib/receipt-ai';
import { expenseShares, total, validateLedger, type Draft, type Expense, type Trip } from '../lib/model';
import { createReceiptFlowWorker } from './helpers/receipt-flow-worker';

// R05: a person who edits a discount the reading extracted owns it. Before the
// fix the record kept source 'receipt', so a rescan replaced the manual split
// {p1:0,p2:300} with the automatic 150/150: shares moved 300/150 → 150/300
// while the total stayed 450, so reconciliation could not notice.

const members = [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }];
const trip: Trip = { id: 'shop', name: 'Shop', currency: 'GBP', members, expenses: [], payments: [], drafts: [] };
const waiting: Draft = { id: 'draft', title: '', currency: 'GBP', payer: 'bob', items: [], tax: 0, tip: 0, discount: 0, receiptId: 'photo', status: 'waiting', source: 'manual' };
const bogofProposal = { kind: 'discount' as const, label: 'BOGOF PRINGLES', amount: 300, percent: null, scope: 'items' as const, itemIndexes: [0, 1], sourceLineIndex: 3, confidence: 'high' as const };
const reading = (ids?: string[]): ReceiptTranscription => ({
  title: 'Tesco Express', currency: 'GBP', tax: 0, tip: 0, discount: 0, printedTotal: 450, date: '2026-11-06', time: '12:00', summary: 'Two Pringles with BOGOF and milk.',
  items: [['PRINGLES', 300, 0], ['PRINGLES', 300, 1], ['MILK', 150, 2]].map(([name, amount, lineIndex], index) => ({ id: ids?.[index] ?? null, name: name as string, amount: amount as number,
    scanSource: { lineIndex: lineIndex as number, observedText: `${name} ${(amount as number / 100).toFixed(2)}`, confidence: 'high' as const } })),
  sourceLines: [{ lineIndex: 3, observedText: 'BOGOF PRINGLES -3.00', confidence: 'high', kind: 'adjustment', amount: -300, mappedTo: 'adjustment' }],
  warnings: [], adjustments: [bogofProposal],
});

/** One Pringles Alice, second Pringles and milk Bob: the second invariant split. */
function assigned(draft: Draft): Draft {
  return { ...draft, items: draft.items.map((item, index) => ({ ...item, members: index === 0 ? ['alice'] : ['bob'] })) };
}
function personSave(previous: Trip, next: Trip): Trip {
  return validateLedger({ trips: [next] }, { previous: { trips: [previous] }, source: 'web', claimEditedProposals: true }).trips[0];
}
function post(draft: Draft): Expense {
  const { status, ...rest } = draft; void status;
  const expense = { ...rest, id: 'posted', sourceDraftId: draft.id, title: 'Tesco', date: '2026-11-06', time: '12:00', timezone: 'Europe/London', currency: 'GBP' } as Expense;
  return validateLedger({ trips: [{ ...trip, drafts: [draft], expenses: [expense] }] }).trips[0].expenses[0];
}

test('R05: claim rule - an edited proposal becomes the person\'s, an untouched one and a new one stay exactly as sent', () => {
  const proposal: Adjustment = { id: 'a', kind: 'discount', amount: 300, scope: { type: 'items', itemIds: ['p1', 'p2'] }, sourceLineIndex: 3, source: 'receipt' };
  const earlier = new Map([[proposal.id, proposal]]);
  assert.deepEqual(claimEditedProposals([proposal], earlier), [proposal], 'unchanged');
  for (const edited of [{ ...proposal, amount: 250 }, { ...proposal, scope: { type: 'items' as const, itemIds: ['p1'] } },
    { ...proposal, allocation: { p1: 0, p2: 300 } }, { ...proposal, label: 'Mine' }, { ...proposal, kind: 'charge' as const }]) {
    const [claimed] = claimEditedProposals([edited], earlier);
    assert.equal(claimed.source, 'user');
    assert.equal(claimed.sourceLineIndex, 3, 'printed-line evidence kept');
    assert.deepEqual({ ...claimed, source: undefined }, { ...edited, source: undefined });
  }
  assert.deepEqual(claimEditedProposals([{ ...proposal, id: 'new' }], earlier), [{ ...proposal, id: 'new' }], 'no earlier version: exact');
  const mine = { ...proposal, source: 'user' as const };
  assert.equal(claimEditedProposals([proposal], new Map([[mine.id, mine]]))[0].source, 'user', 'a stale copy cannot demote a person\'s record');
  assert.equal(personControlled({}), true);
  assert.equal(personControlled({ source: 'receipt' }), false);
});

test('R05: only a person\'s write claims; processing, assistant and import validation never do', () => {
  const extracted = applyReceiptTranscription(trip, waiting, reading());
  const before = { ...trip, drafts: [assigned(extracted)] };
  const [adjustment] = extracted.adjustments!;
  const edited = { ...before, drafts: [{ ...before.drafts[0], adjustments: [{ ...adjustment, allocation: { [extracted.items[0].id]: 0, [extracted.items[1].id]: 300 } }] }] };
  for (const options of [{}, { source: 'mcp' as const }, { source: 'web' as const }]) {
    assert.equal(validateLedger({ trips: [structuredClone(edited)] }, { previous: { trips: [before] }, ...options }).trips[0].drafts[0].adjustments![0].source, 'receipt');
  }
  assert.equal(personSave(before, structuredClone(edited)).drafts[0].adjustments![0].source, 'user');
});

test('R05: extract, override allocation, save the draft, rescan and post - the person\'s split and the 300/150 shares survive', () => {
  const extracted = applyReceiptTranscription(trip, waiting, reading());
  const ids = extracted.items.map(item => item.id);
  const [adjustment] = extracted.adjustments!;
  assert.equal(adjustment.source, 'receipt');
  const stored = { ...trip, drafts: [assigned(extracted)] };
  // The person splits the saving onto the second Pringles only.
  const override = { ...adjustment, allocation: { [ids[0]]: 0, [ids[1]]: 300 } };
  const saved = personSave(stored, { ...stored, drafts: [{ ...stored.drafts[0], adjustments: [override] }] });
  assert.deepEqual(saved.drafts[0].adjustments, [{ ...override, source: 'user' }]);
  const rescanned = applyReceiptTranscription(saved, saved.drafts[0], reading(ids));
  assert.deepEqual(rescanned.adjustments, [{ ...override, source: 'user' }], 'kept exactly, not duplicated');
  const expense = post(rescanned);
  assert.equal(total(expense), 450);
  assert.deepEqual(expenseShares(expense, members, 'GBP'), [300, 150]);
  // Control: an untouched proposal is a reading's and a rescan may replace it,
  // which is the redistribution the review saw once a person's edit was lost.
  const unclaimed = applyReceiptTranscription(stored, { ...stored.drafts[0], adjustments: [override] }, reading(ids));
  assert.deepEqual(expenseShares(post(unclaimed), members, 'GBP'), [150, 300]);
});

test('R05: overriding the amount or the items is kept through a rescan too', () => {
  const extracted = applyReceiptTranscription(trip, waiting, reading());
  const ids = extracted.items.map(item => item.id);
  const [adjustment] = extracted.adjustments!;
  const stored = { ...trip, drafts: [assigned(extracted)] };
  for (const override of [{ ...adjustment, amount: 200 }, { ...adjustment, scope: { type: 'items' as const, itemIds: [ids[1]] } }]) {
    const saved = personSave(stored, { ...stored, drafts: [{ ...stored.drafts[0], adjustments: [override] }] });
    const rescanned = applyReceiptTranscription(saved, saved.drafts[0], reading(ids));
    assert.deepEqual(rescanned.adjustments, [{ ...override, source: 'user' }]);
  }
});

test('R05: through the production routes, a person\'s edit is stored as theirs and an MCP rescan keeps it or refuses to remove its line', async () => {
  const flow = await createReceiptFlowWorker();
  try {
    const seeded = await flow.readLedger();
    const base = seeded.data.trips.find(value => value.id === flow.tripId)!;
    const proposal: Adjustment = { id: 'bogof', kind: 'discount', label: 'BOGOF', amount: 300, scope: { type: 'items', itemIds: ['p1', 'p2'] }, sourceLineIndex: 3, source: 'receipt' };
    const draft: Draft = { id: 'scan', title: 'Tesco', currency: 'GBP', payer: 'bob', tax: 0, tip: 0, discount: 0, status: 'review', source: 'ai',
      items: [{ id: 'p1', name: 'Pringles', amount: 300, members: ['alice'] }, { id: 'p2', name: 'Pringles', amount: 300, members: ['bob'] }, { id: 'milk', name: 'Milk', amount: 150, members: ['bob'] }],
      adjustments: [proposal] };
    const write = async (revision: number, drafts: Draft[], expenses: Expense[] = []) => {
      const response = await flow.browserRequest('/api/ledger', { method: 'POST', body: JSON.stringify({ revision, data: { trips: [{ ...base, drafts, expenses }] } }) });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json() as Promise<{ revision: number; data: { trips: Trip[] } }>;
    };
    const created = await write(seeded.revision, [draft]);
    assert.equal(created.data.trips[0].drafts[0].adjustments![0].source, 'receipt', 'a new record is stored exactly');
    const override = { ...proposal, allocation: { p1: 0, p2: 300 } };
    const edited = await write(created.revision, [{ ...draft, adjustments: [override] }]);
    assert.deepEqual(edited.data.trips.find(value => value.id === flow.tripId)!.drafts[0].adjustments, [{ ...override, source: 'user' }]);

    const mcp = async (changes: Record<string, unknown>) => {
      const revision = (await flow.readLedger()).revision;
      return flow.toolCall('update_receipt_draft', { trip_id: flow.tripId, revision, draft: { id: 'scan', ...changes } });
    };
    const rescan = await mcp({ adjustments: [{ id: 'assistant-bogof', kind: 'discount', label: 'BOGOF', amount: 300, scope: { type: 'items', itemIds: ['p1', 'p2'] }, sourceLineIndex: 3 }] });
    assert.notEqual(rescan.result?.isError, true, JSON.stringify(rescan));
    let stored = (await flow.readLedger()).data.trips.find(value => value.id === flow.tripId)!;
    assert.deepEqual(stored.drafts[0].adjustments, [{ ...override, source: 'user' }], 'kept exactly, no duplicate for its line');
    const removal = await mcp({ removeItemIds: ['p1'] });
    assert.equal(removal.result?.isError ?? !!removal.error, true, 'removing a line a person\'s discount uses is refused');
    stored = (await flow.readLedger()).data.trips.find(value => value.id === flow.tripId)!;
    assert.deepEqual(stored.drafts[0].items.map(item => item.id), ['p1', 'p2', 'milk']);
    assert.deepEqual(stored.drafts[0].adjustments, [{ ...override, source: 'user' }]);
    // Posting stores the person's split and shares.
    const { status, ...rest } = stored.drafts[0]; void status;
    const expense = { ...rest, id: 'posted', sourceDraftId: 'scan', date: '2026-11-06', time: '12:00', timezone: 'Europe/London', currency: 'GBP' } as Expense;
    const posted = await write((await flow.readLedger()).revision, [], [expense]);
    const saved = posted.data.trips.find(value => value.id === flow.tripId)!.expenses[0];
    assert.deepEqual(saved.adjustments, [{ ...override, source: 'user' }]);
    assert.deepEqual(expenseShares(saved, members, 'GBP'), [300, 150]);
  } finally { await flow.dispose(); }
});
