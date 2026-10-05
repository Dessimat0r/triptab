import { migrateReceiptAIOwner, receiptAIOwnerEmail, ReceiptAIAccessError, type ReceiptAIEnvironment } from './receipt-ai-access';

export type OwnerTransferArguments = { show: boolean; apply: boolean; expectedUserId: string; expectedVersion: number; newUserId: string };
const usage = 'Pass --expected-user-id, --expected-version and --new-user-id [--apply] (or --show alone to read the current owner and version).';
function identifier(value: string | undefined) {
  return !!value && value.length <= 200 && !/\s/.test(value) && [...value].every(character => character.codePointAt(0)! >= 32 && character.codePointAt(0) !== 127);
}

/** Internal binding API. Transfers are read-only unless --apply is explicit. */
export function parseOwnerTransferArguments(argv: string[]): OwnerTransferArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!['--show', '--apply', '--expected-user-id', '--expected-version', '--new-user-id'].includes(flag) || values.has(flag)) throw new Error('Unexpected or incomplete argument. ' + usage);
    if (flag === '--show' || flag === '--apply') values.set(flag, 'true');
    else {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('Unexpected or incomplete argument. ' + usage);
      values.set(flag, argv[++index]);
    }
  }
  if (values.has('--show')) {
    if (values.size !== 1) throw new Error(usage);
    return { show: true, apply: false, expectedUserId: '', expectedVersion: 0, newUserId: '' };
  }
  const version = values.get('--expected-version'), expectedUserId = values.get('--expected-user-id'), newUserId = values.get('--new-user-id');
  if (!identifier(expectedUserId) || !identifier(newUserId) || expectedUserId === newUserId || !version || !/^[1-9]\d*$/.test(version)
    || !Number.isSafeInteger(Number(version)) || Number(version) >= Number.MAX_SAFE_INTEGER) throw new Error(usage);
  return { show: false, apply: values.has('--apply'), expectedUserId: expectedUserId!, expectedVersion: Number(version), newUserId: newUserId! };
}

/** Reads the shared settings pin; never selects or prints ciphertext. */
export async function readOwnerPin(database: D1Database) {
  return database.prepare("SELECT user_id AS userId, version, provider, api_key_encrypted IS NOT NULL AS keyConfigured FROM receipt_ai_settings WHERE id='shared'")
    .first<{ userId: string; version: number; provider: string; keyConfigured: number }>();
}

/** Trusted operator binding API; the sole runnable transport is the guarded .ts CLI. */
export async function runOwnerTransfer(database: D1Database, environment: ReceiptAIEnvironment, argv: string[]) {
  const email = receiptAIOwnerEmail(environment); // fail before any read if the target email is not configured
  const args = parseOwnerTransferArguments(argv);
  if (args.show) {
    const pin = await readOwnerPin(database);
    return { shown: true as const, pin: pin ? { userId: pin.userId, version: pin.version, provider: pin.provider, keyConfigured: !!pin.keyConfigured } : null };
  }
  const before = await readOwnerPin(database);
  const target = await database.prepare('SELECT 1 AS allowed FROM profiles p WHERE p.id=? AND lower(p.email)=? AND EXISTS(SELECT 1 FROM auth_links l WHERE l.user_id=p.id)')
    .bind(args.newUserId, email).first();
  if (!before || before.userId !== args.expectedUserId || before.version !== args.expectedVersion || !target) {
    throw new ReceiptAIAccessError('The owner/version or verified canonical target does not match. No transfer was applied.', 409, 'settings_changed');
  }
  if (!args.apply) return { shown: false as const, dryRun: true as const, transferable: true, version: before.version, provider: before.provider, keyConfigured: !!before.keyConfigured };
  return { shown: false as const, dryRun: false as const, ...await migrateReceiptAIOwner(database, environment, args) };
}
