import assert from 'node:assert/strict';
import test from 'node:test';
import { peopleSummary, personalActivity, personKey } from '../lib/personal-activity';
import { settlements, validateLedger, type Expense, type Ledger, type Trip } from '../lib/model';

const spend = (id: string, payer: string, amount: number, members: string[], date = '2026-11-06'): Expense => ({ id, title: id, date, time: '12:00', timezone: 'Europe/London',
  currency: 'GBP', payer, tax: 0, tip: 0, discount: 0, items: [{ id: `${id}-i`, name: id, amount, members }] });
// Gary (account gary) and Sam (account sam) share a holiday and two bills; Sam has a namesake who is not linked.
const holiday: Trip = { id: 'h', name: 'Lisbon', currency: 'EUR', members: [{ id: 'hg', name: 'Gary', userId: 'gary' }, { id: 'hs', name: 'Sam', userId: 'sam' }],
  expenses: [{ ...spend('Hotel', 'hs', 10000, ['hg', 'hs']), currency: 'EUR' }], payments: [], drafts: [] };
const taxi: Trip = { id: 'taxi', kind: 'bill', name: 'Taxi', currency: 'GBP', members: [{ id: 'tg', name: 'Gary', userId: 'gary' }, { id: 'ts', name: 'Sam', userId: 'sam' }],
  expenses: [spend('Taxi', 'tg', 3000, ['tg', 'ts'], '2026-11-05')], payments: [], drafts: [] };
const pizza: Trip = { id: 'pizza', kind: 'bill', name: 'Pizza', currency: 'GBP', members: [{ id: 'pg', name: 'Gary', userId: 'gary' }, { id: 'ps', name: 'Sam', userId: 'sam' }],
  expenses: [spend('Pizza', 'ps', 2000, ['pg', 'ps'], '2026-11-07')], payments: [{ id: 'part', from: 'pg', to: 'ps', amount: 400, date: '2026-11-08' }], drafts: [] };
const namesake: Trip = { id: 'club', kind: 'bill', name: 'Club', currency: 'GBP', members: [{ id: 'cg', name: 'Gary', userId: 'gary' }, { id: 'cs', name: 'Sam' }],
  expenses: [spend('Drinks', 'cg', 1000, ['cg', 'cs'])], payments: [], drafts: [] };
const ledger: Ledger = validateLedger({ trips: [holiday, taxi, pizza, namesake] });

test('F-05 Activity lists my expenses and payments across holidays and bills, newest first', () => {
  const entries = personalActivity(ledger, 'gary');
  assert.deepEqual(entries.map(entry => `${entry.type}:${entry.id}`), ['payment:part', 'expense:Pizza', 'expense:Hotel', 'expense:Drinks', 'expense:Taxi']);
  const taxiEntry = entries.find(entry => entry.id === 'Taxi')!;
  assert.equal(taxiEntry.myShare, 1500); assert.equal(taxiEntry.direction, 'owed-to-me'); assert.equal(taxiEntry.tripKind, 'bill');
  assert.equal(entries.find(entry => entry.id === 'Pizza')!.direction, 'i-owe');
  // Sam sees only Sam's trips; the namesake bill (Sam's name, not account) is not Sam's.
  assert.deepEqual(personalActivity(ledger, 'sam').map(entry => entry.tripId).sort(), ['h', 'pizza', 'pizza', 'taxi']);
  assert.deepEqual(personalActivity(ledger, 'stranger'), []);
});

test('F-05 People: per person and currency, owed and owing kept apart, matched by account only', () => {
  const people = peopleSummary(ledger, 'gary');
  const sam = people.find(person => person.key === 'account:sam')!;
  assert.deepEqual(sam.byCurrency.find(line => line.currency === 'GBP'), { currency: 'GBP', owesMe: 1500, iOwe: 600, owesMeTrips: ['taxi'], iOweTrips: ['pizza'] },
    'Taxi (Sam owes £15) and Pizza (I owe £6 after a £4 payment) are not netted');
  assert.deepEqual(sam.byCurrency.find(line => line.currency === 'EUR'), { currency: 'EUR', owesMe: 0, iOwe: 5000, owesMeTrips: [], iOweTrips: ['h'] });
  const namesakeKey = personKey(ledger.trips[3], 'cs');
  assert.equal(namesakeKey, 'name:club:cs');
  assert(people.some(person => person.key === namesakeKey && !person.linked && person.name === 'Sam (Club)'), 'an unlinked "Sam" is never merged with Sam\'s account');
  // Totals agree with each trip's own settlement suggestions.
  for (const trip of ledger.trips) for (const transfer of settlements(trip)) {
    const other = transfer.from === trip.members[0].id ? transfer.to : transfer.from;
    const line = people.find(person => person.key === personKey(trip, other))!.byCurrency.find(value => value.currency === trip.currency)!;
    assert(line.owesMeTrips.includes(trip.id) || line.iOweTrips.includes(trip.id));
  }
});
