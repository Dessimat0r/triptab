import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { createFetchMock, Log, LogLevel, Miniflare } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';

const owner = { id: 'native-owner', email: 'dessimat0r@gmail.com', displayName: 'Native owner' };
const member = { id: 'native-member', email: 'member@example.test', displayName: 'Native member' };
const originalKey = 'sk-native-' + 'A'.repeat(60);
const replacementKey = 'sk-native-' + 'B'.repeat(60);
const privateMessage = 'Provider diagnostics must never expose this message';
const sessionTokens = { owner: 'O'.repeat(43), member: 'M'.repeat(43) };
type NativeDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>;
type Result = {
  connected?: boolean; manageable?: boolean; provider?: string;
  usesOriginal?: boolean; usesReplacement?: boolean;
  error?: string; code?: string;
  diagnostic?: { code: string; providerStatus?: number; providerCode?: string; networkErrorName?: string; timedOut: boolean };
  providerCalls: number; transportContract: boolean;
};

async function fixture() {
  // Bundle the production library without replacing its auth, crypto, or SQL.
  // Only the provider transport is fake; every D1 operation runs in workerd.
  const project = fileURLToPath(new URL('../', import.meta.url));
  const bundled = await build({
    stdin: { resolveDir: project, sourcefile: 'receipt-ai-native-worker.ts', contents: `
      import { saveReceiptAISettings, removeReceiptAIKey, getReceiptAIAccess, receiptAIKeyCheckDiagnostic } from './lib/receipt-ai-access.ts';
      const accounts = ${JSON.stringify({ owner, member })};
      const originalKey = ${JSON.stringify(originalKey)};
      const replacementKey = ${JSON.stringify(replacementKey)};
      export default { async fetch(request, env) {
        const path = new URL(request.url).pathname;
        const account = path.startsWith('/member/') ? accounts.member : accounts.owner;
        const config = { RECEIPT_AI_TOKEN_KEY: env.TOKEN_KEY };
        const input = request.method === 'POST' ? await request.json() : {};
        const submittedKey = input.replacement ? replacementKey : originalKey;
        let providerCalls = 0, transportContract = true;
        const provider = async (url, init) => {
          providerCalls++;
          transportContract = String(url) === 'https://api.openai.com/v1/models'
            && new Headers(init.headers).get('authorization') === 'Bearer ' + submittedKey
            && init.redirect === 'error' && init.signal instanceof AbortSignal && !init.signal.aborted;
          if (!transportContract) throw new Error('Unexpected provider transport');
          if (input.transportError) throw new TypeError(${JSON.stringify(privateMessage)} + ' ' + submittedKey);
          const status = input.providerStatus || 200;
          return Response.json(status === 200 ? { data: [] } : {
            error: { code: input.providerCode, message: ${JSON.stringify(privateMessage)} + ' ' + submittedKey }
          }, { status });
        };
        try {
          if (path.endsWith('/access')) {
            const access = await getReceiptAIAccess(request, account, env.DB, config);
            return Response.json({ provider: access.provider,
              usesOriginal: access.accessToken === originalKey, usesReplacement: access.accessToken === replacementKey,
              providerCalls, transportContract });
          }
          const result = path.endsWith('/remove')
            ? await removeReceiptAIKey(request, account, env.DB, config)
            : await saveReceiptAISettings(request, account, env.DB, config, { apiKey: submittedKey }, provider);
          return Response.json({ ...result, providerCalls, transportContract });
        } catch (error) {
          return Response.json({ error: error.message, code: error.code, diagnostic: receiptAIKeyCheckDiagnostic(error),
            providerCalls, transportContract }, { status: error.status || 500 });
        }
      } };`
    },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  });
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  const worker = new Miniflare({
    modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-05-15',
    bindings: { TOKEN_KEY: randomBytes(32).toString('base64url') },
    d1Databases: { DB: 'receipt-ai-access-native' }, d1Persist: false,
    log: new Log(LogLevel.NONE), fetchMock,
  });
  try {
    const database = await worker.getD1Database('DB');
    for (const file of (await readdir(new URL('../drizzle/', import.meta.url))).filter(name => name.endsWith('.sql')).sort()) {
      for (const sql of unstable_splitSqlQuery(await readFile(new URL('../drizzle/' + file, import.meta.url), 'utf8'))) {
        await database.prepare(sql).run();
      }
    }
    const now = new Date().toISOString();
    for (const [name, account] of Object.entries({ owner, member })) {
      await database.batch([
        database.prepare('INSERT INTO profiles(id,email,display_name,created_at) VALUES(?,?,?,?)')
          .bind(account.id, account.email, account.displayName, now),
        database.prepare('INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
          .bind(createHash('sha256').update(sessionTokens[name as keyof typeof sessionTokens]).digest('hex'),
            account.id, new Date(Date.now() + 600_000).toISOString(), now),
      ]);
    }
    await database.prepare('INSERT INTO auth_links(oai_user_id,user_id,created_at) VALUES(?,?,?)')
      .bind('native-provider', owner.id, now).run();
    return { worker, database };
  } catch (error) { await worker.dispose(); throw error; }
}

async function call(worker: Miniflare, path: string, body: Record<string, unknown> = {}, bootstrap = false) {
  const account = path.startsWith('/member/') ? 'member' : 'owner';
  const response = await worker.dispatchFetch('https://triptab.test' + path, {
    method: path.endsWith('/access') ? 'GET' : 'POST',
    headers: bootstrap ? { 'oai-authenticated-user-id': 'native-provider', 'oai-authenticated-user-email': owner.email }
      : { cookie: `tt_session=${sessionTokens[account]}` },
    ...(path.endsWith('/access') ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert(!text.includes(originalKey) && !text.includes(replacementKey), 'native responses must not disclose provider keys');
  assert(!text.includes(privateMessage), 'raw provider and transport messages must not become public errors');
  return { status: response.status, result: JSON.parse(text) as Result };
}
async function snapshot(database: NativeDatabase) {
  const row = await database.prepare("SELECT * FROM receipt_ai_settings WHERE id='shared'").first();
  const history = (await database.prepare("SELECT * FROM account_activity_events WHERE entity_id='receipt-processing' ORDER BY sequence").all()).results;
  assert(!JSON.stringify({ row, history }).includes(originalKey) && !JSON.stringify({ row, history }).includes(replacementKey));
  return { row, history };
}
async function bootstrap(worker: Miniflare) {
  const saved = await call(worker, '/owner/save', {}, true);
  assert.equal(saved.status, 200);
  assert.equal(saved.result.connected, true);
  assert.equal(saved.result.manageable, true);
  assert.equal(saved.result.providerCalls, 1);
  assert.equal(saved.result.transportContract, true);
}

test('native workerd bootstraps the shared owner key, permits member processing, replaces and removes it without disclosure', async () => {
  const { worker, database } = await fixture();
  try {
    await bootstrap(worker);
    const first = await snapshot(database);
    assert.equal(first.row?.user_id, owner.id);
    assert.equal(first.row?.version, 1);
    assert.equal(first.history.length, 1);
    const memberAccess = await call(worker, '/member/access');
    assert.equal(memberAccess.status, 200);
    assert.equal(memberAccess.result.usesOriginal, true);
    assert.equal(memberAccess.result.providerCalls, 0);
    const denied = await call(worker, '/member/save', { replacement: true });
    assert.equal(denied.status, 403);
    assert.equal(denied.result.providerCalls, 0);
    assert.deepEqual(await snapshot(database), first);
    const replaced = await call(worker, '/owner/save', { replacement: true });
    assert.equal(replaced.status, 200);
    assert.equal(replaced.result.connected, true);
    assert.equal(replaced.result.transportContract, true);
    const second = await snapshot(database);
    assert.notEqual(second.row?.api_key_encrypted, first.row?.api_key_encrypted);
    assert.equal(second.row?.version, 2);
    assert.equal(second.history.length, 2);
    assert.equal((await call(worker, '/member/access')).result.usesReplacement, true);
    const removed = await call(worker, '/owner/remove');
    assert.equal(removed.status, 200);
    assert.equal(removed.result.connected, false);
    const final = await snapshot(database);
    assert.equal(final.row?.api_key_encrypted, null);
    assert.equal(final.row?.version, 3);
    assert.equal(final.history.length, 3);
    assert.equal((await call(worker, '/member/access')).status, 503);
  } finally { await worker.dispose(); }
});

test('native provider failures have safe categories and preserve the shared key and account history', async t => {
  const scenarios = [
    { name: 'rejected key', providerStatus: 401, providerCode: 'invalid_api_key', status: 400, code: 'key_rejected' },
    { name: 'restricted key', providerStatus: 403, providerCode: 'insufficient_permissions', status: 403, code: 'key_permission_denied' },
    { name: 'rate limit', providerStatus: 429, providerCode: 'rate_limit_exceeded', status: 429, code: 'key_check_rate_limited' },
    { name: 'provider unavailable', providerStatus: 503, providerCode: 'server_error', status: 503, code: 'key_check_server_error' },
    { name: 'transport failure', transportError: true, status: 503, code: 'key_check_unavailable' },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async () => {
    const { worker, database } = await fixture();
    try {
      await bootstrap(worker);
      const before = await snapshot(database);
      const rejected = await call(worker, '/owner/save', { replacement: true, ...scenario });
      assert.equal(rejected.status, scenario.status);
      assert.equal(rejected.result.code, scenario.code);
      assert.equal(rejected.result.providerCalls, 1);
      assert.equal(rejected.result.transportContract, true);
      assert.deepEqual(rejected.result.diagnostic, 'providerStatus' in scenario ? {
        code: scenario.code, timedOut: false, providerStatus: scenario.providerStatus, providerCode: scenario.providerCode,
      } : { code: scenario.code, timedOut: false, networkErrorName: 'TypeError' });
      assert.deepEqual(await snapshot(database), before, 'a refused replacement must preserve ciphertext, version, and history');
      const access = await call(worker, '/member/access');
      assert.equal(access.status, 200);
      assert.equal(access.result.usesOriginal, true);
      assert.equal(access.result.usesReplacement, false);
    } finally { await worker.dispose(); }
  });
});
