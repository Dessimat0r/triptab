import { env } from 'cloudflare:workers';
import { db, ensureProfile, failure, readBoundedBody, sameOrigin, RequestError } from '@/lib/store';
import { receiptAIStatus, saveReceiptAISettings, removeReceiptAIKey, receiptAIKeyCheckDiagnostic, ReceiptAIAccessError, type ReceiptAIEnvironment } from '@/lib/receipt-ai-access';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
function errorResponse(error: unknown) {
  const diagnostic = receiptAIKeyCheckDiagnostic(error);
  if (diagnostic) console.error('TripTab receipt AI key verification failed', diagnostic);
  return error instanceof ReceiptAIAccessError ? Response.json({ error: error.message, code: error.code }, { status: error.status, headers }) : failure(error);
}
export async function GET(request: Request) {
  try { return Response.json(await receiptAIStatus(request, await ensureProfile(request), db(), env as ReceiptAIEnvironment), { headers }); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const profile = await ensureProfile(request);
    let body: unknown;
    try { body = JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 4096))); }
    catch (error) { if (error instanceof RequestError) throw error; throw new RequestError('Enter a valid receipt-processing setting.'); }
    return Response.json(await saveReceiptAISettings(request, profile, db(), env as ReceiptAIEnvironment, body), { headers });
  } catch (error) { return errorResponse(error); }
}
export async function DELETE(request: Request) {
  try {
    sameOrigin(request);
    return Response.json(await removeReceiptAIKey(request, await ensureProfile(request), db(), env as ReceiptAIEnvironment), { headers });
  } catch (error) { return errorResponse(error); }
}
