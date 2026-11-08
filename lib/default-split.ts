import { balances, defaultParticipants, isBill, memberPresent, type DraftItem, type Trip } from './model';

type SplitEntry = { items: DraftItem[]; percentages?: Record<string, number> };
/** Everyone still counted on the bill. Date-blind, so it detects membership changes only. */
export const billParticipantIds = (trip: Pick<Trip, 'members'>) => trip.members.filter(member => !member.retired).map(member => member.id);

/** Who a new line splits between by default: travellers present on the purchase date
 * (holidays honour joining/leaving dates, as a manually added expense does). Without a date,
 * or on a bill, that is everyone not retired. */
export const defaultParticipantIds = (trip: Pick<Trip, 'members'>, date?: string) => defaultParticipants(trip.members, date);

/** The purchase date only when it is real: a date the app filled in as a default says nothing about who was there. */
export const knownPurchaseDate = (entry: { date?: string; fieldSources?: { date?: string } }) => entry.fieldSources?.date === 'default' ? undefined : entry.date;

/** A draft's selection after membership changed: keep the current selection and add only new people who were present on its date. */
export function followParticipants(next: Pick<Trip, 'members'>, before: string[], selected: string[] | undefined, date?: string) {
  const ids = billParticipantIds(next);
  const current = selected ?? defaultParticipants(next.members.filter(member => before.includes(member.id)), date);
  return [...new Set([...current.filter(id => ids.includes(id)),
    ...next.members.filter(member => ids.includes(member.id) && !before.includes(member.id) && memberPresent(member, date)).map(member => member.id)])];
}

/** Allocation is a product default, never an assertion about consumption. */
export function equalItem<T extends DraftItem>(item: T, ids: string[]): T {
  return { ...item, members: [...ids], percentages: undefined, units: undefined, splitMode: 'default' };
}

/** Only marked defaults and genuinely new/unassigned lines follow selection. */
export function defaultSplit<T extends SplitEntry>(entry: T, ids: string[], fillUnassigned = false): T {
  if (!ids.length || entry.percentages !== undefined) return entry;
  let changed = false;
  const items = entry.items.map(item => {
    if (item.splitMode !== 'default' && !(fillUnassigned && item.splitMode !== 'custom' && !item.members.length && !item.percentages && !Object.keys(item.units?.allocations ?? {}).length)) return item;
    if (item.splitMode === 'default' && !item.units && !item.percentages && item.members.length === ids.length && item.members.every((id, index) => id === ids[index])) return item;
    changed = true;
    return equalItem(item, ids);
  });
  return changed ? { ...entry, items } : entry;
}

/** Only unpaid, unsettled bills may follow membership changes automatically.
 * Payment-backed/settled obligations and historical allocations stay exact. */
export function updateDefaultParticipants(previous: Trip, next: Trip): Trip {
  const ids = billParticipantIds(next);
  if (JSON.stringify(billParticipantIds(previous)) === JSON.stringify(ids)) return next;
  const before = billParticipantIds(previous);
  let unpaidBill = false;
  if (isBill(previous) && !previous.payments.length) {
    try { unpaidBill = balances(previous).some(amount => amount !== 0); } catch { /* Uncalculable bills require explicit review. */ }
  }
  return { ...next, expenses: unpaidBill ? next.expenses.map(expense => {
    if (!expense.items.some(item => item.splitMode === 'default')) return expense;
    const participants = followParticipants(next, before, expense.splitMembers, knownPurchaseDate(expense));
    return participants.length ? defaultSplit({ ...expense, splitMembers: participants }, participants) : expense;
  }) : next.expenses, drafts: next.drafts.map(draft => {
    if (draft.expenseId) return draft;
    const participants = followParticipants(next, before, draft.splitMembers, knownPurchaseDate(draft));
    return participants.length ? defaultSplit({ ...draft, splitMembers: participants }, participants) : draft;
  }) };
}
