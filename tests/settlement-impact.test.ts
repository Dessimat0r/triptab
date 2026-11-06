import assert from 'node:assert/strict';
import test from 'node:test';
import { describeSettlementImpact, settlementImpact } from '../lib/settlement-impact';
import { validateLedger, type Expense, type Trip } from '../lib/model';

const members = [{ id: 'gary', name: 'Gary' }, { id: 'sam', name: 'Sam' }];
const dinner: Expense = { id: 'dinner', title: 'Dinner', date: '2026-11-06', time: '20:00', timezone: 'Europe/London', currency: 'GBP', payer: 'gary',
  tax: 0, tip: 0, discount: 0, items: [{ id: 'meal', name: 'Dinner', amount: 2000, members: ['gary', 'sam'] }] };
// Settled: Sam paid Gary £10 for the £20 dinner.
const settled = (): Trip => validateLedger({ trips: [{ id: 'bill', kind: 'bill', name: 'Dinner', currency: 'GBP', members, expenses: [dinner], drafts: [],
  payments: [{ id: 'paid', from: 'sam', to: 'gary', amount: 1000, date: '2026-11-06' }] }] }).trips[0];
const name = (id: string) => members.find(member => member.id === id)!.name;
const money = (amount: number) => `£${(amount / 100).toFixed(2)}`;

test('F-13: deleting a settled expense leaves Gary owing Sam £10, and says so', () => {
  const trip = settled();
  const impact = settlementImpact(trip, { remove: 'dinner' });
  assert.equal(impact.wasSettled, true);
  assert.deepEqual(impact.after, [{ from: 'gary', to: 'sam', amount: 1000 }]);
  assert.equal(describeSettlementImpact(impact, { kind: 'bill', name, money, action: 'deletion' }),
    'This bill was settled. After this deletion, Gary pays Sam £10.00.');
  assert.deepEqual(trip.payments.map(payment => payment.amount), [1000], 'recorded payments are untouched');
});

test('F-13: changing a settled £20 dinner to £30 leaves Sam owing Gary £5', () => {
  const trip = settled();
  const impact = settlementImpact(trip, { replace: { ...trip.expenses[0], items: [{ ...trip.expenses[0].items[0], amount: 3000 }] } });
  assert.deepEqual(impact.after, [{ from: 'sam', to: 'gary', amount: 500 }]);
  assert.equal(describeSettlementImpact(impact, { kind: 'bill', name, money, action: 'change' }),
    'This bill was settled. After this change, Sam pays Gary £5.00.');
  assert.deepEqual(impact.changes, [{ memberId: 'gary', change: 500 }, { memberId: 'sam', change: -500 }]);
});

test('no recorded payments means no warning; an unchanged result says everyone is still settled', () => {
  const unpaid = { ...settled(), payments: [] };
  assert.equal(describeSettlementImpact(settlementImpact(unpaid, { remove: 'dinner' }), { kind: 'bill', name, money, action: 'deletion' }), null);
  const trip = settled();
  const renamed = settlementImpact(trip, { replace: { ...trip.expenses[0], title: 'Supper' } });
  assert.equal(describeSettlementImpact(renamed, { kind: 'holiday', name, money, action: 'change' }), 'This holiday was settled. After this change, everyone is still settled.');
});
