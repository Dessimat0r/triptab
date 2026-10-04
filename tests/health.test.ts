import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

let sqlite: DatabaseSync;
let receiptBinding = true;
const binding = { db: () => ({ prepare: (sql: string) => ({ all: async () => ({ results: sqlite.prepare(sql).all() }) }) }), bucket: () => { if (!receiptBinding) throw Error('Missing secret resource'); return { get() {}, put() {}, delete() {} }; } };
Object.defineProperty(globalThis, Symbol.for('triptab.health-test'), { value: binding, configurable: true });
const boundary = 'data:text/javascript;base64,' + Buffer.from("export const {db,bucket}=globalThis[Symbol.for('triptab.health-test')];").toString('base64');
const compiled = transpileModule(await readFile(new URL('../app/healthz/route.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText.replace("'@/lib/store'", JSON.stringify(boundary));
const { GET } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64')) as typeof import('../app/healthz/route');

test('readiness passes with the complete schema and receipt capability without exposing data', async () => {
  sqlite = new DatabaseSync(':memory:'); receiptBinding = true;
  for (const name of (await readdir(new URL('../drizzle/', import.meta.url))).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(await readFile(new URL('../drizzle/' + name, import.meta.url), 'utf8'));
  const response = await GET(); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 'ready' }); assert.equal(response.headers.get('cache-control'), 'no-store');
});
test('missing migration produces a generic unavailable status instead of a false healthy result', async () => {
  sqlite = new DatabaseSync(':memory:'); sqlite.exec('CREATE TABLE receipts(id TEXT); CREATE TABLE activity_events(sequence INTEGER);'); receiptBinding = true;
  const response = await GET(); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { status: 'unavailable' });
});
test('missing receipt binding also fails readiness without disclosing internal details', async () => {
  sqlite = new DatabaseSync(':memory:'); sqlite.exec('CREATE TABLE receipts(state TEXT,created_at TEXT); CREATE TABLE activity_events(sequence INTEGER);'); receiptBinding = false;
  const response = await GET(); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { status: 'unavailable' });
});
