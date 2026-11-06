import assert from 'node:assert/strict';
import test from 'node:test';
import { clearReading, draftFingerprint, markReading, READING_LIMIT_MS, readingState } from '../lib/reading-status';
import type { Draft } from '../lib/model';

function memory() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), removeItem: (key: string) => void values.delete(key), values };
}
const draft: Draft = { id: 'lunch', title: 'Lunch', status: 'waiting', currency: 'GBP', date: '2026-11-06', time: '13:00', timezone: 'Europe/London',
  payer: 'gary', tax: 0, tip: 0, discount: 0, receiptId: 'photo', items: [] };

test('a started reading shows as reading, per account and draft, until the time limit', () => {
  const store = memory(), start = 1_000_000;
  markReading('gary', 'trip', draft, start, store);
  assert.equal(readingState('gary', 'trip', draft, start + 30_000, store), 'reading');
  assert.equal(readingState('sam', 'trip', draft, start + 30_000, store), undefined, 'another account on this browser sees nothing');
  assert.equal(readingState('gary', 'other-trip', draft, start + 30_000, store), undefined);
  assert.equal(readingState('gary', 'trip', { ...draft, id: 'dinner' }, start + 30_000, store), undefined);
  assert.equal(readingState('gary', 'trip', draft, start + READING_LIMIT_MS + 1, store), 'stalled', 'no proposal arrived in time');
});

test('the stored proposal changes the draft, which ends the reading status', () => {
  const store = memory();
  markReading('gary', 'trip', draft, 0, store);
  const read: Draft = { ...draft, status: 'review', items: [{ id: 'soup', name: 'Soup', amount: 450, members: ['gary'] }] };
  assert.equal(readingState('gary', 'trip', read, 10_000, store), undefined);
  assert.equal(readingState('gary', 'trip', read, READING_LIMIT_MS * 2, store), undefined, 'never "stalled" once read');
});

test('clearing and expiry keep storage small; unavailable storage never throws', () => {
  const store = memory();
  markReading('gary', 'trip', draft, 0, store);
  clearReading('gary', 'lunch', store);
  assert.equal(store.values.size, 0, 'the key is removed when nothing is reading');
  markReading('gary', 'trip', draft, 0, store);
  markReading('gary', 'trip', { ...draft, id: 'later' }, READING_LIMIT_MS * 11, store);
  assert.deepEqual(Object.keys(JSON.parse(store.values.get('triptab:reading:gary')!)), ['later'], 'old entries are dropped');
  const broken = { getItem: () => { throw Error('blocked'); }, setItem: () => { throw Error('blocked'); }, removeItem: () => { throw Error('blocked'); } };
  assert.doesNotThrow(() => markReading('gary', 'trip', draft, 0, broken));
  assert.equal(readingState('gary', 'trip', draft, 0, broken), undefined);
  assert.equal(draftFingerprint(draft), draftFingerprint(JSON.parse(JSON.stringify(draft)) as Draft));
});
