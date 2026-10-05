import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { evaluateReceiptResults, type ReceiptEvaluationResult, type ReceiptGoldenFixture } from '../lib/receipt-evaluation';

const corpus = JSON.parse(await readFile(new URL('./fixtures/receipts/v1/corpus.json', import.meta.url), 'utf8')) as { version: number; fixtures: (ReceiptGoldenFixture & { image: string; sourceImage: string; source: { lines: string[] } })[] };
const example = (fixture: ReceiptGoldenFixture): ReceiptEvaluationResult => ({
  fixtureId: fixture.id,
  items: fixture.expected.items.map(({ lineIndex, name, amount, quantity }) => ({ lineIndex, name, amount, ...(quantity ? { quantity } : {}) })),
  currency: fixture.expected.currency,
  printedSubtotal: fixture.expected.printedSubtotal,
  printedTotal: fixture.expected.printedTotal,
  adjustments: { ...fixture.expected.adjustments },
  warningCodes: [...fixture.expected.warningCodes] as ReceiptEvaluationResult['warningCodes'],
  unreadableFields: [...fixture.expected.unreadableFields],
});
const results = (rows: ReceiptEvaluationResult[]) => ({ corpusVersion: 1, results: rows });

test('versioned synthetic corpus covers all requested single-image financial and capture cases without customer data', async () => {
  assert.equal(corpus.version, 1);
  assert.equal(corpus.fixtures.length, 19);
  const ids = corpus.fixtures.map(fixture => fixture.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ['cafe', 'restaurant-included-vat', 'service-charge', 'separate-tip', 'unit-price', 'repeated-names', 'comma-decimals', 'foreign-currency', 'ambiguous-dollar', 'global-coupon', 'item-discount', 'negative-refund', 'long-receipt', 'blurry-amount', 'cropped-receipt', 'missing-line-subtotal', 'inclusive-tax-summary', 'multiple-totals', 'printed-injection']) assert.ok(ids.includes(id), id);
  for (const fixture of corpus.fixtures) {
    assert.equal(fixture.expected.lineCount, fixture.expected.items.length);
    assert.deepEqual(fixture.expected.sourceOrder, fixture.expected.items.map(item => item.lineIndex));
    assert.equal(new Set(fixture.expected.sourceOrder).size, fixture.expected.lineCount);
    if (fixture.expected.printedSubtotal !== null) {
      assert.ok(fixture.source.lines.some(line => /SUBTOTAL|BEFORE DISCOUNT/.test(line)), `${fixture.id}: printed subtotal must exist independently on the source`);
    }
    const svg = await readFile(new URL(`./fixtures/receipts/v1/${fixture.sourceImage}`, import.meta.url), 'utf8');
    const png = await readFile(new URL(`./fixtures/receipts/v1/${fixture.image}`, import.meta.url));
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.match(svg, /SYNTHETIC TEST RECEIPT/);
    assert.match(svg, /NOT A SALE/);
    assert.ok(!svg.includes('<script') && !svg.includes('<image') && !svg.includes('href='));
  }
});

test('offline golden self-check validates evaluator arithmetic and missing-data representation, not vision quality', () => {
  const report = evaluateReceiptResults(corpus.fixtures, results(corpus.fixtures.map(example)));
  assert.equal(report.modelCalled, false);
  assert.equal(report.evaluationKind, 'operator-supplied-results');
  assert.deepEqual(report.notEvaluated, []);
  assert.equal(report.metrics.lineRecall.rate, 1);
  assert.equal(report.metrics.exactPriceAccuracy.rate, 1);
  assert.equal(report.metrics.purchaseQuantityAccuracy.rate, 1);
  assert.equal(report.metrics.successfulReconciliationRate.rate, 1);
  assert.equal(report.metrics.appropriateUncertaintyRate.rate, 1);
  assert.equal(report.cases.find(row => row.fixtureId === 'blurry-amount')!.reconciles, false);
  assert.equal(report.cases.find(row => row.fixtureId === 'cropped-receipt')!.reconciles, false);
  assert.equal(report.cases.find(row => row.fixtureId === 'missing-line-subtotal')!.reconciles, false);
  assert.equal(report.metrics.falseReconciliationMatches, 0);
  for (const fixture of corpus.fixtures) assert.equal(report.cases.find(row => row.fixtureId === fixture.id)!.serverStatus, fixture.expected.reconciliationStatus, fixture.id);
});

test('evaluation counts omissions, invented and duplicate lines instead of hiding them behind a correct total', () => {
  const fixture = corpus.fixtures.find(row => row.id === 'cafe')!;
  const prediction = example(fixture);
  prediction.items = [prediction.items[0], { ...prediction.items[0] }, { lineIndex: 99, name: 'Balancing row', amount: 320 }];
  const report = evaluateReceiptResults(corpus.fixtures, results([prediction]));
  assert.deepEqual(report.metrics.lineRecall, { correct: 1, evaluated: 2, rate: 0.5 });
  assert.equal(report.metrics.hallucinatedLines, 2);
  assert.deepEqual(report.metrics.exactPriceAccuracy, { correct: 1, evaluated: 2, rate: 0.5 });
  assert.equal(report.metrics.successfulReconciliationRate.rate, 0);
  assert.equal(report.notEvaluated.length, 18);
});

test('one-cent price changes, wrong currency, fabricated totals and source reordering reduce their respective metrics', () => {
  const fixture = corpus.fixtures.find(row => row.id === 'cafe')!;
  const prediction = example(fixture);
  prediction.items[0].amount!++;
  prediction.currency = 'GBP';
  prediction.printedTotal!++;
  prediction.items.reverse();
  const report = evaluateReceiptResults(corpus.fixtures, results([prediction]));
  assert.equal(report.metrics.exactPriceAccuracy.rate, 0.5);
  assert.equal(report.metrics.currencyAccuracy.rate, 0);
  assert.equal(report.metrics.printedTotalAccuracy.rate, 0);
  assert.equal(report.metrics.sourceOrderAccuracy.rate, 0);
  assert.equal(report.metrics.successfulReconciliationRate.rate, 0);
});

test('purchased quantity scoring does not confuse two slices with their single printed unit price', () => {
  const fixture = corpus.fixtures.find(row => row.id === 'unit-price')!;
  const prediction = example(fixture);
  prediction.items[0].amount = 300;
  prediction.items[0].quantity = { total: 1, label: 'slices', sourceText: '2 x Stck' };
  const report = evaluateReceiptResults(corpus.fixtures, results([prediction]));
  assert.equal(report.metrics.exactPriceAccuracy.rate, 0);
  assert.equal(report.metrics.purchaseQuantityAccuracy.rate, 0);
  assert.equal(report.cases[0].serverStatus, 'needs-review');
});

test('guessing an unreadable amount or ambiguous currency fails uncertainty scoring even with warning words', () => {
  const blur = example(corpus.fixtures.find(row => row.id === 'blurry-amount')!);
  blur.items[1].amount = 650;
  const ambiguous = example(corpus.fixtures.find(row => row.id === 'ambiguous-dollar')!);
  ambiguous.currency = 'USD';
  const report = evaluateReceiptResults(corpus.fixtures, results([blur, ambiguous]));
  assert.deepEqual(report.metrics.appropriateUncertaintyRate, { correct: 0, evaluated: 2, rate: 0 });
});

test('a missing physical line can accidentally balance and still be counted as a false recognition match', () => {
  const fixture = corpus.fixtures.find(row => row.id === 'missing-line-subtotal')!;
  const prediction = example(fixture);
  prediction.items[0].amount = 1000;
  prediction.warningCodes = [];
  const report = evaluateReceiptResults(corpus.fixtures, results([prediction]));
  assert.equal(report.cases[0].serverStatus, 'matched');
  assert.equal(report.metrics.falseReconciliationMatches, 1);
  assert.equal(report.metrics.exactPriceAccuracy.rate, 0.5);
  assert.equal(report.metrics.appropriateUncertaintyRate.rate, 0);
});

test('a computed subtotal cannot count as independently observed evidence when none is printed', () => {
  const fixture = corpus.fixtures.find(row => row.id === 'restaurant-included-vat')!;
  assert.equal(fixture.expected.printedSubtotal, null);
  const prediction = example(fixture);
  prediction.printedSubtotal = 1500;
  const report = evaluateReceiptResults(corpus.fixtures, results([prediction]));
  assert.equal(report.cases[0].serverStatus, 'matched', 'the arithmetic can balance while the source evidence is false');
  assert.equal(report.metrics.printedSubtotalAccuracy.rate, 0);
  assert.equal(report.metrics.printedTotalAccuracy.rate, 1);
  assert.equal(report.metrics.falseReconciliationMatches, 1);
  assert.equal(report.metrics.successfulReconciliationRate.rate, 0);
});

test('invented prices and matching invented totals are a false match even on an otherwise clear receipt', () => {
  const fixture = corpus.fixtures.find(row => row.id === 'cafe')!;
  const prediction = example(fixture);
  prediction.items = prediction.items.map(item => ({ ...item, amount: item.amount! + 100 }));
  prediction.printedSubtotal = 770;
  prediction.printedTotal = 770;
  const report = evaluateReceiptResults(corpus.fixtures, results([prediction]));
  assert.equal(report.cases[0].serverStatus, 'matched');
  assert.equal(report.metrics.falseReconciliationMatches, 1);
  assert.equal(report.metrics.successfulReconciliationRate.rate, 0);
});

test('a corpus with no supplied predictions reports unrun coverage and null scores rather than invented accuracy', () => {
  const report = evaluateReceiptResults(corpus.fixtures, results([]));
  assert.equal(report.evaluatedFixtures, 0);
  assert.equal(report.notEvaluated.length, 19);
  assert.equal(report.metrics.lineRecall.rate, null);
  assert.equal(report.metrics.printedTotalAccuracy.rate, null);
  assert.equal(report.metrics.successfulReconciliationRate.rate, null);
});

test('evaluation rejects unsupported corpus versions, duplicate/unknown fixtures, floats and injected result fields', () => {
  const fixture = corpus.fixtures[0];
  const prediction = example(fixture);
  assert.throws(() => evaluateReceiptResults(corpus.fixtures, { corpusVersion: 2, results: [] }));
  assert.throws(() => evaluateReceiptResults(corpus.fixtures, results([prediction, prediction])), /Duplicate/);
  assert.throws(() => evaluateReceiptResults(corpus.fixtures, results([{ ...prediction, fixtureId: 'not-real' }])), /Unknown/);
  assert.throws(() => evaluateReceiptResults(corpus.fixtures, results([{ ...prediction, items: [{ lineIndex: 0, name: 'Coffee', amount: 2.5 }] }])));
  assert.throws(() => evaluateReceiptResults(corpus.fixtures, { corpusVersion: 1, results: [{ ...prediction, expenseId: 'posted' }] }));
});
