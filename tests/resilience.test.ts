import assert from 'node:assert/strict';
import test from 'node:test';
import { findLikelyDuplicates } from '../lib/duplicates';
import { calculationHealth } from '../lib/calculation-health';
import { clearUnsavedEntry, readUnsavedEntry, writeUnsavedEntry } from '../lib/unsaved-entry';
import { validateLedger, type Expense, type Trip } from '../lib/model';

const members = [{ id: 'a', name: 'Alice' }, { id: 'b', name: 'Bob' }];
const entry = (id: string, title: string, amount: number, overrides: Partial<Expense> = {}): Expense => ({ id, title, date: '2026-11-06', time: '19:00', timezone: 'Europe/London',
  currency: 'GBP', payer: 'a', tax: 0, tip: 0, discount: 0, items: [{ id: `${id}-i`, name: title, amount, members: ['a', 'b'] }], ...overrides });
const trip = (expenses: Expense[]): Trip => ({ id: 't', name: 'Trip', currency: 'GBP', members, expenses, drafts: [], payments: [] });

test('F-09: the same restaurant bill entered twice is flagged; different days, amounts and names are not', () => {
  const saved = trip([entry('one', 'Pizza Express', 4520, { payer: 'b' })]);
  assert.deepEqual(findLikelyDuplicates(saved, entry('two', 'PIZZA EXPRESS!', 4520)).map(match => match.id), ['one']);
  assert.deepEqual(findLikelyDuplicates(saved, entry('two', 'Pizza Express Soho', 4540)).map(match => match.id), ['one'], 'within 1% and a contained name');
  assert.deepEqual(findLikelyDuplicates(saved, entry('two', 'Pizza Express', 4520, { date: '2026-11-07' })), [], 'different day');
  assert.deepEqual(findLikelyDuplicates(saved, entry('two', 'Pizza Express', 5200)), [], 'different amount');
  assert.deepEqual(findLikelyDuplicates(saved, entry('two', 'Taxi', 4520)), [], 'same total, unrelated name');
  assert.deepEqual(findLikelyDuplicates(saved, entry('one', 'Pizza Express', 4520)), [], 'editing the entry itself');
  // A second scan of one receipt matches on the printed total even if names differ.
  const scanned = trip([entry('scan1', 'Tesco Express', 450, { receiptScan: { version: 1, printedTotal: 450, status: 'matched', warnings: [] } })]);
  assert.equal(findLikelyDuplicates(scanned, entry('scan2', 'Groceries', 450, { receiptScan: { version: 1, printedTotal: 450, status: 'matched', warnings: [] } })).length, 1);
});

test('F-20: a broken legacy expense is named; the rest still totals, marked incomplete', () => {
  const valid = validateLedger({ trips: [trip([entry('ok', 'Dinner', 2000), entry('ok2', 'Lunch', 1000)])] }).trips[0];
  const broken = { ...valid, expenses: [...valid.expenses, { ...entry('bad', 'Old receipt', 500), currency: 'EUR' as const }] };
  const health = calculationHealth(broken);
  assert.deepEqual(health.failing.map(value => value.id), ['bad']);
  assert.match(health.failing[0].message, /exchange rate|bank charge/);
  assert.equal(health.partialSpent, 3000);
  assert.deepEqual(calculationHealth(valid).failing, []);
});

test('F-18: unsaved entries are kept per account and trip, and storage failures never throw', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); }, removeItem: (k: string) => { values.delete(k); } } as unknown as Storage;
  writeUnsavedEntry(storage, 'gary', 't', { id: 'draft-1', title: 'Coffee' }, new Date('2026-11-06T10:00:00Z'));
  assert.deepEqual(readUnsavedEntry(storage, 'gary', 't'), { savedAt: '2026-11-06T10:00:00.000Z', entry: { id: 'draft-1', title: 'Coffee' } });
  assert.equal(readUnsavedEntry(storage, 'sam', 't'), null, 'another account on the same device sees nothing');
  assert.equal(readUnsavedEntry(storage, 'gary', 'other'), null);
  clearUnsavedEntry(storage, 'gary', 't');
  assert.equal(readUnsavedEntry(storage, 'gary', 't'), null);
  const broken = { getItem() { throw Error('blocked'); }, setItem() { throw Error('full'); }, removeItem() { throw Error('blocked'); } } as unknown as Storage;
  assert.doesNotThrow(() => writeUnsavedEntry(broken, 'gary', 't', { id: 'x' }));
  assert.equal(readUnsavedEntry(broken, 'gary', 't'), null);
  assert.doesNotThrow(() => clearUnsavedEntry(broken, 'gary', 't'));
  values.set('triptab:unsaved-entry:v1:gary:t', '{not json');
  assert.equal(readUnsavedEntry(storage, 'gary', 't'), null);
});

test('F-17: bills have their own limit, so many bills do not block holidays; messages are friendly', async () => {
  const { MAX_OPEN_BILLS, MAX_OPEN_HOLIDAYS } = await import('../lib/model');
  const bill = (index: number): Trip => ({ id: `b${index}`, kind: 'bill', name: `Bill ${index}`, currency: 'GBP', members, expenses: [], drafts: [], payments: [] });
  const holiday = (index: number): Trip => ({ id: `h${index}`, name: `Holiday ${index}`, currency: 'GBP', members, expenses: [], drafts: [], payments: [] });
  const full = [...Array.from({ length: MAX_OPEN_BILLS }, (_, i) => bill(i)), ...Array.from({ length: MAX_OPEN_HOLIDAYS }, (_, i) => holiday(i))];
  assert.equal(validateLedger({ trips: full }).trips.length, 150, '100 bills and 50 holidays are both allowed');
  assert.throws(() => validateLedger({ trips: [...full, bill(999)] }), /100 open bills.*Remove a settled bill from your list/);
  assert.throws(() => validateLedger({ trips: [...full.slice(0, 100), ...full.slice(100), holiday(999)] }), /50 open holidays/);
  assert.doesNotThrow(() => validateLedger({ trips: [...Array.from({ length: 60 }, (_, i) => bill(i)), holiday(1)] }), 'the old combined limit of 50 no longer blocks a holiday');
});

test('F-17: restoring is limited per kind, with a friendly message', async () => {
  const { storage } = await import('./helpers/sqlite-d1');
  const { setTripArchived } = await import('../lib/trip-lifecycle');
  const { MAX_OPEN_BILLS } = await import('../lib/model');
  const database = await storage();
  database.sqlite.prepare('INSERT INTO profiles (id,email,display_name,created_at) VALUES (?,?,?,?)').run('owner', 'o@example.test', 'Owner', '2026-11-06');
  const insert = database.sqlite.prepare('INSERT INTO trips(id,owner,data) VALUES(?,?,?)');
  for (let i = 0; i < MAX_OPEN_BILLS; i++) insert.run(`b${i}`, 'owner', JSON.stringify({ id: `b${i}`, kind: 'bill', name: `B${i}`, currency: 'GBP', members, expenses: [], drafts: [], payments: [] }));
  insert.run('archived-bill', 'owner', JSON.stringify({ id: 'archived-bill', kind: 'bill', name: 'Old bill', currency: 'GBP', members, expenses: [], drafts: [], payments: [] }));
  insert.run('archived-holiday', 'owner', JSON.stringify({ id: 'archived-holiday', name: 'Old holiday', currency: 'GBP', members, expenses: [], drafts: [], payments: [] }));
  database.sqlite.prepare('INSERT INTO trip_archives(user_id,trip_id,archived_at) VALUES (?,?,?)').run('owner', 'archived-bill', '2026-11-01');
  database.sqlite.prepare('INSERT INTO trip_archives(user_id,trip_id,archived_at) VALUES (?,?,?)').run('owner', 'archived-holiday', '2026-11-01');
  const actor = { id: 'owner', displayName: 'Owner' };
  await assert.rejects(setTripArchived(database.asD1(), actor, 'archived-bill', false), /100 open bills/);
  assert.deepEqual(await setTripArchived(database.asD1(), actor, 'archived-holiday', false), { archived: false }, 'a holiday restores despite 100 open bills');
});
