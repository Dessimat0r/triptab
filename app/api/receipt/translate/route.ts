import { env } from 'cloudflare:workers';
import { db,ensureProfile,failure,readBoundedBody,readLedger,RequestError,sameOrigin } from '@/lib/store';
import { getReceiptAIAccess,ReceiptAIAccessError,type ReceiptAIEnvironment } from '@/lib/receipt-ai-access';
import { consumeReceiptProcessBudget,ReceiptAIError } from '@/lib/receipt-ai';
import { languageRequestSchema,processLanguageRequest } from '@/lib/receipt-language-ai';
export const dynamic='force-dynamic';
export async function POST(request:Request){try{
  try{sameOrigin(request);}catch{throw new RequestError("Open TripTab to use language settings.",403);}
  if(request.headers.get('sec-fetch-site')==='cross-site')throw new RequestError('Open TripTab to translate item names.',403);
  if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw new RequestError('Send a JSON translation request.',415);
  const profile=await ensureProfile(request);
  let body:unknown;
  try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedBody(request,150_000)));}
  catch(error){if(error instanceof RequestError)throw error;throw new RequestError('Invalid translation request.');}
  const values=languageRequestSchema.parse(body);
  if(values.accountId!==profile.id)throw new RequestError("Your signed-in account changed. Reload your holiday.",409);
  if(values.purpose==='items'&&new Set(values.rows.map(row=>row.id)).size!==values.rows.length)throw new RequestError('Each item must appear once.');
  const trip=values.tripId?(await readLedger(profile.id)).data.trips.find(trip=>trip.id===values.tripId):undefined;
  if(values.tripId&&!trip)throw new RequestError('Holiday not found in your account.',404);
  let result:unknown;
  // Same-language refresh needs neither credentials nor a paid request.
  if(values.purpose==='items'&&values.rows.every(row=>row.sourceLanguage===row.targetLanguage))
    result={rows:values.rows.map(row=>({id:row.id,text:row.sourceText,sourceLanguage:row.sourceLanguage}))};
  else{
    const database=db(),connection=await getReceiptAIAccess(request,profile,database,env as unknown as ReceiptAIEnvironment);
    await consumeReceiptProcessBudget(database,profile.id,{provider:connection.provider});
    result=await processLanguageRequest(values,connection,{signal:AbortSignal.any([request.signal,AbortSignal.timeout(60_000)]),tripLanguage:trip?.receiptLanguage});
  }
  if((await ensureProfile(request)).id!==profile.id)throw new RequestError('Your account changed. Open this receipt again.',409);
  if(trip&&!(await readLedger(profile.id)).data.trips.some(value=>value.id===trip.id))throw new RequestError('Holiday access changed.',403);
  return Response.json({accountId:profile.id,tripId:values.tripId??null,...result as object},{headers:{'Cache-Control':'private, no-store'}});
}catch(error){
  if(error instanceof ReceiptAIError||error instanceof ReceiptAIAccessError)return Response.json({error:error.message,code:error.code},{status:error.status,headers:{'Cache-Control':'private, no-store'}});
  return failure(error);
}}
