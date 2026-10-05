import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createSourceFile, isFunctionDeclaration, ModuleKind, ScriptKind, ScriptTarget, transpileModule } from 'typescript';
import { equalSavedValue } from '../lib/client-ledger';
import { isBlankReceipt, matchingReceiptProposal, mayFillInitialReceipt, receiptEditableValue, receiptProposalEditor, type InitialReceiptReview, type ReceiptEditor } from '../lib/receipt-processing';
import type { Draft, ReceiptMessage, Trip } from '../lib/model';

// React handlers capture immutable values from one render. Keep those values
// separate from the newest state and defer functional updates so an intervening
// keystroke or incoming proposal exercises the production reconciliation guard.
const source = await readFile(new URL('../components/trip-app.tsx', import.meta.url), 'utf8');
const syntax = createSourceFile('trip-app.tsx', source, ScriptTarget.Latest, true, ScriptKind.TSX);
const home = syntax.statements.find(statement => isFunctionDeclaration(statement) && statement.name?.text === 'Home');
assert(home && isFunctionDeclaration(home) && home.body);
const declarations = [...syntax.statements, ...home.body.statements].filter(isFunctionDeclaration);
function handler(name: string) {
  const declaration = declarations.find(statement => statement.name?.text === name);
  assert(declaration, `Missing production handler: ${name}`);
  return declaration.getText(syntax);
}
const factorySource = `return function createController(initialEditor, initialTrip, boundary) {
  let latestEditing = structuredClone(initialEditor), current = structuredClone(initialTrip);
  let processedReceipt = null, itemized = false;
  const initialReceiptReview = {current:null}, reviewedReceipt = {current:null}, editorDraftBinding = {current:null};
  const receiptSession = {current:1}, editorBaseline = {current:{tripId:initialTrip.id}};
  const profile = {id:'owner'}, updates = [];
  const {equalSavedValue,matchingReceiptProposal,mayFillInitialReceipt,receiptEditableValue,receiptProposalEditor} = boundary;
  const setEditing = update => {updates.push(update)};
  const setProcessedReceipt = next => {processedReceipt=next};
  const setReceiptItemized = next => {itemized=next};
  ${handler('mergeReceiptConversation')}
  return {
    reconcile() {
      const editing = structuredClone(latestEditing);
      ${handler('reconcileEditorReceipt')}
      reconcileEditorReceipt(current);
    },
    initialise(overrides = {}) {
      initialReceiptReview.current = {accountId:profile.id,tripId:current.id,editorId:latestEditing.id,
        draftId:latestEditing.draftId,receiptId:latestEditing.receiptId,
        financial:structuredClone(receiptEditableValue(latestEditing)),...overrides};
    },
    change(next) {latestEditing={...latestEditing,...structuredClone(next)}},
    remote(next) {current=structuredClone(next)},
    flush() {for(const update of updates.splice(0)) latestEditing=typeof update==='function'?update(latestEditing):update},
    advanceSession() {receiptSession.current++;initialReceiptReview.current=null;reviewedReceipt.current=null;processedReceipt=null;itemized=false},
    get editing() {return latestEditing}, get proposal() {return processedReceipt}, get itemized() {return itemized},
    get initial() {return initialReceiptReview.current}, get pendingUpdates() {return updates.length}
  };
}`;
const compiled = transpileModule(factorySource, { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS } }).outputText;
type Controller = {
  reconcile(): void; initialise(overrides?: Partial<InitialReceiptReview>): void;
  change(next: Partial<ReceiptEditor>): void; remote(next: Trip): void; flush(): void; advanceSession(): void;
  readonly editing: ReceiptEditor; readonly proposal: Draft | null; readonly itemized: boolean;
  readonly initial: InitialReceiptReview | null; readonly pendingUpdates: number;
};
const createController = new Function(compiled)() as (editor: ReceiptEditor, trip: Trip, boundary: object) => Controller;
function blankEditor(): ReceiptEditor {
  return {id:'editor',draftId:'draft',receiptId:'photo',title:'',date:'2026-10-04',time:'12:00',timezone:'Europe/London',
    currency:'GBP',payer:'alice',items:[{id:'line',name:'',amount:0,members:['alice','bob']}],tax:0,tip:0,discount:0};
}
function proposedTrip(amount = 1200): Trip {
  return {id:'trip',name:'Holiday',currency:'GBP',members:[{id:'alice',name:'Alice'},{id:'bob',name:'Bob'}],expenses:[],payments:[],
    drafts:[{id:'draft',receiptId:'photo',title:'Dinner',date:'2026-10-04',time:'12:00',timezone:'Europe/London',currency:'GBP',payer:'alice',
      items:[{id:'line',name:'Pasta',amount,members:['alice','bob']}],tax:0,tip:0,discount:0,status:'review',
      conversation:[{id:'answer',role:'assistant',text:'Itemisation is ready',createdAt:'2026-10-04T12:00:00Z'}]}]};
}
function controller(entry = blankEditor(), trip = proposedTrip()) {
  return createController(entry, trip, {equalSavedValue,matchingReceiptProposal,mayFillInitialReceipt,receiptEditableValue,receiptProposalEditor});
}
const lateQuestion: ReceiptMessage = {id:'late-question',role:'user',text:'Is this price for both portions?',createdAt:'2026-10-04T12:00:01Z'};

test('a queued receipt-context refresh retains a question appended after its render', () => {
  const editor = controller(); editor.reconcile();
  assert.equal(editor.pendingUpdates, 1);
  editor.change({conversation:[lateQuestion]}); editor.flush();
  assert.deepEqual(editor.editing.conversation?.map(message => message.id), ['answer','late-question']);
  assert.equal(editor.editing.items[0].amount, 0);
  assert.equal(editor.proposal?.items[0].amount, 1200);
});

test('a queued initial itemisation yields to a newer financial edit and leaves Review available', () => {
  const editor = controller(); editor.initialise(); editor.reconcile();
  editor.change({title:'My entered title',payer:'bob',items:[{id:'line',name:'My entered line',amount:1500,members:['bob']}],percentages:{alice:25,bob:75}});
  editor.flush(); editor.reconcile(); editor.flush();
  assert.equal(editor.editing.title, 'My entered title'); assert.equal(editor.editing.payer, 'bob');
  assert.equal(editor.editing.items[0].amount, 1500); assert.deepEqual(editor.editing.percentages, {alice:25,bob:75});
  assert.equal(editor.itemized, false); assert.equal(editor.proposal?.items[0].amount, 1200);
});

test('an initial itemisation is confirmed only after its accepted values render', () => {
  const editor = controller(); editor.initialise(); editor.reconcile();
  assert.equal(editor.itemized, false); assert.equal(editor.editing.items[0].amount, 0);
  editor.flush(); assert.equal(editor.editing.items[0].amount, 1200);
  editor.reconcile(); editor.flush();
  assert.equal(editor.itemized, true); assert.equal(editor.proposal, null); assert.equal(editor.initial, null);
  editor.change({items:[{...editor.editing.items[0],amount:1400}]}); editor.reconcile(); editor.flush();
  assert.equal(editor.editing.items[0].amount, 1400, 'later local edits cannot trigger another automatic fill');
});

test('queued initial itemisation retains a newer icon choice without delaying transcription', () => {
  const editor = controller(); editor.initialise(); editor.reconcile();
  const icon = {symbol:'Palmtree',background:'pink'} as const;
  editor.change({icon}); editor.flush(); editor.reconcile(); editor.flush();
  assert.deepEqual(editor.editing.icon,icon);
  assert.equal(editor.editing.items[0].amount,1200);
  assert.equal(editor.itemized,true);
});

test('queued initial itemisation retains a reset to automatic icons', () => {
  const editor = controller({...blankEditor(),icon:{symbol:'Palmtree',background:'pink'}});
  editor.initialise(); editor.reconcile(); editor.change({icon:undefined}); editor.flush(); editor.reconcile(); editor.flush();
  assert.equal(editor.editing.icon,undefined);
  assert.equal(editor.editing.items[0].amount,1200);
  assert.equal(editor.itemized,true);
});

test('detected purchase quantity and its default units populate an untouched editor without overwriting newer local allocations', () => {
  const trip = proposedTrip();
  const quantity = { total: 2, label: 'slices', sourceText: '2 × Stck Pizza' };
  const units = { total: 2, label: 'slices', allocations: { alice: 1, bob: 1 } };
  trip.drafts[0].items[0] = { ...trip.drafts[0].items[0], quantity, units };
  const editor = controller(blankEditor(), trip);
  editor.initialise(); editor.reconcile(); editor.flush(); editor.reconcile(); editor.flush();
  assert.deepEqual(editor.editing.items[0].quantity, quantity);
  assert.deepEqual(editor.editing.items[0].units, units);
  assert.equal(editor.itemized, true);
  assert.equal(editor.editing.items[0].amount, 1200);

  const changed = controller(blankEditor(), trip);
  changed.initialise(); changed.reconcile();
  const manual = { total: 2, label: 'pieces', allocations: { alice: 2, bob: 0 } };
  changed.change({ items: [{ ...blankEditor().items[0], name: 'My pizza', amount: 1200, units: manual }] });
  changed.flush(); changed.reconcile(); changed.flush();
  assert.deepEqual(changed.editing.items[0].units, manual);
  assert.equal(changed.editing.items[0].quantity, undefined, 'the proposal cannot silently replace a newer manual item');
  assert.deepEqual(changed.proposal?.items[0].quantity, quantity);
  assert.equal(changed.itemized, false);
});

test('entering only a purchase quantity makes the blank editor nonblank and prevents queued automatic replacement', () => {
  const entry = blankEditor(), editor = controller(entry);
  assert.equal(isBlankReceipt(entry), true);
  editor.initialise(); editor.reconcile();
  const quantity = { total: 2, label: 'pieces' };
  editor.change({ items: [{ ...entry.items[0], quantity }] });
  assert.equal(isBlankReceipt(editor.editing), false);
  editor.flush(); editor.reconcile(); editor.flush();
  assert.deepEqual(editor.editing.items[0].quantity, quantity);
  assert.equal(editor.editing.items[0].amount, 0);
  assert.equal(editor.editing.items[0].name, '');
  assert.equal(editor.itemized, false);
  assert.equal(editor.proposal?.items[0].amount, 1200, 'automatic itemisation remains available for explicit review');
});

test('a replacement proposal between automatic fill and confirmation remains available for Review', () => {
  const editor = controller(); editor.initialise(); editor.reconcile(); editor.flush();
  assert.equal(editor.editing.items[0].amount, 1200);
  editor.remote(proposedTrip(2200)); editor.reconcile(); editor.flush();
  assert.equal(editor.editing.items[0].amount, 1200);
  assert.equal(editor.itemized, false); assert.equal(editor.proposal?.items[0].amount, 2200);
});

test('initial itemisation belongs to its account and exact receipt context', async context => {
  const mismatches: [string, Partial<InitialReceiptReview>][] = [
    ['account',{accountId:'different-account'}], ['trip',{tripId:'different-trip'}],
    ['editor',{editorId:'different-editor'}], ['draft',{draftId:'different-draft'}], ['photo',{receiptId:'different-photo'}],
  ];
  for (const [name, mismatch] of mismatches) await context.test(name, () => {
    const editor = controller(); editor.initialise(mismatch); editor.reconcile(); editor.flush();
    assert.equal(editor.editing.items[0].amount, 0); assert.equal(editor.itemized, false);
    assert.equal(editor.proposal?.items[0].amount, 1200, 'matching proposal still requires explicit review');
  });
});

test('another draft, photo, expense target or trip cannot populate the open receipt', async context => {
  const mismatches: [string, (trip: Trip) => void][] = [
    ['draft',trip => {trip.drafts[0].id='different-draft'}],
    ['photo',trip => {trip.drafts[0].receiptId='different-photo'}],
    ['expense target',trip => {trip.drafts[0].expenseId='another-expense'}],
    ['trip',trip => {trip.id='different-trip'}],
  ];
  for (const [name, change] of mismatches) await context.test(name, () => {
    const editor = controller(); editor.initialise(); const remote = proposedTrip(); change(remote);
    editor.remote(remote); editor.reconcile(); editor.flush();
    assert.equal(editor.editing.items[0].amount, 0); assert.equal(editor.editing.conversation, undefined);
    assert.equal(editor.itemized, false); assert.equal(editor.proposal, null);
  });
});

test('a queued update from an earlier receipt session cannot change the current editor', () => {
  const editor = controller(); editor.initialise(); editor.reconcile();
  editor.advanceSession(); editor.change({title:'Current receipt title'}); editor.flush();
  assert.equal(editor.editing.title, 'Current receipt title'); assert.equal(editor.editing.items[0].amount, 0);
  assert.equal(editor.editing.conversation, undefined); assert.equal(editor.itemized, false); assert.equal(editor.proposal, null);
});

test('a photo changed after reconciliation is preserved when its queued update runs', () => {
  const editor = controller(); editor.initialise(); editor.reconcile();
  editor.change({receiptId:'replacement-photo'}); editor.flush(); editor.reconcile(); editor.flush();
  assert.equal(editor.editing.receiptId, 'replacement-photo'); assert.equal(editor.editing.items[0].amount, 0);
  assert.equal(editor.editing.conversation, undefined); assert.equal(editor.itemized, false); assert.equal(editor.proposal, null);
});
