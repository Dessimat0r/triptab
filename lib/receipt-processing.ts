import { equalSavedValue } from './client-ledger';
import type { Draft, Expense, Trip } from './model';

export type ReceiptEditor = Expense & { draftId?: string; expenseId?: string };
export type InitialReceiptReview = {
  accountId: string;
  tripId: string;
  editorId: string;
  draftId: string;
  receiptId: string;
  financial: ReturnType<typeof receiptEditableValue>;
  pendingFinancial?: ReturnType<typeof receiptEditableValue>;
};

// Compare what the traveller can edit, independently of conversation, memory
// and draft bookkeeping. An incoming proposal must not erase local edits.
export function receiptEditableValue(entry: ReceiptEditor) {
  const { title, date, time, timezone, currency, payer, items, tax, tip, discount, percentages, fx, bankAmount } = entry;
  return { title, date, time, timezone, currency, payer, items, tax, tip, discount, percentages, fx, bankAmount };
}

export function isBlankReceipt(entry: ReceiptEditor) {
  return !entry.expenseId && !entry.title.trim() && !entry.tax && !entry.tip && !entry.discount
    && entry.percentages === undefined && entry.fx === undefined && entry.bankAmount === undefined
    && entry.items.every(item => !item.name.trim() && !item.amount && item.units === undefined && item.percentages === undefined);
}

export function matchingReceiptProposal(trip: Trip, editor: ReceiptEditor) {
  if (!editor.draftId) return null;
  return trip.drafts.find(draft => draft.id === editor.draftId && draft.status === 'review'
    && draft.receiptId === editor.receiptId && draft.expenseId === editor.expenseId) || null;
}

export function isUnchangedInitialReceipt(initial: InitialReceiptReview | null, accountId: string, trip: Trip, editor: ReceiptEditor, draft: Draft) {
  return !!initial && initial.accountId === accountId && initial.tripId === trip.id
    && initial.editorId === editor.id && initial.draftId === draft.id && initial.receiptId === draft.receiptId
    && editor.draftId === draft.id && editor.receiptId === draft.receiptId
    && !editor.expenseId && !draft.expenseId && !trip.expenses.some(expense => expense.id === editor.id)
    && equalSavedValue(initial.financial, receiptEditableValue(editor));
}

export function mayFillInitialReceipt(initial: InitialReceiptReview | null, accountId: string, trip: Trip, editor: ReceiptEditor, draft: Draft) {
  return draft.items.length > 0 && isUnchangedInitialReceipt(initial, accountId, trip, editor, draft);
}

export function receiptProposalEditor(editor: ReceiptEditor, draft: Draft): ReceiptEditor {
  return { ...editor, ...draft, id: editor.id, draftId: draft.id, expenseId: draft.expenseId,
    date: draft.date || editor.date, time: draft.time || editor.time, timezone: draft.timezone || editor.timezone };
}
