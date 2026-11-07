import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

/** Migration 0018 (N05): one column, off for everyone, nothing rewritten, older code unaffected. */
const files = (await readdir(new URL('../drizzle/', import.meta.url))).filter(name => name.endsWith('.sql')).sort();
async function apply(until: number) {
  const database = new DatabaseSync(':memory:');
  for (const name of files.filter(name => Number(name.slice(0, 4)) <= until)) database.exec(await readFile(new URL('../drizzle/' + name, import.meta.url), 'utf8'));
  return database;
}

test('0018 is the next migration after 0017 and is in the journal', async () => {
  assert.equal(files.at(-1), '0018_receipt_ready_preference.sql');
  assert.equal(files.at(-2), '0017_receipt_operation_jobs.sql');
  const journal = JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as { entries: Array<{ idx: number; tag: string }> };
  assert.deepEqual(journal.entries.at(-1), { ...journal.entries.at(-1)!, idx: 18, tag: '0018_receipt_ready_preference' });
});

test('0018 leaves every existing preference row unchanged and switches the new option off for all of them', async () => {
  const database = await apply(17);
  const now = '2026-11-07T00:00:00.000Z';
  for (const id of ['quiet', 'chatty', 'no-row']) database.prepare('INSERT INTO profiles(id,email,display_name,created_at) VALUES(?,?,?,?)').run(id, `${id}@example.test`, id, now);
  database.prepare("INSERT INTO notification_preferences(user_id,scope,delivery,reminders) VALUES('quiet','none','none',0)").run();
  database.prepare("INSERT INTO notification_preferences(user_id,scope,delivery,reminders) VALUES('chatty','all','daily',1)").run();
  const before = database.prepare('SELECT user_id,scope,delivery,reminders FROM notification_preferences ORDER BY user_id').all();
  database.exec(await readFile(new URL('../drizzle/0018_receipt_ready_preference.sql', import.meta.url), 'utf8'));
  assert.deepEqual(database.prepare('SELECT user_id,scope,delivery,reminders FROM notification_preferences ORDER BY user_id').all(), before);
  assert.deepEqual(database.prepare('SELECT user_id,receipt_ready FROM notification_preferences ORDER BY user_id').all().map(row => ({ ...row })), [{ user_id: 'chatty', receipt_ready: 0 }, { user_id: 'quiet', receipt_ready: 0 }]);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM notification_preferences WHERE user_id='no-row'").get()!.n, 0, 'no row is invented for an account without one');
});

test('0018 constrains the option to 0 or 1 and defaults new rows to off; code written before 0018 still inserts and updates', async () => {
  const database = await apply(18);
  database.prepare('INSERT INTO profiles(id,email,display_name,created_at) VALUES(?,?,?,?)').run('a', 'a@example.test', 'A', '2026-11-07T00:00:00.000Z');
  database.prepare("INSERT INTO notification_preferences(user_id,scope,delivery,reminders) VALUES('a','all','immediate',1)").run();
  assert.equal(database.prepare("SELECT receipt_ready FROM notification_preferences WHERE user_id='a'").get()!.receipt_ready, 0);
  database.prepare("UPDATE notification_preferences SET scope='involved',delivery='daily',reminders=0 WHERE user_id='a'").run();
  assert.throws(() => database.prepare("UPDATE notification_preferences SET receipt_ready=2 WHERE user_id='a'").run(), /constraint/i);
  database.prepare("UPDATE notification_preferences SET receipt_ready=1 WHERE user_id='a'").run();
  assert.equal(database.prepare("SELECT receipt_ready FROM notification_preferences WHERE user_id='a'").get()!.receipt_ready, 1);
});
