import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {ModuleKind,ScriptTarget,transpileModule} from 'typescript';

const compiled=transpileModule(await readFile(new URL('../components/use-live-refresh.ts',import.meta.url),'utf8'),{compilerOptions:{module:ModuleKind.CommonJS,target:ScriptTarget.ES2022}}).outputText;
function controller(){
  const window=new EventTarget(),document={visibilityState:'visible'},navigator={onLine:true};
  const latest:{current:unknown}={current:()=>{}};
  let cleanup:(()=>void)|undefined,dependencies:unknown[]|undefined;
  const hooks={useRef(value:unknown){if(!dependencies)latest.current=value;return latest},useLayoutEffect(callback:()=>void){callback()},useEffect(callback:()=>()=>void,next:unknown[]){
    if(!dependencies||next.some((value,index)=>value!==dependencies![index])){cleanup?.();dependencies=next;cleanup=callback();}
  }};
  const compiledModule={exports:{} as {useLiveRefresh(callback:()=>void,options?:{accountId?:string;enabled?:boolean}):void;dispatchLiveRefresh(accountId:string):void}};
  new Function('require','module','exports','window','document','navigator','CustomEvent',compiled)(()=>hooks,compiledModule,compiledModule.exports,window,document,navigator,CustomEvent);
  return {render:compiledModule.exports.useLiveRefresh,dispatch:compiledModule.exports.dispatchLiveRefresh,document,navigator,unmount(){cleanup?.()}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('live events refresh only the current account and ignore empty, hidden or offline scopes',async()=>{
  const ui=controller();let calls=0;ui.render(()=>{calls++},{accountId:'alice'});
  ui.dispatch('bob');ui.dispatch('');await settle();assert.equal(calls,0);
  ui.dispatch('alice');await settle();assert.equal(calls,1);
  ui.document.visibilityState='hidden';ui.dispatch('alice');await settle();assert.equal(calls,1);
  ui.document.visibilityState='visible';ui.navigator.onLine=false;ui.dispatch('alice');await settle();assert.equal(calls,1);
  ui.navigator.onLine=true;ui.dispatch('alice');await settle();assert.equal(calls,2);
});
test('a queued event cannot start a private read after an account change or unmount',async()=>{
  const ui=controller();let old=0,current=0;ui.render(()=>{old++},{accountId:'alice'});
  ui.dispatch('alice');ui.render(()=>{current++},{accountId:'bob'});await settle();assert.equal(old,0);assert.equal(current,0);
  ui.dispatch('bob');ui.unmount();await settle();assert.equal(current,0);
});
test('live checks use the latest callback without replacing its listener or resetting form state',async()=>{
  const ui=controller();let old=0,current=0;ui.render(()=>{old++},{accountId:'alice'});
  ui.render(()=>{current++},{accountId:'alice'});ui.dispatch('alice');await settle();assert.equal(old,0);assert.equal(current,1);
  ui.render(()=>{current++},{accountId:'alice',enabled:false});ui.dispatch('alice');await settle();assert.equal(current,1);
});

test('an empty accepted account scope retries profile bootstrap without waking bound private resources',async()=>{
  const bootstrap=controller(),privatePanel=controller();let retries=0,privateReads=0;
  bootstrap.render(()=>{retries++});privatePanel.render(()=>{privateReads++},{accountId:'alice'});
  bootstrap.dispatch('');privatePanel.dispatch('');await settle();assert.equal(retries,1);assert.equal(privateReads,0);
});
