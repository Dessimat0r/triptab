import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {createSourceFile,isCallExpression,isIdentifier,ScriptKind,ScriptTarget,transpileModule} from 'typescript';
const source=await readFile(new URL('../components/trip-app.tsx',import.meta.url),'utf8');
const syntax=createSourceFile('trip-app.tsx',source,ScriptTarget.Latest,true,ScriptKind.TSX);
let effect='';
function visit(node:import('typescript').Node) {
  if(isCallExpression(node)&&isIdentifier(node.expression)&&node.expression.text==='useEffect'&&node.arguments[0]?.getText(syntax).includes('5_000'))effect=node.arguments[0].getText(syntax);
  node.forEachChild(visit);
}
visit(syntax);assert(effect);
function polling(overrides:Record<string,unknown>={}) {
  let callback:(()=>void)|undefined,calls=0,cleared=false;
  const state={trip:{drafts:[{id:'draft',receiptId:'image',status:'waiting'}]},editing:{draftId:'draft',receiptId:'image'},receiptPrompt:'Saved exact prompt',receiptCopied:false,receiptHandoffOpened:false,receiptProcessing:false,saving:false,uploading:false,auth:false,receiptItemized:false,...overrides};
  const document={visibilityState:'visible'},navigator={onLine:true};
  const window={setInterval(next:()=>void,delay:number){assert.equal(delay,5000);callback=next;return 1},clearInterval(){cleared=true}};
  const execute=new Function('state','window','document','navigator','load',transpileModule(`const {${Object.keys(state).join(',')}}=state;return (${effect})();`,{compilerOptions:{target:ScriptTarget.ES2022}}).outputText);
  const cleanup=execute(state,window,document,navigator,()=>{calls++});
  return {get started(){return !!callback},tick(){callback?.()},get calls(){return calls},hide(){document.visibilityState='hidden'},offline(){navigator.onLine=false},cleanup(){cleanup?.()},get cleared(){return cleared}};
}
test('a staged prompt and automatic native receipt processing never start external receipt polling',()=> {
  assert.equal(polling().started,false);
  assert.equal(polling({receiptProcessing:true,receiptCopied:true}).started,false);
});
test('copied or opened external requests poll only the visible online waiting receipt',()=> {
  for(const key of ['receiptCopied','receiptHandoffOpened']) {
    const poll=polling({[key]:true});assert(poll.started);poll.tick();assert.equal(poll.calls,1);
    poll.hide();poll.tick();assert.equal(poll.calls,1);poll.cleanup();assert.equal(poll.cleared,true);
  }
  const poll=polling({receiptCopied:true});poll.offline();poll.tick();assert.equal(poll.calls,0);
});
test('reviewed and blocked receipt states do not keep external polling alive',()=> {
  for(const state of [{receiptItemized:true},{saving:true},{uploading:true},{auth:true},{trip:{drafts:[{id:'draft',receiptId:'image',status:'review'}]}}])assert.equal(polling({receiptCopied:true,...state}).started,false);
});
