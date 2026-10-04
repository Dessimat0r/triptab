import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { shares, validateLedger } from '../../../lib/model';
import type { Ledger, Trip } from '../../../lib/model';

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
  ledgerReaders: [] as string[],
  ledgerWriters: [] as string[],
  providerLinks: new Map<string, string>(),
  identitySessionFlags: [] as boolean[],
};
function reset() {
  state.data = { trips: [structuredClone(initialTrip)] };
  state.revision = 3;
  state.writes = 0;
  state.profileAvailable = true;
  state.profileHeadersRead = 0;
  state.ledgerReaders = [];
  state.ledgerWriters = [];
  state.providerLinks = new Map();
  state.identitySessionFlags = [];
}
const mockStore = {
  async readLedger(actor: string) {
    state.ledgerReaders.push(actor);
    return { data: actor === user ? structuredClone(state.data) : { trips: [] }, revision: state.revision };
  },
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
    state.ledgerWriters.push(actor);
    state.revision++;
    state.writes++;
    return { data: structuredClone(ledger), revision: state.revision };
  },
  async ensureProfile(request: Request, options: { allowSession: boolean }) {
    state.profileHeadersRead++;
    assert.equal(options.allowSession, false, 'MCP profile creation must exclude browser sessions');
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
const mockAuth = {
  async resolveIdentity(request: Request, options: { allowSession: boolean }) {
    state.identitySessionFlags.push(options.allowSession);
    if (options.allowSession) throw new Error('MCP must not authorize browser sessions');
    const providerId = request.headers.get('oai-authenticated-user-id');
    if (!providerId) throw new Error('UNAUTHORIZED');
    return { id: state.providerLinks.get(providerId) ?? providerId };
  },
};
Object.defineProperty(globalThis, Symbol.for('triptab.mcp-test-store'), { value: mockStore, configurable: true });
Object.defineProperty(globalThis, Symbol.for('triptab.mcp-test-auth'), { value: mockAuth, configurable: true });

// Compile the real route and substitute only its external storage boundary.
// Schemas, authorization branches, tool dispatch and ledger validation remain real.
const source = await readFile(new URL('../../../app/mcp/route.ts', import.meta.url), 'utf8');
const storeUrl = 'data:text/javascript;base64,' + Buffer.from(`
const store = globalThis[Symbol.for('triptab.mcp-test-store')];
${Object.keys(mockStore).map(name => `export const ${name} = store.${name};`).join('\n')}
`).toString('base64');
const authUrl = 'data:text/javascript;base64,' + Buffer.from(`
export const resolveIdentity = globalThis[Symbol.for('triptab.mcp-test-auth')].resolveIdentity;
`).toString('base64');
const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText
  .replace("'@/lib/store'", JSON.stringify(storeUrl))
  .replace("'@/lib/auth'", JSON.stringify(authUrl))
  .replace("'@/lib/model'", JSON.stringify(new URL('../../../lib/model.ts', import.meta.url).href))
  .replace("'zod'", JSON.stringify(import.meta.resolve('zod')));
const route = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64')) as { POST(request: Request): Promise<Response> };
type Reply = { result: { isError?: boolean; content?: { type: string; text: string }[]; tools?: { name: string; description: string; inputSchema: { properties: Record<string, unknown> }; annotations: { readOnlyHint: boolean; idempotentHint?: boolean } }[] } };
async function invoke(name: string, args: Record<string, unknown>, emailHeader = false) {
  const request = new Request('https://triptab.test/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', 'oai-authenticated-user-id': user, ...(emailHeader ? { 'oai-authenticated-user-email': profile.email } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return await (await route.POST(request)).json() as Reply;
}
function content(reply: Reply) { return JSON.parse(reply.result.content![0].text) as { trip_id?: string; data: Ledger; revision: number }; }

// Second pass: an honest AI currency correction leaves a stale bank charge on a draft whose
// currency now equals the trip currency. The UI clears bankAmount on currency change
// (app/page.tsx:1650-1659); the MCP merge (`...existing, ...args.draft`) does not, while it
// explicitly clears fx (app/mcp/route.ts:330).
test('second pass: AI currency correction keeps a hidden bankAmount that overrides the total', async () => {
  reset();
  // draft-1 in the fixture: EUR receipt, 100.00 total, user-entered bank charge 87.00 GBP.
  const reply = await invoke('update_receipt_draft', {
    trip_id: 'trip-1', revision: 3,
    draft: { id: 'draft-1', title: 'Dinner', payer: 'a', currency: 'GBP', tax: 0, tip: 0, discount: 0,
      items: [{ id: 'item-1', name: 'Dinner', amount: 10000, members: ['a', 'b'] }] },
  });
  assert.equal(reply.result.isError, undefined, JSON.stringify(reply));
  const draft = content(reply).data.trips[0].drafts[0];
  console.log('draft after AI correction:', JSON.stringify({ currency: draft.currency, fx: draft.fx, bankAmount: draft.bankAmount }));
  assert.equal(draft.currency, 'GBP');
  assert.equal(draft.fx, undefined, 'fx is cleared on currency change');
  assert.equal(draft.bankAmount, 8700, 'bankAmount survives the currency change');
  // What the user approves in the editor (panel hidden because currency === trip currency):
  const { expenseTotal } = await import('../../../lib/model');
  const expense = { ...draft, date: draft.date!, time: draft.time!, timezone: draft.timezone! };
  console.log('receipt total 10000, ledger total', expenseTotal(expense as never, 'GBP'));
  assert.equal(expenseTotal(expense as never, 'GBP'), 8700);
});
