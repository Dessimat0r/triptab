import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

const boundary = { response: new Response('TripTab'), requests: [] as string[], bindings: [] as unknown[] };
Object.defineProperty(globalThis, Symbol.for('triptab.worker-test'), { value: boundary, configurable: true });
const handlerUrl = 'data:text/javascript;base64,' + Buffer.from(`
const state = globalThis[Symbol.for('triptab.worker-test')];
export default { async fetch(request) { state.requests.push(request.url); return state.response; } };
`).toString('base64');
const contextUrl = 'data:text/javascript;base64,' + Buffer.from(`
export function runWithConnectorBinding(binding, run) {
  globalThis[Symbol.for('triptab.worker-test')].bindings.push(binding);
  return run();
}
`).toString('base64');
const source = await readFile(new URL('../build/sites-worker.ts', import.meta.url), 'utf8');
const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText.replaceAll("'./data-utils'", JSON.stringify(new URL('../lib/data-utils.ts', import.meta.url).href)).replaceAll("'./receipt-ai-config'", JSON.stringify(new URL('../lib/receipt-ai-config.ts', import.meta.url).href)).replaceAll("'@/lib/data-utils'", JSON.stringify(new URL('../lib/data-utils.ts', import.meta.url).href)).replaceAll("'@/lib/receipt-ai-config'", JSON.stringify(new URL('../lib/receipt-ai-config.ts', import.meta.url).href))
  .replace('"vinext/server/fetch-handler"', JSON.stringify(handlerUrl))
  .replace('"../lib/connector-context"', JSON.stringify(contextUrl))
  .replaceAll('import.meta.env.DEV', 'false');
const worker = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64')) as {
  secureResponse(request: Request, response: Response, development?: boolean): Response;
  default: { fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> };
};

test('worker secures page, API and MCP responses without changing status, content or connector binding', async () => {
  boundary.requests = [];
  boundary.bindings = [];
  const binding = { getContext: async () => ({ status: 'available' }) };
  for (const path of ['/', '/api/ledger', '/mcp', '/api/receipt?id=test']) {
    boundary.response = new Response('private response', { status: 200, headers: { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json' } });
    const response = await worker.default.fetch(new Request(`https://triptab.test${path}`), {}, { props: { CONNECTORS: binding } });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'private response');
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(response.headers.get('Content-Type'), 'application/json');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
    assert.equal(response.headers.get('Strict-Transport-Security'), 'max-age=31536000');
    const csp = response.headers.get('Content-Security-Policy')!;
    assert.match(csp, /frame-ancestors 'self' https:\/\/chatgpt\.com/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /worker-src 'self'/);
    assert.match(csp, /manifest-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-eval|connect-src[^;]*ws:/);
    assert.match(response.headers.get('Permissions-Policy')!, /camera=\(self\)/);
    assert.equal(response.headers.get('X-Frame-Options'), null, 'a contradictory SAMEORIGIN header would break ChatGPT embedding');
  }
  assert.equal(boundary.requests.length, 4);
  assert.deepEqual(boundary.bindings, Array(4).fill(binding));
});

test('security wrapper preserves redirects, distinct session cookies and stronger framework CSP', () => {
  const original = new Headers({ Location: '/?account=login', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
  original.append('Set-Cookie', 'tt_session=opaque; HttpOnly; SameSite=Lax');
  original.append('Set-Cookie', 'tt_signed_out=; Max-Age=0; HttpOnly');
  const response = worker.secureResponse(new Request('https://triptab.test/callback'), new Response(null, { status: 302, headers: original }));
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), '/?account=login');
  assert.ok(response.headers.get('Content-Security-Policy')!.startsWith("default-src 'none'; frame-ancestors 'none', "));
  assert.match(response.headers.get('Content-Security-Policy')!, /object-src 'none'/);
  assert.deepEqual(response.headers.getSetCookie(), original.getSetCookie());
});

test('local HTTP preview keeps development websocket support without emitting HSTS', () => {
  const request = new Request('http://127.0.0.1:5173/');
  const response = worker.secureResponse(request, new Response('preview'), true);
  assert.equal(response.headers.get('Strict-Transport-Security'), null);
  const csp = response.headers.get('Content-Security-Policy')!;
  assert.match(csp, /script-src[^;]*'unsafe-eval'/);
  assert.match(csp, /connect-src 'self' ws: wss:/);
});
