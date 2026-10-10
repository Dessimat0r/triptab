import { isBill, type Expense, type Trip } from './model';
export type BillDefaults = { tripId: string; name: boolean; currency: boolean; previousTripId: string };

/** First approved receipt may consume the sole saved scan draft atomically.
 * A draft alone never authorizes changing currency. Financial entries lock it.
 */
export function isFirstBillReceipt(trip: Trip, expense: Pick<Expense, 'sourceDraftId'>) {
  return isBill(trip) && !trip.expenses.length && !trip.payments.length
    && (!trip.drafts.length || trip.drafts.length === 1 && trip.drafts[0].id === expense.sourceDraftId && trip.drafts[0].status === 'review' && !trip.drafts[0].expenseId);
}
export function firstBillExpense(trip: Trip, expense: Expense, defaults: BillDefaults | null) {
  const next = { ...trip }, entry = { ...expense };
  if (defaults?.tripId === trip.id && isFirstBillReceipt(trip, expense)) {
    if (defaults.name) next.name = expense.title.trim().slice(0, 100);
    if (defaults.currency) { next.currency = expense.currency; delete entry.fx; delete entry.bankAmount; }
  }
  return { trip: next, expense: entry };
}
export function billReceiptCurrencyChange(previous: Trip, next: Trip) {
  const expense = next.expenses[0];
  return !!expense && isFirstBillReceipt(previous, expense) && previous.drafts.length === 1
    && next.expenses.length === 1 && !next.payments.length && !next.drafts.length && next.currency === expense.currency;
}
