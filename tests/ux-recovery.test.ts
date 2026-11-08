import assert from 'node:assert/strict';
import test from 'node:test';
import { applyReceiptTranscription, receiptTranscriptionSchema, type ReceiptTranscription } from '../lib/receipt-ai';
import { billParticipantIds, defaultSplit, equalItem, updateDefaultParticipants } from '../lib/default-split';
import { shares, total, validateLedger, type Draft, type Trip } from '../lib/model';
import { acknowledgeReceiptReview, receiptScanSaveError } from '../lib/receipt-scan';

const trip: Trip = { id: 'checkout', kind: 'bill', ownerId: 'owner', name: 'Bill', currency: 'GBP',
  members: ['Alex', 'Sam', 'Jo'].map((name, index) => ({ id: `p${index}`, name })), expenses: [], payments: [], drafts: [] };
const draft: Draft = { id: 'draft', title: '', currency: 'GBP', payer: 'p0', items: [], tax: 0, tip: 0, discount: 0, status: 'waiting', receiptId: 'checkout-image',
  fieldSources: { title: 'default', currency: 'default' } };
const checkout: ReceiptTranscription = { title: null, date: null, time: null, currency: 'GBP', tax: 0, tip: 0, discount: 0,
  printedTotal: 2801, summary: 'Four checkout items.', items: [1200, 800, 500, 301].map((amount, index) => ({ id: null, name: `Item ${index + 1}`, amount })) };

test('missing or malformed optional merchant/date metadata never discards usable financial fields', () => {
  for (const metadata of [{ title: undefined, date: undefined, time: undefined }, { title: '', date: 'not shown', time: '' }]) {
    const parsed = receiptTranscriptionSchema.parse({ ...checkout, ...metadata });
    assert.equal(parsed.title, null); assert.equal(parsed.date, null); assert.equal(parsed.time, null);
    assert.deepEqual(parsed.items, checkout.items); assert.equal(parsed.printedTotal, 2801);
  }
});

test('checkout without merchant/date preserves every item and saves with automatic equal shares', () => {
  const result = applyReceiptTranscription(trip, draft, checkout);
  assert.equal(result.title, 'Bill', 'neutral label is not an invented merchant');
  assert.equal(result.fieldSources?.title, 'default');
  assert.equal(result.date, undefined);
  assert.equal(result.time, undefined);
  assert.deepEqual(result.items.map(item => item.amount), [1200, 800, 500, 301]);
  assert(result.items.every(item => item.splitMode === 'default' && item.members.join() === 'p0,p1,p2'));
  assert.equal(result.receiptScan?.status, 'matched');
  const expense = { ...result, id: 'posted', date: '2026-11-08', time: '12:00', timezone: 'Europe/London', sourceDraftId: result.id };
  const saved = validateLedger({ trips: [{ ...trip, expenses: [expense] }] }).trips[0].expenses[0];
  assert.deepEqual(shares(saved, trip.members), [934, 933, 934]);
  assert.equal(receiptScanSaveError(acknowledgeReceiptReview(saved), { allowAcknowledgement: true }), null);
});

test('ten new items need no per-item allocation; pennies sum exactly and remain deterministic', () => {
  const value = applyReceiptTranscription(trip, draft, { ...checkout, printedTotal: 10010,
    items: Array.from({ length: 10 }, (_, index) => ({ id: null, name: `Line ${index + 1}`, amount: 1001, quantity: { total: 0.000003, label: 'kg', sourceText: null } })) });
  assert(value.items.every(item => item.members.length === 3 && !item.units));
  const amounts = shares({ ...value, items: value.items.map(item => ({ ...item, amount: item.amount! })) }, trip.members);
  assert.equal(amounts.reduce((sum, amount) => sum + amount), 10010);
  assert(Math.max(...amounts) - Math.min(...amounts) <= 1);
  assert.deepEqual(amounts, shares({ ...value, items: value.items.map(item => ({ ...item, amount: item.amount! })) }, trip.members));
});

test('participant changes and reset preserve exceptions, purchase evidence and BOGOF allocation', () => {
  const result = applyReceiptTranscription(trip, draft, checkout);
  result.items[1] = { ...result.items[1], members: ['p1'], splitMode: 'custom' };
  result.items[2] = { ...result.items[2], members: ['p2'], splitMode: undefined }; // historical provenance is protected
  const updated = defaultSplit(result, ['p0', 'p1']);
  assert.deepEqual(updated.items.map(item => item.members), [['p0','p1'], ['p1'], ['p2'], ['p0','p1']]);
  const nextTrip = { ...trip, members: [...trip.members, { id: 'p3', name: 'Kim' }], drafts: [result] };
  const changed = updateDefaultParticipants({ ...trip, drafts: [result] }, nextTrip);
  assert.deepEqual(changed.drafts[0].items[0].members, ['p0','p1','p2','p3']);
  assert.deepEqual(changed.drafts[0].items[1].members, ['p1']);
  const bogof = { ...updated, items: updated.items.map(item => ({ ...item, amount: item.amount! })), adjustments: [{ id: 'offer', kind: 'discount' as const, amount: 800, scope: { type: 'items' as const, itemIds: [updated.items[1].id] }, source: 'user' as const }] };
  assert.equal(total(bogof), 2001);
  const reset = { ...bogof, items: bogof.items.map(item => equalItem(item, billParticipantIds(trip))) };
  assert.deepEqual(reset.adjustments, bogof.adjustments);
  assert.equal(shares(reset, trip.members).reduce((sum, amount) => sum + amount), 2001);
});

test('adding people never reallocates settled/payment-backed obligations or expense-update drafts', () => {
  const result = applyReceiptTranscription(trip, draft, checkout);
  const expense = { ...result, currency: 'GBP' as const, items: result.items.map(item => ({ ...item, amount: item.amount! })), date: '2026-11-08', time: '12:00', timezone: 'Europe/London' };
  const previous = { ...trip, expenses: [expense], payments: [{ id: 'paid', from: 'p1', to: 'p0', amount: 934, date: '2026-11-08' }], drafts: [{ ...result, expenseId: expense.id }] };
  const updated = updateDefaultParticipants(previous, { ...previous, members: [...trip.members, { id: 'p3', name: 'Kim' }] });
  assert.deepEqual(updated.expenses, previous.expenses);
  assert.deepEqual(updated.payments, previous.payments);
  assert.deepEqual(updated.drafts, previous.drafts);
});

test('adding people to an unpaid unsettled bill updates saved defaults, preserving custom shares', () => {
  const result = applyReceiptTranscription(trip, draft, checkout);
  result.items[1] = { ...result.items[1], members: ['p1'], splitMode: 'custom' };
  const expense = { ...result, currency: 'GBP' as const, items: result.items.map(item => ({ ...item, amount: item.amount! })), date: '2026-11-08', time: '12:00', timezone: 'Europe/London' };
  const previous: Trip = { ...trip, expenses: [expense] };
  const changed = updateDefaultParticipants(previous, { ...previous, members: [...trip.members, { id: 'p3', name: 'Kim' }] });
  assert.deepEqual(changed.expenses[0].items[0].members, ['p0','p1','p2','p3']);
  assert.deepEqual(changed.expenses[0].items[1].members, ['p1']);
  assert.equal(total(changed.expenses[0]), 2801);
  const holiday = { ...previous, kind: undefined };
  assert.deepEqual(updateDefaultParticipants(holiday, { ...holiday, members: changed.members }).expenses, previous.expenses);
  const single: Trip = { ...previous, members: [trip.members[0]], expenses: [{ ...expense, items: expense.items.map(item => equalItem(item, ['p0'])) }] };
  assert.deepEqual(updateDefaultParticipants(single, { ...single, members: trip.members }).expenses, single.expenses, 'already settled self-paid bill stays exact even without payment records');
});

test('partial checkout retains readable lines; unreadable amounts still block posting', () => {
  const value = applyReceiptTranscription(trip, draft, { ...checkout, items: [...checkout.items.slice(0, 3), { id: null, name: 'Unclear', amount: null }] });
  assert.equal(value.items.length, 4);
  assert.deepEqual(value.items.map(item => item.amount), [1200, 800, 500, null]);
  assert.equal(value.receiptScan?.status, 'incomplete');
  assert.match(receiptScanSaveError(value)!, /unreadable/);
});

// Holiday travellers have joining/leaving dates. A scanned line must default to the people present on the
// purchase date, as a manually added expense does, so saving without touching shares never charges someone who had left.
const holiday: Trip = { id: 'trip', ownerId: 'owner', name: 'Trip', currency: 'GBP', startDate: '2026-01-01', endDate: '2026-01-20',
  members: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', leftOn: '2026-01-05' }, { id: 'c', name: 'C', joinedOn: '2026-01-08' }], expenses: [], payments: [], drafts: [] };
const holidayDraft: Draft = { ...draft, id: 'h', payer: 'a', date: '2026-01-10' };
const twoItems = (date: string | null): ReceiptTranscription => ({ ...checkout, date, printedTotal: 2000, items: [1000, 1000].map((amount, index) => ({ id: null, name: `Item ${index + 1}`, amount })) });

test('a dated holiday scan excludes travellers who had left and includes those who had joined', () => {
  const result = applyReceiptTranscription(holiday, { ...holidayDraft, fieldSources: { date: 'user' } }, twoItems('2026-01-10'));
  assert(result.items.every(item => item.splitMode === 'default' && item.members.join() === 'a,c'));
  const expense = { ...result, items: result.items.map(item => ({ ...item, amount: item.amount! })), date: '2026-01-10', time: '12:00', timezone: 'Europe/London' };
  assert.deepEqual(shares(expense, holiday.members), [1000, 0, 1000]);
});

test('an undated scan, or a default recording date, keeps everyone who is not retired', () => {
  const result = applyReceiptTranscription(holiday, { ...holidayDraft, date: '2026-01-10', fieldSources: { date: 'default' } }, twoItems(null));
  assert(result.items.every(item => item.members.join() === 'a,b,c'));
});

test('bills have no join or leave dates, so their defaults are unchanged', () => {
  assert.deepEqual(applyReceiptTranscription(trip, { ...draft, date: '2026-01-10', fieldSources: { date: 'user' } }, twoItems('2026-01-10')).items.map(item => item.members.join()), ['p0,p1,p2', 'p0,p1,p2']);
});

test('a traveller added to a holiday draft joins only the lines dated after they joined', () => {
  const early = applyReceiptTranscription(holiday, { ...holidayDraft, date: '2026-01-03', fieldSources: { date: 'user' } }, twoItems('2026-01-03'));
  assert(early.items.every(item => item.members.join() === 'a,b'));
  const next = { ...holiday, members: [...holiday.members, { id: 'd', name: 'D', joinedOn: '2026-01-12' }], drafts: [early] };
  assert(updateDefaultParticipants({ ...holiday, drafts: [early] }, next).drafts[0].items.every(item => item.members.join() === 'a,b'), 'D had not joined on 3 January');
  const late = applyReceiptTranscription(holiday, { ...holidayDraft, date: '2026-01-15', fieldSources: { date: 'user' } }, twoItems('2026-01-15'));
  assert(updateDefaultParticipants({ ...holiday, drafts: [late] }, { ...next, drafts: [late] }).drafts[0].items.every(item => item.members.join() === 'a,c,d'));
});
