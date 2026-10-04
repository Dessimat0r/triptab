import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { ledgerEtag } from '../lib/ledger-freshness';

const sqlite = new DatabaseSync(':memory:');
sqlite.exec(`CREATE TABLE trips(id TEXT PRIMARY KEY, owner TEXT); CREATE TABLE memberships(trip_id TEXT, user_id TEXT); CREATE TABLE activity_events(sequence INTEGER PRIMARY KEY, trip_id TEXT);
INSERT INTO trips VALUES ('shared','alice'),('other','carol'); INSERT INTO memberships VALUES ('shared','bob'); INSERT INTO activity_events VALUES (1,'shared');`);
const database = { prepare(sql: string) { return { bind(...values: string[]) { return { async all() { return { results: sqlite.prepare(sql).all(...values) }; } }; } }; } } as unknown as D1Database;
let authenticated = true;
const boundary = { db: () => database, ensureProfile: async () => { if (!authenticated) throw Error('UNAUTHORIZED'); return { id: 'bob' }; }, readLedger: async () => ({ data: { trips: [] }, revision: 0 }), writeLedger: async () => ({}), sameOrigin: () => {}, readBoundedBody: async () => new Uint8Array(), failure: () => Response.json({ error: 'Sign in' }, { status: 401, headers: { 'Cache-Control': 'private, no-store' } }) };
Object.defineProperty(globalThis, Symbol.for('triptab.freshness-boundary'), { value: boundary, configurable: true });
const boundaryUrl = 'data:text/javascript;base64,' + Buffer.from(`const boundary=globalThis[Symbol.for('triptab.freshness-boundary')]; export const {db,ensureProfile,readLedger,writeLedger,sameOrigin,readBoundedBody,failure}=boundary;`).toString('base64');
const route = transpileModule(await readFile(new URL('../app/api/ledger/route.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText
  .replace("'@/lib/store'", JSON.stringify(boundaryUrl))
  .replace("'@/lib/ledger-freshness'", JSON.stringify(new URL('../lib/ledger-freshness.ts', import.meta.url).href));
const { HEAD } = await import('data:text/javascript;base64,' + Buffer.from(route).toString('base64')) as typeof import('../app/api/ledger/route');

test('freshness tag follows only visible trips and live membership', async () => {
  const before = await ledgerEtag(database, 'bob');
  assert.equal(await ledgerEtag(database, 'alice'), before);
  sqlite.prepare('INSERT INTO activity_events VALUES (?,?)').run(2, 'other');
  assert.equal(await ledgerEtag(database, 'bob'), before);
  sqlite.prepare('INSERT INTO activity_events VALUES (?,?)').run(3, 'shared');
  assert.notEqual(await ledgerEtag(database, 'bob'), before);
  sqlite.prepare('DELETE FROM memberships WHERE user_id=?').run('bob');
  assert.equal(await ledgerEtag(database, 'bob'), await ledgerEtag(database, 'nobody'));
  sqlite.prepare('INSERT INTO memberships VALUES (?,?)').run('shared','bob');
});
test('freshness detects lower-sequence membership loss and a trip without activity', async () => {
  sqlite.prepare('INSERT INTO memberships VALUES (?,?)').run('other', 'bob');
  sqlite.prepare('INSERT INTO activity_events VALUES (?,?)').run(4, 'other');
  const both = await ledgerEtag(database, 'bob');
  sqlite.prepare('DELETE FROM memberships WHERE trip_id=? AND user_id=?').run('shared', 'bob');
  const remaining = await ledgerEtag(database, 'bob');
  assert.notEqual(remaining, both);
  sqlite.prepare('INSERT INTO trips VALUES (?,?)').run('empty', 'bob');
  assert.notEqual(await ledgerEtag(database, 'bob'), remaining);
  sqlite.prepare('DELETE FROM trips WHERE id=?').run('empty');
  sqlite.prepare('DELETE FROM memberships WHERE trip_id=? AND user_id=?').run('other', 'bob');
  sqlite.prepare('INSERT INTO memberships VALUES (?,?)').run('shared', 'bob');
});
test('authenticated conditional HEAD returns no ledger body and private caching', async () => {
  authenticated = true;
  const tag = await ledgerEtag(database, 'bob');
  const response = await HEAD(new Request('https://triptab.test/api/ledger', { method: 'HEAD', headers: { 'If-None-Match': tag } }));
  assert.equal(response.status, 304); assert.equal(response.body, null);
  assert.equal(response.headers.get('etag'), tag); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const changed = await HEAD(new Request('https://triptab.test/api/ledger', { method: 'HEAD', headers: { 'If-None-Match': 'old' } }));
  assert.equal(changed.status, 200); assert.equal(changed.body, null);
});
test('anonymous HEAD reveals no activity tag or error body', async () => {
  authenticated = false;
  const response = await HEAD(new Request('https://triptab.test/api/ledger', { method: 'HEAD' }));
  assert.equal(response.status, 401); assert.equal(response.body, null); assert.equal(response.headers.get('etag'), null);
});
