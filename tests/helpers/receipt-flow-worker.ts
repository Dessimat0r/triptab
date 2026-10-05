import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createFetchMock, Log, LogLevel, Miniflare } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import type { Ledger } from '../../lib/model';

// A complete, decodable synthetic 2×2 PNG, not MIME-labelled text or a receipt
// claiming real OCR. The journey verifies these exact stored image bytes.
export const receiptFlowImage = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4//8/AwQAWQAp5AX7XiD3SwAAAABJRU5ErkJggg==', 'base64'));
export type ReceiptFlowSnapshot = { data: Ledger; revision: number };
type NativeRequestInit = NonNullable<Parameters<Miniflare['dispatchFetch']>[1]>;
type BrowserRequestInit = Omit<RequestInit, 'body'> & Pick<NativeRequestInit, 'body'>;
export type ReceiptFlowToolResult = { jsonrpc: '2.0'; id: number; error?: { code: number; message: string }; result?: {
  isError?: boolean; content?: { type: string; text?: string; data?: string; mimeType?: string }[];
} };

/** Isolated native production routes. Only the trusted gateway header is
 * synthetic; auth/session/SQL/CAS/audit/R2/image validation are production code.
 * This does not exercise the hosted gateway or make a model/provider request.
 */
export async function createReceiptFlowWorker(options: { seedTrip?: boolean } = {}) {
  const project = fileURLToPath(new URL('../../', import.meta.url));
  const bundled = await build({
    stdin: { resolveDir: project, sourcefile: 'receipt-flow-native-worker.ts', contents: `
      import * as ledger from './app/api/ledger/route.ts';
      import * as receipt from './app/api/receipt/route.ts';
      import * as mcp from './app/mcp/route.ts';
      import * as profile from './app/api/profile/route.ts';
      import * as activity from './app/api/activity/route.ts';
      import * as activityEntry from './app/api/activity-entry/route.ts';
      import * as accountActivity from './app/api/account-activity/route.ts';
      import * as aiStatus from './app/api/receipt/ai-status/route.ts';
      import * as notifications from './app/api/notifications/route.ts';
      import * as push from './app/api/push/route.ts';
      import * as exports from './app/api/export/route.ts';
      import * as tripLanguage from './app/api/trip-language/route';
      import * as translate from './app/api/receipt/translate/route';
      const routes = { '/api/ledger': ledger, '/api/receipt': receipt, '/mcp': mcp,
        '/api/profile': profile, '/api/activity': activity, '/api/activity-entry': activityEntry, '/api/account-activity': accountActivity,
        '/api/receipt/ai-status': aiStatus, '/api/notifications': notifications, '/api/push': push,
        '/api/trip-language':tripLanguage, '/api/receipt/translate':translate, '/api/export': exports };
      export default { async fetch(request) {
        const route = routes[new URL(request.url).pathname];
        const handler = route && route[request.method];
        return handler ? handler(request) : new Response('Not found', { status: 404 });
      } };`
    },
    tsconfig: project + 'tsconfig.json', bundle: true, write: false, format: 'esm', platform: 'browser',
    target: 'es2022', external: ['cloudflare:workers'],
  });
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  const worker = new Miniflare({ modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'],
    bindings: { RECEIPT_AI_OWNER_EMAIL: 'dessimat0r@gmail.com', RECEIPT_AI_TOKEN_KEY: randomBytes(32).toString('base64url'), RECEIPT_AI_CHATGPT_PLAN_ENABLED: 'false' },
    d1Databases: { DB: 'receipt-flow-native' }, d1Persist: false,
    r2Buckets: ['RECEIPTS'], r2Persist: false, fetchMock, log: new Log(LogLevel.NONE),
  });
  const origin = 'https://triptab.flow.test';
  const owner = { id: 'flow-owner', email: 'flow-owner@example.test', displayName: 'Native Flow Owner' };
  const providerId = 'flow-provider';
  const sessionToken = randomBytes(32).toString('base64url');
  const tripId = 'flow-trip';
  try {
    const database = await worker.getD1Database('DB');
    for (const name of (await readdir(new URL('../../drizzle/', import.meta.url))).filter(file => file.endsWith('.sql')).sort()) {
      for (const sql of unstable_splitSqlQuery(await readFile(new URL('../../drizzle/' + name, import.meta.url), 'utf8'))) {
        await database.prepare(sql).run();
      }
    }
    const now = new Date().toISOString();
    await database.batch([
      database.prepare('INSERT INTO profiles(id,email,display_name,created_at) VALUES(?,?,?,?)').bind(owner.id, owner.email, owner.displayName, now),
      database.prepare('INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
        .bind(createHash('sha256').update(sessionToken).digest('hex'), owner.id, new Date(Date.now() + 30 * 60_000).toISOString(), now),
      database.prepare('INSERT INTO auth_links(oai_user_id,user_id,created_at) VALUES(?,?,?)').bind(providerId, owner.id, now),
    ]);
    const browserRequest = async (path: string, init: BrowserRequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set('cookie', `tt_session=${sessionToken}`);
      if (!['GET', 'HEAD'].includes(init.method ?? 'GET')) {
        headers.set('origin', origin);
        headers.set('sec-fetch-site', 'same-origin');
        if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      }
      return worker.dispatchFetch(new URL(path, origin).href, { ...init, headers });
    };
    const readLedger = async (): Promise<ReceiptFlowSnapshot> => {
      const response = await browserRequest('/api/ledger');
      if (!response.ok) throw new Error(`Native ledger read failed: ${response.status} ${await response.text()}`);
      return response.json() as Promise<ReceiptFlowSnapshot>;
    };
    const toolCall = async (name: string, args: Record<string, unknown>): Promise<ReceiptFlowToolResult> => {
      const response = await worker.dispatchFetch(origin + '/mcp', {
        method: 'POST', headers: { 'content-type': 'application/json', 'oai-authenticated-user-id': providerId },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      return response.json() as Promise<ReceiptFlowToolResult>;
    };
    const seedTrip = async () => {
      const snapshot = await readLedger();
      if (snapshot.data.trips.some(trip => trip.id === tripId)) return snapshot;
      const response = await browserRequest('/api/ledger', { method: 'POST', body: JSON.stringify({ revision: snapshot.revision,
        data: { trips: [...snapshot.data.trips, {
          id: tripId, name: 'Native receipt holiday', currency: 'GBP', members: [
            { id: 'alice', name: owner.displayName }, { id: 'bob', name: 'Bob' },
          ], expenses: [], drafts: [], payments: [],
        }] },
      }) });
      if (!response.ok) throw new Error(`Native trip creation failed: ${response.status} ${await response.text()}`);
      return response.json() as Promise<ReceiptFlowSnapshot>;
    };
    if (options.seedTrip !== false) await seedTrip();
    return { worker, db: database, database, origin, owner, providerId, sessionToken, tripId,
      browserRequest, toolCall, readLedger, seedTrip, dispose: () => worker.dispose() };
  } catch (error) { await worker.dispose(); throw error; }
}
