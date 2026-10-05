import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseOwnerTransferOptions, runOwnerTransfer, transferReceiptAIOwner, validateOwnerTransferConfig } from '../scripts/transfer-receipt-ai-owner';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';

async function createOwnerTransferDatabase() {
  const worker = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("isolated operator test"); } };',
    compatibilityDate: '2026-05-15', d1Databases: { DB: 'owner-transfer-test' }, d1Persist: false, log: new Log(LogLevel.NONE) });
  try {
    const db = await worker.getD1Database('DB');
    for (const name of (await readdir(new URL('../drizzle/', import.meta.url))).filter(file => file.endsWith('.sql')).sort()) {
      for (const sql of unstable_splitSqlQuery(await readFile(new URL('../drizzle/' + name, import.meta.url), 'utf8'))) await db.prepare(sql).run();
    }
    await db.prepare('INSERT INTO profiles(id,email,display_name,created_at) VALUES(?,?,?,?)').bind('flow-owner', 'old-owner@example.test', 'Old Owner', new Date().toISOString()).run();
    return { db, owner: { id: 'flow-owner' }, dispose: () => worker.dispose() };
  } catch (error) { await worker.dispose(); throw error; }
}

const databaseId = '22222222-2222-4222-8222-222222222222';
const flags = ['--config', '/secure/owner-transfer.json', '--database-id', databaseId, '--expected-owner', 'flow-owner', '--expected-version', '3', '--new-owner', 'new-owner', '--owner-email', ' NEW-OWNER@EXAMPLE.TEST ', '--local', '--persist-to', '/private/local-state'];
const config = { name: 'triptab-owner-transfer', compatibility_date: '2026-05-15', compatibility_flags: ['nodejs_compat'], d1_databases: [{ binding: 'DB', database_name: 'operator-db', database_id: databaseId, remote: false }] };

test('operator argument and config guards require explicit database/mode/version/owner and reject credential-bearing app configs', () => {
  const options = parseOwnerTransferOptions(flags);
  assert.equal(options.apply, false); assert.equal(options.ownerEmail, 'new-owner@example.test');
  validateOwnerTransferConfig(config, options);
  for (const args of [[], [...flags, '--apply', '--apply'], [...flags, '--remote'], flags.slice(0, -2), [...flags.slice(0, 7), '0', ...flags.slice(8)], [...flags, '--api-key', 'NEVER_ACCEPT_KEY']]) assert.throws(() => parseOwnerTransferOptions(args));
  for (const unsafe of [{ ...config, vars: { OPENAI_API_KEY: 'NEVER_READ_KEY' } }, { ...config, main: 'app-worker.ts' }, { ...config, env: {} }, { ...config, d1_databases: [{ ...config.d1_databases[0], database_id: 'wrong' }] }, { ...config, d1_databases: [{ ...config.d1_databases[0], remote: true }] }, { ...config, r2_buckets: [] }]) assert.throws(() => validateOwnerTransferConfig(unsafe, options));
  const remote = parseOwnerTransferOptions([...flags.slice(0, -3), '--remote', '--account-id', 'a'.repeat(32)]);
  assert.throws(() => validateOwnerTransferConfig({ ...config, account_id: 'b'.repeat(32), d1_databases: [{ ...config.d1_databases[0], remote: true }] }, remote));
  validateOwnerTransferConfig({ ...config, account_id: 'a'.repeat(32), d1_databases: [{ ...config.d1_databases[0], remote: true }] }, remote);
});

test('native D1 operator preflight is read-only, transfer clears ciphertext, and canonical/version/audit guards preserve atomicity', async () => {
  const fixture = await createOwnerTransferDatabase();
  try {
    const now = new Date().toISOString();
    await fixture.db.batch([
      fixture.db.prepare('INSERT INTO profiles(id,email,display_name,created_at) VALUES(?,?,?,?)').bind('new-owner', 'new-owner@example.test', 'New Owner', now),
      fixture.db.prepare('INSERT INTO auth_links(oai_user_id,user_id,created_at) VALUES(?,?,?)').bind('new-verified-provider', 'new-owner', now),
      fixture.db.prepare('INSERT INTO receipt_ai_settings(id,user_id,api_key_encrypted,provider,version) VALUES(?,?,?,?,?)').bind('shared', fixture.owner.id, 'NEVER_DISCLOSE_CIPHERTEXT', 'siwc', 3),
    ]);
    const options = parseOwnerTransferOptions(flags);
    const metadata = () => fixture.db.prepare("SELECT user_id,version,provider,api_key_encrypted IS NOT NULL AS key_configured FROM receipt_ai_settings WHERE id='shared'").first();
    const auditCount = async () => (await fixture.db.prepare('SELECT COUNT(*) AS count FROM account_activity_events').first<{ count: number }>())!.count;
    const before = await metadata(), events = await auditCount();
    assert.deepEqual(await transferReceiptAIOwner(fixture.db, options), { dryRun: true, transferable: true, version: 3, keyConfigured: true, provider: 'siwc' });
    assert.deepEqual(await metadata(), before); assert.equal(await auditCount(), events);
    for (const change of [{ expectedUserId: 'different-account' }, { expectedVersion: 4 }, { ownerEmail: 'wrong@example.test' }]) await assert.rejects(transferReceiptAIOwner(fixture.db, { ...options, ...change, apply: true }), /does not match/);
    await fixture.db.prepare("CREATE TRIGGER reject_transfer_audit BEFORE INSERT ON account_activity_events WHEN NEW.source='system' BEGIN SELECT RAISE(ABORT,'reject transfer audit'); END").run();
    await assert.rejects(transferReceiptAIOwner(fixture.db, { ...options, apply: true }));
    assert.deepEqual(await metadata(), before); assert.equal(await auditCount(), events);
    await fixture.db.prepare('DROP TRIGGER reject_transfer_audit').run();
    const result = await transferReceiptAIOwner(fixture.db, { ...options, apply: true });
    assert.deepEqual(result, { dryRun: false, migrated: true, version: 4, keyConfigured: false });
    assert.doesNotMatch(JSON.stringify(result), /NEVER_DISCLOSE|api_key|new-owner@example/);
    assert.deepEqual(await metadata(), { user_id: 'new-owner', version: 4, provider: 'api', key_configured: 0 });
    assert.equal(await auditCount(), events + 1);
    await assert.rejects(transferReceiptAIOwner(fixture.db, { ...options, apply: true }), /does not match/);
  } finally { await fixture.dispose(); }
});

test('runnable local operator command uses an isolated native D1 binding and refuses adjacent environment files before access', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'triptab-operator-'));
  try {
    const configPath = join(folder, 'operator.json'), persistTo = join(folder, 'state');
    await writeFile(configPath, JSON.stringify(config));
    const args = flags.map((value, index) => index === 1 ? configPath : index === flags.length - 1 ? persistTo : value);
    await writeFile(join(folder, '.dev.vars'), 'OPENAI_API_KEY=NEVER_READ_KEY');
    await assert.rejects(runOwnerTransfer(args), /without application environment/);
    await rm(join(folder, '.dev.vars'));
    await writeFile(configPath, JSON.stringify({ ...config, account_id: 'a'.repeat(32), d1_databases: [{ ...config.d1_databases[0], remote: true }] }));
    const savedAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
    try {
      process.env.CLOUDFLARE_ACCOUNT_ID = 'b'.repeat(32);
      await assert.rejects(runOwnerTransfer([...args.slice(0, -3), '--remote', '--account-id', 'a'.repeat(32)]), /account environment does not match/);
    } finally {
      if (savedAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID; else process.env.CLOUDFLARE_ACCOUNT_ID = savedAccount;
      await writeFile(configPath, JSON.stringify(config));
    }
    const { getPlatformProxy } = await import('wrangler');
    const proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath, persist: { path: persistTo }, remoteBindings: false, envFiles: [] });
    try {
      const db = proxy.env.DB;
      await db.batch([
        db.prepare('CREATE TABLE profiles(id TEXT PRIMARY KEY,email TEXT)'), db.prepare('CREATE TABLE auth_links(oai_user_id TEXT,user_id TEXT)'),
        db.prepare('CREATE TABLE receipt_ai_settings(id TEXT PRIMARY KEY,user_id TEXT,api_key_encrypted TEXT,provider TEXT,version INTEGER)'),
        db.prepare('CREATE TABLE account_activity_events(id TEXT,user_id TEXT,actor_name TEXT,created_at TEXT,entity_type TEXT,entity_id TEXT,action TEXT,before_data TEXT,after_data TEXT,source TEXT)'),
      ]);
      await db.batch([
        db.prepare('INSERT INTO profiles VALUES(?,?)').bind('new-owner', 'new-owner@example.test'),
        db.prepare('INSERT INTO auth_links VALUES(?,?)').bind('verified-provider', 'new-owner'),
        db.prepare('INSERT INTO receipt_ai_settings VALUES(?,?,?,?,?)').bind('shared', 'flow-owner', 'NEVER_DISCLOSE_CIPHERTEXT', 'api', 3),
      ]);
    } finally { await proxy.dispose(); }
    const invoke = async (argv: string[]) => {
      const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../scripts/transfer-receipt-ai-owner.ts', import.meta.url)), ...argv],
        { cwd: fileURLToPath(new URL('../', import.meta.url)), env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_CF_FETCH_ENABLED: 'false' } });
      assert.doesNotMatch(result.stdout + result.stderr, /NEVER_DISCLOSE|NEVER_READ|new-owner@example\.test/);
      return JSON.parse(result.stdout) as Record<string, unknown>;
    };
    assert.deepEqual(await invoke(args), { dryRun: true, transferable: true, version: 3, keyConfigured: true, provider: 'api' });
    const readState = async () => {
      const proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath, persist: { path: persistTo }, remoteBindings: false, envFiles: [] });
      try { return { settings: await proxy.env.DB.prepare("SELECT user_id,version,api_key_encrypted IS NOT NULL AS key_configured FROM receipt_ai_settings WHERE id='shared'").first(),
        audits: (await proxy.env.DB.prepare('SELECT COUNT(*) AS count FROM account_activity_events').first<{ count: number }>())!.count }; }
      finally { await proxy.dispose(); }
    };
    assert.deepEqual(await readState(), { settings: { user_id: 'flow-owner', version: 3, key_configured: 1 }, audits: 0 });
    assert.deepEqual(await invoke([...args, '--apply']), { dryRun: false, migrated: true, version: 4, keyConfigured: false });
    assert.deepEqual(await readState(), { settings: { user_id: 'new-owner', version: 4, key_configured: 0 }, audits: 1 });
    const helper = await readFile(new URL('../lib/receipt-ai-access.ts', import.meta.url), 'utf8');
    const migration = helper.slice(helper.indexOf('export async function migrateReceiptAIOwner'), helper.indexOf('export async function receiptAIStatus'));
    assert.doesNotMatch(migration, /SELECT[^\n]*api_key_encrypted,/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
