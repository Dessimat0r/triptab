import { itemSplitError, receiptSplitError, total, type Trip } from './model';
import type { ReceiptEditor } from './receipt-processing';
import { carryReviewAcknowledgements, pendingReviewActions, reconcileReceiptScan, receiptScanSaveError } from './receipt-scan';

/** Stable element IDs the save checklist can move focus to. */
export const EXPENSE_TARGETS = {
  title: 'expense-name-field',
  details: 'expense-purchase-details',
  review: 'expense-receipt-review',
  items: 'expense-items',
  split: 'expense-split-method',
  fx: 'expense-fx-panel',
} as const;

export type SaveBlocker = { key: string; message: string; target: typeof EXPENSE_TARGETS[keyof typeof EXPENSE_TARGETS] };

export function unassignedItemIds(entry: Pick<ReceiptEditor, 'items' | 'percentages'>): string[] {
  return entry.percentages === undefined ? entry.items.filter(item => !item.members.length).map(item => item.id) : [];
}

/**
 * Share every unassigned item equally between the chosen travellers. This is
 * an explicit human choice: assigned items and their existing splits stay as
 * they are, and printed quantities remain evidence on the item.
 */
export function assignUnassignedItems(entry: ReceiptEditor, memberIds: string[]): ReceiptEditor {
  const ids = [...new Set(memberIds)];
  if (!ids.length || entry.percentages !== undefined || !entry.items.some(item => !item.members.length)) return entry;
  const items = entry.items.map(item => item.members.length ? item : { ...item, members: ids, percentages: undefined, units: undefined });
  return carryReviewAcknowledgements(entry, { ...entry, items });
}

const plural = (count: number, one: string, many = one + 's') => `${count} ${count === 1 ? one : many}`;

/**
 * Everything that would currently stop Save, in the order a person can fix
 * it. Save remains the authority; this mirrors its checks so nothing is a
 * surprise, and an otherwise unexplained scan failure still gets an entry.
 */
export function expenseSaveBlockers(entry: ReceiptEditor, trip: Pick<Trip, 'currency'>): SaveBlocker[] {
  const blockers: SaveBlocker[] = [];
  const add = (key: string, message: string, target: SaveBlocker['target']) => blockers.push({ key, message, target });
  if (!entry.title.trim()) add('title', 'Add an expense name', EXPENSE_TARGETS.title);
  if (!entry.currency) add('currency', 'Choose the receipt currency', EXPENSE_TARGETS.details);
  const unreadable = entry.items.filter(item => item.amount === null).length;
  if (unreadable) add('prices', `Enter ${plural(unreadable, 'unreadable price')}`, EXPENSE_TARGETS.items);
  const unnamed = entry.items.filter(item => !item.name.trim()).length;
  if (unnamed) add('names', `Name ${plural(unnamed, 'item')}`, EXPENSE_TARGETS.items);
  const scan = entry.receiptScan && reconcileReceiptScan(entry);
  if (scan && entry.currency && scan.warnings.some(warning => !warning.resolved && warning.code === 'currency-mismatch')) {
    add('scan-currency', 'Match the original currency to the printed currency', EXPENSE_TARGETS.review);
  }
  const reviews = scan ? pendingReviewActions(entry) : 0;
  if (reviews) add('review', `Confirm ${plural(reviews, 'receipt check')}`, EXPENSE_TARGETS.review);
  const unassigned = unassignedItemIds(entry).length;
  if (unassigned) add('unassigned', `Choose who shares ${plural(unassigned, 'item')}`, EXPENSE_TARGETS.items);
  const splitError = receiptSplitError(entry);
  if (splitError) add('receipt-split', splitError, EXPENSE_TARGETS.split);
  else if (entry.percentages === undefined) {
    const index = entry.items.findIndex(item => item.members.length && itemSplitError(item));
    if (index >= 0) add('item-split', `Finish the split for item ${index + 1}`, EXPENSE_TARGETS.items);
  }
  if (entry.currency && entry.currency !== trip.currency) {
    if (entry.bankAmount === 0) add('bank', 'Enter the amount your bank charged', EXPENSE_TARGETS.fx);
    else if (!entry.bankAmount && !entry.fx?.rate) add('fx', 'Add an exchange rate or the bank charge', EXPENSE_TARGETS.fx);
  }
  if (!unreadable && entry.items.length && total(entry) <= 0) add('total', 'The total must be more than zero', EXPENSE_TARGETS.items);
  if (!entry.items.length) add('items', 'Add at least one item', EXPENSE_TARGETS.items);
  if (!blockers.length) {
    const scanError = receiptScanSaveError(entry, { allowAcknowledgement: true });
    if (scanError) add('scan', scanError, EXPENSE_TARGETS.review);
  }
  return blockers;
}
