import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as runtime from 'react/jsx-runtime';
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { fileURLToPath } from 'node:url';
import { appRouter, matchAppRoute } from '../node_modules/vinext/dist/routing/app-router.js';

async function layout(path: string) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const compiled = transpileModule(source, {compilerOptions: {module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.ReactJSX}}).outputText;
  let applicationMounts = 0;
  const boundary = {exports: {} as {default: (props: {children: ReactNode}) => ReactNode}};
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (name === 'react/jsx-runtime') return runtime;
    if (name === './globals.css') return {};
    if (name === '@/components/trip-app') return {__esModule: true, default: ({children}: {children: ReactNode}) => {
      applicationMounts++;
      return createElement('div', {'data-holiday-application': true}, children);
    }};
    throw Error(`Unexpected layout dependency: ${name}`);
  }, boundary, boundary.exports);
  return {
    render(children: ReactNode) {return renderToStaticMarkup(boundary.exports.default({children}));},
    get applicationMounts() {return applicationMounts;},
  };
}

test('the root layout renders a missing page without mounting ledger or account state', async () => {
  const root = await layout('../app/layout.tsx');
  const markup = root.render(createElement('main', null, createElement('h1', null, '404'), createElement('p', null, 'This page could not be found.')));
  assert.equal(root.applicationMounts, 0, 'the application must not replace a missing page with its sign-in screen');
  assert.match(markup, /This page could not be found\./);
  assert.doesNotMatch(markup, /data-holiday-application/);
});

test('the ledger route group mounts one shared application around its section page', async () => {
  const ledger = await layout('../app/(ledger)/layout.tsx');
  const markup = ledger.render(createElement('section', {id: 'panel-balances'}, 'Saved traveller balances'));
  assert.equal(ledger.applicationMounts, 1);
  assert.match(markup, /data-holiday-application/);
  assert.match(markup, /Saved traveller balances/);
});

test('the production framework routes unknown URLs outside the persistent ledger layout', async () => {
  const routes = await appRouter(fileURLToPath(new URL('../app', import.meta.url)));
  const root = fileURLToPath(new URL('../app/layout.tsx', import.meta.url));
  const ledger = fileURLToPath(new URL('../app/(ledger)/layout.tsx', import.meta.url));
  const missing = fileURLToPath(new URL('../app/[...missing]/page.tsx', import.meta.url));
  for (const url of ['/unknown', '/unknown/nested', '/api/unknown']) {
    const match = matchAppRoute(url, routes);
    assert(match);
    assert.equal(match.route.pagePath, missing);
    assert.deepEqual(match.route.layouts, [root], 'missing pages cannot mount account or holiday state');
  }
  for (const url of ['/', '/expenses', '/balances', '/receipts', '/travellers', '/history']) {
    const match = matchAppRoute(url, routes);
    assert(match);
    assert.notEqual(match.route.pagePath, missing, 'the catch-all must not replace a real section route');
    assert.deepEqual(match.route.layouts, [root, ledger]);
  }
});
