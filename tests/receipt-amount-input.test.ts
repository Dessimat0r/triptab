import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as React from 'react';
import * as runtime from 'react/jsx-runtime';
import { t } from '../lib/ui-language';
import { createSourceFile, isFunctionDeclaration, JsxEmit, ModuleKind, ScriptKind, ScriptTarget, transpileModule } from 'typescript';
const source = await readFile(new URL('../components/trip-app.tsx', import.meta.url), 'utf8');
const syntax = createSourceFile('trip-app.tsx', source, ScriptTarget.Latest, true, ScriptKind.TSX);
const declaration = syntax.statements.find(statement => isFunctionDeclaration(statement) && statement.name?.text === 'Amount');
const parser = syntax.statements.find(statement => isFunctionDeclaration(statement) && statement.name?.text === 'parseAmountText');
assert(declaration && parser);
const compiled = transpileModule(parser.getText(syntax) + '\n' + declaration.getText(syntax) + '\nmodule.exports = Amount; module.exports.parseAmountText = parseAmountText;', {compilerOptions: {module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.ReactJSX}}).outputText;
function control(initial: number | null, nullable: boolean) {
  let value = initial, text: unknown;
  const changes: (number | null)[] = [];
  const hooks = {useEffect() {}, useState(next: unknown) {if(text === undefined)text = next;return [text, (next: unknown) => {text = next;}];}};
  const loaded = {exports: {} as (props: {value: number | null; nullable: boolean; label: string; onChange(value: number | null): void}) => React.ReactElement<Record<string, unknown>>};
  new Function('require', 'module', 'exports', 'useState', 'useEffect', 'uiText', compiled)(() => runtime, loaded, loaded.exports, hooks.useState, hooks.useEffect, t);
  function render() {return loaded.exports({value, nullable, label: 'Full line total', onChange(next) {value = next; changes.push(next);}});}
  return {change(next: string) {(render().props.onChange as (event: unknown) => void)({target: {value: next}});}, blur() {(render().props.onBlur as () => void)();}, get value() {return value;}, get text() {return render().props.value;}, changes};
}

test('unreadable price stays unknown through empty and bare decimal input and blur', () => {
  const amount = control(null, true); assert.equal(amount.text, '');
  amount.change('.'); assert.equal(amount.value, null); amount.blur(); assert.equal(amount.text, '');
  amount.change(''); amount.blur(); assert.equal(amount.value, null);
  assert(amount.changes.every(value => value === null), 'unknown cannot be silently converted to a zero-priced receipt line');
});

test('a genuine zero line remains distinct from an unreadable price', () => {
  const amount = control(null, true); amount.change('0'); amount.blur();
  assert.equal(amount.value, 0); assert.equal(amount.text, '0.00');
});

test('receipt prices reject large or nonfinite paste without poisoning reconciliation', () => {
  const amount = control(1200, true);
  for (const text of ['1000000.01', '9'.repeat(400), 'NaN', 'Infinity', '-1.00']) amount.change(text);
  assert.equal(amount.value, 1200); assert.equal(amount.text, '12.00'); assert.deepEqual(amount.changes, []);
  amount.change('1000000.00'); assert.equal(amount.value, 100000000);
});

test('unfinished adjustment decimal retains its earlier finite value on blur', () => {
  const amount = control(250, false); amount.change('.'); amount.blur();
  assert.equal(amount.value, 250); assert.equal(amount.text, '2.50');
  assert(amount.changes.every(value => value === null || Number.isSafeInteger(value)));
});

test('focus, blur and equivalent decimal formatting never manufacture human confirmation', () => {
  const amount=control(1200,true); amount.blur(); amount.change('12.0'); amount.blur();
  assert.deepEqual(amount.changes,[]);
  amount.change('12.01'); amount.blur();
  assert.deepEqual(amount.changes,[1201]);
});

test('a decimal comma is a decimal separator, typed or pasted, and never a silent factor of 100', () => {
  const typed = control(0, false);
  for (const text of ['1', '12', '12,', '12,5', '12,50']) typed.change(text);
  assert.equal(typed.value, 1250); typed.blur(); assert.equal(typed.text, '12.50');
  const pasted = control(0, false); pasted.change('12,50'); assert.equal(pasted.value, 1250);
  const dotted = control(0, false); dotted.change('12.50'); assert.equal(dotted.value, 1250);
});

test('ambiguous grouped or signed amounts are refused rather than reinterpreted', () => {
  const amount = control(1250, false);
  for (const text of ['1,234.56', '1.234,56', '12,5,0', '12,505', '-12,50', '12 50']) amount.change(text);
  assert.equal(amount.value, 1250); assert.equal(amount.text, '12.50'); assert.deepEqual(amount.changes, []);
});

test('a required amount of zero shows an empty field so typing starts a new number', () => {
  const amount = control(0, false); assert.equal(amount.text, '');
  amount.change('7'); assert.equal(amount.value, 700);
  amount.change(''); assert.equal(amount.value, 0); amount.blur(); assert.equal(amount.text, '');
});
