import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {createSourceFile,isCallExpression,isIdentifier,ScriptKind,ScriptTarget,transpileModule} from 'typescript';
const source=await readFile(new URL('../components/trip-app.tsx',import.meta.url),'utf8');
const syntax=createSourceFile('trip-app.tsx',source,ScriptTarget.Latest,true,ScriptKind.TSX);
let effect='',dependencies='';
function visit(node:import('typescript').Node) {
  if(isCallExpression(node)&&isIdentifier(node.expression)&&node.expression.text==='useEffect'&&node.arguments[0]?.getText(syntax).includes('5_000')) {
    effect=node.arguments[0].getText(syntax);dependencies=node.arguments[1].getText(syntax);
  }
  node.forEachChild(visit);
}
visit(syntax);assert(effect);
function polling(overrides:Record<string,unknown>={}) {
  let callback:(()=>void)|undefined,delay=0,cleared=false;
  const calls:unknown[]=[];
  const state={profile:{id:'owner'},auth:false,saving:false,uploading:false,loading:false,receiptProcessing:false,...overrides};
  const events=new Map<string,(event?:unknown)=>void>();
  const target=(scope:string)=>({addEventListener(name:string,fn:(event?:unknown)=>void){events.set(`${scope}:${name}`,fn)},removeEventListener(name:string){events.delete(`${scope}:${name}`)}});
  const document={visibilityState:'visible',...target('document')},navigator={onLine:true,serviceWorker:target('worker')};
  const window={setInterval(next:()=>void,ms:number){delay=ms;callback=next;return 1},clearInterval(){cleared=true},...target('window')};
  const execute=new Function('state','window','document','navigator','load',transpileModule(`const {${Object.keys(state).join(',')}}=state;return (${effect})();`,{compilerOptions:{target:ScriptTarget.ES2022}}).outputText);
  const cleanup=execute(state,window,document,navigator,(options:unknown)=>{calls.push(options);return Promise.resolve()});
  return {get started(){return !!callback},get delay(){return delay},tick(){callback?.()},calls,
    hide(){document.visibilityState='hidden'},show(){document.visibilityState='visible'},offline(){navigator.onLine=false},online(){navigator.onLine=true},
    event(scope:string,name:string,event?:unknown){events.get(`${scope}:${name}`)?.(event)},cleanup(){cleanup?.()},get cleared(){return cleared},get listeners(){return events.size}};
}
test('every open saved receipt polls quickly without requiring a copied prompt or a waiting draft',()=> {
  const poll=polling();assert(poll.started);assert.equal(poll.delay,5000);poll.tick();
  assert.deepEqual(poll.calls,[{background:true}]);poll.cleanup();assert(poll.cleared);assert.equal(poll.listeners,0);
  assert.doesNotMatch(dependencies,/receiptCopied|receiptPrompt|receiptItemized|receiptHandoffOpened|\bediting\b|\btrip,(?!\?)/);
});
test('every active section uses the same five-second conditional refresh loop',()=> {
  const poll=polling();assert.equal(poll.delay,5000);poll.tick();assert.equal(poll.calls.length,1);
});
test('hidden and offline pages make no polling or push refresh requests',()=> {
  const poll=polling();poll.hide();poll.tick();poll.event('worker','message',{data:{type:'TRIPTAB_REFRESH'}});assert.equal(poll.calls.length,0);
  poll.show();poll.offline();poll.tick();poll.event('window','focus');assert.equal(poll.calls.length,0);
  poll.online();poll.event('window','online');assert.equal(poll.calls.length,1);
});
test('visibility, focus, reconnect and push wake-ups use the background loader',()=> {
  const poll=polling();poll.event('window','focus');poll.event('document','visibilitychange');poll.event('window','online');
  poll.event('worker','message',{data:{type:'TRIPTAB_REFRESH'}});assert.deepEqual(poll.calls,Array(4).fill({background:true}));
  poll.event('worker','message',{data:{type:'SKIP_WAITING'}});poll.event('worker','message',{data:null});assert.equal(poll.calls.length,4);
});
test('saving, uploading, loading and signed-out accounts pause all automatic triggers',()=> {
  for(const state of [{saving:true},{uploading:true},{loading:true},{auth:true}]) {
    const poll=polling(state);assert.equal(poll.started,false);assert.equal(poll.listeners,0);assert.equal(poll.calls.length,0);
  }
});
test('cleanup removes timers and push listeners when account or trip scope changes',()=> {
  const old=polling();old.cleanup();old.event('worker','message',{data:{type:'TRIPTAB_REFRESH'}});assert.equal(old.calls.length,0);
  const next=polling({profile:{id:'other-account'}});next.event('worker','message',{data:{type:'TRIPTAB_REFRESH'}});assert.equal(next.calls.length,1);
});

test('saved-data checks continue during a paid receipt request without starting additional processing',()=>{
  const poll=polling({receiptProcessing:true});poll.tick();assert.deepEqual(poll.calls,[{background:true}]);
});
