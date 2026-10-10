import { ICON_CATALOG } from './expense-icons';
import { balances, expenseShares, expenseTotal, settlements, type Expense, type Trip } from './model';

const iconGroups = new Map<string, string>(ICON_CATALOG.map(([symbol, , group]) => [symbol, group]));

/** The spending group of an expense, from its chosen or suggested icon. */
export function expenseGroup(expense: Pick<Expense, 'icon' | 'suggestedIcon'>): string {
  const symbol = expense.icon?.symbol ?? expense.suggestedIcon?.symbol;
  return (symbol && iconGroups.get(symbol)) || 'Other';
}

/** Saved entries that refer to a traveller, so removing them would change money or history links. */
export function memberReferences(trip: Trip, memberId: string) {
  const inEntry = (entry: Trip['expenses'][number] | Trip['drafts'][number]) => entry.payer === memberId
    || Object.hasOwn(entry.percentages || {}, memberId)
    || entry.items.some(item => item.members.includes(memberId) || Object.hasOwn(item.percentages || {}, memberId)
      || Object.hasOwn(item.units?.allocations || {}, memberId));
  return {
    expenses: trip.expenses.filter(inEntry).length,
    drafts: trip.drafts.filter(inEntry).length,
    payments: trip.payments.filter(payment => payment.from === memberId || payment.to === memberId).length,
  };
}

/** Why a traveller cannot be removed yet, or null when removal is safe. */
export function memberRemovalBlocker(trip: Trip, memberId: string): string | null {
  const member = trip.members.find(value => value.id === memberId);
  if (!member) return 'This traveller is no longer in the holiday.';
  if (trip.members.length < 2) return 'A holiday needs at least one traveller.';
  if (member.userId) return `${member.name} has joined with an account, so they stay in the holiday. Mark the day they left instead.`;
  const { expenses, drafts, payments } = memberReferences(trip, memberId);
  const parts = [
    expenses ? `${expenses} ${expenses === 1 ? 'expense' : 'expenses'}` : '',
    drafts ? `${drafts} receipt ${drafts === 1 ? 'draft' : 'drafts'}` : '',
    payments ? `${payments} ${payments === 1 ? 'payment' : 'payments'}` : '',
  ].filter(Boolean);
  if (!parts.length) return null;
  return `${member.name} is in ${parts.join(' and ')}. Take them out of those first, or mark the day they left so new expenses leave them out.`;
}

/** Remove an unreferenced, unlinked traveller and any saved weight snapshot that names them. */
export function removeMember(trip: Trip, memberId: string): Trip {
  const blocker = memberRemovalBlocker(trip, memberId);
  if (blocker) throw new Error(blocker);
  const withoutWeight = <Entry extends { memberWeights?: Record<string, number> }>(entry: Entry): Entry => {
    if (!entry.memberWeights || !Object.hasOwn(entry.memberWeights, memberId)) return entry;
    const memberWeights = { ...entry.memberWeights };
    delete memberWeights[memberId];
    const next: Entry = { ...entry, memberWeights };
    if (!Object.keys(memberWeights).length) delete (next as { memberWeights?: unknown }).memberWeights;
    return next;
  };
  return { ...trip, members: trip.members.filter(member => member.id !== memberId),
    expenses: trip.expenses.map(withoutWeight), drafts: trip.drafts.map(withoutWeight) };
}

function dayCount(start: string, end: string) {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
}

export type SpendingSummary = {
  total: number;
  /** Expenses whose amounts could not be calculated. */
  unavailable: number;
  byDay: { date: string; amount: number }[];
  byGroup: { group: string; amount: number }[];
  /** Days used for averages: the holiday dates when set, else the first to last expense. */
  days: number;
  dailyAverage: number;
  budget?: { amount: number; remaining: number; usedPercent: number;
    /** Remaining budget per day left, when the holiday has an end date still ahead. */
    perDayLeft?: number; daysLeft?: number; projected?: number };
};

/** Group spend, spend per day and per group, and progress against the budget. */
export function spendingSummary(trip: Trip, today?: string): SpendingSummary {
  const byDay = new Map<string, number>(), byGroup = new Map<string, number>();
  let total = 0, unavailable = 0;
  for (const expense of trip.expenses) {
    let amount: number;
    try { amount = expenseTotal(expense, trip.currency); }
    catch { unavailable++; continue; }
    total += amount;
    byDay.set(expense.date, (byDay.get(expense.date) || 0) + amount);
    const group = expenseGroup(expense);
    byGroup.set(group, (byGroup.get(group) || 0) + amount);
  }
  const dates = [...byDay.keys()].sort();
  const start = trip.startDate || dates[0], end = trip.endDate || dates.at(-1);
  const days = start && end && end >= start ? dayCount(start, end) : dates.length;
  const summary: SpendingSummary = {
    total, unavailable,
    byDay: dates.map(date => ({ date, amount: byDay.get(date)! })),
    byGroup: [...byGroup].map(([group, amount]) => ({ group, amount })).sort((a, b) => b.amount - a.amount || a.group.localeCompare(b.group)),
    days, dailyAverage: days ? Math.round(total / days) : 0,
  };
  if (trip.budget) {
    const remaining = trip.budget - total;
    summary.budget = { amount: trip.budget, remaining, usedPercent: Math.round(total / trip.budget * 1000) / 10 };
    if (today && trip.endDate && today <= trip.endDate) {
      const from = trip.startDate && trip.startDate > today ? trip.startDate : today;
      const daysLeft = dayCount(from, trip.endDate);
      summary.budget.daysLeft = daysLeft;
      summary.budget.perDayLeft = Math.max(0, Math.floor(remaining / daysLeft));
      if (trip.startDate && today >= trip.startDate) {
        const elapsed = dayCount(trip.startDate, today);
        summary.budget.projected = Math.round(total / elapsed * dayCount(trip.startDate, trip.endDate));
      }
    }
  }
  return summary;
}

export type TravellerSummary = { id: string; name: string; paid: number; share: number; sent: number; received: number; net: number };

/** Everything an end-of-trip summary shows, or an error when some amounts need review first. */
export function tripSummary(trip: Trip, today?: string):
  { ok: true; spending: SpendingSummary; travellers: TravellerSummary[]; transfers: { from: string; to: string; amount: number }[] }
  | { ok: false; message: string } {
  try {
    const net = balances(trip);
    const travellers = trip.members.map((member, index) => ({ id: member.id, name: member.name, paid: 0, share: 0, sent: 0, received: 0, net: net[index] }));
    for (const expense of trip.expenses) {
      const split = expenseShares(expense, trip.members, trip.currency);
      split.forEach((amount, index) => { travellers[index].share += amount; });
      const payer = travellers.find(value => value.id === expense.payer);
      if (payer) payer.paid += expenseTotal(expense, trip.currency);
    }
    for (const payment of trip.payments) {
      const from = travellers.find(value => value.id === payment.from), to = travellers.find(value => value.id === payment.to);
      if (from) from.sent += payment.amount;
      if (to) to.received += payment.amount;
    }
    return { ok: true, spending: spendingSummary(trip, today), travellers, transfers: settlements(trip) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Review the flagged receipts before closing out this holiday.' };
  }
}

/**
 * Copies of an expense for the following days, such as a nightly room charge.
 * Copies keep the split and amounts but not the receipt image, scan evidence or chat.
 */
export function repeatExpense(expense: Expense, count: number, newId: () => string, options: { everyDays?: number } = {}): Expense[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > 60) throw new Error('Repeat between 1 and 60 times.');
  const step = options.everyDays ?? 1;
  const base = Date.parse(`${expense.date}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(base + (index + 1) * step * 86_400_000).toISOString().slice(0, 10);
    const copy: Expense = structuredClone(expense);
    copy.id = newId();
    copy.date = date;
    copy.items = copy.items.map(item => ({ ...item, id: newId(), scanSource: undefined, fieldSources: undefined }));
    for (const key of ['receiptId', 'receiptScan', 'conversation', 'memory', 'sourceDraftId', 'languageViewId', 'fieldSources', 'location', 'locationHint'] as const) delete copy[key];
    copy.source = 'manual';
    return JSON.parse(JSON.stringify(copy)) as Expense;
  });
}
