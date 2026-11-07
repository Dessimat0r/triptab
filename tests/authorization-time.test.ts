import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { DB_NOW_MS } from '../lib/receipt-operations';

const clock = DB_NOW_MS.replaceAll("'now'", '?');
const clockArguments = (iso: string) => Array(DB_NOW_MS.split("'now'").length - 1).fill(iso);
const dates = ['2026-11-07T00:00:00.000Z', '2038-01-19T03:14:07.000Z', '2100-03-01T00:00:00.000Z', '1969-12-31T23:59:59.000Z'];

test('R16: the database clock preserves every millisecond without Julian-day truncation', () => {
  const database = new DatabaseSync(':memory:');
  try {
    const statement = database.prepare(`SELECT ${clock} AS milliseconds`);
    for (const date of dates) for (let offset = 0; offset < 1000; offset++) {
      const expected = Date.parse(date) + offset, iso = new Date(expected).toISOString();
      assert.equal(statement.get(...clockArguments(iso))!.milliseconds, expected, iso);
    }
  } finally { database.close(); }
});

test('R16: a grant is refused at the exact database expiry boundary and allowed one millisecond before it', () => {
  const database = new DatabaseSync(':memory:');
  try {
    const statement = database.prepare(`SELECT ? > (${clock}) AS authorized`);
    for (const date of dates) for (let offset = 0; offset < 1000; offset++) {
      const deadline = Date.parse(date) + offset, iso = new Date(deadline).toISOString();
      assert.equal(statement.get(deadline, ...clockArguments(iso))!.authorized, 0, `expired at ${iso}`);
      assert.equal(statement.get(deadline + 1, ...clockArguments(iso))!.authorized, 1, `unexpired at ${iso}`);
    }
  } finally { database.close(); }
});
