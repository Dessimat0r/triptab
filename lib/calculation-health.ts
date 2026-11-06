import { expenseShares, expenseTotal, type Trip } from './model';

/**
 * Which saved expenses cannot be calculated (F-20), so the app can name them
 * instead of hiding every balance. Partial totals exclude them and are always
 * labelled incomplete; settlement suggestions are never shown from them.
 */
export function calculationHealth(trip: Trip) {
  const failing: { id: string; title: string; message: string }[] = [];
  let partialSpent = 0;
  for (const expense of trip.expenses) {
    try {
      const amount = expenseTotal(expense, trip.currency);
      expenseShares(expense, trip.members, trip.currency);
      partialSpent += amount;
    } catch (cause) {
      failing.push({ id: expense.id, title: expense.title || 'Untitled', message: cause instanceof Error ? cause.message : 'This expense needs review.' });
    }
  }
  return { failing, partialSpent };
}
