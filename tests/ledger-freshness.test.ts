import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { ledgerEtag, ledgerTagMatches, readLedgerFreshness } from '../lib/ledger-freshness';

const sqlite = new DatabaseSync(':memory:');
sqlite.exec(`CREATE TABLE trips(id TEXT PRIMARY KEY, owner TEXT, receipt_link_version INTEGER NOT NULL DEFAULT 0); CREATE INDEX trips_owner_idx ON trips(owner);
CREATE TABLE memberships(trip_id TEXT, user_id TEXT, member_id TEXT); CREATE INDEX memberships_user_idx ON memberships(user_id);
CREATE UNIQUE INDEX memberships_trip_user_idx ON memberships(trip_id,user_id);
CREATE TABLE profiles(id TEXT PRIMARY KEY,email TEXT); CREATE TABLE sync_state(id INTEGER PRIMARY KEY,revision INTEGER);
CREATE TABLE activity_events(sequence INTEGER PRIMARY KEY, trip_id TEXT); CREATE INDEX activity_events_trip_sequence_idx ON activity_events(trip_id,sequence);
INSERT INTO trips(id,owner) VALUES ('shared','alice'),('other','carol'); INSERT INTO memberships VALUES ('shared','bob','b');
INSERT INTO profiles VALUES ('bob','bob@example.test'),('carol','carol@example.test');
INSERT INTO sync_state VALUES(1,7); INSERT INTO activity_events VALUES (1,'shared');`);
const queries: string[] = [];
const database = {
  prepare(sql: string) {
    let values: unknown[] = [];
    return { bind(...incoming: unknown[]) { values = incoming; return this; },
      async all() { queries.push(sql); return { results: sqlite.prepare(sql).all(...values as (string | number)[]) }; } };
  },
  async batch(statements: { all(): Promise<unknown> }[]) {
    sqlite.exec('BEGIN');
    try { const results = await Promise.all(statements.map(statement => statement.all())); sqlite.exec('COMMIT'); return results; }
    catch(error) { sqlite.exec('ROLLBACK'); throw error; }
  },
} as unknown as D1Database;
let authenticated = true;
let snapshotCalls = 0;
const boundary = {
  db: () => database,
  ensureProfile: async () => { if (!authenticated) throw Error('UNAUTHORIZED'); return { id: 'bob' }; },
  readLedgerSnapshot: async () => {
    snapshotCalls++;
    const versions = sqlite.prepare(`SELECT t.id,t.receipt_link_version AS dataVersion,COALESCE(MAX(e.sequence),0) AS latest FROM trips t
      LEFT JOIN activity_events e ON e.trip_id=t.id WHERE t.owner='bob' OR t.id IN (SELECT trip_id FROM memberships WHERE user_id='bob')
      GROUP BY t.id ORDER BY t.id`).all();
    const links = sqlite.prepare(`SELECT m.trip_id,m.user_id,m.member_id,p.email FROM memberships m LEFT JOIN profiles p ON p.id=m.user_id
      WHERE m.trip_id IN (SELECT trip_id FROM memberships WHERE user_id='bob') ORDER BY m.trip_id,m.member_id,m.user_id`).all();
    return { data: { trips: [] }, revision: Number(sqlite.prepare('SELECT revision FROM sync_state').get()?.revision), freshness: { versions, links } };
  },
  writeLedger: async (_user: string, _data: unknown, _revision: unknown, options: { includeFreshness?: boolean }) => {
    assert.equal(options.includeFreshness, true, 'the route requests freshness from the write response snapshot');
    return boundary.readLedgerSnapshot();
  }, sameOrigin: () => {}, readBoundedBody: async () => new TextEncoder().encode(JSON.stringify({ data: { trips: [] }, revision: 19 })),
  failure: () => Response.json({ error: 'Sign in' }, { status: 401, headers: { 'Cache-Control': 'private, no-store' } }),
};
Object.defineProperty(globalThis, Symbol.for('triptab.freshness-boundary'), { value: boundary, configurable: true });
const boundaryUrl = 'data:text/javascript;base64,' + Buffer.from(`const boundary=globalThis[Symbol.for('triptab.freshness-boundary')]; export const {db,ensureProfile,readLedgerSnapshot,writeLedger,sameOrigin,readBoundedBody,failure}=boundary;`).toString('base64');
const route = transpileModule(await readFile(new URL('../app/api/ledger/route.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText.replaceAll("'./data-utils'", JSON.stringify(new URL('../lib/data-utils.ts', import.meta.url).href)).replaceAll("'./receipt-ai-config'", JSON.stringify(new URL('../lib/receipt-ai-config.ts', import.meta.url).href)).replaceAll("'@/lib/data-utils'", JSON.stringify(new URL('../lib/data-utils.ts', import.meta.url).href)).replaceAll("'@/lib/receipt-ai-config'", JSON.stringify(new URL('../lib/receipt-ai-config.ts', import.meta.url).href))
  .replace("'@/lib/store'", JSON.stringify(boundaryUrl))
  .replace("'@/lib/ledger-freshness'", JSON.stringify(new URL('../lib/ledger-freshness.ts', import.meta.url).href));
const { GET, HEAD, POST } = await import('data:text/javascript;base64,' + Buffer.from(route).toString('base64')) as typeof import('../app/api/ledger/route');

test('freshness tag follows only visible trips and live membership', async () => {
  const before = await ledgerEtag(database, 'bob');
  assert.equal(await ledgerEtag(database, 'alice'), before);
  sqlite.prepare('INSERT INTO activity_events VALUES (?,?)').run(2, 'other');
  assert.equal(await ledgerEtag(database, 'bob'), before);
  sqlite.prepare('INSERT INTO activity_events VALUES (?,?)').run(3, 'shared');
  assert.notEqual(await ledgerEtag(database, 'bob'), before);
  sqlite.prepare('DELETE FROM memberships WHERE user_id=?').run('bob');
  assert.equal(await ledgerEtag(database, 'bob'), await ledgerEtag(database, 'nobody'));
  sqlite.prepare('INSERT INTO memberships VALUES (?,?,?)').run('shared','bob','b');
});
test('freshness detects lower-sequence membership loss and a trip without activity', async () => {
  sqlite.prepare('INSERT INTO memberships VALUES (?,?,?)').run('other', 'bob', 'b');
  sqlite.prepare('INSERT INTO activity_events VALUES (?,?)').run(4, 'other');
  const both = await ledgerEtag(database, 'bob');
  sqlite.prepare('DELETE FROM memberships WHERE trip_id=? AND user_id=?').run('shared', 'bob');
  const remaining = await ledgerEtag(database, 'bob');
  assert.notEqual(remaining, both);
  sqlite.prepare('INSERT INTO trips(id,owner) VALUES (?,?)').run('empty', 'bob');
  assert.notEqual(await ledgerEtag(database, 'bob'), remaining);
  sqlite.prepare('DELETE FROM trips WHERE id=?').run('empty');
  sqlite.prepare('DELETE FROM memberships WHERE trip_id=? AND user_id=?').run('other', 'bob');
  sqlite.prepare('INSERT INTO memberships VALUES (?,?,?)').run('shared', 'bob', 'b');
});
test('freshness tracks the authoritative member email overlay without leaking another account', async () => {
  const before = await ledgerEtag(database, 'bob');
  sqlite.prepare('UPDATE profiles SET email=? WHERE id=?').run('private@example.test','carol');
  assert.equal(await ledgerEtag(database,'bob'), before);
  sqlite.prepare('UPDATE profiles SET email=? WHERE id=?').run('updated@example.test','bob');
  assert.notEqual(await ledgerEtag(database,'bob'), before);
});
test('visible body versions invalidate tags without activity while unrelated bodies and global CAS advances do not', async () => {
  const initial = await ledgerEtag(database,'bob');
  sqlite.prepare('UPDATE trips SET receipt_link_version=receipt_link_version+1 WHERE id=?').run('other');
  sqlite.prepare('UPDATE sync_state SET revision=revision+1').run();
  assert.equal(await ledgerEtag(database,'bob'),initial);
  sqlite.prepare('UPDATE trips SET receipt_link_version=receipt_link_version+1 WHERE id=?').run('shared');
  assert.notEqual(await ledgerEtag(database,'bob'),initial);
});
test('orphan membership metadata cannot change an otherwise empty accessible ledger tag', async () => {
  const before=await ledgerEtag(database,'nobody');
  sqlite.prepare('INSERT INTO memberships VALUES(?,?,?)').run('missing-trip','nobody','unknown');
  assert.equal(await ledgerEtag(database,'nobody'),before);
  sqlite.prepare('DELETE FROM memberships WHERE trip_id=?').run('missing-trip');
});
test('unchanged conditional GET skips the ledger body and returns the latest global revision', async () => {
  authenticated = true;
  const tag = await ledgerEtag(database,'bob');
  sqlite.prepare('UPDATE sync_state SET revision=19').run();
  const calls = snapshotCalls; queries.length = 0;
  const response = await GET(new Request('https://triptab.test/api/ledger',{headers:{'If-None-Match':tag}}));
  assert.equal(response.status,304); assert.equal(response.body,null); assert.equal(snapshotCalls,calls);
  assert.equal(response.headers.get('etag'),tag); assert.equal(response.headers.get('x-ledger-revision'),'19');
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.equal(queries.length,3); assert.ok(queries.every(sql=>!sql.includes('t.data')));
});
test('full GET uses its body snapshot tag and preserves the public ledger shape', async () => {
  authenticated = true;
  const calls = snapshotCalls; queries.length = 0;
  const response = await GET(new Request('https://triptab.test/api/ledger'));
  assert.equal(response.status,200); assert.equal(snapshotCalls,calls+1); assert.equal(queries.length,0);
  assert.deepEqual(await response.json(),{data:{trips:[]},revision:19});
  assert.equal(response.headers.get('etag'),await ledgerEtag(database,'bob'));
  assert.equal(response.headers.get('x-ledger-revision'),'19');
});
test('a save response retains a coherent conditional-refresh tag without a second metadata or body read', async () => {
  authenticated = true;
  const calls = snapshotCalls; queries.length = 0;
  const response = await POST(new Request('https://triptab.test/api/ledger', { method: 'POST' }));
  assert.equal(response.status, 200); assert.equal(snapshotCalls, calls + 1);
  assert.equal(queries.length, 0, 'no separate freshness read after the response snapshot');
  assert.deepEqual(await response.json(), { data: { trips: [] }, revision: 19 }, 'internal freshness stays out of the API body');
  const tag = response.headers.get('etag'); assert.equal(tag, await ledgerEtag(database, 'bob'));
  assert.equal(response.headers.get('x-ledger-revision'), '19');
  const conditional = await GET(new Request('https://triptab.test/api/ledger', { headers: { 'If-None-Match': tag! } }));
  assert.equal(conditional.status, 304); assert.equal(snapshotCalls, calls + 1);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});
test('authenticated conditional HEAD returns no ledger body and private caching', async () => {
  authenticated = true;
  const tag = await ledgerEtag(database, 'bob');
  const response = await HEAD(new Request('https://triptab.test/api/ledger', { method: 'HEAD', headers: { 'If-None-Match': tag } }));
  assert.equal(response.status, 304); assert.equal(response.body, null);
  assert.equal(response.headers.get('etag'), tag); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-ledger-revision'),'19');
  const changed = await HEAD(new Request('https://triptab.test/api/ledger', { method: 'HEAD', headers: { 'If-None-Match': 'old' } }));
  assert.equal(changed.status, 200); assert.equal(changed.body, null);
});
test('anonymous GET and HEAD reveal no freshness metadata', async () => {
  authenticated = false;
  for(const handler of [GET,HEAD]) {
    const response = await handler(new Request('https://triptab.test/api/ledger'));
    assert.equal(response.status,401); assert.equal(response.headers.get('etag'),null); assert.equal(response.headers.get('x-ledger-revision'),null);
    if(handler===HEAD) assert.equal(response.body,null);
  }
});
test('If-None-Match accepts weak/strong lists and wildcard without accepting another tag', () => {
  const tag='W/"triptab-version"';
  assert.equal(ledgerTagMatches('"other", "triptab-version"',tag),true);
  assert.equal(ledgerTagMatches('*',tag),true);
  assert.equal(ledgerTagMatches('W/"another"',tag),false);
  assert.equal(ledgerTagMatches(null,tag),false);
});
test('metadata reads drive indexed visible IDs and seek the latest event', async () => {
  queries.length=0;
  await readLedgerFreshness(database,'bob');
  for(const sql of queries.filter(sql=>sql.includes('FROM trips WHERE owner'))) {
    const plan=sqlite.prepare('EXPLAIN QUERY PLAN '+sql).all('bob','bob').map(row=>String(row.detail));
    assert.ok(plan.some(line=>line.includes('trips_owner_idx') && line.includes('SEARCH')));
    assert.ok(plan.some(line=>line.includes('memberships_user_idx') && line.includes('SEARCH')));
    assert.ok(!plan.some(line=>/^SCAN (t|m|e)\b/.test(line)),JSON.stringify(plan));
  }
  assert.ok(queries[0].includes('ORDER BY e.sequence DESC LIMIT 1'));
});
