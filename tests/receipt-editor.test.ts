import { canonicalJson, sha256Hex } from '../lib/data-utils';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createSourceFile, isFunctionDeclaration, isJsxElement, isJsxAttribute, isJsxExpression, ModuleKind, ScriptKind, ScriptTarget, transpileModule } from 'typescript';
import { equalFinancialValue, equalSavedValue } from '../lib/client-ledger';
import { buildReceiptPrompt } from '../lib/receipt-chatgpt';
import { isBlankReceipt, isUnchangedInitialReceipt, matchingReceiptProposal, mayFillInitialReceipt, receiptEditableValue, receiptProposalEditor, receiptEditorTotal, userReceiptField, type ReceiptEditor } from '../lib/receipt-processing';
import { receiptScanSaveError, receiptScanFingerprint } from '../lib/receipt-scan';
import { itemSchema, draftItemSchema, expenseSchema, itemSplitError, ledgerSchema, receiptSplitError, total, validateLedger, type Draft, type Expense, type ReceiptMessage, type Trip } from '../lib/model';

// Execute the actual page handlers against a small state/persistence boundary.
// JSX, network, clipboard and React hooks are excluded; receipt transitions and
// financial validation are the production functions, not a second algorithm.
const pageSource = await readFile(new URL('../components/trip-app.tsx', import.meta.url), 'utf8');
const syntax = createSourceFile('page.tsx', pageSource, ScriptTarget.Latest, true, ScriptKind.TSX);
const home = syntax.statements.find(statement => isFunctionDeclaration(statement) && statement.name?.text === 'Home');
assert(home && isFunctionDeclaration(home) && home.body);
const names = ['openExpense', 'openDraft', 'newExpense', 'keepExpenseEdits', 'editorIsCurrent', 'resetReceiptReview', 'closeReceiptEditor', 'isReceiptSessionCurrent', 'stageEditorReceiptPrompt', 'refreshReceiptAIStatus', 'prepareEditorReceipt', 'copyEditorReceiptPrompt', 'captureEditorReceipt', 'upload', 'processEditorReceipt', 'readEditorReceipt', 'sendReceiptQuestion', 'retryReceiptQuestion', 'setEditorPlace', 'reconcileEditorReceipt', 'storeEditorReceipt', 'submitExpense', 'reviewProcessedReceipt', 'reviewRestore'];
const declarations = [...syntax.statements, ...home.body.statements].filter(isFunctionDeclaration);
const handlers = ['mergeReceiptConversation', 'hasPendingReceiptQuestions', ...names].map(name => {
  const declaration = declarations.find(statement => statement.name?.text === name);
  assert(declaration, `Missing production handler: ${name}`);
  return declaration.getText(syntax);
}).join('\n');
const controllerSource = `return function createController(initial, boundary) {
  let trip = structuredClone(initial), editing = null, processedReceipt = null, error = '', editorConflict = null;
  let receiptPending = false, receiptCopied = false, receiptPrompt = '', receiptHistoryOpen = false, restoration = null;
  let paste = '', fxError = '', referenceRate = null,captureNotes='',uploadOpen=false;
  const setCaptureNotes=next=>{captureNotes=next},setUploadOpen=next=>{uploadOpen=next};
  let uploading = false, receiptProcessing = false, receiptItemized = false, receiptHandoffError = '', receiptHandoffOpened = false, receiptAIConnecting = false;
  const saving = false, profile = {id:'owner'};
  let receiptAI = null, clipboardFailure = false, failSave = false, network, statusNetwork;
  let commitAIState = true;
  let commitLayout = true, view = '', help = false;
  const clipboard = [], requests = [];
  const navigator = {clipboard:{writeText:async value=>{if(clipboardFailure)throw Error('Blocked clipboard');clipboard.push(value)}}};
  const receiptSession={current:0}, receiptSessionScope={current:{accountId:'owner',tripId:trip.id}}, initialReceiptReview={current:null}, reviewedReceipt={current:null}, blankReceiptEditor={current:null};
  const editorDraftBinding={current:null};
  const activeReceiptEditor={current:null};
  const receiptProcessRequest={current:0},receiptProcessInFlight={current:false};
  const receiptAIStatusRequest={current:0},receiptAIStatusInFlight={current:null};
  const updates = [], editorBaseline = {current:null};
  const latestSnapshot = {current:{data:{trips:[trip]},revision:0}};
  const {canonicalJson,sha256Hex,itemSchema,draftItemSchema,expenseSchema,receiptScanSaveError,receiptEditorTotal,itemSplitError,receiptSplitError,total,equalFinancialValue,equalSavedValue,buildReceiptPrompt,isBlankReceipt,isUnchangedInitialReceipt,matchingReceiptProposal,mayFillInitialReceipt,receiptEditableValue,receiptProposalEditor} = boundary;
  const uid = boundary.uid, today = () => '2026-10-04', localTime = () => '12:00';
  const money = (amount, currency) => currency+' '+amount/100;
  const previewTotal = entry => total(entry);
  const confirm = async () => true;
  const load = async () => ({data:{trips:[trip]},revision:updates.length});
  const setPaymentEditor = () => {};
  const setEditing = next => {editing = typeof next === 'function' ? next(editing) : next;if(commitLayout)activeReceiptEditor.current=editing};
  const setError = next => {error=next};
  const setProcessedReceipt = next => {processedReceipt=typeof next === 'function' ? next(processedReceipt) : next};
  const fetch = async (url,options) => {
    requests.push({url,options});
    if(url==='/api/receipt/ai-status')return statusNetwork?statusNetwork():({ok:true,json:async()=>receiptAI||{configured:false,connected:false,provider:'api',eligible:true,manageable:true,siwcAvailable:false}});
    return network?network(url,options):({ok:true,headers:{get:()=>''},json:async()=>({data:{trips:[structuredClone(trip)]},revision:updates.length})});
  };
  const setReceiptAI = next => {if(commitAIState)receiptAI=next};
  const applySnapshot = snapshot => {if(snapshot.revision<latestSnapshot.current.revision)return false;latestSnapshot.current=snapshot;trip=snapshot.data.trips[0];return true};
  const setReceiptPending = next => {receiptPending=next};
  const setReceiptCopied = next => {receiptCopied=next};
  const setReceiptPrompt = next => {receiptPrompt=next};
  const setReceiptHandoffError = next => {receiptHandoffError=next};
  const setReceiptHandoffOpened = next => {receiptHandoffOpened=next};
  const setReceiptProcessing = next => {receiptProcessing=next};
  const setReceiptItemized = next => {receiptItemized=next};
  const setUploading = next => {uploading=next};
  const setReceiptAIConnecting = next => {receiptAIConnecting=next};
  const setView = next => {view=next}, setHelp = next => {help=next}, prepareReceiptImage = async file => file;
  const setReceiptHistoryOpen = next => {receiptHistoryOpen=next};
  const setRestoration = next => {restoration=next};
  const setEditorConflict = next => {editorConflict=next};
  const setReferenceRate = next => {referenceRate=next};
  const setPaste = next => {paste=next};
  const setFxError = next => {fxError=next};
  async function updateTrip(next) {
    if(failSave)return false;
    error = '';
    const parsed = boundary.validateLedger(boundary.ledgerSchema.parse({trips:[next]}),{previous:{trips:[trip]}});
    trip = parsed.trips[0]; latestSnapshot.current = {data:{trips:[trip]},revision:updates.length+1};
    updates.push(structuredClone(trip)); return true;
  }
  ${handlers}
  return {${names.join(',')},get editing(){return editing},get trip(){return trip},get error(){return error},get updates(){return updates},get baseline(){return editorBaseline.current},get processed(){return processedReceipt},
    edit(next){editing={...editing,...next};activeReceiptEditor.current=editing},remote(next,revision=updates.length){trip=structuredClone(next);latestSnapshot.current={data:{trips:[trip]},revision}},
    get prompt(){return receiptPrompt},get handoffError(){return receiptHandoffError},get clipboard(){return clipboard},get requests(){return requests},get processing(){return receiptProcessing},get itemized(){return receiptItemized},get pending(){return receiptPending},get uploading(){return uploading},get connecting(){return receiptAIConnecting},
    network(next){network=next},clipboardUnavailable(){clipboardFailure=true},persistenceFailure(){failSave=true},persistenceRecovered(){failSave=false},
    aiConnected(){receiptAI={accountId:profile.id,configured:true,connected:true,provider:'api',eligible:true,manageable:true,siwcAvailable:false}},
    participantAccount(connected=true){profile.id='participant';receiptSessionScope.current.accountId='participant';receiptAI={accountId:'participant',configured:connected,connected,provider:'api',eligible:true,manageable:false,siwcAvailable:false}},
    statusNetwork(next){statusNetwork=next},deferAIState(){commitAIState=false},get ai(){return receiptAI},
    deferLayout(){commitLayout=false;activeReceiptEditor.current=null},get view(){return view},get help(){return help},
    accountSwitch(){receiptSession.current++;receiptSessionScope.current={accountId:'other',tripId:trip.id}},
    conflict(next){editorConflict={latest:next}},restoring(){restoration={actorName:'Earlier traveller',createdAt:'2026-10-04T00:00:00Z',adjustments:[]}},
    setNotes(next){captureNotes=next},get captureNotes(){return captureNotes},get restoration(){return restoration}};
}`;
const compiled = transpileModule(controllerSource, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
type Editing = ReceiptEditor;
type Controller = {
  openExpense(expense: Expense, resumeDraft?: boolean): void; openDraft(draft: Draft): void; newExpense(): void; keepExpenseEdits(): void;
  editorIsCurrent(): boolean; resetReceiptReview(): void;
  storeEditorReceipt(entry: Editing, receiptId?: string, keepProposal?: boolean): Promise<Draft | null>;
  submitExpense(event: { preventDefault(): void }): Promise<void>;
  reviewProcessedReceipt():void;
  closeReceiptEditor():void;prepareEditorReceipt():Promise<void>;captureEditorReceipt(file:File):Promise<void>;processEditorReceipt(draft?:Draft):Promise<boolean>;reconcileEditorReceipt(trip:Trip):void;
  upload(file:File,options?:{notes:string;location?:{label:string;source:'user'|'receipt'|'chat'};locationHint?:{latitude:number;longitude:number;accuracy:number;capturedAt:string}}):Promise<void>;deferLayout():void;view:string;help:boolean;
  sendReceiptQuestion(text:string,itemId?:string):Promise<boolean>;retryReceiptQuestion(questionId:string):Promise<boolean>;setEditorPlace(place:{location?:{label:string;source:'user'|'receipt'|'chat'};locationHint?:{latitude:number;longitude:number;accuracy:number;capturedAt:string}}):void;
  setNotes(text:string):void;captureNotes:string;
  reviewRestore(event: {tripId:string;entityType:string;entityId:string;actorName:string;createdAt:string;before:Expense}):Promise<void>;
  editing: Editing | null; trip: Trip; error: string; updates: Trip[]; baseline: { tripId: string; expense?: Expense } | null;
  processed: Draft | null; edit(next: Partial<Editing>): void; remote(next: Trip,revision?:number): void; conflict(next: Expense | null): void;
  uploading:boolean;connecting:boolean;refreshReceiptAIStatus(accountId:string,fresh?:boolean):Promise<unknown>;prompt:string;handoffError:string;clipboard:string[];requests:{url:string;options?:RequestInit}[];processing:boolean;itemized:boolean;pending:boolean;
  network(next:(url:string,options?:RequestInit)=>Promise<unknown>):void;clipboardUnavailable():void;persistenceFailure():void;persistenceRecovered():void;aiConnected():void;accountSwitch():void;
  participantAccount(connected?:boolean):void;statusNetwork(next:()=>Promise<unknown>):void;deferAIState():void;ai:{connected:boolean;accountId:string}|null;
  restoring(): void; restoration: unknown;
};
const createController = new Function(compiled)() as (initial: Trip, boundary: object) => Controller;
const controller = (trip: Trip) => createController(trip, { canonicalJson, sha256Hex, uid: randomUUID, ledgerSchema, itemSchema, draftItemSchema, expenseSchema, itemSplitError, receiptSplitError, total, validateLedger, equalFinancialValue, equalSavedValue, buildReceiptPrompt, isBlankReceipt, isUnchangedInitialReceipt, matchingReceiptProposal, mayFillInitialReceipt, receiptEditableValue, receiptProposalEditor, receiptEditorTotal, receiptScanSaveError });
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

test('purchased quantity survives receipt review, manual corrections, draft storage and expense save in both split modes', async () => {
  for (const receiptPercentages of [undefined, { a: 30, b: 70 }]) {
    const draft = pending('review');
    draft.percentages = receiptPercentages;
    const quantity = { total: 2, label: 'slices', sourceText: '2 × Stck Pizza Margherita' };
    const units = { total: 2, label: 'slices', allocations: { a: 1, b: 1 } };
    draft.items = [{ id: 'pizza', name: 'Pizza slices', amount: 1200, members: ['a', 'b'], quantity, units }];
    const initial = fixture(draft), editor = controller(initial);
    editor.openExpense(initial.expenses[0]);
    assert.deepEqual(editor.editing?.items[0].quantity, quantity);
    assert.deepEqual(editor.editing?.items[0].units, units);
    assert.equal(editor.trip.expenses[0].items[0].quantity, undefined, 'a proposal remains separate from the posted expense');
    editor.edit({ items: editor.editing!.items.map(item => ({ ...item, name: 'Reviewed pizza slices', amount: 1100 })) });
    const stored = await editor.storeEditorReceipt(editor.editing!, editor.editing!.receiptId);
    assert.deepEqual(stored?.items[0].quantity, quantity);
    assert.deepEqual(stored?.items[0].units, units);
    assert.deepEqual(stored?.percentages, receiptPercentages);
    await submit(editor);
    assert.equal(editor.error, '');
    const saved = editor.trip.expenses[0];
    assert.equal(saved.items[0].amount, 1100, 'units must not multiply the full line price');
    assert.deepEqual(saved.items[0].quantity, quantity);
    assert.deepEqual(saved.items[0].units, units);
    assert.deepEqual(saved.percentages, receiptPercentages);
    editor.openExpense(saved);
    assert.deepEqual(editor.editing?.items[0].quantity, quantity);
    assert.deepEqual(editor.editing?.items[0].units, units);
  }
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
  assert.equal(editor.editing?.items.length,0, 'unprocessed receipts do not create a recognised-looking placeholder');
});

test('unrelated drafts are not attached and a concurrent posted financial change still blocks a pending draft save', async () => {
  const noPending=fixture(); noPending.drafts=noPending.drafts.filter(d=>d.id==='unrelated'); const direct=controller(noPending); direct.openExpense(noPending.expenses[0]);
  assert.equal(direct.editing?.draftId,undefined); assert.equal(direct.editing?.receiptId,'old-photo');
  const initial=fixture(); const editor=controller(initial); editor.openExpense(initial.expenses[0]); const changed=structuredClone(initial); changed.expenses[0].payer='b'; editor.remote(changed);
  await submit(editor); assert.match(editor.error,/changed while you were editing/); assert.equal(editor.updates.length,0); assert.equal(editor.editing?.receiptId,'replacement-photo');
});

const financialFields = ['title','date','time','timezone','payer','receiptId','currency','fx','bankAmount','items','percentages','tax','tip','discount','source'] as const;
function latestCorrection(expense: Expense): Expense {
  return {...expense,title:'Latest traveller correction',date:'2026-09-05',time:'20:15',timezone:'Europe/Rome',payer:'b',receiptId:'latest-saved-photo',
    currency:'GBP',fx:undefined,bankAmount:undefined,source:'manual',items:[{id:'latest-item',name:'Bob corrected dinner',amount:3456,members:['a']}],
    percentages:{a:25,b:75},tax:80,tip:100,discount:10,adjustmentAllocation:'selected-participants'};
}
function assertChosenFinancials(actual: Partial<Editing> | null, latest: Expense) {
  for(const key of financialFields) assert.deepEqual(actual?.[key],latest[key],key);
}

test('choosing latest saved consumes a resolved pending proposal and reopening keeps the latest financial details and context', async () => {
  const initial=fixture(pending('review')); const editor=controller(initial); editor.openExpense(initial.expenses[0]);
  const changed=structuredClone(initial); const latest=latestCorrection(changed.expenses[0]); changed.expenses[0]=latest;
  const newerQuestion={...question,id:'newer-question',text:'A newer question saved while the conflict was open'};
  const newerReply={...reply,id:'newer-reply',replyTo:newerQuestion.id,text:'Newer answer on the pending proposal'};
  changed.drafts[0].conversation=[question,reply,newerQuestion,newerReply]; changed.drafts[0].memory={notes:'Newer pending receipt memory',aliases:[]};
  editor.remote(changed); assert.equal(editor.editorIsCurrent(),false); editor.openExpense(changed.expenses[0],false);
  assertChosenFinancials(editor.editing,latest); assert.equal(editor.editing?.draftId,'replacement-draft');
  assert.deepEqual(editor.baseline?.expense,latest); assert.deepEqual(editor.editing?.conversation,changed.drafts[0].conversation);
  assert.equal(editor.editing?.memory?.notes,'Newer pending receipt memory'); assert.equal(editor.updates.length,0);
  await submit(editor); assert.equal(editor.error,''); assertChosenFinancials(editor.trip.expenses[0],latest);
  assert.equal(editor.trip.drafts.some(draft=>draft.id==='replacement-draft'),false); assert(editor.trip.drafts.some(draft=>draft.id==='unrelated'));
  editor.openExpense(editor.trip.expenses[0]); assertChosenFinancials(editor.editing,latest); assert.equal(editor.editing?.draftId,undefined);
  assert.deepEqual(editor.editing?.conversation,changed.drafts[0].conversation); assert.equal(editor.editing?.memory?.notes,'Newer pending receipt memory');
});

test('an unanswered pending draft is rebuilt from latest saved values so reopening cannot restore its stale proposal', async () => {
  const initial=fixture(); const editor=controller(initial); editor.openExpense(initial.expenses[0]);
  const changed=structuredClone(initial); const latest=latestCorrection(changed.expenses[0]); changed.expenses[0]=latest;
  changed.drafts[0].memory={notes:'Keep this unresolved question context',aliases:[]}; editor.remote(changed); assert.equal(editor.editorIsCurrent(),false);
  editor.openExpense(latest,false); await submit(editor); assert.equal(editor.error,''); assertChosenFinancials(editor.trip.expenses[0],latest);
  const retained=editor.trip.drafts.find(draft=>draft.id==='replacement-draft'); assert(retained);
  assert.equal(retained.expenseId,latest.id); assert.equal(retained.status,'waiting'); assertChosenFinancials(retained,latest);
  assert.deepEqual(retained.conversation,[question]); assert.equal(retained.memory?.notes,'Keep this unresolved question context');
  assert.equal(editor.trip.drafts.filter(draft=>draft.expenseId===latest.id).length,1);
  editor.openExpense(editor.trip.expenses[0]); assertChosenFinancials(editor.editing,latest); assert.equal(editor.editing?.draftId,retained.id);
  assert.deepEqual(editor.editing?.conversation,[question]); await submit(editor); assertChosenFinancials(editor.trip.expenses[0],latest);
});

test('automatic replies after choosing saved values preserve financials across different draft and saved photos', async () => {
  const initial=fixture(pending('review')); const editor=controller(initial); editor.openExpense(initial.expenses[0]);
  const changed=structuredClone(initial); const latest=latestCorrection(changed.expenses[0]); changed.expenses[0]=latest; editor.remote(changed);
  assert.equal(editor.editorIsCurrent(),false); editor.openExpense(latest,false);
  const priorError=editor.error;
  const newer=structuredClone(changed); newer.drafts[0].conversation!.push({...question,id:'fresh-question',text:'Keep this new follow-up'});
  newer.drafts[0].memory={notes:'Memory refreshed without replacing chosen financials',aliases:[]}; editor.remote(newer);
  editor.reconcileEditorReceipt(editor.trip); assert.equal(editor.error,priorError,'background replies preserve existing local validation messages'); assertChosenFinancials(editor.editing,latest);
  assert.equal(editor.processed,null,'a proposal for another photo cannot become the selected processed proposal');
  assert(editor.editing?.conversation?.some(message=>message.id==='fresh-question'));
  assert.equal(editor.editing?.memory?.notes,'Memory refreshed without replacing chosen financials');
  const following={...question,id:'my-follow-up',text:'My new question after choosing the saved expense'};
  const saved=await editor.storeEditorReceipt({...editor.editing!,conversation:[...editor.editing!.conversation!,following]},editor.editing!.receiptId,true); assert(saved);
  assert.equal(saved.id,'replacement-draft'); assert.equal(saved.expenseId,latest.id); assertChosenFinancials(saved,latest);
  assert.equal(editor.trip.drafts.filter(draft=>draft.expenseId===latest.id).length,1);
  await submit(editor); assertChosenFinancials(editor.trip.expenses[0],latest); editor.openExpense(editor.trip.expenses[0]); assertChosenFinancials(editor.editing,latest);
  assert(editor.editing?.conversation?.some(message=>message.id==='my-follow-up'));
});

test('a cached processed proposal cannot supply items after its photo changes', async () => {
  const initial=fixture(); const editor=controller(initial); editor.openExpense(initial.expenses[0]);
  const incoming=structuredClone(initial); incoming.drafts[0].status='review'; incoming.drafts[0].conversation=[question,reply];
  editor.remote(incoming); editor.reconcileEditorReceipt(editor.trip);
  assert.equal(editor.processed?.receiptId,'replacement-photo'); const changed=structuredClone(initial);
  changed.drafts[0].receiptId='unreviewed-new-photo'; changed.drafts[0].items[0].amount=9999;
  changed.drafts[0].conversation=[question,{...reply,id:'new-photo-reply',text:'Answer about the new photo'}];
  changed.drafts[0].memory={notes:'Context for the unreviewed new photo',aliases:[]};editor.remote(changed);
  editor.reconcileEditorReceipt(editor.trip); assert.equal(editor.processed,null,'a replacement image invalidates the cached financial proposal');
  assert(!editor.editing?.conversation?.some(message=>message.id==='new-photo-reply'),'the old image binding cannot import a replacement image’s discussion');
  assert.equal(editor.editing?.memory?.notes,initial.drafts[0].memory?.notes);
  const entry={...editor.editing!,items:editor.editing!.items.map(item=>({...item,amount:3000})),conversation:[...editor.editing!.conversation!,{...question,id:'photo-question'}]};
  const saved=await editor.storeEditorReceipt(entry,entry.receiptId,true); assert(saved);
  assert.equal(saved.receiptId,'replacement-photo'); assert.equal(saved.items[0].amount,3000,'unreviewed items for another photo must not replace local values');
});

test('automatic replies and reviewing a replacement draft retain posted and local receipt context', async () => {
  const draft=pending(); delete draft.memory;
  const initial=fixture(draft); const postedQuestion={...question,id:'posted-question',text:'Already saved on the posted expense'};
  initial.expenses[0].conversation=[postedQuestion]; initial.expenses[0].memory={notes:'Memory retained on the posted expense',aliases:[]};
  const editor=controller(initial); editor.openExpense(initial.expenses[0]); const localQuestion={...question,id:'local-question',text:'Local question retained during automatic updates'};
  editor.edit({conversation:[...editor.editing!.conversation!,localQuestion]});
  const incoming=structuredClone(initial); incoming.drafts[0].status='review'; incoming.drafts[0].conversation=[question,reply];
  incoming.drafts[0].items[0].amount=2500; editor.remote(incoming); editor.reconcileEditorReceipt(editor.trip);
  assert.equal(editor.error,''); assert.equal(editor.processed?.id,draft.id);
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

const response = (body: unknown, ok = true) => ({ok,headers:{get:()=>''},json:async()=>body});
const receiptFile = () => new File(['receipt pixels'], 'photo.jpg', {type:'image/jpeg'});
function itemizedTrip(initial: Trip, amount = 2300): Trip {
  const next=structuredClone(initial);
  const draft=next.drafts[0];
  draft.status='review';draft.source='ai';draft.title='Transcribed dinner';
  draft.items=[{id:'native-item',name:'Dinner from image',amount,members:['a','b']}];
  return next;
}

test('copying a saved receipt never overwrites a newer native proposal with stale editor values', async () => {
  const initial=fixture();const editor=controller(initial);editor.openExpense(initial.expenses[0]);
  const newer=itemizedTrip(initial,9900);editor.remote(newer);const original=structuredClone(newer.drafts[0]);
  await editor.prepareEditorReceipt();
  assert.equal(editor.updates.length,0);assert.deepEqual(editor.trip.drafts[0],original);
  assert.equal(editor.editing?.items[0].amount,2000);assert(editor.prompt.includes('replacement-draft'));
  assert.equal(editor.clipboard[0],editor.prompt);
});

test('clipboard failure keeps the exact saved prompt visible without writing or changing items', async () => {
  const initial=fixture();const editor=controller(initial);editor.openExpense(initial.expenses[0]);editor.clipboardUnavailable();
  await editor.prepareEditorReceipt();
  assert.equal(editor.updates.length,0);assert(editor.prompt.includes('get_receipt_image'));
  assert.match(editor.handoffError,/Select and copy the exact receipt prompt/);
  assert.deepEqual(editor.editing?.items,initial.drafts[0].items);
});

test('a failed draft save cannot launch AI processing or mark the uploaded photo as stored', async () => {
  const editor=controller(blankTrip());editor.newExpense();editor.aiConnected();editor.persistenceFailure();
  editor.network(async()=>response({receiptId:'new-photo'}));
  await editor.captureEditorReceipt(receiptFile());
  assert.equal(editor.requests.length,1);assert.equal(editor.prompt,'');assert.equal(editor.pending,true);
  assert.match(editor.handoffError,/draft could not be saved/);assert.equal(editor.trip.drafts.length,0);
});

test('native reading starts only after image and canonical draft save, and fills an unchanged new editor without posting', async () => {
  const editor=controller(blankTrip());editor.newExpense();const id=editor.editing!.id;editor.aiConnected();
  editor.network(async(url,options)=>{
    if(url.startsWith('/api/receipt?'))return response({receiptId:'new-photo'});
    assert.equal(url,'/api/receipt/process');
    const args=JSON.parse(String(options?.body));assert.equal(args.receiptId,'new-photo');
    assert.equal(args.draftId,editor.trip.drafts[0].id);
    assert.equal(args.draftHash,await sha256Hex(canonicalJson(editor.trip.drafts[0])),'scan uses the canonical saved draft as its server fence');
    assert.equal(Object.hasOwn(args,'revision'),false,'unrelated ledger revisions do not fence a receipt scan');
    assert.equal(args.readPurchaseDetails,true,'printed metadata can replace untouched browser defaults');
    assert.equal(editor.trip.drafts[0].status,'waiting');assert.equal(editor.trip.expenses.length,0);
    return response({data:{trips:[itemizedTrip(editor.trip)]},revision:2});
  });
  await editor.captureEditorReceipt(receiptFile());editor.reconcileEditorReceipt(editor.trip);editor.reconcileEditorReceipt(editor.trip);
  assert.equal(editor.editing!.id,id);assert.equal(editor.editing!.items[0].name,'Dinner from image');
  assert.equal(editor.itemized,true);assert.equal(editor.processed,null);assert.equal(editor.trip.expenses.length,0);
  assert.equal(editor.updates.length,1,'only the waiting draft was saved by the browser');
});

test('choosing an icon before upload preserves it through the saved draft and initial itemisation', async () => {
  const editor=controller(blankTrip());editor.newExpense();editor.aiConnected();
  const icon={symbol:'Palmtree',background:'pink'} as const;editor.edit({icon});
  editor.network(async url => url.startsWith('/api/receipt?') ? response({receiptId:'new-photo'})
    : response({data:{trips:[itemizedTrip(editor.trip)]},revision:2}));
  await editor.captureEditorReceipt(receiptFile());editor.reconcileEditorReceipt(editor.trip);editor.reconcileEditorReceipt(editor.trip);
  assert.deepEqual(editor.trip.drafts[0].icon,icon);
  assert.deepEqual(editor.editing?.icon,icon);
  assert.equal(editor.itemized,true);
  assert.equal(editor.editing?.items[0].name,'Dinner from image');
});

test('retaining an incoming proposal for chat keeps the current icon or an explicit automatic reset', async () => {
  for (const icon of [{symbol:'Palmtree',background:'pink'} as const,undefined]) {
    const initial=fixture();initial.drafts[0].icon={symbol:'Coffee',background:'gold'};
    const editor=controller(initial);editor.openExpense(initial.expenses[0]);editor.edit({icon});
    const incoming=structuredClone(initial);incoming.drafts[0].status='review';incoming.drafts[0].items[0].amount=2500;
    editor.remote(incoming);editor.reconcileEditorReceipt(editor.trip);assert(editor.processed);
    const saved=await editor.storeEditorReceipt(editor.editing!,editor.editing!.receiptId,true);
    assert.deepEqual(saved?.icon,icon);
    editor.reviewProcessedReceipt();
    assert.deepEqual(editor.editing?.icon,icon);
  }
});

test('metadata selected before uploading requires review rather than automatic replacement', async () => {
  const editor=controller(blankTrip());editor.newExpense();editor.edit({payer:'b',date:'2026-09-03'});editor.aiConnected();
  editor.network(async url=>url.startsWith('/api/receipt?')?response({receiptId:'new-photo'}):response({data:{trips:[itemizedTrip(editor.trip)]},revision:2}));
  await editor.captureEditorReceipt(receiptFile());editor.reconcileEditorReceipt(editor.trip);
  assert.equal(editor.editing!.payer,'b');assert.equal(editor.editing!.date,'2026-09-03');assert.equal(editor.editing!.items[0].amount,0);
  assert(editor.processed);assert.equal(editor.itemized,false);assert.equal(editor.trip.expenses.length,0);
});

test('typing while native reading is pending preserves local values and offers the completed proposal for review', async () => {
  const editor=controller(blankTrip());editor.newExpense();editor.aiConnected();
  let release!:(value:unknown)=>void, started!:()=>void;
  const pendingResponse=new Promise(resolve=>{release=resolve}),processingStarted=new Promise<void>(resolve=>{started=resolve});
  editor.network(async url=>{
    if(url.startsWith('/api/receipt?'))return response({receiptId:'new-photo'});
    started();return pendingResponse;
  });
  const captured=editor.captureEditorReceipt(receiptFile());await processingStarted;assert.equal(editor.processing,true);
  editor.edit({title:'My local correction',payer:'b',items:[{id:'local',name:'Local item',amount:4500,members:['b']}]});
  release(response({data:{trips:[itemizedTrip(editor.trip)]},revision:2}));await captured;editor.reconcileEditorReceipt(editor.trip);
  assert.equal(editor.editing!.title,'My local correction');assert.equal(editor.editing!.items[0].amount,4500);
  assert.equal(editor.editing!.payer,'b');assert(editor.processed);assert.equal(editor.processing,false);assert.equal(editor.trip.expenses.length,0);
});

test('a reading response from a previous account cannot apply its proposal', async () => {
  const editor=controller(blankTrip());editor.newExpense();editor.aiConnected();
  let release!:(value:unknown)=>void, started!:()=>void;
  const pendingResponse=new Promise(resolve=>{release=resolve}),processingStarted=new Promise<void>(resolve=>{started=resolve});
  editor.network(async url=>{if(url.startsWith('/api/receipt?'))return response({receiptId:'new-photo'});started();return pendingResponse;});
  const captured=editor.captureEditorReceipt(receiptFile());await processingStarted;editor.accountSwitch();
  release(response({data:{trips:[itemizedTrip(editor.trip)]},revision:2}));await captured;
  assert.equal(editor.trip.drafts[0].status,'waiting');assert.equal(editor.editing!.items.length,0);
});

test('an automatic receipt snapshot after closing and reopening cannot replace the new editor or its review state', () => {
  const initial=fixture();const editor=controller(initial);editor.openExpense(initial.expenses[0]);
  editor.closeReceiptEditor();editor.newExpense();const id=editor.editing!.id;
  editor.remote(itemizedTrip(initial),1);editor.reconcileEditorReceipt(editor.trip);
  assert.equal(editor.editing!.id,id);assert.equal(editor.editing!.items[0].amount,0);assert.equal(editor.processed,null);
  assert.equal(editor.trip.drafts[0].status,'review','accepted ledger changes are available outside the unrelated new editor');assert.equal(editor.prompt,'');
});

test('an automatic snapshot for another holiday cannot import its replies or proposal into the open receipt', () => {
  const initial=fixture();const editor=controller(initial);editor.openExpense(initial.expenses[0]);
  const previous=structuredClone(editor.editing);const other=itemizedTrip(initial);other.id='another-holiday';
  other.drafts[0].conversation=[question,reply];editor.remote(other,1);editor.reconcileEditorReceipt(editor.trip);
  assert.deepEqual(editor.editing,previous);assert.equal(editor.processed,null);
});

test('native failures preserve the photo and draft with a retryable error instead of fabricated receipt lines', async () => {
  const editor=controller(blankTrip());editor.newExpense();editor.aiConnected();
  editor.network(async url=>url.startsWith('/api/receipt?')?response({receiptId:'new-photo'}):response({error:'The image is unreadable. Try another photo.'},false));
  await editor.captureEditorReceipt(receiptFile());
  assert.equal(editor.processing,false);assert.match(editor.handoffError,/unreadable/);
  assert.equal(editor.editing!.receiptId,'new-photo');assert.equal(editor.trip.drafts[0].status,'waiting');
  assert.equal(editor.editing!.items.length,0);assert(editor.prompt.includes('new-photo')); assert.equal(editor.trip.expenses.length,0);
});

test('item share questions use configured native text processing with saved context and review-only changes', async () => {
  const initial=fixture(pending('review'));const editor=controller(initial);editor.openExpense(initial.expenses[0]);editor.aiConnected();
  let savedQuestionId='';
  editor.network(async(url,options)=>{
    assert.equal(url,'/api/receipt/process');const args=JSON.parse(String(options?.body));
    savedQuestionId=args.questionId;const saved=editor.trip.drafts.find(draft=>draft.id===args.draftId)!;
    assert(saved.conversation!.some(message=>message.id===savedQuestionId&&message.itemId==='replacement-item'&&message.text.includes('Alice ate 2.5')));
    assert.equal(args.draftHash,await sha256Hex(canonicalJson(saved)));assert.equal(args.readPurchaseDetails,false);
    const next=structuredClone(editor.trip),proposal=next.drafts.find(draft=>draft.id===saved.id)!;
    proposal.conversation!.push({id:'native-reply',role:'assistant',replyTo:savedQuestionId,itemId:'replacement-item',text:'Proposed the requested shares.',createdAt:stamp});
    return response({data:{trips:[next]},revision:editor.updates.length+1});
  });
  assert.equal(await editor.sendReceiptQuestion('Alice ate 2.5 bars and Bob ate 5. Set their item shares.','replacement-item'),true);
  assert.equal(editor.requests.length,1);assert.equal(editor.clipboard.length,0);assert.equal(editor.processing,false);
  assert.equal(editor.trip.drafts.find(draft=>draft.id==='replacement-draft')!.conversation!.at(-1)!.replyTo,savedQuestionId);
  assert.equal(editor.trip.expenses[0].items[0].amount,1000,'asking is not posting financial changes');
  assert.equal(await editor.retryReceiptQuestion(savedQuestionId),true);assert.equal(editor.requests.length,1,'an answered saved question cannot trigger another request');
});

test('native chat failure keeps the saved question available for retry without duplicating it', async () => {
  const initial=fixture(pending('review'));const editor=controller(initial);editor.openExpense(initial.expenses[0]);editor.aiConnected();
  editor.network(async()=>response({error:'OpenAI is temporarily unavailable.'},false));
  assert.equal(await editor.sendReceiptQuestion('Gaz had this drink.','replacement-item'),true);
  assert.match(editor.handoffError,/temporarily unavailable/);assert.equal(editor.processing,false);assert.equal(editor.clipboard.length,0);
  const saved=editor.trip.drafts.find(draft=>draft.id==='replacement-draft')!,id=saved.conversation!.at(-1)!.id,count=saved.conversation!.length;
  assert.equal(await editor.retryReceiptQuestion(id),false);
  assert.equal(editor.trip.drafts.find(draft=>draft.id===saved.id)!.conversation!.length,count);
  const args=editor.requests.map(request=>JSON.parse(String(request.options?.body)));assert.equal(args[0].questionId,args[1].questionId);
});

test('a remotely changed receipt image or review target cannot be consumed by a stale editor save', async context => {
  for(const mutation of ['image','target','removed'])await context.test(mutation,async()=>{
    const initial=fixture();const editor=controller(initial);editor.openExpense(initial.expenses[0]);
    const changed=structuredClone(initial);
    if(mutation==='image')changed.drafts[0].receiptId='another-photo';
    if(mutation==='target')changed.drafts[0].expenseId='another-expense';
    if(mutation==='removed')changed.drafts=[];
    editor.remote(changed);await submit(editor);
    assert.equal(editor.updates.length,0);assert.match(editor.error,/receipt draft changed or is no longer available/);
    assert.equal(editor.editing?.receiptId,'replacement-photo');assert.deepEqual(editor.trip.drafts,changed.drafts);
  });
});

test('inbox upload dispatches printed purchase metadata even before the new editor layout effect commits', async () => {
  const editor=controller(blankTrip());editor.aiConnected();editor.deferLayout();
  assert.equal(editor.editing,null);
  let dispatched: Record<string, unknown> | undefined;
  editor.network(async(url,options)=>{
    if(url.startsWith('/api/receipt?'))return response({receiptId:'inbox-photo'});
    assert.equal(url,'/api/receipt/process');
    const args=JSON.parse(String(options?.body));
    dispatched=args;
    assert.equal(args.receiptId,'inbox-photo');assert.equal(args.draftId,editor.trip.drafts[0].id);assert.equal(args.revision,1);
    assert.equal(editor.trip.drafts[0].status,'waiting');assert.equal(editor.trip.expenses.length,0);
    return response({data:{trips:[itemizedTrip(editor.trip)]},revision:2});
  });
  await editor.upload(receiptFile());
  assert.equal(dispatched?.readPurchaseDetails,true,'the same upload continuation must bind the computed new editor rather than its previous null ref');
  assert.equal(editor.requests.length,3);assert.equal(editor.view,'receipts');assert.equal(editor.help,false);
  assert.equal((editor.editing as Editing | null)?.receiptId,'inbox-photo');assert.equal(editor.trip.expenses.length,0);
  assert(editor.prompt.includes('inbox-photo'));
});

test('a signed-in participant can automatically read a receipt through shared API access without key-management permission', async () => {
  const editor=controller(blankTrip());editor.participantAccount();editor.newExpense();
  let dispatched:Record<string,unknown>|undefined;
  editor.network(async(url,options)=>{
    if(url.startsWith('/api/receipt?'))return response({receiptId:'participant-photo'});
    dispatched=JSON.parse(String(options?.body));
    return response({data:{trips:[itemizedTrip(editor.trip)]},revision:2});
  });
  await editor.captureEditorReceipt(receiptFile());editor.reconcileEditorReceipt(editor.trip);editor.reconcileEditorReceipt(editor.trip);
  assert.equal(editor.requests[2]?.url,'/api/receipt/process');assert.equal(dispatched?.receiptId,'participant-photo');
  assert.equal(editor.editing?.items[0].name,'Dinner from image');assert.equal(editor.itemized,true);
  assert.equal(editor.trip.expenses.length,0,'shared inference still requires a separate approved expense save');
});

test('uploads refresh newly activated shared AI and do not wait for an old participant render to update', async context => {
  for (const source of ['editor','inbox'] as const) await context.test(source, async () => {
    const editor=controller(blankTrip());editor.participantAccount(false);editor.deferAIState();
    if(source==='editor')editor.newExpense();
    editor.statusNetwork(async()=>response({configured:true,connected:true,provider:'api',eligible:true,manageable:false,siwcAvailable:false}));
    editor.network(async(url)=>url.startsWith('/api/receipt?')?response({receiptId:'newly-enabled-photo'}):response({data:{trips:[itemizedTrip(editor.trip)]},revision:2}));

    await (source==='editor'?editor.captureEditorReceipt(receiptFile()):editor.upload(receiptFile()));
    const status=editor.requests.find(request=>request.url==='/api/receipt/ai-status');
    const processing=editor.requests.find(request=>request.url==='/api/receipt/process');
    assert.equal(status?.options?.cache,'no-store','key activation in another browser requires a fresh server read');
    assert.equal(editor.ai?.connected,false,'React has not yet committed the status update to this upload closure');
    assert(processing,'the returned shared service status must start reading even while the previous render was disconnected');
    assert.equal(JSON.parse(String(processing.options?.body)).receiptId,'newly-enabled-photo');
    assert.equal(editor.trip.drafts[0].status,'review');assert.equal(editor.trip.expenses.length,0);
  });
});

test('a pending shared AI status refresh cannot start reading for a different account or editor', async context => {
  for (const change of ['account','editor'] as const) await context.test(change, async () => {
    const editor=controller(blankTrip());editor.participantAccount(false);editor.newExpense();
    let release!:(value:unknown)=>void, started!:()=>void;
    const status=new Promise(resolve=>{release=resolve}),statusStarted=new Promise<void>(resolve=>{started=resolve});
    editor.statusNetwork(async()=>{started();return status});
    editor.network(async()=>response({receiptId:'saved-before-status'}));
    const captured=editor.captureEditorReceipt(receiptFile());await statusStarted;
    if(change==='account')editor.accountSwitch();else{editor.closeReceiptEditor();editor.newExpense();}
    release(response({configured:true,connected:true,provider:'api',eligible:true,manageable:false,siwcAvailable:false}));
    await captured;
    assert.equal(editor.requests.some(request=>request.url==='/api/receipt/process'),false);
    assert.equal(editor.trip.drafts[0].status,'waiting');assert.equal(editor.trip.expenses.length,0);
    if(change==='account')assert.equal(editor.ai?.connected,false,'old-account status cannot update current service state');
  });
});

test('incomplete scanned items and pending quantities persist without fabricated prices or allocations and cannot post', async () => {
  const draft = pending('review');
  draft.expenseId = undefined;
  draft.currency = null;
  draft.items = [{id: 'pizza', name: 'Pizza slices', amount: null, members: [], quantity: {total: 2, label: 'slices'}, units: {total: 2, allocations: {}, label: 'slices'}}];
  draft.receiptScan = {version: 1, printedTotal: 1200, status: 'incomplete', warnings: [{code: 'ambiguous-currency'}]};
  const initial = fixture(draft); initial.expenses = [];
  const editor = controller(initial); editor.openDraft(draft);
  assert.equal(editor.editing?.items[0].amount, null);
  assert.equal(editor.editing?.currency, null);
  const stored = await editor.storeEditorReceipt(editor.editing!, draft.receiptId);
  assert.equal(stored?.items[0].amount, null);
  assert.deepEqual(stored?.items[0].members, []);
  assert.deepEqual(stored?.items[0].units?.allocations, {});
  await submit(editor);
  assert.match(editor.error, /Complete unreadable receipt values/);
  assert.equal(editor.trip.expenses.length, 0);
});

test('Save checks independent totals and explicit reviewed differences before posting', async () => {
  const draft = pending('review'); draft.expenseId = undefined; draft.fx = undefined; draft.bankAmount = undefined;
  draft.currency = 'GBP'; draft.items = [{id: 'pizza', name: 'Pizza', amount: 1200, members: ['a']}];
  draft.tax = 0; draft.tip = 0; draft.discount = 0;
  draft.receiptScan = {version: 1, printedTotal: 1201, printedCurrency: 'GBP', status: 'matched', warnings: []};
  const initial = fixture(draft); initial.expenses = [];
  const editor = controller(initial); editor.openDraft(draft);
  await submit(editor); assert.match(editor.error, /do not match the printed receipt/); assert.equal(editor.trip.expenses.length, 0);
  editor.edit({receiptScan: {...editor.editing!.receiptScan!, acknowledgement: {fingerprint: receiptScanFingerprint(editor.editing!)}}});
  await submit(editor); assert.equal(editor.error, ''); assert.equal(editor.trip.expenses.length, 1);
  assert.equal(editor.trip.expenses[0].items[0].amount, 1200);
  assert.equal(editor.trip.expenses[0].receiptScan?.printedTotal, 1201);
});

test('receipt proposals replace defaults while preserving user-confirmed fields and clearing obsolete currency conversion', () => {
  const initial = fixture(), editor = controller(initial); editor.openDraft(initial.drafts[0]);
  const current = {...editor.editing!, title: 'My title', payer: 'a', currency: 'GBP' as const, fieldSources: {title: 'user' as const, payer: 'user' as const, currency: 'default' as const}};
  const proposal = {...initial.drafts[0], title: 'Scanned title', payer: 'b', currency: 'EUR' as const, fieldSources: {title: 'receipt' as const, currency: 'receipt' as const, payer: 'default' as const}};
  const merged = receiptProposalEditor(current, proposal);
  assert.equal(merged.title, 'My title'); assert.equal(merged.payer, 'a'); assert.equal(merged.currency, 'EUR');
  assert.equal(merged.fx, undefined); assert.equal(merged.bankAmount, undefined);
  assert.equal(merged.fieldSources?.title, 'user'); assert.equal(merged.fieldSources?.currency, 'receipt');
});

test('whole-receipt percentages save scanned pending quantities without inventing consumption, and item mode requires allocation', async () => {
  const draft = pending('review'); draft.expenseId = undefined; draft.currency = 'GBP'; draft.fx = undefined; draft.bankAmount = undefined;
  draft.items = [{id: 'pizza', name: 'Pizza slices', amount: 1200, members: [], quantity: {total: 2, label: 'slices'}, units: {total: 2, allocations: {}, label: 'slices'}}];
  draft.percentages = {a: 30, b: 70}; draft.tax = 0; draft.tip = 0; draft.discount = 0;
  draft.receiptScan = {version: 1, printedTotal: 1200, printedCurrency: 'GBP', status: 'matched', warnings: []};
  const initial = fixture(draft); initial.expenses = [];
  const editor = controller(initial); editor.openDraft(draft); await submit(editor);
  assert.equal(editor.error, ''); assert.equal(editor.trip.expenses.length, 1);
  const saved = editor.trip.expenses[0]; assert.deepEqual(saved.items[0].members, []); assert.deepEqual(saved.items[0].units?.allocations, {});
  assert.deepEqual(saved.percentages, {a: 30, b: 70}); assert.equal(saved.items[0].quantity?.total, 2);
  editor.openExpense(saved); editor.edit({percentages: undefined}); await submit(editor);
  assert.match(editor.error, /cost shares|person/); assert.deepEqual(editor.trip.expenses[0], saved, 'removing the override cannot silently post an unassigned item');
});

test('a question about unfinished pending quantities preserves the last complete draft allocation context', async () => {
  const draft = pending('review'); draft.expenseId = undefined; draft.percentages = undefined; draft.fx = undefined; draft.bankAmount = undefined;
  draft.items = [{id: 'pizza', name: 'Pizza slices', amount: 1200, members: [], quantity: {total: 2, label: 'slices'}, units: {total: 2, allocations: {}, label: 'slices'}}];
  const initial = fixture(draft); initial.expenses = [];
  const editor = controller(initial); editor.openDraft(draft);
  editor.edit({items: [{...editor.editing!.items[0], members: ['a'], units: {total: 2, label: 'slices', allocations: {a: NaN}}}]});
  assert.equal(await editor.sendReceiptQuestion('Please finish these shares', 'pizza'), true);
  const stored = editor.trip.drafts[0]; assert.deepEqual(stored.items[0].members, []); assert.deepEqual(stored.items[0].units?.allocations, {});
  assert.match(stored.conversation!.at(-1)!.text, /Alice: not entered slices/);
  assert(Number.isNaN(editor.editing!.items[0].units?.allocations.a), 'typing remains in the live editor for correction');
  assert.equal(editor.trip.expenses.length, 0);
});

test('opening a legacy populated draft does not relabel saved metadata as replaceable defaults', () => {
  const initial = fixture(); const editor = controller(initial); delete initial.drafts[0].fieldSources;
  editor.openDraft(initial.drafts[0]);
  assert.equal(editor.editing?.fieldSources?.title, undefined);
  assert.equal(editor.editing?.fieldSources?.currency, undefined);
  assert.equal(editor.editing?.fieldSources?.payer, undefined);
  assert.equal(editor.editing?.fieldSources?.date, undefined);
  assert.equal(editor.editing?.fieldSources?.time, undefined);
  assert.equal(editor.editing?.fieldSources?.tax, undefined);
});

test('closing an editor during upload clears busy controls without letting the old upload mutate a new receipt', async () => {
  const editor = controller(fixture()); editor.newExpense();
  let finish!: (response: unknown) => void;
  editor.network(() => new Promise(resolve => {finish=resolve}));
  const upload = editor.captureEditorReceipt({type:'image/png',size:100} as File);
  assert.equal(editor.uploading,true);
  editor.closeReceiptEditor(); assert.equal(editor.uploading,false); assert.equal(editor.connecting,false);
  editor.newExpense(); const freshId=editor.editing!.id;
  finish({ok:true,json:async()=>({receiptId:'old-upload-photo'})}); await upload;
  assert.equal(editor.editing?.id,freshId); assert.equal(editor.editing?.receiptId,undefined);
  assert.equal(editor.uploading,false);
});

test('a half-typed item name and quantity can be saved for chat without a parsing crash', async () => {
  const editor=controller(fixture()); editor.openExpense(editor.trip.expenses[0]);
  const item=editor.editing!.items[0];
  editor.edit({items:[{...item,name:'',units:{total:3,allocations:{a:NaN},label:'pieces'}}]});
  const saved=await editor.storeEditorReceipt(editor.editing!,editor.editing!.receiptId);
  assert(saved); assert.equal(saved.items[0].name,'');
  assert.deepEqual(saved.items[0].units,item.units);
  assert.equal(editor.editing?.items[0].name,'','live text remains available to finish');
});

test('concurrent AI status requests share one read, but a settings change requests a fresh status', async () => {
  const editor=controller(fixture()); editor.newExpense();
  const replies:((response:unknown)=>void)[]=[];
  editor.statusNetwork(()=>new Promise(resolve=>replies.push(resolve)));
  const first=editor.refreshReceiptAIStatus('owner');
  const focus=editor.refreshReceiptAIStatus('owner');
  assert.equal(replies.length,1);
  const changed=editor.refreshReceiptAIStatus('owner',true); assert.equal(replies.length,2);
  const state=(connected:boolean)=>({ok:true,json:async()=>({configured:connected,connected,provider:'api',eligible:true,manageable:true,siwcAvailable:false})});
  replies[0](state(false)); await Promise.all([first,focus]);
  replies[1](state(true)); await changed;
  assert.equal(editor.ai?.connected,true);
});

test('explicit confirmation of the same original currency keeps bank amount and exchange-rate details', () => {
  let callback='';
  function visit(node:import('typescript').Node) {
    if (isJsxElement(node) && node.openingElement.tagName.getText(syntax)==='button' && node.children.some(child=>child.getText(syntax).includes('I checked the currency:'))) {
      const attr=node.openingElement.attributes.properties.find(prop=>isJsxAttribute(prop)&&prop.name.getText(syntax)==='onClick');
      assert(attr&&isJsxAttribute(attr)&&attr.initializer&&isJsxExpression(attr.initializer)&&attr.initializer.expression);
      callback=attr.initializer.expression.getText(syntax);
    }
    node.forEachChild(visit);
  }
  visit(syntax); assert(callback);
  const editing={...pending(),id:'edited',draftId:'replacement-draft',date:'2026-10-05',time:'12:00',timezone:'Europe/Paris',fieldSources:{currency:'default' as const}} as ReceiptEditor;
  const original=structuredClone(editing); let next:ReceiptEditor|undefined;
  const run=new Function('editing','setEditing','userReceiptField',transpileModule(`(${callback})();`,{compilerOptions:{target:ScriptTarget.ES2022}}).outputText);
  run(editing,(value:ReceiptEditor)=>{next=value},userReceiptField);
  assert(next); assert.equal(next.currency,original.currency);
  assert.equal(next.bankAmount,original.bankAmount); assert.deepEqual(next.fx,original.fx);
  assert.equal(next.fieldSources?.currency,'user');
});

test('upload notes and optional place are saved before the first vision request and retained in editor context',async()=>{
  const editor=controller(blankTrip());editor.aiConnected();let inspected=false;
  editor.network(async(url,options)=>{
    if(url.startsWith('/api/receipt?'))return response({receiptId:'notes-photo'});
    const args=JSON.parse(String(options?.body)),saved=editor.trip.drafts.find(draft=>draft.id===args.draftId)!;
    assert.equal(saved.conversation!.at(-1)!.text,'In Bratislava. Gaz had a decaf; I had a cappuccino.');
    assert.equal(saved.conversation!.at(-1)!.authorMemberId,undefined,'the client does not fabricate an author stamp');
    assert.deepEqual(saved.location,{label:'Bratislava',source:'user'});assert.equal(saved.fieldSources?.location,'user');
    assert.equal(saved.locationHint?.latitude,48.1486);assert.equal(args.receiptId,'notes-photo');inspected=true;
    return response({data:{trips:[itemizedTrip(editor.trip)]},revision:editor.updates.length+1});
  });
  await editor.upload(receiptFile(),{notes:' In Bratislava. Gaz had a decaf; I had a cappuccino. ',location:{label:'Bratislava',source:'user'},locationHint:{latitude:48.1486,longitude:17.1077,accuracy:100,capturedAt:stamp}});
  assert.equal(inspected,true);assert.equal(editor.trip.expenses.length,0);assert.equal(editor.editing?.location?.label,'Bratislava');
});

test('editor capture notes survive a failed canonical save and are cleared after a successful retry',async()=>{
  const editor=controller(blankTrip());editor.newExpense();editor.setNotes('Gary had this; I had that.');editor.persistenceFailure();
  editor.network(async()=>response({receiptId:'notes-photo'}));await editor.captureEditorReceipt(receiptFile());
  assert.equal(editor.captureNotes,'Gary had this; I had that.');assert.equal(editor.requests.filter(request=>request.url==='/api/receipt/process').length,0);
  editor.persistenceRecovered();await editor.captureEditorReceipt(receiptFile());assert.equal(editor.captureNotes,'');
  assert.equal(editor.trip.drafts[0].conversation!.filter(message=>message.text==='Gary had this; I had that.').length,1);
});

test('place-only guidance keeps a new receipt eligible for initial extraction and is retained through proposal review',async()=>{
  const editor=controller(blankTrip());editor.newExpense();editor.aiConnected();editor.setEditorPlace({location:{label:'Bratislava',source:'user'}});
  editor.network(async(url)=>url.startsWith('/api/receipt?')?response({receiptId:'new-photo'}):response({data:{trips:[itemizedTrip(editor.trip)]},revision:editor.updates.length+1}));
  await editor.captureEditorReceipt(receiptFile());editor.reconcileEditorReceipt(editor.trip);
  assert.equal(editor.trip.drafts[0].location?.label,'Bratislava');assert.equal(editor.editing?.location?.label,'Bratislava');assert.equal(editor.editing?.items[0].name,'Dinner from image');
  assert.equal(editor.trip.expenses.length,0);
});
