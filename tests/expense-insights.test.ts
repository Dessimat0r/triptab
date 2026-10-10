import assert from 'node:assert/strict';
import test from 'node:test';
import { expenseCategory, expenseFacts, expenseFilterActive, filterExpenses, NO_EXPENSE_FILTER, spendingBreakdown, type ExpenseFilter } from '../lib/expense-insights';
import type { Expense, Trip } from '../lib/model';

function expense(id: string, title: string, amount: number, payer: string, members: string[], extra: Partial<Expense> = {}): Expense {
  return { id, title, date: '2026-10-05', time: '12:00', timezone: 'Europe/Lisbon', currency: 'EUR', payer,
    items: [{ id: `${id}-item`, name: title, amount, members }], tax: 0, tip: 0, discount: 0, ...extra };
}
const trip: Trip = {
  id: 'lisbon', name: 'Lisbon', currency: 'EUR',
  members: [{ id: 'a', name: 'Alice' }, { id: 'b', name: 'Bob' }, { id: 'c', name: 'Carol' }],
  // Saved order is most recent first.
  expenses: [
    expense('taxi', 'Airport taxi', 3000, 'b', ['a', 'b'], { date: '2026-10-07', time: '09:00' }),
    expense('dinner', 'Restaurante do Porto', 9000, 'a', ['a', 'b', 'c'], { date: '2026-10-05', time: '20:30',
      items: [{ id: 'bacalhau', name: 'Bacalhau', amount: 6000, members: ['a', 'b', 'c'] }, { id: 'vinho', name: 'Vinho tinto', amount: 3000, members: ['a', 'c'],
        translations: { en: { text: 'Red wine', source: 'ai' } } as never }] }),
    expense('museum', 'Museu Gulbenkian', 1500, 'c', ['c'], { date: '2026-10-06', time: '11:00', icon: { symbol: 'Landmark', background: 'purple' } }),
    expense('hotel', 'Hotel Avenida', 30000, 'a', ['a', 'b', 'c'], { date: '2026-10-05', time: '15:00' }),
  ],
  drafts: [], payments: [],
};
const facts = expenseFacts(trip);
const ids = (filter: Partial<ExpenseFilter>) => filterExpenses(facts, { ...NO_EXPENSE_FILTER, ...filter }, trip.members).map(entry => entry.expense.id);

test('categories follow the resolved icon, including a manual choice', () => {
  assert.deepEqual(facts.map(entry => entry.category), ['Transport', 'Food', 'Activities', 'Stays']);
  assert.equal(expenseCategory({ title: 'Airport taxi', icon: { symbol: 'Beer', background: 'gold' } }), 'Drinks');
  assert.equal(expenseCategory({ title: 'Unreadable' }), 'Other');
});

test('search matches titles, items, translations, payer and category by word prefix without accents', () => {
  assert.deepEqual(ids({ query: 'red wine' }), ['dinner']);
  assert.deepEqual(ids({ query: 'BACALH' }), ['dinner']);
  assert.deepEqual(ids({ query: 'museu' }), ['museum']);
  assert.deepEqual(ids({ query: 'bob' }), ['taxi'], 'payer name');
  assert.deepEqual(ids({ query: 'stays' }), ['hotel'], 'category name');
  assert.deepEqual(ids({ query: 'xi' }), [], 'only word prefixes match');
  assert.deepEqual(ids({ query: '   ' }), ['taxi', 'dinner', 'museum', 'hotel']);
});

test('payer, participant and category filters combine; the saved order is the default', () => {
  assert.deepEqual(ids({ payer: 'a' }), ['dinner', 'hotel']);
  assert.deepEqual(ids({ participant: 'c' }), ['dinner', 'museum', 'hotel']);
  assert.deepEqual(ids({ participant: 'c', payer: 'a', category: 'Food' }), ['dinner']);
  assert.deepEqual(ids({ participant: 'missing' }), []);
  assert.equal(expenseFilterActive({ ...NO_EXPENSE_FILTER, sort: 'highest' }), false, 'sorting alone is not a filter');
  assert.equal(expenseFilterActive({ ...NO_EXPENSE_FILTER, query: 'x' }), true);
});

test('sorts by purchase time or amount without changing the saved list', () => {
  assert.deepEqual(ids({ sort: 'newest' }), ['taxi', 'museum', 'dinner', 'hotel']);
  assert.deepEqual(ids({ sort: 'oldest' }), ['hotel', 'dinner', 'museum', 'taxi']);
  assert.deepEqual(ids({ sort: 'highest' }), ['hotel', 'dinner', 'taxi', 'museum']);
  assert.deepEqual(ids({ sort: 'lowest' }), ['museum', 'taxi', 'dinner', 'hotel']);
  assert.deepEqual(trip.expenses.map(entry => entry.id), ['taxi', 'dinner', 'museum', 'hotel']);
});

test('the breakdown totals categories, days and each traveller’s share in the settlement currency', () => {
  const breakdown = spendingBreakdown(facts, trip.members);
  assert.equal(breakdown.total, 43500);
  assert.equal(breakdown.counted, 4);
  assert.deepEqual(breakdown.categories.map(entry => [entry.category, entry.amount, entry.count]),
    [['Stays', 30000, 1], ['Food', 9000, 1], ['Transport', 3000, 1], ['Activities', 1500, 1]]);
  assert.deepEqual(breakdown.days.map(entry => [entry.date, entry.amount, entry.count]),
    [['2026-10-05', 39000, 2], ['2026-10-06', 1500, 1], ['2026-10-07', 3000, 1]]);
  // Alice: 10000 hotel + 2000 + 1500 dinner + 1500 taxi; shares add up to the total.
  assert.deepEqual(breakdown.travellers.map(entry => entry.amount), [15000, 13500, 15000]);
  assert.equal(breakdown.travellers.reduce((sum, entry) => sum + entry.amount, 0), breakdown.total);
});

test('foreign-currency entries convert, and entries that cannot be calculated are counted separately', () => {
  const foreign: Trip = { ...trip, expenses: [
    expense('fx', 'Coffee', 1000, 'a', ['a'], { currency: 'GBP', fx: { rate: 1.2, asOf: '2026-10-05', source: 'manual' } }),
    expense('broken', 'Lunch', 1000, 'a', ['a'], { currency: 'GBP' }),
  ] };
  const breakdown = spendingBreakdown(expenseFacts(foreign), foreign.members);
  assert.equal(breakdown.total, 1200);
  assert.equal(breakdown.needsReview, 1);
  const entry = expenseFacts(foreign)[1];
  assert.equal(entry.total, null);
  assert.deepEqual(filterExpenses(expenseFacts(foreign), { ...NO_EXPENSE_FILTER, participant: 'a', sort: 'highest' }, foreign.members).map(value => value.expense.id), ['fx', 'broken'],
    'an entry that needs review still matches its selected people and sorts last');
});
