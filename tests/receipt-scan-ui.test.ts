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
  return [element, ...elements(element.props.children as React.ReactNode)];
}
function text(node: React.ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join(' ');
  if (React.isValidElement(node)) return text((node as Element).props.children as React.ReactNode);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}
const source = await readFile(new URL('../components/receipt-scan-review.tsx', import.meta.url), 'utf8');
const compiled = transpileModule(source, {compilerOptions: {module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.ReactJSX}}).outputText;
const exported = {exports: {} as {default: (props: {entry: ReceiptEditor; onChange(entry: ReceiptEditor): void}) => React.ReactNode}};
new Function('require', 'module', 'exports', compiled)((name: string) => {
  if (name === 'react') return {useId: () => 'review-title', useMemo: (callback:()=>unknown) => callback(), useEffect() {}, useState: (initial: unknown) => [initial, () => {}]};
  if (name === 'react/jsx-runtime') return runtime;
  if (name === '@/lib/model') return model;
  if (name === '@/lib/receipt-processing') return processing;
  if (name === '@/lib/receipt-scan') return scan;
  if (name === '@/lib/money-format') return money;
  throw Error(`Unexpected import ${name}`);
}, exported, exported.exports);
function entry(overrides: Partial<ReceiptEditor> = {}): ReceiptEditor {
  return {id: 'draft', draftId: 'draft', receiptId: 'photo', title: 'Lunch', date: '2026-10-05', time: '12:00', timezone: 'Europe/Vienna', payer: 'alice', currency: 'EUR', items: [{id: 'pizza', name: 'Pizza slices', amount: 1200, members: ['alice']}], tax: 0, tip: 0, discount: 0, receiptScan: {version: 1, printedTotal: 1200, printedCurrency: 'EUR', status: 'matched', warnings: []}, ...overrides};
}
function render(value: ReceiptEditor) {
  let changed: ReceiptEditor | undefined;
  const tree = exported.exports.default({entry: value, onChange(next) {changed = next;}});
  return {tree, elements: elements(tree), text: text(tree).replace(/\s+/g, " "), get changed() {return changed;}};
}

test('unprocessed photo shows no verified printed total or invented receipt line', () => {
  const ui = render(entry({items: [], receiptScan: undefined}));
  assert.match(ui.text, /Receipt not processed yet/);
  assert.match(ui.text, /Printed receipt total Not verified/);
  assert.match(ui.text, /Itemised total Not processed/);
  assert.match(ui.text, /0 lines/);
  assert.doesNotMatch(ui.text, /€0\.00|match exactly/);
});

test('matching receipt reports recognition separately from unassigned people and pending quantities', () => {
  const ui = render(entry({items: [{id: 'pizza', name: 'Pizza slices', amount: 1200, members: [], quantity: {total: 2, label: 'slices'}, units: {total: 2, allocations: {}, label: 'slices'}}]}));
  assert.match(ui.text, /Receipt totals match exactly/);
  assert.match(ui.text, /1 need people assigned/);
  assert.match(ui.text, /Choose who owes/);
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
  assert.match(ui.text, /Original currency differs from the printed currency/);
  assert.doesNotMatch(ui.text, /Receipt totals match exactly/);
});

test('one-cent mismatch exposes a deliberate acknowledgement invalidated by a changed line price', () => {
  const value = entry({receiptScan: {version: 1, printedTotal: 1201, status: 'matched', warnings: []}});
  const ui = render(value);
  assert.match(ui.text, /Difference: -€0\.01/);
  assert.match(ui.text, /Save the reviewed itemised amount despite this difference/);
  const checkbox = ui.elements.find(element => element.type === 'input' && element.props.type === 'checkbox');
  assert(checkbox);
  (checkbox.props.onChange as (event: unknown) => void)({target: {checked: true}});
  assert(ui.changed);
  assert.equal(scan.receiptScanSaveError(ui.changed), null);
  assert(scan.receiptScanSaveError({...ui.changed, items: [{...ui.changed.items[0], amount: 1100}]}));
});

test('a generated unmapped source adjustment can only be resolved by explicit user review', () => {
  const value = entry({receiptScan: {version: 1, printedTotal: 1200, status: 'matched', warnings: [], sourceLines: [{kind: 'adjustment', mappedTo: 'unmapped', amount: -100, observedText: 'Item coupon -1,00', lineIndex: 8}]}});
  const ui = render(value);
  assert.match(ui.text, /Correct the affected item's full line price and shares/);
  const button = ui.elements.find(element => element.type === 'button' && element.props.children === 'I corrected and checked this adjustment');
  assert(button);
  assert(scan.receiptScanSaveError(value));
  (button.props.onClick as () => void)();
  assert(ui.changed?.receiptScan?.warnings.some(warning => warning.code === 'unmapped-adjustment' && warning.resolved));
  assert.equal(scan.receiptScanSaveError(ui.changed!), null);
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

test('200-line review with long descriptions preserves ordered counts and structured accessible warnings', () => {
  const items = Array.from({length: 200}, (_, index) => ({id: `line-${index}`, name: `Line ${index} ${'Long name '.repeat(15)}`, amount: 100, members: []}));
  const ui = render(entry({items, receiptScan: {version: 1, printedTotal: 20000, status: 'matched', warnings: []}}));
  assert.match(ui.text, /200 lines · 200 need people assigned/);
  assert.equal(ui.elements.filter(element => element.type === 'li').length, 200);
  const section = ui.elements[0];
  assert.equal(section.props['aria-labelledby'], 'review-title');
  assert.match(ui.text, /Receipt totals match exactly/);
});

test('checking one duplicate warning does not resolve a different pair of repeated lines', () => {
  const value = entry({items: [{id: 'pizza', name: 'Pizza', amount: 1200, members: ['alice']}, {id: 'line-2', name: 'Pizza duplicate', amount: 0, members: ['alice']}, {id: 'line-3', name: 'Pizza similar', amount: 0, members: ['alice']}], receiptScan: {version: 1, printedTotal: 1200, status: 'needs-review', warnings: [{code: 'possible-duplicate', itemIds: ['pizza', 'line-2']}, {code: 'possible-duplicate', itemIds: ['pizza', 'line-3']}]}});
  const ui = render(value);
  const buttons = ui.elements.filter(element => element.type === 'button' && element.props.children === 'I checked this against the receipt');
  assert.equal(buttons.length, 2); (buttons[0].props.onClick as () => void)();
  assert.deepEqual(ui.changed?.receiptScan?.warnings.filter(warning => warning.code === 'possible-duplicate').map(warning => warning.resolved), [true, undefined]);
});

test('missing printed total permits explicit item review without inventing printed evidence', () => {
  const value=entry({receiptScan:{version:1,printedTotal:null,printedCurrency:'EUR',status:'incomplete',warnings:[]}});
  const ui=render(value); assert.match(ui.text,/The printed total is unavailable/);
  const checkbox=ui.elements.find(element=>element.type==='input' && element.props.type==='checkbox'); assert(checkbox);
  (checkbox.props.onChange as (event:unknown)=>void)({target:{checked:true}});
  assert(ui.changed); assert.equal(ui.changed.receiptScan?.printedTotal,null);
  assert.equal(scan.receiptScanSaveError(ui.changed),null);
  assert.equal(scan.reconcileReceiptScan(ui.changed)?.status,'incomplete');
  assert(scan.receiptScanSaveError({...ui.changed,items:[{...ui.changed.items[0],amount:1100}]}));
});

test('difference checkbox fingerprints reconciled warnings exactly as Save does', () => {
  const value=entry({items:[{id:'pizza',name:'Human checked name',amount:1200,members:['alice'],fieldSources:{name:'user'}}],receiptScan:{version:1,printedTotal:1201,printedCurrency:'EUR',status:'needs-review',warnings:[{code:'uncertain-description',itemId:'pizza'}]}});
  const ui=render(value);
  const checkbox=ui.elements.find(element=>element.type==='input' && element.props.type==='checkbox'); assert(checkbox);
  (checkbox.props.onChange as (event:unknown)=>void)({target:{checked:true}});
  assert(ui.changed); assert.equal(scan.receiptScanSaveError(ui.changed),null);
});
