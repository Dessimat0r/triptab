import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as React from 'react';
import * as runtime from 'react/jsx-runtime';
import { JsxEmit, ModuleKind, transpileModule } from 'typescript';
import { translateUi } from '../lib/ui-language';

const source = transpileModule(readFileSync(new URL('../components/interface-language.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX },
}).outputText;
type Element = React.ReactElement<Record<string, unknown>>;
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children)];
}
async function choose(onSaved: () => Promise<boolean>, response = Response.json({ language: 'fr' })) {
  const saved: string[] = [], errors: string[] = [], requests: Record<string, unknown>[] = [];
  const loaded = { exports: {} as { default: (props: unknown) => React.ReactNode } };
  const fetcher = async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return response;
  };
  new Function('require', 'module', 'exports', 'fetch', source)((name: string) => {
    if (name === 'react') return { useState: (initial: unknown) => [initial, (value: unknown) => { if (typeof value === 'string') errors.push(value); }] };
    if (name === 'react/jsx-runtime') return runtime;
    if (name === '@/lib/ui-language') return { setUiLanguage: (language: string) => saved.push(language), t: (text: string) => translateUi(text, 'en') };
    throw Error(name);
  }, loaded, loaded.exports, fetcher);
  const selector = elements(loaded.exports.default({ accountId: 'alice', value: 'en', onSaved })).find(element => element.type === 'select')!;
  await (selector.props.onChange as (event: unknown) => Promise<void>)({ target: { value: 'fr' } });
  return { saved, errors, requests };
}
test('the language chooser binds a save to its account and applies it after the parent refresh', async () => {
  const result = await choose(async () => true);
  assert.deepEqual(result.requests, [{ language: 'fr', accountId: 'alice' }]);
  assert.deepEqual(result.saved, ['fr']);
});
test('a late save cannot change the interface after switching accounts', async () => {
  const result = await choose(async () => false);
  assert.deepEqual(result.saved, []);
});
test('language conflicts retain the selected interface and explain how to retry', async () => {
  const message = 'Your language settings changed. Reopen settings and try again.';
  const result = await choose(async () => true, Response.json({ error: message }, { status: 409 }));
  assert.deepEqual(result.saved, []);
  assert.equal(result.errors.at(-1), message);
});
