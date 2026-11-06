import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

// R11: an identical membership UPDATE advanced the trip revision (0014), so a
// save that rewrote a membership with the same values made other saves look
// like conflicts. 0015 guards the trigger; real changes still advance it.
async function database(through: string) {
  const sqlite = new DatabaseSync(':memory:');
  const files = (await readdir(new URL('../drizzle/', import.meta.url))).filter(name => name.endsWith('.sql')).sort();
  for (const file of files.slice(0, files.indexOf(through) + 1)) sqlite.exec(await readFile(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'));
  sqlite.exec("INSERT INTO profiles (id,email,display_name,created_at) VALUES ('alex','alex@example.test','Alex','2026-11-06'),('sam','sam@example.test','Sam','2026-11-06')");
  for (const id of ['lisbon', 'porto']) sqlite.prepare("INSERT INTO trips (id, owner, data) VALUES (?, 'alex', ?)").run(id, JSON.stringify({ id, name: id, currency: 'GBP', members: [], expenses: [], payments: [], drafts: [] }));
  const revision = (id: string) => Number((sqlite.prepare('SELECT revision FROM trips WHERE id=?').get(id) as { revision: number }).revision);
  return { sqlite, revision };
}
const noOps = [
  "UPDATE memberships SET member_id = member_id WHERE trip_id='lisbon'",
  "UPDATE memberships SET trip_id='lisbon', user_id='sam', member_id='s' WHERE trip_id='lisbon' AND user_id='sam'",
  "INSERT INTO memberships (trip_id,user_id,member_id) VALUES ('lisbon','sam','s') ON CONFLICT(trip_id,user_id) DO UPDATE SET member_id=excluded.member_id",
];

test('R11: before 0015 an identical membership update advanced the revision (the defect)', async () => {
  const { sqlite, revision } = await database('0014_trip_revisions.sql');
  sqlite.exec("INSERT INTO memberships (trip_id,user_id,member_id) VALUES ('lisbon','sam','s')");
  const before = revision('lisbon');
  sqlite.exec(noOps[0]);
  assert.equal(revision('lisbon'), before + 1);
});

test('R11: 0015 keeps insert, delete, change and move bumps, and ignores real no-op updates', async () => {
  const { sqlite, revision } = await database('0015_membership_revision_noop.sql');
  sqlite.exec("INSERT INTO memberships (trip_id,user_id,member_id) VALUES ('lisbon','sam','s')");
  assert.equal(revision('lisbon'), 1, 'insert');
  for (const sql of noOps) { sqlite.exec(sql); assert.equal(revision('lisbon'), 1, sql); }
  assert.equal(revision('porto'), 0);
  sqlite.exec("UPDATE memberships SET member_id='s2' WHERE trip_id='lisbon' AND user_id='sam'");
  assert.equal(revision('lisbon'), 2, 'a changed member link');
  sqlite.exec("UPDATE memberships SET trip_id='porto' WHERE trip_id='lisbon' AND user_id='sam'");
  assert.deepEqual([revision('lisbon'), revision('porto')], [3, 1], 'a move advances both trips');
  sqlite.exec("DELETE FROM memberships WHERE user_id='sam'");
  assert.equal(revision('porto'), 2, 'delete');
  // Unchanged trip data still does not advance it either (0014's own guard).
  sqlite.exec("UPDATE trips SET data=data WHERE id='porto'");
  assert.equal(revision('porto'), 2);
});
