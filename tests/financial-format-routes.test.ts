import assert from 'node:assert/strict';
import test from 'node:test';
import { createReceiptOperationWorker } from './helpers/receipt-operation-worker';
import { FINANCIAL_FORMAT_HEADER, FINANCIAL_FORMAT_REFUSAL } from '../lib/financial-format';

/**
 * R01 on the remaining money-bearing routes: export, receipt audit, import, offline expenses and invitations.
 * Production handlers, isolated D1. A request that does not declare exactly format 2 (none, empty, older, newer or
 * malformed) gets a 426 with the standard headers, receives no money and changes nothing; format 2 still works.
 */
type Fixture = Awaited<ReturnType<typeof createReceiptOperationWorker>>;
const UNSUPPORTED = [undefined, '', '1', '3', '4', '2.0', 'two'] as const;
async function raw(f: Fixture, path: string, declaration: string | undefined, init: { method?: string; body?: unknown; token?: string } = {}) {
  const headers = new Headers({ cookie: `tt_session=${init.token ?? f.sessionToken}` });
  if (declaration !== undefined) headers.set(FINANCIAL_FORMAT_HEADER, declaration);
  if (init.method && init.method !== 'GET') { headers.set('origin', f.origin); headers.set('sec-fetch-site', 'same-origin'); headers.set('content-type', 'application/json'); }
  const response = await f.worker.dispatchFetch(new URL(path, f.origin).href, { method: init.method ?? 'GET', headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) } as never);
  return { status: response.status, text: await response.text(), headers: response.headers };
}
type Result = { status: number; text: string; headers: { get(name: string): string | null } };
async function assertRefused(label: string, result: Result) {
  assert.equal(result.status, 426, label);
  assert.equal(result.headers.get('X-TripTab-Financial-Format-Required'), '2', label);
  assert.equal(result.headers.get('Cache-Control'), 'private, no-store', label);
  assert.deepEqual(JSON.parse(result.text), { error: FINANCIAL_FORMAT_REFUSAL }, `${label}: nothing but the refusal`);
}
async function state(f: Fixture) {
  const one = async (sql: string) => (await f.database.prepare(sql).first<Record<string, unknown>>())!;
  return { ledger: await one('SELECT revision FROM sync_state WHERE id=1'), trips: (await f.database.prepare('SELECT id,data,revision FROM trips ORDER BY id').all()).results,
    memberships: (await f.database.prepare('SELECT * FROM memberships ORDER BY trip_id,user_id').all()).results, invites: (await f.database.prepare('SELECT * FROM invites ORDER BY token_hash').all()).results,
    history: await one('SELECT COUNT(*) AS n FROM activity_events') };
}
const expense = (id: string) => ({ id, title: 'Queued tickets', date: '2026-11-07', currency: 'GBP', payer: 'alice', tax: 0, tip: 0, discount: 0, items: [{ id: `${id}-line`, name: 'Tickets', amount: 850, members: ['alice', 'bob'] }] });
const importTrip = (id: string) => ({ id, name: 'Imported holiday', currency: 'GBP', members: [{ id: 'alice', name: 'Alice' }], expenses: [], drafts: [], payments: [] });

test('R01-A export: an undeclared, older or newer bundle receives nothing; format 2 still downloads', async () => {
  const f = await createReceiptOperationWorker();
  try {
    const path = `/api/export?scope=trip&format=json&tripId=${f.tripId}`;
    for (const declaration of UNSUPPORTED) {
      const result = await raw(f, path, declaration);
      await assertRefused(`export ${JSON.stringify(declaration)}`, result);
      assert.doesNotMatch(result.text, /Operations holiday/);
    }
    const ok = await raw(f, path, '2');
    assert.equal(ok.status, 200, ok.text.slice(0, 200));
    assert.match(ok.text, /Operations holiday/);
    // CSV and account scopes are gated by the same check.
    await assertRefused('export csv', await raw(f, `/api/export?scope=trip&format=csv&tripId=${f.tripId}`, undefined));
    await assertRefused('export account', await raw(f, '/api/export?scope=account&format=json', '3'));
    assert.equal((await raw(f, '/api/export?scope=account&format=json', '2')).status, 200);
  } finally { await f.dispose().catch(() => {}); }
});

test('R01-F receipt audit: refused before any read for an undeclared, older or newer bundle; format 2 reports', async () => {
  const f = await createReceiptOperationWorker();
  try {
    const path = `/api/receipt/audit?tripId=${f.tripId}`;
    for (const declaration of UNSUPPORTED) await assertRefused(`audit ${JSON.stringify(declaration)}`, await raw(f, path, declaration));
    // Refused before authentication too: a request with no sign-in learns the same, not a 401.
    await assertRefused('audit unauthenticated and undeclared', await f.worker.dispatchFetch(new URL(path, f.origin).href).then(async r => ({ status: r.status, text: await r.text(), headers: r.headers })));
    const ok = await raw(f, path, '2');
    assert.equal(ok.status, 200, ok.text.slice(0, 200));
    assert.ok(Array.isArray(JSON.parse(ok.text).findings));
  } finally { await f.dispose().catch(() => {}); }
});

test('R01-B import: refused before parsing or writing; format 2 still imports once', async () => {
  const f = await createReceiptOperationWorker();
  try {
    const before = await state(f);
    for (const declaration of UNSUPPORTED) {
      const result = await raw(f, '/api/import', declaration, { method: 'POST', body: { accountId: f.owner.id, trip: importTrip('never-imported'), memberId: 'alice' } });
      await assertRefused(`import ${JSON.stringify(declaration)}`, result);
    }
    // Even a body that is not valid JSON for the route is refused on the declaration, not parsed.
    await assertRefused('import unparseable', await raw(f, '/api/import', '1', { method: 'POST', body: 'not an import' }));
    assert.deepEqual(await state(f), before, 'nothing was written');
    const ok = await raw(f, '/api/import', '2', { method: 'POST', body: { accountId: f.owner.id, trip: importTrip('imported-once'), memberId: 'alice' } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(JSON.parse(ok.text).tripId, 'imported-once');
  } finally { await f.dispose().catch(() => {}); }
});

test('R01-D offline expenses: a refused queued expense changes nothing and is not lost client-side; format 2 appends it once', async () => {
  const f = await createReceiptOperationWorker();
  try {
    const before = await state(f);
    for (const declaration of UNSUPPORTED) {
      const result = await raw(f, '/api/offline-expenses', declaration, { method: 'POST', body: { accountId: f.owner.id, tripId: f.tripId, expense: expense(`queued-${String(declaration)}`) } });
      await assertRefused(`offline ${JSON.stringify(declaration)}`, result);
    }
    assert.deepEqual(await state(f), before, 'no expense, revision or history change');
    const body = { accountId: f.owner.id, tripId: f.tripId, expense: expense('queued-ok') };
    const ok = await raw(f, '/api/offline-expenses', '2', { method: 'POST', body });
    assert.equal(ok.status, 200, ok.text);
    const again = await raw(f, '/api/offline-expenses', '2', { method: 'POST', body });
    assert.equal(again.status, 200, 'an identical retry is idempotent');
    const stored = JSON.parse((await f.tripRow()).data) as { expenses: Array<{ id: string }> };
    assert.equal(stored.expenses.filter(value => value.id === 'queued-ok').length, 1);
    assert.equal(stored.expenses.filter(value => value.id.startsWith('queued-') && value.id !== 'queued-ok').length, 0, 'no refused entry was stored');
  } finally { await f.dispose().catch(() => {}); }
});

test('R01-C invitations: the preview and every write are refused without format 2 and change nothing; the invitation list carries no money and is not gated; format 2 previews and accepts', async () => {
  const f = await createReceiptOperationWorker();
  try {
    const bob = await f.createAccount({ id: 'invited-bob', name: 'Bob', email: 'invited-bob@example.test', session: true });
    for (const declaration of UNSUPPORTED) await assertRefused(`create ${JSON.stringify(declaration)}`, await raw(f, '/api/invite', declaration, { method: 'POST', body: { mode: 'create', tripId: f.tripId, memberId: 'bob' } }));
    const created = await raw(f, '/api/invite', '2', { method: 'POST', body: { mode: 'create', tripId: f.tripId, memberId: 'bob' } });
    assert.equal(created.status, 200, created.text);
    const token = new URL(JSON.parse(created.text).url).searchParams.get('invite')!;
    const before = await state(f);
    for (const declaration of UNSUPPORTED) {
      const preview = await raw(f, `/api/invite?token=${token}`, declaration, { token: bob.sessionToken });
      await assertRefused(`preview ${JSON.stringify(declaration)}`, preview);
      assert.doesNotMatch(preview.text, /historySnapshot|Operations holiday/);
      await assertRefused(`accept ${JSON.stringify(declaration)}`, await raw(f, '/api/invite', declaration, { method: 'POST', token: bob.sessionToken, body: { mode: 'accept', token, acceptHistory: true, historySnapshot: 'x' } }));
    }
    assert.deepEqual(await state(f), before, 'no membership, invitation use, revision or history change');
    assert.equal((await raw(f, `/api/invite?mode=list&tripId=${f.tripId}`, undefined)).status, 200, 'the list has no money and is not gated');
    const preview = await raw(f, `/api/invite?token=${token}`, '2', { token: bob.sessionToken });
    assert.equal(preview.status, 200, preview.text);
    const accepted = await raw(f, '/api/invite', '2', { method: 'POST', token: bob.sessionToken, body: { mode: 'accept', token, acceptHistory: true, historySnapshot: JSON.parse(preview.text).historySnapshot } });
    assert.equal(accepted.status, 200, accepted.text);
    assert.equal(JSON.parse(accepted.text).alreadyMember, false);
  } finally { await f.dispose().catch(() => {}); }
});
