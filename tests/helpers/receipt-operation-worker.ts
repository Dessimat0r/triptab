import { FINANCIAL_FORMAT, FINANCIAL_FORMAT_HEADER } from '../../lib/financial-format';
import { canonicalJson, sha256Hex } from '../../lib/data-utils';
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createFetchMock, Log, LogLevel, Miniflare } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import type { Draft, Ledger } from '../../lib/model';
import { receiptFlowImage } from './receipt-flow-worker';

/**
 * R12/R07: the production receipt-processing route, ledger route, upload
 * route and the background runner, in Miniflare with real D1 and R2 and every
 * migration. Only two things are substituted, in tests/helpers/workers-shim.ts:
 * the OpenAI endpoint (a mocked provider, never a network or paid call) and an
 * observation point that can pause or fail one ledger commit batch.
 */
export const transcription = {
  title: 'Café', currency: 'GBP', items: [{ id: null, name: 'Coffee', amount: 250 }, { id: null, name: 'Pastry', amount: 350 }],
  tax: 0, tip: 0, discount: 0, printedTotal: 600, date: '2026-09-28', time: '10:15', summary: 'Read two items.',
};
export type OperationRow = { operation_key: string; provider: string | null; status: string; attempt_id: string; attempts: number; error_code: string | null; phase: string | null;
  auto_resumes: number | null; lease_until: number };
type Hooks = { pauseNextCommit: boolean; atCommit: boolean; proceed: boolean; failNextCommit?: 'before' | 'after'; commitBatches: number;
  pauseBeforeSpend?: boolean; atSpend?: boolean; releaseSpend?: boolean;
  providerChecks?: number; pauseProviderAdmission?: number; atProviderAdmission?: boolean; releaseProviderAdmission?: boolean;
  provider: { calls: number; holdNext: number; held: number; release: boolean; output: unknown; fail?: number }; detached: number };

export async function createReceiptOperationWorker(options: { kind?: 'bill'; bindings?: Record<string, string> } = {}) {
  const project = fileURLToPath(new URL('../../', import.meta.url));
  const shim = fileURLToPath(new URL('./workers-shim.ts', import.meta.url));
  const hasBackground = await access(new URL('../../lib/receipt-background.ts', import.meta.url)).then(() => true, () => false);
  const bundled = await build({
    stdin: { resolveDir: project, sourcefile: 'receipt-operation-test-worker.ts', contents: `
      import * as ledger from './app/api/ledger/route.ts';
      import * as receipt from './app/api/receipt/route.ts';
      import * as process from './app/api/receipt/process/route.ts';
      import * as tripRoute from './app/api/trip/route.ts';
      import * as authRoute from './app/api/auth/route.ts';
      import * as profile from './app/api/profile/route.ts';
      import * as activity from './app/api/activity/route.ts';
      import * as accountActivity from './app/api/account-activity/route.ts';
      import * as exports from './app/api/export/route.ts';
      import * as imports from './app/api/import/route.ts';
      import * as offline from './app/api/offline-expenses/route.ts';
      import * as aiStatus from './app/api/receipt/ai-status/route.ts';
      import * as tripLanguage from './app/api/trip-language/route.ts';
      import * as notifications from './app/api/notifications/route.ts';
      import * as receiptAudit from './app/api/receipt/audit/route.ts';
      import * as mcp from './app/mcp/route.ts';
      import * as invite from './app/api/invite/route.ts';
      import * as translate from './app/api/receipt/translate/route.ts';
      import * as accountRoute from './app/api/account/route.ts';
      import * as remind from './app/api/remind/route.ts';
      import * as notificationPreferences from './app/api/notification-preferences/route.ts';
      import { hooks } from ${JSON.stringify(shim)};
      import { readLedger as storedLedger, writeLedger } from './lib/store.ts';
      ${hasBackground ? "import * as background from './lib/receipt-background.ts';" : 'const background = undefined;'}
      const routes = { '/api/ledger': ledger, '/api/receipt': receipt, '/api/receipt/process': process, '/api/trip': tripRoute, '/api/auth': authRoute, '/api/profile': profile, '/api/activity': activity, '/api/account-activity': accountActivity, '/api/export': exports, '/api/import': imports, '/api/offline-expenses': offline, '/api/receipt/ai-status': aiStatus, '/api/trip-language': tripLanguage, '/api/notifications': notifications, '/api/receipt/audit': receiptAudit, '/mcp': mcp, '/api/invite': invite, '/api/receipt/translate': translate, '/api/account': accountRoute, '/api/remind': remind, '/api/notification-preferences': notificationPreferences };
      export default {
        async fetch(request, env, ctx) {
          const url = new URL(request.url);
          if (url.pathname === '/__test/hooks') {
            if (request.method === 'POST') Object.assign(hooks, await request.json());
            return Response.json(hooks);
          }
          if (url.pathname === '/__test/provider') {
            if (request.method === 'POST') Object.assign(hooks.provider, await request.json());
            return Response.json(hooks.provider);
          }
          if (url.pathname === '/__test/forged-save') {
            // A caller presenting a reading's identity it was never issued (for
            // example a JSON value) must not reach a processing save.
            const { userId, tripId, operation } = await request.json();
            const ledger = await storedLedger(userId);
            const trip = ledger.data.trips.find(value => value.id === tripId);
            try {
              await writeLedger(userId, { trips: [trip] }, ledger.revision, { source: 'web', tripSnapshot: structuredClone(trip), operation });
              return Response.json({ saved: true });
            } catch (error) { return Response.json({ saved: false, error: String(error && error.message) }); }
          }
          if (url.pathname === '/__test/tick') {
            // The scheduled handler's receipt dispatch, invoked as Cron would.
            const now = Number(url.searchParams.get('now')) || Date.now();
            if (!background) return Response.json({ error: 'No background runner in this tree' }, { status: 501 });
            return Response.json(await background.runReceiptOperationTick(env, { now }));
          }
          const route = routes[url.pathname];
          const handler = route && route[request.method];
          return handler ? handler(request) : new Response('Not found', { status: 404 });
        },
      };`,
    },
    tsconfig: project + 'tsconfig.json', bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
    plugins: [{ name: 'workers-shim', setup(builder) {
      builder.onResolve({ filter: /^cloudflare:workers$/ }, args => args.importer === shim ? { path: 'cloudflare:workers', external: true } : { path: shim });
    } }],
  });
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  const tokenKey = randomBytes(32).toString('base64url');
  const worker = new Miniflare({ modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'],
    bindings: { RECEIPT_AI_OWNER_EMAIL: 'owner@example.test', RECEIPT_AI_TOKEN_KEY: tokenKey, ...options.bindings },
    d1Databases: { DB: 'receipt-operations' }, d1Persist: false, r2Buckets: ['RECEIPTS'], r2Persist: false,
    fetchMock, log: new Log(LogLevel.NONE),
  });
  const origin = 'https://triptab.operations.test';
  const owner = { id: 'op-owner', email: 'op-owner@example.test', displayName: 'Alice' };
  const sessionToken = randomBytes(32).toString('base64url');
  const sessionId = 'session-' + randomBytes(8).toString('hex');
  const tripId = 'op-trip';
  try {
    const database = await worker.getD1Database('DB');
    for (const name of (await readdir(new URL('../../drizzle/', import.meta.url))).filter(file => file.endsWith('.sql')).sort()) {
      const statements = unstable_splitSqlQuery(await readFile(new URL('../../drizzle/' + name, import.meta.url), 'utf8'));
      await database.batch(statements.map(statement => database.prepare(statement)));
    }
    const now = new Date().toISOString();
    // The shared API key, encrypted exactly as lib/receipt-ai-access.ts stores it.
    const aes = await webcrypto.subtle.importKey('raw', Buffer.from(tokenKey, 'base64url'), 'AES-GCM', false, ['encrypt']);
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`triptab-receipt-api-v1:${owner.id}`) },
      aes, new TextEncoder().encode('sk-test-mocked-provider-key-0000')));
    await database.batch([
      database.prepare('INSERT INTO profiles(id,email,display_name,created_at) VALUES(?,?,?,?)').bind(owner.id, owner.email, owner.displayName, now),
      database.prepare('INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at,session_id) VALUES(?,?,?,?,?)')
        .bind(createHash('sha256').update(sessionToken).digest('hex'), owner.id, new Date(Date.now() + 30 * 60_000).toISOString(), now, sessionId),
      database.prepare("INSERT INTO receipt_ai_settings(id,user_id,api_key_encrypted,provider,version) VALUES('shared',?,?,'api',1)")
        .bind(owner.id, `v1.${Buffer.from(iv).toString('base64url')}.${Buffer.from(sealed).toString('base64url')}`),
    ]);
    const request = async (path: string, init: RequestInit & { body?: string | Uint8Array } = {}) => {
      const headers = new Headers(init.headers);
      headers.set('cookie', `tt_session=${sessionToken}`);
      headers.set(FINANCIAL_FORMAT_HEADER, String(FINANCIAL_FORMAT));
      if (!['GET', 'HEAD'].includes(init.method ?? 'GET')) {
        headers.set('origin', origin); headers.set('sec-fetch-site', 'same-origin');
        if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      }
      return worker.dispatchFetch(new URL(path, origin).href, { ...init, headers } as never);
    };
    const readLedger = async () => {
      const response = await request('/api/ledger');
      if (!response.ok) throw new Error(`ledger read ${response.status}`);
      return response.json() as Promise<{ data: Ledger; revision: number }>;
    };
    const saveLedger = async (data: Ledger, revision: number) => {
      const response = await request('/api/ledger', { method: 'POST', body: JSON.stringify({ data, revision }) });
      if (!response.ok) throw new Error(`ledger write ${response.status} ${await response.text()}`);
      return response.json() as Promise<{ data: Ledger; revision: number }>;
    };
    // A holiday with one saved receipt photo and its waiting draft, through production routes.
    const initial = await readLedger();
    await saveLedger({ trips: [...initial.data.trips, { id: tripId, name: 'Operations holiday', currency: 'GBP', ...(options.kind ? { kind: options.kind } : {}),
      members: [{ id: 'alice', name: owner.displayName }, { id: 'bob', name: 'Bob' }], expenses: [], drafts: [], payments: [] }] }, initial.revision);
    const upload = await request(`/api/receipt?tripId=${tripId}`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: receiptFlowImage });
    if (!upload.ok) throw new Error(`upload ${upload.status} ${await upload.text()}`);
    const { receiptId } = await upload.json() as { receiptId: string };
    const seeded = await readLedger();
    const waiting: Draft = { id: 'op-draft', receiptId, title: '', currency: 'GBP', payer: 'alice', status: 'waiting', items: [], tax: 0, tip: 0, discount: 0 };
    seeded.data.trips.find(trip => trip.id === tripId)!.drafts.push(waiting);
    await saveLedger(seeded.data, seeded.revision);

    const control = async (path: '/__test/hooks' | '/__test/provider', body?: Partial<Hooks> | Partial<Hooks['provider']>) =>
      (await worker.dispatchFetch(origin + path, body ? { method: 'POST', body: JSON.stringify(body) } : {})).json() as Promise<Hooks & Hooks['provider']>;
    await control('/__test/provider', { output: transcription });
    const currentDraft = async () => (await readLedger()).data.trips.find(trip => trip.id === tripId)!.drafts.find(value => value.id === waiting.id)!;
    const processBody = async (extra: Record<string, unknown> = {}) => {
      const draft = await currentDraft();
      return JSON.stringify({ tripId, draftId: draft.id, receiptId: draft.receiptId, draftHash: await sha256Hex(canonicalJson(draft)), ...extra });
    };
    const process = (body: string, init: RequestInit = {}) => request('/api/receipt/process', { ...init, method: 'POST', body });
    const operations = async () => (await database.prepare('SELECT * FROM receipt_operations ORDER BY created_at').all<OperationRow>()).results;
    const waitFor = async (condition: () => Promise<boolean>, what: string, timeout = 10_000) => {
      const started = Date.now();
      while (!await condition()) {
        if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${what}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    const forgedSave = async (operation: unknown) => (await worker.dispatchFetch(`${origin}/__test/forged-save`, { method: 'POST',
      body: JSON.stringify({ userId: owner.id, tripId, operation }) })).json() as Promise<{ saved: boolean; error?: string }>;
    const tick = async (now = Date.now()) => (await worker.dispatchFetch(`${origin}/__test/tick?now=${now}`)).json() as Promise<{ resumed: number; skipped: number; stored: number; failed: number; disabled: boolean }>;
    /**
     * Any identity: a TripTab session cookie, the trusted ChatGPT headers Sites
     * adds (synthetic here, as in the other native-flow tests), both, or none.
     */
    type Identity = { sessionToken?: string; provider?: { id: string; email?: string } };
    const requestAs = (identity: Identity, path: string, init: RequestInit & { body?: string | Uint8Array } = {}) => {
      const headers = new Headers(init.headers);
      if (identity.sessionToken) headers.set('cookie', `tt_session=${identity.sessionToken}`);
      if (identity.provider) {
        headers.set('oai-authenticated-user-id', identity.provider.id);
        if (identity.provider.email) headers.set('oai-authenticated-user-email', identity.provider.email);
      }
      headers.set(FINANCIAL_FORMAT_HEADER, String(FINANCIAL_FORMAT));
      if (!['GET', 'HEAD'].includes(init.method ?? 'GET')) {
        headers.set('origin', origin); headers.set('sec-fetch-site', 'same-origin');
        if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      }
      return worker.dispatchFetch(new URL(path, origin).href, { ...init, headers } as never);
    };
    /** An account seeded directly: profile, optional password, provider link and live session. */
    const createAccount = async (account: { id: string; email: string; name: string; password?: boolean; link?: { providerId: string }; session?: boolean }) => {
      const token = randomBytes(32).toString('base64url'), created = new Date().toISOString();
      await database.batch([
        database.prepare('INSERT INTO profiles(id,email,display_name,created_at) VALUES(?,?,?,?)').bind(account.id, account.email, account.name, created),
        ...(account.password ? [database.prepare('INSERT INTO auth_credentials(user_id,email,password_hash,password_salt,iterations,created_at) VALUES(?,?,?,?,?,?)')
          .bind(account.id, account.email, 'synthetic-hash', 'synthetic-salt', 1, created)] : []),
        ...(account.link ? [database.prepare('INSERT INTO auth_links(oai_user_id,user_id,created_at) VALUES(?,?,?)').bind(account.link.providerId, account.id, created)] : []),
        ...(account.session ? [database.prepare('INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at,session_id) VALUES(?,?,?,?,?)')
          .bind(createHash('sha256').update(token).digest('hex'), account.id, new Date(Date.now() + 30 * 60_000).toISOString(), created, `${account.id}-session`)] : []),
      ]);
      return { sessionToken: account.session ? token : undefined };
    };
    /** A holiday owned by this identity with one saved photo and its waiting draft, through production routes. */
    const seedReading = async (identity: Identity, holidayId: string, payer = 'me') => {
      const read = async () => {
        const response = await requestAs(identity, '/api/ledger');
        if (!response.ok) throw new Error(`ledger read ${response.status} ${await response.text()}`);
        return response.json() as Promise<{ data: Ledger; revision: number }>;
      };
      const write = async (snapshot: { data: Ledger; revision: number }) => {
        const response = await requestAs(identity, '/api/ledger', { method: 'POST', body: JSON.stringify(snapshot) });
        if (!response.ok) throw new Error(`ledger write ${response.status} ${await response.text()}`);
      };
      const start = await read();
      await write({ revision: start.revision, data: { trips: [...start.data.trips, { id: holidayId, name: `Holiday ${holidayId}`, currency: 'GBP',
        members: [{ id: payer, name: 'Me' }, { id: 'friend', name: 'Friend' }], expenses: [], drafts: [], payments: [] }] } });
      const photo = await requestAs(identity, `/api/receipt?tripId=${holidayId}`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: receiptFlowImage });
      if (!photo.ok) throw new Error(`upload ${photo.status} ${await photo.text()}`);
      const { receiptId: photoId } = await photo.json() as { receiptId: string };
      const withTrip = await read();
      withTrip.data.trips.find(trip => trip.id === holidayId)!.drafts.push({ id: `${holidayId}-draft`, receiptId: photoId, title: '', currency: 'GBP', payer,
        status: 'waiting', items: [], tax: 0, tip: 0, discount: 0 });
      await write(withTrip);
      const body = async () => {
        const draft = (await read()).data.trips.find(trip => trip.id === holidayId)!.drafts.find(value => value.id === `${holidayId}-draft`)!;
        return JSON.stringify({ tripId: holidayId, draftId: draft.id, receiptId: draft.receiptId, draftHash: await sha256Hex(canonicalJson(draft)) });
      };
      const trip = async () => (await database.prepare('SELECT data, revision FROM trips WHERE id=?').bind(holidayId).first<{ data: string; revision: number }>())!;
      const history = async () => Number((await database.prepare('SELECT COUNT(*) AS n FROM activity_events WHERE trip_id=?').bind(holidayId).first<{ n: number }>())!.n);
      return { body, read, trip, history, process: async (init: RequestInit = {}) => requestAs(identity, '/api/receipt/process', { ...init, method: 'POST', body: await body() }) };
    };
    const historyCount = async () => Number((await database.prepare("SELECT COUNT(*) AS n FROM activity_events WHERE trip_id=?").bind(tripId).first<{ n: number }>())!.n);
    const tripRow = async () => (await database.prepare('SELECT data, revision FROM trips WHERE id=?').bind(tripId).first<{ data: string; revision: number }>())!;
    return { worker, database, origin, owner, sessionId, tripId, receiptId, request, readLedger, saveLedger, control, currentDraft,
      processBody, process, operations, waitFor, tick, forgedSave, historyCount, tripRow, requestAs, createAccount, seedReading, sessionToken,
      // Release anything held (a failed assertion can leave a paused commit or
      // provider call) before disposing, so teardown never waits on them.
      dispose: async () => {
        await control('/__test/provider', { release: true }).catch(() => {});
        await control('/__test/hooks', { proceed: true, releaseSpend: true, releaseProviderAdmission: true }).catch(() => {});
        await worker.dispose();
      } };
  } catch (error) { await worker.dispose(); throw error; }
}

