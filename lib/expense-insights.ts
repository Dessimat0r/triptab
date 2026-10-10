import { ICON_CATALOG, iconSearchText, resolveExpenseIcon, type ExpenseSymbol } from './expense-icons';
import { expenseShares, expenseTotal, type Expense, type Trip } from './model';

// Categories are the icon catalogue's groups, so a manual icon choice is also
// the category choice and saved expenses need no extra field.
export const EXPENSE_CATEGORIES = ['Food', 'Drinks', 'Transport', 'Stays', 'Activities', 'Shopping', 'Health & family', 'Other'] as const;
export type ExpenseCategory = typeof EXPENSE_CATEGORIES[number];
const symbolCategories = new Map<ExpenseSymbol, ExpenseCategory>(ICON_CATALOG.map(icon => [icon[0], icon[2]]));

export function expenseCategory(expense: Parameters<typeof resolveExpenseIcon>[0]): ExpenseCategory {
  return symbolCategories.get(resolveExpenseIcon(expense).symbol) ?? 'Other';
}

export type ExpenseFacts = {
  expense: Expense;
  /** Position in the saved list; new expenses are saved first. */
  order: number;
  /** Settlement-currency total, or null while the saved entry needs review. */
  total: number | null;
  /** Each traveller's share in trip member order, or null while it needs review. */
  shares: number[] | null;
  category: ExpenseCategory;
  searchText: string;
};

export type ExpensePreview = { total: number | null; shares: number[] | null };

/** The settlement total and every traveller's share, or nulls while the entry needs review. */
export function expensePreview(expense: Expense, trip: Trip): ExpensePreview {
  try {
    const total = expenseTotal(expense, trip.currency);
    return { total, shares: total > 0 ? expenseShares(expense, trip.members, trip.currency) : trip.members.map(() => 0) };
  } catch { return { total: null, shares: null }; }
}

/**
 * Search text and category for each saved expense, once per trip revision.
 * Pass the list's existing previews so amounts are not calculated twice.
 */
export function expenseFacts(trip: Trip, previews?: ReadonlyMap<string, ExpensePreview>): ExpenseFacts[] {
  const names = new Map(trip.members.map(member => [member.id, member.name]));
  return trip.expenses.map((expense, order) => {
    const { total, shares } = previews?.get(expense.id) ?? expensePreview(expense, trip);
    const category = expenseCategory(expense);
    const words = [expense.title, category, expense.currency, names.get(expense.payer) ?? '', expense.location?.label ?? '',
      ...expense.items.flatMap(item => [item.name, ...Object.values(item.translations ?? {}).map(value => value?.text ?? '')])];
    return { expense, order, total, shares, category, searchText: ` ${iconSearchText(words.join(' '))} ` };
  });
}

export const EXPENSE_SORTS = [
  ['recent', 'Recently added'],
  ['newest', 'Newest purchase first'],
  ['oldest', 'Oldest purchase first'],
  ['highest', 'Highest amount first'],
  ['lowest', 'Lowest amount first'],
] as const;
export type ExpenseSort = typeof EXPENSE_SORTS[number][0];
export type ExpenseFilter = { query: string; payer: string; participant: string; category: ExpenseCategory | ''; sort: ExpenseSort };
export const NO_EXPENSE_FILTER: ExpenseFilter = { query: '', payer: '', participant: '', category: '', sort: 'recent' };

export function expenseFilterActive(filter: ExpenseFilter): boolean {
  return !!(filter.query.trim() || filter.payer || filter.participant || filter.category);
}

/** True when the traveller owes part of the expense. Unreadable entries fall back to their selected people. */
export function expenseInvolves(facts: ExpenseFacts, memberIndex: number, memberId: string): boolean {
  if (facts.shares) return facts.shares[memberIndex] > 0;
  const { expense } = facts;
  if (expense.percentages) return (expense.percentages[memberId] ?? 0) > 0;
  return expense.items.some(item => item.members.includes(memberId));
}

function matches(facts: ExpenseFacts, filter: Omit<ExpenseFilter, 'sort' | 'category'>, members: Trip['members']): boolean {
  if (filter.payer && facts.expense.payer !== filter.payer) return false;
  if (filter.participant) {
    const index = members.findIndex(member => member.id === filter.participant);
    if (index < 0 || !expenseInvolves(facts, index, filter.participant)) return false;
  }
  const terms = iconSearchText(filter.query).split(' ').filter(Boolean);
  // Every typed word must start a word in the entry: "pizz" finds "Pizzeria", "zeria" does not.
  return terms.every(term => facts.searchText.includes(` ${term}`));
}

const purchaseTime = (expense: Expense) => `${expense.date}T${expense.time}`;

/** Filters and sorts without changing the saved order. Entries that need review sort after known amounts. */
export function filterExpenses(facts: readonly ExpenseFacts[], filter: ExpenseFilter, members: Trip['members']): ExpenseFacts[] {
  const result = facts.filter(entry => (!filter.category || entry.category === filter.category) && matches(entry, filter, members));
  const amount = (entry: ExpenseFacts, direction: 1 | -1) => entry.total === null ? Infinity : direction * entry.total;
  const compare: Record<ExpenseSort, (a: ExpenseFacts, b: ExpenseFacts) => number> = {
    recent: () => 0,
    newest: (a, b) => purchaseTime(b.expense).localeCompare(purchaseTime(a.expense)),
    oldest: (a, b) => purchaseTime(a.expense).localeCompare(purchaseTime(b.expense)),
    highest: (a, b) => amount(a, -1) - amount(b, -1),
    lowest: (a, b) => amount(a, 1) - amount(b, 1),
  };
  return result.sort((a, b) => compare[filter.sort](a, b) || a.order - b.order);
}

export type SpendingBreakdown = {
  total: number;
  counted: number;
  /** Expenses left out because their saved amounts need review. */
  needsReview: number;
  categories: { category: ExpenseCategory; amount: number; count: number }[];
  travellers: { memberId: string; amount: number }[];
  days: { date: string; amount: number; count: number }[];
};

/**
 * Category and day totals use each expense's settlement-currency total;
 * traveller totals are what each person owes, not what they paid upfront.
 */
export function spendingBreakdown(facts: readonly ExpenseFacts[], members: Trip['members']): SpendingBreakdown {
  const categories = new Map<ExpenseCategory, { amount: number; count: number }>();
  const days = new Map<string, { amount: number; count: number }>();
  const travellers = members.map(() => 0);
  let total = 0, counted = 0, needsReview = 0;
  for (const entry of facts) {
    if (entry.total === null || !entry.shares) { needsReview++; continue; }
    counted++; total += entry.total;
    const category = categories.get(entry.category) ?? { amount: 0, count: 0 };
    category.amount += entry.total; category.count++; categories.set(entry.category, category);
    const day = days.get(entry.expense.date) ?? { amount: 0, count: 0 };
    day.amount += entry.total; day.count++; days.set(entry.expense.date, day);
    entry.shares.forEach((share, index) => { travellers[index] += share; });
  }
  return {
    total, counted, needsReview,
    categories: [...categories].map(([category, value]) => ({ category, ...value }))
      .sort((a, b) => b.amount - a.amount || EXPENSE_CATEGORIES.indexOf(a.category) - EXPENSE_CATEGORIES.indexOf(b.category)),
    travellers: members.map((member, index) => ({ memberId: member.id, amount: travellers[index] })),
    days: [...days].map(([date, value]) => ({ date, ...value })).sort((a, b) => a.date.localeCompare(b.date)),
  };
}
