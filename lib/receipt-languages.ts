import { z } from 'zod';

export const RECEIPT_LANGUAGES = [
  ['en','English'],['de','German'],['fr','French'],['es','Spanish'],['it','Italian'],['pt','Portuguese'],
  ['nl','Dutch'],['el','Greek'],['pl','Polish'],['cs','Czech'],['sk','Slovak'],['hu','Hungarian'],
  ['ro','Romanian'],['bg','Bulgarian'],['da','Danish'],['sv','Swedish'],['no','Norwegian'],['fi','Finnish'],
  ['is','Icelandic'],['et','Estonian'],['lv','Latvian'],['lt','Lithuanian'],['sl','Slovenian'],['hr','Croatian'],
  ['sr','Serbian'],['bs','Bosnian'],['mk','Macedonian'],['sq','Albanian'],['tr','Turkish'],['uk','Ukrainian'],
  ['ru','Russian'],['ga','Irish'],['cy','Welsh'],['mt','Maltese'],['ca','Catalan'],['eu','Basque'],
  ['ar','Arabic'],['he','Hebrew'],['zh','Chinese'],['ja','Japanese'],['ko','Korean'],['hi','Hindi'],
  ['th','Thai'],['vi','Vietnamese'],['id','Indonesian'],['ka','Georgian'],['hy','Armenian'],['az','Azerbaijani'],
] as const;
export type ReceiptLanguage = typeof RECEIPT_LANGUAGES[number][0];
export const languageSchema = z.enum(RECEIPT_LANGUAGES.map(language=>language[0]) as [ReceiptLanguage,...ReceiptLanguage[]]);
export const receiptLanguageSchema = z.union([languageSchema,z.literal('auto')]);
export const translatedNameSchema = z.object({
  text:z.string().max(200), sourceText:z.string().max(200), pairedText:z.string().max(200),
  sourceLanguage:languageSchema.optional(), provenance:z.enum(['ai','user']),
}).strict();
export const itemTranslationsSchema = z.record(languageSchema,translatedNameSchema);
export type ItemTranslation = z.infer<typeof translatedNameSchema>;
export type BilingualItem = {name:string; nameLanguage?:ReceiptLanguage; translations?:Partial<Record<ReceiptLanguage,ItemTranslation>>; fieldSources?:{name?:'receipt'|'user'|'default'|'ai'}};
export const displayVersionSchema = z.enum(['reading','receipt']);
export type DisplayVersion = z.infer<typeof displayVersionSchema>;
export const tripLanguagePreferencesSchema = z.object({
  readingLanguage:languageSchema.default('en'), primaryVersion:displayVersionSchema.default('reading'),
  itemVersions:z.record(z.string().min(1).max(1250),displayVersionSchema).default({}),
}).strict().refine(value=>Object.keys(value.itemVersions).length<=2000,'Too many remembered item display preferences.');
export type TripLanguagePreferences = z.infer<typeof tripLanguagePreferencesSchema>;
export const defaultLanguagePreferences = ():TripLanguagePreferences=>({readingLanguage:'en',primaryVersion:'reading',itemVersions:{}});
export function languageName(code:unknown):string { return RECEIPT_LANGUAGES.find(language=>language[0]===code)?.[1] || 'Automatic detection'; }
export function receiptLanguageHint(trip:{receiptLanguage?:ReceiptLanguage|'auto'},receipt?:{receiptLanguage?:ReceiptLanguage|'auto';detectedLanguage?:ReceiptLanguage}):ReceiptLanguage|undefined {
  const chosen=receipt?.receiptLanguage ?? trip.receiptLanguage;
  return chosen==='auto'?undefined:chosen;
}
export function observedItemLanguage(item:BilingualItem,receipt:{receiptLanguage?:ReceiptLanguage|'auto';detectedLanguage?:ReceiptLanguage}):ReceiptLanguage|undefined {
  if(receipt.receiptLanguage&&receipt.receiptLanguage!=='auto')return receipt.receiptLanguage;
  return item.nameLanguage ?? receipt.detectedLanguage;
}
/**
 * A line someone typed with no language evidence: no recorded or detected
 * language, no translation and nothing read from a receipt. Its name is just
 * a name, so it is edited in one field rather than as a translation pair.
 */
export function isUntranslatedManualItem(item:BilingualItem&{scanSource?:unknown},receipt:{receiptLanguage?:ReceiptLanguage|'auto';detectedLanguage?:ReceiptLanguage}):boolean {
  return !item.nameLanguage&&!Object.keys(item.translations??{}).length&&!item.scanSource&&item.fieldSources?.name!=='receipt'
    &&!receipt.detectedLanguage&&(!receipt.receiptLanguage||receipt.receiptLanguage==='auto');
}
export function originalItemLanguage(item:BilingualItem,trip:{receiptLanguage?:ReceiptLanguage|'auto'},receipt:{receiptLanguage?:ReceiptLanguage|'auto';detectedLanguage?:ReceiptLanguage}):ReceiptLanguage|undefined {
  return observedItemLanguage(item,receipt) ?? receiptLanguageHint(trip,receipt);
}
export function itemDisplayKey(receipt:{id:string;languageViewId?:string;expenseId?:string},itemId:string):string {
  return JSON.stringify([receipt.languageViewId || receipt.expenseId || receipt.id,itemId]);
}
export function editReadingName<T extends BilingualItem>(item:T,language:ReceiptLanguage,text:string):T {
  const previous=item.translations?.[language];
  return {...item,translations:{...item.translations,[language]:previous?{...previous,text,provenance:'user'}
    :{text,sourceText:item.name,pairedText:'',...(item.nameLanguage?{sourceLanguage:item.nameLanguage}:{}),provenance:'user'}}};
}
export function setPairedTranslation<T extends BilingualItem>(item:T,language:ReceiptLanguage,text:string,sourceLanguage?:ReceiptLanguage,provenance:'ai'|'user'='ai'):T {
  return {...item,...(!item.nameLanguage&&sourceLanguage?{nameLanguage:sourceLanguage}:{}),translations:{...item.translations,[language]:{text,sourceText:item.name,pairedText:text,
    ...(sourceLanguage?{sourceLanguage}:{}),provenance}}};
}
export function mergeScannedNames<T extends BilingualItem>(previous:T|undefined,next:T,language:ReceiptLanguage|undefined,readingLanguage:ReceiptLanguage|undefined,text:string|null|undefined):T {
  const result={...next,...(language&&(!next.nameLanguage||next.fieldSources?.name==='receipt')?{nameLanguage:language}:{})};
  if(!readingLanguage || !text || previous?.translations?.[readingLanguage]?.provenance==='user')return result;
  return setPairedTranslation(result,readingLanguage,text,language,'ai');
}
