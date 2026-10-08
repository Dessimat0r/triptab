import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as React from 'react';
import * as runtime from 'react/jsx-runtime';
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import * as model from '../lib/model';
import * as processing from '../lib/receipt-processing';
import * as scan from '../lib/receipt-scan';
import * as money from '../lib/money-format';
import type { ReceiptEditor } from '../lib/receipt-processing';

type Element = React.ReactElement<Record<string, unknown>>;
function elements(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  const element = node as Element;
  if (typeof element.type === 'function' && element.type.name === 'ReceiptReviewSummary') return elements((element.type as (props: Record<string, unknown>) => React.ReactNode)(element.props));
  return [element, ...elements(element.props.children as React.ReactNode)];
}
function text(node: React.ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join(' ');
  if (React.isValidElement(node)) {
    const element = node as Element;
    return text(typeof element.type === 'function' && element.type.name === 'ReceiptReviewSummary' ? (element.type as (props: Record<string, unknown>) => React.ReactNode)(element.props) : element.props.children as React.ReactNode);
  }
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}
const source = await readFile(new URL('../components/receipt-scan-review.tsx', import.meta.url), 'utf8');
const compiled = transpileModule(source, {compilerOptions: {module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.ReactJSX}}).outputText;
const exported = {exports: {} as {default: (props: {entry: ReceiptEditor; onChange(entry: ReceiptEditor): void}) => React.ReactNode; ReceiptReviewSummary: (props: {entry: ReceiptEditor}) => React.ReactNode}};
new Function('require', 'module', 'exports', compiled)((name: string) => {
  if (name === 'react') return {useId: () => 'review-title', useMemo: (callback:()=>unknown) => callback(), useEffect() {}, useState: (initial: unknown) => [initial, () => {}]};
  if (name === 'react/jsx-runtime') return runtime;
  if (name === '@/components/expense-quick-review') return {focusExpenseTarget() {}};
  if (name === '@/lib/model') return model;
  if (name === '@/lib/receipt-processing') return processing;
  if (name === '@/lib/receipt-scan') return scan;
  if (name === '@/lib/money-format') return money;
  throw Error(`Unexpected import ${name}`);
}, exported, exported.exports);
function entry(overrides: Partial<ReceiptEditor> = {}): ReceiptEditor {
  return {id: 'draft', draftId: 'draft', receiptId: 'photo', title: 'Lunch', date: '2026-10-05', time: '12:00', timezone: 'Europe/Vienna', payer: 'alice', currency: 'EUR', items: [{id: 'pizza', name: 'Pizza slices', amount: 1200, members: ['alice']}], tax: 0, tip: 0, discount: 0, receiptScan: {version: 1, printedTotal: 1200, printedCurrency: 'EUR', status: 'matched', warnings: []}, ...overrides};
}
// The editor shows the receipt's evidence under Purchase and the points Save
// confirms under Check & save; render both, as the editor does.
function render(value: ReceiptEditor) {
  let changed: ReceiptEditor | undefined;
  const evidence = exported.exports.default({entry: value, onChange(next) {changed = next;}});
  const summary = exported.exports.ReceiptReviewSummary({entry: value});
  const tree = [evidence, summary];
  return {tree, evidence, elements: elements(tree), text: text(tree).replace(/\s+/g, " "), get changed() {return changed;}};
}

test('unprocessed photo shows no verified printed total or invented receipt line', () => {
  const ui = render(entry({items: [], receiptScan: undefined}));
  assert.match(ui.text, /Receipt not processed yet/);
  assert.match(ui.text, /Printed receipt total Not verified/);
  assert.match(ui.text, /Itemised total Not processed/);
  assert.match(ui.text, /0 lines/);
  assert.doesNotMatch(ui.text, /€0\.00|match exactly/);
});

test('matching receipt reports recognition without repeating who still needs assigning', () => {
  const ui = render(entry({items: [{id: 'pizza', name: 'Pizza slices', amount: 1200, members: [], quantity: {total: 2, label: 'slices'}, units: {total: 2, allocations: {}, label: 'slices'}}]}));
  assert.match(ui.text, /Receipt totals match exactly/);
  // The line, the bulk share and the Save checklist each say this once.
  assert.doesNotMatch(ui.text, /need people assigned|Choose who owes/);
  assert.doesNotMatch(ui.text, /ready to save/i);
});

test('unknown prices stay incomplete and cannot be dismissed by a review button', () => {
  const ui = render(entry({items: [{id: 'pizza', name: 'Pizza', amount: null, members: ['alice']}]}));
  assert.match(ui.text, /Incomplete prices/);
  assert.match(ui.text, /1 missing price/);
  assert.match(ui.text, /Item price is unreadable/);
  const issue = ui.elements.find(element => element.type === 'li' && text(element.props.children as React.ReactNode).includes('Item price is unreadable'));
  assert(issue);
  assert.equal(elements(issue).filter(element => element.type === 'button').length, 0);
});

test('printed currency is displayed independently and a wrong original currency cannot look matched', () => {
  const ui = render(entry({currency: 'GBP'}));
  assert.match(ui.text, /Printed receipt total €12\.00/);
  assert.match(ui.text, /Itemised total £12\.00/);
  assert.match(ui.text, /The selected currency differs from the printed currency/);
  assert.doesNotMatch(ui.text, /Receipt totals match exactly/);
});

test('one-cent mismatch appears in the acceptance summary without an editing acknowledgement', () => {
  const value = entry({receiptScan: {version: 1, printedTotal: 1201, status: 'matched', warnings: []}});
  const ui=render(value);
  assert.match(ui.text,/Itemised total differs from printed total by €0.01/);
  assert.match(ui.text,/Confirm & save expense accepts/);
  assert.equal(ui.elements.filter(element=>element.type==='input' && element.props.type==='checkbox').length,0);
  assert.equal(ui.changed,undefined);assert(scan.receiptScanSaveError(value));
  // The receipt's thumbnail is the one way to see the photo; the summary links to lines instead.
  assert.equal(ui.elements.filter(element=>element.type==='a').length,0);
});

test('an unmapped adjustment is named with its printed evidence for the final confirmation', () => {
  const value=entry({receiptScan:{version:1,printedTotal:1200,status:'matched',warnings:[],sourceLines:[{kind:'adjustment',mappedTo:'unmapped',amount:-100,observedText:'Item coupon -1,00',lineIndex:8}]}});
  const ui=render(value);assert.match(ui.text,/Correct the affected item's full line price and shares/);
  assert.match(ui.text,/A discount, refund or charge needs checking/);assert.match(ui.text,/Item coupon -1,00/);assert.match(ui.text,/line 9/);
  assert.equal(ui.elements.filter(element=>element.type==='button').length,0);assert.equal(ui.changed,undefined);
  assert(scan.receiptScanSaveError(value));assert.equal(scan.receiptScanSaveError(scan.acknowledgeReceiptReview(value)),null);
});

test('correcting printed total requires a value from the photo and records user provenance', () => {
  const ui = render(entry({receiptScan: {version: 1, printedTotal: null, status: 'incomplete', warnings: []}}));
  const control = ui.elements.find(element => typeof element.type === 'function' && element.props.label === 'Printed grand total');
  assert(control);
  (control.props.onChange as (value: number) => void)(1200);
  assert.equal(ui.changed?.receiptScan?.printedTotal, 1200);
  assert.equal(ui.changed?.receiptScan?.fieldSources?.printedTotal, 'user');
  assert.equal(scan.receiptScanSaveError(ui.changed!), null);
});

test('a 200-line receipt keeps one labelled summary instead of a message per unassigned line', () => {
  const items = Array.from({length: 200}, (_, index) => ({id: `line-${index}`, name: `Line ${index} ${'Long name '.repeat(15)}`, amount: 100, members: []}));
  const ui = render(entry({items, receiptScan: {version: 1, printedTotal: 20000, status: 'matched', warnings: []}}));
  assert.doesNotMatch(ui.text, /need people assigned/);
  assert.equal(ui.elements.filter(element => element.type === 'li').length, 0);
  const section = elements(ui.evidence)[0];
  assert.equal(section.props['aria-labelledby'], 'review-title');
  assert.match(ui.text, /Receipt totals match exactly/);
  assert.match(ui.text, /Itemised total €200\.00/);
  const missing = render(entry({items: items.map((item, index) => index ? item : {...item, amount: null}), receiptScan: {version: 1, printedTotal: 20000, status: 'matched', warnings: []}}));
  assert.match(missing.text, /200 lines · 1 missing price/, 'line counts appear when a price still needs entering');
});

test('duplicate warnings preserve both affected pairs and link to their item evidence', () => {
  const value=entry({items:[{id:'pizza',name:'Pizza',amount:1200,members:['alice']},{id:'line-2',name:'Pizza duplicate',amount:0,members:['alice']},{id:'line-3',name:'Pizza similar',amount:0,members:['alice']}],receiptScan:{version:1,printedTotal:1200,status:'needs-review',warnings:[{code:'possible-duplicate',itemIds:['pizza','line-2']},{code:'possible-duplicate',itemIds:['pizza','line-3']}]}});
  const ui=render(value);assert.match(ui.text,/Possible duplicate receipt lines: Pizza, Pizza duplicate/);assert.match(ui.text,/Possible duplicate receipt lines: Pizza, Pizza similar/);
  assert(ui.elements.some(element=>element.type==='button' && text(element.props.children as React.ReactNode).replace(/\s+/g,' ').trim()==='Check Pizza similar'));
  assert.equal(ui.elements.filter(element=>element.type==='a').length,0);
  assert.equal(ui.changed,undefined);
});

test('the missing total summary names the amount being saved without inventing evidence', () => {
  const value=entry({receiptScan:{version:1,printedTotal:null,printedCurrency:'EUR',status:'incomplete',warnings:[]}});
  const ui=render(value);assert.match(ui.text,/Printed total not readable — saving the itemised €12.00/);
  assert.equal(ui.elements.filter(element=>element.type==='input' && element.props.type==='checkbox').length,0);
  assert.equal(ui.changed,undefined);assert.equal(value.receiptScan?.printedTotal,null);
});

test('ambiguous currency is visible alongside missing total and uncertain lines with no review controls', () => {
  const value=entry({fieldSources:{currency:'ai'},items:[{id:'pizza',name:'Pizza',amount:1200,members:['alice'],scanSource:{confidence:'low'}}],receiptScan:{version:1,printedTotal:null,status:'incomplete',warnings:[{code:'ambiguous-currency'},{code:'image-may-be-incomplete'}]}});
  const ui=render(value);assert.match(ui.text,/Currency read as EUR/);assert.match(ui.text,/Printed total not readable/);
  assert.match(ui.text,/Receipt detail needs checking: Pizza/);assert.match(ui.text,/Receipt image may be incomplete/);
  assert.equal(ui.elements.filter(element=>element.type==='input' && element.props.type==='checkbox').length,0);
  assert(ui.elements.filter(element=>element.type==='button').every(element=>text(element.props.children as React.ReactNode).startsWith('Check ')));
  assert.equal(ui.changed,undefined);assert.equal(scan.receiptScanSaveError(scan.acknowledgeReceiptReview(value)),null);
});

test('an empty item name is a correction and never appears as an acceptance point', () => {
  const value=entry({items:[{id:'pizza',name:'',amount:1200,members:['alice']}]});
  const ui=render(value);assert.match(ui.text,/Item description needs checking/);assert.doesNotMatch(ui.text,/Confirm when saving/);
  assert.equal(scan.pendingReviewActions(value),0);assert(scan.receiptScanSaveError(scan.acknowledgeReceiptReview(value)));
});
