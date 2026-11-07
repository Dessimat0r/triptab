import { total, type Draft, type Expense, type Trip } from './model';

/**
 * Likely duplicates of an entry being saved (F-09): same day, same receipt
 * currency, total within 1%, and a matching name or printed total. Shown as a
 * notice with "Save anyway"; it never blocks saving.
 */
export type LikelyDuplicate = { id: string; title: string; date: string; payer: string; amount: number; currency: string; draft: boolean };

const normal = (value: string) => value.normalize('NFKD').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, '');
function sameName(a: string, b: string) {
  const left = normal(a), right = normal(b);
  return !!left && !!right && (left === right || (Math.min(left.length, right.length) >= 4 && (left.includes(right) || right.includes(left))));
}
function safeTotal(entry: Expense | Draft) { try { return entry.items.some(item => item.amount === null) ? null : total(entry); } catch { return null; } }

export function findLikelyDuplicates(trip: Trip, entry: Expense | Draft, ignore: string[] = []): LikelyDuplicate[] {
  const amount = safeTotal(entry);
  if (amount === null || amount <= 0 || !entry.currency) return [];
  const skip = new Set([entry.id, ...ignore, ...('sourceDraftId' in entry && entry.sourceDraftId ? [entry.sourceDraftId] : []),
    ...('expenseId' in entry && entry.expenseId ? [entry.expenseId] : [])]);
  const printed = entry.receiptScan?.printedTotal ?? null;
  return [...trip.expenses, ...trip.drafts].flatMap(other => {
    if (skip.has(other.id) || ('expenseId' in other && other.expenseId && skip.has(other.expenseId))) return [];
    if (other.currency !== entry.currency || !other.date || other.date !== entry.date) return [];
    const otherAmount = safeTotal(other);
    if (otherAmount === null || Math.abs(otherAmount - amount) > Math.max(1, Math.round(amount * 0.01))) return [];
    const otherPrinted = other.receiptScan?.printedTotal ?? null;
    if (!sameName(entry.title, other.title) && !(printed !== null && printed === otherPrinted)) return [];
    return [{ id: other.id, title: other.title || 'Untitled', date: other.date, payer: other.payer, amount: otherAmount, currency: other.currency!, draft: 'status' in other }];
  });
}
