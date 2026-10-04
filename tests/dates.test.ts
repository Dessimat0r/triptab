import assert from 'node:assert/strict';
import test from 'node:test';
import { localDate, localTime, localTimestamp, validCalendarDate } from '../lib/dates';

test('local date and time stay on the transaction day on both sides of UTC midnight', () => {
  const evening = new Date('2026-10-05T03:30:00Z');
  assert.equal(localDate(evening, 'America/Los_Angeles'), '2026-10-04');
  assert.equal(localTime(evening, 'America/Los_Angeles'), '20:30');
  assert.equal(localTimestamp(evening, 'America/Los_Angeles'), '2026-10-04T20:30');
  const morning = new Date('2026-10-03T22:15:00Z');
  assert.equal(localDate(morning, 'Europe/Vienna'), '2026-10-04');
  assert.equal(localTime(morning, 'Europe/Vienna'), '00:15');
  assert.equal(localDate(morning, 'Asia/Tokyo'), '2026-10-04');
  assert.equal(localTime(morning, 'Asia/Tokyo'), '07:15');
});

test('default dates use device calendar components rather than UTC components', () => {
  const previousTimezone = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles';
    const date = new Date('2026-10-05T03:30:00Z');
    assert.equal(localDate(date), '2026-10-04');
    assert.equal(localTime(date), '20:30');
    assert.ok(`${localDate(date)}T${localTime(date)}` <= localTimestamp(date, 'America/Los_Angeles'));
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

test('timezone formatting respects DST and does not emit 24:00 at midnight', () => {
  assert.equal(localTimestamp(new Date('2026-10-25T00:30:00Z'), 'Europe/Vienna'), '2026-10-25T02:30');
  assert.equal(localTimestamp(new Date('2026-10-25T01:30:00Z'), 'Europe/Vienna'), '2026-10-25T02:30');
  assert.equal(localTimestamp(new Date('2026-10-03T22:00:00Z'), 'Europe/Vienna'), '2026-10-04T00:00');
  assert.throws(() => localDate(new Date('invalid')));
  assert.throws(() => localTime(new Date(), 'Imaginary/Zone'));
});

test('calendar-date validation accepts leap days and rejects impossible or ambiguous input', () => {
  for (const date of ['2024-02-29', '2026-10-04', '1999-01-04']) assert.equal(validCalendarDate(date), true);
  for (const date of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-00-01', '26-10-04', '04/10/2026', '2026-10-04T00:00']) {
    assert.equal(validCalendarDate(date), false);
  }
});
