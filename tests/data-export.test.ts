import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createSourceFile, isFunctionDeclaration, isJsxAttribute, isJsxSelfClosingElement, ModuleKind, ScriptKind, ScriptTarget, transpileModule } from 'typescript';

const source = await readFile(new URL('../components/data-export.tsx', import.meta.url), 'utf8');
const syntax = createSourceFile('data-export.tsx', source, ScriptTarget.Latest, true, ScriptKind.TSX);
const component = syntax.statements.find(statement => isFunctionDeclaration(statement) && statement.name?.text === 'DataExport');
assert(component && isFunctionDeclaration(component) && component.body);
const download = component.body.statements.find(statement => isFunctionDeclaration(statement) && statement.name?.text === 'download');
assert(download && isFunctionDeclaration(download));
// Execute the actual download handler. Only browser download plumbing and
// React setters are substituted; URL construction and cursor changes are real.
const compiled = transpileModule(`return function controller(fetch) {
  let busy=false,error='',status='',history=null,accountHistoryCursors={json:null,csv:null};
  const selectedTrip='holiday',receipts=false,request={current:null};
  const setBusy=v=>busy=v,setError=v=>error=v,setStatus=v=>status=v,setHistory=v=>history=v;
  const setAccountHistoryCursors=update=>{accountHistoryCursors=update(accountHistoryCursors)};
  const document={body:{appendChild(){}},createElement(){return {click(){},remove(){}}}};
  const setTimeout=callback=>callback();
  ${download.getText(syntax)}
  return {download,get cursors(){return {...accountHistoryCursors}},get busy(){return busy},get error(){return error}};
}`, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
type Controller = { download(scope: 'account-activity', format: 'json' | 'csv', older?: boolean): Promise<void>; cursors: { json: number | null; csv: number | null }; busy: boolean; error: string };
const controller = new Function(compiled)() as (fetcher: (url: string, options: RequestInit) => Promise<Response>) => Controller;

test('account JSON and CSV paginate independently while alternating downloads', async () => {
  const requests: URLSearchParams[] = [];
  const reader = controller(async url => {
    const query = new URL(url, 'https://triptab.test').searchParams;
    requests.push(query);
    const before = query.get('before');
    const next = before ? Number(before) - 100 : query.get('format') === 'json' ? 300 : 700;
    return new Response('download fixture', { headers: { 'x-export-next-cursor': String(next) } });
  });
  await reader.download('account-activity', 'json');
  assert.deepEqual(reader.cursors, { json: 300, csv: null });
  await reader.download('account-activity', 'csv');
  await reader.download('account-activity', 'json', true);
  assert.equal(requests[2].get('before'), '300');
  assert.deepEqual(reader.cursors, { json: 200, csv: 700 });
  await reader.download('account-activity', 'csv', true);
  assert.equal(requests[3].get('before'), '700');
  assert.deepEqual(reader.cursors, { json: 200, csv: 600 });
  assert.equal(reader.error, ''); assert.equal(reader.busy, false);
});

test('ending one account export format never clears the other format cursor', async () => {
  let ending = false;
  const reader = controller(async url => {
    const query = new URL(url, 'https://triptab.test').searchParams;
    return new Response('download fixture', { headers: ending ? {} : { 'x-export-next-cursor': query.get('format') === 'json' ? '10' : '20' } });
  });
  await reader.download('account-activity', 'json'); await reader.download('account-activity', 'csv');
  ending = true; await reader.download('account-activity', 'json', true);
  assert.deepEqual(reader.cursors, { json: null, csv: 20 });
});

test('each mounted account export is keyed to the authenticated profile so switching accounts resets private cursors and aborts pending downloads', async () => {
  for (const filename of ['account-panel.tsx', 'trip-app.tsx']) {
    const text = await readFile(new URL('../components/' + filename, import.meta.url), 'utf8');
    const ast = createSourceFile(filename, text, ScriptTarget.Latest, true, ScriptKind.TSX);
    const keys: string[] = [];
    function visit(node: import('typescript').Node) {
      if (isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'DataExport') {
        const key = node.attributes.properties.find(property => isJsxAttribute(property) && property.name.getText(ast) === 'key');
        assert(key && isJsxAttribute(key), `${filename} export must reset its component instance across accounts`);
        keys.push(key.initializer!.getText(ast));
      }
      node.forEachChild(visit);
    }
    visit(ast); assert(keys.length); assert.ok(keys.every(key => /profile\??\.id/.test(key)), `${filename} must use the current account identity`);
  }
});
