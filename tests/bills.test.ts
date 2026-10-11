import assert from 'node:assert/strict';
import test from 'node:test';
import { balances, settlements, validateLedger, parseStoredTrip, type Trip } from '../lib/model';
import { deleteTrip, discardEmptyBill, listArchivedTrips, TripLifecycleError } from '../lib/trip-lifecycle';
import { storage } from './helpers/sqlite-d1';
const base: Trip = { id: 'bill', kind: 'bill', name: 'Dinner', currency: 'GBP', members: [{ id: 'alex', name: 'Alex' }, { id: 'sam', name: 'Sam' }], expenses: [], payments: [], drafts: [] };

test('absent kind round-trips without adding a default discriminator', () => {
  const holiday = { ...base }; delete holiday.kind;
  assert.deepEqual(validateLedger({ trips: [holiday] }), { trips: [holiday] });
  assert.deepEqual(parseStoredTrip(JSON.parse(JSON.stringify(holiday))), holiday);
});
test('bills reject holiday planning and more than twenty people', () => {
  for (const changes of [{ startDate: '2026-10-10' }, { endDate: '2026-10-10' }, { budget: 100 }]) assert.throws(() => validateLedger({ trips: [{ ...base, ...changes }] }), /Bills don’t have dates or a budget/);
  for (const changes of [{ joinedOn: '2026-10-10' }, { leftOn: '2026-10-10' }, { weight: 1 }]) assert.throws(() => validateLedger({ trips: [{ ...base, members: [{ ...base.members[0], ...changes }] }] }), /Bills don’t track traveller dates or family weights/);
  assert.throws(() => validateLedger({ trips: [{ ...base, members: Array.from({ length: 21 }, (_, i) => ({ id: `m${i}`, name: `Person ${i}` })) }] }), /up to 20 people/);
  const old = { ...base, startDate: '2026-10-10' };
  assert.equal(parseStoredTrip(old).startDate, old.startDate);
  validateLedger({ trips: [old] }, { previous: { trips: [old] } });
  assert.throws(() => validateLedger({ trips: [{ ...old, name: 'Changed' }] }, { previous: { trips: [old] } }), /Bills don’t have dates/);
});
test('twenty seeded mixed split ledgers give identical holiday and bill balances and settlements', () => {
  let seed = 0x515babe;
  const random = (limit: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
  for (let iteration = 0; iteration < 20; iteration++) {
    const members = Array.from({ length: 2 + random(19) }, (_, i) => ({ id: `m${i}`, name: `Person ${i}` }));
    const ids = members.map(member => member.id);
    const expenses = Array.from({ length: 1 + random(8) }, (_, i) => ({ id: `e${i}`, title: 'Food', date: '2026-10-10', time: '19:00', timezone: 'Europe/London', payer: ids[random(ids.length)], currency: i % 2 ? 'EUR' as const : 'GBP' as const, ...(i % 2 ? { fx: { rate: 0.85, asOf: '2026-10-10', source: 'manual' as const } } : {}), items: [{ id: `line${i}`, name: 'Food', amount: 500 + random(50000), members: random(2) ? ids : [ids[random(ids.length)]], ...(i % 3 === 0 ? { percentages: { [ids[0]]: 33.33, [ids[1]]: 66.67 }, members: ids.slice(0, 2) } : {}) }], tax: random(200), tip: random(200), discount: random(100) }));
    const holiday = validateLedger({ trips: [{ ...base, kind: undefined, members, expenses, payments: [{ id: 'payment', from: ids[0], to: ids[1], amount: 100 + random(500), date: '2026-10-10' }] }] }).trips[0];
    const bill = validateLedger({ trips: [{ ...holiday, kind: 'bill' }] }).trips[0];
    assert.deepEqual(balances(bill), balances(holiday)); assert.deepEqual(settlements(bill), settlements(holiday));
  }
});
async function seeded(value = base) {
  const db = await storage();
  db.sqlite.prepare('INSERT INTO profiles (id,email,display_name,created_at) VALUES (?,?,?,?)').run('owner', 'owner@example.test', 'Alex', '2026-10-10');
  db.sqlite.prepare('INSERT INTO profiles (id,email,display_name,created_at) VALUES (?,?,?,?)').run('other', 'other@example.test', 'Sam', '2026-10-10');
  db.sqlite.prepare('INSERT INTO trips(id,owner,data) VALUES(?,?,?)').run(value.id, 'owner', JSON.stringify(value));
  return db;
}
const actor = { id: 'owner', displayName: 'Alex' };
const conflict = (error: unknown) => error instanceof TripLifecycleError && error.status === 409;
test('discard deletes only an empty unshared owner bill, queues photos and retains history', async () => {
  const db = await seeded();
  db.sqlite.prepare('INSERT INTO receipts(id,owner,trip_id,created_at) VALUES(?,?,?,?)').run('photo', actor.id, base.id, '2026-10-10');
  await discardEmptyBill(db.asD1(), actor, base.id);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM trips').get()?.n, 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM receipt_object_purges').get()?.n, 1);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM activity_events WHERE action='delete'").get()?.n, 1);
});
test('discard rejects holidays, entries, a different actor and another joined account', async () => {
  for (const value of [{ ...base, kind: undefined }, { ...base, payments: [{ id: 'p', from: 'sam', to: 'alex', amount: 100, date: '2026-10-10' }] }, { ...base, expenses: [{ id: 'e' }] as Trip['expenses'] }, { ...base, drafts: [{ id: 'd' }] as Trip['drafts'] }]) {
    const db = await seeded(value); await assert.rejects(discardEmptyBill(db.asD1(), actor, base.id), conflict); assert.ok(db.sqlite.prepare('SELECT 1 FROM trips').get());
  }
  const db = await seeded(); await assert.rejects(discardEmptyBill(db.asD1(), { id: 'other', displayName: 'Sam' }, base.id), (error: unknown) => error instanceof TripLifecycleError && error.status === 403);
  db.sqlite.prepare('INSERT INTO memberships(trip_id,user_id,member_id) VALUES(?,?,?)').run(base.id, 'other', 'sam');
  await assert.rejects(discardEmptyBill(db.asD1(), actor, base.id), conflict);
});
test('a save or account join between discard read and commit wins', async () => {
  for (const join of [false, true]) {
    const db = await seeded();
    db.beforeBatch = () => { db.beforeBatch = undefined; if (join) db.sqlite.prepare('INSERT INTO memberships(trip_id,user_id,member_id) VALUES(?,?,?)').run(base.id, 'other', 'sam'); else db.sqlite.prepare('UPDATE trips SET data=? WHERE id=?').run(JSON.stringify({ ...base, payments: [{ id: 'p', from: 'sam', to: 'alex', amount: 100, date: '2026-10-10' }] }), base.id); };
    await assert.rejects(discardEmptyBill(db.asD1(), actor, base.id), conflict); assert.ok(db.sqlite.prepare('SELECT 1 FROM trips').get()); assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM activity_events').get()?.n, 0);
  }
});
test('archived summaries preserve bill kind without rewriting old holiday summaries', async () => {
  const db = await seeded(); db.sqlite.prepare('INSERT INTO trip_archives(user_id,trip_id,archived_at) VALUES(?,?,?)').run(actor.id, base.id, '2026-10-10');
  assert.equal((await listArchivedTrips(db.asD1(), actor.id))[0].kind, 'bill');
});

test('first receipt defaults adopt currency and title together, preserving explicit choices', async () => {
  const { firstBillExpense } = await import('../lib/bills');
  const expense: Trip['expenses'][number] = { id: 'e', title: 'Restaurant', currency: 'EUR', payer: 'alex', date: '2026-10-10', time: '19:00', timezone: 'Europe/London', items: [{ id: 'i', name: 'Food', amount: 1200, members: ['alex','sam'] }], tax: 0, tip: 0, discount: 0, fx: { rate: 0.85, asOf: '2026-10-10', source: 'reference' }, bankAmount: 1000 };
  const defaults = { tripId: base.id, name: true, currency: true, previousTripId: '' };
  const adopted = firstBillExpense(base, expense, defaults);
  assert.equal(adopted.trip.name, expense.title); assert.equal(adopted.trip.currency, 'EUR'); assert.equal(adopted.expense.fx, undefined); assert.equal(adopted.expense.bankAmount, undefined);
  const explicit = firstBillExpense(base, expense, { ...defaults, name: false, currency: false });
  assert.deepEqual(explicit, { trip: base, expense });
  assert.deepEqual(firstBillExpense({ ...base, expenses: [expense] }, expense, defaults).trip.currency, 'GBP');
});

test('a holiday delete loses to a save that lands between its read and commit', async () => {
  const holiday: Trip = { ...base, kind: undefined, name: 'Trip' };
  const db = await seeded(holiday);
  db.beforeBatch = () => { db.beforeBatch = undefined; db.sqlite.prepare('UPDATE trips SET data=? WHERE id=?').run(JSON.stringify({ ...holiday, name: 'Trip 2' }), holiday.id); };
  await assert.rejects(deleteTrip(db.asD1(), actor, holiday.id, 'Trip'), conflict);
  assert.ok(db.sqlite.prepare('SELECT 1 FROM trips').get());
});
