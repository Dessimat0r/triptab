import { readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { migrateReceiptAIOwner, receiptAIOwnerEmail } from '../lib/receipt-ai-access';

export type OwnerTransferOptions = {
  configPath: string; databaseId: string; accountId?: string; persistTo?: string;
  remote: boolean; apply: boolean; ownerEmail: string;
  expectedUserId: string; expectedVersion: number; newUserId: string;
};
const usage = 'Usage: transfer-receipt-ai-owner.ts --config /absolute/operator.json --database-id UUID --expected-owner ACCOUNT --expected-version INTEGER --new-owner ACCOUNT --owner-email EMAIL (--local --persist-to PATH | --remote --account-id ID) [--apply]';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const accountId = /^[0-9a-f]{32}$/i;
function identifier(value: string | undefined) {
  return !!value && value.length <= 200 && !/\s/.test(value) && [...value].every(character => character.codePointAt(0)! >= 32 && character.codePointAt(0) !== 127);
}

export function parseOwnerTransferOptions(args: string[]): OwnerTransferOptions {
  const flags = new Set(['--apply', '--local', '--remote']);
  const allowed = new Set(['--config', '--database-id', '--account-id', '--persist-to', '--expected-owner', '--expected-version', '--new-owner', '--owner-email', ...flags]);
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (!allowed.has(name) || options.has(name)) throw Error(usage);
    if (flags.has(name)) options.set(name, 'true');
    else {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw Error(usage);
      options.set(name, value);
    }
  }
  const configPath = options.get('--config'), databaseId = options.get('--database-id');
  const expectedUserId = options.get('--expected-owner'), newUserId = options.get('--new-owner');
  const version = options.get('--expected-version'), remote = options.has('--remote');
  if (!configPath || !isAbsolute(configPath) || !databaseId || !uuid.test(databaseId)
    || options.has('--local') === remote || !identifier(expectedUserId) || !identifier(newUserId) || expectedUserId === newUserId
    || !version || !/^[1-9]\d*$/.test(version) || !Number.isSafeInteger(Number(version)) || Number(version) >= Number.MAX_SAFE_INTEGER
    || (remote && (!accountId.test(options.get('--account-id') || '') || options.has('--persist-to') || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(databaseId)))
    || (!remote && (!options.has('--persist-to') || options.has('--account-id')))) throw Error(usage);
  const ownerEmail = receiptAIOwnerEmail({ RECEIPT_AI_OWNER_EMAIL: options.get('--owner-email') });
  return { configPath, databaseId, accountId: options.get('--account-id'), persistTo: options.get('--persist-to'),
    expectedUserId: expectedUserId!, expectedVersion: Number(version), newUserId: newUserId!, remote, apply: options.has('--apply'), ownerEmail };
}

/** A dedicated config prevents an operator accidentally targeting a preview,
 * wrong account/database, other remote bindings, or application secrets. */
export function validateOwnerTransferConfig(value: unknown, options: OwnerTransferOptions) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Use a minimal operator-only JSON Wrangler configuration.');
  const config = value as Record<string, unknown>;
  const permitted = new Set(['name', 'compatibility_date', 'compatibility_flags', 'account_id', 'd1_databases']);
  if (Object.keys(config).some(key => !permitted.has(key)) || typeof config.name !== 'string' || !/^[a-z0-9-]{1,63}$/.test(config.name)
    || typeof config.compatibility_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(config.compatibility_date)
    || !Array.isArray(config.d1_databases) || config.d1_databases.length !== 1) throw Error('Use a minimal operator-only JSON Wrangler configuration.');
  const binding = config.d1_databases[0] as Record<string, unknown> | null;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)
    || Object.keys(binding).some(key => !['binding', 'database_name', 'database_id', 'remote'].includes(key))
    || binding.binding !== 'DB' || typeof binding.database_name !== 'string' || !binding.database_name
    || binding.database_id !== options.databaseId || binding.remote !== options.remote
    || (options.remote && config.account_id !== options.accountId)) throw Error('The operator account, database or local/remote binding does not match the explicit target.');
}

/** This read-only preflight deliberately never selects credential ciphertext. */
export async function transferReceiptAIOwner(database: D1Database, options: OwnerTransferOptions) {
  const before = await database.prepare("SELECT user_id,version,provider,api_key_encrypted IS NOT NULL AS key_configured FROM receipt_ai_settings WHERE id='shared'")
    .first<{ user_id: string; version: number; provider: string; key_configured: number }>();
  const target = await database.prepare('SELECT 1 AS allowed FROM profiles p WHERE p.id=? AND lower(p.email)=? AND EXISTS(SELECT 1 FROM auth_links l WHERE l.user_id=p.id)')
    .bind(options.newUserId, options.ownerEmail).first();
  if (!before || before.user_id !== options.expectedUserId || before.version !== options.expectedVersion || !target) throw Error('The owner/version or verified canonical target does not match. No transfer was applied.');
  if (!options.apply) return { dryRun: true, transferable: true, version: before.version, keyConfigured: !!before.key_configured, provider: before.provider };
  const result = await migrateReceiptAIOwner(database, { RECEIPT_AI_OWNER_EMAIL: options.ownerEmail }, options);
  return { dryRun: false, ...result };
}

export async function runOwnerTransfer(args: string[]) {
  const options = parseOwnerTransferOptions(args);
  const configuration: unknown = JSON.parse(await readFile(options.configPath, 'utf8'));
  validateOwnerTransferConfig(configuration, options);
  if (options.remote && ['CLOUDFLARE_ACCOUNT_ID', 'CF_ACCOUNT_ID'].some(name => process.env[name] && process.env[name] !== options.accountId)) throw Error('The operator account environment does not match the explicit target.');
  // Wrangler also recognizes .dev.vars independently of envFiles. Require a
  // dedicated config directory so application secrets are never loaded here.
  if ((await readdir(dirname(options.configPath))).some(name => name.startsWith('.env') || name.startsWith('.dev.vars'))) throw Error('Use a dedicated operator config directory without application environment files.');
  // Remote bindings are opted in both here and in the dedicated DB config.
  // Authentication uses the operator's Wrangler account, never an app user or
  // OpenAI key. No TripTab HTTP/MCP handler is exposed by this operator command.
  const { getPlatformProxy } = await import('wrangler');
  const proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath: options.configPath, envFiles: [],
    remoteBindings: options.remote, persist: options.remote ? false : { path: resolve(options.persistTo!) } });
  try {
    if (!proxy.env.DB) throw Error('The operator D1 binding is unavailable.');
    return await transferReceiptAIOwner(proxy.env.DB, options);
  } finally { await proxy.dispose(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await runOwnerTransfer(process.argv.slice(2))));
  } catch {
    // Wrangler/provider errors may contain account IDs, response bodies or
    // credentials. Do not print them, stacks, profiles or configuration.
    console.error('Receipt AI owner transfer did not complete. Check the explicit target, canonical verification, owner/version and operator D1 permissions.');
    console.error(usage);
    process.exitCode = 1;
  }
}
