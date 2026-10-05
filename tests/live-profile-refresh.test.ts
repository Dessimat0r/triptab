import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createSourceFile, isFunctionDeclaration, isJsxAttribute, isJsxExpression, isJsxSelfClosingElement, ModuleKind, ScriptKind, ScriptTarget, transpileModule } from 'typescript';
import type { Profile } from '../components/account-panel';

const source = await readFile(new URL('../components/trip-app.tsx', import.meta.url), 'utf8');
const syntax = createSourceFile('trip-app.tsx', source, ScriptTarget.Latest, true, ScriptKind.TSX);
const home = syntax.statements.find(statement => isFunctionDeclaration(statement) && statement.name?.text === 'Home');
assert(home && isFunctionDeclaration(home) && home.body);
const handlers = ['refreshProfile', 'accountAuthenticated'].map(name => {
  const handler = home.body!.statements.find(statement => isFunctionDeclaration(statement) && statement.name?.text === name);
  assert(handler && isFunctionDeclaration(handler));
  return handler.getText(syntax);
}).join('\n');
let onSaved = '';
function visit(node: import('typescript').Node) {
  if (isJsxSelfClosingElement(node) && node.tagName.getText(syntax) === 'AccountPanel') {
    const attribute = node.attributes.properties.find(property => isJsxAttribute(property) && property.name.getText(syntax) === 'onSaved');
    assert(attribute && isJsxAttribute(attribute) && attribute.initializer && isJsxExpression(attribute.initializer));
    onSaved = attribute.initializer.expression!.getText(syntax);
  }
  node.forEachChild(visit);
}
visit(home);
assert(onSaved);
const compiled = transpileModule(`return function controller(fetch, initialProfile) {
  let profile=initialProfile, ledger={trips:[{id:'private-holiday'}]}, editing={id:'unsaved-receipt'}, receiptAI={connected:true}, paymentEditor={id:'unsaved-payment'}, receiptResets=0, account=true, auth=false;
  const profileReadRequest={current:0}, profileReadInFlight={current:null}, activeProfile={current:profile};
  const receiptSessionScope={current:{accountId:profile?.id||'',tripId:''}};
  const loadRequest={current:0}, latestSnapshot={current:{data:ledger,revision:3}}, savedEtag={current:'old-account'}, loadCalls=[];
  const setProfile=next=>{profile=typeof next==='function'?next(profile):next;activeProfile.current=profile;};
  const equalSavedValue=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
  const load=async options=>{loadCalls.push(options);};
  const resetReceiptReview=()=>{receiptResets++;},setEditing=next=>{editing=next;},setReceiptAI=next=>{receiptAI=next;},setPaymentEditor=next=>{paymentEditor=next;};
  const setLedger=next=>{ledger=next;},setRevision=()=>{},setActivityRefreshKey=()=>{},setAuth=next=>{auth=next;},setError=()=>{},setAccount=next=>{account=next;};
  ${handlers}
  const saveProfile=${onSaved};
  return {refreshProfile,accountAuthenticated,saveProfile,loadCalls,get profile(){return profile;},get editing(){return editing;},get receiptAI(){return receiptAI;},get paymentEditor(){return paymentEditor;},get ledger(){return ledger;},get receiptResets(){return receiptResets;},get account(){return account;},get auth(){return auth;}};
}`, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
type Controller = {
  refreshProfile(accountId: string): Promise<void>;
  accountAuthenticated(profile: Profile): Promise<void>;
  saveProfile(profile: Profile): void;
  loadCalls: ({ background?: boolean; fresh?: boolean } | undefined)[];
  profile: Profile | null;
  editing: object | null;
  receiptAI: object | null;
  paymentEditor: object | null;
  ledger: { trips: { id: string }[] };
  receiptResets: number;
  account: boolean;
};
const controller = new Function(compiled)() as (fetcher: (url: string, options?: RequestInit) => Promise<Response>, profile: Profile | null) => Controller;
const owner: Profile = { id: 'owner', email: 'owner@example.test', displayName: 'Original name', hasPassword: true, chatgptConnected: false };
const second: Profile = { id: 'second', email: 'second@example.test', displayName: 'Second account' };
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); };

test('profile checks coalesce and update same-account fields without resetting open editors', async () => {
  let calls = 0, finish!: (response: Response) => void;
  const app = controller(async (url, options) => {
    calls++; assert.equal(url, '/api/profile'); assert.equal(options?.cache, 'no-store');
    return new Promise(resolve => { finish = resolve; });
  }, owner);
  const receipt = app.editing, payment = app.paymentEditor;
  const first = app.refreshProfile(owner.id), secondRead = app.refreshProfile(owner.id);
  assert.equal(calls, 1);
  finish(Response.json({ ...owner, displayName: 'Remote name', chatgptConnected: true, emailVerified: true }));
  await Promise.all([first, secondRead]);
  assert.equal(app.profile?.displayName, 'Remote name');
  assert.equal(app.profile?.chatgptConnected, true);
  assert.equal(app.profile?.emailVerified, true);
  assert.equal(app.editing, receipt);
  assert.equal(app.paymentEditor, payment);
  assert.equal(app.receiptResets, 0);
  assert.equal(app.account, true);
});

test('a delayed profile check cannot undo a profile saved by the open account form', async () => {
  let finish!: (response: Response) => void;
  const app = controller(async () => new Promise(resolve => { finish = resolve; }), owner);
  const reading = app.refreshProfile(owner.id);
  app.saveProfile({ ...owner, displayName: 'Just saved' });
  finish(Response.json({ ...owner, displayName: 'Old server read' }));
  await reading;
  assert.equal(app.profile?.displayName, 'Just saved');
  assert.equal(app.account, false);
});

test('the next check after a local profile save starts a fresh read instead of reusing the invalidated one', async () => {
  const replies: ((response: Response) => void)[] = [];
  const app = controller(async () => new Promise(resolve => { replies.push(resolve); }), owner);
  const oldRead = app.refreshProfile(owner.id);
  app.saveProfile({ ...owner, displayName: 'Just saved' });
  const freshRead = app.refreshProfile(owner.id);
  assert.equal(replies.length, 2);
  replies[1](Response.json({ ...owner, displayName: 'Just saved', emailVerified: true })); await freshRead;
  replies[0](Response.json(owner)); await oldRead;
  assert.equal(app.profile?.displayName, 'Just saved');
  assert.equal(app.profile?.emailVerified, true);
});

test('automatic account detection safely clears the previous account editors and ledger', async () => {
  const app = controller(async () => Response.json(second), owner);
  await app.refreshProfile(owner.id);
  assert.equal(app.profile?.id, second.id);
  assert.equal(app.editing, null);
  assert.equal(app.paymentEditor, null);
  assert.equal(app.receiptAI, null);
  assert.deepEqual(app.ledger, { trips: [] });
  assert.equal(app.receiptResets, 1);
});

test('an old account response arriving after authentication cannot replace the new account', async () => {
  let firstRead = true, finish!: (response: Response) => void;
  const app = controller(async () => {
    if (firstRead) { firstRead = false; return new Promise(resolve => { finish = resolve; }); }
    return Response.json(second);
  }, owner);
  const reading = app.refreshProfile(owner.id);
  await app.accountAuthenticated(second);
  finish(Response.json(owner)); await reading;
  assert.equal(app.profile?.id, second.id);
  assert.equal(app.receiptResets, 1);
});

test('the post-authentication profile read cannot overwrite a newer account-form save', async () => {
  let finish!: (response: Response) => void;
  const app = controller(async () => new Promise(resolve => { finish = resolve; }), owner);
  const authenticating = app.accountAuthenticated(second);
  await settle();
  app.saveProfile({ ...second, displayName: 'Saved after signing in' });
  finish(Response.json({ ...second, displayName: 'Older authentication read' }));
  await authenticating;
  assert.equal(app.profile?.displayName, 'Saved after signing in');
});

test('expired profile authentication checks the ledger freshly without reloading the page', async () => {
  const app = controller(async () => new Response(null, { status: 401 }), owner);
  await app.refreshProfile(owner.id);
  assert.deepEqual(app.loadCalls, [{ background: true, fresh: true }]);
});

test('failed and malformed profile checks preserve local state and can retry automatically', async () => {
  let result: Response | Error = new Error('offline');
  const app = controller(async () => { if (result instanceof Error) throw result; return result; }, owner);
  const receipt = app.editing;
  await app.refreshProfile(owner.id);
  result = Response.json({ id: owner.id, displayName: 123, email: owner.email });
  await app.refreshProfile(owner.id);
  assert.equal(app.profile, owner);
  result = Response.json({ ...owner, displayName: 'Recovered' });
  await app.refreshProfile(owner.id);
  assert.equal(app.profile?.displayName, 'Recovered');
  assert.equal(app.editing, receipt);
});

test('initial profile loading accepts the authenticated owner without discarding initial ledger data', async () => {
  const app = controller(async () => Response.json(owner), null);
  await app.refreshProfile(''); await settle();
  assert.equal(app.profile?.id, owner.id);
  assert.equal(app.receiptResets, 0);
  assert.equal(app.ledger.trips.length, 1);
});
