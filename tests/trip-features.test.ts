import assert from 'node:assert/strict';
import test from 'node:test';
import {
  balances, CURRENCIES, CURRENT_CALCULATION_RULE, defaultParticipants, expenseShares, expenseTotal, memberPresent,
  REFERENCE_RATE_CURRENCIES, remainderOffset, shares, stampCalculationRules, tripMemberWeights, validateLedger,
} from '../lib/model';
import type { Expense, Trip } from '../lib/model';

const members = [{ id: 'a', name: 'Alice' }, { id: 'b', name: 'Bob' }, { id: 'c', name: 'Chloe' }];
function expense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'dinner', title: 'Dinner', date: '2026-08-15', time: '20:30', timezone: 'Europe/Paris',
    currency: 'GBP', payer: 'a', items: [{ id: 'food', name: 'Food', amount: 1000, members: ['a', 'b', 'c'] }],
    tax: 0, tip: 0, discount: 0, ...overrides,
  };
}
function trip(overrides: Partial<Trip> = {}): Trip {
  return { id: 'holiday', name: 'Summer', currency: 'GBP', members, expenses: [expense()], drafts: [], payments: [], ...overrides };
}
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

test('new and changed entries adopt the rotating remainder rule; unchanged ones keep theirs', () => {
  const legacy = expense({ adjustmentAllocation: 'receipt-total' });
  const previous = validateLedger({ trips: [trip({ expenses: [legacy] })] }, {});
  assert.equal(previous.trips[0].expenses[0].adjustmentAllocation, CURRENT_CALCULATION_RULE);
  const stored = { trips: [trip({ expenses: [legacy] })] };
  const unchanged = validateLedger(structuredClone(stored), { previous: structuredClone(stored) });
  assert.equal(unchanged.trips[0].expenses[0].adjustmentAllocation, 'receipt-total');
});

test('rotating remainder spreads the leftover penny across travellers by entry', () => {
  const recipients = new Map<string, number>();
  for (let index = 0; index < 60; index++) {
    const entry = expense({ id: `entry-${index}`, adjustmentAllocation: 'rotating-remainder' });
    const split = shares(entry, members);
    assert.equal(sum(split), 1000);
    const extra = members[split.indexOf(334)].id;
    recipients.set(extra, (recipients.get(extra) || 0) + 1);
  }
  assert.equal(recipients.size, 3, 'every traveller absorbs some leftover pennies');
  // The historical rule always favours the first selected person.
  for (let index = 0; index < 5; index++) assert.deepEqual(shares(expense({ id: `entry-${index}`, adjustmentAllocation: 'receipt-total' }), members), [334, 333, 333]);
  assert.equal(remainderOffset('same', 3), remainderOffset('same', 3));
  assert.equal(remainderOffset(undefined, 3), 0);
});

test('rotation also applies to whole-receipt percentage splits and conserves pennies', () => {
  const entry = expense({ percentages: { a: 50, b: 50 }, items: [{ id: 'x', name: 'X', amount: 1001, members: [] }], adjustmentAllocation: 'rotating-remainder' });
  const split = shares(entry, members);
  assert.equal(sum(split), 1001);
  assert.deepEqual([...split].sort(), [0, 500, 501]);
});

test('traveller weights count a couple as two in equal splits and are stamped at save time', () => {
  const weighted = members.map(member => member.id === 'a' ? { ...member, weight: 2 } : member);
  assert.deepEqual(tripMemberWeights(weighted), { a: 2 });
  assert.equal(tripMemberWeights(members), undefined);
  const saved = validateLedger({ trips: [trip({ members: weighted })] });
  const entry = saved.trips[0].expenses[0];
  assert.deepEqual(entry.memberWeights, { a: 2 });
  assert.deepEqual(expenseShares(entry, weighted, 'GBP'), [500, 250, 250]);
  // Changing the weight later leaves the saved expense as it was.
  const later = structuredClone(saved);
  later.trips[0].members = members.map(member => member.id === 'a' ? { ...member, weight: 3 } : member);
  const resaved = validateLedger(structuredClone(later), { previous: saved });
  assert.deepEqual(resaved.trips[0].expenses[0].memberWeights, { a: 2 });
  assert.equal(sum(balances(resaved.trips[0])), 0);
  // Explicit unit or percentage splits ignore weights.
  const units = stampCalculationRules(expense({ items: [{ id: 'food', name: 'Food', amount: 900, members: ['a', 'b'], units: { total: 3, allocations: { a: 1, b: 2 } } }] }), weighted);
  assert.deepEqual(shares(units, weighted), [300, 600, 0]);
});

test('weights apply to tax and tip on zero-priced lines', () => {
  const weighted = members.map(member => member.id === 'b' ? { ...member, weight: 3 } : member);
  const entry = stampCalculationRules(expense({ items: [{ id: 'z', name: 'Cover', amount: 0, members: ['a', 'b'] }], tip: 400 }), weighted);
  assert.deepEqual(shares(entry, weighted), [100, 300, 0]);
});

test('joining and leaving dates guide default participants and are validated', () => {
  const travellers = [{ id: 'a', joinedOn: '2026-08-10' }, { id: 'b', leftOn: '2026-08-12' }, { id: 'c' }];
  assert.deepEqual(defaultParticipants(travellers, '2026-08-11'), ['a', 'b', 'c']);
  assert.deepEqual(defaultParticipants(travellers, '2026-08-09'), ['b', 'c']);
  assert.deepEqual(defaultParticipants(travellers, '2026-08-13'), ['a', 'c']);
  assert.deepEqual(defaultParticipants([{ id: 'a', leftOn: '2026-01-01' }], '2026-08-13'), ['a']);
  assert.equal(memberPresent({}, undefined), true);
  assert.throws(() => validateLedger({ trips: [trip({ members: [{ id: 'a', name: 'Alice', joinedOn: '2026-08-12', leftOn: '2026-08-10' }, members[1], members[2]] })] }), /leaving date/);
  const saved = validateLedger({ trips: [trip({ members: [{ id: 'a', name: 'Alice', joinedOn: '2026-08-12', leftOn: '2026-08-20' }, members[1], members[2]] })] });
  assert.equal(saved.trips[0].members[0].joinedOn, '2026-08-12');
});

test('a group budget is an optional positive settlement amount', () => {
  assert.equal(validateLedger({ trips: [trip({ budget: 150000 })] }).trips[0].budget, 150000);
  assert.throws(() => validateLedger({ trips: [trip({ budget: 0 })] }));
});

test('currencies cover major travel destinations, with reference rates only where the provider has them', () => {
  for (const code of ['JPY', 'THB', 'MXN', 'INR', 'NZD', 'ZAR', 'AED']) assert.ok(CURRENCIES.some(currency => currency.code === code), code);
  assert.ok(REFERENCE_RATE_CURRENCIES.has('JPY'));
  assert.ok(!REFERENCE_RATE_CURRENCIES.has('AED'));
  for (const code of REFERENCE_RATE_CURRENCIES) assert.ok(CURRENCIES.some(currency => currency.code === code), code);
  const aed = expense({ currency: 'AED', fx: { rate: 0.21, asOf: '2026-08-14', source: 'manual' } });
  assert.equal(sum(expenseShares(validateLedger({ trips: [trip({ expenses: [aed] })] }).trips[0].expenses[0], members, 'GBP')), 210);
});

import { expenseGroup, memberRemovalBlocker, removeMember, repeatExpense, spendingSummary, tripSummary } from '../lib/trip-insights';

test('spending summary totals by day and icon group, and tracks the budget', () => {
  const holiday = trip({
    startDate: '2026-08-14', endDate: '2026-08-17', budget: 10000,
    expenses: [
      expense({ id: 'one', date: '2026-08-14', icon: { symbol: 'Utensils', background: 'indigo' } }),
      expense({ id: 'two', date: '2026-08-15', items: [{ id: 'taxi', name: 'Taxi', amount: 2000, members: ['a', 'b'] }], suggestedIcon: { symbol: 'Wifi', background: 'slate' } }),
    ],
  });
  const summary = spendingSummary(holiday, '2026-08-15');
  assert.equal(summary.total, 3000);
  assert.equal(summary.days, 4);
  assert.equal(summary.dailyAverage, 750);
  assert.deepEqual(summary.byDay, [{ date: '2026-08-14', amount: 1000 }, { date: '2026-08-15', amount: 2000 }]);
  assert.deepEqual(summary.byGroup.map(group => group.group), ['Other', 'Food']);
  assert.deepEqual(summary.budget, { amount: 10000, remaining: 7000, usedPercent: 30, daysLeft: 3, perDayLeft: 2333, projected: 6000 });
  assert.equal(expenseGroup({}), 'Other');
});

test('trip summary reports each person and the final transfers', () => {
  const summary = tripSummary(trip());
  assert.ok(summary.ok);
  if (!summary.ok) return;
  assert.equal(sum(summary.travellers.map(person => person.net)), 0);
  assert.equal(sum(summary.travellers.map(person => person.share)), 1000);
  assert.equal(summary.travellers[0].paid, 1000);
  assert.equal(sum(summary.transfers.map(transfer => transfer.amount)), summary.travellers[0].net);
});

test('only unlinked travellers who are in no entries can be removed', () => {
  const holiday = trip({ members: [...members, { id: 'd', name: 'Dan' }, { id: 'e', name: 'Eve', userId: 'account-e' }] });
  assert.match(memberRemovalBlocker(holiday, 'a')!, /in 1 expense/);
  assert.match(memberRemovalBlocker(holiday, 'e')!, /joined with an account/);
  assert.equal(memberRemovalBlocker(holiday, 'd'), null);
  const weighted = { ...holiday, expenses: [{ ...holiday.expenses[0], memberWeights: { d: 2 } }] };
  const next = removeMember(weighted, 'd');
  assert.deepEqual(next.members.map(member => member.id), ['a', 'b', 'c', 'e']);
  assert.equal(next.expenses[0].memberWeights, undefined);
  assert.throws(() => removeMember(holiday, 'a'));
});

test('repeating an expense copies its split onto later days without receipt evidence', () => {
  let counter = 0;
  const source = expense({ receiptId: 'photo', conversation: [], fieldSources: { title: 'user' } });
  const copies = repeatExpense(source, 3, () => `id-${counter++}`, { everyDays: 2 });
  assert.deepEqual(copies.map(copy => copy.date), ['2026-08-17', '2026-08-19', '2026-08-21']);
  assert.ok(copies.every(copy => !copy.receiptId && !copy.conversation && copy.items[0].id !== 'food' && copy.items[0].members.length === 3));
  assert.equal(new Set(copies.map(copy => copy.id)).size, 3);
  assert.doesNotThrow(() => validateLedger({ trips: [trip({ expenses: [source, ...copies].map(entry => ({ ...entry, receiptId: undefined })) })] }));
  assert.throws(() => repeatExpense(source, 0, () => 'x'));
});

test('new yen and króna receipts allocate whole native units while old saved rules keep their balances',()=>{
  for(const currency of ['JPY','ISK','KRW','VND','CLP'] as const){
    const current=expense({currency,items:[{id:'x',name:'X',amount:100100,members:['a','b']}],adjustmentAllocation:'native-minor-units'});
    const split=expenseShares(current,members,currency);assert.equal(split.reduce((a,b)=>a+b,0),100100);assert.ok(split.every(value=>value%100===0));
    assert.deepEqual(expenseShares({...current,adjustmentAllocation:'receipt-total'},members,currency),[50050,50050,0]);
    assert.throws(()=>expenseTotal({...current,items:[{...current.items[0],amount:100101}]},currency),/whole currency/);
  }
});
