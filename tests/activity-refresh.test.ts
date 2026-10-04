import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createSourceFile, isCallExpression, isFunctionDeclaration, isIdentifier, isJsxAttribute, isJsxSelfClosingElement, isVariableStatement, ModuleKind, ScriptKind, ScriptTarget, transpileModule } from 'typescript';
import { ledgerEtag } from '../lib/ledger-freshness';
import type { Ledger } from '../lib/model';

const source = await readFile(new URL('../components/trip-app.tsx', import.meta.url), 'utf8');
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
const accountAuthenticated = home.body.statements.find(statement => isFunctionDeclaration(statement) && statement.name?.text === 'accountAuthenticated');
assert(accountAuthenticated && isFunctionDeclaration(accountAuthenticated));
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
  let ledger = {trips: []}, revision = 0, activityRefreshKey = 0, loading = false, error = '', auth = false, profile = {id: 'current-account'};
  const latestSnapshot = {current: {data: ledger, revision}}, savedEtag = {current: ''}, loadRequest = {current: 0}, inFlightLoad = {current: null}, editorBaseline = {current: null};
  const setLedger = next => {ledger = next}, setRevision = next => {revision = next}, setActivityRefreshKey = next => {activityRefreshKey = next};
  const setLoading = next => {loading = next}, setError = next => {error = next};
  const setLastRefreshed = () => {}, setAuth = next => {auth = next}, setProfile = next => {profile = next}, setEditorConflict = () => {};
  ${callbacks}
  ${accountAuthenticated.getText(syntax)}
  return {load,applySnapshot,accountAuthenticated,setError,get revision(){return revision},get ledger(){return ledger},get refreshKey(){return ${panelKeys[0]}},get panelKeys(){return [${panelKeys.join(',')}]},get loading(){return loading},get error(){return error},get auth(){return auth},get profile(){return profile}};
}`;
const compiled = transpileModule(controllerSource, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
type Snapshot = {data: Ledger; revision: number};
type Controller = {load(options?: {background?: boolean}): Promise<unknown>; applySnapshot(snapshot: Snapshot, etag?: string, invalidateRefresh?: boolean): boolean; accountAuthenticated(profile: object): Promise<void>; setError(message: string): void; revision: number; ledger: Ledger; refreshKey: string | number; panelKeys: (string | number)[]; loading: boolean; error: string; auth: boolean; profile: {id: string} | null};
const controller = new Function(compiled)() as (fetch: (url: string, options: RequestInit) => Promise<Response>) => Controller;

test('an invitation event refreshes the History panel with no ledger revision change', async () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec("CREATE TABLE trips(id TEXT PRIMARY KEY,owner TEXT); CREATE TABLE memberships(trip_id TEXT,user_id TEXT,member_id TEXT); CREATE TABLE profiles(id TEXT PRIMARY KEY,email TEXT); CREATE TABLE sync_state(id INTEGER PRIMARY KEY,revision INTEGER); CREATE TABLE activity_events(sequence INTEGER PRIMARY KEY,trip_id TEXT); INSERT INTO trips VALUES('holiday','alice'); INSERT INTO memberships VALUES('holiday','bob','bob-traveller'); INSERT INTO profiles VALUES('bob','bob@example.test'); INSERT INTO sync_state VALUES(1,5); INSERT INTO activity_events VALUES(1,'holiday');");
    function statement(sql: string, values: string[] = []) {
      return {bind(...next: string[]) {return statement(sql, next);}, async all() {return {results: sqlite.prepare(sql).all(...values)};}};
    }
    const database = {prepare: statement, async batch(statements: ReturnType<typeof statement>[]) {
      sqlite.exec('BEGIN');
      try {const results = await Promise.all(statements.map(query => query.all())); sqlite.exec('COMMIT'); return results;}
      catch (error) {sqlite.exec('ROLLBACK'); throw error;}
    }} as unknown as D1Database;
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

test('an unchanged conditional refresh preserves the ledger identity and advances only the shared save token', async () => {
  const unchanged = new Response(null, {status: 304, headers: {ETag: '"saved"', 'X-Ledger-Revision': '8'}});
  unchanged.json = async () => {throw Error('304 has no JSON body');};
  const editor = controller(async (_url, options) => {
    assert.equal(new Headers(options.headers).get('If-None-Match'), '"saved"');
    return unchanged;
  });
  const saved: Ledger = {trips: []};
  editor.applySnapshot({data: saved, revision: 5}, '"saved"');
  const result = await editor.load({background: true}) as Snapshot;
  assert.equal(editor.ledger, saved, 'unchanged refresh must not replace the data or invalidate render caches');
  assert.equal(result.data, saved);
  assert.equal(result.revision, 8);
  assert.equal(editor.revision, 8);
  assert.equal(editor.refreshKey, '"saved"');
  assert.equal(editor.error, '');
});

test('a delayed 304 cannot replace a newer accepted save token or History freshness', async () => {
  let finish!: (response: Response) => void;
  const editor = controller(() => new Promise(resolve => {finish = resolve;}));
  editor.applySnapshot({data: {trips: []}, revision: 5}, '"old"');
  const pending = editor.load();
  const newer: Ledger = {trips: []};
  editor.applySnapshot({data: newer, revision: 7}, '"new"', true);
  finish(new Response(null, {status: 304, headers: {ETag: '"old"', 'X-Ledger-Revision': '9'}}));
  await pending;
  assert.equal(editor.ledger, newer);
  assert.equal(editor.revision, 7);
  assert.equal(editor.refreshKey, '"new"');
});

test('a 304 cannot advance the token from a malformed, older or mismatched response', async () => {
  for (const header of ['', '-1', '1.5', 'Infinity', '9007199254740992', '4']) {
    const editor = controller(async () => new Response(null, {status: 304, headers: {ETag: '"saved"', 'X-Ledger-Revision': header}}));
    editor.applySnapshot({data: {trips: []}, revision: 5}, '"saved"');
    await editor.load();
    assert.equal(editor.revision, 5, header);
    assert.equal(editor.error, '', header);
  }
  const editor = controller(async () => new Response(null, {status: 304, headers: {ETag: '"other"', 'X-Ledger-Revision': '8'}}));
  editor.applySnapshot({data: {trips: []}, revision: 5}, '"saved"');
  await editor.load();
  assert.equal(editor.revision, 5);
  assert.match(editor.error, /inconsistent version/);
});

test('a superseding account-expiry response prevents an older 304 from reviving its ledger', async () => {
  let finish!: (response: Response) => void;
  let requests = 0;
  const editor = controller(async () => ++requests === 1 ? new Promise(resolve => {finish = resolve;}) : Response.json({error: 'Sign in'}, {status: 401}));
  editor.applySnapshot({data: {trips: []}, revision: 5}, '"saved"');
  const pending = editor.load();
  editor.applySnapshot({data: {trips: []}, revision: 5}, '"saved"', true);
  await editor.load();
  finish(new Response(null, {status: 304, headers: {ETag: '"saved"', 'X-Ledger-Revision': '9'}}));
  await pending;
  assert.equal(editor.revision, 0);
  assert.equal(editor.refreshKey, 0);
  assert.deepEqual(editor.ledger, {trips: []});
});

test('a focus refresh coalesces with the awaited financial refresh and cannot return an older held snapshot', async () => {
  let finish!: (response: Response) => void;
  let requests = 0;
  const editor = controller(async () => {
    requests++;
    return new Promise(resolve => {finish = resolve;});
  });
  editor.applySnapshot({data: {trips: []}, revision: 5}, '"saved"');
  const foreground = editor.load();
  const background = editor.load({background: true});
  assert.equal(requests, 1, 'the focus refresh shares the pending ledger request');
  finish(Response.json({data: {trips: []}, revision: 6}, {headers: {ETag: '"new-payment"'}}));
  const [financial, focus] = await Promise.all([foreground, background]) as Snapshot[];
  assert.equal(financial.revision, 6);
  assert.equal(focus.revision, 6);
  assert.equal(editor.revision, 6);
  assert.equal(editor.refreshKey, '"new-payment"');
});

test('account authentication starts its own refresh epoch and never reuses the previous account request', async () => {
  let finish!: (response: Response) => void;
  let requests = 0;
  const editor = controller(async (url, options) => {
    requests++;
    if (requests === 1) return new Promise(resolve => {finish = resolve;});
    if (url === '/api/profile') return Response.json({id: 'second-account'});
    assert.equal(new Headers(options.headers).get('If-None-Match'), null, 'an account switch clears the old ETag');
    return Response.json({data: {trips: []}, revision: 1}, {headers: {ETag: '"second-account"'}});
  });
  editor.applySnapshot({data: {trips: []}, revision: 5}, '"first-account"');
  const previous = editor.load();
  await editor.accountAuthenticated({id: 'second-account'});
  finish(new Response(null, {status: 304, headers: {ETag: '"first-account"', 'X-Ledger-Revision': '9'}}));
  await previous;
  assert.equal(editor.revision, 1);
  assert.equal(editor.refreshKey, '"second-account"');
  assert.equal(requests, 3);
});

test('a foreground financial action starts a fresh read after an earlier background snapshot', async () => {
  const replies: ((response: Response) => void)[] = [];
  const editor = controller(async () => new Promise(resolve => {replies.push(resolve);}));
  editor.applySnapshot({data: {trips: []}, revision: 5}, '"saved"');
  const poll = editor.load({background: true});
  let finished = false;
  const financial = editor.load().then(result => {finished = true; return result;});
  assert.equal(replies.length, 2, 'financial review needs a read started after the action');
  replies[0](Response.json({data: {trips: []}, revision: 6}, {headers: {ETag: '"earlier-poll"'}}));
  await poll;
  assert.equal(finished, false, 'an earlier background response cannot resolve the fresh financial check');
  replies[1](Response.json({data: {trips: []}, revision: 7}, {headers: {ETag: '"fresh-payment"'}}));
  const result = await financial as Snapshot;
  assert.equal(result.revision, 7);
  assert.equal(editor.revision, 7);
});

test('a failed request clears the shared promise so a later refresh can retry', async () => {
  let requests = 0;
  const editor = controller(() => {
    if (++requests === 1) throw Error('Network disconnected');
    return Promise.resolve(Response.json({data: {trips: []}, revision: 1}));
  });
  await editor.load();
  assert.match(editor.error, /Network disconnected/);
  await editor.load();
  assert.equal(requests, 2);
  assert.equal(editor.revision, 1);
});

test('a failed background refresh followed by an unchanged success leaves no stale error banner', async () => {
  let requests = 0;
  const editor = controller(async () => {
    if (++requests === 1) throw TypeError('Failed to fetch');
    return new Response(null, {status: 304, headers: {ETag: '"saved"', 'X-Ledger-Revision': '6'}});
  });
  const saved: Ledger = {trips: []};
  editor.applySnapshot({data: saved, revision: 5}, '"saved"');
  await editor.load({background: true});
  assert.equal(editor.error, '');
  assert.equal(editor.ledger, saved);
  assert.equal(editor.revision, 5);
  assert.equal(editor.loading, false);
  await editor.load({background: true});
  assert.equal(requests, 2);
  assert.equal(editor.error, '');
  assert.equal(editor.ledger, saved);
  assert.equal(editor.revision, 6);
});

test('background server failures and later success preserve an existing editor validation message', async () => {
  for (const failure of [Response.json({error: 'Temporary upstream failure'}, {status: 503}), new Response('<h1>Bad Gateway</h1>', {status: 502})]) {
    let requests = 0;
    const editor = controller(async () => ++requests === 1 ? failure
      : Response.json({data: {trips: []}, revision: 6}, {headers: {ETag: '"new"'}}));
    editor.applySnapshot({data: {trips: []}, revision: 5}, '"saved"');
    const message = 'Choose at least one person for receipt adjustments.';
    editor.setError(message);
    await editor.load({background: true});
    assert.equal(editor.error, message);
    assert.equal(editor.revision, 5);
    assert.equal(editor.auth, false);
    await editor.load({background: true});
    assert.equal(editor.error, message, 'a successful refresh must not clear unrelated local validation');
    assert.equal(editor.revision, 6);
  }
});

test('a foreground request still reports its failure when a background refresh joins it', async () => {
  let reject!: (error: Error) => void;
  const editor = controller(() => new Promise((_resolve, failed) => {reject = failed;}));
  editor.applySnapshot({data: {trips: []}, revision: 5}, '"saved"');
  const manual = editor.load();
  const focus = editor.load({background: true});
  reject(Error('Manual refresh could not connect'));
  await Promise.all([manual, focus]);
  assert.equal(editor.error, 'Manual refresh could not connect');
  assert.equal(editor.loading, false);
});

test('a background 401 clears saved account data even if its response body is empty or invalid', async () => {
  const saved: Ledger = {trips: [{
    id: 'private-holiday', name: 'Private holiday', currency: 'GBP',
    members: [{id: 'traveller', name: 'Alice', userId: 'current-account'}], drafts: [], payments: [],
    expenses: [{id: 'private-expense', title: 'Private receipt', date: '2026-10-04', time: '12:00', timezone: 'Europe/London', currency: 'GBP', payer: 'traveller', receiptId: 'private-photo',
      items: [{id: 'private-item', name: 'Lunch', amount: 1000, members: ['traveller']}], tax: 0, tip: 0, discount: 0}],
  }]};
  for (const response of [Response.json({error: 'Sign in'}, {status: 401}), new Response(null, {status: 401}), new Response('Sign in', {status: 401})]) {
    const editor = controller(async () => response);
    editor.applySnapshot({data: saved, revision: 5}, '"saved"');
    assert.equal(editor.ledger.trips[0].expenses[0].receiptId, 'private-photo');
    editor.setError('My unsaved receipt still needs review');
    await editor.load({background: true});
    assert.equal(editor.auth, true);
    assert.equal(editor.profile, null);
    assert.deepEqual(editor.ledger, {trips: []});
    assert.equal(editor.revision, 0);
    assert.equal(editor.refreshKey, 0);
    assert.equal(editor.error, 'My unsaved receipt still needs review');
    assert.equal(editor.loading, false);
  }
});
