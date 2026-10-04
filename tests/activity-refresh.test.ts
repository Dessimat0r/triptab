import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createSourceFile, isCallExpression, isFunctionDeclaration, isIdentifier, isJsxAttribute, isJsxSelfClosingElement, isVariableStatement, ModuleKind, ScriptKind, ScriptTarget, transpileModule } from 'typescript';
import { ledgerEtag } from '../lib/ledger-freshness';
import type { Ledger } from '../lib/model';

const source = await readFile(new URL('../app/page.tsx', import.meta.url), 'utf8');
const syntax = createSourceFile('page.tsx', source, ScriptTarget.Latest, true, ScriptKind.TSX);
const home = syntax.statements.find(statement => isFunctionDeclaration(statement) && statement.name?.text === 'Home');
assert(home && isFunctionDeclaration(home) && home.body);
const callbacks = ['applySnapshot', 'load'].map(name => {
  const statement = home.body!.statements.find(statement => isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => isIdentifier(declaration.name) && declaration.name.text === name));
  assert(statement && isVariableStatement(statement));
  const declaration = statement.declarationList.declarations.find(declaration => isIdentifier(declaration.name) && declaration.name.text === name)!;
  assert(declaration.initializer && isCallExpression(declaration.initializer));
  return `const ${name} = ${declaration.initializer.arguments[0].getText(syntax)};`;
}).join('\n');
const panelKeys: string[] = [];
function findPanel(node: import('typescript').Node) {
  if (isJsxSelfClosingElement(node) && node.tagName.getText(syntax) === 'ActivityPanel') {
    const property = node.attributes.properties.find(property => isJsxAttribute(property) && property.name.getText(syntax) === 'refreshKey');
    assert(property && isJsxAttribute(property));
    panelKeys.push(property.initializer!.getText(syntax).slice(1, -1));
  }
  node.forEachChild(findPanel);
}
findPanel(syntax);
assert(panelKeys.length);
const controllerSource = `return function controller(fetch) {
  let ledger = {trips: []}, revision = 0, activityRefreshKey = 0, loading = false, error = '';
  const latestSnapshot = {current: {data: ledger, revision}}, savedEtag = {current: ''}, loadRequest = {current: 0}, editorBaseline = {current: null};
  const setLedger = next => {ledger = next}, setRevision = next => {revision = next}, setActivityRefreshKey = next => {activityRefreshKey = next};
  const setLoading = next => {loading = next}, setError = next => {error = next};
  const setLastRefreshed = () => {}, setAuth = () => {}, setProfile = () => {}, setEditorConflict = () => {};
  ${callbacks}
  return {load,applySnapshot,get revision(){return revision},get ledger(){return ledger},get refreshKey(){return ${panelKeys[0]}},get panelKeys(){return [${panelKeys.join(',')}]},get loading(){return loading},get error(){return error}};
}`;
const compiled = transpileModule(controllerSource, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
type Snapshot = {data: Ledger; revision: number};
type Controller = {load(): Promise<unknown>; applySnapshot(snapshot: Snapshot, etag?: string, invalidateRefresh?: boolean): boolean; revision: number; ledger: Ledger; refreshKey: string | number; panelKeys: (string | number)[]; loading: boolean; error: string};
const controller = new Function(compiled)() as (fetch: () => Promise<Response>) => Controller;

test('an invitation event refreshes the History panel with no ledger revision change', async () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec("CREATE TABLE trips(id TEXT PRIMARY KEY,owner TEXT); CREATE TABLE memberships(trip_id TEXT,user_id TEXT); CREATE TABLE activity_events(sequence INTEGER PRIMARY KEY,trip_id TEXT); INSERT INTO trips VALUES('holiday','alice'); INSERT INTO memberships VALUES('holiday','bob'); INSERT INTO activity_events VALUES(1,'holiday');");
    const database = {prepare(sql: string) {return {bind(...values: string[]) {return {async all() {return {results: sqlite.prepare(sql).all(...values)};}};}};}} as unknown as D1Database;
    const snapshot: Snapshot = {data: {trips: []}, revision: 5};
    const editor = controller(async () => Response.json(snapshot, {headers: {ETag: await ledgerEtag(database, 'bob')}}));
    await editor.load();
    const before = editor.refreshKey;
    sqlite.prepare('INSERT INTO activity_events VALUES(?,?)').run(2, 'holiday');
    await editor.load();
    assert.equal(editor.revision, 5);
    assert.notEqual(editor.refreshKey, before, 'the actual panel prop must follow the new invitation audit event');
    assert.equal(editor.refreshKey, await ledgerEtag(database, 'bob'));
    assert(editor.panelKeys.every(key => key === editor.refreshKey), 'holiday and receipt history must share the accepted freshness token');
    assert.deepEqual(editor.ledger, snapshot.data);
    assert.equal(editor.error, '');
  } finally {sqlite.close();}
});

test('a superseded equal-revision refresh cannot roll History back to an older ETag', async () => {
  let finish!: (response: Response) => void;
  const editor = controller(() => new Promise(resolve => {finish = resolve;}));
  const slow = editor.load();
  assert.equal(editor.applySnapshot({data: {trips: []}, revision: 5}, '"new-invitation"', true), true);
  finish(Response.json({data: {trips: []}, revision: 5}, {headers: {ETag: '"old-invitation"'}}));
  await slow;
  assert.equal(editor.refreshKey, '"new-invitation"');
  assert.equal(editor.revision, 5);
});

test('older revisions cannot change History freshness and headerless saves retain revision refresh', () => {
  const editor = controller(async () => {throw Error('unexpected fetch');});
  editor.applySnapshot({data: {trips: []}, revision: 5}, '"new"');
  assert.equal(editor.applySnapshot({data: {trips: []}, revision: 4}, '"old"'), false);
  assert.equal(editor.refreshKey, '"new"');
  editor.applySnapshot({data: {trips: []}, revision: 6}, '', true);
  assert.equal(editor.refreshKey, 6);
});
