"use client";
import { useCallback,useEffect,useLayoutEffect,useRef,useState } from 'react';
import { defaultLanguagePreferences,tripLanguagePreferencesSchema,RECEIPT_LANGUAGES,type TripLanguagePreferences,type DisplayVersion } from '@/lib/receipt-languages';
import './receipt-languages.css';
type Snapshot={accountId:string;tripId:string;revision:number;preferences:TripLanguagePreferences};
type Change={readingLanguage?:TripLanguagePreferences['readingLanguage'];primaryVersion?:DisplayVersion;itemKey?:string;itemVersion?:DisplayVersion|null};
export function useTripLanguagePreferences(accountId:string,tripId:string){
  const [snapshot,setSnapshot]=useState<Snapshot|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const scope=useRef({accountId,tripId}),current=useRef(snapshot),pending=useRef(false),generation=useRef(0);
  useLayoutEffect(()=>{scope.current={accountId,tripId};current.current=snapshot;},[accountId,tripId,snapshot]);
  const matches=useCallback((account:string,trip:string)=>scope.current.accountId===account&&scope.current.tripId===trip,[ ]);
  const reload=useCallback(async()=>{
    if(!accountId||!tripId||pending.current)return;
    const token=++generation.current;
    try{
      const response=await fetch(`/api/trip-language?tripId=${encodeURIComponent(tripId)}`,{cache:'no-store'});
      const body=await response.json() as Snapshot&{error?:string};
      if(!response.ok)throw Error(body.error||'Unable to load your language preferences.');
      if(body.accountId!==accountId||body.tripId!==tripId||!Number.isSafeInteger(body.revision)||body.revision<0)throw Error('Your account changed. Reload your holiday.');
      const next={...body,preferences:tripLanguagePreferencesSchema.parse(body.preferences)};
      if(matches(accountId,tripId)&&generation.current===token){current.current=next;setSnapshot(next);setError('');}
    }catch(cause){if(matches(accountId,tripId)&&generation.current===token)setError(cause instanceof Error?cause.message:'Unable to load your language preferences.');}
  },[accountId,tripId,matches]);
  useEffect(()=>{
    const requests=generation;
    requests.current++;pending.current=false;
    Promise.resolve().then(()=>{if(matches(accountId,tripId)){setBusy(false);setError('');void reload();}});
    const visible=()=>{if(document.visibilityState==='visible')void reload();};
    window.addEventListener('focus',reload);document.addEventListener('visibilitychange',visible);
    return()=>{requests.current++;window.removeEventListener('focus',reload);document.removeEventListener('visibilitychange',visible);};
  },[accountId,tripId,matches,reload]);
  const save=useCallback(async(change:Change)=>{
    const previous=current.current;
    if(pending.current||!previous||previous.accountId!==accountId||previous.tripId!==tripId)return false;
    pending.current=true;const token=++generation.current;setBusy(true);setError('');
    const preferences={...previous.preferences,...(change.readingLanguage?{readingLanguage:change.readingLanguage}:{}),...(change.primaryVersion?{primaryVersion:change.primaryVersion}:{}),itemVersions:{...previous.preferences.itemVersions}};
    if(change.itemKey){if(change.itemVersion===null)delete preferences.itemVersions[change.itemKey];else if(change.itemVersion)preferences.itemVersions[change.itemKey]=change.itemVersion;}
    setSnapshot({...previous,preferences});
    try{
      const response=await fetch('/api/trip-language',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accountId,tripId,revision:previous.revision,...change})});
      const body=await response.json() as Snapshot&{error?:string};
      if(!response.ok)throw Error(body.error||'Unable to save your language preferences.');
      if(body.accountId!==accountId||body.tripId!==tripId||!Number.isSafeInteger(body.revision)||body.revision<previous.revision)throw Error('Your account changed. Reload your holiday.');
      const next={...body,preferences:tripLanguagePreferencesSchema.parse(body.preferences)};
      if(matches(accountId,tripId)&&generation.current===token){current.current=next;setSnapshot(next);return true;}
    }catch(cause){if(matches(accountId,tripId)&&generation.current===token){setSnapshot(previous);setError(cause instanceof Error?cause.message:'Unable to save your language preferences.');}}
    finally{if(matches(accountId,tripId)&&generation.current===token){pending.current=false;setBusy(false);}}
    return false;
  },[accountId,tripId,matches]);
  const ready=snapshot?.accountId===accountId&&snapshot?.tripId===tripId;
  return {preferences:ready?snapshot.preferences:defaultLanguagePreferences(),ready,busy,error,save,reload};
}
export type LanguagePreferencesController=ReturnType<typeof useTripLanguagePreferences>;
export function PersonalLanguageSettings({settings}:{settings:LanguagePreferencesController}){
  return <section className="panel personal-language-settings" aria-labelledby="reading-language-heading">
    <h3 id="reading-language-heading">Your receipt language preferences</h3>
    <p className="footnote">Saved just for you in this holiday. Both item names stay visible and editable.</p>
    <div className="fieldpair">
      <label>Reading language<select aria-label="Reading language" value={settings.preferences.readingLanguage} disabled={!settings.ready||settings.busy} onChange={event=>void settings.save({readingLanguage:event.target.value as TripLanguagePreferences['readingLanguage']})}>
        {RECEIPT_LANGUAGES.map(([code,label])=><option key={code} value={code}>{label}</option>)}
      </select></label>
      <label>Show first<select aria-label="Default item name display" value={settings.preferences.primaryVersion} disabled={!settings.ready||settings.busy} onChange={event=>void settings.save({primaryVersion:event.target.value as DisplayVersion})}>
        <option value="reading">Reading language</option><option value="receipt">Receipt original</option>
      </select></label>
    </div>
    {settings.busy&&<p className="footnote" role="status">Saving your preferences…</p>}
    {settings.error&&<p className="error" role="alert">{settings.error} <button type="button" className="quiet" onClick={()=>void settings.reload()}>Reload preferences</button></p>}
  </section>;
}
