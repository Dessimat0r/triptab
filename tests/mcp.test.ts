import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { validateLedger } from '../lib/model';
import type { Ledger, Trip } from '../lib/model';

const user = 'owner-1';
const profile = { id: user, email: 'owner@example.com', displayName: 'Owner', createdAt: '2026-10-04T00:00:00Z' };
const initialTrip: Trip = {
  id: 'trip-1', ownerId: user, name: 'Lisbon', currency: 'GBP',
  members: [{ id: 'a', name: 'Owner', userId: user, email: profile.email }, { id: 'b', name: 'Alex' }],
  expenses: [], payments: [],
  drafts: [{
    id: 'draft-1', title: 'Dinner', currency: 'EUR', payer: 'a', status: 'review',
    items: [{ id: 'item-1', name: 'Dinner', amount: 10000, members: ['a', 'b'] }],
    tax: 0, tip: 0, discount: 0, date: '2026-08-15', time: '20:30', timezone: 'Europe/Lisbon',
    fx: { rate: 0.85, asOf: '2026-08-14', source: 'reference' }, bankAmount: 8700,
  }],
};

const state = {
  data: { trips: [structuredClone(initialTrip)] } as Ledger,
  revision: 3,
  writes: 0,
  profileAvailable: true,
  profileHeadersRead: 0,
};
function reset() {
  state.data = { trips: [structuredClone(initialTrip)] };
  state.revision = 3;
  state.writes = 0;
  state.profileAvailable = true;
  state.profileHeadersRead = 0;
}
const mockStore = {
  owner(request: Request) {
    const value = request.headers.get('oai-authenticated-user-id');
    if (!value) throw new Error('UNAUTHORIZED');
    return value;
  },
  async readLedger() { return { data: structuredClone(state.data), revision: state.revision }; },
  async writeLedger(actor: string, data: unknown, revision: number) {
    if (revision !== state.revision) throw new Error('CONFLICT');
    const ledger = validateLedger(data);
    for (const trip of ledger.trips) {
      if (!state.data.trips.some(existing => existing.id === trip.id)) {
        trip.ownerId = actor;
        trip.members[0] = { ...trip.members[0], userId: actor, email: profile.email, name: profile.displayName };
      }
    }
    state.data = structuredClone(ledger);
    state.revision++;
    state.writes++;
    return { data: structuredClone(ledger), revision: state.revision };
  },
  async ensureProfile(request: Request) {
    state.profileHeadersRead++;
    if (!request.headers.get('oai-authenticated-user-email')) throw new Error('UNAUTHORIZED');
    return profile;
  },
  db() {
    return { prepare: () => ({ bind: () => ({ first: async () => state.profileAvailable ? { email: profile.email, display_name: profile.displayName } : null }) }) };
  },
  bucket() { throw new Error('Receipt storage was not expected in this test'); },
  receiptKey: (actor: string, id: string) => `${actor}/${id}`,
  receiptAccess: async () => null,
};
Object.defineProperty(globalThis, Symbol.for('triptab.mcp-test-store'), { value: mockStore, configurable: true });

// Compile the real route and substitute only its external storage boundary.
// Schemas, authorization branches, tool dispatch and ledger validation remain real.
const source = await readFile(new URL('../app/mcp/route.ts', import.meta.url), 'utf8');
const storeUrl = 'data:text/javascript;base64,' + Buffer.from(`
const store = globalThis[Symbol.for('triptab.mcp-test-store')];
${Object.keys(mockStore).map(name => `export const ${name} = store.${name};`).join('\n')}
`).toString('base64');
const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText
  .replace("'@/lib/store'", JSON.stringify(storeUrl))
  .replace("'@/lib/model'", JSON.stringify(new URL('../lib/model.ts', import.meta.url).href))
  .replace("'zod'", JSON.stringify(import.meta.resolve('zod')));
const route = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64')) as { POST(request: Request): Promise<Response> };
type Reply = { result: { isError?: boolean; content?: { type: string; text: string }[]; tools?: { name: string; inputSchema: { properties: Record<string, unknown> }; annotations: { readOnlyHint: boolean } }[] } };
async function invoke(name: string, args: Record<string, unknown>, emailHeader = false) {
  const request = new Request('https://triptab.test/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', 'oai-authenticated-user-id': user, ...(emailHeader ? { 'oai-authenticated-user-email': profile.email } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return await (await route.POST(request)).json() as Reply;
}
function content(reply: Reply) { return JSON.parse(reply.result.content![0].text) as { trip_id?: string; data: Ledger; revision: number }; }
const create = {
  request_id: 'b3eef768-a4e0-4566-bba1-3ab3e6813612', revision: 3,
  name: 'Lisbon in summer', currency: 'GBP', travellers: ['Me', 'Alex'], startDate: '2027-06-03', endDate: '2027-06-10',
};
const expenseDraft = {
  id: 'draft-2', title: 'Taxi to the hotel', payer: 'a', currency: 'EUR',
  items: [{ id: 'taxi-item', name: 'Taxi fare', amount: 4500, members: ['a', 'b'] }],
  tax: 0, tip: 200, discount: 0, date: '2026-08-16', time: '21:15', timezone: 'Europe/Lisbon',
  fx: { rate: 0.86, asOf: '2026-08-14', source: 'manual' }, bankAmount: 4111,
};

test('lists native holiday and natural-language expense tools with write annotations', async () => {
  const response = await route.POST(new Request('https://triptab.test/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }));
  const reply = await response.json() as Reply;
  for (const name of ['create_holiday', 'create_expense_draft', 'update_receipt_draft']) {
    const tool = reply.result.tools!.find(tool => tool.name === name);
    assert.ok(tool);
    assert.equal(tool.annotations.readOnlyHint, false);
  }
});

test('creates a dated holiday using the authenticated stored profile and is safe to retry', async () => {
  reset();
  const first = await invoke('create_holiday', create);
  assert.equal(first.result.isError, undefined);
  const saved = content(first);
  const holiday = saved.data.trips.find(trip => trip.id === saved.trip_id)!;
  assert.equal(holiday.name, create.name);
  assert.equal(holiday.startDate, create.startDate);
  assert.equal(holiday.endDate, create.endDate);
  assert.equal(holiday.members[0].userId, user);
  assert.equal(holiday.members[0].email, profile.email);
  assert.equal(holiday.members[0].name, profile.displayName);
  assert.equal(holiday.members[1].name, 'Alex');
  assert.match(holiday.members[1].id, /^[a-f0-9-]{36}$/);
  const retry = await invoke('create_holiday', create);
  assert.equal(content(retry).trip_id, saved.trip_id);
  assert.equal(state.writes, 1);
  assert.equal(state.data.trips.length, 2);
});

test('creates the profile from verified gateway headers when available', async () => {
  reset();
  state.profileAvailable = false;
  const reply = await invoke('create_holiday', create, true);
  assert.equal(reply.result.isError, undefined);
  assert.equal(state.profileHeadersRead, 1);
  assert.equal(state.writes, 1);
});

test('rejects new holiday creation without a verified account profile', async () => {
  reset();
  state.profileAvailable = false;
  const reply = await invoke('create_holiday', create);
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content![0].text, /Open TripTab.*verified profile/);
  assert.equal(state.writes, 0);
});

test('rejects invalid or reversed holiday dates and stale revisions without writing', async () => {
  reset();
  for (const fields of [{ startDate: '2027-02-30' }, { endDate: '2027-06-02' }, { revision: 2 }]) {
    const reply = await invoke('create_holiday', { ...create, ...fields });
    assert.equal(reply.result.isError, true);
  }
  assert.equal(state.writes, 0);
});

test('creates a complete natural-language expense draft without posting an expense', async () => {
  reset();
  const reply = await invoke('create_expense_draft', { trip_id: 'trip-1', revision: 3, draft: expenseDraft });
  assert.equal(reply.result.isError, undefined);
  const holiday = content(reply).data.trips[0];
  const draft = holiday.drafts.find(value => value.id === expenseDraft.id)!;
  assert.equal(holiday.expenses.length, 0);
  assert.equal(draft.status, 'review');
  assert.equal(draft.receiptId, undefined);
  assert.equal(draft.date, expenseDraft.date);
  assert.equal(draft.time, expenseDraft.time);
  assert.equal(draft.timezone, expenseDraft.timezone);
  assert.equal(draft.bankAmount, 4111);
  assert.equal(draft.fx!.rate, 0.86);
  assert.equal(draft.items[0].amount, 4500);
});

test('accepts incoming metadata overrides when updating an existing receipt draft', async () => {
  reset();
  const reply = await invoke('update_receipt_draft', { trip_id: 'trip-1', revision: 3, draft: { ...expenseDraft, id: 'draft-1' } });
  assert.equal(reply.result.isError, undefined);
  const draft = content(reply).data.trips[0].drafts[0];
  assert.equal(draft.fx!.rate, 0.86);
  assert.equal(draft.bankAmount, 4111);
  assert.equal(draft.date, '2026-08-16');
});

test('rejects invalid member assignments and malformed purchase timezones', async () => {
  reset();
  for (const draft of [
    { ...expenseDraft, payer: 'other-user' },
    { ...expenseDraft, timezone: 'Europe/Nowhere' },
    { ...expenseDraft, time: '24:00' },
  ]) {
    const reply = await invoke('create_expense_draft', { trip_id: 'trip-1', revision: 3, draft });
    assert.equal(reply.result.isError, true);
  }
  assert.equal(state.writes, 0);
});
