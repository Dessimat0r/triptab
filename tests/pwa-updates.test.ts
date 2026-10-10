import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
type WorkerEvent = { waitUntil(task: Promise<unknown>): void; request?: Request; respondWith?(task: Promise<Response>): void };
function worker(cacheAssets: () => Promise<void> = async () => {}) {
  const events = new Map<string, (event: WorkerEvent) => void>();
  const calls: string[] = [];
  let cached!: () => void;
  const caching = new Promise<void>(resolve => { cached = resolve; });
  const offline = new Response('Offline screen');
  let disconnected = false;
  const self = {
    location: { origin: 'https://triptab.test' },
    addEventListener(name: string, handler: (event: WorkerEvent) => void) { events.set(name, handler); },
    async skipWaiting() { calls.push('activate'); },
    clients: { async claim() { calls.push('claim'); } },
  };
  const caches = {
    async open() { return { async addAll(urls: string[]) { assert(urls.includes('/offline.html')); assert(urls.every(url => url === '/offline.html' || url === '/offline-store.js' || url === '/offline-capture.js' || url.startsWith('/icons/'))); calls.push('cache'); cached(); await cacheAssets(); } }; },
    async keys() { return ['triptab-public-v4', 'triptab-public-v6', 'unrelated-cache']; },
    async delete(key: string) { calls.push(`delete:${key}`); return true; },
    async match() { return offline; },
  };
  vm.runInNewContext(source, { importScripts() {}, self, caches, URL, Response, AbortController, setTimeout, clearTimeout, fetch: async () => {
    if (disconnected) throw Error('offline'); return new Response('Current server page');
  } });
  async function lifecycle(name: string) {
    let task: Promise<unknown> | undefined;
    events.get(name)!({ waitUntil(value) { task = value; } }); await task;
  }
  function request(path: string, navigate = false) {
    const request = new Request(`https://triptab.test${path}`);
    if (navigate) Object.defineProperty(request, 'mode', { value: 'navigate' });
    let result: Promise<Response> | undefined;
    events.get('fetch')!({ request, waitUntil() {}, respondWith(value) { result = value; } });
    return result;
  }
  return { calls, caching, lifecycle, request, disconnect() { disconnected = true; } };
}

test('worker activates only after offline assets are cached and retains unrelated caches', async () => {
  let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  const fixture = worker(() => held), installing = fixture.lifecycle('install');
  await fixture.caching;
  assert.deepEqual(fixture.calls, ['cache']); finish(); await installing;
  assert.deepEqual(fixture.calls, ['cache', 'activate']);
  await fixture.lifecycle('activate');
  assert.deepEqual(fixture.calls, ['cache', 'activate', 'delete:triptab-public-v4', 'claim']);
});

test('failed offline asset caching leaves the current worker active', async () => {
  const fixture = worker(async () => { throw Error('asset unavailable'); });
  await assert.rejects(fixture.lifecycle('install'), /asset unavailable/);
  assert.deepEqual(fixture.calls, ['cache']);
});

test('silent updates preserve network-only private data and the offline navigation fallback', async () => {
  const fixture = worker();
  for (const path of ['/api/ledger', '/api/receipt?id=private', '/assets/app.js', '/expenses']) {
    assert.equal(fixture.request(path), undefined, `${path} stays outside the worker cache`);
  }
  assert.equal(await (await fixture.request('/expenses', true))!.text(), 'Current server page');
  fixture.disconnect();
  assert.equal(await (await fixture.request('/expenses', true))!.text(), 'Offline screen');
});
