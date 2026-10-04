import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createSourceFile, isFunctionDeclaration, ModuleKind, ScriptKind, ScriptTarget, transpileModule } from 'typescript';
import { equalFinancialValue } from '../lib/client-ledger';
import { itemSchema, itemSplitError, ledgerSchema, receiptSplitError, total, validateLedger, type Draft, type Expense, type ReceiptMessage, type Trip } from '../lib/model';

// Execute the actual page handlers against a small state/persistence boundary.
// JSX, network, clipboard and React hooks are excluded; receipt transitions and
// financial validation are the production functions, not a second algorithm.
const pageSource = await readFile(new URL('../app/page.tsx', import.meta.url), 'utf8');
const syntax = createSourceFile('page.tsx', pageSource, ScriptTarget.Latest, true, ScriptKind.TSX);
const home = syntax.statements.find(statement => isFunctionDeclaration(statement) && statement.name?.text === 'Home');
assert(home && isFunctionDeclaration(home) && home.body);
const names = ['openExpense', 'openDraft', 'newExpense', 'keepExpenseEdits', 'editorIsCurrent', 'resetReceiptReview', 'storeEditorReceipt', 'submitExpense', 'checkEditorReceipt', 'reviewProcessedReceipt', 'reviewRestore'];
const declarations = [...syntax.statements, ...home.body.statements].filter(isFunctionDeclaration);
const handlers = ['mergeReceiptConversation', 'hasPendingReceiptQuestions', ...names].map(name => {
  const declaration = declarations.find(statement => statement.name?.text === name);
  assert(declaration, `Missing production handler: ${name}`);
  return declaration.getText(syntax);
}).join('\n');
const controllerSource = `return function createController(initial, boundary) {
  let trip = structuredClone(initial), editing = null, processedReceipt = null, error = '', editorConflict = null;
  let receiptPending = false, receiptCopied = false, receiptPrompt = '', receiptHistoryOpen = false, restoration = null;
  let paste = '', fxError = '', referenceRate = null;
  let receiptChecking = false;
  const uploading = false, saving = false, profile = {id:'owner'};
  const updates = [], editorBaseline = {current:null};
  const latestSnapshot = {current:{data:{trips:[trip]},revision:0}};
  const {itemSchema,itemSplitError,receiptSplitError,total,equalFinancialValue} = boundary;
  const uid = boundary.uid, today = () => '2026-10-04', localTime = () => '12:00';
  const money = (amount, currency) => currency+' '+amount/100;
  const previewTotal = entry => total(entry);
  const confirm = async () => true;
  const load = async () => ({data:{trips:[trip]},revision:updates.length});
  const setPaymentEditor = () => {};
  const setEditing = next => {editing = typeof next === 'function' ? next(editing) : next};
  const setError = next => {error=next};
  const setProcessedReceipt = next => {processedReceipt=typeof next === 'function' ? next(processedReceipt) : next};
  const setReceiptChecking = next => {receiptChecking=next};
  const fetch = async () => ({ok:true,headers:{get:()=>''},json:async()=>({data:{trips:[structuredClone(trip)]},revision:updates.length})});
  const applySnapshot = snapshot => {latestSnapshot.current=snapshot;trip=snapshot.data.trips[0]};
  const setReceiptPending = next => {receiptPending=next};
  const setReceiptCopied = next => {receiptCopied=next};
  const setReceiptPrompt = next => {receiptPrompt=next};
  const setReceiptHistoryOpen = next => {receiptHistoryOpen=next};
  const setRestoration = next => {restoration=next};
  const setEditorConflict = next => {editorConflict=next};
  const setReferenceRate = next => {referenceRate=next};
  const setPaste = next => {paste=next};
  const setFxError = next => {fxError=next};
  async function updateTrip(next) {
    const parsed = boundary.validateLedger(boundary.ledgerSchema.parse({trips:[next]}),{previous:{trips:[trip]}});
    trip = parsed.trips[0]; latestSnapshot.current = {data:{trips:[trip]},revision:updates.length+1};
    updates.push(structuredClone(trip)); return true;
  }
  ${handlers}
  return {${names.join(',')},get editing(){return editing},get trip(){return trip},get error(){return error},get updates(){return updates},get baseline(){return editorBaseline.current},get processed(){return processedReceipt},
    edit(next){editing={...editing,...next}},remote(next){trip=structuredClone(next)},
    conflict(next){editorConflict={latest:next}},restoring(){restoration={actorName:'Earlier traveller',createdAt:'2026-10-04T00:00:00Z',adjustments:[]}},
    get restoration(){return restoration}};
}`;
const compiled = transpileModule(controllerSource, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
type Editing = Expense & { draftId?: string; expenseId?: string };
type Controller = {
  openExpense(expense: Expense, resumeDraft?: boolean): void; openDraft(draft: Draft): void; newExpense(): void; keepExpenseEdits(): void;
  editorIsCurrent(): boolean; resetReceiptReview(): void;
  storeEditorReceipt(entry: Editing, receiptId?: string, keepProposal?: boolean): Promise<Draft | null>;
  submitExpense(event: { preventDefault(): void }): Promise<void>;
  checkEditorReceipt(repliesOnly?:boolean):Promise<void>; reviewProcessedReceipt():void;
  reviewRestore(event: {tripId:string;entityType:string;entityId:string;actorName:string;createdAt:string;before:Expense}):Promise<void>;
  editing: Editing | null; trip: Trip; error: string; updates: Trip[]; baseline: { tripId: string; expense?: Expense } | null;
  processed: Draft | null; edit(next: Partial<Editing>): void; remote(next: Trip): void; conflict(next: Expense | null): void;
  restoring(): void; restoration: unknown;
};
const createController = new Function(compiled)() as (initial: Trip, boundary: object) => Controller;
const controller = (trip: Trip) => createController(trip, { uid: randomUUID, ledgerSchema, itemSchema, itemSplitError, receiptSplitError, total, validateLedger, equalFinancialValue });
const stamp = '2026-10-04T12:00:00Z';
const question: ReceiptMessage = { id: 'question', role: 'user', text: 'Check the replacement image', createdAt: stamp };
const reply: ReceiptMessage = { id: 'reply', role: 'assistant', replyTo: question.id, text: 'Reviewed replacement image', createdAt: stamp };
const posted: Expense = { id: 'posted', title: 'Posted dinner', date: '2026-09-03', time: '18:30', timezone: 'Europe/Lisbon', currency: 'GBP', payer: 'a', receiptId: 'old-photo', items: [{ id: 'old-item', name: 'Old dinner', amount: 1000, members: ['a','b'] }], tax: 0, tip: 0, discount: 0 };
function pending(status: Draft['status'] = 'waiting'): Draft {
  return { id: 'replacement-draft', expenseId: posted.id, title: 'Corrected dinner', date: '2026-09-04', time: '19:45', timezone: 'Europe/Paris', currency: 'EUR', payer: 'b', receiptId: 'replacement-photo',
    items: [{ id: 'replacement-item', name: 'Chocolate bars', amount: 2000, members: ['a','b'], units: { total: 7.5, allocations: {a:2.5,b:5}, label: 'bars' } }], percentages: {a:30,b:70},
    tax: 20, tip: 30, discount: 10, bankAmount: 1800, fx: {rate:0.85,asOf:'2026-09-04',source:'manual'}, source:'ai', adjustmentAllocation:'selected-participants',
    memory:{notes:'Replacement photo and saved item edits',aliases:[]},conversation:status==='review'?[question,reply]:[question],status };
}
function fixture(draft = pending()): Trip {
  return { id:'trip',name:'Holiday',currency:'GBP',members:[{id:'a',name:'Alice',userId:'owner'},{id:'b',name:'Bob'}],expenses:[structuredClone(posted)],drafts:[draft,{id:'unrelated',title:'Separate receipt',currency:'GBP',payer:'a',items:[],tax:0,tip:0,discount:0,status:'waiting'}],payments:[] };
}
const submit = (editor: Controller) => editor.submitExpense({ preventDefault() {} });

test('opening a posted expense reopens all saved replacement-draft edits and keeps the posted conflict baseline', async () => {
  const initial = fixture(); const editor = controller(initial); editor.openExpense(initial.expenses[0]);
  assert.equal(editor.editing?.id,posted.id); assert.equal(editor.editing?.draftId,'replacement-draft');
  for (const field of ['title','receiptId','items','percentages','payer','date','time','timezone','currency','fx','bankAmount','tax','tip','discount','source','memory','conversation'] as const) assert.deepEqual(editor.editing?.[field],initial.drafts[0][field],field);
  assert.deepEqual(editor.baseline?.expense,posted); assert.deepEqual(editor.trip.expenses,[posted]); assert.equal(editor.updates.length,0);
  await submit(editor); assert.equal(editor.error,''); assert.equal(editor.updates.length,1);
  assert.equal(editor.trip.expenses[0].receiptId,'replacement-photo'); assert.equal(editor.trip.expenses[0].items[0].name,'Chocolate bars');
  assert.equal(editor.trip.drafts.find(d=>d.id==='replacement-draft')?.expenseId,posted.id); assert(editor.trip.drafts.some(d=>d.id==='unrelated'));
});

test('review proposals retain the replacement image when another receipt question is persisted', async () => {
  const initial=fixture(pending('review')); const editor=controller(initial); editor.openExpense(initial.expenses[0]);
  assert.equal(editor.editing?.receiptId,'replacement-photo');
  const changed={...editor.editing!,title:'My reviewed correction',conversation:[...editor.editing!.conversation!,{...question,id:'follow-up',text:'Is the second bar included?'}]};
  const saved=await editor.storeEditorReceipt(changed,changed.receiptId,true);
  assert.equal(saved?.receiptId,'replacement-photo'); assert.equal(saved?.title,'My reviewed correction'); assert.deepEqual(saved?.items,changed.items);
  assert.equal(saved?.expenseId,posted.id); assert.equal(editor.trip.expenses[0].receiptId,'old-photo');
  assert.equal(editor.editing?.receiptId,'replacement-photo'); assert.equal(editor.editing?.conversation?.at(-1)?.id,'follow-up');
});

test('a saved removal of the image is not replaced by the posted expense image', async () => {
  const draft=pending('review'); delete draft.receiptId; const initial=fixture(draft); const editor=controller(initial); editor.openExpense(initial.expenses[0]);
  assert.equal(editor.editing?.receiptId,undefined); await submit(editor); assert.equal(editor.trip.expenses[0].receiptId,undefined);
  assert.equal(editor.trip.drafts.some(d=>d.id===draft.id),false); assert(editor.trip.drafts.some(d=>d.id==='unrelated'));
});

test('optional draft purchase fields inherit the posted purchase while empty replacement items stay unreviewed', () => {
  const draft=pending(); delete draft.date; delete draft.time; delete draft.timezone; draft.items=[];
  const initial=fixture(draft); const editor=controller(initial); editor.openExpense(initial.expenses[0]);
  assert.equal(editor.editing?.date,posted.date); assert.equal(editor.editing?.time,posted.time); assert.equal(editor.editing?.timezone,posted.timezone);
  assert.equal(editor.editing?.items.length,1); assert.equal(editor.editing?.items[0].name,''); assert.equal(editor.editing?.items[0].amount,0);
});

test('unrelated drafts are not attached and a concurrent posted financial change still blocks a pending draft save', async () => {
  const noPending=fixture(); noPending.drafts=noPending.drafts.filter(d=>d.id==='unrelated'); const direct=controller(noPending); direct.openExpense(noPending.expenses[0]);
  assert.equal(direct.editing?.draftId,undefined); assert.equal(direct.editing?.receiptId,'old-photo');
  const initial=fixture(); const editor=controller(initial); editor.openExpense(initial.expenses[0]); const changed=structuredClone(initial); changed.expenses[0].payer='b'; editor.remote(changed);
  await submit(editor); assert.match(editor.error,/changed while you were editing/); assert.equal(editor.updates.length,0); assert.equal(editor.editing?.receiptId,'replacement-photo');
});


test('choosing the latest saved expense after a conflict does not reopen its older pending proposal', async () => {
  const initial=fixture(); const editor=controller(initial); editor.openExpense(initial.expenses[0]);
  const changed=structuredClone(initial); changed.expenses[0]={...changed.expenses[0],title:'Latest traveller correction',payer:'b',receiptId:'latest-saved-photo'}; editor.remote(changed);
  assert.equal(editor.editorIsCurrent(),false); editor.openExpense(changed.expenses[0],false);
  assert.equal(editor.editing?.title,'Latest traveller correction'); assert.equal(editor.editing?.receiptId,'latest-saved-photo'); assert.equal(editor.editing?.draftId,undefined);
  assert.deepEqual(editor.editing?.items,changed.expenses[0].items); assert.deepEqual(editor.baseline?.expense,changed.expenses[0]);
  await submit(editor); assert.equal(editor.trip.expenses[0].title,'Latest traveller correction'); assert.equal(editor.trip.expenses[0].receiptId,'latest-saved-photo');
  assert.equal(editor.trip.drafts[0].receiptId,'replacement-photo','pending proposal remains available separately');
});

test('checking and reviewing a replacement draft retains posted and local receipt context', async () => {
  const draft=pending('review'); delete draft.memory;
  const initial=fixture(draft); const postedQuestion={...question,id:'posted-question',text:'Already saved on the posted expense'};
  initial.expenses[0].conversation=[postedQuestion]; initial.expenses[0].memory={notes:'Memory retained on the posted expense',aliases:[]};
  const editor=controller(initial); editor.openExpense(initial.expenses[0]); const localQuestion={...question,id:'local-question',text:'Local question retained while checking'};
  editor.edit({conversation:[...editor.editing!.conversation!,localQuestion]});
  await editor.checkEditorReceipt(); assert.equal(editor.error,''); assert.equal(editor.processed?.id,draft.id);
  assert.deepEqual(editor.editing?.conversation?.map(message=>message.id),['posted-question','question','reply','local-question']);
  assert.equal(editor.editing?.memory?.notes,'Memory retained on the posted expense'); assert.equal(editor.editing?.receiptId,'replacement-photo');
  editor.reviewProcessedReceipt(); assert.equal(editor.editing?.receiptId,'replacement-photo');
  assert.deepEqual(new Set(editor.editing?.conversation?.map(message=>message.id)),new Set(['posted-question','question','reply','local-question']));
  assert.equal(editor.editing?.memory?.notes,'Memory retained on the posted expense'); assert.equal(editor.processed,null);
  const saved=await editor.storeEditorReceipt({...editor.editing!,title:'Reviewed replacement with retained context'},editor.editing!.receiptId,true);
  assert.equal(saved?.receiptId,'replacement-photo'); assert.equal(saved?.title,'Reviewed replacement with retained context');
  assert.equal(saved?.memory?.notes,'Memory retained on the posted expense');
});

function blankTrip(): Trip { const initial=fixture(); initial.expenses=[]; initial.drafts=[]; return initial; }
function fillNew(editor: Controller, conversation?: ReceiptMessage[]) {
  editor.newExpense(); editor.edit({title:'New manual dinner',items:[{id:'new-line',name:'New dinner',amount:1234,members:['a','b']}],conversation});
}

test('a new manual expense atomically records its distinct pre-save draft origin when the draft is consumed', async () => {
  const editor=controller(blankTrip()); fillNew(editor); const futureExpenseId=editor.editing!.id;
  const draft=await editor.storeEditorReceipt(editor.editing!,'new-manual-photo'); assert(draft); assert.notEqual(draft.id,futureExpenseId);
  assert.equal(draft.expenseId,undefined,'unsaved expense cannot be a live draft target'); const before=editor.updates.length;
  await submit(editor); assert.equal(editor.error,''); assert.equal(editor.updates.length,before+1,'expense posting and provenance use one save');
  const expense=editor.trip.expenses[0]; assert.equal(expense.id,futureExpenseId); assert.equal(expense.sourceDraftId,draft.id);
  assert.equal(expense.receiptId,'new-manual-photo'); assert.equal(editor.trip.drafts.length,0);
});

test('new chat expense keeps provenance through pending retention, later AI review and draft consumption', async () => {
  const editor=controller(blankTrip()); fillNew(editor,[question]); const futureExpenseId=editor.editing!.id;
  const draft=await editor.storeEditorReceipt(editor.editing!,'new-chat-photo',true); assert(draft); await submit(editor);
  assert.equal(editor.trip.expenses[0].id,futureExpenseId); assert.equal(editor.trip.expenses[0].sourceDraftId,draft.id);
  assert.equal(editor.trip.drafts[0].id,draft.id); assert.equal(editor.trip.drafts[0].expenseId,futureExpenseId);
  const answered=structuredClone(editor.trip); answered.drafts[0]={...answered.drafts[0],title:'AI reviewed dinner',status:'review',conversation:[question,reply],memory:{notes:'AI remembered the new photo',aliases:[]},items:[{...answered.drafts[0].items[0],amount:2345}]};
  editor.remote(answered); editor.openExpense(answered.expenses[0]); await submit(editor);
  assert.equal(editor.error,''); assert.equal(editor.trip.expenses[0].id,futureExpenseId); assert.equal(editor.trip.expenses[0].sourceDraftId,draft.id);
  assert.equal(editor.trip.expenses[0].receiptId,'new-chat-photo'); assert.equal(editor.trip.expenses[0].items[0].amount,2345);
  assert.deepEqual(editor.trip.expenses[0].conversation,[question,reply]); assert.equal(editor.trip.drafts.length,0);
});

test('an inbox draft posted with unanswered questions keeps distinct IDs and explicit provenance', async () => {
  const initial=blankTrip(); initial.drafts=[{...posted,id:'inbox-draft',conversation:[question],status:'waiting'}];
  const editor=controller(initial); editor.openDraft(initial.drafts[0]); await submit(editor);
  assert.equal(editor.error,''); assert.notEqual(editor.trip.expenses[0].id,'inbox-draft');
  assert.equal(editor.trip.expenses[0].sourceDraftId,'inbox-draft'); assert.equal(editor.trip.drafts[0].id,'inbox-draft');
  assert.equal(editor.trip.drafts[0].expenseId,editor.trip.expenses[0].id);
});

test('restoring a deleted expense preserves its identity and links a new receipt draft before or after a reply', async () => {
  for(const answered of [false,true]) {
    const editor=controller(blankTrip()); const snapshot={...posted,receiptId:undefined,sourceDraftId:'historical-consumed-draft'};
    await editor.reviewRestore({tripId:'trip',entityType:'expense',entityId:posted.id,actorName:'Earlier traveller',createdAt:stamp,before:snapshot});
    assert.equal(editor.editing?.id,posted.id); assert.equal(editor.editing?.sourceDraftId,'historical-consumed-draft');
    editor.edit({conversation:answered?[question,reply]:[question]}); const draft=await editor.storeEditorReceipt(editor.editing!); assert(draft);
    assert.notEqual(draft.id,posted.id); await submit(editor); assert.equal(editor.error,'');
    assert.equal(editor.trip.expenses[0].id,posted.id,'restore must stay in the delete/restore expense family');
    assert.equal(editor.trip.expenses[0].sourceDraftId,draft.id); assert.equal(editor.trip.drafts.length,answered?0:1);
  }
});

test('ordinary edits retain consumed-draft provenance while an explicit new copy clears old family context', async () => {
  const initial=fixture(); initial.drafts=[]; initial.expenses[0].sourceDraftId='historic-origin';
  const editor=controller(initial); editor.openExpense(initial.expenses[0]); editor.edit({title:'Ordinary correction'}); await submit(editor);
  assert.equal(editor.trip.expenses[0].sourceDraftId,'historic-origin');
  editor.openExpense(editor.trip.expenses[0]); editor.restoring(); editor.conflict(null); const removed=structuredClone(editor.trip); removed.expenses=[]; editor.remote(removed); editor.keepExpenseEdits();
  assert.notEqual(editor.editing?.id,posted.id); assert.equal(editor.editing?.sourceDraftId,undefined); assert.equal(editor.editing?.draftId,undefined);
  assert.equal(editor.restoration,null); assert.equal(editor.processed,null); await submit(editor);
  assert.equal(editor.trip.expenses[0].sourceDraftId,undefined,'a new copy cannot claim a consumed draft belonging to its earlier expense');
});
