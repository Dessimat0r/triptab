import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCsv, previewImport } from '../lib/import-ledger';
import { expenseShares, balances, type Trip } from '../lib/model';
test('CSV parser keeps commas, doubled quotes and multiline fields and rejects malformed records', () => {
  assert.deepEqual(
    parseCsv('Title,Note\r\n"Dinner, Prague","Bob said ""hello""\nthen paid"'),
    [
      ['Title', 'Note'],
      ['Dinner, Prague', 'Bob said "hello"\nthen paid'],
    ],
  );
  assert.throws(() => parseCsv('a,b\n"unfinished'), /unfinished/);
});
test('basic CSV and Splitwise net columns preserve exact shares without inventing a payer', () => {
  const a = previewImport(
    'Date,Description,Amount,Currency,Paid by,Shared by\n2026-10-10,Dinner,10.01,GBP,Alice,Alice;Bob',
    'trip.csv',
  ).trips[0];
  assert.deepEqual(
    expenseShares(a.expenses[0], a.members, a.currency),
    [501, 500],
  );
  const b = previewImport(
    'Date,Description,Category,Cost,Currency,Alice,Bob\n2026-10-10,Dinner,Food,10.01,GBP,5.00,-5.00',
    'splitwise.csv',
  ).trips[0];
  assert.deepEqual(
    expenseShares(b.expenses[0], b.members, b.currency),
    [501, 500],
  );
  assert.throws(
    () =>
      previewImport(
        'Date,Description,Cost,Currency,Alice,Bob\n2026-10-10,Dinner,10.01,GBP,0.00,0.00',
        'x.csv',
      ),
    /single payer/,
  );
});
test('JSON financial copy keeps saved rounding and item translations while dropping account links and photos', () => {
  const trip: Trip = {
    id: 'old',
    ownerId: 'old-owner',
    name: 'Trip',
    currency: 'GBP',
    members: [
      {
        id: 'a',
        name: 'Alice',
        userId: 'old-owner',
        email: 'alice@example.test',
        payTo: { paypal: 'alice' },
      },
      { id: 'b', name: 'Bob' },
    ],
    expenses: [
      {
        id: 'food',
        title: 'Food',
        date: '2026-10-10',
        time: '20:30',
        timezone: 'Europe/London',
        currency: 'GBP',
        payer: 'a',
        receiptId: 'old-photo',
        adjustmentAllocation: 'receipt-total',
        items: [
          {
            id: 'line',
            name: 'Tostada',
            nameLanguage: 'es',
            translations: {
              en: {
                text: 'Toast',
                sourceText: 'Tostada',
                pairedText: 'Tostada',
                sourceLanguage: 'es',
                provenance: 'user',
              },
            },
            amount: 1001,
            members: ['a', 'b'],
          },
        ],
        tax: 0,
        tip: 0,
        discount: 0,
      },
    ],
    drafts: [],
    payments: [],
  };
  const copy = previewImport(
    JSON.stringify({
      schemaVersion: 1,
      amountScale: 100,
      data: { trips: [trip] },
    }),
    'trip.json',
  ).trips[0];
  assert.notEqual(copy.id, trip.id);
  assert.equal(copy.members[0].userId, undefined);
  assert.equal(copy.expenses[0].receiptId, undefined);
  assert.equal(copy.members[0].payTo, undefined);
  assert.deepEqual(balances(copy), balances(trip));
  assert.deepEqual(
    copy.expenses[0].items[0].translations,
    trip.expenses[0].items[0].translations,
  );
});

test('TripTab JSON preserves bill kind and applies bill validation on import', () => {
  const bill: Trip = { id: 'bill', kind: 'bill', name: 'Dinner', currency: 'GBP', members: [{ id: 'a', name: 'Alice' }, { id: 'b', name: 'Bob' }], expenses: [], drafts: [], payments: [] };
  const input = (trip: Trip) => JSON.stringify({ schemaVersion: 1, amountScale: 100, data: { trips: [trip] } });
  const copy = previewImport(input(bill), 'bill.json').trips[0];
  assert.equal(copy.kind, 'bill');
  assert.equal(copy.name, bill.name);
  assert.equal(copy.currency, bill.currency);
  assert.deepEqual(copy.members.map(member => member.name), ['Alice', 'Bob']);
  for (const extra of [{ startDate: '2026-10-10' }, { budget: 100 }, { members: [{ id: 'a', name: 'Alice', weight: 2 }] }]) {
    assert.throws(() => previewImport(input({ ...bill, ...extra }), 'bill.json'), /Bills don’t/);
  }
  const csv = previewImport('Date,Description,Amount,Currency,Paid by,Shared by\n2026-10-10,Dinner,10.00,GBP,Alice,Alice;Bob', 'bill.csv').trips[0];
  assert.equal(csv.kind ?? 'holiday', 'holiday');
});
