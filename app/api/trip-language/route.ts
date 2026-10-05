import { z } from 'zod';
import { db, ensureProfile, failure, readBoundedBody, RequestError, sameOrigin } from '@/lib/store';
import { languageSchema, displayVersionSchema } from '@/lib/receipt-languages';
import { readTripLanguagePreferences, saveTripLanguagePreferences } from '@/lib/trip-language-preferences';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store'};
const id=z.string().min(1).max(100);
const patch=z.object({accountId:z.string().min(1).max(512),tripId:id,revision:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),readingLanguage:languageSchema.optional(),primaryVersion:displayVersionSchema.optional(),
  itemKey:z.string().min(1).max(1250).optional(),itemVersion:displayVersionSchema.nullable().optional()}).strict()
  .refine(value=>(value.itemKey===undefined)===(value.itemVersion===undefined),'Choose an item and display version together.');
export async function GET(request:Request){try{
  const query=new URL(request.url).searchParams;
  if(query.size!==1||query.getAll('tripId').length!==1)throw new RequestError('Choose one holiday.');
  const profile=await ensureProfile(request),tripId=id.parse(query.get('tripId'));
  return Response.json({accountId:profile.id,tripId,...await readTripLanguagePreferences(db(),profile.id,tripId)},{headers});
}catch(error){return failure(error);}}
export async function POST(request:Request){try{
  try{sameOrigin(request);}catch{throw new RequestError("Open TripTab to use language settings.",403);}if(request.headers.get('sec-fetch-site')==='cross-site')throw new RequestError('Open TripTab to change your language preferences.',403);
  if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw new RequestError('Send JSON language preferences.',415);
  const profile=await ensureProfile(request);
  let body:unknown;
  try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedBody(request,8192)));}
  catch(error){if(error instanceof RequestError)throw error;throw new RequestError('Invalid language preferences.');}
  const values=patch.parse(body);
  if(values.accountId!==profile.id)throw new RequestError("Your signed-in account changed. Reload your holiday.",409);
  return Response.json({accountId:profile.id,tripId:values.tripId,...await saveTripLanguagePreferences(db(),profile,values.tripId,values.revision,values)},{headers});
}catch(error){return failure(error);}}
