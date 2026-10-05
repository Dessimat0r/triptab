import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultLanguagePreferences,editReadingName,itemDisplayKey,mergeScannedNames,observedItemLanguage,originalItemLanguage,receiptLanguageHint,setPairedTranslation } from '../lib/receipt-languages';
import { draftSchema,expenseSchema,shares,type Draft,type Trip,type Item } from '../lib/model';
import { applyReceiptTranscription,processReceiptImage,type ReceiptTranscription } from '../lib/receipt-ai';
import { processLanguageRequest } from '../lib/receipt-language-ai';
import { receiptScanFingerprint,blankReceiptItem } from '../lib/receipt-scan';
import { createReceiptFlowWorker } from './helpers/receipt-flow-worker';
const trip:Trip={id:'holiday',name:'Austria',currency:'EUR',receiptLanguage:'de',members:[{id:'alice',name:'Alice'}],expenses:[],drafts:[],payments:[]};
const draft:Draft={id:'draft',title:'Restaurant',currency:'EUR',payer:'alice',items:[],tax:0,tip:0,discount:0,status:'waiting',receiptId:'photo'};
const transcription:ReceiptTranscription={title:'Ristorante',currency:'EUR',detectedLanguage:'it',items:[{id:null,name:'Acqua frizzante',nameLanguage:'it',translatedName:'Sparkling water',amount:250,scanSource:{lineIndex:0,observedText:'ACQUA FRIZZANTE 2,50',confidence:'high'}}],tax:0,tip:0,discount:0,printedTotal:250,date:null,time:null,summary:'One Italian item.'};
function completed(value:unknown){return new Response(`data: ${JSON.stringify({type:'response.completed',response:{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(value)}]}]}})}\n\n`,{headers:{'Content-Type':'text/event-stream'}});}
test('receipt hints, explicit overrides and detected outliers retain distinct roles',()=>{
  assert.equal(receiptLanguageHint(trip,{}),'de');assert.equal(receiptLanguageHint(trip,{receiptLanguage:'auto'}),undefined);
  assert.equal(originalItemLanguage({name:'Acqua',nameLanguage:'it'},trip,{detectedLanguage:'de'}),'it');
  assert.equal(originalItemLanguage({name:'Acqua',nameLanguage:'it'},trip,{receiptLanguage:'fr'}),'fr');
  assert.equal(observedItemLanguage({name:'Acqua'},{}),undefined,'trip hints are never asserted as actual source language');
  assert.equal(originalItemLanguage({name:'Acqua'},trip,{}),'de');
});
test('initial scan infers outlier language and captures both versions in the original vision request',async()=>{
  let calls=0,body:Record<string,unknown>={};
  const result=await processReceiptImage({accessToken:'synthetic',provider:'api',trip,draft,callerMemberId:'alice',readingLanguage:'en',image:{bytes:new Uint8Array([1]),mimeType:'image/png'}},{fetcher:async(_url,init)=>{calls++;body=JSON.parse(init!.body as string);return completed(transcription);}});
  assert.equal(calls,1);const context=JSON.parse(((body.input as {content:{text:string}[]}[])[0].content[0].text).split('\n').slice(1).join('\n'));
  assert.equal(context.readingLanguage,'en');assert.equal(context.tripReceiptLanguageHint,'de');assert.equal(context.receiptLanguageOverride,null);
  const parsed=applyReceiptTranscription(trip,draft,result,undefined,{readingLanguage:'en'});
  assert.equal(parsed.detectedLanguage,'it');assert.equal(parsed.items[0].name,'Acqua frizzante');assert.equal(parsed.items[0].nameLanguage,'it');
  assert.equal(parsed.items[0].translations?.en?.text,'Sparkling water');assert.equal(parsed.items[0].translations?.en?.sourceText,'Acqua frizzante');
  assert.equal(parsed.items[0].scanSource?.observedText,'ACQUA FRIZZANTE 2,50');assert.equal(parsed.items[0].amount,250);assert.deepEqual(parsed.items[0].members,[]);
});
test('rescans preserve manual translations and canonical corrections and update accepted detected languages',()=>{
  const original=applyReceiptTranscription(trip,draft,transcription,undefined,{readingLanguage:'en'}),item=original.items[0];
  const corrected=editReadingName({...item,name:'My corrected name',fieldSources:{...item.fieldSources,name:'user' as const}},'en','My English name');
  const before={...original,items:[corrected]};const rescanned=applyReceiptTranscription(trip,before,{...transcription,items:[{...transcription.items[0],id:item.id}]},undefined,{readingLanguage:'en'});
  assert.equal(rescanned.items[0].name,'My corrected name');assert.equal(rescanned.items[0].translations?.en?.text,'My English name');assert.equal(rescanned.items[0].translations?.en?.sourceText,'Acqua frizzante');
  const changed=applyReceiptTranscription(trip,original,{...transcription,detectedLanguage:'fr',items:[{...transcription.items[0],id:item.id,name:'Eau gazeuse',nameLanguage:'fr'}]},undefined,{readingLanguage:'en'});
  assert.equal(changed.items[0].nameLanguage,'fr');assert.equal(changed.items[0].translations?.en?.sourceLanguage,'fr');
  assert.equal(mergeScannedNames(item,{...item,name:'Eau'},'fr','en','Water').nameLanguage,'fr');
});
test('edited reading names are user content and translations never alter money or invalidate financial review',()=>{
  const item:Item={id:'line',name:'Acqua',amount:250,members:['alice'],fieldSources:{name:'receipt' as const,amount:'receipt' as const}};
  const expense=expenseSchema.parse({...draft,date:'2026-10-05',time:'12:00',timezone:'Europe/Vienna',items:[item]});
  const bilingual={...expense,items:[setPairedTranslation(item,'en','Water','it')]};
  assert.deepEqual(shares(bilingual,trip.members),shares(expense,trip.members));assert.equal(receiptScanFingerprint(bilingual),receiptScanFingerprint(expense));
  const edited=editReadingName(bilingual.items[0],'en','Sparkling water');assert.notEqual(edited.translations!.en!.pairedText,edited.translations!.en!.text);
  assert.equal(blankReceiptItem({name:'',amount:0,translations:{en:{text:'Human entry'}}}),false);
  assert.equal(draftSchema.parse({...draft,items:[{...item,translations:bilingual.items[0].translations}]}).items[0].translations?.en?.text,'Water');
});
test('stable display keys survive posting, avoid delimiter collisions and default to English',()=>{
  assert.equal(defaultLanguagePreferences().readingLanguage,'en');
  assert.equal(itemDisplayKey({id:'draft',languageViewId:'original'},'line'),itemDisplayKey({id:'expense',languageViewId:'original'},'line'));
  assert.notEqual(itemDisplayKey({id:'a:b'},'c'),itemDisplayKey({id:'a'},'b:c'));
});
test('manual translations are one lean text-only request and same-language copies make none',async()=>{
  let calls=0;
  const fetcher:typeof fetch=async(_url,init)=>{calls++;const body=JSON.parse(init!.body as string);assert.equal(body.store,false);assert.equal(body.tools,undefined);assert.equal(body.input[0].content.length,1);assert.equal(body.input[0].content[0].type,'input_text');return completed({rows:[{id:'line',text:'Water',sourceLanguage:'it'}]});};
  const connection={accessToken:'synthetic',provider:'api' as const};
  const result=await processLanguageRequest({purpose:'items',tripId:trip.id,rows:[{id:'line',sourceText:'Acqua',targetLanguage:'en'}]},connection,{fetcher,tripLanguage:'de'});
  assert.deepEqual(result,{rows:[{id:'line',text:'Water',sourceLanguage:'it'}]});assert.equal(calls,1);
  await processLanguageRequest({purpose:'items',tripId:trip.id,rows:[{id:'copy',sourceText:'Water',sourceLanguage:'en',targetLanguage:'en'}]},connection,{fetcher});assert.equal(calls,1);
  await assert.rejects(processLanguageRequest({purpose:'items',tripId:trip.id,rows:[{id:'different',sourceText:'Acqua',targetLanguage:'en'}]},connection,{fetcher}),/incomplete item names/);
});
test('trip language suggestion returns only supported code or uncertainty',async()=>{
  const connection={accessToken:'synthetic',provider:'api' as const};
  assert.deepEqual(await processLanguageRequest({purpose:'trip-language',text:'Vienna'},connection,{fetcher:async()=>completed({language:'de'})}),{language:'de'});
  assert.deepEqual(await processLanguageRequest({purpose:'trip-language',text:'Our holiday'},connection,{fetcher:async()=>completed({language:null})}),{language:null});
});
test('native preferences are private, repeatedly editable, audited and preserved through account export',async()=>{
  const flow=await createReceiptFlowWorker();try{
    const get=()=>flow.browserRequest(`/api/trip-language?tripId=${flow.tripId}`);
    const update=(revision:number,change:Record<string,unknown>)=>flow.browserRequest('/api/trip-language',{method:'POST',body:JSON.stringify({accountId:flow.owner.id,tripId:flow.tripId,revision,...change})});
    const initial=await (await get()).json() as {preferences:unknown;revision:number;accountId:string};assert.deepEqual(initial.preferences,defaultLanguagePreferences());assert.equal(initial.revision,0);assert.equal(initial.accountId,flow.owner.id);
    assert.equal((await update(0,{readingLanguage:'fr'})).status,200);assert.equal((await update(1,{primaryVersion:'receipt'})).status,200);
    const key=itemDisplayKey({id:'expense'},'line');assert.equal((await update(2,{itemKey:key,itemVersion:'reading'})).status,200);
    assert.equal((await update(3,{itemKey:key,itemVersion:null})).status,200);assert.equal((await update(3,{readingLanguage:'de'})).status,409);
    const latest=await (await get()).json() as {preferences:ReturnType<typeof defaultLanguagePreferences>;revision:number};assert.equal(latest.revision,4);assert.deepEqual(latest.preferences,{readingLanguage:'fr',primaryVersion:'receipt',itemVersions:{}});
    assert.equal((await update(4,{readingLanguage:'fr'})).status,200);const history=await (await flow.browserRequest('/api/account-activity')).json() as {events:{entityType:string}[]};assert.equal(history.events.filter(event=>event.entityType==='language').length,4);
    const exported=await (await flow.browserRequest('/api/export?scope=account')).json() as {languagePreferences:unknown[]};assert.deepEqual(exported.languagePreferences,[{tripId:flow.tripId,preferences:latest.preferences}]);
    const shared=await (await flow.browserRequest(`/api/export?scope=trip&tripId=${flow.tripId}`)).json() as {languagePreferences?:unknown};assert.equal(shared.languagePreferences,undefined);
    assert.equal((await flow.browserRequest(`/api/trip-language?tripId=${flow.tripId}&userId=someone`)).status,400);
    assert.equal((await update(4,{accountId:'someone-else',readingLanguage:'de'})).status,409);
    assert.equal((await update(4,{readingLanguage:'invalid'})).status,400);assert.equal((await update(4,{itemKey:key})).status,400);
    assert.equal((await flow.worker.dispatchFetch(flow.origin+`/api/trip-language?tripId=${flow.tripId}`)).status,401);
    assert.equal((await flow.worker.dispatchFetch(flow.origin+'/api/trip-language',{method:'POST',headers:{cookie:`tt_session=${flow.sessionToken}`,origin:'https://evil.test','content-type':'application/json'},body:JSON.stringify({accountId:flow.owner.id,tripId:flow.tripId,revision:4,readingLanguage:'de'})})).status,403);
    await flow.db.batch([
      flow.db.prepare('INSERT INTO profiles(id,email,display_name,created_at) VALUES(?,?,?,?)').bind('second-traveller','second@example.test','Bob',new Date().toISOString()),
      flow.db.prepare('INSERT INTO memberships(trip_id,user_id,member_id) VALUES(?,?,?)').bind(flow.tripId,'second-traveller','bob'),
    ]);
    const second=async(path:string,body?:unknown)=>flow.worker.dispatchFetch(flow.origin+path,{method:body?'POST':'GET',headers:{'oai-authenticated-user-id':'second-traveller','oai-authenticated-user-email':'second@example.test',origin:flow.origin,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    const other=await second(`/api/trip-language?tripId=${flow.tripId}`);assert.equal(other.status,200);assert.deepEqual((await other.json() as {preferences:unknown}).preferences,defaultLanguagePreferences());
    assert.equal((await second('/api/trip-language',{accountId:'second-traveller',tripId:flow.tripId,revision:0,readingLanguage:'de'})).status,200);
    assert.equal((await (await get()).json() as {preferences:{readingLanguage:string}}).preferences.readingLanguage,'fr');
    await flow.db.prepare('DELETE FROM memberships WHERE user_id=?').bind('second-traveller').run();
    assert.equal((await second(`/api/trip-language?tripId=${flow.tripId}`)).status,404);
    assert.equal((await second('/api/trip-language',{accountId:'second-traveller',tripId:flow.tripId,revision:1,readingLanguage:'it'})).status,404);
  }finally{await flow.dispose();}
});
test('native same-language refresh uses no model credentials and checks holiday access',async()=>{
  const flow=await createReceiptFlowWorker();try{
    const body={purpose:'items',accountId:flow.owner.id,tripId:flow.tripId,rows:[{id:'line',sourceText:'Water',sourceLanguage:'en',targetLanguage:'en'}]};
    const response=await flow.browserRequest('/api/receipt/translate',{method:'POST',body:JSON.stringify(body)});assert.equal(response.status,200);
    assert.deepEqual((await response.json() as {rows:unknown[]}).rows,[{id:'line',text:'Water',sourceLanguage:'en'}]);
    assert.equal((await flow.browserRequest('/api/receipt/translate',{method:'POST',body:JSON.stringify({...body,tripId:'someone-elses-trip'})})).status,404);
    assert.equal((await flow.browserRequest('/api/receipt/translate',{method:'POST',body:JSON.stringify({...body,rows:[...body.rows,...body.rows]})})).status,400);
  }finally{await flow.dispose();}
});

test('connected ChatGPT reads private reading preferences and preserves user translations during receipt recognition',async()=>{
  const flow=await createReceiptFlowWorker();try{
    await flow.browserRequest('/api/trip-language',{method:'POST',body:JSON.stringify({accountId:flow.owner.id,tripId:flow.tripId,revision:0,readingLanguage:'fr'})});
    const snapshot=await flow.readLedger();
    const item={id:'language-line',name:'Acqua',nameLanguage:'it',amount:250,members:['alice'],translations:{fr:{text:'Eau corrigée',sourceText:'Acqua',pairedText:'Eau',sourceLanguage:'it',provenance:'user'}}};
    const draft={id:'language-draft',title:'Restaurant',currency:'GBP',payer:'alice',items:[item],tax:0,tip:0,discount:0,status:'waiting',fieldSources:{title:'default'}};
    const saved=await flow.browserRequest('/api/ledger',{method:'POST',body:JSON.stringify({revision:snapshot.revision,data:{trips:snapshot.data.trips.map(trip=>({...trip,drafts:[draft]}))}})});assert.equal(saved.status,200);
    const current=await flow.readLedger();
    const context=await flow.toolCall('get_receipt_context',{tripId:flow.tripId,draftId:draft.id});assert.equal(context.result?.isError,undefined);
    assert.equal(JSON.parse(context.result!.content![0].text!).readingLanguage,'fr');
    const recognized=await flow.toolCall('update_receipt_draft',{trip_id:flow.tripId,revision:current.revision,draft:{id:draft.id,detectedLanguage:'it',upsertItems:[{id:item.id,name:'Acqua',nameLanguage:'it',translations:{fr:{text:'Eau',sourceText:'Acqua',pairedText:'Eau',sourceLanguage:'it',provenance:'ai'}}}],receiptScan:{version:1,printedTotal:250,printedCurrency:'GBP',warnings:[]}}});
    assert.equal(recognized.result?.isError,undefined,recognized.result?.content?.[0]?.text);
    const after=(await flow.readLedger()).data.trips[0].drafts[0];assert.equal(after.detectedLanguage,'it');assert.equal(after.items[0].translations?.fr?.text,'Eau corrigée');assert.equal(after.items[0].translations?.fr?.provenance,'user');
  }finally{await flow.dispose();}
});
