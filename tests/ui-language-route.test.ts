import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { ModuleKind, transpileModule } from 'typescript';
import { storage } from './helpers/sqlite-d1';
import * as audit from '../lib/audit';

class RequestError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const source = transpileModule(readFileSync(new URL('../app/api/interface-language/route.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS },
}).outputText;
async function fixture(beforeBatch?: (database: Awaited<ReturnType<typeof storage>>) => void) {
  const database = await storage();
  database.sqlite.prepare("INSERT INTO profiles(id,email,display_name,created_at,ui_language) VALUES ('alice','alice@example.test','Alice','2026-10-10','fr')").run();
  const native = database.asD1();
  database.beforeBatch = () => beforeBatch?.(database);
  const loaded = { exports: {} as { POST(request: Request): Promise<Response> } };
  new Function('require', 'module', 'exports', source)((name: string) => name === '@/lib/audit' ? audit : {
    db: () => native, ensureProfile: async () => ({ id: 'alice', displayName: 'Alice' }),
    sameOrigin() {}, readBoundedBody: async (request: Request) => new Uint8Array(await request.arrayBuffer()),
    RequestError, failure: (error: RequestError) => Response.json({ error: error.message }, { status: error.status || 500 }),
  }, loaded, loaded.exports);
  const post = (language: string, accountId = 'alice') => loaded.exports.POST(new Request('https://triptab.test/api/interface-language', {
    method: 'POST', body: JSON.stringify({ language, accountId }),
  }));
  return { database, post };
}

test('interface preferences record an actual change once and reject another account', async () => {
  const { database, post } = await fixture();
  assert.equal((await post('de')).status, 200);
  assert.equal((await post('de')).status, 200);
  assert.equal((await post('es', 'bob')).status, 409);
  assert.equal(database.sqlite.prepare("SELECT ui_language FROM profiles WHERE id='alice'").get()?.ui_language, 'de');
  const events = database.sqlite.prepare('SELECT before_data,after_data FROM account_activity_events').all();
  assert.equal(events.length, 1);
  assert.deepEqual(JSON.parse(String(events[0].before_data)), { language: 'fr' });
  assert.deepEqual(JSON.parse(String(events[0].after_data)), { language: 'de' });
});

test('a competing preference change cannot produce a false before/after entry', async () => {
  const { database, post } = await fixture(database => {
    database.sqlite.prepare("UPDATE profiles SET ui_language='de' WHERE id='alice'").run();
  });
  assert.equal((await post('es')).status, 409);
  assert.equal(database.sqlite.prepare("SELECT ui_language FROM profiles WHERE id='alice'").get()?.ui_language, 'de');
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM account_activity_events').get()?.count, 0);
});

test('a preference request already in flight cannot restore private history after deletion', async () => {
  const { database, post } = await fixture(database => {
    database.sqlite.prepare("UPDATE profiles SET ui_language='en',deleted_at='2026-10-10' WHERE id='alice'").run();
    database.sqlite.prepare("DELETE FROM account_activity_events WHERE user_id='alice'").run();
  });
  assert.equal((await post('es')).status, 401);
  assert.equal(database.sqlite.prepare("SELECT ui_language FROM profiles WHERE id='alice'").get()?.ui_language, 'en');
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM account_activity_events').get()?.count, 0);
});
