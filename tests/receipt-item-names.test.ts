import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as React from 'react';
import * as runtime from 'react/jsx-runtime';
import { JsxEmit,ModuleKind,ScriptTarget,transpileModule } from 'typescript';
import * as languages from '../lib/receipt-languages';
import * as data from '../lib/data-utils';
import type { DraftItem,Trip } from '../lib/model';
import type { ReceiptEditor } from '../lib/receipt-processing';
import type { LanguagePreferencesController } from '../components/trip-language-preferences';
const compiled=transpileModule(await readFile(new URL('../components/receipt-item-names.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ModuleKind.CommonJS,target:ScriptTarget.ES2022,jsx:JsxEmit.ReactJSX}}).outputText;
type Element=React.ReactElement<Record<string,unknown>>;
const elements=(value:unknown):Element[]=>Array.isArray(value)?value.flatMap(elements):React.isValidElement<Record<string,unknown>>(value)?[value,...elements(value.props.children)]:[];
async function flush(){await new Promise(resolve=>setImmediate(resolve));}
function fixture(){
  const item:DraftItem={id:'line',name:'Acqua',nameLanguage:'it',amount:250,members:['alice'],fieldSources:{name:'receipt'},translations:{en:{text:'Water',sourceText:'Acqua',pairedText:'Water',sourceLanguage:'it',provenance:'ai'}}};
  const trip:Trip={id:'holiday',name:'Vienna',currency:'EUR',receiptLanguage:'de',members:[{id:'alice',name:'Alice'}],drafts:[],expenses:[],payments:[]};
  const receipt:ReceiptEditor={id:'receipt',title:'Italian restaurant',date:'2026-10-05',time:'12:00',timezone:'Europe/Vienna',currency:'EUR',payer:'alice',items:[item],tax:0,tip:0,discount:0};
  const settings={preferences:languages.defaultLanguagePreferences(),ready:true,busy:false,error:'',save:async()=>true,reload:async()=>{}} as LanguagePreferencesController;
  const requests:{body:Record<string,unknown>;resolve:(result:unknown)=>void;signal:AbortSignal}[]=[];
  const fetcher:typeof fetch=async(_url,init)=>new Promise(resolve=>requests.push({body:JSON.parse(init!.body as string),signal:init!.signal as AbortSignal,resolve:result=>resolve(Response.json({accountId:'account',tripId:trip.id,rows:[{id:item.id,text:result,sourceLanguage:'it'}]}))}));
  const state:unknown[]=[],refs:{current:unknown}[]=[],effects:(()=>void|(()=>void))[]=[],cleanup:(()=>void)[]=[];let stateIndex=0,refIndex=0;
  const hooks={useState(initial:unknown){const index=stateIndex++;if(!(index in state))state[index]=initial;return [state[index],(next:unknown)=>{state[index]=typeof next==='function'?next(state[index]):next;}];},useRef(initial:unknown){return refs[refIndex++]??(refs[refIndex-1]={current:initial});},useLayoutEffect(effect:()=>void|(()=>void)){effects.push(effect);}};
  const exportedModule={exports:{} as {default:(props:Record<string,unknown>)=>unknown}};
  new Function('require','module','exports','fetch',compiled)((name:string)=>name==='@/lib/ui-language'?{t:(value:string)=>value}:name==='react'?hooks:name==='react/jsx-runtime'?runtime:name==='@/lib/receipt-languages'?languages:name==='@/lib/data-utils'?data:name==='lucide-react'?{RefreshCw:()=>null,Undo2:()=>null}:{},exportedModule,exportedModule.exports,fetcher);
  const props={accountId:'account',trip,receipt,item,index:0,settings,onUpdate:(change:(item:DraftItem)=>DraftItem)=>{props.item=change(props.item);props.receipt={...props.receipt,items:[props.item]};}};
  let tree:Element[]=[];
  const render=()=>{stateIndex=0;refIndex=0;tree=elements(exportedModule.exports.default(props));for(const effect of effects.splice(0)){const dispose=effect();if(dispose)cleanup.push(dispose);}return tree;};
  render();
  const input=(name:string)=>tree.find(element=>element.type==='input'&&element.props['aria-label']===name)!;
  const button=(name:string)=>tree.find(element=>element.type==='button'&&element.props['aria-label']===name)!;
  const click=(element:Element)=>(element.props.onClick as ()=>void)();
  const edit=(name:string,text:string)=>{(input(name).props.onChange as (event:unknown)=>void)({target:{value:text}});render();};
  return {props,requests,render,input,button,click,edit,state,unmount:()=>cleanup.forEach(dispose=>dispose()),undo:()=>{const control=tree.find(element=>element.type==='button'&&String(element.props.className).includes('translation-undo'));assert(control);click(control);render();},text:()=>JSON.stringify(tree)};
}
test('both compact item names are editable and refresh in either direction with Undo',async()=>{
  const f=fixture();assert.equal(f.input('Item 1 English name').props.value,'Water');assert.equal(f.input('Item 1 name').props.value,'Acqua');
  f.edit('Item 1 name','Acqua frizzante');assert.match(f.text(),/refresh suggested/);
  f.click(f.button('Refresh item 1 English name'));await flush();assert.equal(f.requests.length,1);assert.deepEqual(f.requests[0].body.rows,[{id:'line',sourceText:'Acqua frizzante',sourceLanguage:'it',targetLanguage:'en'}]);
  f.requests[0].resolve('Sparkling water');await flush();f.render();assert.equal(f.props.item.translations?.en?.text,'Sparkling water');assert.equal(f.props.item.scanSource,undefined);
  f.props.item={...f.props.item,amount:500};f.props.receipt={...f.props.receipt,items:[f.props.item]};f.render();f.undo();assert.equal(f.props.item.translations?.en?.text,'Water');assert.equal(f.props.item.amount,500);
  f.edit('Item 1 English name','Still water');f.click(f.button('Refresh item 1 receipt name'));await flush();assert.deepEqual(f.requests[1].body.rows,[{id:'line',sourceText:'Still water',sourceLanguage:'en',targetLanguage:'it'}]);
  f.requests[1].resolve('Acqua naturale');await flush();f.render();assert.equal(f.props.item.name,'Acqua naturale');assert.equal(f.props.item.fieldSources?.name,'user');assert.equal(f.props.item.translations?.en?.pairedText,'Still water');
  f.undo();assert.equal(f.props.item.name,'Acqua frizzante');assert.equal(f.props.item.translations?.en?.text,'Still water');assert.equal(f.props.item.amount,500);
});
test('same-language items use one canonical name field',()=>{
  const f=fixture();
  f.props.item={...f.props.item,name:'Ticket',nameLanguage:'en',translations:{en:{text:'Ticket',sourceText:'Ticket',pairedText:'Ticket',sourceLanguage:'en',provenance:'ai'}}};
  f.props.receipt={...f.props.receipt,detectedLanguage:'en',items:[f.props.item]};f.render();
  assert.equal(f.input('Item 1 name').props.value,'Ticket');
  assert.doesNotMatch(f.text(),/Item 1 English name|Show first for item 1|Refresh item 1/);
  f.edit('Item 1 name','Train ticket');assert.equal(f.props.item.name,'Train ticket');
});
for(const target of ['source','target','merchant','receipt-language','reading-language','account'])test(`a pending item translation preserves newer ${target} context`,async()=>{
  const f=fixture();f.click(f.button('Refresh item 1 English name'));await flush();
  if(target==='source')f.edit('Item 1 name','Human source');
  if(target==='target')f.edit('Item 1 English name','Human target');
  if(target==='merchant')f.props.receipt={...f.props.receipt,title:'Different restaurant'};
  if(target==='receipt-language')f.props.receipt={...f.props.receipt,receiptLanguage:'fr'};
  if(target==='reading-language')f.props.settings={...f.props.settings,preferences:{...f.props.settings.preferences,readingLanguage:'fr'}};
  if(target==='account')f.props.accountId='other-account';
  f.render();const before=structuredClone(f.props.item);f.requests[0].resolve('Old response');await flush();f.render();assert.deepEqual(f.props.item,before);assert.match(f.text(),/edits were kept/);
});
test('trip hints remain hints and provider detection supplies an unknown original language',async()=>{
  const f=fixture();f.props.item={...f.props.item,name:'Acqua',nameLanguage:undefined,translations:undefined};f.props.trip={...f.props.trip,receiptLanguage:'en'};f.props.receipt={...f.props.receipt,items:[f.props.item]};f.render();
  f.click(f.button('Translate item 1 English name'));await flush();assert.equal((f.requests[0].body.rows as {sourceLanguage?:unknown}[])[0].sourceLanguage,undefined);
  f.requests[0].resolve('Water');await flush();f.render();assert.equal(f.props.item.nameLanguage,'it');assert.equal(f.props.item.translations?.en?.sourceLanguage,'it');
});
test('translation waits for saved language preferences and closing an editor aborts pending work',async()=>{
  const f=fixture();f.props.settings={...f.props.settings,ready:false};f.render();assert.equal(f.button('Refresh item 1 English name').props.disabled,true);
  f.props.settings={...f.props.settings,ready:true};f.render();f.click(f.button('Refresh item 1 English name'));await flush();f.unmount();assert.equal(f.requests[0].signal.aborted,true);
  const before=structuredClone(f.props.item);f.requests[0].resolve('Late response');await flush();assert.deepEqual(f.props.item,before);
});
test('Undo keeps a later provenance-only confirmation intact',async()=>{
  const f=fixture();f.click(f.button('Refresh item 1 English name'));await flush();f.requests[0].resolve('Sparkling water');await flush();f.render();
  f.props.item={...f.props.item,fieldSources:{...f.props.item.fieldSources,name:'user'}};f.props.receipt={...f.props.receipt,items:[f.props.item]};f.render();f.undo();assert.equal(f.props.item.fieldSources?.name,'user');assert.equal(f.props.item.translations?.en?.text,'Sparkling water');
});
