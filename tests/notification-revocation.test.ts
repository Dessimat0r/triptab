import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { storage, type SQLiteD1, type SQLiteStatement } from './helpers/sqlite-d1';
import { ModuleKind, ScriptTarget } from 'typescript';
import { leaveTrip } from '../lib/trip-lifecycle';
import { transpileWithSharedImports } from './helpers/transpile';
const asModule=(source:string)=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const source=await readFile(new URL('../lib/notifications.ts',import.meta.url),'utf8');
const fixture={database:null as SQLiteD1 | null,pending:[] as Promise<unknown>[],paused:false,release:false,pause:false};
Object.assign(globalThis,{__triptabIndependentNotification:fixture});
const envModule=asModule("const f=globalThis.__triptabIndependentNotification; export const env={}; export const waitUntil=p=>f.pending.push(p);");
const storeModule=asModule("export const db=()=>globalThis.__triptabIndependentNotification.database; export class RequestError extends Error{};");
const code=transpileWithSharedImports(source,{compilerOptions:{module:ModuleKind.ESNext,target:ScriptTarget.ES2022},sharedImportOverrides:{'cloudflare:workers':envModule,'./store':storeModule}}).outputText;
const notifications=await import(asModule(code)) as typeof import('../lib/notifications');
async function seed(){
 const database=await storage(), now=new Date().toISOString();
 database.sqlite.prepare('INSERT INTO profiles(id,email,display_name,created_at) VALUES(?,?,?,?)').run('alice','alice@example.test','Alice',now);
 database.sqlite.prepare('INSERT INTO profiles(id,email,display_name,created_at) VALUES(?,?,?,?)').run('bob','bob@example.test','Bob',now);
 const trip={id:'secret',name:'Secret treatment visit',currency:'GBP',members:[{id:'a',name:'Alice'},{id:'b',name:'Bob'}],expenses:[],payments:[],drafts:[]};
 database.sqlite.prepare('INSERT INTO trips(id,owner,data) VALUES(?,?,?)').run(trip.id,'alice',JSON.stringify(trip));
 database.sqlite.prepare('INSERT INTO memberships(trip_id,user_id,member_id) VALUES(?,?,?)').run(trip.id,'alice','a');
 database.sqlite.prepare('INSERT INTO memberships(trip_id,user_id,member_id) VALUES(?,?,?)').run(trip.id,'bob','b');
 fixture.pending=[];fixture.paused=false;fixture.release=false;fixture.pause=false;
 fixture.database=new Proxy(database,{get(target,key){
  if(key==='batch')return async(statements:SQLiteStatement[])=>{
   if(fixture.pause&&statements.some(statement=>/INSERT INTO (notifications|notification_digests)/.test(statement.sql))){
    fixture.paused=true;while(!fixture.release)await new Promise(resolve=>setTimeout(resolve,2));
   }
   return target.batch(statements);
  };
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 return database;
}
async function atNotification(){
 await notifications.notifyMembers('secret','alice','Secret treatment visit','Alice added private receipt Oncology consultation in Secret treatment visit.');
 const until=Date.now()+3000;while(!fixture.paused&&Date.now()<until)await new Promise(r=>setTimeout(r,2));
 assert(fixture.paused,'notification paused after recipient and preference reads, before inbox write');
}
test('Independent notification control: a current authorised member receives the expected notice',async()=>{
 const db=await seed(); await notifications.notifyMembers('secret','alice','Secret treatment visit','Private receipt'); await Promise.all(fixture.pending);
 assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id='bob'").get()!.n,1);
});
test('Independent notification privacy: leaving during async delivery must prevent a new private inbox entry',async()=>{
 const db=await seed();fixture.pause=true;
 try{
  await atNotification();
  await leaveTrip(db.asD1(),{id:'bob',displayName:'Bob'},'secret');
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM memberships WHERE user_id='bob'").get()!.n,0);
  fixture.release=true;await Promise.all(fixture.pending);
  const stored=db.sqlite.prepare("SELECT title,body FROM notifications WHERE user_id='bob'").all();
  console.log('INDEPENDENT notification after actual leave',JSON.stringify(stored));
  assert.deepEqual(stored,[],'a revoked member must not receive a new private receipt/trip label');
 }finally{fixture.release=true;await Promise.allSettled(fixture.pending);}
});
test('Independent notification preferences: disabling notifications during delivery must prevent the write',async()=>{
 const db=await seed();fixture.pause=true;
 try{
  await atNotification();
  db.sqlite.prepare("INSERT INTO notification_preferences(user_id,scope,delivery,reminders) VALUES('bob','none','none',0)").run();
  fixture.release=true;await Promise.all(fixture.pending);
  const stored=db.sqlite.prepare("SELECT title,body FROM notifications WHERE user_id='bob'").all();
  console.log('INDEPENDENT notification after disable',JSON.stringify(stored));
  assert.deepEqual(stored,[],'scope none must be checked in the final inbox write');
 }finally{fixture.release=true;await Promise.allSettled(fixture.pending);}
});

for(const delivery of ['immediate','daily'] as const)for(const cutoff of ['membership','account','bill','scope','involved'] as const)test(`N01: ${delivery} notification checks ${cutoff} in its final write`,async()=>{
 const db=await seed();
 db.sqlite.prepare('INSERT INTO notification_preferences(user_id,scope,delivery,reminders) VALUES(?,?,?,0)').run('bob','all',delivery);
 fixture.pause=true;
 try{
  const pending=notifications.notifyMembers('secret','alice','Private bill','Private receipt',['a']);
  await pending;
  const until=Date.now()+3000;while(!fixture.paused&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,2));
  assert(fixture.paused,'delivery reached its final write after eligibility reads');
  if(cutoff==='membership')db.sqlite.prepare("DELETE FROM memberships WHERE user_id='bob'").run();
  if(cutoff==='account')db.sqlite.prepare("UPDATE profiles SET deleted_at=? WHERE id='bob'").run(new Date().toISOString());
  if(cutoff==='bill')db.sqlite.prepare("UPDATE trips SET owner='deleted:alice' WHERE id='secret'").run();
  if(cutoff==='scope')db.sqlite.prepare("UPDATE notification_preferences SET scope='none' WHERE user_id='bob'").run();
  if(cutoff==='involved')db.sqlite.prepare("UPDATE notification_preferences SET scope='involved' WHERE user_id='bob'").run();
  fixture.release=true;await Promise.all(fixture.pending);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id='bob'").get()!.n,0);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM notification_digests WHERE user_id='bob'").get()!.n,0);
 }finally{fixture.release=true;await Promise.allSettled(fixture.pending);}
});

test('N01: an authorised legacy owner without a membership still receives their own receipt reply',async()=>{
 const db=await seed();db.sqlite.prepare("DELETE FROM memberships WHERE user_id='alice'").run();
 await notifications.notifyReceiptReply('secret','alice');await Promise.all(fixture.pending);
 assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id='alice'").get()!.n,1);
});
