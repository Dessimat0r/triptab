import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allocate, balances, convertAmount, CURRENCIES, draftSchema, expenseSchema, expenseShares,
  expenseTotal, settlements, shares, total, validateLedger,
} from '../lib/model';
import type { Expense, Trip } from '../lib/model';

const members = [{ id: 'a', name: 'Alice' }, { id: 'b', name: 'Bob' }, { id: 'c', name: 'Chloe' }];
function expense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'dinner', title: 'Dinner', date: '2026-08-15', time: '20:30', timezone: 'Europe/Paris',
    currency: 'EUR', payer: 'a',
    items: [{ id: 'food', name: 'Food', amount: 10001, members: ['a', 'b', 'c'] }],
    tax: 0, tip: 0, discount: 0, fx: { rate: 0.85, asOf: '2026-08-14', source: 'reference' },
    ...overrides,
  };
}
function trip(expenses: Expense[] = [expense()]): Trip {
  return { id: 'holiday', name: 'Summer', currency: 'GBP', members, expenses, drafts: [], payments: [] };
}
function ledger(expenses: Expense[] = [expense()]) { return { trips: [trip(expenses)] }; }
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

test('preserves receipt currency and conserves pennies when converting item shares', () => {
  const dinner = expense({
    items: [
      { id: 'salad', name: 'Salad', amount: 1250, members: ['a'] },
      { id: 'wine', name: 'Wine', amount: 2101, members: ['b', 'c'] },
      { id: 'bread', name: 'Bread', amount: 503, members: ['a', 'b', 'c'] },
    ], tax: 385, tip: 401, discount: 99,
  });
  assert.equal(total(dinner), 4541);
  assert.equal(sum(shares(dinner, members)), 4541);
  assert.equal(expenseTotal(dinner, 'GBP'), 3860);
  assert.equal(sum(expenseShares(dinner, members, 'GBP')), 3860);
  assert.equal(dinner.items[0].amount, 1250);
});

test('actual bank charge overrides the reference rate and distributes fees proportionally', () => {
  const dinner = expense({ bankAmount: 8777 });
  assert.equal(expenseTotal(dinner, 'GBP'), 8777);
  assert.equal(sum(expenseShares(dinner, members, 'GBP')), 8777);
  assert.deepEqual(balances(trip([dinner])), [5851, -2926, -2925]);
});

test('same-currency receipts need no rate and ignore an irrelevant rate', () => {
  assert.equal(expenseTotal(expense({ currency: 'GBP', fx: undefined }), 'GBP'), 10001);
  assert.equal(expenseTotal(expense({ currency: 'GBP' }), 'GBP'), 10001);
  assert.deepEqual(expenseShares(expense({ currency: 'GBP' }), members, 'GBP'), [3334, 3334, 3333]);
});

test('a zero actual charge remains zero rather than falling back to an estimate', () => {
  const dinner = expense({ bankAmount: 0 });
  assert.equal(expenseTotal(dinner, 'GBP'), 0);
  assert.deepEqual(expenseShares(dinner, members, 'GBP'), [0, 0, 0]);
});

test('rounds decimal half cents up and supports scientific notation rates', () => {
  assert.equal(convertAmount(50, 0.29), 15);
  assert.equal(convertAmount(5000000, 1e-7), 1);
  assert.equal(convertAmount(1, 1.25e7), 12500000);
  assert.equal(convertAmount(0, 1e21), 0);
  assert.equal(convertAmount(1, Number.MIN_VALUE), 0);
  assert.equal(expenseTotal(expense({ items: [{ id: 'small', name: 'Small charge', amount: 50, members: ['a'] }], fx: { rate: 0.29, asOf: '2026-08-15', source: 'manual' } }), 'GBP'), 15);
  assert.throws(() => convertAmount(1, 1e21), /out of range/);
});

test('converted balances conserve money across mixed currencies and recorded settlement', () => {
  const expenses = [
    expense({ bankAmount: 8777 }),
    expense({ id: 'taxi', currency: 'GBP', payer: 'b', fx: undefined, items: [{ id: 'taxi-fare', name: 'Taxi', amount: 1201, members: ['a', 'b'] }] }),
    expense({ id: 'coffee', currency: 'PLN', payer: 'c', fx: { rate: 0.2, asOf: '2026-08-15', source: 'manual' }, items: [{ id: 'cups', name: 'Coffee', amount: 5501, members: ['a', 'b', 'c'] }] }),
  ];
  const holiday = trip(expenses);
  validateLedger({ trips: [holiday] });
  assert.equal(sum(balances(holiday)), 0);
  const transfers = settlements(holiday);
  holiday.payments = transfers.map((payment, index) => ({ ...payment, id: `payment-${index}`, date: '2026-08-16' }));
  assert.deepEqual(balances(holiday), [0, 0, 0]);
  assert.deepEqual(settlements(holiday), []);
});

test('largest remainders conserve amounts across varied splits and large integers', () => {
  for (let value = 1; value <= 1000; value++) {
    const weights = [value % 17, value % 23, value % 31 + 1, value % 7];
    const amount = value * 137;
    const allocated = allocate(amount, weights);
    assert.equal(sum(allocated), amount);
    assert.ok(allocated.every(value => Number.isInteger(value) && value >= 0));
    allocated.forEach((value, index) => assert.ok(Math.abs(value - amount * weights[index] / sum(weights)) < 1));
  }
  assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.equal(sum(allocate(Number.MAX_SAFE_INTEGER, [137, 19, 400])), Number.MAX_SAFE_INTEGER);
});

test('cross-currency expenses require a conversion basis but waiting drafts do not', () => {
  assert.throws(() => validateLedger(ledger([expense({ fx: undefined })])), /exchange rate/);
  assert.throws(() => expenseTotal(expense({ fx: undefined }), 'GBP'), /exchange rate/);
  validateLedger(ledger([expense({ fx: undefined, bankAmount: 8500 })]));
  const holiday = trip([]);
  holiday.drafts = [draftSchema.parse({
    id: 'receipt', title: '', payer: 'a', status: 'waiting', items: [], tax: 0, tip: 0, discount: 0,
  })];
  validateLedger({ trips: [holiday] });
  assert.equal(holiday.drafts[0].currency, 'EUR');
});

test('rejects invalid calendar dates, times, timezones, rates and assignments', () => {
  assert.equal(expenseSchema.safeParse(expense({ date: '2026-02-30' })).success, false);
  assert.equal(expenseSchema.safeParse(expense({ time: '24:00' })).success, false);
  assert.equal(expenseSchema.safeParse(expense({ timezone: 'Europe/Imaginary' })).success, false);
  assert.equal(expenseSchema.safeParse(expense({ timezone: '+01:00' })).success, false);
  assert.equal(expenseSchema.safeParse(expense({ fx: { rate: 0, asOf: '2026-08-15', source: 'manual' } })).success, false);
  assert.equal(expenseSchema.safeParse(expense({ fx: { rate: Infinity, asOf: '2026-08-15', source: 'manual' } })).success, false);
  assert.throws(() => validateLedger(ledger([expense({ items: [{ id: 'food', name: 'Food', amount: 10, members: ['unknown'] }] })])), /assignments/);
  assert.throws(() => validateLedger(ledger([expense({ items: [{ id: 'food', name: 'Food', amount: 10, members: ['a', 'a'] }] })])), /assignments/);
  assert.throws(() => validateLedger(ledger([expense({ payer: 'unknown' })])), /payer/);
  assert.throws(() => validateLedger(ledger([expense({ discount: 10002 })])), /Discount/);
  assert.throws(() => expenseTotal(expense({ fx: { rate: 1e20, asOf: '2026-08-15', source: 'manual' } }), 'GBP'), /out of range/);
});

test('supports Europe currencies and rejects duplicate item IDs', () => {
  assert.ok(['GBP', 'EUR', 'CHF', 'CZK', 'DKK', 'HUF', 'ISK', 'NOK', 'PLN', 'RON', 'SEK', 'TRY', 'ALL', 'BAM', 'MKD', 'MDL', 'RSD', 'UAH'].every(code => CURRENCIES.some(currency => currency.code === code)));
  const duplicate = { id: 'food', name: 'Food', amount: 10, members: ['a'] };
  assert.throws(() => validateLedger(ledger([expense({ items: [duplicate, duplicate] })])), /Duplicate item/);
});

test('preserves optional holiday dates and rejects invalid date ranges', () => {
  const holiday = { ...trip(), startDate: '2027-06-03', endDate: '2027-06-10' };
  const saved = validateLedger({ trips: [holiday] });
  assert.equal(saved.trips[0].startDate, '2027-06-03');
  assert.equal(saved.trips[0].endDate, '2027-06-10');
  assert.throws(() => validateLedger({ trips: [{ ...holiday, endDate: '2027-06-02' }] }), /end date/);
  assert.throws(() => validateLedger({ trips: [{ ...holiday, startDate: '2027-02-30' }] }));
  validateLedger({ trips: [{ ...trip(), startDate: '2027-06-03' }] });
});
