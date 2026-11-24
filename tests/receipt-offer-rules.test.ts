import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adjustmentSchema, applyAdjustments } from '../lib/adjustments';
import { builtInOffers, offerRuleSchema, type OfferRule } from '../lib/offer-rules';
import { draftSchema, expenseShares, shares, stampCalculationRules, total, type Trip } from '../lib/model';
import { applyReceiptQuestion } from '../lib/receipt-assistant';
import { applyReceiptTranscription } from '../lib/receipt-ai';
import { reconcileReceiptScan } from '../lib/receipt-scan';
import { createReceiptOperationWorker } from './helpers/receipt-operation-worker';

const members = [{ id: 'a', name: 'Alice' }, { id: 'b', name: 'Bob' }];
const items = [{ id: 'm1', amount: 1500, name: 'First main', members: ['a'] }, { id: 'm2', amount: 1000, name: 'Second main', members: ['b'] }];
const bogof = builtInOffers.bogof.rule;
const offer = (rule: OfferRule, changes: Record<string, unknown> = {}) => adjustmentSchema.parse({
  id: 'deal', group: 'A', kind: 'discount', scope: { type: 'items', itemIds: ['m1', 'm2'] }, rule, ...changes,
});
const draft = draftSchema.parse({ id: 'd', title: 'Meal', payer: 'a', currency: 'GBP', items, tax: 0, tip: 0, discount: 0, status: 'review',
  receiptScan: { version: 1, status: 'needs-review', warnings: [{ code: 'unmapped-adjustment', lineIndex: 3 }], printedSubtotal: 1500, printedTotal: 1500,
    sourceLines: [{ lineIndex: 3, kind: 'adjustment', amount: -1000, observedText: 'Main offer', mappedTo: 'unmapped' }] },
  conversation: [{ id: 'q', authorMemberId: 'a', role: 'user', text: 'The mains were BOGOF. Split the saving.', createdAt: '2026-11-24T12:00:00Z' }],
});
const trip: Trip = { id: 't', name: 'Trip', currency: 'GBP', members, drafts: [draft], expenses: [], payments: [] };
const proposal = { adjustmentId: null, label: null, group: null, items: items.map(item => ({ itemId: item.id, itemIndex: null, portions: null })),
  sourceLineIndex: 3, preset: 'bogof' as const, presetValue: null, savedRule: null, custom: null,
  split: { mode: 'equal' as const, people: members.map(member => ({ id: member.id, amount: null })) }, stacking: null };
const changes = { metadata: null, items: [], removeItemIds: [], clear: [], remember: null, aliases: [] };

test('BOGOF uses the cheaper portion, set-price variants use its price difference, and settlement can share either saving independently', () => {
  const free = offer(bogof, { rewardOnly: true });
  assert.deepEqual(applyAdjustments(items, [free]).applied[0].allocation, { m1: 0, m2: 1000 });
  const priced = offer(builtInOffers.secondPrice.rule);
  assert.equal(applyAdjustments(items, [priced]).applied[0].amount, 900);
  const entry = stampCalculationRules({ ...draft, adjustments: [offer(bogof, { memberSplit: { mode: 'equal', memberIds: ['a', 'b'] } })] }, members);
  assert.equal(total(entry), 1500);
  assert.deepEqual(shares(entry, members), [1000, 500]);
  assert.deepEqual(expenseShares({ ...entry, bankAmount: 1701 }, members, 'EUR'), [1134, 567]);
});

test('one grouped portion on a quantity line leaves other portions available and overlapping offers require confirmation', () => {
  const multibuy = { ...items[1], quantity: { total: 2 } };
  const line = { ...items[0], id: 'm3' };
  const group = (id: string, other: string) => offer(bogof, { id, group: id, scope: { type: 'items', itemIds: ['m2', other], portions: { m2: 1 } } });
  const result = applyAdjustments([items[0], multibuy, line], [group('A', 'm1'), group('B', 'm3')]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.applied.map(value => value.amount), [500, 500]);
  const second = offer(bogof, { id: 'B', group: 'B' });
  assert.match(applyAdjustments(items, [offer(bogof), second]).errors.join(), /overlap/i);
  assert.deepEqual(applyAdjustments(items, [offer(bogof), { ...second, stacking: true }]).errors, []);
});

test('a capped custom rule is copied from the saved library and the observed amount takes precedence', () => {
  const rule = offerRuleSchema.parse({ version: 1, buy: 2, cheapest: 1, benefit: 'percent', value: 50, cap: 400, limit: 1 });
  const updated = applyReceiptQuestion(trip, draft, { summary: 'Offer applied.', changes: { ...changes,
    offers: [{ ...proposal, preset: null, savedRule: 'Two mains' }] } }, 'q', [{ name: 'Two mains', rule }]);
  assert.equal(updated.adjustments?.[0].group, 'A');
  assert.equal(updated.adjustments?.[0].rule?.cap, 400);
  assert.equal(updated.adjustments?.[0].printedAmount, 1000);
  assert.equal(applyAdjustments(items, updated.adjustments).applied[0].expected, 400);
  assert.equal(reconcileReceiptScan(updated)?.status, 'matched');
});

test('upload applies the printed saving using scanned line references and leaves ordinary receipts without groups', () => {
  const blank = draftSchema.parse({ ...draft, items: [], status: 'waiting', conversation: [], receiptScan: undefined });
  const source = { ...draft.receiptScan!.sourceLines![0], confidence: 'high' as const };
  const read = applyReceiptTranscription(trip, blank, { title: 'Meal', currency: 'GBP', date: null, time: null,
    tax: 0, tip: 0, discount: 0, printedSubtotal: 1500, printedTotal: 1500, warnings: [], summary: 'Matched',
    sourceLines: [{ ...source, kind: 'adjustment', amount: -1000, mappedTo: 'unmapped', observedText: 'Main offer', lineIndex: 3 }],
    items: items.map(item => ({ id: null, name: item.name, amount: item.amount })),
    changes: { ...changes, offers: [{ ...proposal, items: items.map((_, itemIndex) => ({ itemId: null, itemIndex, portions: null })), split: null }] },
  });
  assert.equal(read.adjustments?.[0].group, 'A');
  assert.equal(read.receiptScan?.status, 'matched');
  assert.equal(draftSchema.parse({ ...blank, adjustments: undefined }).adjustments, undefined);
});

test('reusable rules are account-scoped and can be changed without rewriting a receipt snapshot', async () => {
  const fixture = await createReceiptOperationWorker();
  try {
    const other = await fixture.createAccount({ id: 'other', name: 'Other', email: 'other@example.test', session: true });
    const send = async (method: string, token: string, body?: unknown, query = '') => fixture.worker.dispatchFetch(`${fixture.origin}/api/receipt/offer-rules${query}`, {
      method, headers: { cookie: `tt_session=${token}`, origin: fixture.origin, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const saved = { name: 'Mains', rule: bogof };
    const created = await send('PUT', fixture.sessionToken, saved);
    assert.equal(created.status, 200, await created.clone().text());
    assert.deepEqual(await (await send('GET', fixture.sessionToken)).json(), [saved]);
    assert.deepEqual(await (await send('GET', other.sessionToken!)).json(), []);
    assert.equal((await send('PUT', fixture.sessionToken, saved)).status, 409);
    const changed = { ...saved, rule: { ...bogof, value: 100 } };
    assert.equal((await send('PUT', fixture.sessionToken, changed, '?replace=true')).status, 200);
    assert.deepEqual(await (await send('GET', fixture.sessionToken)).json(), [changed]);
    assert.equal(applyAdjustments(items, [offer(saved.rule)]).applied[0].amount, 1000);
  } finally { await fixture.dispose(); }
});
