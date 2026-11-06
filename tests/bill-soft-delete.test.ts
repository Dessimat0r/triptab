import assert from 'node:assert/strict';
import test from 'node:test';
import { BILL_RESTORE_DAYS, deleteTrip, deletedOwner, listArchivedTrips, listDeletedBills, OPEN_TRIP_IDS, openTripBindings, purgeDeletedBill,
  purgeExpiredDeletedBills, restoreDeletedBill, setTripArchived } from '../lib/trip-lifecycle';
import type { Trip } from '../lib/model';
import { storage } from './helpers/sqlite-d1';

// F-14, owner decision A: a deleted bill is hidden, can be restored with its
// photos for 30 days, then is removed for good.
const gary = { id: 'gary', displayName: 'Gary' }, mallory = { id: 'mallory', displayName: 'Mallory' };
const dinner: Trip = { id: 'dinner', kind: 'bill', name: 'Dinner', currency: 'GBP',
  members: [{ id: 'd-gary', name: 'Gary', userId: 'gary' }, { id: 'd-sam', name: 'Sam' }],
  expenses: [{ id: 'meal', title: 'Meal', date: '2026-11-06', time: '20:00', timezone: 'Europe/London', currency: 'GBP', payer: 'd-gary', tax: 0, tip: 0, discount: 0,
    receiptId: 'photo', items: [{ id: 'food', name: 'Food', amount: 4000, members: ['d-gary', 'd-sam'] }] }], payments: [], drafts: [] };
const DAY = 24 * 60 * 60 * 1000;
// The owner-or-member rule used by history, receipts, invites, reminders,
// exports and language settings (as lib/trip-language-preferences.ts).
const accessibleTripSql = 'EXISTS (SELECT 1 FROM trips t WHERE t.id = ? AND (t.owner = ? OR EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = t.id AND m.user_id = ?)))';

async function seeded() {
  const database = await storage();
  for (const [id, name] of [['gary', 'Gary'], ['mallory', 'Mallory']]) {
    database.sqlite.prepare('INSERT INTO profiles (id,email,display_name,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.test`, name, '2026-11-06');
  }
  database.sqlite.prepare('INSERT INTO trips(id,owner,data) VALUES(?,?,?)').run(dinner.id, 'gary', JSON.stringify(dinner));
  database.sqlite.prepare('INSERT INTO memberships (trip_id,user_id,member_id) VALUES (?,?,?)').run('dinner', 'gary', 'd-gary');
  database.sqlite.prepare(`INSERT INTO receipts (id,owner,trip_id,created_at,state,content_type,size_bytes,sha256) VALUES ('photo','gary','dinner','2026-11-06','active','image/jpeg',10,'x')`).run();
  database.sqlite.prepare(`INSERT INTO invites (token_hash,trip_id,member_id,email,expires_at,created_by) VALUES ('t','dinner','d-sam','sam@example.test','2026-11-13','gary')`).run();
  return database;
}
const open = (database: Awaited<ReturnType<typeof storage>>, user: string) =>
  (database.sqlite.prepare(OPEN_TRIP_IDS).all(...openTripBindings(user)) as { id?: string; trip_id?: string }[]).map(row => row.id ?? row.trip_id);
const canOpen = (database: Awaited<ReturnType<typeof storage>>, user: string) =>
  !!database.sqlite.prepare(`SELECT 1 AS ok WHERE ${accessibleTripSql}`).get('dinner', user, user);
const stored = (database: Awaited<ReturnType<typeof storage>>) => database.sqlite.prepare("SELECT owner, data FROM trips WHERE id = 'dinner'").get() as { owner: string; data: string } | undefined;

test('deleting a bill with entries hides it from every owner-or-member check and keeps its photo', async () => {
  const database = await seeded();
  const result = await deleteTrip(database.asD1(), gary, 'dinner', 'Dinner');
  assert.equal(result.restorable, true);
  assert.equal(stored(database)!.owner, deletedOwner('gary'));
  assert.deepEqual(open(database, 'gary'), [], 'not in the ledger');
  assert.equal(canOpen(database, 'gary'), false, 'history, receipts and language settings all use this access rule');
  assert.deepEqual(await listArchivedTrips(database.asD1(), 'gary'), [], 'not in Archived holidays');
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM invites WHERE trip_id='dinner'").get()!.n, 0, 'pending invitations are withdrawn');
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM receipts WHERE trip_id='dinner'").get()!.n, 1, 'the photo is kept');
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS n FROM receipt_object_purges').get()!.n, 0, 'nothing is queued for removal yet');
  const [listed] = await listDeletedBills(database.asD1(), 'gary');
  assert.equal(listed.name, 'Dinner');
  assert.equal(Date.parse(listed.restoreUntil) - Date.parse(listed.deletedAt), BILL_RESTORE_DAYS * DAY);
  assert.deepEqual(await listDeletedBills(database.asD1(), 'mallory'), []);
});

test('restore puts the same bill back: entries, owner link, photo and its place in the list', async () => {
  const database = await seeded();
  const before = stored(database)!.data;
  await deleteTrip(database.asD1(), gary, 'dinner', 'Dinner');
  await assert.rejects(restoreDeletedBill(database.asD1(), mallory, 'dinner'), /can no longer be restored/);
  await restoreDeletedBill(database.asD1(), gary, 'dinner');
  assert.equal(stored(database)!.owner, 'gary');
  assert.deepEqual(JSON.parse(stored(database)!.data), JSON.parse(before), 'exactly the data that was deleted');
  assert.deepEqual(open(database, 'gary'), ['dinner']);
  assert.deepEqual(database.sqlite.prepare("SELECT user_id, member_id FROM memberships WHERE trip_id='dinner'").all().map(row => ({ ...row })), [{ user_id: 'gary', member_id: 'd-gary' }]);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM receipts WHERE trip_id='dinner' AND state='active'").get()!.n, 1);
  const events = database.sqlite.prepare("SELECT action FROM activity_events WHERE trip_id='dinner' AND entity_type='trip' ORDER BY sequence").all().map(row => row.action);
  assert.deepEqual(events, ['delete', 'create'], 'History records the deletion and the restore');
  assert.deepEqual(await listDeletedBills(database.asD1(), 'gary'), []);
});

test('after 30 days the bill can no longer be restored and maintenance removes it with its photo', async () => {
  const database = await seeded();
  await deleteTrip(database.asD1(), gary, 'dinner', 'Dinner');
  const deletedAt = Date.parse(JSON.parse(stored(database)!.data).deletion.at);
  assert.deepEqual(await purgeExpiredDeletedBills(database.asD1(), { now: deletedAt + 29 * DAY }), { purged: 0 });
  assert.ok(stored(database), 'kept within the window');
  await assert.rejects(restoreDeletedBill(database.asD1(), gary, 'dinner', deletedAt + 31 * DAY), /restored for 30 days/);
  assert.deepEqual(await listDeletedBills(database.asD1(), 'gary', deletedAt + 31 * DAY), []);
  assert.deepEqual(await purgeExpiredDeletedBills(database.asD1(), { now: deletedAt + 31 * DAY }), { purged: 1 });
  assert.equal(stored(database), undefined);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM receipts WHERE trip_id='dinner'").get()!.n, 0);
  assert.deepEqual(database.sqlite.prepare('SELECT receipt_id, owner FROM receipt_object_purges').all().map(row => ({ ...row })), [{ receipt_id: 'photo', owner: 'gary' }], 'the image is queued for deletion');
});

test('the owner can remove a deleted bill for good at once; nobody else can', async () => {
  const database = await seeded();
  await deleteTrip(database.asD1(), gary, 'dinner', 'Dinner');
  await assert.rejects(purgeDeletedBill(database.asD1(), mallory, 'dinner'), /already removed/);
  assert.ok(stored(database));
  await purgeDeletedBill(database.asD1(), gary, 'dinner');
  assert.equal(stored(database), undefined);
  await assert.rejects(restoreDeletedBill(database.asD1(), gary, 'dinner'), /can no longer be restored/);
});

test('a deleted bill cannot be archived, restored as an archive, or reached by its old owner', async () => {
  const database = await seeded();
  await deleteTrip(database.asD1(), gary, 'dinner', 'Dinner');
  await assert.rejects(setTripArchived(database.asD1(), gary, 'dinner', true), /do not have access/);
  await assert.rejects(setTripArchived(database.asD1(), gary, 'dinner', false), /do not have access/);
  await assert.rejects(deleteTrip(database.asD1(), gary, 'dinner', 'Dinner'), /Only the bill owner/);
});

test('holidays are still deleted at once (typing the name), as before', async () => {
  const database = await seeded();
  const holiday = { ...dinner, id: 'lisbon', kind: undefined, name: 'Lisbon', expenses: [] };
  database.sqlite.prepare('INSERT INTO trips(id,owner,data) VALUES(?,?,?)').run(holiday.id, 'gary', JSON.stringify(holiday));
  const result = await deleteTrip(database.asD1(), gary, 'lisbon', 'Lisbon');
  assert.equal(result.restorable, false);
  assert.equal(database.sqlite.prepare("SELECT 1 FROM trips WHERE id='lisbon'").get(), undefined);
});
