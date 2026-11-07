import assert from 'node:assert/strict';
import test from 'node:test';
import { addConnectedMember, leaveTrip, listArchivedTripData, listConnections, OPEN_TRIP_IDS, openTripBindings, setTripArchived } from '../lib/trip-lifecycle';
import type { Trip } from '../lib/model';
import { storage } from './helpers/sqlite-d1';

const gary = { id: 'gary', displayName: 'Gary' }, sam = { id: 'sam', displayName: 'Sam' }, mallory = { id: 'mallory', displayName: 'Mallory' };
const holiday: Trip = { id: 'holiday', name: 'Lisbon', currency: 'GBP', members: [{ id: 'h-gary', name: 'Gary', userId: 'gary' }, { id: 'h-sam', name: 'Sam', userId: 'sam' }], expenses: [], payments: [], drafts: [] };
const taxi: Trip = { id: 'taxi', kind: 'bill', name: 'Taxi', currency: 'GBP', members: [{ id: 't-gary', name: 'Gary', userId: 'gary' }, { id: 't-sam', name: 'Sam' }],
  expenses: [{ id: 'ride', title: 'Taxi', date: '2026-11-06', time: '22:00', timezone: 'Europe/London', currency: 'GBP', payer: 't-gary', tax: 0, tip: 0, discount: 0,
    items: [{ id: 'fare', name: 'Taxi', amount: 3000, members: ['t-gary', 't-sam'] }] }], payments: [], drafts: [] };
const privateBill: Trip = { ...taxi, id: 'private', name: 'Private', members: [{ id: 'p-gary', name: 'Gary', userId: 'gary' }, { id: 'p-other', name: 'Sam' }], expenses: [] };

async function seeded() {
  const database = await storage();
  for (const [id, name] of [['gary', 'Gary'], ['sam', 'Sam'], ['mallory', 'Mallory']]) {
    database.sqlite.prepare('INSERT INTO profiles (id,email,display_name,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.test`, name, '2026-11-06');
  }
  for (const trip of [holiday, taxi, privateBill]) database.sqlite.prepare('INSERT INTO trips(id,owner,data) VALUES(?,?,?)').run(trip.id, 'gary', JSON.stringify(trip));
  database.sqlite.prepare('INSERT INTO memberships (trip_id,user_id,member_id) VALUES (?,?,?)').run('holiday', 'sam', 'h-sam');
  return database;
}
const open = (database: Awaited<ReturnType<typeof storage>>, user: string) =>
  (database.sqlite.prepare(OPEN_TRIP_IDS).all(...openTripBindings(user)) as { id?: string; trip_id?: string }[]).map(row => row.id ?? row.trip_id).sort();

test('F-04: connections come only from shared trips and expose names, never emails', async () => {
  const database = await seeded();
  assert.deepEqual(await listConnections(database.asD1(), 'gary'), [{ id: 'sam', name: 'Sam' }]);
  assert.deepEqual(await listConnections(database.asD1(), 'sam'), [{ id: 'gary', name: 'Gary' }]);
  assert.deepEqual(await listConnections(database.asD1(), 'mallory'), []);
  assert.doesNotMatch(JSON.stringify(await listConnections(database.asD1(), 'gary')), /@/);
});

test('F-04 acceptance: Gary adds Sam to a new taxi bill; Sam sees that bill only, and can leave it', async () => {
  const database = await seeded();
  assert.deepEqual(open(database, 'sam'), ['holiday']);
  const result = await addConnectedMember(database.asD1(), gary, 'taxi', 't-sam', 'sam');
  assert.equal(result.memberId, 't-sam');
  assert.deepEqual(open(database, 'sam'), ['holiday', 'taxi'], 'the taxi bill is now in Sam\'s list; the private bill is not');
  const stored = JSON.parse((database.sqlite.prepare('SELECT data FROM trips WHERE id = ?').get('taxi') as { data: string }).data) as Trip;
  assert.equal(stored.members.find(member => member.id === 't-sam')?.userId, 'sam');
  assert.equal(stored.members.find(member => member.id === 't-sam')?.email, undefined, 'no email is copied to the other members');
  assert.equal(stored.expenses[0].items[0].amount, 3000, 'money is untouched');
  const event = database.sqlite.prepare("SELECT entity_type, entity_id FROM activity_events WHERE trip_id = 'taxi' ORDER BY rowid DESC LIMIT 1").get() as { entity_type: string; entity_id: string };
  assert.deepEqual({ ...event }, { entity_type: 'member', entity_id: 't-sam' }, 'the link is in the bill\'s history');
  // Leaving keeps the person, their share and the expense; only the account link goes.
  await leaveTrip(database.asD1(), sam, 'taxi');
  assert.deepEqual(open(database, 'sam'), ['holiday']);
  const after = JSON.parse((database.sqlite.prepare('SELECT data FROM trips WHERE id = ?').get('taxi') as { data: string }).data) as Trip;
  assert.equal(after.members.find(member => member.id === 't-sam')?.userId, undefined);
  assert.equal(after.expenses.length, 1);
});

test('F-04: unconnected accounts, holidays, guessed IDs and repeats are refused and change nothing', async () => {
  const database = await seeded();
  const snapshot = () => JSON.stringify(['trips', 'memberships', 'activity_events'].map(table => database.sqlite.prepare(`SELECT * FROM ${table}`).all()));
  const before = snapshot();
  await assert.rejects(addConnectedMember(database.asD1(), gary, 'taxi', 't-sam', 'mallory'), /share a holiday or bill/);
  await assert.rejects(addConnectedMember(database.asD1(), gary, 'holiday', 'h-sam', 'sam'), /only to bills/);
  await assert.rejects(addConnectedMember(database.asD1(), mallory, 'taxi', 't-sam', 'mallory'), /already on this bill|not found/);
  await assert.rejects(addConnectedMember(database.asD1(), mallory, 'taxi', 't-sam', 'gary'), /not found/, 'no access to the bill');
  await assert.rejects(addConnectedMember(database.asD1(), gary, 'guessed', 't-sam', 'sam'), /not found/);
  await assert.rejects(addConnectedMember(database.asD1(), gary, 'taxi', 'nobody', 'sam'), /no longer on this bill/);
  assert.equal(snapshot(), before);
  await addConnectedMember(database.asD1(), gary, 'taxi', 't-sam', 'sam');
  await assert.rejects(addConnectedMember(database.asD1(), gary, 'taxi', 't-sam', 'sam'), /already on it/);
  await assert.rejects(addConnectedMember(database.asD1(), gary, 'taxi', 't-gary', 'sam'), /already on it/);
  // Joining one bill does not make Sam a connection route to Gary's private bill.
  await assert.rejects(addConnectedMember(database.asD1(), sam, 'private', 'p-other', 'sam'), /already on this bill|not found/);
  assert.deepEqual(open(database, 'sam'), ['holiday', 'taxi']);
});

test('F-05: archived trips for Activity are the account\'s own archive only, with account links and no emails', async () => {
  const database = await seeded();
  assert.deepEqual(await listArchivedTripData(database.asD1(), 'gary'), []);
  await setTripArchived(database.asD1(), gary, 'holiday', true);
  await setTripArchived(database.asD1(), gary, 'private', true);
  const garys = await listArchivedTripData(database.asD1(), 'gary');
  assert.deepEqual(garys.map(trip => trip.id), ['holiday', 'private']);
  const lisbon = garys.find(trip => trip.id === 'holiday')!;
  assert.equal(lisbon.ownerId, 'gary');
  assert.deepEqual(lisbon.members.map(member => member.userId), ['gary', 'sam'], 'links come from ownership and memberships');
  assert.doesNotMatch(JSON.stringify(garys), /@/);
  // Sam can open the holiday but has not archived it; Gary's archive is not his.
  assert.deepEqual(await listArchivedTripData(database.asD1(), 'sam'), []);
  // Mallory has no access to anything, archived or not.
  database.sqlite.prepare('INSERT INTO trip_archives (user_id, trip_id, archived_at) VALUES (?,?,?)').run('mallory', 'private', '2026-11-06');
  assert.deepEqual(await listArchivedTripData(database.asD1(), 'mallory'), [], 'an archive row alone never grants access');
  // After Sam archives then leaves, the holiday is no longer readable by him.
  await setTripArchived(database.asD1(), sam, 'holiday', true);
  assert.deepEqual((await listArchivedTripData(database.asD1(), 'sam')).map(trip => trip.id), ['holiday']);
  await leaveTrip(database.asD1(), sam, 'holiday');
  assert.deepEqual(await listArchivedTripData(database.asD1(), 'sam'), []);
});
