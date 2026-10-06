import assert from 'node:assert/strict';
import test from 'node:test';
import { applyReceiptQuestion, processReceiptQuestion } from '../lib/receipt-assistant';
import { applyReceiptChanges, type ReceiptChanges } from '../lib/receipt-proposals';
import { applyReceiptTranscription, receiptContext, type ReceiptTranscription } from '../lib/receipt-ai';
import { draftSchema, total, type Draft, type Trip } from '../lib/model';
import { receiptLocationHintSchema, receiptLocationSchema } from '../lib/receipt-location';

const trip: Trip = { id:'holiday',name:'Bratislava holiday',currency:'GBP',ownerId:'account',
  members:[{id:'chris',name:'Christopher Dennett',userId:'account',email:'private@example.test'},{id:'gary',name:'Gareth'}],expenses:[],payments:[],drafts:[] };
const base: Draft = { id:'draft',title:'Café',currency:'EUR',payer:'chris',tax:0,tip:0,discount:0,status:'waiting',source:'manual',items:[],
  conversation:[{id:'guidance',role:'user',text:'In Bratislava. Gaz bought a decaf, I bought a capp. Both had two croissants.',authorMemberId:'chris',authorName:'Chris',createdAt:'2026-10-06T10:00:00Z'}],
  memory:{notes:'Gareth is sometimes called Gary or Gaz.',aliases:[]} };
const empty = (): ReceiptChanges => ({ metadata:null,items:[],removeItemIds:[],clear:[],remember:null,aliases:[] });
const metadata = () => ({ title:null,currency:null,date:null,time:null,timezone:null,payer:null,receiptLanguage:null,location:null,tax:null,tip:null,discount:null,bankAmount:null,fx:null,percentages:null });
const patch = (id:string|null,itemIndex:number|null): ReceiptChanges['items'][number] => ({id,itemIndex,name:null,amount:null,members:null,units:null,percentages:null});
const scan: ReceiptTranscription = { title:'Cafe',currency:'EUR',tax:0,tip:0,discount:0,printedTotal:1600,date:null,time:null,summary:'Read three printed lines.',location:'Bratislava',locationSource:'receipt',items:[
  {id:null,name:'Decaf',amount:400},{id:null,name:'Cappuccino',amount:400},{id:null,name:'Croissant',amount:800,quantity:{total:4,label:'pieces',sourceText:'4 x Croissant'}}] };
const guidance = (): ReceiptChanges => ({...empty(),items:[{...patch(null,0),members:['gary']},{...patch(null,1),members:['chris']},
  {...patch(null,2),units:{total:4,label:'croissants',allocations:[{memberId:'chris',value:2},{memberId:'gary',value:2}]}}]});
const saved = (): Draft => applyReceiptTranscription(trip,base,{...scan,changes:guidance()});
const sse = (value:unknown) => new Response(`data: ${JSON.stringify({type:'response.completed',response:{status:'completed',error:null,output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(value)}]}]}})}\n\n`,{headers:{'content-type':'text/event-stream'}});

test('one scan may apply explicit saved guidance without multiplying printed prices or posting an expense',()=>{
  const original=structuredClone(base),result=saved();
  assert.deepEqual(base,original); assert.equal(total(result),1600); assert.equal(result.status,'review'); assert.equal(trip.expenses.length,0);
  assert.deepEqual(result.items.map(item=>item.members),[['gary'],['chris'],['chris','gary']]);
  assert.deepEqual(result.items[2].units,{total:4,label:'croissants',allocations:{chris:2,gary:2}});
  assert.equal(result.items[2].amount,800); assert.deepEqual(result.location,{label:'Bratislava',source:'receipt'});
});

test('photo-only reading leaves all personal consumption unassigned and preserves printed quantities',()=>{
  const result=applyReceiptTranscription(trip,{...base,conversation:[]},{...scan,changes:null});
  assert(result.items.every(item=>item.members.length===0));
  assert.deepEqual(result.items[2].units?.allocations,{}); assert.equal(result.items[2].quantity?.total,4);
});

test('unknown or inactive authors cannot turn scan guidance into financial shares',()=>{
  for(const author of [undefined,'removed-traveller']) {
    const result=applyReceiptTranscription(trip,{...base,conversation:base.conversation!.map(message=>({...message,authorMemberId:author}))},{...scan,changes:guidance()});
    assert(result.items.every(item=>item.members.length===0)); assert.match(result.conversation!.at(-1)!.text,/Clarify who is speaking/);
  }
});

test('recognition protects existing line allocations and receipt-wide percentages',()=>{
  const old=saved(); old.items[0].members=['chris'];
  const result=applyReceiptTranscription(trip,old,{...scan,items:scan.items.map((item,index)=>({...item,id:old.items[index].id})),changes:guidance()});
  assert.deepEqual(result.items[0].members,['chris']); assert.deepEqual(result.items[2].units,old.items[2].units);
  const global=applyReceiptTranscription(trip,{...base,percentages:{chris:75,gary:25}},{...scan,changes:guidance()});
  assert.deepEqual(global.percentages,{chris:75,gary:25}); assert(global.items.every(item=>item.members.length===0));
});

test('consumption that disagrees with purchased count leaves affected shares unchanged and asks for review',()=>{
  const changes=guidance(); changes.items[2].units!.total=2; changes.items[2].units!.allocations=[{memberId:'chris',value:1},{memberId:'gary',value:1}];
  const result=applyReceiptTranscription(trip,base,{...scan,changes});
  assert.deepEqual(result.items[2].members,[]); assert.deepEqual(result.items[2].units?.allocations,{});
  assert.equal(result.items[2].quantity?.total,4); assert.match(result.conversation!.at(-1)!.text,/quantities differ from the receipt/);
});

test('saved manual and chat locations survive a rescan, while missing receipt location is inferred',()=>{
  for(const source of ['user','chat'] as const) {
    const original={...base,location:{label:'Vienna, Italian restaurant',source},fieldSources:source==='user'?{location:'user' as const}:undefined};
    assert.deepEqual(applyReceiptTranscription(trip,original,scan).location,original.location);
  }
  assert.deepEqual(applyReceiptTranscription(trip,base,{...scan,locationSource:'context'}).location,{label:'Bratislava',source:'chat'});
});

test('native item question sends a single text-only strict request with trusted author, names and shared aliases',async()=>{
  const receipt=saved(),item=receipt.items[2];
  receipt.conversation!.push({id:'question',role:'user',text:'Give me one and Gaz three; this was in Bratislava.',authorMemberId:'gary',authorName:'Gary',itemId:item.id,createdAt:'2026-10-06T11:00:00Z'});
  receipt.memory!.aliases.push({name:'me',memberId:'gary',scopeMemberId:'gary'},{name:'cap',itemId:receipt.items[1].id});
  const sharedTrip={...trip,drafts:[{...base,id:'other',memory:{notes:'',aliases:[{name:'Gaz',memberId:'gary'}]}}]};
  let calls=0;
  const result=await processReceiptQuestion({accessToken:'fake-key',provider:'api',trip:sharedTrip,draft:receipt,callerMemberId:'chris',questionId:'question'}, {fetcher:async(url,init)=>{
    calls++; assert.equal(String(url),'https://api.openai.com/v1/responses'); const body=JSON.parse(init!.body as string);
    assert.equal(body.store,false); assert.equal(body.tools,undefined); assert.equal(body.previous_response_id,undefined);
    assert.equal(body.text.format.strict,true); assert.equal(body.input[0].content.length,1); assert.equal(body.input[0].content[0].type,'input_text');
    assert.doesNotMatch(JSON.stringify(body),/input_image|private@example|fake-key/);
    const context=JSON.parse(body.input[0].content[0].text);
    assert.equal(context.callerMemberId,'chris'); assert.equal(context.speakerMemberId,'gary'); assert.equal(context.questionItemId,item.id);
    assert.deepEqual(context.members,trip.members.map(({id,name})=>({id,name})));
    assert(context.travellerAliases.some((alias:{name:string})=>alias.name==='Gaz')); assert.match(context.nameResolution,/loose nicknames/i);
    assert.equal(context.receipt.memory.aliases[0].appliesToSpeaker,true); assert.deepEqual(context.receipt.items[2].units.allocations,{chris:2,gary:2});
    assert.match(body.instructions,/never the caller/); assert.match(body.instructions,/never multiply prices/i);
    return sse({summary:'Propose the clarified shares.',changes:{...empty(),items:[{...patch(item.id,null),units:{total:4,label:'croissants',allocations:[{memberId:'gary',value:1},{memberId:'chris',value:3}]}}]}});
  }});
  assert.equal(calls,1); const applied=applyReceiptQuestion(sharedTrip,receipt,result,'question');
  assert.deepEqual(applied.items[2].units?.allocations,{gary:1,chris:3}); assert.equal(applied.items[2].id,item.id); assert.equal(applied.items[2].amount,800);
  assert.deepEqual(applied.items.slice(0,2),receipt.items.slice(0,2)); assert.equal(applied.conversation!.at(-1)!.itemId,item.id);
  assert.equal(applied.conversation!.at(-1)!.replyTo,'question'); assert.equal(applied.conversation!.at(-1)!.authorMemberId,undefined);
  assert.equal(applied.status,'review'); assert.equal(sharedTrip.expenses.length,0);
  assert.strictEqual(applyReceiptQuestion(sharedTrip,applied,result,'question'),applied,'a saved reply is idempotent');
});

test('selected unknown author is not replaced by caller or an earlier known speaker',()=>{
  const receipt=saved(); receipt.conversation!.push({id:'unknown',role:'user',text:'Give me all of these.',itemId:receipt.items[0].id,createdAt:'2026-10-06T12:00:00Z'});
  assert.equal(receiptContext(trip,receipt,'chris','unknown').speakerMemberId,null);
  assert.throws(()=>applyReceiptQuestion(trip,receipt,{summary:'Proposed shares',changes:{...empty(),items:[{...patch(receipt.items[0].id,null),members:['chris']}]}} ,'unknown'),/need clarification/);
});

test('text proposals permit receipt-level context from an item thread and explicit removals only',()=>{
  const receipt=saved(),before=structuredClone(receipt); const changes={...empty(),metadata:{...metadata(),location:'Vienna',receiptLanguage:'it' as const},remember:'Pizza here is sold by the slice.',items:[{...patch(receipt.items[0].id,null),name:'Decaffeinated coffee'}]};
  const result=applyReceiptChanges(trip,receipt,changes,{questionId:'guidance'}).draft;
  assert.equal(result.items.length,3); assert.deepEqual(result.items.slice(1),receipt.items.slice(1)); assert.deepEqual(result.location,{label:'Vienna',source:'chat'});
  assert.equal(result.receiptLanguage,'it'); assert.match(result.memory!.notes,/sold by the slice/); assert.deepEqual(receipt,before);
  const removed=applyReceiptChanges(trip,receipt,{...empty(),removeItemIds:[receipt.items[0].id]},{questionId:'guidance'}).draft;
  assert.deepEqual(removed.items.map(item=>item.id),receipt.items.slice(1).map(item=>item.id));
});

test('invalid references, duplicate shares, over/under allocations and implicit additions are rejected atomically',()=>{
  const receipt=saved(),id=receipt.items[2].id,before=structuredClone(receipt);
  const invalid:ReceiptChanges[]=[
    {...empty(),items:[{...patch('unknown',null),members:['chris']}]},
    {...empty(),items:[{...patch(id,null),members:['missing']}]},
    {...empty(),items:[{...patch(id,null),percentages:[{memberId:'chris',value:75},{memberId:'gary',value:20}]}]},
    {...empty(),items:[{...patch(id,null),percentages:[{memberId:'chris',value:50},{memberId:'chris',value:50}]}]},
    {...empty(),items:[{...patch(id,null),units:{total:4,label:null,allocations:[{memberId:'chris',value:3}]}}]},
    {...empty(),items:[{...patch(id,null),units:{total:4,label:null,allocations:[{memberId:'chris',value:5}]}}]},
    {...empty(),items:[{...patch(null,null)}]},
    {...empty(),removeItemIds:['not-an-item']},
    {...empty(),aliases:[{name:'Gaz',memberId:'missing',itemId:null,scopeMemberId:null}]},
  ];
  for(const [index,changes] of invalid.entries()){assert.throws(()=>applyReceiptChanges(trip,receipt,changes,{questionId:'guidance'}),`invalid proposal ${index}`);assert.deepEqual(receipt,before);}
});

test('receipt place metadata remains optional for legacy drafts and validates bounded device hints',()=>{
  assert.equal(draftSchema.parse({...base,conversation:[]}).location,undefined);
  assert.deepEqual(receiptLocationSchema.parse({label:' Bratislava '}),{label:'Bratislava',source:'user'});
  const hint={latitude:48.1486,longitude:17.1077,accuracy:100,capturedAt:'2026-10-06T10:00:00Z'};
  assert.deepEqual(receiptLocationHintSchema.parse(hint),hint);
  for(const invalid of [{...hint,latitude:91},{...hint,longitude:-181},{...hint,accuracy:-1},{...hint,capturedAt:'yesterday'}])assert.equal(receiptLocationHintSchema.safeParse(invalid).success,false);
  for(const label of ['', ' '.repeat(2),'x'.repeat(301)])assert.equal(receiptLocationSchema.safeParse({label}).success,false);
});

test('personal aliases are scoped to the selected trusted author, and ambiguous shared aliases retain both candidates',()=>{
  const receipt=saved(); receipt.conversation!.push({id:'gary-question',role:'user',text:'Remember this is mine.',authorMemberId:'gary',createdAt:'2026-10-06T12:00:00Z'});
  const alias={name:'me',memberId:'gary',itemId:null,scopeMemberId:'gary'};
  const updated=applyReceiptChanges(trip,receipt,{...empty(),aliases:[alias]},{questionId:'gary-question'}).draft;
  assert.deepEqual(updated.memory!.aliases.at(-1),{name:'me',memberId:'gary',scopeMemberId:'gary'});
  for(const wrong of [{...alias,scopeMemberId:null},{...alias,scopeMemberId:'chris'},{...alias,memberId:'chris'}])assert.throws(()=>applyReceiptChanges(trip,receipt,{...empty(),aliases:[wrong]},{questionId:'gary-question'}));
  const ambiguous={...receipt,memory:{notes:'',aliases:[{name:'G',memberId:'chris'},{name:'g',memberId:'gary'}]}};
  assert(receiptContext(trip,ambiguous,'chris','gary-question').receipt.memory.aliases.every(value=>value.ambiguous));
});

test('currency corrections clear stale conversion but retain explicitly supplied new bank amount and rate',()=>{
  const receipt={...saved(),fx:{rate:0.86,asOf:'2026-10-06',source:'manual' as const},bankAmount:1376};
  const changed=applyReceiptChanges(trip,receipt,{...empty(),metadata:{...metadata(),currency:'CHF'}},{questionId:'guidance'}).draft;
  assert.equal(changed.currency,'CHF');assert.equal(changed.fx,undefined);assert.equal(changed.bankAmount,undefined);
  const explicit=applyReceiptChanges(trip,receipt,{...empty(),metadata:{...metadata(),currency:'CHF',fx:{rate:0.9,asOf:'2026-10-06',source:'manual'},bankAmount:1440}},{questionId:'guidance'}).draft;
  assert.deepEqual(explicit.fx,{rate:0.9,asOf:'2026-10-06',source:'manual'});assert.equal(explicit.bankAmount,1440);
});

test('receipt percentages require a complete 100% allocation and unknown speakers cannot clear financial metadata',()=>{
  const receipt=saved();
  assert.throws(()=>applyReceiptChanges(trip,receipt,{...empty(),metadata:{...metadata(),percentages:[{memberId:'chris',value:40},{memberId:'gary',value:50}]}},{questionId:'guidance'}));
  const updated=applyReceiptChanges(trip,receipt,{...empty(),metadata:{...metadata(),percentages:[{memberId:'chris',value:40},{memberId:'gary',value:60}]}},{questionId:'guidance'}).draft;
  assert.deepEqual(updated.percentages,{chris:40,gary:60});
  const unknown={...updated,conversation:[{id:'unknown',role:'user' as const,text:'Clear the split',createdAt:'2026-10-06T12:00:00Z'}]};
  assert.throws(()=>applyReceiptChanges(trip,unknown,{...empty(),clear:['percentages']},{questionId:'unknown'}));
});

test('text edits retain printed evidence, reject fabricated reference rates and permit explicit new lines',()=>{
  const receipt=saved(); receipt.receiptScan!.acknowledgement={fingerprint:'scan-v1:'+'a'.repeat(64)};
  const evidence=structuredClone(receipt.receiptScan!);
  const proposal=applyReceiptChanges(trip,receipt,{...empty(),items:[{...patch(null,null),name:'Manually added water',amount:300,members:['gary']}]},{questionId:'guidance'}).draft;
  assert.equal(proposal.items.length,4);assert.equal(proposal.items[3].amount,300);assert.equal(proposal.items[3].name,'Manually added water');
  assert.notEqual(proposal.items[3].id,receipt.items[0].id);
  assert.equal(proposal.receiptScan?.printedTotal,evidence.printedTotal);assert.deepEqual(proposal.receiptScan?.sourceLines,evidence.sourceLines);
  assert(proposal.receiptScan?.warnings.some(warning=>warning.code==='total-mismatch'));
  assert.throws(()=>applyReceiptChanges(trip,receipt,{...empty(),metadata:{...metadata(),fx:{rate:0.86,source:'reference',asOf:'2026-10-06'}}},{questionId:'guidance'}),/explicitly supplied manual/);
  assert.throws(()=>applyReceiptChanges(trip,receipt,{...empty(),receiptScan:{acknowledgement:{fingerprint:'fabricated'}}} as ReceiptChanges,{questionId:'guidance'}));
});
