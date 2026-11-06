import { balances, settlements, type Expense, type Trip } from './model';

/**
 * What an edit or deletion does to who owes whom (F-13). Recorded payments
 * are never changed: the result says which new transfers would be needed
 * afterwards, using the same balance and settlement rules as the app.
 */
export type SettlementImpact = {
  /** The trip had recorded payments and every balance was zero before the change. */
  wasSettled: boolean;
  /** Recorded payments exist, so the change can reopen or alter settled amounts. */
  hasPayments: boolean;
  /** Transfers needed after the change. */
  after: { from: string; to: string; amount: number }[];
  /** Each person's balance change, in settlement minor units (positive: gets back more). */
  changes: { memberId: string; change: number }[];
  /** False when an entry cannot be calculated; the caller must not present figures. */
  available: boolean;
};

export function settlementImpact(trip: Trip, change: { replace: Expense } | { remove: string }): SettlementImpact {
  const hasPayments = trip.payments.length > 0;
  const next: Trip = 'remove' in change
    ? { ...trip, expenses: trip.expenses.filter(expense => expense.id !== change.remove) }
    : { ...trip, expenses: trip.expenses.some(expense => expense.id === change.replace.id)
      ? trip.expenses.map(expense => expense.id === change.replace.id ? change.replace : expense)
      : [change.replace, ...trip.expenses] };
  try {
    const before = balances(trip), after = balances(next);
    return {
      wasSettled: hasPayments && before.every(value => value === 0),
      hasPayments,
      after: settlements(next),
      changes: trip.members.map((member, index) => ({ memberId: member.id, change: after[index] - before[index] })).filter(value => value.change),
      available: true,
    };
  } catch {
    return { wasSettled: false, hasPayments, after: [], changes: [], available: false };
  }
}

/** Plain-language summary, e.g. "This bill was settled. After this change, Sam pays Gary £5.00." */
export function describeSettlementImpact(impact: SettlementImpact, options: {
  kind: 'bill' | 'holiday'; name: (memberId: string) => string; money: (amount: number) => string; action: 'change' | 'deletion';
}): string | null {
  if (!impact.hasPayments) return null;
  if (!impact.available) return `Recorded payments stay as they are. Check the balances after this ${options.action}.`;
  const lead = impact.wasSettled ? `This ${options.kind} was settled.` : 'Recorded payments stay as they are.';
  const result = impact.after.length
    ? `After this ${options.action}, ${impact.after.map(transfer => `${options.name(transfer.from)} pays ${options.name(transfer.to)} ${options.money(transfer.amount)}`).join(', ')}.`
    : `After this ${options.action}, everyone is still settled.`;
  return `${lead} ${result}`;
}
