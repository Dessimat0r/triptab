import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeExpenseEdits } from '../lib/expense-merge';
import { expenseShares, total, validateLedger, type Expense, type Trip } from '../lib/model';

const members = [{ id: 'gary', name: 'Gary' }, { id: 'sam', name: 'Sam' }];
function dinner(overrides: Partial<Expense> = {}): Expense {
  return { id: 'dinner', title: 'Dinner', date: '2026-11-06', time: '20:00', timezone: 'Europe/London',
    currency: 'GBP', payer: 'gary', tax: 0, tip: 0, discount: 0, adjustmentAllocation: 'native-minor-units',
    items: [{ id: 'meal', name: 'Dinner', amount: 2000, members: ['gary', 'sam'] }], ...overrides };
}
const withItem = (entry: Expense, id: string, change: Partial<Expense['items'][number]>) =>
  ({ ...entry, items: entry.items.map(item => item.id === id ? { ...item, ...change } : item) });
function holiday(expense: Expense): Trip {
  return { id: 'trip', name: 'Trip', currency: 'GBP', members, expenses: [expense], drafts: [], payments: [] };
}

test('F-08 acceptance: one person changes the amount, the other the name; both survive', () => {
  const base = dinner();
  const theirs = withItem(base, 'meal', { amount: 3000 });
  const mine = { ...base, title: "Dinner at Rosa's" };
  const result = mergeExpenseEdits(base, mine, theirs);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.merged.title, "Dinner at Rosa's");
  assert.equal(result.merged.items[0].amount, 3000);
  assert.equal(total(result.merged), 3000);
  assert.deepEqual(result.applied.map(change => change.key), ['item:meal:financial']);
  // The merged record is a valid ledger entry whose shares sum to the total.
  const saved = validateLedger({ trips: [holiday(result.merged)] }).trips[0];
  assert.equal(expenseShares(saved.expenses[0], members, 'GBP').reduce((sum, share) => sum + share, 0), 3000);
});

test('a quick-form name edit that also renames the line and records provenance still merges', () => {
  const base = dinner();
  const theirs = withItem(base, 'meal', { amount: 3000, fieldSources: { amount: 'user' } });
  const mine = withItem({ ...base, title: "Dinner at Rosa's" }, 'meal', { name: "Dinner at Rosa's", fieldSources: { name: 'user' } });
  const result = mergeExpenseEdits(base, mine, theirs);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.merged.items[0], { id: 'meal', name: "Dinner at Rosa's", amount: 3000, members: ['gary', 'sam'], fieldSources: { amount: 'user', name: 'user' } });
});

test('both people changing the amount differently is a conflict that needs a choice', () => {
  const base = dinner();
  const theirs = withItem(base, 'meal', { amount: 3000 }), mine = withItem(base, 'meal', { amount: 2500 });
  const result = mergeExpenseEdits(base, mine, theirs);
  assert.deepEqual(result.conflicts.map(conflict => conflict.key), ['item:meal:financial']);
  assert.equal(result.merged.items[0].amount, 3000, 'unresolved conflicts never keep the stale or my value silently');
  assert.equal(mergeExpenseEdits(base, mine, theirs, { 'item:meal:financial': 'mine' }).merged.items[0].amount, 2500);
  assert.deepEqual(mergeExpenseEdits(base, mine, theirs, { 'item:meal:financial': 'theirs' }).conflicts, []);
});

test('the same change on both sides is not a conflict', () => {
  const base = dinner(), changed = withItem(base, 'meal', { amount: 3000 });
  assert.deepEqual(mergeExpenseEdits(base, changed, structuredClone(changed)).conflicts, []);
});

test('an item price and its sharing merge as one unit; its name merges separately', () => {
  const base = dinner();
  const theirs = withItem(base, 'meal', { members: ['gary'] });
  const mine = withItem(base, 'meal', { name: 'Tasting menu' });
  const result = mergeExpenseEdits(base, mine, theirs);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.merged.items[0], { id: 'meal', name: 'Tasting menu', amount: 2000, members: ['gary'] });
  // Price changed by one, sharing by the other: one financial unit, so it must be chosen.
  const split = mergeExpenseEdits(base, withItem(base, 'meal', { amount: 2400 }), theirs);
  assert.deepEqual(split.conflicts.map(conflict => conflict.key), ['item:meal:financial']);
});

test('lines added, removed and edited by different people merge by stable item ID', () => {
  const base = dinner({ items: [{ id: 'a', name: 'Starter', amount: 500, members: ['gary'] }, { id: 'b', name: 'Main', amount: 1500, members: ['sam'] }] });
  const theirs = { ...base, items: [...base.items, { id: 'c', name: 'Wine', amount: 900, members: ['gary', 'sam'] }] };
  const mine = { ...base, items: [base.items[1], { id: 'd', name: 'Dessert', amount: 600, members: ['sam'] }] };
  const result = mergeExpenseEdits(base, mine, theirs);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.merged.items.map(item => item.id), ['b', 'c', 'd'], 'my removal and both additions apply');
  // A line one person removed while the other changed it is a conflict.
  const edited = withItem(base, 'a', { amount: 700 });
  const removal = mergeExpenseEdits(base, { ...base, items: [base.items[1]] }, edited);
  assert.deepEqual(removal.conflicts.map(conflict => conflict.key), ['item:a']);
  assert.deepEqual(mergeExpenseEdits(base, { ...base, items: [base.items[1]] }, edited, { 'item:a': 'mine' }).merged.items.map(item => item.id), ['b']);
});

test('currency, rate and bank charge stay consistent as one group', () => {
  const base = dinner({ currency: 'EUR', fx: { rate: 0.85, asOf: '2026-11-05', source: 'reference' } });
  const theirs = { ...base, currency: 'USD' as const, fx: { rate: 0.78, asOf: '2026-11-05', source: 'reference' as const } };
  const mine = { ...base, fx: { rate: 0.86, asOf: '2026-11-05', source: 'manual' as const } };
  const result = mergeExpenseEdits(base, mine, theirs);
  assert.deepEqual(result.conflicts.map(conflict => conflict.key), ['currency']);
  assert.equal(result.merged.currency, 'USD'); assert.equal(result.merged.fx?.rate, 0.78, 'never a USD amount with my EUR rate');
});

test('switching to whole-receipt percentages conflicts with re-allocated lines', () => {
  const base = dinner();
  const mine = { ...base, percentages: { gary: 70, sam: 30 } };
  const theirs = withItem(base, 'meal', { members: ['sam'] });
  assert(mergeExpenseEdits(base, mine, theirs).conflicts.some(conflict => conflict.key === 'split-mode'));
  // A descriptive change by the other person does not block the split change.
  assert.deepEqual(mergeExpenseEdits(base, mine, { ...base, title: 'Supper' }).conflicts, []);
});

test('payer and date conflicts are reported; discussions always combine', () => {
  const base = dinner({ conversation: [{ id: 'm1', role: 'user', text: 'hi', createdAt: '2026-11-06T20:00:00Z' }] as Expense['conversation'] });
  const theirs = { ...base, payer: 'sam', conversation: [...base.conversation!, { id: 'm2', role: 'user', text: 'theirs', createdAt: '2026-11-06T20:01:00Z' }] as Expense['conversation'] };
  const mine = { ...base, payer: 'gary', date: '2026-11-05', conversation: [...base.conversation!, { id: 'm3', role: 'user', text: 'mine', createdAt: '2026-11-06T20:02:00Z' }] as Expense['conversation'] };
  mine.payer = 'gary';
  const result = mergeExpenseEdits(base, { ...mine, payer: 'gary' }, theirs);
  assert.deepEqual(result.conflicts, [], 'my payer equals the base, so their payer applies');
  assert.equal(result.merged.payer, 'sam'); assert.equal(result.merged.date, '2026-11-05');
  assert.deepEqual(result.merged.conversation?.map(message => message.id), ['m1', 'm2', 'm3']);
  const clash = mergeExpenseEdits(base, { ...base, payer: 'gary', time: '21:00' }, { ...base, time: '19:00' });
  assert.deepEqual(clash.conflicts.map(conflict => conflict.key), ['when']);
});

test('editor-only fields come from the editor and provenance follows the value taken', () => {
  const base = dinner({ fieldSources: { title: 'receipt' } });
  const theirs = { ...base, payer: 'sam', fieldSources: { title: 'receipt', payer: 'user' as const } };
  const mine = { ...base, title: 'Mine', expenseId: 'dinner', draftId: 'draft', fieldSources: { title: 'user' as const } };
  const result = mergeExpenseEdits(base, mine, theirs);
  assert.equal(result.merged.expenseId, 'dinner'); assert.equal(result.merged.draftId, 'draft');
  assert.deepEqual(result.merged.fieldSources, { title: 'user', payer: 'user' });
});

test('property: independent edits never conflict and never lose the other person\'s change', () => {
  let seed = 20261106;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const edits: ((entry: Expense) => Expense)[] = [
    entry => ({ ...entry, title: `T${Math.floor(random() * 1000)}` }),
    entry => ({ ...entry, payer: entry.payer === 'gary' ? 'sam' : 'gary' }),
    entry => ({ ...entry, tip: 100 + Math.floor(random() * 500) }),
    entry => ({ ...entry, tax: 1 + Math.floor(random() * 300) }),
    entry => withItem(entry, 'a', { amount: 100 + Math.floor(random() * 5000) }),
    entry => withItem(entry, 'b', { members: random() < 0.5 ? ['gary'] : ['sam'] }),
    entry => withItem(entry, 'a', { name: `Line ${Math.floor(random() * 99)}` }),
    entry => ({ ...entry, date: '2026-11-0' + (1 + Math.floor(random() * 5)) }),
  ];
  const fields = ['title', 'payer', 'tip', 'tax', 'a.amount', 'b.members', 'a.name', 'date'];
  const read = (entry: Expense, field: string) => {
    const [id, key] = field.split('.');
    return key ? entry.items.find(item => item.id === id)?.[key as 'amount'] : entry[field as 'title'];
  };
  for (let run = 0; run < 500; run++) {
    const base = dinner({ items: [{ id: 'a', name: 'A', amount: 1000, members: ['gary', 'sam'] }, { id: 'b', name: 'B', amount: 777, members: ['gary', 'sam'] }] });
    const order = edits.map((_, index) => index).sort(() => random() - 0.5);
    const split = 1 + Math.floor(random() * (edits.length - 1));
    const mineEdits = order.slice(0, split), theirEdits = order.slice(split);
    const mine = mineEdits.reduce((entry, index) => edits[index](entry), structuredClone(base));
    const theirs = theirEdits.reduce((entry, index) => edits[index](entry), structuredClone(base));
    const result = mergeExpenseEdits(base, mine, theirs);
    assert.deepEqual(result.conflicts, [], `run ${run}`);
    for (const index of mineEdits) assert.deepEqual(read(result.merged, fields[index]), read(mine, fields[index]), `run ${run} keeps my ${fields[index]}`);
    for (const index of theirEdits) assert.deepEqual(read(result.merged, fields[index]), read(theirs, fields[index]), `run ${run} keeps their ${fields[index]}`);
    const shares = expenseShares(validateLedger({ trips: [holiday(result.merged)] }).trips[0].expenses[0], members, 'GBP');
    assert.equal(shares.reduce((sum, share) => sum + share, 0), total(result.merged));
  }
});
