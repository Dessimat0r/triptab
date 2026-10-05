import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as React from 'react';
import * as runtime from 'react/jsx-runtime';
import { createSourceFile, isFunctionDeclaration, JsxEmit, ModuleKind, ScriptKind, ScriptTarget, transpileModule } from 'typescript';
const source = await readFile(new URL('../components/trip-app.tsx', import.meta.url), 'utf8');
const syntax = createSourceFile('trip-app.tsx', source, ScriptTarget.Latest, true, ScriptKind.TSX);
const declaration = syntax.statements.find(statement => isFunctionDeclaration(statement) && statement.name?.text === 'Amount');
assert(declaration);
const compiled = transpileModule(declaration.getText(syntax) + '\nmodule.exports = Amount;', {compilerOptions: {module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.ReactJSX}}).outputText;
function control(initial: number | null, nullable: boolean) {
  let value = initial, text: unknown;
  const changes: (number | null)[] = [];
  const hooks = {useEffect() {}, useState(next: unknown) {if(text === undefined)text = next;return [text, (next: unknown) => {text = next;}];}};
  const loaded = {exports: {} as (props: {value: number | null; nullable: boolean; label: string; onChange(value: number | null): void}) => React.ReactElement<Record<string, unknown>>};
  new Function('require', 'module', 'exports', 'useState', 'useEffect', compiled)(() => runtime, loaded, loaded.exports, hooks.useState, hooks.useEffect);
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
