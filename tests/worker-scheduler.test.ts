import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

class SQLiteStatement {
  private values: SQLInputValue[] = [];
  constructor(private readonly sqlite: DatabaseSync, readonly sql: string) {}
  bind(...values: SQLInputValue[]) { this.values = values; return this; }
  async first<T>() { return (this.sqlite.prepare(this.sql).get(...this.values) || null) as T | null; }
  async all<T>() { return { results: this.sqlite.prepare(this.sql).all(...this.values) as T[] }; }
  runSync() {
    const statement = this.sqlite.prepare(this.sql);
    const results = statement.columns().length ? statement.all(...this.values) : (statement.run(...this.values), []);
    return { results, meta: { changes: Number(this.sqlite.prepare('SELECT changes() AS count').get()!.count) } };
  }
  async run() { return this.runSync(); }
}
class SQLiteD1 {
  readonly sqlite = new DatabaseSync(':memory:');
  private pending: Promise<unknown> = Promise.resolve();
  prepare(sql: string) { return new SQLiteStatement(this.sqlite, sql); }
  batch(statements: D1PreparedStatement[]) {
    const operation = this.pending.then(() => {
      this.sqlite.exec('BEGIN');
      try {
        const results = statements.map(statement => (statement as unknown as SQLiteStatement).runSync());
        this.sqlite.exec('COMMIT'); return results;
      } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  asD1() { return this as unknown as D1Database; }
}
async function storage() {
  const database = new SQLiteD1();
  for (const file of (await readdir(new URL('../drizzle/', import.meta.url))).filter(name => name.endsWith('.sql')).sort()) {
    database.sqlite.exec(await readFile(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
  }
  database.sqlite.prepare('INSERT INTO trips (id,owner,data) VALUES (?,?,?)')
    .run('quiet-holiday', 'absent-owner', JSON.stringify({ expenses: [{ receiptId: 'attached-image' }], drafts: [] }));
  return database;
}
function image(database: SQLiteD1, id: string, state = 'active', createdAt = '2026-10-01T00:00:00Z') {
  database.sqlite.prepare('INSERT INTO receipts (id,owner,trip_id,state,created_at,content_type,size_bytes,sha256) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, 'absent-owner', 'quiet-holiday', state, createdAt, 'image/jpeg', 100, 'a'.repeat(64));
}
function dataUrl(source: string) { return 'data:text/javascript;base64,' + Buffer.from(source).toString('base64'); }
function compile(source: string) { return transpileModule(source, { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ESNext } }).outputText; }
const boundary = { requests: 0, connectors: 0 };
Object.defineProperty(globalThis, Symbol.for('triptab.scheduler-test'), { value: boundary, configurable: true });
const handlerUrl = dataUrl("export default {fetch(){globalThis[Symbol.for('triptab.scheduler-test')].requests++;return new Response('TripTab');}};");
const contextUrl = dataUrl("export function runWithConnectorBinding(binding,run){globalThis[Symbol.for('triptab.scheduler-test')].connectors++;return run();}");
const workerSource = compile(await readFile(new URL('../build/sites-worker.ts', import.meta.url), 'utf8'))
  .replace('"vinext/server/fetch-handler"', JSON.stringify(handlerUrl))
  .replace('"../lib/connector-context"', JSON.stringify(contextUrl))
  .replace('"../lib/receipt-lifecycle"', JSON.stringify(new URL('../lib/receipt-lifecycle.ts', import.meta.url).href))
  .replaceAll('import.meta.env.DEV', 'false');
const worker = (await import(dataUrl(workerSource)) as { default: {
  scheduled(controller: ScheduledController, env: unknown, ctx: unknown): Promise<void>;
} }).default;
const scheduledTime = Date.parse('2026-10-04T13:00:00Z');
function dispatch(env: unknown) {
  const pending: Promise<unknown>[] = [];
  const returned = worker.scheduled({ cron: '*/15 * * * *', scheduledTime, noRetry() {} } as ScheduledController, env, {
    waitUntil(task: Promise<unknown>) { pending.push(task); },
  });
  assert.equal(pending.length, 1, 'the actual Worker registers its cleanup lifetime with waitUntil');
  assert.equal(returned, pending[0], 'Cron observes the same cleanup failure directly from the handler');
  return returned;
}

test('scheduled Worker cleans a quiet holiday in bounded audited runs without participant or connector requests', async () => {
  const database = await storage();
  for (let index = 0; index < 21; index++) image(database, `old-image-${String(index).padStart(2, '0')}`);
  image(database, 'attached-image');
  image(database, 'recent-image', 'active', '2026-10-03T13:01:00Z');
  image(database, 'pending-image', 'pending');
  const removed: string[] = [];
  const env = { DB: database.asD1(), RECEIPTS: { async delete(key: string) { removed.push(key); } } };
  await dispatch(env);
  assert.equal(removed.length, 20, 'each scheduled invocation uses the system helper’s bounded default');
  const first = database.sqlite.prepare('SELECT * FROM activity_events ORDER BY sequence').all();
  assert.equal(first.length, 40);
  assert.ok(first.every(event => event.actor_id === 'system' && event.actor_name === 'TripTab' && event.source === 'system' && event.entity_type === 'receipt'));
  assert.equal(first.filter(event => event.action === 'update').length, 20);
  assert.equal(first.filter(event => event.action === 'delete').length, 20);
  assert.ok(first.filter(event => event.action === 'delete').every(event => JSON.parse(String(event.before_data)).deletionReason === 'orphan-expired'));
  await dispatch(env);
  assert.equal(removed.length, 21);
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM activity_events').get()!.count, 42);
  assert.deepEqual(database.sqlite.prepare('SELECT id FROM receipts ORDER BY id').all().map(row => row.id), ['attached-image', 'pending-image', 'recent-image']);
  await dispatch(env);
  assert.equal(removed.length, 21, 'repeated runs do not repeat completed deletes');
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM activity_events').get()!.count, 42);
  assert.equal(boundary.requests, 0);
  assert.equal(boundary.connectors, 0);
});

test('partial object deletion failure is reported safely and a later scheduled run completes the retained intent once', async () => {
  const database = await storage();
  image(database, 'retry-image');
  let fail = true;
  const env = { DB: database.asD1(), RECEIPTS: { async delete() { if (fail) throw new Error('PRIVATE_BUCKET/private-receipt-key'); } } };
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  try {
    console.warn = (...values: unknown[]) => { warnings.push(values); };
    await assert.rejects(dispatch(env), error => error instanceof Error && error.message === 'TripTab scheduled receipt cleanup did not complete.');
    assert.deepEqual(warnings, [['TripTab scheduled receipt cleanup did not complete.']]);
    assert.doesNotMatch(JSON.stringify(warnings), /PRIVATE_BUCKET|private-receipt-key|retry-image/);
    assert.equal(database.sqlite.prepare('SELECT state FROM receipts WHERE id=?').get('retry-image')!.state, 'deleting');
    assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM activity_events').get()!.count, 1);
    fail = false;
    await dispatch(env);
    const events = database.sqlite.prepare('SELECT action,before_data FROM activity_events ORDER BY sequence').all();
    assert.deepEqual(events.map(event => event.action), ['update', 'delete']);
    assert.equal(JSON.parse(String(events[1].before_data)).deletionReason, 'orphan-expired');
    assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM receipts WHERE id=?').get('retry-image')!.count, 0);
    await dispatch(env);
    assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM activity_events').get()!.count, 2);
  } finally { console.warn = originalWarn; }
});

test('scheduled database failures and missing bindings expose a generic failure without resource values', async () => {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  try {
    console.warn = (...values: unknown[]) => { warnings.push(values); };
    for (const env of [{}, { DB: { prepare() { throw new Error('PRIVATE_DATABASE_ID and financial contents'); } }, RECEIPTS: { delete() {} } }]) {
      await assert.rejects(dispatch(env), error => error instanceof Error && error.message === 'TripTab scheduled receipt cleanup did not complete.');
    }
    assert.equal(warnings.length, 2);
    assert.ok(warnings.every(values => values.length === 1 && values[0] === 'TripTab scheduled receipt cleanup did not complete.'));
    assert.doesNotMatch(JSON.stringify(warnings), /PRIVATE_DATABASE_ID|financial contents/);
  } finally { console.warn = originalWarn; }
});

test('portable and managed Worker configurations retain a real 15-minute UTC Cron declaration for build and preview', async () => {
  const source = await readFile(new URL('../vite.config.ts', import.meta.url), 'utf8');
  const pluginUrl = dataUrl('export default ()=>({name:"vinext-fixture"}); export function sites(options){return {name:"sites-fixture",options};} export function connectorPreview(){return {name:"connector-fixture"};}');
  const viteUrl = dataUrl('export const defineConfig=config=>config;');
  const cloudflareUrl = dataUrl('export function cloudflare(options){return {name:"cloudflare-fixture",options};}');
  const hostingUrl = dataUrl('export default {d1:"DB",r2:"RECEIPTS"};');
  const flags = ['CLOUDFLARE_CF_FETCH_ENABLED', 'WRANGLER_SEND_METRICS', 'WRANGLER_WRITE_LOGS', 'WRANGLER_LOG_PATH', 'WRANGLER_REGISTRY_PATH', 'MINIFLARE_REGISTRY_PATH'];
  const previous = flags.map(name => [name, process.env[name]] as const);
  try {
    for (const profile of ['portable', 'managed-linux']) {
      const profileUrl = dataUrl(`export const readExecutionProfile=()=>${JSON.stringify(profile)};`);
      const compiled = compile(source)
        .replace('"vinext"', JSON.stringify(pluginUrl)).replace('"vite"', JSON.stringify(viteUrl))
        .replace('"./.openai/hosting.json"', JSON.stringify(hostingUrl))
        .replace('"./scripts/execution-profile.mjs"', JSON.stringify(profileUrl))
        .replace('"./build/sites-vite-plugin"', JSON.stringify(pluginUrl))
        .replace('"./build/connector-preview-plugin.mjs"', JSON.stringify(pluginUrl))
        .replace('"@cloudflare/vite-plugin"', JSON.stringify(cloudflareUrl));
      const configure = (await import(dataUrl(compiled)) as { default: (context: { command: string }) => Promise<{ plugins: { name: string; options?: { config?: Record<string, unknown> } }[] }> }).default;
      for (const command of ['serve', 'build']) {
        const config = (await configure({ command })).plugins.find(plugin => plugin.name === 'cloudflare-fixture')!.options!.config!;
        assert.deepEqual(config.triggers, { crons: ['*/15 * * * *'] });
        assert.equal(config.main, './build/sites-worker.ts');
        assert.deepEqual(config.d1_databases, [{ binding: 'DB', database_name: 'site-creator-d1', database_id: '00000000-0000-4000-8000-000000000000' }]);
        assert.deepEqual(config.r2_buckets, [{ binding: 'RECEIPTS', bucket_name: 'site-creator-r2' }]);
        assert.equal(Boolean(config.services), command === 'serve');
      }
    }
  } finally {
    for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});
