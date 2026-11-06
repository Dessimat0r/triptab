import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

// F-16: migration 0014 on a database that already holds trips, memberships and
// receipts. Data is unchanged; every trip starts at revision 0; afterwards
// every kind of change advances it, and the 0009 receipt-link triggers still run.
test('0014 upgrades existing data without changing it, then tracks every change', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const files = (await readdir(new URL('../drizzle/', import.meta.url))).filter(name => name.endsWith('.sql')).sort();
  // Later migrations (0015 onwards) are applied by their own tests.
  for (const file of files.slice(0, files.indexOf('0014_trip_revisions.sql'))) sqlite.exec(await readFile(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'));
  const data = JSON.stringify({ id: 'lisbon', name: 'Lisbon', currency: 'GBP', members: [{ id: 'a', name: 'Alex' }], expenses: [{ id: 'e1', receiptId: 'r1', items: [] }], payments: [], drafts: [] });
  sqlite.prepare("INSERT INTO profiles (id,email,display_name,created_at) VALUES ('alex','alex@example.test','Alex','2026-11-06')").run();
  sqlite.prepare("INSERT INTO trips (id, owner, data) VALUES ('lisbon', 'alex', ?)").run(data);
  sqlite.prepare("INSERT INTO memberships (trip_id, user_id, member_id) VALUES ('lisbon', 'alex', 'a')").run();
  const linkVersion = (sqlite.prepare("SELECT receipt_link_version AS v FROM trips WHERE id='lisbon'").get() as { v: number }).v;

  sqlite.exec(await readFile(new URL('../drizzle/0014_trip_revisions.sql', import.meta.url), 'utf8'));
  const row = () => sqlite.prepare("SELECT data, revision, receipt_link_version AS v FROM trips WHERE id='lisbon'").get() as { data: string; revision: number; v: number };
  assert.deepEqual({ ...row() }, { data, revision: 0, v: linkVersion }, 'existing data and the receipt-link version are untouched');
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM memberships").get()!.n, 1);

  sqlite.prepare("UPDATE trips SET data = json_set(data, '$.name', 'Porto') WHERE id='lisbon'").run();
  assert.equal(row().revision, 1);
  assert.equal(row().v, linkVersion + 1, 'the 0009 projection trigger still advances its own version');
  sqlite.prepare("DELETE FROM memberships WHERE trip_id='lisbon'").run();
  assert.equal(row().revision, 2);
  sqlite.prepare("DELETE FROM trips WHERE id='lisbon'").run();
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM trips').get()!.n, 0, 'deleting a trip with the triggers present still works');
});
