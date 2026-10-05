import assert from 'node:assert/strict';
import test from 'node:test';
import { ModuleKind, ScriptTarget } from 'typescript';
import { transpileWithSharedImports } from './helpers/transpile';

test('shared imports honor explicit mocks in static, re-exported and dynamic imports without rewriting ordinary text', async () => {
  const dataURL = (source: string) => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const mockAudit = dataURL('export const marker = "mock audit";');
  const mockReact = dataURL('export const marker = "mock React";');
  const compiled = transpileWithSharedImports(`
    export { marker as relativeAudit } from './audit';
    import { marker as aliasAudit } from "@/lib/audit";
    import { marker as react } from 'react';
    export { aliasAudit, react };
    export const ordinaryText = './audit';
    export const dynamicAudit = async () => (await import('./audit')).marker;
  `, {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
    sharedImportOverrides: { './audit': mockAudit, '@/lib/audit': mockAudit, react: mockReact },
  }).outputText;
  const loaded = await import(dataURL(compiled));
  assert.equal(loaded.relativeAudit, 'mock audit');
  assert.equal(loaded.aliasAudit, 'mock audit');
  assert.equal(loaded.react, 'mock React');
  assert.equal(await loaded.dynamicAudit(), 'mock audit');
  assert.equal(loaded.ordinaryText, './audit');
});
