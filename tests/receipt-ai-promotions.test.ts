import assert from 'node:assert/strict';
import test from 'node:test';
import { applyReceiptTranscription, receiptTranscriptionSchema, type ReceiptTranscription } from '../lib/receipt-ai';
import { reconcileReceiptScan } from '../lib/receipt-scan';
import { expenseShares, total, validateLedger, type Draft, type Trip } from '../lib/model';

const trip: Trip = { id: 'shop', name: 'Shop', currency: 'GBP', members: [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }], expenses: [], payments: [], drafts: [] };
const waiting: Draft = { id: 'draft', title: '', currency: 'GBP', payer: 'bob', items: [], tax: 0, tip: 0, discount: 0, receiptId: 'photo', status: 'waiting', source: 'manual' };
const line = (lineIndex: number, observedText: string, amount: number, kind: 'item' | 'adjustment', mappedTo: 'adjustment' | 'unmapped' | null = null) =>
  ({ lineIndex, observedText, confidence: 'high' as const, kind, amount, mappedTo });
// R1 exactly as the prompt now instructs the model to return it.
const r1 = (adjustments: ReceiptTranscription['adjustments'], mapped: 'adjustment' | 'unmapped' = 'adjustment'): ReceiptTranscription => ({
  title: 'Tesco Express', currency: 'GBP', tax: 0, tip: 0, discount: 0, printedTotal: 450, date: '2026-11-06', time: '12:00', summary: 'Two Pringles with BOGOF and milk.',
  items: [{ id: null, name: 'PRINGLES ORIGINAL 200G', amount: 300, scanSource: { lineIndex: 0, observedText: 'PRINGLES 3.00', confidence: 'high' } },
    { id: null, name: 'PRINGLES ORIGINAL 200G', amount: 300, scanSource: { lineIndex: 1, observedText: 'PRINGLES 3.00', confidence: 'high' } },
    { id: null, name: 'SEMI SKIMMED MILK 2PT', amount: 150, scanSource: { lineIndex: 2, observedText: 'MILK 1.50', confidence: 'high' } }],
  sourceLines: [line(3, 'BOGOF PRINGLES -3.00', -300, 'adjustment', mapped)],
  warnings: mapped === 'unmapped' ? [{ code: 'unmapped-adjustment', lineIndex: 3, observedText: 'BOGOF PRINGLES -3.00' }] : [],
  adjustments,
});
const bogof = { kind: 'discount' as const, label: 'BOGOF PRINGLES', amount: 300, percent: null, scope: 'items' as const, itemIndexes: [0, 1], sourceLineIndex: 3, confidence: 'high' as const };

test('F-10: a clear BOGOF becomes a scoped discount on its two lines and the receipt matches', () => {
  const draft = applyReceiptTranscription(trip, waiting, r1([bogof]));
  assert.equal(draft.discount, 0);
  assert.equal(draft.adjustments?.length, 1);
  const [adjustment] = draft.adjustments!;
  assert.deepEqual(adjustment.scope, { type: 'items', itemIds: [draft.items[0].id, draft.items[1].id] });
  assert.equal(adjustment.amount, 300); assert.equal(adjustment.source, 'receipt'); assert.equal(adjustment.sourceLineIndex, 3);
  assert.deepEqual(draft.items.map(item => item.amount), [300, 300, 150], 'printed prices preserved');
  const scan = reconcileReceiptScan(draft)!;
  assert.equal(scan.calculatedTotal, 450);
  assert.equal(scan.sourceLines?.[0].mappedTo, 'adjustment');
  assert(!scan.warnings.some(warning => warning.code === 'unmapped-adjustment' || warning.code === 'total-mismatch'));
  // Assign and post as the editor would: Alice both Pringles, milk shared, Bob paid.
  const posted = { ...draft, items: draft.items.map((item, index) => ({ ...item, members: index < 2 ? ['alice'] : ['alice', 'bob'] })), status: undefined };
  delete (posted as Partial<Draft>).status;
  const saved = validateLedger({ trips: [{ ...trip, expenses: [{ ...posted, id: 'posted', sourceDraftId: draft.id, title: 'Tesco', date: '2026-11-06', time: '12:00', timezone: 'Europe/London', currency: 'GBP' } as never] }] }).trips[0];
  assert.equal(total(saved.expenses[0]), 450);
  assert.deepEqual(expenseShares(saved.expenses[0], trip.members, 'GBP'), [375, 75]);
});

test('F-10: unclear qualifying items, refunds and invalid proposals stay unmapped evidence for a person', () => {
  const unclear = applyReceiptTranscription(trip, waiting, r1([], 'unmapped'));
  assert.deepEqual(unclear.adjustments ?? [], []);
  assert(reconcileReceiptScan(unclear)!.warnings.some(warning => warning.code === 'unmapped-adjustment' && warning.lineIndex === 3));
  assert(reconcileReceiptScan(unclear)!.warnings.some(warning => warning.code === 'total-mismatch' && warning.difference === 300));
  // An item-scoped proposal naming no lines, or more than its lines, is never trusted.
  for (const invalid of [{ ...bogof, itemIndexes: [] }, { ...bogof, amount: 601 }, { ...bogof, itemIndexes: [0, 9] }, { ...bogof, amount: null }]) {
    const draft = applyReceiptTranscription(trip, waiting, r1([invalid]));
    assert.deepEqual(draft.adjustments ?? [], [], JSON.stringify(invalid));
    assert.equal(draft.receiptScan?.sourceLines?.[0].mappedTo, 'unmapped');
    assert(reconcileReceiptScan(draft)!.warnings.some(warning => warning.code === 'unmapped-adjustment'));
  }
  // The same printed line cannot be applied twice.
  const twice = applyReceiptTranscription(trip, waiting, r1([bogof, { ...bogof, label: 'again' }]));
  assert.equal(twice.adjustments?.length, 1);
});

test('F-10: a rescan keeps a person\'s own discount and does not duplicate it', () => {
  const first = applyReceiptTranscription(trip, waiting, r1([], 'unmapped'));
  const mine = { ...first, adjustments: [{ id: 'mine', kind: 'discount' as const, amount: 300, scope: { type: 'items' as const, itemIds: [first.items[0].id, first.items[1].id] }, sourceLineIndex: 3, source: 'user' as const }] };
  const rescanned = applyReceiptTranscription(trip, mine, { ...r1([bogof]), items: r1([bogof]).items.map((item, index) => ({ ...item, id: first.items[index].id })) });
  assert.deepEqual(rescanned.adjustments?.map(value => value.id), ['mine']);
});

test('F-10: older transcriptions without adjustments still parse', () => {
  const legacy = r1(undefined, 'unmapped'); delete legacy.adjustments;
  assert(receiptTranscriptionSchema.safeParse(legacy).success);
});

test('F-10: the prompt rule and the golden corpus agree on promotions, refunds and the discount field', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../lib/receipt-ai.ts', import.meta.url), 'utf8');
  assert.match(source, /never in the discount field \(leave discount 0\)/);
  assert.match(source, /Refunds, returns, deposits.*are never adjustments/);
  const corpus = JSON.parse(await readFile(new URL('./fixtures/receipts/v1/corpus.json', import.meta.url), 'utf8')) as { fixtures: { id: string; source: { lines: string[] }; expected: { adjustments: { discount: number }; scopedAdjustments?: unknown[]; warningCodes: string[] } }[] };
  for (const fixture of corpus.fixtures) {
    const negative = fixture.source.lines.some(text => /-\d+[.,]\d{2}\s*$/.test(text));
    if (!negative) continue;
    assert.equal(fixture.expected.adjustments.discount, 0, `${fixture.id}: promotions never use the legacy discount field`);
    const refund = fixture.source.lines.some(text => /RETURN|DEPOSIT|REFUND/i.test(text) && /-\d/.test(text));
    if (refund) assert(fixture.expected.warningCodes.includes('unmapped-adjustment') && !fixture.expected.scopedAdjustments?.length, `${fixture.id}: refunds stay evidence`);
    else assert(fixture.expected.scopedAdjustments?.length, `${fixture.id}: a promotion is a scoped record`);
  }
  for (const id of ['bogof', 'multibuy', 'percentage-discount', 'loyalty', 'item-discount', 'global-coupon']) assert(corpus.fixtures.some(fixture => fixture.id === id), id);
});
