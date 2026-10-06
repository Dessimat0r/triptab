"use client";
import { useLayoutEffect,useRef,useState } from 'react';
import { RefreshCw,Undo2 } from 'lucide-react';
import { canonicalJson } from '@/lib/data-utils';
import { editReadingName,isUntranslatedManualItem,itemDisplayKey,languageName,originalItemLanguage,observedItemLanguage,setPairedTranslation,type ReceiptLanguage,type DisplayVersion } from '@/lib/receipt-languages';
import type { DraftItem,Trip } from '@/lib/model';
import type { ReceiptEditor } from '@/lib/receipt-processing';
import type { LanguagePreferencesController } from './trip-language-preferences';
import './receipt-languages.css';
export const itemNameSnapshot=(item:DraftItem,language:ReceiptLanguage)=>canonicalJson({name:item.name,nameLanguage:item.nameLanguage,nameSource:item.fieldSources?.name,translation:item.translations?.[language]});
type Props={accountId:string;trip:Trip;receipt:ReceiptEditor;item:DraftItem;index:number;settings:LanguagePreferencesController;onUpdate:(change:(item:DraftItem)=>DraftItem)=>void};
function restoredNames(current:DraftItem,before:DraftItem,language:ReceiptLanguage):DraftItem{
  const translations={...current.translations};
  if(before.translations?.[language])translations[language]=before.translations[language];else delete translations[language];
  return {...current,name:before.name,nameLanguage:before.nameLanguage,translations:Object.keys(translations).length?translations:undefined,
    fieldSources:{...current.fieldSources,name:before.fieldSources?.name}};
}
export default function ReceiptItemNames(props:Props){
  const {item,index,settings,trip,receipt,accountId,onUpdate}=props;
  const language=settings.preferences.readingLanguage,originalLanguage=originalItemLanguage(item,trip,receipt),reading=item.translations?.[language];
  const manual=isUntranslatedManualItem(item,receipt);
  const sameLanguage=manual||observedItemLanguage(item,receipt)===language;
  const displayKey=itemDisplayKey(receipt,item.id),version=settings.preferences.itemVersions[displayKey]??settings.preferences.primaryVersion;
  const [pending,setPending]=useState<DisplayVersion|null>(null),[error,setError]=useState(''),[undo,setUndo]=useState<{before:DraftItem;after:string;language:ReceiptLanguage}|null>(null);
  const latest=useRef(props),requestToken=useRef(0),controller=useRef<AbortController|null>(null);
  useLayoutEffect(()=>{latest.current=props;});
  useLayoutEffect(()=>()=>{requestToken.current++;controller.current?.abort();},[]);
  const context=canonicalJson([accountId,trip.id,receipt.id,receipt.languageViewId,receipt.title,receipt.location,receipt.locationHint,receipt.receiptLanguage,receipt.detectedLanguage,trip.receiptLanguage,language,originalLanguage]);
  async function refresh(target:DisplayVersion){
    if(pending||!settings.ready)return;
    const sourceText=target==='reading'?item.name:reading?.text,sourceLanguage=target==='reading'?observedItemLanguage(item,receipt):language,targetLanguage=target==='reading'?language:originalLanguage;
    if(!sourceText?.trim()||!targetLanguage)return;
    const before=structuredClone(item),snapshot=itemNameSnapshot(item,language),token=++requestToken.current;
    const abort=new AbortController();controller.current=abort;setPending(target);setError('');setUndo(null);
    try{
      const response=await fetch('/api/receipt/translate',{method:'POST',signal:abort.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({purpose:'items',accountId,tripId:trip.id,receiptTitle:receipt.title,receiptLocation:receipt.location,receiptLocationHint:receipt.locationHint,
        rows:[{id:item.id,sourceText,...(sourceLanguage?{sourceLanguage}:{}),targetLanguage}]})});
      const result=await response.json() as {accountId:string;tripId:string;rows:{id:string;text:string;sourceLanguage:ReceiptLanguage|null}[];error?:string};
      if(!response.ok)throw Error(result.error||'Unable to translate this name.');
      const now=latest.current,nowLanguage=now.settings.preferences.readingLanguage;
      const nowContext=canonicalJson([now.accountId,now.trip.id,now.receipt.id,now.receipt.languageViewId,now.receipt.title,now.receipt.location,now.receipt.locationHint,now.receipt.receiptLanguage,now.receipt.detectedLanguage,now.trip.receiptLanguage,nowLanguage,originalItemLanguage(now.item,now.trip,now.receipt)]);
      if(token!==requestToken.current)return;
      if(context!==nowContext||itemNameSnapshot(now.item,language)!==snapshot){setError('The item changed while translating. Your edits were kept; refresh again.');return;}
      const row=result.rows?.[0];
      if(result.accountId!==accountId||result.tripId!==trip.id||result.rows?.length!==1||row?.id!==item.id||typeof row.text!=='string'||!row.text.trim()||row.text.length>200)throw Error('Invalid translation response. Try again.');
      now.onUpdate(current=>{
        if(itemNameSnapshot(current,language)!==snapshot)return current;
        const next=target==='reading'
          ?setPairedTranslation(current,language,row.text,observedItemLanguage(item,receipt)??row.sourceLanguage??undefined,'user')
          :setPairedTranslation({...current,name:row.text,nameLanguage:targetLanguage,fieldSources:{...current.fieldSources,name:'user' as const}},language,reading!.text,targetLanguage,'user');
        return next;
      });
      // Calculate without depending on React executing a state updater immediately.
      const expected=target==='reading'?setPairedTranslation(before,language,row.text,observedItemLanguage(item,receipt)??row.sourceLanguage??undefined,'user')
        :setPairedTranslation({...before,name:row.text,nameLanguage:targetLanguage,fieldSources:{...before.fieldSources,name:'user' as const}},language,reading!.text,targetLanguage,'user');
      setUndo({before,after:itemNameSnapshot(expected,language),language});
    }catch(cause){if(token===requestToken.current&&!abort.signal.aborted)setError(cause instanceof Error?cause.message:'Unable to translate this name.');}
    finally{if(token===requestToken.current)setPending(null);}
  }
  function row(target:DisplayVersion,showTranslationAction=true){
    const translated=target==='reading',value=translated?reading?.text??'':item.name;
    const stale=reading&& (translated?reading.sourceText!==item.name:reading.pairedText!==reading.text);
    const fieldId=`item-name-${displayKey}-${target}`;
    return <div key={target} className={`item-name-row ${version===target?'item-name-row--preferred':'item-name-row--alternate'}`}>
      <div className="item-name-field">
        <label className="item-name-caption" htmlFor={fieldId}>{manual?'Item name':sameLanguage?languageName(language):translated?languageName(language):`Receipt · ${originalLanguage?languageName(originalLanguage):'original'}`}{!sameLanguage&&stale&&<span className="translation-stale"> · refresh suggested</span>}</label>
        <input id={fieldId} aria-label={`Item ${index+1} ${translated?languageName(language)+' name':'name'}`} lang={translated?language:originalLanguage} dir="auto"
          placeholder={translated?`${languageName(language)} item name`:'Item name'} value={value} required={!translated} maxLength={200}
          onChange={event=>{setError('');setUndo(null);const text=event.target.value;onUpdate(current=>translated?editReadingName(current,language,text):{...current,name:text,fieldSources:{...current.fieldSources,name:'user'}});}} />
      </div>
      {showTranslationAction&&<button type="button" className="iconbutton translation-refresh" aria-label={`${!value.trim()?'Translate':'Refresh'} item ${index+1} ${translated?languageName(language)+' name':'receipt name'}`} title={translated?`Translate receipt name into ${languageName(language)}`:originalLanguage?`Translate ${languageName(language)} name into ${languageName(originalLanguage)}`:'Choose a receipt language to translate back'}
        disabled={!settings.ready||pending!==null||!(translated?item.name.trim():reading?.text.trim())||(!translated&&!originalLanguage)} onClick={()=>void refresh(target)}>
        <RefreshCw size={15} className={pending===target?'translation-spinner':undefined} aria-hidden="true" />
        {!value.trim()&&<span aria-hidden="true">Translate</span>}
      </button>}
    </div>;
  }
  if(sameLanguage)return <div className="item-bilingual-names item-bilingual-names--single">
    {row('receipt',false)}
    {pending&&<span className="footnote" role="status">Translating…</span>}{error&&<p className="error" role="alert">{error}</p>}
  </div>;
  return <div className="item-bilingual-names">
    {row(version)}{row(version==='reading'?'receipt':'reading')}
    <div className="item-language-actions">
      <label className="sr-only" htmlFor={`item-language-${displayKey}`}>Show first for item {index+1}</label>
      <select id={`item-language-${displayKey}`} aria-label={`Show first for item ${index+1}`} value={settings.preferences.itemVersions[displayKey]??'default'} disabled={!settings.ready||settings.busy} onChange={event=>void settings.save({itemKey:displayKey,itemVersion:event.target.value==='default'?null:event.target.value as DisplayVersion})}>
        <option value="default">Holiday display default</option><option value="reading">{languageName(language)} first</option><option value="receipt">Receipt original first</option>
      </select>
      {undo&&<button type="button" className="quiet translation-undo" onClick={()=>{const saved=undo;onUpdate(current=>itemNameSnapshot(current,saved.language)===saved.after?restoredNames(current,saved.before,saved.language):current);setUndo(null);}}><Undo2 size={13} aria-hidden="true" /> Undo</button>}
    </div>
    {pending&&<span className="footnote" role="status">Translating…</span>}{error&&<p className="error" role="alert">{error}</p>}
  </div>;
}
export function TranslateMissingNames({accountId,trip,receipt,settings,onUpdate}:{accountId:string;trip:Trip;receipt:ReceiptEditor;settings:LanguagePreferencesController;onUpdate:(id:string,change:(item:DraftItem)=>DraftItem)=>void}){
  const [pending,setPending]=useState(false),[error,setError]=useState('');
  const latest=useRef({accountId,trip,receipt,settings,onUpdate}),token=useRef(0),controller=useRef<AbortController|null>(null);
  useLayoutEffect(()=>{latest.current={accountId,trip,receipt,settings,onUpdate};});
  useLayoutEffect(()=>()=>{token.current++;controller.current?.abort();},[]);
  const language=settings.preferences.readingLanguage,missing=receipt.items.filter(item=>item.name.trim()&&!isUntranslatedManualItem(item,receipt)&&observedItemLanguage(item,receipt)!==language&&!item.translations?.[language]?.text.trim());
  if(!missing.length)return null;
  return <div className="missing-name-translations"><button type="button" className="quiet" disabled={pending||!settings.ready} onClick={async()=>{
    const before=new Map(missing.map(item=>[item.id,itemNameSnapshot(item,language)])),context=canonicalJson([accountId,trip.id,receipt.id,receipt.languageViewId,receipt.title,receipt.location,receipt.locationHint,receipt.receiptLanguage,receipt.detectedLanguage,trip.receiptLanguage,language]);
    const request=++token.current,abort=new AbortController();controller.current=abort;setPending(true);setError('');
    try{
      const response=await fetch('/api/receipt/translate',{method:'POST',signal:abort.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({purpose:'items',accountId,tripId:trip.id,receiptTitle:receipt.title,receiptLocation:receipt.location,receiptLocationHint:receipt.locationHint,rows:missing.map(item=>({id:item.id,sourceText:item.name,sourceLanguage:observedItemLanguage(item,receipt),targetLanguage:language}))})});
      const result=await response.json() as {accountId:string;tripId:string;rows:{id:string;text:string;sourceLanguage:ReceiptLanguage|null}[];error?:string};
      if(!response.ok)throw Error(result.error||'Unable to translate these names.');
      if(token.current!==request)return;
      const now=latest.current;
      if(context!==canonicalJson([now.accountId,now.trip.id,now.receipt.id,now.receipt.languageViewId,now.receipt.title,now.receipt.location,now.receipt.locationHint,now.receipt.receiptLanguage,now.receipt.detectedLanguage,now.trip.receiptLanguage,now.settings.preferences.readingLanguage]))throw Error('Receipt context changed. Your edits were kept; translate again.');
      if(result.accountId!==accountId||result.tripId!==trip.id||!Array.isArray(result.rows)||result.rows.length!==before.size||new Set(result.rows.map(row=>row.id)).size!==before.size||result.rows.some(row=>!before.has(row.id)||typeof row.text!=='string'||!row.text.trim()||row.text.length>200))throw Error('Invalid translation response. Try again.');
      let skipped=0;
      for(const row of result.rows){const current=now.receipt.items.find(item=>item.id===row.id);if(!current||itemNameSnapshot(current,language)!==before.get(row.id)){skipped++;continue;}
        now.onUpdate(row.id,item=>itemNameSnapshot(item,language)===before.get(row.id)?setPairedTranslation(item,language,row.text,observedItemLanguage(item,now.receipt)??row.sourceLanguage??undefined,'user'):item);}
      if(skipped)setError('Some items changed while translating. Those edits were kept.');
    }catch(cause){if(token.current===request&&!abort.signal.aborted)setError(cause instanceof Error?cause.message:'Unable to translate these names.');}
    finally{if(token.current===request)setPending(false);}
  }}>{pending?'Translating…':`Translate ${missing.length===1?'missing name':`${missing.length} missing names`} to ${languageName(language)}`}</button>{error&&<p className="error" role="alert">{error}</p>}</div>;
}
