import { migrateReceiptAIOwner, receiptAIOwnerEmail, type ReceiptAIEnvironment } from './receipt-ai-access';

export type OwnerTransferArguments = { show: boolean; expectedUserId: string; expectedVersion: number; newUserId: string };

/** Parses `--show` or `--expected-user-id X --expected-version N --new-user-id Y`. */
export function parseOwnerTransferArguments(argv: string[]): OwnerTransferArguments {
  const values = new Map<string, string>(); let show = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--show') { show = true; continue; }
    if (!['--expected-user-id', '--expected-version', '--new-user-id'].includes(flag) || values.has(flag) || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new Error(`Unexpected or incomplete argument: ${flag}`);
    }
    values.set(flag, argv[++index]);
  }
  if (show) return { show, expectedUserId: '', expectedVersion: 0, newUserId: '' };
  const expectedVersion = Number(values.get('--expected-version'));
  if (!values.get('--expected-user-id') || !values.get('--new-user-id') || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
    throw new Error('Pass --expected-user-id, --expected-version and --new-user-id (or --show to read the current owner and version).');
  }
  return { show, expectedUserId: values.get('--expected-user-id')!, expectedVersion, newUserId: values.get('--new-user-id')! };
}

/** Reads the shared settings pin; never selects or prints ciphertext. */
export async function readOwnerPin(database: D1Database) {
  return database.prepare("SELECT user_id AS userId, version, provider, api_key_encrypted IS NOT NULL AS keyConfigured FROM receipt_ai_settings WHERE id='shared'")
    .first<{ userId: string; version: number; provider: string; keyConfigured: number }>();
}

/** Operator entry point shared by the CLI and its tests. */
export async function runOwnerTransfer(database: D1Database, environment: ReceiptAIEnvironment, argv: string[]) {
  receiptAIOwnerEmail(environment); // fail before any read if the target email is not configured
  const args = parseOwnerTransferArguments(argv);
  if (args.show) {
    const pin = await readOwnerPin(database);
    return { shown: true as const, pin: pin ? { userId: pin.userId, version: pin.version, provider: pin.provider, keyConfigured: !!pin.keyConfigured } : null };
  }
  return { shown: false as const, ...await migrateReceiptAIOwner(database, environment, args) };
}
