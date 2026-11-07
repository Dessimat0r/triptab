// Test-only stand-in for 'cloudflare:workers' inside the receipt-operation
// Miniflare worker (tests/helpers/receipt-operation-worker.ts). It re-exports
// the real runtime module, with two observation points and nothing else:
//
// - the D1 binding pauses (or fails) a ledger commit batch at the exact moment
//   before it runs, so a test can interleave another real request there;
// - outbound OpenAI requests are answered by a mocked provider that counts
//   calls and can hold them, so no paid or network call is ever made.
//
// Every SQL statement, route, claim and fence still runs in production code
// against Miniflare's D1 and R2. This module is never part of a build.
import { env as runtimeEnv, waitUntil as runtimeWaitUntil } from 'cloudflare:workers';

type Hooks = {
  /** Pause the next ledger commit batch until `proceed` (set by the test). */
  pauseNextCommit: boolean; atCommit: boolean; proceed: boolean;
  /** Make the next ledger commit batch fail before it runs, or after it committed. */
  failNextCommit?: 'before' | 'after';
  commitBatches: number;
  pauseBeforeSpend?: boolean; atSpend?: boolean; releaseSpend?: boolean;
  providerChecks?: number; pauseProviderAdmission?: number; atProviderAdmission?: boolean; releaseProviderAdmission?: boolean;
  provider: { calls: number; holdNext: number; held: number; release: boolean; output: unknown; fail?: number };
  detached: number;
};
const key = Symbol.for('triptab.receipt-operation-test');
const scope = globalThis as unknown as Record<symbol, Hooks>;
export const hooks: Hooks = scope[key] ??= {
  pauseNextCommit: false, atCommit: false, proceed: false, commitBatches: 0,
  provider: { calls: 0, holdNext: 0, held: 0, release: false, output: undefined }, detached: 0,
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function wrapDatabase(database: D1Database): D1Database {
  // writeLedger prepares this statement immediately before its commit batch.
  let commitPrepared = false;
  return new Proxy(database, { get(target, property) {
    if (property === 'prepare') return (sql: string) => {
      if (sql.startsWith('INSERT OR IGNORE INTO sync_state')) commitPrepared = true;
      const statement = target.prepare(sql);
      const budget = sql.startsWith('INSERT INTO auth_rate_limits');
      const providerAdmission = sql.startsWith('UPDATE receipt_operations SET provider =');
      if (budget || providerAdmission) return new Proxy(statement, { get(target, property) {
        if (property === 'bind') return (...values: unknown[]) => {
          const bound = target.bind(...values);
          return new Proxy(bound, { get(target, property) {
            if (property === 'first') return async () => {
              if (budget && hooks.pauseBeforeSpend) {
                hooks.pauseBeforeSpend = false; hooks.atSpend = true;
                while (!hooks.releaseSpend) await sleep(5);
                hooks.atSpend = false;
              }
              if (providerAdmission) {
                hooks.providerChecks = (hooks.providerChecks ?? 0) + 1;
                if (hooks.pauseProviderAdmission === hooks.providerChecks) {
                  hooks.atProviderAdmission = true;
                  while (!hooks.releaseProviderAdmission) await sleep(5);
                  hooks.atProviderAdmission = false;
                }
              }
              return target.first();
            };
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
          } });
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      return statement;
    };
    if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
      const commit = commitPrepared; commitPrepared = false;
      if (commit) {
        hooks.commitBatches++;
        if (hooks.pauseNextCommit) {
          hooks.pauseNextCommit = false; hooks.atCommit = true;
          while (!hooks.proceed) await sleep(5);
          hooks.proceed = false; hooks.atCommit = false;
        }
        if (hooks.failNextCommit === 'before') { hooks.failNextCommit = undefined; throw new Error('D1_ERROR: simulated commit failure'); }
        const results = await target.batch(statements);
        if (hooks.failNextCommit === 'after') { hooks.failNextCommit = undefined; throw new Error('D1_ERROR: simulated loss after commit'); }
        return results;
      }
      return target.batch(statements);
    };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

const wrapped = new Map<string, unknown>();
export const env = new Proxy(runtimeEnv as unknown as Record<string, unknown>, { get(target, property) {
  if (property !== 'DB') return Reflect.get(target, property);
  if (!wrapped.has('DB')) wrapped.set('DB', wrapDatabase(target.DB as D1Database));
  return wrapped.get('DB');
} });

export function waitUntil(promise: Promise<unknown>) {
  hooks.detached++;
  return runtimeWaitUntil(promise);
}

function providerStream(output: unknown) {
  const event = { type: 'response.completed', response: { status: 'completed', error: null,
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] } };
  return new Response(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith('https://api.openai.com/')) return realFetch(input, init);
  hooks.provider.calls++;
  const signal = init?.signal;
  if (hooks.provider.holdNext > 0) {
    hooks.provider.holdNext--; hooks.provider.held++;
    // Held until the test releases it; an abort (timeout) ends it like the real provider.
    while (!hooks.provider.release) {
      if (signal?.aborted) { hooks.provider.held--; throw signal.reason ?? new DOMException('Aborted', 'AbortError'); }
      await sleep(5);
    }
    hooks.provider.held--;
  }
  if (hooks.provider.fail) { hooks.provider.fail--; return Response.json({ error: { code: 'server_error' } }, { status: 500 }); }
  return providerStream(hooks.provider.output);
}) as typeof fetch;
