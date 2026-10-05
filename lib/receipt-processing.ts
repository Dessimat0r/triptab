import { equalSavedValue } from './client-ledger';
import type { Draft, DraftItem, Expense, Trip } from './model';

export type ReceiptEditor = Omit<Expense, 'items' | 'currency'> & { items: DraftItem[]; currency: Draft['currency']; draftId?: string; expenseId?: string };
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
// and draft bookkeeping. Cosmetic icon choices are merged separately so they
// do not prevent initial itemisation. An incoming proposal must not erase them.
export function receiptEditableValue(entry: ReceiptEditor) {
  const { title, date, time, timezone, currency, payer, items, tax, tip, discount, percentages, fx, bankAmount, receiptScan, fieldSources } = entry;
  return { title, date, time, timezone, currency, payer, items, tax, tip, discount, percentages, fx, bankAmount, receiptScan, fieldSources };
}

export function isBlankReceipt(entry: ReceiptEditor) {
  return !entry.expenseId && !entry.title.trim() && !entry.tax && !entry.tip && !entry.discount
    && entry.percentages === undefined && entry.fx === undefined && entry.bankAmount === undefined
    && entry.items.every(item => !item.name.trim() && !item.amount && item.quantity === undefined && item.units === undefined && item.percentages === undefined);
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
  const next = { ...editor, ...draft, id: editor.id, draftId: draft.id, expenseId: draft.expenseId,
    icon: editor.icon,
    date: draft.date || editor.date, time: draft.time || editor.time, timezone: draft.timezone || editor.timezone };
  // A proposal may replace defaults, but user-confirmed purchase details stay
  // authoritative even when a later external client carries older metadata.
  for (const field of ['title', 'currency', 'date', 'time', 'timezone', 'payer', 'tax', 'tip', 'discount'] as const) {
    if (editor.fieldSources?.[field] !== 'user') continue;
    Object.assign(next, { [field]: editor[field], fieldSources: { ...next.fieldSources, [field]: 'user' } });
  }
  if (next.currency !== editor.currency) { next.fx = undefined; next.bankAmount = undefined; }
  return next;
}

export function receiptEditorTotal(entry: Pick<ReceiptEditor, 'items' | 'tax' | 'tip' | 'discount'>): number | null {
  if (entry.items.some(item => item.amount === null || !Number.isSafeInteger(item.amount))) return null;
  const amount = entry.items.reduce((sum, item) => sum + item.amount!, 0) + entry.tax + entry.tip - entry.discount;
  return Number.isSafeInteger(amount) ? amount : null;
}

export function userReceiptField<T extends ReceiptEditor>(entry: T, field: keyof NonNullable<T['fieldSources']>, value: unknown): T {
  return { ...entry, [field]: value, fieldSources: { ...entry.fieldSources, [field]: 'user' } };
}
