import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allocate, balances, convertAmount, CURRENCIES, draftSchema, expenseSchema, expenseShares,
  expenseTotal, itemSchema, itemShares, itemSplitError, receiptSplitError, settlements, shares, total, validateLedger,
  MAX_AMOUNT, paymentSchema, validExchangeRate,
  parseLedgerStructure, parseStoredTrip,
  travellerFinancialPreview,
  unitsScale, UNIT_SCALE, MAX_UNITS, unitsSchema, itemUnitsError, receiptQuantitySchema,
} from '../lib/model';
import type { Expense, Item, ReceiptMessage, Trip } from '../lib/model';

const members = [{ id: 'a', name: 'Alice' }, { id: 'b', name: 'Bob' }, { id: 'c', name: 'Chloe' }];
function expense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'dinner', title: 'Dinner', date: '2026-08-15', time: '20:30', timezone: 'Europe/Paris',
    currency: 'EUR', payer: 'a',
    items: [{ id: 'food', name: 'Food', amount: 10001, members: ['a', 'b', 'c'] }],
    tax: 0, tip: 0, discount: 0, fx: { rate: 0.85, asOf: '2026-08-14', source: 'reference' }, adjustmentAllocation: 'selected-participants',
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

test('rejects a zero actual charge instead of zeroing a posted expense', () => {
  const dinner = expense({ bankAmount: 0 });
  assert.throws(() => expenseTotal(dinner, 'GBP'), /greater than zero/);
  assert.throws(() => expenseShares(dinner, members, 'GBP'), /greater than zero/);
  assert.equal(expenseSchema.safeParse(dinner).success, false);
  assert.equal(draftSchema.safeParse({ ...dinner, status: 'review' }).success, false);
  assert.throws(() => validateLedger(ledger([dinner])));
});

test('a bank charge cannot override a receipt in its settlement currency, including review drafts', () => {
  const dinner = expense({ currency: 'GBP', bankAmount: 8700 });
  assert.throws(() => expenseTotal(dinner, 'GBP'), /currencies are the same/);
  assert.throws(() => validateLedger(ledger([dinner])), /currencies are the same/);
  const holiday = trip([]);
  holiday.drafts = [{ ...dinner, items: [], status: 'waiting' }];
  assert.throws(() => validateLedger({ trips: [holiday] }), /currencies are the same/);
});

test('posted original and converted receipt totals must be positive while incomplete drafts remain valid', () => {
  const zero = expense({ items: [{ id: 'zero', name: 'Free', amount: 0, members: ['a'] }] });
  assert.throws(() => validateLedger(ledger([zero])), /Receipt total must be greater than zero/);
  assert.throws(() => validateLedger(ledger([expense({ discount: 10001 })])), /Receipt total must be greater than zero/);
  const roundedToZero = expense({ items: [{ id: 'small', name: 'Small', amount: 1, members: ['a'] }], fx: { rate: 0.001, asOf: '2026-08-15', source: 'manual' } });
  assert.throws(() => validateLedger(ledger([roundedToZero])), /Converted receipt total must be greater than zero/);
  const holiday = trip([]);
  holiday.drafts = [{ ...zero, id: 'waiting', status: 'waiting', items: [], fx: undefined }];
  assert.equal(validateLedger({ trips: [holiday] }).trips[0].drafts.length, 1);
});

test('caps converted totals at the money-field limit and refuses unsafe intermediate sums', () => {
  const boundary = expense({ currency: 'GBP', fx: undefined, items: [{ id: 'large', name: 'Large', amount: MAX_AMOUNT, members: ['a'] }] });
  assert.equal(expenseTotal(boundary, 'GBP'), MAX_AMOUNT);
  validateLedger(ledger([boundary]));
  assert.throws(() => expenseTotal({ ...boundary, tax: 1 }, 'GBP'), /out of range/);
  assert.throws(() => validateLedger(ledger([expense({ fx: { rate: 1e11, asOf: '2026-08-15', source: 'manual' } })])), /out of range/);
  assert.throws(() => expenseTotal(expense({ bankAmount: MAX_AMOUNT + 1 }), 'GBP'), /out of range/);
  assert.throws(() => total(expense({ items: [{ id: 'unsafe', name: 'Unsafe', amount: Number.MAX_SAFE_INTEGER, members: ['a'] }], tax: 1 })), /out of range/);
  assert.throws(() => total(expense({ tax: 0.5 })), /out of range/);
  for (const rate of [0, -1, NaN, Infinity, '0.85', null]) assert.equal(validExchangeRate(rate), false);
  for (const rate of [0.00214, 0.85, 450, Number.MIN_VALUE]) assert.equal(validExchangeRate(rate), true);
});

test('structural stored-data parsing preserves historical bank charges and raw traveller names', () => {
  const legacy = trip([expense({ currency: 'GBP', bankAmount: 8700 })]);
  legacy.members = [{ id: 'a', name: ' Alice ' }, { id: 'b', name: 'alice' }, { id: 'c', name: '   ' }];
  legacy.drafts = [{ ...expense({ id: 'old-draft', bankAmount: 0 }), items: [], status: 'waiting' }];
  const stored = parseStoredTrip(JSON.parse(JSON.stringify(legacy)));
  assert.equal(stored.expenses[0].bankAmount, 8700);
  assert.equal(stored.drafts[0].bankAmount, 0);
  assert.deepEqual(stored.members.map(member => member.name), [' Alice ', 'alice', '   ']);
  assert.deepEqual(parseLedgerStructure({ trips: [legacy] }).trips[0], stored);
  assert.throws(() => validateLedger({ trips: [legacy] }));
});

test('only unchanged records from a trusted prior snapshot retain legacy financial values', () => {
  const legacy = trip([expense({ currency: 'GBP', bankAmount: 8700 })]);
  legacy.members = [{ id: 'a', name: ' Alice ' }, { id: 'b', name: 'alice' }, { id: 'c', name: 'Chloe' }];
  legacy.drafts = [{ ...expense({ id: 'old-draft', bankAmount: 0 }), items: [], status: 'waiting' }];
  const clean = { ...trip(), id: 'other-trip' };
  const previous = { trips: [legacy, clean] };
  const incoming = structuredClone(previous);
  incoming.trips[1].expenses[0].title = 'Updated dinner';
  const saved = validateLedger(incoming, { previous });
  assert.deepEqual(saved.trips[0], parseStoredTrip(legacy));
  assert.equal(saved.trips[1].expenses[0].title, 'Updated dinner');
  const modifiedExpense = structuredClone(incoming);
  modifiedExpense.trips[0].expenses[0].title = 'Changed old dinner';
  assert.throws(() => validateLedger(modifiedExpense, { previous }), /currencies are the same/);
  const modifiedDraft = structuredClone(incoming);
  modifiedDraft.trips[0].drafts[0].title = 'Changed old draft';
  assert.throws(() => validateLedger(modifiedDraft, { previous }), /greater than zero/);
  const addedDraft = structuredClone(incoming);
  addedDraft.trips[0].drafts.push({ ...addedDraft.trips[0].drafts[0], id: 'new-invalid-draft' });
  assert.throws(() => validateLedger(addedDraft, { previous }), /greater than zero/);
  assert.throws(() => validateLedger(incoming, { previous: { trips: [clean] } }), /Traveller names must be unique/);
  const changedCurrency = structuredClone(incoming);
  changedCurrency.trips[0].currency = 'EUR';
  assert.throws(() => validateLedger(changedCurrency, { previous }), /greater than zero/);
});

test('legacy zero bank charges and duplicate names can be repaired without changing other financial values', () => {
  const legacy = trip([expense({ bankAmount: 0 })]);
  legacy.members = [{ id: 'a', name: ' Alice ' }, { id: 'b', name: 'alice' }, { id: 'c', name: 'Chloe' }];
  legacy.drafts = [{ ...expense({ id: 'old-draft', bankAmount: 0 }), items: [], status: 'waiting' }];
  const repaired = structuredClone(legacy);
  repaired.expenses[0].bankAmount = 8501;
  repaired.drafts = [];
  repaired.members[1].name = 'Alice Smith';
  const saved = validateLedger({ trips: [repaired] }, { previous: { trips: [legacy] } }).trips[0];
  assert.equal(saved.members[0].name, ' Alice ', 'unchanged historical name must not be silently trimmed');
  assert.equal(saved.members[1].name, 'Alice Smith');
  assert.equal(saved.expenses[0].bankAmount, 8501);
  assert.deepEqual(saved.expenses[0].items, legacy.expenses[0].items);
  assert.equal(saved.drafts.length, 0);
  assert.equal(expenseTotal(saved.expenses[0], 'GBP'), 8501);
});

test('unchanged historical zero or oversized totals do not block repairs elsewhere, but modified amounts remain strict', () => {
  const zero = expense({ id: 'old-zero', items: [{ id: 'zero-item', name: 'Free', amount: 0, members: ['a'] }] });
  const oversized = expense({ id: 'old-large', fx: { rate: 1e11, asOf: '2026-08-15', source: 'manual' } });
  const legacy = trip([zero, oversized]);
  const saved = validateLedger({ trips: [legacy] }, { previous: { trips: [legacy] } });
  assert.deepEqual(saved.trips[0].expenses, legacy.expenses);
  const changedZero = structuredClone(legacy);
  changedZero.expenses[0].title = 'Updated zero';
  assert.throws(() => validateLedger({ trips: [changedZero] }, { previous: { trips: [legacy] } }), /Receipt total must be greater than zero/);
  const changedLarge = structuredClone(legacy);
  changedLarge.expenses[1].title = 'Updated large';
  assert.throws(() => validateLedger({ trips: [changedLarge] }, { previous: { trips: [legacy] } }), /out of range/);
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

test('trims traveller names and requires distinct names independent of case and edge spaces', () => {
  const holiday = trip([]);
  holiday.members = [{ id: 'a', name: ' Alice ' }, { id: 'b', name: 'alice' }];
  assert.throws(() => validateLedger({ trips: [holiday] }), /Traveller names must be unique.*surname or nickname/);
  holiday.members[1].name = 'Alice Smith';
  assert.deepEqual(validateLedger({ trips: [holiday] }).trips[0].members.map(member => member.name), ['Alice', 'Alice Smith']);
  holiday.members[0].name = '   ';
  assert.throws(() => validateLedger({ trips: [holiday] }));
});

test('preserves manual payment details and AI provenance without changing legacy records', () => {
  const holiday = trip();
  holiday.payments = [{ id: 'partial', from: 'b', to: 'a', amount: 200, date: '2026-08-16', time: '09:35', timezone: 'Europe/Paris', method: ' Bank transfer ', note: ' First part ' }];
  holiday.expenses[0].source = 'ai';
  holiday.drafts = [{ ...expense({ id: 'draft' }), source: 'ai', status: 'review' }];
  const parsed = validateLedger(JSON.parse(JSON.stringify({ trips: [holiday] }))).trips[0];
  assert.deepEqual(parsed.payments[0], { ...holiday.payments[0], method: 'Bank transfer', note: 'First part' });
  assert.equal(parsed.expenses[0].source, 'ai');
  assert.equal(parsed.drafts[0].source, 'ai');
  assert.equal(expenseSchema.parse(expense()).source, undefined);
  assert.equal(paymentSchema.safeParse({ ...holiday.payments[0], time: '24:00' }).success, false);
  assert.equal(paymentSchema.safeParse({ ...holiday.payments[0], timezone: 'Imaginary/Zone' }).success, false);
  assert.equal(paymentSchema.safeParse({ ...holiday.payments[0], method: 'x'.repeat(81) }).success, false);
  assert.equal(paymentSchema.safeParse({ ...holiday.payments[0], note: 'x'.repeat(501) }).success, false);
  assert.equal(paymentSchema.safeParse({ id: 'legacy', from: 'b', to: 'a', amount: 200, date: '2026-08-16' }).success, true);
});

test('settles equal opposite balances first and makes remaining greedy transfers deterministic by member id', () => {
  const holiday: Trip = { ...trip([]), members: [...members, { id: 'd', name: 'Daniel' }] };
  holiday.expenses = [
    expense({ id: 'couple-one', currency: 'GBP', fx: undefined, payer: 'd', items: [{ id: 'one', name: 'One', amount: 300, members: ['a'] }] }),
    expense({ id: 'couple-two', currency: 'GBP', fx: undefined, payer: 'c', items: [{ id: 'two', name: 'Two', amount: 700, members: ['b'] }] }),
  ];
  assert.deepEqual(balances(holiday), [-300, -700, 700, 300]);
  const paired = [{ from: 'a', to: 'd', amount: 300 }, { from: 'b', to: 'c', amount: 700 }];
  assert.deepEqual(settlements(holiday), paired);
  assert.deepEqual(settlements({ ...holiday, members: [...holiday.members].reverse() }), paired);
  holiday.expenses[0].items[0].amount = 500;
  holiday.expenses[1].items[0].amount = 500;
  assert.deepEqual(settlements(holiday), [{ from: 'a', to: 'c', amount: 500 }, { from: 'b', to: 'd', amount: 500 }]);
  holiday.expenses.push(expense({ id: 'extra', currency: 'GBP', fx: undefined, payer: 'c', items: [{ id: 'extra', name: 'Extra', amount: 101, members: ['a'] }] }));
  const transfers = settlements(holiday);
  assert.deepEqual(settlements({ ...holiday, members: [...holiday.members].reverse() }), transfers);
  holiday.payments = transfers.map((payment, index) => ({ ...payment, id: `settled-${index}`, date: '2026-08-16' }));
  assert.deepEqual(balances(holiday), [0, 0, 0, 0]);
});

test('seeded mixed-currency trips conserve every penny through allocation, JSON persistence and settlement', () => {
  let seed = 0x515babe;
  const random = (limit: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % limit;
  };
  const currencies = ['GBP', 'EUR', 'PLN', 'HUF', 'ISK'] as const;
  for (let iteration = 0; iteration < 800; iteration++) {
    const travellers = Array.from({ length: 2 + random(7) }, (_, index) => ({ id: `person-${index}`, name: `Person ${index}` }));
    const expenses = Array.from({ length: 1 + random(8) }, (_, index) => {
      const currency = currencies[random(currencies.length)];
      const ids = travellers.map(member => member.id);
      const items: Item[] = Array.from({ length: 1 + random(5) }, (_, itemIndex) => ({
        id: `item-${itemIndex}`, name: 'Item', amount: 500 + random(50000),
        members: random(2) ? ids : [ids[random(ids.length)]],
      }));
      const percentages = random(3) === 0 ? { [ids[0]]: 60, [ids[1]]: 40 } : undefined;
      if (random(2)) items[0] = { ...items[0], members: [ids[0], ids[1]], percentages: { [ids[0]]: 33.33, [ids[1]]: 66.67 } };
      return expense({ id: `expense-${index}`, adjustmentAllocation: 'rotating-remainder', currency, payer: ids[random(ids.length)], items, tax: random(200), tip: random(200), discount: random(400), percentages,
        fx: currency === 'GBP' ? undefined : { rate: currency === 'HUF' || currency === 'ISK' ? 0.00214 : 0.85327, asOf: '2026-08-15', source: 'manual' },
        bankAmount: currency !== 'GBP' && random(3) === 0 ? 1 + random(80000) : undefined,
      });
    });
    const holiday: Trip = { ...trip(expenses), members: travellers };
    for (const receipt of expenses) {
      assert.equal(sum(shares(receipt, travellers)), total(receipt));
      assert.equal(sum(expenseShares(receipt, travellers, 'GBP')), expenseTotal(receipt, 'GBP'));
    }
    const persisted = validateLedger(JSON.parse(JSON.stringify({ trips: [holiday] }))).trips[0];
    assert.deepEqual(balances(persisted), balances(holiday));
    assert.equal(sum(balances(persisted)), 0);
    persisted.payments = settlements(persisted).map((payment, index) => ({ ...payment, id: `payment-${index}`, date: '2026-08-16' }));
    assert.ok(balances(persisted).every(value => value === 0));
    assert.deepEqual(settlements(persisted), []);
  }
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

test('splits individual item costs 70/30 while crediting the sole receipt payer', () => {
  const dinner = expense({
    currency: 'GBP', fx: undefined, payer: 'c',
    items: [{ id: 'food', name: 'Food', amount: 10000, members: ['a', 'b'], percentages: { a: 70, b: 30 } }],
  });
  assert.deepEqual(itemShares(dinner.items[0], members), [7000, 3000, 0]);
  assert.deepEqual(shares(dinner, members), [7000, 3000, 0]);
  assert.deepEqual(balances(trip([dinner])), [-7000, -3000, 10000]);
});

test('supports one person owing 100%, including an explicitly selected zero share', () => {
  const single: Item = { id: 'coffee', name: 'Coffee', amount: 499, members: ['c'], percentages: { c: 100 } };
  assert.deepEqual(itemShares(single, members), [0, 0, 499]);
  const withZero: Item = { ...single, members: ['a', 'b'], percentages: { a: 0, b: 100 } };
  assert.deepEqual(itemShares(withZero, members), [0, 499, 0]);
  assert.equal(itemSchema.safeParse(withZero).success, true);
  assert.deepEqual(itemShares({ ...withZero, amount: 0 }, members), [0, 0, 0]);
});

test('scales fractional unit quantities exactly without accepting hidden floating-point precision', () => {
  const valid: [unknown, number][] = [
    [2.5, 2500000], ['2.5', 2500000], [0.1, 100000], [0.2, 200000],
    [1.000001, 1000001], ['0.000001', 1], ['.5', 500000], ['1.', UNIT_SCALE],
    [' 0.25 ', 250000], [MAX_UNITS, MAX_UNITS * UNIT_SCALE], [999999.999999, 999999999999], [0, 0],
  ];
  for (const [value, scaled] of valid) assert.equal(unitsScale(value), scaled);
  for (const value of [-1, -0.001, NaN, Infinity, -Infinity, Number.MIN_VALUE, 1e-7, 0.1234567,
    MAX_UNITS + 0.000001, 0.1 + 0.2, '', '.', '1e3', '1,5', '0.1234567', '1000000.0000001', null, {}, []]) {
    assert.equal(unitsScale(value), null);
  }
  assert.equal(unitsSchema.safeParse({ total: 0.3, allocations: { a: 0.1, b: 0.2 } }).success, true);
  assert.equal(unitsSchema.safeParse({ total: 0.1 + 0.2, allocations: { a: 0.1, b: 0.2 } }).success, false);
  assert.equal(unitsSchema.safeParse({ total: '3', allocations: { a: 2.5, b: 0.5 } }).success, false);
});

test('purchased receipt quantity validates bounded decimal evidence independently of financial allocations', () => {
  const quantity = receiptQuantitySchema.parse({ total: 2, label: ' slices ', sourceText: ' 2 x Stck ' });
  assert.deepEqual(quantity, { total: 2, label: 'slices', sourceText: '2 x Stck' });
  for (const value of [0.000001, 0.25, 2, 7.5, MAX_UNITS]) {
    assert.equal(receiptQuantitySchema.safeParse({ total: value }).success, true);
  }
  for (const value of [0, -1, NaN, Infinity, 1e-7, 0.1234567, MAX_UNITS + 1, '2']) {
    assert.equal(receiptQuantitySchema.safeParse({ total: value }).success, false);
  }
  for (const extra of [
    { label: '' }, { label: ' ' }, { label: 'x'.repeat(41) },
    { sourceText: '' }, { sourceText: 'x'.repeat(201) }, { allocations: { a: 2 } },
  ]) assert.equal(receiptQuantitySchema.safeParse({ total: 2, ...extra }).success, false);
  const item: Item = { id: 'pizza', name: 'Pizza', amount: 1001, members: ['b', 'a'], percentages: { b: 70, a: 30 }, quantity };
  assert.deepEqual(itemSchema.parse(item).quantity, quantity);
  assert.deepEqual(itemShares(item, members), [300, 701, 0]);
  const saved = parseStoredTrip(JSON.parse(JSON.stringify(trip([expense({ items: [item] })]))));
  assert.deepEqual(saved.expenses[0].items[0].quantity, quantity);
  assert.equal(total(saved.expenses[0]), 1001);
});

test('fractional units allocate a full line price without multiplying its cost', () => {
  const chocolate: Item = {
    id: 'chocolate', name: 'Chocolate', amount: 1001, members: ['a', 'b'],
    units: { total: 3, allocations: { a: 2.5, b: 0.5 } },
  };
  assert.equal(itemSplitError(chocolate), null);
  assert.equal(itemUnitsError(chocolate), null);
  assert.deepEqual(itemShares(chocolate, members), [834, 167, 0]);
  assert.equal(chocolate.amount, 1001);
  const arbitrary: Item = { ...chocolate, members: ['a', 'b', 'c'], units: { total: 7.5, allocations: { a: 3.25, b: 3.75, c: 0.5 } } };
  assert.deepEqual(itemShares(arbitrary, members), [434, 500, 67]);
  const microscopic: Item = { ...arbitrary, units: { total: 0.000003, allocations: { a: 0.000002, b: 0.000001, c: 0 } } };
  assert.deepEqual(itemShares(microscopic, members), [667, 334, 0]);
  const maximum: Item = { ...chocolate, amount: MAX_AMOUNT, units: { total: MAX_UNITS, allocations: { a: 999999.999999, b: 0.000001 } } };
  assert.equal(sum(itemShares(maximum, members)), MAX_AMOUNT);
  for (let amount = 0; amount < 1000; amount++) {
    assert.equal(sum(itemShares({ ...arbitrary, amount }, members)), amount);
    assert.equal(sum(itemShares({ ...microscopic, amount }, members)), amount);
  }
});

test('rejects invalid item unit totals, quantities, participant keys and conflicting split modes', () => {
  const item: Item = { id: 'chocolate', name: 'Chocolate', amount: 1001, members: ['a', 'b'], units: { total: 3, allocations: { a: 2.5, b: 0.5 } } };
  const invalid: unknown[] = [
    { total: 0, allocations: { a: 0, b: 0 } },
    { total: -3, allocations: { a: 2.5, b: 0.5 } },
    { total: 3, allocations: { a: 0, b: 0 } },
    { total: 3, allocations: { a: 3.5, b: -0.5 } },
    { total: 3, allocations: { a: 2.5, b: 0.500001 } },
    { total: 3.0000001, allocations: { a: 2.5, b: 0.5 } },
    { total: 3, allocations: { a: 2.5, b: 0.5000001 } },
    { total: MAX_UNITS + 1, allocations: { a: MAX_UNITS, b: 1 } },
    { total: 3, allocations: { a: NaN, b: 0.5 } },
    { total: 3, allocations: { a: Infinity, b: 0.5 } },
    { total: 3, allocations: { a: MAX_UNITS + 1, b: 0 } },
    { total: Infinity, allocations: { a: 2.5, b: 0.5 } },
    { total: 3, allocations: { a: 3 } },
    { total: 3, allocations: { a: 2.5, c: 0.5 } },
    { total: 3, allocations: { a: 2.5, b: 0.5, unknown: 0 } },
    { total: '3', allocations: { a: 2.5, b: 0.5 } },
    { total: 3, allocations: { a: '2.5', b: 0.5 } },
    { total: 3, allocations: null },
    null,
  ];
  for (const units of invalid) {
    const malformed = { ...item, units: units as Item['units'] };
    assert.ok(itemSplitError(malformed));
    assert.equal(itemSchema.safeParse(malformed).success, false);
    assert.throws(() => itemShares(malformed, members));
    assert.equal(expenseSchema.safeParse(expense({ items: [malformed] })).success, false);
    assert.equal(draftSchema.safeParse({ ...expense({ items: [malformed] }), status: 'review' }).success, false);
    assert.throws(() => validateLedger(ledger([expense({ items: [malformed] })])));
  }
  const conflicting = { ...item, percentages: { a: 80, b: 20 } };
  assert.match(itemSplitError(conflicting)!, /either percentages or units/);
  assert.equal(itemSchema.safeParse(conflicting).success, false);
  const unknown = { ...item, members: ['a', 'unknown'], units: { total: 3, allocations: { a: 2.5, unknown: 0.5 } } };
  assert.throws(() => itemShares(unknown, members), /Unknown member/);
  assert.throws(() => validateLedger(ledger([expense({ items: [unknown] })])), /assignments/);
});

test('fractional units preserve exact tax, tip, discount, FX and actual-bank allocations through JSON persistence', () => {
  const dinner = expense({ payer: 'c', items: [
    { id: 'chocolate', name: 'Chocolate', amount: 1001, members: ['a', 'b'], units: { total: 3, allocations: { a: 2.5, b: 0.5 } } },
    { id: 'coffee', name: 'Coffee', amount: 500, members: ['a', 'b'], units: { total: 7.5, allocations: { a: 1, b: 6.5 } } },
  ], tax: 200, tip: 100, discount: 50 });
  assert.equal(total(dinner), 1751);
  assert.deepEqual(shares(dinner, members), [1051, 700, 0]);
  assert.deepEqual(expenseShares(dinner, members, 'GBP'), [893, 595, 0]);
  assert.deepEqual(expenseShares({ ...dinner, bankAmount: 1501 }, members, 'GBP'), [901, 600, 0]);
  const holiday = trip([{ ...dinner, bankAmount: 1501 }]);
  holiday.drafts = [{ ...dinner, id: 'units-review', status: 'review' }];
  const persisted = validateLedger(JSON.parse(JSON.stringify({ trips: [holiday] }))).trips[0];
  assert.deepEqual(persisted.expenses[0].items.map(item => item.units), dinner.items.map(item => item.units));
  assert.deepEqual(persisted.drafts[0].items.map(item => item.units), dinner.items.map(item => item.units));
  assert.deepEqual(balances(persisted), [-901, -600, 1501]);
  const transfers = settlements(persisted);
  persisted.payments = transfers.map((transfer, index) => ({ ...transfer, id: `settled-${index}`, date: '2026-08-16' }));
  assert.deepEqual(balances(persisted), [0, 0, 0]);
});

test('receipt-wide percentages override fractional unit costs while retaining validated unit metadata', () => {
  const item: Item = { id: 'chocolate', name: 'Chocolate', amount: 1001, members: ['a', 'b'], units: { total: 3, allocations: { a: 2.5, b: 0.5 } } };
  const dinner = expense({ currency: 'GBP', fx: undefined, items: [item], percentages: { b: 50, c: 50 } });
  assert.deepEqual(shares(dinner, members), [0, 501, 500]);
  assert.deepEqual(expenseShares(dinner, members, 'GBP'), [0, 501, 500]);
  const saved = validateLedger(ledger([dinner])).trips[0].expenses[0];
  assert.deepEqual(saved.items[0].units, item.units);
  const invalidHidden = { ...dinner, items: [{ ...item, units: { total: 3, allocations: { a: 1, b: 1 } } }] };
  assert.equal(expenseSchema.safeParse(invalidHidden).success, false);
  assert.throws(() => validateLedger(ledger([invalidHidden])));
  assert.equal(expenseSchema.parse(expense()).items[0].units, undefined);
});

test('unit labels persist as receipt metadata and never change allocated line costs', () => {
  const item: Item = { id: 'chocolate', name: 'Chocolate', amount: 1001, members: ['a', 'b'], units: { total: 3, allocations: { a: 2.5, b: 0.5 }, label: '  bars  ' } };
  const parsed = itemSchema.parse(item);
  assert.equal(parsed.units?.label, 'bars');
  assert.deepEqual(itemShares(parsed, members), [834, 167, 0]);
  const holiday = trip([expense({ items: [item] })]);
  holiday.drafts = [{ ...expense({ id: 'review', items: [item] }), status: 'review' }];
  const persisted = validateLedger(JSON.parse(JSON.stringify({ trips: [holiday] }))).trips[0];
  assert.equal(persisted.expenses[0].items[0].units?.label, 'bars');
  assert.equal(persisted.drafts[0].items[0].units?.label, 'bars');
  for (const label of ['', '   ', 'x'.repeat(41)]) {
    const malformed = { ...item, units: { ...item.units!, label } };
    assert.ok(itemSplitError(malformed));
    assert.equal(itemSchema.safeParse(malformed).success, false);
  }
  assert.equal(unitsSchema.safeParse({ total: 3, allocations: { a: 2.5, b: 0.5 }, extra: 'ignored' }).success, false);
});

test('item-targeted receipt conversations and memory retain historical references without affecting money', () => {
  const question: ReceiptMessage = {
    id: 'question', role: 'user', text: 'Share these bars 2.5 to me and 0.5 to Bob.', createdAt: '2026-10-04T12:00:00Z',
    itemId: 'chocolate', authorMemberId: 'a', authorName: ' Alice ',
  };
  const answer: ReceiptMessage = {
    id: 'answer', role: 'assistant', text: 'The three bars are assigned 2.5 to Alice and 0.5 to Bob.', createdAt: '2026-10-04T12:01:00Z',
    replyTo: question.id, itemId: 'chocolate', authorName: 'ChatGPT',
  };
  const item: Item = { id: 'chocolate', name: 'Chocolate', amount: 1001, members: ['a', 'b'], units: { total: 3, allocations: { a: 2.5, b: 0.5 }, label: 'bars' } };
  const plain = expense({ items: [item] });
  const memory = { notes: 'The bars means the chocolate line. “Me” refers to the speaker.', aliases: [
    { name: ' bars ', itemId: item.id }, { name: 'me', memberId: 'a', scopeMemberId: 'a' },
  ] };
  const detailed = expense({ items: [item], conversation: [question, answer], memory });
  const holiday = trip([detailed]);
  holiday.drafts = [{ ...detailed, id: 'review', expenseId: detailed.id, status: 'review' }];
  const saved = validateLedger(JSON.parse(JSON.stringify({ trips: [holiday] }))).trips[0];
  assert.equal(saved.expenses[0].conversation![0].authorName, 'Alice');
  assert.equal(saved.expenses[0].conversation![0].authorMemberId, 'a');
  assert.equal(saved.expenses[0].conversation![1].itemId, 'chocolate');
  assert.equal(saved.expenses[0].memory!.aliases[0].name, 'bars');
  assert.deepEqual(saved.drafts[0].memory, saved.expenses[0].memory);
  assert.deepEqual(balances(saved), balances(trip([plain])));
  const historical = { ...saved.expenses[0], items: expense().items };
  assert.equal(expenseSchema.safeParse(historical).success, true, 'removed item targets stay in saved message and alias history');
  assert.equal(expenseSchema.parse(expense()).memory, undefined);
  for (const bad of [{ itemId: '' }, { authorMemberId: '' }, { authorName: 'x'.repeat(81) }]) {
    assert.equal(expenseSchema.safeParse({ ...detailed, conversation: [{ ...question, ...bad }] }).success, false);
  }
});

test('fractional percentages conserve cents and preserve selected-person remainder ordering', () => {
  const fractional: Item = {
    id: 'bread', name: 'Bread', amount: 100, members: ['a', 'b', 'c'],
    percentages: { a: 33.33, b: 33.33, c: 33.34 },
  };
  assert.deepEqual(itemShares(fractional, members), [33, 33, 34]);
  assert.deepEqual(itemShares({ ...fractional, amount: 1 }, members), [0, 0, 1]);
  for (let amount = 0; amount < 1000; amount++) {
    assert.equal(sum(itemShares({ ...fractional, amount }, members)), amount);
  }
  const tied: Item = { id: 'water', name: 'Water', amount: 1, members: ['b', 'a'], percentages: { a: 50, b: 50 } };
  assert.deepEqual(itemShares(tied, members), [0, 1, 0]);
  assert.deepEqual(itemShares({ ...tied, percentages: undefined }, members), [0, 1, 0]);
});

test('percentage costs flow through tax, tip, discount, conversion and actual bank fees', () => {
  const dinner = expense({
    payer: 'c', items: [{ id: 'food', name: 'Food', amount: 10000, members: ['a', 'b'], percentages: { a: 70, b: 30 } }],
    tax: 1000, tip: 500, discount: 500,
  });
  assert.deepEqual(shares(dinner, members), [7700, 3300, 0]);
  assert.equal(expenseTotal(dinner, 'GBP'), 9350);
  assert.deepEqual(expenseShares(dinner, members, 'GBP'), [6545, 2805, 0]);
  const bankCharged = { ...dinner, bankAmount: 9801 };
  assert.deepEqual(expenseShares(bankCharged, members, 'GBP'), [6861, 2940, 0]);
  assert.deepEqual(balances(trip([bankCharged])), [-6861, -2940, 9801]);
  assert.equal(sum(balances(trip([bankCharged]))), 0);
});

test('zero-priced items assign positive tax and tip only to their selected participant union', () => {
  const dinner = expense({
    payer: 'c',
    items: [{ id: 'complimentary', name: 'Complimentary meal', amount: 0, members: ['b'] }],
    tax: 101, tip: 2, discount: 1,
  });
  assert.equal(total(dinner), 102);
  assert.deepEqual(shares(dinner, members), [0, 102, 0]);
  assert.deepEqual(expenseShares(dinner, members, 'GBP'), [0, 87, 0]);
  assert.deepEqual(balances(trip([dinner])), [0, -87, 87]);
  validateLedger(ledger([dinner]));
  const union = { ...dinner, tax: 101, tip: 0, discount: 0, items: [
    { id: 'one', name: 'One', amount: 0, members: ['b'] },
    { id: 'two', name: 'Two', amount: 0, members: ['b', 'c'] },
    { id: 'three', name: 'Three', amount: 0, members: ['b'] },
  ] };
  assert.deepEqual(shares(union, members), [0, 51, 50], 'selecting someone on several items must not count them several times');
  assert.deepEqual(expenseShares({ ...union, bankAmount: 5 }, members, 'GBP'), [0, 3, 2]);
  assert.equal(sum(expenseShares({ ...union, bankAmount: 5 }, members, 'GBP')), 5);
  assert.throws(() => shares({ ...dinner, items: [] }, members), /Choose at least one person/);
});

test('the receipt-total rule rounds once so per-item pennies cannot pile onto one person', () => {
  const pair = [{ id: 'a', name: 'Chris' }, { id: 'b', name: 'Gary' }];
  const billa = expense({
    currency: 'GBP', fx: undefined, adjustmentAllocation: 'receipt-total',
    items: [
      { id: 'roll', name: 'Roll', amount: 35, members: ['a', 'b'] },
      { id: 'water', name: 'Water', amount: 129, members: ['a', 'b'] },
    ],
  });
  assert.deepEqual(shares({ ...billa, adjustmentAllocation: 'selected-participants' }, pair), [83, 81], 'the per-item rule rounds each line separately');
  assert.deepEqual(shares(billa, pair), [82, 82]);
  assert.deepEqual(expenseShares(billa, pair, 'GBP'), [82, 82]);
  const odd = { ...billa, items: [...billa.items, { id: 'gum', name: 'Gum', amount: 1, members: ['b', 'a'] }] };
  assert.deepEqual(shares(odd, pair), [83, 82], 'a true tie follows the order people were first selected on items');
  assert.deepEqual(shares({ ...odd, items: [odd.items[2], ...billa.items] }, pair), [82, 83]);
  assert.deepEqual(shares(expense({ adjustmentAllocation: 'receipt-total', items: [{ id: 'bar', name: 'Bar', amount: 1001, members: ['b', 'a'],
    units: { total: 3, allocations: { a: 1.5, b: 1.5 } } }] }), members), [500, 501, 0]);
});

test('the receipt-total rule shares tax, tip, discount and conversion against exact item shares', () => {
  const dinner = expense({
    adjustmentAllocation: 'receipt-total',
    items: [
      { id: 'salad', name: 'Salad', amount: 1250, members: ['a'] },
      { id: 'wine', name: 'Wine', amount: 2101, members: ['b', 'c'], percentages: { b: 33.33, c: 66.67 } },
      { id: 'bread', name: 'Bread', amount: 503, members: ['a', 'b', 'c'] },
      { id: 'units', name: 'Olives', amount: 700, members: ['c', 'a'], units: { total: 3, allocations: { a: 1, c: 2 } } },
    ], tax: 385, tip: 401, discount: 99,
  });
  assert.equal(sum(shares(dinner, members)), total(dinner));
  assert.equal(sum(expenseShares(dinner, members, 'GBP')), expenseTotal(dinner, 'GBP'));
  assert.equal(sum(expenseShares({ ...dinner, bankAmount: 4999 }, members, 'GBP')), 4999);
  const free = expense({ adjustmentAllocation: 'receipt-total', currency: 'GBP', fx: undefined, tax: 101,
    items: [{ id: 'free', name: 'Free', amount: 0, members: ['b', 'c'] }] });
  assert.deepEqual(shares(free, members), [0, 51, 50], 'zero-priced items share adjustments between selected people');
  assert.throws(() => shares({ ...free, items: [] }, members), /Choose at least one person/);
});

test('saved per-item receipts keep their balances until they are edited', () => {
  const legacy = expense({ currency: 'GBP', fx: undefined, items: [
    { id: 'roll', name: 'Roll', amount: 35, members: ['a', 'b'] },
    { id: 'water', name: 'Water', amount: 129, members: ['a', 'b'] },
  ] });
  const oldTrip = trip([legacy]);
  const untouched = validateLedger({ trips: [structuredClone(oldTrip)] }, { previous: { trips: [oldTrip] } }).trips[0];
  assert.equal(untouched.expenses[0].adjustmentAllocation, 'selected-participants');
  assert.deepEqual(shares(untouched.expenses[0], members), [83, 81, 0]);
  const edited = structuredClone(oldTrip);
  edited.expenses[0].title = 'BILLA';
  const saved = validateLedger({ trips: [edited] }, { previous: { trips: [oldTrip] } }).trips[0];
  assert.equal(saved.expenses[0].adjustmentAllocation, 'rotating-remainder');
  assert.deepEqual(shares(saved.expenses[0], members), [82, 82, 0]);
});

test('unversioned zero-price receipts preserve historical shares until explicitly saved with the corrected allocation rule', () => {
  const historical = expense({
    currency: 'GBP', fx: undefined, adjustmentAllocation: undefined,
    items: [{ id: 'complimentary', name: 'Complimentary meal', amount: 0, members: ['b'] }],
    tax: 100, tip: 1, discount: 0,
  });
  const oldTrip = trip([historical]);
  assert.deepEqual(shares(historical, members), [34, 34, 33]);
  assert.deepEqual(balances(oldTrip), [67, -34, -33]);
  const parsed = parseStoredTrip(JSON.parse(JSON.stringify(oldTrip)));
  assert.equal(parsed.expenses[0].adjustmentAllocation, undefined);
  const untouched = validateLedger({ trips: [parsed] }, { previous: { trips: [oldTrip] } }).trips[0];
  assert.equal(untouched.expenses[0].adjustmentAllocation, undefined);
  assert.deepEqual(balances(untouched), [67, -34, -33]);
  const modified = structuredClone(parsed);
  modified.expenses[0].title = 'Reviewed complimentary meal';
  const saved = validateLedger({ trips: [modified] }, { previous: { trips: [oldTrip] } }).trips[0];
  assert.equal(saved.expenses[0].adjustmentAllocation, 'rotating-remainder');
  assert.deepEqual(shares(saved.expenses[0], members), [0, 101, 0]);
  assert.deepEqual(balances(saved), [101, -101, 0]);
  const newTrip = validateLedger({ trips: [{ ...oldTrip, id: 'new-trip' }] }).trips[0];
  assert.equal(newTrip.expenses[0].adjustmentAllocation, 'rotating-remainder');
  assert.deepEqual(shares(newTrip.expenses[0], members), [0, 101, 0]);
});

test('waiting empty-item drafts accept allocation metadata without requiring completed receipt amounts', () => {
  const holiday = trip([]);
  holiday.drafts = [{ ...expense({ id: 'waiting', adjustmentAllocation: undefined }), items: [], fx: undefined, tax: 100, status: 'waiting' }];
  const accepted = validateLedger({ trips: [holiday] }).trips[0].drafts[0];
  assert.equal(accepted.adjustmentAllocation, 'rotating-remainder');
  assert.equal(accepted.items.length, 0);
  assert.equal(accepted.tax, 100);
});

test('receipt-wide percentages keep priority over selected zero-price-item participants', () => {
  const dinner = expense({
    items: [{ id: 'complimentary', name: 'Complimentary meal', amount: 0, members: ['b'] }],
    tax: 101, tip: 2, discount: 1, percentages: { a: 70, c: 30 },
  });
  assert.deepEqual(shares(dinner, members), [71, 0, 31]);
  assert.deepEqual(expenseShares(dinner, members, 'GBP'), [61, 0, 26]);
  assert.deepEqual(expenseShares({ ...dinner, bankAmount: 103 }, members, 'GBP'), [72, 0, 31]);
  validateLedger(ledger([dinner]));
});

test('traveller invitation previews exactly aggregate cost, upfront payments and transfers in settlement currency', () => {
  const holiday = trip([
    expense(),
    expense({ id: 'taxi', currency: 'GBP', fx: undefined, payer: 'b', items: [{ id: 'taxi-item', name: 'Taxi', amount: 1201, members: ['a', 'b'] }] }),
    expense({ id: 'bank', payer: 'c', bankAmount: 8777, percentages: { a: 70, b: 30 } }),
  ]);
  holiday.payments = [
    { id: 'one', from: 'a', to: 'b', amount: 900, date: '2026-08-16' },
    { id: 'two', from: 'b', to: 'a', amount: 200, date: '2026-08-16' },
    { id: 'three', from: 'c', to: 'a', amount: 300, date: '2026-08-16' },
  ];
  assert.deepEqual(travellerFinancialPreview(holiday, 'a'), {
    available: true, currency: 'GBP', expenseCount: 3, paymentCount: 3,
    costShare: 9579, paidUpfront: 8501, paymentsSent: 900, paymentsReceived: 500, netBalance: -678,
  });
  assert.deepEqual(travellerFinancialPreview(holiday, 'c'), {
    available: true, currency: 'GBP', expenseCount: 2, paymentCount: 1,
    costShare: 2833, paidUpfront: 8777, paymentsSent: 300, paymentsReceived: 0, netBalance: 6244,
  });
  members.forEach((member, index) => {
    const preview = travellerFinancialPreview(holiday, member.id);
    assert.equal(preview.available, true);
    if (preview.available) assert.equal(preview.netBalance, balances(holiday)[index]);
  });
});

test('traveller invitation previews expose no invented financial amounts for invalid legacy receipts or transfers', () => {
  const cases = [
    trip([expense({ bankAmount: 0 })]),
    trip([expense({ currency: 'GBP', bankAmount: 8700 })]),
    trip([expense({ items: [{ id: 'zero', name: 'Zero', amount: 0, members: ['a'] }] })]),
    trip([expense({ fx: { rate: 1e11, asOf: '2026-08-15', source: 'manual' } })]),
  ];
  const invalidPayment = trip();
  invalidPayment.payments = [{ id: 'invalid', from: 'a', to: 'b', amount: MAX_AMOUNT + 1, date: '2026-08-16' }];
  cases.push(invalidPayment);
  for (const holiday of cases) {
    const preview = travellerFinancialPreview(holiday, 'a');
    assert.equal(preview.available, false);
    assert.equal(preview.currency, 'GBP');
    assert.equal(preview.expenseCount, 1);
    assert.equal('costShare' in preview, false);
    assert.equal('netBalance' in preview, false);
    if (!preview.available) assert.ok(preview.message.length);
  }
  const missing = travellerFinancialPreview(trip(), 'missing');
  assert.equal(missing.available, false);
  if (!missing.available) assert.match(missing.message, /no longer in the holiday/);
});

test('rejects invalid explicit percentages in both the schema and share calculation', () => {
  const base: Item = { id: 'food', name: 'Food', amount: 100, members: ['a', 'b'], percentages: { a: 70, b: 30 } };
  const malformed: Item[] = [
    { ...base, members: [], percentages: {} },
    { ...base, members: ['a', 'a'], percentages: { a: 100 } },
    { ...base, percentages: { a: 70, b: 20 } },
    { ...base, percentages: { a: 0, b: 0 } },
    { ...base, percentages: { a: 100 } },
    { ...base, percentages: { a: 70, unknown: 30 } },
    { ...base, percentages: { a: 70, b: 30, c: 0 } },
    { ...base, percentages: { a: 33.333, b: 66.667 } },
    { ...base, percentages: { a: -1, b: 101 } },
    { ...base, percentages: { a: Number.NaN, b: 30 } },
    { ...base, percentages: { a: Infinity, b: 30 } },
  ];
  for (const item of malformed) {
    assert.ok(itemSplitError(item));
    assert.equal(itemSchema.safeParse(item).success, false);
    assert.throws(() => itemShares(item, members));
    assert.throws(() => validateLedger(ledger([expense({ items: [item] })])));
  }
  const unknown: Item = { ...base, members: ['a', 'unknown'], percentages: { a: 70, unknown: 30 } };
  assert.throws(() => itemShares(unknown, members), /Unknown member/);
  assert.throws(() => validateLedger(ledger([expense({ items: [unknown] })])), /assignments/);
  assert.throws(() => itemShares({ ...base, members: [] }, members), /at least one person/);
});

test('keeps percentage metadata in persisted expenses and review drafts without changing legacy receipts', () => {
  const item: Item = { id: 'food', name: 'Food', amount: 10001, members: ['a', 'b'], percentages: { a: 33.33, b: 66.67 } };
  const holiday = trip([expense({ items: [item] })]);
  holiday.drafts = [{ ...expense({ id: 'review', items: [item] }), status: 'review' }];
  const saved = validateLedger(JSON.parse(JSON.stringify({ trips: [holiday] })));
  assert.deepEqual(saved.trips[0].expenses[0].items[0].percentages, { a: 33.33, b: 66.67 });
  assert.deepEqual(saved.trips[0].drafts[0].items[0].percentages, { a: 33.33, b: 66.67 });
  assert.deepEqual(shares(expense(), members), [3334, 3334, 3333]);
  const oldSaved = validateLedger(ledger()).trips[0].expenses[0].items[0];
  assert.equal(oldSaved.percentages, undefined);
  assert.deepEqual(itemShares(oldSaved, members), [3334, 3334, 3333]);
});

test('receipt-wide percentages override item responsibilities and include tax, tip and discount', () => {
  const dinner = expense({
    payer: 'c', percentages: { a: 60, b: 40 },
    items: [{ id: 'food', name: 'Food', amount: 10000, members: ['c'], percentages: { c: 100 } }],
    tax: 1000, tip: 500, discount: 500,
  });
  assert.deepEqual(shares(dinner, members), [6600, 4400, 0]);
  assert.deepEqual(expenseShares(dinner, members, 'GBP'), [5610, 3740, 0]);
  assert.deepEqual(expenseShares({ ...dinner, bankAmount: 9801 }, members, 'GBP'), [5881, 3920, 0]);
  assert.deepEqual(balances(trip([{ ...dinner, bankAmount: 9801 }])), [-5881, -3920, 9801]);
  assert.equal(receiptSplitError(dinner), null);
});

test('converts receipt-wide percentages directly without reweighting rounded original pennies', () => {
  const dinner = expense({
    items: [{ id: 'small', name: 'Small charge', amount: 1, members: ['a'] }],
    percentages: { a: 50, b: 50 }, fx: { rate: 2, asOf: '2026-08-15', source: 'manual' },
  });
  assert.deepEqual(shares(dinner, members), [1, 0, 0]);
  assert.deepEqual(expenseShares(dinner, members, 'GBP'), [1, 1, 0]);
  assert.deepEqual(expenseShares({ ...dinner, bankAmount: 3 }, members, 'GBP'), [2, 1, 0]);
  assert.deepEqual(expenseShares({ ...dinner, fx: undefined, bankAmount: 2 }, members, 'GBP'), [1, 1, 0]);
});

test('allows a selected subset of known people for receipt-wide percentages', () => {
  const dinner = expense({
    currency: 'GBP', fx: undefined,
    items: [{ id: 'food', name: 'Food', amount: 10000, members: ['a', 'b', 'c'] }],
    percentages: { b: 40, c: 60 },
  });
  validateLedger(ledger([dinner]));
  assert.deepEqual(shares(dinner, members), [0, 4000, 6000]);
  assert.deepEqual(balances(trip([dinner])), [10000, -4000, -6000]);
  assert.deepEqual(shares({ ...dinner, percentages: { c: 100 } }, members), [0, 0, 10000]);
  assert.deepEqual(shares({ ...dinner, percentages: { a: 0, c: 100 } }, members), [0, 0, 10000]);
});

test('rejects invalid receipt-wide percentages and checks hidden item splits independently', () => {
  const malformed = [
    {}, { a: 70, b: 20 }, { a: 0, b: 0 }, { a: 33.333, b: 66.667 },
    { a: -1, b: 101 }, { a: Number.NaN }, { a: Infinity }, { '': 100 },
    Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`person-${index}`, index ? 0 : 100])),
  ];
  for (const percentages of malformed) {
    const dinner = expense({ percentages });
    assert.ok(receiptSplitError(dinner));
    assert.equal(expenseSchema.safeParse(dinner).success, false);
    assert.throws(() => shares(dinner, members));
    assert.throws(() => expenseShares(dinner, members, 'GBP'));
    assert.throws(() => validateLedger(ledger([dinner])));
  }
  const unknown = expense({ percentages: { a: 70, unknown: 30 } });
  assert.throws(() => validateLedger(ledger([unknown])), /receipt percentage assignments/);
  assert.throws(() => shares(unknown, members), /Unknown member/);
  assert.throws(() => expenseShares(unknown, members, 'GBP'), /Unknown member/);
  const malformedItem = expense({ percentages: { a: 100 }, items: [{ id: 'food', name: 'Food', amount: 100, members: ['b'], percentages: { b: 90 } }] });
  assert.equal(expenseSchema.safeParse(malformedItem).success, false);
  assert.throws(() => validateLedger(ledger([malformedItem])));
});

test('preserves receipt-wide percentages on saved expenses and review drafts', () => {
  const dinner = expense({ percentages: { a: 60, c: 40 } });
  const holiday = trip([dinner]);
  holiday.drafts = [{ ...dinner, id: 'review', status: 'review' }];
  const saved = validateLedger(JSON.parse(JSON.stringify({ trips: [holiday] })));
  assert.deepEqual(saved.trips[0].expenses[0].percentages, { a: 60, c: 40 });
  assert.deepEqual(saved.trips[0].drafts[0].percentages, { a: 60, c: 40 });
  assert.equal(draftSchema.safeParse({ ...holiday.drafts[0], percentages: { a: 50 } }).success, false);
  assert.equal(receiptSplitError(expense()), null);
});

test('persists a receipt review draft linked to an existing expense without changing posted costs', () => {
  const original = expense({ percentages: { a: 60, b: 40 }, adjustmentAllocation: 'rotating-remainder' });
  const holiday = trip([original]);
  const postedBalances = balances(holiday);
  holiday.drafts = [draftSchema.parse({
    ...original, id: 'receipt-review', expenseId: original.id, receiptId: 'receipt-image', status: 'waiting',
    items: [],
  })];
  const waiting = validateLedger(JSON.parse(JSON.stringify({ trips: [holiday] })));
  assert.equal(waiting.trips[0].drafts[0].expenseId, original.id);
  assert.equal(waiting.trips[0].drafts[0].status, 'waiting');
  assert.deepEqual(waiting.trips[0].expenses[0], original);
  assert.deepEqual(balances(waiting.trips[0]), postedBalances);

  holiday.drafts[0] = {
    ...holiday.drafts[0], status: 'review',
    items: [{ ...original.items[0], amount: 20000 }],
  };
  const reviewed = validateLedger(JSON.parse(JSON.stringify({ trips: [holiday] })));
  assert.equal(reviewed.trips[0].drafts[0].expenseId, original.id);
  assert.equal(reviewed.trips[0].drafts[0].items[0].amount, 20000);
  assert.deepEqual(reviewed.trips[0].expenses[0], original);
  assert.deepEqual(balances(reviewed.trips[0]), postedBalances);
});

test('rejects unknown receipt review targets and targets belonging only to a different trip', () => {
  const holiday = trip();
  holiday.drafts = [{ ...expense({ id: 'receipt-review' }), expenseId: 'unknown', status: 'review' }];
  assert.throws(() => validateLedger({ trips: [holiday] }), /expense that is not in this trip/);
  const otherHoliday = { ...trip([expense({ id: 'elsewhere' })]), id: 'other-holiday' };
  holiday.drafts[0].expenseId = 'elsewhere';
  assert.throws(() => validateLedger({ trips: [holiday, otherHoliday] }), /expense that is not in this trip/);
});

test('allows only one pending receipt review per posted expense while keeping legacy draft IDs distinct', () => {
  const holiday = trip();
  const review = { ...expense({ id: 'receipt-review' }), expenseId: 'dinner', status: 'review' as const };
  holiday.drafts = [review, { ...review, id: 'second-review', status: 'waiting' }];
  assert.throws(() => validateLedger({ trips: [holiday] }), /only have one pending receipt draft/);
  holiday.drafts = [review, { ...expense({ id: 'new-receipt' }), status: 'review' }];
  const saved = validateLedger({ trips: [holiday] });
  assert.equal(saved.trips[0].drafts[1].expenseId, undefined);
  assert.deepEqual(balances(saved.trips[0]), balances(trip()));
  holiday.drafts[0].id = 'dinner';
  assert.throws(() => validateLedger({ trips: [holiday] }), /Duplicate IDs/);
});

test('preserves per-receipt conversations on posted expenses and review drafts', () => {
  const conversation: ReceiptMessage[] = [
    { id: 'question', role: 'user', text: 'Is the service charge included?', createdAt: '2026-10-04T12:15:00.000Z' },
    { id: 'answer', role: 'assistant', text: 'The receipt shows it separately.', createdAt: '2026-10-04T12:16:00+01:00', replyTo: 'question' },
    { id: 'historic-answer', role: 'assistant', text: 'Please check the unclear wine price.', createdAt: '2026-10-04T12:17:00Z' },
  ];
  const original = expense({ conversation });
  const holiday = trip([original]);
  holiday.drafts = [{ ...original, id: 'review', expenseId: original.id, status: 'review' }];
  const saved = validateLedger(JSON.parse(JSON.stringify({ trips: [holiday] })));
  assert.deepEqual(saved.trips[0].expenses[0].conversation, conversation);
  assert.deepEqual(saved.trips[0].drafts[0].conversation, conversation);
  assert.deepEqual(balances(saved.trips[0]), balances(trip()));
  assert.equal(expenseSchema.parse(expense()).conversation, undefined);
  const trimmed = expenseSchema.parse(expense({ conversation: [{ ...conversation[0], text: '  Check this price.  ' }] }));
  assert.equal(trimmed.conversation![0].text, 'Check this price.');
});

test('rejects malformed receipt messages, invalid reply parents and duplicate IDs', () => {
  const question: ReceiptMessage = { id: 'question', role: 'user', text: 'Check the tip.', createdAt: '2026-10-04T12:15:00Z' };
  const answer: ReceiptMessage = { id: 'answer', role: 'assistant', text: 'It is 10%.', createdAt: '2026-10-04T12:16:00Z', replyTo: question.id };
  const invalid: unknown[] = [
    [{ ...question, id: '' }], [{ ...question, role: 'system' }],
    [{ ...question, text: '   ' }], [{ ...question, text: 'x'.repeat(4001) }],
    [{ ...question, createdAt: 'today' }], [{ ...question, createdAt: '2026-02-30T12:15:00Z' }],
    [{ ...answer, replyTo: '' }], [{ ...answer, replyTo: 'missing' }],
    [question, { ...answer, replyTo: 'answer' }],
    [question, answer, { ...answer, id: 'second-answer', replyTo: answer.id }],
    [question, { ...question, text: 'Repeated ID.' }],
    Array.from({ length: 101 }, (_, index) => ({ ...question, id: `question-${index}` })),
  ];
  for (const conversation of invalid) {
    const input = { ...expense(), conversation };
    assert.equal(expenseSchema.safeParse(input).success, false);
    assert.equal(draftSchema.safeParse({ ...input, status: 'review' }).success, false);
    assert.throws(() => validateLedger({ trips: [trip([input as Expense])] }));
  }
  assert.equal(expenseSchema.safeParse(expense({ conversation: [question, answer] })).success, true);
});

test('receipt source-draft provenance survives consumption, stored parsing and restoration without an active draft', () => {
  const original = expense({ sourceDraftId: 'consumed-processing-draft' });
  const persisted = validateLedger(ledger([original]));
  assert.equal(persisted.trips[0].drafts.length, 0);
  assert.equal(persisted.trips[0].expenses[0].sourceDraftId, 'consumed-processing-draft');
  assert.equal(parseStoredTrip(JSON.parse(JSON.stringify(persisted.trips[0]))).expenses[0].sourceDraftId, 'consumed-processing-draft');
  assert.equal(parseLedgerStructure(JSON.parse(JSON.stringify(persisted))).trips[0].expenses[0].sourceDraftId, 'consumed-processing-draft');
  assert.deepEqual(balances(persisted.trips[0]), balances(trip([expense()])));
  assert.equal(validateLedger(ledger([original]), { previous: ledger([]) }).trips[0].expenses[0].sourceDraftId, 'consumed-processing-draft');
});

test('receipt source-draft IDs are bounded references and remain optional for older expenses', () => {
  assert.equal(expenseSchema.parse(expense()).sourceDraftId, undefined);
  assert.equal(expenseSchema.parse(expense({ sourceDraftId: 'd'.repeat(100) })).sourceDraftId, 'd'.repeat(100));
  for (const sourceDraftId of ['', 'd'.repeat(101), 7, null]) {
    assert.equal(expenseSchema.safeParse({ ...expense(), sourceDraftId }).success, false);
  }
});
