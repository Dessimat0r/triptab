import { env, waitUntil } from 'cloudflare:workers';
import { z } from 'zod';
import { db, ensureProfile, failure, readBoundedBody, readLedger, RequestError, sameOrigin } from '@/lib/store';
import { executionGrant } from '@/lib/auth';
import { getReceiptAIAccess, ReceiptAIAccessError, type ReceiptAIEnvironment } from '@/lib/receipt-ai-access';
import { ReceiptAIError } from '@/lib/receipt-ai';
import { financialFormatRefusal } from '@/lib/financial-format';
import { claimOperation, finishOperation, operationFence, type Claim, type OperationSource } from '@/lib/receipt-operations';
import { errorCategory, executeOperation, loadOperationSource, logOperation, type OperationLog } from '@/lib/receipt-operation-work';

export const dynamic = 'force-dynamic';
const id = z.string().min(1).max(100);
const requestSchema = z.object({ tripId: id, draftId: id, receiptId: id.regex(/^[-a-z0-9]+$/i).optional(),
  // Cached clients may still send this global counter. Only the required draft
  // fingerprint fences inference; this compatibility value never decides it.
  revision: z.number().int().min(0).optional(), draftHash: z.string().regex(/^[a-f0-9]{64}$/),
  questionId: id.optional(), readPurchaseDetails: z.boolean().optional() }).strict();
/** A browser request's attempt; the background runner allows longer (lib/receipt-background.ts). */
const REQUEST_TIMEOUT_MS = 90_000;

export async function POST(request: Request) {
  // R01: refuse a bundle that would drop the proposal's discounts before any
  // paid inference runs for it.
  const refused = financialFormatRefusal(request);
  if (refused) return refused;
  let operation: OperationLog | undefined;
  let claim: Extract<Claim, { owned: true }> | undefined;
  try {
    sameOrigin(request);
    if (request.headers.get('sec-fetch-site') === 'cross-site') throw new RequestError('Open TripTab to process this receipt.', 403);
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new RequestError('Send a JSON receipt-processing request.', 415);
    const profile = await ensureProfile(request);
    const bytes = await readBoundedBody(request, 2048);
    let body: unknown;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new RequestError('Invalid receipt-processing request.'); }
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) throw new RequestError('Reload TripTab and open the saved receipt again before processing it. A current receipt fingerprint is required.');
    const values = parsed.data;
    const source = await loadOperationSource(profile.id, values);
    if (source.answered) return Response.json({ ...source.ledger, draft: source.draft }, { headers: { 'Cache-Control': 'private, no-store' } });
    const database = db();
    // R07: the work may finish after this request ends (the background runner
    // resumes it if the platform cuts it off). It acts only under this
    // person's execution grant: their server-side session or trusted ChatGPT
    // identity, rechecked before spending and inside the commit.
    const grant = await executionGrant(request, database, profile.id);
    if (!grant) throw new RequestError('Sign in to TripTab again before reading this receipt.', 401);
    const job: OperationSource = { tripId: source.trip.id, draftId: source.draft.id, draftHash: values.draftHash, receiptId: values.receiptId,
      imageVersion: source.image?.version, questionId: values.questionId, readPurchaseDetails: values.readPurchaseDetails };
    // R06: claim this operation before any budget, key lookup or provider
    // call. Identical requests, on any Worker instance, share one claim; only
    // its holder spends. The key is the authorized source just checked.
    const attempt = await claimOperation(database, job, profile.id, { grant });
    if (!attempt.owned) {
      // Already running (here or in the background): the app keeps showing it
      // as reading and picks up the stored proposal on refresh. Already stored:
      // return what was saved.
      const latest = await readLedger(profile.id);
      const latestDraft = latest.data.trips.find(value => value.id === source.trip.id)?.drafts.find(value => value.id === source.draft.id);
      return Response.json({ ...latest, draft: latestDraft, reading: attempt.status === 'running' },
        { status: attempt.status === 'running' ? 202 : 200, headers: { 'Cache-Control': 'private, no-store' } });
    }
    claim = attempt;
    operation = { attemptId: claim.attemptId, tripId: source.trip.id, draftId: source.draft.id, receiptId: values.receiptId, runner: 'request' };
    const started = operation, held = claim;
    // F-11/R07: a phone that locks or leaves the app drops this request. The
    // reading continues for the platform's post-disconnect grace period
    // (waitUntil: up to 30 s after the client disconnects). If it is cut off
    // there, no outcome is recorded, its lease runs out, and the background
    // runner resumes the operation once under the same grant.
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const work = executeOperation({ userId: profile.id, request: job, source, fence: operationFence(held), log: started, signal,
      credential: () => getReceiptAIAccess(request, profile, database, env as unknown as ReceiptAIEnvironment),
      stillCurrent: async () => {
        if ((await ensureProfile(request)).id !== profile.id) throw new RequestError('Your signed-in account changed. Open this receipt again.', 409);
      } }).then(({ saved, savedDraft }) => Response.json({ ...saved, draft: savedDraft }, { headers: { 'Cache-Control': 'private, no-store' } }));
    // Keep the reading alive after the client disconnects; errors still reach a connected client.
    // A failure records the outcome on the claim, so a later request may retry.
    const settled = work.catch(async error => { await finishOperation(database, held.key, held.attemptId, 'failed', { errorCode: errorCategory(error) }).catch(() => {}); throw error; });
    try { waitUntil(settled.then(() => undefined, error => { logOperation('native-processing-failed', started, { category: 'detached' }); void error; })); } catch { /* Not running in a Worker (tests). */ }
    claim = undefined;
    return await settled;
  } catch (error) {
    // A failure before the work started also ends the claim.
    if (claim) await finishOperation(db(), claim.key, claim.attemptId, 'failed', { errorCode: errorCategory(error) }).catch(() => {});
    if (operation) logOperation('native-processing-failed', operation, { category: errorCategory(error) });
    if (error instanceof ReceiptAIError || error instanceof ReceiptAIAccessError) {
      return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: { 'Cache-Control': 'private, no-store' } });
    }
    return failure(error);
  }
}
