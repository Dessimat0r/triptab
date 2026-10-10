"use client";
import { t as uiText } from "@/lib/ui-language";

import { useLayoutEffect,useRef,useState } from 'react';
import { RECEIPT_LANGUAGES,displayLanguageName,languageSchema,type ReceiptLanguage } from '@/lib/receipt-languages';
import './receipt-languages.css';
export function LanguageOptions(){return <>{RECEIPT_LANGUAGES.map(([code])=><option key={code} value={code}>{displayLanguageName(code)}</option>)}</>;}
export function TripReceiptLanguage({value,onChange,destination,busy=false,accountId,tripId,name}:{value:ReceiptLanguage|'auto';onChange:(language:ReceiptLanguage|'auto')=>void;destination:()=>string;busy?:boolean;accountId?:string;tripId?:string;name?:string}){
  const [pending,setPending]=useState(false),[error,setError]=useState(''),token=useRef(0),current=useRef({value,destination,accountId,tripId});
  useLayoutEffect(()=>{current.current={value,destination,accountId,tripId};});
  useLayoutEffect(()=>()=>{token.current++;},[]);
  return <div className="trip-receipt-language">
    <label>{uiText("Receipt language")}<select aria-label={uiText("Holiday receipt language")} name={name} value={value} disabled={busy} onChange={event=>{token.current++;setError('');onChange(event.target.value as ReceiptLanguage|'auto');}}>
      <option value="auto">{uiText("Automatic detection")}</option><LanguageOptions />
    </select></label>
    <button type="button" className="quiet" disabled={busy||pending||!accountId} onClick={async()=>{
      const text=destination().trim(),before=current.current,request=++token.current;
      if(!text){setError('Enter a holiday name or destination first.');return;}
      setPending(true);setError('');
      try{
        const response=await fetch('/api/receipt/translate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({purpose:'trip-language',accountId,text,...(tripId?{tripId}:{})})});
        const result=await response.json() as {accountId:string;tripId:string|null;language:unknown;error?:string};
        if(!response.ok)throw Error(result.error||'Unable to suggest a language.');
        if(token.current!==request||current.current.value!==before.value||current.current.destination().trim()!==text||current.current.accountId!==before.accountId||current.current.tripId!==before.tripId)return;
        if(result.accountId!==accountId||result.tripId!==(tripId??null))throw Error('Your account changed. Try again.');
        if(result.language===null){setError('The destination is unclear. Choose a language or keep automatic detection.');return;}
        onChange(languageSchema.parse(result.language));
      }catch(cause){if(token.current===request)setError(cause instanceof Error?cause.message:'Unable to suggest a language.');}
      finally{setPending(false);}
    }}>{pending?uiText('Suggesting…'):uiText('Suggest from holiday name')}</button>
    <small className="footnote">{uiText("A starting hint for scans. Each receipt can detect a different language.")}</small>
    {error&&<p className="error" role="alert">{uiText(error)}</p>}
  </div>;
}
export function ReceiptLanguageSelect({tripLanguage,value,detected,onChange}:{tripLanguage?:ReceiptLanguage|'auto';value?:ReceiptLanguage|'auto';detected?:ReceiptLanguage;onChange:(value:ReceiptLanguage|'auto'|undefined)=>void}){
  return <label className="receipt-language-control">{uiText("Receipt language")}<select aria-label={uiText("Receipt language")} value={value??'trip'} onChange={event=>onChange(event.target.value==='trip'?undefined:event.target.value as ReceiptLanguage|'auto')}>
    <option value="trip">{uiText("Holiday hint · ")}{displayLanguageName(tripLanguage)}</option><option value="auto">{uiText("Automatic detection (ignore holiday hint)")}</option><LanguageOptions />
  </select><small>{detected?uiText("Detected: {value0}. ", { value0: displayLanguageName(detected) }):''}{uiText("A selected language overrides detection.")}</small></label>;
}
