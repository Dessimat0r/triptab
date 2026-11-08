import { balances, isBill, type DraftItem, type Trip } from './model';

type SplitEntry = { items: DraftItem[]; percentages?: Record<string, number> };
export const billParticipantIds = (trip: Pick<Trip, 'members'>) => trip.members.filter(member => !member.retired).map(member => member.id);

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
  const selectedIds = (selected: string[] = before) => [...new Set([...selected.filter(id => ids.includes(id)), ...ids.filter(id => !before.includes(id))])];
  let unpaidBill = false;
  if (isBill(previous) && !previous.payments.length) {
    try { unpaidBill = balances(previous).some(amount => amount !== 0); } catch { /* Uncalculable bills require explicit review. */ }
  }
  return { ...next, expenses: unpaidBill ? next.expenses.map(expense => {
    if (!expense.items.some(item => item.splitMode === 'default')) return expense;
    const participants = selectedIds(expense.splitMembers);
    return participants.length ? defaultSplit({ ...expense, splitMembers: participants }, participants) : expense;
  }) : next.expenses, drafts: next.drafts.map(draft => {
    if (draft.expenseId) return draft;
    const selected = draft.splitMembers ?? before;
    const participants = selectedIds(selected);
    return participants.length ? defaultSplit({ ...draft, splitMembers: participants }, participants) : draft;
  }) };
}
