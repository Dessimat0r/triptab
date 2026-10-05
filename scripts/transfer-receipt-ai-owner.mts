// Operator-only: move the shared receipt AI owner pin. Not reachable over HTTP or MCP.
//   RECEIPT_AI_OWNER_EMAIL=new-owner@example.com npm run receipt-owner -- --show
//   RECEIPT_AI_OWNER_EMAIL=new-owner@example.com npm run receipt-owner -- \
//     --expected-user-id <current> --expected-version <n> --new-user-id <target>
// Targets the local preview D1 state (dist/server/wrangler.json, .wrangler/state);
// set RECEIPT_AI_REMOTE=1 to use the config's remote D1 binding instead.
import { pathToFileURL } from 'node:url';
import './sites-env.mjs';
import { getPlatformProxy } from 'wrangler';
import { runOwnerTransfer } from '../lib/receipt-ai-owner-transfer';

const remote = process.env.RECEIPT_AI_REMOTE === '1';
const proxy = await getPlatformProxy<{ DB: D1Database }>({
  configPath: pathToFileURL('dist/server/wrangler.json').pathname,
  persist: remote ? false : { path: '.wrangler/state/v3' },
  remoteBindings: remote,
});
try {
  const result = await runOwnerTransfer(proxy.env.DB, { RECEIPT_AI_OWNER_EMAIL: process.env.RECEIPT_AI_OWNER_EMAIL } as never, process.argv.slice(2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await proxy.dispose();
}
