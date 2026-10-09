import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCalendarDate, formatInstant, formatInstantDay, formatClockTime } from '../lib/dates';
test('calendar dates remain on the saved day in extreme viewer zones', () => {
  const previous = process.env.TZ;
  try { for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) { process.env.TZ = zone; assert.equal(formatCalendarDate('2026-07-28'), '28 Jul 2026'); } }
  finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  assert.equal(formatCalendarDate('2026-02-30'), 'Invalid date');
  assert.equal(formatCalendarDate('bad'), 'Invalid date');
});
test('instant displays follow the viewer zone and reject invalid input', () => {
  assert.match(formatInstant('2026-07-28T00:30:00Z', { timeZone: 'Pacific/Pago_Pago' }), /27 Jul 2026/);
  assert.match(formatInstantDay('2026-07-28T00:30:00Z', { timeZone: 'Pacific/Kiritimati' }), /28 Jul 2026/);
  assert.equal(formatClockTime('2026-07-28T00:30:00Z', { timeZone: 'UTC' }), '00:30');
  for (const format of [formatInstant, formatInstantDay, formatClockTime]) assert.equal(format('bad'), 'Date unavailable');
});
