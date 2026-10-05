import { z } from 'zod';
import { reconcileReceiptScan, RECEIPT_SCAN_WARNING_CODES } from './receipt-scan';

const money = z.number().int().min(0).max(100_000_000);
const adjustmentsSchema = z.object({ tax: money, tip: money, discount: money }).strict();
const itemSchema = z.object({
  lineIndex: z.number().int().min(0).max(1000),
  name: z.string().trim().min(1).max(200),
  amount: money.nullable(),
  quantity: z.object({ total: z.number().positive().max(1_000_000), label: z.string().max(80).nullable().optional(), sourceText: z.string().max(500).nullable().optional() }).strict().optional(),
}).strict();
export const receiptEvaluationResultsSchema = z.object({
  corpusVersion: z.literal(1),
  // Operators supply real scan results; the tool never calls a model itself.
  results: z.array(z.object({
    fixtureId: z.string().min(1).max(100),
    items: z.array(itemSchema).max(200),
    currency: z.string().max(10).nullable(),
    printedSubtotal: money.nullable(),
    printedTotal: money.nullable(),
    adjustments: adjustmentsSchema,
    warningCodes: z.array(z.enum(RECEIPT_SCAN_WARNING_CODES)).max(200),
    unreadableFields: z.array(z.string().max(200)).max(200),
  }).strict()).max(200),
}).strict();
export type ReceiptEvaluationResult = z.infer<typeof receiptEvaluationResultsSchema>['results'][number];
export type ReceiptGoldenFixture = {
  id: string;
  expected: {
    lineCount: number;
    items: { lineIndex: number; name: string; amount: number | null; acceptedNames?: string[]; quantity?: { total: number; label?: string | null; sourceText?: string | null } }[];
    sourceOrder: number[];
    currency: string | null;
    printedSubtotal: number | null;
    printedTotal: number | null;
    adjustments: { tax: number; tip: number; discount: number };
    warningCodes: string[];
    unreadableFields: string[];
    reconciliationStatus: 'matched' | 'needs-review' | 'incomplete';
  };
};

function normalizedName(value: string) { return value.normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/g, ' ').trim(); }
const metric = (correct: number, evaluated: number) => ({ correct, evaluated, rate: evaluated ? correct / evaluated : null });

/** Offline scoring only. These scores describe supplied predictions, never CI's vision accuracy. */
export function evaluateReceiptResults(fixtures: ReceiptGoldenFixture[], supplied: unknown) {
  const { results } = receiptEvaluationResultsSchema.parse(supplied);
  const known = new Map(fixtures.map(fixture => [fixture.id, fixture]));
  const seen = new Set<string>();
  const cases = results.map(result => {
    if (seen.has(result.fixtureId)) throw Error(`Duplicate result for ${result.fixtureId}`);
    seen.add(result.fixtureId);
    const fixture = known.get(result.fixtureId);
    if (!fixture) throw Error(`Unknown corpus fixture ${result.fixtureId}`);
    const expected = fixture.expected;
    const aligned = new Map<number, ReceiptEvaluationResult['items'][number]>();
    let hallucinatedLines = 0;
    for (const row of result.items) {
      const reference = expected.items.find(item => item.lineIndex === row.lineIndex);
      if (!reference || aligned.has(row.lineIndex) || !(reference.acceptedNames ?? [reference.name]).some(name => normalizedName(name) === normalizedName(row.name))) {
        hallucinatedLines++;
      } else aligned.set(row.lineIndex, row);
    }
    const readable = expected.items.filter(item => item.amount !== null);
    const quantityLines = expected.items.filter(item => item.quantity);
    const scan = reconcileReceiptScan({ currency: result.currency,
      items: result.items.map((row, index) => ({ ...row, id: `evaluation-${index}`, members: [], scanSource: { lineIndex: row.lineIndex } })),
      ...result.adjustments,
      receiptScan: { version: 1, status: 'matched', printedSubtotal: result.printedSubtotal, printedTotal: result.printedTotal,
        warnings: result.warningCodes.map(code => ({ code })) },
    })!;
    const reconciles = scan.status === 'matched';
    const uncertaintyExpected = expected.warningCodes.length > 0 || expected.unreadableFields.length > 0;
    const reportedWarnings = new Set<string>(result.warningCodes);
    const appropriateUncertainty = expected.warningCodes.every(code => reportedWarnings.has(code)) &&
      expected.unreadableFields.every(field => result.unreadableFields.includes(field)) &&
      expected.items.filter(item => item.amount === null).every(item => aligned.get(item.lineIndex)?.amount === null) &&
      (expected.currency !== null || result.currency === null) && (expected.printedTotal !== null || result.printedTotal === null);
    const exactPriceAccuracy = metric(readable.filter(item => aligned.get(item.lineIndex)?.amount === item.amount).length, readable.length);
    const purchaseQuantityAccuracy = metric(quantityLines.filter(item => {
      const quantity = aligned.get(item.lineIndex)?.quantity;
      return quantity?.total === item.quantity!.total && (quantity?.label ?? null) === (item.quantity!.label ?? null);
    }).length, quantityLines.length);
    const currencyCorrect = result.currency === expected.currency;
    const printedSubtotalCorrect = result.printedSubtotal === expected.printedSubtotal;
    const printedTotalCorrect = result.printedTotal === expected.printedTotal;
    const sourceOrderCorrect = result.items.map(item => item.lineIndex).join(',') === expected.sourceOrder.join(',');
    const adjustmentsCorrect = (['tax', 'tip', 'discount'] as const).every(field => result.adjustments[field] === expected.adjustments[field]);
    // Balancing two invented values is arithmetic success, not source fidelity.
    const sourceAccurate = aligned.size === expected.lineCount && hallucinatedLines === 0 &&
      exactPriceAccuracy.correct === exactPriceAccuracy.evaluated && purchaseQuantityAccuracy.correct === purchaseQuantityAccuracy.evaluated &&
      currencyCorrect && printedSubtotalCorrect && printedTotalCorrect && sourceOrderCorrect && adjustmentsCorrect;
    return {
      fixtureId: result.fixtureId,
      lineRecall: metric(aligned.size, expected.lineCount),
      hallucinatedLines,
      exactPriceAccuracy,
      purchaseQuantityAccuracy,
      currencyCorrect,
      printedSubtotalCorrect,
      printedTotalCorrect,
      sourceOrderCorrect,
      adjustmentsCorrect,
      sourceAccurate,
      reconciliationEligible: expected.reconciliationStatus === 'matched',
      reconciles,
      serverStatus: scan.status,
      serverWarningCodes: [...new Set(scan.warnings.map(warning => warning.code))],
      falseReconciliationMatch: reconciles && (expected.reconciliationStatus !== 'matched' || !sourceAccurate),
      uncertaintyExpected,
      appropriateUncertainty,
    };
  });
  const aggregate = (field: 'lineRecall' | 'exactPriceAccuracy' | 'purchaseQuantityAccuracy') => metric(cases.reduce((sum, row) => sum + row[field].correct, 0), cases.reduce((sum, row) => sum + row[field].evaluated, 0));
  const eligible = cases.filter(row => row.reconciliationEligible);
  const uncertain = cases.filter(row => row.uncertaintyExpected);
  return {
    corpusVersion: 1,
    evaluationKind: 'operator-supplied-results',
    modelCalled: false,
    evaluatedFixtures: cases.length,
    notEvaluated: fixtures.filter(fixture => !seen.has(fixture.id)).map(fixture => fixture.id),
    metrics: {
      lineRecall: aggregate('lineRecall'),
      hallucinatedLines: cases.reduce((sum, row) => sum + row.hallucinatedLines, 0),
      exactPriceAccuracy: aggregate('exactPriceAccuracy'),
      purchaseQuantityAccuracy: aggregate('purchaseQuantityAccuracy'),
      currencyAccuracy: metric(cases.filter(row => row.currencyCorrect).length, cases.length),
      printedSubtotalAccuracy: metric(cases.filter(row => row.printedSubtotalCorrect).length, cases.length),
      printedTotalAccuracy: metric(cases.filter(row => row.printedTotalCorrect).length, cases.length),
      sourceOrderAccuracy: metric(cases.filter(row => row.sourceOrderCorrect).length, cases.length),
      successfulReconciliationRate: metric(eligible.filter(row => row.reconciles && row.sourceAccurate).length, eligible.length),
      falseReconciliationMatches: cases.filter(row => row.falseReconciliationMatch).length,
      appropriateUncertaintyRate: metric(uncertain.filter(row => row.appropriateUncertainty).length, uncertain.length),
    },
    cases,
    limitations: 'No model request is made. Align source line indexes and add reviewed accepted descriptions before scoring translations. CI checks this evaluator and money contracts, not live vision quality.',
  };
}
