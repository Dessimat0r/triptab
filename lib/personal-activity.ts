import { expenseShares, expenseTotal, isBill, settlements, type Currency, type Ledger, type Trip } from './model';

/**
 * A person's financial activity across their open holidays and bills (F-05,
 * D04). Inputs are only the trips the server already let this account read.
 * People are matched across trips by their linked TripTab account only;
 * unlinked names stay separate per trip (D03). Nothing is netted across trips.
 */
export type ActivityEntry = {
  type: 'expense' | 'payment';
  tripId: string; tripName: string; tripKind: 'bill' | 'holiday'; currency: Currency;
  id: string; title: string; date: string; time?: string;
  /** Expense total, or the payment amount, in the trip's settlement currency; null if it cannot be calculated. */
  amount: number | null;
  /** My cost share of an expense (null if it cannot be calculated). */
  myShare?: number | null;
  paidByMe: boolean;
  /** People on the other side: the payer, or the payment's other person. Person keys, see `personKey`. */
  people: string[];
  /** For filtering: I owe on this entry, others owe me, or neither. */
  direction: 'i-owe' | 'owed-to-me' | 'none';
};
export type PersonTotals = {
  key: string; name: string; linked: boolean;
  byCurrency: { currency: Currency; owesMe: number; iOwe: number; owesMeTrips: string[]; iOweTrips: string[] }[];
};

/** The same TripTab account in every trip; an unlinked name only within its own trip. */
export function personKey(trip: Trip, memberId: string) {
  const member = trip.members.find(value => value.id === memberId);
  return member?.userId ? `account:${member.userId}` : `name:${trip.id}:${memberId}`;
}

function me(trip: Trip, accountId: string) { return trip.members.find(member => member.userId === accountId)?.id; }

export function personalActivity(ledger: Ledger, accountId: string): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  for (const trip of ledger.trips) {
    const mine = me(trip, accountId);
    if (!mine) continue;
    const index = trip.members.findIndex(member => member.id === mine);
    const base = { tripId: trip.id, tripName: trip.name, tripKind: isBill(trip) ? 'bill' as const : 'holiday' as const, currency: trip.currency };
    for (const expense of trip.expenses) {
      let amount: number | null = null, shares: number[] | null = null;
      try { amount = expenseTotal(expense, trip.currency); shares = expenseShares(expense, trip.members, trip.currency); } catch { /* shown as needing review */ }
      const myShare = shares ? shares[index] : null;
      const paidByMe = expense.payer === mine;
      const named = expense.percentages ? Object.hasOwn(expense.percentages, mine) : expense.items.some(item => item.members.includes(mine));
      if (!paidByMe && !named && !myShare) continue;
      const others = shares ? shares.reduce((sum, share, position) => position === index ? sum : sum + share, 0) : 0;
      entries.push({ ...base, type: 'expense', id: expense.id, title: expense.title, date: expense.date, time: expense.time, amount, myShare, paidByMe,
        people: paidByMe ? [] : [personKey(trip, expense.payer)],
        direction: paidByMe ? (others > 0 ? 'owed-to-me' : 'none') : (myShare ? 'i-owe' : 'none') });
    }
    for (const payment of trip.payments) {
      if (payment.from !== mine && payment.to !== mine) continue;
      const other = payment.from === mine ? payment.to : payment.from;
      entries.push({ ...base, type: 'payment', id: payment.id, title: payment.from === mine ? 'You paid' : 'You were paid', date: payment.date, time: payment.time,
        amount: payment.amount, paidByMe: payment.from === mine, people: [personKey(trip, other)], direction: 'none' });
    }
  }
  return entries.sort((a, b) => `${b.date} ${b.time ?? ''}`.localeCompare(`${a.date} ${a.time ?? ''}`));
}

/** Names for person keys; a linked account uses its latest name. */
export function personNames(ledger: Ledger): Map<string, string> {
  const names = new Map<string, string>();
  for (const trip of ledger.trips) for (const member of trip.members) {
    const key = personKey(trip, member.id);
    names.set(key, member.userId ? member.name : `${member.name} (${trip.name})`);
  }
  return names;
}

/**
 * Per person and currency: what they owe me and what I owe them, each from
 * the trips' own suggested settlements. The two are shown separately and
 * never netted, so separate bills stay separate (D04).
 */
export function peopleSummary(ledger: Ledger, accountId: string): PersonTotals[] {
  const names = personNames(ledger);
  const people = new Map<string, PersonTotals>();
  for (const trip of ledger.trips) {
    const mine = me(trip, accountId);
    if (!mine) continue;
    let transfers: ReturnType<typeof settlements>;
    try { transfers = settlements(trip); } catch { continue; }
    for (const transfer of transfers) {
      if (transfer.from !== mine && transfer.to !== mine) continue;
      const other = transfer.from === mine ? transfer.to : transfer.from;
      const key = personKey(trip, other);
      const person = people.get(key) ?? { key, name: names.get(key) ?? 'Someone', linked: key.startsWith('account:'), byCurrency: [] };
      let line = person.byCurrency.find(value => value.currency === trip.currency);
      if (!line) { line = { currency: trip.currency, owesMe: 0, iOwe: 0, owesMeTrips: [], iOweTrips: [] }; person.byCurrency.push(line); }
      if (transfer.to === mine) { line.owesMe += transfer.amount; line.owesMeTrips.push(trip.id); }
      else { line.iOwe += transfer.amount; line.iOweTrips.push(trip.id); }
      people.set(key, person);
    }
  }
  return [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
}
