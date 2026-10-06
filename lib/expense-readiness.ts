import { itemSplitError, receiptSplitError, total, type ReceiptMessage, type Trip } from './model';
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
  amount: 'expense-quick-amount',
  shared: 'expense-quick-shared',
} as const;

/** The element that holds one receipt line's controls. */
export const expenseItemTarget = (itemId: string) => `expense-item-${itemId}`;

/**
 * `target` is the element to scroll to; `focus` optionally selects the
 * control inside it that fixes the problem (otherwise its first control).
 */
export type SaveBlocker = { key: string; message: string; target: string; focus?: string };

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
  const add = (key: string, message: string, target: string, focus?: string) => blockers.push({ key, message, target, ...(focus ? { focus } : {}) });
  const firstItem = (match: (item: ReceiptEditor['items'][number]) => boolean) => {
    const item = entry.items.find(match);
    return item ? expenseItemTarget(item.id) : EXPENSE_TARGETS.items;
  };
  if (!entry.title.trim()) add('title', 'Add an expense name', EXPENSE_TARGETS.title);
  if (!entry.currency) add('currency', 'Choose the receipt currency', EXPENSE_TARGETS.details);
  const unreadable = entry.items.filter(item => item.amount === null).length;
  if (unreadable) add('prices', `Enter ${plural(unreadable, 'unreadable price')}`, firstItem(item => item.amount === null), '.moneyinput input');
  const unnamed = entry.items.filter(item => !item.name.trim()).length;
  // The receipt-original name is the required one; a translation is optional.
  if (unnamed) add('names', `Name ${plural(unnamed, 'item')}`, firstItem(item => !item.name.trim()), 'input[required]');
  const scan = entry.receiptScan && reconcileReceiptScan(entry);
  if (scan && entry.currency && scan.warnings.some(warning => !warning.resolved && warning.code === 'currency-mismatch')) {
    add('scan-currency', 'Match the original currency to the printed currency', EXPENSE_TARGETS.review);
  }
  const reviews = scan ? pendingReviewActions(entry) : 0;
  if (reviews) add('review', `Confirm ${plural(reviews, 'receipt check')}`, EXPENSE_TARGETS.review);
  const unassigned = unassignedItemIds(entry).length;
  if (unassigned) add('unassigned', `Choose who shares ${plural(unassigned, 'item')}`, firstItem(item => !item.members.length), '.share-split button[aria-pressed]');
  const splitError = receiptSplitError(entry);
  if (splitError) add('receipt-split', splitError, EXPENSE_TARGETS.split);
  else if (entry.percentages === undefined) {
    const index = entry.items.findIndex(item => item.members.length && itemSplitError(item));
    if (index >= 0) add('item-split', `Finish the split for item ${index + 1}`, expenseItemTarget(entry.items[index].id), '.share-split input[aria-invalid="true"], .share-split button[aria-pressed="true"]');
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

/**
 * Whether the receipt conversation holds a real discussion: a traveller has
 * written about the receipt (an upload note or a question), so they see the
 * reply to it. A scan adds a summary every time; on its own that is routine.
 * Item discussions are shown with their items.
 */
export function hasReceiptDiscussion(messages: ReceiptMessage[] = []): boolean {
  return messages.some(message => message.role === 'user' && !message.itemId);
}
