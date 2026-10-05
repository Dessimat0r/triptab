import assert from 'node:assert/strict';
import { readFile,readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ModuleKind,ScriptTarget } from 'typescript';
import { transpileWithSharedImports } from './helpers/transpile';
import { readAccountActivity } from '../lib/audit';
class Statement{
  private values:(string|number|null)[]=[];
  constructor(readonly sqlite:DatabaseSync,readonly sql:string){}
  bind(...values:(string|number|null)[]){this.values=values;return this;}
  async first<T>(){return (this.sqlite.prepare(this.sql).get(...this.values)??null) as T|null;}
  async all<T>(){return {results:this.sqlite.prepare(this.sql).all(...this.values) as T[]};}
  runSync(){const statement=this.sqlite.prepare(this.sql),results=statement.columns().length?statement.all(...this.values):(statement.run(...this.values),[]);return {results,meta:{changes:Number(this.sqlite.prepare('SELECT changes() AS count').get()!.count)}};}
}
class Database{
  readonly sqlite=new DatabaseSync(':memory:');beforeBatch?:()=>void;
  prepare(sql:string){return new Statement(this.sqlite,sql);}
  async batch(statements:Statement[]){this.beforeBatch?.();this.beforeBatch=undefined;this.sqlite.exec('BEGIN');try{const result=statements.map(statement=>statement.runSync());this.sqlite.exec('COMMIT');return result;}catch(error){this.sqlite.exec('ROLLBACK');throw error;}}
  asD1(){return this as unknown as D1Database;}
}
const dataURL=(source:string)=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const boundary=dataURL('export class RequestError extends Error {constructor(message,status=400){super(message);this.status=status;}}');
const compiled=transpileWithSharedImports(await readFile(new URL('../lib/trip-language-preferences.ts',import.meta.url),'utf8'),{compilerOptions:{module:ModuleKind.ESNext,target:ScriptTarget.ES2022},sharedImportOverrides:{'./store':boundary}}).outputText;
const {readTripLanguagePreferences,saveTripLanguagePreferences}=await import(dataURL(compiled)) as typeof import('../lib/trip-language-preferences');
const alice={id:'alice',displayName:'Alice'},bob={id:'bob',displayName:'Bob'},trip='holiday';
async function fixture(){const db=new Database();for(const file of (await readdir(new URL('../drizzle/',import.meta.url))).filter(file=>file.endsWith('.sql')).sort())db.sqlite.exec(await readFile(new URL('../drizzle/'+file,import.meta.url),'utf8'));
  db.sqlite.prepare('INSERT INTO profiles(id,email,display_name,created_at) VALUES(?,?,?,?)').run(alice.id,'alice@example.test',alice.displayName,'2026-10-05');
  db.sqlite.prepare('INSERT INTO profiles(id,email,display_name,created_at) VALUES(?,?,?,?)').run(bob.id,'bob@example.test',bob.displayName,'2026-10-05');
  db.sqlite.prepare('INSERT INTO trips(id,owner,data) VALUES(?,?,?)').run(trip,alice.id,'{}');
  db.sqlite.prepare('INSERT INTO memberships(trip_id,user_id,member_id) VALUES(?,?,?)').run(trip,bob.id,'traveller-bob');return db;}
const count=(db:Database)=>Number(db.sqlite.prepare('SELECT COUNT(*) AS count FROM account_activity_events').get()!.count);
test('preference insert/update CAS and no-op preserve exact private durable audit',async()=>{const db=await fixture();try{
  await saveTripLanguagePreferences(db.asD1(),bob,trip,0,{readingLanguage:'fr'});
  await saveTripLanguagePreferences(db.asD1(),bob,trip,1,{primaryVersion:'receipt'});
  assert.equal((await readTripLanguagePreferences(db.asD1(),bob.id,trip)).revision,2);
  await assert.rejects(saveTripLanguagePreferences(db.asD1(),bob,trip,1,{readingLanguage:'de'}),/changed elsewhere/);assert.equal(count(db),2);
  await saveTripLanguagePreferences(db.asD1(),bob,trip,2,{readingLanguage:'fr'});assert.equal(count(db),2);
  assert.equal((await readAccountActivity(db.asD1(),alice.id)).events.length,0);
  const history=(await readAccountActivity(db.asD1(),bob.id)).events;assert.equal(history[0].actorName,'Bob');assert.equal(history[0].entityType,'language');assert.ok(!JSON.stringify(history).includes('example.test'));
}finally{db.sqlite.close();}});
for(const revision of [0,1])for(const race of ['membership','canonical-account','concurrent-save'])test(`preference revision ${revision} guards ${race} race inside its SQL transaction`,async()=>{const db=await fixture();try{
  if(revision)await saveTripLanguagePreferences(db.asD1(),bob,trip,0,{readingLanguage:'fr'});
  const before=count(db);
  db.beforeBatch=()=>{
    if(race==='membership')db.sqlite.prepare('DELETE FROM memberships WHERE user_id=?').run(bob.id);
    else if(race==='canonical-account')db.sqlite.prepare('INSERT INTO auth_links(oai_user_id,user_id,created_at) VALUES(?,?,?)').run(bob.id,alice.id,'2026-10-05');
    else if(revision)db.sqlite.prepare('UPDATE trip_language_preferences SET revision=revision+1 WHERE user_id=?').run(bob.id);
    else db.sqlite.prepare('INSERT INTO trip_language_preferences(user_id,trip_id,data,revision) VALUES(?,?,?,1)').run(bob.id,trip,JSON.stringify({readingLanguage:'it',primaryVersion:'reading',itemVersions:{}}));
  };
  await assert.rejects(saveTripLanguagePreferences(db.asD1(),bob,trip,revision,{readingLanguage:'de'}),/changed/);assert.equal(count(db),before);
  const row=db.sqlite.prepare('SELECT data FROM trip_language_preferences WHERE user_id=?').get(bob.id);
  if(row)assert.notEqual(JSON.parse(row.data as string).readingLanguage,'de');
}finally{db.sqlite.close();}});
test('preference and audit roll back atomically when the private history write fails',async()=>{const db=await fixture();try{
  db.sqlite.exec("CREATE TRIGGER deny_language_audit BEFORE INSERT ON account_activity_events BEGIN SELECT RAISE(ABORT,'audit unavailable');END;");
  await assert.rejects(saveTripLanguagePreferences(db.asD1(),bob,trip,0,{readingLanguage:'fr'}),/audit unavailable/);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM trip_language_preferences').get()!.count,0);assert.equal(count(db),0);
}finally{db.sqlite.close();}});
