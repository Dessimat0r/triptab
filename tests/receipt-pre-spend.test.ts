import test from 'node:test';
import assert from 'node:assert/strict';
import {createReceiptOperationWorker} from './helpers/receipt-operation-worker';
import { processReceiptImage } from '../lib/receipt-ai';
import { processReceiptQuestion } from '../lib/receipt-assistant';
import { draftSchema, tripSchema } from '../lib/model';

for(const cutoff of ['unlink','grant-expiry','logout','account-deleted','key-removed','source-edited'] as const)test(`Independent pre-spend race: ${cutoff} while quota is prepared must prevent the first provider call`,async()=>{
 const f=await createReceiptOperationWorker();
 try{
  const account=await f.createAccount({id:'pre-spend-legacy',email:'pre-spend@example.test',name:'Legacy',password:true,link:{providerId:'pre-spend-legacy'},session:true});
  const identity=cutoff==='logout'?{sessionToken:account.sessionToken}:{provider:{id:'pre-spend-legacy',email:'pre-spend@example.test'}};
  const reading=await f.seedReading(identity,'pre-spend-trip');
  await f.control('/__test/hooks',{pauseBeforeSpend:true,releaseSpend:false});
  const pending=reading.process();await f.waitFor(async()=>(await f.control('/__test/hooks')).atSpend===true,'quota step immediately before the provider call');
  assert.equal((await f.control('/__test/provider')).calls,0);
  if(cutoff==='unlink'){
   const revoked=await f.requestAs({sessionToken:account.sessionToken},'/api/auth',{method:'POST',body:JSON.stringify({action:'unlink_chatgpt'})});assert.equal(revoked.status,200);
   assert.equal((await f.requestAs(identity,'/api/ledger')).status,401);
  }else if(cutoff==='grant-expiry'){
   // The grant expires after inference has been admitted, but before any inference request.
   const deadline=Date.now()+500;await f.database.prepare('UPDATE receipt_operations SET grant_expires_at=? WHERE trip_id=?').bind(deadline,'pre-spend-trip').run();
   await new Promise(r=>setTimeout(r,Math.max(0,deadline-Date.now())+100));
  }else if(cutoff==='logout'){
   assert.equal((await f.requestAs(account,'/api/auth',{method:'POST',body:JSON.stringify({action:'logout'})})).status,200);
  }else if(cutoff==='account-deleted'){
   await f.database.prepare('UPDATE profiles SET deleted_at=? WHERE id=?').bind(new Date().toISOString(),'pre-spend-legacy').run();
  }else if(cutoff==='key-removed'){
   await f.database.prepare("UPDATE receipt_ai_settings SET api_key_encrypted=NULL,version=version+1 WHERE id='shared'").run();
  }else{
   const snapshot=await reading.read();snapshot.data.trips.find(trip=>trip.id==='pre-spend-trip')!.drafts[0].title='My new title';
   assert.equal((await f.requestAs(identity,'/api/ledger',{method:'POST',body:JSON.stringify(snapshot)})).status,200);
  }
  const before=await reading.trip(),history=await reading.history();
  await f.control('/__test/hooks',{releaseSpend:true});
  const response=await pending,calls=(await f.control('/__test/provider')).calls;
  console.log('INDEPENDENT pre-spend revocation',JSON.stringify({cutoff,status:response.status,calls,historyDelta:await reading.history()-history}));
  assert.deepEqual(await reading.trip(),before);assert.equal(await reading.history(),history,'the final commit fence still protects persistence');
  assert.equal(calls,0,'a revoked or expired grant must not send a receipt to the provider for the first time');
  assert.equal((await f.operations())[0].status,'failed');
  assert.equal((await f.tick(Date.now()+1_000_000)).resumed,0,'a terminal refusal must not become an automatic paid retry');
 }finally{await f.control('/__test/hooks',{releaseSpend:true}).catch(()=>{});await f.dispose();}
});

test('N04: leaving the bill during quota preparation prevents receipt disclosure to the provider',async()=>{
 const f=await createReceiptOperationWorker();
 try{
  const bob=await f.createAccount({id:'leaving-reader',email:'reader@example.test',name:'Bob',session:true});
  await f.database.prepare('INSERT INTO memberships(trip_id,user_id,member_id) VALUES(?,?,?)').bind(f.tripId,'leaving-reader','bob').run();
  await f.control('/__test/hooks',{pauseBeforeSpend:true,releaseSpend:false});
  const pending=f.requestAs(bob,'/api/receipt/process',{method:'POST',body:await f.processBody()});
  await f.waitFor(async()=>(await f.control('/__test/hooks')).atSpend===true,'quota preparation');
  assert.equal((await f.requestAs(bob,'/api/trip',{method:'POST',body:JSON.stringify({action:'leave',tripId:f.tripId})})).status,200);
  const before=await f.tripRow(),history=await f.historyCount();
  await f.control('/__test/hooks',{releaseSpend:true});
  assert.notEqual((await pending).status,200);
  assert.equal((await f.control('/__test/provider')).calls,0);
  assert.deepEqual(await f.tripRow(),before);assert.equal(await f.historyCount(),history);
 }finally{await f.dispose();}
});

for(const kind of ['image','question'] as const)test(`N04: ${kind} rechecks after asynchronous ChatGPT model discovery, preserving the terminal error`,async()=>{
 const trip=tripSchema.parse({id:'model-trip',name:'Trip',currency:'GBP',members:[{id:'me',name:'Me'}],expenses:[],drafts:[],payments:[]});
 const draft=draftSchema.parse({id:'model-draft',title:'Receipt',currency:'GBP',payer:'me',status:'waiting',items:[],tax:0,tip:0,discount:0,
  conversation:[{id:'question',role:'user',text:'Explain the discount',createdAt:'2026-11-07T12:00:00.000Z'}]});
 const refusal=new Error('test-terminal-authorization-ended');let active=true,models=0,inference=0,checks=0;
 const fetcher=(async(input:RequestInfo|URL)=>{
  if(String(input).endsWith('/models')){models++;active=false;return Response.json({data:[{id:'plan-model'}]});}
  inference++;throw new Error('The revoked operation must never reach inference');
 }) as typeof fetch;
 const beforeRequest=async()=>{checks++;if(!active)throw refusal;};
 const context={accessToken:'mock-token',provider:'siwc' as const,trip,draft,callerMemberId:'me'};
 await assert.rejects(kind==='image'
  ?processReceiptImage({...context,image:{bytes:new Uint8Array([1,2,3]),mimeType:'image/png'}},{fetcher,beforeRequest})
  :processReceiptQuestion({...context,questionId:'question'},{fetcher,beforeRequest}),error=>error===refusal);
 assert.equal(models,1);assert.equal(inference,0);assert.equal(checks,2);
});
