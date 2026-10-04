import assert from 'node:assert/strict';
import test from 'node:test';
import { rebaseLedger, equalFinancialValue, hasNewMatchingPayment } from '../lib/client-ledger';
import type { Ledger } from '../lib/model';
const base: Ledger = { trips: [{ id: 't', name: 'Trip', currency: 'GBP', members: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], expenses: [{ id: 'e', title: 'Dinner', date: '2026-10-04', time: '19:00', timezone: 'Europe/London', currency: 'GBP', payer: 'a', items: [{ id: 'i', name: 'Dinner', amount: 1000, members: ['a','b'] }], tax: 0, tip: 0, discount: 0 }], payments: [], drafts: [] }] };
test('unrelated changes rebase without losing the open expense entry', () => {
  const local = structuredClone(base), remote = structuredClone(base);
  local.trips[0].expenses[0].title = 'My dinner';
  remote.trips.push({ ...structuredClone(base.trips[0]), id: 'other', name: 'Other trip' });
  remote.trips[0].payments.push({ id: 'p', from: 'b', to: 'a', amount: 200, date: '2026-10-04' });
  const result = rebaseLedger(base, local, remote);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.data.trips[0].expenses[0].title, 'My dinner');
  assert.equal(result.data.trips[0].payments.length, 1);
  assert.equal(result.data.trips[1].id, 'other');
});
test('a concurrently edited or deleted expense needs explicit resolution', () => {
  const local = structuredClone(base), remote = structuredClone(base);
  local.trips[0].expenses[0].title = 'My dinner';
  remote.trips[0].expenses[0].payer = 'b';
  assert.equal(rebaseLedger(base, local, remote).conflicts[0].entityId, 'e');
  remote.trips[0].expenses = [];
  assert.equal(rebaseLedger(base, local, remote).conflicts[0].entityId, 'e');
});
test('receipt conversation appends merge without overriding a financial correction', () => {
  const local = structuredClone(base), remote = structuredClone(base);
  local.trips[0].expenses[0].conversation = [{ id: 'question', role: 'user', text: 'Which payer?', createdAt: '2026-10-04T10:00:00Z' }];
  remote.trips[0].expenses[0].payer = 'b';
  const result = rebaseLedger(base, local, remote);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.data.trips[0].expenses[0].payer, 'b');
  assert.equal(result.data.trips[0].expenses[0].conversation?.[0].id, 'question');
  assert.ok(equalFinancialValue(base.trips[0].expenses[0], local.trips[0].expenses[0]));
});
test('retrying the same stable payment ID cannot duplicate the payment', () => {
  const local = structuredClone(base);
  local.trips[0].payments.push({ id: 'submission-id', from: 'b', to: 'a', amount: 250, date: '2026-10-04' });
  const result = rebaseLedger(base, local, local);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.data.trips[0].payments.length, 1);
});

test('a newly recorded matching transfer blocks automatic rebasing until duplicate review', () => {
  const local = structuredClone(base), remote = structuredClone(base);
  const payment = { id: 'local-transfer', from: 'b', to: 'a', amount: 250, date: '2026-10-04', time: '12:00', note: 'My transfer' };
  local.trips[0].payments.push(payment);
  remote.trips[0].payments.push({ ...payment, id: 'competing-transfer', time: '12:01', note: 'Other traveller recorded it' });
  assert.equal(hasNewMatchingPayment(base, local, remote), true);
  assert.equal(hasNewMatchingPayment(remote, { ...remote, trips: [{ ...remote.trips[0], payments: [...remote.trips[0].payments, payment] }] }, remote), false,
    'the refreshed matching transfer is now visible for explicit review');
});

test('matching-payment checks preserve stable-ID retries and already-reviewed baseline duplicates', () => {
  const local = structuredClone(base), remote = structuredClone(base);
  const payment = { id: 'local-transfer', from: 'b', to: 'a', amount: 250, date: '2026-10-04' };
  local.trips[0].payments.push(payment);
  remote.trips[0].payments.push(payment, { ...payment, id: 'separate-transfer' });
  assert.equal(hasNewMatchingPayment(base, local, remote), false, 'own stable-ID retry does not add another record');
  const reviewedBase = structuredClone(base);
  reviewedBase.trips[0].payments.push({ ...payment, id: 'earlier-transfer' });
  const proposed = structuredClone(reviewedBase);
  proposed.trips[0].payments.push(payment);
  assert.equal(hasNewMatchingPayment(reviewedBase, proposed, reviewedBase), false, 'a previously visible duplicate was already reviewed');
  const edited = structuredClone(reviewedBase);
  edited.trips[0].payments[0].amount = 300;
  const competing = structuredClone(reviewedBase);
  competing.trips[0].payments.push({ ...payment, id: 'competing-transfer', amount: 300 });
  assert.equal(hasNewMatchingPayment(reviewedBase, edited, competing), false, 'editing an existing transfer is not adding a duplicate');
});

test('matching-payment checks stay within the same trip, sender, recipient, amount and calendar date', () => {
  const local = structuredClone(base);
  const payment = { id: 'local-transfer', from: 'b', to: 'a', amount: 250, date: '2026-10-04' };
  local.trips[0].payments.push(payment);
  for (const changed of [{ from: 'a' }, { to: 'b' }, { amount: 251 }, { date: '2026-10-03' }]) {
    const remote = structuredClone(base);
    remote.trips[0].payments.push({ ...payment, ...changed, id: 'different-transfer' });
    assert.equal(hasNewMatchingPayment(base, local, remote), false);
  }
  const remote = structuredClone(base);
  remote.trips.push({ ...structuredClone(base.trips[0]), id: 'other-trip', payments: [{ ...payment, id: 'other-transfer' }] });
  assert.equal(hasNewMatchingPayment(base, local, remote), false);
});
