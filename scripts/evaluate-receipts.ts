import { readFile } from 'node:fs/promises';
import { evaluateReceiptResults, type ReceiptGoldenFixture } from '../lib/receipt-evaluation';

const filename = process.argv[2];
if (!filename || process.argv.length !== 3) {
  console.error('Usage: npx tsx scripts/evaluate-receipts.ts <operator-results.json>');
  console.error('Offline only: supply previously captured scan results. This command never calls OpenAI.');
  process.exitCode = 1;
} else {
  const corpus = JSON.parse(await readFile(new URL('../tests/fixtures/receipts/v1/corpus.json', import.meta.url), 'utf8')) as { fixtures: ReceiptGoldenFixture[] };
  const results: unknown = JSON.parse(await readFile(filename, 'utf8'));
  console.log(JSON.stringify(evaluateReceiptResults(corpus.fixtures, results), null, 2));
}
